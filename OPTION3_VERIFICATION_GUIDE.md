# CO3404 Distributed Systems — Option 3 Verification Guide

> **Target grade:** 2:1 (Upper Second Class)
> **Architecture:** 3-VM distributed deployment on Azure (VNet: `vnet-jokes`, `10.0.0.0/16`)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project File Audit](#2-project-file-audit)
3. [Clean Folder Structure](#3-clean-folder-structure)
4. [Prerequisites](#4-prerequisites)
5. [VM1 — Joke Service + ETL + MySQL](#5-vm1--joke-service--etl--mysql)
6. [VM2 — Submit Service + RabbitMQ](#6-vm2--submit-service--rabbitmq)
7. [VM3 — Kong API Gateway (Terraform)](#7-vm3--kong-api-gateway-terraform)
8. [End-to-End Verification Tests](#8-end-to-end-verification-tests)
9. [Resilience Testing](#9-resilience-testing)
10. [Kong Admin Diagnostics](#10-kong-admin-diagnostics)
11. [Troubleshooting](#11-troubleshooting)
12. [Azure Cost-Saving Tips](#12-azure-cost-saving-tips)
13. [Security Best Practices](#13-security-best-practices)

---

## 1. Architecture Overview

```
                        Internet
                            │
                    HTTPS :443 / HTTP :80
                            │
                   ┌────────▼─────────┐
                   │  VM3: Kong GW    │  Static Public IP: 85.211.240.162
                   │  vm-kong         │  Private IP: 10.0.1.6
                   │  NSG: 22 (your   │  Image: kong:3.9 (DB-less mode)
                   │  IP), 443, 80    │
                   └────┬────────┬────┘
                        │        │          Azure VNet: 10.0.0.0/16
          ──────────────┼────────┼──────────── snet-jokes: 10.0.1.0/24 ────
                        │        │
             /joke/*    │        │  /submit/*
        (rate-limited   │        │  (no limit)
         5 req/min)     │        │
                        ▼        ▼
         ┌──────────────────┐  ┌─────────────────────┐
         │ VM1: vm-joke     │  │ VM2: vm-submit       │
         │ Private: 10.0.1.4│  │ Private: 10.0.1.5    │
         │ Public: 85.211   │  │ Public: 85.211       │
         │       .178.130   │  │       .241.251        │
         │                  │  │                      │
         │ joke-service:3001│  │ submit-service:3002  │
         │ etl-service:3003 │  │ rabbitmq:5672/15672  │
         │ mysql:3306       │  │                      │
         └──────────────────┘  └──────────────────────┘
                  ▲                       │
                  │    AMQP 10.0.1.5:5672 │
                  │    (ETL → RabbitMQ)   │
                  └───────────────────────┘
```

**Request Flow:**
```
Client → HTTPS :443 → Kong → /joke/*   → http://10.0.1.4:3001 (joke-service)
                           → /submit/* → http://10.0.1.5:3002 (submit-service)

Submit → RabbitMQ (VM2) → ETL (VM1) → MySQL (VM1)
```

**Kong Plugins:**
| Plugin         | Scope        | Behaviour                               |
|----------------|--------------|-----------------------------------------|
| rate-limiting  | joke-service | 5 req/min per IP → HTTP 429 after limit |
| correlation-id | global       | Adds `Kong-Request-ID` header to every response |

---

## 2. Project File Audit

### ✅ Valid — Required for Production Deployment

| File | VM | Purpose |
|------|----|---------|
| `joke-service/server.js` | VM1 | Joke REST API + static frontend |
| `joke-service/db.js` | VM1 | MySQL connection pool with retry |
| `joke-service/Dockerfile` | VM1 | Container image build (node:18-alpine) |
| `joke-service/package.json` | VM1 | Dependencies: express, mysql2 |
| `joke-service/public/index.html` | VM1 | Joke browser frontend |
| `joke-service/public/app.js` | VM1 | Frontend JavaScript |
| `etl-service/server.js` | VM1 | RabbitMQ consumer → MySQL writer |
| `etl-service/db.js` | VM1 | MySQL connection pool with retry |
| `etl-service/Dockerfile` | VM1 | Container image build |
| `etl-service/package.json` | VM1 | Dependencies: amqplib, mysql2, express |
| `db/init.sql` | VM1 | MySQL schema + seed data |
| `infra/vm1-compose.yml` | VM1 | Docker Compose for VM1 services |
| `infra/vm1-setup.sh` | VM1 | Bootstrap Docker on VM1 |
| `infra/.env.vm1.example` | VM1 | Environment template for VM1 |
| `submit-service/server.js` | VM2 | Submit REST API + Swagger + frontend |
| `submit-service/rabbitmq.js` | VM2 | RabbitMQ connection manager |
| `submit-service/Dockerfile` | VM2 | Container image build |
| `submit-service/package.json` | VM2 | Dependencies: express, amqplib, axios, swagger |
| `submit-service/public/index.html` | VM2 | Submit browser frontend |
| `submit-service/public/app.js` | VM2 | Frontend JavaScript |
| `infra/vm2-compose.yml` | VM2 | Docker Compose for VM2 services |
| `infra/vm2-setup.sh` | VM2 | Bootstrap Docker on VM2 |
| `infra/.env.vm2.example` | VM2 | Environment template for VM2 |
| `infra/terraform/main.tf` | VM3 | Azure resources + Kong provisioning |
| `infra/terraform/variables.tf` | VM3 | Terraform input variables |
| `infra/terraform/outputs.tf` | VM3 | Post-apply output values |
| `infra/terraform/kong.yml.tpl` | VM3 | Kong config template (edit this to change routes) |
| `infra/terraform/terraform.tfvars.example` | VM3 | Terraform values template |
| `infra/kong/docker-compose.yml` | VM3 | Kong container definition |
| `infra/vm3-setup.sh` | VM3 | Manual Docker bootstrap for VM3 |
| `infra/deploy.sh` | local | Deploy source files to VM1 + VM2 via scp |

### ⚠️ Local Development Only — Not Used in Distributed Deployment

| File | Reason |
|------|--------|
| `docker-compose.yml` (root) | Phase 1 all-in-one local stack. Not deployed to any VM. Useful for local testing only. |

### 🚫 Must Never Be Committed (Already in `.gitignore`)

| File/Path | Reason |
|-----------|--------|
| `node_modules/` | Rebuild via `npm install` inside Docker |
| `.env`, `infra/.env.vm1`, `infra/.env.vm2` | Contain real credentials |
| `infra/terraform/terraform.tfvars` | Contains subscription ID + your IP |
| `infra/terraform/terraform.tfstate` | Contains real Azure resource IDs and IPs — use remote state in production |
| `infra/terraform/terraform.tfstate.backup` | Sensitive state backup |
| `infra/kong/kong.yml` | Generated by Terraform from `kong.yml.tpl` |
| `infra/kong/certs/*.crt`, `*.key`, `*.pem` | TLS private key — never commit |

> **Note:** `terraform.tfstate` is in `.gitignore` but may still be present locally. This is acceptable for a student demo but must use remote state (Azure Storage / Terraform Cloud) in production.

---

## 3. Clean Folder Structure

```
co3404-distributed-joke-system/
├── .gitignore                          # Excludes secrets, tfstate, node_modules
├── README.md                           # Project overview
├── docker-compose.yml                  # LOCAL DEV ONLY (Phase 1 all-in-one)
│
├── db/
│   └── init.sql                        # MySQL schema + seed data
│
├── joke-service/                       # → Deployed to VM1
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js
│   ├── db.js
│   └── public/
│       ├── index.html
│       └── app.js
│
├── etl-service/                        # → Deployed to VM1
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js
│   └── db.js
│
├── submit-service/                     # → Deployed to VM2
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js
│   ├── rabbitmq.js
│   └── public/
│       ├── index.html
│       └── app.js
│
└── infra/
    ├── deploy.sh                       # scp source files to VM1 + VM2
    ├── .env.vm1.example                # Copy → .env.vm1, fill VM2 private IP
    ├── .env.vm2.example                # Copy → .env.vm2, fill VM1 private IP
    ├── vm1-compose.yml                 # Docker Compose for VM1
    ├── vm1-setup.sh                    # Bootstrap Docker on VM1
    ├── vm2-compose.yml                 # Docker Compose for VM2
    ├── vm2-setup.sh                    # Bootstrap Docker on VM2
    ├── vm3-setup.sh                    # Manual Docker bootstrap for VM3
    │
    ├── kong/
    │   ├── docker-compose.yml          # Kong container (uploaded to VM3 by Terraform)
    │   └── certs/
    │       └── .gitkeep                # Dir tracked; certs gitignored
    │
    └── terraform/
        ├── main.tf                     # Azure + provisioners
        ├── variables.tf                # Input variable declarations
        ├── outputs.tf                  # Prints IPs + test commands
        ├── kong.yml.tpl                # Kong declarative config template
        └── terraform.tfvars.example    # Copy → terraform.tfvars
```

---

## 4. Prerequisites

| Tool | Install | Verify |
|------|---------|--------|
| Azure CLI | [docs.microsoft.com/cli/azure/install-azure-cli](https://docs.microsoft.com/cli/azure/install-azure-cli) | `az version` |
| Terraform ≥ 1.5 | `brew install terraform` | `terraform version` |
| jq | `brew install jq` | `jq --version` |
| SSH key | Must exist at `~/.ssh/co3404_key` | `ls ~/.ssh/co3404_key` |

```bash
# Verify Azure login
az account show --query "{sub:id, name:name}" -o table

# Verify your current public IP (needed for NSG SSH whitelist)
curl -4 -s ifconfig.me
```

---

## 5. VM1 — Joke Service + ETL + MySQL

**VM:** `vm-joke` | Private IP: `10.0.1.4` | Public IP: `85.211.178.130`

### 5.1 Bootstrap Docker (run once)

```bash
# Copy the setup script to VM1
scp -i ~/.ssh/co3404_key infra/vm1-setup.sh azureuser@85.211.178.130:~/

# Run the bootstrap
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130 "bash ~/vm1-setup.sh"

# Log out and back in (required for docker group to take effect)
```

### 5.2 Deploy Source Files

```bash
# From project root on your Mac
./infra/deploy.sh
```

This copies `joke-service/`, `etl-service/`, `db/`, `infra/vm1-compose.yml`,
and `infra/.env.vm1` to `~/co3404/` on VM1.

Or manually:
```bash
VM1=85.211.178.130
scp -i ~/.ssh/co3404_key -r joke-service etl-service db azureuser@$VM1:~/co3404/
scp -i ~/.ssh/co3404_key infra/vm1-compose.yml azureuser@$VM1:~/co3404/docker-compose.yml
```

### 5.3 Configure Environment

```bash
# Copy the example and fill in VM2's private IP
cp infra/.env.vm1.example infra/.env.vm1
# Edit infra/.env.vm1: set RABBITMQ_HOST=10.0.1.5

# Upload the env file
scp -i ~/.ssh/co3404_key infra/.env.vm1 azureuser@85.211.178.130:~/co3404/.env
```

**Contents of `.env` on VM1:**
```dotenv
DB_HOST=mysql
DB_USER=jokeuser
DB_PASSWORD=jokepassword
DB_NAME=jokesdb
DB_ROOT_PASSWORD=rootpassword
RABBITMQ_HOST=10.0.1.5          # VM2 private IP
RABBITMQ_USER=guest
RABBITMQ_PASSWORD=guest
```

### 5.4 Start VM1 Services

```bash
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130

cd ~/co3404
docker compose up -d --build

# Verify all three containers are running
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

**Expected output:**
```
NAMES                  STATUS                    PORTS
jokes_joke_service     Up X minutes              0.0.0.0:3001->3001/tcp
jokes_etl_service      Up X minutes
jokes_mysql            Up X minutes (healthy)    3306/tcp
```

> MySQL and ETL have no public port mapping — correct by design.

### 5.5 Verify VM1 Health

```bash
# From your Mac
curl http://85.211.178.130:3001/health
```

**Expected:**
```json
{ "status": "ok", "service": "joke-service", "db": "connected" }
```

```bash
# Verify MySQL has seed data
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130 \
  "docker exec jokes_mysql mysql -ujokeuser -pjokepassword jokesdb \
   -e 'SELECT COUNT(*) AS joke_count FROM jokes;'"
```

**Expected:** `joke_count: 8` (or however many seed jokes are in `init.sql`)

---

## 6. VM2 — Submit Service + RabbitMQ

**VM:** `vm-submit` | Private IP: `10.0.1.5` | Public IP: `85.211.241.251`

### 6.1 Bootstrap Docker (run once)

```bash
scp -i ~/.ssh/co3404_key infra/vm2-setup.sh azureuser@85.211.241.251:~/
ssh -i ~/.ssh/co3404_key azureuser@85.211.241.251 "bash ~/vm2-setup.sh"
# Log out and back in
```

### 6.2 Deploy Source Files

```bash
VM2=85.211.241.251
scp -i ~/.ssh/co3404_key -r submit-service azureuser@$VM2:~/co3404/
scp -i ~/.ssh/co3404_key infra/vm2-compose.yml azureuser@$VM2:~/co3404/docker-compose.yml
```

### 6.3 Configure Environment

```bash
cp infra/.env.vm2.example infra/.env.vm2
# Edit infra/.env.vm2: set JOKE_SERVICE_URL=http://10.0.1.4:3001

scp -i ~/.ssh/co3404_key infra/.env.vm2 azureuser@85.211.241.251:~/co3404/.env
```

**Contents of `.env` on VM2:**
```dotenv
RABBITMQ_USER=guest
RABBITMQ_PASSWORD=guest
JOKE_SERVICE_URL=http://10.0.1.4:3001    # VM1 private IP
```

### 6.4 Start VM2 Services

```bash
ssh -i ~/.ssh/co3404_key azureuser@85.211.241.251

cd ~/co3404
docker compose up -d --build

docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

**Expected:**
```
NAMES                   STATUS                    PORTS
jokes_submit_service    Up X minutes              0.0.0.0:3002->3002/tcp
jokes_rabbitmq          Up X minutes (healthy)    0.0.0.0:5672->5672/tcp, 0.0.0.0:15672->15672/tcp
```

### 6.5 Verify VM2 Health

```bash
curl http://85.211.241.251:3002/health
```

**Expected:**
```json
{ "status": "ok", "service": "submit-service", "rabbitmq": "connected" }
```

---

## 7. VM3 — Kong API Gateway (Terraform)

**VM:** `vm-kong` | Private IP: `10.0.1.6` | Public IP: `85.211.240.162` (static)

### 7.1 Configure Terraform

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:
```hcl
subscription_id = "4990b7f7-b6d3-4424-a459-49fcd9df2b65"
my_ip           = "<output of: curl -4 -s ifconfig.me>"
```

### 7.2 Deploy Kong VM

```bash
cd infra/terraform

terraform init          # download azurerm, local, null providers
terraform plan          # preview changes (should show ~8 resources)
terraform apply         # create VM3 + install Docker + start Kong (~8–12 min)
```

**What `terraform apply` does automatically:**
1. Creates NSG, static public IP, NIC, VM3 in `rg-co3404-jokes`
2. Installs Docker Engine on VM3
3. Renders `kong.yml` from `kong.yml.tpl` and uploads it
4. Generates a self-signed TLS certificate with IP SAN
5. Starts Kong container
6. Downloads `server.crt` to `infra/kong/certs/server.crt`

**Outputs printed on completion:**
```
kong_public_ip      = "85.211.240.162"
kong_https_base_url = "https://85.211.240.162"
ssh_command         = "ssh -i ~/.ssh/co3404_key azureuser@85.211.240.162"
test_joke_api       = "curl -sk https://85.211.240.162/joke/programming | jq ."
```

### 7.3 Trust the TLS Certificate (macOS)

```bash
# Add self-signed cert to macOS System Keychain
sudo security add-trusted-cert \
  -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  infra/kong/certs/server.crt
```

> Fully restart your browser (Cmd+Q) after adding to Keychain.

For `curl` without the Keychain step, use `-sk` (skip verification):
```bash
curl -sk https://85.211.240.162/joke/any | jq .
```

### 7.4 Verify Kong Container

```bash
KONG_IP=85.211.240.162

# Kong health check
ssh -i ~/.ssh/co3404_key azureuser@$KONG_IP \
  "sudo docker exec kong_gateway kong health"
```

**Expected:**
```
Kong is healthy at ...
```

```bash
# Verify Kong response headers (proves traffic flows through Kong)
curl -sk -I https://$KONG_IP/joke/any | grep -E "Kong-Request-ID|X-Kong"
```

**Expected:**
```
kong-request-id: d4f2c1a0-...        ← correlation-id plugin active
x-kong-upstream-latency: 12
x-kong-proxy-latency: 1
```

---

## 8. End-to-End Verification Tests

Set the Kong IP once for all commands:
```bash
KONG_IP=85.211.240.162
VM1_IP=85.211.178.130
VM2_IP=85.211.241.251
```

---

### 8.1 Joke Service via Kong

**Test:** Kong routes `/joke/*` to VM1 `joke-service:3001`

```bash
# Fetch a programming joke
curl -sk https://$KONG_IP/joke/programming | jq .
```

**Expected:**
```json
{
  "id": 3,
  "setup": "Why do programmers prefer dark mode?",
  "punchline": "Because light attracts bugs!",
  "type": "programming"
}
```

```bash
# Fetch a random joke
curl -sk https://$KONG_IP/joke/any | jq .

# Fetch multiple jokes
curl -sk "https://$KONG_IP/joke/dad?count=3" | jq .

# List all joke types
curl -sk https://$KONG_IP/joke/types | jq .
```

---

### 8.2 Submit → RabbitMQ → ETL → MySQL (Full Pipeline)

**Step 1 — Submit a joke through Kong:**
```bash
curl -sk -X POST https://$KONG_IP/submit \
  -H "Content-Type: application/json" \
  -d '{
    "setup":     "Why did the DevOps engineer quit?",
    "punchline": "Because they kept getting deployed to production.",
    "type":      "programming"
  }' | jq .
```

**Expected:**
```json
{
  "message": "Joke queued for processing by the ETL service",
  "queued": {
    "setup": "Why did the DevOps engineer quit?",
    "punchline": "Because they kept getting deployed to production.",
    "type": "programming"
  }
}
```

**Step 2 — Verify message reached RabbitMQ (management UI or CLI):**
```bash
# Check queue depth via RabbitMQ HTTP API (before ETL processes it)
curl -s -u guest:guest http://$VM2_IP:15672/api/queues/%2F/jokes_queue | \
  jq '{messages: .messages, consumers: .consumers}'
```

**Expected (if ETL is running and fast):**
```json
{ "messages": 0, "consumers": 1 }
```

The message count is 0 because ETL already consumed it. `consumers: 1` confirms the ETL is connected.

**Step 3 — Verify joke was written to MySQL by ETL:**
```bash
ssh -i ~/.ssh/co3404_key azureuser@$VM1_IP \
  "docker exec jokes_mysql mysql -ujokeuser -pjokepassword jokesdb \
   -e 'SELECT id, setup, type_id FROM jokes ORDER BY id DESC LIMIT 3;'" 2>/dev/null
```

**Expected:** Your new joke appears at the top of the results.

**Step 4 — Verify new joke is retrievable via Kong:**
```bash
curl -sk https://$KONG_IP/joke/programming | jq .setup
```

The joke you submitted should now appear in responses.

---

### 8.3 ETL Consumer Verification

Confirm the ETL service is connected to RabbitMQ and consuming the queue:

```bash
# Check ETL logs for successful consumption
ssh -i ~/.ssh/co3404_key azureuser@$VM1_IP \
  "docker logs jokes_etl_service --tail 20"
```

**Expected log lines:**
```
[RabbitMQ] Connecting…
[RabbitMQ] Connected. Queue "jokes_queue" asserted.
[DB] Connected to MySQL
[ETL] Inserted type 'programming' (id=2)
[ETL] Inserted joke id=9 — "Why did the DevOps engineer quit?"
[ETL] ACK'd message
```

---

### 8.4 Private IP Communication Verification

Confirm cross-VM communication uses private IPs (not public IPs):

```bash
# From VM3 (Kong), can it reach VM1 on private IP?
ssh -i ~/.ssh/co3404_key azureuser@$KONG_IP \
  "curl -s http://10.0.1.4:3001/health"
```

**Expected:**
```json
{ "status": "ok", "service": "joke-service", "db": "connected" }
```

```bash
# From VM3, can it reach VM2 on private IP?
ssh -i ~/.ssh/co3404_key azureuser@$KONG_IP \
  "curl -s http://10.0.1.5:3002/health"
```

**Expected:**
```json
{ "status": "ok", "service": "submit-service", "rabbitmq": "connected" }
```

```bash
# From VM1 (ETL), can it reach RabbitMQ on VM2 private IP?
ssh -i ~/.ssh/co3404_key azureuser@$VM1_IP \
  "nc -zv 10.0.1.5 5672 && echo 'AMQP reachable'"
```

**Expected:** `Connection to 10.0.1.5 5672 port [tcp/amqp] succeeded!`

---

### 8.5 HTTPS Verification

```bash
# Verify TLS is active and the certificate is valid
curl -sk -v https://$KONG_IP/joke/any 2>&1 | grep -E "SSL|TLS|certificate|cipher"
```

**Expected output includes:**
```
* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
* Server certificate:
*  subject: CN=85.211.240.162
*  SSL certificate verify ok.   ← only if cert is in Keychain
```

```bash
# Confirm HTTP redirects or is also functional (Kong listens on :80 too)
curl -sk http://$KONG_IP/joke/any | jq .setup
```

---

### 8.6 Rate Limiting Test

The Joke API is limited to **5 requests per minute per IP**.

```bash
KONG_IP=85.211.240.162

echo "=== Rate Limit Test (max 5/min) ==="
for i in $(seq 1 8); do
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" https://$KONG_IP/joke/any)
  echo "  Request $i → HTTP $STATUS"
  sleep 0.3
done
```

**Expected output:**
```
=== Rate Limit Test (max 5/min) ===
  Request 1 → HTTP 200
  Request 2 → HTTP 200
  Request 3 → HTTP 200
  Request 4 → HTTP 200
  Request 5 → HTTP 200
  Request 6 → HTTP 429   ← rate limit enforced
  Request 7 → HTTP 429
  Request 8 → HTTP 429
```

**Inspect rate limit response headers:**
```bash
curl -sk -i https://$KONG_IP/joke/any | head -25
```

**Expected headers on a 429:**
```
HTTP/2 429
x-ratelimit-limit-minute: 5
x-ratelimit-remaining-minute: 0
retry-after: 60
content-type: application/json

{"message":"Rate limit exceeded — Joke API allows 5 req/min. Retry after 60 seconds."}
```

**Confirm Submit API has NO rate limit:**
```bash
echo "=== Submit has no rate limit ==="
for i in $(seq 1 8); do
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" \
    -X POST https://$KONG_IP/submit \
    -H "Content-Type: application/json" \
    -d "{\"setup\":\"Load test $i\",\"punchline\":\"No limit\",\"type\":\"general\"}")
  echo "  Submit $i → HTTP $STATUS"
  sleep 0.1
done
```

**Expected:** All 8 requests return `200` — per-service plugin isolation confirmed.

---

## 9. Resilience Testing

### 9.1 Stop Joke Service — Kong Isolates Failure

```bash
KONG_IP=85.211.240.162
VM1_IP=85.211.178.130

# Stop the Joke service container on VM1
ssh -i ~/.ssh/co3404_key azureuser@$VM1_IP \
  "docker stop jokes_joke_service"

sleep 3

# Joke API should return 502 (upstream unreachable)
echo -n "Joke API (service down):  "
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://$KONG_IP/joke/any

# Submit API MUST still work (different upstream — service isolation)
echo -n "Submit API (still up):    "
curl -sk -o /dev/null -w "HTTP %{http_code}\n" \
  -X POST https://$KONG_IP/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Resilience test","punchline":"Submit still works!","type":"general"}'
```

**Expected:**
```
Joke API (service down):  HTTP 502
Submit API (still up):    HTTP 200
```

**Restore Joke service:**
```bash
ssh -i ~/.ssh/co3404_key azureuser@$VM1_IP \
  "docker start jokes_joke_service"
sleep 5
curl -sk https://$KONG_IP/joke/any | jq .setup
```

---

### 9.2 Stop ETL — Messages Queue in RabbitMQ

```bash
VM1_IP=85.211.178.130
VM2_IP=85.211.241.251

# Stop the ETL service
ssh -i ~/.ssh/co3404_key azureuser@$VM1_IP \
  "docker stop jokes_etl_service"

# Submit 3 jokes while ETL is down
for i in 1 2 3; do
  curl -sk -X POST https://$KONG_IP/submit \
    -H "Content-Type: application/json" \
    -d "{\"setup\":\"Queued joke $i\",\"punchline\":\"No ETL\",\"type\":\"general\"}" \
    -o /dev/null -w "Submit $i: HTTP %{http_code}\n"
done

# Check queue depth — should be 3 unprocessed messages
curl -s -u guest:guest http://$VM2_IP:15672/api/queues/%2F/jokes_queue | \
  jq '{messages: .messages, consumers: .consumers}'
```

**Expected:**
```
Submit 1: HTTP 200
Submit 2: HTTP 200
Submit 3: HTTP 200
{ "messages": 3, "consumers": 0 }   ← messages queued, no consumer
```

```bash
# Restart ETL — it will consume all 3 queued messages
ssh -i ~/.ssh/co3404_key azureuser@$VM1_IP \
  "docker start jokes_etl_service"
sleep 5

# Queue should be empty now
curl -s -u guest:guest http://$VM2_IP:15672/api/queues/%2F/jokes_queue | \
  jq '{messages: .messages, consumers: .consumers}'
```

**Expected:**
```json
{ "messages": 0, "consumers": 1 }
```

At-least-once delivery confirmed — no jokes lost during ETL downtime.

---

### 9.3 VM Reboot Resilience (auto-restart)

```bash
# Reboot VM1 — all containers should come back automatically
# (restart: unless-stopped in docker-compose + systemctl enable docker)
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130 "sudo reboot"

# Wait ~90 seconds, then check containers are back
sleep 90
curl http://85.211.178.130:3001/health
```

---

## 10. Kong Admin Diagnostics

Run these from inside VM3:
```bash
ssh -i ~/.ssh/co3404_key azureuser@85.211.240.162
```

```bash
# View all configured routes
curl -s http://127.0.0.1:8001/routes | jq '.data[] | {name, paths, methods}'

# View all services (upstreams)
curl -s http://127.0.0.1:8001/services | jq '.data[] | {name, host, port}'

# View all active plugins
curl -s http://127.0.0.1:8001/plugins | jq '.data[] | {name, service: .service.id, config}'

# Check rate limit counters
curl -s http://127.0.0.1:8001/plugins | \
  jq '.data[] | select(.name=="rate-limiting") | .config'

# Verify Kong version and uptime
curl -s http://127.0.0.1:8001/ | jq '{version, tagline}'

# View Kong container logs
sudo docker logs kong_gateway --tail 50
```

**Hot-reload Kong config without restart:**
```bash
# Edit the config file
nano ~/kong/kong.yml

# Apply without restarting the container
curl -s -X POST http://127.0.0.1:8001/config \
  -F config=@/home/azureuser/kong/kong.yml | jq .message
```

**Expected:** `"Configuration loaded"`

---

## 11. Troubleshooting

### `terraform apply` fails — "SSH connection refused"

```bash
# Your public IP may have changed since last run
curl -4 -s ifconfig.me

# Update terraform.tfvars with new IP
# Then re-apply
cd infra/terraform && terraform apply
```

---

### HTTP 502 on `/joke/*` or `/submit/*`

Kong can't reach the upstream. Check in order:

```bash
# 1. Are Phase 2 containers running?
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130 \
  "docker ps --format 'table {{.Names}}\t{{.Status}}'"

# 2. From Kong VM, can it ping VM1 on private IP?
ssh -i ~/.ssh/co3404_key azureuser@85.211.240.162 \
  "curl -s --connect-timeout 3 http://10.0.1.4:3001/health || echo 'UNREACHABLE'"

# 3. Check NSG rules allow traffic from 10.0.1.6 → 10.0.1.4:3001
az network nsg rule list -g rg-co3404-jokes --nsg-name nsg-joke -o table
```

---

### Kong container exits immediately

```bash
ssh -i ~/.ssh/co3404_key azureuser@85.211.240.162
cd ~/kong && sudo docker compose logs kong
```

**Validate the kong.yml syntax:**
```bash
sudo docker run --rm \
  -v $(pwd)/kong.yml:/kong.yml \
  kong:3.9 kong config parse /kong.yml
```

**Check certs exist:**
```bash
ls -la ~/kong/certs/
# Must have: server.crt server.key
```

---

### ETL not consuming messages

```bash
# Check ETL logs for errors
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130 \
  "docker logs jokes_etl_service --tail 30"

# Verify ETL can reach RabbitMQ on VM2 private IP
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130 \
  "nc -zv 10.0.1.5 5672 && echo 'AMQP reachable' || echo 'AMQP BLOCKED'"
```

If `AMQP BLOCKED` — check the NSG on VM2 allows TCP 5672 from VirtualNetwork service tag.

---

### Rate limit counter does not reset after 60 seconds

Kong uses per-IP counters with a sliding minute window. Wait a **full 60 seconds** from the **first** request in the current window, not from the 429.

```bash
# Check remaining quota
curl -sk -I https://85.211.240.162/joke/any | grep -i ratelimit
```

---

### `terraform destroy` leaves orphaned resources

```bash
cd infra/terraform

# Check what Terraform still tracks
terraform state list

# Remove a specific resource from state if it was deleted outside Terraform
terraform state rm azurerm_linux_virtual_machine.vm_kong

# Force destroy all tracked resources
terraform destroy -auto-approve
```

---

### RabbitMQ Management UI inaccessible

The UI on port 15672 is NSG-restricted to `my_ip` only.

```bash
# Get your current IP
MY_IP=$(curl -4 -s ifconfig.me)

# Check the NSG rule
az network nsg rule show \
  -g rg-co3404-jokes \
  --nsg-name nsg-submit \
  --name Allow-RabbitMQ-Management \
  --query "{source: sourceAddressPrefix, dest_port: destinationPortRange}"
```

If your IP has changed, update the NSG rule:
```bash
az network nsg rule update \
  -g rg-co3404-jokes \
  --nsg-name nsg-submit \
  --name Allow-RabbitMQ-Management \
  --source-address-prefix "$MY_IP"
```

---

## 12. Azure Cost-Saving Tips

### Stop individual VMs when not in use

```bash
# Deallocate = VM off, disk billed but compute free
az vm deallocate -g rg-co3404-jokes -n vm-joke   --no-wait
az vm deallocate -g rg-co3404-jokes -n vm-submit --no-wait
az vm deallocate -g rg-co3404-jokes -n vm-kong   --no-wait

# Check status
az vm list -g rg-co3404-jokes --query "[].{name:name, state:powerState}" -o table
```

### Restart VMs before a session

```bash
az vm start -g rg-co3404-jokes -n vm-joke   --no-wait
az vm start -g rg-co3404-jokes -n vm-submit --no-wait
az vm start -g rg-co3404-jokes -n vm-kong   --no-wait

# Wait for all VMs to be running
az vm list -g rg-co3404-jokes --query "[].{name:name, state:powerState}" -o table
```

> **Note:** VM1 and VM2 use **dynamic** public IPs. After a restart their IPs change — update `infra/deploy.sh` (`VM1_IP`, `VM2_IP`), `infra/.env.vm1`, `infra/.env.vm2`, and redeploy. Docker containers restart automatically. VM3's Kong uses a **static** IP (`pip-kong`) — it never changes.

### Destroy Kong VM only (keeps Phase 2 intact)

```bash
cd infra/terraform
terraform destroy
```

This removes only the Terraform-managed resources (NSG, public IP, NIC, VM3). VM1 and VM2 are untouched.

### Destroy everything

```bash
# Deletes the entire resource group including VM1, VM2, VM3, VNet, disks
az group delete -n rg-co3404-jokes --yes --no-wait
```

### Check current spend

```bash
az consumption usage list \
  --start-date $(date -v-7d +%Y-%m-%d) \
  --end-date $(date +%Y-%m-%d) \
  --query "[].{service:instanceName, cost:pretaxCost}" \
  -o table
```

---

## 13. Security Best Practices

### What is correctly secured in this deployment

| Control | Implementation | Status |
|---------|---------------|--------|
| SSH restricted to your IP | NSG rule `Allow-SSH` uses `var.my_ip` | ✅ |
| Kong Admin API internal-only | Bound to `127.0.0.1:8001` — not exposed to internet | ✅ |
| RabbitMQ AMQP VNet-only | NSG `Allow-AMQP-VNet` uses `VirtualNetwork` service tag | ✅ |
| RabbitMQ Management restricted | NSG allows port 15672 from `my_ip` only | ✅ |
| MySQL unexposed externally | No `ports:` mapping in `vm1-compose.yml` | ✅ |
| ETL unexposed externally | No `ports:` mapping in `vm1-compose.yml` | ✅ |
| Secrets in `.env` files | `.env` files gitignored; only `.example` committed | ✅ |
| TLS on Kong | Self-signed cert with IP SAN; terminates at Kong | ✅ |
| Terraform state gitignored | `terraform.tfstate` in `.gitignore` | ✅ |

### Known limitations (acceptable for student demo)

| Limitation | Production Fix |
|------------|---------------|
| Self-signed TLS certificate | Use Let's Encrypt with a domain name or Azure-managed cert |
| `terraform.tfstate` stored locally | Use remote state in Azure Storage (`azurerm` backend) |
| Default RabbitMQ credentials (`guest/guest`) | Use strong credentials via Azure Key Vault |
| No HTTPS between Kong and upstreams | Enable mTLS on internal VNet traffic |
| Single Kong node | Use Azure Load Balancer + multiple Kong instances |
| No secrets rotation | Integrate Azure Key Vault with Docker secrets |

### Rotate SSH access if IP changes

```bash
# Get current IP
MY_IP=$(curl -4 -s ifconfig.me)

# Update Kong NSG SSH rule
az network nsg rule update \
  -g rg-co3404-jokes \
  --nsg-name nsg-kong \
  --name Allow-SSH \
  --source-address-prefix "$MY_IP"
```

### Verify no unintended ports are exposed

```bash
# List all NSG rules for each VM
az network nsg rule list -g rg-co3404-jokes --nsg-name nsg-kong   -o table
az network nsg rule list -g rg-co3404-jokes --nsg-name nsg-joke   -o table
az network nsg rule list -g rg-co3404-jokes --nsg-name nsg-submit -o table
```

Kong NSG should only show: SSH (your IP), HTTP (any), HTTPS (any).
VM1 NSG should show: SSH (your IP), joke-service port 3001 (any).
VM2 NSG should show: SSH (your IP), submit port 3002 (any), AMQP VNet-only, RabbitMQ-UI (your IP only).

---

*Generated: 4 March 2026 | CO3404 Distributed Systems | Option 3 — 3-VM Azure Deployment*
