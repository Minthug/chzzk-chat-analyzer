// content.js - ISOLATED world
// DOM MutationObserver 방식으로 채팅 수집 (WebSocket 불필요)

(function () {
  'use strict';

  // 개발 모드에서만 로그 출력 (배포 시 false로 변경)
  const DEBUG = false;
  const LOG = (...args) => { if (DEBUG) console.log('[chzzk-analyzer]', ...args); };
  const INFO = (...args) => console.log('[chzzk-analyzer]', ...args);
  INFO('content script loaded', window.location.pathname);

  // ── 선택자 (치지직 클래스명) ──────────────────────────────────────────────
  const SELECTORS = {
    vodChatList: [
      '[class*="vod_chatting_list"]',
      '[class*="vod_chatting_content"]',
    ],
    liveChatList: [
      '[class*="live_chatting_list"]',
      '[class*="live_chatting_content"]',
    ],
    chatItem: [
      '[class*="vod_chatting_item"]',
      '[class*="live_chatting_item"]',
      '[class*="chatting_item"]',
    ],
  };

  // ── 페이지 타입 ───────────────────────────────────────────────────────────
  function getPageType() {
    const path = window.location.pathname;
    if (path.startsWith('/live/')) return 'live';
    if (path.startsWith('/video/')) return 'vod';
    return 'unknown';
  }

  function getPageId() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    return parts[1] || null;
  }

  function getVideoEl() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    if (videos.length === 1) return videos[0];

    // 재생 중인 영상 우선
    const playing = videos.find(v => !v.paused && v.duration > 60);
    if (playing) return playing;

    // duration이 가장 긴 영상 = 본 VOD
    const withDuration = videos.filter(v => v.duration > 60);
    if (withDuration.length > 0) {
      return withDuration.reduce((a, b) => a.duration > b.duration ? a : b);
    }

    return videos[0];
  }

  // ── 채팅 컨테이너 탐색 ───────────────────────────────────────────────────
  function findChatContainer() {
    const pageType = getPageType();
    const candidates =
      pageType === 'vod'
        ? [...SELECTORS.vodChatList, ...SELECTORS.liveChatList]
        : [...SELECTORS.liveChatList, ...SELECTORS.vodChatList];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function isChatItem(node) {
    if (node.nodeType !== 1) return false;
    return SELECTORS.chatItem.some((sel) => node.matches(sel));
  }

  // ── 안전한 메시지 전송 헬퍼 ──────────────────────────────────────────────
  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (_) {
      // 확장 프로그램 재로드 시 context 무효화 → 조용히 무시
    }
  }

  // ── 메시지 전송 ───────────────────────────────────────────────────────────
  function sendChatEvent(count) {
    const pageType = getPageType();
    const pageId = getPageId();
    if (!pageId) return;

    let videoTimestamp = null;
    if (pageType === 'vod') {
      const video = getVideoEl();
      videoTimestamp = video ? video.currentTime : null;
    }

    safeSend({
      type: 'CHAT_MESSAGE',
      pageType,
      pageId,
      count,
      videoTimestamp,
      wallTimestamp: Date.now(),
    });
  }

  // ── MutationObserver 설정 ─────────────────────────────────────────────────
  let chatObserver = null;
  let observedContainer = null;
  let pendingCount = 0;
  let flushTimer = null;

  function scheduleSend(count) {
    pendingCount += count;
    LOG('chat detected, pending:', pendingCount);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (pendingCount > 0) {
        sendChatEvent(pendingCount);
        pendingCount = 0;
      }
    }, 200);
  }

  function startObserving(container) {
    if (chatObserver) chatObserver.disconnect();
    observedContainer = container;

    chatObserver = new MutationObserver((mutations) => {
      let newChats = 0;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (isChatItem(node)) {
            newChats++;
          } else if (node.nodeType === 1) {
            newChats += node.querySelectorAll(
              SELECTORS.chatItem.join(',')
            ).length;
          }
        }
      }
      if (newChats > 0) scheduleSend(newChats);
    });

    chatObserver.observe(container, { childList: true, subtree: true });
    INFO('DOM observer started on', container.className);

    safeSend({
      type: 'WS_OPEN',
      pageType: getPageType(),
      pageId: getPageId(),
      url: 'dom-observer',
      timestamp: Date.now(),
    });
  }

  // ── 컨테이너 detach 감지 & 재연결 ────────────────────────────────────────
  // React가 DOM을 재마운트하면 이전 container가 detach됨 → 재연결 필요
  setInterval(() => {
    if (!observedContainer) return;
    if (!observedContainer.isConnected) {
      INFO('container detached! reconnecting...');
      observedContainer = null;
      tryMount();
    }
  }, 2000);

  // ── 컨테이너 탐색 & 재시도 ────────────────────────────────────────────────
  let mountTimer = null;

  function tryMount() {
    const container = findChatContainer();
    LOG('tryMount - container:', container ? container.className : 'NOT FOUND');
    if (container) {
      startObserving(container);
      injectOverlay();
      return;
    }
    mountTimer = setTimeout(tryMount, 1000);
  }

  // ── 오버레이 주입 ─────────────────────────────────────────────────────────
  let overlayInjected = false;
  function injectOverlay() {
    if (overlayInjected) return;
    overlayInjected = true;

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/content/overlay.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  // ── background / popup 메시지 처리 ───────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SPIKE_UPDATE' || msg.type === 'STATS_UPDATE') {
      window.postMessage({ source: 'chzzk-analyzer-bg', ...msg }, '*');
    }

    if (msg.type === 'SEEK_TO') {
      const video = getVideoEl();
      if (video && !isNaN(msg.sec)) {
        video.currentTime = msg.sec;
        video.play().catch(() => {});
        INFO('seeked to', msg.sec);
      }
    }
  });

  // ── SPA 네비게이션 대응 ───────────────────────────────────────────────────
  let lastPath = window.location.pathname;
  new MutationObserver(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      overlayInjected = false;
      if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
      if (mountTimer) { clearTimeout(mountTimer); mountTimer = null; }
      observedContainer = null;
      safeSend({
        type: 'PAGE_NAVIGATE',
        pageType: getPageType(),
        pageId: getPageId(),
        timestamp: Date.now(),
      });
      setTimeout(tryMount, 1500);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── 탭 가시성 변화 감지 (백그라운드 탭 대응) ─────────────────────────────
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // 탭이 숨겨짐 → WebSocket 폴백 모드 활성화 요청
      INFO('tab hidden - switching to WebSocket fallback');
      window.postMessage({ source: 'chzzk-analyzer-content', type: 'TAB_HIDDEN' }, '*');
    } else {
      // 탭이 다시 보임 → DOM Observer 재확인
      INFO('tab visible - resuming DOM observer');
      window.postMessage({ source: 'chzzk-analyzer-content', type: 'TAB_VISIBLE' }, '*');
      // 컨테이너가 detach 됐을 수 있으므로 재점검
      if (!observedContainer || !observedContainer.isConnected) {
        tryMount();
      }
    }
  });

  // ── WebSocket 폴백에서 오는 채팅 수신 ────────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'chzzk-analyzer-ws') return;

    if (msg.type === 'CHAT_MESSAGE') {
      // 탭이 숨겨진 상태에서만 WebSocket 카운트 사용 (DOM과 중복 방지)
      if (document.hidden) {
        scheduleSend(msg.count || 1);
      }
    }
  });

  // ── 시작 ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryMount, 500));
  } else {
    setTimeout(tryMount, 500);
  }
})();
