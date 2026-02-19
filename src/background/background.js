// background.js - Service Worker
// Data aggregation, spike detection, storage

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const WINDOW_SIZE_SEC = 30;   // aggregation window in seconds
const LAG_WINDOWS     = 10;   // number of past windows used for baseline
const DEFAULT_Z_THRESH = 3.0; // Z-Score threshold for spike
const STORAGE_KEY     = 'chzzk_analyzer_session';

// ── In-memory state ──────────────────────────────────────────────────────────
// keyed by pageId
const sessions = {};

function getSession(pageId) {
  if (!sessions[pageId]) {
    sessions[pageId] = {
      pageId,
      pageType: 'unknown',
      startedAt: Date.now(),
      // Array of { windowIndex, startSec, count }
      windows: [],
      // Current accumulating window
      currentWindowIndex: 0,
      currentWindowCount: 0,
      currentWindowStartSec: null, // for VOD; null for live
      currentWindowStartMs: null,  // for live
      // Detected spikes
      spikes: [],
      totalMessages: 0,
      channelName: null,
    };
  }
  return sessions[pageId];
}

// ── Z-Score spike detection ──────────────────────────────────────────────────
function detectSpike(windows, zThreshold = DEFAULT_Z_THRESH) {
  if (windows.length < 2) return { isSpike: false, zScore: 0, mean: 0, std: 0 };

  const lag = Math.min(LAG_WINDOWS, windows.length - 1);
  const baseline = windows.slice(-lag - 1, -1); // last LAG_WINDOWS (excluding current)

  const counts = baseline.map((w) => w.count);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((s, c) => s + (c - mean) ** 2, 0) / counts.length;
  const std = Math.sqrt(variance);

  const current = windows[windows.length - 1].count;
  const zScore = std > 0 ? (current - mean) / std : 0;

  return {
    isSpike: zScore >= zThreshold,
    zScore: Math.round(zScore * 100) / 100,
    mean: Math.round(mean * 10) / 10,
    std: Math.round(std * 10) / 10,
    count: current,
  };
}

