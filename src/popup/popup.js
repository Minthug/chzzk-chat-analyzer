// popup.js - Extension popup logic

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentPageId = null;
let currentSession = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statTotal   = document.getElementById('stat-total');
const statWindows = document.getElementById('stat-windows');
const statSpikes  = document.getElementById('stat-spikes');
const spikeList   = document.getElementById('spike-list');
const spikeBadge  = document.getElementById('spike-badge');
const statusBar   = document.getElementById('status-bar');
const btnTxt      = document.getElementById('btn-export-txt');
const btnCsv      = document.getElementById('btn-export-csv');
const btnClear    = document.getElementById('btn-clear');
const settingZ            = document.getElementById('setting-z');
const settingWin          = document.getElementById('setting-window');
const settingThumbnail    = document.getElementById('setting-thumbnail');
const btnSave             = document.getElementById('btn-save-settings');
const btnClearThumbs      = document.getElementById('btn-clear-thumbnails');
const storageBarFill      = document.getElementById('storage-bar-fill');
const storageText         = document.getElementById('storage-text');
const tabVolume           = document.getElementById('tab-volume');
const tabKeyword          = document.getElementById('tab-keyword');
const settingKeywordInput = document.getElementById('setting-keyword-input');
const btnAddKeyword       = document.getElementById('btn-add-keyword');
const keywordTagList      = document.getElementById('keyword-tag-list');

let activeTab       = 'volume';
let currentKeywords = [];

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Load settings
  const res = await bgMessage({ type: 'GET_SETTINGS' });
  if (res?.settings) {
    settingZ.value             = res.settings.zThreshold   ?? 3.0;
    settingWin.value           = res.settings.windowSize   ?? 30;
    settingThumbnail.checked   = res.settings.saveThumbnail ?? true;
    currentKeywords            = res.settings.keywords     ?? [];
    renderKeywordTags();
  }

  // Find active chzzk tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab  = tabs[0];

  if (!tab || !tab.url?.includes('chzzk.naver.com')) {
    setStatus('치지직 탭이 아닙니다.');
    return;
  }

  // Extract pageId from URL
  const url  = new URL(tab.url);
  const parts = url.pathname.split('/').filter(Boolean);
  currentPageId = parts[1] || null;

  if (!currentPageId) {
    setStatus('채널/영상 페이지를 열어주세요.');
    return;
  }

  await refreshData();
}

// ── Refresh session data from background ──────────────────────────────────────
async function refreshData() {
  // 메모 입력 중이면 갱신 스킵 (타이핑 내용 날아가지 않도록)
  if (document.activeElement?.classList.contains('spike-memo')) return;
  const res = await bgMessage({ type: 'GET_SESSION_DATA', pageId: currentPageId });
  currentSession = res?.data || null;
  renderSession(currentSession);
  updateStorageBar();
}

// ── 스토리지 사용량 표시 ──────────────────────────────────────────────────────
async function updateStorageBar() {
  try {
    const MAX = 10 * 1024 * 1024; // 10MB
    const used = await chrome.storage.local.getBytesInUse(null);
    const pct  = Math.min(100, (used / MAX) * 100);
    const mb   = (used / 1024 / 1024).toFixed(1);

    storageBarFill.style.width = `${pct}%`;
    storageBarFill.style.backgroundColor =
      pct > 80 ? '#e74c3c' : pct > 60 ? '#e67e22' : '#27ae60';
    storageText.textContent = `${mb} MB / 10 MB (${Math.round(pct)}%)`;
  } catch (_) {}
}

