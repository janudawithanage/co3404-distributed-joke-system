# Azure Pending Steps Checklist

> **Status:** Local stack fully validated — 59/59 tests pass.  
> Hosted Azure deployment is frozen at **12 Mar 2026** (commit `16854a0`).  
> All items below require active Azure portal / CLI or SSH access.  
> See `HOSTED_VS_LOCAL_RECOVERY_REPORT.md` for the full drift analysis.

---

## 0. What Is Already Known (no Azure access needed)

These values have been confirmed from Terraform state, env files, and live probing:

| Value | Confirmed Value | Source |
|---|---|---|
| Kong public IP | `85.211.240.162` | `terraform output -raw kong_public_ip` + live probe |
| Kong private IP (VNet) | `10.0.1.6` | Terraform state (`azurerm_network_interface.nic_kong`) |
| VM1 private IP (joke + ETL) | `10.0.1.4` | Terraform variable default; confirmed in vm1 env |
| VM2 private IP (submit + RabbitMQ) | `10.0.1.5` | `infra/.env.vm1` → `RABBITMQ_HOST=10.0.1.5` |
| VM3 private IP (moderate) | `10.0.1.7` | Terraform variable default; confirmed in vm3 env |
| `PUBLIC_GATEWAY_BASE` (VM1 + VM2) | `https://85.211.240.162` | `infra/.env.vm1`, `infra/.env.vm2` |
| `RABBITMQ_HOST` (VM1 + VM3) | `10.0.1.5` | `infra/.env.vm1`, `infra/.env.vm3` |
| Docker Hub username | `janudaw` | `infra/.env.vm1` → `JOKE_IMAGE=janudaw/joke-service:latest` |
| Kong version | `3.9.1` | Live `Server: kong/3.9.1` response header |
| Auth mode on hosted | `unconfigured` | Live `GET /me` response |

### Values still missing (require Azure or Auth0 access)

| Value | Where to Get It |
|---|---|
| VM1 public IP | Azure Portal → VMs → joke-vm → Overview |
| VM2 public IP | Azure Portal → VMs → submit-vm → Overview |
| VM3 public IP | Azure Portal → VMs → moderate-vm → Overview |
| VM1 SSH private key | `~/.ssh/co3404_key` (local machine) or Azure key vault |
| VM2 SSH private key | Same key pair as VM1 |
| VM3 SSH private key | Same key pair as VM1/VM2 |
| RabbitMQ credentials | On VM2 — `cat ~/co3404/.env | grep RABBITMQ` after SSH |
| MySQL credentials | On VM1 — `cat ~/co3404/.env | grep DB_` after SSH |
| Auth0 Client ID | Auth0 Dashboard → Applications → co3404-moderate |
| Auth0 Client Secret | Auth0 Dashboard → Applications → co3404-moderate |
| Auth0 Domain / Issuer URL | Auth0 Dashboard → Applications → co3404-moderate → Domain |
| `AUTH0_SECRET` (32-char random) | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

---

## 1. Stale Deployed Builds — Services That Must Be Redeployed

All four service images are frozen at March 2026. Every change since then is local-only.

| Service | Hosted build date | Image on Docker Hub | What changed locally |
|---|---|---|---|
| `joke-service` | Sat 07 Mar 2026 | `janudaw/joke-service:latest` (stale) | New UI, `/config.js` route, `dbType` in health |
| `submit-service` | Sat 07 Mar 2026 | `janudaw/submit-service:latest` (stale) | New UI, 500-char validation, Swagger IP fix |
| `moderate-service` | Thu 12 Mar 2026 | `janudaw/moderate-service:latest` (stale) | New UI, `/auth-status`, `/moderate-types`, auth banner |
| `etl-service` | Mar 2026 (built from source on VM1) | **Not on Docker Hub** | `INSERT IGNORE`, Mongo guard fix |
| `kong.yml` | Thu 12 Mar 2026 (on Kong VM) | N/A (file, not image) | 5 missing routes added, ip-restriction on /mq-admin |

**Before redeploying:** CI/CD (see section 3) will rebuild and push all images automatically once secrets are set. Manual push is only needed if CI/CD cannot be configured.

---

## 2. GitHub Secrets — Must Be Set Before CI/CD Works


Go to: **Repository → Settings → Secrets and variables → Actions → New repository secret**

> ✅ = value already confirmed, enter as-is.  🔴 = must collect before setting.

