#!/usr/bin/env bash
# fix-db-index.sh -- migrate the uq_joke index on the AZURE MySQL instance
#
# Background
# ----------
# db/init.sql previously declared:
#   UNIQUE KEY uq_joke (setup(500), punchline(500))
# utf8mb4 uses up to 4 bytes per character, so that index requires
#   4 * (500 + 500) = 4000 bytes, which exceeds MySQL InnoDB's 3072-byte
#   combined key-prefix limit.  On Azure the data volume already exists, so
#   the init.sql fix that reduced the prefix to (255, 255) won't run again.
#   This script runs the equivalent ALTER TABLE against the live database.
#
# Usage
# -----
#   SSH into VM1 (joke-vm), then run:
#     bash ~/co3404/infra/scripts/fix-db-index.sh
#
#   Or run directly through deploy.sh (it scps the infra/ directory first):
#     ssh azureuser@<VM1_IP> "bash ~/co3404/infra/scripts/fix-db-index.sh"
#
# Prerequisites
# -------------
#   - The MySQL container "jokes_mysql" must be running on VM1
#   - DB_ROOT_PASSWORD must be set in the environment, or the script will
#     look for it in ~/co3404/.env.vm1
#
# Safety
# ------
#   - Only the index is changed; no row data is touched.
#   - Idempotent: if the index already has the correct prefix lengths the
#     DROP will fail gracefully and the script exits 0.

set -euo pipefail

MYSQL_CONTAINER="${MYSQL_CONTAINER:-jokes_mysql}"
DB_NAME="${DB_NAME:-jokesdb}"

# ── Resolve DB_ROOT_PASSWORD ──────────────────────────────────────────────────
if [[ -z "${DB_ROOT_PASSWORD:-}" ]]; then
  ENV_FILE="${HOME}/co3404/.env.vm1"
  if [[ -f "$ENV_FILE" ]]; then
    DB_ROOT_PASSWORD="$(grep -E '^DB_ROOT_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
  fi
fi

if [[ -z "${DB_ROOT_PASSWORD:-}" ]]; then
  echo "ERROR: DB_ROOT_PASSWORD is not set and could not be read from ~/co3404/.env.vm1"
  echo "       Set it in the environment:  export DB_ROOT_PASSWORD=<value>"
  exit 1
fi

echo "==> Checking current uq_joke index prefix lengths..."

CURRENT=$(docker exec "$MYSQL_CONTAINER" mysql \
  -u root -p"${DB_ROOT_PASSWORD}" \
  -sNe "SELECT Sub_part FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA='${DB_NAME}' AND TABLE_NAME='jokes'
          AND INDEX_NAME='uq_joke'
        ORDER BY SEQ_IN_INDEX LIMIT 1;" 2>/dev/null || echo "none")

if [[ "$CURRENT" == "255" ]]; then
  echo "==> uq_joke index already uses prefix 255 -- no migration needed."
  exit 0
fi

echo "==> Current prefix: ${CURRENT} (expected 255 after migration)"
echo "==> Applying migration: DROP old index, ADD new index with prefix 255..."

docker exec "$MYSQL_CONTAINER" mysql \
  -u root -p"${DB_ROOT_PASSWORD}" "${DB_NAME}" \
  -e "
    -- Step 1: drop the oversized index (fails gracefully if already gone)
    ALTER TABLE jokes DROP INDEX uq_joke;

    -- Step 2: recreate with InnoDB-safe prefix lengths
    --         4 bytes/char x 255 x 2 cols = 2040 bytes  (< 3072-byte limit)
    ALTER TABLE jokes ADD UNIQUE KEY uq_joke (setup(255), punchline(255));
  " 2>&1

echo "==> Verifying new prefix lengths..."
NEW=$(docker exec "$MYSQL_CONTAINER" mysql \
  -u root -p"${DB_ROOT_PASSWORD}" \
  -sNe "SELECT GROUP_CONCAT(Sub_part ORDER BY SEQ_IN_INDEX)
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA='${DB_NAME}' AND TABLE_NAME='jokes'
          AND INDEX_NAME='uq_joke';" 2>/dev/null)

if [[ "$NEW" == "255,255" ]]; then
  echo "==> Migration successful. uq_joke index is now (255, 255)."
else
  echo "ERROR: Migration may have failed. Current Sub_part values: '${NEW}'"
  exit 1
fi
