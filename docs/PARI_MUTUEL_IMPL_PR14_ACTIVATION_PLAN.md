# Pari-Mutuel PR14: Batch-Canonical Activation Plan

Date: 2026-02-22  
Scope: activation stance + policy language only (non-activating document)

## 1) Activation Stance (Locked)
1. Batch counting is canonical correctness and claimability authority.
2. Signature fast path is optional acceleration only.
3. No ZK dependency is required for activation.
4. Settlement incentives (bounty pool) are part of activation economics.

## 2) Two-Lane Model (Authority Separation)
### Lane A: Canonical Claimability (Batch)
- Only canonical count finalization is allowed to unlock on-chain claimability.
- Economic authority for payout unlock is batch-canonical state progression.
- User guarantees are anchored to this lane only.

### Lane B: Fast Readiness Signal (Signature Fast Path)
- May provide immediate tier-count/readiness signal.
- Must not be presented as “funds claimable now” unless canonical lane is finalized.
- Can be disabled operationally without affecting eventual correctness/liveness.

Policy translation:
- Fast path = readiness signal.
- Batch path = payout unlock authority.

## 3) Activation Economics: Settlement Bounty Pool
Target per-ticket split for activation economics:
- `2%` treasury
- `3%` settlement bounty
- `85%` jackpot
- `10%` lower-tier pools (existing internal subdivision retained)

Note:
- This is activation-plan economics policy. It is not a code change by itself.

## 4) Bounty Accounting Mechanics (Deterministic)
Let:
- `N = ticket_count_frozen`
- `P = bounty_pool`

Per-ticket reward basis:
- `reward_per_ticket = floor((99% of P) / N)`

Per successful `count_batch` reward:
- `reward = delta_progress * reward_per_ticket`
- `delta_progress = new_progress - old_progress`

Rules:
1. Reward is paid only when progress strictly advances.
2. No reward for replay/no-op transitions.
3. No initial bond requirement (can be introduced later if abuse appears).
4. `1%` of bounty remains undistributed each round and carries forward in bounty pool accounting.
5. At canonical finalization, distributed bounty is deterministic and bounded by progress.

## 5) Product/UX Integration Requirements
Add optional “Earn / Help Finalize” surface with:
1. Total bounty pool for round.
2. Remaining bounty.
3. Current canonical progress percentage.
4. Estimated reward for next batch.
5. Estimated tx cost.
6. Estimated net profit.

UX guard:
- Normal ticket users must not be required to use this screen.
- Official runner bot may operate by default at launch, while system remains permissionless.

## 6) Activation Gate Mapping
Before any activation discussion:
1. Two-lane authority language is present in user guarantees.
2. Bounty split and deterministic accounting model are approved.
3. Monitoring and fast-path trust model are approved.
4. Batch canonical invariants remain green.

## 7) Non-Activating Statement
This document does not modify protocol behavior. It formalizes activation policy and guarantee language requirements for follow-on implementation/release gating.
