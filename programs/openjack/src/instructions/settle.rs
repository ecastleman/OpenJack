use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};
use spl_account_compression::program::SplAccountCompression;

use crate::errors::OpenJackError;
use crate::events::{WinnerChallenged, WinnerRootPublished};
use crate::state::{LotteryConfig, Round, RoundStatus, ScannerBond, WinnerRecord};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PublishWinnerRootArgs {
    pub tier: u8,
    pub root_hash: [u8; 32],
    pub winner_count: u32,
    pub observed_ticket_count: u32,
    pub commitment_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ChallengeOmittedWinnerArgs {
    pub tier: u8,
    pub leaf_index: u32,
    pub ticket_owner: Pubkey,
    pub compression_root: [u8; 32],
    pub compression_leaf: [u8; 32],
    pub compression_index: u32,
    pub ticket_proof: Vec<[u8; 32]>,
}

#[derive(Accounts)]
pub struct PostScannerBond<'info> {
    #[account(mut)]
    pub scanner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, LotteryConfig>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(
        init_if_needed,
        payer = scanner,
        seeds = [b"bond".as_ref(), round.round_id.to_le_bytes().as_ref()],
        bump,
        space = 8 + std::mem::size_of::<ScannerBond>()
    )]
    pub scanner_bond: Account<'info, ScannerBond>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishWinnerRoot<'info> {
    pub scanner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, LotteryConfig>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [b"bond".as_ref(), round.round_id.to_le_bytes().as_ref()],
        bump = scanner_bond.bump
    )]
    pub scanner_bond: Account<'info, ScannerBond>,
}

#[derive(Accounts)]
pub struct ChallengeOmittedWinner<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, LotteryConfig>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [b"bond".as_ref(), round.round_id.to_le_bytes().as_ref()],
        bump = scanner_bond.bump
    )]
    pub scanner_bond: Account<'info, ScannerBond>,
    /// CHECK: PDA is derived and verified in-handler from (round_id, tier, leaf_index)
    /// and data is deserialized/serialized as WinnerRecord after ownership checks.
    #[account(mut)]
    pub winner_record: UncheckedAccount<'info>,
    /// CHECK: verified against round.tree_address and used for compression CPI
    pub merkle_tree: UncheckedAccount<'info>,
    pub compression_program: Program<'info, SplAccountCompression>,
    pub system_program: Program<'info, System>,
}

pub fn post_scanner_bond(ctx: Context<PostScannerBond>) -> Result<()> {
    require!(
        ctx.accounts.scanner.key() == ctx.accounts.config.official_scanner_pubkey,
        OpenJackError::ScannerUnauthorized
    );
    let bond = &mut ctx.accounts.scanner_bond;
    bond.posted = true;
    bond.amount = ctx.accounts.config.scanner_bond_lamports;
    bond.slashed = 0;
    bond.bump = ctx.bumps.scanner_bond;
    Ok(())
}

pub fn publish_winner_root(
    ctx: Context<PublishWinnerRoot>,
    args: PublishWinnerRootArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    validate_settlement_context(
        round.status,
        now,
        round.settle_deadline_ts,
        args.tier,
        ctx.accounts.scanner.key(),
        ctx.accounts.config.official_scanner_pubkey,
        ctx.accounts.scanner_bond.posted,
    )?;

    let round = &mut ctx.accounts.round;
    let idx = args.tier as usize;
    round.roots[idx] = args.root_hash;
    round.tier_winner_counts[idx] = args.winner_count;
    round.roots_committed_mask |= 1u8 << args.tier;
    round.scanner_observed_ticket_count = args.observed_ticket_count;
    round.scanner_commitment_hash = args.commitment_hash;

    emit!(WinnerRootPublished {
        round_id: round.round_id,
        tier: args.tier,
        root_hash: args.root_hash,
        winner_count: args.winner_count,
        observed_ticket_count: args.observed_ticket_count,
        ts: now,
    });
    Ok(())
}

