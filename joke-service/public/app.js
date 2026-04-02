'use strict';

const cfg = window.APP_CONFIG || {};
const preferGateway = cfg.gatewayBase || cfg.azureBase || cfg.localBase || '';
const defaultBase   = (preferGateway || window.location.origin || '').replace(/\/$/, '');

const bases = {
  joke:      (cfg.jokeServiceBase || defaultBase).replace(/\/$/, ''),
  submit:    (cfg.submitServiceBase || defaultBase).replace(/\/$/, ''),
  moderate:  (cfg.moderateServiceBase || defaultBase).replace(/\/$/, ''),
  gateway:   defaultBase
};

const state = {
  cardCounter: 0,
  jokesServed: 0,
  types: []
};

// Tracks the auto-dismiss timer for the homepage inline submit alert.
let _homeSubmitTimer = null;

function withBase(base, path) {
  if (!path.startsWith('/')) path = `/${path}`;
  return `${base}${path}`;
}

/* ── Load joke types from the API (gateway-first) ─────────── */
async function loadTypes() {
  try {
    const res = await fetch(withBase(bases.gateway, '/types'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const types = await res.json();
    if (!Array.isArray(types)) throw new Error('unexpected response');
    state.types = types;

    const typeSelect   = document.getElementById('typeSelect');
    const submitSelect = document.getElementById('submit-type');

    typeSelect.innerHTML = '<option value="any">Any type</option>';
    submitSelect.innerHTML = '<option value="">Select type</option>';

    types.forEach(t => {
      const label = t.name.charAt(0).toUpperCase() + t.name.slice(1);
      const o1 = document.createElement('option');
      o1.value = t.name; o1.textContent = label; typeSelect.appendChild(o1);
      const o2 = document.createElement('option');
      o2.value = t.name; o2.textContent = label; submitSelect.appendChild(o2);
    });

    document.getElementById('metric-types').textContent = types.length;
  } catch (err) {
    console.warn('[home] failed to load types', err);
    document.getElementById('metric-types').textContent = '—';
  }
}

/* ── Joke card builder with delayed punchline ─────────────── */
function createJokeCard(joke) {
  const id   = ++state.cardCounter;
  const card = document.createElement('div');
  card.className = 'joke-card';

  card.innerHTML = `
    <span class="type-badge">${escapeHtml(joke.type || 'general')}</span>
    <p class="setup">${escapeHtml(joke.setup)}</p>
    <p class="timer" id="timer-${id}">Punchline reveals in 3s…</p>
    <p class="punchline" id="punchline-${id}">💥 ${escapeHtml(joke.punchline)}</p>
  `;

  let remaining = 3;
  const interval = setInterval(() => {
    remaining--;
    const el = document.getElementById(`timer-${id}`);
    if (el && remaining > 0) {
      el.textContent = `Punchline reveals in ${remaining}s…`;
    }
  }, 1000);

  setTimeout(() => {
    clearInterval(interval);
    const timer = document.getElementById(`timer-${id}`);
    const punch = document.getElementById(`punchline-${id}`);
    if (timer) timer.remove();
    if (punch) punch.classList.add('revealed');
  }, 3000);

  return card;
}

/* ── Fetch and display jokes ─────────────────────────────── */
async function getJokes() {
  const type  = document.getElementById('typeSelect').value;
  const count = Math.max(1, parseInt(document.getElementById('countInput').value, 10) || 1);
  const box   = document.getElementById('jokesContainer');
  const btn   = document.getElementById('getJokeBtn');

  btn.disabled = true;
  btn.textContent = 'Fetching…';
  box.innerHTML = '<p style="color:var(--muted);">Loading curated jokes…</p>';

  try {
    const res = await fetch(withBase(bases.gateway, `/joke/${encodeURIComponent(type)}?count=${count}`));
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // Kong 429 returns { message: '...' }; service errors return { error: '...' }
      const msg = res.status === 429
        ? (err.message || err.error || 'Rate limit exceeded — Joke API allows 5 requests/min. Please wait 60 seconds.')
        : (err.message || err.error || 'Unable to fetch jokes. Please try again.');
      box.innerHTML = `<p style="color:var(--danger);">⚠️ ${escapeHtml(msg)}</p>`;
      return;
    }

    const data  = await res.json();
    const jokes = Array.isArray(data) ? data : [data];
    state.jokesServed += jokes.length;
    document.getElementById('metric-jokes').textContent = state.jokesServed;

    box.innerHTML = '';
    jokes.forEach(j => box.appendChild(createJokeCard(j)));
  } catch (err) {
    box.innerHTML = '<p style="color:var(--danger);">Network error reaching Joke Service</p>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch jokes';
  }
}

/* ── Submit from homepage (through gateway) ──────────────── */
async function submitFromHome() {
  // Cancel any pending auto-dismiss from a prior successful submission
  if (_homeSubmitTimer) { clearTimeout(_homeSubmitTimer); _homeSubmitTimer = null; }

  const setup     = document.getElementById('submit-setup').value.trim();
  const punchline = document.getElementById('submit-punchline').value.trim();
  const type      = document.getElementById('submit-type').value.trim();
  const alertBox  = document.getElementById('submit-alert');
  const btn       = document.getElementById('submit-btn');

  if (!setup || !punchline || !type) {
    alertBox.style.color = 'var(--danger)';
    alertBox.textContent = 'Fill in setup, punchline, and type.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Queueing…';
  alertBox.textContent = '';

  try {
    const res = await fetch(withBase(bases.submit, '/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup, punchline, type })
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      alertBox.style.color = 'var(--success)';
      alertBox.textContent = '✅ Queued for human moderation. Thank you!';
      document.getElementById('submit-setup').value = '';
      document.getElementById('submit-punchline').value = '';
      // Reset the type selector back to the placeholder option
      const typeEl = document.getElementById('submit-type');
      if (typeEl) typeEl.selectedIndex = 0;
      // Auto-clear success message after 6 seconds
      _homeSubmitTimer = setTimeout(() => { alertBox.textContent = ''; _homeSubmitTimer = null; }, 6000);
    } else {
      alertBox.style.color = 'var(--danger)';
      alertBox.textContent = body.error || body.message || 'Submission failed.';
    }
  } catch (err) {
    alertBox.style.color = 'var(--danger)';
    alertBox.textContent = 'Network error reaching Submit Service.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Queue for moderation';
  }
}

/* ── Health indicator (via gateway /health route) ────────── */
async function loadHealth() {
  const el = document.getElementById('health-indicator');
  try {
    const res = await fetch(withBase(bases.gateway, '/health'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== 'ok') throw new Error(json.status || 'non-ok status');
    const db = (json.dbType || 'db').toUpperCase();
    el.style.color = 'var(--success)';
    el.textContent = `✅ Online · ${db}`;
  } catch (_) {
    el.style.color = 'var(--danger)';
    el.textContent = '❌ Unavailable';
  }
}

/* ── Sanitise text ───────────────────────────────────────── */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/* ── Init ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadTypes();
  loadHealth();

  document.getElementById('getJokeBtn').addEventListener('click', getJokes);
  document.getElementById('refresh-types').addEventListener('click', loadTypes);
  document.getElementById('submit-btn').addEventListener('click', submitFromHome);

  const cta1 = document.getElementById('cta-get-started');
  const cta2 = document.getElementById('cta-submit');
  cta1?.addEventListener('click', getJokes);
  cta2?.addEventListener('click', () => {
    document.getElementById('submit-setup').focus();
  });
});
