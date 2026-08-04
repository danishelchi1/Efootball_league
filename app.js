/* ═══════════════════════════════════════════════════════
   FOOTBALL LEAGUE MANAGER — APP.JS
   Full SPA with LocalStorage, fixtures, standings & more
   ═══════════════════════════════════════════════════════ */

'use strict';

/* ─── Default Players (corrected names from real fixtures) ─── */
const DEFAULT_PLAYERS = [
  'Abdullah',       // idx 0
  'Danish Elchi',   // idx 1
  'Hamdan',         // idx 2
  'Tosif',          // idx 3  (was 'Touf')
  'Sami Sayyed',    // idx 4
  'Yasir',          // idx 5
  'As Afnan',       // idx 6
  'Danish Sheikh',  // idx 7
  'Abubakar Khokar',// idx 8  (was 'Abubakar Khoker')
  'Saani Asnain',   // idx 9  (was 'Sami Annan')
  'Suhaib',         // idx 10
  'Umar Khokar'     // idx 11 (was 'Umar Khoker')
];

/* ─── State version — bump this to force a migration ─── */
const STATE_VERSION = 2;

/* ─── State ─── */
let state = {
  leagueName: 'Football Premier League 2026',
  players: [...DEFAULT_PLAYERS],
  fixtures: [],          // [{round, id, home, away, homeScore, awayScore, played, locked, note, timestamp}]
  scorers: {},           // {playerName: {goals, assists}}
  lockedRounds: {},      // {roundNum: true}
  theme: 'dark',
  activity: [],          // [{text, icon, time}]
  undoStack: []          // for undo
};

let currentNotesMatchId = null;

/* ═══════════════════════════════════════
   ADMIN AUTH — PIN-based access control
   ‣ PIN is hashed (djb2) and stored in localStorage.
   ‣ Logged-in session lives in sessionStorage only
     (auto-expires when the tab/browser closes).
   ‣ Default PIN on first launch: 1234
     Change it immediately from the Admin Panel → Change PIN.
═══════════════════════════════════════ */
const ADMIN_SESSION_KEY = 'flm_admin';
const ADMIN_PIN_STORAGE = 'flm_admin_pin';

function hashPin(pin) {
  let h = 5381;
  for (let i = 0; i < pin.length; i++) {
    h = Math.imul(h, 33) ^ pin.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function getStoredPinHash() {
  // Default PIN hash = hashPin('7248944444')
  return localStorage.getItem(ADMIN_PIN_STORAGE) || 'e2m1j5';
}

function isAdmin() {
  return sessionStorage.getItem(ADMIN_SESSION_KEY) === 'true';
}

function adminLogin(pin) {
  if (hashPin(pin) === getStoredPinHash()) {
    sessionStorage.setItem(ADMIN_SESSION_KEY, 'true');
    updateAdminUI();
    return true;
  }
  return false;
}

function adminLogout() {
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  updateAdminUI();
  renderAll();
  showToast('Logged out 🔒');
}

/* Show / hide the floating admin badge */
function updateAdminUI() {
  const badge = document.getElementById('admin-badge');
  if (!badge) return;
  if (isAdmin()) {
    badge.textContent = '🟢 Admin';
    badge.classList.add('admin-active');
    badge.onclick = () => {
      if (confirm('Log out of admin mode?')) adminLogout();
    };
    badge.title = 'Click to log out';
  } else {
    badge.textContent = '🔑 Admin Login';
    badge.classList.remove('admin-active');
    badge.onclick = () => openAdminLogin();
    badge.title = 'Log in as admin to edit results';
  }
}

function openAdminLogin(afterLoginCallback) {
  window._adminCallback = afterLoginCallback || null;
  document.getElementById('admin-pin-input').value = '';
  document.getElementById('admin-login-error').textContent = '';
  openModal('modal-admin-login');
  setTimeout(() => document.getElementById('admin-pin-input').focus(), 100);
}

function submitAdminLogin() {
  const pin = document.getElementById('admin-pin-input').value;
  if (!pin) return;
  if (adminLogin(pin)) {
    closeModal('modal-admin-login');
    showToast('Welcome, Admin! 🟢');
    renderAll();
    if (window._adminCallback) {
      window._adminCallback();
      window._adminCallback = null;
    }
  } else {
    document.getElementById('admin-login-error').textContent = '❌ Wrong PIN. Try again.';
    document.getElementById('admin-pin-input').value = '';
    document.getElementById('admin-pin-input').focus();
  }
}

function requireAdmin(callback) {
  if (isAdmin()) { callback(); }
  else { openAdminLogin(callback); }
}

function changePIN() {
  requireAdmin(() => {
    const current = prompt('Enter your CURRENT PIN:');
    if (!current) return;
    if (hashPin(current) !== getStoredPinHash()) {
      showToast('Wrong current PIN!', true); return;
    }
    const newPin = prompt('Enter your NEW PIN (min 4 characters):');
    if (!newPin || newPin.length < 4) {
      showToast('PIN must be at least 4 characters!', true); return;
    }
    const confirm2 = prompt('Confirm your NEW PIN:');
    if (newPin !== confirm2) {
      showToast('PINs do not match!', true); return;
    }
    localStorage.setItem(ADMIN_PIN_STORAGE, hashPin(newPin));
    showToast('PIN changed successfully! 🔐');
  });
}

/* ═══════════════════════════════════════
   INIT
═══════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  loadState();
  // If state is fresh or outdated, regenerate fixtures and seed results
  if (!state.fixtures.length) {
    generateFixtures();
    seedRound1And2Results();
    saveLocalOnly();
  }
  renderAll();
  buildRoundFilter();
  populateScorerSelect();
  populateRenameList();
  setAdminLeagueName();
  updateAdminUI();
  checkWinner();

  // Allow Enter key in admin PIN modal
  document.getElementById('admin-pin-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitAdminLogin();
  });

  // ── Cloud sync: fetch latest on load, then poll every 30 s ──
  fetchCloudData(true);
  startSyncPolling();
});

/* ═══════════════════════════════════════
   LOCAL STORAGE
═══════════════════════════════════════ */
function saveLocalOnly() {
  try { localStorage.setItem('flm_state', JSON.stringify(state)); } catch(e) {}
}
/** saveState = local + cloud push (if admin + token set) */
function saveState() {
  saveLocalOnly();
  if (isAdmin() && getSyncToken()) pushCloudData();
}
function loadState() {
  try {
    const raw = localStorage.getItem('flm_state');
    if (raw) {
      const saved = JSON.parse(raw);
      if (!saved._v || saved._v < STATE_VERSION) {
        console.log('🔄 State version mismatch — resetting to v' + STATE_VERSION);
        state = getDefaultState();
        if (saved.theme) state.theme = saved.theme;
      } else {
        state = { ...state, ...saved };
      }
    }
  } catch(e) { state = getDefaultState(); }
  applyTheme();
}
function getDefaultState() {
  return {
    _v: STATE_VERSION,
    leagueName: 'Football Premier League 2026',
    players: [...DEFAULT_PLAYERS],
    fixtures: [], scorers: {}, lockedRounds: {},
    theme: 'dark', activity: [], undoStack: []
  };
}

/* ═══════════════════════════════════════
   CLOUD SYNC — GitHub as database
   ‣ READ  : raw.githubusercontent.com (public, no auth)
             → all 12 players auto-fetch every 30 s
   ‣ WRITE : GitHub REST API with Admin's PAT
             → only Admin device pushes data.json
   ‣ PAT is stored ONLY in Admin's own localStorage
             → never embedded in source code
═══════════════════════════════════════ */
const CLOUD_OWNER      = 'danishelchi1';
const CLOUD_REPO       = 'Efootball_league';
const CLOUD_FILE       = 'data.json';
const SYNC_TOKEN_STORE = 'flm_gh_token';
// Fields that are shared across all devices (theme/undoStack are local-only)
const SYNC_FIELDS = ['_v','leagueName','players','fixtures','scorers','lockedRounds','activity'];

let _syncPollTimer = null;

function getSyncToken() {
  return localStorage.getItem(SYNC_TOKEN_STORE) || '';
}
function setSyncTokenUI() {
  const inp = document.getElementById('sync-token-input');
  const tok = inp ? inp.value.trim() : '';
  if (!tok.startsWith('ghp_') && !tok.startsWith('github_pat_')) {
    showToast('Invalid token format!', true); return;
  }
  localStorage.setItem(SYNC_TOKEN_STORE, tok);
  if (inp) inp.value = '';
  showToast('Sync token saved! ☁️');
  // Immediately push current state
  pushCloudData();
}

function setSyncStatus(status) {
  const btn   = document.getElementById('sync-btn');
  const badge = document.getElementById('sync-badge');
  const states = {
    syncing: { text: '🔄', title: 'Syncing…',    cls: 'badge-syncing' },
    ok:      { text: '☁️', title: 'Cloud synced', cls: 'badge-ok'      },
    error:   { text: '⚠️', title: 'Sync error',   cls: 'badge-error'   },
    idle:    { text: '☁️', title: 'Cloud sync',   cls: 'badge-idle'    },
  };
  const s = states[status] || states.idle;
  if (btn) { btn.textContent = s.text; btn.title = s.title; }
  if (badge) {
    badge.className = `sync-badge ${s.cls}`;
    badge.textContent = s.title;
  }
}

async function fetchCloudData(silent = false) {
  setSyncStatus('syncing');
  try {
    const url = `https://raw.githubusercontent.com/${CLOUD_OWNER}/${CLOUD_REPO}/main/${CLOUD_FILE}?t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cloud = await res.json();

    if (!cloud || !cloud._v || !Array.isArray(cloud.fixtures)) {
      setSyncStatus('idle'); return;
    }

    // Find newest played-match timestamp in cloud vs local
    const ts = arr => Math.max(0, ...arr.filter(f => f.played && f.timestamp).map(f => f.timestamp));
    const cloudTs = ts(cloud.fixtures);
    const localTs = ts(state.fixtures);

    // Non-admins ALWAYS take cloud; Admin only takes cloud if it's newer
    if (!isAdmin() || cloudTs > localTs) {
      const savedTheme = state.theme;
      SYNC_FIELDS.forEach(k => { if (cloud[k] !== undefined) state[k] = cloud[k]; });
      state.theme = savedTheme;  // keep device theme
      saveLocalOnly();
      renderAll();
      buildRoundFilter();
      populateScorerSelect();
    }
    setSyncStatus('ok');
    if (!silent) showToast('Synced from cloud ☁️');
  } catch(e) {
    setSyncStatus('error');
    if (!silent) showToast('Cloud sync failed — check connection', true);
    console.warn('fetchCloudData error:', e);
  }
}

async function pushCloudData() {
  const token = getSyncToken();
  if (!token) return;   // No token on this device — skip push
  setSyncStatus('syncing');
  try {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
    const apiUrl = `https://api.github.com/repos/${CLOUD_OWNER}/${CLOUD_REPO}/contents/${CLOUD_FILE}`;

    // Get current SHA (required by GitHub API for updates)
    const shaRes  = await fetch(apiUrl, { headers });
    const shaJson = await shaRes.json();
    const sha     = shaJson.sha;

    // Build payload (only sync fields, skip theme/undoStack)
    const payload = {};
    SYNC_FIELDS.forEach(k => { payload[k] = state[k]; });
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));

    const putRes = await fetch(apiUrl, {
      method: 'PUT', headers,
      body: JSON.stringify({
        message: `sync: match update ${new Date().toISOString().slice(0,16)}`,
        content, sha, branch: 'main'
      })
    });
    if (!putRes.ok) {
      const err = await putRes.json();
      throw new Error(err.message || putRes.status);
    }
    setSyncStatus('ok');
    showToast('Saved & synced to cloud ☁️');
  } catch(e) {
    setSyncStatus('error');
    console.error('pushCloudData error:', e);
    showToast('Saved locally — cloud push failed ⚠️', true);
  }
}

