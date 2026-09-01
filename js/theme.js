/* MapWarm — 테마 관리 (라이트/다크/시스템 3단, ux-architect 표준) */
(function () {
  'use strict';

  class ThemeManager {
    constructor() {
      this.currentTheme = this.getStoredTheme() || 'system';
      this.applyTheme(this.currentTheme);
      this.initializeToggle();

      // 시스템 테마가 바뀌면(OS 다크모드 전환) 캔버스 팔레트도 갱신
      window
        .matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', () => {
          if (this.currentTheme === 'system') this.notify();
        });
    }

    getStoredTheme() {
      try {
        return localStorage.getItem('theme');
      } catch (e) {
        return null;
      }
    }

    applyTheme(theme) {
      if (theme === 'system') {
        document.documentElement.removeAttribute('data-theme');
        try {
          localStorage.removeItem('theme');
        } catch (e) { /* 저장 불가 환경 무시 */ }
      } else {
        document.documentElement.setAttribute('data-theme', theme);
        try {
          localStorage.setItem('theme', theme);
        } catch (e) { /* 저장 불가 환경 무시 */ }
      }
      this.currentTheme = theme;
      this.updateToggleUI();
      this.notify();
    }

    // 캔버스 렌더러 등이 이 이벤트를 듣고 색상 토큰을 다시 읽는다
    notify() {
      document.dispatchEvent(new CustomEvent('mw:themechange'));
    }

    initializeToggle() {
      const toggle = document.querySelector('.theme-toggle');
      if (!toggle) return;
      toggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.theme-toggle-option');
        if (btn) this.applyTheme(btn.dataset.theme);
      });
    }

    updateToggleUI() {
      document.querySelectorAll('.theme-toggle-option').forEach((option) => {
        const on = option.dataset.theme === this.currentTheme;
        option.classList.toggle('active', on);
        option.setAttribute('aria-checked', String(on));
      });
    }
  }

  window.MW = window.MW || {};
  MW.ThemeManager = ThemeManager;
})();
