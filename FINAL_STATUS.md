# Final Submission Status

> **Module:** CO3404 Distributed Systems — Ulster University
> **Date:** 3 April 2026

---

## Test Results

```bash
node test-flows.js
```

| Metric | Result |
|---|---|
| Total tests | 59 |
| Passed | **58** |
| Failed | **0** |
| Warnings | 1 (benign) |

**The 1 warning** (FLOW 9): auth mode reports `dev` locally. This is the correct value for a stack with `AUTH_ENABLED=false`. The test validates the JSON shape of `/auth-status` — it passes.

---

## Bug Fixes Applied

All 8 bugs identified in the visual audit report have been resolved:

| ID | Description | Fix |
|---|---|---|
| L1 | Missing `<base href="/joke-ui/">` — relative assets 404 through Kong | Added to `joke-service/public/index.html` |
| L2 | Kong ip-restriction `deny: 0.0.0.0/0` overrode the `allow` list — blocked all access | Removed `deny` entry; added Docker Desktop bridge CIDR |
| L3 | MySQL charset mismatch (`latin1` vs `utf8mb4`) in `init.sql` and live tables | Added `DEFAULT CHARSET=utf8mb4`; `ALTER TABLE ... CONVERT TO CHARACTER SET utf8mb4` migrations |
| L4 | Test-generated types and jokes accumulating in the database between runs | Added post-test cleanup SQL; pre-test queue drain in `test-flows.js` |
| L5 | `AUTH_ENABLED=false` undocumented — easy to expose publicly without auth | Warning block in `.env.example`; startup detector in `moderate-service/server.js` |
| L6 | Swagger "Try it out" defaulted to direct service port instead of Kong URL | Kong listed first in Swagger server list |
| L7 | Submit UI loaded `config.js` twice (duplicate absolute `<script>` tag) | Removed redundant `<script src="/config.js">` tag |
| L8 | 5 stale messages in RabbitMQ causing spurious test failures | Purged via management API; pre-test drain added to test suite |

---

## Deployment State

| Component | Status |
|---|---|
| Local Docker Compose | ✅ All services healthy |
| MySQL | ✅ Schema correct (`utf8mb4_0900_ai_ci`); 5 types, 11 seed jokes |
| RabbitMQ | ✅ All queues and fanout exchange configured; 0 stale messages |
| Auth mode (local) | ✅ Dev/demo mode — full moderation pipeline works without Auth0 login |
| Azure VMs (VM1–VM4) | ⚠️ May be deallocated — student subscription, no uptime guarantee |
| GitHub Actions CI/CD | ✅ Workflows for joke, submit, moderate, etl, kong — all passing |

---

## Commit History

```
5d1688f  chore: deep cleanup — remove dead code, stale files, doc fixes
9ecc397  fix: BUG-L3 live DB migration + BUG-L5 auth warnings + test hygiene
1be599f  fix: final audit pass — all critical and significant bugs resolved
```

---

## Local Verification Commands

```bash
# Start the stack
docker compose up -d

# Run the full test suite
node test-flows.js
# Expected: 58 pass · 0 fail · 1 warning

# Spot-check key routes
curl http://localhost:8000/types
curl http://localhost:8000/joke/programming
curl http://localhost:8000/auth-status

# Rate limit test (requests 6–8 should return 429)
for i in $(seq 1 8); do
  echo -n "Request $i: "
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/joke/any
done
```
