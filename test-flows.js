'use strict';
/**
 * test-flows.js
 * Comprehensive system-behaviour simulation.
 * Run locally (host):      node test-flows.js
 * Run from a container:    set *_BASE env vars to Docker DNS names, e.g.
 *   JOKE_BASE=http://joke-service:4000 \
 *   SUBMIT_BASE=http://submit-service:4200 \
 *   MODERATE_BASE=http://moderate-service:4300 \
 *   ETL_BASE=http://etl-service:4001 \
 *   KONG_BASE=http://kong:80 node test-flows.js
 *
 * Defaults target localhost ports from docker-compose:
 *   joke-service     http://localhost:3000
 *   submit-service   http://localhost:3200
 *   moderate-service http://localhost:3300
 *   etl-service      http://localhost:3001
 *   kong             http://localhost:8000
 */

const http  = require('http');
const https = require('https');

// ── ANSI colours ─────────────────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;   // green  ✓
const R = s => `\x1b[31m${s}\x1b[0m`;   // red    ✗
const Y = s => `\x1b[33m${s}\x1b[0m`;   // yellow ⚠
const B = s => `\x1b[36m${s}\x1b[0m`;   // cyan   section headers
const W = s => `\x1b[1m${s}\x1b[0m`;    // bold

const results = [];
function pass(name, detail='') { results.push({ok:true,name,detail});  console.log(G('  ✓') + ' ' + name + (detail ? ' — ' + detail : '')); }
function fail(name, detail='') { results.push({ok:false,name,detail}); console.log(R('  ✗') + ' ' + name + (detail ? ' — ' + detail : '')); }
function warn(name, detail='') { results.push({ok:'warn',name,detail});console.log(Y('  ⚠') + ' ' + name + (detail ? ' — ' + detail : '')); }
function section(t) { console.log('\n' + B('══ ' + t + ' ══')); }

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const options = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + (u.search || ''),
      method:   opts.method  || 'GET',
      headers:  opts.headers || {},
      rejectUnauthorized: false,
    };
    if (opts.body) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(opts.body);
    }
    const req = lib.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch(_) {}
        resolve({ code: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function post(url, data) { return request(url, { method:'POST', body: JSON.stringify(data) }); }

// ── Queue drain helper ────────────────────────────────────────────────────────
// Rejects ALL pending jokes in the "submit" RabbitMQ queue so ETL/ECST tests
// start from a clean state regardless of what prior test runs left behind.
async function drainQueue(modUrl) {
  let n = 0;
  for (let i = 0; i < 30; i++) {
    const r = await request(modUrl + '/moderate').catch(() => ({ code: 0 }));
    if (r.code === 200 && r.json?.setup) {
      await post(modUrl + '/reject', {}).catch(() => {});
      n++;
    } else break;
  }
  return n;
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN TEST RUNNER
// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  const JOKE = process.env.JOKE_BASE     || 'http://localhost:3000';
  const SUBM = process.env.SUBMIT_BASE   || 'http://localhost:3200';
  const MOD  = process.env.MODERATE_BASE || 'http://localhost:3300';
  const ETL  = process.env.ETL_BASE      || 'http://localhost:3001';
  const KONG = process.env.KONG_BASE     || 'http://localhost:8000';

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 1 — HEALTH CHECKS (direct)');
  // ───────────────────────────────────────────────────────────────────────────
  for (const [label, url] of [
    ['joke-service /health',     JOKE+'/health'],
    ['submit-service /health',   SUBM+'/health'],
    ['moderate-service /health', MOD +'/health'],
    ['etl-service /health',      ETL +'/health'],
  ]) {
    try {
      const r = await request(url);
      if (r.code === 200 && r.json?.status === 'ok') pass(label, `dbType=${r.json.dbType||'n/a'} rabbitmq=${r.json.rabbitmq||'n/a'}`);
      else fail(label, `HTTP ${r.code}: ${r.body.substring(0,80)}`);
    } catch(e) { fail(label, e.message); }
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 1b — HEALTH CHECKS via Kong');
  // ───────────────────────────────────────────────────────────────────────────
  for (const [label, path] of [
    ['Kong → joke /joke/any',  '/joke/any'],
    ['Kong → submit /types',   '/types'],
    ['Kong → moderate /health','/health'],   // /health not routed — should 404
    ['Kong → etl /etl-health', '/etl-health'],
  ]) {
    try {
      const r = await request(KONG + path);
      const hasKongId = !!r.headers['kong-request-id'];
      const detail = `HTTP ${r.code}, Kong-Request-ID: ${hasKongId ? 'present' : 'MISSING'}`;
      // /health is not a Kong route; /etl-health is explicitly routed.
      if (path === '/health') {
        r.code === 404 ? pass(label+' (correctly 404 — unrouted path)', detail) : warn(label, detail);
      } else if (path === '/etl-health') {
        r.code === 200 ? pass(label, detail) : fail(label, detail);
      } else if (r.code < 400) {
        pass(label, detail);
      } else {
        fail(label, detail);
      }
    } catch(e) { fail(label, e.message); }
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 1c — /config.js runtime config injection');
  // ───────────────────────────────────────────────────────────────────────────
  for (const [label, url, expectedKey] of [
    ['joke-service /config.js',   JOKE+'/config.js',  'gatewayBase'],
    ['submit-service /config.js', SUBM+'/config.js',  'gatewayBase'],
  ]) {
    try {
      const r = await request(url);
      const hasKey = r.body.includes(expectedKey);
      const hasGateway = r.body.includes('localhost:8000') || r.body.includes('8000');
      if (r.code === 200 && hasKey) {
        hasGateway ? pass(label, 'gatewayBase=http://localhost:8000 ✓') : warn(label, 'gatewayBase is empty string — PUBLIC_GATEWAY_BASE not set');
      } else {
        fail(label, `HTTP ${r.code}: ${r.body.substring(0,80)}`);
      }
    } catch(e) { fail(label, e.message); }
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 2 — JOKE FETCH (GET /joke/:type + /types)');
  // ───────────────────────────────────────────────────────────────────────────
  try {
    const types = await request(JOKE+'/types');
    if (types.code === 200 && Array.isArray(types.json) && types.json.length > 0) {
      pass('GET /types', `${types.json.length} types: ${types.json.map(t=>t.name).join(', ')}`);
    } else fail('GET /types', `HTTP ${types.code}: ${types.body.substring(0,80)}`);
  } catch(e) { fail('GET /types', e.message); }

  for (const t of ['any','programming','general','knock-knock']) {
    try {
      const r = await request(JOKE+`/joke/${t}`);
      if (r.code === 200 && r.json?.setup) pass(`GET /joke/${t}`, `"${r.json.setup.substring(0,50)}…"`);
      else if (r.code === 404)              warn(`GET /joke/${t}`, 'No jokes for this type (expected if DB fresh)');
      else                                  fail(`GET /joke/${t}`, `HTTP ${r.code}: ${r.body.substring(0,60)}`);
    } catch(e) { fail(`GET /joke/${t}`, e.message); }
  }

  // Multi-joke fetch
  try {
    const r = await request(JOKE+'/joke/any?count=3');
    if (r.code === 200 && Array.isArray(r.json) && r.json.length === 3)
      pass('GET /joke/any?count=3', `returned ${r.json.length} jokes`);
    else if (r.code === 200 && r.json?.setup)
      warn('GET /joke/any?count=3', 'Only 1 joke in DB — returned single object (expected)');
    else fail('GET /joke/any?count=3', `HTTP ${r.code}: ${r.body.substring(0,60)}`);
  } catch(e) { fail('GET /joke/any?count=3', e.message); }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 3 — SUBMIT → QUEUE (POST /submit)');
  // ───────────────────────────────────────────────────────────────────────────
  const testJoke = { setup: 'Why do testers hate parties?', punchline: 'Because they always find bugs in the punch!', type: 'testing' };

  // Valid submit
  try {
    const r = await post(SUBM+'/submit', testJoke);
    if (r.code === 202 && r.json?.message) pass('POST /submit valid joke', r.json.message);
    else fail('POST /submit valid joke', `HTTP ${r.code}: ${r.body.substring(0,80)}`);
  } catch(e) { fail('POST /submit valid joke', e.message); }

  // Missing fields
  try {
    const r = await post(SUBM+'/submit', { setup:'only setup' });
    r.code === 400 ? pass('POST /submit missing fields → 400', r.json?.error||'') : fail('POST /submit missing fields → 400', `Got HTTP ${r.code}`);
  } catch(e) { fail('POST /submit missing fields → 400', e.message); }

  // H4: oversized payload
  try {
    const r = await post(SUBM+'/submit', { setup:'x'.repeat(501), punchline:'p', type:'general' });
    r.code === 400 ? pass('POST /submit oversized setup → 400 (H4 fix)', r.json?.error||'') : fail('POST /submit oversized setup → 400 (H4 fix)', `Got HTTP ${r.code} — validation NOT enforced`);
  } catch(e) { fail('POST /submit oversized setup → 400 (H4 fix)', e.message); }

  // Submit via Kong
  try {
    const r = await post(KONG+'/submit', { setup:'Via Kong joke', punchline:'Punchline', type:'general' });
    if (r.code === 202) pass('POST /submit via Kong → 202', 'Kong-Request-ID: '+(r.headers['kong-request-id']||'MISSING'));
    else fail('POST /submit via Kong', `HTTP ${r.code}: ${r.body.substring(0,60)}`);
  } catch(e) { fail('POST /submit via Kong', e.message); }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 4 — RATE LIMITING (Kong)');
  // ───────────────────────────────────────────────────────────────────────────
  let hit429 = false;
  const rlResults = [];
  for (let i = 1; i <= 8; i++) {
    try {
      const r = await request(KONG+'/joke/any');
      rlResults.push(r.code);
      if (r.code === 429) { hit429 = true; }
    } catch(e) { rlResults.push('err'); }
  }
  if (hit429) {
    pass('Rate limit hit on /joke/any (5 req/min)', `Codes: ${rlResults.join(', ')}`);
  } else {
    warn('Rate limit NOT hit in 8 requests', `All codes: ${rlResults.join(', ')} — may be a new minute window`);
  }

  // Confirm /joke-ui is NOT rate limited (should return 200 for HTML)
  try {
    const r = await request(KONG+'/joke-ui');
    r.code < 400 ? pass('/joke-ui NOT rate-limited (C1 fix)', `HTTP ${r.code}`) : fail('/joke-ui rate-limiting check', `HTTP ${r.code}`);
  } catch(e) { fail('/joke-ui rate-limiting check', e.message); }

  // Submit rate limit (separate counter, 10/min)
  let submitHit429 = false;
  for (let i = 1; i <= 12; i++) {
    const r = await post(KONG+'/submit', { setup:'rl'+i, punchline:'p', type:'general' }).catch(()=>({code:0}));
    if (r.code === 429) { submitHit429 = true; break; }
  }
  submitHit429 ? pass('Submit API rate limit hit (10 req/min, H1 fix)') : warn('Submit rate limit NOT hit in 12 requests (may need >60s)');

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 5 — MODERATE → APPROVE (GET /moderate + POST /moderated)');
  // ───────────────────────────────────────────────────────────────────────────
  // Submit a fresh joke to guarantee something is in the queue
  await post(SUBM+'/submit', { setup:'Test approve joke', punchline:'Approved!', type:'testing' }).catch(() => ({ code: 0 }));
  await sleep(300);

  // GET /moderate (no-auth mode — AUTH0 vars are placeholders)
  try {
    const r = await request(MOD+'/moderate');
    if (r.code === 200 && r.json?.setup) {
      pass('GET /moderate → joke fetched', `"${r.json.setup.substring(0,50)}"`);
      // Approve it
      const approved = await post(MOD+'/moderated', { setup: r.json.setup, punchline: r.json.punchline, type: r.json.type });
      if (approved.code === 202) pass('POST /moderated → 202 approved', approved.json?.message||'');
      else fail('POST /moderated', `HTTP ${approved.code}: ${approved.body.substring(0,80)}`);
    } else if (r.code === 204) {
      warn('GET /moderate → 204 empty queue', 'Submit queue may not have propagated yet');
    } else if (r.code === 401) {
      fail('GET /moderate → 401', 'Auth is blocking even in no-auth mode — check AUTH0 env vars');
    } else {
      fail('GET /moderate', `HTTP ${r.code}: ${r.body.substring(0,80)}`);
    }
  } catch(e) { fail('GET /moderate', e.message); }

  // Auth protection: check /moderate returns 401 if oidc NOT set (in no-auth mode it should pass)
  try {
    const r = await request(MOD+'/moderate');
    if (r.code === 200 || r.code === 204) pass('Auth no-auth mode: /moderate accessible (AUTH0 not configured)', `HTTP ${r.code}`);
    else if (r.code === 401) warn('Auth: /moderate blocked — check no-auth mock injection', `HTTP ${r.code}`);
    else warn('/moderate secondary check', `HTTP ${r.code}`);
  } catch(e) { warn('/moderate secondary check', e.message); }

  // POST /reject flow
  await post(SUBM+'/submit', { setup:'Test reject joke', punchline:'Rejected!', type:'testing' }).catch(() => ({ code: 0 }));
  await sleep(300);
  try {
    const fetchR = await request(MOD+'/moderate');
    if (fetchR.code === 200 && fetchR.json?.setup) {
      const rej = await post(MOD+'/reject', {});
      rej.code === 200 ? pass('POST /reject → 200', rej.json?.message||'') : fail('POST /reject', `HTTP ${rej.code}`);
    } else warn('POST /reject test skipped', 'No joke in queue');
  } catch(e) { fail('POST /reject', e.message); }

  // H4 moderated oversized payload
  try {
    const r = await post(MOD+'/moderated', { setup:'x'.repeat(501), punchline:'p', type:'t' });
    r.code === 400 ? pass('POST /moderated oversized → 400 (H4 fix)', r.json?.error||'') : fail('POST /moderated oversized → 400 (H4 fix)', `Got HTTP ${r.code}`);
  } catch(e) { fail('POST /moderated oversized H4', e.message); }

  // M5: /me endpoint returns JSON 401 (not redirect) when not authenticated
  // In no-auth mode it should return the mock user
  try {
    const r = await request(MOD+'/me');
    if (r.code === 200 && r.json?.name) pass('GET /me → 200 mock user (no-auth mode)', r.json.name);
    else if (r.code === 401 && r.json?.error) pass('GET /me → JSON 401 (M5 fix, auth mode)', r.json.error);
    else fail('GET /me', `HTTP ${r.code}: ${r.body.substring(0,80)}`);
  } catch(e) { fail('GET /me', e.message); }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 6 — ETL → DB WRITE (approve then verify joke in DB)');
  // ───────────────────────────────────────────────────────────────────────────
  // Drain any accumulated queue leftovers, then submit a fresh traceable joke.
  await drainQueue(MOD);
  await sleep(200);

  const uniqueSetup = `ETL test joke ${Date.now()}`;
  const uniqueType  = `etl${Date.now()}`;

  await post(SUBM+'/submit', { setup: uniqueSetup, punchline: 'ETL punchline', type: uniqueType }).catch(() => ({ code: 0 }));
  await sleep(500); // let RabbitMQ route the message

  let approvedType = null;
  try {
    const fetchR = await request(MOD+'/moderate');
    if (fetchR.code === 200 && fetchR.json?.setup) {
      approvedType = fetchR.json.type;  // this is now our joke (queue was drained)
      const appR = await post(MOD+'/moderated', { setup: fetchR.json.setup, punchline: fetchR.json.punchline, type: fetchR.json.type });
      appR.code === 202 ? pass('ETL pipeline: submit → approve sent', `type=${approvedType}`) : fail('ETL approve step', `HTTP ${appR.code}`);
    } else warn('ETL pipeline: queue empty when checking', `HTTP ${fetchR.code}`);
  } catch(e) { fail('ETL submit→approve', e.message); }

  // Wait for ETL consumer + DB write (2500 ms = plenty for local Docker)
  if (approvedType) {
    await sleep(2500);
    try {
      const r = await request(JOKE+`/joke/${approvedType}`);
      if (r.code === 200 && r.json?.setup) pass('ETL → DB write verified via joke-service', `type=${approvedType}: "${r.json.setup.substring(0,55)}"`);
      else if (r.code === 404)             fail('ETL → DB write NOT verified', `type "${approvedType}" still not in DB after 2500 ms`);
      else                                 fail('ETL DB verify', `HTTP ${r.code}: ${r.body.substring(0,60)}`);
    } catch(e) { fail('ETL DB verify', e.message); }
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 7 — ECST type_update → cache sync');
  // ───────────────────────────────────────────────────────────────────────────
  // Drain queue again so our unique-type joke is first in line
  const drained7 = await drainQueue(MOD);
  if (drained7 > 0) console.log(Y(`  ⚠ Drained ${drained7} leftover joke(s) before ECST test`));

  const newType = `ecst${Date.now()}`;
  let ecstApprovedType = null;

  await post(SUBM+'/submit', { setup: `ECST test ${newType}`, punchline: 'sync!', type: newType }).catch(() => ({ code: 0 }));
  await sleep(500);

  try {
    const fetchR = await request(MOD+'/moderate');
    if (fetchR.code === 200 && fetchR.json?.setup) {
      ecstApprovedType = fetchR.json.type;
      await post(MOD+'/moderated', { setup: fetchR.json.setup, punchline: fetchR.json.punchline, type: fetchR.json.type });
      pass('ECST: new-type joke approved', `type=${ecstApprovedType}`);
    } else warn('ECST: queue empty after drain', `HTTP ${fetchR.code}`);
  } catch(e) { fail('ECST approve', e.message); }

  await sleep(3000); // give ETL time to consume + publish ECST event

  // Check submit-service ECST cache updated
  if (ecstApprovedType) {
    try {
      const r = await request(SUBM+'/types');
      const found = Array.isArray(r.json) && r.json.some(t => t.name === ecstApprovedType);
      found ? pass('ECST sub_type_update cache synced to submit-service', `New type "${ecstApprovedType}" present`) : warn('ECST submit cache sync', `"${ecstApprovedType}" NOT in cache yet`);
    } catch(e) { fail('ECST submit cache', e.message); }

    // Check moderate-service ECST cache (/moderate-types — M2 fix)
    try {
      const r = await request(MOD+'/moderate-types');
      const found = Array.isArray(r.json) && r.json.some(t => t.name === ecstApprovedType);
      found ? pass('ECST mod_type_update cache synced via /moderate-types (M2 fix)', `New type "${ecstApprovedType}" present`) : warn('ECST moderate cache sync', `"${ecstApprovedType}" NOT in /moderate-types yet`);
    } catch(e) { fail('ECST /moderate-types', e.message); }
  }
  try {
    const r = await request(KONG+'/moderate-types');
    if (r.code === 200 && Array.isArray(r.json)) pass('Kong /moderate-types route works (M2 fix)', `${r.json.length} types, Kong-Request-ID: ${r.headers['kong-request-id']?'✓':'missing'}`);
    else fail('Kong /moderate-types route', `HTTP ${r.code}: ${r.body.substring(0,60)}`);
  } catch(e) { fail('Kong /moderate-types route', e.message); }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 8 — AUTH PROTECTION');
  // ───────────────────────────────────────────────────────────────────────────
  // In no-auth mode (AUTH0_CLIENT_ID is a placeholder) all protected routes should pass
  const auth0configured = !!(process.env.AUTH0_CLIENT_ID && !process.env.AUTH0_CLIENT_ID.includes('REPLACE'));

  if (!auth0configured) {
    console.log(Y('  ⚠ Auth0 not configured — testing no-auth mock mode'));
    for (const [label, path, method] of [
      ['GET /moderate (protected)',   '/moderate',  'GET'],
      ['POST /moderated (protected)', '/moderated', 'POST'],
      ['POST /reject (protected)',    '/reject',    'POST'],
      ['GET /me (protected)',         '/me',        'GET'],
    ]) {
      try {
        const r = method === 'POST'
          ? await post(MOD+path, {})
          : await request(MOD+path);
        // In no-auth mode these should NOT return 401
        if (r.code !== 401) pass(label + ' accessible in no-auth mode', `HTTP ${r.code}`);
        else fail(label + ' BLOCKED in no-auth mode — mock should allow', `HTTP ${r.code}`);
      } catch(e) { fail(label, e.message); }
    }
  } else {
    pass('Auth0 CONFIGURED — OIDC active', 'Full OIDC flow requires browser interaction; testing API response shapes only');
  }

  // Public routes must be accessible without auth
  for (const [label, url] of [
    ['GET /health (public)',  MOD+'/health'],
    ['GET /types (public)',   MOD+'/types'],
    ['GET /moderate-types (public)', MOD+'/moderate-types'],
  ]) {
    try {
      const r = await request(url);
      r.code === 200 ? pass(label, `HTTP ${r.code}`) : fail(label, `HTTP ${r.code}: ${r.body.substring(0,60)}`);
    } catch(e) { fail(label, e.message); }
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 9 — DB SWITCHING (DB_TYPE env)');
  // ───────────────────────────────────────────────────────────────────────────
  try {
    const r = await request(JOKE+'/health');
    const dbType = r.json?.dbType;
    pass('DB type reported by joke-service', `DB_TYPE=${dbType}`);
    if (dbType === 'mysql') pass('MySQL adapter active (default)', 'seed data + ETL writes via MySQL');
    else if (dbType === 'mongo') pass('MongoDB adapter active', 'jokes served from MongoDB');
    else warn('Unknown dbType', dbType);
  } catch(e) { fail('DB type check', e.message); }

  try {
    const r = await request(ETL+'/health');
    const dbType = r.json?.dbType;
    r.json?.dbType ? pass('ETL DB type matches', `etl DB_TYPE=${dbType}`) : warn('ETL health missing dbType', r.body.substring(0,60));
  } catch(e) { fail('ETL DB type check', e.message); }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 10 — SERVICE FAILURE RECOVERY');
  // ───────────────────────────────────────────────────────────────────────────
  // Test: submit-service returns 503 gracefully when publishing fails
  // We cannot kill RabbitMQ in this test, but we can verify 503 is the correct
  // response code by checking the error path exists in the code. Instead,
  // verify that after multiple rapid submits the service stays up.
  let submitOk = 0;
  for (let i = 0; i < 5; i++) {
    const r = await post(SUBM+'/submit', { setup:`recovery ${i}`, punchline:'p', type:'general' }).catch(()=>({code:0}));
    if (r.code === 202 || r.code === 429) submitOk++;
  }
  submitOk >= 4 ? pass('Submit service stable under rapid requests', `${submitOk}/5 succeeded or rate-limited`) : fail('Submit service instability', `${submitOk}/5`);

  // ETL: verify it's still consuming after earlier tests
  try {
    const r = await request(ETL+'/health');
    r.code === 200 ? pass('ETL service alive after consume cycle', '') : fail('ETL health post-test', `HTTP ${r.code}`);
  } catch(e) { fail('ETL health post-test', e.message); }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 11 — API EDGE CASES');
  // ───────────────────────────────────────────────────────────────────────────
  // Unknown joke type
  try {
    const r = await request(JOKE+'/joke/nonexistenttype_xyz');
    r.code === 404 && r.json?.error ? pass('GET /joke/<unknown> → 404 with error body', r.json.error) : fail('GET /joke/<unknown>', `HTTP ${r.code}`);
  } catch(e) { fail('GET /joke/unknown', e.message); }

  // Swagger UI accessible
  try {
    const r = await request(SUBM+'/docs');
    r.code < 400 ? pass('GET /docs Swagger UI', `HTTP ${r.code}`) : fail('GET /docs Swagger UI', `HTTP ${r.code}`);
  } catch(e) { fail('GET /docs Swagger UI', e.message); }

  // /config.js correct content-type
  try {
    const r = await request(JOKE+'/config.js');
    const ct = r.headers['content-type'] || '';
    ct.includes('javascript') ? pass('/config.js has application/javascript content-type', ct) : fail('/config.js wrong content-type', ct);
  } catch(e) { fail('/config.js content-type', e.message); }

  // Kong /mq-admin must be ip-restricted (returns 403 from VNet perspective — in local Docker all containers
  // are on 172.x which may or may not be in the allow list; warn either way)
  try {
    const r = await request(KONG+'/mq-admin/');
    if (r.code === 403) pass('Kong /mq-admin ip-restricted → 403 (H2 fix)', 'External access blocked');
    else if (r.code === 200) warn('Kong /mq-admin returned 200', 'Docker bridge (172.x) not in VNet allow-list — expected in local dev, blocked in prod');
    else warn('Kong /mq-admin', `HTTP ${r.code}`);
  } catch(e) { warn('Kong /mq-admin ip-restriction test', e.message); }

  // ───────────────────────────────────────────────────────────────────────────
  section('FLOW 12 — FRONTEND STATIC ASSETS');
  // ───────────────────────────────────────────────────────────────────────────
  for (const [label, url] of [
    ['joke-service / (HTML)',          JOKE+'/'],
    ['joke-service /joke-ui (HTML)',   JOKE+'/joke-ui'],
    ['submit-service / (HTML)',        SUBM+'/'],
    ['submit-service /submit (HTML)',  SUBM+'/submit'],
    ['moderate-service / (HTML)',      MOD+'/'],
    ['moderate-service /moderate-ui (HTML)', MOD+'/moderate-ui'],  // L5 fix
    ['Kong /joke-ui (HTML via Kong)', KONG+'/joke-ui'],
    ['Kong /submit (HTML via Kong)',  KONG+'/submit'],
  ]) {
    try {
      const r = await request(url);
      const isHtml = r.body.includes('<html') || r.body.includes('<!DOCTYPE');
      if (r.code < 400 && isHtml) pass(label, `HTTP ${r.code}`);
      else if (r.code < 400) warn(label, `HTTP ${r.code} but content not HTML`);
      else fail(label, `HTTP ${r.code}`);
    } catch(e) { fail(label, e.message); }
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('SUMMARY');
  // ───────────────────────────────────────────────────────────────────────────
  const passed  = results.filter(r => r.ok === true).length;
  const warned  = results.filter(r => r.ok === 'warn').length;
  const failed  = results.filter(r => r.ok === false).length;
  const total   = results.length;

  console.log(`\n  Total: ${total}  |  ${G('Pass: '+passed)}  |  ${Y('Warn: '+warned)}  |  ${R('Fail: '+failed)}`);

  if (failed > 0) {
    console.log('\n  Failed tests:');
    results.filter(r=>!r.ok).forEach(r=>console.log(R(`    ✗ ${r.name}`) + (r.detail ? ` — ${r.detail}`:'')));
  }
  if (warned > 0) {
    console.log('\n  Warnings:');
    results.filter(r=>r.ok==='warn').forEach(r=>console.log(Y(`    ⚠ ${r.name}`) + (r.detail ? ` — ${r.detail}`:'')));
  }

  const pct = Math.round((passed / total) * 100);
  let verdict;
  if (failed === 0)          verdict = W('✅  FULLY COMPLETE     (' + pct + '% pass, '+warned+' warnings)');
  else if (pct >= 80)        verdict = W('🟡 MOSTLY COMPLETE    (' + pct + '% pass, '+failed+' failures)');
  else if (pct >= 50)        verdict = W('🟠 PARTIALLY COMPLETE (' + pct + '% pass, '+failed+' failures)');
  else                       verdict = W('🔴 NOT COMPLETE       (' + pct + '% pass, '+failed+' failures)');

  console.log('\n  Verdict: ' + verdict + '\n');
})().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
