# CO3404 Distributed Systems – Phase 2: Azure Deployment

## Architecture Overview

```
Your Mac (SSH)
     │
     ├── ssh → VM1 (joke-vm)  B2s  10.0.1.4  ── Public IP (SSH + port 3001)
     │              ├── joke-service   :3001
     │              ├── etl-service    (internal)
     │              └── mysql          (internal)
     │
     └── ssh → VM2 (submit-vm) B1s  10.0.1.5  ── Public IP (SSH + port 3002)
                    ├── submit-service :3002
                    └── rabbitmq       :5672 (VNet only) / :15672 (your IP only)

Cross-VM traffic uses private IPs inside the Azure VNet — never leaves Azure.
```

---

## Step 1 — Azure Portal: Resource Group

1. Portal → **Resource groups** → **Create**
2. **Subscription**: your student subscription
3. **Resource group**: `rg-co3404-jokes`
4. **Region**: `UK South` (closest to most UK universities, cheap)
5. Click **Review + create** → **Create**

---

## Step 2 — Azure Portal: Virtual Network

1. Portal → search **Virtual networks** → **Create**
2. **Basics tab**:
   - Resource group: `rg-co3404-jokes`
   - Name: `vnet-jokes`
   - Region: `UK South`
3. **IP Addresses tab**:
   - IPv4 address space: `10.0.0.0/16`
   - Delete the default subnet, then **Add subnet**:
     - Name: `snet-jokes`
     - Starting address: `10.0.1.0`
     - Size: `/24` (gives 251 usable hosts)
4. Click **Review + create** → **Create**

---

## Step 3 — Generate SSH Key Pair (on your Mac)

```bash
# Run once — generates ~/.ssh/co3404_key and ~/.ssh/co3404_key.pub
ssh-keygen -t ed25519 -f ~/.ssh/co3404_key -C "co3404-azure"

# Print the public key — you will paste this into the Azure VM form
cat ~/.ssh/co3404_key.pub
```

---

## Step 4 — Azure Portal: Create VM1 (joke-vm)

1. Portal → **Virtual machines** → **Create** → **Azure virtual machine**

### Basics tab
| Field | Value |
|---|---|
| Resource group | `rg-co3404-jokes` |
| Virtual machine name | `vm-joke` |
| Region | `UK South` |
| Availability options | No infrastructure redundancy required |
| Image | **Ubuntu Server 22.04 LTS** (x64) |
| Size | **Standard_B2s** (2 vCPU, 4 GiB) |
| Authentication type | SSH public key |
| Username | `azureuser` |
| SSH public key source | Use existing public key |
| SSH public key | _(paste contents of `~/.ssh/co3404_key.pub`)_ |

### Disks tab
- OS disk type: **Standard SSD** (saves credits vs Premium SSD)

### Networking tab
| Field | Value |
|---|---|
| Virtual network | `vnet-jokes` |
| Subnet | `snet-jokes` |
| Public IP | Create new → name `pip-joke` |
| NIC network security group | **Advanced** → Create new → name `nsg-joke` |
| Public inbound ports | None (we configure NSG manually) |

2. Click **Review + create** → **Create**

---

## Step 5 — Azure Portal: Create VM2 (submit-vm)

Repeat Step 4 with these differences:

| Field | Value |
|---|---|
| Virtual machine name | `vm-submit` |
| Size | **Standard_B1s** (1 vCPU, 1 GiB) |
| Public IP | Create new → name `pip-submit` |
| NIC NSG | Advanced → Create new → name `nsg-submit` |

---

## Step 6 — Get Private IP Addresses

After both VMs are created:

1. Portal → **vm-joke** → **Networking** → note the **Private IP address** (e.g. `10.0.1.4`)
2. Portal → **vm-submit** → **Networking** → note the **Private IP address** (e.g. `10.0.1.5`)

> Azure assigns private IPs starting from `.4` in the subnet.
> VM1 is typically `10.0.1.4`, VM2 is `10.0.1.5`. Confirm in the portal.

---

## Step 7 — Configure NSG Rules

### NSG for VM1 (nsg-joke)

