/* MapWarm — 입력: 가상 조이스틱(터치한 자리에 생김) + 방향키/WASD */
(function () {
  'use strict';

  class Input {
    constructor(areaEl, joyEl) {
      this.area = areaEl;
      this.joy = joyEl;
      this.stick = joyEl.querySelector('.joystick-stick');
      this.enabled = true;

      this.keyStack = []; // 마지막으로 누른 키가 우선
      this.latchDir = null; // 틱 사이에 짧게 눌렀다 뗀 키도 다음 틱에 1칸 보장 (키 래치)
      this.joyDir = null;
      this.pointerId = null;
      this.origin = null;

      this.keyMap = {
        ArrowUp: [0, -1], KeyW: [0, -1],
        ArrowDown: [0, 1], KeyS: [0, 1],
        ArrowLeft: [-1, 0], KeyA: [-1, 0],
        ArrowRight: [1, 0], KeyD: [1, 0],
      };

      window.addEventListener('keydown', (e) => {
        const d = this.keyMap[e.code];
        if (!d) return;
        e.preventDefault();
        if (!this.keyStack.includes(e.code)) this.keyStack.push(e.code);
        this.latchDir = d; // 틱 전에 떼어도 이 방향은 소비될 때까지 유지
      });

      window.addEventListener('keyup', (e) => {
        const i = this.keyStack.indexOf(e.code);
        if (i >= 0) this.keyStack.splice(i, 1);
      });

      // 포인터 이벤트: 터치와 마우스 모두 처리
      areaEl.addEventListener('pointerdown', (e) => this.onDown(e));
      areaEl.addEventListener('pointermove', (e) => this.onMove(e));
      areaEl.addEventListener('pointerup', (e) => this.onUp(e));
      areaEl.addEventListener('pointercancel', (e) => this.onUp(e));
      areaEl.addEventListener('contextmenu', (e) => e.preventDefault());

      // v2: 미조작 시 좌하단에 50% 알파 힌트 조이스틱 상주
      window.addEventListener('resize', () => {
        if (this.pointerId === null) this.showHint();
      });
      this.showHint();
    }

    showHint() {
      if (!this.enabled) return;
      this.joy.classList.add('hint');
      this.joy.classList.remove('hidden');
      this.joy.style.left = '86px';
      this.joy.style.top = (this.area.clientHeight || 600) - 130 + 'px';
      this.setStick(0, 0);
    }

    onDown(e) {
      if (!this.enabled || this.pointerId !== null) return;
      if (e.target.closest('button') || e.target.closest('.overlay')) return;

      this.pointerId = e.pointerId;
      try {
        this.area.setPointerCapture(e.pointerId);
      } catch (err) { /* 일부 브라우저 미지원 무시 */ }

      const rect = this.area.getBoundingClientRect();
      this.origin = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      this.joy.style.left = this.origin.x + 'px';
      this.joy.style.top = this.origin.y + 'px';
      this.joy.classList.remove('hidden');
      this.joy.classList.remove('hint'); // 터치한 자리로 점프 + 풀 알파
      this.setStick(0, 0);
    }

    onMove(e) {
      if (e.pointerId !== this.pointerId || !this.origin) return;
      const rect = this.area.getBoundingClientRect();
      let dx = e.clientX - rect.left - this.origin.x;
      let dy = e.clientY - rect.top - this.origin.y;

      const len = Math.hypot(dx, dy);
      const max = MW.CONFIG.JOY_RADIUS;
      if (len > max) {
        dx = (dx / len) * max;
        dy = (dy / len) * max;
      }
      this.setStick(dx, dy);

      if (len < MW.CONFIG.JOY_DEADZONE) {
        this.joyDir = null;
        return;
      }
      // 대각선 금지: 더 큰 축 방향만 사용
      this.joyDir =
        Math.abs(dx) >= Math.abs(dy)
          ? [dx > 0 ? 1 : -1, 0]
          : [0, dy > 0 ? 1 : -1];
    }

    onUp(e) {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.origin = null;
      this.joyDir = null;
      this.showHint(); // 놓으면 좌하단 힌트 위치로 복귀
    }

    setStick(dx, dy) {
      this.stick.style.transform =
        'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
    }

    // 현재 입력 방향: 조이스틱 > 누르고 있는 키 > 래치(짧게 눌렀다 뗀 키)
    getDir() {
      if (!this.enabled) return null;
      if (this.joyDir) {
        this.latchDir = null;
        return this.joyDir;
      }
      const code = this.keyStack[this.keyStack.length - 1];
      if (code) {
        this.latchDir = null; // 누르고 있는 동안엔 래치 불필요
        return this.keyMap[code];
      }
      if (this.latchDir) {
        const d = this.latchDir;
        this.latchDir = null; // 딱 1칸만 보장하고 소비
        return d;
      }
      return null;
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) {
        this.joyDir = null;
        this.keyStack.length = 0;
        this.latchDir = null;
        this.pointerId = null;
        this.origin = null;
        this.joy.classList.add('hidden');
      } else {
        this.showHint();
      }
    }
  }

  window.MW = window.MW || {};
  MW.Input = Input;
})();