| Secret Name | Status | Value / Where to Get It |
|-------------|--------|--------------------------|
| `DOCKER_HUB_USERNAME` | ✅ | `janudaw` |
| `DOCKER_HUB_TOKEN` | 🔴 | Docker Hub → Account Settings → Security → New Access Token |
| `VM1_HOST` | 🔴 | Azure Portal → VMs → joke-vm → Overview → Public IP |
| `VM1_SSH_PRIVATE_KEY` | 🔴 | `cat ~/.ssh/co3404_key` (or whichever key was used for VM1) |
| `VM2_HOST` | 🔴 | Azure Portal → VMs → submit-vm → Overview → Public IP |
| `VM2_SSH_PRIVATE_KEY` | 🔴 | Same key pair as VM1 |
| `VM3_HOST` | 🔴 | Azure Portal → VMs → moderate-vm → Overview → Public IP |
| `VM3_SSH_PRIVATE_KEY` | 🔴 | Same key pair as VM1/VM2 |
| `KONG_VM_HOST` | ✅ | `85.211.240.162` |
| `KONG_VM_SSH_PRIVATE_KEY` | 🔴 | Same key pair — or check `infra/terraform/` for provisioner key path |
| `KONG_PUBLIC_URL` | ✅ | `https://85.211.240.162` |

---

## 3. VM Environment Files — Exact Values to Fill In

> Lines marked ✅ are already filled in the committed file.  Lines marked 🔴 are still `REPLACE_WITH_*` placeholders.

### VM1 (`infra/.env.vm1`) — joke-service + ETL + MySQL
```
DB_ROOT_PASSWORD=<choose a strong password>          # 🔴 set before first docker compose up
DB_NAME=jokesdb
DB_USER=jokesuser
DB_PASSWORD=<choose a strong password>               # 🔴 set before first docker compose up
DB_TYPE=mysql
RABBITMQ_HOST=10.0.1.5                               # ✅ already set
RABBITMQ_USER=<choose>                               # 🔴 set — must match VM2 and VM3
RABBITMQ_PASSWORD=<choose>                           # 🔴 set — must match VM2 and VM3
PUBLIC_GATEWAY_BASE=https://85.211.240.162           # ✅ already set
JOKE_IMAGE=janudaw/joke-service:latest               # ✅ already set
ETL_IMAGE=janudaw/etl-service:latest                 # ✅ already set (build fallback exists)
```

### VM2 (`infra/.env.vm2`) — submit-service + RabbitMQ
```
RABBITMQ_USER=<same as VM1>                          # 🔴 set — must match VM1
RABBITMQ_PASSWORD=<same as VM1>                      # 🔴 set — must match VM1
PUBLIC_GATEWAY_BASE=https://85.211.240.162           # ✅ already set
SUBMIT_IMAGE=janudaw/submit-service:latest           # ✅ already set
```

### VM3 (`infra/.env.vm3`) — moderate-service (Auth0 required)
```
AUTH_ENABLED=true
AUTH0_BASE_URL=https://85.211.240.162                # ✅ (confirm after Kong is live)
AUTH0_CLIENT_ID=<from Auth0 Application>             # 🔴 collect from Auth0 dashboard
AUTH0_CLIENT_SECRET=<from Auth0 Application>         # 🔴 collect from Auth0 dashboard
AUTH0_ISSUER_BASE_URL=https://<tenant>.auth0.com     # 🔴 collect from Auth0 dashboard
AUTH0_AUDIENCE=<your Auth0 API Identifier>           # 🔴 or leave blank if not using RBAC
AUTH0_SECRET=<generate below>                        # 🔴 generate fresh
RABBITMQ_HOST=10.0.1.5                               # ✅ already set
RABBITMQ_USER=<same as VM1>                          # 🔴 set — must match VM1/VM2
RABBITMQ_PASSWORD=<same as VM1>                      # 🔴 set — must match VM1/VM2
DOCKER_IMAGE=janudaw/moderate-service:latest         # ✅ already set
```

Generate `AUTH0_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 4. Auth0 Setup

### 4a. Create Application
1. Auth0 Dashboard → **Applications → Create Application**
2. Type: **Regular Web Application**
3. Name: `co3404-moderate`
4. Note the **Domain**, **Client ID**, **Client Secret** — these go into VM3 `.env`

### 4b. Configure Allowed URLs
In the Application settings:

| Setting | Value |
|---------|-------|
| Allowed Callback URLs | `https://85.211.240.162/callback` |
| Allowed Logout URLs | `https://85.211.240.162` |
| Allowed Web Origins | `https://85.211.240.162` |

