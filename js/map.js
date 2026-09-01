/* MapWarm — 실제 지도 배경 (OpenStreetMap 래스터 타일, 라이브러리 없음)
   Geo: 셀 ↔ 위경도 ↔ 타일 픽셀을 "하나의" 웹 메르카토르 변환으로 통일
   TileMap: 보이는 타일만 요청 · Map 캐시 · 동시 8개 제한 · 실패 시 격자 폴백 */
(function () {
  'use strict';

  const EARTH_CIRCUM = 40075016.686; // 적도 둘레(m)

  /**
   * 기준점(anchor): "이 셀 좌표 = 이 위경도"를 한 점으로 고정하고,
   * 주변 400m는 국소 선형으로 취급한다 (메르카토르는 등각이라 x/y 축척 동일).
   * 데모 모드 anchor = 서울시청, GPS 모드 anchor = 첫 fix.
   */
  class Geo {
    constructor(lat, lng, cellX, cellY) {
      this.setAnchor(lat, lng, cellX, cellY);
    }

    setAnchor(lat, lng, cellX, cellY) {
      this.lat = lat;
      this.lng = lng;
      this.cellX = cellX; // 연속 셀 좌표 (셀 (c,r)의 중심 = (c+0.5, r+0.5))
      this.cellY = cellY;
      this.m0 = Geo.latLngToMercator(lat, lng);
      // 메르카토르 정규화 좌표(0~1) 기준: 1m = 몇 단위인가 (anchor 위도에서)
      this.upm = 1 / (EARTH_CIRCUM * Math.cos((lat * Math.PI) / 180));
      this.upc = this.upm * MW.CONFIG.GPS_CELL_METERS; // 1셀(5m) = 몇 단위
    }

    // 위경도 → 웹 메르카토르 정규화 좌표 (x,y ∈ 0~1, y는 남쪽으로 증가)
    static latLngToMercator(lat, lng) {
      const x = (lng + 180) / 360;
      const s = Math.sin((lat * Math.PI) / 180);
      const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
      return { x, y };
    }

    cellToMercator(x, y) {
      return {
        x: this.m0.x + (x - this.cellX) * this.upc,
        y: this.m0.y + (y - this.cellY) * this.upc, // 화면 아래(행 증가) = 남쪽
      };
    }

    mercatorToCell(mx, my) {
      return {
        x: this.cellX + (mx - this.m0.x) / this.upc,
        y: this.cellY + (my - this.m0.y) / this.upc,
      };
    }

    // GPS 좌표 → 5m 격자 셀 스냅 (지도 렌더링과 완전히 같은 변환을 쓴다)
    latLngToCell(lat, lng) {
      const m = Geo.latLngToMercator(lat, lng);
      const p = this.mercatorToCell(m.x, m.y);
      return { c: Math.floor(p.x), r: Math.floor(p.y) };
    }
  }

  class TileMap {
    constructor() {
      this.cache = new Map(); // "z/x/y" → { status: 'pending'|'ok'|'error', img }
      this.queue = [];
      this.inflight = 0;
      this.maxInflight = 8; // 동시 요청 제한 (OSM 정책 배려)
      this.zoom = 18;
      this.geo = null;
      this.onLoad = null; // 타일 1장 로드 완료 시 알림 (결과 카드 재렌더 등)
    }

    setGeo(geo) {
      this.geo = geo;
      this.zoom = this.pickZoom();
    }

    // 5m/셀 해상도에 가장 가까운 줌 선택 (z=17~18 중)
    pickZoom() {
      const cp = MW.CONFIG.CELL_PX;
      let best = 18;
      let bd = Infinity;
      const zooms = [17, 18];
      for (let i = 0; i < zooms.length; i++) {
        const z = zooms[i];
        const tilePxPerCell = this.geo.upc * Math.pow(2, z) * 256;
        const d = Math.abs(Math.log2(cp / tilePxPerCell));
        if (d < bd) {
          bd = d;
          best = z;
        }
      }
      return best;
    }

    /** 화면에 보이는 타일만 그린다. 로드 안 된 타일 영역은 밑의 격자 배경이 그대로 보인다(폴백). */
    draw(ctx, ox, oy, cp, w, h) {
      const geo = this.geo;
      if (!geo) return;
      const z = this.zoom;
      const n = Math.pow(2, z);

      // 화면 네 귀퉁이 → 셀 좌표 → 메르카토르 → 타일 번호 범위
      const mA = geo.cellToMercator((0 - ox) / cp, (0 - oy) / cp);
      const mB = geo.cellToMercator((w - ox) / cp, (h - oy) / cp);
      const tx0 = Math.max(0, Math.floor(mA.x * n));
      const tx1 = Math.min(n - 1, Math.floor(mB.x * n));
      const ty0 = Math.max(0, Math.floor(mA.y * n));
      const ty1 = Math.min(n - 1, Math.floor(mB.y * n));

      // 안전장치: 좌표 이상으로 범위가 폭주하면 요청하지 않음
      if (tx1 - tx0 > 10 || ty1 - ty0 > 10) return;

      const tileScreenSize = (256 / (geo.upc * n * 256)) * cp; // 타일 1장 = 화면 px

      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const key = z + '/' + tx + '/' + ty;
          let t = this.cache.get(key);
          if (!t) t = this.request(key, z, tx, ty); // 캐시 우선, 같은 타일 재요청 없음
          if (t.status !== 'ok') continue;

          const cell = geo.mercatorToCell(tx / n, ty / n);
          const sx = ox + cell.x * cp;
          const sy = oy + cell.y * cp;
          // +0.5px 겹침: 타일 사이 미세한 실금(seam) 방지
          ctx.drawImage(t.img, sx, sy, tileScreenSize + 0.5, tileScreenSize + 0.5);
        }
      }
    }

    request(key, z, x, y) {
      const t = { status: 'pending', img: null };
      this.cache.set(key, t); // 실패해도 캐시에 남아 재요청하지 않는다
      this.queue.push({ key, z, x, y, t });
      this.pump();
      return t;
    }

    pump() {
      while (this.inflight < this.maxInflight && this.queue.length) {
        const job = this.queue.shift();
        this.inflight++;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          // 로드 시 1회만 저채도로 구워 캐시 (매 프레임 필터 금지 — 성능)
          job.t.img = this.desaturate(img);
          job.t.status = 'ok';
          this.inflight--;
          this.pump();
          if (this.onLoad) this.onLoad();
        };
        img.onerror = () => {
          job.t.status = 'error'; // 이 타일 영역은 격자 배경으로 폴백
          this.inflight--;
          this.pump();
        };
        img.src = 'https://tile.openstreetmap.org/' + job.z + '/' + job.x + '/' + job.y + '.png';
      }
    }

    /** 타일 채도를 강하게 뺀다 (지도는 무대, 캔디 영토가 주인공 — §6.5) */
    desaturate(img) {
      try {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const x = c.getContext('2d');

        x.filter = 'saturate(0.15)';
        if (x.filter && x.filter !== 'none') {
          x.drawImage(img, 0, 0);
          return c;
        }

        // ctx.filter 미지원(구형 Safari 등) → 수동 채도 감소 (타일당 1회)
        x.drawImage(img, 0, 0);
        const data = x.getImageData(0, 0, c.width, c.height);
        const p = data.data;
        for (let i = 0; i < p.length; i += 4) {
          const g = 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
          p[i] = g + (p[i] - g) * 0.15;
          p[i + 1] = g + (p[i + 1] - g) * 0.15;
          p[i + 2] = g + (p[i + 2] - g) * 0.15;
        }
        x.putImageData(data, 0, 0);
        return c;
      } catch (e) {
        return img; // 실패 시 원본 (--map-tint 워시는 그대로 적용됨)
      }
    }
  }

  window.MW = window.MW || {};
  MW.Geo = Geo;
  MW.TileMap = TileMap;
})();
