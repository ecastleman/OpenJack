# Pari-Mutuel Phase 2 Error Taxonomy (Freeze Path)

Date: 2026-02-20  
Scope: prototype-gated, docs-only (no behavior changes)

Policy constraints:
- One error -> one policy class only (`RETRYABLE` or `HARD_STOP`).
- No timeout-based bypass.
- No governance escape hatch in Phase 2.

## Mapping Table (1:1)
| Error | Policy Class | Retryable State Semantics | Hard-Stop Recovery Guidance | Error Definition Trace | Enforcement Trace | Test Trace |
|---|---|---|---|---|---|---|
| `RoundNotClosable` | `RETRYABLE` | State unchanged on failure; retry allowed after `now >= close_ts`. | N/A | `/Users/ernesto/Documents/New project/programs/openjack/src/errors.rs:10` | `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`validate_begin_freeze_state`) | `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`begin_freeze_validation_rejects_before_close`) |
| `FreezeStateInvalid` | `RETRYABLE` | State unchanged on failure in freeze apply path; retry allowed once round reaches a valid freeze state. | N/A | `/Users/ernesto/Documents/New project/programs/openjack/src/errors.rs:70` | `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`validate_begin_freeze_state`, `apply_prototype_freeze`) | `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`begin_freeze_validation_rejects_wrong_state`, `apply_prototype_freeze_rejects_invalid_state`) |
| `FreezeCommitmentMismatch` | `HARD_STOP` | N/A | Treat as integrity violation. Do not bypass with timeout. Investigate canonical-input divergence/state corruption, patch root cause, and only then resume freeze progression. | `/Users/ernesto/Documents/New project/programs/openjack/src/errors.rs:72` | `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs:291` (`apply_prototype_freeze`) | `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs:505` (`apply_prototype_freeze_rejects_commitment_mismatch`) |
| `FreezeSourceInvalid` | `HARD_STOP` | N/A | Treat as state/config defect. No timeout bypass. Requires code/data correction before progress. | `/Users/ernesto/Documents/New project/programs/openjack/src/errors.rs:74` | `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`validate_freeze_source_bounds`) | `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`freeze_source_bounds_reject_inverted_range`) |
| `MathOverflow` (freeze path) | `HARD_STOP` | N/A | Treat as implementation defect. No timeout bypass. Patch arithmetic path and re-validate before resume. | `/Users/ernesto/Documents/New project/programs/openjack/src/errors.rs:58` | `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`apply_prototype_freeze`) | `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`apply_prototype_freeze_rejects_attempt_counter_overflow`) |

## PASS/FAIL Gate for P2-04
PASS:
1. Every freeze-path error maps to exactly one policy class.
2. Retryables explicitly state “state unchanged on failure.”
3. Hard-stops include explicit recovery guidance and forbid timeout bypass.
4. Every row includes definition trace + enforcement trace + test trace or `TEST_MISSING`.

FAIL:
1. Any error maps to multiple policy classes.
2. Retryable row lacks state-unchanged semantics.
3. Hard-stop row lacks recovery guidance.
4. Any row lacks traceability.
