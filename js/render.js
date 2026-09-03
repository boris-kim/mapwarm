/* MapWarm — 캔버스 렌더러 v2 ("지도 자체가 그래픽 포스터")
   - 영토: 빽빽한 도트 매트릭스 (링 변형 + 가장자리 디더링 + 숨쉬기 펄스)
   - 지도: 저채도·저대비 무대 + 바닥 텍스처(존 라벨·노이즈 패치)
   - 타이포: 대형 점유율 %, 점령 "+N" 플로트
   - 모션: 점령 물결, 꼬리 스파클, 봇 처치 순차 소멸, 위험 비네트, 마이크로 줌
   성능 예산: 60fps — 그라디언트 프레임당 ≤4, 텍스처는 캐시, shadowBlur는 다크 한정 소수
   색상은 전부 CSS 토큰(getComputedStyle) — 테마를 따라간다 */
(function () {
  'use strict';

  const DOT_MIN = 0.18;   // v2: 밀도 상향
  const DOT_MAX = 0.48;
  const EDGE_CUT = 0.295; // 이 이하(이웃 ≤3) = 가장자리 → 2×2 디더링
  const POP_MS = 250;     // 점령 팝 스케일-인
  const WAVE_MS = 18;     // 점령 물결: 중심 거리 × 18ms 지연
  const FLOAT_MS = 1000;  // "+N" 타이포 수명
  const ZOOM_MS = 120;    // 점령 임팩트 마이크로 줌

  const MARKER_SIZE = { 1: 58, 2: 44, 3: 44 }; // v2: 존재감 상향

  const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

  // 고정 시드 PRNG (바닥 텍스처용)
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Renderer {
    constructor(canvas, board, game) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.board = board;
      this.game = game;
      this.cam = { x: board.size / 2, y: board.size / 2 };
      this.palette = null;
      this.isDark = false;

      // 도트 캐시 — 영토가 바뀔 때(board.rev)만 재계산
      const N = board.size * board.size;
      this.boardRev = -1;
      this.dotR = new Float32Array(N);
      this.prevOwner = new Uint8Array(N);
      this.pops = new Map(); // idx → 팝 시작 시각 (물결: 중심 거리만큼 지연)

      // 소유자별 영토 클러스터 (다크 네온 글로우 언더레이)
      this.clusters = { 1: null, 2: null, 3: null };

      // 이펙트 큐
      this.floats = []; // "+N" 타이포 {x,y(셀),text,t0}
      this.botFx = [];  // 봇 처치 연출 {id,trail,cutK,head,debris,t0}
      this.zoomT0 = -1e9;

      // 예상 점령 게이지: 숫자 스케일 팝 추적
      this._projCount = -1;
      this._projPopT0 = -1e9;

      // 프로필: 플레이어(id 1)는 프로필을 따르고, 봇은 고정
      this.profile = MW.Profile ? MW.Profile.load() : { nick: 'MINJAE', photo: null, face: 0, color: 'lime' };
      this.names = { 1: this.profile.nick, 2: 'PIKO', 3: 'MOMO' };
      this._photoImg = null;   // 프로필 사진 디코드 캐시 (매 프레임 디코드 금지)
      this._photoSrc = null;   // 캐시된 사진의 data URL (변경 감지)
      this._photoReady = false;
      this.loadProfilePhoto();

      // 바닥 텍스처 (고정 시드, 셀 좌표 캐시)
      this.texture = this.buildTexture();

      this.refreshPalette();
      this.resize();

      window.addEventListener('resize', () => this.resize());
      document.addEventListener('mw:themechange', () => this.refreshPalette());
    }

    refreshPalette() {
      const cs = getComputedStyle(document.documentElement);
      const tok = (n, fb) => {
        const v = cs.getPropertyValue(n).trim();
        return v || fb;
      };
      const entTok = (prefix) => {
        const head = tok('--' + prefix + '-head', '#888888');
        return {
          t: tok('--' + prefix + '-territory', head),
          tr: tok('--' + prefix + '-trail', head),
          h: head,
          frame: tok('--' + prefix + '-frame', head),
        };
      };
      this.palette = {
        outside: tok('--canvas-outside', '#e6ebe3'),
        bg: tok('--canvas-bg', '#eaebe7'),
        grid: tok('--canvas-grid', 'rgba(0,0,0,0)'),
        bound: tok('--canvas-bound', '#9a9b96'),
        mapTint: tok('--map-tint', 'rgba(255,255,255,0.5)'),
        white: tok('--sticker-white', tok('--on-primary', '#ffffff')),
        face: tok('--avatar-face', '#2b2b2e'),
        labelBg: tok('--label-bg', tok('--avatar-face', '#2b2b2e')),
        labelFg: tok('--label-fg', '#b7e819'),
        danger: tok('--danger-color', '#ff3e9a'),
        pop: null,
        ent: { 1: entTok('p1'), 2: entTok('bot1'), 3: entTok('bot2') },
        // 프로필 색 (캔디 팔레트 id → 실제 색)
        candy: {
          lime: tok('--candy-lime', '#b7e819'),
          pink: tok('--candy-pink', '#ff3e9a'),
          orange: tok('--candy-orange', '#ff8a00'),
          sky: tok('--candy-sky', '#3aa0ff'),
          purple: tok('--candy-purple', '#a855f7'),
          cyan: tok('--candy-cyan', '#22d3ee'),
        },
      };
      this.palette.pop = tok('--pop-color', this.palette.ent[1].h);

      const t = document.documentElement.getAttribute('data-theme');
      this.isDark =
        t === 'dark' ||
        (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    // 프로필 변경 반영 (설정 저장 시 main.js가 호출)
    setProfile(profile) {
      this.profile = profile;
      this.names[1] = profile.nick;
      this.loadProfilePhoto();
    }

    // 프로필 사진 1회 디코드 캐시 (data URL 바뀔 때만 재로드)
    loadProfilePhoto() {
      const src = this.profile && this.profile.photo;
      if (src === this._photoSrc) return;
      this._photoSrc = src;
      this._photoReady = false;
      this._photoImg = null;
      if (!src || typeof Image === 'undefined') return;
      const img = new Image();
      img.onload = () => {
        this._photoImg = img;
        this._photoReady = true;
        if (this.onProfilePhoto) this.onProfilePhoto(); // HUD 썸네일 등 재그리기
      };
      img.onerror = () => {
        this._photoImg = null; // 실패 → 프리셋 얼굴 폴백
        this._photoReady = false;
        if (this.onProfilePhoto) this.onProfilePhoto();
      };
      img.src = src;
    }

    // 플레이어 프레임 색 = 프로필 캔디 색 (없으면 라임 토큰)
    playerFrameColor() {
      const c = this.profile && this.profile.color;
      return (this.palette.candy && this.palette.candy[c]) || this.palette.ent[1].frame;
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    lerpPos(e, t) {
      return { x: e.pc + (e.c - e.pc) * t, y: e.pr + (e.r - e.pr) * t };
    }

    // ---------- 외부 트리거 ----------
    zoomPulse() {
      this.zoomT0 = performance.now();
    }

    // 봇 처치: 꼬리 스냅샷 + 끊긴 지점 + 파편 (die() 호출 전에 불러야 한다)
    addBotDeathFx(bot, cutCellIdx) {
      const trail = bot.trail.slice();
      let cutK = cutCellIdx != null ? trail.indexOf(cutCellIdx) : -1;
      if (cutK < 0) cutK = Math.max(0, trail.length - 1);
      const debris = [];
      const n = 6 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        debris.push({
          a: Math.random() * Math.PI * 2,
          v: 30 + Math.random() * 60,
        });
      }
      this.botFx.push({
        id: bot.id,
        trail,
        cutK,
        head: { c: bot.c, r: bot.r },
        debris,
        t0: performance.now(),
      });
    }

    // ---------- 바닥 텍스처 (고정 시드, 1회 생성) ----------
    buildTexture() {
      const rnd = mulberry32(20260902);
      const items = { labels: [], rects: [] };
      // 존 라벨 「01」~「04」: 사분면 중심
      const q = [[20, 20, '01'], [60, 20, '02'], [20, 60, '03'], [60, 60, '04']];
      for (let i = 0; i < q.length; i++) {
        items.labels.push({ c: q[i][0], r: q[i][1], text: q[i][2] });
      }
      // 디더 노이즈 패치: 작은 사각형 무리
      for (let p = 0; p < 26; p++) {
        const bc = 3 + rnd() * 74;
        const br = 3 + rnd() * 74;
        const n = 4 + ((rnd() * 6) | 0);
        for (let k = 0; k < n; k++) {
          items.rects.push({
            c: bc + (rnd() - 0.5) * 5,
            r: br + (rnd() - 0.5) * 5,
            s: 0.1 + rnd() * 0.16,
          });
        }
      }
      // 픽셀 클러스터: 2×2/3×3 미니 그리드
      for (let p = 0; p < 16; p++) {
        const bc = 4 + rnd() * 72;
        const br = 4 + rnd() * 72;
        const g = 2 + ((rnd() * 2) | 0);
        for (let gy = 0; gy < g; gy++) {
          for (let gx = 0; gx < g; gx++) {
            items.rects.push({ c: bc + gx * 0.45, r: br + gy * 0.45, s: 0.14 });
          }
        }
      }
      return items;
    }

    drawGroundTexture(ox, oy, cp, c0, r0, c1, r1) {
      const ctx = this.ctx;
      const P = this.palette;
      ctx.save();
      // 디더 패치 + 픽셀 클러스터
      ctx.globalAlpha = this.isDark ? 0.1 : 0.09;
      ctx.fillStyle = P.bound;
      const rects = this.texture.rects;
      for (let i = 0; i < rects.length; i++) {
        const it = rects[i];
        if (it.c < c0 - 1 || it.c > c1 + 1 || it.r < r0 - 1 || it.r > r1 + 1) continue;
        const s = it.s * cp;
        ctx.fillRect(ox + it.c * cp, oy + it.r * cp, s, s);
      }
      // 존 라벨 「01」…
      ctx.globalAlpha = this.isDark ? 0.14 : 0.12;
      ctx.font = '800 ' + Math.round(cp * 1.4) + 'px ' + MONO;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labels = this.texture.labels;
      for (let i = 0; i < labels.length; i++) {
        const it = labels[i];
        if (it.c < c0 - 3 || it.c > c1 + 3 || it.r < r0 - 2 || it.r > r1 + 2) continue;
        ctx.fillText('「' + it.text + '」', ox + it.c * cp, oy + it.r * cp);
      }
      ctx.restore();
    }

    // ---------- 도트 캐시 + 점령 물결 + 클러스터 (영토 변경 시에만) ----------
    updateDots(now) {
      const board = this.board;
      if (board.rev === this.boardRev) return;
      this.boardRev = board.rev;

      const s = board.size;
      const o = board.owner;
      const prev = this.prevOwner;

      // 새로 점령된 셀 수집 (소유자별)
      const gained = { 1: [], 2: [], 3: [] };
      for (let i = 0; i < o.length; i++) {
        if (o[i] !== 0 && o[i] !== prev[i]) gained[o[i]].push(i);
        else if (o[i] === 0) this.pops.delete(i);
      }

      // 점령 물결: flood 중심에서 거리 × 18ms 지연으로 팝 시작
      for (let id = 1; id <= 3; id++) {
        const g = gained[id];
        if (!g.length) continue;
        let sc = 0;
        let sr = 0;
        for (let k = 0; k < g.length; k++) {
          const c = g[k] % s;
          sc += c;
          sr += (g[k] - c) / s;
        }
        const cc = sc / g.length;
        const cr = sr / g.length;
        for (let k = 0; k < g.length; k++) {
          const c = g[k] % s;
          const r = (g[k] - c) / s;
          this.pops.set(g[k], now + (Math.abs(c - cc) + Math.abs(r - cr)) * WAVE_MS);
        }
        // "+N" 타이포: 플레이어 점령 중심에 (스폰 시점 제외)
        if (id === 1 && this.game.tickCount > 0) {
          this.floats.push({ x: cc + 0.5, y: cr + 0.5, text: '+' + g.length, t0: now });
        }
      }
      prev.set(o);
      this.computeField();
    }

    // 월드 복원/정산 직후: 팝·플로트 없이 현재 상태를 기준선으로 채택
    syncBaseline() {
      this.boardRev = this.board.rev;
      this.prevOwner.set(this.board.owner);
      this.pops.clear();
      this.floats.length = 0;
      this.computeField();
    }

    // 도트 반지름 + 소유자별 클러스터 중심
    computeField() {
      const board = this.board;
      const s = board.size;
      const o = board.owner;
      const d = this.dotR;
      const cl = { 1: { sx: 0, sy: 0, n: 0 }, 2: { sx: 0, sy: 0, n: 0 }, 3: { sx: 0, sy: 0, n: 0 } };
      for (let r = 0; r < s; r++) {
        for (let c = 0; c < s; c++) {
          const i = r * s + c;
          const id = o[i];
          if (!id) {
            d[i] = 0;
            continue;
          }
          let n = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (!dr && !dc) continue;
              const cc = c + dc;
              const rr = r + dr;
              if (cc >= 0 && rr >= 0 && cc < s && rr < s && o[rr * s + cc] === id) n++;
            }
          }
          d[i] = DOT_MIN + (DOT_MAX - DOT_MIN) * (n / 8);
          const k = cl[id];
          k.sx += c;
          k.sy += r;
          k.n++;
        }
      }
      for (let id = 1; id <= 3; id++) {
        const k = cl[id];
        this.clusters[id] = k.n ? { x: k.sx / k.n + 0.5, y: k.sy / k.n + 0.5, count: k.n } : null;
      }
    }

    // ---------- 메인 드로우 ----------
    draw(tickT, dt) {
      const ctx = this.ctx;
      const P = this.palette;
      const board = this.board;
      const s = board.size;
      const cp = MW.CONFIG.CELL_PX;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (!w || !h || !P) return;

      const now = performance.now();
      this.updateDots(now);

      // 카메라
      const pl = this.game.player;
      const pp = this.lerpPos(pl, tickT);
      const k = 1 - Math.exp(-6 * dt);
      this.cam.x += (pp.x + 0.5 - this.cam.x) * k;
      this.cam.y += (pp.y + 0.5 - this.cam.y) * k;
      const vw = w / cp;
      const vh = h / cp;
      this.cam.x = vw >= s ? s / 2 : Math.min(Math.max(this.cam.x, vw / 2), s - vw / 2);
      this.cam.y = vh >= s ? s / 2 : Math.min(Math.max(this.cam.y, vh / 2), s - vh / 2);
      const ox = w / 2 - this.cam.x * cp;
      const oy = h / 2 - this.cam.y * cp;

      // 점령 임팩트 마이크로 줌 (≥20셀)
      const zt = now - this.zoomT0;
      const zoomed = zt >= 0 && zt < ZOOM_MS;
      if (zoomed) {
        const zk = 1 + 0.03 * Math.sin((Math.PI * zt) / ZOOM_MS);
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.scale(zk, zk);
        ctx.translate(-w / 2, -h / 2);
      }

      // 배경 + 지도 무대
      ctx.fillStyle = P.outside;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = P.bg;
      ctx.fillRect(ox, oy, s * cp, s * cp);
      if (this.game.tileMap) {
        this.game.tileMap.draw(ctx, ox, oy, cp, w, h);
        ctx.fillStyle = P.mapTint;
        ctx.fillRect(0, 0, w, h);
      }

      const c0 = Math.max(0, Math.floor(-ox / cp));
      const r0 = Math.max(0, Math.floor(-oy / cp));
      const c1 = Math.min(s - 1, Math.ceil((w - ox) / cp));
      const r1 = Math.min(s - 1, Math.ceil((h - oy) / cp));

      // 바닥 텍스처 (밀도가 무드다)
      this.drawGroundTexture(ox, oy, cp, c0, r0, c1, r1);

      // 다크 네온: 영토 클러스터 글로우 언더레이 (그라디언트 ≤3)
      if (this.isDark) this.drawClusterGlow(ox, oy, cp, w, h);

      // 예상 점령 유령 미리보기 (실제 도트 아래, 반투명 펄스)
      this.drawProjectedGhost(ox, oy, cp, c0, r0, c1, r1, now);

      // 영토 도트 매트릭스
      this.drawDots(ox, oy, cp, c0, r0, c1, r1, now);

      // 사망 연출 상태
      const dying = this.game.state === 'dying';
      const deathElapsed = dying ? now - this.game.deathAt : 0;
      const fx = MW.CONFIG.DEATH_FX_MS;

      // 꼬리 캡슐
      const entities = [this.game.player].concat(this.game.bots);
      for (let e = 0; e < entities.length; e++) {
        const ent = entities[e];
        if (!ent.alive || !ent.trail.length) continue;
        const isDyingPlayer = dying && ent === this.game.player;
        if (isDyingPlayer) ctx.globalAlpha = Math.max(0, 1 - deathElapsed / fx);
        this.drawTrail(ent, ox, oy, cp, tickT);
        ctx.globalAlpha = 1;
      }

      // 봇 처치 연출 (순차 소멸 + 넘어짐 + 파편)
      this.drawBotFx(now, ox, oy, cp);

      // 머리 스티커 + 아바타 마커
      for (let e = 0; e < entities.length; e++) {
        const ent = entities[e];
        if (!ent.alive) continue;
        const pos = this.lerpPos(ent, tickT);
        const hx = ox + pos.x * cp;
        const hy = oy + pos.y * cp;
        const isDyingPlayer = dying && ent === this.game.player;
        if (isDyingPlayer) {
          ctx.globalAlpha = Math.floor(deathElapsed / 100) % 2 === 0 ? 0.9 : 0.15;
        }
        this.drawHeadSticker(ent, hx, hy, cp);
        ctx.globalAlpha = 1;
        this.drawMarker(ent, hx + cp / 2, hy, now, isDyingPlayer ? deathElapsed / fx : -1);
      }

      // 꼬리 끝 스파클 — 머리 스티커·마커보다 위 레이어 (가려짐 방지)
      for (let e = 0; e < entities.length; e++) {
        const ent = entities[e];
        if (!ent.alive || !ent.trail.length) continue;
        if (dying && ent === this.game.player) {
          ctx.globalAlpha = Math.max(0, 1 - deathElapsed / fx);
        }
        this.drawSparkle(ent, ox, oy, cp, tickT, now);
        ctx.globalAlpha = 1;
      }

      // "+N" 플로트 타이포
      this.drawFloats(now, ox, oy, cp);

      // 예상 점령 숫자 ("+180", 오르면 스케일 팝, 임계 넘으면 "지금 닫아!")
      this.drawProjectedNumber(ox, oy, cp, tickT, now);

      // 대형 점유율 % (그래픽 요소)
      this.drawBigPct(w, h);

      // 게임판 경계
      ctx.strokeStyle = P.bound;
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + 1, oy + 1, s * cp - 2, s * cp - 2);

      if (zoomed) ctx.restore();

      // 위험 비네트 (자기 꼬리 근접 — 줌/월드 변환 밖, 화면 고정)
      this.drawDangerVignette(w, h, now);
    }

    // ---------- 다크 네온 클러스터 글로우 ----------
    drawClusterGlow(ox, oy, cp, w, h) {
      const ctx = this.ctx;
      const P = this.palette;
      for (let id = 1; id <= 3; id++) {
        const cl = this.clusters[id];
        if (!cl) continue;
        const gx = ox + cl.x * cp;
        const gy = oy + cl.y * cp;
        const rr = Math.min(Math.sqrt(cl.count) * cp * 0.9, Math.max(w, h));
        if (gx + rr < 0 || gx - rr > w || gy + rr < 0 || gy - rr > h) continue;
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, rr);
        g.addColorStop(0, P.ent[id].h);
        g.addColorStop(1, 'transparent');
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = g;
        ctx.fillRect(gx - rr, gy - rr, rr * 2, rr * 2);
        ctx.globalAlpha = 1;
      }
    }

    // ---------- 예상 점령 유령 미리보기 ----------
    // "지금 닫으면 여기까지" — 새로 먹을 셀을 내 색 반투명 사각형 + 펄스로.
    // 실제 도트보다 옅게, 성긴 사각형이라 저비용 (게임 로직 캐시 game.projected 사용).
    drawProjectedGhost(ox, oy, cp, c0, r0, c1, r1, now) {
      const proj = this.game.projected;
      if (!proj || !proj.count) return;
      const ctx = this.ctx;
      const P = this.palette;
      const s = this.board.size;
      const cells = proj.cells;

      // 펄스 알파 (유령은 도트보다 확실히 옅게)
      const pulse = 0.10 + 0.06 * (0.5 + 0.5 * Math.sin(now / 380));
      const urge = proj.count >= MW.CONFIG.GAUGE_URGE_CELLS;
      ctx.save();
      ctx.globalAlpha = urge ? pulse + 0.05 : pulse;
      ctx.fillStyle = urge ? P.ent[1].h : P.ent[1].t; // 임계 넘으면 더 쨍한 라임
      const inset = cp * 0.12;
      const sz = cp - inset * 2;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k];
        const c = i % s;
        const r = (i - c) / s;
        if (c < c0 || c > c1 || r < r0 || r > r1) continue;
        ctx.fillRect(ox + c * cp + inset, oy + r * cp + inset, sz, sz);
      }
      ctx.restore();
    }

    // ---------- 예상 점령 숫자 ("+N") ----------
    drawProjectedNumber(ox, oy, cp, tickT, now) {
      const proj = this.game.projected;
      if (!proj || !proj.count) {
        this._projCount = -1;
        return;
      }
      const ctx = this.ctx;
      const P = this.palette;
      const urge = proj.count >= MW.CONFIG.GAUGE_URGE_CELLS;

      // 값이 오르면 스케일 팝
      if (proj.count > this._projCount) this._projPopT0 = now;
      this._projCount = proj.count;
      const pt = Math.min(1, (now - this._projPopT0) / 220);
      const pop = 1 + 0.35 * (1 - pt) * (pt > 0 ? 1 : 0);

      // 예정 영역 중심 위쪽에 표시 (없으면 머리 근처)
      let bx = ox + proj.cx * cp;
      let by = oy + proj.cy * cp - cp * 1.6;
      const pl = this.game.player;
      if (!proj.cx && !proj.cy) {
        const hp = this.lerpPos(pl, tickT);
        bx = ox + (hp.x + 0.5) * cp;
        by = oy + hp.y * cp - cp * 1.8;
      }

      const text = '+' + proj.count;
      const base = Math.max(20, Math.round(cp * 1.0));
      ctx.save();
      ctx.translate(bx, by);
      ctx.scale(pop, pop);
      try { ctx.letterSpacing = '1px'; } catch (e) { /* noop */ }
      ctx.font = '900 ' + base + 'px ' + MONO;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = P.white;
      ctx.lineWidth = 5;
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = P.ent[1].h;
      ctx.fillText(text, 0, 0);

      if (urge) {
        // "지금 닫아!" 힌트 (라임 강조 필)
        const hint = '지금 닫아!';
        const hf = Math.max(11, Math.round(cp * 0.5));
        ctx.font = '800 ' + hf + 'px ' + MONO;
        const tw = ctx.measureText(hint).width;
        const pw = tw + 16;
        const ph = hf + 10;
        const hy = base * 0.72 + ph / 2;
        this.roundRectPath(-pw / 2, hy - ph / 2, pw, ph, ph / 2);
        ctx.fillStyle = P.ent[1].h;
        ctx.fill();
        ctx.fillStyle = P.face;
        ctx.fillText(hint, 0, hy);
      }
      ctx.restore();
    }

    // ---------- 영토 도트 매트릭스 ----------
    drawDots(ox, oy, cp, c0, r0, c1, r1, now) {
      const ctx = this.ctx;
      const P = this.palette;
      const board = this.board;
      const s = board.size;
      const o = board.owner;
      const d = this.dotR;
      const half = cp / 2;

      if (this.pops.size) {
        this.pops.forEach((t0, i) => {
          if (now - t0 >= POP_MS) this.pops.delete(i);
        });
      }

      // v0.2 온기: GPS 모드에서 내 도트는 온기에 따라 축소·감쇠 (식은 셀은 옅은 패스로)
      const warmth = this.game.mode === 'gps' ? this.game.warmth : null;
      const wallNow = warmth ? Date.now() : 0;
      const coldDots = []; // [cx, cy, rad] — 온기 <0.5 셀 (알파 감쇠 패스)

      for (let id = 1; id <= 3; id++) {
        const ringCells = []; // 링 변형 (~15%, 해시 기반)
        ctx.fillStyle = P.ent[id].t;
        ctx.beginPath();
        for (let r = r0; r <= r1; r++) {
          const base = r * s;
          for (let c = c0; c <= c1; c++) {
            const i = base + c;
            if (o[i] !== id || !d[i] || this.pops.has(i)) continue;
            const cx = ox + c * cp + half;
            const cy = oy + r * cp + half;
            // M1 도트 숨쉬기
            const breathe = 1 + 0.04 * Math.sin(now / 900 + (c + r) * 0.7);
            let rad = d[i] * cp * breathe;
            if (warmth && id === 1) {
              const wv = warmth.warmAt(i, wallNow);
              rad *= 0.35 + 0.65 * wv; // 식으면 축소
              if (wv < 0.5) {
                coldDots.push(cx, cy, rad); // 감쇠 패스로
                continue;
              }
            }
            if (d[i] <= EDGE_CUT) {
              // 가장자리(이웃 ≤3): 2×2 서브도트 디더링
              const sub = Math.max(0.9, rad * 0.5);
              const off = cp * 0.22;
              ctx.moveTo(cx - off + sub, cy - off);
              ctx.arc(cx - off, cy - off, sub, 0, Math.PI * 2);
              ctx.moveTo(cx + off + sub, cy - off);
              ctx.arc(cx + off, cy - off, sub, 0, Math.PI * 2);
              ctx.moveTo(cx - off + sub, cy + off);
              ctx.arc(cx - off, cy + off, sub, 0, Math.PI * 2);
              ctx.moveTo(cx + off + sub, cy + off);
              ctx.arc(cx + off, cy + off, sub, 0, Math.PI * 2);
            } else if (((i * 2654435761) >>> 0) % 100 < 15) {
              ringCells.push(cx, cy, rad); // 링 변형은 스트로크 패스로
            } else {
              ctx.moveTo(cx + rad, cy);
              ctx.arc(cx, cy, rad, 0, Math.PI * 2);
            }
          }
        }
        ctx.fill();

        if (ringCells.length) {
          ctx.strokeStyle = P.ent[id].t;
          ctx.lineWidth = Math.max(1.5, cp * 0.09);
          ctx.beginPath();
          for (let k = 0; k < ringCells.length; k += 3) {
            const cx = ringCells[k];
            const cy = ringCells[k + 1];
            const rad = ringCells[k + 2] * 0.82;
            ctx.moveTo(cx + rad, cy);
            ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          }
          ctx.stroke();
        }
      }

      // 식은 내 도트: 옅게 (온기 <0.5 — 감쇠 표현)
      if (coldDots.length) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = P.ent[1].t;
        ctx.beginPath();
        for (let k = 0; k < coldDots.length; k += 3) {
          const rad = coldDots[k + 2];
          if (rad <= 0.3) continue;
          ctx.moveTo(coldDots[k] + rad, coldDots[k + 1]);
          ctx.arc(coldDots[k], coldDots[k + 1], rad, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.restore();
      }

      // 팝 중인 도트: 물결 지연 + 스케일 인 (초반 팝 색 플래시)
      if (this.pops.size) {
        this.pops.forEach((t0, i) => {
          const el = now - t0;
          if (el <= 0) return; // 물결이 아직 안 닿음
          const c = i % s;
          const r = (i - c) / s;
          if (c < c0 || c > c1 || r < r0 || r > r1) return;
          if (!d[i]) return;
          const t = Math.min(1, el / POP_MS);
          const ease = 1 - Math.pow(1 - t, 3);
          const rad = d[i] * cp * ease;
          if (rad <= 0.2) return;
          // 플래시는 소유자별: 플레이어 = --pop-color, 봇 = 자기 head 색 + 흰 믹스
          const flash = t < 0.4;
          const id = o[i];
          ctx.fillStyle = flash
            ? (id === 1 ? P.pop : P.ent[id].h)
            : P.ent[id].t;
          const px = ox + c * cp + half;
          const py = oy + r * cp + half;
          ctx.beginPath();
          ctx.arc(px, py, rad, 0, Math.PI * 2);
          ctx.fill();
          if (flash && id !== 1) {
            // 흰색 50% 믹스 느낌의 밝기 플래시 (점점 소멸)
            ctx.globalAlpha = 0.5 * (1 - t / 0.4);
            ctx.fillStyle = P.white;
            ctx.beginPath();
            ctx.arc(px, py, rad, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          }
        });
      }
    }

    // ---------- 꼬리 캡슐 (v2: 컬러 0.48, 라이트 그림자 / 다크 글로우) ----------
    drawTrail(ent, ox, oy, cp, tickT) {
      const ctx = this.ctx;
      const P = this.palette;
      const s = this.board.size;
      const half = cp / 2;
      const trail = ent.trail;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const buildPath = () => {
        ctx.beginPath();
        for (let k = 0; k < trail.length; k++) {
          const i = trail[k];
          const c = i % s;
          const r = (i - c) / s;
          const x = ox + c * cp + half;
          const y = oy + r * cp + half;
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        const pos = this.lerpPos(ent, tickT);
        ctx.lineTo(ox + pos.x * cp + half, oy + pos.y * cp + half);
      };

      // 1패스: 흰 외곽선 (라이트에선 얕은 그림자)
      ctx.save();
      if (!this.isDark) {
        ctx.shadowColor = 'rgba(0,0,0,0.18)'; // 그림자 — 팔레트 색 아님
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
      }
      buildPath();
      ctx.strokeStyle = P.white;
      ctx.lineWidth = cp * 0.62;
      ctx.stroke();
      ctx.restore();

      // 2패스: 소유자 색 (다크에선 네온 글로우)
      ctx.save();
      if (this.isDark) {
        ctx.shadowColor = P.ent[ent.id].h;
        ctx.shadowBlur = 10;
      }
      buildPath();
      ctx.strokeStyle = P.ent[ent.id].tr;
      ctx.lineWidth = cp * 0.48;
      ctx.stroke();
      ctx.restore();
    }

    // M3: 꼬리 끝 흰 십자 스파클
    drawSparkle(ent, ox, oy, cp, tickT, now) {
      const ctx = this.ctx;
      const P = this.palette;
      const pos = this.lerpPos(ent, tickT);
      const sx = ox + pos.x * cp + cp / 2;
      const sy = oy + pos.y * cp + cp / 2;
      const tw = Math.sin(now / 120 + ent.id * 2) * 0.5 + 0.5;
      const size = cp * (0.3 + 0.22 * tw);
      ctx.save();
      ctx.globalAlpha *= 0.5 + 0.5 * tw;
      if (this.isDark) {
        ctx.shadowColor = P.ent[ent.id].h;
        ctx.shadowBlur = 8;
      }
      ctx.strokeStyle = P.white;
      ctx.lineCap = 'round';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx - size, sy);
      ctx.lineTo(sx + size, sy);
      ctx.moveTo(sx, sy - size);
      ctx.lineTo(sx, sy + size);
      ctx.stroke();
      ctx.restore();
    }

    // M4: 봇 처치 — 끊긴 지점부터 셀당 20ms 순차 소멸 + 넘어진 마커 + 파편
    drawBotFx(now, ox, oy, cp) {
      const ctx = this.ctx;
      const P = this.palette;
      const s = this.board.size;
      const half = cp / 2;

      for (let f = this.botFx.length - 1; f >= 0; f--) {
        const fx = this.botFx[f];
        const el = now - fx.t0;
        const trail = fx.trail;
        const maxDist = Math.max(fx.cutK, trail.length - 1 - fx.cutK);
        const total = Math.max(maxDist * 20 + 200, 700);
        if (el > total) {
          this.botFx.splice(f, 1);
          continue;
        }

        // 꼬리 순차 소멸 (도트로 축소·페이드)
        ctx.fillStyle = P.ent[fx.id].tr;
        for (let k2 = 0; k2 < trail.length; k2++) {
          const st = Math.abs(k2 - fx.cutK) * 20;
          const ft = (el - st) / 160;
          if (ft >= 1) continue;
          const i = trail[k2];
          const c = i % s;
          const r = (i - c) / s;
          const shrink = ft <= 0 ? 1 : 1 - ft;
          ctx.globalAlpha = shrink;
          ctx.beginPath();
          ctx.arc(ox + c * cp + half, oy + r * cp + half, cp * 0.24 * shrink, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        // 넘어지는 마커 (600ms)
        if (el < 600) {
          const fake = { id: fx.id, c: fx.head.c, r: fx.head.r, pc: fx.head.c, pr: fx.head.r };
          this.drawMarker(fake, ox + fx.head.c * cp + half, oy + fx.head.r * cp, now, el / 600);
        }

        // 파편 도트 (0.5s)
        const pt = el / 500;
        if (pt < 1) {
          const hx = ox + fx.head.c * cp + half;
          const hy = oy + fx.head.r * cp + half;
          ctx.fillStyle = P.ent[fx.id].h;
          ctx.globalAlpha = 1 - pt;
          for (let k2 = 0; k2 < fx.debris.length; k2++) {
            const db = fx.debris[k2];
            const dx = hx + Math.cos(db.a) * db.v * pt;
            const dy = hy + Math.sin(db.a) * db.v * pt + 42 * pt * pt;
            ctx.beginPath();
            ctx.arc(dx, dy, 3.2, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }
    }

    // ---------- 머리 스티커 ----------
    drawHeadSticker(ent, x, y, cp) {
      const ctx = this.ctx;
      const P = this.palette;
      const glow = this.isDark && ent.id === 1;

      ctx.save();
      if (glow) {
        ctx.shadowColor = P.ent[1].h;
        ctx.shadowBlur = 12;
      } else {
        ctx.shadowColor = 'rgba(0,0,0,0.25)'; // 얕은 스티커 그림자
        ctx.shadowBlur = 3;
        ctx.shadowOffsetY = 1;
      }
      ctx.fillStyle = P.ent[ent.id].h;
      this.roundRectPath(x + 2, y + 2, cp - 4, cp - 4, 6);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = P.white;
      ctx.lineWidth = 2.5;
      this.roundRectPath(x + 2, y + 2, cp - 4, cp - 4, 6);
      ctx.stroke();
    }

    roundRectPath(x, y, w, h, rad) {
      const ctx = this.ctx;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, rad);
      else ctx.rect(x, y, w, h);
    }

    // ---------- 아바타 마커 ----------
    drawMarker(ent, headCX, headTopY, now, deathT) {
      const ctx = this.ctx;
      const P = this.palette;
      const S = MARKER_SIZE[ent.id];
      const R = S / 2;
      const tailLen = 12;

      // M6: 이동 중엔 통통, 정지 시에도 1px/1.6s 느린 호흡
      const moving = ent.pc !== ent.c || ent.pr !== ent.r;
      const bob = moving ? Math.sin(now / 110) * 2.5 : Math.sin(now / 255) * 1;

      const cx = headCX;
      const cy = headTopY - tailLen - R + bob;

      ctx.save();
      if (deathT >= 0) {
        ctx.globalAlpha = Math.max(0, 1 - deathT);
        ctx.translate(cx, cy);
        ctx.rotate((Math.PI / 2) * Math.min(1, deathT * 1.4));
        ctx.translate(-cx, -cy);
      }

      const frame = ent.id === 1 ? this.playerFrameColor() : P.ent[ent.id].frame;

      // 말풍선 꼬리
      ctx.fillStyle = frame;
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy + R * 0.6);
      ctx.lineTo(cx + 5, cy + R * 0.6);
      ctx.lineTo(cx, headTopY - 1 + bob);
      ctx.closePath();
      ctx.fill();

      // 꽃잎 프레임 (다크: 플레이어 라임 글로우)
      const glow = this.isDark && ent.id === 1;
      ctx.save();
      if (glow) {
        ctx.shadowColor = P.ent[1].h;
        ctx.shadowBlur = 16;
      }
      ctx.fillStyle = frame;
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const px = cx + Math.cos(a) * R * 0.78;
        const py = cy + Math.sin(a) * R * 0.78;
        ctx.moveTo(px + R * 0.32, py);
        ctx.arc(px, py, R * 0.32, 0, Math.PI * 2);
      }
      ctx.moveTo(cx + R * 0.92, cy);
      ctx.arc(cx, cy, R * 0.92, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 흰 링 + (사진 또는 프리셋 얼굴)
      let style;
      let photoImg = null;
      if (ent.id === 1) {
        style = (MW.Profile && MW.Profile.FACES[this.profile.face]) || 'smile';
        if (this._photoReady && this._photoImg) photoImg = this._photoImg;
      } else {
        style = ent.id === 3 ? 'round' : 'flat';
      }
      this.avatarInner(ctx, cx, cy, R, style, photoImg);

      // 이름 라벨 필 (토큰: 라이트 차콜+라임 / 다크 라임+차콜)
      this.drawLabel(this.names[ent.id] || '?', cx, cy + R + 6, S);

      ctx.restore();
    }

    // 흰 링 + 내부: 사진(원형 클립) 또는 프리셋 얼굴 (ctx 명시 — 마커/썸네일/미리보기 공용)
    avatarInner(ctx, cx, cy, R, style, photoImg) {
      const P = this.palette;
      ctx.fillStyle = P.white;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.7, 0, Math.PI * 2);
      ctx.fill();

      if (photoImg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.6, 0, Math.PI * 2);
        ctx.clip();
        const d = R * 1.2;
        ctx.drawImage(photoImg, cx - R * 0.6, cy - R * 0.6, d, d);
        ctx.restore();
        return;
      }

      ctx.fillStyle = P.face;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.58, 0, Math.PI * 2);
      ctx.fill();
      this.drawFaceStyle(ctx, style || 'smile', cx, cy, R);
    }

    // 프리셋 얼굴 스타일 (§6.5 픽셀 얼굴): smile / flat / round / wink
    drawFaceStyle(ctx, style, cx, cy, R) {
      const P = this.palette;
      const f = R / 17;
      ctx.fillStyle = P.white;
      ctx.strokeStyle = P.white;
      ctx.lineCap = 'round';

      if (style === 'round') {
        ctx.beginPath();
        ctx.arc(cx - 4.5 * f, cy - 2.5 * f, 2 * f, 0, Math.PI * 2);
        ctx.arc(cx + 4.5 * f, cy - 2.5 * f, 2 * f, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy + 3.5 * f, 2.2 * f, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      const ew = 3.5 * f;
      // 왼쪽 눈
      if (style === 'wink') {
        // 윙크: 왼쪽은 가로 선
        ctx.lineWidth = 1.8 * f;
        ctx.beginPath();
        ctx.moveTo(cx - 6.2 * f, cy - 2.8 * f);
        ctx.lineTo(cx - 2.7 * f, cy - 2.8 * f);
        ctx.stroke();
      } else {
        ctx.fillRect(cx - 6 * f, cy - 4.5 * f, ew, ew);
      }
      // 오른쪽 눈 (사각)
      ctx.fillRect(cx + 2.5 * f, cy - 4.5 * f, ew, ew);

      if (style === 'flat') {
        ctx.fillRect(cx - 3.5 * f, cy + 3 * f, 7 * f, 1.8 * f);
      } else {
        // smile / wink: 웃는 입
        ctx.lineWidth = 1.8 * f;
        ctx.beginPath();
        ctx.arc(cx, cy + 1.5 * f, 4.5 * f, Math.PI * 0.18, Math.PI * 0.82);
        ctx.stroke();
      }
    }

    // ---------- 프로필 아바타를 임의 캔버스에 1개 그리기 (HUD 썸네일 · 설정 미리보기) ----------
    // profile 생략 시 현재 커밋된 프로필. photoImg 는 미리보기용 미커밋 사진(Image).
    renderAvatarTo(canvasEl, cssSize, profile, photoImg) {
      if (!canvasEl || !this.palette) return;
      profile = profile || this.profile;
      const ctx = canvasEl.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      canvasEl.width = cssSize * dpr;
      canvasEl.height = cssSize * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssSize, cssSize);

      const cx = cssSize / 2;
      const cy = cssSize / 2;
      const R = cssSize / 2 - Math.max(1, cssSize * 0.03);

      // 프레임 링 (프로필 캔디 색)
      const cand = this.palette.candy;
      ctx.fillStyle = (cand && cand[profile.color]) || this.palette.ent[1].frame;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      const style = (MW.Profile && MW.Profile.FACES[profile.face]) || 'smile';
      // photoImg 미지정 시: 커밋된 프로필의 사진 캐시 사용 (같은 프로필일 때)
      let img = photoImg || null;
      if (!img && profile === this.profile && this._photoReady) img = this._photoImg;
      this.avatarInner(ctx, cx, cy, R * 1.02, style, img);
    }

    // HUD 썸네일 (커밋된 프로필)
    renderThumb(canvasEl) {
      this.renderAvatarTo(canvasEl, 30);
    }

    drawLabel(name, cx, cy, S) {
      const ctx = this.ctx;
      const P = this.palette;
      const fontPx = Math.max(8, Math.round(S * 0.22));

      ctx.save();
      try {
        ctx.letterSpacing = '1px';
      } catch (e) { /* noop */ }
      ctx.font = '800 ' + fontPx + 'px ' + MONO;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const tw = ctx.measureText(name).width;
      const pw = tw + 12;
      const ph = fontPx + 7;

      ctx.fillStyle = P.labelBg;
      this.roundRectPath(cx - pw / 2, cy - ph / 2, pw, ph, ph / 2);
      ctx.fill();
      ctx.strokeStyle = P.white;
      ctx.lineWidth = 1.5;
      this.roundRectPath(cx - pw / 2, cy - ph / 2, pw, ph, ph / 2);
      ctx.stroke();

      ctx.fillStyle = P.labelFg;
      ctx.fillText(name, cx, cy + 0.5);
      ctx.restore();
    }

    // ---------- "+N" 플로트 타이포 (1초) ----------
    drawFloats(now, ox, oy, cp) {
      if (!this.floats.length) return;
      const ctx = this.ctx;
      const P = this.palette;
      ctx.save();
      ctx.font = '900 ' + Math.round(cp * 1.15) + 'px ' + MONO;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      for (let i = this.floats.length - 1; i >= 0; i--) {
        const fl = this.floats[i];
        const t = (now - fl.t0) / FLOAT_MS;
        if (t >= 1) {
          this.floats.splice(i, 1);
          continue;
        }
        const x = ox + fl.x * cp;
        // 아바타 라벨과 겹치지 않게 시작점을 위로 cp*2 띄운다
        const y = oy + fl.y * cp - cp * 2 - t * 34;
        ctx.globalAlpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
        ctx.strokeStyle = P.white;
        ctx.lineWidth = 4;
        ctx.strokeText(fl.text, x, y);
        ctx.fillStyle = P.ent[1].h;
        ctx.fillText(fl.text, x, y);
      }
      ctx.restore();
    }

    // ---------- 대형 점유율 % (캔버스 그래픽 타이포) ----------
    drawBigPct(w, h) {
      const ctx = this.ctx;
      const P = this.palette;
      const s = this.board.size;
      const pct = ((this.game.playerCells || 0) / (s * s)) * 100;
      const text = pct.toFixed(0) + '%';
      ctx.save();
      try {
        ctx.letterSpacing = '2px';
      } catch (e) { /* noop */ }
      ctx.font = '900 64px ' + MONO;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = this.isDark ? 0.2 : 0.15;
      ctx.strokeStyle = P.white; // 스티커 느낌 외곽선
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, w - 14, h - 34);
      ctx.fillStyle = P.ent[1].h;
      ctx.fillText(text, w - 14, h - 34);
      ctx.restore();
    }

    // ---------- M5: 위험 비네트 (자기 꼬리 근접) ----------
    drawDangerVignette(w, h, now) {
      const pl = this.game.player;
      if (this.game.state !== 'playing' || !pl.alive) return;
      const trail = pl.trail;
      if (trail.length < 5) return;

      // 머리 바로 뒤 3칸은 항상 붙어 있으므로 제외하고 최소 맨해튼 거리
      const s = this.board.size;
      let min = 99;
      for (let k = 0; k < trail.length - 3; k++) {
        const i = trail[k];
        const c = i % s;
        const r = (i - c) / s;
        const d = Math.abs(c - pl.c) + Math.abs(r - pl.r);
        if (d < min) min = d;
        if (min === 0) break;
      }
      if (min > 2) return;

      const ctx = this.ctx;
      const pulse = 0.25 * (0.5 + 0.5 * Math.sin(now / 250));
      const g = ctx.createRadialGradient(
        w / 2, h / 2, Math.min(w, h) * 0.38,
        w / 2, h / 2, Math.max(w, h) * 0.72
      );
      g.addColorStop(0, 'transparent');
      g.addColorStop(1, this.palette.danger);
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  window.MW = window.MW || {};
  MW.Renderer = Renderer;
})();
