# Pari-Mutuel PR15: Prototype Bounty Accounting Report

Date: 2026-02-22  
Scope: feature-gated (`canonical-freeze-prototype`) and non-activating.

## What PR15 Implements
1. Adds prototype-only round accounting fields:
   - `bounty_pool_balance`
   - `bounty_pool_initial`
   - `bounty_distributed_so_far`
2. Locks prototype ticket revenue split to:
   - `2%` treasury
   - `3%` bounty
   - `85%` jackpot
   - `10%` lower-tier pool
3. Freezes bounty baseline at canonical freeze:
   - `bounty_pool_initial = bounty_pool_balance`
   - `bounty_distributed_so_far = 0`
4. Pays bounty only on strict accepted count progress:
   - reward formula:
     - `max_distributable = floor(99% * bounty_pool_initial)`
     - `reward_per_ticket = floor(max_distributable / ticket_count_frozen)`
     - `reward = min(reward_per_ticket * delta_progress, remaining_distributable)`
5. Preserves replay/no-op semantics:
   - replay / no-op paths pay `0`
   - post-finalization paths cannot increase bounty distribution

## Invariants Locked
1. Conservation identity (all transitions):
   - `bounty_distributed_so_far + bounty_pool_balance == bounty_pool_initial`
2. Strict progress-only payout:
   - payout iff accepted transition with `delta_progress > 0` and not already finalized
3. Deterministic rounding:
   - total distributed never exceeds `floor(99% * bounty_pool_initial)`
   - remainder deterministically stays in `bounty_pool_balance`

Trace row: `INV-09` in `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md`.

## Worked Examples
### Example A (small N)
- Inputs:
  - `ticket_count_frozen = 3`
  - `bounty_pool_initial = 101`
- Computation:
  - `max_distributable = floor(101 * 99 / 100) = 99`
  - `reward_per_ticket = floor(99 / 3) = 33`
- If batches are `1` then `2`:
  - payout = `33 + 66 = 99`
  - carry = `2`
- Verified by test:
  - `count_batch_bounty_rounding_on_last_batch_never_overpays`

### Example B (large N)
- Inputs:
  - `ticket_count_frozen = 100_000`
  - `bounty_pool_initial = 3_000_000_000` lamports
- Computation:
  - `max_distributable = 2_970_000_000`
  - `reward_per_ticket = floor(2_970_000_000 / 100_000) = 29_700`
- For a batch with `delta_progress = 6`:
  - payout = `178_200` lamports
- For complete progress:
  - total distributed <= `2_970_000_000`
  - deterministic carry >= `30_000_000` plus floor remainder.

## Mixed-Mode Safety
`partial batch -> fast finalize -> replay/new-range` behavior is covered:
1. partial batch distributes only the earned amount,
2. fast finalize short-circuits count state to terminal,
3. replay/no-op pays zero,
4. new range is rejected,
5. distributed/carry totals remain unchanged post-finalize.

Trace test:
- `partial_batch_then_fast_finalize_blocks_additional_bounty`

## Test Evidence
Command:
```bash
cargo test -p openjack --lib --features canonical-freeze-prototype
```

Result in PR15 workspace:
- `76 passed, 0 failed`

New/updated bounty-focused tests:
1. `count_batch_bounty_conservation_is_monotonic_per_transition`
2. `count_batch_bounty_rounding_on_last_batch_never_overpays`
3. `count_batch_noop_replay_pays_zero_bounty`
4. `partial_batch_then_fast_finalize_blocks_additional_bounty`
5. `micro_batch_reward_scales_with_delta_progress`

## Non-Activation Statement
PR15 introduces prototype-gated accounting and tests only.  
No migration, no settlement activation, no governance timeout bypass.
