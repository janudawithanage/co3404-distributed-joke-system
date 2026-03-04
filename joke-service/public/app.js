/**
 * joke-service/public/app.js
 *
 * Frontend JavaScript for the Joke Machine.
 *
 * Key requirement: punchline is revealed after 3 seconds
 * using setTimeout() to demonstrate asynchronous behaviour.
 */

'use strict';

/* ── Load joke types from the API ────────────────────────── */
async function loadTypes() {
  try {
    const res   = await fetch('/types');
    const types = await res.json();
    const sel   = document.getElementById('typeSelect');

    // Reset to just the "any" option then populate from API
    sel.innerHTML = '<option value="any">🎲 Any Type</option>';
    types.forEach(t => {
      const opt       = document.createElement('option');
      opt.value       = t.name;
      opt.textContent = t.name.charAt(0).toUpperCase() + t.name.slice(1);
      sel.appendChild(opt);
    });
  } catch (err) {
    console.error('[app.js] Failed to load types:', err);
  }
}

/* ── Card counter (used for unique element IDs) ──────────── */
let cardCounter = 0;

/* ── Build a joke card DOM element ───────────────────────── */
function createJokeCard(joke) {
  const id   = ++cardCounter;
  const card = document.createElement('div');
  card.className = 'joke-card';

  card.innerHTML = `
    <span class="type-badge">${escapeHtml(joke.type || 'general')}</span>
    <p  class="setup">${escapeHtml(joke.setup)}</p>
    <p  class="timer"     id="timer-${id}">⏳ Punchline reveals in 3 seconds…</p>
    <p  class="punchline" id="punchline-${id}">💥 ${escapeHtml(joke.punchline)}</p>
  `;

  /* Countdown display — updates every second */
  let remaining  = 3;
  const interval = setInterval(() => {
    remaining--;
    const el = document.getElementById(`timer-${id}`);
    if (el && remaining > 0) {
      el.textContent =
        `⏳ Punchline reveals in ${remaining} second${remaining !== 1 ? 's' : ''}…`;
    }
  }, 1000);

  /**
   * setTimeout() is the core requirement here.
   * After 3000 ms the punchline CSS class is toggled,
   * triggering the CSS opacity + translate transition.
   */
  setTimeout(() => {
    clearInterval(interval);

    const timer   = document.getElementById(`timer-${id}`);
    const punchEl = document.getElementById(`punchline-${id}`);

    if (timer)   timer.remove();
    if (punchEl) punchEl.classList.add('revealed');
  }, 3000);

  return card;
}

/* ── Fetch and display jokes ─────────────────────────────── */
async function getJokes() {
  const type  = document.getElementById('typeSelect').value;
  const count = Math.max(1, parseInt(document.getElementById('countInput').value) || 1);
  const box   = document.getElementById('jokesContainer');
  const btn   = document.getElementById('getJokeBtn');

  btn.disabled    = true;
  btn.textContent = 'Loading…';
  box.innerHTML   = '<p class="loading">🔄 Fetching jokes…</p>';

  try {
    const res = await fetch(`/joke/${type}?count=${count}`);

    if (!res.ok) {
      const err = await res.json();
      box.innerHTML = `<p class="error">❌ ${escapeHtml(err.error)}</p>`;
      return;
    }

    const data  = await res.json();
    // API returns a single object for count=1, array otherwise
    const jokes = Array.isArray(data) ? data : [data];

    box.innerHTML = '';
    jokes.forEach(j => box.appendChild(createJokeCard(j)));

  } catch (err) {
    box.innerHTML = '<p class="error">❌ Could not reach the Joke Service</p>';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Get Joke(s)';
  }
}

/* ── Sanitise text before inserting into the DOM ─────────── */
function escapeHtml(str) {
  const div       = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/* ── Init ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadTypes();
  document.getElementById('getJokeBtn').addEventListener('click', getJokes);
});