### 4c. Create API (optional — for RBAC)
If using `AUTH0_AUDIENCE`:
1. Auth0 Dashboard → **APIs → Create API**
2. Identifier: e.g. `https://co3404-jokes-api`
3. Set `AUTH0_AUDIENCE` in VM3 `.env` to this value

### 4d. Assign Moderator Role (optional)
If `MODERATOR_ROLE` is enforced in `moderate-service/auth.js`:
1. Auth0 Dashboard → **User Management → Roles → Create Role** → `moderator`
2. Assign the role to each moderator user

---

## 5. Terraform (Kong VM only)

> **Important:** Only the **Kong VM** (`10.0.1.6` / `85.211.240.162`) is managed by Terraform.  
> VM1, VM2, VM3 were provisioned **manually** (not in Terraform state) and must be managed via SSH / Azure Portal directly.

If you need to **re-provision the Kong VM** (e.g. after deallocation):
```bash
cd infra/terraform

# Copy and fill in variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars: set subscription_id, my_ip, etc.
# Kong public IP is already known: 85.211.240.162

# Initialise
terraform init

# Check state first — Kong VM may already exist
terraform state list

# Plan — should show no changes if Kong VM is already running
terraform plan

# Apply only if Kong VM needs reprovisioning
terraform apply

# Confirm Kong IP
terraform output -raw kong_public_ip   # expect: 85.211.240.162
```

The `kong.yml` Terraform generates uses `kong.yml.tpl` — already reviewed and correct.

---

## 6. Initial VM Setup

Run the setup scripts from your local machine (or Azure Cloud Shell):

```bash
# VM1
scp infra/vm1-setup.sh azureuser@<VM1_PUBLIC_IP>:~/
scp infra/vm1-compose.yml azureuser@<VM1_PUBLIC_IP>:~/
ssh azureuser@<VM1_PUBLIC_IP> "bash ~/vm1-setup.sh"

# VM2
scp infra/vm2-setup.sh azureuser@<VM2_PUBLIC_IP>:~/
scp infra/vm2-compose.yml azureuser@<VM2_PUBLIC_IP>:~/
ssh azureuser@<VM2_PUBLIC_IP> "bash ~/vm2-setup.sh"

# VM3
scp infra/vm3-setup.sh azureuser@<VM3_PUBLIC_IP>:~/
scp infra/vm3-compose.yml azureuser@<VM3_PUBLIC_IP>:~/
ssh azureuser@<VM3_PUBLIC_IP> "bash ~/vm3-setup.sh"
```

After setup, copy env files and start services:
```bash
# Example for VM1:
scp infra/.env.vm1 azureuser@<VM1_PUBLIC_IP>:~/.env
ssh azureuser@<VM1_PUBLIC_IP> "cd ~ && docker compose up -d"
```

---

## 7. NSG Rules to Verify

In Azure Portal → Network Security Groups, verify these inbound rules exist:

| VM | Port | Description |
|----|------|-------------|
| VM1 | TCP 3000 | joke-service REST API |
| VM1 | TCP 3001 | etl-service (Kong health check) |
| VM2 | TCP 5672 | RabbitMQ AMQP (from VM1 and VM3 private IPs only) |
| VM2 | TCP 15672 | RabbitMQ Management (from Kong/admin IPs only) |
| VM3 | TCP 3300 | moderate-service |
| VM4 | TCP 80 | Kong HTTP |
| VM4 | TCP 443 | Kong HTTPS (if TLS configured) |
| VM4 | TCP 22 | SSH (restrict to your IP) |

> **Security note:** RabbitMQ ports (5672, 15672) should NOT be open to `0.0.0.0/0`.  
> Restrict them to VM1 and VM3 private IPs (`10.0.1.4/32`, `10.0.1.7/32`).

---

## 8. Docker Hub — Push Images

Before first deployment (or after any code change before CI/CD is wired up):

```bash
# Build and push all four images manually
DHUB=<DOCKER_HUB_USERNAME>

docker build -t $DHUB/joke-service:latest    joke-service/   && docker push $DHUB/joke-service:latest
docker build -t $DHUB/submit-service:latest  submit-service/ && docker push $DHUB/submit-service:latest
docker build -t $DHUB/moderate-service:latest moderate-service/ && docker push $DHUB/moderate-service:latest
docker build -t $DHUB/etl-service:latest     etl-service/    && docker push $DHUB/etl-service:latest
```

