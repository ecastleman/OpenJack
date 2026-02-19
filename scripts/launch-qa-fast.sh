#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/ernesto/Documents/New project"
cd "$ROOT"

if [[ -z "${OPENJACK_PROGRAM_ID:-}" ]]; then
  echo "OPENJACK_PROGRAM_ID is required for qa-fast launch."
  echo "This should be the deployed qa-fast program ID (built with feature qa-fast-timers)."
  exit 1
fi

export RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
export OPENJACK_IDL_PATH="${OPENJACK_IDL_PATH:-$ROOT/target/idl/openjack.json}"
export DATABASE_URL="${DATABASE_URL:-postgres://localhost:5432/openjack}"
export OPENJACK_API_BASE="${OPENJACK_API_BASE:-http://localhost:8080}"
export INGEST_API_KEY="${INGEST_API_KEY:-dev-ingest-key}"
export OPENJACK_EVENT_SOURCE_MODE="${OPENJACK_EVENT_SOURCE_MODE:-rpc}"
export OPENJACK_RPC_LOOKBACK_LIMIT="${OPENJACK_RPC_LOOKBACK_LIMIT:-120}"
export OPENJACK_SCAN_INTERVAL_SECS="${OPENJACK_SCAN_INTERVAL_SECS:-8}"
export OPENJACK_PROOF_MODE="${OPENJACK_PROOF_MODE:-off}"
export OPENJACK_ASSET_RESOLVER_MODE="${OPENJACK_ASSET_RESOLVER_MODE:-postgres}"
export OPENJACK_WINNING_SOURCE="${OPENJACK_WINNING_SOURCE:-api}"
export AUTHORITY_KEYPAIR_PATH="${AUTHORITY_KEYPAIR_PATH:-$HOME/.config/solana/id.json}"
export SCANNER_KEYPAIR_PATH="${SCANNER_KEYPAIR_PATH:-$HOME/.config/solana/id.json}"
export VRF_CALLBACK_KEYPAIR_PATH="${VRF_CALLBACK_KEYPAIR_PATH:-$HOME/.config/solana/id.json}"
export READY_WALLET="${READY_WALLET:-$(solana address)}"
export SMOKE_WALLET="${SMOKE_WALLET:-$READY_WALLET}"
export OPENJACK_CLOSE_IN_SECS="${OPENJACK_CLOSE_IN_SECS:-45}"
export OPENJACK_AUTO_FULFILL_DRAW="${OPENJACK_AUTO_FULFILL_DRAW:-true}"
export OPENJACK_ORACLE_MAX_AGE_SECS="${OPENJACK_ORACLE_MAX_AGE_SECS:-600}"
export OPENJACK_ORACLE_PUBKEY="${OPENJACK_ORACLE_PUBKEY:-11111111111111111111111111111111}"
export OPENJACK_TICKET_PRICE_USD_CENTS="${OPENJACK_TICKET_PRICE_USD_CENTS:-200}"
export GATE_MODE="${GATE_MODE:-false}"

echo "[launch-qa-fast] Applying DB schemas..."
psql "$DATABASE_URL" -f "$ROOT/services/api/data/schema.sql"
psql "$DATABASE_URL" -f "$ROOT/services/scanner/data/schema.sql"

echo "[launch-qa-fast] Syncing config roles..."
npm run config:init
npm run scanner:set-official
npm run vrf:set-callback
npm run oracle:set-max-age
npm run ticket-price:set
npm run config:verify

echo "[launch-qa-fast] Creating round..."
ROUND_OUTPUT="$(npm run round:create-open:qa-fast)"
echo "$ROUND_OUTPUT"

ROUND_ID="$(echo "$ROUND_OUTPUT" | awk -F= '/^round_id=/{print $2}' | tail -n 1 | tr -d '[:space:]')"
if [[ -z "$ROUND_ID" ]]; then
  echo "[launch-qa-fast] Could not parse round_id from output."
  echo "Set OPENJACK_KEEPER_ROUND_ID/OPENJACK_SCAN_ROUND_ID manually, then run: npm run seeker:vertical"
  exit 1
fi

export OPENJACK_KEEPER_ROUND_ID="$ROUND_ID"
export OPENJACK_SCAN_ROUND_ID="$ROUND_ID"
export READY_ROUND_ID="$ROUND_ID"
export SMOKE_ROUND_ID="$ROUND_ID"

if [[ "$GATE_MODE" == "true" ]]; then
  echo "[launch-qa-fast] GATE_MODE=true -> starting API only for protocol gate runs (round $ROUND_ID) ..."
  echo "[launch-qa-fast] In another terminal run: OPENJACK_GATE_PROFILE=qa-fast npm run gate:protocol"
  npm run api
else
  echo "[launch-qa-fast] Starting vertical stack for round $ROUND_ID ..."
  npm run seeker:vertical
fi
