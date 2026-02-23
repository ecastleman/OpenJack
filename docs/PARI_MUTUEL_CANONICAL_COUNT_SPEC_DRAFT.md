# Pari-Mutuel Canonical Count Spec (Draft)
Status: Draft for design review. Not implemented.

## Assumptions And Dependencies
This design is only viable if all items below are true:

1. The protocol can freeze a canonical round ticket universe at close, from program-maintained state.
2. The frozen commitment is reproducible by any verifier from on-chain data.
3. Round ticket leaves use a deterministic hash schema that binds:
   - `round_id`
   - `leaf_index`
   - ticket numbers (`main[5]`, `bonus`)
   - buyer owner key
   - optional asset identity binding (if required by claim model)
4. The protocol can enforce immutable round ticket boundaries after close:
   - either dedicated tree per round, or
   - fixed `[start_index, end_index)` range in a shared append-only tree.
5. Solana compute limits allow bounded per-batch proof verification (`O(batch_size * logN)`).
6. Existing claim replay protection (`ClaimRecord`) remains available.

If item 1 or 2 fails, this is rebuild-level work, not an incremental evolution.

## Canonical Source Definition (Phase 2 Lock)
Canonical source (one sentence):
- The canonical ticket-set commitment is deterministically derived from `Round` account state only (`round_id`, `tree_address`, `ticket_count`, `close_ts`, `leaf_start_index`, `leaf_end_index`) and written as `ticket_set_root`.

Code path pointer:
- Derivation function: `programs/openjack/src/instructions/round.rs` (`derive_prototype_ticket_set_root`)
- Commit/apply logic: `programs/openjack/src/instructions/round.rs` (`apply_prototype_freeze`, called by `freeze_ticket_set`)

## Goals
1. No permanent non-terminal round states after draw.
2. No trapped funds in unresolved settlement limbo.
3. Exact pari-mutuel payouts preserved under normal protocol recovery.
4. No dependency on scanner/keeper meeting a narrow deadline for correctness.
5. Permissionless progress from draw to payout-ready state.

## Non-Goals
1. Guaranteeing one-click instant claims immediately at draw for every round.
2. Eliminating all operational latency under severe chain congestion.

## User-Facing Guarantees
1. After draw, round settlement cannot dead-end permanently.
2. Anyone can permissionlessly advance settlement to exact payout-ready state.
3. Exact payouts are based on finalized global winner counts.
4. Funds are never permanently stuck in a non-terminal state.

Not guaranteed:
1. Immediate post-draw claim in all conditions.
2. Zero-delay finalization under network congestion.

## High-Level Architecture
Two settlement paths are bound to the same canonical ticket commitment:

1. Fast path: zk count proof verification (one-shot global counts).
2. Fallback path: permissionless deterministic batch counting on-chain.

Both paths output the same state artifact:
- `tier_winner_counts[6]`
- `counts_finalized = true`

Claims use finalized counts for exact pari-mutuel payouts.

## Canonical Ticket Set Freeze
### Commitment Object
At close, freeze:
1. `ticket_set_root`
2. `ticket_count`
3. `leaf_start_index` and `leaf_end_index` (if shared tree)
4. `close_slot`
5. `leaf_schema_version`

### Derivation Requirement
`ticket_set_root` must be derived from program-maintained state, not scanner snapshot.

Acceptable examples:
1. Dedicated round tree root at close.
2. Shared tree plus immutable leaf range committed by program at close.

Unacceptable:
1. Off-chain scanner-computed root committed without program-verifiable canonical source.

### Close-Time Liveness Requirement
Close transition must never depend on off-chain pipeline completion.
If root/range cannot be frozen atomically during close, this design is blocked.

## Proposed State Machine
```
OPEN
  -> CLOSED_PENDING_FREEZE
  -> CLOSED_ROOT_FROZEN
  -> DRAWN_COUNT_UNFINALIZED
  -> COUNT_FINALIZED
  -> CLAIMING
  -> FINALIZED_COMPLETE

DRAWN_COUNT_UNFINALIZED
  -> COUNT_FINALIZED          (fast-path finalize stub OR batch path)
  -> DRAWN_COUNT_UNFINALIZED  (partial batch progress)
```

