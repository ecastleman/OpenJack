# Pari-Mutuel Phase 2 Traceability Bundle

Date: 2026-02-20  
Scope: prototype-gated docs trace map

## Trace Table
| Requirement | Source Doc Section | Enforcing Test/Measurement | PASS/FAIL Criterion |
|---|---|---|---|
| Canonical-source definition is single and consistent | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_CHECKLIST.md` Section 1 | Text consistency check across: checklist/spec/feasibility memo/go-no-go memo | PASS if sentence is identical and code pointers match. FAIL if any divergence exists. |
| `CLOSED_PENDING_FREEZE` is permissionless and retryable | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_CANONICAL_COUNT_SPEC_DRAFT.md` `CLOSED_PENDING_FREEZE` policy section | Policy lock + round freeze behavior tests in `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` | PASS if retries are allowed and failures are state-unchanged. FAIL if timeout or blocked retries appear. |
| No governance escape hatch in Phase 2 | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_CHECKLIST.md` Sections 2 and Exit Criteria | Checklist/task-board scope checks | PASS if no governance override is added. FAIL if any governance/manual override appears in Phase 2 docs. |
| Mutual exclusion (buy vs freeze) | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md` `INV-01` | Buy status gates in purchase tests + freeze gating in round freeze tests | PASS if no reachable state permits both successful buy and freeze. FAIL otherwise. |
| Freeze replay determinism | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md` `INV-02` | `apply_prototype_freeze_commits_then_is_idempotent_on_retry`; `apply_prototype_freeze_rejects_commitment_mismatch` | PASS if replay is no-op/equality-check or deterministic mismatch reject only. FAIL if divergent commitment appears. |
| Caller independence | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md` `INV-03` | `freeze_commitment_is_derived_only_from_round_state_not_caller_timing` | PASS if caller/timing do not change commitment. FAIL if they do. |
| Multi-caller determinism | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md` `INV-04` | `multi_caller_race_order_keeps_same_canonical_commitment_state` | PASS if canonical fields converge independent of caller order. FAIL otherwise. |
| Error taxonomy is 1:1 with recovery semantics | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_ERROR_TAXONOMY.md` | Row-level trace to `errors.rs`, enforcing line in `round.rs`, and test trace/`TEST_MISSING` | PASS if each error maps to exactly one policy with required semantics/recovery. FAIL if ambiguous or incomplete. |
| Rent envelope (+64B) is measured and bounded | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_P2_05_RENT_MEASUREMENT.md` | RPC measurement commands + observed outputs + computed delta | PASS if delta is positive and fits +64B envelope. FAIL otherwise. |
| CU guardrails locked (`B=3`, `B=6`, `B=7` opt-in) | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_IMPLEMENTATION_CHECKLIST.md` | CU evidence artifact `/Users/ernesto/Documents/New project/reports/protocol-gate/count-batch-cu-summary-1771655463798.json` | PASS if defaults match locked constants and change-gate requires new artifact. FAIL otherwise. |
| Canonical derivation input changes require spec+test updates | `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_IMPLEMENTATION_CHECKLIST.md` | Documentation gate (spec + checklist + `round.rs` tests) | PASS if all three updates are required. FAIL if any bypass path exists. |

## Coverage Notes
- `TEST_MISSING` entries in taxonomy are explicit and remain visible risk markers until test PRs add coverage.
- This trace bundle is documentation-level compliance for Phase 2 planning and does not modify protocol behavior.