function manualSync() {
  fetchCloudData(false);
}

function startSyncPolling() {
  if (_syncPollTimer) clearInterval(_syncPollTimer);
  // Poll every 30 seconds
  _syncPollTimer = setInterval(() => fetchCloudData(true), 30000);
  // Refresh on tab focus (e.g. player switches from another tab/app)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchCloudData(true);
  });
}

/* ═══════════════════════════════════════
   FIXTURE GENERATION — Circle Method
   Circle order derived from real fixture schedule so that the
   generated pairs exactly match the user's fixture list.

   Real R1 pairs:
     As Afnan–Yasir | Danish Sheikh–Abdullah | Umar Khokar–Abubakar Khokar
     Hamdan–Danish Elchi | Sami Sayyed–Suhaib | Tosif–Saani Asnain

   Circle order (by player index in DEFAULT_PLAYERS):
     [6=AsAfnan, 7=DanishSheikh, 11=UmarKhokar, 2=Hamdan,
      4=SamiSayyed, 3=Tosif, 9=SaaniAsnain, 10=Suhaib,
      1=DanishElchi, 8=AbubakarKhokar, 0=Abdullah, 5=Yasir]
═══════════════════════════════════════ */
function generateFixtures() {
  const n = state.players.length; // 12
  const rounds = n - 1;           // 11
  const matchesPerRound = n / 2;  // 6

  // Circle order aligned to produce real fixture pairs
  const circleOrder = [6, 7, 11, 2, 4, 3, 9, 10, 1, 8, 0, 5];
  const teams = [...circleOrder];
  const fixtures = [];
  let id = 1;

  for (let round = 0; round < rounds; round++) {
    for (let m = 0; m < matchesPerRound; m++) {
      const home = teams[m];
      const away = teams[n - 1 - m];
      fixtures.push({
        id: id++,
        round: round + 1,
        home: home,
        away: away,
        homeScore: null,
        awayScore: null,
        played: false,
        locked: false,
        note: '',
        timestamp: null
      });
    }
    // Rotate all elements except the first (classic circle method)
    const last = teams.pop();
    teams.splice(1, 0, last);
  }
  state.fixtures = fixtures;
  // Don't call saveState here — caller decides when to save
}

