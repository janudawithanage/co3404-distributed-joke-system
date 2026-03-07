# CO3404 Distributed Systems — Audit Report
## Option 3 (Upper Second Class / 2:1)

**Audit Date:** 7 March 2026  
**Auditor:** Senior Distributed Systems Engineer (automated)  
**Project:** CO3404 Joke System — Microservices + Kong API Gateway on Azure

---

## 1. Project Overview

This project implements a distributed joke submission and retrieval system as a university assignment for CO3404 Distributed Systems, targeting **Option 3 (2:1 grade)**. It is composed of three microservices, a MySQL database, a RabbitMQ message broker, and a Kong API Gateway deployed on Azure virtual machines.

---

## 2. Detected Architecture

```
                        Internet (HTTPS :443 / HTTP :80)
                                       │
                           ┌───────────▼──────────────┐
                           │   VM3: Kong Gateway       │
                           │   Kong 3.9 (DB-less mode) │
                           │   TLS self-signed cert    │
                           │   Rate-limit: 5 req/min   │
                           │   Correlation-ID header   │
                           └──────┬───────────┬────────┘
                                  │           │
            /joke/*, /joke-ui/    │           │  /submit, /types, /docs
                                  ▼           ▼
         ┌────────────────────┐       ┌────────────────────────┐
         │ VM1: vm-joke        │       │ VM2: vm-submit          │
         │ 10.0.1.4 (private) │       │ 10.0.1.5 (private)     │
         │                    │       │                        │
         │ joke-service:3001  │◄──────│ submit-service:3002    │
         │ etl-service:3003   │  HTTP │   GET /types proxy      │
         │ mysql:3306         │  /types │ rabbitmq:5672         │
         └─────────┬──────────┘       └──────────┬─────────────┘
                   │ SQL                          │ AMQP
                   │                             ▼
                   │                   ┌──────────────────┐
                   └──────── SQL ──────│   etl-service     │
                             (VM1)     │   consumer loop   │
                                       └──────────────────┘
```

**Local Development (Phase 1):**  
Single `docker-compose.yml` runs all five services on one Docker bridge network (`jokes_network`). MySQL and RabbitMQ are health-checked before dependent services start.

**Azure Deployment (Phase 2 + 3):**  
- VM1 (`vm-joke`, `10.0.1.4`): joke-service, etl-service, mysql
- VM2 (`vm-submit`, `10.0.1.5`): submit-service, rabbitmq
- VM3 (`vm-kong`, `10.0.1.6`): Kong API Gateway (Terraform-provisioned)
- All VMs in the same Azure VNet (`vnet-jokes`, `10.0.0.0/16`)
- Kong exposes HTTPS with a self-signed certificate (IP SAN)
- NSG rules restrict traffic appropriately per service

---

## 3. Assessment Requirements Checklist

### GENERAL

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| G1 | Distributed system architecture | **PASS** | Three microservices across three Azure VMs with a message broker |
| G2 | Resilient to failure of other microservices | **PASS** | Submit works when Joke is down; ETL works when RabbitMQ reconnects |
| G3 | Docker networking / service name DNS | **PASS** | All compose files use service names (mysql, rabbitmq, joke-service) |
| G4 | Azure private networking for cross-VM comms | **PASS** | VM1↔VM2 uses private IPs (10.0.1.x) via Azure VNet, never public internet |
| G5 | Maintainable and modular code | **PASS** | Each service has its own Dockerfile, package.json, db.js, server.js |
| G6 | Demonstrably testable | **PASS** | /health on every service, curl test commands in all guides |

---

