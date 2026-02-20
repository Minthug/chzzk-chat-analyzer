// overlay.js - injected into page (runs in MAIN world via script tag)
// YouTube 스타일 채팅량 그래프 - 재생바 위에 반투명 흰색 히스토그램

(function () {
  'use strict';

  if (window.__chzzkOverlayActive) return;
  window.__chzzkOverlayActive = true;

  // ── 상태 ────────────────────────────────────────────────────────────────────
  let windows         = [];
  let spikes          = [];
  let graphCanvas     = null;
  let markerContainer = null;
  let lastDrawHash    = '';
  let lastMarkerHash  = '';
  let animFrame       = null;

  // ── 비디오 요소 탐색 ─────────────────────────────────────────────────────────
  function getVideoEl() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    if (videos.length === 1) return videos[0];
    const playing = videos.find(v => !v.paused && v.duration > 60);
    if (playing) return playing;
    const withDuration = videos.filter(v => v.duration > 60);
    if (withDuration.length > 0)
      return withDuration.reduce((a, b) => a.duration > b.duration ? a : b);
    return videos[0];
  }

  // ── pzp 재생바 탐색 ──────────────────────────────────────────────────────────
  function findProgressArea() {
    return (
      document.querySelector('[class*="pzp-ui-progress__entire"]') ||
      document.querySelector('[class*="pzp-ui-progress"]')         ||
      document.querySelector('[class*="pzp-pc__progress"]')        ||
      null
    );
  }

  // ── 그래프 + 마커 생성 ────────────────────────────────────────────────────────
  function setupGraph() {
    const progressEl = findProgressArea();
    if (!progressEl) return false;

    if (graphCanvas && graphCanvas.isConnected) return true;

    if (getComputedStyle(progressEl).position === 'static') {
      progressEl.style.position = 'relative';
    }

    // 히스토그램 캔버스
    graphCanvas = document.createElement('canvas');
    graphCanvas.id = 'chzzk-graph-canvas';
    graphCanvas.height = 48;
    graphCanvas.style.cssText = `
      position: absolute;
      bottom: 100%;
      left: 0;
      width: 100%;
      height: 48px;
      pointer-events: none;
      z-index: 90;
    `;
    progressEl.appendChild(graphCanvas);

    // 스파이크 마커 컨테이너
    markerContainer = document.createElement('div');
    markerContainer.id = 'chzzk-spike-markers';
    markerContainer.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 99;
    `;
    progressEl.appendChild(markerContainer);

    startRenderLoop();
    return true;
  }

  // ── 렌더 루프 ────────────────────────────────────────────────────────────────
  function startRenderLoop() {
    if (animFrame) cancelAnimationFrame(animFrame);
    function loop() {
      animFrame = requestAnimationFrame(loop);
      drawGraph();
    }
    loop();
  }

  // ── 히스토그램 그리기 ─────────────────────────────────────────────────────────
  function drawGraph() {
    if (!graphCanvas || !graphCanvas.isConnected || windows.length === 0) return;

    const W = graphCanvas.clientWidth;
    if (W === 0) return;
    if (graphCanvas.width !== W) graphCanvas.width = W;
    const H = graphCanvas.height;

    const video       = getVideoEl();
    const currentTime = video ? Math.floor(video.currentTime) : -1;
    const hash        = `${windows.length}|${spikes.length}|${currentTime}`;
    if (hash === lastDrawHash) return;
    lastDrawHash = hash;

    const ctx = graphCanvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const maxCount = Math.max(...windows.map(w => w.count), 1);
    const spikeSet = new Set(spikes.map(s => s.windowIndex));
    const n        = windows.length;
    const step     = W / Math.max(n - 1, 1);

    // 각 포인트의 x, y 계산
    const pts = windows.map((w, i) => ({
      x: i * step,
      y: H - 4 - (w.count / maxCount) * (H - 8),
      isSpike: spikeSet.has(w.windowIndex),
    }));

    // ── 채우기 영역 (fill) ──────────────────────────────────────────────────
    const fillGrad = ctx.createLinearGradient(0, 0, 0, H);
    fillGrad.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
    fillGrad.addColorStop(1, 'rgba(255, 255, 255, 0.05)');

    ctx.beginPath();
    ctx.moveTo(pts[0].x, H);
    ctx.lineTo(pts[0].x, pts[0].y);

    // 부드러운 곡선 (Catmull-Rom 스타일)
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }

    ctx.lineTo(pts[pts.length - 1].x, H);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // ── 스파이크 구간 별도 채우기 (붉은빛) ──────────────────────────────────
    spikes.forEach((spike) => {
      const idx = windows.findIndex(w => w.windowIndex === spike.windowIndex);
      if (idx < 0) return;
      const x1 = (Math.max(idx - 1, 0)) * step;
      const x2 = (Math.min(idx + 1, n - 1)) * step;

      const spikeGrad = ctx.createLinearGradient(0, 0, 0, H);
      spikeGrad.addColorStop(0, 'rgba(255, 80, 80, 0.7)');
      spikeGrad.addColorStop(1, 'rgba(255, 80, 80, 0.05)');

      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, 0, x2 - x1, H);
      ctx.clip();

      ctx.beginPath();
      ctx.moveTo(pts[0].x, H);
      ctx.lineTo(pts[0].x, pts[0].y);
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(i - 1, 0)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(i + 2, pts.length - 1)];
        ctx.bezierCurveTo(
          p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
          p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
          p2.x, p2.y
        );
      }
      ctx.lineTo(pts[pts.length - 1].x, H);
      ctx.closePath();
      ctx.fillStyle = spikeGrad;
      ctx.fill();
      ctx.restore();
    });

    // ── 선 그리기 ────────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
        p2.x, p2.y
      );
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // ── 현재 재생 위치 마커 ──────────────────────────────────────────────────
    if (currentTime >= 0 && windows[0]?.startSec != null) {
      const maxSec = (windows[windows.length - 1].startSec || 0) + 30;
      if (maxSec > 0) {
        const xPos = (currentTime / maxSec) * W;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.moveTo(xPos, 0);
        ctx.lineTo(xPos, H);
        ctx.stroke();
      }
    }
  }

  // ── 재생바 스파이크 마커 ──────────────────────────────────────────────────────
  function updateMarkers() {
    if (!markerContainer || !markerContainer.isConnected) return;
    if (spikes.length === 0) return;

    const video    = getVideoEl();
    const duration = video?.duration;
    if (!duration || isNaN(duration)) return;

    const hash = `${spikes.length}|${Math.floor(duration)}`;
    if (hash === lastMarkerHash) return;
    lastMarkerHash = hash;

    markerContainer.innerHTML = '';

    spikes.forEach((spike) => {
      if (spike.startSec == null) return;
      const pct = (spike.startSec / duration) * 100;
      if (pct < 0 || pct > 100) return;

      const marker = document.createElement('div');
      marker.style.cssText = `
        position: absolute;
        left: ${pct}%;
        top: -8px;
        width: 4px;
        height: 16px;
        background: rgba(255, 90, 90, 0.9);
        transform: translateX(-50%);
        border-radius: 2px;
        cursor: pointer;
        pointer-events: all;
        z-index: 99;
      `;

      const tooltip = document.createElement('div');
      tooltip.textContent = `${spike.hms}  ${spike.count}개 (${spike.ratio ?? '?'}x)`;
      tooltip.style.cssText = `
        display: none;
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0,0,0,0.85);
        color: #fff;
        font-size: 11px;
        white-space: nowrap;
        padding: 3px 7px;
        border-radius: 4px;
        pointer-events: none;
      `;
      marker.appendChild(tooltip);
      marker.addEventListener('mouseenter', () => { tooltip.style.display = 'block'; });
      marker.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
      marker.addEventListener('click', () => {
        const v = getVideoEl();
        if (v) { v.currentTime = spike.startSec; v.play().catch(() => {}); }
      });

      markerContainer.appendChild(marker);
    });
  }

  // ── 메시지 수신 ───────────────────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'chzzk-analyzer-bg') return;

    if (msg.type === 'STATS_UPDATE') {
      windows = msg.windows || [];
      spikes  = msg.spikes  || [];
      if (!setupGraph()) setTimeout(setupGraph, 1000);
      updateMarkers();
    }

    if (msg.type === 'SPIKE_UPDATE') {
      lastDrawHash   = '';
      lastMarkerHash = '';
    }
  });

  // ── 마운트 ────────────────────────────────────────────────────────────────────
  function tryMount() {
    if (setupGraph()) return;
    setTimeout(tryMount, 1000);
  }
  tryMount();

  // SPA 네비게이션 대응
  let lastPath = location.pathname;
  new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (graphCanvas)     { graphCanvas.remove();     graphCanvas = null; }
      if (markerContainer) { markerContainer.remove(); markerContainer = null; }
      if (animFrame)       { cancelAnimationFrame(animFrame); animFrame = null; }
      window.__chzzkOverlayActive = false;
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
