#!/usr/bin/env bash
# =============================================================================
# infra/scripts/fix-db-cleanup.sh
#
# General-purpose data hygiene script for the jokes database.
# Idempotent — safe to run repeatedly.
#
# What it does:
#   1. Removes test-generated joke types (ecst*, etl*, testing) and their jokes
#   2. Removes stale test joke rows by known test setup patterns
#   3. Applies an idempotent encoding fix for the em-dash in joke #8
#      (no-op if the row already has the correct UTF-8 bytes)
#   4. Purges all messages from the RabbitMQ submit queue (optional)
#   5. Prints a final summary of types and joke counts
#
# Usage (local Docker Compose stack):
#   ./infra/scripts/fix-db-cleanup.sh
#
# Usage (Azure VM):
#   VM1_HOST=52.163.x.y ./infra/scripts/fix-db-cleanup.sh
#
# Environment variables:
#   VM1_HOST   — Azure VM1 public IP.  Leave unset for local use.
#   SSH_KEY    — Path to SSH private key  (default: ~/.ssh/co3404_key)
#   SSH_USER   — SSH username on Azure VM (default: azureuser)
#   SKIP_QUEUE — Set to 1 to skip the RabbitMQ queue purge step
# =============================================================================
set -euo pipefail

VM1_HOST="${VM1_HOST:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/co3404_key}"
SSH_USER="${SSH_USER:-azureuser}"
SKIP_QUEUE="${SKIP_QUEUE:-0}"

# ---------------------------------------------------------------------------
# Helper: run SQL against the MySQL container (local or remote)
# ---------------------------------------------------------------------------
run_sql() {
  local sql="$1"
  if [[ -n "$VM1_HOST" ]]; then
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${VM1_HOST}" \
      "sudo docker exec -i jokes_mysql mysql -ujokeuser -pjokepassword jokesdb 2>/dev/null" \
      <<< "$sql"
  else
    docker exec -i jokes_mysql mysql -ujokeuser -pjokepassword jokesdb 2>/dev/null \
      <<< "$sql"
  fi
}

# ---------------------------------------------------------------------------
# Helper: purge the RabbitMQ submit queue via management API
# ---------------------------------------------------------------------------
purge_queue() {
  local rmq_host="${1:-localhost}"
  echo "  Purging RabbitMQ submit queue on ${rmq_host}:15672..."
  if curl -sf -X DELETE "http://${rmq_host}:15672/api/queues/%2F/submit/contents" \
       -u guest:guest -H "Content-Type: application/json" -d '{}'; then
    echo "  submit queue purged"
  else
    echo "  WARNING: Could not reach RabbitMQ management API -- skipping queue purge"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if [[ -n "$VM1_HOST" ]]; then
  echo "Running hygiene against Azure VM1 ($VM1_HOST)..."
else
  echo "Running hygiene against local Docker Compose stack..."
fi

echo ""
echo "-- Applying cleanup SQL --"

SQL=$(cat <<'SQLEOF'
SET NAMES utf8mb4;

-- 1. Remove jokes linked to test-generated types (ecst*, etl*, testing)
DELETE j FROM jokes j
  INNER JOIN types t ON j.type_id = t.id
  WHERE t.name REGEXP '^(ecst|etl)[0-9]+$' OR t.name = 'testing';

-- 2. Remove orphaned test-generated types
DELETE FROM types
  WHERE name REGEXP '^(ecst|etl)[0-9]+$' OR name = 'testing';

-- 3. Remove stale test joke rows by known setup patterns
DELETE FROM jokes
  WHERE setup REGEXP '^recovery [0-9]+$'
     OR setup = 'Via Kong joke'
     OR setup = 'Test approve joke'
     OR setup = 'Test reject joke'
     OR setup REGEXP '^rl[0-9]+$';

SQLEOF
)

# Step 4 is built separately so the em-dash byte is embedded at write time
SQL="$SQL
-- 4. Idempotent em-dash encoding fix for joke #8 punchline.
--    Guards against mojibake from volumes initialised before the charset fix.
--    No-op if the punchline already has the correct UTF-8 bytes (E2 80 94).
UPDATE jokes
  SET punchline = 'Interrupting cow wh— MOOO!'
  WHERE setup LIKE 'Knock knock%Interrupting cow%'
    AND HEX(punchline) NOT LIKE '%E28094%';"

SQL="$SQL
$(cat <<'SQLEOF2'

-- 5. Final summary
SELECT '=== Types ===' AS info;
SELECT id, name FROM types ORDER BY name;

SELECT '=== Joke counts by type ===' AS info;
SELECT t.name AS type, COUNT(j.id) AS jokes
  FROM types t
  LEFT JOIN jokes j ON j.type_id = t.id
  GROUP BY t.id, t.name
  ORDER BY t.name;
SQLEOF2
)"

run_sql "$SQL"

echo ""
echo "Database hygiene complete."

if [[ "$SKIP_QUEUE" != "1" ]]; then
  echo ""
  purge_queue "${VM1_HOST:-localhost}"
fi

echo ""
echo "Done."
