// page-inject.js - MAIN world
// WebSocket monkey-patch: 탭이 숨겨졌을 때 폴백으로 채팅 수집

(function () {
  'use strict';

  const OriginalWebSocket = window.WebSocket;

  // content.js에서 TAB_HIDDEN/TAB_VISIBLE 신호를 받아 폴백 모드 관리
  let tabHidden = document.hidden;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'chzzk-analyzer-content') return;
    if (msg.type === 'TAB_HIDDEN') tabHidden = true;
    if (msg.type === 'TAB_VISIBLE') tabHidden = false;
  });

  function countMessages(payload) {
    if (!payload) return 1;
    if (Array.isArray(payload.messageList)) return payload.messageList.length;
    if (Array.isArray(payload.chatList)) return payload.chatList.length;
    return 1;
  }

  function PatchedWebSocket(url, protocols) {
    const ws = protocols
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);

    const isChat = typeof url === 'string' && url.includes('nchat.naver.com');

    if (isChat) {
      ws.addEventListener('message', (event) => {
        // 탭이 숨겨진 경우에만 WebSocket 폴백 활성화
        if (!tabHidden) return;

        try {
          const raw = event.data;
          if (typeof raw !== 'string' || !raw.startsWith('42')) return;

          const parsed = JSON.parse(raw.slice(2));
          const [eventName, payload] = parsed;

          if (
            eventName === 'chat' ||
            eventName === 'CHAT' ||
            (payload && (payload.messageList || payload.chatList))
          ) {
            window.postMessage(
              {
                source: 'chzzk-analyzer-ws',
                type: 'CHAT_MESSAGE',
                count: countMessages(payload),
                timestamp: Date.now(),
              },
              '*'
            );
          }
        } catch (_) {}
      });

      ws.addEventListener('open', () => {
        window.postMessage(
          { source: 'chzzk-analyzer-ws', type: 'WS_OPEN', url, timestamp: Date.now() },
          '*'
        );
      });

      ws.addEventListener('close', () => {
        window.postMessage(
          { source: 'chzzk-analyzer-ws', type: 'WS_CLOSE', url, timestamp: Date.now() },
          '*'
        );
      });
    }

    return ws;
  }

  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;

  window.WebSocket = PatchedWebSocket;
})();
