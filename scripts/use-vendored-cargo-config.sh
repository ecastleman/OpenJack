#!/usr/bin/env bash
set -euo pipefail

cp .cargo/config.vendored.toml .cargo/config.toml
echo "Applied vendored Cargo config (.cargo/config.toml)."