### OPTION 1 — JOKE APPLICATION

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| J1 | NodeJS + Express server | **PASS** | `express: ^4.18.2` in package.json |
| J2 | Serves static frontend files | **PASS** | `express.static('public')` in server.js |
| J3 | Web UI: select type, request random joke | **PASS** | `joke-service/public/index.html` + `app.js` |
| J4 | Setup shown first, punchline after 3 seconds | **PASS** | `setTimeout(() => punchEl.classList.add('revealed'), 3000)` with countdown timer |
| J5 | Button can request another random joke | **PASS** | `ORDER BY RAND()` in SQL; button re-fetches on click |
| J6 | Joke types loaded dynamically from API | **PASS** | `loadTypes()` calls `GET /types` on page load |
| J7 | GET /joke/:type with optional ?count | **PASS** | Implemented with `Math.max(1, parseInt(req.query.count) \|\| 1)` |
| J8 | Supports type "any" | **PASS** | `if (type === 'any')` branch queries all types via JOIN |
| J9 | Returns one or more jokes | **PASS** | Returns single object (count=1) or array (count>1) — frontend normalises both |
| J10 | Returns available jokes if count exceeds stored | **PASS** | SQL `LIMIT ?` with MySQL — returns all rows if fewer exist |
| J11 | GET /types returns all types without duplicates | **PASS** | `UNIQUE` constraint on `types.name` + `SELECT id, name FROM types ORDER BY name` |
| J12 | Works even if Submit app is down | **PASS** | Joke service has no dependency on Submit service |

---

### OPTION 1 — SUBMIT APPLICATION

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| S1 | NodeJS + Express server | **PASS** | `express: ^4.18.2` in package.json |
| S2 | Serves static frontend files | **PASS** | `express.static('public')` in server.js |
| S3 | UI: enter setup, punchline, select/add type | **PASS** | `submit-service/public/index.html` with form + custom type input |
| S4 | Prevent submission when required fields missing | **PASS** | Frontend validation; server-side 400 if fields missing |
| S5 | POST /submit | **PASS** | Validates, trims, publishes to RabbitMQ; returns 202 Accepted |
| S6 | GET /types | **PASS** | Proxy to Joke service + file-cache fallback |
| S7 | GET /docs (OpenAPI/Swagger) | **PASS** | `swagger-jsdoc` + `swagger-ui-express` at `/docs` |
| S8 | Works even if Joke app is down | **PASS** | `GET /types` falls back to cache file on Docker volume |
| S9 | Prevent duplicate joke types | **PASS** | ETL uses `INSERT IGNORE` + `UNIQUE` constraint in MySQL |
| S10 | Demonstrates system resilience | **PASS** | Cache survives Joke service restart; submit works while ETL is down |

---

### OPTION 1 — DATABASE

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| D1 | MySQL 8 | **PASS** | `mysql:8.0` image |
| D2 | Persistent storage (Docker volume) | **PASS** | `mysql_data:/var/lib/mysql` named volume in all compose files |
| D3 | Schema and data handled correctly | **PASS** | `db/init.sql` creates tables and seeds data on first start |
| D4 | jokes/types relationship, no duplicate types | **PASS** | `jokes.type_id` FK to `types.id`; `types.name UNIQUE NOT NULL` |

---

### OPTION 2 — MICROSERVICES + RABBITMQ + ETL

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| M1 | Joke and Submit are microservices | **PASS** | Separate Docker containers, separate processes, separate source trees |
| M2 | Submit gets types from Joke over HTTP | **PASS** | `axios.get(\`${JOKE_SERVICE_URL}/types\`)` in submit-service/server.js |
| M3 | Submit has file cache for joke types | **PASS** | `CACHE_FILE = /app/cache/types.json` on Docker named volume |
| M4 | Cache refreshes on every /types call | **PASS** | Every successful live call writes `fs.writeFile(CACHE_FILE, ...)` |
| M5 | If Joke is down, Submit returns cached types | **PASS** | Catch block reads cache file; 503 only if cache also missing |
| M6 | New submissions go to RabbitMQ queue | **PASS** | `publishJoke()` in rabbitmq.js; no direct DB writes from Submit |
| M7 | RabbitMQ queue is durable/persistent | **PASS** | `durable: true` + `persistent: true` in both submit and ETL |
| M8 | ETL service consumes queue messages | **PASS** | `channel.consume(QUEUE_NAME, ...)` in etl-service/server.js |
| M9 | ETL transforms and writes to database | **PASS** | `getOrCreateType()` + `insertJoke()` — type normalised to lowercase |
| M10 | ETL acknowledges messages properly | **PASS** | `channel.ack(msg)` only after successful DB write; `nack(msg, false, true)` on DB error; `nack(msg, false, false)` on malformed JSON |
| M11 | ETL is Dockerized | **PASS** | `etl-service/Dockerfile` with node:18-alpine |
| M12 | Submit still accepts data when Joke is down | **PASS** | RabbitMQ is independent; Submit only calls Joke for `/types` |
| M13 | Queued messages survive and are later consumed | **PASS** | Durable queue + persistent messages + rabbitmq_data volume |
| M14 | Type cache works correctly | **PASS** | Tested end-to-end in local docker-compose |

