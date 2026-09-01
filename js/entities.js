/* MapWarm — 엔티티(플레이어/봇): 칸 단위 이동, 꼬리, 점령, 봇 AI */
(function () {
  'use strict';

  const C = () => MW.CONFIG;

  class Entity {
    constructor(id, board) {
      this.id = id;
      this.board = board;
      this.alive = true;
      this.c = 0;
      this.r = 0;
      this.pc = 0; // 직전 틱 위치 (렌더 보간용)
      this.pr = 0;
      this.trail = [];          // 꼬리 칸 목록 (그린 순서)
      this.trailSet = new Set(); // 꼬리 칸 빠른 조회
      this.lastDir = null;
    }

    spawn(c, r) {
      this.c = c;
      this.r = r;
      this.pc = c;
      this.pr = r;
      this.alive = true;
      this.trail.length = 0;
      this.trailSet.clear();
      this.lastDir = null;
      this.board.claimStart(c, r, this.id, C().START_RADIUS);
    }

    hasTrail() {
      return this.trail.length > 0;
    }

    /**
     * 한 틱에 한 칸 이동. 대각선 없음.
     * 반환: null(정지) | 'blocked' | 'moved' | 'captured' | 'self-trail'
     */
    step(dir) {
      this.pc = this.c;
      this.pr = this.r;
      if (!dir) return null;

      const nc = this.c + dir[0];
      const nr = this.r + dir[1];
      if (!this.board.inBounds(nc, nr)) return 'blocked';

      this.c = nc;
      this.r = nr;
      this.lastDir = dir;

      const i = this.board.idx(nc, nr);

      // 자기 꼬리를 밟으면 사망
      if (this.trailSet.has(i)) return 'self-trail';

      if (this.board.owner[i] === this.id) {
        // 꼬리를 끌고 내 영토로 복귀 → 점령
        if (this.hasTrail()) {
          this.board.capture(this.id, this.trail);
          this.trail = [];
          this.trailSet.clear();
          return 'captured';
        }
        return 'moved';
      }

      // 영토 밖 → 꼬리를 그린다
      this.trail.push(i);
      this.trailSet.add(i);
      return 'moved';
    }

    die() {
      this.alive = false;
      this.trail = [];
      this.trailSet.clear();
      this.lastDir = null;
      this.board.clearOwner(this.id); // 죽으면 영토도 사라진다
    }
  }

  /**
   * 봇 AI — 자기 영토에서 나가 직사각형 루프를 돌고 복귀해 점령.
   * 플레이어와 완전히 같은 규칙(step/capture/사망)을 쓴다.
   */
  class Bot extends Entity {
    constructor(id, board) {
      super(id, board);
      this.queue = [];        // 계획된 이동 방향 목록
      this.wait = 0;          // 다음 루프까지 대기 틱
      this.respawnTimer = 0;  // 사망 후 리스폰 카운트다운
    }

    tickAI(game) {
      if (!this.alive) {
        this.respawnTimer--;
        if (this.respawnTimer <= 0) game.respawnBot(this);
        return;
      }

      let dir = null;
      if (this.queue.length) {
        dir = this.queue.shift();
      } else if (this.hasTrail()) {
        // 루프가 끝났는데 아직 영토 밖 (예: 집을 빼앗김) → 가장 가까운 내 땅으로
        dir = this.dirTowardTerritory();
      } else if (this.wait > 0) {
        this.wait--;
      } else {
        this.planLoop();
        if (this.queue.length) dir = this.queue.shift();
        else this.wait = 8;
      }

      if (!dir) return;

      const res = this.step(dir);
      if (res === 'self-trail') {
        game.killBot(this);
      } else if (res === 'captured') {
        this.queue.length = 0;
        this.wait = 10 + ((Math.random() * 16) | 0);
        game.afterCapture(this);
      } else if (res === 'blocked') {
        this.queue.length = 0; // 다음 틱에 재계획
      }
    }

    // 직사각형 루프 계획: A방향 a칸 → B방향 b칸 → 반대A a칸 → 반대B b칸 (제자리 복귀)
    planLoop() {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const s = this.board.size;
      for (let attempt = 0; attempt < 12; attempt++) {
        const A = dirs[(Math.random() * 4) | 0];
        const perp = A[0] !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
        const B = perp[(Math.random() * 2) | 0];
        const a = 4 + ((Math.random() * 8) | 0);
        const b = 4 + ((Math.random() * 8) | 0);

        const moves = [];
        for (let i = 0; i < a; i++) moves.push(A);
        for (let i = 0; i < b; i++) moves.push(B);
        for (let i = 0; i < a; i++) moves.push([-A[0], -A[1]]);
        for (let i = 0; i < b; i++) moves.push([-B[0], -B[1]]);

        // 경로가 보드 안(가장자리 1칸 여유)에 머무는지 확인
        let c = this.c;
        let r = this.r;
        let ok = true;
        for (let i = 0; i < moves.length; i++) {
          c += moves[i][0];
          r += moves[i][1];
          if (c < 1 || r < 1 || c >= s - 1 || r >= s - 1) {
            ok = false;
            break;
          }
        }
        if (ok) {
          this.queue = moves;
          return;
        }
      }
    }

    // 가장 가까운 내 영토 칸 쪽으로 한 칸 (내 꼬리는 되도록 피함)
    dirTowardTerritory() {
      const s = this.board.size;
      const owner = this.board.owner;
      let best = null;
      let bd = Infinity;
      for (let i = 0; i < owner.length; i++) {
        if (owner[i] === this.id) {
          const c = i % s;
          const r = (i - c) / s;
          const d = Math.abs(c - this.c) + Math.abs(r - this.r);
          if (d < bd) {
            bd = d;
            best = { c, r };
          }
        }
      }
      if (!best) return null;

      const cand = [];
      const dc = Math.sign(best.c - this.c);
      const dr = Math.sign(best.r - this.r);
      if (dc) cand.push([dc, 0]);
      if (dr) cand.push([0, dr]);

      for (let k = 0; k < cand.length; k++) {
        const nc = this.c + cand[k][0];
        const nr = this.r + cand[k][1];
        if (this.board.inBounds(nc, nr) && !this.trailSet.has(this.board.idx(nc, nr))) {
          return cand[k];
        }
      }
      return cand[0] || null;
    }
  }

  window.MW = window.MW || {};
  MW.Entity = Entity;
  MW.Bot = Bot;
})();
