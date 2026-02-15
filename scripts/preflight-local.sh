#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check_cmd() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    echo "[ok] $name: $(command -v "$name")"
  else
    echo "[missing] $name"
  fi
}

check_node_modules() {
  local dir="$1"
  if [[ -d "$ROOT_DIR/$dir/node_modules" ]]; then
    echo "[ok] $dir/node_modules"
  else
    echo "[missing] $dir/node_modules (run: npm --prefix $dir install)"
  fi
}

echo "== OpenJack preflight =="
check_cmd node
check_cmd npm
check_cmd psql
check_cmd solana
check_cmd anchor

echo
check_node_modules "services/api"
check_node_modules "services/scanner"
check_node_modules "apps/web"

echo
echo "Suggested next commands:"
echo "1) npm --prefix services/api install"
echo "2) npm --prefix services/scanner install"
echo "3) npm --prefix apps/web install"
echo "4) psql \"\$DATABASE_URL\" -f \"$ROOT_DIR/services/api/data/schema.sql\""
echo "5) psql \"\${SCANNER_DATABASE_URL:-\$DATABASE_URL}\" -f \"$ROOT_DIR/services/scanner/data/schema.sql\""