/* ─── Seed Round 1 & Round 2 real results ─── */
function seedRound1And2Results() {
  // Each entry: {home: playerIdx, away: playerIdx, homeScore, awayScore}
  // Scores are expressed from the perspective of whichever player the
  // circle method assigns as 'home' in the generated fixture.
  //
  // Round 1
  //  Fixture home→away           User result          Stored as
  //  As Afnan   vs Yasir          0-8 (Yasir win)      0–8
  //  Danish Sheikh vs Abdullah    5-3 (DSheikh win)    5–3
  //  Umar Khokar vs AbubakarK    4-4 (Draw)           4–4
  //  Hamdan vs Danish Elchi       1-2 (DElchi win)     1–2
  //  Sami Sayyed vs Suhaib        1-6 (Suhaib win)     1–6
  //  Tosif vs Saani Asnain        1-0 (Tosif win)      1–0
  //
  // Round 2
  //  As Afnan vs Abdullah         0-8 (Abdullah win)   0–8
  //  Yasir vs Abubakar Khokar     3-2 (Yasir win)      3–2
  //  Danish Sheikh vs Danish Elchi 2-1 (DSheikh win)   2–1
  //  Umar Khokar vs Suhaib        7-6 (UmarK win)      7–6
  //  Hamdan vs Saani Asnain       5-2 (Hamdan win)     5–2
  //  Sami Sayyed vs Tosif         3-1 (SamiS win)      3–1
  const seeds = [
    { home: 6,  away: 5,  homeScore: 0, awayScore: 8 },  // R1: As Afnan vs Yasir
    { home: 7,  away: 0,  homeScore: 5, awayScore: 3 },  // R1: Danish Sheikh vs Abdullah
    { home: 11, away: 8,  homeScore: 4, awayScore: 4 },  // R1: Umar Khokar vs Abubakar Khokar
    { home: 2,  away: 1,  homeScore: 1, awayScore: 2 },  // R1: Hamdan vs Danish Elchi
    { home: 4,  away: 10, homeScore: 1, awayScore: 6 },  // R1: Sami Sayyed vs Suhaib
    { home: 3,  away: 9,  homeScore: 1, awayScore: 0 },  // R1: Tosif vs Saani Asnain
    { home: 6,  away: 0,  homeScore: 0, awayScore: 8 },  // R2: As Afnan vs Abdullah
    { home: 5,  away: 8,  homeScore: 3, awayScore: 2 },  // R2: Yasir vs Abubakar Khokar
    { home: 7,  away: 1,  homeScore: 2, awayScore: 1 },  // R2: Danish Sheikh vs Danish Elchi
    { home: 11, away: 10, homeScore: 7, awayScore: 6 },  // R2: Umar Khokar vs Suhaib
    { home: 2,  away: 9,  homeScore: 5, awayScore: 2 },  // R2: Hamdan vs Saani Asnain
    { home: 4,  away: 3,  homeScore: 3, awayScore: 1 },  // R2: Sami Sayyed vs Tosif
  ];

  const now = Date.now();
  seeds.forEach((s, i) => {
    const f = state.fixtures.find(f => f.home === s.home && f.away === s.away);
    if (f) {
      f.homeScore  = s.homeScore;
      f.awayScore  = s.awayScore;
      f.played     = true;
      f.timestamp  = now - (seeds.length - i) * 120000; // stagger timestamps
    } else {
      console.warn('Seed: fixture not found', s);
    }
  });

  // Build activity feed from seeded results
  const pn = (idx) => state.players[idx] || 'Player';
  seeds.forEach(s => {
    const result = s.homeScore > s.awayScore ? pn(s.home) + ' wins'
                 : s.awayScore > s.homeScore ? pn(s.away) + ' wins'
                 : 'Draw';
    addActivity(
      `R${state.fixtures.find(f=>f.home===s.home&&f.away===s.away)?.round||'?'}: ` +
      `<b>${pn(s.home)}</b> ${s.homeScore}–${s.awayScore} <b>${pn(s.away)}</b> — ${result}`, '⚽'
    );
  });
}

function regenerateFixtures() {
  if (!confirm('⚠️ This will RESET all scores and regenerate fixtures. Continue?')) return;
  pushUndo('regenerate');
  state.fixtures = [];
  state.lockedRounds = {};
  generateFixtures();
  renderAll();
  showToast('Fixtures regenerated! 🔄');
}

/* ═══════════════════════════════════════
   THEME
═══════════════════════════════════════ */
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  saveState();
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = state.theme === 'dark' ? '☀️' : '🌙';
}

/* ═══════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════ */
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('section-' + name);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.section === name);
  });

  // Re-render relevant sections
  if (name === 'dashboard') renderDashboard();
  if (name === 'fixtures') renderFixtures();
  if (name === 'table') renderTable();
  if (name === 'stats') renderStats();
  if (name === 'players') renderPlayers();
  if (name === 'admin') { populateRenameList(); setAdminLeagueName(); }
}

/* ═══════════════════════════════════════
   RENDER ALL
═══════════════════════════════════════ */
function renderAll() {
  document.getElementById('league-name-display').textContent = state.leagueName;
  renderDashboard();
  renderFixtures();
  renderTable();
  renderStats();
  renderPlayers();
}

/* ═══════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════ */
function renderDashboard() {
  const played = state.fixtures.filter(f => f.played);
  const total = state.fixtures.length;
  const remaining = total - played.length;
  const pct = Math.round((played.length / total) * 100);
  const totalGoals = played.reduce((s, f) => s + f.homeScore + f.awayScore, 0);
  const gpm = played.length ? (totalGoals / played.length).toFixed(1) : '0.0';

  // Determine current round
  let currentRound = 1;
  for (let r = 1; r <= 11; r++) {
    const roundMatches = state.fixtures.filter(f => f.round === r);
    const allPlayed = roundMatches.every(f => f.played);
    if (!allPlayed) { currentRound = r; break; }
    if (r === 11 && allPlayed) currentRound = 11;
  }

  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-text').textContent = pct + '%';
  document.getElementById('dash-round').innerHTML = `Round <b>${currentRound}</b> of 11`;
  document.getElementById('dash-matches-played').innerHTML = `<b>${played.length}</b> Played`;
  document.getElementById('dash-matches-remaining').innerHTML = `<b>${remaining}</b> Remaining`;
  document.getElementById('dash-total-played').textContent = played.length;
  document.getElementById('dash-remaining').textContent = remaining;
  document.getElementById('dash-total-goals').textContent = totalGoals;
  document.getElementById('dash-avg-goals').textContent = gpm;

  renderTop3();
  renderLast5();
  renderActivityFeed();
}

function renderTop3() {
  const table = computeTable();
  const container = document.getElementById('top3-container');
  if (!table.length || !table.some(r => r.played > 0)) {
    container.innerHTML = '<div class="top3-empty">No matches played yet</div>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const posClasses = ['pos-1', 'pos-2', 'pos-3'];
  container.innerHTML = table.slice(0, 3).map((row, i) => `
    <div class="top3-card ${posClasses[i]}" onclick="openPlayer('${esc(row.name)}')">
      <span class="top3-medal">${medals[i]}</span>
      <div class="top3-name">${esc(row.name)}</div>
      <div class="top3-pts">${row.pts}</div>
      <div class="top3-pts-label">pts</div>
      <div class="top3-meta">${row.w}W ${row.d}D ${row.l}L | GD ${row.gd >= 0 ? '+' : ''}${row.gd}</div>
    </div>
  `).join('');
}

function renderLast5() {
  const played = state.fixtures.filter(f => f.played)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 5);
  const container = document.getElementById('last5-matches');
  if (!played.length) {
    container.innerHTML = '<div class="empty-state">No completed matches yet</div>';
    return;
  }
  container.innerHTML = played.map(f => {
    const homeName = state.players[f.home] || 'Unknown';
    const awayName = state.players[f.away] || 'Unknown';
    return `
      <div class="match-result-item">
        <span class="match-home">${esc(homeName)}</span>
        <span class="match-score">${f.homeScore} – ${f.awayScore}</span>
        <span class="match-away">${esc(awayName)}</span>
        <span class="match-round-badge">R${f.round}</span>
      </div>`;
  }).join('');
}

