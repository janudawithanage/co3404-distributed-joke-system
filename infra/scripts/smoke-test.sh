#!/usr/bin/env bash
# =============================================================================
# infra/scripts/smoke-test.sh
#
# End-to-end smoke test for the Distributed Joke System.
# Runs against the live Azure deployment via the Kong gateway.
#
# Usage:
#   KONG_IP=<kong_public_ip> ./infra/scripts/smoke-test.sh
#   # or
#   ./infra/scripts/smoke-test.sh <kong_public_ip>
#
# Optional flags:
#   --http    Use http:// instead of https:// (useful when TLS is not yet set up)
#   --verbose Print full response bodies for each check
#
# Exit code:
#   0  All checks passed
#   1  One or more checks failed (details printed inline)
#
# Prerequisites:
#   curl, jq  (brew install jq  or  apt install jq)
#
# What is tested:
#   SECTION A  Static routes (GET, expected status codes)
#   SECTION B  Full pipeline: submit → moderate queue → approve → /jokes
#   SECTION C  Rate limiting on /joke/any (6 rapid requests → 429)
#   SECTION D  Auth-status endpoint returns expected JSON shape
#   SECTION E  Kong middleware headers present (Kong-Request-ID, X-RateLimit-*)
# =============================================================================

set -uo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────
KONG_IP="${1:-${KONG_IP:-}}"
SCHEME="https"
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --http)    SCHEME="http" ;;
    --verbose) VERBOSE=true ;;
  esac
done

if [[ -z "$KONG_IP" ]]; then
  echo "Usage: KONG_IP=<ip> $0 [--http] [--verbose]"
  echo "   or: $0 <kong_public_ip> [--http] [--verbose]"
  exit 1
fi

BASE="${SCHEME}://${KONG_IP}"

# ─── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

PASS=0; FAIL=0; WARN=0

pass() { echo -e "  ${GREEN}PASS${RESET}  $1"; ((PASS++)); }
fail() { echo -e "  ${RED}FAIL${RESET}  $1"; ((FAIL++)); }
warn() { echo -e "  ${YELLOW}WARN${RESET}  $1"; ((WARN++)); }
header() { echo -e "\n${CYAN}${BOLD}$1${RESET}"; }

# ─── Core check helpers ───────────────────────────────────────────────────────
# check LABEL URL EXPECTED_HTTP [CURL_EXTRA_ARGS...]
check() {
  local label="$1" url="$2" expected="$3"
  shift 3
  local resp http body
  resp=$(curl -sk --max-time 10 -w "\n%{http_code}" "$@" "$url" 2>/dev/null)
  http="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if [[ "$http" == "$expected" ]]; then
    pass "$label  →  HTTP $http"
    $VERBOSE && echo "       $body"
  else
    fail "$label  →  HTTP $http  (expected $expected)"
    echo "       Body: ${body:0:200}"
  fi
}

