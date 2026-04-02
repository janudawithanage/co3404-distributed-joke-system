# Hosted vs Local Recovery Report
**Project:** CO3404 Distributed Joke System  
**Repository:** https://github.com/janudawithanage/co3404-distributed-joke-system  
**Report generated:** 03 April 2026  
**Local HEAD:** `eb5ec3b` — docs: add AZURE_PENDING.md  
**Inferred hosted baseline:** `16854a0` — fix(moderate-ui): add base href for Kong path-based routing (Thu 12 Mar 2026)  

---

## 1. Project Situation Summary

This is a four-service distributed joke submission and moderation platform deployed across three Azure VMs, fronted by a Kong 3.9.1 API gateway.

| Layer | Technology | Location |
|---|---|---|
| API Gateway | Kong 3.9.1 (DB-less) | Dedicated Kong VM — `85.211.240.162` |
| Joke service | Node.js + MySQL | VM1 — `10.0.1.4:3000` |
| ETL service | Node.js | VM1 — `10.0.1.4:3001` |
| Submit service | Node.js + RabbitMQ | VM2 — `10.0.1.5:3200` |
| Moderate service | Node.js + Auth0 (stub) | VM3 — `10.0.1.7:3300` |
| Message queue | RabbitMQ 3.x | VM2 — `10.0.1.5:5672` |
| Database | MySQL 8.0 | VM1 (Docker container) |

**Current state:** The live Azure deployment is frozen at an early March 2026 manual deploy. The local `main` branch has accumulated approximately 3–5 weeks of additional development work — a full UI redesign, new backend routes, Kong config additions, security improvements, and CI/CD pipelines — none of which has ever been deployed to Azure.

---

## 2. Why Azure Portal Access Is Unavailable

GitHub Actions CI/CD has never run because the required repository secrets have not been configured:

| Secret | Purpose | Status |
|---|---|---|
| `DOCKER_HUB_USERNAME` | Push images to Docker Hub | **Not set** |
| `DOCKER_HUB_TOKEN` | Docker Hub authentication | **Not set** |
| `VM1_HOST` | SSH target for joke/ETL deploy | **Not set** |
| `VM1_SSH_PRIVATE_KEY` | SSH auth for VM1 | **Not set** |
| `VM2_HOST` | SSH target for submit deploy | **Not set** |
| `VM2_SSH_PRIVATE_KEY` | SSH auth for VM2 | **Not set** |
| `VM3_HOST` | SSH target for moderate deploy | **Not set** |
| `VM3_SSH_PRIVATE_KEY` | SSH auth for VM3 | **Not set** |
| `KONG_PUBLIC_URL` | Kong reload target | **Not set** |

Because these secrets are absent, every `push` to `main` silently skips all deploy steps. The validate workflow runs but produces no side-effects. All five `deploy-*.yml` workflows have trigger conditions in place and are syntactically valid — only the secrets are missing.

Additionally, the filled-in `.env.vm*` files (containing real VM IPs and credentials) are not committed to git (correctly, as they contain secrets), making it impossible to reconstruct the exact deployed configuration without VM access.

---

## 3. How the Hosted State Was Inferred

With no SSH or Azure portal access, the hosted state was reconstructed entirely from the live public API surface:

### 3.1 HTTP Response Evidence
All requests used `HTTPS` to `85.211.240.162` with a self-signed TLS certificate (verification disabled for probing only).

- **Route probe** — 18 routes tested: confirmed which Kong routes exist, which return 404, and which return unexpected responses.
- **Response body diff** — all six frontend static files (`index.html`, `app.js` for each of the three UIs) fetched and compared byte-for-byte against local copies.
- **`Last-Modified` headers** — confirmed frontend file build timestamps (`Sat 07 Mar 2026` for joke-ui and submit-ui; `Thu 12 Mar 2026` for moderate-ui).
- **Swagger spec inspection** — `/docs/swagger-ui-init.js` fetched and parsed to reveal the embedded server list and API version.
- **Behaviour probe** — edge-case API calls (oversized payloads, unknown types, case variants, health checks) tested to infer backend code version.
- **Kong header inspection** — `Kong-Request-ID`, `X-Kong-Upstream-Latency`, `Via: 1.1 kong/3.9.1`, and `X-Auth-Mode` presence/absence analysed.

