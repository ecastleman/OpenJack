use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::{
    BONUS_N, MAIN_K, MAIN_N, MAX_TICKETS_PER_TX, MAX_TICKETS_PER_WALLET_PER_ROUND,
};
use crate::errors::OpenJackError;
use crate::events::TicketPurchased;
use crate::math::{split_ticket_revenue, usd_cents_to_lamports_ceil};
use crate::state::{LotteryConfig, Round, RoundStatus, UserRoundStats};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TicketNumbers {
    pub main: [u8; 5],
    pub bonus: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BuyTicketsArgs {
    pub tickets: Vec<TicketNumbers>,
    pub oracle_price_micro_usd_per_sol: u64,
    pub oracle_publish_ts: i64,
}

#[derive(Accounts)]
pub struct BuyTickets<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, LotteryConfig>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    /// CHECK: Must match config treasury address.
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: Must match config oracle address.
    pub oracle_feed: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = buyer,
        seeds = [
            b"user_round".as_ref(),
            round.round_id.to_le_bytes().as_ref(),
            buyer.key().as_ref()
        ],
        bump,
        space = 8 + std::mem::size_of::<UserRoundStats>()
    )]
    pub user_round_stats: Account<'info, UserRoundStats>,
    pub system_program: Program<'info, System>,
}

pub fn buy_tickets(ctx: Context<BuyTickets>, args: BuyTicketsArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    let config = &ctx.accounts.config;

    require!(
        round.status == RoundStatus::Open as u8,
        OpenJackError::RoundClosed
    );
    require!(now < round.close_ts, OpenJackError::RoundClosed);
    require!(
        ctx.accounts.treasury.key() == config.treasury_pubkey,
        OpenJackError::TreasuryAccountMismatch
    );
    require!(
        ctx.accounts.oracle_feed.key() == config.sol_usd_oracle,
        OpenJackError::OracleAccountMismatch
    );

    let qty_usize = args.tickets.len();
    require!(qty_usize > 0, OpenJackError::TooManyTicketsPerTx);
    require!(
        qty_usize <= MAX_TICKETS_PER_TX as usize,
        OpenJackError::TooManyTicketsPerTx
    );

    require!(args.oracle_publish_ts <= now, OpenJackError::OracleInvalid);
    let oracle_age = now
        .checked_sub(args.oracle_publish_ts)
        .ok_or(OpenJackError::MathOverflow)?;
    require!(
        oracle_age <= config.oracle_max_age_secs as i64,
        OpenJackError::OracleStale
    );

    let qty = qty_usize as u32;
    let stats = &mut ctx.accounts.user_round_stats;
    if stats.bump == 0 {
        stats.bump = ctx.bumps.user_round_stats;
    }
    let updated_count = stats
        .tickets_bought
        .checked_add(qty)
        .ok_or(OpenJackError::MathOverflow)?;
    require!(
        updated_count <= MAX_TICKETS_PER_WALLET_PER_ROUND,
        OpenJackError::WalletRoundCapExceeded
    );

    for t in &args.tickets {
        validate_ticket_numbers(t)?;
    }

    let lamports_per_ticket = usd_cents_to_lamports_ceil(
        config.ticket_price_usd_cents as u64,
        args.oracle_price_micro_usd_per_sol,
    )?;
    let total_lamports = lamports_per_ticket
        .checked_mul(qty as u64)
        .ok_or(OpenJackError::MathOverflow)?;
    let split = split_ticket_revenue(total_lamports);
    let remainder_to_round = total_lamports
        .checked_sub(split.treasury)
        .ok_or(OpenJackError::MathOverflow)?;

    if split.treasury > 0 {
        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        );
        system_program::transfer(cpi, split.treasury)?;
    }

    if remainder_to_round > 0 {
        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: round.to_account_info(),
            },
        );
        system_program::transfer(cpi, remainder_to_round)?;
    }

    let jackpot_total = split
        .jackpot
        .checked_add(split.dust)
        .ok_or(OpenJackError::MathOverflow)?;
    round.sales_lamports = round
        .sales_lamports
        .checked_add(total_lamports)
        .ok_or(OpenJackError::MathOverflow)?;
    round.treasury_paid_lamports = round
        .treasury_paid_lamports
        .checked_add(split.treasury)
        .ok_or(OpenJackError::MathOverflow)?;
    round.jackpot_pool_balance = round
        .jackpot_pool_balance
        .checked_add(jackpot_total)
        .ok_or(OpenJackError::MathOverflow)?;
    for (i, amount) in split.lower_tiers.iter().enumerate() {
        round.tier_pool_balances[i] = round.tier_pool_balances[i]
            .checked_add(*amount)
            .ok_or(OpenJackError::MathOverflow)?;
    }

    let start_leaf = round.ticket_count;
    round.ticket_count = round
        .ticket_count
        .checked_add(qty)
        .ok_or(OpenJackError::MathOverflow)?;

    for (i, t) in args.tickets.iter().enumerate() {
        let mut sorted_main = t.main;
        sorted_main.sort_unstable();
        emit!(TicketPurchased {
            round_id: round.round_id,
            leaf_index: start_leaf + i as u32,
            main: sorted_main,
            bonus: t.bonus,
            purchaser: ctx.accounts.buyer.key(),
            paid_lamports: lamports_per_ticket,
            ts: now,
        });
    }

    stats.tickets_bought = updated_count;
    Ok(())
}

fn validate_ticket_numbers(ticket: &TicketNumbers) -> Result<()> {
    if ticket.bonus == 0 || ticket.bonus > BONUS_N {
        return Err(OpenJackError::InvalidBonusNumber.into());
    }

    let mut sorted = ticket.main;
    sorted.sort_unstable();
    if sorted.len() != MAIN_K {
        return Err(OpenJackError::InvalidMainNumbers.into());
    }

    for n in sorted.iter() {
        if *n == 0 || *n > MAIN_N {
            return Err(OpenJackError::InvalidMainNumbers.into());
        }
    }

    for window in sorted.windows(2) {
        if window[0] == window[1] {
            return Err(OpenJackError::InvalidMainNumbers.into());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_ticket() {
        let t = TicketNumbers {
            main: [1, 2, 3, 4, 5],
            bonus: 1,
        };
        assert!(validate_ticket_numbers(&t).is_ok());
    }

    #[test]
    fn rejects_duplicate_main_number() {
        let t = TicketNumbers {
            main: [1, 2, 2, 4, 5],
            bonus: 1,
        };
        assert!(validate_ticket_numbers(&t).is_err());
    }

    #[test]
    fn rejects_out_of_range_bonus() {
        let t = TicketNumbers {
            main: [1, 2, 3, 4, 5],
            bonus: 11,
        };
        assert!(validate_ticket_numbers(&t).is_err());
    }
}
