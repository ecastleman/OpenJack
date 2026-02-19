#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/ernesto/Documents/New project"
cd "$ROOT"

if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgres://localhost:5432/openjack}"
export OPENJACK_API_BASE="${OPENJACK_API_BASE:-http://localhost:8080}"
export INGEST_API_KEY="${INGEST_API_KEY:-dev-ingest-key}"
export OPENJACK_PROGRAM_ID="${OPENJACK_PROGRAM_ID:-Cnraeedx3R74G42eLHBz1rTbSwCQt62C2RC7iaejWSW3}"
export OPENJACK_IDL_PATH="${OPENJACK_IDL_PATH:-$ROOT/target/idl/openjack.json}"
export RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
export OPENJACK_DAS_RPC_URL="${OPENJACK_DAS_RPC_URL:-}"
export SCANNER_KEYPAIR_PATH="${SCANNER_KEYPAIR_PATH:-$HOME/.config/solana/id.json}"
export AUTHORITY_KEYPAIR_PATH="${AUTHORITY_KEYPAIR_PATH:-$HOME/.config/solana/id.json}"
export VRF_CALLBACK_KEYPAIR_PATH="${VRF_CALLBACK_KEYPAIR_PATH:-$HOME/.config/solana/id.json}"
export OPENJACK_CNFT_MINT_ENABLED=true
export PAGER=cat

if [[ -z "$OPENJACK_DAS_RPC_URL" ]]; then
  echo "OPENJACK_DAS_RPC_URL is required (set a real DAS key)."
  exit 1
fi

if [[ ! -f "$OPENJACK_IDL_PATH" ]]; then
  echo "OPENJACK_IDL_PATH not found: $OPENJACK_IDL_PATH"
  exit 1
fi

echo "[clean-cycle] killing old processes..."
pkill -f "services/api/src/server.js" || true
pkill -f "node src/server.js" || true
pkill -f "services/scanner/src/index.js" || true
pkill -f "scripts/round-orchestrator.mjs" || true
lsof -ti tcp:8080 | xargs kill -9 2>/dev/null || true

# API should derive tree config from round tree to avoid stale constraint-seeds mismatch.
unset OPENJACK_TREE_ADDRESS
unset OPENJACK_TREE_CONFIG_ADDRESS

createdb openjack 2>/dev/null || true

echo "[clean-cycle] applying schemas..."
psql "$DATABASE_URL" -f "services/scanner/data/schema.sql" >/dev/null
psql "$DATABASE_URL" -f "services/api/data/schema.sql" >/dev/null

echo "[clean-cycle] ensuring cNFT tree initialized..."
node scripts/init-cnft-tree.mjs >/dev/null

echo "[clean-cycle] starting api..."
OPENJACK_IDL_PATH="$OPENJACK_IDL_PATH" npm run api >/tmp/openjack-api.log 2>&1 &
API_PID=$!
KEEPER_PID=""

cleanup() {
  if [[ -n "$KEEPER_PID" ]]; then
    kill "$KEEPER_PID" 2>/dev/null || true
  fi
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for _ in {1..30}; do
  if curl -sf "$OPENJACK_API_BASE/health" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -sf "$OPENJACK_API_BASE/health" >/dev/null; then
  echo "[clean-cycle] API failed to start; tail:"
  tail -n 80 /tmp/openjack-api.log || true
  exit 1
fi

echo "[clean-cycle] clearing stale DRAWING/SETTLING active rounds..."
while true; do
  ACTIVE_JSON="$(curl -s "$OPENJACK_API_BASE/rounds/active")"
  RID="$(echo "$ACTIVE_JSON" | jq -r '.round.roundId // 0')"
  ST="$(echo "$ACTIVE_JSON" | jq -r '.round.status // "NONE"')"
  if [[ "$RID" == "0" || "$ST" == "NONE" ]]; then
    break
  fi
  if [[ "$ST" == "DRAWING" || "$ST" == "SETTLING" ]]; then
    echo "[clean-cycle] tombstoning stale round=$RID status=$ST"
    psql "$DATABASE_URL" -c "UPDATE rounds SET status='FINALIZED', updated_at=now() WHERE round_id=$RID;" >/dev/null
  else
    break
  fi
done

echo "[clean-cycle] starting keeper daemon..."
npm run keeper >/tmp/openjack-keeper.log 2>&1 &
KEEPER_PID=$!

sleep 2

echo "[clean-cycle] running gate cycle..."
OPENJACK_PROOF_MODE=off \
OPENJACK_GATE_SKIP_AUTO_CLAIM=true \
OPENJACK_GATE_PROFILE=qa-fast \
OPENJACK_GATE_CYCLES=1 \
OPENJACK_GATE_CONTINUE_ON_FAIL=false \
OPENJACK_GATE_SEND_TX_MIN_INTERVAL_MS=1100 \
OPENJACK_GATE_CLOSE_IN_SECS=15 \
OPENJACK_GATE_WAIT_SETTLING_MS=180000 \
OPENJACK_GATE_WAIT_FINALIZED_MS=300000 \
npm run gate:protocol

REPORT="$(ls -t reports/protocol-gate/protocol-gate-*.json | head -n1)"
ROUND="$(jq -r '.results[] | select(.ok==true) | .roundId' "$REPORT" | tail -n1)"
WALLET="$(jq -r '.buyer' "$REPORT")"

if [[ -z "$ROUND" || "$ROUND" == "null" ]]; then
  echo "[clean-cycle] could not parse successful round from $REPORT"
  exit 1
fi

echo "[clean-cycle] hydrating latest round=$ROUND..."
OPENJACK_SCAN_ROUND_ID="$ROUND" \
OPENJACK_SCANNER_MODE=once \
OPENJACK_SCANNER_CLAIMS_ONLY=true \
OPENJACK_PROOF_MODE=das \
OPENJACK_ASSET_RESOLVER_MODE=derived \
npm run scanner >/tmp/openjack-hydrate.log 2>&1 || {
  echo "[clean-cycle] hydrate failed; tail:"
  tail -n 80 /tmp/openjack-hydrate.log || true
  exit 1
}

echo "[clean-cycle] claiming latest report..."
npm run claim:gate-report -- "$REPORT" >/tmp/openjack-claim.log 2>&1 || {
  echo "[clean-cycle] claim failed; tail:"
  tail -n 120 /tmp/openjack-claim.log || true
  exit 1
}

echo "[clean-cycle] final verification"
curl -s "$OPENJACK_API_BASE/rounds/$ROUND/hydration"
echo
curl -s "$OPENJACK_API_BASE/claims/estimate?roundId=$ROUND&wallet=$WALLET"
echo

npm run verify:claimed-round -- "$ROUND" "$WALLET"

echo "[clean-cycle] done round=$ROUND report=$REPORT"