// ── Convert seconds to HH:MM:SS ──────────────────────────────────────────────
function secToHMS(sec) {
  if (sec == null) return '--:--:--';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [h, m, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

// ── Flush current window into windows array ───────────────────────────────────
function flushWindow(session) {
  if (session.currentWindowCount === 0) {
    // advance empty window anyway
    session.currentWindowIndex++;
    session.currentWindowCount = 0;
    return;
  }

  const windowEntry = {
    windowIndex: session.currentWindowIndex,
    startSec: session.pageType === 'vod'
      ? session.currentWindowStartSec
      : null,
    startMs: session.pageType === 'live'
      ? session.currentWindowStartMs
      : null,
    count: session.currentWindowCount,
    hms: session.pageType === 'vod'
      ? secToHMS(session.currentWindowStartSec)
      : new Date(session.currentWindowStartMs).toLocaleTimeString('ko-KR'),
  };

  session.windows.push(windowEntry);

  // Spike detection
  const result = detectSpike(session.windows);
  if (result.isSpike) {
    const spike = {
      ...windowEntry,
      zScore: result.zScore,
      mean: result.mean,
      std: result.std,
      ratio: result.mean > 0
        ? Math.round((result.count / result.mean) * 100) / 100
        : null,
    };
    session.spikes.push(spike);
    console.log('[chzzk-analyzer] Spike detected:', spike);

    // 뱃지 업데이트
    updateBadge(session.spikes.length);

    // Notify content scripts in this tab
    notifyTabs(session.pageId, { type: 'SPIKE_UPDATE', spike });
  }

  // Notify stats update
  notifyTabs(session.pageId, {
    type: 'STATS_UPDATE',
    windows: session.windows.slice(-50), // last 50 windows
    spikes: session.spikes,
    totalMessages: session.totalMessages,
  });

  // Advance
  session.currentWindowIndex++;
  session.currentWindowCount = 0;
}

// ── 뱃지 업데이트 ────────────────────────────────────────────────────────────
function updateBadge(spikeCount) {
  const text = spikeCount > 0 ? String(spikeCount) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
}

// ── Notify all tabs on this pageId ───────────────────────────────────────────
async function notifyTabs(pageId, message) {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.chzzk.naver.com/*' });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch (_) {}
}

// ── Handle incoming chat message ──────────────────────────────────────────────
function handleChatMessage(msg) {
  const session = getSession(msg.pageId);
  session.pageType = msg.pageType;
  session.totalMessages += msg.count;

  if (msg.pageType === 'vod') {
    const vt = msg.videoTimestamp ?? 0;

    // Initialize window start
    if (session.currentWindowStartSec === null) {
      session.currentWindowStartSec = Math.floor(vt / WINDOW_SIZE_SEC) * WINDOW_SIZE_SEC;
    }

    const expectedWindowIdx = Math.floor(vt / WINDOW_SIZE_SEC);

    // If jumped past one or more windows (fast forward), flush them
    while (session.currentWindowIndex < expectedWindowIdx) {
      flushWindow(session);
      session.currentWindowStartSec = session.currentWindowIndex * WINDOW_SIZE_SEC;
    }

    session.currentWindowCount += msg.count;
  } else {
    // Live: wall-clock based
    const now = msg.wallTimestamp;

    if (session.currentWindowStartMs === null) {
      session.currentWindowStartMs = now;
    }

    const elapsed = now - session.currentWindowStartMs;

    if (elapsed >= WINDOW_SIZE_SEC * 1000) {
      flushWindow(session);
      session.currentWindowStartMs = now;
    }

    session.currentWindowCount += msg.count;
  }

  // Persist to session storage
  persistSession(session);
}

// ── Persist session to chrome.storage.session ─────────────────────────────────
let persistTimer = null;
function persistSession(session) {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const existing = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY] || {};
      existing[session.pageId] = {
        pageId: session.pageId,
        pageType: session.pageType,
        startedAt: session.startedAt,
        windows: session.windows.slice(-200),
        spikes: session.spikes,
        totalMessages: session.totalMessages,
      };
      await chrome.storage.session.set({ [STORAGE_KEY]: existing });
    } catch (e) {
      console.error('[chzzk-analyzer] Storage error:', e);
    }
  }, 500);
}

// ── Get settings ─────────────────────────────────────────────────────────────
async function getSettings() {
  const result = await chrome.storage.sync.get({
    zThreshold: DEFAULT_Z_THRESH,
    windowSize: WINDOW_SIZE_SEC,
  });
  return result;
}

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'WS_OPEN':
      console.log('[chzzk-analyzer] WebSocket opened:', msg.url, 'pageType:', msg.pageType);
      getSession(msg.pageId).pageType = msg.pageType;
      break;

    case 'WS_CLOSE':
      console.log('[chzzk-analyzer] WebSocket closed for:', msg.pageId);
      {
        const session = sessions[msg.pageId];
        if (session) flushWindow(session);
      }
      break;

    case 'CHAT_MESSAGE':
      handleChatMessage(msg);
      break;

    case 'PAGE_NAVIGATE':
      console.log('[chzzk-analyzer] Navigation to:', msg.pageType, msg.pageId);
      break;

    case 'GET_SESSION_DATA': {
      chrome.storage.session.get(STORAGE_KEY).then((result) => {
        const data = (result[STORAGE_KEY] || {})[msg.pageId] || null;
        sendResponse({ data });
      });
      return true; // async response
    }

    case 'GET_ALL_SESSIONS': {
      chrome.storage.session.get(STORAGE_KEY).then((result) => {
        sendResponse({ data: result[STORAGE_KEY] || {} });
      });
      return true;
    }

    case 'CLEAR_SESSION': {
      delete sessions[msg.pageId];
      chrome.storage.session.get(STORAGE_KEY).then(async (result) => {
        const existing = result[STORAGE_KEY] || {};
        delete existing[msg.pageId];
        await chrome.storage.session.set({ [STORAGE_KEY]: existing });
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'GET_SETTINGS': {
      getSettings().then((settings) => sendResponse({ settings }));
      return true;
    }

    case 'SAVE_SETTINGS': {
      chrome.storage.sync.set(msg.settings).then(() => sendResponse({ ok: true }));
      return true;
    }
  }
});
