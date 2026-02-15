# OpenJack Milestone Plan and Test Gates

## M1: Core protocol skeleton (on-chain)

Deliverables:
- Anchor workspace and `openjack` program scaffold.
- Account definitions and round status machine.
- Deterministic split math utilities and invariants.

Test gates:
- Unit tests for status transitions (`OPEN->CLOSED->DRAWING->SETTLING->FINALIZED`).
- Property tests ensuring splits sum exactly and no overflow.
- Negative tests for illegal transitions and double-finalize.

## M2: Purchase path + pricing

Deliverables:
- `buy_tickets` with ticket validation and per-wallet/per-tx limits.
- Oracle integration and stale-price checks.
- Event emission for each ticket.

Test gates:
- Reject stale oracle updates.
- Reject malformed number selections.
- Enforce `100/tx` and `10,000/wallet/round` caps.
- Verify rounding mode (`ceil`) and split accounting.

## M3: Draw path (VRF)

Deliverables:
- `request_draw` and callback `fulfill_draw`.
- Deterministic winning number derivation from VRF bytes.
- Transition into settling with 1-hour deadline.

Test gates:
- Callback authorization and replay protection.
- Deterministic derivation snapshots from fixed VRF seeds.
- Draw unavailable before close.

## M4: Settlement roots + challenge/slash

Deliverables:
- Scanner bond posting and root publication per tier.
- Count commitments and observed ticket commitment hash.
- Omitted winner challenge that increments counts and slashes bond.

Test gates:
- Non-scanner root publish rejected.
- Missing bond blocks root publication.
- Valid omission challenge updates counts and applies slash.
- Invalid challenge proofs rejected.

## M5: Finalize + claims

Deliverables:
- Final payout-per-winner computation by tier.
- Claim path with cNFT existence + ownership + winner proof checks.
- Claim nullifier via `ClaimRecord` PDA.

Test gates:
- Payout math correctness across zero/non-zero winner counts.
- Double claim prevention.
- Non-owner cannot claim.
- Claims blocked before finalize.

## M6: Post-finalization lifecycle

Deliverables:
- 30-day winners-to-unclaimed sweep.
- Claim source routing (`winners` vs `unclaimed`).
- Optional yield-adapter interface scaffold.

Test gates:
- Sweep only after `finalized_ts + 30d`.
- Correct post-sweep fund source.
- Sweep idempotence and conservation of funds.

## M7: Off-chain services and UX integration

Deliverables:
- Scanner service with dual ingestion and reconciliation.
- API endpoints for rounds/pots/tickets/roots/claims preview.
- Seeker-first frontend flow for buy, draw, settle indicators, and claim.

Test gates:
- E2E devnet test: buy -> draw -> roots -> finalize -> claim.
- Reconciliation mismatch simulation with recovery path.
- Frontend smoke tests for primary user journeys.

## Exit criteria before mainnet

- External security audit findings resolved.
- Runbooks for oracle outage, VRF outage, and scanner incident tested.
- Multisig + timelock change management in place.
- Production observability dashboards and paging alerts active.
