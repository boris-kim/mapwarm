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

      // 줌: 활성 포인터 추적(핀치) — 두 손가락이면 이동 대신 배율 조절
      this.pointers = new Map(); // pointerId → {x, y} (client 좌표)
      this.pinchDist = 0;        // 핀치 진행 중 두 손가락 거리 (0 = 핀치 아님)

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

      // 데스크톱 휠: 게임 영역 스크롤로 줌 (페이지 스크롤 방지)
      areaEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = MW.CONFIG.ZOOM_WHEEL_STEP;
        this.applyZoom(e.deltaY < 0 ? step : 1 / step);
      }, { passive: false });

      // 줌 버튼 (있으면): 에디토리얼 +/− 컨트롤
      if (typeof document !== 'undefined') {
        const zin = document.getElementById('zoom-in');
        const zout = document.getElementById('zoom-out');
        if (zin) zin.addEventListener('click', () => this.applyZoom(MW.CONFIG.ZOOM_BTN_STEP));
        if (zout) zout.addEventListener('click', () => this.applyZoom(1 / MW.CONFIG.ZOOM_BTN_STEP));
      }

      // v2: 미조작 시 좌하단에 50% 알파 힌트 조이스틱 상주
      window.addEventListener('resize', () => {
        if (this.pointerId === null) this.showHint();
      });
      this.showHint();
    }

    // 렌더러 카메라에 줌 팩터 전달 (뷰 전용). MW.game은 부트스트랩 후 존재.
    applyZoom(factor) {
      const r = MW.game && MW.game.renderer;
      if (r) r.userZoom(factor);
    }

    pinchDistance() {
      const it = this.pointers.values();
      const a = it.next().value;
      const b = it.next().value;
      if (!a || !b) return 0;
      return Math.hypot(a.x - b.x, a.y - b.y);
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
      if (!this.enabled) return;
      if (e.target.closest('button') || e.target.closest('.overlay')) return;

      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // 두 번째 손가락 → 핀치 모드: 진행 중이던 조이스틱 취소, 이동 입력 무시
      if (this.pointers.size >= 2) {
        this.cancelJoystick();
        this.pinchDist = this.pinchDistance();
        return;
      }

      // 첫 손가락 → 조이스틱
      if (this.pointerId !== null) return;
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

    cancelJoystick() {
      this.pointerId = null;
      this.origin = null;
      this.joyDir = null;
      this.showHint();
    }

    onMove(e) {
      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      // 핀치: 두 손가락 거리 변화 → 배율
      if (this.pinchDist > 0 && this.pointers.size >= 2) {
        const d = this.pinchDistance();
        if (d > 0 && this.pinchDist > 0) {
          const factor = d / this.pinchDist;
          if (factor > 0.5 && factor < 2) this.applyZoom(factor);
        }
        this.pinchDist = d;
        return;
      }

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
      this.pointers.delete(e.pointerId);

      // 핀치 종료 (손가락 하나 이하로) — 이동 재개는 새 터치부터 (점프 방지)
      if (this.pinchDist > 0) {
        if (this.pointers.size < 2) {
          this.pinchDist = 0;
          this.showHint();
        }
        return;
      }

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
        this.pointers.clear();
        this.pinchDist = 0;
        this.joy.classList.add('hidden');
      } else {
        this.showHint();
      }
    }
  }

  window.MW = window.MW || {};
  MW.Input = Input;
})();
