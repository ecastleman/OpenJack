# Pari-Mutuel Canonical Count: Feasibility Delta
Status: Pre-implementation feasibility review.

This document maps the draft architecture assumptions to the current codebase and marks each as:
- `SUPPORTED`
- `PARTIALLY_SUPPORTED`
- `REBUILD_LEVEL`

Companion draft:
- `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_CANONICAL_COUNT_SPEC_DRAFT.md`

## Canonical Source Definition (Phase 2 Lock)
Canonical source (one sentence):
- The canonical ticket-set commitment is deterministically derived from `Round` account state only (`round_id`, `tree_address`, `ticket_count`, `close_ts`, `leaf_start_index`, `leaf_end_index`) and written as `ticket_set_root`.

Code path pointer:
- Derivation function: `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`derive_prototype_ticket_set_root`)
- Commit/apply logic: `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`apply_prototype_freeze`, called by `freeze_ticket_set`)

## Executive Summary
1. Current system already has deterministic per-round `ticket_count` and per-ticket `leaf_index` assignment at purchase time.
2. Current system does **not** freeze a canonical `ticket_set_root` on-chain at close.
3. Current round model stores `tree_address` but not an immutable global leaf range boundary; this is the biggest feasibility gap for trust-minimized canonical freeze.
4. Deadline-orphan risk exists today because winner root publication is time-window-gated.
5. Proposed architecture is viable only if canonical freeze can be derived from program-maintained state without off-chain snapshot dependency.

## Assumption Mapping
| Assumption | Status | Current Evidence | Gap |
|---|---|---|---|
| Canonical ticket universe can be frozen at close from program state | `PARTIALLY_SUPPORTED` | Round has `tree_address`, `ticket_count` (`programs/openjack/src/state.rs`, `purchase.rs`) | No on-chain `ticket_set_root`; no immutable close-time range commitment |
| Commitment reproducible by independent verifier from on-chain data | `PARTIALLY_SUPPORTED` | Per-ticket deterministic `leaf_index` emitted on purchase (`purchase.rs`, `events.rs`) | Missing canonical root/range object in round state |
| Immutable round ticket boundaries after close | `PARTIALLY_SUPPORTED` | Buy requires `status == OPEN` and `now < close_ts` (`purchase.rs`) | If tree is shared across rounds, no explicit global `[start,end)` range commitment today |
| O(1) close transition for canonical freeze | `REBUILD_LEVEL` (as-is) | `close_round` is O(1) now (`round.rs`) | No maintained root accumulator/range metadata suitable for immediate freeze write |
| Permissionless on-chain fallback counting | `REBUILD_LEVEL` | Not present | Requires new state, new instructions, new proofs |
| Claim replay protection | `SUPPORTED` | `ClaimRecord` PDA exists (`claim.rs`) | Reuse in new design |

## Core Make-Or-Break: Canonical Freeze At Close
To meet the required bar:
1. Derived purely from program-maintained state.
2. No off-chain snapshot dependency for correctness.
3. No race conditions.
4. O(1) at close.
5. Immutable once stored.
6. Reproducible by independent verifier.

### Current-State Finding
Current code does not maintain a canonical ticket-set root inside round state.  
`close_round` currently only flips status (`programs/openjack/src/instructions/round.rs`).

### Feasible Paths
1. **Path A (Preferred): Dedicated per-round tree**
   - Guarantee each round has isolated tree namespace.
   - Freeze root as tree root + `ticket_count` at close.
   - Low ambiguity, cleaner audits.
2. **Path B: Shared tree with explicit per-round global range commitment**
   - Must store immutable global `start_leaf_global` and `end_leaf_global`.
   - Must prove mapping from round-local indexing to global append index.
   - Higher complexity and migration risk.

If neither A nor B can satisfy reproducibility without off-chain snapshots, architecture is blocked.

## Freeze Retry Semantics
Question: can freeze be retried, or must it succeed in close transition?

