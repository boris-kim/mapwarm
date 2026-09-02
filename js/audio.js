/* MapWarm — 소리 + 햅틱 (juice 감각 채널, v0.2)
   - 사운드: WebAudio(AudioContext)로 짧은 합성음 — 외부 파일/CDN 없음
   - 햅틱: navigator.vibrate (미지원 = iOS Safari 등은 조용히 무시)
   - 첫 사용자 제스처 후 AudioContext 활성화(autoplay 정책)
   - 음소거 토글은 localStorage 'mapwarm-mute'
   저사양 고려: 오실레이터/게인은 재생 시 짧게 생성·자동 정리, 동시 음 소수 */
(function () {
  'use strict';

  class AudioFx {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.ready = false;
      this.hasVibrate =
        typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

      this.muted = false;
      try {
        this.muted = localStorage.getItem('mapwarm-mute') === '1';
      } catch (e) { /* 저장 불가 환경 무시 */ }

      this._lastDanger = 0; // 위험음 스로틀
    }

    // 첫 제스처에서 호출 — AudioContext는 그때 생성/resume
    unlock() {
      if (this.ready) {
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return; // WebAudio 미지원 → 사운드 없이 진행 (햅틱은 별개)
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.14; // 볼륨 작게
        this.master.connect(this.ctx.destination);
        this.ready = true;
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) {
        this.ctx = null; // 실패해도 게임은 계속
      }
    }

    setMuted(m) {
      this.muted = !!m;
      try {
        localStorage.setItem('mapwarm-mute', this.muted ? '1' : '0');
      } catch (e) { /* noop */ }
    }

    toggleMute() {
      this.setMuted(!this.muted);
      return this.muted;
    }

    // 짧은 톤 하나 (type=파형, f0→f1 글라이드, dur초, delay초, peak게인)
    tone(type, f0, f1, dur, delay, peak) {
      if (!this.ready || this.muted || !this.ctx) return;
      const t0 = this.ctx.currentTime + (delay || 0);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t0);
      if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      const pk = peak == null ? 1 : peak;
      // 빠른 어택 + 지수 감쇠 (클릭 방지용 미세 램프)
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(pk, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
      // 자동 정리 (노드 누수 방지)
      osc.onended = () => {
        try {
          osc.disconnect();
          g.disconnect();
        } catch (e) { /* noop */ }
      };
    }

    vibrate(pattern) {
      if (!this.hasVibrate || this.muted) return;
      try {
        navigator.vibrate(pattern);
      } catch (e) { /* 조용히 무시 */ }
    }

    // ---------- 이벤트 사운드 + 햅틱 ----------
    capture() {
      // 밝은 팝
      this.tone('triangle', 520, 880, 0.14, 0, 1);
      this.vibrate(30);
    }

    earlyClose() {
      // 낮은 톤 (조기 닫힘 — 사망 아님)
      this.tone('sine', 300, 190, 0.22, 0, 1);
      this.vibrate([20, 40, 20]);
    }

    botKill() {
      // 상승 아르페지오 2~3음
      this.tone('square', 440, 440, 0.08, 0, 0.8);
      this.tone('square', 620, 620, 0.08, 0.07, 0.8);
      this.tone('square', 820, 900, 0.1, 0.14, 0.9);
      this.vibrate(50);
    }

    danger() {
      // 미세 경고음 (자기 꼬리 근접) — 최대 초당 ~1.5회로 스로틀
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - this._lastDanger < 650) return;
      this._lastDanger = now;
      this.tone('sawtooth', 240, 240, 0.06, 0, 0.5);
    }

    report() {
      // 부드러운 더블 (밤새 리포트 / 주간 카드 발행)
      this.tone('sine', 660, 660, 0.12, 0, 0.8);
      this.tone('sine', 880, 880, 0.16, 0.13, 0.8);
      this.vibrate([15, 60, 15]);
    }
  }

  window.MW = window.MW || {};
  MW.AudioFx = AudioFx;
})();