Notes:
1. No deadline-based transition that can block both finalization paths.
2. `DRAWN_COUNT_UNFINALIZED` is live as long as at least one permissionless finalization path exists.
3. In current prototype implementation, `COUNT_FINALIZED` is represented by:
   - `count_finalized == true`
   - `count_progress_index == ticket_count_frozen`

### PR5 Transition/Test Trace Table
| Transition Rule | Enforcing Path | Test Trace |
|---|---|---|
| Fast-path finalize can set terminal count state from unfinalized state | `programs/openjack/src/instructions/round.rs` (`apply_finalize_counts_fast_path`) | `finalize_counts_fast_path_marks_terminal_count_state` |
| Fast-path finalize can short-circuit partial batch progress | `programs/openjack/src/instructions/round.rs` (`apply_finalize_counts_fast_path`) | `finalize_counts_fast_path_short_circuits_partial_batch_progress` |
| Fast-path replay after finalization is immutable no-op | `programs/openjack/src/instructions/round.rs` (`apply_finalize_counts_fast_path`) | `finalize_counts_fast_path_replay_is_noop_and_immutable` |
| Batch path can terminalize when progress reaches frozen count | `programs/openjack/src/instructions/round.rs` (`apply_count_batch`) | `count_batch_multi_batch_progress_reaches_finalized_end_state` |
| Batch mutation after fast-path finalization is deterministically rejected | `programs/openjack/src/instructions/round.rs` (`apply_count_batch`) | `count_batch_after_fast_path_finalized_rejects_new_range` |
| Batch replay of last accepted batch remains deterministic no-op post-finalization | `programs/openjack/src/instructions/round.rs` (`apply_count_batch`) | `count_batch_replay_last_batch_after_finalized_is_noop` |
| Fast-path finalize rejects any bound input mismatch with specific error | `programs/openjack/src/instructions/round.rs` (`validate_fast_path_bindings`) | `finalize_counts_fast_path_rejects_round_id_mismatch`; `finalize_counts_fast_path_rejects_ticket_set_root_mismatch`; `finalize_counts_fast_path_rejects_ticket_count_mismatch`; `finalize_counts_fast_path_rejects_winning_main_mismatch`; `finalize_counts_fast_path_rejects_winning_bonus_mismatch`; `finalize_counts_fast_path_rejects_tier_winner_count_mismatch_on_replay` |
| Fast-path finalize requires verifier acceptance bit in prototype mode | `programs/openjack/src/instructions/round.rs` (`apply_finalize_counts_fast_path`) | `finalize_counts_fast_path_rejects_mock_verifier_false` |

## `CLOSED_PENDING_FREEZE` Liveness Policy (Phase 2 Lock)
Normative policy:
1. `CLOSED_PENDING_FREEZE` is a permissionless-progress state.
2. Any caller may invoke `freeze_ticket_set`.
3. Failed freeze attempts are retryable and leave state unchanged.
4. No protocol deadline invalidates freeze retries.
5. No automatic timeout-based mode switch exists in this phase.
6. No governance/manual escape hatch is introduced in this phase.

Required invariants:
1. Buy/freeze mutual exclusion:
   - buys only while `OPEN`
   - freeze only while `CLOSED_PENDING_FREEZE` or `CLOSED_FROZEN`
2. Replay/versioning:
   - repeated freeze calls are deterministic no-op/equality-check or reject mismatch
   - no divergent canonical commitment for identical round state

## New/Extended Round State (Conceptual)
1. `ticket_set_root: [u8; 32]`
2. `ticket_count_frozen: u32`
3. `leaf_start_index: u32`
4. `leaf_end_index: u32`
5. `counts_finalized: bool`
6. `tier_winner_counts: [u32; 6]`
7. `count_progress_index: u32` (fallback path)
8. `counting_epoch: u32` (anti-replay/versioning)
9. `count_path_used: enum { NONE, FAST_PATH, BATCH }` (conceptual)

