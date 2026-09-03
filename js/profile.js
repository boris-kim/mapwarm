/* MapWarm — 프로필 (v0.3, 로컬 완결 · 서버 없음)
   순수 데이터 모듈: 로드/세이브/기본값/마이그레이션 (node 테스트 가능, localStorage 가드)
   사진은 브라우저 localStorage에만 저장 — 어디에도 전송되지 않는다. */
(function () {
  'use strict';

  window.MW = window.MW || {};

  const KEY = 'mapwarm-profile';
  const NICK_MAX = 10;

  // 프리셋 얼굴 (사진 없을 때) — §6.5 캔버스 얼굴 스타일 (이모지 아님)
  const FACES = ['smile', 'flat', 'round', 'wink'];
  // 캔디 팔레트 색 id (CSS --candy-* 토큰과 1:1)
  const COLORS = ['lime', 'pink', 'orange', 'sky', 'purple', 'cyan'];

  function defaults() {
    return { nick: 'MINJAE', photo: null, face: 0, color: 'lime' };
  }

  // 어떤 입력이 와도 안전한 프로필로 정규화 (빈 이름 방지, 잘못된 값 폴백)
  function sanitize(p) {
    const d = defaults();
    if (!p || typeof p !== 'object') return d;

    if (typeof p.nick === 'string') {
      const nick = p.nick.trim().slice(0, NICK_MAX);
      if (nick) d.nick = nick;
    }
    // 사진은 data URL 문자열만 허용 (그 외엔 프리셋 얼굴로)
    d.photo =
      typeof p.photo === 'string' && p.photo.slice(0, 5) === 'data:' ? p.photo : null;
    d.face =
      Number.isInteger(p.face) && p.face >= 0 && p.face < FACES.length ? p.face : 0;
    d.color = COLORS.indexOf(p.color) >= 0 ? p.color : 'lime';
    return d;
  }

  function load() {
    try {
      if (typeof localStorage === 'undefined') return defaults();
      const raw = localStorage.getItem(KEY);
      if (raw) return sanitize(JSON.parse(raw));

      // 하위호환: 기존 'mapwarm-nick' 만 있던 사용자 마이그레이션
      const oldNick = localStorage.getItem('mapwarm-nick');
      if (oldNick) {
        const p = defaults();
        p.nick = String(oldNick).toUpperCase().slice(0, NICK_MAX);
        save(p);
        return p;
      }
    } catch (e) { /* 저장 불가/파싱 실패 → 기본값 */ }
    return defaults();
  }

  function save(p) {
    const clean = sanitize(p);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(KEY, JSON.stringify(clean));
      }
    } catch (e) { /* 용량 초과 등 무시 */ }
    return clean;
  }

  /**
   * 파일(또는 data URL)을 정사각 중앙 크롭 + size×size 리사이즈 → JPEG data URL.
   * localStorage 용량 절감(256px 이하 권장). 브라우저 전용(document 필요).
   * @param {File|string} input
   * @param {number} size 출력 한 변 px
   * @param {(dataUrl:string|null)=>void} cb 실패 시 null
   */
  function cropResize(input, size, cb) {
    if (typeof document === 'undefined') {
      cb(null);
      return;
    }
    const img = new Image();
    let objUrl = null;
    img.onload = function () {
      try {
        const cv = document.createElement('canvas');
        cv.width = size;
        cv.height = size;
        const ctx = cv.getContext('2d');
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        cb(cv.toDataURL('image/jpeg', 0.82));
      } catch (e) {
        cb(null);
      }
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
    img.onerror = function () {
      cb(null);
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
    if (typeof input === 'string') {
      img.src = input;
    } else {
      objUrl = URL.createObjectURL(input);
      img.src = objUrl;
    }
  }

  MW.Profile = { KEY, NICK_MAX, FACES, COLORS, defaults, sanitize, load, save, cropResize };
})();
