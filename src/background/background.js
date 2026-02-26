// background.js - Service Worker
// Data aggregation, spike detection, storage

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
let WINDOW_SIZE_SEC  = 30;    // 팝업 설정에서 로드됨
let Z_THRESH         = 3.0;   // 팝업 설정에서 로드됨
let SAVE_THUMBNAIL   = true;  // 썸네일 자동 캡처 여부
let KEYWORDS         = [];    // 키워드 감지 목록
const LAG_WINDOWS    = 10;
const DEFAULT_Z_THRESH  = 3.0;
const STORAGE_KEY    = 'chzzk_analyzer_session';

// 서비스 워커 시작 시 사용자 설정 로드
chrome.storage.sync.get({ zThreshold: 3.0, windowSize: 30, saveThumbnail: true, keywords: [] }, (s) => {
  Z_THRESH        = s.zThreshold;
  WINDOW_SIZE_SEC = s.windowSize;
  SAVE_THUMBNAIL  = s.saveThumbnail ?? true;
  KEYWORDS        = s.keywords || [];
  console.log('[chzzk-analyzer] Settings loaded:', { Z_THRESH, WINDOW_SIZE_SEC, SAVE_THUMBNAIL, KEYWORDS });
});

// ── In-memory state ──────────────────────────────────────────────────────────
// keyed by pageId
const sessions = {};

// tabId → pageId 매핑 (페이지 이동 감지용)
const tabPageMap = {};

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
      liveTitle: null,
      // Keyword spikes
      keywordSpikes: [],
      keywordState: {},  // { [keyword]: { currentCount, currentWindowIndex, currentWindowStartSec, currentWindowStartMs, windows[] } }
    };
  }
  return sessions[pageId];
}

