# Phase 2 Implementation PR1: Freeze-Path Hardening (Feature-Gated)

## Scope
- Feature-gate context:
  - `canonical-freeze-prototype` only.
- Behavior change summary:
  - Refactor freeze preconditions into explicit validation helpers for deterministic policy enforcement.
  - Add missing freeze-path error tests (`RoundNotClosable`, `FreezeStateInvalid`, `FreezeSourceInvalid`, `MathOverflow`) to close taxonomy gaps.
  - Keep settlement flow and migration behavior unchanged.
- Out-of-scope:
  - Any migration/account rewrite.
  - Any settlement path changes.
  - Any governance/manual escape hatch.

## Checklist Linkage
- Phase 2 checklist:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_CHECKLIST.md`
- Task board item(s):
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_TASK_BOARD.md`
- Traceability row(s):
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_TRACEABILITY_BUNDLE.md`

## Gate Verification
- Canonical-source consistency:
  - Preserved; no changes to derivation inputs or canonical root formula.
- `CLOSED_PENDING_FREEZE` liveness policy preserved:
  - Preserved; retryable failures remain state-unchanged.
- No governance escape hatch introduced:
  - Confirmed.
- No timeout-based bypass introduced:
  - Confirmed.
- Error taxonomy impact:
  - Strengthened with direct test coverage for previously missing freeze-path errors.
  - Updated taxonomy trace links in `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_ERROR_TAXONOMY.md`.
- Rent/CU guardrail impact:
  - None (no change).

## Evidence
- Tests:
  - `cargo test -p openjack --lib --features canonical-freeze-prototype` (`45 passed`)
  - `cargo test -p openjack --lib` (`33 passed`)
  - Added tests in `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs`:
    - `begin_freeze_validation_rejects_before_close`
    - `begin_freeze_validation_rejects_wrong_state`
    - `apply_prototype_freeze_rejects_invalid_state`
    - `freeze_source_bounds_reject_inverted_range`
    - `apply_prototype_freeze_rejects_attempt_counter_overflow`
- Measurement artifacts:
  - Not applicable for this PR scope.
- Spec diffs:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_ERROR_TAXONOMY.md` (test trace updates).
