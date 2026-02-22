# Phase 2 Implementation PR3: Batch CU Harness + Progress Invariants (Feature-Gated)

## Scope
- Feature-gate context:
  - `canonical-freeze-prototype` only.
- Behavior change summary:
  - Adds realistic per-leaf verification work digest to `count_batch` scaffold.
  - Adds simulation-based CU benchmark harness for `count_batch`.
  - Adds multi-batch progress invariant tests (skip/double-count/idempotency/finalization end-state).
- Out-of-scope:
  - Settlement activation.
  - Migration.
  - Fast-path (zk) changes.

## Checklist Linkage
- Phase 2 checklist:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_CHECKLIST.md`
- Task board item(s):
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_TASK_BOARD.md`
- Traceability row(s):
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_TRACEABILITY_BUNDLE.md`

## Gate Verification
- Canonical-source consistency:
  - Preserved; no changes to freeze canonical derivation inputs.
- `CLOSED_PENDING_FREEZE` liveness policy preserved:
  - Preserved; no deadline coupling introduced in batch scaffold.
- No governance escape hatch introduced:
  - Confirmed.
- No timeout-based bypass introduced:
  - Confirmed.
- Error taxonomy impact:
  - Added batch-scaffold-specific errors for monotonic/replay/work verification only.
- Rent/CU guardrail impact:
  - No policy constant changes (`B=3`, `B=6`, `B=7 opt-in`) in this PR.

## Evidence
- Tests:
  - `cargo test -p openjack --lib --features canonical-freeze-prototype` (`56 passed`)
  - `cargo test -p openjack --lib` (`33 passed`)
  - Added progress invariant tests in `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs`:
    - `count_batch_multi_batch_progress_reaches_finalized_end_state`
    - `count_batch_replay_last_batch_after_finalized_is_noop`
    - `count_batch_after_finalized_new_range_rejected`
    - `count_batch_rejects_skip_ahead`
    - `count_batch_rejects_double_count_old_range`
    - `count_batch_replay_same_batch_is_idempotent_noop`
- Measurement harness:
  - `/Users/ernesto/Documents/New project/scripts/count-batch-cu-benchmark.mjs`
  - Initial prototype benchmark report (digest scaffold era):
    - `/Users/ernesto/Documents/New project/reports/protocol-gate/count-batch-cu-benchmark-1771634536555.json`
  - Initial derived envelope summary:
    - `/Users/ernesto/Documents/New project/reports/protocol-gate/count-batch-cu-summary-1771634571668.json`
  - Superseding real-membership-path benchmark:
    - `/Users/ernesto/Documents/New project/reports/protocol-gate/count-batch-cu-benchmark-1771655463798.json`
  - Superseding summary:
    - `/Users/ernesto/Documents/New project/reports/protocol-gate/count-batch-cu-summary-1771655463798.json`
  - Historical blocked attempt (pre-prototype deployment on `Cnra...` layout):
    - `/Users/ernesto/Documents/New project/reports/protocol-gate/count-batch-cu-benchmark-blocked-1771633507.json`
- Spec diffs:
  - Not required; no activation or policy changes in this PR.
