# OpenJack UI State Model (Contract-Driven)

This document maps backend claimability contract states to deterministic UX states.

## Design Principle

Single responsive app (mobile and desktop) with one backend contract and one design system.
No separate product logic by form factor.

## Canonical UX States

Derived from `GET /claims/estimate` contract:

1. `NOT_WINNER`
- Condition:
  - `winnerTickets = 0`
  - `readinessReasons` includes `NOT_WINNER`
- UX:
  - Message: no winning tickets this round.
  - Do not show claim CTA.

2. `WINNER_PENDING_PROOF`
- Condition:
  - ticket reason includes `PENDING_PROOF`
- UX:
  - Winner visible.
  - Claim CTA disabled.
  - Show "proof hydration in progress" copy.

3. `WINNER_ALREADY_CLAIMED`
- Condition:
  - ticket reason includes `ALREADY_CLAIMED`
- UX:
  - Show claimed badge and tx link if available.
  - Claim CTA hidden/disabled.

4. `WINNER_OWNER_MISMATCH`
- Condition:
  - ticket reason includes `OWNER_MISMATCH`
- UX:
  - Show ownership mismatch state.
  - Explain entitlement follows current owner.

5. `ROUND_NOT_FINALIZED`
- Condition:
  - top-level or ticket reason includes `ROUND_NOT_FINALIZED`
- UX:
  - Show "claim opens after finalize".
  - No claim submission allowed.

6. `INGESTION_NOT_READY`
- Condition:
  - top-level or ticket reason includes `INGESTION_NOT_READY`
- UX:
  - Show "results still syncing".
  - No claim submission until ready.

7. `CLAIMABLE`
- Condition:
  - ticket `readinessReasons=[]`
- UX:
  - Claim CTA enabled.
  - Batch claim enabled when one or more claimable tickets exist.

## Copy Mapping Rule

Machine state must be mapped to copy in a separate translation layer.
Never branch UI copy off ad hoc string parsing outside the enum map.

## Wallet-First State Layer

Global app states:
- `DISCONNECTED`
- `CONNECTED`
- `WRONG_NETWORK`
- `TX_PENDING`
- `TX_CONFIRMED`
- `TX_FAILED`

Claim action states:
- `IDLE`
- `SUBMITTING`
- `CONFIRMING`
- `SUCCESS`
- `ERROR_RETRYABLE`

## Responsive Product Requirement

Mobile and desktop share:
- same contract
- same state machine
- same components/tokens
- same feature set

Desktop may expose richer diagnostics, but not different claimability logic.
