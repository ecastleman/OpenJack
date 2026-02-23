# Phase 2 Implementation PR7: Real Membership Verification in `count_batch`

Date: 2026-02-21  
Scope: prototype-gated only; no settlement activation, no migration, no governance/timeout bypass.

## What Changed
- Replaced digest-only `count_batch` scaffold checks with per-leaf membership verification against frozen `ticket_set_root`.
- Added canonical prototype Merkle helpers in `programs/openjack/src/instructions/round.rs`:
  - deterministic leaf schema hash
  - canonical tree folding
  - membership verification by sibling path + index direction
- Extended `CountBatchArgs` with `leaf_proofs` payload and bound `batch_hash` to provided proof material.
- Updated benchmark + runner scripts to generate matching leaf proofs:
  - `scripts/count-batch-cu-benchmark.mjs`
  - `scripts/prototype-run-count-batch.mjs`

## Invariants Preserved
- Monotonic progress index (`count_progress_index`) remains enforced.
- Replay/idempotency semantics unchanged.
- Skip-ahead and double-count rejection unchanged.
- No deadline coupling introduced.
- Feature-gated under canonical-freeze prototype path.

## Test Evidence
- `cargo test -p openjack --lib --features canonical-freeze-prototype` => pass (`68` tests).
- `cargo test -p openjack --lib` => pass (`33` tests).
- Existing invariant tests for count progress/replay/finalization remain passing with real proofs.

## CU Measurement (Real Membership Path)
- Frozen prototype round: `1771718700` (`ticketCountFrozen=8`).
- Benchmark report:
  - `reports/protocol-gate/count-batch-cu-benchmark-1771655463798.json`
- Summary artifact:
  - `reports/protocol-gate/count-batch-cu-summary-1771655463798.json`

Observed (30 simulations per size):
- `B=1..6`: successful, max observed CU at `B=6` = `14995`.
- `B=7`: rejected by on-chain guard (`CountBatchTooLarge`, custom `6039`).

Policy impact:
- Locked defaults remain unchanged:
  - `B=3 @ 200k`
  - `B=6 @ 400k`
  - `B=7` aggressive opt-in only (currently blocked by on-chain max-batch guard).
