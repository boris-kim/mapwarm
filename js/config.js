/* MapWarm — 전역 네임스페이스 & 게임 상수 */
(function () {
  'use strict';

  window.MW = window.MW || {};

  MW.CONFIG = {
    GRID: 48,               // 게임판: 48×48칸 (약 240m×240m — 5분 산책 = 동네 한 블록)
    TICK_MS: 125,           // 로직 틱: 초당 8틱 (렌더링과 분리)
    CELL_PX: 36,            // 화면상 1칸 크기(px) — 줌 인: 한 걸음이 화면에서 크게 움직임
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
    ANCHOR_REUSE_M: 120,    // 저장된 동네 anchor에서 이 거리 안이면 같은 보드 복원 (보드 240m에 맞춤)
    WORLD_KEY: 'mapwarm-world-v1', // localStorage 영속 키
    WORLD_SAVE_TICKS: 80,   // 자동 저장 주기 (80틱 = 10초)
    DECAY_CHECK_TICKS: 240, // 플레이 중 냉각 중립화 점검 주기 (30초)

    // --- v0.2 오디오 확장 (발소리 · BGM) ---
    STEP_DEMO_EVERY: 2,     // 데모: 발소리를 이 칸수마다 1발 (초당 8칸이라 촘촘함 완화)
    STEP_GPS_EVERY: 1,      // GPS: 매 걸음 발소리

    // --- v0.3 예상 점령 게이지 ---
    GAUGE_TICKS: 2,         // 예상 면적 재계산 주기 (2틱마다 = 초당 4회)
    GAUGE_URGE_CELLS: 60,   // 예상 점령이 이 칸수 이상이면 "지금 닫아!" 강조

    // --- v0.3 카메라 줌 (뷰 전용 — 로직 좌표 불변) ---
    ZOOM_MAX: 1.2,          // 최대 배율 (현재보다 살짝 더 당김). 최소는 보드 전체가 화면에 들어오는 배율(런타임 계산)
    ZOOM_RETURN_MS: 1800,   // 손 뗀 뒤 기본 배율(1.0)로 부드럽게 복귀하기까지 대기
    ZOOM_WHEEL_STEP: 1.12,  // 데스크톱 휠 한 틱 배율
    ZOOM_BTN_STEP: 1.35,    // 줌 버튼 한 번 배율

    // --- v0.3 친구 멀티 = 비동기 우편함 (Supabase REST) ---
    // ⚠ 아래 URL/키가 둘 다 채워지고 그룹 코드가 있어야 멀티가 켜진다.
    //    하나라도 비면 net은 완전 무동작 = 100% 혼자 플레이 (에러/네트워크 0).
    //    사용자가 나중에: ① supabase-schema.sql 실행 ② 아래 URL/키 입력.
    SUPABASE_URL: '',        // 예: 'https://xxxx.supabase.co'
    SUPABASE_ANON_KEY: '',   // Supabase anon public 키
    GROUP_KEY: '',           // 기본 그룹 코드 (보통은 UI/링크로 설정 → localStorage)
    SYNC_INTERVAL_MS: 60000, // 수신 폴링 주기 (60초)
    UPLOAD_MAX_CELLS: 500,   // 한 번에 업로드 상한 (초과 시 reject — 순간이동 치팅 방어)
  };

  // 엔티티 ID (보드 owner 배열 값과 동일)
  MW.ID = { NONE: 0, PLAYER: 1, BOT1: 2, BOT2: 3 };
})();
