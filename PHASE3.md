# Phase 3 — Kong API Gateway (Terraform + Docker)

## Architecture

```
                        Internet
                            │
                     ┌──────▼───────┐
                     │  VM3: Kong   │  pip-kong (Static public IP)
                     │  vm-kong     │  NSG: ports 22 (your IP), 443, 80
                     │  10.0.1.6    │
                     └──┬───────┬───┘
                        │       │         Azure VNet 10.0.0.0/16
          ──────────────┼───────┼──────────────────────────────────
                        │       │
              ┌─────────▼──┐  ┌─▼───────────────┐
              │  VM1        │  │  VM2             │
              │  vm-joke    │  │  vm-submit       │
              │  10.0.1.4   │  │  10.0.1.5        │
              │             │  │                  │
              │ joke-service│  │ submit-service   │
              │ :3001       │  │ :3002            │
              │ etl-service │  │ rabbitmq :5672   │
              │ mysql       │  │                  │
              └─────────────┘  └──────────────────┘
```

**Request flow:**
```
Client → HTTPS :443 → Kong → /joke/*  → http://10.0.1.4:3001 (joke-service)
                           → /submit/* → http://10.0.1.5:3002 (submit-service)
```

**Kong features active:**
| Plugin          | Scope         | Config                          |
|-----------------|---------------|---------------------------------|
| rate-limiting   | joke-service  | 5 req/min per IP, returns 429   |
| correlation-id  | global        | adds Kong-Request-ID header     |

---

## Prerequisites

| Tool      | Install command              | Verify              |
|-----------|------------------------------|---------------------|
| Terraform | `brew install terraform`     | `terraform version` |
| Azure CLI | already installed (Phase 2)  | `az version`        |
| jq        | `brew install jq`            | `jq --version`      |

**Phase 2 must be running** — VM1 and VM2 with all services healthy.

---

## Step 1 — Configure Terraform

```bash
cd infra/terraform

# Copy the example and fill in your values
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:
```hcl
subscription_id = "4990b7f7-b6d3-4424-a459-49fcd9df2b65"   # your Azure Students sub
my_ip           = "175.157.84.237"                          # curl -4 ifconfig.me
```

All other values default to the Phase 2 settings (VM IPs, region, VNet name).

---

## Step 2 — Deploy Kong VM with Terraform

```bash
# Initialise providers (downloads azurerm, local, null)
terraform init

# Preview what will be created
terraform plan

# Create VM3, install Docker, upload Kong config, generate TLS cert, start Kong
terraform apply
```

`terraform apply` runs four sequential steps automatically:

| Step | What happens |
|------|-------------|
| Azure resources | NSG, Public IP, NIC, VM3 created in `malaysiawest` |
| Docker install | Docker 29.x + Compose plugin installed on VM3 |
| File upload | `docker-compose.yml` and `kong.yml` copied to VM3 |
| Kong deploy | Self-signed TLS cert generated, Kong container started, cert downloaded to `infra/kong/certs/server.crt` |

**Expected duration: ~8–12 minutes** (VM boot + Docker install + image pull)

**Outputs printed on completion:**
```
kong_public_ip      = "x.x.x.x"
kong_https_base_url = "https://x.x.x.x"
ssh_command         = "ssh -i ~/.ssh/co3404_key azureuser@x.x.x.x"
test_joke_api       = "curl -sk https://x.x.x.x/joke/programming | jq ."
...
```

---

## Step 3 — Trust the TLS Certificate (removes HTTPS warnings)

The self-signed certificate is downloaded to `infra/kong/certs/server.crt`.
To avoid browser/curl warnings, add it to the macOS System Keychain:

```bash
# Add to System Keychain (requires your Mac admin password)
sudo security add-trusted-cert \
  -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  infra/kong/certs/server.crt
```

> **Restart Chrome/Safari/Firefox** after adding to Keychain for browser warnings to disappear.

For curl without the Keychain step, use `-k` (insecure) or `--cacert`:
```bash
# Option A: skip cert verification (quick test only)
curl -sk https://KONG_IP/joke/any | jq .

# Option B: use the cert explicitly (proper verification)
curl --cacert infra/kong/certs/server.crt https://KONG_IP/joke/any | jq .
```

---

## Step 4 — Verify Kong is Healthy

```bash
KONG_IP=$(cd infra/terraform && terraform output -raw kong_public_ip)

# Check Kong's health endpoint via the Admin API (from inside the VM)
ssh -i ~/.ssh/co3404_key azureuser@$KONG_IP \
  "sudo docker exec kong_gateway kong health"
```

Expected output:
```
Kong is healthy at ...
```

```bash
# Verify Kong response headers are present
curl -sk -I https://$KONG_IP/joke/any | grep -E "Kong-Request-ID|X-Kong"
```

Expected headers:
```
Kong-Request-ID: d4f2c1a0-...       ← correlation-id plugin
X-Kong-Upstream-Latency: 12         ← ms taken to reach backend
X-Kong-Proxy-Latency: 1             ← ms taken by Kong itself
```

---

## Step 5 — Test Joke API via Kong

```bash
KONG_IP=$(cd infra/terraform && terraform output -raw kong_public_ip)

