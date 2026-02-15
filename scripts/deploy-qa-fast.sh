#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/ernesto/Documents/New project"
cd "$ROOT"

if ! command -v solana-keygen >/dev/null 2>&1; then
  echo "solana-keygen is required but not found in PATH."
  exit 1
fi
if ! command -v solana >/dev/null 2>&1; then
  echo "solana CLI is required but not found in PATH."
  exit 1
fi
if ! command -v anchor >/dev/null 2>&1; then
  echo "anchor CLI is required but not found in PATH."
  exit 1
fi

export RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
DEPLOY_KEYPAIR_PATH="${QA_FAST_PROGRAM_KEYPAIR_PATH:-$ROOT/keys/openjack-dev-fast-keypair.json}"
SO_PATH="$ROOT/target/deploy/openjack.so"
TMP_KEYPAIR_PATH="$ROOT/target/deploy/openjack-keypair.json"
WALLET_PATH="${WALLET_PATH:-$HOME/.config/solana/id.json}"
BACKUP_KEYPAIR_PATH="$ROOT/target/deploy/openjack-keypair.pre-qa-fast.bak"

DEPLOY_KEYPAIR_REF="$DEPLOY_KEYPAIR_PATH"
TMP_KEYPAIR_REF="$TMP_KEYPAIR_PATH"
SO_REF="$SO_PATH"
if [[ "$DEPLOY_KEYPAIR_PATH" == "$ROOT/"* ]]; then
  DEPLOY_KEYPAIR_REF="${DEPLOY_KEYPAIR_PATH#$ROOT/}"
fi
if [[ "$TMP_KEYPAIR_PATH" == "$ROOT/"* ]]; then
  TMP_KEYPAIR_REF="${TMP_KEYPAIR_PATH#$ROOT/}"
fi
if [[ "$SO_PATH" == "$ROOT/"* ]]; then
  SO_REF="${SO_PATH#$ROOT/}"
fi

mkdir -p "$(dirname "$DEPLOY_KEYPAIR_PATH")"
mkdir -p "$ROOT/target/deploy"

RESTORE_TARGET_KEYPAIR=0
cleanup() {
  if [[ "$RESTORE_TARGET_KEYPAIR" -eq 1 && -f "$BACKUP_KEYPAIR_PATH" ]]; then
    mv -f "$BACKUP_KEYPAIR_PATH" "$TMP_KEYPAIR_PATH"
  else
    rm -f "$BACKUP_KEYPAIR_PATH"
  fi
}
trap cleanup EXIT

if [[ ! -f "$DEPLOY_KEYPAIR_PATH" || ! -s "$DEPLOY_KEYPAIR_PATH" ]]; then
  echo "[deploy-qa-fast] Keypair file missing or empty: $DEPLOY_KEYPAIR_PATH"
  echo "[deploy-qa-fast] qa-fast uses the dev-fast program id feature; point QA_FAST_PROGRAM_KEYPAIR_PATH to your dev-fast keypair."
  exit 1
fi

echo "[deploy-qa-fast] Program id:"
QA_FAST_PROGRAM_ID="$(solana-keygen pubkey "$DEPLOY_KEYPAIR_REF")"
echo "  $QA_FAST_PROGRAM_ID"
if [[ "$QA_FAST_PROGRAM_ID" != "Cnraeedx3R74G42eLHBz1rTbSwCQt62C2RC7iaejWSW3" ]]; then
  echo "[deploy-qa-fast] ERROR: qa-fast build uses dev-fast-program-id and must deploy to Cnraeedx3R74G42eLHBz1rTbSwCQt62C2RC7iaejWSW3"
  echo "[deploy-qa-fast] Set QA_FAST_PROGRAM_KEYPAIR_PATH to the dev-fast keypair and retry."
  exit 1
fi

echo "[deploy-qa-fast] Building openjack with qa-fast timers..."
if [[ -f "$TMP_KEYPAIR_PATH" ]]; then
  cp "$TMP_KEYPAIR_PATH" "$BACKUP_KEYPAIR_PATH"
  RESTORE_TARGET_KEYPAIR=1
fi
cp "$DEPLOY_KEYPAIR_PATH" "$TMP_KEYPAIR_PATH"
anchor build -- --features qa-fast-timers,dev-fast-program-id

if [[ ! -f "$SO_PATH" ]]; then
  echo "Build succeeded but $SO_PATH was not found."
  exit 1
fi

echo "[deploy-qa-fast] Deploying to devnet..."
solana program deploy "$SO_REF" \
  --program-id "$DEPLOY_KEYPAIR_REF" \
  --url "$RPC_URL" \
  --keypair "$WALLET_PATH"

echo ""
echo "[deploy-qa-fast] Complete."
echo "Program ID: $QA_FAST_PROGRAM_ID"
echo ""
echo "Next:"
echo "  export OPENJACK_PROGRAM_ID=$QA_FAST_PROGRAM_ID"
echo "  npm run launch:qa-fast"
