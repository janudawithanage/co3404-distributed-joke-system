# CO3404 Distributed Joke System — Deployment Guide

This guide takes you from a fresh clone to a fully running Azure deployment
and explains how to keep it up to date.  Read it top to bottom the first time;
for subsequent deploys jump straight to [Redeploy steps](#redeploy-steps).

> **⚠️ Azure status:** VMs may be deallocated (student subscription). All services work fully in local Docker — see [LOCAL_RUN.md](LOCAL_RUN.md).

---

## Architecture overview

| VM | Name | Private IP | Hosts |
|----|------|------------|-------|
| VM1 | joke-vm | 10.0.1.4 | MySQL · joke-service (3000) · etl-service (3001) |
| VM2 | submit-vm | 10.0.1.5 | RabbitMQ (5672, 15672) · submit-service (3200) |
| VM3 | moderate-vm | 10.0.1.7 | moderate-service (3300) |
| VM4 | kong-vm | public IP | Kong API Gateway (80 / 443) |

All user traffic flows through Kong.  Services talk to each other over the
Azure VNet using private IPs.

---

## Prerequisites

Before you start, make sure you have:

- [ ] An Azure subscription with 4 VMs provisioned (use Terraform in
      `infra/terraform/` or create them manually — Ubuntu 22.04 LTS, Standard B1s or larger)
- [ ] A Docker Hub account and an access token
      (Docker Hub → Account Settings → Security → New Access Token)
- [ ] An SSH key pair at `~/.ssh/co3404_key` / `~/.ssh/co3404_key.pub`
      whose public half is in `~/.ssh/authorized_keys` on every VM
- [ ] `curl`, `jq`, and `ssh` available on your local machine
- [ ] This repository cloned locally

---

## Step 1 — Add GitHub Secrets (one-time)

Go to **GitHub → your repo → Settings → Secrets and variables → Actions** and
add every secret in the table below.

> All four services share the same SSH key, so `VM*_SSH_PRIVATE_KEY` will be
> the same value four times.  Copy the output of `cat ~/.ssh/co3404_key`.

| Secret name | Description | How to get the value |
|-------------|-------------|----------------------|
| `DOCKER_HUB_USERNAME` | Your Docker Hub username | Docker Hub profile page |
| `DOCKER_HUB_TOKEN` | Docker Hub access token (not your password) | Docker Hub → Security → New Access Token |
| `VM1_HOST` | Public IP of VM1 (joke-vm) | Azure portal → VM1 → Overview → Public IP |
| `VM1_SSH_PRIVATE_KEY` | SSH private key for VM1 | `cat ~/.ssh/co3404_key` |
| `VM2_HOST` | Public IP of VM2 (submit-vm) | Azure portal → VM2 → Public IP |
| `VM2_SSH_PRIVATE_KEY` | SSH private key for VM2 | `cat ~/.ssh/co3404_key` |
| `VM3_HOST` | Public IP of VM3 (moderate-vm) | Azure portal → VM3 → Public IP |
| `VM3_SSH_PRIVATE_KEY` | SSH private key for VM3 | `cat ~/.ssh/co3404_key` |
| `KONG_VM_HOST` | Public IP of VM4 (kong-vm) | Azure portal → VM4 → Public IP |
| `KONG_VM_SSH_PRIVATE_KEY` | SSH private key for VM4 | `cat ~/.ssh/co3404_key` |
| `KONG_PUBLIC_URL` | Full gateway URL, e.g. `https://1.2.3.4` | Same as `KONG_VM_HOST` but with scheme |

> **Where is the Kong public IP?**  Run:
> ```bash
> terraform -chdir=infra/terraform output -raw kong_public_ip
> # or look it up in Azure portal → VM4 → Overview → Public IP address
> ```

---

## Step 2 — Create .env files (one-time)

The `.env.vm*` files are **gitignored** — they hold credentials and are never
committed.  Create them from the examples and fill in every `REPLACE_WITH_*`
value.

```bash
# VM1 — joke-service + ETL + MySQL
cp infra/.env.vm1.example infra/.env.vm1

# VM2 — submit-service + RabbitMQ
cp infra/.env.vm2.example infra/.env.vm2

# VM3 — moderate-service (+ optional Auth0)
cp infra/.env.vm3.example infra/.env.vm3
```

**Minimum values to fill in** (others have working defaults for the lab):

| File | Variable | Value |
|------|----------|-------|
| `.env.vm1` | `RABBITMQ_HOST` | Private IP of VM2, e.g. `10.0.1.5` |
| `.env.vm1` | `PUBLIC_GATEWAY_BASE` | Kong URL, e.g. `https://1.2.3.4` |
| `.env.vm1` | `JOKE_IMAGE` | `<your-dockerhub>/joke-service:latest` |
| `.env.vm2` | `PUBLIC_GATEWAY_BASE` | Kong URL, e.g. `https://1.2.3.4` |
| `.env.vm2` | `SUBMIT_IMAGE` | `<your-dockerhub>/submit-service:latest` |
| `.env.vm3` | `RABBITMQ_HOST` | Private IP of VM2, e.g. `10.0.1.5` |
| `.env.vm3` | `DOCKER_IMAGE` | `<your-dockerhub>/moderate-service:latest` |

> **Auth0** (optional):  Fill in `AUTH0_*` values in `.env.vm3` to enable
> login-protected moderation.  Leave them as `REPLACE_WITH_*` to run the
> service in **unconfigured** passthrough mode (fine for demos, not production).

---

## Step 3 — Bootstrap VMs (one-time per VM)

Each VM needs Docker installed.  Run the setup script once, then log out and
back in so the `docker` group takes effect.

```bash
SSHKEY="-i ~/.ssh/co3404_key"

# VM1
scp $SSHKEY infra/vm1-setup.sh azureuser@<VM1_IP>:~/
ssh $SSHKEY azureuser@<VM1_IP> "bash ~/vm1-setup.sh"
# Log out and back in, then continue.

# VM2 — same script works for all VMs
scp $SSHKEY infra/vm2-setup.sh azureuser@<VM2_IP>:~/
ssh $SSHKEY azureuser@<VM2_IP> "bash ~/vm2-setup.sh"

# VM3
scp $SSHKEY infra/vm3-setup.sh azureuser@<VM3_IP>:~/
ssh $SSHKEY azureuser@<VM3_IP> "bash ~/vm3-setup.sh"

# VM4 (Kong) — Docker only, no compose needed from setup.sh
scp $SSHKEY infra/vm1-setup.sh azureuser@<KONG_IP>:~/
ssh $SSHKEY azureuser@<KONG_IP> "bash ~/vm1-setup.sh"
```

---

## Step 4 — First deployment

Edit `infra/deploy.sh` and set the four IP variables at the top:

```bash
VM1_IP="<vm1-public-ip>"
VM2_IP="<vm2-public-ip>"
VM3_IP="<vm3-public-ip>"    # optional — CI/CD handles this on every push
KONG4_IP="<kong-public-ip>"
```

Then run the script from the **project root**:

```bash
chmod +x infra/deploy.sh
./infra/deploy.sh
```

What happens:
1. Copies service source + compose files + `.env` to each VM via `scp`
2. Pulls Docker Hub images (joke-service, submit-service, moderate-service)
3. Runs `docker compose down && docker compose up -d --build`
4. **Runs the DB index migration** on VM1 (idempotent — safe to re-run)
5. **Health-checks** each service before moving to the next VM
6. Copies `kong.yml` to VM4 and restarts Kong

Expected output ends with:
```
[VM1] ✅ Port 3000 is healthy.
[VM1] ✅ Port 3001 is healthy.
[VM2] ✅ Port 3200 is healthy.
[VM3] ✅ moderate-service restarted.
[Kong VM4] ✅ Kong restarted with new config.
```

---

## Step 5 — Verify with the smoke test

```bash
./infra/scripts/smoke-test.sh <kong_public_ip>
# or with http:// if TLS is not yet configured:
./infra/scripts/smoke-test.sh <kong_public_ip> --http
```

The script tests:
- **A.** All 11 static routes (status codes)
- **B.** Full pipeline: submit → RabbitMQ → moderate queue → approve → MySQL → `/jokes`
- **C.** Rate limiting (6 rapid `/joke/any` requests trigger 429)
- **D.** `/auth-status` JSON shape
- **E.** Kong middleware headers (`Kong-Request-ID`, `X-RateLimit-*`, `X-Auth-Mode`)

A clean deployment produces output like:

```
CO3404 Smoke Test
  Target: https://1.2.3.4

A. Static / health routes
  PASS  GET /health  →  HTTP 200
  PASS  GET /joke/any  →  HTTP 200
  ...
C. Rate limiting
  PASS  Rate limiting  →  429 returned (rate limit is active)

─────────────────────────────────────────────────────────
 Results:  18 passed  /  0 failed  /  0 warnings  (18 total)
─────────────────────────────────────────────────────────

Smoke test PASSED.  Deployment looks healthy.
```

---

## Redeploy steps

### After a code change — just push to `main`

CI/CD handles everything automatically:

| Files changed | Workflow triggered | What it does |
|---------------|-------------------|--------------|
| `joke-service/**` | `deploy-joke.yml` | Build image → push to Docker Hub → SSH to VM1 → pull + restart → health check |
| `submit-service/**` | `deploy-submit.yml` | Same for VM2 |
| `moderate-service/**` | `deploy-moderate.yml` | Same for VM3 |
| `etl-service/**` | `deploy-etl.yml` | Build image → push to Docker Hub → SSH to VM1 → pull + restart etl-service only → health check |
| `infra/kong/kong.yml` | `deploy-kong.yml` | SCP kong.yml to VM4 → restart Kong → smoke test `/health` |

Each workflow also **injects the current `KONG_PUBLIC_URL` secret into `.env`**
on the target VM, so a Kong IP change is handled automatically.

### Force a redeploy without a code change

```bash
git commit --allow-empty -m "chore: force redeploy" && git push
```

Or trigger any workflow manually from **GitHub → Actions → select workflow → Run workflow**.

### Redeploy a single VM manually

If you need to bypass CI/CD (e.g. first-time setup, ETL-only change):

```bash
# VM1 only (joke-service + ETL + DB migration)
VM1_IP=<ip> VM2_IP=placeholder ./infra/deploy.sh
# NOTE: VM2_IP must not be the literal placeholder or the guard will reject it.
# Better: set both IPs and the script will deploy both.

# Just Kong
KONG_IP=<ip> ./infra/scripts/redeploy-kong.sh

# ETL only (no CI/CD for ETL — always use deploy.sh)
./infra/deploy.sh   # copies etl-service/ and rebuilds on VM1
```

### Update a `.env` variable (e.g. new Kong IP)

1. Edit `infra/.env.vm1` and/or `infra/.env.vm2`
2. Run `./infra/deploy.sh` — it copies the new `.env` and restarts affected services
3. **Or** update the `KONG_PUBLIC_URL` GitHub Secret — the next CI/CD run will inject
   the new value automatically.

---

## What is automated vs manual

### Fully automated (CI/CD)
- Building and pushing Docker images on every `git push main`
- Deploying joke-service to VM1 when `joke-service/**` changes
- Deploying submit-service to VM2 when `submit-service/**` changes
- Deploying moderate-service to VM3 when `moderate-service/**` changes
- Reloading Kong on VM4 when `infra/kong/kong.yml` changes
- Injecting `PUBLIC_GATEWAY_BASE` into remote `.env` on each deploy

### Manual (first-time only)
- Provisioning Azure VMs and creating the SSH key
- Adding GitHub Secrets (see Step 1 table)
- Creating `.env.vm*` files from the examples (Step 2)
- Running `vm*-setup.sh` on each VM to install Docker (Step 3)
- Running `./infra/deploy.sh` for the initial full deployment (Step 4)
- Setting up Auth0 credentials in `.env.vm3` (if needed)

### Manual (ongoing)
- TLS certificate rotation → update `infra/kong/certs/` and push to main (Kong CI/CD handles the rest)
- Scaling / adding VMs → update Terraform and re-run `deploy.sh`
- First-time ETL deploy → run `./infra/deploy.sh` (CI/CD takes over for subsequent changes)

---

## Troubleshooting

### "SYSTEM STATUS — Checking…" stuck on the joke homepage
`PUBLIC_GATEWAY_BASE` is missing or still a placeholder in `infra/.env.vm1`.
Fix: set the correct Kong URL, then re-run `./infra/deploy.sh`.

### Swagger "Try it out" — connection refused
`PUBLIC_GATEWAY_BASE` is missing in `infra/.env.vm2`.
Fix: same as above for VM2.

### Container fails to start on VM1
`JOKE_IMAGE` is missing or still a placeholder.  Docker Compose falls back to
`your-dockerhub-username/joke-service:latest` which doesn't exist.
Fix: set `JOKE_IMAGE=<username>/joke-service:latest` in `infra/.env.vm1`.

### MySQL won't start (InnoDB index key too long)
The data volume has the old `uq_joke (setup(500), punchline(500))` index.
Fix:
```bash
ssh -i ~/.ssh/co3404_key azureuser@<VM1_IP>
bash ~/co3404/fix-db-index.sh
```
Or re-run `./infra/deploy.sh` — it now calls this migration automatically.

### Rate limiting not working (no 429)
Check that Kong is running the production `kong.yml` (not the local one).
Run `./infra/scripts/redeploy-kong.sh` with `KONG_IP=<ip>`.

### `deploy.sh` exits with "ERROR: PROJECT_ROOT" or empty path
The script must be run from the **project root**, not from inside `infra/`.
```bash
cd /path/to/co3404-distributed-joke-system
./infra/deploy.sh
```

---

## Useful commands

```bash
# Get Kong public IP from Terraform
terraform -chdir=infra/terraform output -raw kong_public_ip

# SSH into a VM
ssh -i ~/.ssh/co3404_key azureuser@<VM_IP>

# View logs for all services on VM1
ssh -i ~/.ssh/co3404_key azureuser@<VM1_IP> \
  'docker compose -f ~/co3404/docker-compose.yml logs --tail=50'

# Check running containers on VM1
ssh -i ~/.ssh/co3404_key azureuser@<VM1_IP> 'docker ps'

# Restart only the joke-service without a full redeploy
ssh -i ~/.ssh/co3404_key azureuser@<VM1_IP> \
  'cd ~/co3404 && docker compose restart joke-service'

# Run smoke tests
./infra/scripts/smoke-test.sh <kong_public_ip>
./infra/scripts/smoke-test.sh <kong_public_ip> --verbose   # show full response bodies
./infra/scripts/smoke-test.sh <kong_public_ip> --http      # skip TLS

# Run DB migration manually (idempotent)
ssh -i ~/.ssh/co3404_key azureuser@<VM1_IP> 'bash ~/co3404/fix-db-index.sh'

# Reload Kong manually (zero-downtime config reload)
KONG_IP=<ip> ./infra/scripts/redeploy-kong.sh
```
