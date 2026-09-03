/* MapWarm — 건물 콜렉팅 = 랜드마크 스티커 (v0.3)
   Overpass API(OSM 공개 데이터)를 fetch로 질의 — 라이브러리 아님, 데이터 호출.
   두 층 (§6.11): ① 발견(도감) = 영구·무손실  ② 현재 소유 = 온기 종속(표시만).
   Overpass 실패/오프라인이어도 게임은 100% 동작 (콜렉팅만 빠짐).
   개인정보 없음(공개 지도 데이터). 순수 판정/파싱은 static — node 테스트 가능. */
(function () {
  'use strict';

  window.MW = window.MW || {};

  // 카테고리 → 스티커 (라벨·캔디색·아이콘). 색은 §6.5 캔디 팔레트 id.
  const CATS = [
    { id: 'cafe', label: '카페', color: 'orange', tag: 'amenity', val: 'cafe' },
    { id: 'convenience', label: '편의점', color: 'sky', tag: 'shop', val: 'convenience' },
    { id: 'restaurant', label: '식당', color: 'pink', tag: 'amenity', val: 'restaurant' },
    { id: 'school', label: '학교', color: 'purple', tag: 'amenity', val: 'school' },
    { id: 'pharmacy', label: '약국', color: 'lime', tag: 'amenity', val: 'pharmacy' },
    { id: 'bank', label: '은행', color: 'cyan', tag: 'amenity', val: 'bank' },
    { id: 'post_office', label: '우체국', color: 'pink', tag: 'amenity', val: 'post_office' },
    { id: 'library', label: '도서관', color: 'purple', tag: 'amenity', val: 'library' },
    { id: 'park', label: '공원', color: 'lime', tag: 'leisure', val: 'park' },
    { id: 'playground', label: '놀이터', color: 'orange', tag: 'leisure', val: 'playground' },
    { id: 'station', label: '역', color: 'sky', tag: 'railway', val: 'station' },
    { id: 'bridge', label: '다리', color: 'cyan', tag: 'man_made', val: 'bridge' },
    { id: 'tourism', label: '명소', color: 'purple', tag: 'tourism', val: '*' },
    { id: 'frontier', label: '개척지', color: 'lime', tag: null, val: null }, // 마일스톤 폴백
  ];
  const CAT_BY_ID = {};
  for (let i = 0; i < CATS.length; i++) CAT_BY_ID[CATS[i].id] = CATS[i];

  const MILESTONES = [100, 500, 1000]; // 누적 감싼 칸 수 → 개척지 스티커

  class Landmarks {
    constructor() {
      this.fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null;
      this.collection = Landmarks.loadCollection();
      this.cache = Landmarks.loadCache(); // regionKey → POI 배열
      this.explored = Landmarks.loadExplored();
      this._backoffUntil = 0;
    }

    // ---------- 저장 ----------
    static loadCollection() {
      try {
        const raw = localStorage.getItem('mapwarm-collection');
        if (raw) return JSON.parse(raw) || {};
      } catch (e) { /* noop */ }
      return {};
    }
    saveCollection() {
      try {
        localStorage.setItem('mapwarm-collection', JSON.stringify(this.collection));
      } catch (e) { /* noop */ }
    }
    static loadCache() {
      try {
        const raw = localStorage.getItem('mapwarm-poicache');
        if (raw) return JSON.parse(raw) || {};
      } catch (e) { /* noop */ }
      return {};
    }
    saveCache() {
      try {
        localStorage.setItem('mapwarm-poicache', JSON.stringify(this.cache));
      } catch (e) { /* noop */ }
    }
    static loadExplored() {
      try {
        return parseInt(localStorage.getItem('mapwarm-explored') || '0', 10) || 0;
      } catch (e) {
        return 0;
      }
    }
    saveExplored() {
      try {
        localStorage.setItem('mapwarm-explored', String(this.explored));
      } catch (e) { /* noop */ }
    }

    // ---------- 순수 헬퍼 ----------
    static cats() {
      return CATS;
    }
    static catInfo(id) {
      return CAT_BY_ID[id] || null;
    }

    // OSM 태그 → 카테고리 id (없으면 null)
    static classify(tags) {
      if (!tags) return null;
      for (let i = 0; i < CATS.length; i++) {
        const cat = CATS[i];
        if (!cat.tag) continue;
        if (cat.val === '*') {
          if (tags[cat.tag]) return cat.id;
        } else if (tags[cat.tag] === cat.val) {
          return cat.id;
        }
      }
      return null;
    }

    // 지역 캐시 키 (약 550m 격자로 반올림 — 같은 동네 재질의 방지)
    static regionKey(lat, lon) {
      return Math.round(lat * 200) + ':' + Math.round(lon * 200);
    }

    // Overpass 응답 → [{name, cat, lat, lon}]
    static parseOverpass(json) {
      const out = [];
      if (!json || !Array.isArray(json.elements)) return out;
      for (let i = 0; i < json.elements.length; i++) {
        const el = json.elements[i];
        const cat = Landmarks.classify(el.tags);
        if (!cat) continue;
        const lat = el.lat != null ? el.lat : el.center && el.center.lat;
        const lon = el.lon != null ? el.lon : el.center && el.center.lon;
        if (lat == null || lon == null) continue;
        const name = (el.tags && el.tags.name) || Landmarks.catInfo(cat).label;
        out.push({ name: name, cat: cat, lat: lat, lon: lon });
      }
      return out;
    }

    static buildQuery(bbox) {
      const b = bbox.s + ',' + bbox.w + ',' + bbox.n + ',' + bbox.e;
      return (
        '[out:json][timeout:25];(' +
        'node["amenity"~"^(cafe|restaurant|school|pharmacy|bank|post_office|library)$"](' + b + ');' +
        'node["shop"="convenience"](' + b + ');' +
        'node["leisure"~"^(park|playground)$"](' + b + ');' +
        'way["leisure"~"^(park|playground)$"](' + b + ');' +
        'node["railway"="station"](' + b + ');' +
        'node["man_made"="bridge"](' + b + ');' +
        'node["tourism"](' + b + ');' +
        ');out center tags;'
      );
    }

    static poiKey(poi) {
      return poi.cat + '@' + Number(poi.lat).toFixed(5) + ',' + Number(poi.lon).toFixed(5);
    }

    /**
     * 획득 판정: POI 점의 셀이 이번에 감싼 셀 집합(capturedSet)에 들어오면 발견.
     * 도감(collection)은 영구·무손실 — 이미 있으면 추가 안 함(최초 획득만).
     * @param cellOf (lat,lon) → idx | null
     * @returns 새로 발견한 POI 배열
     */
    static awardFromCapture(pois, capturedSet, cellOf, collection, now) {
      const newly = [];
      if (!pois || !pois.length) return newly;
      for (let i = 0; i < pois.length; i++) {
        const poi = pois[i];
        const idx = cellOf(poi.lat, poi.lon);
        if (idx == null || !capturedSet.has(idx)) continue;
        const key = Landmarks.poiKey(poi);
        if (collection[key]) continue; // 이미 도감에 있음 (무손실)
        collection[key] = {
          name: poi.name,
          cat: poi.cat,
          lat: poi.lat,
          lon: poi.lon,
          firstAt: now,
        };
        newly.push(collection[key]);
      }
      return newly;
    }

    // 마일스톤 폴백: 누적 감싼 칸이 임계 넘으면 개척지 스티커
    static checkMilestones(prevTotal, newTotal, collection, now) {
      const newly = [];
      for (let i = 0; i < MILESTONES.length; i++) {
        const m = MILESTONES[i];
        if (prevTotal < m && newTotal >= m) {
          const key = 'frontier@' + m;
          if (!collection[key]) {
            collection[key] = { name: '개척지 ' + m, cat: 'frontier', milestone: m, firstAt: now };
            newly.push(collection[key]);
          }
        }
      }
      return newly;
    }

    // ---------- 네트워크: 지역 POI 질의 (캐시 우선, 429 백오프) ----------
    async fetchRegion(bbox) {
      if (!this.fetchImpl) return [];
      const key = Landmarks.regionKey((bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2);
      if (this.cache[key]) return this.cache[key]; // 재질의 금지
      if (Date.now() < this._backoffUntil) return []; // 429 백오프 중

      const url = 'https://overpass-api.de/api/interpreter';
      const body = 'data=' + encodeURIComponent(Landmarks.buildQuery(bbox));
      let attempt = 0;
      while (attempt < 2) {
        try {
          const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
          });
          if (res && res.status === 429) {
            this._backoffUntil = Date.now() + Math.pow(2, attempt + 1) * 5000;
            attempt++;
            continue;
          }
          if (!res || !res.ok) return [];
          const json = JSON.parse(await res.text());
          const pois = Landmarks.parseOverpass(json);
          this.cache[key] = pois; // 성공만 캐시 (POI는 안 변함)
          this.saveCache();
          return pois;
        } catch (e) {
          return []; // 조용히 폴백
        }
      }
      return [];
    }

    // 현재 소유 여부: POI 셀을 지금 내가 가졌나 (표시용)
    static isOwnedNow(entry, board, cellOf, playerId) {
      if (!entry.lat && entry.milestone) return true; // 개척지는 항상 보유
      const idx = cellOf(entry.lat, entry.lon);
      return idx != null && board.owner[idx] === playerId;
    }
  }

  Landmarks.MILESTONES = MILESTONES;
  MW.Landmarks = Landmarks;
})();
