# OpenJack Scanner

Official scanner service skeleton with reconciliation and publish pipeline.

## Run sample

```bash
cd /Users/ernesto/Documents/New\ project/services/scanner
npm install
node /Users/ernesto/Documents/New\ project/services/scanner/src/index.js
```

Environment:

- `SCANNER_PUBLISH_MODE=dry-run|live`
- `RPC_URL`
- `OPENJACK_PROGRAM_ID`
- `OPENJACK_IDL_PATH`
- `SCANNER_KEYPAIR_PATH`
- `SCANNER_DATABASE_URL` (or `DATABASE_URL`)
- `SCANNER_PUBLISH_MAX_ATTEMPTS` (default `3`)
- `SCANNER_PUBLISH_BACKOFF_MS` (default `1500`)
- `SCANNER_CONFIRM_TIMEOUT_MS` (default `60000`)
- `SCANNER_CONFIRM_POLL_MS` (default `2000`)
- `SCANNER_DEAD_LETTER_DELAY_MS` (default `15000`)
- `SCANNER_DEAD_LETTER_MAX_ATTEMPTS` (default `10`)
- `SCANNER_AUTO_SEAL_SNAPSHOT=true|false` (default `true`)
- `SCANNER_REQUIRE_SEALED_SNAPSHOT=true|false` (default `true`)
- `SCANNER_SNAPSHOT_SCHEMA_VERSION` (default `1`)
- `OPENJACK_API_BASE` (optional, ex `http://localhost:8080`)
- `INGEST_API_KEY` (used when `OPENJACK_API_BASE` is set)
- `OPENJACK_PROOF_MODE=off|file|das` (default `off`)
- `OPENJACK_PROOF_MAP_PATH` (required when `OPENJACK_PROOF_MODE=file`)
- `OPENJACK_DAS_RPC_URL` (optional override for DAS RPC endpoint)
- `OPENJACK_DAS_RPC_FALLBACK_URL` (optional fallback DAS endpoint)
- `OPENJACK_PROOF_MAX_ATTEMPTS` (default `3`)
- `OPENJACK_PROOF_BACKOFF_BASE_MS` (default `400`)
- `OPENJACK_PROOF_BACKOFF_MAX_MS` (default `5000`)
- `OPENJACK_PROOF_JITTER_MS` (default `200`)
- `OPENJACK_PROOF_CONCURRENCY` (default `4`)
- `OPENJACK_ASSET_RESOLVER_MODE=off|file|postgres` (default `off`)
- `OPENJACK_ASSET_MAP_PATH` (required when `OPENJACK_ASSET_RESOLVER_MODE=file`)
- `OPENJACK_ASSET_DATABASE_URL` (optional override DB URL for resolver postgres mode)
- `OPENJACK_ASSET_TABLE` (default `ticket_ledger`)
- `OPENJACK_ASSET_ROUND_COLUMN` (default `round_id`)
- `OPENJACK_ASSET_LEAF_COLUMN` (default `leaf_index`)
- `OPENJACK_ASSET_ID_COLUMN` (default `asset_id`)
- `OPENJACK_EVENT_SOURCE_MODE=sample|file|postgres|rpc|rpc-dual` (default `sample`)
- `OPENJACK_WS_EVENTS_PATH` (`file` mode)
- `OPENJACK_BACKFILL_EVENTS_PATH` (`file` mode; defaults to `OPENJACK_WS_EVENTS_PATH`)
- `OPENJACK_EVENT_DATABASE_URL` (optional override DB URL for event source postgres mode)
- `OPENJACK_EVENT_TABLE` (default `ticket_events`)
- `OPENJACK_EVENT_ROUND_COLUMN` (default `round_id`)
- `OPENJACK_EVENT_LEAF_COLUMN` (default `leaf_index`)
- `OPENJACK_RPC_LOOKBACK_LIMIT` (`rpc` mode; default `300`)
- `OPENJACK_RPC_SLOT_BACKFILL_LIMIT` (`rpc-dual` mode; default `200`)
- `OPENJACK_PERSIST_EVENTS=true|false` (default `false`; upsert finalized canonical events into `ticket_ledger`)
- `OPENJACK_SCAN_ROUND_ID` (default `42`)
- `OPENJACK_SCANNER_MODE=once|daemon` (default `once`)
- `OPENJACK_SCAN_INTERVAL_SECS` (daemon poll interval, default `30`)
- `OPENJACK_WINNING_SOURCE=env|api` (default `env`)
- `OPENJACK_WINNING_MAIN` CSV (default `1,2,3,4,5`)
- `OPENJACK_WINNING_BONUS` (default `1`)
- `OPENJACK_FETCH_TIER_PAYOUTS=true|false` (default `false`)
- `OPENJACK_AUDIT_LOG_PATH` (optional JSONL file path for ticket/publish audit trail)
- `OPENJACK_AUDIT_SUMMARY_PATH` (optional JSON file path for latest round summary)

`live` mode submits real `publish_winner_root` transactions via Anchor.

If `OPENJACK_API_BASE` is set, scanner ingests:
- roots (`POST /ingest/roots`)
- claim-ticket payloads grouped by wallet (`POST /ingest/claim-estimate`)

Those payloads include `winnerRootHash` and `winnerRootProof` from per-tier winner Merkle trees.

Proof modes:

- `off`: no cNFT proof hydration.
- `file`: load proof payloads from a local JSON map.
- `das`: fetch `ticketProof` and ownership metadata via DAS `getAsset` + `getAssetProof`
  using each ticket's `assetId`.

Asset resolver modes:

- `off`: requires `assetId` to be already present in ingested ticket events.
- `file`: loads `leafIndex -> assetId` from a local JSON map.
- `postgres`: resolves `assetId` from an indexer tickets table (`round_id`, `leaf_index`, `asset_id`).

Event source modes:

- `sample`: built-in sample events.
- `file`: read ws/backfill events from JSON files.
- `postgres`: load events from `ticket_events` table.
- `rpc`: read Anchor `TicketPurchased` events directly from recent program transactions.
- `rpc-dual`: build two independent pipelines
  - A: transaction log scan from recent signatures
  - B: slot block backfill scan from recent slots
  then reconcile on `leafIndex`.

Scanner modes:

- `once`: single scan/publish pass for the selected round.
- `daemon`: continuous scan loop. If `OPENJACK_SCAN_ROUND_ID` is unset, scanner discovers
  active round from `OPENJACK_API_BASE/rounds/active`.

Publish reliability:

- successful `publish_winner_root` transactions are polled for on-chain confirmation.
- failures are queued in `scanner_publish_dead_letters` and retried in subsequent runs.

Proof hydration reliability:

- proof enrichment retries are bounded with exponential backoff + jitter.
- per-ticket hydration state is persisted in `scanner_proof_hydration` (`pending|hydrated|failed`, attempts, last error).
- scanner never drops winner visibility when proofs fail; tickets remain visible with proof status metadata.
- DAS fallback endpoint is used only for retryable transport/rate-limit/provider errors (not deterministic "asset not found"-style errors).

Ops helpers (workspace root):

- `npm run hydrate:rehydrate-failed-round -- <roundId>`
- `npm run hydrate:cleanup-status` (`OPENJACK_PROOF_RETENTION_DAYS`, `OPENJACK_PROOF_CLEANUP_DRY_RUN=true|false`)

## Postgres schema

```bash
psql \"$SCANNER_DATABASE_URL\" -f /Users/ernesto/Documents/New\\ project/services/scanner/data/schema.sql
```