// ── Z-Score spike detection ──────────────────────────────────────────────────
function detectSpike(windows, zThreshold = Z_THRESH) {
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
    keywordSpikes: session.keywordSpikes,
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

// ── 키워드 상태 초기화 ────────────────────────────────────────────────────────
function initKeywordState(session, keyword) {
  if (!session.keywordState[keyword]) {
    session.keywordState[keyword] = {
      currentCount:          0,
      currentWindowIndex:    0,
      currentWindowStartSec: null,
      currentWindowStartMs:  null,
      windows:               [],
    };
  }
  return session.keywordState[keyword];
}

// ── 키워드 윈도우 플러시 ──────────────────────────────────────────────────────
function flushKeywordWindow(session, keyword) {
  const ks = session.keywordState[keyword];
  if (!ks) return;

  if (ks.currentCount === 0) {
    ks.currentWindowIndex++;
    return;
  }

  const windowEntry = {
    windowIndex: ks.currentWindowIndex,
    startSec: session.pageType === 'vod'  ? ks.currentWindowStartSec : null,
    startMs:  session.pageType === 'live' ? ks.currentWindowStartMs  : null,
    count:    ks.currentCount,
    hms:      session.pageType === 'vod'
      ? secToHMS(ks.currentWindowStartSec)
      : new Date(ks.currentWindowStartMs).toLocaleTimeString('ko-KR'),
  };

  ks.windows.push(windowEntry);
  if (ks.windows.length > 20) ks.windows = ks.windows.slice(-20);

  const result = detectSpike(ks.windows);
  if (result.isSpike) {
    const spike = {
      keyword,
      ...windowEntry,
      zScore: result.zScore,
      mean:   result.mean,
      ratio:  result.mean > 0
        ? Math.round((windowEntry.count / result.mean) * 100) / 100
        : null,
    };
    session.keywordSpikes.push(spike);
    console.log('[chzzk-analyzer] Keyword spike:', spike);
    updateBadge(session.spikes.length + session.keywordSpikes.length);
    notifyTabs(session.pageId, { type: 'KEYWORD_SPIKE_UPDATE', spike });
  }

  ks.currentWindowIndex++;
  ks.currentCount = 0;
}

// ── 키워드 빈도 처리 ──────────────────────────────────────────────────────────
function processKeywords(session, texts, msg) {
  if (!KEYWORDS.length || !texts.length) return;

  for (const keyword of KEYWORDS) {
    const matchCount = texts.filter(t => t.includes(keyword)).length;
    const ks = initKeywordState(session, keyword);

    if (msg.pageType === 'vod') {
      const vt = msg.videoTimestamp ?? 0;
      if (ks.currentWindowStartSec === null) {
        ks.currentWindowStartSec = Math.floor(vt / WINDOW_SIZE_SEC) * WINDOW_SIZE_SEC;
      }
      const expectedIdx = Math.floor(vt / WINDOW_SIZE_SEC);
      while (ks.currentWindowIndex < expectedIdx) {
        flushKeywordWindow(session, keyword);
        ks.currentWindowStartSec = ks.currentWindowIndex * WINDOW_SIZE_SEC;
      }
      ks.currentCount += matchCount;
    } else {
      const now = msg.wallTimestamp;
      if (ks.currentWindowStartMs === null) ks.currentWindowStartMs = now;
      if (now - ks.currentWindowStartMs >= WINDOW_SIZE_SEC * 1000) {
        flushKeywordWindow(session, keyword);
        ks.currentWindowStartMs = now;
      }
      ks.currentCount += matchCount;
    }
  }
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

  // Keyword processing
  processKeywords(session, msg.texts || [], msg);

  // Persist to session storage
  persistSession(session);
}

// ── 썸네일 제거 (용량 부족 시 스파이크 데이터는 보존) ──────────────────────────
function stripThumbnails(stored) {
  let removed = 0;
  for (const pageId of Object.keys(stored)) {
    const s = stored[pageId];
    if (!s.spikes) continue;
    for (const spike of s.spikes) {
      if (spike.thumbnail) { delete spike.thumbnail; removed++; }
    }
  }
  console.log(`[chzzk-analyzer] Storage full: ${removed}개 썸네일 제거 (스파이크 데이터는 유지)`);
}

// ── Persist session to chrome.storage.local (브라우저 재시작 후에도 유지) ──────
let persistTimer = null;
function persistSession(session) {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const existing = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
      existing[session.pageId] = {
        pageId: session.pageId,
        pageType: session.pageType,
        startedAt: session.startedAt,
        windows: session.windows.slice(-200),
        spikes: session.spikes,
        keywordSpikes: session.keywordSpikes,
        totalMessages: session.totalMessages,
        channelName: session.channelName || null,
        liveTitle: session.liveTitle || null,
      };
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: existing });
      } catch (e) {
        if (e.message?.includes('QUOTA_BYTES')) {
          // 용량 초과 → 모든 세션에서 썸네일 제거 후 재시도
          stripThumbnails(existing);
          await chrome.storage.local.set({ [STORAGE_KEY]: existing });
        } else {
          throw e;
        }
      }
    } catch (e) {
      console.error('[chzzk-analyzer] Storage error:', e);
    }
  }, 500);
}

// ── 페이지 메타 (스트리머명/방제) ────────────────────────────────────────────
async function fetchPageMeta(pageId, pageType) {
  try {
    let url;
    if (pageType === 'live') {
      url = `https://api.chzzk.naver.com/service/v2/channels/${pageId}/live-detail`;
    } else if (pageType === 'vod') {
      url = `https://api.chzzk.naver.com/service/v1/videos/${pageId}`;
    } else {
      return null;
    }

    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const json = await res.json();
    const content = json?.content;
    if (!content) return null;

    if (pageType === 'live') {
      return {
        channelName: content.channel?.channelName || null,
        liveTitle: content.liveTitle || null,
      };
    } else {
      return {
        channelName: content.channel?.channelName || null,
        liveTitle: content.videoTitle || null,
      };
    }
  } catch (e) {
    console.warn('[chzzk-analyzer] fetchPageMeta failed:', e);
    return null;
  }
}

function parseTabTitle(title) {
  if (!title) return { channelName: null, liveTitle: null };
  const cleaned = title.replace(/\s*[-–]\s*CHZZK\s*$/i, '').trim();
  const parts = cleaned.split(/\s*[-–]\s*/);
  if (parts.length >= 2) {
    return {
      liveTitle: parts[0]?.trim() || null,
      channelName: parts[parts.length - 1]?.replace(/\s+LIVE$/i, '').trim() || null,
    };
  }
  return { channelName: cleaned || null, liveTitle: null };
}

