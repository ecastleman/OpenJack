# Phase 2 Implementation PR2: Batch Fallback Scaffolding (Feature-Gated)

## Scope
- Feature-gate context:
  - `canonical-freeze-prototype` only.
- Behavior change summary:
  - Adds `count_batch` instruction skeleton and internal batch-progress scaffold.
  - Adds monotonic progress index checks, replay/idempotency guards, and out-of-bounds protections.
  - Adds invariant tests for skip/double-count prevention and no deadline coupling.
- Out-of-scope:
  - Settlement activation.
  - Migration/account upgrade execution.
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
  - Preserved; no changes to `ticket_set_root` derivation formula or inputs.
- `CLOSED_PENDING_FREEZE` liveness policy preserved:
  - Preserved; no timeout checks introduced in batch scaffold path.
- No governance escape hatch introduced:
  - Confirmed.
- No timeout-based bypass introduced:
  - Confirmed.
- Error taxonomy impact:
  - Freeze-path taxonomy unchanged.
  - Added batch-specific error codes for scaffold invariants only.
- Rent/CU guardrail impact:
  - No guardrail value changes.
  - No activation of settlement path.

## Evidence
- Tests:
  - `cargo test -p openjack --lib --features canonical-freeze-prototype` (`51 passed`)
  - `cargo test -p openjack --lib` (`33 passed`)
  - New scaffold invariant tests in `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs`:
    - `count_batch_advances_progress_monotonically`
    - `count_batch_rejects_skip_ahead`
    - `count_batch_replay_same_batch_is_idempotent_noop`
    - `count_batch_replay_with_mismatch_rejected`
    - `count_batch_rejects_double_count_old_range`
    - `count_batch_is_not_deadline_coupled`
- Measurement artifacts:
  - Not applicable for this PR scope.
- Spec diffs:
  - Not required in this scaffold PR (no settlement activation or canonical-source changes).
