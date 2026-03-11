/**
 * moderate-service/public/app.js
 *
 * Moderation UI JavaScript
 * ─────────────────────────
 * Behaviour:
 *  1. On load: fetch /me (user profile) and /types (for dropdown)
 *  2. Poll GET /moderate every 1 second for the next joke to review
 *     - If joke available: show mod-card, stop polling
 *     - If queue empty:    show "polling" banner, keep polling
 *  3. Approve button:  POST /moderated with (possibly edited) fields
 *  4. Reject button:   POST /reject, then resume polling immediately
 */

'use strict';

let pollTimer    = null;
let isProcessing = false;

// ── On page load ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await loadUserProfile();
  await loadTypes();
  startPolling();
});

// ─────────────────────────────────────────────────────────────────────────────
// loadUserProfile — fetch /me and populate the header
// ─────────────────────────────────────────────────────────────────────────────
async function loadUserProfile() {
  try {
    const res  = await fetch('/me');
    if (!res.ok) return; // unauthenticated — OIDC will redirect
    const user = await res.json();

    document.getElementById('user-info').style.display = 'flex';
    document.getElementById('user-name').textContent   = user.name || user.email;
    if (user.picture) {
      document.getElementById('user-avatar').src = user.picture;
    } else {
      document.getElementById('user-avatar').style.display = 'none';
    }
  } catch (_) { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// loadTypes — fetch /types and populate the <select> dropdown
// This reads from the local ECST cache; no HTTP call to joke-service.
// ─────────────────────────────────────────────────────────────────────────────
async function loadTypes() {
  try {
    const res   = await fetch('/types');
    const types = await res.json();
    const sel   = document.getElementById('type');
    // Remove all options except the first placeholder
    while (sel.options.length > 1) sel.remove(1);
    types.forEach(t => {
      const opt   = document.createElement('option');
      opt.value   = t.name;
      opt.textContent = t.name;
      sel.appendChild(opt);
    });
  } catch (_) { /* types will remain empty if service not yet warm */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling — GET /moderate every 1 second
// ─────────────────────────────────────────────────────────────────────────────
function startPolling() {
  setStatus('Polling for jokes…', true);
  pollTimer = setInterval(pollForJoke, 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollForJoke() {
  if (isProcessing) return;
  try {
    const res = await fetch('/moderate');

    if (res.status === 204) {
      // Queue is empty — keep polling
      setStatus('No jokes available for moderation. Polling every second…', true);
      return;
    }

    if (res.status === 401) {
      stopPolling();
      setStatus('Session expired. Please log in again.');
      setTimeout(() => { location.href = '/login'; }, 2000);
      return;
    }

    if (!res.ok) {
      setStatus('Broker unavailable — retrying…', true);
      return;
    }

    const joke = await res.json();
    stopPolling();
    showJoke(joke);

  } catch (err) {
    setStatus('Connection error — retrying…', true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// showJoke — populate the mod-card and reveal it
// ─────────────────────────────────────────────────────────────────────────────
function showJoke(joke) {
  document.getElementById('setup').value     = joke.setup;
  document.getElementById('punchline').value = joke.punchline;

  // Select the matching type in the dropdown, or add it if missing
  const sel = document.getElementById('type');
  let found = false;
  for (const opt of sel.options) {
    if (opt.value === joke.type) { opt.selected = true; found = true; break; }
  }
  if (!found && joke.type) {
    const opt = document.createElement('option');
    opt.value = joke.type;
    opt.textContent = joke.type;
    opt.selected = true;
    sel.appendChild(opt);
  }

  // Show the card, hide the banner
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
      showToast('✅ Joke approved and sent to database!', 'success');
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(`❌ Error: ${body.error || 'Approval failed'}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Network error: ${err.message}`, 'error');
  }

  // Reset UI and resume polling after 1 second
  setTimeout(() => {
    hideCard();
    isProcessing = false;
    startPolling();
  }, 1000);
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
      showToast('❌ Joke rejected and discarded.', 'error');
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(`Error: ${body.error || 'Reject failed'}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message}`, 'error');
  }

  // Resume polling for next joke
  setTimeout(() => {
    hideCard();
    isProcessing = false;
    startPolling();
  }, 800);
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

function setStatus(text, showSpinner = false) {
  document.getElementById('status-text').textContent = text;
  const spinner = document.querySelector('.spinner');
  spinner.style.display = showSpinner ? 'block' : 'none';
}

function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = `show ${type}`;
  setTimeout(() => { toast.className = ''; }, 3500);
}