// ── Render session ────────────────────────────────────────────────────────────
function renderSession(session) {
  if (!session) {
    statTotal.textContent   = '0';
    statWindows.textContent = '0';
    statSpikes.textContent  = '0';
    spikeList.innerHTML     = '<div class="empty-msg">채팅 데이터 수집 중...<br>치지직 라이브 또는 VOD를 시청하세요.</div>';
    btnTxt.disabled = true;
    btnCsv.disabled = true;
    spikeBadge.classList.remove('visible');
    return;
  }

  statTotal.textContent   = session.totalMessages.toLocaleString();
  statWindows.textContent = session.windows.length;
  statSpikes.textContent  = session.spikes.length;

  const savedAt = new Date(session.startedAt).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  setStatus(`저장됨 · 분석 시작: ${savedAt}`);

  if (session.spikes.length > 0) {
    spikeBadge.classList.add('visible');
    btnTxt.disabled = false;
    btnCsv.disabled = false;
  } else {
    spikeBadge.classList.remove('visible');
    btnTxt.disabled = true;
    btnCsv.disabled = true;
  }

  if (activeTab === 'keyword') {
    renderKeywordSpikes(session);
    return;
  }

  if (session.spikes.length === 0) {
    spikeList.innerHTML = '<div class="empty-msg">아직 급증 구간이 감지되지 않았습니다.</div>';
    return;
  }

  // 시간순 정렬 (원본 배열 보존)
  const sortedSpikes = [...session.spikes].sort((a, b) => {
    const aTime = a.startSec ?? a.startMs ?? 0;
    const bTime = b.startSec ?? b.startMs ?? 0;
    return aTime - bTime;
  });

  // Z-Score 상위 3개 인덱스 추출 (정렬 후 기준)
  const top3 = new Set(
    [...sortedSpikes]
      .map((s, i) => ({ i, z: s.zScore }))
      .sort((a, b) => b.z - a.z)
      .slice(0, 3)
      .map(x => x.i)
  );

  spikeList.innerHTML = sortedSpikes
    .map(
      (s, i) => `
      <div class="spike-item" data-index="${i}" data-sec="${s.startSec ?? ''}" title="클릭하면 해당 시점으로 이동">
        ${s.thumbnail
          ? `<img class="spike-thumb" src="${s.thumbnail}" alt="미리보기" />`
          : `<div class="spike-thumb-empty">📷</div>`
        }
        <div class="spike-info">
          <span class="spike-time">▶ ${s.hms}${top3.has(i) ? ' <span class="spike-star">★</span>' : ''}</span>
          <span class="spike-count">${s.count}개/30s</span>
          <span class="spike-ratio">${s.ratio ? s.ratio + 'x' : ''} Z=${s.zScore}</span>
          <div class="spike-memo-wrap${s.memo ? ' has-memo' : ''}">
            <span class="spike-memo-icon">✏</span>
            <input class="spike-memo" type="text" placeholder="메모 추가..."
              value="${(s.memo || '').replace(/"/g, '&quot;')}"
              data-window-index="${s.windowIndex}"
              data-is-keyword="false" />
          </div>
        </div>
      </div>`
    )
    .join('');

  // 클릭 시 영상 해당 시점으로 이동 (메모 입력 클릭은 무시)
  spikeList.querySelectorAll('.spike-item[data-sec]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.spike-memo-wrap')) return;
      const sec = parseFloat(el.dataset.sec);
      if (isNaN(sec)) return;
      seekToTime(sec);
    });
  });
}

// ── Export helpers ────────────────────────────────────────────────────────────
function formatTxt(session) {
  const now = new Date().toLocaleString('ko-KR');

  // 볼륨 + 키워드 스파이크를 시간순으로 합치기
  const allSpikes = [
    ...session.spikes.map(s => ({ ...s, _type: '볼륨' })),
    ...(session.keywordSpikes || []).map(s => ({ ...s, _type: `키워드:${s.keyword}` })),
  ].sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));

  const lines = [
    '# 치지직 편집 포인트 | 채팅 급증 구간',
    `# 페이지 ID: ${session.pageId}  |  생성: ${now}`,
    '',
    ...allSpikes.map(
      (s) =>
        `${s.hms} [${s._type}] - ${s.count}${s._type === '볼륨' ? '개' : '회'}/30s${s.ratio ? ', 평균 대비 ' + s.ratio + 'x' : ''}, Z=${s.zScore}${s.memo ? ' // ' + s.memo : ''}`
    ),
  ];
  return lines.join('\n');
}

