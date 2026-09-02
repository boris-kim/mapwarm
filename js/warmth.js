/* MapWarm — v0.2 온기·잠식·주간 헬퍼 (순수 로직, DOM 없음 — node에서 그대로 테스트)
   - 온기: 셀별 lastWarm 타임스탬프 → 열람 시점에 경과 계산 (앱이 꺼져 있어도 일관)
   - 냉각: 7일 선형, 0이면 중립화
   - 봇 잠식: 온기 30% 미만 + 가장자리 셀만, 하루당 내 영토의 5~10% */
(function () {
  'use strict';

  const DAY_MS = 86400000;

  class Warmth {
    constructor(size) {
      this.size = size;
      // 셀별 마지막 가열 시각 (epoch ms). 0 = 온기 없음. 플레이어 소유 셀만 의미 있음.
      this.lastWarm = new Float64Array(size * size);
    }

    decayMs() {
      return MW.CONFIG.WARM_DECAY_DAYS * DAY_MS;
    }

    /** 셀 온기 0~1 (열람 시점 계산) */
    warmAt(i, now) {
      const t = this.lastWarm[i];
      if (!t) return 0;
      const w = 1 - (now - t) / this.decayMs();
      return w < 0 ? 0 : w > 1 ? 1 : w;
    }

    heat(i, now) {
      this.lastWarm[i] = now;
    }

    clearAll() {
      this.lastWarm.fill(0);
    }

    /**
     * 냉각 경과 적용: 온기가 0이 된 내 셀을 중립화.
     * 플레이어 소유가 아닌 셀의 온기 찌꺼기도 청소.
     * @returns 중립화된 칸 수
     */
    applyDecay(board, now) {
      const o = board.owner;
      let cooled = 0;
      for (let i = 0; i < o.length; i++) {
        if (o[i] === MW.ID.PLAYER) {
          if (this.lastWarm[i] === 0) {
            // 온기 기록이 없는 내 셀(마이그레이션 등)은 지금부터 식기 시작
            this.lastWarm[i] = now;
          } else if (this.warmAt(i, now) <= 0) {
            o[i] = 0;
            this.lastWarm[i] = 0;
            cooled++;
          }
        } else if (this.lastWarm[i]) {
          this.lastWarm[i] = 0;
        }
      }
      if (cooled) board.rev++;
      return cooled;
    }

    /**
     * 재가열: (c,r) 중심 반경 radius 박스 안의 내 소유 셀 온기 1.0.
     * @returns 새로 데워진(온기 <0.99였던) 칸 수
     */
    reheatAround(board, c, r, radius, now) {
      const s = board.size;
      let n = 0;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const cc = c + dc;
          const rr = r + dr;
          if (cc < 0 || rr < 0 || cc >= s || rr >= s) continue;
          const i = rr * s + cc;
          if (board.owner[i] !== MW.ID.PLAYER) continue;
          if (this.warmAt(i, now) < 0.99) n++;
          this.lastWarm[i] = now;
        }
      }
      return n;
    }

    /**
     * 봇 잠식 (앱 열 때 경과 계산):
     * 온기 < ERODE_COLD 인 내 영토 "가장자리" 셀만, 하루당 5~10%를 봇 소유로.
     * 즉시 탈환 가능 (봇 소유가 되므로 감싸면 회수).
     * @param rand 0~1 난수 함수 (테스트에서 주입 가능)
     * @returns { taken, byBot: {2:n, 3:m} }
     */
    erode(board, elapsedMs, now, rand) {
      const C = MW.CONFIG;
      const o = board.owner;
      const s = board.size;
      const mine = board.count(MW.ID.PLAYER);
      const byBot = { 2: 0, 3: 0 };
      if (!mine || elapsedMs <= 0) return { taken: 0, byBot };

      const days = Math.min(elapsedMs / DAY_MS, C.ERODE_MAX_DAYS);
      const frac = (C.ERODE_MIN_FRAC + rand() * (C.ERODE_MAX_FRAC - C.ERODE_MIN_FRAC)) * days;
      let target = Math.min(mine, Math.floor(mine * frac));
      let taken = 0;

      // 패스 단위: 매 패스마다 "차갑고 + 가장자리"인 후보를 다시 수집
      while (taken < target) {
        const cand = [];
        for (let r = 0; r < s; r++) {
          for (let c = 0; c < s; c++) {
            const i = r * s + c;
            if (o[i] !== MW.ID.PLAYER) continue;
            if (this.warmAt(i, now) >= C.ERODE_COLD) continue;
            // 가장자리: 4방 이웃 중 내 소유가 아닌 칸이 있음 (보드 끝 포함)
            const edge =
              c === 0 || r === 0 || c === s - 1 || r === s - 1 ||
              o[i - 1] !== MW.ID.PLAYER || o[i + 1] !== MW.ID.PLAYER ||
              o[i - s] !== MW.ID.PLAYER || o[i + s] !== MW.ID.PLAYER;
            if (edge) cand.push(i);
          }
        }
        if (!cand.length) break;
        // 이번 패스에서 후보의 절반까지 랜덤 잠식 (가장자리 우선을 유지하며 전진)
        const take = Math.min(target - taken, Math.max(1, Math.floor(cand.length / 2)));
        for (let k = 0; k < take; k++) {
          const pick = cand[(rand() * cand.length) | 0];
          if (o[pick] !== MW.ID.PLAYER) continue; // 같은 패스에서 중복 픽
          const bot = rand() < 0.5 ? MW.ID.BOT1 : MW.ID.BOT2;
          o[pick] = bot;
          this.lastWarm[pick] = 0;
          byBot[bot]++;
          taken++;
        }
      }
      if (taken) board.rev++;
      return { taken, byBot };
    }
  }

  // 주간 정산 헬퍼 (월요일 기준)
  const Weekly = {
    /** ts가 속한 주의 월요일 00:00 (로컬) */
    mondayStart(ts) {
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      const dow = (d.getDay() + 6) % 7; // 월=0
      return d.getTime() - dow * DAY_MS;
    },
    /** 다음 월요일까지 D-일수 (1~7) */
    daysToNextMonday(ts) {
      const next = Weekly.mondayStart(ts) + 7 * DAY_MS;
      return Math.max(1, Math.ceil((next - ts) / DAY_MS));
    },
    /** 연중 주차 (표시용) */
    weekNum(mondayTs) {
      const d = new Date(mondayTs);
      const jan1 = new Date(d.getFullYear(), 0, 1).getTime();
      return Math.max(1, Math.ceil(((mondayTs - jan1) / DAY_MS + 1) / 7));
    },
  };

  window.MW = window.MW || {};
  MW.Warmth = Warmth;
  MW.Weekly = Weekly;
})();
