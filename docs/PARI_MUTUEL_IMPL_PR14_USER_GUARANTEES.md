# Pari-Mutuel PR14: User Guarantee Language (Batch-Canonical)

Date: 2026-02-22  
Scope: product/legal-facing guarantee draft language (non-activating)

## Canonical Guarantee (User-Facing)
1. Claimability is determined by canonical on-chain batch finalization state.
2. A fast “ready-soon” signal may appear before claimability unlock.
3. A fast signal is not a claim unlock by itself.
4. If fast path is unavailable, canonical batch progression still provides eventual unlock.
5. No deadline-based expiry can remove the canonical completion path.

## UI Copy Guardrails
Use these semantic distinctions consistently:
- `Ready soon (accelerated signal)` = fast-path signal only.
- `Claimable now` = canonical batch-finalized authority only.
- Never map `not claimable yet` to `not a winner`.

## Allowed Status Vocabulary
1. `CANONICAL_CLAIMABLE_NOW`
2. `CANONICAL_NOT_FINALIZED_YET`
3. `FAST_SIGNAL_READY_SOON`
4. `FAST_SIGNAL_UNAVAILABLE`
5. `WINNER_PENDING_CANONICAL_FINALIZATION`
6. `NOT_A_WINNER`

## Prohibited Messaging
1. Do not state “claim now” from fast-path-only state.
2. Do not imply funds are blocked if fast path is offline.
3. Do not conflate acceleration failures with entitlement loss.

## Settlement Incentive Guarantee Language
1. A fixed bounty pool funds permissionless canonical settlement progress.
2. Reward is proportional to verified canonical progress.
3. No reward is paid for no-op or replay calls.
4. Remaining undistributed bounty carries forward by deterministic accounting rules.

## Operator Guarantee
1. Official runner may be active at launch.
2. Protocol remains permissionless for third-party participants to progress settlement.
3. Disabling fast path does not disable canonical completion.

## Non-Activating Statement
This document defines user-guarantee language requirements. It does not alter contract behavior by itself.
