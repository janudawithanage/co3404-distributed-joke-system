# Distributed Joke System

[![Node.js](https://img.shields.io/badge/Node.js-18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Kong](https://img.shields.io/badge/Kong-3.9-003459?logo=kong&logoColor=white)](https://konghq.com/)
[![RabbitMQ](https://img.shields.io/badge/RabbitMQ-3.12-FF6600?logo=rabbitmq&logoColor=white)](https://www.rabbitmq.com/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com/)
[![Auth0](https://img.shields.io/badge/Auth0-OIDC-EB5424?logo=auth0&logoColor=white)](https://auth0.com/)
[![CI](https://github.com/janudawithanage/co3404-distributed-joke-system/actions/workflows/validate.yml/badge.svg?branch=public-portfolio)](https://github.com/janudawithanage/co3404-distributed-joke-system/actions/workflows/validate.yml)

A full-stack distributed microservices platform demonstrating async messaging, API gateway patterns, event-carried state transfer, and multi-VM cloud deployment.

Jokes flow through a multi-stage async pipeline: **submitted** by users \u2192 **queued** in RabbitMQ \u2192 **reviewed** by a human moderator via an Auth0-protected UI \u2192 **persisted** to MySQL \u2192 **served** globally through a Kong API Gateway.

> **\u26a0\ufe0f Azure note:** Production VMs may be deallocated to save costs. All features run fully in local Docker (`docker compose up -d`). See [DEPLOYMENT.md](DEPLOYMENT.md) to reprovision.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **API Gateway** | Kong 3.9 (DB-less) \u2014 routing, TLS, rate-limiting, correlation IDs |
| **Services** | Node.js 18 + Express \u2014 4 independent microservices |
| **Message Broker** | RabbitMQ 3.12 \u2014 2 queues + 1 fanout exchange (AMQP) |
| **Database** | MySQL 8.0 (`utf8mb4`) with MongoDB adapter option |
| **Auth** | Auth0 OIDC (moderate-service); `AUTH_ENABLED` flag for local dev |
| **Infrastructure** | Docker Compose (local) \u00b7 4 Azure VMs (production) |
| **IaC** | Terraform \u2014 VM provisioning, VNet, NSG, Kong TLS |
| **CI/CD** | GitHub Actions \u2014 independent build/push/deploy per service |

---

## Architecture

```
Browser / curl
     \u2502  HTTP :8000 (local)  \u00b7  HTTPS :443 (Azure)
     \u25bc
\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502  Kong API Gateway (DB-less)                 \u2502
\u2502  routing \u00b7 TLS \u00b7 rate-limit \u00b7 corr-ID       \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
           \u2502              \u2502              \u2502
           \u25bc              \u25bc              \u25bc
     joke-service   submit-service  moderate-service
     GET /joke/*    POST /submit    GET /moderate
     GET /types     GET /docs       POST /moderated
                                    POST /reject
                                    (Auth0 OIDC)
           \u2502              \u2502              \u2502
           \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
                          \u2502
                     etl-service
                  (internal only)
                          \u2502
                       MySQL
```

**Async moderation pipeline:**

```
POST /submit
     \u2502
submit-service \u2500\u2500publishes\u2500\u2500\u25b6 [submit queue]
                                     \u2502
                              moderate-service
                              (human review)
                                     \u2502 approve
                              [moderated queue]
                                     \u2502
                              etl-service \u2500\u2500\u25b6 MySQL
                                     \u2502
                           [type_update fanout exchange]
                              \u2199                    \u2198
                    sub_type_update          mod_type_update
                  (submit ECST cache)      (moderate ECST cache)
```

**Key patterns:** ECST (Event-Carried State Transfer) \u00b7 at-least-once delivery + `INSERT IGNORE` idempotency \u00b7 prefetch(1) fair dispatch \u00b7 single public entry point (Kong)

\u2192 Full topology, queue reference, design decisions: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Services

| Service | Port (local) | Role |
|---|---|---|
| **Kong Gateway** | :8000 | Single public entry point \u2014 routing, TLS, rate-limiting |
| **joke-service** | :4000 | Browse approved jokes; MySQL or MongoDB backend |
| **submit-service** | :4200 | Accept submissions; publish to `submit` queue; Swagger UI |
| **moderate-service** | :4300 | Auth0-protected moderation dashboard (approve / reject) |
| **etl-service** | :4001 | Persist approved jokes to MySQL; broadcast ECST type events |
| **RabbitMQ** | :5672 / :15672 | Message broker + management UI |
| **MySQL** | :3306 | Relational store \u2014 joke types and approved jokes |

---

## Quick Start

**Requires:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
git clone https://github.com/janudawithanage/co3404-distributed-joke-system.git
cd co3404-distributed-joke-system
cp .env.example .env        # Auth0 values are optional for local dev
docker compose up -d        # ~30 s for MySQL + RabbitMQ health checks
curl http://localhost:8000/types
```

| URL | What you get |
|---|---|
| http://localhost:8000/joke-ui | Joke browser |
| http://localhost:8000/submit | Submit a joke (goes into the moderation queue) |
| http://localhost:8000/moderate-ui | Moderation dashboard (no login required locally) |
| http://localhost:8000/docs | Swagger / OpenAPI |
| http://localhost:15672 | RabbitMQ management UI (`guest` / `guest`) |

Full local setup including Auth0 and MongoDB mode \u2192 [LOCAL_RUN.md](LOCAL_RUN.md)

---

## Key API Routes

| Method | Route | Notes |
|---|---|---|
| `GET` | `/joke/:type` | Random joke; `type=any` for all categories. Rate-limited: 5 req/min |
| `GET` | `/joke/:type?count=N` | Up to N jokes |
| `GET` | `/types` | All joke categories |
| `POST` | `/submit` | Queue a joke for moderation \u2192 `202 Accepted` |
| `GET` | `/moderate` | Next pending joke (Auth0 required in production) |
| `POST` | `/moderated` | Approve \u2014 forwards to `moderated` queue |
| `POST` | `/reject` | Reject \u2014 nacks and discards the message |
| `GET` | `/docs` | Swagger UI (submit-service) |
| `GET` | `/health` | Health check (all services) |

Full reference with curl examples \u2192 [API_OVERVIEW.md](API_OVERVIEW.md)

---

## Testing

```bash
node test-flows.js   # 59 end-to-end tests against the local stack
```

Expected: **58 pass \u00b7 0 fail \u00b7 1 benign warning**

> FLOW 9 reports auth mode as `dev` locally \u2014 correct behaviour when `AUTH_ENABLED=false`.

---

## Production Deployment (Azure)

All user traffic routes through **Kong** (VM4, public IP). VM1\u2013VM3 are on a private VNet with no public HTTP ports.

```bash
# Provision infrastructure
cd infra/terraform && terraform apply

# Smoke-test after deploy
export KONG_IP=$(terraform output -raw kong_public_ip)
./infra/scripts/smoke-test.sh $KONG_IP   # 18 checks across all services
```

GitHub Actions workflows build, push to Docker Hub, and deploy each service independently. Triggered manually via the GitHub Actions UI (deployment secrets required).

Full provisioning, CI/CD setup, and redeploy runbook \u2192 [DEPLOYMENT.md](DEPLOYMENT.md)

---

## Documentation

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System topology, message flow, project structure, design decisions |
| [LOCAL_RUN.md](LOCAL_RUN.md) | Local setup, Auth0, MongoDB mode, env variables, database schema |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Azure provisioning, GitHub Actions CI/CD, redeploy steps, troubleshooting |
| [API_OVERVIEW.md](API_OVERVIEW.md) | All routes with request/response examples and auth requirements |
| [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) | Known gaps, Azure state, and deferred improvements |
