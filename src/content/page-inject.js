// page-inject.js - MAIN world
// WebSocket monkey-patch to intercept chzzk chat messages

(function () {
  'use strict';

  const OriginalWebSocket = window.WebSocket;

  function PatchedWebSocket(url, protocols) {
    const ws = protocols
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);

    const isChat = typeof url === 'string' && url.includes('nchat.naver.com');

    if (isChat) {
      ws.addEventListener('message', (event) => {
        try {
          const raw = event.data;
          // Socket.IO frames start with a numeric code
          // Chat messages come as "42[...]" (event) frames
          if (typeof raw === 'string' && raw.startsWith('42')) {
            const jsonStr = raw.slice(2); // strip "42"
            const parsed = JSON.parse(jsonStr);
            // parsed = [eventName, payload]
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
                  eventName,
                  payload,
                  timestamp: Date.now(),
                },
                '*'
              );
            }
          }
        } catch (_) {
          // ignore parse errors
        }
      });

      ws.addEventListener('open', () => {
        window.postMessage(
          {
            source: 'chzzk-analyzer-ws',
            type: 'WS_OPEN',
            url,
            timestamp: Date.now(),
          },
          '*'
        );
      });

      ws.addEventListener('close', () => {
        window.postMessage(
          {
            source: 'chzzk-analyzer-ws',
            type: 'WS_CLOSE',
            url,
            timestamp: Date.now(),
          },
          '*'
        );
      });
    }

    return ws;
  }

  // Copy static properties
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;

  window.WebSocket = PatchedWebSocket;
})();
