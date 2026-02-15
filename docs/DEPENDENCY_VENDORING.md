# OpenJack Dependency Vendoring

Use this flow to run Rust/Anchor tests in network-restricted environments.

## One-time setup on a machine with internet

From `/Users/ernesto/Documents/New project`:

```bash
cargo generate-lockfile
cargo vendor vendor > .cargo/config.vendored.toml
./scripts/use-vendored-cargo-config.sh
```

Commit these paths:

- `Cargo.lock`
- `.cargo/config.toml`
- `.cargo/config.vendored.toml`
- `vendor/`

## Running in restricted/offline environments

From `/Users/ernesto/Documents/New project`:

```bash
cargo test -p openjack --offline
```

## Switching back to default (non-vendored) Cargo config

```bash
./scripts/use-default-cargo-config.sh
```

