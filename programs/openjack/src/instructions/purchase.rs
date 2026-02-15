use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use mpl_bubblegum::instructions::MintV1CpiBuilder;
use mpl_bubblegum::types::{Creator, MetadataArgs, TokenProgramVersion, TokenStandard};

use crate::constants::{
    BONUS_N, MAIN_K, MAIN_N, MAX_TICKETS_PER_TX, MAX_TICKETS_PER_WALLET_PER_ROUND,
};
use crate::errors::OpenJackError;
use crate::events::TicketPurchased;
use crate::math::{split_ticket_revenue, usd_cents_to_lamports_ceil};
use crate::state::{LotteryConfig, Round, RoundStatus, UserRoundStats};

#[derive(Clone)]
struct CnftMintAccounts<'info> {
    merkle_tree: AccountInfo<'info>,
    tree_config: AccountInfo<'info>,
    bubblegum_program: AccountInfo<'info>,
    log_wrapper: AccountInfo<'info>,
    compression_program: AccountInfo<'info>,
}

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
    #[account(mut)]
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

pub fn buy_tickets<'info>(
    ctx: Context<'_, '_, '_, 'info, BuyTickets<'info>>,
    args: BuyTicketsArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    let round = &ctx.accounts.round;

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
    let current_tickets_bought = ctx.accounts.user_round_stats.tickets_bought;
    let updated_count = current_tickets_bought
        .checked_add(qty)
        .ok_or(OpenJackError::MathOverflow)?;
    require!(
        updated_count <= MAX_TICKETS_PER_WALLET_PER_ROUND,
        OpenJackError::WalletRoundCapExceeded
    );

    let round_id = round.round_id;
    let tree_address = round.tree_address;
    let cnft_accounts = parse_cnft_accounts(ctx.remaining_accounts, tree_address)?;

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
                to: ctx.accounts.round.to_account_info(),
            },
        );
        system_program::transfer(cpi, remainder_to_round)?;
    }

    let round = &mut ctx.accounts.round;
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

    let buyer_key = ctx.accounts.buyer.key();
    let buyer_info = ctx.accounts.buyer.to_account_info();
    let system_program_info = ctx.accounts.system_program.to_account_info();
    for (i, t) in args.tickets.iter().enumerate() {
        let leaf_index = start_leaf + i as u32;
        let mut sorted_main = t.main;
        sorted_main.sort_unstable();
        let asset_id = mint_ticket_cnft(
            buyer_key,
            &buyer_info,
            &system_program_info,
            &cnft_accounts,
            round_id,
            leaf_index,
            sorted_main,
            t.bonus,
        )?;
        emit!(TicketPurchased {
            round_id,
            leaf_index,
            main: sorted_main,
            bonus: t.bonus,
            asset_id,
            purchaser: buyer_key,
            paid_lamports: lamports_per_ticket,
            ts: now,
        });
    }

    let stats = &mut ctx.accounts.user_round_stats;
    if stats.bump == 0 {
        stats.bump = ctx.bumps.user_round_stats;
    }
    stats.tickets_bought = updated_count;
    Ok(())
}

fn parse_cnft_accounts<'info>(
    remaining: &[AccountInfo<'info>],
    expected_tree_address: Pubkey,
) -> Result<CnftMintAccounts<'info>> {
    require!(
        remaining.len() >= 5,
        OpenJackError::CnftMintAccountsInvalid
    );

    let merkle_tree = remaining[0].clone();
    let tree_config = remaining[1].clone();
    let bubblegum_program = remaining[2].clone();
    let log_wrapper = remaining[3].clone();
    let compression_program = remaining[4].clone();

    require!(
        merkle_tree.key() == expected_tree_address,
        OpenJackError::CnftMintAccountsInvalid
    );
    require!(
        bubblegum_program.key() == mpl_bubblegum::ID,
        OpenJackError::CnftMintAccountsInvalid
    );
    require!(
        compression_program.key() == spl_account_compression::ID,
        OpenJackError::CnftMintAccountsInvalid
    );
    require!(
        log_wrapper.key().to_string() == "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV",
        OpenJackError::CnftMintAccountsInvalid
    );

    Ok(CnftMintAccounts {
        merkle_tree,
        tree_config,
        bubblegum_program,
        log_wrapper,
        compression_program,
    })
}

fn mint_ticket_cnft<'info>(
    buyer: Pubkey,
    buyer_info: &AccountInfo<'info>,
    system_program_info: &AccountInfo<'info>,
    cnft: &CnftMintAccounts<'info>,
    round_id: u64,
    leaf_index: u32,
    main: [u8; 5],
    bonus: u8,
) -> Result<Pubkey> {
    let metadata = build_ticket_metadata(buyer, round_id, leaf_index, main, bonus);
    MintV1CpiBuilder::new(&cnft.bubblegum_program)
        .tree_config(&cnft.tree_config)
        .leaf_owner(buyer_info)
        .leaf_delegate(buyer_info)
        .merkle_tree(&cnft.merkle_tree)
        .payer(buyer_info)
        .tree_creator_or_delegate(buyer_info)
        .log_wrapper(&cnft.log_wrapper)
        .compression_program(&cnft.compression_program)
        .system_program(system_program_info)
        .metadata(metadata)
        .invoke()?;

    Ok(mpl_bubblegum::utils::get_asset_id(
        &cnft.merkle_tree.key(),
        leaf_index as u64,
    ))
}

fn build_ticket_metadata(
    buyer: Pubkey,
    round_id: u64,
    leaf_index: u32,
    main: [u8; 5],
    bonus: u8,
) -> MetadataArgs {
    MetadataArgs {
        name: format!("OpenJack R{} #{}", round_id, leaf_index),
        symbol: "OJACK".to_string(),
        uri: format!(
            "openjack://ticket?round={}&leaf={}&main={}-{}-{}-{}-{}&bonus={}",
            round_id, leaf_index, main[0], main[1], main[2], main[3], main[4], bonus
        ),
        seller_fee_basis_points: 0,
        primary_sale_happened: false,
        is_mutable: false,
        edition_nonce: None,
        token_standard: Some(TokenStandard::NonFungible),
        collection: None,
        uses: None,
        token_program_version: TokenProgramVersion::Original,
        creators: vec![Creator {
            address: buyer,
            verified: true,
            share: 100,
        }],
    }
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