// ── 파일명 헬퍼 ───────────────────────────────────────────────────────────────
function sanitizeFilename(str) {
  if (!str) return '';
  return str.replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 40);
}

function buildFilename(session, ext) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const ch    = sanitizeFilename(session.channelName) || session.pageId;
  const title = sanitizeFilename(session.liveTitle);
  return title ? `${ch}_${title}_${date}.${ext}` : `${ch}_${date}.${ext}`;
}

// ── 자동 내보내기 (TXT) ───────────────────────────────────────────────────────
function formatSpikesToTxt(session) {
  const allSpikes = [
    ...(session.spikes || []).map(s => ({ ...s, _type: '포인트' })),
    ...(session.keywordSpikes || []).map(s => ({ ...s, _type: `키워드:${s.keyword}` })),
  ].sort((a, b) => (a.startSec ?? a.startMs ?? 0) - (b.startSec ?? b.startMs ?? 0));

  if (allSpikes.length === 0) return null;

  const now = new Date().toLocaleString('ko-KR');
  const lines = [
    '# 치지직 편집 포인트 | 채팅 급증 구간 (자동 저장)',
    `# 페이지 ID: ${session.pageId}  |  생성: ${now}`,
    '',
    ...allSpikes.map(s =>
      `${s.hms} [${s._type}] - ${s.count}${s._type === '포인트' ? '개' : '회'}/30s${s.ratio ? ', 평균 대비 ' + s.ratio + 'x' : ''}, Z=${s.zScore}${s.memo ? ' // ' + s.memo : ''}`
    ),
  ];
  return lines.join('\n');
}

async function autoExport(session) {
  if (!session) return;
  const content = formatSpikesToTxt(session);
  if (!content) return;

  try {
    const filename = buildFilename(session, 'txt');
    const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    console.log('[chzzk-analyzer] Auto-exported:', filename);
  } catch (e) {
    console.error('[chzzk-analyzer] Auto-export failed:', e);
  }
}

// ── 세션 초기화 헬퍼 ─────────────────────────────────────────────────────────
async function clearSession(pageId) {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const existing = result[STORAGE_KEY] || {};
    const stored = existing[pageId];

    // 스파이크가 있으면 초기화 전에 자동 내보내기
    // in-memory 세션에 최신 channelName/liveTitle이 있으면 덮어쓰기
    if (stored && (stored.spikes?.length > 0 || stored.keywordSpikes?.length > 0)) {
      const mem = sessions[pageId];
      if (mem?.channelName) stored.channelName = mem.channelName;
      if (mem?.liveTitle)   stored.liveTitle   = mem.liveTitle;
      await autoExport(stored);
    }

    delete existing[pageId];
    await chrome.storage.local.set({ [STORAGE_KEY]: existing });
    console.log('[chzzk-analyzer] Session auto-cleared:', pageId);
  } catch (e) {
    console.error('[chzzk-analyzer] Failed to clear session:', e);
  }
  delete sessions[pageId];
}

// ── Get settings ─────────────────────────────────────────────────────────────
async function getSettings() {
  const result = await chrome.storage.sync.get({
    zThreshold: DEFAULT_Z_THRESH,
    windowSize: WINDOW_SIZE_SEC,
    saveThumbnail: true,
    keywords: [],
  });
  return result;
}

// ── Service Worker Keep-Alive (MV3 슬립 방지) ────────────────────────────────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // 24초마다
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // 서비스 워커 슬립 방지 - 아무것도 안 해도 깨어있게 됨
  }
});

