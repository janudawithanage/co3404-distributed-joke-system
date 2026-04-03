# Known Limitations

## Azure Deployment Uptime

The Azure VMs (VM1–VM4) are hosted on a student subscription and may be deallocated at any point. There is no guarantee of uptime between submission and marking.

**If the Azure environment is unavailable:**
- All features work fully in local Docker (`docker compose up -d`)
- Run `node test-flows.js` for evidence of a working, tested system
- See [DEPLOYMENT.md](DEPLOYMENT.md) to re-provision the environment from scratch with Terraform

**To check / restart the Azure environment:**
```bash
# Get current Kong IP
terraform -chdir=infra/terraform output -raw kong_public_ip

# Run smoke test against Azure
./infra/scripts/smoke-test.sh <kong_public_ip>

# Force redeploy all services
./infra/deploy.sh
```

---

## TLS Certificate is Self-Signed

The Kong TLS certificate in `infra/kong/certs/` is self-signed. Browsers show a security warning; use `curl -k` or accept the browser warning for testing.

Replacing with a Let's Encrypt certificate is straightforward but out of scope for this assignment.

---

## MongoDB Support is Secondary

`DB_TYPE=mongo` is supported by `joke-service` and `etl-service`, but:
- The automated test suite (`test-flows.js`) runs against MySQL only
- The production Azure topology uses MySQL exclusively
- MongoDB mode is available for local experimentation; it has not been stress-tested

---

## Single-Node RabbitMQ

RabbitMQ runs as a single container with no message persistence beyond standard queue durability. If VM2 is forcibly stopped while messages are in-flight, unacked messages in the `submit` queue may be lost.

For this assignment scope, a single-node broker is sufficient.

---

## Rate Limiting Scope

Only `GET /joke/:type` is rate-limited (5 req/min per IP). The `/submit` endpoint has no rate limiting, which would be a concern in a real production deployment. This was considered acceptable for the module scope.

---

## No Role-Based Moderation

`moderate-service` checks for an authenticated session (`requiresAuthJson`) but does not enforce a moderator role from the Auth0 token. Any authenticated user can approve or reject jokes. Adding role claims to the Auth0 token and checking them in `requiresModeratorRoleJson` is implemented but not enforced by default.

---

## ETL Service Uses Build-on-VM by Default

`vm1-compose.yml` uses `build: ./etl-service` rather than a pre-built Docker Hub image. The `deploy-etl.yml` CI/CD workflow sets `ETL_IMAGE` in `.env` to switch to the pre-built image, but this only applies after the first CI/CD run. The initial deployment always builds from source on the VM.
