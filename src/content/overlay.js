// overlay.js - injected into page (runs in MAIN world via script tag)
// Draws chat histogram overlay beneath the video player

(function () {
  'use strict';

  // Avoid double-injection
  if (window.__chzzkOverlayActive) return;
  window.__chzzkOverlayActive = true;

  // ── State ──────────────────────────────────────────────────────────────────
  let windows = [];
  let spikes = [];
  let canvas = null;
  let panel = null;
  let container = null;
  let animFrame = null;
  let lastDrawHash = '';

  // ── 시크바 마커 상태 ────────────────────────────────────────────────────────
  let markerContainer = null;
  let seekBarEl = null;
  let lastMarkerHash = '';

  // ── Selectors for chzzk player ─────────────────────────────────────────────
  const PLAYER_SELECTORS = [
    '.webplayer-internal-view',
    '.vod-player-wrap',
    '.live-player-wrap',
    '[class*="PlayerWrap"]',
    '[class*="playerWrap"]',
    '.player_area',
  ];

  function findPlayerContainer() {
    for (const sel of PLAYER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function getVideoEl() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    if (videos.length === 1) return videos[0];

    const playing = videos.find(v => !v.paused && v.duration > 60);
    if (playing) return playing;

    const withDuration = videos.filter(v => v.duration > 60);
    if (withDuration.length > 0) {
      return withDuration.reduce((a, b) => a.duration > b.duration ? a : b);
    }

    return videos[0];
  }

  // ── Create overlay elements ────────────────────────────────────────────────
  function createOverlay(playerEl) {
    // Wrapper
    container = document.createElement('div');
    container.id = 'chzzk-analyzer-overlay';
    container.style.cssText = `
      position: relative;
      width: 100%;
      background: #0d0d0d;
      border-top: 1px solid #333;
      user-select: none;
    `;

    // Canvas
    canvas = document.createElement('canvas');
    canvas.style.cssText = `
      display: block;
      width: 100%;
      height: 72px;
      cursor: pointer;
    `;
    canvas.height = 72;

    // Spike panel
    panel = document.createElement('div');
    panel.id = 'chzzk-analyzer-panel';
    panel.style.cssText = `
      display: none;
      max-height: 180px;
      overflow-y: auto;
      padding: 6px 10px;
      font: 12px/1.5 monospace;
      color: #ccc;
      background: #111;
      border-top: 1px solid #333;
    `;

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = '📊 편집 포인트';
    toggleBtn.style.cssText = `
      position: absolute;
      top: 4px;
      right: 8px;
      padding: 2px 8px;
      font-size: 11px;
      background: #1a1a2e;
      color: #aaa;
      border: 1px solid #444;
      border-radius: 4px;
      cursor: pointer;
      z-index: 10;
    `;
    toggleBtn.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    container.appendChild(canvas);
    container.appendChild(toggleBtn);
    container.appendChild(panel);

    // Insert after player
    playerEl.parentNode.insertBefore(container, playerEl.nextSibling);

    // Canvas click → seek
    canvas.addEventListener('click', (e) => {
      if (windows.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const maxSec = windows[windows.length - 1].startSec +
        (windows[0].startSec != null ? 30 : 0);
      if (maxSec <= 0) return;

      const targetSec = ratio * maxSec;
      const video = getVideoEl();
      if (video) video.currentTime = targetSec;
    });

    startRenderLoop();
  }

  // ── Render loop ────────────────────────────────────────────────────────────
  function startRenderLoop() {
    function loop() {
      animFrame = requestAnimationFrame(loop);
      draw();
    }
    loop();
  }

  function draw() {
    if (!canvas || windows.length === 0) return;

    // Sync canvas pixel width
    const displayW = canvas.clientWidth;
    if (canvas.width !== displayW) canvas.width = displayW;
    const W = canvas.width;
    const H = canvas.height;

    // Quick hash to skip redundant redraws
    const video = getVideoEl();
    const currentTime = video ? Math.floor(video.currentTime) : -1;
    const hash = `${windows.length}|${spikes.length}|${currentTime}`;
    if (hash === lastDrawHash) return;
    lastDrawHash = hash;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, W, H);

    if (windows.length === 0) return;

    const maxCount = Math.max(...windows.map((w) => w.count), 1);
    const spikeSet = new Set(spikes.map((s) => s.windowIndex));

    const barW = Math.max(1, W / windows.length);

    windows.forEach((w, i) => {
      const barH = Math.max(1, (w.count / maxCount) * (H - 12));
      const x = i * barW;
      const y = H - barH;

      ctx.fillStyle = spikeSet.has(w.windowIndex) ? '#e74c3c' : '#27ae60';
      ctx.fillRect(x, y, barW - 1, barH);
    });

    // Current time marker (VOD only)
    if (currentTime >= 0 && windows[0]?.startSec != null) {
      const maxSec = (windows[windows.length - 1].startSec || 0) + 30;
      if (maxSec > 0) {
        const xPos = (currentTime / maxSec) * W;
        ctx.strokeStyle = '#f1c40f';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(xPos, 0);
        ctx.lineTo(xPos, H);
        ctx.stroke();
      }
    }

    // Label
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.fillText('채팅량', 4, 11);
  }

  // ── 시크바 마커 ────────────────────────────────────────────────────────────
  function findSeekBar() {
    // pzp-ui-progress__entire-background: 프로그레스바 전체 배경 영역
    return (
      document.querySelector('[class*="pzp-ui-progress__entire"]') ||
      document.querySelector('[class*="pzp-ui-progress"]') ||
      document.querySelector('[class*="pzp-pc__progress"]') ||
      null
    );
  }

  function setupSeekBarMarkers() {
    const seekBar = findSeekBar();
    if (!seekBar) return false;

    // 이미 세팅됐고 DOM에 연결된 경우 재사용
    if (markerContainer && markerContainer.isConnected) return true;

    seekBarEl = seekBar;
    if (getComputedStyle(seekBar).position === 'static') {
      seekBar.style.position = 'relative';
    }

    markerContainer = document.createElement('div');
    markerContainer.id = 'chzzk-spike-markers';
    markerContainer.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 99;
    `;
    seekBar.appendChild(markerContainer);
    return true;
  }

  function updateSeekBarMarkers() {
    if (spikes.length === 0) return;

    const video = getVideoEl();
    const duration = video ? video.duration : 0;
    if (!duration || isNaN(duration)) return;

    // 변경 없으면 스킵
    const hash = `${spikes.length}|${Math.floor(duration)}`;
    if (hash === lastMarkerHash && markerContainer?.isConnected) return;
    lastMarkerHash = hash;

    if (!setupSeekBarMarkers()) return;

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
        background: #e74c3c;
        transform: translateX(-50%);
        border-radius: 2px;
        opacity: 0.9;
        cursor: pointer;
        pointer-events: all;
        z-index: 99;
      `;

      // 툴팁
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
        if (video) { video.currentTime = spike.startSec; video.play().catch(() => {}); }
      });

      markerContainer.appendChild(marker);
    });
  }

  // ── Update spike panel ─────────────────────────────────────────────────────
  function updatePanel() {
    if (!panel) return;
    if (spikes.length === 0) {
      panel.innerHTML = '<span style="color:#666">감지된 급증 구간 없음</span>';
      return;
    }
    panel.innerHTML = spikes
      .map(
        (s) =>
          `<div style="margin-bottom:4px; padding:3px 0; border-bottom:1px solid #222; cursor:pointer"
               data-sec="${s.startSec ?? ''}"
               data-ms="${s.startMs ?? ''}">
            <span style="color:#e74c3c">▲ ${s.hms}</span>
            &nbsp; ${s.count}개/30s &nbsp;
            <span style="color:#888">(평균대비 ${s.ratio ? s.ratio + 'x' : '?'} | Z=${s.zScore})</span>
          </div>`
      )
      .join('');

    panel.querySelectorAll('[data-sec]').forEach((el) => {
      el.addEventListener('click', () => {
        const sec = parseFloat(el.dataset.sec);
        const video = getVideoEl();
        if (video && !isNaN(sec)) video.currentTime = sec;
      });
    });
  }

  // ── Listen for messages from content.js ───────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'chzzk-analyzer-bg') return;

    if (msg.type === 'STATS_UPDATE') {
      windows = msg.windows || [];
      spikes = msg.spikes || [];
      updatePanel();
      updateSeekBarMarkers();
    }

    if (msg.type === 'SPIKE_UPDATE') {
      lastDrawHash = '';
      lastMarkerHash = ''; // 마커도 강제 갱신
    }
  });

  // ── Mount when player appears ──────────────────────────────────────────────
  function tryMount() {
    if (container) return; // already mounted
    const player = findPlayerContainer();
    if (player) {
      createOverlay(player);
      return;
    }
    // Retry
    setTimeout(tryMount, 1000);
  }

  tryMount();

  // Handle SPA navigations
  let lastPath = location.pathname;
  const navObserver = new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      // Reset
      if (container) {
        container.remove();
        container = null;
        canvas = null;
        panel = null;
      }
      if (animFrame) cancelAnimationFrame(animFrame);
      window.__chzzkOverlayActive = false;
      navObserver.disconnect();
    }
  });
  navObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
