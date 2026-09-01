/* MapWarm — GPS 모드: watchPosition으로 실제 좌표를 5m 격자 셀로 스냅 */
(function () {
  'use strict';

  class GpsController {
    constructor(game) {
      this.game = game;
      this.watchId = null;
      this.anchored = false; // 첫 fix로 지도/셀 기준점을 잡았는지
      this.target = null;    // 현재 GPS가 가리키는 목표 셀
      this.accuracy = null;
      this.started = false;  // 첫 fix를 받았는지
    }

    start() {
      if (!('geolocation' in navigator)) {
        this.game.gpsFailed(null);
        return;
      }
      this.started = false;
      this.anchored = false;
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.onFix(pos),
        (err) => this.onError(err),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
      );
    }

    onFix(pos) {
      const { latitude, longitude, accuracy } = pos.coords;
      this.accuracy = accuracy;

      if (!this.anchored) {
        // 첫 fix = anchor: 지도 타일과 셀 좌표의 기준점을 현재 플레이어 셀에 묶는다
        this.anchored = true;
        this.game.setGpsAnchor(latitude, longitude);
      }

      // 지도 렌더링과 동일한 메르카토르 변환으로 5m 격자 셀 스냅
      this.target = this.game.geo.latLngToCell(latitude, longitude);

      if (!this.started) {
        this.started = true;
        this.game.gpsStarted();
      }
      this.game.updateGpsBadge(accuracy);
    }

    onError(err) {
      this.stop();
      this.game.gpsFailed(err);
    }

    stop() {
      if (this.watchId !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(this.watchId);
      }
      this.watchId = null;
      this.anchored = false;
      this.target = null;
      this.accuracy = null;
      this.started = false;
    }

    // 목표 셀 쪽으로 한 칸씩 (대각선 금지 — 차이가 큰 축 먼저)
    getDir(player) {
      if (!this.target) return null;
      const dc = this.target.c - player.c;
      const dr = this.target.r - player.r;
      if (!dc && !dr) return null;
      if (Math.abs(dc) >= Math.abs(dr) && dc) return [Math.sign(dc), 0];
      return [0, Math.sign(dr)];
    }
  }

  window.MW = window.MW || {};
  MW.GpsController = GpsController;
})();
