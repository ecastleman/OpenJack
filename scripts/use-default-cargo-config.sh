#!/usr/bin/env bash
set -euo pipefail

cat > .cargo/config.toml << 'EOF'
[net]
git-fetch-with-cli = true
EOF

echo "Applied default Cargo config (.cargo/config.toml)."

