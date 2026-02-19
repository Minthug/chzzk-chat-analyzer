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
const settingZ    = document.getElementById('setting-z');
const settingWin  = document.getElementById('setting-window');
const btnSave     = document.getElementById('btn-save-settings');

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Load settings
  const res = await bgMessage({ type: 'GET_SETTINGS' });
  if (res?.settings) {
    settingZ.value   = res.settings.zThreshold ?? 3.0;
    settingWin.value = res.settings.windowSize  ?? 30;
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

  setStatus(`페이지 ID: ${currentPageId}`);
  await refreshData();
}

// ── Refresh session data from background ──────────────────────────────────────
async function refreshData() {
  const res = await bgMessage({ type: 'GET_SESSION_DATA', pageId: currentPageId });
  currentSession = res?.data || null;
  renderSession(currentSession);
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

  if (session.spikes.length > 0) {
    spikeBadge.classList.add('visible');
    btnTxt.disabled = false;
    btnCsv.disabled = false;
  } else {
    spikeBadge.classList.remove('visible');
    btnTxt.disabled = true;
    btnCsv.disabled = true;
  }

  if (session.spikes.length === 0) {
    spikeList.innerHTML = '<div class="empty-msg">아직 급증 구간이 감지되지 않았습니다.</div>';
    return;
  }

  spikeList.innerHTML = session.spikes
    .map(
      (s) => `
      <div class="spike-item">
        <span class="spike-time">${s.hms}</span>
        <span class="spike-count">${s.count}개/30s</span>
        <span class="spike-ratio">${s.ratio ? s.ratio + 'x' : ''} Z=${s.zScore}</span>
      </div>`
    )
    .join('');
}

// ── Export helpers ────────────────────────────────────────────────────────────
function formatTxt(session) {
  const now = new Date().toLocaleString('ko-KR');
  const lines = [
    '# 치지직 편집 포인트 | 채팅 급증 구간',
    `# 페이지 ID: ${session.pageId}  |  생성: ${now}`,
    '',
    ...session.spikes.map(
      (s) =>
        `${s.hms} - 채팅 급증 (30초 ${s.count}개${s.ratio ? ', 평균 대비 ' + s.ratio + 'x' : ''}, Z=${s.zScore})`
    ),
  ];
  return lines.join('\n');
}

function formatCsv(session) {
  const header = 'timestamp_hms,timestamp_sec,chat_count,avg_count,spike_ratio,z_score';
  const rows = session.spikes.map((s) =>
    [
      s.hms,
      s.startSec ?? '',
      s.count,
      s.mean ?? '',
      s.ratio ?? '',
      s.zScore,
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
  await bgMessage({ type: 'SAVE_SETTINGS', settings: { zThreshold: z, windowSize: w } });
  setStatus('설정 저장됨');
});

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

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
