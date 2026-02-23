# M7 Integration Baseline

This baseline provides runnable local components:

- `packages/shared`: shared event and tier contracts
- `services/scanner`: dual-ingestion reconciliation and root payload builder
- `services/api`: thin read-only API
- `apps/web`: lightweight frontend consuming API data

Plus integration scaffolding:

- scanner publish adapter with real Anchor `publish_winner_root` live mode
- API ingestion endpoints and tx-prepare endpoints backed by Postgres repository
- frontend wallet connect + tx-prepare + `signAndSendTransaction` actions
- claim flow uses ticket payloads from `/claims/estimate` (no hardcoded leaf/tier/amount)

## Run locally

From `.`:

0. Preflight:

```bash
npm run preflight
```

1. Start API:

```bash
cd services/api
npm install
psql "$DATABASE_URL" -f services/api/data/schema.sql
node src/server.js
```

2. Start web app (new terminal):

```bash
cd apps/web
npm install
npm run dev
```

3. Open:

- API health: `http://localhost:8080/health`
- Web app: `http://localhost:5173`

4. Run scanner for target round:

```bash
cd services/scanner
npm install
psql "${SCANNER_DATABASE_URL:-$DATABASE_URL}" -f services/scanner/data/schema.sql
OPENJACK_EVENT_SOURCE_MODE=postgres \
OPENJACK_SCANNER_MODE=daemon \
OPENJACK_SCAN_INTERVAL_SECS=30 \
OPENJACK_WINNING_SOURCE=api \
OPENJACK_ASSET_RESOLVER_MODE=postgres \
OPENJACK_PROOF_MODE=das \
OPENJACK_FETCH_TIER_PAYOUTS=true \
OPENJACK_API_BASE=http://localhost:8080 \
node src/index.js
```

For direct chain ingestion (no event DB), use:

```bash
OPENJACK_EVENT_SOURCE_MODE=rpc \
OPENJACK_RPC_LOOKBACK_LIMIT=300 \
OPENJACK_SCAN_ROUND_ID=42 \
node src/index.js
```

For dual ingestion + persistence:

```bash
OPENJACK_EVENT_SOURCE_MODE=rpc-dual \
OPENJACK_RPC_LOOKBACK_LIMIT=300 \
OPENJACK_RPC_SLOT_BACKFILL_LIMIT=200 \
OPENJACK_PERSIST_EVENTS=true \
OPENJACK_SCAN_ROUND_ID=42 \
node src/index.js
```

5. Run devnet E2E harness:

```bash
cd .
node scripts/devnet-e2e-openjack.mjs
```

6. Run Seeker smoke checks:

```bash
cd .
npm run seeker:smoke
npm run seeker:report
npm run seeker:ready
npm run seeker:beta
npm run seeker:live
```

Optional smoke env:

- `SMOKE_API_BASE` (default `http://localhost:8080`)
- `SMOKE_WALLET` (default `11111111111111111111111111111111`)
- `SMOKE_ROUND_ID` (override active round discovery)
- `SMOKE_WRITE_REPORT=true` (write timestamped JSON+MD report)
- `SMOKE_REPORT_DIR` (default `reports/seeker`)

`seeker:report` writes artifacts:
- `reports/seeker/seeker-smoke-<timestamp>.json`
- `reports/seeker/seeker-smoke-<timestamp>.md`

`seeker:ready` prints `READY` or `NOT_READY` gate status.
Optional gate env:
- `READY_API_BASE` (default `http://localhost:8080`)
- `READY_WALLET` (default `11111111111111111111111111111111`)
- `READY_ROUND_ID` (override active round discovery)
- `READY_STRICT=true` (treat roots/claim checks as fatal)

`seeker:beta` runs orchestration:
- optional `keeper` one-shot
- optional `scanner` one-shot
- readiness gate
- smoke report artifact

Optional beta env:
- `BETA_RUN_KEEPER_ONCE=true`
- `BETA_RUN_SCANNER_ONCE=true`
- `BETA_READY_STRICT=true`

`seeker:live` validates required env vars and prints exact command order
for a live Seeker beta session. It exits non-zero if required env vars are missing.

