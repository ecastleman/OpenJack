# Pari-Mutuel PR13: Activation Blockers (Batch-Canonical Baseline)

Date: 2026-02-21  
Scope: governance/activation readiness checklist only (no behavior changes)

## Canonical Architecture Lock
1. Batch counting is canonical correctness + liveness path.
2. Signature fast finalize is optional acceleration only.
3. No activation decision may assume fast path availability.

## Blockers (Must All Be Cleared)

### B1. Batch-canonical invariants locked and green
- Required:
  - `INV-06` first-valid-finalize-wins semantics remain deterministic.
  - `INV-07` post-finalization immutability remains enforced.
  - `INV-08` fast-path binding integrity remains explicit and tested.
- Evidence:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md`
  - `cargo test -p openjack --lib --features canonical-freeze-prototype`

### B2. Batch progress operations playbook exists
- Required:
  - one-command status visibility (`processed/total/remaining`, last result counters)
  - one-command hard-fail diagnosis workflow (tx logs/simulation summary)
- Evidence:
  - `/Users/ernesto/Documents/New project/scripts/count-batch-status.mjs`
  - `/Users/ernesto/Documents/New project/scripts/count-batch-failures.mjs`

### B3. Signature fast-path trust model approved
- Required:
  - verifier key ownership policy
  - rotation/revocation workflow
  - multisig/committee option and escalation
  - monitoring + alert thresholds
- Evidence:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR13_SIGNATURE_FAST_PATH_TRUST_MODEL.md`

### B4. ZK status explicitly resolved
- Required:
  - PR12 Gate A result acknowledged (`FAIL`)
  - final empirical Groth16 viability re-check run on target cluster(s)
  - explicit PASS/FAIL outcome with stop policy
- Evidence:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR12_GATE_A_REPORT.md`
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR13_ZK_RECHECK_GATES.md`

### B5. No activation bypasses
- Required:
  - no governance timeout bypass
  - no deadline-based fallback-to-finalization shortcut
  - no economics changes bundled with activation review

### B6. Two-lane authority + guarantee language lock
- Required:
  - fast path explicitly classified as readiness signal only
  - canonical claim unlock explicitly classified as batch authority only
  - user guarantee language approved and linked
- Evidence:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR14_ACTIVATION_PLAN.md`
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR14_USER_GUARANTEES.md`

### B7. Settlement bounty economics lock
- Required:
  - activation economics split documented: 2% treasury, 3% bounty, 85% jackpot, 10% lower-tier pools
  - deterministic reward accounting rules documented (99% distributed, 1% carry-forward)
  - optional Earn/Help Finalize UX requirement documented
- Evidence:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR14_ACTIVATION_PLAN.md`

## Activation Decision Policy
- If any blocker is open: **NO-GO**.
- If all blockers are cleared:
  - fast path may be enabled only as acceleration,
  - batch remains canonical and always operable.
