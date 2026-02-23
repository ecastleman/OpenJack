# Pari-Mutuel PR17: Batch Runner Profitability + Ops Policy

Date: 2026-02-22  
Scope: feature-gated, non-activating.

## Runner Decision Policy
The canonical batch runner uses conservative net estimation:

1. `reward_est` is derived from on-chain prototype bounty state:
   - `max_distributable = floor(99% * bounty_pool_initial)`
   - `reward_per_ticket = floor(max_distributable / ticket_count_frozen)`
   - `reward_est = min(reward_per_ticket * batch_len, remaining_distributable)`
2. `fee_est` is conservatively modeled:
   - `fee_est = ceil(base_fee_lamports * expected_retries * fee_multiplier_bps / 10_000)`
3. `net_est = reward_est - fee_est`
4. Submit/skip decision:
   - submit if `net_est >= min_net_lamports`
   - or submit if force-complete is enabled and `remaining <= force_complete_remaining`

## Liveness-Completion Policy
Near completion, profitability gating cannot stall canonical progress:

1. Force-complete mode can bypass `min_net_lamports` for the final `N` tickets.
2. Official bot should run force-complete mode by default at launch.
3. Permissionless runners may keep stricter profitability thresholds.

## Error Handling Taxonomy
Runner maps errors into auditable policy classes:

1. `retryable` (continue with refreshed round state):
   - `CountProgressGap`, `CountReplayMismatch`, `BlockhashNotFound`, `Timeout`, `TransactionExpiredBlockheightExceededError`, unknown classes.
2. `hard_stop` (stop after threshold):
   - `CountBatchTooLarge`, `CountBatchMembershipInvalid`, `CountBatchWorkMismatch`, `CountBatchOutOfBounds`, `ClientOffsetOutOfRange`, `InstructionSerializationOutOfRange`, `FreezeStateInvalid`, `InvalidRoundState`, `RoundSolvencyFloorViolated`, `CountBatchBountyRentViolation`, `CountBatchBountyRecipientInvalid`.

### Deterministic Client Build Errors
`ClientOffsetOutOfRange` is treated as non-retryable for the same payload and is emitted at `stage=build` with a full request tuple:

1. Tuple fields:
   - `start_index`: the attempted batch start.
   - `remaining`: `expected_total - start_index` at attempt time.
   - `expected_total`: `ticket_count_frozen`.
   - `requested_batch_len` / `page_size`: attempted batch width.
   - `stress_mode`: whether stress policy selected this width.
2. Why non-retryable:
   - this class indicates deterministic client-side serialization/build bounds, not transient RPC liveness.
   - resubmitting the same tuple repeats the same failure.
3. Adaptive downshift behavior:
   - on `ClientOffsetOutOfRange`, runner reduces batch size (`N -> N-1`) and retries with a new tuple.
   - it never loops on the same invalid tuple.
   - this preserves progress while keeping the canonical window invariant: `start_index + batch_len <= expected_total`.

## Stable Machine Output Contract
Runner emits parseable `key=value` lines only:

1. Decision line:
   - `event=COUNT_BATCH_RUNNER ... decision=submit|skip reason=...`
2. Success tx line:
   - `event=COUNT_BATCH_RUNNER_TX ... sig=...`
3. Error line:
   - `event=COUNT_BATCH_RUNNER_ERROR class=... policy=retryable|hard_stop ...`
4. Completion line:
   - `event=COUNT_BATCH_RUNNER_DONE ... finalized=true|false`
5. Correlation:
   - every decision/tx/error line includes `attempt_id=<round>-<seq>`
   - startup config is emitted once as `event=COUNT_BATCH_BOT_CONFIG ...`

## Official Bot Wrapper/Profile
1. Wrapper:
   - `/Users/ernesto/Documents/New project/scripts/official-count-batch-bot.mjs`
2. Profile defaults:
   - `/Users/ernesto/Documents/New project/config/profiles/official-bot.env`
3. Dry-run mode:
   - `OPENJACK_BOT_DRY_RUN=true npm run count-batch:bot`
   - emits decision lines only (no submit).

## Minimal Collector
1. Collector:
   - `/Users/ernesto/Documents/New project/scripts/collect-count-batch-logs.mjs`
2. Purpose:
   - transforms `key=value` runner lines into JSONL.
3. Optional file sink:
   - set `OPENJACK_COLLECT_OUT=reports/...jsonl` to append records.

## Regression Guard
B8 anti-drift guard remains required:

- `npm run check:round-solvency`

This guard fails if a new round-lamport debit callsite is introduced in instruction code without `assert_round_solvency_floor`.