// ── 이전 세션 복원 ────────────────────────────────────────────────────────────
async function restoreSession(pageId, pageType) {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = (result[STORAGE_KEY] || {})[pageId];
    if (!stored || !sessions[pageId]) return;

    const session = sessions[pageId];

    // 스파이크 기록만 복원 (윈도우는 복원하지 않음)
    // → 윈도우를 복원하면 기준선 계산이 꼬여서 새 스파이크를 못 잡음
    session.spikes        = stored.spikes        || [];
    session.keywordSpikes = stored.keywordSpikes || [];
    session.totalMessages = stored.totalMessages || 0;
    session.startedAt     = stored.startedAt     || session.startedAt;
    session.pageType      = pageType             || stored.pageType || 'unknown';
    session.keywordState  = {};

    // 윈도우 추적 상태 초기화 (서비스 워커가 살아있을 때 이전 값이 남아있으면
    // expectedWindowIdx가 currentWindowIndex를 따라잡지 못해 윈도우가 플러시 안 됨)
    session.windows              = [];
    session.currentWindowIndex   = 0;
    session.currentWindowCount   = 0;
    session.currentWindowStartSec = null;
    session.currentWindowStartMs  = null;

    console.log('[chzzk-analyzer] Restored session:', pageId,
      'spikes:', session.spikes.length, '(windows fresh for new detection)');

    // 복원된 데이터를 overlay에도 전달
    notifyTabs(pageId, {
      type: 'STATS_UPDATE',
      windows: session.windows.slice(-50),
      spikes: session.spikes,
      keywordSpikes: session.keywordSpikes,
      totalMessages: session.totalMessages,
    });
  } catch (e) {
    console.error('[chzzk-analyzer] Failed to restore session:', e);
  }
}

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'WS_OPEN': {
      const tabId = sender.tab?.id;
      if (tabId) tabPageMap[tabId] = msg.pageId;
      console.log('[chzzk-analyzer] WebSocket opened:', msg.url, 'pageType:', msg.pageType);
      const openSession = getSession(msg.pageId);
      openSession.pageType = msg.pageType;

      // 즉시 폴백: 탭 타이틀 파싱
      const tabMeta = parseTabTitle(sender.tab?.title);
      if (tabMeta.channelName) openSession.channelName = tabMeta.channelName;
      if (tabMeta.liveTitle)   openSession.liveTitle   = tabMeta.liveTitle;

      // 정확한 데이터: chzzk API 비동기 호출 후 덮어쓰기
      fetchPageMeta(msg.pageId, msg.pageType).then(meta => {
        const s = sessions[msg.pageId];
        if (!s || !meta) return;
        if (meta.channelName) s.channelName = meta.channelName;
        if (meta.liveTitle)   s.liveTitle   = meta.liveTitle;
        console.log('[chzzk-analyzer] Page meta:', meta.channelName, '|', meta.liveTitle);
      });

      restoreSession(msg.pageId, msg.pageType); // 이전 세션 복원
      break;
    }

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

    case 'PAGE_NAVIGATE': {
      const tabId = sender.tab?.id;
      const oldPageId = tabId ? tabPageMap[tabId] : null;
      const newPageId = msg.pageId;

      if (tabId) tabPageMap[tabId] = newPageId;

      // 다른 영상/방송으로 이동 시 이전 세션 자동 초기화
      if (oldPageId && oldPageId !== newPageId) {
        clearSession(oldPageId);
      }
      console.log('[chzzk-analyzer] Navigation to:', msg.pageType, newPageId);
      break;
    }

    case 'GET_SESSION_DATA': {
      chrome.storage.local.get(STORAGE_KEY).then((result) => {
        const data = (result[STORAGE_KEY] || {})[msg.pageId] || null;
        // in-memory에 최신 channelName/liveTitle이 있으면 덮어쓰기
        if (data) {
          const mem = sessions[msg.pageId];
          if (mem?.channelName) data.channelName = mem.channelName;
          if (mem?.liveTitle)   data.liveTitle   = mem.liveTitle;
        }
        sendResponse({ data });
      });
      return true; // async response
    }

    case 'GET_ALL_SESSIONS': {
      chrome.storage.local.get(STORAGE_KEY).then((result) => {
        sendResponse({ data: result[STORAGE_KEY] || {} });
      });
      return true;
    }

    case 'VIDEO_ENDED':
      // VOD 재생 완료 → 세션 자동 초기화
      clearSession(msg.pageId);
      break;

    case 'CLEAR_SESSION': {
      delete sessions[msg.pageId];
      chrome.storage.local.get(STORAGE_KEY).then(async (result) => {
        const existing = result[STORAGE_KEY] || {};
        delete existing[msg.pageId];
        await chrome.storage.local.set({ [STORAGE_KEY]: existing });
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'CAPTURE_REQUEST': {
      // canvas.toDataURL()이 CDN CORS로 막히므로
      // captureVisibleTab으로 탭 전체 캡처 → OffscreenCanvas로 비디오 영역 crop
      if (!sender.tab?.active) break; // 탭이 숨겨진 경우 스킵
      (async () => {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
            format: 'jpeg',
            quality: 70,
          });

          const { rect, dpr = 1, pageId, windowIndex } = msg;
          const blob = await (await fetch(dataUrl)).blob();
          const img  = await createImageBitmap(blob);

          const canvas = new OffscreenCanvas(160, 90);
          canvas.getContext('2d').drawImage(
            img,
            Math.round(rect.x * dpr), Math.round(rect.y * dpr),
            Math.round(rect.width * dpr), Math.round(rect.height * dpr),
            0, 0, 160, 90
          );

          const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
          const buf   = await thumbBlob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary  = '';
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }
          const thumbnail = `data:image/jpeg;base64,${btoa(binary)}`;

          const session = sessions[pageId];
          if (session) {
            const spike = session.spikes.find(s => s.windowIndex === windowIndex);
            if (spike) {
              spike.thumbnail = thumbnail;
              persistSession(session);
            }
          }
        } catch (_) {
          // 탭 비활성화 등 캡처 불가 시 조용히 무시
        }
      })();
      break;
    }

    case 'CLEAR_THUMBNAILS': {
      chrome.storage.local.get(STORAGE_KEY).then(async (result) => {
        const existing = result[STORAGE_KEY] || {};
        let removed = 0;
        for (const pageId of Object.keys(existing)) {
          for (const spike of existing[pageId].spikes || []) {
            if (spike.thumbnail) { delete spike.thumbnail; removed++; }
          }
        }
        // 메모리 세션도 정리
        for (const pageId of Object.keys(sessions)) {
          for (const spike of sessions[pageId].spikes || []) {
            delete spike.thumbnail;
          }
        }
        await chrome.storage.local.set({ [STORAGE_KEY]: existing });
        sendResponse({ ok: true, removed });
      });
      return true;
    }

    case 'SAVE_MEMO': {
      chrome.storage.local.get(STORAGE_KEY).then(async (result) => {
        const existing = result[STORAGE_KEY] || {};
        const stored   = existing[msg.pageId];
        if (!stored) { sendResponse({ ok: false }); return; }

        const spikes = msg.isKeyword ? stored.keywordSpikes : stored.spikes;
        const spike  = spikes?.find(s =>
          s.windowIndex === msg.windowIndex &&
          (!msg.isKeyword || s.keyword === msg.keyword)
        );

        if (spike) {
          spike.memo = msg.memo;
          await chrome.storage.local.set({ [STORAGE_KEY]: existing });

          // 메모리 세션도 동기화
          const mem = sessions[msg.pageId];
          if (mem) {
            const memSpikes = msg.isKeyword ? mem.keywordSpikes : mem.spikes;
            const memSpike  = memSpikes?.find(s =>
              s.windowIndex === msg.windowIndex &&
              (!msg.isKeyword || s.keyword === msg.keyword)
            );
            if (memSpike) memSpike.memo = msg.memo;
          }
        }
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'GET_SETTINGS': {
      getSettings().then((settings) => sendResponse({ settings }));
      return true;
    }

    case 'SAVE_SETTINGS': {
      chrome.storage.sync.set(msg.settings).then(() => {
        // 저장 즉시 메모리에 반영
        if (msg.settings.zThreshold   !== undefined) Z_THRESH        = msg.settings.zThreshold;
        if (msg.settings.windowSize   !== undefined) WINDOW_SIZE_SEC = msg.settings.windowSize;
        if (msg.settings.saveThumbnail !== undefined) SAVE_THUMBNAIL = msg.settings.saveThumbnail;
        if (msg.settings.keywords      !== undefined) KEYWORDS        = msg.settings.keywords;
        sendResponse({ ok: true });
      });
      return true;
    }
  }
});
