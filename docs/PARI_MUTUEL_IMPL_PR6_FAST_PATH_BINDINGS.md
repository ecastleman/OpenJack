# Phase 2 Implementation PR6: Fast-Path Interface + Binding Guards (Feature-Gated)

## Scope
- Feature-gate context:
  - `canonical-freeze-prototype` only.
- Behavior change summary:
  - Extends `finalize_counts_fast_path` to accept explicit bound inputs:
    - `round_id`
    - `ticket_set_root`
    - `ticket_count_frozen`
    - `winning_main`
    - `winning_bonus`
    - `tier_winner_counts`
    - `mock_verifier_ok` (prototype-only verifier placeholder)
  - Adds strict binding validation with specific error codes per mismatch class.
  - Preserves PR5 semantics:
    - first valid finalize wins
    - replay-safe post-finalization behavior
    - no deadline coupling
- Out-of-scope:
  - Real verifier integration
  - Settlement activation
  - Migration
  - Governance/timeout bypass

## Code Paths
- `/Users/ernesto/Documents/New project/programs/openjack/src/lib.rs`
- `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs`
  - `FinalizeCountsFastPathArgs`
  - `finalize_counts_fast_path`
  - `apply_finalize_counts_fast_path`
  - `validate_fast_path_bindings`
- `/Users/ernesto/Documents/New project/programs/openjack/src/errors.rs`

## Acceptance Evidence
Positive-path:
- `finalize_counts_fast_path_marks_terminal_count_state`

Negative-path (specific mismatch failures):
- `finalize_counts_fast_path_rejects_round_id_mismatch`
- `finalize_counts_fast_path_rejects_ticket_set_root_mismatch`
- `finalize_counts_fast_path_rejects_ticket_count_mismatch`
- `finalize_counts_fast_path_rejects_winning_main_mismatch`
- `finalize_counts_fast_path_rejects_winning_bonus_mismatch`
- `finalize_counts_fast_path_rejects_tier_winner_count_mismatch_on_replay`
- `finalize_counts_fast_path_rejects_mock_verifier_false`

Post-finalization invariants unchanged:
- `finalize_counts_fast_path_replay_is_noop_and_immutable`
- `count_batch_after_fast_path_finalized_rejects_new_range`
- `count_batch_replay_last_batch_after_finalized_is_noop`

## Guardrail Check
- No deadline coupling introduced.
- No migration introduced.
- No settlement activation introduced.
- No governance escape hatch introduced.