function renderActivityFeed() {
  const container = document.getElementById('recent-activity');
  if (!state.activity.length) {
    container.innerHTML = '<div class="activity-empty">No activity yet. Enter some match results!</div>';
    return;
  }
  container.innerHTML = state.activity.slice(0, 10).map(a => `
    <div class="activity-item">
      <span class="activity-icon">${a.icon}</span>
      <span class="activity-text">${a.text}</span>
      <span class="activity-time">${formatTime(a.time)}</span>
    </div>`).join('');
}

function addActivity(text, icon = '⚽') {
  state.activity.unshift({ text, icon, time: Date.now() });
  if (state.activity.length > 50) state.activity.pop();
}

function formatTime(ts) {
  const now = Date.now();
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

/* ═══════════════════════════════════════
   FIXTURES RENDER
═══════════════════════════════════════ */
function renderFixtures(filter = 'all') {
  const container = document.getElementById('fixtures-container');
  const rounds = filter === 'all'
    ? [...Array(11)].map((_, i) => i + 1)
    : [parseInt(filter)];

  container.innerHTML = rounds.map(r => renderRound(r)).join('');
}

function renderRound(roundNum) {
  const matches = state.fixtures.filter(f => f.round === roundNum);
  const playedCount = matches.filter(f => f.played).length;
  const isLocked = state.lockedRounds[roundNum];
  const lockIcon = isLocked ? '🔒' : '🔓';
  const lockLabel = isLocked ? 'Locked' : 'Lock';

  const matchesHTML = matches.map(f => renderFixtureCard(f)).join('');
  return `
    <div class="round-block" id="round-${roundNum}">
      <div class="round-header">
        <span class="round-title">Round ${roundNum}</span>
        <span class="round-stats">${playedCount}/${matches.length} played</span>
        <button class="round-lock-btn" onclick="requireAdmin(()=>toggleLockRound(${roundNum}))">${lockIcon} ${lockLabel}</button>
      </div>
      ${matchesHTML}
    </div>`;
}

function renderFixtureCard(f) {
  const homeName = esc(state.players[f.home] || 'Player ' + (f.home + 1));
  const awayName = esc(state.players[f.away] || 'Player ' + (f.away + 1));
  const isLocked = state.lockedRounds[f.round];
  const lockedClass = isLocked ? ' locked' : '';

  const homeVal = f.homeScore !== null ? f.homeScore : '';
  const awayVal = f.awayScore !== null ? f.awayScore : '';
  const statusClass = f.played ? 'completed' : 'not-played';
  const statusText = f.played ? '✅ Completed' : '⏳ Not Played';
  const notePreview = f.note ? `📝 ${esc(f.note.substring(0, 40))}${f.note.length > 40 ? '…' : ''}` : '';

  const adminDisabled = !isAdmin() || isLocked;
  const adminHint = !isAdmin() ? ' title="Log in as admin to edit"' : '';

  return `
    <div class="fixture-card${lockedClass}" id="fixture-${f.id}">
      <div class="fixture-row">
        <span class="fixture-player home">${homeName}</span>
        <div class="score-inputs">
          <input type="number" class="score-input" id="hs-${f.id}" value="${homeVal}"
            min="0" max="99" placeholder="–" ${adminDisabled ? 'disabled' : ''}
            onkeydown="if(event.key==='Enter') requireAdmin(()=>saveResult(${f.id}))">
          <span class="score-dash">–</span>
          <input type="number" class="score-input" id="as-${f.id}" value="${awayVal}"
            min="0" max="99" placeholder="–" ${adminDisabled ? 'disabled' : ''}
            onkeydown="if(event.key==='Enter') requireAdmin(()=>saveResult(${f.id}))">
        </div>
        <span class="fixture-player away">${awayName}</span>
      </div>
      <div class="fixture-actions">
        <span class="fixture-status ${statusClass}">${statusText}</span>
        ${notePreview ? `<span class="fixture-note-preview">${notePreview}</span>` : ''}
        <button class="save-btn" onclick="requireAdmin(()=>saveResult(${f.id}))" ${isLocked ? 'disabled' : ''}${adminHint}>
          ${isAdmin() ? '💾 Save' : '🔒 Save'}
        </button>
        ${f.played ? `<button class="delete-btn" onclick="requireAdmin(()=>deleteResult(${f.id}))" ${isLocked ? 'disabled' : ''}${adminHint}>🗑️</button>` : ''}
        <button class="notes-btn" onclick="requireAdmin(()=>openNotes(${f.id}))" ${isLocked ? 'disabled' : ''}${adminHint}>📝</button>
      </div>
    </div>`;
}

function refreshFixtureCard(id) {
  const f = state.fixtures.find(x => x.id === id);
  if (!f) return;
  const el = document.getElementById('fixture-' + id);
  if (!el) return;
  el.outerHTML = renderFixtureCard(f);
}

/* ─── Save Result (admin only) ─── */
function saveResult(id) {
  if (!isAdmin()) { requireAdmin(() => saveResult(id)); return; }
  const f = state.fixtures.find(x => x.id === id);
  if (!f) return;
  if (state.lockedRounds[f.round]) { showToast('Round is locked! 🔒', true); return; }

  const hsEl = document.getElementById('hs-' + id);
  const asEl = document.getElementById('as-' + id);
  const hs = hsEl ? hsEl.value : '';
  const as_ = asEl ? asEl.value : '';

  if (hs === '' || as_ === '') { showToast('Enter both scores!', true); return; }
  const hScore = parseInt(hs);
  const aScore = parseInt(as_);
  if (isNaN(hScore) || isNaN(aScore) || hScore < 0 || aScore < 0) {
    showToast('Invalid scores!', true); return;
  }

  // Undo
  pushUndo('edit', JSON.parse(JSON.stringify(f)));

  const wasPlayed = f.played;
  f.homeScore = hScore;
  f.awayScore = aScore;
  f.played = true;
  f.timestamp = Date.now();

  const homeName = state.players[f.home];
  const awayName = state.players[f.away];
  const result = `<b>${homeName}</b> ${hScore}–${aScore} <b>${awayName}</b>`;
  addActivity(`R${f.round}: ${result} saved`, '⚽');

  saveState();
  refreshFixtureCard(id);
  renderTable();
  renderDashboard();
  renderStats();
  showToast(wasPlayed ? 'Result updated! ✏️' : 'Result saved! ✅');
  checkWinner();
}

/* ─── Delete Result (admin only) ─── */
function deleteResult(id) {
  if (!isAdmin()) { requireAdmin(() => deleteResult(id)); return; }
  const f = state.fixtures.find(x => x.id === id);
  if (!f) return;
  if (!confirm('Delete this result?')) return;

  pushUndo('delete', JSON.parse(JSON.stringify(f)));

  f.homeScore = null; f.awayScore = null;
  f.played = false; f.timestamp = null;

  addActivity(`Result deleted: R${f.round} ${state.players[f.home]} vs ${state.players[f.away]}`, '🗑️');

  saveState();
  refreshFixtureCard(id);
  renderTable();
  renderDashboard();
  renderStats();
  showToast('Result deleted 🗑️');
}

/* ─── Lock Rounds (admin only) ─── */
function toggleLockRound(roundNum) {
  if (!isAdmin()) { requireAdmin(() => toggleLockRound(roundNum)); return; }
  state.lockedRounds[roundNum] = !state.lockedRounds[roundNum];
  saveState();
  renderFixtures(document.getElementById('round-filter')?.value || 'all');
  showToast(state.lockedRounds[roundNum] ? `Round ${roundNum} locked 🔒` : `Round ${roundNum} unlocked 🔓`);
}

/* ─── Round Filter ─── */
function buildRoundFilter() {
  const sel = document.getElementById('round-filter');
  if (!sel) return;
  sel.innerHTML = '<option value="all">All Rounds</option>';
  for (let r = 1; r <= 11; r++) {
    sel.innerHTML += `<option value="${r}">Round ${r}</option>`;
  }
}
function filterRound(val) {
  renderFixtures(val);
}

/* ═══════════════════════════════════════
   LEAGUE TABLE
═══════════════════════════════════════ */
function computeTable() {
  const rows = state.players.map((name, idx) => ({
    idx, name, played: 0, w: 0, d: 0, l: 0,
    gf: 0, ga: 0, gd: 0, pts: 0
  }));

  state.fixtures.filter(f => f.played).forEach(f => {
    const h = rows[f.home];
    const a = rows[f.away];
    if (!h || !a) return;

    h.played++; a.played++;
    h.gf += f.homeScore; h.ga += f.awayScore;
    a.gf += f.awayScore; a.ga += f.homeScore;

    if (f.homeScore > f.awayScore) {
      h.w++; h.pts += 3; a.l++;
    } else if (f.homeScore < f.awayScore) {
      a.w++; a.pts += 3; h.l++;
    } else {
      h.d++; h.pts++; a.d++; a.pts++;
    }
  });

  rows.forEach(r => { r.gd = r.gf - r.ga; });

  rows.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.gd !== a.gd) return b.gd - a.gd;
    if (b.gf !== a.gf) return b.gf - a.gf;
    // Head-to-head
    const h2h = getHeadToHead(a.idx, b.idx);
    if (h2h !== 0) return h2h;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

function getHeadToHead(idxA, idxB) {
  const match = state.fixtures.find(f =>
    f.played &&
    ((f.home === idxA && f.away === idxB) || (f.home === idxB && f.away === idxA))
  );
  if (!match) return 0;
  if (match.home === idxA) {
    if (match.homeScore > match.awayScore) return -1;
    if (match.homeScore < match.awayScore) return 1;
  } else {
    if (match.awayScore > match.homeScore) return -1;
    if (match.awayScore < match.homeScore) return 1;
  }
  return 0;
}

function renderTable() {
  const table = computeTable();
  const tbody = document.getElementById('table-body');
  if (!tbody) return;
  if (!table.some(r => r.played > 0)) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No results yet – enter match scores in Fixtures</td></tr>';
    return;
  }

  tbody.innerHTML = table.map((row, i) => {
    const pos = i + 1;
    let rankClass = '';
    let badgeClass = 'rank-other';
    if (pos === 1) { rankClass = 'rank-1'; badgeClass = 'rank-1'; }
    else if (pos === 2) { rankClass = 'rank-2'; badgeClass = 'rank-2'; }
    else if (pos === 3) { rankClass = 'rank-3'; badgeClass = 'rank-3'; }

    const gdStr = row.gd > 0 ? `<span class="gd-pos">+${row.gd}</span>`
                : row.gd < 0 ? `<span class="gd-neg">${row.gd}</span>`
                : `<span class="gd-zero">0</span>`;

    return `<tr class="${rankClass}">
      <td><span class="rank-badge ${badgeClass}">${pos}</span></td>
      <td class="player-col">
        <span class="player-name-cell" onclick="openPlayer('${esc(row.name)}')">${esc(row.name)}</span>
      </td>
      <td>${row.played}</td>
      <td>${row.w}</td>
      <td>${row.d}</td>
      <td>${row.l}</td>
      <td>${row.gf}</td>
      <td>${row.ga}</td>
      <td>${gdStr}</td>
      <td class="pts-cell">${row.pts}</td>
    </tr>`;
  }).join('');
}