Recommended semantics:
1. `close_round` transitions to `CLOSED_PENDING_FREEZE` (buys disabled immediately).
2. `freeze_ticket_set` instruction finalizes canonical commitment.
3. `freeze_ticket_set` is idempotent and retryable until success.
4. No deadline on freeze itself.

Rationale:
1. Avoids fragile single-shot close dependency.
2. Preserves deterministic progression without allowing additional buys.
3. Keeps canonical correctness requirements explicit.

If freeze can be done atomically and safely inside close, this two-step model can be simplified.

## Batch Counting Correctness (No Skips / No Doubles)
Required properties:
1. `start == count_progress_index`.
2. Contiguous batch indices only.
3. All per-item proofs verified against canonical `ticket_set_root`.
4. Winner tier recomputed on-chain from draw result.
5. Full transaction reverts on any invalid element (no partial writes).

Current code does not implement this path. This is net-new.

## Anti-Grief: Minimal Vs Hardening
### Minimal viable (no bonds)
1. Strict in-order progress.
2. Reject too-small spam batches (except final tail).
3. Hard max batch by CU safety.
4. Whole-tx revert on invalid proofs.

### Optional hardening
1. Caller bond.
2. Slash for objectively invalid repeated submissions.
3. Optional rewards for successful progress txs.

Recommendation: ship minimal first, add bond/slash only if empirical abuse appears.

## Scale And Cost Envelope (Fallback Path)
Fallback tx count formula:
1. `T = ceil(N / B)`
2. `N` tickets, `B` verified leaves per tx.

Illustrative tx counts:

| Tickets (`N`) | Batch 64 | Batch 128 | Batch 256 |
|---:|---:|---:|---:|
| 100,000 | 1,563 | 782 | 391 |
| 1,000,000 | 15,625 | 7,813 | 3,907 |
| 10,000,000 | 156,250 | 78,125 | 39,063 |

Notes:
1. `B=256` may be aggressive depending on proof verification CU cost.
2. Practical `B` must be determined by benchmark in-program with realistic proof depth.
3. This makes zk fast path very valuable for UX at high scale.

Who pays:
1. Batch caller pays tx fees by default.
2. Optional protocol incentives can reimburse/fund progress contributors.

## Layered Fallback: Can Scanner Coexist?
Yes, as an optimization layer, not as trust anchor.

Safe layering:
1. Primary: canonical freeze + zk finalize.
2. Secondary: scanner assists by submitting proofs/aggregations.
3. Tertiary: permissionless batch fallback.

Unsafe layering:
1. Scanner commitment accepted without proof as authoritative source of truth.

Conclusion:
1. Scanner can coexist as an accelerator.
2. Scanner must not be required for correctness/liveness.

## Exact Entitlement Under Recovery
Normal recovery must preserve economics:
1. No sweeping winner pools to treasury as routine recovery.
2. Recovery means switching count-finalization mechanism, not changing payout rules.

If economics must be altered, that is governance break-glass, not normal protocol recovery.

## No-Orphan Property Check
Current orphan cause:
1. Root publish and finalize are both gated by settlement window boundary in opposite directions.
2. Missed roots by deadline => permanent `SETTLING` limbo.

Target property under new model:
1. From `DRAWN_COUNT_UNFINALIZED`, at least one permissionless path always remains available.
2. No deadline should simultaneously invalidate all finalization paths.

## Recommended Next Validation Work
1. Root freeze feasibility spike:
   - prove whether round-close can commit canonical root/range from program state.
2. CU benchmark spike:
   - measure proof verify cost/leaf to derive real safe `B`.
3. State transition proof:
   - enumerate all failure branches and show terminal reachability.
4. Migration impact:
   - evaluate whether current shared/dedicated tree usage requires structural change.

## Preliminary Decision Gate
Proceed to implementation planning only if all are true:
1. Canonical freeze derivation is on-chain reproducible without off-chain snapshot correctness dependency.
2. Freeze has retry-safe semantics (or atomic O(1) success guarantee).
3. Batch fallback can make bounded progress under realistic CU constraints.
4. Economic recovery policy keeps exact entitlement under normal operations.
