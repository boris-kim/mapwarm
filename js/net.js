/* MapWarm — 친구 멀티 = 비동기 우편함 (v0.3)
   Supabase Postgres를 SDK 없이 fetch로 PostgREST REST 직접 호출.
   (SDK는 CDN이라 금지, REST는 데이터 호출이라 허용)

   핵심 안전장치: URL·키·그룹코드 중 하나라도 비면 enabled()=false → 완전 무동작.
   네트워크 실패도 조용히 폴백(null 반환) — 게임은 절대 멈추지 않는다.
   충돌 = 서버 updated_at(수신 시각) 기준 last-write-wins. 클라 타임스탬프는 안 보낸다.
   개인정보: 사진 dataURL은 절대 서버로 보내지 않는다 (색·닉·얼굴 프리셋만). */
(function () {
  'use strict';

  window.MW = window.MW || {};
  const PLAYER = 1; // MW.ID.PLAYER

  class Net {
    constructor(cfg) {
      cfg = cfg || {};
      this.url = (cfg.SUPABASE_URL || '').replace(/\/+$/, '');
      this.key = cfg.SUPABASE_ANON_KEY || '';
      this.group = cfg.GROUP_KEY || '';
      this.uploadMax = cfg.UPLOAD_MAX_CELLS || 500;
      this.lastSync = ''; // 마지막으로 본 서버 updated_at (ISO 문자열)
      this.fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null;
    }

    setKeys(url, key) {
      this.url = (url || '').replace(/\/+$/, '');
      this.key = key || '';
    }

    setGroup(code) {
      this.group = code || '';
      this.lastSync = ''; // 그룹 바뀌면 처음부터 다시 수신
    }

    // URL·키·그룹·fetch 전부 있어야만 켜진다. 하나라도 없으면 오프라인.
    enabled() {
      return !!(this.url && this.key && this.group && this.fetchImpl);
    }

    _headers(extra) {
      return Object.assign(
        {
          apikey: this.key,
          Authorization: 'Bearer ' + this.key,
          'Content-Type': 'application/json',
        },
        extra || {}
      );
    }

    // 모든 요청은 실패해도 절대 throw하지 않고 null 반환 (오프라인 폴백)
    async _req(path, opts) {
      if (!this.enabled()) return null;
      try {
        const res = await this.fetchImpl(this.url + path, opts);
        if (!res || !res.ok) return null;
        const txt = await res.text();
        return txt ? JSON.parse(txt) : [];
      } catch (e) {
        return null;
      }
    }

    // 업로드: 이번 세션 델타만 upsert (merge-duplicates). updated_at은 서버가 찍는다.
    async uploadCells(rows) {
      if (!this.enabled() || !rows || !rows.length) return { ok: false };
      if (rows.length > this.uploadMax) return { ok: false, rejected: true };
      const body = rows.map((r) => ({
        group_id: this.group,
        idx: r.idx,
        owner: r.owner,
        color: r.color,
        warmth_ts: r.warmth_ts,
      }));
      const r = await this._req('/rest/v1/cells', {
        method: 'POST',
        headers: this._headers({ Prefer: 'resolution=merge-duplicates' }),
        body: JSON.stringify(body),
      });
      return { ok: r !== null, count: body.length };
    }

    // 수신: last-sync 이후 updated_at 변경분만 GET
    async pullCells() {
      if (!this.enabled()) return { rows: [] };
      let q =
        '/rest/v1/cells?group_id=eq.' +
        encodeURIComponent(this.group) +
        '&select=idx,owner,color,warmth_ts,updated_at&order=updated_at.asc';
      if (this.lastSync) q += '&updated_at=gt.' + encodeURIComponent(this.lastSync);
      const rows = await this._req(q, { headers: this._headers() });
      if (!rows) return { rows: [] };
      for (let i = 0; i < rows.length; i++) {
        const u = rows[i].updated_at;
        if (u && u > this.lastSync) this.lastSync = u;
      }
      return { rows };
    }

    // 멤버 upsert (사진 제외 — 색·닉·얼굴만)
    async upsertMember(m) {
      if (!this.enabled()) return { ok: false };
      const body = [
        {
          group_id: this.group,
          member_id: m.member_id,
          nick: m.nick,
          color: m.color,
          face: m.face,
        },
      ];
      const r = await this._req('/rest/v1/members', {
        method: 'POST',
        headers: this._headers({ Prefer: 'resolution=merge-duplicates' }),
        body: JSON.stringify(body),
      });
      return { ok: r !== null };
    }

    async fetchMembers() {
      if (!this.enabled()) return [];
      const rows = await this._req(
        '/rest/v1/members?group_id=eq.' +
          encodeURIComponent(this.group) +
          '&select=member_id,nick,color,face',
        { headers: this._headers() }
      );
      return rows || [];
    }

    // 랜덤 6자리 그룹 코드 (혼동 문자 0/O/1/I 제외)
    static makeGroupCode() {
      const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let s = '';
      for (let i = 0; i < 6; i++) s += abc[(Math.random() * abc.length) | 0];
      return s;
    }

    /**
     * 순수 머지: 서버 rows를 로컬 보드에 반영 (last-write-wins — 서버가 진실).
     * remoteOwner(idx→memberId)를 갱신해 친구 소유를 추적(렌더 후속용).
     * 로컬 게임 로직상 친구 셀은 중립(0)으로 둬 감싸면 탈환 가능하게 한다.
     * @returns {lost, lostByMember, applied}
     */
    static mergeRemoteCells(board, remoteOwner, rows, myId) {
      let lost = 0;
      let applied = 0;
      const lostByMember = {};
      if (!rows || !rows.length) return { lost, lostByMember, applied };

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const idx = row.idx | 0;
        if (idx < 0 || idx >= board.owner.length) continue;
        const owner = row.owner;
        const prevMine = board.owner[idx] === PLAYER;

        if (owner === myId) {
          // 서버가 "내 것"이라고 확인 → 내 영토 유지
          board.owner[idx] = PLAYER;
          delete remoteOwner[idx];
        } else if (owner) {
          // 친구 소유
          if (prevMine) {
            lost++;
            lostByMember[owner] = (lostByMember[owner] || 0) + 1;
          }
          board.owner[idx] = 0; // 로컬 중립 (감싸면 회수)
          remoteOwner[idx] = owner;
        } else {
          // 중립화
          board.owner[idx] = 0;
          delete remoteOwner[idx];
        }
        applied++;
      }
      if (applied) board.rev++;
      return { lost, lostByMember, applied };
    }
  }

  MW.Net = Net;
})();