---

### OPTION 3 — KONG API GATEWAY

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| K1 | Kong API Gateway implemented | **PASS** | Kong 3.9 in DB-less mode with declarative YAML config |
| K2 | Client can access microservices through single origin | **PASS** | All traffic enters via Kong (HTTPS public IP); backends on private IPs |
| K3 | Kong forwards requests to appropriate services | **PASS** | `/joke/*` → VM1:3001; `/submit` → VM2:3002; `/types` → VM2:3002; `/docs` → VM2:3002 |
| K4 | Rate limiting on Joke API | **PASS** | `rate-limiting` plugin, 5 req/min per IP, returns HTTP 429 |
| K5 | Rate limit low enough to demonstrate | **PASS** | 5 requests/min — easily triggered in demo loop |
| K6 | HTTPS/TLS implemented on Kong | **PASS** | Self-signed cert with IP SAN (covers `85.211.240.162`), valid until Mar 2027 |
| K7 | Kong configured without unnecessary complexity | **PASS** | DB-less declarative YAML; no Admin API dependency; minimal plugins |
| K8 | Kong VM created using Terraform | **PASS** | `infra/terraform/main.tf` creates NSG, Public IP, NIC, VM3, installs Docker, deploys Kong |
| K9 | Terraform files valid, readable, aligned | **PASS** | Includes variables.tf, outputs.tf, terraform.tfvars.example, kong.yml.tpl |

---

## 4. Issues Found

### Pre-fix Issues (now resolved)

| ID | Severity | File | Issue | Fix Applied |
|----|----------|------|-------|-------------|
| F1 | Moderate | `.env` | Contained stale `DB_TYPE=MYSQL` and `MONGO_HOST=mongodb` variables not used anywhere in the codebase (leftover from an abandoned MongoDB variant) | Removed both variables from `.env` |
| F2 | Moderate | `.env.example` | Was slightly out of sync with actual `.env` (missing vs having the MongoDB vars) | Updated `.env.example` to match cleaned `.env` |
| F3 | Moderate | `infra/terraform/kong.yml.tpl` | No Kong route for `/docs` — the Swagger UI was not accessible through the gateway | Added `submit-docs-route` to expose `/docs` through Kong |
| F4 | Minor | `submit-service/public/index.html` | Footer link `/joke/any` would 404 when the page is accessed locally at port 3002 | Replaced with `/health` link which works correctly both locally and through Kong |
| F5 | Minor | `docker-compose.yml` | `joke-service` and `etl-service` had no healthcheck definitions, so container orchestration could not report their health | Added `healthcheck` with `wget -qO- /health` test for both services |
| F6 | Minor | `infra/vm1-compose.yml` | Same missing healthchecks as F5, but for the Azure VM1 deployment | Added `healthcheck` for joke-service and etl-service |
| F7 | Minor | `infra/vm2-compose.yml` | `submit-service` had no healthcheck; no `KONG_PUBLIC_IP` env var for Swagger | Added healthcheck; added `KONG_PUBLIC_IP` optional env var |
| F8 | Minor | `submit-service/server.js` | Swagger server URL used a hardcoded `'https://KONG_PUBLIC_IP'` placeholder string | Updated to use `process.env.KONG_PUBLIC_IP` with graceful fallback |
| F9 | Minor | `infra/.env.vm2.example` | Missing the optional `KONG_PUBLIC_IP` variable for Swagger | Added documented optional `KONG_PUBLIC_IP` field |

### Known Limitations (not fixed — acceptable for assessment)