/* ═══════════════════════════════════════
   STATISTICS
═══════════════════════════════════════ */
function renderStats() {
  const played = state.fixtures.filter(f => f.played);
  const totalGoals = played.reduce((s, f) => s + f.homeScore + f.awayScore, 0);
  const gpm = played.length ? (totalGoals / played.length).toFixed(2) : '0.00';
  const totalWins = played.reduce((s, f) => s + (f.homeScore !== f.awayScore ? 1 : 0), 0);
  const totalDraws = played.reduce((s, f) => s + (f.homeScore === f.awayScore ? 1 : 0), 0);

  setEl('stat-total-goals', totalGoals);
  setEl('stat-gpm', gpm);
  setEl('stat-played', played.length);
  setEl('stat-wins', totalWins);
  setEl('stat-draws', totalDraws);

  renderTopScorers();
  renderCleanSheets();
  renderMostWins();
  renderBiggestVictory();
  renderHighestScoring();
  renderStreaks();
}

function renderTopScorers() {
  const container = document.getElementById('top-scorers-list');
  if (!container) return;

  // Combine manual scorers with computed goals from match totals
  const table = computeTable();
  const manualScorers = state.scorers || {};

  const list = state.players.map((name, idx) => {
    const row = table.find(r => r.idx === idx);
    const manual = manualScorers[name] || {};
    return {
      name,
      goals: manual.goals !== undefined ? manual.goals : 0,
      assists: manual.assists !== undefined ? manual.assists : 0
    };
  }).filter(s => s.goals > 0 || s.assists > 0)
    .sort((a, b) => b.goals - a.goals || b.assists - a.assists);

  if (!list.length) {
    container.innerHTML = '<div class="mini-item"><span class="mini-name" style="color:var(--text3)">No goal data yet. Use the form below.</span></div>';
    return;
  }

  container.innerHTML = list.map((s, i) => `
    <div class="scorer-item">
      <span class="scorer-pos">${i + 1}</span>
      <span class="scorer-name">${esc(s.name)}</span>
      <span>
        <span class="scorer-stat">${s.goals}</span>
        <span class="scorer-label"> ⚽</span>
      </span>
      <span>
        <span class="scorer-stat" style="color:var(--blue-light)">${s.assists}</span>
        <span class="scorer-label"> 🎯</span>
      </span>
    </div>`).join('');
}

function saveScorer() {
  if (!isAdmin()) { requireAdmin(() => saveScorer()); return; }
  const player = document.getElementById('scorer-player').value;
  const goals = parseInt(document.getElementById('scorer-goals').value) || 0;
  const assists = parseInt(document.getElementById('scorer-assists').value) || 0;
  if (!player) { showToast('Select a player!', true); return; }
  if (!state.scorers) state.scorers = {};
  state.scorers[player] = { goals, assists };
  addActivity(`Updated stats for ${player}: ${goals}⚽ ${assists}🎯`, '📊');
  saveState();
  renderStats();
  showToast('Stats saved! 📊');
}

function populateScorerSelect() {
  const sel = document.getElementById('scorer-player');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select Player</option>';
  state.players.forEach(p => {
    sel.innerHTML += `<option value="${esc(p)}">${esc(p)}</option>`;
  });
}

