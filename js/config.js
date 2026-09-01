/* MapWarm — 전역 네임스페이스 & 게임 상수 */
(function () {
  'use strict';

  window.MW = window.MW || {};

  MW.CONFIG = {
    GRID: 80,               // 게임판: 80×80칸 (약 400m×400m)
    TICK_MS: 125,           // 로직 틱: 초당 8틱 (렌더링과 분리)
    CELL_PX: 22,            // 화면상 1칸 크기(px)
    START_RADIUS: 1,        // 시작 영토 3×3 (반경 1)
    BOT_RESPAWN_TICKS: 24,  // 봇 리스폰 대기 (약 3초)
    GPS_CELL_METERS: 5,     // 현실 1칸 = 5m
    GPS_ACC_WARN: 25,       // 정확도 25m 초과 시 경고 배지
    DEMO_ANCHOR: { lat: 37.5665, lng: 126.9780 }, // 데모 모드 지도 기준점: 서울시청
    JOY_DEADZONE: 12,       // 조이스틱 데드존(px)
    JOY_RADIUS: 36,         // 스틱 최대 이동 반경(px)
    DEATH_FX_MS: 600,       // 사망 연출 길이 (오버레이 표시 전)
  };

  // 엔티티 ID (보드 owner 배열 값과 동일)
  MW.ID = { NONE: 0, PLAYER: 1, BOT1: 2, BOT2: 3 };
})();