function formatCsv(session) {
  const header = 'type,keyword,timestamp_hms,timestamp_sec,chat_count,avg_count,spike_ratio,z_score,memo';

  const allSpikes = [
    ...session.spikes.map(s => ({ ...s, _type: '볼륨', _keyword: '' })),
    ...(session.keywordSpikes || []).map(s => ({ ...s, _type: '키워드', _keyword: s.keyword })),
  ].sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));

  const rows = allSpikes.map((s) =>
    [
      s._type,
      s._keyword,
      s.hms,
      s.startSec ?? '',
      s.count,
      s.mean ?? '',
      s.ratio ?? '',
      s.zScore,
      s.memo ? `"${s.memo.replace(/"/g, '""')}"` : '',
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Event listeners ────────────────────────────────────────────────────────────
btnTxt.addEventListener('click', () => {
  if (!currentSession) return;
  const ts = new Date().toISOString().slice(0, 10);
  downloadText(formatTxt(currentSession), `chzzk-spikes-${currentSession.pageId}-${ts}.txt`);
});

btnCsv.addEventListener('click', () => {
  if (!currentSession) return;
  const ts = new Date().toISOString().slice(0, 10);
  downloadText(formatCsv(currentSession), `chzzk-spikes-${currentSession.pageId}-${ts}.csv`);
});

btnClear.addEventListener('click', async () => {
  if (!currentPageId) return;
  await bgMessage({ type: 'CLEAR_SESSION', pageId: currentPageId });
  currentSession = null;
  renderSession(null);
  setStatus('세션 초기화 완료');
});

btnSave.addEventListener('click', async () => {
  const z = parseFloat(settingZ.value);
  const w = parseInt(settingWin.value, 10);
  if (isNaN(z) || isNaN(w)) return;
  await bgMessage({
    type: 'SAVE_SETTINGS',
    settings: { zThreshold: z, windowSize: w, saveThumbnail: settingThumbnail.checked },
  });
  setStatus('설정 저장됨');
});

btnClearThumbs.addEventListener('click', async () => {
  const res = await bgMessage({ type: 'CLEAR_THUMBNAILS' });
  setStatus(`📷 썸네일 ${res?.removed ?? 0}개 삭제 완료`);
  updateStorageBar();
  await refreshData();
});

// ── 메모 자동저장 (800ms 디바운스) ────────────────────────────────────────────
let memoSaveTimer = null;
spikeList.addEventListener('input', (e) => {
  const input = e.target;
  if (!input.classList.contains('spike-memo')) return;

  // has-memo 클래스 실시간 토글
  const wrap = input.closest('.spike-memo-wrap');
  if (wrap) wrap.classList.toggle('has-memo', input.value.length > 0);

  clearTimeout(memoSaveTimer);
  memoSaveTimer = setTimeout(async () => {
    if (!currentPageId) return;
    await bgMessage({
      type: 'SAVE_MEMO',
      pageId:      currentPageId,
      windowIndex: parseInt(input.dataset.windowIndex),
      memo:        input.value,
      isKeyword:   input.dataset.isKeyword === 'true',
      keyword:     input.dataset.keyword || null,
    });
  }, 800);
});

// ── 탭 전환 ───────────────────────────────────────────────────────────────────
tabVolume.addEventListener('click', () => {
  activeTab = 'volume';
  tabVolume.classList.add('active');
  tabKeyword.classList.remove('active');
  renderSession(currentSession);
});

tabKeyword.addEventListener('click', () => {
  activeTab = 'keyword';
  tabKeyword.classList.add('active');
  tabVolume.classList.remove('active');
  renderSession(currentSession);
});

// ── 키워드 관리 ───────────────────────────────────────────────────────────────
function renderKeywordTags() {
  keywordTagList.innerHTML = currentKeywords.map(kw => `
    <span class="keyword-tag">
      ${kw}
      <span class="keyword-tag-del" data-kw="${kw}">×</span>
    </span>
  `).join('');
  keywordTagList.querySelectorAll('.keyword-tag-del').forEach(el => {
    el.addEventListener('click', () => removeKeyword(el.dataset.kw));
  });
}

function isKoreanJamo(char) {
  const code = char.charCodeAt(0);
  return code >= 0x3130 && code <= 0x318F; // ㄱ~ㅣ 범위
}

function addKeyword(kw) {
  kw = kw.trim();
  if (!kw) return;
  if (kw.length === 1 && isKoreanJamo(kw)) {
    settingKeywordInput.value = '';
    settingKeywordInput.placeholder = 'ㅋ, ㅎ 등 단독 자음/모음은 등록 불가';
    setTimeout(() => { settingKeywordInput.placeholder = '키워드 입력 후 Enter 또는 추가'; }, 2000);
    return;
  }
  if (currentKeywords.includes(kw)) return;
  currentKeywords.push(kw);
  saveKeywords();
  renderKeywordTags();
}

function removeKeyword(kw) {
  currentKeywords = currentKeywords.filter(k => k !== kw);
  saveKeywords();
  renderKeywordTags();
}

async function saveKeywords() {
  await bgMessage({ type: 'SAVE_SETTINGS', settings: { keywords: currentKeywords } });
}

btnAddKeyword.addEventListener('click', () => {
  addKeyword(settingKeywordInput.value);
  settingKeywordInput.value = '';
});

settingKeywordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    addKeyword(settingKeywordInput.value);
    settingKeywordInput.value = '';
  }
});

