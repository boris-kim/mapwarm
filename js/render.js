/* MapWarm — 캔버스 렌더러 (아트 디렉션 §6.5: 하드웨어 토이 × 할프톤 스티커)
   - 영토: 할프톤 도트 (8방 이웃 수에 비례한 점 크기, 면 채우기 없음)
   - 꼬리: 라운드 캡슐 폴리라인 2패스 (흰 외곽선 + 소유자 색)
   - 아바타: 부루마블 말 스타일 꽃잎 스티커 마커 + 이름 라벨
   - 색상은 전부 CSS 토큰(getComputedStyle) — 테마를 따라간다 */
(function () {
  'use strict';

  const DOT_MIN = 0.14; // 도트 반지름 최소 (셀 크기 대비, 이웃 0)
  const DOT_MAX = 0.36; // 도트 반지름 최대 (8방 이웃 전부 내 땅)
  const POP_MS = 250;   // 점령 팝 스케일-인 길이

  const NAMES = { 1: 'ME', 2: 'PIKO', 3: 'MOMO' };
  const MARKER_SIZE = { 1: 34, 2: 26, 3: 26 };

  class Renderer {
    constructor(canvas, board, game) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.board = board;
      this.game = game;
      this.cam = { x: board.size / 2, y: board.size / 2 };
      this.palette = null;
      this.isDark = false;

      // 할프톤 도트 캐시 — 영토가 바뀔 때(board.rev 증가)만 다시 계산
      const N = board.size * board.size;
      this.boardRev = -1;
      this.dotR = new Float32Array(N);   // 셀별 도트 반지름 계수 (0 = 도트 없음)
      this.prevOwner = new Uint8Array(N); // 팝 연출용 이전 소유 스냅샷
      this.pops = new Map();              // idx → 팝 시작 시각

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
          frame: tok('--' + prefix + '-frame', head), // 마커 꽃잎 프레임 색
        };
      };
      this.palette = {
        outside: tok('--canvas-outside', '#e6ebe3'),
        bg: tok('--canvas-bg', '#eaebe7'),
        grid: tok('--canvas-grid', 'rgba(0,0,0,0.05)'),
        bound: tok('--canvas-bound', '#9a9b96'),
        mapTint: tok('--map-tint', 'rgba(255,255,255,0.3)'),
        pop: null, // 아래에서 채움 (플레이어 색 폴백)
        // 토큰 미도착 대비 폴백 — ux-architect 토큰이 오면 자동으로 그 값 사용
        white: tok('--sticker-white', tok('--on-primary', '#ffffff')),
        face: tok('--avatar-face', '#2b2b2e'),
        ent: {
          1: entTok('p1'),
          2: entTok('bot1'),
          3: entTok('bot2'),
        },
      };
      this.palette.pop = tok('--pop-color', this.palette.ent[1].h);

      // 다크 여부: 테마 시스템(data-theme + 시스템 선호)을 읽기만 한다
      const t = document.documentElement.getAttribute('data-theme');
      this.isDark =
        t === 'dark' ||
        (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
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
      return {
        x: e.pc + (e.c - e.pc) * t,
        y: e.pr + (e.r - e.pr) * t,
      };
    }

    // ---------- 할프톤 도트 캐시 (영토 변경 시에만) ----------
    updateDots(now) {
      const board = this.board;
      if (board.rev === this.boardRev) return;
      this.boardRev = board.rev;

      const s = board.size;
      const o = board.owner;
      const prev = this.prevOwner;

      // 새로 점령된 셀 → 팝 시작 기록 / 잃은 셀 → 팝 취소
      for (let i = 0; i < o.length; i++) {
        if (o[i] !== 0 && o[i] !== prev[i]) this.pops.set(i, now);
        else if (o[i] === 0) this.pops.delete(i);
      }
      prev.set(o);

      // 도트 반지름: 8방 이웃 중 같은 소유자 수에 비례
      const d = this.dotR;
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
        }
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

      // --- 카메라 ---
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

      // --- 배경 (타일이 없는 영역의 폴백) ---
      ctx.fillStyle = P.outside;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = P.bg;
      ctx.fillRect(ox, oy, s * cp, s * cp);

      // --- 지도 타일 (로드 시 이미 저채도로 구워짐) + 테마 워시 ---
      if (this.game.tileMap) {
        this.game.tileMap.draw(ctx, ox, oy, cp, w, h);
        ctx.fillStyle = P.mapTint;
        ctx.fillRect(0, 0, w, h);
      }

      // --- 보이는 셀 범위 ---
      const c0 = Math.max(0, Math.floor(-ox / cp));
      const r0 = Math.max(0, Math.floor(-oy / cp));
      const c1 = Math.min(s - 1, Math.ceil((w - ox) / cp));
      const r1 = Math.min(s - 1, Math.ceil((h - oy) / cp));

      // --- 격자선 (은은하게, 토큰이 투명이면 안 보임) ---
      ctx.strokeStyle = P.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = c0; c <= c1 + 1; c++) {
        const x = Math.round(ox + c * cp) + 0.5;
        ctx.moveTo(x, oy + r0 * cp);
        ctx.lineTo(x, oy + (r1 + 1) * cp);
      }
      for (let r = r0; r <= r1 + 1; r++) {
        const y = Math.round(oy + r * cp) + 0.5;
        ctx.moveTo(ox + c0 * cp, y);
        ctx.lineTo(ox + (c1 + 1) * cp, y);
      }
      ctx.stroke();

      // --- 영토: 할프톤 도트 ---
      this.drawDots(ox, oy, cp, c0, r0, c1, r1, now);

      // 사망 연출 상태
      const dying = this.game.state === 'dying';
      const deathElapsed = dying ? now - this.game.deathAt : 0;
      const fx = MW.CONFIG.DEATH_FX_MS;

      // --- 꼬리: 캡슐 폴리라인 ---
      const entities = [this.game.player].concat(this.game.bots);
      for (let e = 0; e < entities.length; e++) {
        const ent = entities[e];
        if (!ent.alive || !ent.trail.length) continue;
        const isDyingPlayer = dying && ent === this.game.player;
        if (isDyingPlayer) ctx.globalAlpha = Math.max(0, 1 - deathElapsed / fx); // 꼬리 소멸
        this.drawTrail(ent, ox, oy, cp, tickT);
        ctx.globalAlpha = 1;
      }

      // --- 머리 스티커 + 아바타 마커 ---
      for (let e = 0; e < entities.length; e++) {
        const ent = entities[e];
        if (!ent.alive) continue;
        const pos = this.lerpPos(ent, tickT);
        const hx = ox + pos.x * cp;
        const hy = oy + pos.y * cp;
        const isDyingPlayer = dying && ent === this.game.player;

        // 머리: 라운드 사각 스티커 + 흰 테두리 (사망 중엔 점멸)
        if (isDyingPlayer) {
          ctx.globalAlpha = Math.floor(deathElapsed / 100) % 2 === 0 ? 0.9 : 0.15;
        }
        this.drawHeadSticker(ent, hx, hy, cp);
        ctx.globalAlpha = 1;

        // 마커 (사망 중엔 넘어지며 페이드)
        this.drawMarker(ent, hx + cp / 2, hy, now, isDyingPlayer ? deathElapsed / fx : -1);
      }

      // --- 게임판 경계 ---
      ctx.strokeStyle = P.bound;
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + 1, oy + 1, s * cp - 2, s * cp - 2);
    }

    // ---------- 영토 도트 ----------
    drawDots(ox, oy, cp, c0, r0, c1, r1, now) {
      const ctx = this.ctx;
      const P = this.palette;
      const board = this.board;
      const s = board.size;
      const o = board.owner;
      const d = this.dotR;
      const half = cp / 2;

      // 팝이 끝난 항목 정리 (매 프레임 소량)
      if (this.pops.size) {
        this.pops.forEach((t0, i) => {
          if (now - t0 >= POP_MS) this.pops.delete(i);
        });
      }

      // 1) 팝 중이 아닌 도트: 소유자별로 경로를 모아 한 번에 채움 (fillStyle 전환 최소화)
      for (let id = 1; id <= 3; id++) {
        ctx.fillStyle = P.ent[id].t;
        ctx.beginPath();
        for (let r = r0; r <= r1; r++) {
          const base = r * s;
          for (let c = c0; c <= c1; c++) {
            const i = base + c;
            if (o[i] !== id || !d[i] || this.pops.has(i)) continue;
            const cx = ox + c * cp + half;
            const cy = oy + r * cp + half;
            const rad = d[i] * cp;
            ctx.moveTo(cx + rad, cy);
            ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          }
        }
        ctx.fill();
      }

      // 2) 팝 중인 도트: 개별로 스케일 인 (0 → 목표, ease-out) — 초반엔 팝 색으로 반짝
      if (this.pops.size) {
        this.pops.forEach((t0, i) => {
          const c = i % s;
          const r = (i - c) / s;
          if (c < c0 || c > c1 || r < r0 || r > r1) return;
          if (!d[i]) return;
          const t = Math.min(1, (now - t0) / POP_MS);
          const ease = 1 - Math.pow(1 - t, 3);
          const cx = ox + c * cp + half;
          const cy = oy + r * cp + half;
          const rad = d[i] * cp * ease;
          if (rad <= 0.2) return;
          ctx.fillStyle = t < 0.4 ? P.pop : P.ent[o[i]].t;
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }

    // ---------- 꼬리 캡슐 ----------
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
        // 끝점 = 보간된 머리 위치 (캡슐이 머리를 따라 미끄러진다)
        const pos = this.lerpPos(ent, tickT);
        ctx.lineTo(ox + pos.x * cp + half, oy + pos.y * cp + half);
      };

      // 2패스: 흰 외곽선(굵게) → 소유자 색(가늘게)
      buildPath();
      ctx.strokeStyle = P.white;
      ctx.lineWidth = cp * 0.62;
      ctx.stroke();

      buildPath();
      ctx.strokeStyle = P.ent[ent.id].tr;
      ctx.lineWidth = cp * 0.34;
      ctx.stroke();
    }

    // ---------- 머리 스티커 ----------
    drawHeadSticker(ent, x, y, cp) {
      const ctx = this.ctx;
      const P = this.palette;
      const glow = this.isDark && ent.id === 1; // 다크: 플레이어만 라임 글로우

      ctx.save();
      if (glow) {
        ctx.shadowColor = P.ent[1].h;
        ctx.shadowBlur = 12;
      } else {
        // 얕은 스티커 그림자 (색 아님 — 투명 검정)
        ctx.shadowColor = 'rgba(0,0,0,0.25)';
        ctx.shadowBlur = 3;
        ctx.shadowOffsetY = 1;
      }
      ctx.fillStyle = P.ent[ent.id].h;
      this.roundRectPath(x + 2, y + 2, cp - 4, cp - 4, 6);
      ctx.fill();
      ctx.restore();

      // 흰 스티커 테두리
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

    // ---------- 부루마블 아바타 마커 ----------
    // deathT: -1 = 정상, 0~1 = 사망 진행도 (넘어지며 페이드)
    drawMarker(ent, headCX, headTopY, now, deathT) {
      const ctx = this.ctx;
      const P = this.palette;
      const S = MARKER_SIZE[ent.id];
      const R = S / 2;
      const tailLen = 12;

      // 이동 중이면 살짝 bob
      const moving = ent.pc !== ent.c || ent.pr !== ent.r;
      const bob = moving ? Math.sin(now / 110) * 2.5 : 0;

      const cx = headCX;
      const cy = headTopY - tailLen - R + bob;

      ctx.save();
      if (deathT >= 0) {
        // 죽음: 마커가 훽 넘어지며 사라진다
        ctx.globalAlpha = Math.max(0, 1 - deathT);
        ctx.translate(cx, cy);
        ctx.rotate((Math.PI / 2) * Math.min(1, deathT * 1.4));
        ctx.translate(-cx, -cy);
      }

      const frame = P.ent[ent.id].frame;

      // 말풍선 꼬리 (아래로)
      ctx.fillStyle = frame;
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy + R * 0.6);
      ctx.lineTo(cx + 5, cy + R * 0.6);
      ctx.lineTo(cx, headTopY - 1 + bob);
      ctx.closePath();
      ctx.fill();

      // 꽃잎 스티커 프레임: 원 10개 + 중심 원 (다크에선 플레이어만 글로우)
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

      // 흰 링
      ctx.fillStyle = P.white;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.7, 0, Math.PI * 2);
      ctx.fill();

      // 얼굴: 차콜 원 + 픽셀 이목구비
      ctx.fillStyle = P.face;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.58, 0, Math.PI * 2);
      ctx.fill();
      this.drawFace(ent.id, cx, cy, R);

      // 이름 라벨 필
      this.drawLabel(NAMES[ent.id] || '?', cx, cy + R + 6, S);

      ctx.restore();
    }

    drawFace(id, cx, cy, R) {
      const ctx = this.ctx;
      const P = this.palette;
      const f = R / 17; // 플레이어 기준 스케일
      ctx.fillStyle = P.white;

      if (id === 3) {
        // MOMO: 동그란 눈 + 동그란 입
        ctx.beginPath();
        ctx.arc(cx - 4.5 * f, cy - 2.5 * f, 2 * f, 0, Math.PI * 2);
        ctx.arc(cx + 4.5 * f, cy - 2.5 * f, 2 * f, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy + 3.5 * f, 2.2 * f, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      // ME / PIKO: 사각 픽셀 눈
      const ew = 3.5 * f;
      ctx.fillRect(cx - 6 * f, cy - 4.5 * f, ew, ew);
      ctx.fillRect(cx + 2.5 * f, cy - 4.5 * f, ew, ew);

      if (id === 1) {
        // ME: 웃는 입 (라운드 스트로크)
        ctx.strokeStyle = P.white;
        ctx.lineWidth = 1.8 * f;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy + 1.5 * f, 4.5 * f, Math.PI * 0.18, Math.PI * 0.82);
        ctx.stroke();
      } else {
        // PIKO: 일자 입
        ctx.fillRect(cx - 3.5 * f, cy + 3 * f, 7 * f, 1.8 * f);
      }
    }

    drawLabel(name, cx, cy, S) {
      const ctx = this.ctx;
      const P = this.palette;
      const fontPx = Math.max(7, Math.round(S * 0.26));

      ctx.save();
      try {
        ctx.letterSpacing = '1px'; // 미지원 브라우저는 무시
      } catch (e) { /* noop */ }
      ctx.font = '700 ' + fontPx + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const tw = ctx.measureText(name).width;
      const pw = tw + 10;
      const ph = fontPx + 6;

      // 차콜 스티커 필 + 흰 테두리
      ctx.fillStyle = P.face;
      this.roundRectPath(cx - pw / 2, cy - ph / 2, pw, ph, ph / 2);
      ctx.fill();
      ctx.strokeStyle = P.white;
      ctx.lineWidth = 1.5;
      this.roundRectPath(cx - pw / 2, cy - ph / 2, pw, ph, ph / 2);
      ctx.stroke();

      ctx.fillStyle = P.white;
      ctx.fillText(name, cx, cy + 0.5);
      ctx.restore();
    }
  }

  window.MW = window.MW || {};
  MW.Renderer = Renderer;
})();