## Tier Count Finalization Paths
### Path A: Fast Path Finalization (PR5 stub)
Instruction: `finalize_counts_fast_path()`

Current PR5 status:
1. Implemented as feature-gated placeholder without external verifier integration.
2. Deterministically sets terminal count state (`count_progress_index=ticket_count_frozen`, `count_finalized=true`) when invoked first.
3. Replay-safe no-op after finalization.

Future upgrade target:
1. Replace placeholder validation with zk proof verification while preserving same terminal-state semantics.

Public inputs must bind:
1. `round_id`
2. `ticket_set_root`
3. `ticket_count_frozen`
4. draw result (`winning_main`, `winning_bonus`)
5. output `tier_winner_counts[6]`

On success:
1. set counts
2. `counts_finalized = true`
3. `count_path_used = FAST_PATH` (conceptual)

### Path B: Permissionless Batch Fallback
Instruction: `count_batch(start_index, batch_items[])`

Required checks:
1. `counts_finalized == false`
2. `start_index == count_progress_index`
3. `batch_items` are contiguous indices from `start_index`
4. each item verifies against `ticket_set_root` and leaf schema
5. each item winner tier is recomputed on-chain from draw result

Per-item verification input:
1. leaf payload (ticket data + owner + round binding + leaf index)
2. Merkle proof path to `ticket_set_root`

State update:
1. accumulate local per-tier deltas
2. apply deltas to `tier_winner_counts`
3. increment `count_progress_index`
4. if `count_progress_index == ticket_count_frozen`, set `counts_finalized = true`, `count_path_used = BATCH`

Atomicity:
1. Any invalid item reverts whole transaction.
2. No partial progress writes on failure.

Idempotency/resume:
1. Re-submit same valid batch at same start produces same post-state.
2. Anyone can continue from current `count_progress_index`.

## Fast-Path Retry Semantics
Design intent (normative):

1. `finalize_counts_fast_path` is permissionless and retryable.
2. No protocol-level wall clock wait rule between zk and batch paths.
3. Batch path is always available while `counts_finalized == false`.
4. First valid finalization path wins; post-finalization mixed-path attempts are no-op/equality-check or reject.

### 1) Permissionless, Retryable zk Finalize
`finalize_counts_fast_path` may be called any time after draw and before count finalization:

1. Allowed state: `DRAWN_COUNT_UNFINALIZED` and `counts_finalized == false`.
2. Failed proof / verifier unavailability / infra error:
   - instruction fails atomically
   - round state remains unchanged
   - caller (or any actor) can retry later
3. No protocol-level timeout that disables future zk attempts.

### 2) zk Short-Circuit Over Partial Batch Progress
If batch counting has partially progressed and a valid zk proof later arrives:

1. zk must verify against the same canonical `ticket_set_root`, `ticket_count_frozen`, and draw outcome.
2. On success:
   - overwrite/commit final authoritative `tier_winner_counts`
   - set `counts_finalized = true`
   - set `count_path_used = FAST_PATH`
   - set `count_progress_index = ticket_count_frozen`
3. After this, `count_batch` becomes no-op/equality-check or reject by rule.

### 3) Mutual Exclusion After Finalization
Once `counts_finalized == true`:

1. `finalize_counts_fast_path` must reject, or verify equality and no-op.
2. `count_batch` must reject, or no-op when proving already-finalized equality.
3. `tier_winner_counts` remain immutable after finalization.

### 4) No Cross-Path Dependency
Path independence requirements:

1. zk does not require batch to be untouched.
2. batch does not require zk availability.
3. Either path can finalize as long as `counts_finalized == false`.
4. No hidden state-machine dependency where one path blocks the other pre-finalization.

## Batch Correctness: No Skips, No Doubles
No skips:
1. strict contiguous range check
2. strict `start_index == count_progress_index`

