# Pari-Mutuel PR13.1: Activation Readiness Scoreboard

Date: 2026-02-21  
Scope: non-activating readiness consolidation only (batch-first canonical policy)

## Policy Baseline
- Batch counting is canonical correctness + liveness path.
- Signature fast finalize is optional acceleration only.
- No activation discussion proceeds while any blocker is FAIL.

Primary blocker source:
- `docs/PARI_MUTUEL_IMPL_PR13_ACTIVATION_BLOCKERS.md`

## Scoreboard (B1-B8)
| Blocker | Status | Evidence | Notes / Next Action |
|---|---|---|---|
| `B1` Batch-canonical invariants locked and green | PASS | `docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md`; `cargo test -p openjack --lib --features canonical-freeze-prototype` (76 passed in latest runs) | Invariants for first-valid-finalize-wins, post-finalization immutability, binding integrity, and bounty conservation are traced and green. |
| `B2` Batch progress operations playbook exists | PASS | `scripts/count-batch-status.mjs`; `scripts/count-batch-failures.mjs`; `scripts/prototype-run-count-batch.mjs`; `scripts/rehearse-count-batch-activation.mjs`; `docs/PARI_MUTUEL_IMPL_PR8_BATCH_PROGRESS_OBSERVABILITY.md`; `docs/PARI_MUTUEL_IMPL_PR17_RUNNER_OPS_POLICY.md`; `docs/PARI_MUTUEL_IMPL_PR18_REHEARSAL_RUNBOOK.md` | Status + hard-fail diagnosis workflows exist, runner profitability/failover policy is documented with stable machine-parseable output, and one-command rehearsal produces audit-grade artifacts. |
| `B3` Signature fast-path trust model approved | PASS | `docs/PARI_MUTUEL_IMPL_PR13_SIGNATURE_FAST_PATH_TRUST_MODEL.md` | Trust assumptions, key policy, rotation/revocation, and monitoring are documented; fast path remains non-canonical. |
| `B4` ZK status explicitly resolved | N/A (batch-canonical activation) | `docs/PARI_MUTUEL_IMPL_PR12_GATE_A_REPORT.md`; `docs/PARI_MUTUEL_IMPL_PR13_2_ZK_RECHECK_REPORT.md`; `reports/protocol-gate/zk-recheck-build-1771716980604.json`; `docs/PARI_MUTUEL_IMPL_PR13_ZK_RECHECK_GATES.md` | Final empirical re-check executed. `ZK_RECHECK = FAIL` because runtime feasibility gate R1 failed (missing verifier primitive path). For batch-canonical activation this blocker is explicitly out of scope (N/A), and ZK remains parked until a new verifier strategy is approved. |
| `B5` No activation bypasses | PASS | `docs/PARI_MUTUEL_IMPL_PR13_ACTIVATION_BLOCKERS.md`; `docs/PARI_MUTUEL_PHASE2_CHECKLIST.md` | No governance timeout bypass, no deadline shortcut, no bundled economics change path documented. |
| `B6` Two-lane authority + guarantee language lock | PASS | `docs/PARI_MUTUEL_IMPL_PR14_ACTIVATION_PLAN.md`; `docs/PARI_MUTUEL_IMPL_PR14_USER_GUARANTEES.md` | Canonical claimability authority (batch) and fast readiness signal-only lane are explicitly separated in activation/guarantee docs. |
| `B7` Settlement bounty economics lock | PASS (prototype impl + policy) | `docs/PARI_MUTUEL_IMPL_PR14_ACTIVATION_PLAN.md`; `docs/PARI_MUTUEL_IMPL_PR15_BOUNTY_ACCOUNTING_REPORT.md` | Activation economics and deterministic reward rules are documented and prototype-implemented with invariant tests; still non-activating. |
| `B8` Round solvency floor invariant enforced | PASS (prototype) | `docs/PARI_MUTUEL_IMPL_PR13_ACTIVATION_BLOCKERS.md`; `programs/openjack/src/solvency.rs`; `cargo test -p openjack --lib --features canonical-freeze-prototype` (80 passed) | Centralized solvency helper is wired into round debit paths and covered by arithmetic sequencing/edge tests plus mixed-mode protocol tests. |

## Activation Decision
- Current result: **PROTOTYPE READY (batch-canonical baseline)**
- Reason: batch-canonical blockers are PASS; `B4` is explicitly N/A for this activation lane.

## Rehearsal Evidence (PASS)
1. Multi-round suite PASS artifact:
   - `reports/protocol-gate/activation-rehearsal-suite-1771779958870.json`
2. Final clean sanity rerun PASS artifact (same IDs, locked profile):
   - `reports/protocol-gate/activation-rehearsal-suite-1771781562242.json`
3. Latest 5-round PASS artifact (regression guard enabled):
   - `reports/protocol-gate/activation-rehearsal-suite-1771806831505.json`
   - gate snapshot: `roundsMeetMinimum=true`, `suiteSloPass=true`, `regressionGuardPass=true`
4. Code state anchor:
   - `f2ec132`
5. Rehearsal profile notes:
   - deterministic `ClientOffsetOutOfRange` classification is locked as non-retryable
   - adaptive downshift is enabled to prevent retry loops on invalid batch windows
6. Locked baseline env (redacted-safe, no keys/paths):
   - `OPENJACK_REHEARSAL_ROUND_IDS=1771776441,1771776801,1771777601,1771778155,1771774597`
   - `OPENJACK_SUITE_STRESS_BATCH_LEN=3`
   - `OPENJACK_SUITE_STRESS_REMAINING_THRESHOLD=36`
   - `OPENJACK_RUNNER_FORCE_COMPLETE_REMAINING=40` (runner-only liveness override; no protocol behavior change)

## Required To Move To GO
1. Keep batch-canonical path as activation baseline.
2. Enforce PR19 rehearsal suite SLO thresholds and PASS artifacts before any activation recommendation.
3. Re-open ZK only with a new runtime/verifier strategy proposal and fresh gate plan.

## Non-Activating Statement
This document does not authorize activation or change protocol behavior. It only consolidates readiness status under the batch-canonical policy.
