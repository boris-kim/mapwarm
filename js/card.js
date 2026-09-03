/* MapWarm — 동네 정복 카드 (v0.15 핵심)
   판이 끝나면 내가 먹은 동네가 스티커 포스터가 되어 나온다.
   1080×1350(4:5) 캔버스에 §6.5 스티커 언어로 그린다 — 색은 전부 토큰.
   공유: toBlob → navigator.share(files), 미지원이면 이미지 다운로드 폴백. */
(function () {
  'use strict';

  class ConquestCard {
    constructor(game) {
      this.game = game;
    }

    // 토큰 팔레트 (그릴 때마다 새로 읽음 — 테마 전환 반영)
    readPalette() {
      const cs = getComputedStyle(document.documentElement);
      const tok = (n, fb) => {
        const v = cs.getPropertyValue(n).trim();
        return v || fb;
      };
      return {
        panel: tok('--panel-bg', '#2b2b2e'),
        panelDeep: tok('--panel-bg-deep', '#232326'),
        fg: tok('--panel-fg', '#f2f2f4'),
        muted: tok('--panel-fg-muted', '#7c7d84'),
        rivet: tok('--rivet-color', '#5a5b60'),
        white: tok('--sticker-white', '#ffffff'),
        face: tok('--avatar-face', '#2b2b2e'),
        lime: tok('--p1-head', '#b7e819'),
        limeFrame: tok('--p1-frame', '#b7e819'),
        pink: tok('--bot1-head', '#ff3e9a'),
        orange: tok('--bot2-head', '#ff8a00'),
        ledBg: tok('--led-fill-bg', '#b7e819'),
        ledFg: tok('--led-fill-fg', '#1e2005'),
        mapTint: tok('--map-tint', 'rgba(234,235,231,0.62)'),
      };
    }

    /**
     * 카드를 canvas(1080×1350 버퍼)에 그린다.
     * result: { outcome:'win'|'lose'|'death', reason, pct, elapsedMs, cuts, owner:Uint8Array }
     */
    render(canvas, result, includeMap) {
      const W = MW.CONFIG.CARD_W;
      const H = MW.CONFIG.CARD_H;
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      const P = this.readPalette();
      const win = result.outcome === 'win';

      // --- 차콜 하드웨어 패널 배경 + 스티커 테두리 + 리벳 ---
      ctx.fillStyle = P.panelDeep;
      ctx.fillRect(0, 0, W, H);
      this.rr(ctx, 20, 20, W - 40, H - 40, 44);
      ctx.fillStyle = P.panel;
      ctx.fill();
      this.rr(ctx, 20, 20, W - 40, H - 40, 44);
      ctx.strokeStyle = P.white;
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.fillStyle = P.rivet;
      const rv = [[56, 56], [W - 56, 56], [56, H - 56], [W - 56, H - 56]];
      for (let i = 0; i < rv.length; i++) {
        ctx.beginPath();
        ctx.arc(rv[i][0], rv[i][1], 12, 0, Math.PI * 2);
        ctx.fill();
      }

      // --- 헤더 ---
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      try { ctx.letterSpacing = '4px'; } catch (e) { /* 미지원 무시 */ }
      ctx.font = '700 26px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = P.muted;
      ctx.fillText('MAPWARM · NEIGHBORHOOD CONQUEST', W / 2, 108);

      ctx.font = '800 68px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = win ? P.lime : P.pink;
      ctx.fillText(
        result.weekly
          ? 'WEEK ' + result.weekNum
          : win ? 'VICTORY!' : result.outcome === 'death' ? 'K.O.' : 'TIME UP',
        W / 2,
        186
      );

      // --- 영토 실루엣 (기본: 지도 없음 — 프라이버시) ---
      const area = { x: 90, y: 250, w: 900, h: 740 };
      const layout = this.territoryLayout(result.owner, area);
      if (layout) {
        if (includeMap && this.game.tileMap) {
          this.drawMapLayer(ctx, area, layout, P, result.owner);
        }
        this.drawTerritoryDots(ctx, result.owner, layout, P.lime);
      } else {
        ctx.font = '700 34px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = P.muted;
        ctx.fillText('NO LAND…', W / 2, area.y + area.h / 2);
      }

      // --- 내 아바타 스티커 (승리=왕관 / 패배·사망=넘어짐) ---
      this.drawAvatar(ctx, 812, 918, 220, P, {
        frame: P.limeFrame,
        faceId: 1,
        happy: win,
        fallen: !win,
        crown: win,
        alpha: win ? 1 : 0.85,
      });

      // --- 내가 꼬리를 끊어 죽인 봇들: 바닥에 쓰러진 스티커 (§6.8) ---
      this.drawKilledBots(ctx, result.kills || {}, P);

      // --- 결과 전광판 ---
      const pctText = '동네 ' + result.pct.toFixed(1) + '% 정복'; // 동네 N% 정복
      ctx.font = '800 58px ui-monospace, SFMono-Regular, Menlo, monospace';
      const tw = ctx.measureText(pctText).width;
      const pw = tw + 88;
      const ph = 104;
      this.rr(ctx, W / 2 - pw / 2, 1046 - ph / 2, pw, ph, 30);
      ctx.fillStyle = P.ledBg;
      ctx.fill();
      ctx.fillStyle = P.ledFg;
      ctx.fillText(pctText, W / 2, 1050);

      ctx.font = '700 34px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = P.fg;
      ctx.fillText(
        result.weekly
          ? 'GAINED +' + (result.gained || 0) + ' · WALKS ×' + (result.walks || 0)
          : 'TIME ' + MW.Round.fmt(result.elapsedMs) + ' · TAIL CUT ×' + result.cuts,
        W / 2,
        1150
      );

      if (result.reason) {
        ctx.font = '600 26px -apple-system, "Apple SD Gothic Neo", sans-serif';
        ctx.fillStyle = P.muted;
        ctx.fillText(result.reason, W / 2, 1198);
      }

      // 주간 카드: 랜드마크 소유/발견 한 줄
      if (result.weekly && result.landmarks) {
        ctx.font = '700 28px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = P.lime;
        ctx.fillText(
          '★ 랜드마크 소유 ' + result.landmarks.owned + ' / 발견 ' + result.landmarks.discovered,
          W / 2,
          1232
        );
      }

      // --- MapWarm 로고 스티커 (핑크 필 + 흰 테두리, 살짝 기울임) ---
      ctx.save();
      ctx.translate(W / 2, 1276);
      ctx.rotate(-0.05);
      ctx.font = '800 44px -apple-system, "Apple SD Gothic Neo", sans-serif';
      const lw = ctx.measureText('MapWarm').width;
      this.rr(ctx, -lw / 2 - 34, -40, lw + 68, 80, 40);
      ctx.fillStyle = P.pink;
      ctx.fill();
      this.rr(ctx, -lw / 2 - 34, -40, lw + 68, 80, 40);
      ctx.strokeStyle = P.white;
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.fillStyle = P.white;
      ctx.fillText('MapWarm', 0, 2);
      ctx.restore();
      try { ctx.letterSpacing = '0px'; } catch (e) { /* noop */ }
    }

    // 내 영토 바운딩 박스를 카드 영역에 맞게 스케일·중앙 정렬
    territoryLayout(owner, area) {
      const s = MW.CONFIG.GRID;
      let c0 = s, r0 = s, c1 = -1, r1 = -1;
      for (let i = 0; i < owner.length; i++) {
        if (owner[i] !== MW.ID.PLAYER) continue;
        const c = i % s;
        const r = (i - c) / s;
        if (c < c0) c0 = c;
        if (c > c1) c1 = c;
        if (r < r0) r0 = r;
        if (r > r1) r1 = r;
      }
      if (c1 < 0) return null; // 영토 없음 (둘러싸여 전부 빼앗긴 사망)
      c0 = Math.max(0, c0 - 1);
      r0 = Math.max(0, r0 - 1);
      c1 = Math.min(s - 1, c1 + 1);
      r1 = Math.min(s - 1, r1 + 1);
      const bw = c1 - c0 + 1;
      const bh = r1 - r0 + 1;
      const cp = Math.min(area.w / bw, area.h / bh, 46);
      return {
        c0, r0, c1, r1, cp,
        ox: area.x + (area.w - bw * cp) / 2 - c0 * cp,
        oy: area.y + (area.h - bh * cp) / 2 - r0 * cp,
      };
    }

    // 선택 시: 저채도 타일을 "영토 셀들의 합집합 모양"에만 클립해서 깐다 (실루엣 밖 지도 노출 금지)
    drawMapLayer(ctx, area, layout, P, owner) {
      const s = MW.CONFIG.GRID;
      const id = MW.ID.PLAYER;
      ctx.save();
      ctx.beginPath();
      for (let r = layout.r0; r <= layout.r1; r++) {
        for (let c = layout.c0; c <= layout.c1; c++) {
          if (owner[r * s + c] !== id) continue;
          // 셀 사각형을 살짝 겹치게(+0.5) 이어붙여 하나의 실루엣 모양으로
          ctx.rect(
            layout.ox + c * layout.cp - 0.25,
            layout.oy + r * layout.cp - 0.25,
            layout.cp + 0.5,
            layout.cp + 0.5
          );
        }
      }
      ctx.clip();
      ctx.translate(area.x, area.y);
      this.game.tileMap.draw(
        ctx,
        layout.ox - area.x,
        layout.oy - area.y,
        layout.cp,
        area.w,
        area.h
      );
      ctx.translate(-area.x, -area.y);
      ctx.fillStyle = P.mapTint;
      ctx.fillRect(area.x, area.y, area.w, area.h);
      ctx.restore();
    }

    // 할프톤 도트 실루엣 — 게임 화면과 같은 규칙 (8방 이웃 비례)
    drawTerritoryDots(ctx, owner, L, color) {
      const s = MW.CONFIG.GRID;
      const id = MW.ID.PLAYER;
      const half = L.cp / 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let r = L.r0; r <= L.r1; r++) {
        for (let c = L.c0; c <= L.c1; c++) {
          if (owner[r * s + c] !== id) continue;
          let n = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (!dr && !dc) continue;
              const cc = c + dc;
              const rr2 = r + dr;
              if (cc >= 0 && rr2 >= 0 && cc < s && rr2 < s && owner[rr2 * s + cc] === id) n++;
            }
          }
          const rad = (0.14 + 0.22 * (n / 8)) * L.cp;
          const cx = L.ox + c * L.cp + half;
          const cy = L.oy + r * L.cp + half;
          ctx.moveTo(cx + rad, cy);
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }

    // 죽인 봇 종류별 1개씩, 내 아바타 근처 바닥에 쓰러진 스티커. 2번 이상이면 ×N 뱃지.
    drawKilledBots(ctx, kills, P) {
      const spots = [
        { x: 262, y: 946, rot: 1.62 },
        { x: 420, y: 964, rot: 1.38 },
      ];
      const frames = { 2: P.pink, 3: P.orange };
      let slot = 0;
      const ids = [2, 3];
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        const n = kills[id] || 0;
        if (!n || slot >= spots.length) continue;
        const sp = spots[slot++];
        this.drawAvatar(ctx, sp.x, sp.y, 132, P, {
          frame: frames[id],
          faceId: id,
          happy: false,
          fallen: true,
          rot: sp.rot,
          alpha: 0.92,
        });
        if (n > 1) this.drawKillBadge(ctx, sp.x + 52, sp.y - 56, n, P);
      }
    }

    drawKillBadge(ctx, cx, cy, n, P) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 26, 0, Math.PI * 2);
      ctx.fillStyle = P.white;
      ctx.fill();
      ctx.font = '800 26px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = P.face;
      ctx.fillText('×' + n, cx, cy + 1);
      ctx.restore();
    }

    // 아바타 스티커 (render.js 마커와 같은 레시피, 카드 스케일)
    // opts: { frame, faceId(1/2/3), happy, fallen, crown, rot, alpha }
    drawAvatar(ctx, cx, cy, S, P, opts) {
      const R = S / 2;
      ctx.save();
      ctx.translate(cx, cy);
      // 승리 = 살짝 기울임 / 패배·사망 = 훽 넘어짐
      ctx.rotate(opts.fallen ? (opts.rot != null ? opts.rot : 1.35) : -0.1);
      if (opts.alpha != null) ctx.globalAlpha = opts.alpha;

      // 꽃잎 프레임 + 중심 원
      ctx.fillStyle = opts.frame;
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const px = Math.cos(a) * R * 0.78;
        const py = Math.sin(a) * R * 0.78;
        ctx.moveTo(px + R * 0.32, py);
        ctx.arc(px, py, R * 0.32, 0, Math.PI * 2);
      }
      ctx.moveTo(R * 0.92, 0);
      ctx.arc(0, 0, R * 0.92, 0, Math.PI * 2);
      ctx.fill();

      // 흰 링 + 차콜 얼굴
      ctx.fillStyle = P.white;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = P.face;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.58, 0, Math.PI * 2);
      ctx.fill();

      // 이목구비 (게임 마커와 동일한 캐릭터별 얼굴)
      const f = R / 17;
      ctx.fillStyle = P.white;
      ctx.strokeStyle = P.white;
      ctx.lineCap = 'round';
      if (opts.faceId === 3) {
        // MOMO: 동그란 눈 + 동그란 입
        ctx.beginPath();
        ctx.arc(-4.5 * f, -2.5 * f, 2 * f, 0, Math.PI * 2);
        ctx.arc(4.5 * f, -2.5 * f, 2 * f, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 3.5 * f, 2.2 * f, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const ew = 3.5 * f;
        ctx.fillRect(-6 * f, -4.5 * f, ew, ew);
        ctx.fillRect(2.5 * f, -4.5 * f, ew, ew);
        if (opts.faceId === 2) {
          // PIKO: 일자 입
          ctx.fillRect(-3.5 * f, 3 * f, 7 * f, 1.8 * f);
        } else {
          // ME: 웃음 / 시무룩
          ctx.lineWidth = 1.8 * f;
          ctx.beginPath();
          if (opts.happy) ctx.arc(0, 1.5 * f, 4.5 * f, Math.PI * 0.18, Math.PI * 0.82);
          else ctx.arc(0, 7 * f, 4.5 * f, Math.PI * 1.18, Math.PI * 1.82);
          ctx.stroke();
        }
      }

      // 승리: 왕관 (간단한 프리미티브)
      if (opts.crown) {
        const cw = R * 0.62;
        const cyTop = -R * 1.02;
        ctx.beginPath();
        ctx.moveTo(-cw, cyTop);
        ctx.lineTo(-cw, cyTop - R * 0.34);
        ctx.lineTo(-cw * 0.5, cyTop - R * 0.12);
        ctx.lineTo(0, cyTop - R * 0.44);
        ctx.lineTo(cw * 0.5, cyTop - R * 0.12);
        ctx.lineTo(cw, cyTop - R * 0.34);
        ctx.lineTo(cw, cyTop);
        ctx.closePath();
        ctx.fillStyle = P.orange;
        ctx.fill();
        ctx.strokeStyle = P.white;
        ctx.lineWidth = 5;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
      ctx.restore();
    }

    rr(ctx, x, y, w, h, rad) {
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, rad);
      else ctx.rect(x, y, w, h);
    }

    // ---------- 공유: Web Share API → 다운로드 폴백 ----------
    share(canvas, result) {
      const game = this.game;
      canvas.toBlob((blob) => {
        if (!blob) {
          game.toast('카드 이미지를 만들 수 없어요.');
          return;
        }
        const file = new File([blob], 'mapwarm-card.png', { type: 'image/png' });
        const text = '동네 ' + result.pct.toFixed(1) + '% 정복! — MapWarm';
        if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
          navigator.share({ files: [file], title: 'MapWarm', text }).catch(() => {
            /* 사용자가 공유 시트를 닫음 — 조용히 무시 */
          });
        } else {
          // 폴백: 이미지 다운로드
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'mapwarm-card.png';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          game.toast('카드 이미지를 저장했어요.');
        }
      }, 'image/png');
    }
  }

  window.MW = window.MW || {};
  MW.ConquestCard = ConquestCard;
})();