# Fetch a programming joke
curl -sk https://$KONG_IP/joke/programming | jq .
```

Expected response:
```json
{
  "id": 3,
  "setup": "Why do programmers prefer dark mode?",
  "punchline": "Because light attracts bugs!",
  "type": "programming"
}
```

```bash
# Fetch a random joke from any category
curl -sk https://$KONG_IP/joke/any | jq .

# Fetch multiple jokes
curl -sk "https://$KONG_IP/joke/dad?count=3" | jq .
```

---

## Step 6 — Test Submit API via Kong

```bash
KONG_IP=$(cd infra/terraform && terraform output -raw kong_public_ip)

# Submit a joke through Kong → RabbitMQ → ETL → MySQL
curl -sk -X POST https://$KONG_IP/submit \
  -H "Content-Type: application/json" \
  -d '{
    "setup":     "Why did the DevOps engineer quit?",
    "punchline": "Because they kept getting deployed to production.",
    "type":      "programming"
  }' | jq .
```

Expected response:
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

Verify it reached MySQL (via VM1):
```bash
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130 \
  "docker exec jokes_mysql mysql -ujokeuser -pjokepassword jokesdb \
   -e 'SELECT id, setup FROM jokes ORDER BY id DESC LIMIT 3;'" 2>/dev/null
```

---

## Step 7 — Rate Limiting Demonstration

The Joke API is limited to **5 requests per minute per IP**.
After 5 requests, Kong returns HTTP `429 Too Many Requests`.

### Quick demo — send 8 requests in rapid succession:

```bash
KONG_IP=$(cd infra/terraform && terraform output -raw kong_public_ip)

echo "Testing rate limit (max 5/min):"
for i in $(seq 1 8); do
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" https://$KONG_IP/joke/any)
  echo "  Request $i → HTTP $STATUS"
  sleep 0.3
done
```

**Expected output:**
```
Testing rate limit (max 5/min):
  Request 1 → HTTP 200
  Request 2 → HTTP 200
  Request 3 → HTTP 200
  Request 4 → HTTP 200
  Request 5 → HTTP 200
  Request 6 → HTTP 429   ← rate limit kicked in
  Request 7 → HTTP 429
  Request 8 → HTTP 429
```

### See the rate limit headers on a 429 response:

```bash
curl -sk -i https://$KONG_IP/joke/any | head -20
```

When rate limited, response includes:
```
HTTP/2 429
X-RateLimit-Limit-Minute: 5
X-RateLimit-Remaining-Minute: 0
Retry-After: 60
Content-Type: application/json

{"message":"Rate limit exceeded — Joke API allows 5 req/min. Retry after 60 seconds."}
```

### Confirm Submit API has NO rate limit:

```bash
# Submit multiple jokes rapidly — all should return 200
for i in $(seq 1 8); do
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" \
    -X POST https://$KONG_IP/submit \
    -H "Content-Type: application/json" \
    -d "{\"setup\":\"Test $i\",\"punchline\":\"Demo\",\"type\":\"general\"}")
  echo "  Submit $i → HTTP $STATUS"
  sleep 0.1
done
```

Expected: all 8 requests return `200` — Submit has no rate limit.

---

## Step 8 — Resilience Demonstration

This demonstrates that Kong continues serving the Submit API even when the Joke service is completely down.

### Stop the Joke service on VM1:

```bash
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130 \
  "docker stop jokes_joke_service"
```

### Test Kong behaviour with Joke service down:

```bash
KONG_IP=$(cd infra/terraform && terraform output -raw kong_public_ip)

# Joke API should return 502 Bad Gateway (upstream unreachable)
echo -n "Joke API (service down): "
curl -sk -o /dev/null -w "HTTP %{http_code}\n" https://$KONG_IP/joke/any

# Submit API should still work (different upstream)
echo -n "Submit API (still up):   "
curl -sk -o /dev/null -w "HTTP %{http_code}\n" \
  -X POST https://$KONG_IP/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Kong resilience test","punchline":"Submit still works!","type":"general"}'
```

**Expected output:**
```
Joke API (service down): HTTP 502
Submit API (still up):   HTTP 200
```

This demonstrates service isolation — a failure in one upstream does not affect other routes.

### Restore the Joke service:

```bash
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130 \
  "docker start jokes_joke_service"

# Confirm it's back
sleep 5
curl -sk https://$KONG_IP/joke/any | jq .setup
```

---

## Kong Admin API (diagnostic commands)

Run these **from inside VM3** (SSH in first):

```bash
ssh -i ~/.ssh/co3404_key azureuser@KONG_IP

# View all configured routes
curl -s http://127.0.0.1:8001/routes | jq '.data[] | {name, paths, methods}'

# View all configured services
curl -s http://127.0.0.1:8001/services | jq '.data[] | {name, host, port}'

# View all active plugins
curl -s http://127.0.0.1:8001/plugins | jq '.data[] | {name, config}'

# Check rate limit counters
curl -s http://127.0.0.1:8001/plugins | jq '.data[] | select(.name=="rate-limiting") | .config'

