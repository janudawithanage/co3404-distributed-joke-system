# CO3404 Distributed Joke System

A distributed microservices platform built as a personal project to explore distributed systems design.

Jokes flow through an async pipeline: **submitted** by users → **queued** in RabbitMQ → **reviewed** by a human moderator via an Auth0-protected UI → **persisted** to MySQL → **served** through a Kong API Gateway.

> **⚠️ Azure status:** VMs may be deallocated. All features work fully in local Docker.
> See [FINAL_STATUS.md](FINAL_STATUS.md) for the current deployment state.

---

## Services

| Service | Port (local) | Role |
|---|---|---|
| **Kong Gateway** | 8000 → 80 | Entry point: routing, TLS, rate-limiting, correlation IDs |
| **Joke Service** | 3000 → 4000 | Browse jokes; MySQL or MongoDB backend |
| **Submit Service** | 3200 → 4200 | Accept joke submissions; publish to `submit` queue |
| **Moderate Service** | 3300 → 4300 | Auth0-protected moderation UI (approve / reject) |
| **ETL Service** | 3001 → 4001 | Persist approved jokes; broadcast ECST type updates |
| **RabbitMQ** | 5672 / 15672 | Message broker + management UI |
| **MySQL** | 3306 | Relational store (types + jokes) |

---

## Quick Start (Local)

**Requires:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
git clone <repo-url> && cd co3404-distributed-joke-system
cp .env.example .env          # Auth0 values are optional for local dev
docker compose up -d          # ~30 s for MySQL + RabbitMQ health checks to pass
curl http://localhost:8000/types
```

| URL | Description |
|---|---|
| http://localhost:8000/joke-ui | Joke browser |
| http://localhost:8000/submit | Submit a joke |
| http://localhost:8000/moderate-ui | Moderation UI (Auth0 login — optional locally) |
| http://localhost:8000/docs | Swagger / OpenAPI docs |
| http://localhost:15672 | RabbitMQ dashboard (`guest` / `guest`) |

Full local setup including Auth0 and MongoDB mode → **[LOCAL_RUN.md](LOCAL_RUN.md)**

---

## Architecture Summary

```
Browser / curl
     │  HTTP :8000 (local) · HTTPS :443 (Azure)
     ▼
Kong API Gateway ─────────────────────────────────────┐
     │                       │                        │
     ▼                       ▼                        ▼
joke-service            submit-service          moderate-service
 + etl-service           + RabbitMQ              (Auth0 OIDC)
 + MySQL
```

Async submission pipeline:

```
POST /submit → submit-service → [submit queue] → moderate-service
                                                        │ approve
                                                 [moderated queue]
                                                        ▼
                                               etl-service → MySQL
                                                        │
                                          [type_update fanout exchange]
                                         ↙                            ↘
                               sub_type_update               mod_type_update
                             (submit ECST cache)           (moderate ECST cache)
```

Full topology (local + Azure VMs), project structure, design decisions → **[ARCHITECTURE.md](ARCHITECTURE.md)**

---

## Key API Routes

| Method | Route | Notes |
|---|---|---|
| `GET` | `/joke/:type` | Random joke; `type=any` for all categories. Rate-limited: 5 req/min |
| `GET` | `/joke/:type?count=N` | Up to N jokes |
| `GET` | `/types` | All joke categories |
| `POST` | `/submit` | Queue a joke for moderation → 202 |
| `GET` | `/moderate` | Next pending joke (Auth0 required in prod) |
| `POST` | `/moderated` | Approve — forwards to `moderated` queue |
| `POST` | `/reject` | Reject — nacks and discards the message |
| `GET` | `/docs` | Swagger UI (submit-service) |
| `GET` | `/health` | Health check (all services) |

Full reference with curl examples → **[API_OVERVIEW.md](API_OVERVIEW.md)**

---

## Testing

```bash
node test-flows.js   # 59 end-to-end tests against the local stack
```

Expected: **58 pass · 0 fail · 1 benign warning**
(FLOW 9 reports auth mode as `dev` locally — this is correct behaviour.)

---

## Azure Deployment

All user traffic routes through **Kong** (VM4). VM1–VM3 are private.

```bash
export KONG_IP=<kong-public-ip>   # from: terraform -chdir=infra/terraform output -raw kong_public_ip
curl -sk https://$KONG_IP/types
./infra/scripts/smoke-test.sh $KONG_IP
```

Full provisioning, CI/CD, and redeploy guide → **[DEPLOYMENT.md](DEPLOYMENT.md)**

---

## Documentation

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System topology, message flow, project structure, design decisions |
| [LOCAL_RUN.md](LOCAL_RUN.md) | Local setup, Auth0, MongoDB mode, env variables, database schema |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Azure provisioning, GitHub Actions CI/CD, redeploy steps, troubleshooting |
| [API_OVERVIEW.md](API_OVERVIEW.md) | All routes with request/response examples and auth requirements |
| [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) | Known gaps, Azure state, and deferred improvements |
| [FINAL_STATUS.md](FINAL_STATUS.md) | Submission state: bug fixes, test results, deployment status |

