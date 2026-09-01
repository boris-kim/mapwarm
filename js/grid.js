/* MapWarm — 게임판(그리드) 모델 & 점령 판정(flood fill) */
(function () {
  'use strict';

  class Board {
    constructor(size) {
      this.size = size;
      // 각 칸의 주인: 0=없음, 1=플레이어, 2=봇1, 3=봇2
      this.owner = new Uint8Array(size * size);
      // 영토 변경 카운터 — 렌더러가 할프톤 도트 캐시를 언제 다시 계산할지 판단
      this.rev = 0;
    }

    clearAll() {
      this.owner.fill(0);
      this.rev++;
    }

    idx(c, r) {
      return r * this.size + c;
    }

    inBounds(c, r) {
      return c >= 0 && r >= 0 && c < this.size && r < this.size;
    }

    ownerAt(c, r) {
      return this.owner[this.idx(c, r)];
    }

    clearOwner(id) {
      const o = this.owner;
      for (let i = 0; i < o.length; i++) {
        if (o[i] === id) o[i] = 0;
      }
      this.rev++;
    }

    count(id) {
      let n = 0;
      const o = this.owner;
      for (let i = 0; i < o.length; i++) {
        if (o[i] === id) n++;
      }
      return n;
    }

    // 시작 영토: (c,r) 중심으로 (2*radius+1)² 칸
    claimStart(c, r, id, radius) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (this.inBounds(c + dc, r + dr)) {
            this.owner[this.idx(c + dc, r + dr)] = id;
          }
        }
      }
      this.rev++;
    }

    /**
     * 점령 판정 — 보드 가장자리에서 물을 채우는 방식(flood fill).
     * 1) 꼬리 칸을 전부 내 영토로 만든다.
     * 2) 보드 가장자리에서 시작해 "내 영토가 아닌 칸"으로만 물을 퍼뜨린다.
     * 3) 물이 닿지 못한 칸 = 꼬리+영토로 둘러싸인 안쪽 → 전부 내 영토.
     * (다른 주인의 영토도 둘러싸면 빼앗는다 — splix 규칙)
     */
    capture(id, trailCells) {
      const s = this.size;
      const N = s * s;
      const owner = this.owner;

      for (let k = 0; k < trailCells.length; k++) {
        owner[trailCells[k]] = id;
      }

      const visited = new Uint8Array(N);
      const stack = [];

      const seed = (i) => {
        if (!visited[i] && owner[i] !== id) {
          visited[i] = 1;
          stack.push(i);
        }
      };

      for (let c = 0; c < s; c++) {
        seed(c);                 // 윗줄
        seed((s - 1) * s + c);   // 아랫줄
      }
      for (let r = 0; r < s; r++) {
        seed(r * s);             // 왼쪽 열
        seed(r * s + s - 1);     // 오른쪽 열
      }

      while (stack.length) {
        const i = stack.pop();
        const c = i % s;
        const r = (i - c) / s;
        if (c > 0) seed(i - 1);
        if (c < s - 1) seed(i + 1);
        if (r > 0) seed(i - s);
        if (r < s - 1) seed(i + s);
      }

      for (let i = 0; i < N; i++) {
        if (!visited[i] && owner[i] !== id) owner[i] = id;
      }
      this.rev++;
    }
  }

  window.MW = window.MW || {};
  MW.Board = Board;
})();