function renderCleanSheets() {
  const container = document.getElementById('clean-sheets-list');
  if (!container) return;
  const counts = {};
  state.fixtures.filter(f => f.played).forEach(f => {
    const hName = state.players[f.home];
    const aName = state.players[f.away];
    if (f.awayScore === 0) counts[hName] = (counts[hName] || 0) + 1;
    if (f.homeScore === 0) counts[aName] = (counts[aName] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!sorted.length) { container.innerHTML = '<div class="mini-item"><span class="mini-name" style="color:var(--text3)">No data yet</span></div>'; return; }
  container.innerHTML = sorted.map(([name, val], i) => `
    <div class="mini-item">
      <span class="mini-rank">${i + 1}</span>
      <span class="mini-name">${esc(name)}</span>
      <span class="mini-val">${val}</span>
    </div>`).join('');
}

function renderMostWins() {
  const container = document.getElementById('most-wins-list');
  if (!container) return;
  const table = computeTable();
  const sorted = table.filter(r => r.w > 0).sort((a, b) => b.w - a.w).slice(0, 5);
  if (!sorted.length) { container.innerHTML = '<div class="mini-item"><span class="mini-name" style="color:var(--text3)">No data yet</span></div>'; return; }
  container.innerHTML = sorted.map((r, i) => `
    <div class="mini-item">
      <span class="mini-rank">${i + 1}</span>
      <span class="mini-name">${esc(r.name)}</span>
      <span class="mini-val">${r.w}</span>
    </div>`).join('');
}

function renderBiggestVictory() {
  const container = document.getElementById('biggest-victory');
  if (!container) return;
  const played = state.fixtures.filter(f => f.played);
  if (!played.length) { container.innerHTML = '<span style="color:var(--text3)">No matches yet</span>'; return; }
  const best = played.reduce((best, f) => {
    const diff = Math.abs(f.homeScore - f.awayScore);
    return diff > Math.abs((best?.homeScore || 0) - (best?.awayScore || 0)) ? f : best;
  }, null);
  if (!best) return;
  const h = state.players[best.home], a = state.players[best.away];
  const winner = best.homeScore > best.awayScore ? h : a;
  const diff = Math.abs(best.homeScore - best.awayScore);
  container.innerHTML = `
    <div><b>${esc(h)}</b> <span class="record-score">${best.homeScore}–${best.awayScore}</span> <b>${esc(a)}</b></div>
    <div style="font-size:12px;color:var(--text3)">R${best.round} · Margin: ${diff} goals · ${esc(winner)} won</div>`;
}

function renderHighestScoring() {
  const container = document.getElementById('highest-scoring');
  if (!container) return;
  const played = state.fixtures.filter(f => f.played);
  if (!played.length) { container.innerHTML = '<span style="color:var(--text3)">No matches yet</span>'; return; }
  const best = played.reduce((b, f) => (f.homeScore + f.awayScore) > (b.homeScore + b.awayScore) ? f : b, played[0]);
  const h = state.players[best.home], a = state.players[best.away];
  container.innerHTML = `
    <div><b>${esc(h)}</b> <span class="record-score">${best.homeScore}–${best.awayScore}</span> <b>${esc(a)}</b></div>
    <div style="font-size:12px;color:var(--text3)">R${best.round} · Total: ${best.homeScore + best.awayScore} goals</div>`;
}

function renderStreaks() {
  // Win streak & unbeaten run per player
  const winStreakEl = document.getElementById('win-streak');
  const unbeatenEl = document.getElementById('unbeaten-run');

  const streaks = state.players.map((name, idx) => {
    const matches = state.fixtures.filter(f => f.played && (f.home === idx || f.away === idx))
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    let maxWin = 0, curWin = 0;
    let maxUnbeaten = 0, curUnbeaten = 0;
    matches.forEach(f => {
      const isHome = f.home === idx;
      const myScore = isHome ? f.homeScore : f.awayScore;
      const oppScore = isHome ? f.awayScore : f.homeScore;
      if (myScore > oppScore) { curWin++; curUnbeaten++; }
      else if (myScore === oppScore) { curWin = 0; curUnbeaten++; }
      else { curWin = 0; curUnbeaten = 0; }
      maxWin = Math.max(maxWin, curWin);
      maxUnbeaten = Math.max(maxUnbeaten, curUnbeaten);
    });
    return { name, maxWin, maxUnbeaten };
  }).filter(s => s.maxWin > 0 || s.maxUnbeaten > 0);

  const topWin = [...streaks].sort((a, b) => b.maxWin - a.maxWin).slice(0, 5);
  const topUnbeaten = [...streaks].sort((a, b) => b.maxUnbeaten - a.maxUnbeaten).slice(0, 5);

  if (winStreakEl) {
    winStreakEl.innerHTML = topWin.length
      ? topWin.map((s, i) => `<div class="mini-item"><span class="mini-rank">${i+1}</span><span class="mini-name">${esc(s.name)}</span><span class="mini-val">${s.maxWin}</span></div>`).join('')
      : '<div class="mini-item"><span class="mini-name" style="color:var(--text3)">No data yet</span></div>';
  }
  if (unbeatenEl) {
    unbeatenEl.innerHTML = topUnbeaten.length
      ? topUnbeaten.map((s, i) => `<div class="mini-item"><span class="mini-rank">${i+1}</span><span class="mini-name">${esc(s.name)}</span><span class="mini-val">${s.maxUnbeaten}</span></div>`).join('')
      : '<div class="mini-item"><span class="mini-name" style="color:var(--text3)">No data yet</span></div>';
  }
}

/* ═══════════════════════════════════════
   PLAYERS
═══════════════════════════════════════ */
function renderPlayers(filter = '') {
  const container = document.getElementById('players-grid');
  if (!container) return;
  const table = computeTable();

  const list = state.players.map((name, idx) => {
    const row = table.find(r => r.idx === idx) || { played: 0, w: 0, d: 0, l: 0, pts: 0, gd: 0, gf: 0, ga: 0 };
    const rank = table.findIndex(r => r.idx === idx) + 1;
    return { name, idx, row, rank };
  }).filter(p => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));

  if (!list.length) { container.innerHTML = '<div class="empty-state">No players found</div>'; return; }

  container.innerHTML = list.map(({ name, idx, row, rank }) => {
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    const rankIcon = medals[rank] || '';
    const form = getPlayerForm(idx, 5);
    const formHTML = form.map(r => `<span class="form-badge form-${r}">${r}</span>`).join('');
    const initial = name[0].toUpperCase();

    return `
      <div class="player-card" onclick="openPlayer('${esc(name)}')">
        ${rankIcon ? `<span class="player-card-rank">${rankIcon}</span>` : ''}
        <div class="player-avatar">${initial}</div>
        <div class="player-card-name">${esc(name)}</div>
        <div class="player-card-pts">${row.pts}</div>
        <div class="player-card-pts-label">points · #${rank}</div>
        <div class="player-card-meta">
          <span class="player-meta-tag"><b>${row.w}</b>W</span>
          <span class="player-meta-tag"><b>${row.d}</b>D</span>
          <span class="player-meta-tag"><b>${row.l}</b>L</span>
        </div>
        <div class="player-card-form">${formHTML}</div>
      </div>`;
  }).join('');
}

function filterPlayers(val) { renderPlayers(val); }

function getPlayerForm(idx, n = 5) {
  const matches = state.fixtures.filter(f => f.played && (f.home === idx || f.away === idx))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, n);
  return matches.map(f => {
    const isHome = f.home === idx;
    const my = isHome ? f.homeScore : f.awayScore;
    const opp = isHome ? f.awayScore : f.homeScore;
    if (my > opp) return 'W';
    if (my < opp) return 'L';
    return 'D';
  }).reverse();
}