# Reload config from kong.yml without restart (DB-less hot reload)
curl -s -X POST http://127.0.0.1:8001/config \
  -F config=@/home/azureuser/kong/kong.yml | jq .message
```

---

## Updating Kong Configuration

To change routes, rate limits, or add plugins:

```bash
# 1. Edit the template (not kong.yml directly)
#    infra/terraform/kong.yml.tpl

# 2. Re-apply Terraform (only re-runs if config changed)
cd infra/terraform
terraform apply

# OR — manual hot-reload on the VM without Terraform:
ssh -i ~/.ssh/co3404_key azureuser@KONG_IP

# Edit kong.yml
nano ~/kong/kong.yml

# Hot-reload without container restart
curl -s -X POST http://127.0.0.1:8001/config \
  -F config=@/home/azureuser/kong/kong.yml | jq .message
```

---

## Cost Management

```bash
# Deallocate Kong VM when not in use (stops billing for compute)
az vm deallocate -g rg-co3404-jokes -n vm-kong --no-wait

# Restart Kong VM before next session
az vm start -g rg-co3404-jokes -n vm-kong

# Deallocate ALL three VMs (fully stop Phase 2 + Phase 3)
az vm deallocate -g rg-co3404-jokes -n vm-joke   --no-wait
az vm deallocate -g rg-co3404-jokes -n vm-submit --no-wait
az vm deallocate -g rg-co3404-jokes -n vm-kong   --no-wait

# Destroy Kong VM only (keeps Phase 2 intact)
cd infra/terraform && terraform destroy

# Destroy EVERYTHING (all phases)
az group delete -n rg-co3404-jokes --yes
```

> **Note:** After VM restart, the public IP changes if using `Dynamic` allocation.
> Phase 3 uses `Static` allocation for the Kong VM, so the IP stays the same.
> Phase 2 VMs (vm-joke, vm-submit) use dynamic IPs — if they restart, update
> `infra/.env.vm1`, `infra/.env.vm2`, and redeploy. Docker containers with
> `restart: unless-stopped` start automatically after VM boot.

---

## Troubleshooting

### `terraform apply` fails at "Waiting for VM to fully boot"

SSH connectivity failed during provisioning. This can happen if:
- Azure hasn't assigned the public IP yet
- NSG rule with `my_ip` is outdated (your IP changed)

```bash
# Check your current IP
curl -4 -s ifconfig.me

# Update terraform.tfvars with new IP, then re-apply
terraform apply
```

### Kong container exits immediately

```bash
ssh -i ~/.ssh/co3404_key azureuser@KONG_IP
cd ~/kong && sudo docker compose logs kong
```

Common causes:
- `kong.yml` syntax error — validate with: `sudo docker run --rm -v $(pwd)/kong.yml:/kong.yml kong:3.9 kong config parse /kong.yml`
- Cert file missing — check `ls -la ~/kong/certs/`

### HTTP 502 when calling `/joke/*` or `/submit/*`

Kong can't reach the upstream service. Check:

```bash
# From VM3, can it reach VM1?
curl -s http://10.0.1.4:3001/health

# From VM3, can it reach VM2?
curl -s http://10.0.1.5:3002/health

# Are Phase 2 services running?
ssh -i ~/.ssh/co3404_key azureuser@85.211.178.130 "docker ps --format 'table {{.Names}}\t{{.Status}}'"
ssh -i ~/.ssh/co3404_key azureuser@85.211.241.251 "docker ps --format 'table {{.Names}}\t{{.Status}}'"
```

### Rate limit counter doesn't reset after 60 seconds

Kong's `local` policy stores counters in memory. If you're testing from different IPs or behind NAT, the counters are per-IP. Wait a full 60 seconds from the **first** request in the window.

```bash
# Check current counter headers
curl -sk -I https://KONG_IP/joke/any | grep X-RateLimit
```

### HTTPS certificate warning still shown after Keychain install

```bash
# Verify the cert is trusted
security verify-cert -c infra/kong/certs/server.crt

# If not trusted, try removing and re-adding
sudo security remove-trusted-cert -d infra/kong/certs/server.crt
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  infra/kong/certs/server.crt
```

Then **fully restart your browser** (Cmd+Q, not just close window).

---

## File Reference

| File | Purpose |
|------|---------|
| `infra/terraform/main.tf` | Azure resources + provisioners |
| `infra/terraform/variables.tf` | All configurable inputs |
| `infra/terraform/outputs.tf` | Printed after apply (IPs, test commands) |
| `infra/terraform/terraform.tfvars` | Your actual values (gitignored) |
| `infra/terraform/terraform.tfvars.example` | Template to copy |
| `infra/terraform/kong.yml.tpl` | Kong config template (edit this) |
| `infra/kong/docker-compose.yml` | Kong container definition |
| `infra/kong/kong.yml` | Generated Kong config (gitignored) |
| `infra/kong/certs/server.crt` | Downloaded TLS cert (gitignored) |
| `infra/vm3-setup.sh` | Manual Docker install for VM3 |
