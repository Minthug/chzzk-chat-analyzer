// content.js - ISOLATED world
// DOM MutationObserver 방식으로 채팅 수집 (WebSocket 불필요)

(function () {
  'use strict';

  // ── 선택자 (치지직 클래스명) ──────────────────────────────────────────────
  const SELECTORS = {
    // VOD 채팅 컨테이너 후보들
    vodChatList: [
      '[class*="vod_chatting_list"]',
      '[class*="vod_chatting_content"]',
    ],
    // 라이브 채팅 컨테이너 후보들
    liveChatList: [
      '[class*="live_chatting_list"]',
      '[class*="live_chatting_content"]',
    ],
    // 채팅 아이템 후보들
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
    return document.querySelector('video');
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

  // 추가된 노드가 채팅 아이템인지 확인
  function isChatItem(node) {
    if (node.nodeType !== 1) return false;
    return SELECTORS.chatItem.some((sel) => node.matches(sel));
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

    chrome.runtime.sendMessage({
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
  let pendingCount = 0;
  let flushTimer = null;

  // 짧은 시간 안에 여러 메시지가 한꺼번에 오는 경우 배치 처리
  function scheduleSend(count) {
    pendingCount += count;
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

    chatObserver = new MutationObserver((mutations) => {
      let newChats = 0;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (isChatItem(node)) {
            newChats++;
          } else if (node.nodeType === 1) {
            // 컨테이너 내부에 채팅 아이템이 있을 수 있음
            newChats += node.querySelectorAll(
              SELECTORS.chatItem.join(',')
            ).length;
          }
        }
      }
      if (newChats > 0) scheduleSend(newChats);
    });

    chatObserver.observe(container, { childList: true, subtree: true });
    console.log('[chzzk-analyzer] DOM observer started on', container.className);

    // 초기 알림
    chrome.runtime.sendMessage({
      type: 'WS_OPEN',
      pageType: getPageType(),
      pageId: getPageId(),
      url: 'dom-observer',
      timestamp: Date.now(),
    });
  }

  // ── 컨테이너 탐색 & 재시도 ────────────────────────────────────────────────
  let mountTimer = null;

  function tryMount() {
    const container = findChatContainer();
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

  // ── background → overlay 브릿지 ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SPIKE_UPDATE' || msg.type === 'STATS_UPDATE') {
      window.postMessage({ source: 'chzzk-analyzer-bg', ...msg }, '*');
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
      chrome.runtime.sendMessage({
        type: 'PAGE_NAVIGATE',
        pageType: getPageType(),
        pageId: getPageId(),
        timestamp: Date.now(),
      });
      setTimeout(tryMount, 1500);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── 시작 ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryMount, 500));
  } else {
    setTimeout(tryMount, 500);
  }
})();