/* ─── Player Profile ─── */
function openPlayer(name) {
  const idx = state.players.indexOf(name);
  if (idx === -1) return;
  const table = computeTable();
  const row = table.find(r => r.idx === idx) || { played: 0, w: 0, d: 0, l: 0, pts: 0, gd: 0, gf: 0, ga: 0 };
  const rank = table.findIndex(r => r.idx === idx) + 1;
  const form = getPlayerForm(idx, 5);

  const winPct = row.played ? ((row.w / row.played) * 100).toFixed(0) : 0;
  const drawPct = row.played ? ((row.d / row.played) * 100).toFixed(0) : 0;
  const lossPct = row.played ? ((row.l / row.played) * 100).toFixed(0) : 0;

  const formHTML = form.map(r => `<span class="form-badge form-${r}">${r}</span>`).join('');
  const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const rankIcon = medals[rank] || `#${rank}`;

  const matches = state.fixtures.filter(f => f.played && (f.home === idx || f.away === idx))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const matchesHTML = matches.map(f => {
    const isHome = f.home === idx;
    const opp = isHome ? state.players[f.away] : state.players[f.home];
    const myScore = isHome ? f.homeScore : f.awayScore;
    const oppScore = isHome ? f.awayScore : f.homeScore;
    let result = 'draw';
    if (myScore > oppScore) result = 'win';
    else if (myScore < oppScore) result = 'loss';

    return `
      <div class="profile-match ${result}">
        <span style="font-size:12px;color:var(--text3)">R${f.round}</span>
        <span style="flex:1;font-weight:600">${esc(isHome ? 'vs' : 'vs')} ${esc(opp)}</span>
        <span style="font-family:'Outfit',sans-serif;font-weight:800;font-size:16px">${myScore}–${oppScore}</span>
        <span style="font-size:11px;font-weight:800;padding:2px 8px;border-radius:100px;
          background:${result==='win'?'var(--green-dim)':result==='loss'?'#2a0808':'#2a1c00'};
          color:${result==='win'?'var(--green-light)':result==='loss'?'var(--red)':'var(--gold-light)'}">
          ${result.toUpperCase()}
        </span>
      </div>`;
  }).join('') || '<div class="empty-state">No matches yet</div>';

  document.getElementById('profile-player-name').textContent = name;
  document.getElementById('player-profile-content').innerHTML = `
    <div class="profile-header">
      <div class="profile-avatar">${name[0].toUpperCase()}</div>
      <div>
        <div class="profile-name">${esc(name)}</div>
        <div class="profile-rank">Rank: ${rankIcon} &nbsp;|&nbsp; ${row.pts} points</div>
        <div class="profile-form-row" style="margin-top:8px">
          <span class="form-label">Form:</span>
          ${form.length ? formHTML : '<span style="color:var(--text3);font-size:12px">No matches yet</span>'}
        </div>
      </div>
    </div>

    <div class="profile-stats-grid">
      <div class="profile-stat"><div class="profile-stat-val">${row.played}</div><div class="profile-stat-label">Played</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${row.pts}</div><div class="profile-stat-label">Points</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${row.w}</div><div class="profile-stat-label">Wins</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${row.d}</div><div class="profile-stat-label">Draws</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${row.l}</div><div class="profile-stat-label">Losses</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${row.gf}</div><div class="profile-stat-label">Goals For</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${row.ga}</div><div class="profile-stat-label">Goals Against</div></div>
      <div class="profile-stat">
        <div class="profile-stat-val ${row.gd >= 0 ? 'gd-pos' : 'gd-neg'}">${row.gd >= 0 ? '+' : ''}${row.gd}</div>
        <div class="profile-stat-label">Goal Diff</div>
      </div>
      <div class="profile-stat"><div class="profile-stat-val">${rank}</div><div class="profile-stat-label">Current Rank</div></div>
    </div>

    <div class="card">
      <div class="card-title">📊 Win / Draw / Loss %</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:80px;text-align:center;padding:10px;background:var(--green-dim);border-radius:8px;border:1px solid var(--green)">
          <div style="font-size:20px;font-weight:900;color:var(--green-light);font-family:'Outfit',sans-serif">${winPct}%</div>
          <div style="font-size:11px;color:var(--text3)">WIN</div>
        </div>
        <div style="flex:1;min-width:80px;text-align:center;padding:10px;background:#2a1c00;border-radius:8px;border:1px solid var(--gold)">
          <div style="font-size:20px;font-weight:900;color:var(--gold-light);font-family:'Outfit',sans-serif">${drawPct}%</div>
          <div style="font-size:11px;color:var(--text3)">DRAW</div>
        </div>
        <div style="flex:1;min-width:80px;text-align:center;padding:10px;background:#2a0808;border-radius:8px;border:1px solid var(--red)">
          <div style="font-size:20px;font-weight:900;color:var(--red);font-family:'Outfit',sans-serif">${lossPct}%</div>
          <div style="font-size:11px;color:var(--text3)">LOSS</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">📋 Match History</div>
      <div class="profile-matches">${matchesHTML}</div>
    </div>`;

  showSection('player-profile');
}

/* ═══════════════════════════════════════
   ADMIN
═══════════════════════════════════════ */
function populateRenameList() {
  const container = document.getElementById('rename-players-list');
  if (!container) return;
  container.innerHTML = state.players.map((name, i) => `
    <div class="rename-item">
      <span class="rename-idx">${i + 1}</span>
      <input type="text" class="rename-input" id="rename-${i}" value="${esc(name)}" placeholder="Player ${i + 1}">
    </div>`).join('');
}

function savePlayerNames() {
  if (!isAdmin()) { requireAdmin(() => savePlayerNames()); return; }
  const newNames = state.players.map((_, i) => {
    const el = document.getElementById('rename-' + i);
    return el ? el.value.trim() || state.players[i] : state.players[i];
  });

  // Update scorer keys if names changed
  const newScorers = {};
  newNames.forEach((name, i) => {
    const old = state.players[i];
    if (state.scorers && state.scorers[old]) {
      newScorers[name] = state.scorers[old];
    }
  });
  state.scorers = { ...state.scorers, ...newScorers };

  state.players = newNames;
  saveState();
  renderAll();
  populateScorerSelect();
  showToast('Player names saved! 👥');
}

function setAdminLeagueName() {
  const el = document.getElementById('admin-league-name');
  if (el) el.value = state.leagueName;
}

function saveLeagueName() {
  const el = document.getElementById('admin-league-name');
  if (!el) return;
  const name = el.value.trim();
  if (!name) return;
  state.leagueName = name;
  document.getElementById('league-name-display').textContent = name;
  saveState();
  showToast('League name saved! ✏️');
}

function editLeagueName() {
  document.getElementById('modal-league-input').value = state.leagueName;
  openModal('modal-league-name');
}
function saveLeagueNameModal() {
  const val = document.getElementById('modal-league-input').value.trim();
  if (!val) return;
  state.leagueName = val;
  document.getElementById('league-name-display').textContent = val;
  setAdminLeagueName();
  saveState();
  closeModal('modal-league-name');
  showToast('League name updated! ✏️');
}

function resetLeague() {
  if (!confirm('⚠️ Are you sure? This will DELETE ALL match results permanently!')) return;
  if (!confirm('⚠️ FINAL CONFIRMATION: Reset all results?')) return;
  pushUndo('reset');
  state.fixtures.forEach(f => {
    f.homeScore = null; f.awayScore = null;
    f.played = false; f.timestamp = null; f.note = '';
  });
  state.activity = [];
  saveState();
  renderAll();
  showToast('League reset! All results cleared 🔄');
}

/* ═══════════════════════════════════════
   NOTES
═══════════════════════════════════════ */
function openNotes(id) {
  const f = state.fixtures.find(x => x.id === id);
  if (!f) return;
  currentNotesMatchId = id;
  document.getElementById('modal-notes-input').value = f.note || '';
  openModal('modal-notes');
}
function saveNotes() {
  const id = currentNotesMatchId;
  if (!id) return;
  const f = state.fixtures.find(x => x.id === id);
  if (!f) return;
  f.note = document.getElementById('modal-notes-input').value.trim();
  saveState();
  closeModal('modal-notes');
  refreshFixtureCard(id);
  showToast('Notes saved! 📝');
}