pub fn challenge_omitted_winner<'info>(
    ctx: Context<'_, '_, '_, 'info, ChallengeOmittedWinner<'info>>,
    args: ChallengeOmittedWinnerArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &ctx.accounts.round;
    validate_challenge_context(
        round.status,
        now,
        round.settle_deadline_ts,
        args.tier,
        ctx.accounts.scanner_bond.posted,
    )?;
    let merkle_tree_info = ctx.accounts.merkle_tree.to_account_info();
    let compression_program_info = ctx.accounts.compression_program.to_account_info();
    let remaining_accounts = ctx.remaining_accounts.to_vec();
    verify_challenge_compression_membership_raw(
        merkle_tree_info,
        compression_program_info,
        remaining_accounts,
        round.tree_address,
        &args,
    )?;

    let round_id_bytes = round.round_id.to_le_bytes();
    let leaf_index_bytes = args.leaf_index.to_le_bytes();
    let tier_bytes = [args.tier];
    let winner_seeds = [
        b"winner".as_ref(),
        round_id_bytes.as_ref(),
        tier_bytes.as_ref(),
        leaf_index_bytes.as_ref(),
    ];
    let (expected_winner_record, winner_bump) =
        Pubkey::find_program_address(&winner_seeds, ctx.program_id);
    require_keys_eq!(
        ctx.accounts.winner_record.key(),
        expected_winner_record,
        OpenJackError::WinnerRecordPdaMismatch
    );

    let mut winner_record = if ctx.accounts.winner_record.data_is_empty() {
        let winner_space = (8 + std::mem::size_of::<WinnerRecord>()) as u64;
        let rent_lamports = Rent::get()?.minimum_balance(winner_space as usize);
        let signer_seeds: &[&[u8]] = &[
            b"winner".as_ref(),
            round_id_bytes.as_ref(),
            tier_bytes.as_ref(),
            leaf_index_bytes.as_ref(),
            &[winner_bump],
        ];
        let signer = &[signer_seeds];
        let create_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            CreateAccount {
                from: ctx.accounts.challenger.to_account_info(),
                to: ctx.accounts.winner_record.to_account_info(),
            },
            signer,
        );
        system_program::create_account(create_ctx, rent_lamports, winner_space, ctx.program_id)?;
        WinnerRecord {
            registered_by: Pubkey::default(),
            registered_ts: 0,
            bump: winner_bump,
        }
    } else {
        let data = ctx.accounts.winner_record.try_borrow_data()?;
        let mut data_slice: &[u8] = &data;
        WinnerRecord::try_deserialize(&mut data_slice)?
    };

    require!(
        winner_record.registered_ts == 0,
        OpenJackError::WinnerAlreadyRegistered
    );
    winner_record.registered_by = ctx.accounts.challenger.key();
    winner_record.registered_ts = now;
    winner_record.bump = winner_bump;
    {
        let mut data = ctx.accounts.winner_record.try_borrow_mut_data()?;
        data[..8].copy_from_slice(&WinnerRecord::DISCRIMINATOR);
        let mut dst: &mut [u8] = &mut data[8..];
        winner_record.try_serialize(&mut dst)?;
    }

    let round = &mut ctx.accounts.round;
    let idx = args.tier as usize;
    round.tier_winner_counts[idx] = round.tier_winner_counts[idx]
        .checked_add(1)
        .ok_or(OpenJackError::MathOverflow)?;

    let bond = &mut ctx.accounts.scanner_bond;
    let slash = compute_slash_lamports(
        ctx.accounts.config.scanner_slash_lamports,
        bond.amount,
        bond.slashed,
    );
    bond.slashed = bond
        .slashed
        .checked_add(slash)
        .ok_or(OpenJackError::MathOverflow)?;

    emit!(WinnerChallenged {
        round_id: round.round_id,
        tier: args.tier,
        leaf_index: args.leaf_index,
        challenger: ctx.accounts.challenger.key(),
        slash_lamports: slash,
        ts: now,
    });
    Ok(())
}

