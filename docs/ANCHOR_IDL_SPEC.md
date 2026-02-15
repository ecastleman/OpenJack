# OpenJack Anchor IDL-First Specification (v0 draft)

## Program

- Name: `openjack`
- Network target: Solana mainnet-beta (devnet during prelaunch)
- Token of account: native SOL (lamports)

## Constants

- `MAX_TICKETS_PER_TX = 100`
- `MAX_TICKETS_PER_WALLET_PER_ROUND = 10_000`
- `MAIN_N = 50`
- `MAIN_K = 5`
- `BONUS_N = 10`
- `TIER_COUNT = 5` (excluding jackpot)

### Revenue splits

- `TREASURY_BPS = 200`
- `LOWER_POOL_BPS = 1300`
- `JACKPOT_BPS = 8500`

### Lower-tier internal splits (of lower pool)

- `T5_ONLY_BPS = 4500`
- `T4_BONUS_BPS = 2500`
- `T4_ONLY_BPS = 1500`
- `T3_BONUS_BPS = 1000`
- `T2_BONUS_BPS = 500`

## Accounts

### LotteryConfig (PDA: `["config"]`)

Fields:
- `authority: Pubkey`
- `treasury_pubkey: Pubkey`
- `official_scanner_pubkey: Pubkey`
- `vrf_callback_authority: Pubkey`
- `scanner_bond_lamports: u64`
- `scanner_slash_lamports: u64`
- `sol_usd_oracle: Pubkey`
- `oracle_max_age_secs: u32`
- `ticket_price_usd_cents: u32` (default 200)
- `finder_fee_bps: u16`
- `cadence_min_gap_secs: u32`
- `cadence_max_gap_secs: u32`
- `bump: u8`

### Round (PDA: `["round", round_id_le]`)

Fields:
- `round_id: u64`
- `status: u8` (`OPEN=0,CLOSED=1,DRAWING=2,SETTLING=3,FINALIZED=4`)
- `open_ts: i64`
- `close_ts: i64`
- `draw_ts: i64`
- `settle_deadline_ts: i64`
- `tree_address: Pubkey`
- `ticket_count: u32`
- `sales_lamports: u64`
- `treasury_paid_lamports: u64`
- `jackpot_pool_balance: u64`
- `tier_pool_balances: [u64;5]`
- `winners_pool_balance: u64`
- `unclaimed_pool_balance: u64`
- `winning_main: [u8;5]`
- `winning_bonus: u8`
- `vrf_request: Pubkey`
- `tier_winner_counts: [u32;6]`
- `tier_payout_per_winner: [u64;6]`
- `tier_remainders: [u64;6]`
- `roots: [[u8;32];6]`
- `roots_committed_mask: u8`
- `scanner_commitment_hash: [u8;32]`
- `scanner_observed_ticket_count: u32`
- `finalized_ts: i64`
- `bump: u8`

### UserRoundStats (PDA: `["user_round", round_id_le, user_pubkey]`)

Fields:
- `tickets_bought: u32`
- `bump: u8`

### ClaimRecord (PDA: `["claim", round_id_le, leaf_index_le]`)

Fields:
- `claimer: Pubkey`
- `tier: u8`
- `amount: u64`
- `claimed_ts: i64`
- `source_pool: u8` (`WINNERS=0,UNCLAIMED=1`)
- `bump: u8`

### WinnerRecord (PDA: `["winner", round_id_le, tier_u8, leaf_index_le]`)

Fields:
- `registered_by: Pubkey`
- `registered_ts: i64`
- `bump: u8`

### ScannerBond (PDA: `["bond", round_id_le]`)

Fields:
- `posted: bool`
- `amount: u64`
- `slashed: u64`
- `bump: u8`

### Vault PDAs

- `jackpot_vault`: `["vault", round_id_le, "jackpot"]`
- `winners_vault`: `["vault", round_id_le, "winners"]`
- `unclaimed_vault`: `["vault", round_id_le, "unclaimed"]`

## Instructions

### Config

- `init_config(args)`
- `set_official_scanner(new_scanner)`
- `set_treasury(new_treasury)`
- `set_oracle(new_oracle, max_age_secs)`
- `set_vrf_callback_authority(new_authority)`

### Round lifecycle

- `create_round(round_id, open_ts, close_ts, tree_address)`
- `close_round(round_id)`
- `request_draw(round_id, vrf_request)`
- `fulfill_draw(round_id, vrf_request, vrf_result)`
  - verifies callback signer against `vrf_callback_authority`
  - verifies `vrf_request` matches the one stored during `request_draw`
  - derives `winning_main` and `winning_bonus` deterministically from `vrf_result`
- `finalize_prizes(round_id)`

### Purchases

- `buy_tickets(round_id, tickets)`
  - Validates selection constraints and caps.
  - Uses SOL/USD oracle with max-age guard.
  - Splits payment into treasury/jackpot/lower-tier pools.
  - Emits one `TicketPurchased` event per ticket.

### Scanner and settlement

- `post_scanner_bond(round_id)`
- `publish_winner_root(round_id, tier, root_hash, winner_count, observed_ticket_count, commitment_hash)`
- `challenge_omitted_winner(round_id, leaf_index, expected_tier, ticket_payload, proofs)`

### Claims and sweeping

- `claim(round_id, leaf_index, tier, recipient, proofs)`
- `sweep_winners_to_unclaimed(round_id)`

## Events

- `TicketPurchased`
  - `round_id, leaf_index, main[5], bonus, purchaser, paid_lamports, ts`
- `RoundStatusChanged`
  - `round_id, from_status, to_status, ts`
- `DrawFulfilled`
  - `round_id, winning_main[5], winning_bonus, vrf_request, ts`
- `WinnerRootPublished`
  - `round_id, tier, root_hash, winner_count, observed_ticket_count, ts`
- `WinnerChallenged`
  - `round_id, tier, leaf_index, challenger, slash_lamports, ts`
- `Claimed`
  - `round_id, leaf_index, claimer, tier, amount, source_pool, ts`
- `SweptToUnclaimed`
  - `round_id, amount, ts`

## Errors (initial set)

- `InvalidRoundState`
- `RoundClosed`
- `RoundNotClosable`
- `TooManyTicketsPerTx`
- `WalletRoundCapExceeded`
- `InvalidMainNumbers`
- `InvalidBonusNumber`
- `OracleStale`
- `OracleInvalid`
- `VrfUnauthorized`
- `VrfReplay`
- `SettlementWindowOpen`
- `SettlementWindowClosed`
- `ScannerBondMissing`
- `ScannerUnauthorized`
- `TierOutOfRange`
- `WinnerProofInvalid`
- `OwnershipProofInvalid`
- `AlreadyClaimed`
- `NotTicketOwner`
- `SweepNotReady`
- `MathOverflow`

## Initial invariants to enforce

- Sum of revenue split legs equals ticket payment.
- `tier_pool_balances` never negative.
- Claim amount equals configured payout per tier at finalize.
- One claim max per `leaf_index` per round.
- Finalize executes once.
- No parameter mutation affecting active round economics.
