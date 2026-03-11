/**
 * submit-service/public/app.js
 *
 * Frontend for the Submit microservice.
 * Loads available joke types from /types (with cache fallback
 * on the server side), and POSTs new jokes to /submit.
 */

'use strict';

/* ── Load joke types ─────────────────────────────────────── */
async function loadTypes() {
  const sel    = document.getElementById('typeSelect');
  const custom = document.getElementById('typeCustom');

  try {
    const res   = await fetch('/types');
    const types = await res.json();

    sel.innerHTML = '';
    types.forEach(t => {
      const opt       = document.createElement('option');
      opt.value       = t.name;
      opt.textContent = t.name.charAt(0).toUpperCase() + t.name.slice(1);
      sel.appendChild(opt);
    });

    // Append a "custom" sentinel option
    const customOpt       = document.createElement('option');
    customOpt.value       = '__custom__';
    customOpt.textContent = '＋ Custom type…';
    sel.appendChild(customOpt);

    // Show/hide free-text input based on selection
    sel.addEventListener('change', () => {
      const isCustom       = sel.value === '__custom__';
      custom.style.display = isCustom ? 'block' : 'none';
      if (isCustom) custom.focus();
    });

  } catch (err) {
    // Fallback: let user type the type manually
    console.warn('[app.js] Could not load types, showing text input');
    sel.style.display    = 'none';
    custom.style.display = 'block';
  }
}

/* ── Alert helper ────────────────────────────────────────── */
function showAlert(msg, kind) {
  const box      = document.getElementById('alertBox');
  box.innerHTML  = `<div class="alert alert-${kind}">${msg}</div>`;
  if (kind === 'success') {
    setTimeout(() => { box.innerHTML = ''; }, 6000);
  }
}

/* ── Submit joke ─────────────────────────────────────────── */
async function submitJoke() {
  const setup     = document.getElementById('setup').value.trim();
  const punchline = document.getElementById('punchline').value.trim();
  const selEl     = document.getElementById('typeSelect');
  const customEl  = document.getElementById('typeCustom');

  let type = selEl.value === '__custom__'
    ? customEl.value.trim().toLowerCase()
    : selEl.value;

  if (!setup || !punchline || !type) {
    showAlert('⚠️ Please fill in all fields (setup, punchline, type).', 'error');
    return;
  }

  const btn          = document.getElementById('submitBtn');
  btn.disabled       = true;
  btn.textContent    = 'Submitting…';

  try {
    const res  = await fetch('/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ setup, punchline, type })
    });
    const data = await res.json();

    if (res.ok) {
      showAlert(
        '✅ Joke queued for moderation! A moderator will review it before it enters the database.',
        'success'
      );
      document.getElementById('setup').value     = '';
      document.getElementById('punchline').value = '';
    } else {
      showAlert(`❌ ${escapeHtml(data.error)}`, 'error');
    }
  } catch (err) {
    showAlert('❌ Network error – could not reach the Submit Service.', 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Submit Joke';
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
  document.getElementById('submitBtn').addEventListener('click', submitJoke);
});
