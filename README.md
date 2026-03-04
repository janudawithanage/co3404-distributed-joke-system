# CO3404 Distributed Systems – Joke System
## OPTION 3 (Upper Second Class 2:1) — Phase 0 & 1

---

## Phase 0 – Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Docker Network: jokes_network                     │
│                                                                      │
│   Browser          Browser                                           │
│      │                │                                              │
│      ▼                ▼                                              │
│  ┌──────────┐    ┌──────────────┐       ┌─────────────────────────┐ │
│  │  joke-   │◄───│   submit-    │─AMQP─►│       RabbitMQ          │ │
│  │ service  │    │   service    │       │  :5672 / UI :15672      │ │
│  │  :3001   │    │   :3002      │       └───────────┬─────────────┘ │
│  └────┬─────┘    └──────────────┘                   │               │
│       │ SQL                                          │ AMQP          │
│       │              GET /types (HTTP proxy)         ▼               │
│       │              with file-cache fallback  ┌──────────┐         │
│       ▼                                        │   etl-   │         │
│  ┌──────────┐◄───────────────────────── SQL ───│  service │         │
│  │  MySQL   │                                  │  :3003   │         │
│  │  :3306   │                                  └──────────┘         │
│  └──────────┘                                                        │
└─────────────────────────────────────────────────────────────────────┘
```

### Service Responsibilities

| Service | Port | Role |
|---|---|---|
| `joke-service` | 3001 | Reads jokes from MySQL; serves frontend |
| `submit-service` | 3002 | Accepts new jokes; publishes to RabbitMQ; Swagger docs |
| `etl-service` | 3003 | Consumes RabbitMQ queue; writes to MySQL |
| `mysql` | 3306 | Relational database |
| `rabbitmq` | 5672 / 15672 | Message broker + management UI |

### Resilience Design

- **Submit → RabbitMQ → ETL → MySQL** — Submit never touches the DB directly.
- If **Joke service is stopped**, Submit still works (RabbitMQ is independent).
- If **ETL is stopped**, jokes queue up in RabbitMQ (durable queue + persistent messages).
- Submit's `GET /types` falls back to a **local cache file** on a Docker volume if Joke service is unreachable.
- ETL uses **at-least-once delivery**: messages are ACK'd only after a successful DB insert.

---

## Folder Structure

```
co3404-distributed-joke-system/
├── .env                        # Environment variables for docker-compose
├── .gitignore
├── docker-compose.yml          # Orchestrates all 5 services
├── db/
│   └── init.sql                # Schema + seed data (auto-run on MySQL start)
├── joke-service/
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── package.json
│   ├── db.js                   # MySQL connection pool + retry
│   ├── server.js               # Express API
│   └── public/
│       ├── index.html          # Joke frontend
│       └── app.js              # Frontend JS (setTimeout punchline reveal)
├── submit-service/
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── package.json
│   ├── rabbitmq.js             # RabbitMQ connection + publish helper
│   ├── server.js               # Express API + Swagger
│   └── public/
│       ├── index.html          # Submit frontend
│       └── app.js
└── etl-service/
    ├── Dockerfile
    ├── .dockerignore
    ├── package.json
    ├── db.js                   # MySQL connection pool + retry
    └── server.js               # RabbitMQ consumer + ETL logic
```

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose v2)
- No local Node.js required — everything runs inside containers.

---

## Running Locally

### 1. Start all services

```bash
docker compose up --build
```

First build takes ~2–3 min (pulls images + runs `npm install` per service).
Add `-d` to detach: `docker compose up --build -d`

### 2. Access the services

| URL | Description |
|---|---|
| http://localhost:3001 | Joke frontend |
| http://localhost:3002 | Submit frontend |
| http://localhost:3002/docs | Swagger API docs |
| http://localhost:3003/health | ETL health check |
| http://localhost:15672 | RabbitMQ Management UI (guest / guest) |

---

## Demonstrating Resilience

### Scenario: stop Joke Service → Submit still works → ETL drains queue

```bash
# 1. Stop the Joke Service
docker compose stop joke-service

# 2. Submit a joke at http://localhost:3002 or via /docs
#    POST /submit  { "setup": "...", "punchline": "...", "type": "programming" }
#    Returns 202 Accepted — message is in RabbitMQ

# 3. Check RabbitMQ UI -> jokes_queue -> Messages Ready = 1

# 4. Restart the Joke Service
docker compose start joke-service

# 5. Watch ETL logs
docker compose logs -f etl-service
# => [ETL] Inserted joke (type: programming): ...

# 6. Visit http://localhost:3001, select programming -> your joke appears!
```

---

## Useful Commands

```bash
# Live logs (all services)
docker compose logs -f

# Logs for one service
docker compose logs -f etl-service

# Stop everything (data persists in volumes)
docker compose down

# Stop AND delete all data (volumes)
docker compose down -v

# Rebuild one service after a code change
docker compose up --build submit-service

# MySQL shell
docker exec -it jokes_mysql mysql -u jokeuser -pjokepassword jokesdb

# RabbitMQ queue depth
docker exec -it jokes_rabbitmq rabbitmqctl list_queues name messages
```

---

## Database Schema

```sql
CREATE TABLE types (
  id   INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
);

CREATE TABLE jokes (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  setup     TEXT NOT NULL,
  punchline TEXT NOT NULL,
  type_id   INT  NOT NULL,
  FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE RESTRICT
);
```

---

## API Reference

### Joke Service :3001

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/joke/:type?count=N` | `type=any` for random; defaults to 1 |
| GET | `/types` | All categories |
| GET | `/health` | Health check |

### Submit Service :3002

| Method | Endpoint | Notes |
|---|---|---|
| POST | `/submit` | Body: `{ setup, punchline, type }` -> 202 |
| GET | `/types` | Proxied from Joke service with cache fallback |
| GET | `/docs` | Swagger UI |
| GET | `/health` | Health check |

### ETL Service :3003

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/health` | Health check |

---

## Environment Variables (.env)

| Variable | Default | Used By |
|---|---|---|
| `DB_HOST` | `mysql` | joke, etl |
| `DB_USER` | `jokeuser` | joke, etl |
| `DB_PASSWORD` | `jokepassword` | joke, etl |
| `DB_NAME` | `jokesdb` | joke, etl |
| `DB_ROOT_PASSWORD` | `rootpassword` | mysql container |
| `RABBITMQ_HOST` | `rabbitmq` | submit, etl |
| `RABBITMQ_USER` | `guest` | submit, etl |
| `RABBITMQ_PASSWORD` | `guest` | submit, etl |
| `JOKE_SERVICE_URL` | `http://joke-service:3001` | submit |
