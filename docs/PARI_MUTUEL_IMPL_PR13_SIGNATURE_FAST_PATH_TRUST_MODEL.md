# Pari-Mutuel PR13: Signature Fast-Path Trust Model

Date: 2026-02-21  
Scope: policy/trust documentation for optional acceleration path

## Role of Signature Fast Path
- Signature fast finalize is an acceleration layer only.
- It is not the canonical correctness path.
- Batch counting remains canonical and permissionless.

## Trust Assumptions
1. A verifier key (or key set) signs fast-path public input digests.
2. On-chain finalize verifies:
  - signature validity,
  - signer pubkey binding,
  - full round binding inputs.
3. Compromised/unavailable verifier keys must not block eventual correctness because batch path remains available.

## Key Policy
### Ownership
- Default: multisig-controlled key management authority (recommended).
- No single human key as production long-term policy.

### Rotation
- Rotation triggers:
  - scheduled hygiene interval,
  - suspected compromise,
  - operational incident.
- Rotation requirements:
  - explicit change log entry,
  - overlap/dual-sign validation window (if supported),
  - monitoring rule update in same change set.

### Revocation
- Emergency revocation playbook must exist before any activation:
  - disable fast-path attempts operationally,
  - switch to batch-only mode,
  - publish incident status for operators.

## Committee/Multisig Options
- Option A: single verifier pubkey (lowest complexity, higher trust concentration).
- Option B: threshold committee off-chain signature aggregation (recommended if operationally feasible).
- Option C: rotating signer set with strict audit log + dual-control approvals.

Recommendation:
- Start with controlled multisig-managed single key policy for prototype/prod-like prelaunch.
- Do not claim decentralized trust for signature fast path.

## Monitoring Expectations
Required metrics:
1. Fast-path attempt success rate.
2. Fast-path reject rate by error class.
3. Batch progress lag while fast path is enabled.
4. Verifier key mismatch incidents.

Alert thresholds (initial):
- any unexpected verifier pubkey mismatch in production-like runs -> page.
- sustained fast-path failure rate > 10% over rolling window -> degrade to batch-first mode.
- no finalized progress while both fast and batch runners idle -> page.

## Abuse/Failure Containment
- If fast path malfunctions or trust assumptions are violated:
  - mark fast path as degraded,
  - continue permissionless batch progression,
  - preserve no-dead-end and no-expiry guarantees.

## Activation Guard
- Fast path cannot be treated as required path in any user-facing guarantee.
- User guarantee remains batch-backed:
  - no trapped funds from fast-path outage,
  - eventual permissionless progress remains intact.
