// background.js - Service Worker
// Data aggregation, spike detection, storage

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
let WINDOW_SIZE_SEC  = 30;    // 팝업 설정에서 로드됨
let Z_THRESH         = 3.0;   // 팝업 설정에서 로드됨
let SAVE_THUMBNAIL   = true;  // 썸네일 자동 캡처 여부
let AUTO_EXPORT      = true;  // 방송 이동/종료 시 TXT 자동 저장 여부
let PAUSED           = false; // 채팅 수집 일시중지 여부
let KEYWORDS         = [];    // 키워드 감지 목록
const LAG_WINDOWS    = 10;
const DEFAULT_Z_THRESH  = 3.0;
const STORAGE_KEY    = 'chzzk_analyzer_session';

// 서비스 워커 시작 시 사용자 설정 로드
// 설정 로드 완료 전 도착한 CHAT_MESSAGE는 큐에 보관 → 로드 후 처리 (레이스 컨디션 방지)
let SETTINGS_LOADED = false;
const pendingChatMessages = [];
// SAVE_SETTINGS가 startup get 콜백보다 먼저 실행된 경우, 콜백이 그 값을 덮어쓰지 않도록 추적
const _explicitSettingKeys = new Set();

function _applyAndFlush() {
  SETTINGS_LOADED = true;
  if (pendingChatMessages.length > 0) {
    console.log('[chzzk-analyzer] Flushing', pendingChatMessages.length, 'pending chat messages');
    pendingChatMessages.splice(0).forEach(m => handleChatMessage(m));
  }
  console.log('[chzzk-analyzer] Settings loaded:', { Z_THRESH, WINDOW_SIZE_SEC, SAVE_THUMBNAIL, AUTO_EXPORT, PAUSED, KEYWORDS });
}

chrome.storage.local.get(
  { zThreshold: 3.0, windowSize: 30, saveThumbnail: true, autoExport: true, paused: false, keywords: [], _settingsMigrated: false },
  (s) => {
    if (!s._settingsMigrated) {
      // 최초 1회: storage.sync → storage.local 전체 설정 마이그레이션
      chrome.storage.sync.get(
        { zThreshold: 3.0, windowSize: 30, saveThumbnail: true, autoExport: true, paused: false, keywords: [] },
        (sync) => {
          const migrated = {
            zThreshold:    sync.zThreshold    ?? s.zThreshold,
            windowSize:    sync.windowSize    ?? s.windowSize,
            saveThumbnail: sync.saveThumbnail ?? s.saveThumbnail,
            autoExport:    sync.autoExport    ?? s.autoExport,
            paused:        sync.paused        ?? s.paused,
            keywords:      sync.keywords?.length ? sync.keywords : (s.keywords || []),
            _settingsMigrated: true,
          };
          chrome.storage.local.set(migrated);
          console.log('[chzzk-analyzer] Settings migrated from sync:', migrated);
          if (!_explicitSettingKeys.has('zThreshold'))    Z_THRESH        = migrated.zThreshold;
          if (!_explicitSettingKeys.has('windowSize'))    WINDOW_SIZE_SEC = migrated.windowSize;
          if (!_explicitSettingKeys.has('saveThumbnail')) SAVE_THUMBNAIL  = migrated.saveThumbnail ?? true;
          if (!_explicitSettingKeys.has('autoExport'))    AUTO_EXPORT     = migrated.autoExport    ?? true;
          if (!_explicitSettingKeys.has('paused'))        PAUSED          = migrated.paused        ?? false;
          if (!_explicitSettingKeys.has('keywords'))      KEYWORDS        = migrated.keywords;
          _applyAndFlush();
        }
      );
      return;
    }

    // 마이그레이션 완료된 이후: local에서 바로 적용
    if (!_explicitSettingKeys.has('zThreshold'))    Z_THRESH        = s.zThreshold;
    if (!_explicitSettingKeys.has('windowSize'))    WINDOW_SIZE_SEC = s.windowSize;
    if (!_explicitSettingKeys.has('saveThumbnail')) SAVE_THUMBNAIL  = s.saveThumbnail ?? true;
    if (!_explicitSettingKeys.has('autoExport'))    AUTO_EXPORT     = s.autoExport    ?? true;
    if (!_explicitSettingKeys.has('paused'))        PAUSED          = s.paused        ?? false;
    if (!_explicitSettingKeys.has('keywords'))      KEYWORDS        = s.keywords || [];
    _applyAndFlush();
  }
);

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
      startedAtCorrected: false,
      restoredFromStorage: false, // restoreSession이 이미 실행됐으면 재실행 방지
      // Array of { windowIndex, startSec, count }
      windows: [],
      // Current accumulating window (wall-clock 기반으로 통일)
      currentWindowIndex: 0,
      currentWindowCount: 0,
      currentWindowStartMs: null,  // wall-clock 기반 (live/VOD 공통)
      currentWindowStartSec: null, // VOD 표시용 (영상 시간), 윈도우 진행에는 미사용
      // Detected spikes
      spikes: [],
      totalMessages: 0,
      channelName: null,
      liveTitle: null,
      managerChats: [],
      // Keyword spikes
      keywordSpikes: [],
      keywordState: {},  // { [keyword]: { currentCount, currentWindowIndex, currentWindowStartSec, currentWindowStartMs, windows[] } }
    };
  }
  return sessions[pageId];
}

