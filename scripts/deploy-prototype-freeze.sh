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
DEPLOY_KEYPAIR_PATH="${PROTOTYPE_FREEZE_PROGRAM_KEYPAIR_PATH:-$ROOT/keys/openjack-prototype-freeze-keypair.json}"
SO_PATH="$ROOT/target/deploy/openjack.so"
TMP_KEYPAIR_PATH="$ROOT/target/deploy/openjack-keypair.json"
WALLET_PATH="${WALLET_PATH:-$HOME/.config/solana/id.json}"
BACKUP_KEYPAIR_PATH="$ROOT/target/deploy/openjack-keypair.pre-prototype-freeze.bak"
EXTRA_FEATURES="${PROTOTYPE_FREEZE_EXTRA_FEATURES:-}"

DEPLOY_KEYPAIR_REF="$DEPLOY_KEYPAIR_PATH"
SO_REF="$SO_PATH"
if [[ "$DEPLOY_KEYPAIR_PATH" == "$ROOT/"* ]]; then
  DEPLOY_KEYPAIR_REF="${DEPLOY_KEYPAIR_PATH#$ROOT/}"
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
  echo "[deploy-prototype-freeze] Creating new prototype program keypair: $DEPLOY_KEYPAIR_PATH"
  solana-keygen new --no-bip39-passphrase --force -o "$DEPLOY_KEYPAIR_PATH" >/dev/null
else
  echo "[deploy-prototype-freeze] Reusing existing prototype program keypair: $DEPLOY_KEYPAIR_PATH"
fi

if [[ ! -s "$DEPLOY_KEYPAIR_PATH" ]]; then
  echo "[deploy-prototype-freeze] Keypair file missing or empty: $DEPLOY_KEYPAIR_PATH"
  exit 1
fi

echo "[deploy-prototype-freeze] Program id:"
PROTOTYPE_PROGRAM_ID="$(solana-keygen pubkey "$DEPLOY_KEYPAIR_REF")"
echo "  $PROTOTYPE_PROGRAM_ID"

FEATURES="canonical-freeze-prototype,prototype-program-id"
if [[ -n "$EXTRA_FEATURES" ]]; then
  FEATURES="${FEATURES},${EXTRA_FEATURES}"
fi

echo "[deploy-prototype-freeze] Building openjack with features: $FEATURES"
if [[ -f "$TMP_KEYPAIR_PATH" ]]; then
  cp "$TMP_KEYPAIR_PATH" "$BACKUP_KEYPAIR_PATH"
  RESTORE_TARGET_KEYPAIR=1
fi
cp "$DEPLOY_KEYPAIR_PATH" "$TMP_KEYPAIR_PATH"
anchor build -- --features "$FEATURES"

if [[ ! -f "$SO_PATH" ]]; then
  echo "Build succeeded but $SO_PATH was not found."
  exit 1
fi

echo "[deploy-prototype-freeze] Deploying to devnet..."
solana program deploy "$SO_REF" \
  --program-id "$DEPLOY_KEYPAIR_REF" \
  --url "$RPC_URL" \
  --keypair "$WALLET_PATH"

echo ""
echo "[deploy-prototype-freeze] Complete."
echo "Program ID: $PROTOTYPE_PROGRAM_ID"
echo ""
echo "Next:"
echo "  export OPENJACK_PROGRAM_ID=$PROTOTYPE_PROGRAM_ID"
echo "  update config/profiles/prototype-freeze.env OPENJACK_PROGRAM_ID=$PROTOTYPE_PROGRAM_ID"
echo "  npm run with-profile -- prototype-freeze npm run config:init"