---

## 9. Kong Deployment to Kong VM (`85.211.240.162`)

Kong is already running. This step is only needed if Kong config must be **reloaded** with the new `kong.yml`.

The CI/CD workflow (`deploy-kong.yml`) will do this automatically when `infra/kong/kong.yml` is pushed.  
To trigger manually:

```bash
# Option A: use CI/CD workflow_dispatch from GitHub Actions UI
# (deploy-kong.yml supports workflow_dispatch)

# Option B: push a trivial change to infra/kong/kong.yml to trigger the workflow
git commit --allow-empty -m "ci: reload kong config" && git push

# Option C: manual SSH deploy (if CI/CD not yet configured)
scp infra/kong/kong.yml azureuser@85.211.240.162:~/kong/kong.yml
scp infra/kong/docker-compose.yml azureuser@85.211.240.162:~/
ssh azureuser@85.211.240.162 "cd ~/kong && docker compose down && docker compose up -d"

# Verify
curl -k https://85.211.240.162/health
```

---

## 10. Post-Deployment Smoke Test

Kong IP is known. VM1/VM2/VM3 public IPs must be filled in from Azure Portal.

```bash
# Kong IP is confirmed — run Kong-level smoke test immediately:
bash infra/scripts/smoke-test.sh 85.211.240.162
```

Full test suite (once VM public IPs are known):
```bash
KONG=https://85.211.240.162 \
JOKE=http://<VM1_PUBLIC_IP>:3000 \
SUBM=http://<VM2_PUBLIC_IP>:3200 \
MODR=http://<VM3_PUBLIC_IP>:3300 \
ETL=http://<VM1_PUBLIC_IP>:3001 \
node test-flows.js
```

Expected health check responses after redeploy:

| Endpoint | Expected |
|----------|----------|
| `GET /health` (via Kong) | `{"status":"ok","dbType":"mysql"}` |
| `GET /auth-status` (via Kong) | `{"authEnabled":true,"mode":"oidc"}` |
| `GET /mq-admin/` (via Kong) | `403 Forbidden` (ip-restriction) |

---

## 11. CI/CD — Verify Workflows

Each workflow is **path-scoped** and only triggers on changes to its own directory:

| Workflow | Trigger path | Deploys to |
|----------|-------------|------------|
| `deploy-joke.yml` | `joke-service/**` | VM1 |
| `deploy-submit.yml` | `submit-service/**` | VM2 |
| `deploy-moderate.yml` | `moderate-service/**` | VM3 |
| `deploy-etl.yml` | `etl-service/**` | VM1 |
| `deploy-kong.yml` | `infra/kong/kong.yml`, `infra/kong/docker-compose.yml` + `workflow_dispatch` | Kong VM |

All five service directories already have local changes ahead of the hosted build, so **any push to `main`** will trigger all four service deploys simultaneously. Kong must also be reloaded after services are up.

After setting all GitHub Secrets (step 2), push to trigger all deploys:

```bash
# A normal push will trigger all path-scoped workflows automatically
git push origin main

# Kong workflow: trigger via GitHub Actions UI (workflow_dispatch)
# or push a whitespace change to infra/kong/kong.yml
```

Expected: `deploy-joke`, `deploy-submit`, `deploy-moderate`, `deploy-etl`, and `deploy-kong` all pass green.

---

## 12. Exact Redeploy Order (once Azure access returns)

Follow these steps **in order**. Do not proceed to the next step until the current one passes.

### Step 1 — Collect required values
- [ ] SSH into VM2: `cat ~/co3404/.env | grep RABBITMQ` → note `RABBITMQ_USER`, `RABBITMQ_PASSWORD`
- [ ] SSH into VM1: `cat ~/co3404/.env | grep DB_` → note `DB_ROOT_PASSWORD`, `DB_PASSWORD`
- [ ] Azure Portal → get VM1, VM2, VM3 public IPs
- [ ] Locate SSH private key (`~/.ssh/co3404_key` or equivalent)
- [ ] Auth0 Dashboard → co3404-moderate application → note Client ID, Client Secret, Domain
- [ ] Docker Hub → generate new access token (Settings → Security → New Token)
- [ ] Generate `AUTH0_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### Step 2 — Fill in env files
- [ ] Update `infra/.env.vm1`: fill in `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `DB_ROOT_PASSWORD`, `DB_PASSWORD`
- [ ] Update `infra/.env.vm2`: fill in `RABBITMQ_USER`, `RABBITMQ_PASSWORD`
- [ ] Update `infra/.env.vm3`: fill in all `REPLACE_WITH_*` placeholders (Auth0 + RabbitMQ credentials)
- [ ] SCP updated env files to each VM:
  ```bash
  scp infra/.env.vm1 azureuser@<VM1_PUBLIC_IP>:~/.env
  scp infra/.env.vm2 azureuser@<VM2_PUBLIC_IP>:~/.env
  scp infra/.env.vm3 azureuser@<VM3_PUBLIC_IP>:~/.env
  ```

