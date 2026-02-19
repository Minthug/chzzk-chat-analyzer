// content.js - ISOLATED world
// Coordinator: receives postMessage from MAIN world, forwards to background

(function () {
  'use strict';

  // ── Page type detection ───────────────────────────────────────────────────
  function getPageType() {
    const path = window.location.pathname;
    if (path.startsWith('/live/')) return 'live';
    if (path.startsWith('/video/')) return 'vod';
    return 'unknown';
  }

  function getVideoElement() {
    return (
      document.querySelector('video') ||
      document.querySelector('.webplayer-internal-video') ||
      null
    );
  }

  // ── Channel / video ID extraction ────────────────────────────────────────
  function getPageId() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    return parts[1] || null; // live/{id} or video/{id}
  }

  // ── Message count helper ──────────────────────────────────────────────────
  function countMessages(payload) {
    if (!payload) return 1;
    if (Array.isArray(payload.messageList)) return payload.messageList.length;
    if (Array.isArray(payload.chatList)) return payload.chatList.length;
    return 1;
  }

  // ── Inject overlay script when video page is detected ────────────────────
  let overlayInjected = false;
  function maybeInjectOverlay() {
    if (overlayInjected) return;
    const type = getPageType();
    if (type === 'unknown') return;

    overlayInjected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/content/overlay.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  // ── postMessage listener (from MAIN world) ────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'chzzk-analyzer-ws') return;

    if (msg.type === 'WS_OPEN') {
      maybeInjectOverlay();
      chrome.runtime.sendMessage({
        type: 'WS_OPEN',
        pageType: getPageType(),
        pageId: getPageId(),
        url: msg.url,
        timestamp: msg.timestamp,
      });
      return;
    }

    if (msg.type === 'WS_CLOSE') {
      chrome.runtime.sendMessage({
        type: 'WS_CLOSE',
        pageId: getPageId(),
        timestamp: msg.timestamp,
      });
      return;
    }

    if (msg.type === 'CHAT_MESSAGE') {
      const pageType = getPageType();
      let videoTimestamp = null;

      if (pageType === 'vod') {
        const video = getVideoElement();
        videoTimestamp = video ? video.currentTime : null;
      }

      const count = countMessages(msg.payload);

      chrome.runtime.sendMessage({
        type: 'CHAT_MESSAGE',
        pageType,
        pageId: getPageId(),
        count,
        videoTimestamp, // seconds from start (VOD) or null (live)
        wallTimestamp: msg.timestamp, // ms epoch
      });
    }
  });

  // ── Listen for messages from background (e.g. spike data for overlay) ────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SPIKE_UPDATE' || msg.type === 'STATS_UPDATE') {
      // Forward to overlay via postMessage
      window.postMessage(
        { source: 'chzzk-analyzer-bg', ...msg },
        '*'
      );
    }
  });

  // ── Detect page navigations (SPA) ────────────────────────────────────────
  let lastPath = window.location.pathname;
  const observer = new MutationObserver(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      overlayInjected = false;
      chrome.runtime.sendMessage({
        type: 'PAGE_NAVIGATE',
        pageType: getPageType(),
        pageId: getPageId(),
        timestamp: Date.now(),
      });
      setTimeout(maybeInjectOverlay, 1500);
    }
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Initial check
  setTimeout(maybeInjectOverlay, 1000);
})();
