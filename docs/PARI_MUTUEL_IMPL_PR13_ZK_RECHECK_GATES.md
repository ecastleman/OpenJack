# Pari-Mutuel PR13: Final Empirical ZK Re-Check Gates

Date: 2026-02-21  
Scope: one final empirical viability re-check before parking ZK

## Preconditions
1. PR12 Gate A fail acknowledged:
   - `docs/PARI_MUTUEL_IMPL_PR12_GATE_A_REPORT.md`
2. Re-check is empirical (compile + invoke + measured CU/reliability), not API surface inference only.
3. Re-check remains non-activating.

## Re-Check Objective
Determine whether an actual proof-of-correctness path (Groth16-style target) is viable on target cluster(s) under practical CU and reliability limits.

## Required Re-Check Outputs
1. Build result:
   - minimal verifier compilation attempt outcome.
2. Invocation result:
   - successful verification invocation or deterministic failure reason.
3. Measured CU distribution:
   - mean / p95 / max.
4. Reliability sample:
   - success/failure counts and categorized failure causes.

Artifact paths:
- `reports/protocol-gate/zk-recheck-build-*.json`
- `reports/protocol-gate/zk-recheck-invoke-*.json`
- `reports/protocol-gate/zk-recheck-cu-*.json`
- `reports/protocol-gate/zk-recheck-reliability-*.json`

## PASS/FAIL Gates
### Gate R1: Runtime feasibility
PASS:
- verifier compiles and executes on target cluster path.
FAIL:
- cannot compile/invoke due to runtime primitive/support gaps.

### Gate R2: CU envelope
Target:
- p95 <= 120,000 CU
- max <= 160,000 CU
FAIL if exceeded.

### Gate R3: Reliability
Target:
- failure rate <= 1% on controlled run sample.
- failures categorized with deterministic retry guidance.
FAIL if unstable/noisy above threshold.

## Stop Policy
- If any gate fails: declare **NO-GO for ZK activation now** and park ZK path.
- Keep batch-canonical architecture unchanged.

## Decision Output
Single statement required:
- `ZK_RECHECK = PASS` or `ZK_RECHECK = FAIL`

No ambiguous middle state for activation decisions.
