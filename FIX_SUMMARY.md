# Fix Summary — CO3404 Option 3 Audit

**Date:** 7 March 2026

This file documents every file changed during the post-audit fix pass and explains why each change was made.

---

## Changed Files

### 1. `.env`
**Change:** Removed two stale variables: `DB_TYPE=MYSQL` and `MONGO_HOST=mongodb`.  
**Why:** These variables were leftover from an earlier MongoDB experiment that was abandoned. Neither is referenced in `docker-compose.yml` or any service source file. Their presence was misleading and made the `.env` inconsistent with `.env.example`.

---

### 2. `.env.example`
**Change:** Removed the same stale `DB_TYPE` and `MONGO_HOST` variables from the example file.  
**Why:** The example file should exactly mirror the expected `.env` contents. It had already been inconsistent (`.env` had the stale vars, `.env.example` did not), so this brings them into alignment. The example file is the authoritative reference for new deployments.

---

### 3. `docker-compose.yml`
**Change:** Added `healthcheck` blocks to `joke-service` and `etl-service`.  
**Why:** Both services expose a `GET /health` endpoint but had no Docker healthcheck configured. Without healthchecks, `docker compose ps` shows "running" instead of "healthy", and other services cannot use `condition: service_healthy` in their `depends_on`. The healthcheck uses `wget -qO- http://localhost:<port>/health` (available in `node:18-alpine`).

---

### 4. `infra/vm1-compose.yml`
**Change:** Added identical `healthcheck` blocks to `joke-service` and `etl-service`.  
**Why:** Same reason as above. The VM compose files should mirror the local compose healthcheck behaviour for consistent monitoring in the Azure deployment.

---

### 5. `infra/vm2-compose.yml`
**Change (a):** Added `healthcheck` to `submit-service`.  
**Why:** Same reason — the service exposes `/health` but had no Docker healthcheck.

**Change (b):** Added `KONG_PUBLIC_IP: ${KONG_PUBLIC_IP:-}` to `submit-service` environment.  
**Why:** The Swagger UI server dropdown (in `submit-service/server.js`) now reads this env var to populate the Kong server URL automatically. The `${KONG_PUBLIC_IP:-}` syntax means the variable defaults to an empty string if not set, so the service starts without error whether or not the var is provided.

---

### 6. `infra/.env.vm2.example`
**Change:** Added an optional `KONG_PUBLIC_IP` field with documentation comment.  
**Why:** Operators deploying to VM2 can optionally set this value (obtained from `terraform output -raw kong_public_ip`) to make the Swagger UI show the correct Kong server URL in its dropdown. Without it, the UI shows a `<KONG_PUBLIC_IP>` placeholder which is functional but less polished.

---

### 7. `infra/terraform/kong.yml.tpl`
**Change:** Added a new route `submit-docs-route` to the `submit-service` service definition.  
**Why:** The Submit Service exposes a Swagger UI at `GET /docs` but this path was not exposed through Kong. Assessors and reviewers accessing the API through the single Kong origin (`https://KONG_IP/docs`) would get a 404. The new route maps `GET /docs` to the submit-service without stripping the path, making the Swagger UI accessible through HTTPS via Kong.

---

### 8. `submit-service/server.js`
**Change:** Replaced the hardcoded `'https://KONG_PUBLIC_IP'` placeholder in the Swagger server list with a dynamic value read from `process.env.KONG_PUBLIC_IP`.  
**Why:** A static placeholder string in the Swagger UI is confusing and makes the "Kong API Gateway" server option non-functional. The new code reads the env var at startup: if set, the Swagger UI shows the real Kong HTTPS URL; if not set, it shows a clearly labelled placeholder with a hint to set the env var. This is backwards-compatible — the service still starts without the env var.

---

### 9. `submit-service/public/index.html`
**Change:** Replaced the footer link `<a href="/joke/any">🤣 View Jokes (via Kong)</a>` with `<a href="/health">❤️ Health Check</a>`.  
**Why:** The `/joke/any` link worked through Kong but was broken when the Submit UI was accessed directly at `http://localhost:3002` (resolves to `http://localhost:3002/joke/any` which returns 404 — there is no joke route on the Submit service). The `/health` endpoint exists on the Submit service itself and is always accessible in both local and deployed contexts.

---

## New Files Created

### `AUDIT_REPORT.md`
Full assessment audit report including detected architecture, requirements checklist (PASS/PARTIAL/FAIL), issues found, fixes applied, known limitations, and grade assessment.

### `RUN_AND_TEST.md`
Complete run and test guide covering local Docker setup, RabbitMQ queue flow verification, type cache fallback testing, resilience testing, Azure deployment, Kong gateway verification, HTTPS verification, rate limiting demonstration, and submission checklist.

### `FIX_SUMMARY.md`
This file.

---

## Files Reviewed but NOT Changed

| File | Reason not changed |
|------|--------------------|
| `joke-service/server.js` | Correct implementation of all Option 1 + 2 requirements |
| `joke-service/db.js` | Correct connection pool with retry logic |
| `joke-service/public/index.html` | Clean UI; punchline timing via setTimeout is correct |
| `joke-service/public/app.js` | 3-second reveal via CSS transition + setTimeout is correct |
| `joke-service/Dockerfile` | Correct node:18-alpine multi-layer build |
| `joke-service/package.json` | Correct minimal dependencies |
| `submit-service/rabbitmq.js` | Correct durable queue + persistent messages + auto-reconnect |
| `submit-service/public/app.js` | Correct form validation + type cache fallback in UI |
| `etl-service/server.js` | Correct at-least-once delivery: ack/nack logic is textbook correct |
| `etl-service/db.js` | Correct; intentionally near-identical to joke-service/db.js (microservice isolation) |
| `etl-service/Dockerfile` | Correct |
| `etl-service/package.json` | Correct minimal dependencies |
| `db/init.sql` | Correct schema + seed data; UNIQUE constraint prevents duplicate types |
| `infra/terraform/main.tf` | Correct Azure resource creation + provisioners |
| `infra/terraform/variables.tf` | Well-documented variables with sensible defaults |
| `infra/terraform/outputs.tf` | Useful post-apply outputs with ready-to-use test commands |
| `infra/terraform/terraform.tfvars.example` | Clear template with instructions |
| `infra/kong/docker-compose.yml` | Correct Kong 3.9 DB-less container configuration |
| `infra/vm1-setup.sh` | Correct Docker install bootstrap for Ubuntu 22.04 |
| `infra/vm2-setup.sh` | Correct (identical to vm1-setup.sh — appropriate) |
| `infra/vm3-setup.sh` | Correct alternative manual bootstrap for Kong VM |
| `infra/deploy.sh` | Correct scp deployment script |
| `infra/.env.vm1.example` | No changes needed |
| `.gitignore` | Correct — all secrets, state, generated files properly excluded |

---

*Fix summary generated: 7 March 2026*
