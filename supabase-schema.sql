-- ============================================================
-- MapWarm v0.3 — 친구 멀티(비동기 우편함) DB 스키마
-- Supabase(Postgres) SQL Editor에 붙여넣고 Run 하면 됩니다.
--
-- ⚠ 프로토타입 주의: 이 스키마는 friend-scale(친구 몇 명) 기준으로
--    anon 읽기/쓰기를 허용합니다. 프로덕션에서는 RLS를 강화하세요
--    (예: 그룹 코드 소유 검증, 멤버만 쓰기, rate limit).
--
-- 개인정보: 프로필 사진은 서버에 저장하지 않습니다.
--   members에는 색·닉·얼굴 프리셋만 들어갑니다.
-- 충돌 판정: updated_at(서버 now()) 기준 last-write-wins.
--   클라이언트 타임스탬프는 신뢰하지 않습니다(아래 트리거가 서버 시각을 강제).
-- ============================================================

-- ---------- 셀(영토) ----------
create table if not exists public.cells (
  group_id   text        not null,
  idx        integer     not null,           -- 보드 셀 인덱스 (row*size + col)
  owner      text        not null,           -- 프로필 member_id (또는 닉)
  color      text,                           -- 캔디 색 id (lime/pink/...)
  warmth_ts  bigint,                         -- 온기 기준 시각(ms) — 클라 계산용, 판정엔 안 씀
  updated_at timestamptz not null default now(),
  primary key (group_id, idx)
);

-- 수신 델타 조회용 인덱스 (group + updated_at 범위)
create index if not exists cells_group_updated_idx
  on public.cells (group_id, updated_at);

-- ---------- 멤버(프로필, 사진 없음) ----------
create table if not exists public.members (
  group_id   text    not null,
  member_id  text    not null,
  nick       text,
  color      text,
  face       integer,
  updated_at timestamptz not null default now(),
  primary key (group_id, member_id)
);

-- ---------- updated_at 서버 시각 강제 (LWW 기준) ----------
-- INSERT/UPDATE 모두 서버 now()로 덮어써서 클라 시계 조작을 무력화한다.
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists cells_set_updated_at on public.cells;
create trigger cells_set_updated_at
  before insert or update on public.cells
  for each row execute function public.set_updated_at();

drop trigger if exists members_set_updated_at on public.members;
create trigger members_set_updated_at
  before insert or update on public.members
  for each row execute function public.set_updated_at();

-- ---------- RLS (프로토타입: anon 전체 허용) ----------
-- 프로덕션 전환 시 아래 정책을 그룹/멤버 검증으로 좁힐 것.
alter table public.cells   enable row level security;
alter table public.members enable row level security;

drop policy if exists cells_anon_all on public.cells;
create policy cells_anon_all on public.cells
  for all to anon using (true) with check (true);

drop policy if exists members_anon_all on public.members;
create policy members_anon_all on public.members
  for all to anon using (true) with check (true);
