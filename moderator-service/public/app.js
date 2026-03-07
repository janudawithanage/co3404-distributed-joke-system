/**
 * moderator-service/public/app.js
 *
 * Moderator frontend.
 *
 * Polls GET /moderate every 1 second.
 * When a joke arrives it populates the editable form.
 * Approve → POST /moderated with (possibly edited) fields.
 * Reject  → POST /reject.
 * If no joke available, shows the pulsing "waiting" message.
 */

'use strict';

// ── DOM refs ─────────────────────────────────────────────────
const setupEl     = document.getElementById('setup');
const punchlineEl = document.getElementById('punchline');
const typeEl      = document.getElementById('type');
const statusEl    = document.getElementById('status');
const formEl      = document.getElementById('jokeForm');
const waitingEl   = document.getElementById('waitingMsg');
const approveBtn  = document.getElementById('approveBtn');
const rejectBtn   = document.getElementById('rejectBtn');

// ── State ─────────────────────────────────────────────────────
let jokeInReview = false; // true while a joke is displayed in the form

// ─────────────────────────────────────────────────────────────
// Polling — GET /moderate every 1 s
// ─────────────────────────────────────────────────────────────
async function pollForJoke() {
  try {
    const res  = await fetch('/moderate');
    const data = await res.json();

    if (data.waiting) {
      showWaiting(data.message);
    } else if (data.joke) {
      showJoke(data.joke);
    }
  } catch {
    showWaiting('⚠️ Cannot reach moderator service…');
  }
}

setInterval(pollForJoke, 1000);
pollForJoke(); // immediate first poll

// ─────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────
function showWaiting(message) {
  jokeInReview = false;
  formEl.style.display    = 'none';
  waitingEl.style.display = 'block';
  waitingEl.textContent   = message || 'No jokes available. Waiting…';
}

function showJoke(joke) {
  jokeInReview = true;
  waitingEl.style.display = 'none';
  formEl.style.display    = 'flex';

  // Only overwrite fields if the value changed — prevents
  // the cursor jumping while the moderator is editing.
  if (setupEl.value     !== joke.setup)     setupEl.value     = joke.setup;
  if (punchlineEl.value !== joke.punchline) punchlineEl.value = joke.punchline;
  if (typeEl.value      !== joke.type)      typeEl.value      = joke.type;
}

// ─────────────────────────────────────────────────────────────
// Approve — POST /moderated
// ─────────────────────────────────────────────────────────────
async function approveJoke() {
  const setup     = setupEl.value.trim();
  const punchline = punchlineEl.value.trim();
  const type      = typeEl.value.trim().toLowerCase();

  if (!setup || !punchline || !type) {
    showStatus('⚠️ Please fill in all fields before approving.', 'error');
    return;
  }

  setButtons(true);
  clearStatus();

  try {
    const res  = await fetch('/moderated', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ setup, punchline, type })
    });
    const data = await res.json();

    if (res.ok) {
      showStatus('✅ Joke approved and forwarded to the ETL pipeline.', 'success');
      showWaiting('No jokes available. Waiting…');
    } else {
      showStatus(`❌ ${escapeHtml(data.error)}`, 'error');
    }
  } catch {
    showStatus('❌ Network error — could not reach the moderator service.', 'error');
  } finally {
    setButtons(false);
  }
}

// ─────────────────────────────────────────────────────────────
// Reject — POST /reject
// ─────────────────────────────────────────────────────────────
async function rejectJoke() {
  if (!confirm('Reject this joke? It will be permanently discarded.')) return;

  setButtons(true);
  clearStatus();

  try {
    const res  = await fetch('/reject', { method: 'POST' });
    const data = await res.json();

    if (res.ok) {
      showStatus('🗑️ Joke rejected and discarded.', 'warn');
      showWaiting('No jokes available. Waiting…');
    } else {
      showStatus(`❌ ${escapeHtml(data.error)}`, 'error');
    }
  } catch {
    showStatus('❌ Network error — could not reach the moderator service.', 'error');
  } finally {
    setButtons(false);
  }
}

// ─────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────
function showStatus(msg, kind) {
  statusEl.innerHTML = `<div class="alert alert-${kind}">${msg}</div>`;
  if (kind === 'success' || kind === 'warn') {
    setTimeout(clearStatus, 5000);
  }
}

function clearStatus() {
  statusEl.innerHTML = '';
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────
function setButtons(disabled) {
  approveBtn.disabled = disabled;
  rejectBtn.disabled  = disabled;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}
