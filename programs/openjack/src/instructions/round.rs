use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::constants::SETTLEMENT_WINDOW_SECS;
use crate::errors::OpenJackError;
use crate::events::{DrawFulfilled, RoundStatusChanged};
use crate::state::{LotteryConfig, Round, RoundStatus};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateRoundArgs {
    pub round_id: u64,
    pub open_ts: i64,
    pub close_ts: i64,
    pub tree_address: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RequestDrawArgs {
    pub vrf_request: Pubkey,
}

#[derive(Accounts)]
#[instruction(args: CreateRoundArgs)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, LotteryConfig>,
    #[account(
        init,
        payer = authority,
        seeds = [b"round".as_ref(), args.round_id.to_le_bytes().as_ref()],
        bump,
        space = 8 + std::mem::size_of::<Round>()
    )]
    pub round: Account<'info, Round>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
pub struct RequestDraw<'info> {
    pub config: Account<'info, LotteryConfig>,
    #[account(mut)]
    pub round: Account<'info, Round>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FulfillDrawArgs {
    pub vrf_request: Pubkey,
    pub vrf_result: [u8; 32],
}

#[derive(Accounts)]
pub struct FulfillDraw<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = vrf_callback_authority)]
    pub config: Account<'info, LotteryConfig>,
    pub vrf_callback_authority: Signer<'info>,
    #[account(mut)]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
pub struct FinalizePrizes<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

pub fn create_round(ctx: Context<CreateRound>, args: CreateRoundArgs) -> Result<()> {
    let round = &mut ctx.accounts.round;
    round.round_id = args.round_id;
    round.status = RoundStatus::Open as u8;
    round.open_ts = args.open_ts;
    round.close_ts = args.close_ts;
    round.tree_address = args.tree_address;
    round.bump = ctx.bumps.round;
    Ok(())
}

pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let now = Clock::get()?.unix_timestamp;
    require!(
        round.status == RoundStatus::Open as u8,
        OpenJackError::InvalidRoundState
    );
    require!(now >= round.close_ts, OpenJackError::RoundNotClosable);
    round.status = RoundStatus::Closed as u8;
    emit!(RoundStatusChanged {
        round_id: round.round_id,
        from_status: RoundStatus::Open as u8,
        to_status: RoundStatus::Closed as u8,
        ts: now,
    });
    Ok(())
}

pub fn request_draw(ctx: Context<RequestDraw>, args: RequestDrawArgs) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let now = Clock::get()?.unix_timestamp;
    require!(
        round.status == RoundStatus::Closed as u8,
        OpenJackError::InvalidRoundState
    );
    require!(now >= round.close_ts, OpenJackError::RoundNotClosable);
    require!(
        args.vrf_request != Pubkey::default(),
        OpenJackError::VrfUnauthorized
    );

    round.vrf_request = args.vrf_request;
    round.status = RoundStatus::Drawing as u8;
    emit!(RoundStatusChanged {
        round_id: round.round_id,
        from_status: RoundStatus::Closed as u8,
        to_status: RoundStatus::Drawing as u8,
        ts: now,
    });
    Ok(())
}

pub fn fulfill_draw(ctx: Context<FulfillDraw>, args: FulfillDrawArgs) -> Result<()> {
    let round = &mut ctx.accounts.round;
    validate_vrf_fulfillment(
        round.status,
        round.draw_ts,
        round.vrf_request,
        args.vrf_request,
    )?;

    let (winning_main, winning_bonus) = derive_winning_numbers(&args.vrf_result);
    round.winning_main = winning_main;
    round.winning_bonus = winning_bonus;
    round.draw_ts = Clock::get()?.unix_timestamp;
    round.settle_deadline_ts = round.draw_ts + SETTLEMENT_WINDOW_SECS;
    round.status = RoundStatus::Settling as u8;

    emit!(DrawFulfilled {
        round_id: round.round_id,
        winning_main,
        winning_bonus,
        vrf_request: args.vrf_request,
        ts: round.draw_ts,
    });

    emit!(RoundStatusChanged {
        round_id: round.round_id,
        from_status: RoundStatus::Drawing as u8,
        to_status: RoundStatus::Settling as u8,
        ts: round.draw_ts,
    });
    Ok(())
}

pub fn derive_winning_numbers(vrf_result: &[u8; 32]) -> ([u8; 5], u8) {
    let mut available: Vec<u8> = (1..=50).collect();
    let mut selected = [0u8; 5];

    for (pick, slot) in selected.iter_mut().enumerate() {
        let idx = draw_index(
            vrf_result,
            b"OPENJACK_MAIN",
            pick as u8,
            available.len() as u64,
        );
        *slot = available.remove(idx as usize);
    }
    selected.sort_unstable();

    let bonus_idx = draw_index(vrf_result, b"OPENJACK_BONUS", 0, 10);
    let bonus = (bonus_idx as u8) + 1;

    (selected, bonus)
}

fn draw_index(seed: &[u8; 32], domain: &[u8], nonce: u8, modulus: u64) -> u64 {
    let hash = hashv(&[seed, domain, &[nonce]]);
    let bytes = hash.to_bytes();
    let n = u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]);
    n % modulus
}