7. Run round orchestrator (keeper):

```bash
cd .
OPENJACK_KEEPER_MODE=daemon \
OPENJACK_KEEPER_INTERVAL_SECS=15 \
OPENJACK_API_BASE=http://localhost:8080 \
OPENJACK_AUTO_FULFILL_DRAW=false \
npm run keeper
```

Keeper env:
- `OPENJACK_KEEPER_MODE=once|daemon` (default `daemon`)
- `OPENJACK_KEEPER_INTERVAL_SECS` (default `15`)
- `OPENJACK_KEEPER_ROUND_ID` (optional fixed round; otherwise uses `/rounds/active`)
- `OPENJACK_AUTO_FULFILL_DRAW=true|false` (default `false`; requires vrf callback authority signer)
- `OPENJACK_API_BASE` + `INGEST_API_KEY` for round status ingest to API

Optional flags:

- `E2E_WAIT_FOR_FINALIZE=true` to wait 1 hour and continue finalize + claim
- `E2E_WAIT_FOR_SWEEP=true` to include post-30-day sweep reminder

If the harness exits with `RPC not reachable`, your machine cannot access the configured `RPC_URL`.

### Required env vars for live integrations

- `RPC_URL` (devnet/mainnet RPC)
- `OPENJACK_PROGRAM_ID`
- `OPENJACK_IDL_PATH` (default `target/idl/openjack.json`)
- `SCANNER_KEYPAIR_PATH` (scanner live mode signer)
- `INGEST_API_KEY`
- `DATABASE_URL` (Postgres connection string)
- `TREASURY_PUBKEY` and `ORACLE_FEED_PUBKEY` (tx prepare account wiring)

## Implemented API endpoints

- `GET /health`
- `GET /rounds/active`
- `GET /rounds/:roundId`
- `GET /rounds/:roundId/roots`
- `GET /claims/estimate?roundId=<id>&wallet=<pubkey>`
- `POST /ingest/round` (requires `x-api-key`)
- `POST /ingest/roots` (requires `x-api-key`)
- `POST /ingest/claim-estimate` (requires `x-api-key`)
- `POST /tx/prepare/buy`
- `POST /tx/prepare/claim`

`/ingest/claim-estimate` accepts per-ticket fields:
- `leafIndex`
- `tier`
- `amount`
- optional proof metadata (`winnerRootHash`, `winnerRootProof`, `ticketProof`, `ownershipProof`)

Current scanner behavior:
- `winnerRootHash` and `winnerRootProof` are generated from a per-tier Merkle tree over winning `leafIndex` values.
- roots are ingested into API automatically (`POST /ingest/roots`) when `OPENJACK_API_BASE` is set.
- claim candidates are ingested into API automatically (`POST /ingest/claim-estimate`) when `OPENJACK_API_BASE` is set.
- scanner can run continuously with `OPENJACK_SCANNER_MODE=daemon` and poll active rounds.
- claim amounts can be hydrated from on-chain `tierPayoutPerWinner` via `OPENJACK_FETCH_TIER_PAYOUTS=true`.
- root publish reliability includes tx confirmation polling and dead-letter retry queue.
- `ticketProof` and `ownershipProof` can be hydrated by scanner proof providers:
  - `OPENJACK_PROOF_MODE=off` (default)
  - `OPENJACK_PROOF_MODE=file` + `OPENJACK_PROOF_MAP_PATH`
  - `OPENJACK_PROOF_MODE=das` (+ `OPENJACK_DAS_RPC_URL` optional)
- `assetId` can be resolved automatically before proof hydration via:
  - `OPENJACK_ASSET_RESOLVER_MODE=file` + `OPENJACK_ASSET_MAP_PATH`
  - `OPENJACK_ASSET_RESOLVER_MODE=postgres` (+ table/column env overrides)

Default ingest key (dev only): `dev-ingest-key`

## Next integration steps

- Add robust DB migrations and indexes (currently auto-init + SQL bootstrap).
- Add Seeker device QA pass: wallet connect, buy, roots visibility, claim success path.