Portal → **nsg-joke** → **Inbound security rules**

Add these rules:

| Priority | Name | Port | Protocol | Source | Action |
|---|---|---|---|---|---|
| 300 | Allow-SSH | 22 | TCP | **My IP address** | Allow |
| 310 | Allow-JokeAPI | 3001 | TCP | Any | Allow |
| 4096 | Deny-All | Any | Any | Any | Deny |

> The Deny-All rule blocks everything not explicitly allowed.
> MySQL (3306) and ETL (3003) have NO inbound rule → blocked by default.

### NSG for VM2 (nsg-submit)

Portal → **nsg-submit** → **Inbound security rules**

| Priority | Name | Port | Protocol | Source | Action |
|---|---|---|---|---|---|
| 300 | Allow-SSH | 22 | TCP | **My IP address** | Allow |
| 310 | Allow-SubmitAPI | 3002 | TCP | Any | Allow |
| 320 | Allow-RabbitMQ-Management | 15672 | TCP | **My IP address** | Allow |
| 330 | Allow-AMQP-VNet | 5672 | TCP | **VirtualNetwork** (service tag) | Allow |
| 4096 | Deny-All | Any | Any | Any | Deny |

> Rule 330 uses the `VirtualNetwork` service tag — this allows 5672 from
> any resource inside the VNet (i.e. VM1's ETL service) but NOT from the internet.

---

## Step 8 — Install Docker on Both VMs

Copy the setup scripts to each VM, then run them.

```bash
# From your Mac (project root)

# VM1
scp -i ~/.ssh/co3404_key infra/vm1-setup.sh azureuser@<VM1_PUBLIC_IP>:~/
ssh -i ~/.ssh/co3404_key azureuser@<VM1_PUBLIC_IP> "bash ~/vm1-setup.sh"

# VM2
scp -i ~/.ssh/co3404_key infra/vm2-setup.sh azureuser@<VM2_PUBLIC_IP>:~/
ssh -i ~/.ssh/co3404_key azureuser@<VM2_PUBLIC_IP> "bash ~/vm2-setup.sh"
```

Log out and back in on each VM after the script finishes so the `docker` group takes effect:
```bash
exit
ssh -i ~/.ssh/co3404_key azureuser@<VM_PUBLIC_IP>
```

---

## Step 9 — Prepare Environment Files (on your Mac)

```bash
# From project root

# VM1 .env
cp infra/.env.vm1.example infra/.env.vm1
# Edit and replace REPLACE_WITH_VM2_PRIVATE_IP with the actual value (e.g. 10.0.1.5)
nano infra/.env.vm1

# VM2 .env
cp infra/.env.vm2.example infra/.env.vm2
# Edit and replace REPLACE_WITH_VM1_PRIVATE_IP with the actual value (e.g. 10.0.1.4)
nano infra/.env.vm2
```

---

## Step 10 — Deploy Project Files to Azure VMs

Edit `infra/deploy.sh` and fill in your VM public IPs and SSH key path, then:

```bash
chmod +x infra/deploy.sh
./infra/deploy.sh
```

This copies:
- VM1: `joke-service/`, `etl-service/`, `db/`, `vm1-compose.yml` (as `docker-compose.yml`), `.env.vm1` (as `.env`)
- VM2: `submit-service/`, `vm2-compose.yml` (as `docker-compose.yml`), `.env.vm2` (as `.env`)

---

## Step 11 — Start Services

### Start VM1 first (MySQL must be ready before ETL connects)

```bash
ssh -i ~/.ssh/co3404_key azureuser@<VM1_PUBLIC_IP>

cd ~/co3404
docker compose up -d --build

# Watch startup logs — wait until MySQL healthcheck passes
docker compose logs -f
# Look for: [Joke Service] Listening on http://localhost:3001
# Ctrl+C to exit log tail
```

### Then start VM2

```bash
ssh -i ~/.ssh/co3404_key azureuser@<VM2_PUBLIC_IP>

cd ~/co3404
docker compose up -d --build

docker compose logs -f
# Look for: [Submit Service] Listening on http://localhost:3002
```

---

## Step 12 — Verify the System

### Basic health checks

```bash
# From your Mac — replace with actual public IPs

# Joke service
curl http://<VM1_PUBLIC_IP>:3001/health
# => {"status":"ok","service":"joke-service"}

# Joke types
curl http://<VM1_PUBLIC_IP>:3001/types

# Submit service
curl http://<VM2_PUBLIC_IP>:3002/health

# Get a random joke
curl "http://<VM1_PUBLIC_IP>:3001/joke/any"
```

### Test RabbitMQ management UI

Open in browser: `http://<VM2_PUBLIC_IP>:15672`  
Login: `guest` / `guest`  
Go to **Queues** → confirm `jokes_queue` exists.

### Test private networking between VMs

SSH into VM1 and ping VM2's private IP:
```bash
ssh -i ~/.ssh/co3404_key azureuser@<VM1_PUBLIC_IP>
ping -c 3 10.0.1.5          # should succeed (same VNet)
curl http://10.0.1.5:5672   # RabbitMQ AMQP port — should respond
```

SSH into VM2 and reach Joke service on VM1:
```bash
ssh -i ~/.ssh/co3404_key azureuser@<VM2_PUBLIC_IP>
curl http://10.0.1.4:3001/types   # should return joke types array
```

### Submit a joke end-to-end

```bash
curl -X POST http://<VM2_PUBLIC_IP>:3002/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Why do Azure VMs never get lost?","punchline":"Because they always follow the VNet!","type":"programming"}'
# => 202 {"message":"Joke queued for processing..."}
```

Immediately check RabbitMQ UI — **Messages Ready** on `jokes_queue` should briefly show **1**, then drop to 0 as ETL processes it.

Then confirm the joke is in the database:
```bash
ssh -i ~/.ssh/co3404_key azureuser@<VM1_PUBLIC_IP>
docker exec -it jokes_mysql mysql -u jokeuser -pjokepassword jokesdb \
  -e "SELECT j.setup, j.punchline, t.name FROM jokes j JOIN types t ON j.type_id=t.id ORDER BY j.id DESC LIMIT 3;"
```

---

## Step 13 — Resilience Demonstration

### Stop the Joke service — Submit must still work

```bash
# SSH into VM1
ssh -i ~/.ssh/co3404_key azureuser@<VM1_PUBLIC_IP>
cd ~/co3404

# Stop just the joke-service container
docker compose stop joke-service

# Confirm it's stopped
docker compose ps
```

From your Mac, submit a joke — it must still return 202:
```bash
curl -X POST http://<VM2_PUBLIC_IP>:3002/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Test while joke is down","punchline":"Still works!","type":"general"}'
```

Check RabbitMQ UI — message is queued.

Now restart the Joke service:
```bash
# On VM1
docker compose start joke-service

# Watch ETL drain the queue
docker compose logs -f etl-service
# => [ETL] Connected to RabbitMQ
# => [ETL] Inserted joke (type: general): ...
```

Confirm via the Joke frontend: `http://<VM1_PUBLIC_IP>:3001`

---

## Step 14 — Verify Persistence

### MySQL data survives container restart

```bash
# On VM1
docker compose restart mysql
# Wait ~30 seconds for healthcheck to pass

# Jokes are still there:
docker exec -it jokes_mysql mysql -u jokeuser -pjokepassword jokesdb \
  -e "SELECT COUNT(*) FROM jokes;"
```

### RabbitMQ queue survives restart (durable + persistent messages)

```bash
# On VM2 — submit a joke but stop ETL first (stop it on VM1)
# On VM1:
docker compose stop etl-service

# On Mac: submit a joke
curl -X POST http://<VM2_PUBLIC_IP>:3002/submit \
  -H "Content-Type: application/json" \
  -d '{"setup":"Persistence test","punchline":"Message survives!","type":"dad"}'

# On VM2 — restart RabbitMQ
docker compose restart rabbitmq

# Check RabbitMQ UI — message is STILL in the queue (persistent: true)

# Restart ETL on VM1 — it drains the queue
docker compose start etl-service
```

---

## Step 15 — VM Auto-Restart on Reboot

All containers have `restart: unless-stopped` in the compose files.  
Docker itself is enabled as a systemd service in the setup scripts.

Test it:
```bash
# On VM1
sudo reboot
# Wait 2 minutes, then SSH back in
ssh -i ~/.ssh/co3404_key azureuser@<VM1_PUBLIC_IP>
docker ps   # all containers should be running automatically
```

---

## Step 16 — Cost-Saving Best Practices

### Deallocate VMs when not using them
"Stopped" VMs in Azure still incur **compute charges**.  
"Deallocated" VMs do NOT (you only pay for the disk).

```bash
# Azure CLI — install once on your Mac: brew install azure-cli
az login

# Deallocate both VMs
az vm deallocate --resource-group rg-co3404-jokes --name vm-joke
az vm deallocate --resource-group rg-co3404-jokes --name vm-submit

# Start them again before a demo
az vm start --resource-group rg-co3404-jokes --name vm-joke
az vm start --resource-group rg-co3404-jokes --name vm-submit
```

> After deallocating, the public IP changes if it is dynamic.
> To get the new IP: `az vm show -g rg-co3404-jokes -n vm-joke --show-details --query publicIps`

### Use Static Public IPs to avoid changing IPs
Portal → pip-joke → Configuration → Assignment: **Static**  
(Costs ~£2.50/month but saves confusion. Free while VM is running.)

### Set a budget alert
Portal → Subscriptions → Cost alerts → Add budget: £30/month  
Set alerts at 80% and 100%.

### VM sizing
- VM1 B2s: sufficient for MySQL + 2 Node services (~£25/month if running 24/7)
- VM2 B1s: minimal, sufficient for Submit + RabbitMQ (~£7/month if running 24/7)
- Combined if running 24/7 = ~£32/month — deallocate overnight to stay within student credits

### Delete everything when done with the assignment
```bash
az group delete --name rg-co3404-jokes --yes --no-wait
```
This deletes VMs, NICs, public IPs, NSGs, disks, and the VNet in one command.

---

## Troubleshooting

### ETL cannot connect to RabbitMQ on VM2
```bash
# On VM1 — check ETL logs
docker compose logs etl-service

# Verify RABBITMQ_HOST is set correctly
docker compose exec etl-service printenv RABBITMQ_HOST
# Should show VM2's private IP e.g. 10.0.1.5

# Test TCP connectivity from VM1 to VM2 port 5672
nc -zv 10.0.1.5 5672
# "succeeded" = network is open; check NSG rule 330 if it fails
```

### Submit /types returns 503 (no cache)
```bash
# On VM2 — check the submit service can reach VM1
docker compose exec submit-service wget -qO- http://10.0.1.4:3001/types
# If this fails, check VM1's NSG allows port 3001 from VirtualNetwork
```

### Container won't start
```bash
docker compose logs <service-name>    # see the error
docker compose down && docker compose up -d --build   # full rebuild
```

### MySQL healthcheck keeps failing
```bash
# Give it more time on first boot — init.sql takes ~20s to run
docker compose logs mysql
# Look for "ready for connections" message
```

### SSH connection refused
- Confirm the VM is in **Running** state (not deallocated)
- Confirm NSG allows TCP 22 from **your current IP** (home vs university may differ — update the NSG rule)
- Your public IP: `curl ifconfig.me`

---

## File Reference

| File | Purpose |
|---|---|
| `infra/vm1-compose.yml` | Docker Compose for VM1 (joke + etl + mysql) |
| `infra/vm2-compose.yml` | Docker Compose for VM2 (submit + rabbitmq) |
| `infra/vm1-setup.sh` | Bootstrap script — installs Docker on VM1 |
| `infra/vm2-setup.sh` | Bootstrap script — installs Docker on VM2 |
| `infra/deploy.sh` | Copies files from Mac to both VMs via scp |
| `infra/.env.vm1.example` | Template env file for VM1 |
| `infra/.env.vm2.example` | Template env file for VM2 |