### 3.2 Git History Evidence
The `Last-Modified` timestamps were cross-referenced against the squashed git history to identify the closest matching commit:

- `joke-ui` + `submit-ui` → `Last-Modified: Sat, 07 Mar 2026` → commit era of `7a33b3d`/`4f2bcf6` (Mar 8)
- `moderate-ui` → `Last-Modified: Thu, 12 Mar 2026` → commit `16854a0` (Mar 12, 18:18 IST)

Commit `16854a0` is the last change that touches `moderate-service/public/index.html` before the era of the April 2026 redesign. It is therefore the most precise anchor for the full hosted baseline — all three UI files existed at or before this commit.

### 3.3 Inferred Hosted Baseline Commit
```
16854a045242f9610a659018d02ea83559defbf1
fix(moderate-ui): add base href for Kong path-based routing
Thu 12 Mar 2026 18:18:07 +0530
```

This is used as the basis for the `hosted-baseline` recovery branch.

---

## 4. Local vs Hosted Differences

### 4.1 Frontend (all 6 files differ — confirmed High confidence)

| File | Hosted | Local (HEAD) | Key divergence |
|---|---|---|---|
| `joke-service/public/index.html` | 166 lines / 4,421 bytes | 538 lines / 18,168 bytes | Full glassmorphism redesign; Space Grotesk font; config.js script tag; 🎭 favicon |
| `joke-service/public/app.js` | 123 lines / 3,849 bytes | 219 lines / 8,163 bytes | No `window.APP_CONFIG`; no `gatewayBase`; no `bases` object; no state tracking |
| `submit-service/public/index.html` | 148 lines / 4,468 bytes | 222 lines / 7,967 bytes | Full redesign; no config.js script tag; old `#10b981` accent |
| `submit-service/public/app.js` | 115 lines / 3,654 bytes | 189 lines / 6,559 bytes | No `gatewayBase`; no `withBase()`; no char counters; no keyboard shortcuts |
| `moderate-service/public/index.html` | 251 lines / 7,093 bytes | 289 lines / 10,658 bytes | No auth-warning banner; no stats panel; old amber accent |
| `moderate-service/public/app.js` | 241 lines / 7,795 bytes | 307 lines / 10,575 bytes | **Fetches `/types` (wrong endpoint)**; no exponential backoff; no keyboard shortcuts; no `authEnabled` check |

### 4.2 Backend / API (all 3 deployable server.js files differ — High confidence)

| Issue | Hosted behaviour | Local behaviour | File |
|---|---|---|---|
| POST /submit length validation | 501-char payload → **202 Accepted** | >500 chars → 400 error | `submit-service/server.js:165` |
| GET /config.js | → **404** | → 200 `window.APP_CONFIG={...}` | `joke-service/server.js:88`, `submit-service/server.js:86` |
| GET /auth-status | → **404** | → 200 `{authEnabled, mode}` | `moderate-service/server.js:142` |
| GET /moderate-types | → **404 HTML** | → 200 ECST cache | `moderate-service/server.js:192` |
| GET /me | no `authEnabled` field | includes `authEnabled: false` | `moderate-service/server.js:313` |
| GET /submit/health | `{status, service, timestamp}` only | also includes `dbType`, `rabbitmq` | `submit-service/server.js` |
| X-Auth-Mode header | absent | present on all moderate responses | `moderate-service/server.js:128` |
| Swagger server list | `https://KONG_PUBLIC_IP` literal | real Kong IP injected at startup | `submit-service/server.js:111` |
| getAuthMode() / unconfigured mode | absent from auth.js | present — 3-mode state machine | `moderate-service/auth.js` |