// ── Z-Score spike detection ──────────────────────────────────────────────────
function detectSpike(windows, zThreshold = Z_THRESH, minWindows = 2) {
  if (windows.length < minWindows) return { isSpike: false, zScore: 0, mean: 0, std: 0 };

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

// ── 라이브 startedAt 보정 + 기존 스파이크 hms/startSec 재계산 ─────────────────
function correctLiveStartedAt(session, newStartedAt) {
  if (!session || session.pageType !== 'live') return;
  session.startedAt = newStartedAt;
  session.startedAtCorrected = true; // restoreSession이 덮어쓰지 못하도록 표시
  // 기존에 잘못 기록된 스파이크 타임스탬프 재계산
  for (const spike of session.spikes || []) {
    if (spike.startMs != null) {
      const elapsedSec = Math.floor((spike.startMs - newStartedAt) / 1000);
      spike.startSec = elapsedSec;
      spike.hms = secToHMS(elapsedSec);
    }
  }
  for (const spike of session.keywordSpikes || []) {
    if (spike.startMs != null) {
      const elapsedSec = Math.floor((spike.startMs - newStartedAt) / 1000);
      spike.startSec = elapsedSec;
      spike.hms = secToHMS(elapsedSec);
    }
  }
  for (const chat of session.managerChats || []) {
    if (chat.wallMs != null) {
      chat.hms = secToHMS(Math.floor((chat.wallMs - newStartedAt) / 1000));
    }
  }
  console.log('[chzzk-analyzer] startedAt corrected to:', new Date(newStartedAt).toISOString());
  // 팝업이 열려 있으면 갱신된 타임스탬프를 즉시 반영
  notifyTabs(session.pageId, {
    type: 'STATS_UPDATE',
    windows: session.windows.slice(-50),
    spikes: session.spikes,
    keywordSpikes: session.keywordSpikes,
    totalMessages: session.totalMessages,
  });
}

// ── Flush current window into windows array ───────────────────────────────────
function flushWindow(session) {
  if (session.currentWindowCount === 0) {
    // advance empty window anyway
    session.currentWindowIndex++;
    session.currentWindowCount = 0;
    return;
  }

  // VOD: currentWindowStartSec(영상 시간)이 있으면 표시에 사용, 없으면 경과 시간
  const elapsedSec = session.currentWindowStartMs != null
    ? Math.floor((session.currentWindowStartMs - session.startedAt) / 1000)
    : null;
  const vodSec = session.pageType === 'vod' ? session.currentWindowStartSec : null;
  const windowEntry = {
    windowIndex: session.currentWindowIndex,
    startSec: vodSec ?? elapsedSec,
    startMs:  session.currentWindowStartMs,
    count:    session.currentWindowCount,
    windowSec: WINDOW_SIZE_SEC,
    hms:      secToHMS(vodSec ?? elapsedSec),
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
      // pageId가 null이면 모든 치지직 탭에 전송 (SET_PAUSED 등 전역 알림용)
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

  const kwElapsedSec = ks.currentWindowStartMs != null
    ? Math.floor((ks.currentWindowStartMs - session.startedAt) / 1000)
    : null;
  const kwVodSec = session.pageType === 'vod' ? ks.currentWindowStartSec : null;
  const windowEntry = {
    windowIndex: ks.currentWindowIndex,
    startSec: kwVodSec ?? kwElapsedSec,
    startMs:  ks.currentWindowStartMs,
    count:    ks.currentCount,
    windowSec: WINDOW_SIZE_SEC,
    hms:      secToHMS(kwVodSec ?? kwElapsedSec),
  };

  ks.windows.push(windowEntry);
  if (ks.windows.length > 20) ks.windows = ks.windows.slice(-20);

  // 키워드는 빈 윈도우를 건너뛰므로 std 계산을 위해 최소 3개 이상 필요
  const result = detectSpike(ks.windows, Z_THRESH, 3);

  // std=0 폴백: 이전 윈도우에 키워드가 없어서 표준편차가 0인 경우
  // Z-score 수식이 0/0이 되어 항상 미감지 → 최소 등장 횟수로 대신 판단
  // ex) 평균 0회 키워드가 갑자기 2회 이상 → 급증으로 처리
  const fallbackSpike = !result.isSpike
    && result.std === 0
    && result.mean < 1
    && windowEntry.count >= Math.max(2, Math.ceil(Z_THRESH));

  if (result.isSpike || fallbackSpike) {
    const spike = {
      keyword,
      ...windowEntry,
      zScore: result.isSpike ? result.zScore : windowEntry.count,
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
    // "[뱃지] 닉네임_메시지" 포맷에서 _ 이후 메시지 부분만 키워드 검색
    const matchCount = texts.filter(t => {
      const idx = t.indexOf('_');
      const msgPart = idx > 0 ? t.slice(idx + 1) : t;
      return msgPart.includes(keyword);
    }).length;
    const ks = initKeywordState(session, keyword);

    // 키워드도 wall-clock 기반으로 통일
    const now = msg.wallTimestamp;
    if (ks.currentWindowStartMs === null) {
      ks.currentWindowStartMs  = now;
      if (msg.pageType === 'vod' && msg.videoTimestamp > 0) {
        ks.currentWindowStartSec = Math.floor(msg.videoTimestamp);
      }
    }
    // VOD: 영상 타임스탬프 기준 윈도우 진행 (wall-clock은 preload 시 신뢰 불가)
    const kwShouldFlush = (msg.pageType === 'vod' && msg.videoTimestamp > 0 && ks.currentWindowStartSec != null)
      ? (msg.videoTimestamp - ks.currentWindowStartSec) >= WINDOW_SIZE_SEC
      : (now - ks.currentWindowStartMs) >= WINDOW_SIZE_SEC * 1000;

    if (kwShouldFlush) {
      flushKeywordWindow(session, keyword);
      ks.currentWindowStartMs  = now;
      ks.currentWindowStartSec = (msg.pageType === 'vod' && msg.videoTimestamp > 0)
        ? Math.floor(msg.videoTimestamp) : null;
    }
    ks.currentCount += matchCount;
  }
}

// ── Handle incoming chat message ──────────────────────────────────────────────
function handleChatMessage(msg) {
  if (PAUSED) return; // 일시중지 중이면 수집 스킵
  const session = getSession(msg.pageId);
  session.pageType = msg.pageType;
  session.totalMessages += msg.count;

  // 윈도우 진행: VOD/라이브 모두 wall-clock 기반으로 통일
  // (videoTimestamp는 부정확·null 가능성이 높아 윈도우 기준으로 부적합)
  const now = msg.wallTimestamp;

  if (session.currentWindowStartMs === null) {
    session.currentWindowStartMs = now;
    // VOD: 이 윈도우의 표시 시간(영상 기준) 기록
    if (msg.pageType === 'vod' && msg.videoTimestamp > 0) {
      session.currentWindowStartSec = Math.floor(msg.videoTimestamp);
    }
  }

  // VOD: 채팅이 한꺼번에 preload되면 wall-clock이 거의 0ms → 윈도우가 절대 flush 안 됨
  // → VOD는 영상 타임스탬프 기준으로 윈도우 진행, 라이브는 wall-clock 유지
  const isVod = msg.pageType === 'vod';
  const shouldFlush = (isVod && msg.videoTimestamp > 0 && session.currentWindowStartSec != null)
    ? (msg.videoTimestamp - session.currentWindowStartSec) >= WINDOW_SIZE_SEC
    : (now - session.currentWindowStartMs) >= WINDOW_SIZE_SEC * 1000;

  if (shouldFlush) {
    flushWindow(session);
    session.currentWindowStartMs = now;
    // 새 윈도우의 표시 시간 갱신
    session.currentWindowStartSec = (isVod && msg.videoTimestamp > 0)
      ? Math.floor(msg.videoTimestamp) : null;
  }

  session.currentWindowCount += msg.count;

  // Keyword processing
  processKeywords(session, msg.texts || [], msg);

  // 매니저 채팅 수집
  for (const t of (msg.texts || [])) {
    if (!t.startsWith('[매니저]')) continue;
    const withoutBadge = t.slice('[매니저] '.length);
    const underIdx = withoutBadge.indexOf('_');
    const nickname = underIdx > 0 ? withoutBadge.slice(0, underIdx) : '';
    const text     = underIdx > 0 ? withoutBadge.slice(underIdx + 1) : withoutBadge;
    const managerElapsedSec = msg.pageType === 'live'
      ? Math.floor((msg.wallTimestamp - session.startedAt) / 1000)
      : null;
    const hms = msg.pageType === 'vod'
      ? secToHMS(Math.floor(msg.videoTimestamp || 0))
      : secToHMS(managerElapsedSec);
    session.managerChats.push({
      hms,
      startSec: msg.pageType === 'vod' ? Math.floor(msg.videoTimestamp || 0) : managerElapsedSec,
      wallMs: msg.pageType === 'live' ? msg.wallTimestamp : null,
      nickname,
      text,
    });
    if (session.managerChats.length > 300) session.managerChats.shift();
  }

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
        managerChats: session.managerChats || [],
      };
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: existing });
      } catch (e) {
        if (e.message?.includes('QUOTA_BYTES')) {
          // 용량 초과 → 모든 세션에서 썸네일 제거 후 재시도
          stripThumbnails(existing);
          // 메모리 세션도 함께 정리 (안 하면 다음 persist 때 또 포함되어 무한 실패)
          for (const pid of Object.keys(sessions)) {
            for (const spike of sessions[pid].spikes || []) delete spike.thumbnail;
          }
          await chrome.storage.local.set({ [STORAGE_KEY]: existing });
          console.warn('[chzzk-analyzer] Storage quota exceeded: all thumbnails removed.');
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
      // openDate: 방송 시작 시각 (e.g. "2026-02-27 14:30:00")
      const openDate = content.openDate || content.liveOpenDate || null;
      return {
        channelName: content.channel?.channelName || null,
        liveTitle: content.liveTitle || null,
        liveStartedAt: openDate ? new Date(openDate).getTime() : null,
      };
    } else {
      return {
        channelName: content.channel?.channelName || null,
        liveTitle: content.videoTitle || null,
        liveStartedAt: null,
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
      `${s.hms} [${s._type}] - ${s.count}${s._type === '포인트' ? '개' : '회'}/${s.windowSec ?? 30}s${s.ratio ? ', 평균 대비 ' + s.ratio + 'x' : ''}, Z=${s.zScore}${s.memo ? ' // ' + s.memo : ''}`
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

    // 스파이크가 있으면 초기화 전에 자동 내보내기 (설정 OFF 시 스킵)
    if (AUTO_EXPORT && stored && (stored.spikes?.length > 0 || stored.keywordSpikes?.length > 0)) {
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

// ── 내보내기만 하고 세션 데이터는 보존 (다른 방송으로 이동 시) ──────────────
// clearSession과 달리 storage의 데이터를 삭제하지 않아 돌아왔을 때 스파이크 복원 가능
async function exportAndKeepSession(pageId) {
  const mem = sessions[pageId];
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const existing = result[STORAGE_KEY] || {};

    // in-memory 최신 상태를 storage에 직접 반영
    // (persistTimer 500ms 디바운스로 인해 마지막 채팅이 저장 안 된 경우 대비)
    if (mem) {
      existing[pageId] = {
        pageId:        mem.pageId,
        pageType:      mem.pageType,
        startedAt:     mem.startedAt,
        windows:       mem.windows.slice(-200),
        spikes:        mem.spikes,
        keywordSpikes: mem.keywordSpikes,
        totalMessages: mem.totalMessages,
        channelName:   mem.channelName || null,
        liveTitle:     mem.liveTitle   || null,
        managerChats:  mem.managerChats || [],
      };
      await chrome.storage.local.set({ [STORAGE_KEY]: existing });
    }

    const stored = existing[pageId];
    if (AUTO_EXPORT && stored && (stored.spikes?.length > 0 || stored.keywordSpikes?.length > 0)) {
      await autoExport(stored);
    }
  } catch (e) {
    console.error('[chzzk-analyzer] Failed to export session:', e);
  }
  // in-memory만 제거 (tracking state 초기화)
  delete sessions[pageId];
}

// ── Get settings ─────────────────────────────────────────────────────────────
async function getSettings() {
  const result = await chrome.storage.local.get({
    zThreshold: DEFAULT_Z_THRESH,
    windowSize: WINDOW_SIZE_SEC,
    saveThumbnail: true,
    autoExport: true,
    paused: false,
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
    if (!sessions[pageId]) return;

    const session = sessions[pageId];

    // 이미 복원 시도했으면 스킵 (DOM 재마운트로 WS_OPEN이 재발송될 때 windows 리셋 방지)
    // stored 유무와 관계없이 먼저 설정해야 함:
    // stored가 없을 때 early return하면 플래그가 false로 남아 다음 DOM 재마운트 시
    // persistSession이 저장한 데이터로 restore가 재실행되어 windows가 리셋됨
    if (session.restoredFromStorage) {
      console.log('[chzzk-analyzer] Session already restored, skipping (reconnect)');
      return;
    }
    session.restoredFromStorage = true;

    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = (result[STORAGE_KEY] || {})[pageId];
    if (!stored) return;

    // 스파이크 기록만 복원 (윈도우는 복원하지 않음)
    // → 윈도우를 복원하면 기준선 계산이 꼬여서 새 스파이크를 못 잡음
    session.spikes        = stored.spikes        || [];
    session.keywordSpikes = stored.keywordSpikes || [];
    session.totalMessages = stored.totalMessages || 0;
    // 이미 보정된 경우(STREAM_ELAPSED 또는 API) 덮어쓰지 않음
    if (!session.startedAtCorrected) {
      session.startedAt = stored.startedAt || session.startedAt;
    }
    session.pageType      = pageType             || stored.pageType || 'unknown';
    // channelName/liveTitle 복원 (파일명 버그 방지: fetchPageMeta 전에 이동해도 이름 유지)
    if (stored.channelName && !session.channelName) session.channelName = stored.channelName;
    if (stored.liveTitle   && !session.liveTitle)   session.liveTitle   = stored.liveTitle;
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

      // WS_OPEN 시점에 DOM에서 바로 읽힌 경우 즉시 보정
      if (msg.pageType === 'live' && msg.streamElapsedSec != null) {
        correctLiveStartedAt(openSession, msg.timestamp - msg.streamElapsedSec * 1000);
      }

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
        // API에서 방송 시작 시각을 가져온 경우 startedAt 보정 (가장 정확)
        if (meta.liveStartedAt) correctLiveStartedAt(s, meta.liveStartedAt);
        // channelName/liveTitle을 즉시 storage에 반영 (파일명 버그 방지)
        // 채팅 메시지가 없어도 저장 보장
        persistSession(s);
        console.log('[chzzk-analyzer] Page meta:', meta.channelName, '|', meta.liveTitle, '| startedAt:', meta.liveStartedAt);
      });

      restoreSession(msg.pageId, msg.pageType); // 이전 세션 복원
      break;
    }

    case 'STREAM_ELAPSED': {
      // 라이브 방송 경과 시간 DOM 폴링으로 확인된 시점에 startedAt 보정 (API 보정이 없을 때 폴백)
      const session = sessions[msg.pageId];
      if (session && session.pageType === 'live') {
        const newStartedAt = msg.timestamp - msg.streamElapsedSec * 1000;
        correctLiveStartedAt(session, newStartedAt);
      }
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
      if (!SETTINGS_LOADED) {
        // 설정 로드 완료 전: 큐에 보관 (잘못된 설정으로 처리하지 않음)
        pendingChatMessages.push(msg);
      } else {
        handleChatMessage(msg);
      }
      break;

    case 'PAGE_NAVIGATE': {
      const tabId = sender.tab?.id;
      const oldPageId = tabId ? tabPageMap[tabId] : null;
      const newPageId = msg.pageId;

      if (tabId) tabPageMap[tabId] = newPageId;

      // 다른 영상/방송으로 이동 시 내보내기 후 세션 데이터 보존
      // (돌아왔을 때 스파이크 복원 가능하도록 storage는 삭제하지 않음)
      if (oldPageId && oldPageId !== newPageId) {
        exportAndKeepSession(oldPageId);
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
      if (!sender.tab?.windowId) break;
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
        } catch (e) {
          console.warn('[chzzk-analyzer] Thumbnail capture failed:', e?.message);
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
      // startup get 콜백이 이 값들을 덮어쓰지 못하도록 명시적 설정 키 추적
      Object.keys(msg.settings).forEach(k => _explicitSettingKeys.add(k));
      // storage 저장 전에 즉시 메모리 반영 (PAUSED는 특히 즉각 적용 필요)
      if (msg.settings.zThreshold    !== undefined) Z_THRESH        = msg.settings.zThreshold;
      if (msg.settings.windowSize    !== undefined) WINDOW_SIZE_SEC = msg.settings.windowSize;
      if (msg.settings.saveThumbnail !== undefined) SAVE_THUMBNAIL  = msg.settings.saveThumbnail;
      if (msg.settings.autoExport    !== undefined) AUTO_EXPORT     = msg.settings.autoExport;
      if (msg.settings.keywords      !== undefined) KEYWORDS        = msg.settings.keywords;
      if (msg.settings.paused !== undefined) {
        PAUSED = msg.settings.paused;
        // content script에도 즉시 전파 (서비스 워커 재시작 무관하게 차단)
        notifyTabs(null, { type: 'SET_PAUSED', paused: PAUSED });
      }
      chrome.storage.local.set(msg.settings).then(() => sendResponse({ ok: true }));
      return true;
    }
  }
});
