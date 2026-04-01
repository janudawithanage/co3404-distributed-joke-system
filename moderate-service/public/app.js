/**
 * moderate-service/public/app.js
 *
 * Production-level Moderation UI JavaScript
 * ──────────────────────────────────────────
 * Features:
 *  - Session statistics (approved / rejected / total)
 *  - Keyboard shortcuts: A = approve, R = reject, Ctrl+Enter = approve
 *  - Polling with exponential backoff on errors
 *  - Accessible toast notifications
 *  - Editable joke fields before approve
 *  - User profile display (Auth0 or mock)
 */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let pollTimer    = null;
let isProcessing = false;
let pollDelay    = 1000;        // starts at 1 s, backs off on errors
const POLL_MIN   = 1000;
const POLL_MAX   = 8000;

const stats = { approved: 0, rejected: 0 };

// ── On page load ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Bind click handlers
  document.getElementById('btn-approve').addEventListener('click', approveJoke);
  document.getElementById('btn-reject').addEventListener('click', rejectJoke);
  document.getElementById('logout-btn')?.addEventListener('click', () => { location.href = '/logout'; });

  await loadUserProfile();
  await loadTypes();
  startPolling();
  bindKeyboardShortcuts();
});

// ─────────────────────────────────────────────────────────────────────────────
// loadUserProfile — fetch /me and populate the header
// ─────────────────────────────────────────────────────────────────────────────
async function loadUserProfile() {
  try {
    const res = await fetch('/me');
    if (!res.ok) return;
    const user = await res.json();

    document.getElementById('user-info').style.display = 'flex';
    document.getElementById('user-name').textContent = user.name || user.email;
    if (user.picture) {
      document.getElementById('user-avatar').src = user.picture;
    } else {
      document.getElementById('user-avatar').style.display = 'none';
    }
  } catch (_) { /* ignore — OIDC will redirect if needed */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// loadTypes — fetch /types and populate the <select> dropdown
// ─────────────────────────────────────────────────────────────────────────────
async function loadTypes() {
  try {
    const res   = await fetch('/moderate-types');
    const types = await res.json();
    const sel   = document.getElementById('type');
    while (sel.options.length > 1) sel.remove(1);
    types.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name.charAt(0).toUpperCase() + t.name.slice(1);
      sel.appendChild(opt);
    });
  } catch (_) { /* types will remain empty if service not yet warm */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling — GET /moderate with adaptive interval
// ─────────────────────────────────────────────────────────────────────────────
function startPolling() {
  setStatus('Polling for jokes…', true);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollForJoke, pollDelay);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollForJoke() {
  if (isProcessing) return;
  try {
    const res = await fetch('/moderate');

    if (res.status === 204) {
      // Queue empty — reset to normal speed
      if (pollDelay !== POLL_MIN) { pollDelay = POLL_MIN; stopPolling(); startPolling(); }
      setStatus('No jokes in queue. Polling every second…', true);
      return;
    }

    if (res.status === 401) {
      stopPolling();
      setStatus('Session expired — redirecting to login…', false);
      setTimeout(() => { location.href = '/login'; }, 2000);
      return;
    }

    if (!res.ok) {
      // Back off on broker errors
      pollDelay = Math.min(pollDelay * 2, POLL_MAX);
      stopPolling(); startPolling();
      setStatus(`Broker unavailable — retrying every ${pollDelay / 1000}s…`, true);
      return;
    }

    // Got a joke
    pollDelay = POLL_MIN;
    const joke = await res.json();
    stopPolling();
    showJoke(joke);

  } catch (err) {
    pollDelay = Math.min(pollDelay * 2, POLL_MAX);
    stopPolling(); startPolling();
    setStatus(`Connection error — retrying every ${pollDelay / 1000}s…`, true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// showJoke — populate the mod-card and reveal it
// ─────────────────────────────────────────────────────────────────────────────
function showJoke(joke) {
  document.getElementById('setup').value     = joke.setup;
  document.getElementById('punchline').value = joke.punchline;

  const sel = document.getElementById('type');
  let found = false;
  for (const opt of sel.options) {
    if (opt.value === joke.type) { opt.selected = true; found = true; break; }
  }
  if (!found && joke.type) {
    const opt = document.createElement('option');
    opt.value = joke.type;
    opt.textContent = joke.type.charAt(0).toUpperCase() + joke.type.slice(1);
    opt.selected = true;
    sel.appendChild(opt);
  }

  document.getElementById('status-banner').style.display = 'none';
  document.getElementById('mod-card').classList.add('visible');
  setButtonsDisabled(false);
}

// ─────────────────────────────────────────────────────────────────────────────
// approveJoke — POST /moderated with (possibly edited) joke fields
// ─────────────────────────────────────────────────────────────────────────────
async function approveJoke() {
  if (isProcessing) return;
  isProcessing = true;
  setButtonsDisabled(true);

  const payload = {
    setup:     document.getElementById('setup').value.trim(),
    punchline: document.getElementById('punchline').value.trim(),
    type:      document.getElementById('type').value.trim()
  };

  if (!payload.setup || !payload.punchline || !payload.type) {
    showToast('Please fill in all fields before approving.', 'error');
    setButtonsDisabled(false);
    isProcessing = false;
    return;
  }

  try {
    const res = await fetch('/moderated', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });

    if (res.ok) {
      stats.approved++;
      updateStats();
      showToast('✅ Joke approved and sent to database!', 'success');
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(`❌ Error: ${body.error || 'Approval failed'}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Network error: ${err.message}`, 'error');
  }

  setTimeout(() => {
    hideCard();
    isProcessing = false;
    startPolling();
  }, 800);
}

// ─────────────────────────────────────────────────────────────────────────────
// rejectJoke — POST /reject — permanently discards the current joke
// ─────────────────────────────────────────────────────────────────────────────
async function rejectJoke() {
  if (isProcessing) return;
  isProcessing = true;
  setButtonsDisabled(true);

  try {
    const res = await fetch('/reject', { method: 'POST' });
    if (res.ok) {
      stats.rejected++;
      updateStats();
      showToast('❌ Joke rejected and discarded.', 'error');
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(`Error: ${body.error || 'Reject failed'}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message}`, 'error');
  }

  setTimeout(() => {
    hideCard();
    isProcessing = false;
    startPolling();
  }, 600);
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard Shortcuts — A / R / Ctrl+Enter
// ─────────────────────────────────────────────────────────────────────────────
function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts while typing in form fields
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') {
      // Allow Ctrl+Enter even in textareas
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        approveJoke();
      }
      return;
    }

    const card = document.getElementById('mod-card');
    if (!card.classList.contains('visible')) return;

    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      approveJoke();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      rejectJoke();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hideCard() {
  document.getElementById('mod-card').classList.remove('visible');
  document.getElementById('status-banner').style.display = 'flex';
  document.getElementById('setup').value     = '';
  document.getElementById('punchline').value = '';
}

function setButtonsDisabled(disabled) {
  document.getElementById('btn-approve').disabled = disabled;
  document.getElementById('btn-reject').disabled  = disabled;
}

function setStatus(text, showSpinner) {
  document.getElementById('status-text').textContent = text;
  const spinner = document.querySelector('#status-banner .spinner');
  if (spinner) spinner.style.display = showSpinner ? 'block' : 'none';
}

function updateStats() {
  document.getElementById('stat-approved').textContent = stats.approved;
  document.getElementById('stat-rejected').textContent = stats.rejected;
  document.getElementById('stat-total').textContent    = stats.approved + stats.rejected;
}

function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `show ${type || ''}`;
  setTimeout(() => { toast.className = ''; }, 3500);
}
