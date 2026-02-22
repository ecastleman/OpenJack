# Pari-Mutuel PR12b: Post-Gate-A Alternatives

Date: 2026-02-21  
Baseline: PR12 Gate A = FAIL for planned BN254/pairing primitive path

## Context
We confirmed no usable BN254/pairing verifier primitive in the currently targeted runtime/toolchain path for the intended Groth16-style on-chain verification route.

This memo compares viable next paths without violating current constraints:
- no activation,
- no economics changes,
- no governance/timeout bypass.

## Option A: Build Custom In-Program ZK Verifier
Description:
- Implement verifier arithmetic inside program code (no runtime primitive dependency).

Pros:
- Maintains proof-of-correctness goal on current chain path.
- Keeps permissionless finalize shape.

Cons:
- Very high implementation complexity.
- Very high audit surface and cryptographic correctness risk.
- High CU risk; likely difficult to meet practical p95/max targets.
- Longer timeline and higher maintenance burden.

Assessment:
- Feasible in theory, high execution risk.
- Not recommended as immediate next step.

## Option B: Keep Current Architecture (Batch as Canonical Liveness Path) + Fast-Path Non-ZK Acceleration
Description:
- Keep current permissionless batch counting as correctness/liveness backbone.
- Keep signature-bound fast path as plumbing/integration aid only (non-activation).
- Invest in batch throughput, tooling, observability, and operator ergonomics.

Pros:
- No dead-end states preserved.
- Lowest protocol risk from current baseline.
- Immediate practical progress with known components.

Cons:
- Does not deliver cryptographic one-shot proof-of-correctness for global counts.
- Large rounds remain operationally heavier than desired fast path.

Assessment:
- Strong short/mid-term default.
- Best risk-adjusted path while verifier primitive is unavailable.

## Option C: Retarget to Environment with Supported ZK Verifier Primitive
Description:
- Plan fast path around an execution environment/runtime where target verifier primitive exists.

Pros:
- Preserves intended ZK architecture.
- Potentially better CU envelope for verify path.

Cons:
- Strategic/platform scope expansion.
- Requires additional integration, ops, and audit work.
- Timeline uncertainty.

Assessment:
- Valid long-term path if ZK fast path is mandatory.
- Not immediate unless platform change is acceptable.

## Option D: Optimistic/Challenge-Based Off-Chain Counts as Primary
Description:
- Off-chain count publication with dispute/challenge instead of direct proof verification.

Pros:
- Potentially lower on-chain verification cost.

Cons:
- Reintroduces liveness/game-theory complexity.
- Higher product ambiguity and dispute UX complexity.
- Risk of reintroducing deadline-style fragility if poorly designed.

Assessment:
- Not preferred given current “no orphan / deterministic recovery” goals.

## Recommendation
Recommended next path: **Option B now, Option C evaluated in parallel**.

1. Keep batch fallback as canonical correctness/liveness path.
2. Treat current fast-path verifier plumbing as non-activating scaffolding only.
3. Improve batch throughput envelope and operational tooling for scale.
4. Track runtime verifier primitive availability as an external dependency gate for true ZK fast path.

## Suggested Immediate Work (non-activating)
1. Batch performance hardening at larger synthetic scales (1M/10M simulation model updates).
2. End-to-end ops playbook for forced progress and failure diagnosis.
3. Explicit activation blocker list in one place:
   - missing runtime verifier primitive
   - verifier CU/latency unknown for true ZK path
   - unresolved audit scope for custom verifier alternative.

## Decision Framing
- If requirement is “cryptographic one-shot proof on current runtime immediately”: **NO-GO**.
- If requirement is “no trapped funds + deterministic permissionless progress now”: **GO with batch-canonical path** while ZK fast path remains blocked by runtime capability.