fn validate_settlement_context(
    round_status: u8,
    now: i64,
    settle_deadline_ts: i64,
    tier: u8,
    scanner: Pubkey,
    official_scanner: Pubkey,
    bond_posted: bool,
) -> Result<()> {
    require!(
        round_status == RoundStatus::Settling as u8,
        OpenJackError::InvalidRoundState
    );
    require!(
        now <= settle_deadline_ts,
        OpenJackError::SettlementWindowClosed
    );
    require!(tier <= 5, OpenJackError::TierOutOfRange);
    require!(
        scanner == official_scanner,
        OpenJackError::ScannerUnauthorized
    );
    require!(bond_posted, OpenJackError::ScannerBondMissing);
    Ok(())
}

fn validate_challenge_context(
    round_status: u8,
    now: i64,
    settle_deadline_ts: i64,
    tier: u8,
    bond_posted: bool,
) -> Result<()> {
    require!(
        round_status == RoundStatus::Settling as u8,
        OpenJackError::InvalidRoundState
    );
    require!(
        now <= settle_deadline_ts,
        OpenJackError::SettlementWindowClosed
    );
    require!(tier <= 5, OpenJackError::TierOutOfRange);
    require!(bond_posted, OpenJackError::ScannerBondMissing);
    Ok(())
}

fn verify_challenge_compression_membership_raw<'info>(
    merkle_tree_info: AccountInfo<'info>,
    compression_program_info: AccountInfo<'info>,
    remaining_accounts: Vec<AccountInfo<'info>>,
    expected_tree_address: Pubkey,
    args: &ChallengeOmittedWinnerArgs,
) -> Result<()> {
    require!(
        merkle_tree_info.key() == expected_tree_address,
        OpenJackError::CompressionProofInvalid
    );
    require!(
        args.compression_index == args.leaf_index,
        OpenJackError::CompressionProofInvalid
    );
    require!(
        !args.ticket_proof.is_empty(),
        OpenJackError::CompressionProofInvalid
    );
    require!(
        remaining_accounts.len() == args.ticket_proof.len(),
        OpenJackError::CompressionProofInvalid
    );
    for (i, node) in args.ticket_proof.iter().enumerate() {
        require!(
            remaining_accounts[i].key().to_bytes() == *node,
            OpenJackError::CompressionProofInvalid
        );
    }

    let cpi_accounts = spl_account_compression::cpi::accounts::VerifyLeaf {
        merkle_tree: merkle_tree_info,
    };
    let cpi_ctx =
        CpiContext::new(compression_program_info, cpi_accounts).with_remaining_accounts(remaining_accounts);
    spl_account_compression::cpi::verify_leaf(
        cpi_ctx,
        args.compression_root,
        args.compression_leaf,
        args.compression_index,
    )
    .map_err(|_| OpenJackError::CompressionProofInvalid.into())
}

fn compute_slash_lamports(configured_slash: u64, bond_amount: u64, slashed_so_far: u64) -> u64 {
    let remaining = bond_amount.saturating_sub(slashed_so_far);
    configured_slash.min(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_rejects_non_scanner() {
        let result = validate_settlement_context(
            RoundStatus::Settling as u8,
            100,
            200,
            1,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            true,
        );
        assert!(result.is_err());
    }

    #[test]
    fn publish_rejects_missing_bond() {
        let scanner = Pubkey::new_unique();
        let result = validate_settlement_context(
            RoundStatus::Settling as u8,
            100,
            200,
            1,
            scanner,
            scanner,
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn publish_rejects_tier_out_of_range() {
        let scanner = Pubkey::new_unique();
        let result = validate_settlement_context(
            RoundStatus::Settling as u8,
            100,
            200,
            6,
            scanner,
            scanner,
            true,
        );
        assert!(result.is_err());
    }

    #[test]
    fn challenge_rejects_tier_out_of_range() {
        let result = validate_challenge_context(RoundStatus::Settling as u8, 100, 200, 6, true);
        assert!(result.is_err());
    }

    #[test]
    fn slash_is_capped_by_remaining_bond() {
        let slash = compute_slash_lamports(50, 100, 80);
        assert_eq!(slash, 20);
    }
}
