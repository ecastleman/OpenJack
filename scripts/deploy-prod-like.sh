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
PROD_KEYPAIR_PATH="${PROD_LIKE_PROGRAM_KEYPAIR_PATH:-$ROOT/keys/openjack-keypair.json}"
SO_PATH="$ROOT/target/deploy/openjack.so"
TMP_KEYPAIR_PATH="$ROOT/target/deploy/openjack-keypair.json"
WALLET_PATH="${WALLET_PATH:-$HOME/.config/solana/id.json}"

if [[ ! -f "$PROD_KEYPAIR_PATH" ]]; then
  echo "prod-like program keypair not found: $PROD_KEYPAIR_PATH"
  echo "Set PROD_LIKE_PROGRAM_KEYPAIR_PATH to the correct keypair and retry."
  exit 1
fi

if [[ ! -s "$PROD_KEYPAIR_PATH" ]]; then
  echo "prod-like keypair file is empty: $PROD_KEYPAIR_PATH"
  exit 1
fi

# Solana signer parsing is brittle with absolute paths containing spaces.
PROD_KEYPAIR_REF="$PROD_KEYPAIR_PATH"
SO_REF="$SO_PATH"
if [[ "$PROD_KEYPAIR_PATH" == "$ROOT/"* ]]; then
  PROD_KEYPAIR_REF="${PROD_KEYPAIR_PATH#$ROOT/}"
fi
if [[ "$SO_PATH" == "$ROOT/"* ]]; then
  SO_REF="${SO_PATH#$ROOT/}"
fi

echo "[deploy-prod-like] Program id:"
PROD_PROGRAM_ID="$(solana-keygen pubkey "$PROD_KEYPAIR_REF")"
echo "  $PROD_PROGRAM_ID"

echo "[deploy-prod-like] Building openjack (prod-like)..."
cp "$PROD_KEYPAIR_PATH" "$TMP_KEYPAIR_PATH"
anchor build

if [[ ! -f "$SO_PATH" ]]; then
  echo "Build succeeded but $SO_PATH was not found."
  exit 1
fi

echo "[deploy-prod-like] Deploying to devnet..."
solana program deploy "$SO_REF" \
  --program-id "$PROD_KEYPAIR_REF" \
  --url "$RPC_URL" \
  --keypair "$WALLET_PATH"

echo ""
echo "[deploy-prod-like] Complete."
echo "Program ID: $PROD_PROGRAM_ID"
echo ""
echo "Next:"
echo "  export OPENJACK_PROGRAM_ID=$PROD_PROGRAM_ID"
echo "  npm run launch:prod-like"

