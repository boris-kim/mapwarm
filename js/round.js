/* MapWarm — 라운드 규칙 (순수 로직, DOM 없음 — node에서 그대로 테스트 가능)
   승리: 점유율 WIN_PCT 도달 → 즉시 승리
   시간 종료: 점유율 순위(나 vs 봇들)로 판정 — 공동 1위는 승리로 친다 */
(function () {
  'use strict';

  class Round {
    constructor(limitMs, winPct) {
      this.limitMs = limitMs;
      this.winPct = winPct;
      this.ticks = 0;
    }

    /** 새 라운드 시작. limitMs를 주면 제한시간도 갱신 */
    reset(limitMs) {
      this.ticks = 0;
      if (limitMs != null) this.limitMs = limitMs;
    }

    /** 모드 전환 등으로 제한시간만 바꿀 때 (경과 시간은 유지) */
    setLimit(limitMs) {
      this.limitMs = limitMs;
    }

    tick() {
      this.ticks++;
    }

    elapsedMs() {
      return this.ticks * MW.CONFIG.TICK_MS;
    }

    remainingMs() {
      return Math.max(0, this.limitMs - this.elapsedMs());
    }

    /**
     * 매 틱 판정. 승리 조건이 시간 종료보다 우선.
     * @returns 'win' | 'timeup' | null
     */
    check(playerPct) {
      if (playerPct >= this.winPct) return 'win';
      if (this.remainingMs() <= 0) return 'timeup';
      return null;
    }

    /** 시간 종료 시 순위 판정: 나보다 칸이 많은 봇이 없으면 승리 */
    static rankWin(playerCells, botCellCounts) {
      for (let i = 0; i < botCellCounts.length; i++) {
        if (botCellCounts[i] > playerCells) return false;
      }
      return true;
    }

    /** ms → "m:ss" 전광판 표기 */
    static fmt(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      const m = Math.floor(s / 60);
      const ss = String(s % 60);
      return m + ':' + (ss.length < 2 ? '0' + ss : ss);
    }
  }

  window.MW = window.MW || {};
  MW.Round = Round;
})();