### Step 3 — Set all 11 GitHub Secrets
- [ ] Repository → Settings → Secrets and variables → Actions
- [ ] Set each secret from the table in Section 2 (3 are pre-filled: `DOCKER_HUB_USERNAME`, `KONG_VM_HOST`, `KONG_PUBLIC_URL`)

### Step 4 — Push to main (triggers all service deploys)
```bash
git push origin main
```
This will trigger `deploy-joke`, `deploy-submit`, `deploy-moderate`, `deploy-etl` simultaneously.

### Step 5 — Trigger Kong config reload
After all four service workflows pass green:
```bash
# Via GitHub Actions UI: manually trigger deploy-kong workflow (workflow_dispatch)
# OR:
git commit --allow-empty -m "ci: reload kong config" -- infra/kong/kong.yml && git push
```
> Kong health check in `deploy-kong.yml` waits up to 30s for `/health` to return 200 — ensure services are up first.

### Step 6 — Smoke test
```bash
bash infra/scripts/smoke-test.sh 85.211.240.162
```

### Step 7 — Verify security posture
```bash
# RabbitMQ admin must be blocked by ip-restriction plugin:
curl -k https://85.211.240.162/mq-admin/    # expect: 403

# Auth0 should be active on moderate-service:
curl -k https://85.211.240.162/auth-status  # expect: {"authEnabled":true,"mode":"oidc"}
```

---

## Summary Checklist

### Pre-filled (no action needed) ✅
- [x] Kong public IP confirmed: `85.211.240.162`
- [x] All private VNet IPs confirmed: VM1=`10.0.1.4`, VM2=`10.0.1.5`, VM3=`10.0.1.7`, Kong=`10.0.1.6`
- [x] `PUBLIC_GATEWAY_BASE`, `RABBITMQ_HOST`, all three Docker image names already set in env files
- [x] Kong is running on `85.211.240.162` (verified live)
- [x] `DOCKER_HUB_USERNAME=janudaw`, `KONG_VM_HOST=85.211.240.162`, `KONG_PUBLIC_URL=https://85.211.240.162` pre-filled for GitHub Secrets
- [x] Auth0 callback URLs updated to `https://85.211.240.162`

### Must collect (requires Azure / Auth0 access) 🔴
- [ ] VM1 public IP (Azure Portal)
- [ ] VM2 public IP (Azure Portal)
- [ ] VM3 public IP (Azure Portal)
- [ ] SSH private key for all VMs (`~/.ssh/co3404_key`)
- [ ] `RABBITMQ_USER` and `RABBITMQ_PASSWORD` (SSH into VM2 to retrieve)
- [ ] `DB_ROOT_PASSWORD` and `DB_PASSWORD` (SSH into VM1 to retrieve)
- [ ] Auth0 Client ID, Client Secret, Domain (Auth0 dashboard)
- [ ] `AUTH0_SECRET` (generate fresh: `node -e "..."`)
- [ ] Docker Hub access token (Docker Hub → Account Settings → Security)

### Actions (once values collected, in order) 🔴
- [ ] Fill in remaining `REPLACE_WITH_*` in `infra/.env.vm1`, `.env.vm2`, `.env.vm3`
- [ ] SCP updated env files to each VM
- [ ] Set all 11 GitHub Secrets (see Section 2)
- [ ] `git push origin main` — triggers all four service deploy workflows
- [ ] Trigger `deploy-kong.yml` via `workflow_dispatch` (GitHub Actions UI)
- [ ] Verify NSG rules (Section 7)
- [ ] Run smoke test: `bash infra/scripts/smoke-test.sh 85.211.240.162`
- [ ] Verify: `curl -k https://85.211.240.162/mq-admin/` → `403`
- [ ] Verify: `curl -k https://85.211.240.162/auth-status` → `{"authEnabled":true}`