/* ═══════════════════════════════════════
   UNDO
═══════════════════════════════════════ */
function pushUndo(type, data = null) {
  state.undoStack.push({ type, data, timestamp: Date.now() });
  if (state.undoStack.length > 20) state.undoStack.shift();
  showUndoBar(`Last action: ${type}`);
}

function undoAction() {
  const last = state.undoStack.pop();
  if (!last) { showToast('Nothing to undo', true); return; }
  if (last.type === 'edit' || last.type === 'delete') {
    const f = state.fixtures.find(x => x.id === last.data.id);
    if (f) Object.assign(f, last.data);
  } else if (last.type === 'reset') {
    showToast('Cannot undo full reset', true); return;
  }
  saveState();
  renderAll();
  hideUndoBar();
  showToast('Undone! ↩');
}

function showUndoBar(msg) {
  const bar = document.getElementById('undo-bar');
  document.getElementById('undo-msg').textContent = msg;
  bar.classList.remove('hidden');
  setTimeout(hideUndoBar, 8000);
}
function hideUndoBar() {
  document.getElementById('undo-bar')?.classList.add('hidden');
}

/* ═══════════════════════════════════════
   EXPORT / IMPORT
═══════════════════════════════════════ */
function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${state.leagueName.replace(/\s+/g, '_')}_export.json`);
  showToast('Exported to JSON! 📤');
}

function triggerImport() {
  document.getElementById('import-file').click();
}

function importJSON(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!imported.fixtures || !imported.players) throw new Error('Invalid file');
      Object.assign(state, imported);
      saveState();
      renderAll();
      buildRoundFilter();
      populateScorerSelect();
      populateRenameList();
      showToast('Imported successfully! 📥');
    } catch(err) {
      showToast('Import failed: Invalid JSON file', true);
    }
    input.value = '';
  };
  reader.readAsText(file);
}

function exportExcel() {
  const table = computeTable();
  let csv = 'Position,Player,P,W,D,L,GF,GA,GD,Points\n';
  table.forEach((r, i) => {
    csv += `${i+1},"${r.name}",${r.played},${r.w},${r.d},${r.l},${r.gf},${r.ga},${r.gd},${r.pts}\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  downloadBlob(blob, `${state.leagueName.replace(/\s+/g, '_')}_standings.csv`);
  showToast('Exported to Excel/CSV! 📊');
}

function exportPDF() {
  const table = computeTable();
  const rows = table.map((r, i) => `
    <tr style="${i===0?'background:#d4a01722':i===1?'background:#8b949e22':i===2?'background:#c47a2b22':''}">
      <td>${i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1}</td>
      <td style="text-align:left;font-weight:bold">${r.name}</td>
      <td>${r.played}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
      <td>${r.gf}</td><td>${r.ga}</td><td>${r.gd >= 0 ? '+' : ''}${r.gd}</td>
      <td style="font-weight:900;color:#2ea043">${r.pts}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><title>${esc(state.leagueName)}</title>
  <style>
    body{font-family:Arial,sans-serif;margin:20px;color:#111}
    h1{text-align:center;color:#1a3a20;border-bottom:3px solid #2ea043;padding-bottom:10px}
    table{width:100%;border-collapse:collapse;margin-top:20px}
    th{background:#1a3a20;color:white;padding:10px 8px;text-align:center;font-size:12px}
    td{padding:9px 8px;text-align:center;border-bottom:1px solid #ddd;font-size:13px}
    .legend{margin-top:20px;font-size:12px;color:#666}
    .gen{font-size:11px;color:#999;text-align:center;margin-top:10px}
  </style></head><body>
  <h1>⚽ ${esc(state.leagueName)}</h1>
  <table><thead><tr>
    <th>#</th><th>Player</th><th>P</th><th>W</th><th>D</th><th>L</th>
    <th>GF</th><th>GA</th><th>GD</th><th>Pts</th>
  </tr></thead><tbody>${rows}</tbody></table>
  <div class="legend">🥇 1st · 🥈 2nd · 🥉 3rd</div>
  <div class="gen">Generated: ${new Date().toLocaleString()}</div>
  </body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  setTimeout(() => win.print(), 500);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════
   SEARCH
═══════════════════════════════════════ */
function toggleSearch() {
  const bar = document.getElementById('search-bar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) {
    document.getElementById('global-search').focus();
  }
}

function globalSearch(val) {
  const container = document.getElementById('search-results');
  if (!val.trim()) { container.innerHTML = ''; return; }
  const results = [];
  const lower = val.toLowerCase();

  state.players.forEach(name => {
    if (name.toLowerCase().includes(lower)) {
      results.push({ label: `👤 ${name}`, action: `openPlayer('${esc(name)}')` });
    }
  });

  state.fixtures.filter(f => f.played).forEach(f => {
    const h = state.players[f.home], a = state.players[f.away];
    if (h.toLowerCase().includes(lower) || a.toLowerCase().includes(lower)) {
      results.push({
        label: `⚽ R${f.round}: ${h} ${f.homeScore}–${f.awayScore} ${a}`,
        action: `showSection('fixtures');filterRound(${f.round});document.getElementById('round-filter').value='${f.round}'`
      });
    }
  });

  if (!results.length) { container.innerHTML = '<div class="search-result-item" style="color:var(--text3)">No results found</div>'; return; }

  container.innerHTML = results.slice(0, 10).map(r =>
    `<div class="search-result-item" onclick="${r.action};toggleSearch()">${r.label}</div>`
  ).join('');
}

/* ═══════════════════════════════════════
   MODALS
═══════════════════════════════════════ */
function openModal(id) {
  document.getElementById(id)?.classList.remove('hidden');
  document.getElementById('modal-backdrop')?.classList.remove('hidden');
}
function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
  document.getElementById('modal-backdrop')?.classList.add('hidden');
}
function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.getElementById('modal-backdrop')?.classList.add('hidden');
}

/* ═══════════════════════════════════════
   TOAST
═══════════════════════════════════════ */
let toastTimer;
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ═══════════════════════════════════════
   WINNER CHECK + CONFETTI
═══════════════════════════════════════ */
function checkWinner() {
  const allDone = state.fixtures.every(f => f.played);
  if (!allDone) return;
  const table = computeTable();
  const winner = table[0];
  if (!winner || winner.played === 0) return;

  // Only fire once
  if (state._winnerCelebrated === winner.name) return;
  state._winnerCelebrated = winner.name;
  saveState();

  showToast(`🏆 ${winner.name} wins the league! Congratulations!`);
  launchConfetti();
}

function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#2ea043','#d4a017','#1f6feb','#e35252','#8957e5','#fff'];
  const pieces = Array.from({ length: 150 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * -canvas.height,
    r: Math.random() * 8 + 4,
    c: colors[Math.floor(Math.random() * colors.length)],
    vx: (Math.random() - 0.5) * 4,
    vy: Math.random() * 4 + 2,
    alpha: 1
  }));

  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach(p => {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      p.x += p.vx; p.y += p.vy;
      p.alpha -= 0.005;
      if (p.y > canvas.height) { p.y = -10; p.x = Math.random() * canvas.width; p.alpha = 1; }
    });
    frame++;
    if (frame < 400) requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  draw();
}

/* ═══════════════════════════════════════
   HELPERS
═══════════════════════════════════════ */
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ─── Keyboard shortcuts ─── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAllModals();
});
