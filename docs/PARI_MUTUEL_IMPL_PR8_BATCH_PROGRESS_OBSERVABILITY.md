# Phase 2 Implementation PR8: Batch Progress Observability

Date: 2026-02-21  
Scope: prototype-gated only; no settlement activation, no migration, no fast-path verifier changes.

## Delivered
- Added prototype count observability fields on `Round`:
  - `count_batches_accepted`
  - `count_batches_noop_replay`
  - `count_last_result_code`
  - `count_last_result_count`
- Added prototype event:
  - `CountBatchObserved` in `/Users/ernesto/Documents/New project/programs/openjack/src/events.rs`
  - emitted from `count_batch` with:
    - `processed`, `total`, `remaining`
    - last result code + streak count
    - accepted/noop replay counters
- Added single read surface script:
  - `/Users/ernesto/Documents/New project/scripts/count-batch-status.mjs`
  - package alias: `npm run count-batch:status`
- Added hard-fail visibility summary script:
  - `/Users/ernesto/Documents/New project/scripts/count-batch-failures.mjs`
  - package alias: `npm run count-batch:failures`

## One-line status format
- Example output:
  - `COUNTING: 1200/100000 (1.20%) remaining=98800 lastResult=NoopReplay resultCount=3`
- Current result code mapping:
  - `Accepted` (`count_batch` advanced progress)
  - `NoopReplay` (idempotent replay accepted as no-op)
- `None` (no successful batch outcome recorded yet)

Hard-fail summary output:
- Example:
  - `COUNT_BATCH_FAILS: round=1771718700 inspected=100 failed=2 latest=CountReplayMismatch classes=CountReplayMismatch=2`

## Important semantics note
- Solana transaction rollback means failed instructions cannot persist state.
- Therefore this PR records stable on-chain "last result" for successful count transitions only.
- Hard-fail error classes remain observable via tx logs/RPC simulation paths, not persisted in round state.

## Semantics safety checks
- No changes to counting state-machine gates.
- No deadline coupling introduced.
- Invariant tests remain passing, with additional observability checks:
  - `count_batch_observability_does_not_mutate_progress_semantics`
  - `count_batch_replay_same_batch_is_idempotent_noop` (counter assertions)
  - `count_batch_replay_last_batch_after_finalized_is_noop` (counter assertions)

## Validation
- `cargo test -p openjack --lib --features canonical-freeze-prototype` => pass (`69` tests)
- `cargo test -p openjack --lib` => pass (`33` tests)
- Status script run (prototype round `1771718700`) =>  
  `COUNTING: 0/8 (0.00%) remaining=8 lastErr=None errCount=0`