// ── 키워드 스파이크 렌더 ──────────────────────────────────────────────────────
function renderKeywordSpikes(session) {
  const kSpikes = session?.keywordSpikes || [];

  if (!currentKeywords.length) {
    spikeList.innerHTML = '<div class="empty-msg">키워드를 추가하면<br>해당 단어의 급증 구간을 감지합니다.</div>';
    return;
  }

  if (kSpikes.length === 0) {
    spikeList.innerHTML = '<div class="empty-msg">키워드 급증 구간이 아직 없습니다.</div>';
    return;
  }

  // 시간순 정렬 (원본 배열 보존)
  const sortedKSpikes = [...kSpikes].sort((a, b) => {
    const aTime = a.startSec ?? a.startMs ?? 0;
    const bTime = b.startSec ?? b.startMs ?? 0;
    return aTime - bTime;
  });

  // Z-Score 상위 3개 인덱스 추출 (정렬 후 기준)
  const top3 = new Set(
    [...sortedKSpikes]
      .map((s, i) => ({ i, z: s.zScore }))
      .sort((a, b) => b.z - a.z)
      .slice(0, 3)
      .map(x => x.i)
  );

  spikeList.innerHTML = sortedKSpikes
    .map((s, i) => `
      <div class="spike-item" data-index="${i}" data-sec="${s.startSec ?? ''}" title="클릭하면 해당 시점으로 이동">
        <div class="keyword-badge">${s.keyword}</div>
        <div class="spike-info">
          <span class="spike-time">▶ ${s.hms}${top3.has(i) ? ' <span class="spike-star">★</span>' : ''}</span>
          <span class="spike-count">${s.count}회/30s</span>
          <span class="spike-ratio">${s.ratio ? s.ratio + 'x' : ''} Z=${s.zScore}</span>
          <div class="spike-memo-wrap${s.memo ? ' has-memo' : ''}">
            <span class="spike-memo-icon">✏</span>
            <input class="spike-memo" type="text" placeholder="메모 추가..."
              value="${(s.memo || '').replace(/"/g, '&quot;')}"
              data-window-index="${s.windowIndex}"
              data-is-keyword="true"
              data-keyword="${s.keyword}" />
          </div>
        </div>
      </div>`)
    .join('');

  spikeList.querySelectorAll('.spike-item[data-sec]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.spike-memo-wrap')) return;
      const sec = parseFloat(el.dataset.sec);
      if (!isNaN(sec)) seekToTime(sec);
    });
  });
}

// ── 영상 시점 이동 ────────────────────────────────────────────────────────────
async function seekToTime(sec) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return;

  chrome.tabs.sendMessage(tab.id, { type: 'SEEK_TO', sec });
  setStatus(`▶ ${secToHMS(sec)} 으로 이동`);
}

function secToHMS(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [h, m, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

// ── Background messaging ───────────────────────────────────────────────────────
function bgMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response);
    });
  });
}

// ── Status bar ────────────────────────────────────────────────────────────────
function setStatus(msg) {
  statusBar.textContent = msg;
}

// ── Auto-refresh every 5 seconds ──────────────────────────────────────────────
setInterval(refreshData, 5000);

// ── 팝업 열리면 뱃지 초기화 ───────────────────────────────────────────────────
chrome.action.setBadgeText({ text: '' });

// ── 후원 링크 ─────────────────────────────────────────────────────────────────
document.querySelector('.donate-btn').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://qr.kakaopay.com/FFSsYFjn3' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
