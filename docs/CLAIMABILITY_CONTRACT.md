# OpenJack Claimability Contract (v1)

Contract version: `2026-02-19.v1`

Primary endpoint:
- `GET /claims/estimate?roundId=<id>&wallet=<pubkey>`

## Purpose

This contract freezes the machine-readable claimability surface used by frontend and automation.
It separates:
- winner presence (`winnerTickets`)
- current claim readiness (`claimableTickets`)
- deterministic non-claimable reasons (`readinessReasons`)

Rule: "No claimable tickets" must never be interpreted as "No wins".

## Response Shape

```json
{
  "contractVersion": "2026-02-19.v1",
  "wallet": "<base58>",
  "roundId": 1771522414,
  "roundStatus": 4,
  "winnerTickets": 6,
  "claimableTickets": 6,
  "nonClaimableWinnerTickets": 0,
  "estimatedLamports": 1715000000,
  "potentialLamports": 1715000000,
  "readinessReasons": [],
  "nonClaimableReasonCounts": {},
  "tickets": [
    {
      "leafIndex": 0,
      "tier": 0,
      "amount": 1487500000,
      "claimable": true,
      "readinessReasons": []
    }
  ]
}
```

## Enums (Stable)

`CLAIMABILITY_REASON` values:
- `ROUND_NOT_FINALIZED`
- `NOT_WINNER`
- `PENDING_PROOF`
- `PROOF_FAILED`
- `ALREADY_CLAIMED`
- `OWNER_MISMATCH`
- `PAYOUT_NOT_READY_OR_ZERO`
- `INGESTION_NOT_READY`

These values are machine-facing and must remain stable for UI logic.
Copy/text shown to users must be mapped separately.

## Field Semantics

- `winnerTickets`:
  count of winner ticket entries returned in `tickets`.
- `claimableTickets`:
  count of tickets with `claimable=true` and `readinessReasons=[]`.
- `nonClaimableWinnerTickets`:
  `winnerTickets - claimableTickets`.
- `estimatedLamports`:
  lamports currently claim-ready (`claimable` subset).
- `potentialLamports`:
  lamports across all winner tickets whether currently claimable or not.
- `readinessReasons`:
  top-level reasons for empty/global states.
  Typical examples: `NOT_WINNER`, `ROUND_NOT_FINALIZED`, `INGESTION_NOT_READY`.
- `nonClaimableReasonCounts`:
  reason histogram across non-claimable winner tickets only.
- `tickets[].readinessReasons`:
  deterministic reason list (sorted, unique).

## Invariants (Must Hold)

1. `contractVersion` is exactly `2026-02-19.v1`.
2. `winnerTickets === tickets.length`.
3. `claimableTickets === count(tickets where readinessReasons.length === 0)`.
4. `nonClaimableWinnerTickets === winnerTickets - claimableTickets`.
5. `tickets[].claimable` is equivalent to `tickets[].readinessReasons.length === 0`.
6. Every reason key in response is in `CLAIMABILITY_REASON`.

## Compatibility Policy

- Additive, backward-compatible fields do not require version bump.
- Any enum rename/removal or invariant change requires a new `contractVersion`.
- CI contract tests must pass for every merge.