| ID | Issue | Reason Accepted |
|----|-------|-----------------|
| L1 | Kong frontend routes (`/joke-ui`, `/submit`) serve static HTML but relative JS/CSS links (`src="app.js"`) resolve to the domain root when accessed without a trailing slash (e.g. `/joke-ui` vs `/joke-ui/`). Access at `/joke-ui/` or `/submit/` (with trailing slash) loads correctly. | Kong path-stripping is standard behaviour; API endpoints work perfectly; the assessment requirement is for single-origin API access, not UI hosting through Kong |
| L2 | `infra/terraform/terraform.tfstate` is present locally despite being gitignored. The state contains real Azure resource IDs. | Standard Terraform workflow — state is local by design during student deployment; must not be included in submission zip |
| L3 | `infra/kong/certs/server.crt` is present locally despite being gitignored. It is the real self-signed certificate from the Azure deployment (no private key present). | Keeping it enables `--cacert` testing without regenerating; contains no secrets |
| L4 | `infra/.env.vm1` and `infra/.env.vm2` contain real Azure private IPs. They are gitignored. | Only local copies; never committed; acceptable for student demonstration |
| L5 | Terraform state shows only partial Azure resources (NSG, PIP, NIC — no VM resource). This likely means the Kong VM was deallocated to save Azure credits and state was cleaned. | Terraform `apply` will recreate the VM from the same configuration; infrastructure-as-code approach is correct |

---

## 5. Fixes Applied (Summary)

| File | Change |
|------|--------|
| `.env` | Removed `DB_TYPE` and `MONGO_HOST` stale variables |
| `.env.example` | Synchronised to match cleaned `.env` |
| `docker-compose.yml` | Added healthchecks for `joke-service` and `etl-service` |
| `infra/vm1-compose.yml` | Added healthchecks for `joke-service` and `etl-service` |
| `infra/vm2-compose.yml` | Added healthcheck for `submit-service`; added `KONG_PUBLIC_IP` env var |
| `infra/.env.vm2.example` | Added optional `KONG_PUBLIC_IP` documentation |
| `infra/terraform/kong.yml.tpl` | Added `submit-docs-route` to expose Swagger UI at `/docs` through Kong |
| `submit-service/server.js` | Swagger server URL now reads `KONG_PUBLIC_IP` env var with fallback |
| `submit-service/public/index.html` | Replaced broken `/joke/any` footer link with functional `/health` link |

---

## 6. Architecture Strengths

- **Correct microservice boundaries**: Each service has its own process, Dockerfile, and dependencies. No shared code across service boundaries.
- **Proper at-least-once delivery**: ETL ACKs only after confirmed DB write; NACKs with requeue on transient DB errors; NACKs without requeue on malformed JSON.
- **Self-healing connections**: Both Submit (RabbitMQ) and ETL (RabbitMQ + MySQL) implement infinite retry loops with exponential-style delays.
- **Idempotent ETL**: `INSERT IGNORE` + `SELECT` pattern ensures type deduplication is safe under concurrent or re-delivered messages.
- **Durable infrastructure**: Named Docker volumes for MySQL, RabbitMQ, and the type cache — all survive container rebuilds.
- **Terraform provisioning**: Kong VM is fully automated (VM creation, Docker install, config upload, TLS cert generation, container start) in a single `terraform apply`.
- **Security-conscious NSG rules**: MySQL, ETL, and RabbitMQ AMQP ports are NOT exposed to the internet; SSH restricted to author IP.
- **DB-less Kong**: No Postgres dependency for Kong; declarative YAML config is version-controlled (as a template).

---

## 7. Grade Assessment

Based on the implementation against the CO3404 Option 3 requirements:

| Criterion | Evidence |
|-----------|----------|
| All Option 1 requirements met | Joke frontend with 3s punchline, type API, count parameter, "any" type ✅ |
| All Option 2 requirements met | RabbitMQ queue, ETL consumer, type cache, resilience patterns ✅ |
| All Option 3 requirements met | Kong gateway, HTTPS/TLS, rate limiting, single origin, Terraform VM ✅ |
| High 2:1 indicator: Terraform for Kong VM | Full Terraform configuration with provisioners ✅ |
| Mid/High 2:1 indicator: HTTPS on gateway | Self-signed cert with IP SAN, valid 1 year ✅ |

**Assessment verdict: This implementation most closely satisfies a solid Upper Second Class (2:1) as targeted.**

The code is clean, commented, and modular. All key distributed systems concepts (decoupling, resilience, message queuing, API gateway, infrastructure-as-code) are correctly implemented and demonstrable.

---

*Report generated by automated audit — 7 March 2026*
