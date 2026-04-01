/**
 * submit-service/public/app.js
 *
 * Production-level frontend for the Submit microservice.
 * Features: character counters, loading states, keyboard shortcuts,
 * accessible alerts, custom type toggle, auto-dismiss success.
 */

'use strict';

const cfg         = window.APP_CONFIG || {};
const gatewayBase = (cfg.gatewayBase || cfg.azureBase || cfg.localBase || window.location.origin || '').replace(/\/$/, '');

function withBase(path) {
  if (!path.startsWith('/')) path = `/${path}`;
  return `${gatewayBase}${path}`;
}

/* ── Load joke types ─────────────────────────────────────── */
async function loadTypes() {
  const sel    = document.getElementById('typeSelect');
  const custom = document.getElementById('typeCustom');

  try {
    const res   = await fetch(withBase('/types'));
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
    console.warn('[Submit UI] Could not load types, showing text input');
    sel.style.display    = 'none';
    custom.style.display = 'block';
  }
}

/* ── Character counter helper ────────────────────────────── */
function setupCharCounter(inputId, countId, max) {
  const input   = document.getElementById(inputId);
  const counter = document.getElementById(countId);
  if (!input || !counter) return;

  input.addEventListener('input', () => {
    const len = input.value.length;
    counter.textContent = len;
    counter.parentElement.classList.toggle('warn', len > max * 0.9);
  });
}

/* ── Alert helper ────────────────────────────────────────── */
function showAlert(msg, kind) {
  const box = document.getElementById('alertBox');
  box.textContent = msg;
  box.className   = `alert visible alert-${kind}`;
  if (kind === 'success') {
    setTimeout(() => {
      box.classList.remove('visible');
    }, 5000);
  }
}

function hideAlert() {
  document.getElementById('alertBox').classList.remove('visible');
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

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.querySelector('.btn-text').textContent = 'Submitting…';
  hideAlert();

  try {
    const res  = await fetch(withBase('/submit'), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ setup, punchline, type })
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      showAlert(
        '✅ Joke queued for moderation! A moderator will review it before it enters the database.',
        'success'
      );
      // Clear form
      document.getElementById('setup').value     = '';
      document.getElementById('punchline').value  = '';
      document.getElementById('setup-count').textContent    = '0';
      document.getElementById('punchline-count').textContent = '0';
    } else {
      showAlert(`❌ ${escapeHtml(data.error || 'Submission failed.')}`, 'error');
    }
  } catch (err) {
    showAlert('❌ Network error — could not reach the Submit Service.', 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.querySelector('.btn-text').textContent = 'Submit to queue';
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
  setupCharCounter('setup',     'setup-count',     500);
  setupCharCounter('punchline', 'punchline-count', 500);

  document.getElementById('submitBtn').addEventListener('click', submitJoke);

  // Keyboard shortcut: Ctrl/Cmd+Enter to submit
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submitJoke();
    }
  });
});