### 4.3 Kong / Gateway (single kong.yml file differs — High confidence)

| Route | Hosted | Local |
|---|---|---|
| `GET /health` | **404** — no route | → joke-service `/health` |
| `GET /config.js` | **404** — no route | → joke-service `/config.js` |
| `GET /auth-status` | **404** — not in `moderate-auth-route` | included in `moderate-auth-route` |
| `GET /moderate-types` | **404** — no route | → moderate-service `/moderate-types` |
| `GET /etl-health` | **404** — no route | → etl-service `/health` |
| `GET /mq-admin/` | **200** — no ip-restriction | **403** — ip-restriction plugin blocks non-allowlisted IPs |
| Rate limits | March 2026 values | Tuned limits with custom error messages |

### 4.4 Database / ETL

| Aspect | Hosted state | Local state |
|---|---|---|
| Seed joke inserts | `INSERT INTO` (old — fails on duplicate) | `INSERT IGNORE` (safe re-run) |
| Seed types | `general`, `programming`, `knock-knock`, `dad`, `science` (5 types) | Same 5 types seeded |
| Live DB types | 7 types: `bye`(id:37), `dad`(4), `general`(1), `hi`(id:31), `knock-knock`(3), `programming`(2), `science`(5) | N/A — hi and bye added post-deploy by ECST |
| `wordplay` type | Not present | Not seeded locally either (neither version has it) |
| ETL ECST pipeline | Working — hi and bye prove fanout delivered | Same code — `mod_type_update`, `sub_type_update` queues confirmed |

### 4.5 Security Gaps (hosted only)

| Gap | Hosted | Local fix |
|---|---|---|
| RabbitMQ management UI | `/mq-admin/` → **200 public** | ip-restriction plugin in kong.yml |
| Moderation UI auth | `unconfigured` — anyone can approve/reject | Auth0 credentials just need filling in |
| CORS on moderate-service | `Access-Control-Allow-Origin: *` | Locked to `AUTH0_BASE_URL` or `PUBLIC_GATEWAY_BASE` |
| Payload size limit | No limit — arbitrary length submissions accepted | 500-char cap on setup and punchline |
| No `X-Auth-Mode` header | Operators cannot detect auth state externally | Header present on all moderate-service responses |

### 4.6 Files Added Locally (do not exist at hosted-era commit)

| File | Purpose |
|---|---|
| `.github/workflows/deploy-etl.yml` | CI/CD for ETL service |
| `.github/workflows/deploy-joke.yml` | CI/CD for joke-service |
| `.github/workflows/deploy-submit.yml` | CI/CD for submit-service |
| `.github/workflows/deploy-kong.yml` | CI/CD for Kong config reload |
| `.github/workflows/validate.yml` | Docker Compose config validation |
| `test-flows.js` | End-to-end test runner (59 tests) |
| `infra/scripts/fix-*.sh` | Operational fix scripts |
| `infra/scripts/smoke-test.sh` | Post-deploy smoke test |
| `AZURE_PENDING.md` | Deployment checklist |
| `DEPLOYMENT.md` | Full deployment guide |
| `visual_audit_report.md` | Visual audit artefact |

---

## 5. Stale Deployed Components

These are running on Azure but behind the current local version:

| Component | Running version (estimated) | Why stale |
|---|---|---|
| `joke-service` Docker image | March 7–8 2026 build | No CI/CD; Docker Hub `:latest` never updated |
| `submit-service` Docker image | March 7–8 2026 build | Same |
| `moderate-service` Docker image | March 12 2026 build | Same |
| `etl-service` | Built from source on VM1 at deploy time | No `deploy-etl.yml` existed at deploy time |
| `kong.yml` | March 12 2026 version | Kong container never restarted with new config |
| `infra/vm1-compose.yml` (live on VM1) | March 2026 version | compose file never re-copied to VM |
| `infra/vm2-compose.yml` (live on VM2) | March 2026 version | Same |
| `infra/vm3-compose.yml` (live on VM3) | March 2026 version | Same |

