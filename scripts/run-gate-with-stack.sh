#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/ernesto/Documents/New project"
cd "$ROOT"
API_LOG_PATH="${OPENJACK_API_LOG_PATH:-/tmp/openjack-api.log}"
KEEPER_LOG_PATH="${OPENJACK_KEEPER_LOG_PATH:-/tmp/openjack-keeper.log}"
export OPENJACK_API_LOG_PATH="$API_LOG_PATH"
export OPENJACK_KEEPER_LOG_PATH="$KEEPER_LOG_PATH"

if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgres://localhost:5432/openjack}"
export OPENJACK_API_BASE="${OPENJACK_API_BASE:-http://localhost:8080}"
export INGEST_API_KEY="${INGEST_API_KEY:-dev-ingest-key}"
export OPENJACK_PROGRAM_ID="${OPENJACK_PROGRAM_ID:-}"
export OPENJACK_IDL_PATH="${OPENJACK_IDL_PATH:-$ROOT/target/idl/openjack.json}"
export RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
export PAGER=cat

if [[ -z "$OPENJACK_PROGRAM_ID" ]]; then
  echo "OPENJACK_PROGRAM_ID is required (set in .env.local or shell env)."
  exit 1
fi

if [[ ! -f "$OPENJACK_IDL_PATH" ]]; then
  echo "OPENJACK_IDL_PATH not found: $OPENJACK_IDL_PATH"
  exit 1
fi

echo "[gate-stack] killing old processes..."
pkill -f "services/api/src/server.js" || true
pkill -f "node src/server.js" || true
pkill -f "services/scanner/src/index.js" || true
pkill -f "scripts/round-orchestrator.mjs" || true
lsof -ti tcp:8080 | xargs kill -9 2>/dev/null || true

createdb openjack 2>/dev/null || true

echo "[gate-stack] applying schemas..."
psql "$DATABASE_URL" -f "services/scanner/data/schema.sql" >/dev/null
psql "$DATABASE_URL" -f "services/api/data/schema.sql" >/dev/null

echo "[gate-stack] ensuring cNFT tree initialized..."
node scripts/init-cnft-tree.mjs >/dev/null

# API should derive tree config from round tree to avoid stale constraint-seeds mismatch.
unset OPENJACK_TREE_ADDRESS
unset OPENJACK_TREE_CONFIG_ADDRESS

echo "[gate-stack] starting api..."
OPENJACK_IDL_PATH="$OPENJACK_IDL_PATH" npm run api >"$API_LOG_PATH" 2>&1 &
API_PID=$!
KEEPER_PID=""

cleanup() {
  if [[ -n "$KEEPER_PID" ]]; then
    kill "$KEEPER_PID" 2>/dev/null || true
  fi
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" 2>/dev/null || true
  fi
  rm -f "${REPORT_BEFORE:-}" "${REPORT_AFTER:-}" "${REPORT_NEW:-}" 2>/dev/null || true
}
trap cleanup EXIT

for _ in {1..30}; do
  if curl -sf "$OPENJACK_API_BASE/health" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -sf "$OPENJACK_API_BASE/health" >/dev/null; then
  echo "[gate-stack] API failed to start; tail:"
  tail -n 80 "$API_LOG_PATH" || true
  exit 1
fi

echo "[gate-stack] starting keeper daemon..."
npm run keeper >"$KEEPER_LOG_PATH" 2>&1 &
KEEPER_PID=$!
sleep 2

echo "[gate-stack] running gate (cycles=${OPENJACK_GATE_CYCLES:-1}, profile=${OPENJACK_GATE_PROFILE:-dev-fast}, proof_mode=${OPENJACK_PROOF_MODE:-das})..."
STACK_SESSION_ID="${OPENJACK_STACK_SESSION_ID:-stack-$(date +%s)-$$}"
export OPENJACK_STACK_SESSION_ID="$STACK_SESSION_ID"
echo "[gate-stack] session=$OPENJACK_STACK_SESSION_ID"

REPORT_BEFORE="$(mktemp)"
REPORT_AFTER="$(mktemp)"
REPORT_NEW="$(mktemp)"
ls -1 "$ROOT"/reports/protocol-gate/protocol-gate-*.json 2>/dev/null | sort >"$REPORT_BEFORE" || true

set +e
npm run gate:protocol
GATE_STATUS=$?
set -e

ls -1 "$ROOT"/reports/protocol-gate/protocol-gate-*.json 2>/dev/null | sort >"$REPORT_AFTER" || true
comm -13 "$REPORT_BEFORE" "$REPORT_AFTER" >"$REPORT_NEW" || true
LATEST_REPORT="$(tail -n1 "$REPORT_NEW" || true)"
if [[ -z "$LATEST_REPORT" ]]; then
  LATEST_REPORT="$(ls -t "$ROOT"/reports/protocol-gate/protocol-gate-*.json 2>/dev/null | head -n1 || true)"
fi
if [[ -n "$LATEST_REPORT" ]]; then
  echo "[gate-stack] latest_report=$LATEST_REPORT"
fi

DEFAULT_POST_RUN="false"
if [[ -n "${OPENJACK_GATE_CYCLES:-}" ]] && [[ "${OPENJACK_GATE_CYCLES:-1}" -gt 1 ]]; then
  DEFAULT_POST_RUN="true"
fi
POST_RUN_FLAG="${OPENJACK_GATE_POST_RUN:-$DEFAULT_POST_RUN}"

if [[ "$POST_RUN_FLAG" == "true" && -n "$LATEST_REPORT" ]]; then
  echo "[gate-stack] running post steps (hydrate+claim+verify) for latest report..."
  set +e
  npm run gate:post-report -- "$LATEST_REPORT"
  POST_STATUS=$?
  set -e
else
  POST_STATUS=0
fi

if [[ "${GATE_STATUS:-0}" -ne 0 ]]; then
  echo "[gate-stack] gate run exited non-zero: $GATE_STATUS"
fi
if [[ "${POST_STATUS:-0}" -ne 0 ]]; then
  echo "[gate-stack] post run exited non-zero: $POST_STATUS"
fi
if [[ "${GATE_STATUS:-0}" -ne 0 || "${POST_STATUS:-0}" -ne 0 ]]; then
  echo "[gate-stack] logs api=$API_LOG_PATH keeper=$KEEPER_LOG_PATH"
  if [[ -n "$LATEST_REPORT" ]]; then
    echo "[gate-stack] report=$LATEST_REPORT"
  fi
fi

if [[ "${GATE_STATUS:-0}" -ne 0 ]]; then
  exit "$GATE_STATUS"
fi
if [[ "${POST_STATUS:-0}" -ne 0 ]]; then
  exit "$POST_STATUS"
fi