No doubles:
1. processed indices are strictly monotonic
2. past indices cannot be replayed because start must match progress

No silent under/over-count:
1. each provided leaf must verify against canonical root
2. winner tier is recomputed on-chain, not trusted from caller
3. batch delta is derived by program, not user input

## Anti-Grief Strategy
### Minimal Viable (No Bonds)
1. reject out-of-order ranges
2. reject tiny spam batches below configurable `MIN_BATCH_SIZE` except final tail batch
3. enforce hard `MAX_BATCH_SIZE` for CU safety
4. whole-tx revert on invalid proofs

### Optional Hardening (Bond/Slash Layer)
1. optional caller bond for batch submission
2. slash on objectively invalid proof spam beyond threshold
3. optional reward share for successful batch contributors

This layer is optional and should not be required for base liveness.

## Cost Model (Draft)
Variables:
1. `N` = frozen ticket count
2. `B` = effective batch size
3. `T_batch = ceil(N / B)`

Fallback finalization tx count:
1. `T_batch`

Example:
1. `N = 100,000`
2. `B = 500`
3. `T_batch = 200`

Who pays:
1. Caller of each batch tx pays normal transaction fee.
2. Optional protocol incentives can reimburse or reward progress contributors.

User experience when zk unavailable:
1. round enters batch counting mode
2. claims wait for `counts_finalized = true`
3. progress is visible and permissionless

Target: rare fallback path; fast path handles normal case.

## Failure Branches And Terminal Completeness
Failure branch handling:
1. zk verifier unavailable -> fallback batch path remains available.
2. interrupted batch run -> resume from `count_progress_index`.
3. invalid batch attempts -> revert, no progress corruption.
4. mixed path attempt after finalize -> rejected (`counts_finalized == true`).

No non-terminal dead state claim:
1. From `DRAWN_COUNT_UNFINALIZED`, at least one permissionless finalization path exists.
2. Once `counts_finalized == true`, claims become exact and deterministic.

## Economic Policy
Normal protocol recovery:
1. Must preserve exact pari-mutuel entitlement.
2. Must not sweep winner pools to treasury/carryover as routine liveness action.

Governance break-glass:
1. Separate path for catastrophic protocol failures only.
2. Explicitly outside normal guarantee scope.
3. Requires strict governance controls (timelock, supermajority, evented reason).

## Invariants (Must Hold)
1. `ticket_set_root` and `ticket_count_frozen` are immutable after close.
2. `count_progress_index` monotonic non-decreasing.
3. `count_progress_index <= ticket_count_frozen`.
4. `counts_finalized => count_progress_index == ticket_count_frozen` for batch path.
5. After `counts_finalized`, `tier_winner_counts` immutable.
6. Claim payout for a ticket is deterministic function of:
   - frozen pools at payout source,
   - finalized `tier_winner_counts`,
   - ticket tier,
   - claim replay state.
7. Conservation of funds across round pools and claims.

## Operational Considerations
1. Publish progress endpoint for batch finalization (`processed/total`).
2. Alerting when round remains `DRAWN_COUNT_UNFINALIZED` beyond SLO target.
3. Track `count_path_used` metrics to detect zk path degradation.

## Audit Checklist
1. Canonical root freeze correctness and immutability.
2. Leaf schema collision resistance and domain separation.
3. Batch counting index monotonicity and replay resistance.
4. Proof verification soundness (zk and Merkle paths).
5. Claim replay protection under concurrent claims.
6. Fund conservation and overflow checks.
7. State transition totality (no dead-end branches).
8. Break-glass governance controls and abuse resistance.

## Open Questions
1. Is close-time canonical root freeze feasible with current cNFT tree plumbing, or does it require structural migration?
2. What verifier stack (if any) is acceptable for zk in Solana CU limits?
3. What batch size yields best liveness under devnet/mainnet congestion envelopes?
4. Do we need contributor incentives for fallback finalization?
