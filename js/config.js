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

    // --- v0.15 라운드 ---
    WIN_PCT: 40,            // 점유율 40% 도달 → 즉시 승리
    ROUND_MS_DEMO: 180000,  // 데모 제한시간 3분
    ROUND_MS_GPS: 1200000,  // GPS 제한시간 20분
    TIME_WARN_MS: 30000,    // 30초 남으면 시간 표시 경고(핑크)
    BOT_GPS_STEP_MS: 3500,  // GPS 모드 봇 걸음: 1칸당 ~3.5초 (사람 1.4m/s × 5m 칸)

    // --- v0.15 정복 카드 ---
    CARD_W: 1080,           // 카드 이미지 1080×1350 (4:5)
    CARD_H: 1350,

    // --- v0.2 "식지 않는 동네" (GPS 모드 전용 — 전부 튜닝 대상) ---
    WARM_DECAY_DAYS: 7,     // 온기: 점령 1.0 → 7일에 걸쳐 선형 냉각, 0이면 중립화
    REHEAT_RADIUS: 2,       // 내 머리 주변 반경 2칸(박스)의 내 셀 재가열
    ERODE_COLD: 0.3,        // 봇 잠식 대상: 온기 30% 미만 셀만
    ERODE_MIN_FRAC: 0.05,   // 봇 잠식: 하루당 내 영토의 5~10%
    ERODE_MAX_FRAC: 0.10,
    ERODE_MAX_DAYS: 7,      // 잠식 경과 계산 상한 (7일 이상 방치 = 7일치)
    GPS_START_RADIUS: 3,    // 온보딩 첫 GPS 세션 시작 영토 7×7 (반경 3) — 첫 보상 공백 완화
    WARM_ALERT_AVG: 0.7,    // 내 영토 평균 온기가 이 밑이면 "식음 경고" (D1~D4 능동 훅)
    ANCHOR_REUSE_M: 250,    // 저장된 동네 anchor에서 이 거리 안이면 같은 보드 복원
    WORLD_KEY: 'mapwarm-world-v1', // localStorage 영속 키
    WORLD_SAVE_TICKS: 80,   // 자동 저장 주기 (80틱 = 10초)
    DECAY_CHECK_TICKS: 240, // 플레이 중 냉각 중립화 점검 주기 (30초)
  };

  // 엔티티 ID (보드 owner 배열 값과 동일)
  MW.ID = { NONE: 0, PLAYER: 1, BOT1: 2, BOT2: 3 };
})();