---

## 6. Newer Local-Only Components

These exist only in the local repo and have never reached Azure:

| Component | Added in | What it does |
|---|---|---|
| Space Grotesk UI redesign (all 3 UIs) | Apr 2026 squash | New glassmorphism look, favicon, better UX |
| `window.APP_CONFIG` runtime config injection | Apr 2026 squash | Allows frontend to dynamically route through Kong |
| `withBase()` / `gatewayBase` in submit-ui | Apr 2026 squash | Routes all API calls through Kong in production |
| Auth-warning banner in moderate-ui | Apr 2026 squash | Warns users when auth is unconfigured |
| Exponential backoff polling in moderate-ui | Apr 2026 squash | Reduces server load when queue is empty |
| Session stats (approved/rejected counters) | Apr 2026 squash | Visible in moderation UI |
| `GET /config.js` route (both services) | Apr 2026 squash | Serves `window.APP_CONFIG` to browser |
| `GET /auth-status` route | Apr 2026 squash | Allows operators to inspect auth mode |
| `GET /moderate-types` route | Apr 2026 squash | Dedicated types endpoint for moderate-ui |
| `GET /etl-health` Kong route | Fix `c870fe7` | External health check for ETL |
| `GET /health` Kong route | Fix `c28215d` | External health check via Kong |
| 500-character payload validation | Fix commit | Guards against oversized submissions |
| ip-restriction on `/mq-admin/` | `dc36dae` | Closes RabbitMQ UI public exposure |
| `INSERT IGNORE` on seed jokes | Fix `0b08d6f` | Idempotent DB init on container restart |
| `X-Auth-Mode` response header | Apr 2026 squash | Auth mode observable without log access |
| `authEnabled` field in `/me` | Apr 2026 squash | UI auth-warning banner depends on this |
| `getAuthMode()` 3-mode state machine | Apr 2026 squash | `oidc` / `dev` / `unconfigured` detection |
| All CI/CD workflows (5 files) | Apr 2026 squash | Automated build + deploy on push to `main` |
| `test-flows.js` (59 E2E tests) | Apr 2026 squash | Full system simulation runner |
| Fix scripts in `infra/scripts/` | Apr 2026 squash | Operational recovery helpers |

---

## 7. Confidence Levels

| Evidence type | Confidence | What it covers |
|---|---|---|
| HTTP `Last-Modified` headers on frontend files | **High** | Build date of all 6 frontend assets |
| Live route probe (18 routes) | **High** | Exact Kong route map; which routes 404 |
| Live byte/line count comparison of frontend files | **High** | Confirms all 6 frontend files are old March builds |
| Live behaviour probe (POST payloads, edge cases) | **High** | Backend validation logic, error formats |
| `/docs/swagger-ui-init.js` inspection | **High** | Swagger server list literally shows `KONG_PUBLIC_IP` placeholder |
| Kong response headers (`Kong-Request-ID`) | **High** | Correlation-ID plugin active; version string = 3.9.1 |
| `X-Auth-Mode` header absence | **High** | Confirms old moderate-service is running |
| `authEnabled` absence in `/me` | **High** | Confirms old moderate-service is running |
| `infra/.env.vm3` file visible in editor | **High** | Auth0 values confirmed as placeholder strings |
| ETL version (cannot probe directly) | **Medium** | Inferred from ECST pipeline functioning; no direct health endpoint |
| RabbitMQ credentials strength | **Medium** | `.env.vm2`/`.env.vm3` tracked files show `REPLACE_WITH_*`; actual deployed creds unknown |
| Docker image exact SHA | **Low** | Cannot determine without Docker Hub or VM access |

---

## 8. Safest Recovery Plan

### Step 1 — Create `hosted-baseline` branch immediately (no Azure access needed)

```bash
# Creates a permanent reference to the inferred hosted state
git checkout -b hosted-baseline 16854a0
git checkout main
git push origin hosted-baseline

# Optional: tag it for maximum permanence
git tag -a v0-azure-march-2026 16854a0 -m "Last known hosted state — March 12 2026 manual deploy"
git push origin v0-azure-march-2026
```

