# OpenJack API

Thin API with read endpoints, ingestion hooks, and tx-prepare endpoints.

Claimability contract:
- `GET /claims/estimate` returns versioned contract payload (`contractVersion`).
- Spec: `/Users/ernesto/Documents/New project/docs/CLAIMABILITY_CONTRACT.md`.

## Run

```bash
cd /Users/ernesto/Documents/New\ project/services/api
npm install
psql "$DATABASE_URL" -f /Users/ernesto/Documents/New\ project/services/api/data/schema.sql
node /Users/ernesto/Documents/New\ project/services/api/src/server.js
```

Environment:

- `PORT` (default `8080`)
- `INGEST_API_KEY` (default `dev-ingest-key`)
- `DATABASE_URL` (default `postgres://localhost:5432/openjack`)
- `RPC_URL`
- `OPENJACK_PROGRAM_ID`
- `OPENJACK_IDL_PATH`

`prepare/buy` now resolves treasury + oracle directly from on-chain `LotteryConfig` PDA.

## Ingest example

```bash
curl -X POST http://localhost:8080/ingest/round \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-ingest-key' \
  -d '{"roundId":43,"status":"OPEN"}'
```

Claim estimate ingest example:

```bash
curl -X POST http://localhost:8080/ingest/claim-estimate \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-ingest-key' \
  -d '{
    "roundId": 43,
    "wallet": "YourWalletPubkey",
    "estimatedLamports": 1000000,
    "tickets": [
      {
        "leafIndex": 12,
        "tier": 3,
        "amount": 1000000,
        "assetId": "CNFT_ASSET_ID",
        "winnerRootHash": "abc123",
        "winnerRootProof": ["..."],
        "ticketProof": ["..."],
        "ownershipProof": { "owner": "WalletPubkey", "delegate": null }
      }
    ]
  }'
```