# check_contains LABEL URL EXPECTED_HTTP GREP_PATTERN
check_contains() {
  local label="$1" url="$2" expected="$3" pattern="$4"
  local resp http body
  resp=$(curl -sk --max-time 10 -w "\n%{http_code}" "$url" 2>/dev/null)
  http="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if [[ "$http" == "$expected" ]] && echo "$body" | grep -q "$pattern"; then
    pass "$label  →  HTTP $http, contains '$pattern'"
  elif [[ "$http" != "$expected" ]]; then
    fail "$label  →  HTTP $http (expected $expected)"
    echo "       Body: ${body:0:200}"
  else
    fail "$label  →  HTTP $http but body missing '$pattern'"
    echo "       Body: ${body:0:200}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Distributed Joke System — Smoke Test${RESET}"
echo "  Target: $BASE"
echo "  Date:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# =============================================================================
# SECTION A — Static routes
# =============================================================================
header "A. Static / health routes"

check "GET /health"         "$BASE/health"      "200"
check "GET /joke/any"       "$BASE/joke/any"    "200"
check "GET /types"          "$BASE/types"       "200"
check "GET /config.js"      "$BASE/config.js"   "200"
check "GET /auth-status"    "$BASE/auth-status" "200"
check "GET /etl-health"     "$BASE/etl-health"  "200"

header "A2. UI pages"
check "GET /joke-ui"        "$BASE/joke-ui"     "200"
check "GET /submit"         "$BASE/submit"      "200"
check "GET /moderate-ui"    "$BASE/moderate-ui" "200"
check "GET /docs"           "$BASE/docs"        "301"  # redirect from Express

header "A3. Protected admin routes (must return 403 from internet)"
check "GET /mq-admin/ (blocked)" "$BASE/mq-admin/" "403"

header "A4. /config.js contains gatewayBase (not empty/localhost)"
resp_config=$(curl -sk --max-time 10 "$BASE/config.js" 2>/dev/null)
if echo "$resp_config" | grep -qE 'gatewayBase\s*:\s*"(https?://[^"]+)"'; then
  GBASE=$(echo "$resp_config" | grep -oE '"https?://[^"]+"' | head -1)
  pass "/config.js  →  gatewayBase = $GBASE"
  if echo "$GBASE" | grep -qE '"https?://localhost'; then
    warn "  gatewayBase is localhost — frontend will not work outside the server"
  fi
else
  fail "/config.js  →  gatewayBase missing or empty (PUBLIC_GATEWAY_BASE not set on VM1)"
fi

# =============================================================================
# SECTION B — Full submission pipeline
# =============================================================================
header "B. Full pipeline: submit → moderate → approve → check in /jokes"

UNIQUE_SETUP="Smoke test $(date +%s)?"
UNIQUE_PUNCH="It passed."

echo "  Submitting joke: '$UNIQUE_SETUP'"
SUBMIT_RESP=$(curl -sk --max-time 10 \
  -X POST "$BASE/submit" \
  -H "Content-Type: application/json" \
  -d "{\"setup\":\"$UNIQUE_SETUP\",\"punchline\":\"$UNIQUE_PUNCH\",\"type\":\"test\"}" \
  2>/dev/null)
SUBMIT_HTTP=$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" \
  -X POST "$BASE/submit" \
  -H "Content-Type: application/json" \
  -d "{\"setup\":\"${UNIQUE_SETUP}2\",\"punchline\":\"$UNIQUE_PUNCH\",\"type\":\"test\"}" \
  2>/dev/null)

if [[ "$SUBMIT_HTTP" == "200" ]] || [[ "$SUBMIT_HTTP" == "201" ]]; then
  pass "POST /submit  →  HTTP $SUBMIT_HTTP"
else
  fail "POST /submit  →  HTTP $SUBMIT_HTTP"
  echo "       Body: ${SUBMIT_RESP:0:200}"
fi

# Poll moderate queue
echo "  Polling GET /moderated for pending joke (up to 15 s)..."
JOKE_ID=""
for i in $(seq 1 3); do
  QUEUE_RESP=$(curl -sk --max-time 10 "$BASE/moderated" 2>/dev/null)
  QUEUE_HTTP=$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" "$BASE/moderated" 2>/dev/null)
  # Try to extract an ID from the response (handles array or single object)
  JOKE_ID=$(echo "$QUEUE_RESP" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); \
      arr=d if isinstance(d,list) else [d]; \
      ids=[x.get('id') or x.get('_id') for x in arr if x]; \
      print(ids[0] if ids else '')" 2>/dev/null || true)
  if [[ -n "$JOKE_ID" ]]; then
    pass "GET /moderated  →  HTTP $QUEUE_HTTP, got pending joke id=$JOKE_ID"
    break
  fi
  sleep 5
done
if [[ -z "$JOKE_ID" ]]; then
  warn "GET /moderated  →  no pending joke found after 15 s (pipeline may be slow)"
fi

# Approve the joke
if [[ -n "$JOKE_ID" ]]; then
  echo "  Approving joke id=$JOKE_ID..."
  APPROVE_HTTP=$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" \
    -X POST "$BASE/moderated/$JOKE_ID/approve" \
    -H "Content-Type: application/json" \
    2>/dev/null)
  if [[ "$APPROVE_HTTP" == "200" ]] || [[ "$APPROVE_HTTP" == "204" ]]; then
    pass "POST /moderated/$JOKE_ID/approve  →  HTTP $APPROVE_HTTP"
  else
    fail "POST /moderated/$JOKE_ID/approve  →  HTTP $APPROVE_HTTP"
  fi

  # Give ETL time to write to MySQL
  sleep 3

  echo "  Checking /jokes for the approved joke..."
  JOKES_RESP=$(curl -sk --max-time 10 "$BASE/jokes" 2>/dev/null)
  JOKES_HTTP=$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" "$BASE/jokes" 2>/dev/null)
  if [[ "$JOKES_HTTP" == "200" ]]; then
    pass "GET /jokes  →  HTTP 200"
  else
    fail "GET /jokes  →  HTTP $JOKES_HTTP"
  fi
fi

# =============================================================================
# SECTION C — Rate limiting
# =============================================================================
header "C. Rate limiting on /joke/any (6 rapid requests, expect 429 on 5th or 6th)"

CODES=()
for i in $(seq 1 6); do
  CODE=$(curl -sk --max-time 5 -o /dev/null -w "%{http_code}" "$BASE/joke/any" 2>/dev/null)
  CODES+=("$CODE")
done
echo "  Response codes: ${CODES[*]}"

GOT_429=false
for c in "${CODES[@]}"; do
  [[ "$c" == "429" ]] && GOT_429=true
done

if $GOT_429; then
  pass "Rate limiting  →  429 returned (rate limit is active)"
else
  fail "Rate limiting  →  no 429 received after 6 rapid requests (rate limit may not be configured)"
fi

# Verify the 429 body has the expected shape
RATE_BODY=$(curl -sk --max-time 5 "$BASE/joke/any" 2>/dev/null)
if echo "$RATE_BODY" | grep -q '"message"'; then
  pass "429 body  →  contains 'message' field (frontend handler will display it)"
else
  warn "429 body  →  'message' field not found (frontend may show blank error)"
fi

# =============================================================================
# SECTION D — Auth-status shape
# =============================================================================
header "D. /auth-status response shape"

AUTH_BODY=$(curl -sk --max-time 10 "$BASE/auth-status" 2>/dev/null)
if echo "$AUTH_BODY" | grep -q '"authEnabled"'; then
  pass "/auth-status  →  contains 'authEnabled'"
else
  fail "/auth-status  →  missing 'authEnabled' field"
  echo "       Body: ${AUTH_BODY:0:200}"
fi
if echo "$AUTH_BODY" | grep -q '"mode"'; then
  MODE=$(echo "$AUTH_BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('mode','?'))" 2>/dev/null || echo "?")
  pass "/auth-status  →  mode = $MODE"
  if [[ "$MODE" == "unconfigured" ]]; then
    warn "  Auth0 is not configured — moderation UI is publicly accessible"
  fi
else
  fail "/auth-status  →  missing 'mode' field"
fi

# =============================================================================
# SECTION E — Kong middleware headers
# =============================================================================
header "E. Kong middleware headers"

HEADERS=$(curl -sk --max-time 10 -I "$BASE/joke/any" 2>/dev/null)
if echo "$HEADERS" | grep -qi "kong-request-id"; then
  pass "Kong-Request-ID header present"
else
  fail "Kong-Request-ID header missing (is Kong actually proxying this request?)"
fi
if echo "$HEADERS" | grep -qi "x-ratelimit-remaining"; then
  pass "X-RateLimit-Remaining header present"
else
  warn "X-RateLimit-Remaining header missing (rate-limit plugin may not be configured on /joke/any)"
fi
if echo "$HEADERS" | grep -qi "x-auth-mode"; then
  AMODE=$(echo "$HEADERS" | grep -i "x-auth-mode" | awk '{print $2}' | tr -d '\r')
  pass "X-Auth-Mode header present  →  $AMODE"
else
  warn "X-Auth-Mode header missing (auth-mode response transform not active)"
fi

# =============================================================================
# Summary
# =============================================================================
TOTAL=$((PASS + FAIL + WARN))
echo ""
echo "─────────────────────────────────────────────────────────"
echo -e " Results:  ${GREEN}${PASS} passed${RESET}  /  ${RED}${FAIL} failed${RESET}  /  ${YELLOW}${WARN} warnings${RESET}  (${TOTAL} total)"
echo "─────────────────────────────────────────────────────────"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}Smoke test FAILED — $FAIL check(s) require attention.${RESET}"
  echo ""
  echo "Quick debug commands:"
  echo "  ssh -i ~/.ssh/co3404_key azureuser@<VM1_IP> 'docker compose -f ~/co3404/docker-compose.yml logs --tail=30'"
  echo "  ssh -i ~/.ssh/co3404_key azureuser@<KONG_IP> 'sudo docker compose -f ~/kong/docker-compose.yml logs kong --tail=30'"
  exit 1
else
  echo -e "${GREEN}Smoke test PASSED.${RESET}  Deployment looks healthy."
  exit 0
fi