This is non-destructive. `main` is untouched. The branch can be deleted at any time.

### Step 2 — Verify the branch is correct

```bash
# Should show 57 files changed, 5718 insertions, 776 deletions
git diff --stat hosted-baseline main | tail -3

# Browse the hosted-era version of any file
git show hosted-baseline:moderate-service/public/app.js | head -30
git show hosted-baseline:infra/kong/kong.yml | grep "name:.*route"
```

### Step 3 — Do not revert `main`

`main` is the correct forward state. Every change on `main` since March 2026 is an improvement or a bug fix. The goal is to *deploy* `main` to Azure, not to revert it.

### Step 4 — When access returns, deploy in this order

1. Set GitHub repository secrets (see `AZURE_PENDING.md` for the complete list)
2. Push to `main` → CI/CD triggers → Docker images built and pushed → VMs pull new images
3. Manually reload Kong on the Kong VM with the updated `kong.yml`
4. Fill in `infra/.env.vm3` Auth0 credentials if authentication is required
5. Run `infra/scripts/smoke-test.sh` to verify all routes

---

## 9. Recommended Next Steps Once Azure Access Returns

Ordered from safest to most impactful:

| Priority | Action | Command / location | Risk |
|---|---|---|---|
| 1 | Set GitHub Actions secrets | GitHub repo → Settings → Secrets and variables → Actions | None |
| 2 | Trigger CI/CD by pushing to `main` | `git commit --allow-empty -m "chore: trigger CI/CD" && git push` | Low |
| 3 | Verify Docker images built on Docker Hub | `docker pull janudaw/joke-service:latest` etc. | None |
| 4 | SSH to each VM and run `docker-compose pull && docker-compose up -d` | `infra/deploy.sh` or manual | Medium (brief downtime per VM) |
| 5 | Reload Kong with new config | `infra/scripts/redeploy-kong.sh` | Low |
| 6 | Run smoke test | `bash infra/scripts/smoke-test.sh` | None |
| 7 | Fill in Auth0 credentials in `infra/.env.vm3` | `infra/.env.vm3.example` for instructions | Low |
| 8 | Verify `/auth-status` → `{"authEnabled":true,"mode":"oidc"}` | `curl https://85.211.240.162/auth-status` | None |
| 9 | Verify RabbitMQ management UI is ip-restricted | `curl https://85.211.240.162/mq-admin/` → should 403 | None |
| 10 | Run full E2E test suite against live Azure | `node test-flows.js` | None |

### Critical items before any demonstration

- [ ] `/mq-admin/` must return 403 (currently returns 200 — public access)
- [ ] Auth mode must not be `unconfigured` (currently `unconfigured` — anyone can moderate)
- [ ] Swagger `/docs` must show the Kong IP as the default server (currently shows `KONG_PUBLIC_IP` literal)
- [ ] `GET /health` must return 200 (currently 404 — no Kong route)
- [ ] moderate-ui `app.js` must fetch `/moderate-types` not `/types` (currently wrong endpoint)

---

## 10. Quick Reference

| Item | Value |
|---|---|
| Kong public IP | `85.211.240.162` |
| Inferred hosted commit | `16854a0` (Thu 12 Mar 2026) |
| Local HEAD | `eb5ec3b` (03 Apr 2026) |
| Files diverged | 57 (40 modified, 17 added) |
| Lines added locally | +5,718 |
| Lines removed locally | -776 |
| Recovery branch | `hosted-baseline` (not yet created — run Step 1 above) |
| Tests passing locally | 59/59 |
| Docker Hub images | `janudaw/joke-service:latest`, `janudaw/submit-service:latest`, `janudaw/moderate-service:latest` |
| Auth mode on hosted | `unconfigured` (passthrough — no real auth) |
| Swagger default server | `https://KONG_PUBLIC_IP` (literal placeholder — bug) |
