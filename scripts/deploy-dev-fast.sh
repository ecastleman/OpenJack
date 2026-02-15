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
DEPLOY_KEYPAIR_PATH="${DEV_FAST_PROGRAM_KEYPAIR_PATH:-$ROOT/keys/openjack-dev-fast-keypair.json}"
SO_PATH="$ROOT/target/deploy/openjack.so"
TMP_KEYPAIR_PATH="$ROOT/target/deploy/openjack-keypair.json"
WALLET_PATH="${WALLET_PATH:-$HOME/.config/solana/id.json}"
BACKUP_KEYPAIR_PATH="$ROOT/target/deploy/openjack-keypair.pre-dev-fast.bak"

# Solana signer parsing is brittle with absolute paths containing spaces.
# Use repo-relative paths when possible.
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

if [[ ! -f "$DEPLOY_KEYPAIR_PATH" ]]; then
  echo "[deploy-dev-fast] Creating new dev-fast program keypair: $DEPLOY_KEYPAIR_PATH"
  solana-keygen new --no-bip39-passphrase --force -o "$DEPLOY_KEYPAIR_PATH" >/dev/null
else
  echo "[deploy-dev-fast] Reusing existing dev-fast program keypair: $DEPLOY_KEYPAIR_PATH"
fi

if [[ ! -s "$DEPLOY_KEYPAIR_PATH" ]]; then
  echo "[deploy-dev-fast] Keypair file missing or empty: $DEPLOY_KEYPAIR_PATH"
  exit 1
fi

echo "[deploy-dev-fast] Program id:"
DEV_FAST_PROGRAM_ID="$(solana-keygen pubkey "$DEPLOY_KEYPAIR_REF")"
echo "  $DEV_FAST_PROGRAM_ID"

echo "[deploy-dev-fast] Building openjack with dev-fast timers..."
if [[ -f "$TMP_KEYPAIR_PATH" ]]; then
  cp "$TMP_KEYPAIR_PATH" "$BACKUP_KEYPAIR_PATH"
  RESTORE_TARGET_KEYPAIR=1
fi
cp "$DEPLOY_KEYPAIR_PATH" "$TMP_KEYPAIR_PATH"
anchor build -- --features dev-fast-timers,dev-fast-program-id

if [[ ! -f "$SO_PATH" ]]; then
  echo "Build succeeded but $SO_PATH was not found."
  exit 1
fi

echo "[deploy-dev-fast] Deploying to devnet..."
solana program deploy "$SO_REF" \
  --program-id "$DEPLOY_KEYPAIR_REF" \
  --url "$RPC_URL" \
  --keypair "$WALLET_PATH"

echo ""
echo "[deploy-dev-fast] Complete."
echo "Program ID: $DEV_FAST_PROGRAM_ID"
echo ""
echo "Next:"
echo "  export OPENJACK_PROGRAM_ID=$DEV_FAST_PROGRAM_ID"
echo "  npm run launch:dev-fast"
