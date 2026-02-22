# Phase 2 Implementation PR5: COUNT_FINALIZED State Machine Stub (Feature-Gated)

## Scope
- Feature-gate context:
  - `canonical-freeze-prototype` only.
- Behavior change summary:
  - Adds `finalize_counts_fast_path(...)` stub entrypoint (no verifier integration).
  - Establishes deterministic first-valid-finalize-wins behavior between fast-path finalize and batch path terminalization.
  - Preserves immutable/replay-safe post-finalization behavior.
- Out-of-scope:
  - Settlement activation.
  - Migration.
  - Governance escape hatch.
  - Timeout-based bypass.

## Checklist Linkage
- Phase 2 checklist:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_CHECKLIST.md`
- Invariant matrix:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md`
- Spec transition table:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_CANONICAL_COUNT_SPEC_DRAFT.md`

## Code Changes
1. New feature-gated instruction:
   - `/Users/ernesto/Documents/New project/programs/openjack/src/lib.rs`
   - `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`FinalizeCountsFastPath`, `finalize_counts_fast_path`)
2. Internal finalize helper:
   - `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`apply_finalize_counts_fast_path`)
3. Determinism/post-finalization guards remain in batch path:
   - `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`apply_count_batch`)

## Test Evidence
- `cargo test -p openjack --lib --features canonical-freeze-prototype` -> `61 passed`
- New PR5 tests:
  - `finalize_counts_fast_path_marks_terminal_count_state`
  - `finalize_counts_fast_path_short_circuits_partial_batch_progress`
  - `finalize_counts_fast_path_replay_is_noop_and_immutable`
  - `count_batch_after_fast_path_finalized_rejects_new_range`

## Guardrail Check
- No deadline coupling introduced.
- No migration changes introduced.
- No settlement activation changes introduced.
- No governance/manual escape hatch introduced.
