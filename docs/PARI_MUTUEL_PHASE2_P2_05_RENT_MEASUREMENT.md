# P2-05 Rent Measurement Artifact

Date: 2026-02-20  
Scope: prototype-gated, docs/measurement-only

## Inputs
- Current `Round` size (bytes): `616`
- Proposed planning size (bytes): `680` (`616 + 64` guardrail)

## Reproducible Commands
### 1) Measure current `Round` size (bytes)
```bash
cargo run --offline --quiet --manifest-path /tmp/openjack-round-size-probe/Cargo.toml
```
Observed output:
```text
616
```

### 2) Rent-exemption minimum via Alchemy devnet RPC
Size = 616:
```bash
curl --max-time 20 -sS -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getMinimumBalanceForRentExemption","params":[616]}' \
  'https://solana-devnet.g.alchemy.com/v2/REDACTED'
```
Observed output:
```json
{"jsonrpc":"2.0","result":5178240,"id":1}
```

Size = 680:
```bash
curl --max-time 20 -sS -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getMinimumBalanceForRentExemption","params":[680]}' \
  'https://solana-devnet.g.alchemy.com/v2/REDACTED'
```
Observed output:
```json
{"jsonrpc":"2.0","result":5623680,"id":1}
```

## Computation
- `rent_min(616)` = `5,178,240` lamports
- `rent_min(680)` = `5,623,680` lamports
- Delta = `rent_min(680) - rent_min(616)` = `445,440` lamports

## PASS/FAIL (Checklist Rule)
Checklist rule:
- PASS if measured rent delta is positive and fits the +64-byte planning envelope.
- FAIL if measured rent delta does not fit the +64-byte planning envelope.

Result:
- **PASS**
- Reason: delta for the proposed `+64B` size is positive (`445,440`) and exactly corresponds to the planning envelope measurement (`616 -> 680`).
