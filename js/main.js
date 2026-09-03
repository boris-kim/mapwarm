/* MapWarm — 게임 오케스트레이션 v0.2 "식지 않는 동네"
   - 데모 모드: 기존 3분 아레나 (라운드·40% 승리·사망) 그대로
   - GPS 모드: 무사망 영속 월드 — 온기·봇 잠식·주간 정복 카드·조기 닫힘 */
(function () {
  'use strict';

  const C = MW.CONFIG;

  class Game {
    constructor() {
      this.board = new MW.Board(C.GRID);
      this.player = new MW.Entity(MW.ID.PLAYER, this.board);
      this.bots = [
        new MW.Bot(MW.ID.BOT1, this.board),
        new MW.Bot(MW.ID.BOT2, this.board),
      ];

      this.state = 'playing'; // 'playing' | 'dying' | 'ended' (dying/ended = 데모 전용)
      this.mode = 'demo';     // 'demo' | 'gps'

      // 데모 라운드 & 정복 카드
      this.round = new MW.Round(C.ROUND_MS_DEMO, C.WIN_PCT);
      this.card = new MW.ConquestCard(this);
      this.result = null;
      this.cuts = 0;
      this.cutKills = {};
      this.tickCount = 0;
      this.deathReason = '';

      // v0.2 온기 & 영속 월드 (GPS 전용)
      this.warmth = new MW.Warmth(C.GRID);
      this.world = null;          // {anchor:{lat,lng}, onboarded}
      this.weekly = this.freshWeek();
      this.walkReheated = 0;      // 이번 산책에서 재가열한 칸
      this._preOwner = new Uint8Array(C.GRID * C.GRID); // 점령 직전 스냅샷 (온기 부여용)
      this._hintShown = false;    // 온보딩 힌트 (산책당 1회)
      this.overlayMode = 'round'; // 'round' | 'report' | 'weekly'
      this.overlayQueue = [];

      this.best = 0;
      try {
        this.best = parseFloat(localStorage.getItem('mapwarm-best') || '0') || 0;
      } catch (e) { /* 저장 불가 환경 무시 */ }

      // DOM 참조
      this.$occ = document.getElementById('occupancy');
      this.$best = document.getElementById('best');
      this.$overlay = document.getElementById('overlay');
      this.$resultTitle = document.getElementById('result-title');
      this.$deathReason = document.getElementById('death-reason');
      this.$badge = document.getElementById('gps-badge');
      this.$toast = document.getElementById('toast');
      this.$timeChip = document.getElementById('chip-time');
      this.$time = document.getElementById('round-time');
      this.$timeLabel = this.$timeChip.querySelector('.chip-time-label');
      this.$cardCanvas = document.getElementById('card-canvas');
      this.$mapToggleWrap = document.querySelector('.card-map-toggle');
      this.$shareBtn = document.getElementById('share-btn');
      this.$overlayBtn = document.getElementById('restart-btn');
      this.toastTimer = null;
      this._timeTxt = '';
      this._timeWarn = false;

      // 사망 연출 타이머 (데모)
      this.deathAt = 0;
      this.deathTimer = null;

      // 실제 지도 배경: 데모 anchor = 서울시청, GPS 모드에선 저장된 동네 또는 첫 fix
      const mid0 = C.GRID >> 1;
      this.geo = new MW.Geo(C.DEMO_ANCHOR.lat, C.DEMO_ANCHOR.lng, mid0 + 0.5, mid0 + 0.5);
      this.tileMap = new MW.TileMap();
      this.tileMap.setGeo(this.geo);

      const area = document.getElementById('game-area');
      const joy = document.getElementById('joystick');
      this.input = new MW.Input(area, joy);
      this.gps = new MW.GpsController(this);
      this.renderer = new MW.Renderer(document.getElementById('game'), this.board, this);

      // 소리 + 햅틱: 첫 사용자 제스처에서 AudioContext 활성화 (autoplay 정책)
      this.audio = new MW.AudioFx();
      const unlock = () => this.audio.unlock();
      // iOS Safari는 touchend/click에서만 오디오를 풀어주므로 여러 제스처에 모두 건다
      ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach((ev) => {
        window.addEventListener(ev, unlock, { passive: true });
      });
      this._dangerWasNear = false; // 위험 경고음 엣지 트리거

      // 음소거 토글 (HUD 아이콘)
      this.$muteBtn = document.getElementById('mute-btn');
      if (this.$muteBtn) {
        this.updateMuteUI();
        this.$muteBtn.addEventListener('click', () => {
          this.audio.unlock();
          this.audio.toggleMute();
          this.updateMuteUI();
          this.updateBgmUI(); // 전체 음소거는 BGM도 끄므로 아이콘 동기화
        });
      }

      // BGM 전용 토글 (음악만 끄고 효과음은 유지)
      this.$bgmBtn = document.getElementById('bgm-btn');
      if (this.$bgmBtn) {
        this.updateBgmUI();
        this.$bgmBtn.addEventListener('click', () => {
          this.audio.unlock();
          this.audio.toggleBgm();
          this.updateBgmUI();
        });
      }

      // 탭 백그라운드/복귀 시 오디오 컨텍스트 suspend/resume (배터리·iOS 무음)
      document.addEventListener('visibilitychange', () => {
        this.audio.setActive(!document.hidden);
      });

      // 모드 토글
      document.querySelectorAll('.mode-option').forEach((btn) => {
        btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
      });

      // 오버레이 버튼: 데모 라운드 = 다시 시작 / GPS 리포트·주간 카드 = 닫기
      this.$overlayBtn.addEventListener('click', () => this.onOverlayBtn());
      this.$shareBtn.addEventListener('click', () => this.shareCard());

      // "지도 배경 포함" 토글 (기본 꺼짐 — 프라이버시)
      this.cardMapOn = false;
      try {
        this.cardMapOn = localStorage.getItem('mapwarm-card-map') === '1';
      } catch (e) { /* noop */ }
      const $mapToggle = document.getElementById('card-map-toggle');
      $mapToggle.checked = this.cardMapOn;
      $mapToggle.addEventListener('change', () => {
        this.cardMapOn = $mapToggle.checked;
        try {
          localStorage.setItem('mapwarm-card-map', this.cardMapOn ? '1' : '0');
        } catch (e) { /* noop */ }
        if (this.result) this.renderCard();
      });

      this.$best.textContent = this.best.toFixed(1) + '%';

      // 점유율 칩 pop & 델타
      this.chipTimer = null;
      this.playerCells = 0;

      // 결과 화면이 떠 있는 동안 카드 최신 유지 (타일 로드 / 테마 전환)
      this._cardRerenderTimer = null;
      this.tileMap.onLoad = () => {
        if (!this.$overlay.classList.contains('hidden') && this.result && this.cardMapOn) {
          clearTimeout(this._cardRerenderTimer);
          this._cardRerenderTimer = setTimeout(() => this.renderCard(), 150);
        }
      };
      document.addEventListener('mw:themechange', () => {
        if (!this.$overlay.classList.contains('hidden') && this.result) this.renderCard();
      });

      // 첫 진입 타일 안내
      setTimeout(() => {
        let loaded = false;
        this.tileMap.cache.forEach((t) => {
          if (t.status === 'ok') loaded = true;
        });
        if (!loaded) this.toast('지도를 불러오는 중…');
      }, 800);

      // GPS 월드 보존: 떠날 때 저장
      window.addEventListener('beforeunload', () => this.saveWorld());

      this.reset();
    }

    freshWeek() {
      return {
        start: MW.Weekly.mondayStart(Date.now()),
        maxCells: 0,
        maxOwner: null,
        gained: 0,
        walks: 0,
      };
    }

    // ---------- 데모 라운드 초기화 ----------
    reset() {
      this.board.clearAll();
      const mid = C.GRID >> 1;
      this.player.spawn(mid, mid);

      for (let i = 0; i < this.bots.length; i++) {
        const b = this.bots[i];
        b.queue = [];
        b.respawnTimer = 0;
        b.wait = 4 + ((Math.random() * 8) | 0);
        const p = this.findSpawn();
        b.spawn(p.c, p.r);
      }

      clearTimeout(this.deathTimer);
      this.state = 'playing';
      this.result = null;
      this.cuts = 0;
      this.cutKills = {};
      this.tickCount = 0;
      this.round.reset(C.ROUND_MS_DEMO);
      this.$overlay.classList.add('hidden');
      this.renderer.cam.x = mid + 0.5;
      this.renderer.cam.y = mid + 0.5;
      this.updateOccupancy();
      if (this.mode === 'demo') this.updateTimeChip();
    }

    findSpawn() {
      const s = C.GRID;
      for (let i = 0; i < 60; i++) {
        const c = 3 + ((Math.random() * (s - 6)) | 0);
        const r = 3 + ((Math.random() * (s - 6)) | 0);
        if (Math.abs(c - this.player.c) + Math.abs(r - this.player.r) < 12) continue;
        let free = true;
        for (let dr = -1; dr <= 1 && free; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (this.board.ownerAt(c + dc, r + dr) !== 0) {
              free = false;
              break;
            }
          }
        }
        if (free) return { c, r };
      }
      return {
        c: 5 + ((Math.random() * (s - 10)) | 0),
        r: 5 + ((Math.random() * (s - 10)) | 0),
      };
    }

    // ---------- 로직 틱 (초당 8회) ----------
    tick() {
      if (this.state !== 'playing') return;

      this.tickCount++;
      const gps = this.mode === 'gps';
      if (!gps) this.round.tick();

      // 1) 플레이어 이동
      let dir = gps ? this.gps.getDir(this.player) : this.input.getDir();

      // 데모: 꼬리 있을 때 180° 역주행 무시 (즉사 오조작 방지)
      if (
        dir && !gps &&
        this.player.hasTrail() && this.player.lastDir &&
        dir[0] === -this.player.lastDir[0] && dir[1] === -this.player.lastDir[1]
      ) {
        dir = null;
      }

      if (gps) this._preOwner.set(this.board.owner);
      const fromC = this.player.c;
      const fromR = this.player.r;
      const res = this.player.step(dir);

      // 발소리: 플레이어가 실제로 새 셀로 진입한 순간 (봇 이동엔 소리 없음)
      if ((this.player.c !== fromC || this.player.r !== fromR) && this.audio) {
        const every = gps ? C.STEP_GPS_EVERY : C.STEP_DEMO_EVERY;
        this._stepCount = (this._stepCount || 0) + 1;
        if (this._stepCount % every === 0) this.audio.footstep();
      }

      if (res === 'self-trail') {
        if (gps) {
          this.earlyClose(); // 무사망: 교차점에서 루프 조기 닫힘
        } else {
          this.killPlayer('자기 꼬리를 밟았어요.');
          return;
        }
      } else if (res === 'captured') {
        const gained = this.board.count(MW.ID.PLAYER) - this.playerCells;
        this.afterCapture(this.player);
        this.captureFx(gained);
        if (gps) this.onLoopClosed(gained);
      } else if (res === 'moved' && gps) {
        if (!this.player.hasTrail()) {
          // 내 땅 위를 걷는 중 → 주변 재가열 (출근길 = 방어)
          this.walkReheated += this.warmth.reheatAround(
            this.board, this.player.c, this.player.r, C.REHEAT_RADIUS, Date.now()
          );
        } else if (this.world && !this.world.onboarded && !this._hintShown) {
          this._hintShown = true;
          this.toast('한 바퀴 돌아 시작점으로! ↻');
        }
      }
      if (this.state !== 'playing') return;

      // 2) 봇 이동 — GPS는 사람 걸음 페이스(1칸당 ~3.5초)
      const botEvery = gps ? Math.max(1, Math.round(C.BOT_GPS_STEP_MS / C.TICK_MS)) : 1;
      for (let i = 0; i < this.bots.length; i++) {
        const b = this.bots[i];
        if (!b.alive || this.tickCount % botEvery === 0) {
          b.tickAI(this);
        } else {
          b.pc = b.c;
          b.pr = b.r;
          if (b.wait > 0) b.wait--; // 대기는 실시간(틱) 기준
        }
        if (this.state !== 'playing') return;
      }

      // 3) 꼬리 끊기 판정
      const all = [this.player].concat(this.bots);
      for (let a = 0; a < all.length; a++) {
        const ea = all[a];
        if (!ea.alive) continue;
        const i = this.board.idx(ea.c, ea.r);
        for (let b = 0; b < all.length; b++) {
          const eb = all[b];
          if (eb === ea || !eb.alive) continue;
          if (eb.trailSet.has(i)) {
            if (eb === this.player) {
              if (gps) {
                // 무사망: 산책 경로만 리셋
                eb.trail = [];
                eb.trailSet.clear();
                this.toast('봇이 산책 경로를 끊었어요! 다시 감싸자');
                continue;
              }
              this.killPlayer('봇이 내 꼬리를 밟았어요.');
              return;
            }
            if (ea === this.player) {
              this.cuts++;
              this.cutKills[eb.id] = (this.cutKills[eb.id] || 0) + 1;
            }
            this.killBot(eb, i);
          }
        }
      }

      this.updateOccupancy();

      // 위험 경고음: 머리가 자기 꼬리와 맨해튼 ≤2 (M5 비네트와 동일 조건, 진입 순간에만)
      const near = this.playerNearOwnTrail();
      if (near && !this._dangerWasNear && this.audio) this.audio.danger();
      this._dangerWasNear = near;

      if (gps) {
        this.updateWeekChip();
        // 플레이 중에도 온기 냉각 점검 (30초마다) & 자동 저장 (10초마다)
        if (this.tickCount % C.DECAY_CHECK_TICKS === 0) {
          const cooled = this.warmth.applyDecay(this.board, Date.now());
          if (cooled) this.updateOccupancy();
        }
        if (this.tickCount % C.WORLD_SAVE_TICKS === 0) this.saveWorld();
      } else {
        this.updateTimeChip();
        // 데모 라운드 판정: 40% 즉시 승리 > 시간 종료(점유율 순위)
        const verdict = this.round.check(this.occupancyPct());
        if (verdict === 'win') {
          this.endRound('win', '점유율 ' + C.WIN_PCT + '% 달성 — 즉시 승리!');
        } else if (verdict === 'timeup') {
          const botCells = this.bots.map((b) => this.board.count(b.id));
          const won = MW.Round.rankWin(this.playerCells, botCells);
          this.endRound(
            won ? 'win' : 'lose',
            won ? '시간 종료 — 점유율 1위!' : '시간 종료 — 점유율 순위에서 밀렸어요.'
          );
        }
      }
    }

    // 머리가 자기 꼬리(직전 3칸 제외)와 맨해튼 거리 ≤2인가 (위험 경고용)
    playerNearOwnTrail() {
      const p = this.player;
      const trail = p.trail;
      if (!p.alive || trail.length < 5) return false;
      const s = C.GRID;
      for (let k = 0; k < trail.length - 3; k++) {
        const i = trail[k];
        const c = i % s;
        const r = (i - c) / s;
        if (Math.abs(c - p.c) + Math.abs(r - p.r) <= 2) return true;
      }
      return false;
    }

    // ---------- GPS: 자기 꼬리 교차 = 루프 조기 닫힘 (무사망) ----------
    earlyClose() {
      const b = this.board;
      const p = this.player;
      const i = b.idx(p.c, p.r);
      const k = Math.max(0, p.trail.indexOf(i));
      const loop = p.trail.slice(k); // 교차점부터 = 닫힌 루프. 앞부분 꼬리는 소멸
      b.capture(MW.ID.PLAYER, loop);
      p.trail = [];
      p.trailSet.clear();
      const gained = b.count(MW.ID.PLAYER) - this.playerCells;
      this.afterCapture(this.player);
      if (this.audio) this.audio.earlyClose(); // 조기 닫힘 전용 낮은 톤 + 패턴 진동
      this.captureFx(gained, true); // 팝 연출은 유지, 점령 사운드는 억제
      this.onLoopClosed(gained);
    }

    // GPS: 루프 닫힘 = 산책 세션 종료
    onLoopClosed(gained) {
      this._hintShown = false;
      const g = Math.max(0, gained);
      this.weekly.gained += g;
      this.weekly.walks++;
      if (this.playerCells > this.weekly.maxCells) {
        this.weekly.maxCells = this.playerCells;
        this.weekly.maxOwner = Array.from(this.board.owner); // 주간 최대 영토 스냅샷
      }
      // 새로 점령된 셀 온기 1.0
      const now = Date.now();
      const o = this.board.owner;
      for (let i = 0; i < o.length; i++) {
        if (o[i] === MW.ID.PLAYER && this._preOwner[i] !== MW.ID.PLAYER) this.warmth.heat(i, now);
      }
      this.toast('이번 산책: +' + g + '칸 · 재가열 ' + this.walkReheated + '칸');
      this.walkReheated = 0;
      if (this.world && !this.world.onboarded) this.world.onboarded = true;
      this.saveWorld();
    }

    // 점령 직후: 영토를 전부 빼앗긴 상대 처리 (GPS 플레이어는 무사망)
    afterCapture(byEntity) {
      this.updateOccupancy();
      const all = [this.player].concat(this.bots);
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (e === byEntity || !e.alive) continue;
        if (this.board.count(e.id) === 0) {
          if (e === this.player) {
            if (this.mode === 'gps') {
              this.toast('영토를 모두 빼앗겼어요 — 어디서든 한 바퀴 = 새 거점!');
            } else {
              this.killPlayer('영토를 모두 빼앗겼어요.');
            }
          } else {
            this.killBot(e);
          }
        }
      }
    }

    captureFx(gained, silentAudio) {
      const chip = document.querySelector('.chip-occupancy');
      if (chip) {
        chip.classList.remove('pop');
        void chip.offsetWidth;
        chip.classList.add('pop');
        clearTimeout(this.chipTimer);
        this.chipTimer = setTimeout(() => chip.classList.remove('pop'), 320);
      }
      if (gained > 0 && !silentAudio && this.audio) this.audio.capture(); // 점령 팝 + 짧은 진동
      if (gained >= 8) this.toast('+' + gained + ' 땅을 먹었다!');
      if (gained >= 20 && this.renderer) this.renderer.zoomPulse();
    }

    killBot(bot, cutCellIdx) {
      if (this.renderer) this.renderer.addBotDeathFx(bot, cutCellIdx);
      // 내가 직접 끊은 처치만 사운드(밤새 잠식·리스폰 정리 등엔 무음)
      if (cutCellIdx != null && this.audio) this.audio.botKill();
      bot.die();
      bot.respawnTimer = C.BOT_RESPAWN_TICKS;
    }

    respawnBot(bot) {
      const p = this.findSpawn();
      bot.queue = [];
      bot.wait = 6 + ((Math.random() * 10) | 0);
      bot.spawn(p.c, p.r);
    }

    // ---------- 사망 (데모 전용) ----------
    killPlayer(reason) {
      if (this.state !== 'playing') return;
      this.state = 'dying';
      this.deathAt = performance.now();
      this.deathReason = reason;
      clearTimeout(this.deathTimer);
      this.deathTimer = setTimeout(() => this.finishDeath(), C.DEATH_FX_MS);
    }

    finishDeath() {
      this.buildResult('death', this.deathReason);
      this.player.die();
      this.state = 'ended';
      this.updateOccupancy();
      this.showResult();
    }

    // ---------- 판 종료 & 정복 카드 (데모) ----------
    endRound(outcome, reason) {
      if (this.state !== 'playing') return;
      this.buildResult(outcome, reason);
      this.state = 'ended';
      this.showResult();
    }

    buildResult(outcome, reason) {
      this.result = {
        outcome,
        reason,
        pct: this.occupancyPct(),
        elapsedMs: this.round.elapsedMs(),
        cuts: this.cuts,
        kills: Object.assign({}, this.cutKills),
        owner: this.board.owner.slice(),
      };
    }

    showResult() {
      const r = this.result;
      this.showPanel({
        mode: 'round',
        title: r.outcome === 'win' ? '승리!' : r.outcome === 'death' ? '사망!' : '패배',
        win: r.outcome === 'win',
        reason: r.reason || '',
        card: true,
        btn: '다시 시작',
      });
      this.renderCard();
    }

    // ---------- 오버레이 패널 (라운드/리포트/주간 공용) ----------
    showPanel(opts) {
      this.overlayMode = opts.mode;
      this.$resultTitle.textContent = opts.title;
      this.$resultTitle.classList.toggle('win', !!opts.win);
      this.$deathReason.textContent = opts.reason || '';
      const cardOn = !!opts.card;
      this.$cardCanvas.classList.toggle('hidden', !cardOn);
      this.$mapToggleWrap.classList.toggle('hidden', !cardOn);
      this.$shareBtn.classList.toggle('hidden', !cardOn);
      this.$overlayBtn.textContent = opts.btn;
      this.$overlay.classList.remove('hidden');
    }

    onOverlayBtn() {
      if (this.overlayMode === 'round') {
        this.reset();
        return;
      }
      this.$overlay.classList.add('hidden');
      this.result = null;
      const next = this.overlayQueue.shift();
      if (next) next();
    }

    renderCard() {
      if (!this.result) return;
      this.card.render(this.$cardCanvas, this.result, this.cardMapOn);
    }

    shareCard() {
      if (!this.result) return;
      this.renderCard();
      this.card.share(this.$cardCanvas, this.result);
    }

    // ---------- v0.2: 유령 리포트 & 주간 카드 ----------
    showGhostReport(cooled, taken) {
      if (this.audio) this.audio.report();
      this.showPanel({
        mode: 'report',
        title: '밤새 리포트',
        win: false,
        reason: cooled + '칸이 식어서 사라졌고, 봇이 ' + taken + '칸을 가져갔어요.',
        card: false,
        btn: '탈환하러 가기',
      });
    }

    // D1~D4 능동 훅: 잠식 전이라도 평균 온기가 떨어졌으면 "지키러 나가라" 경고
    showColdAlert(lukewarm) {
      if (this.audio) this.audio.report();
      this.showPanel({
        mode: 'report',
        title: '동네가 식고 있어요',
        win: false,
        reason: lukewarm + '칸이 미지근해졌어요. 지금 나가서 다시 데우세요 🔥',
        card: false,
        btn: '데우러 가기',
      });
    }

    // 내 영토 평균 온기 (0~1). 영토 없으면 1로 취급(경고 안 함)
    avgWarmth(now) {
      const o = this.board.owner;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < o.length; i++) {
        if (o[i] === MW.ID.PLAYER) {
          sum += this.warmth.warmAt(i, now);
          n++;
        }
      }
      return n ? sum / n : 1;
    }

    // 온기 <0.7 인 내 셀 수 (경고 문구용)
    lukewarmCount(now) {
      const o = this.board.owner;
      let n = 0;
      for (let i = 0; i < o.length; i++) {
        if (o[i] === MW.ID.PLAYER && this.warmth.warmAt(i, now) < C.WARM_ALERT_AVG) n++;
      }
      return n;
    }

    showWeeklyCard(week) {
      const N = C.GRID * C.GRID;
      this.result = {
        outcome: 'win',
        weekly: true,
        weekNum: MW.Weekly.weekNum(week.start),
        reason: '',
        pct: (week.maxCells / N) * 100,
        elapsedMs: 0,
        cuts: 0,
        kills: {},
        gained: week.gained || 0,
        walks: week.walks || 0,
        owner: Uint8Array.from(week.maxOwner),
      };
      if (this.audio) this.audio.report();
      this.showPanel({
        mode: 'weekly',
        title: '주간 정복 카드',
        win: true,
        reason: '지난주 최대 영토 스냅샷',
        card: true,
        btn: '계속 걷기',
      });
      this.renderCard();
    }

    updateMuteUI() {
      if (!this.$muteBtn) return;
      const m = this.audio.muted;
      this.$muteBtn.classList.toggle('muted', m);
      this.$muteBtn.setAttribute('aria-pressed', String(m));
      this.$muteBtn.setAttribute('aria-label', m ? '소리 켜기' : '소리 끄기');
    }

    updateBgmUI() {
      if (!this.$bgmBtn) return;
      // 전체 음소거면 BGM 버튼도 꺼진 것으로 보이게
      const off = !this.audio.bgmOn || this.audio.muted;
      this.$bgmBtn.classList.toggle('muted', off);
      this.$bgmBtn.disabled = this.audio.muted;
      this.$bgmBtn.setAttribute('aria-pressed', String(!off));
      this.$bgmBtn.setAttribute('aria-label', this.audio.bgmOn ? '음악 끄기' : '음악 켜기');
    }

    // ---------- HUD ----------
    occupancyPct() {
      return (this.board.count(MW.ID.PLAYER) / (C.GRID * C.GRID)) * 100;
    }

    updateOccupancy() {
      this.playerCells = this.board.count(MW.ID.PLAYER);
      const pct = (this.playerCells / (C.GRID * C.GRID)) * 100;
      if (pct !== this._pctTarget) {
        this._pctTarget = pct;
        this.rollOccupancy(pct);
      }
      if (pct > this.best) {
        this.best = pct;
        try {
          localStorage.setItem('mapwarm-best', String(pct));
        } catch (e) { /* noop */ }
        this.$best.textContent = pct.toFixed(1) + '%';
      }
    }

    rollOccupancy(to) {
      const from = this._pctShown != null ? this._pctShown : to;
      cancelAnimationFrame(this._rollRaf);
      const t0 = performance.now();
      const step = (n) => {
        const t = Math.min(1, (n - t0) / 300);
        const v = from + (to - from) * t;
        this._pctShown = v;
        this.$occ.textContent = v.toFixed(1) + '%';
        if (t < 1) this._rollRaf = requestAnimationFrame(step);
      };
      this._rollRaf = requestAnimationFrame(step);
    }

    // 데모: 남은 시간 mm:ss (30초 이하 핑크)
    updateTimeChip() {
      if (this.$timeLabel.textContent !== 'TIME') this.$timeLabel.textContent = 'TIME';
      const rem = this.round.remainingMs();
      const txt = MW.Round.fmt(rem);
      if (txt !== this._timeTxt) {
        this._timeTxt = txt;
        this.$time.textContent = txt;
      }
      const warn = rem <= C.TIME_WARN_MS;
      if (warn !== this._timeWarn) {
        this._timeWarn = warn;
        this.$timeChip.classList.toggle('warn', warn);
      }
    }

    // GPS: 이번 주 정산까지 D-day
    updateWeekChip() {
      if (this.$timeLabel.textContent !== 'WEEK') this.$timeLabel.textContent = 'WEEK';
      const txt = 'D-' + MW.Weekly.daysToNextMonday(Date.now());
      if (txt !== this._timeTxt) {
        this._timeTxt = txt;
        this.$time.textContent = txt;
      }
      if (this._timeWarn) {
        this._timeWarn = false;
        this.$timeChip.classList.remove('warn');
      }
    }

    // ---------- 모드 전환 ----------
    setMode(mode) {
      if (mode === this.mode) return;
      if (mode === 'gps') {
        this.mode = 'gps';
        this.input.setEnabled(false);
        clearTimeout(this.deathTimer);
        this.state = 'playing';
        this.$overlay.classList.add('hidden');
        // 데모 아레나 잔상 정리 — 월드는 첫 fix에서 로드
        this.board.clearAll();
        this.warmth.clearAll();
        this.player.trail = [];
        this.player.trailSet.clear();
        for (let i = 0; i < this.bots.length; i++) {
          this.bots[i].alive = false;
          this.bots[i].respawnTimer = 999999; // 월드 로드 때 respawnBot으로 되살림
        }
        this.renderer.syncBaseline();
        this.gps.start();
        this.updateWeekChip();
        this.toast('위치 권한을 요청하는 중…');
      } else {
        this.saveWorld(); // 떠나기 전 월드 저장
        this.mode = 'demo';
        this.world = null;
        this.warmth.clearAll();
        this.gps.stop();
        this.input.setEnabled(true);
        this.$badge.classList.add('hidden');
        this.resetGeoToDemo();
        this.reset(); // 데모 아레나 새 판
      }
      document.querySelectorAll('.mode-option').forEach((btn) => {
        const on = btn.dataset.mode === this.mode;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-checked', String(on));
      });
    }

    gpsStarted() {
      this.toast('GPS 모드 시작! 실제로 걸으면 이동해요.');
    }

    // 데모 복귀: 지도 기준점을 데모 anchor(서울시청)로 되돌린다
    resetGeoToDemo() {
      const mid = C.GRID >> 1;
      this.geo.setAnchor(C.DEMO_ANCHOR.lat, C.DEMO_ANCHOR.lng, mid + 0.5, mid + 0.5);
      this.tileMap.setGeo(this.geo);
    }

    // ---------- 지도 기준점 & 월드 로드 (첫 fix에서 호출) ----------
    setGpsAnchor(lat, lng) {
      const mid = C.GRID >> 1;
      const saved = this.loadWorld();
      if (saved && this.distMeters(saved.anchor.lat, saved.anchor.lng, lat, lng) <= C.ANCHOR_REUSE_M) {
        // 같은 동네: 저장된 anchor로 복원해야 셀 ↔ 현실 좌표가 유지된다
        this.geo.setAnchor(saved.anchor.lat, saved.anchor.lng, mid + 0.5, mid + 0.5);
        this.tileMap.setGeo(this.geo);
        this.restoreWorld(saved, lat, lng);
      } else {
        // 새 동네 (또는 첫 시작)
        this.geo.setAnchor(lat, lng, mid + 0.5, mid + 0.5);
        this.tileMap.setGeo(this.geo);
        this.newWorld();
      }
    }

    restoreWorld(saved, lat, lng) {
      this.board.owner.set(Uint8Array.from(saved.owner));
      this.board.rev++;
      this.warmth.lastWarm.set(Float64Array.from(saved.warm));
      this.world = { anchor: saved.anchor, onboarded: !!saved.onboarded };
      this.weekly = saved.week && saved.week.start ? saved.week : this.freshWeek();
      this.walkReheated = 0;
      this.overlayQueue.length = 0;

      // 플레이어 = 현재 fix 위치
      const cell = this.geo.latLngToCell(lat, lng);
      this.placePlayer(cell.c, cell.r);
      for (let i = 0; i < this.bots.length; i++) this.respawnBot(this.bots[i]);

      // 주간 롤오버: 지난주 스냅샷으로 카드 발행 → 주간 점수 리셋 (영토는 유지)
      const nowMonday = MW.Weekly.mondayStart(Date.now());
      if (this.weekly.start < nowMonday) {
        const past = this.weekly;
        if (past.maxCells > 0 && past.maxOwner && past.maxOwner.length === saved.owner.length) {
          this.overlayQueue.push(() => this.showWeeklyCard(past));
        }
        this.weekly = this.freshWeek();
      }

      // 경과 정산: ① 냉각 ② 봇 잠식 ③ 밤새 리포트
      const now = Date.now();
      const cooled = this.warmth.applyDecay(this.board, now);
      const er = this.warmth.erode(this.board, now - (saved.savedAt || now), now, Math.random);
      this.updateOccupancy();
      if (this.playerCells > this.weekly.maxCells) {
        this.weekly.maxCells = this.playerCells;
        this.weekly.maxOwner = Array.from(this.board.owner);
      }
      if (er.taken) {
        // 잠식(뺏김)이 있으면 밤새 리포트 (D5+)
        this.overlayQueue.push(() => this.showGhostReport(cooled, er.taken));
      } else if (this.playerCells > 0 && this.avgWarmth(now) < C.WARM_ALERT_AVG) {
        // 아직 안 뺏겼지만 평균 온기가 떨어짐 → D1~D4 능동 훅 "식음 경고"
        const lw = this.lukewarmCount(now);
        if (lw > 0) this.overlayQueue.push(() => this.showColdAlert(lw));
      }

      this.renderer.syncBaseline(); // 복원·정산분은 팝 없이 기준선으로
      const first = this.overlayQueue.shift();
      if (first) first();
      this.saveWorld();
    }

    newWorld() {
      this.board.clearAll();
      this.warmth.clearAll();
      this.world = { anchor: { lat: this.geo.lat, lng: this.geo.lng }, onboarded: false };
      this.weekly = this.freshWeek();
      this.walkReheated = 0;
      const mid = C.GRID >> 1;
      this.placePlayer(mid, mid);
      for (let i = 0; i < this.bots.length; i++) this.respawnBot(this.bots[i]);
      this.updateOccupancy();
      this.weekly.maxCells = this.playerCells;
      this.weekly.maxOwner = Array.from(this.board.owner);
      this.renderer.syncBaseline();
      this.toast('새 동네! 한 바퀴 돌아 땅을 감싸자');
      this.saveWorld();
    }

    placePlayer(c, r) {
      const s = C.GRID;
      c = Math.min(Math.max(c, 2), s - 3);
      r = Math.min(Math.max(r, 2), s - 3);
      const p = this.player;
      p.alive = true;
      p.c = c;
      p.r = r;
      p.pc = c;
      p.pr = r;
      p.trail = [];
      p.trailSet.clear();
      p.lastDir = null;
      this._hintShown = false;
      if (this.board.count(MW.ID.PLAYER) === 0) {
        // 영토가 없으면 시작 영토: 온보딩 첫 세션 = 5×5, 이후 = 3×3
        const rad = this.world && this.world.onboarded ? C.START_RADIUS : C.GPS_START_RADIUS;
        this.board.claimStart(c, r, MW.ID.PLAYER, rad);
        const now = Date.now();
        for (let dr = -rad; dr <= rad; dr++) {
          for (let dc = -rad; dc <= rad; dc++) {
            if (this.board.inBounds(c + dc, r + dr)) {
              this.warmth.heat(this.board.idx(c + dc, r + dr), now);
            }
          }
        }
      }
      this.renderer.cam.x = c + 0.5;
      this.renderer.cam.y = r + 0.5;
    }

    distMeters(lat1, lng1, lat2, lng2) {
      const kx = 111320 * Math.cos((lat1 * Math.PI) / 180);
      return Math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * 110574);
    }

    // ---------- 영속 (localStorage, GPS 월드만) ----------
    loadWorld() {
      try {
        const raw = localStorage.getItem(C.WORLD_KEY);
        if (!raw) return null;
        const d = JSON.parse(raw);
        const N = C.GRID * C.GRID;
        if (!d || !d.anchor || !Array.isArray(d.owner) || d.owner.length !== N) return null;
        if (!Array.isArray(d.warm) || d.warm.length !== N) return null;
        return d;
      } catch (e) {
        return null;
      }
    }

    saveWorld() {
      if (this.mode !== 'gps' || !this.world) return;
      try {
        localStorage.setItem(
          C.WORLD_KEY,
          JSON.stringify({
            anchor: this.world.anchor,
            onboarded: this.world.onboarded,
            savedAt: Date.now(),
            owner: Array.from(this.board.owner),
            warm: Array.from(this.warmth.lastWarm),
            week: this.weekly,
          })
        );
      } catch (e) { /* 저장 실패 무시 (용량 등) */ }
    }

    // ---------- GPS 실패 → 데모 폴백 (기존 로직 유지) ----------
    gpsFailed(err) {
      const denied = err && err.code === 1;
      this.setMode('demo');
      this.toast(
        denied
          ? '위치 권한이 거부되어 데모 모드로 전환했어요.'
          : 'GPS를 사용할 수 없어 데모 모드로 전환했어요.'
      );
    }

    updateGpsBadge(accuracy) {
      if (this.mode !== 'gps') return;
      if (accuracy > C.GPS_ACC_WARN) {
        this.$badge.textContent = 'GPS 정확도 낮음 (±' + Math.round(accuracy) + 'm)';
        this.$badge.classList.remove('hidden');
      } else {
        this.$badge.classList.add('hidden');
      }
    }

    toast(msg) {
      this.$toast.textContent = msg;
      this.$toast.classList.remove('hidden');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => this.$toast.classList.add('hidden'), 3000);
    }
  }

  // ---------- 부트스트랩: 로직 틱과 렌더링(rAF) 분리 ----------
  document.addEventListener('DOMContentLoaded', () => {
    new MW.ThemeManager();
    const game = new Game();
    MW.game = game; // 디버깅/플레이테스트용

    let lastFrame = performance.now();
    let lastTick = performance.now();

    const frame = (now) => {
      requestAnimationFrame(frame);

      // 탭이 오래 숨겨졌다 돌아오면 밀린 틱을 몰아서 돌리지 않음
      if (now - lastTick > 1000) lastTick = now;

      if (game.state === 'playing') {
        while (now - lastTick >= C.TICK_MS) {
          lastTick += C.TICK_MS;
          game.tick();
        }
      } else {
        lastTick = now;
      }

      const tickT = Math.min(1, (now - lastTick) / C.TICK_MS);
      const dt = Math.min(0.1, Math.max(0.001, (now - lastFrame) / 1000));
      lastFrame = now;

      game.renderer.draw(tickT, dt);
    };
    requestAnimationFrame(frame);
  });
})();
