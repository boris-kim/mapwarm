/* MapWarm — 게임 오케스트레이션: 틱 루프, 충돌 규칙, HUD, 모드 전환 */
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

      this.state = 'playing'; // 'playing' | 'dead'
      this.mode = 'demo';     // 'demo' | 'gps'

      this.best = 0;
      try {
        this.best = parseFloat(localStorage.getItem('mapwarm-best') || '0') || 0;
      } catch (e) { /* 저장 불가 환경 무시 */ }

      // DOM 참조
      this.$occ = document.getElementById('occupancy');
      this.$best = document.getElementById('best');
      this.$overlay = document.getElementById('overlay');
      this.$deathReason = document.getElementById('death-reason');
      this.$deathOcc = document.getElementById('death-occupancy');
      this.$badge = document.getElementById('gps-badge');
      this.$toast = document.getElementById('toast');
      this.toastTimer = null;

      // 사망 연출 타이머
      this.deathAt = 0;
      this.deathTimer = null;

      // 실제 지도 배경: 데모 anchor = 서울시청, GPS 모드에선 첫 fix가 anchor
      const mid0 = C.GRID >> 1;
      this.geo = new MW.Geo(C.DEMO_ANCHOR.lat, C.DEMO_ANCHOR.lng, mid0 + 0.5, mid0 + 0.5);
      this.tileMap = new MW.TileMap();
      this.tileMap.setGeo(this.geo);

      const area = document.getElementById('game-area');
      const joy = document.getElementById('joystick');
      this.input = new MW.Input(area, joy);
      this.gps = new MW.GpsController(this);
      this.renderer = new MW.Renderer(document.getElementById('game'), this.board, this);

      // 모드 토글
      document.querySelectorAll('.mode-option').forEach((btn) => {
        btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
      });

      // 다시 시작
      document.getElementById('restart-btn').addEventListener('click', () => this.reset());

      this.$best.textContent = this.best.toFixed(1) + '%';

      // 점유율 칩 pop 타이머 & 점령 델타 추적
      this.chipTimer = null;
      this.playerCells = 0;

      // 첫 진입: 잠시 후에도 타일이 하나도 없으면 1회 안내
      setTimeout(() => {
        let loaded = false;
        this.tileMap.cache.forEach((t) => {
          if (t.status === 'ok') loaded = true;
        });
        if (!loaded) this.toast('지도를 불러오는 중…');
      }, 800);

      this.reset();
    }

    // ---------- 라운드 초기화 ----------
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
      this.$overlay.classList.add('hidden');
      this.renderer.cam.x = mid + 0.5;
      this.renderer.cam.y = mid + 0.5;
      this.updateOccupancy();
    }

    // 봇 스폰 위치: 빈 3×3 이고 플레이어와 적당히 떨어진 곳
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

      // 1) 플레이어 이동
      let dir = this.mode === 'gps' ? this.gps.getDir(this.player) : this.input.getDir();

      // 데모 모드에서 꼬리가 있을 때 180° 역주행은 무시 (즉사 오조작 방지, splix 표준)
      if (
        dir && this.mode === 'demo' &&
        this.player.hasTrail() && this.player.lastDir &&
        dir[0] === -this.player.lastDir[0] && dir[1] === -this.player.lastDir[1]
      ) {
        dir = null;
      }

      const res = this.player.step(dir);
      if (res === 'self-trail') {
        this.killPlayer('자기 꼬리를 밟았어요.');
        return;
      }
      if (res === 'captured') {
        // 새로 먹은 칸 수 (afterCapture가 playerCells를 갱신하기 전에 계산)
        const gained = this.board.count(MW.ID.PLAYER) - this.playerCells;
        this.afterCapture(this.player);
        this.captureFx(gained);
      }
      if (this.state !== 'playing') return;

      // 2) 봇 이동 (같은 규칙)
      for (let i = 0; i < this.bots.length; i++) {
        this.bots[i].tickAI(this);
        if (this.state !== 'playing') return;
      }

      // 3) 꼬리 끊기 판정: 누군가의 머리가 다른 사람 꼬리 위 → 꼬리 주인 사망
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
              this.killPlayer('봇이 내 꼬리를 밟았어요.');
              return;
            }
            this.killBot(eb);
          }
        }
      }

      this.updateOccupancy();
    }

    // 점령 직후: 영토를 전부 빼앗긴(둘러싸인) 상대는 사망
    afterCapture(byEntity) {
      this.updateOccupancy();
      const all = [this.player].concat(this.bots);
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (e === byEntity || !e.alive) continue;
        if (this.board.count(e.id) === 0) {
          if (e === this.player) this.killPlayer('영토를 모두 빼앗겼어요.');
          else this.killBot(e);
        }
      }
    }

    // 점령 순간 연출: 점유율 칩 pop + 큰 점령이면 토스트
    captureFx(gained) {
      const chip = document.querySelector('.chip-occupancy');
      if (chip) {
        chip.classList.remove('pop');
        void chip.offsetWidth; // 리플로우 강제 → 애니메이션 재시작
        chip.classList.add('pop');
        clearTimeout(this.chipTimer);
        this.chipTimer = setTimeout(() => chip.classList.remove('pop'), 320);
      }
      if (gained >= 8) this.toast('+' + gained + ' 땅을 먹었다!');
    }

    killBot(bot) {
      bot.die();
      bot.respawnTimer = C.BOT_RESPAWN_TICKS;
    }

    respawnBot(bot) {
      const p = this.findSpawn();
      bot.queue = [];
      bot.wait = 6 + ((Math.random() * 10) | 0);
      bot.spawn(p.c, p.r);
    }

    // 사망: 즉시 오버레이를 띄우지 않고 짧은 연출(머리 깜빡임 + 꼬리 소멸) 후 표시
    killPlayer(reason) {
      if (this.state !== 'playing') return;
      const pct = this.occupancyPct(); // 영토가 지워지기 전에 기록
      this.state = 'dying'; // 틱은 멈추고 렌더러가 연출을 그린다
      this.deathAt = performance.now();
      this.$deathReason.textContent = reason;
      this.$deathOcc.textContent = pct.toFixed(1) + '%';
      clearTimeout(this.deathTimer);
      this.deathTimer = setTimeout(() => this.finishDeath(), C.DEATH_FX_MS);
    }

    finishDeath() {
      this.player.die();
      this.state = 'dead';
      this.$overlay.classList.remove('hidden');
      this.updateOccupancy();
    }

    // ---------- HUD ----------
    occupancyPct() {
      return (this.board.count(MW.ID.PLAYER) / (C.GRID * C.GRID)) * 100;
    }

    updateOccupancy() {
      this.playerCells = this.board.count(MW.ID.PLAYER);
      const pct = (this.playerCells / (C.GRID * C.GRID)) * 100;
      this.$occ.textContent = pct.toFixed(1) + '%';
      if (pct > this.best) {
        this.best = pct;
        try {
          localStorage.setItem('mapwarm-best', String(pct));
        } catch (e) { /* 저장 불가 환경 무시 */ }
        this.$best.textContent = pct.toFixed(1) + '%';
      }
    }

    // ---------- 모드 전환 ----------
    setMode(mode) {
      if (mode === this.mode) return;
      if (mode === 'gps') {
        this.mode = 'gps';
        this.input.setEnabled(false);
        this.gps.start();
        this.toast('위치 권한을 요청하는 중…');
      } else {
        this.mode = 'demo';
        this.gps.stop();
        this.input.setEnabled(true);
        this.$badge.classList.add('hidden');
        this.resetGeoToDemo(); // 지도 기준점을 서울시청으로 복귀
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

    // ---------- 지도 기준점 (셀 ↔ 위경도 ↔ 타일이 전부 이 anchor 하나를 공유) ----------
    setGpsAnchor(lat, lng) {
      // 첫 GPS fix 지점 = 플레이어가 지금 서 있는 셀의 중심
      this.geo.setAnchor(lat, lng, this.player.c + 0.5, this.player.r + 0.5);
      this.tileMap.setGeo(this.geo);
    }

    resetGeoToDemo() {
      const mid = C.GRID >> 1;
      this.geo.setAnchor(C.DEMO_ANCHOR.lat, C.DEMO_ANCHOR.lng, mid + 0.5, mid + 0.5);
      this.tileMap.setGeo(this.geo);
    }

    // GPS 실패 → 데모 모드로 우아하게 복귀
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
