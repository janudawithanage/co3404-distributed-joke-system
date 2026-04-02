# Azure Pending Steps Checklist

> **Status:** Local stack fully validated — 59/59 tests pass.  
> All items below require active Azure portal / CLI access.

---

## 1. Infrastructure — Azure Values Needed

| Value | How to Obtain | Used In |
|-------|--------------|---------|
| `VM1_PUBLIC_IP` | Azure Portal → VMs → joke-vm → Overview | GitHub Secrets, smoke-test.sh |
| `VM2_PUBLIC_IP` | Azure Portal → VMs → submit-vm → Overview | GitHub Secrets, smoke-test.sh |
| `VM3_PUBLIC_IP` | Azure Portal → VMs → moderate-vm → Overview | GitHub Secrets |
| `VM4_PUBLIC_IP` (Kong) | `terraform output -raw kong_public_ip` OR Azure Portal → kong-vm | All env files, Auth0 config |
| `VM2_PRIVATE_IP` | Azure Portal → submit-vm → Networking (usually `10.0.1.5`) | `RABBITMQ_HOST` in vm1 + vm3 `.env` |

---

## 2. GitHub Secrets — Must Be Set Before CI/CD Works

Go to: **Repository → Settings → Secrets and variables → Actions → New repository secret**

| Secret Name | Value |
|-------------|-------|
| `DOCKER_HUB_USERNAME` | Your Docker Hub username |
| `DOCKER_HUB_TOKEN` | Docker Hub → Account Settings → Security → New Access Token |
| `VM1_HOST` | `VM1_PUBLIC_IP` (from step 1) |
| `VM1_SSH_PRIVATE_KEY` | Contents of `~/.ssh/id_rsa` (or Azure-generated key) for VM1 |
| `VM2_HOST` | `VM2_PUBLIC_IP` (from step 1) |
| `VM2_SSH_PRIVATE_KEY` | Contents of SSH private key for VM2 |
| `VM3_HOST` | `VM3_PUBLIC_IP` (from step 1) |
| `VM3_SSH_PRIVATE_KEY` | Contents of SSH private key for VM3 |
| `KONG_VM_HOST` | `VM4_PUBLIC_IP` (Kong VM, from step 1) |
| `KONG_VM_SSH_PRIVATE_KEY` | Contents of SSH private key for Kong VM |
| `KONG_PUBLIC_URL` | `http://<VM4_PUBLIC_IP>` (or `https://` if TLS set up) |

---

## 3. VM Environment Files — Exact Values to Fill In

### VM1 (`infra/.env.vm1`) — joke-service + ETL + MySQL
```
DB_ROOT_PASSWORD=<choose a strong password>
DB_NAME=jokesdb
DB_USER=jokesuser
DB_PASSWORD=<choose a strong password>
DB_TYPE=mysql
RABBITMQ_HOST=<VM2_PRIVATE_IP>       # e.g. 10.0.1.5
RABBITMQ_USER=<choose>
RABBITMQ_PASSWORD=<choose>
PUBLIC_GATEWAY_BASE=http://<VM4_PUBLIC_IP>
JOKE_IMAGE=<DOCKER_HUB_USERNAME>/joke-service:latest
ETL_IMAGE=<DOCKER_HUB_USERNAME>/etl-service:latest
```

### VM2 (`infra/.env.vm2`) — submit-service + RabbitMQ
```
RABBITMQ_USER=<same as VM1>
RABBITMQ_PASSWORD=<same as VM1>
PUBLIC_GATEWAY_BASE=http://<VM4_PUBLIC_IP>
SUBMIT_IMAGE=<DOCKER_HUB_USERNAME>/submit-service:latest
```

### VM3 (`infra/.env.vm3`) — moderate-service (Auth0 required)
```
AUTH_ENABLED=true
AUTH0_CLIENT_ID=<from Auth0 Application>
AUTH0_CLIENT_SECRET=<from Auth0 Application>
AUTH0_ISSUER_BASE_URL=https://<your-auth0-tenant>.auth0.com
AUTH0_AUDIENCE=<your Auth0 API Identifier, or leave blank>
AUTH0_SECRET=<generate: openssl rand -hex 32>
RABBITMQ_HOST=<VM2_PRIVATE_IP>
RABBITMQ_USER=<same as VM1>
RABBITMQ_PASSWORD=<same as VM1>
PUBLIC_GATEWAY_BASE=http://<VM4_PUBLIC_IP>
MODERATE_IMAGE=<DOCKER_HUB_USERNAME>/moderate-service:latest
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
| Allowed Callback URLs | `http://<VM4_PUBLIC_IP>/callback` |
| Allowed Logout URLs | `http://<VM4_PUBLIC_IP>` |
| Allowed Web Origins | `http://<VM4_PUBLIC_IP>` |

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

## 5. Terraform (Kong VM4)

```bash
cd infra/terraform

# Copy and fill in variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars: set subscription_id, resource_group, admin_username, etc.

# Initialise
terraform init

# Plan
terraform plan

# Apply — provisions VM4, generates kong.yml from template
terraform apply

# Get Kong public IP
terraform output -raw kong_public_ip
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

## 9. Kong Deployment to VM4

After Terraform provisions VM4:

```bash
# Copy generated kong.yml and certs to Kong VM
scp infra/kong/kong.yml azureuser@<VM4_PUBLIC_IP>:~/kong.yml
scp infra/kong/docker-compose.yml azureuser@<VM4_PUBLIC_IP>:~/

# Start Kong
ssh azureuser@<VM4_PUBLIC_IP> "docker compose up -d"

# Verify
curl http://<VM4_PUBLIC_IP>/health
```

---

## 10. Post-Deployment Smoke Test

Update `infra/scripts/smoke-test.sh` with real IPs, then run:

```bash
# Edit KONG_URL, VM1_URL, VM2_URL, VM3_URL in smoke-test.sh
KONG_URL=http://<VM4_PUBLIC_IP> bash infra/scripts/smoke-test.sh
```

Or run the full test suite against the deployed stack:
```bash
KONG=http://<VM4_PUBLIC_IP> \
JOKE=http://<VM1_PUBLIC_IP>:3000 \
SUBM=http://<VM2_PUBLIC_IP>:3200 \
MODR=http://<VM3_PUBLIC_IP>:3300 \
ETL=http://<VM1_PUBLIC_IP>:3001 \
node test-flows.js
```

---

## 11. CI/CD — Verify Workflows

After setting all GitHub Secrets (step 2), trigger a test run:

```bash
# Push a no-op change to main to trigger all deploy workflows
git commit --allow-empty -m "ci: trigger deploy workflows" && git push
```

Expected: all four deploy workflows (`deploy-joke`, `deploy-submit`, `deploy-etl`, `deploy-kong`) should pass.

---

## Summary Checklist

- [ ] Note VM1, VM2, VM3, VM4 public IPs from Azure Portal
- [ ] Note VM2 private IP
- [ ] Run `terraform apply` for Kong VM4
- [ ] Set all 11 GitHub Secrets
- [ ] Fill in `infra/.env.vm1`, `.env.vm2`, `.env.vm3` with real values
- [ ] Create Auth0 Application, configure callback URLs
- [ ] Run vm1/vm2/vm3 setup scripts
- [ ] Push Docker images to Docker Hub (or let CI/CD do it)
- [ ] Deploy Kong to VM4
- [ ] Verify NSG rules
- [ ] Run smoke test against live stack
- [ ] Enable CI/CD by triggering a push to `main`