fn validate_vrf_fulfillment(
    round_status: u8,
    draw_ts: i64,
    expected_request: Pubkey,
    provided_request: Pubkey,
) -> Result<()> {
    require!(
        round_status == RoundStatus::Drawing as u8,
        OpenJackError::InvalidRoundState
    );
    require!(draw_ts == 0, OpenJackError::VrfReplay);
    require!(
        expected_request != Pubkey::default(),
        OpenJackError::VrfUnauthorized
    );
    require!(
        provided_request == expected_request,
        OpenJackError::VrfUnauthorized
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivation_is_deterministic() {
        let seed = [42u8; 32];
        let (main_a, bonus_a) = derive_winning_numbers(&seed);
        let (main_b, bonus_b) = derive_winning_numbers(&seed);
        assert_eq!(main_a, main_b);
        assert_eq!(bonus_a, bonus_b);
    }

    #[test]
    fn derived_main_numbers_are_unique_and_sorted() {
        let seed = [7u8; 32];
        let (main, bonus) = derive_winning_numbers(&seed);

        assert!((1..=10).contains(&bonus));
        assert!(main.windows(2).all(|w| w[0] < w[1]));
        for n in main {
            assert!((1..=50).contains(&n));
        }
    }

    #[test]
    fn distinct_seeds_produce_distinct_results() {
        let seed_a = [1u8; 32];
        let seed_b = [2u8; 32];
        let draw_a = derive_winning_numbers(&seed_a);
        let draw_b = derive_winning_numbers(&seed_b);
        assert_ne!(draw_a, draw_b);
    }

    #[test]
    fn reject_vrf_replay() {
        let result = validate_vrf_fulfillment(
            RoundStatus::Drawing as u8,
            123,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn reject_vrf_request_mismatch() {
        let result = validate_vrf_fulfillment(
            RoundStatus::Drawing as u8,
            0,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn payout_math_computes_obligations_and_remainders() {
        let jackpot_pool = 1_000;
        let tier_pools = [500, 400, 300, 200, 100];
        let winner_counts = [2, 5, 0, 3, 1, 4];

        let (payouts, remainders, total) =
            compute_tier_payouts(jackpot_pool, tier_pools, winner_counts).unwrap();

        assert_eq!(payouts, [500, 100, 0, 100, 200, 25]);
        assert_eq!(remainders, [0, 0, 400, 0, 0, 0]);
        assert_eq!(total, 2_100);
    }
}

pub fn finalize_prizes(ctx: Context<FinalizePrizes>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let now = Clock::get()?.unix_timestamp;
    const ALL_TIERS_MASK: u8 = 0b0011_1111;
    require!(
        round.status == RoundStatus::Settling as u8,
        OpenJackError::InvalidRoundState
    );
    require!(
        round.roots_committed_mask == ALL_TIERS_MASK,
        OpenJackError::WinnerRootsIncomplete
    );
    require!(
        now > round.settle_deadline_ts,
        OpenJackError::SettlementWindowOpen
    );

    let (payouts, remainders, total_obligation) = compute_tier_payouts(
        round.jackpot_pool_balance,
        round.tier_pool_balances,
        round.tier_winner_counts,
    )?;

    round.tier_payout_per_winner = payouts;
    round.tier_remainders = remainders;

    // Keep only remainders in carryover pools; move obligations into winners pool.
    round.jackpot_pool_balance = remainders[0];
    for i in 0..5 {
        round.tier_pool_balances[i] = remainders[i + 1];
    }
    round.winners_pool_balance = round
        .winners_pool_balance
        .checked_add(total_obligation)
        .ok_or(OpenJackError::MathOverflow)?;

    round.status = RoundStatus::Finalized as u8;
    round.finalized_ts = now;

    emit!(RoundStatusChanged {
        round_id: round.round_id,
        from_status: RoundStatus::Settling as u8,
        to_status: RoundStatus::Finalized as u8,
        ts: round.finalized_ts,
    });
    Ok(())
}

fn compute_tier_payouts(
    jackpot_pool: u64,
    tier_pools: [u64; 5],
    winner_counts: [u32; 6],
) -> Result<([u64; 6], [u64; 6], u64)> {
    let mut payout_per_winner = [0u64; 6];
    let mut remainders = [0u64; 6];
    let mut total_obligation = 0u64;

    let tier_sources = [
        jackpot_pool,
        tier_pools[0],
        tier_pools[1],
        tier_pools[2],
        tier_pools[3],
        tier_pools[4],
    ];

    for i in 0..6 {
        let source = tier_sources[i];
        let winners = winner_counts[i] as u64;
        if winners == 0 {
            payout_per_winner[i] = 0;
            remainders[i] = source;
            continue;
        }

        let per = source / winners;
        let obligation = per
            .checked_mul(winners)
            .ok_or(OpenJackError::MathOverflow)?;
        payout_per_winner[i] = per;
        remainders[i] = source
            .checked_sub(obligation)
            .ok_or(OpenJackError::MathOverflow)?;
        total_obligation = total_obligation
            .checked_add(obligation)
            .ok_or(OpenJackError::MathOverflow)?;
    }

    Ok((payout_per_winner, remainders, total_obligation))
}
