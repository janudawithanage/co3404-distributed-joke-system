#!/usr/bin/env bash
# =============================================================================
# infra/scripts/fix-db-cleanup.sh
#
# MEDIUM FIX M1 — BUG-005:
#   Remove junk test types ("hi", "bye") and their associated jokes from
#   the production MySQL database on VM1.
#
# Usage:
#   chmod +x infra/scripts/fix-db-cleanup.sh
#   ./infra/scripts/fix-db-cleanup.sh
#
# NOTE: This script removes data permanently. Review the SQL before running.
# =============================================================================
set -euo pipefail

VM1_HOST=""         # e.g. "52.163.x.y"  (VM1 public IP from Azure portal)
SSH_KEY="$HOME/.ssh/co3404_key"
SSH_USER="azureuser"

if [[ -z "$VM1_HOST" ]]; then
  echo "❌  VM1_HOST is not set. Edit this script and set your VM1 public IP."
  exit 1
fi

echo "🧹  Connecting to VM1 ($VM1_HOST) to clean junk types…"

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${VM1_HOST}" bash <<'SQLSH'
set -e

echo "── Current types in DB before cleanup ──"
sudo docker exec jokes_mysql mysql -ujokeuser -pjokepassword jokesdb \
  -e "SELECT id, name FROM types ORDER BY name;" 2>/dev/null

echo ""
echo "── Jokes linked to junk types (preview) ──"
sudo docker exec jokes_mysql mysql -ujokeuser -pjokepassword jokesdb \
  -e "SELECT j.id, j.setup, t.name AS type FROM jokes j JOIN types t ON j.type_id=t.id WHERE t.name IN ('hi','bye') ORDER BY t.name, j.id;" 2>/dev/null

echo ""
echo "── Running cleanup SQL ──"
sudo docker exec jokes_mysql mysql -ujokeuser -pjokepassword jokesdb 2>/dev/null <<'SQL'
-- Step 1: Delete jokes belonging to junk types
DELETE j FROM jokes j
  INNER JOIN types t ON j.type_id = t.id
  WHERE t.name IN ('hi', 'bye');

-- Step 2: Delete the junk types
DELETE FROM types WHERE name IN ('hi', 'bye');

-- Step 3: Verify
SELECT 'Remaining types:' AS '';
SELECT id, name FROM types ORDER BY name;

SELECT 'Remaining jokes count by type:' AS '';
SELECT t.name AS type, COUNT(j.id) AS joke_count
  FROM types t
  LEFT JOIN jokes j ON j.type_id = t.id
  GROUP BY t.id, t.name
  ORDER BY t.name;
SQL

echo "✅  Cleanup complete"
SQLSH

echo ""
echo "✅  DB cleanup done. Verify via Kong: curl https://<KONG_PUBLIC_IP>/types"
