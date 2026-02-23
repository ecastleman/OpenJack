# CU Spike Status (Empirical `count_batch`)

Date: 2026-02-21  
Goal: replace claim-proxy assumptions with direct `count_batch` CU measurement on prototype deployment.

## Result

`PASS` for direct `count_batch` sampling on devnet using Alchemy RPC, after deploying prototype program id and enabling real membership verification path in `count_batch`:
- Program id: `BtTuYHeZ7r9KkWUrH4EgrkY29oPqfrLuhWWtWzrJCp8G`
- Frozen round used: `1771718700` (`ticketCountFrozen=8`, `status=CLOSED_FROZEN`)
- Harness report:
  - `reports/protocol-gate/count-batch-cu-benchmark-1771655463798.json`
- Summary artifact:
  - `reports/protocol-gate/count-batch-cu-summary-1771655463798.json`

## Measured CU (30 runs per batch size)

1. `B=1`: mean/p95/max `7342`
2. `B=2`: mean/p95/max `8873`
3. `B=3`: mean/p95/max `10404`
4. `B=4`: mean/p95/max `11934`
5. `B=5`: mean/p95/max `13465`
6. `B=6`: mean/p95/max `14995`
7. `B=7`: rejected by on-chain guard (`CountBatchTooLarge`, custom `6039`)

Observed model in this prototype verifier path:
- near-linear growth to `B=6` with approx `~1530 CU` additional per extra leaf in sampled range.

## Safety envelope (derived from empirical max model)

1. Under `200k` cap:
   - locked default remains `B=3` (conservative, unchanged)
2. Under `400k` cap:
   - locked default remains `B=6` (conservative, unchanged)
   - `B=7` remains aggressive opt-in only, and is currently blocked by on-chain prototype max-batch guard.

## Policy interpretation

1. Current defaults remain conservative and unchanged:
   - `B=3 @ 200k`
   - `B=6 @ 400k`
   - `B=7` aggressive opt-in only
2. This measurement supersedes prior digest-scaffold assumptions; it reflects the current real membership-verification prototype path.
3. Any future verifier-path change still requires remeasurement before changing `B`.
