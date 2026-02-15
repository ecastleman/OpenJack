use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use spl_account_compression::program::SplAccountCompression;

use crate::constants::WINNERS_CLAIM_WINDOW_SECS;
use crate::errors::OpenJackError;
use crate::events::{Claimed, SweptToUnclaimed};
use crate::state::{ClaimRecord, Round, RoundStatus};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimArgs {
    pub leaf_index: u32,
    pub tier: u8,
    pub amount: u64,
    pub ticket_owner: Pubkey,
    pub compression_root: [u8; 32],
    pub compression_leaf: [u8; 32],
    pub compression_index: u32,
    pub ticket_proof_hash: [u8; 32],
    pub winner_root_hash: [u8; 32],
    pub winner_root_proof: Vec<[u8; 32]>,
}

#[derive(Accounts)]
#[instruction(args: ClaimArgs)]
pub struct Claim<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(
        init,
        payer = claimer,
        seeds = [
            b"claim".as_ref(),
            round.round_id.to_le_bytes().as_ref(),
            args.leaf_index.to_le_bytes().as_ref()
        ],
        bump,
        space = 8 + std::mem::size_of::<ClaimRecord>()
    )]
    pub claim_record: Account<'info, ClaimRecord>,
    /// CHECK: verified against round.tree_address and used for compression CPI
    pub merkle_tree: UncheckedAccount<'info>,
    pub compression_program: Program<'info, SplAccountCompression>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SweepWinnersToUnclaimed<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

pub fn claim<'info>(
    ctx: Context<'_, '_, '_, 'info, Claim<'info>>,
    args: ClaimArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &ctx.accounts.round;
    require!(
        round.status == RoundStatus::Finalized as u8,
        OpenJackError::InvalidRoundState
    );
    require!(args.tier <= 5, OpenJackError::TierOutOfRange);
    verify_winner_root_proof(round, &args)?;
    verify_owner_matches_claimer(ctx.accounts.claimer.key(), args.ticket_owner)?;
    let ticket_proof = extract_ticket_proof_from_remaining(&ctx)?;
    verify_ticket_proof_binding(round, &args, &ticket_proof)?;
    let merkle_tree_info = ctx.accounts.merkle_tree.to_account_info();
    let compression_program_info = ctx.accounts.compression_program.to_account_info();
    let remaining_accounts = ctx.remaining_accounts.to_vec();
    verify_compression_membership_raw(
        merkle_tree_info,
        compression_program_info,
        remaining_accounts,
        round.tree_address,
        &args,
    )?;

    let expected_amount = round.tier_payout_per_winner[args.tier as usize];
    require!(expected_amount > 0, OpenJackError::WinnerProofInvalid);
    require!(
        args.amount == expected_amount,
        OpenJackError::InvalidClaimAmount
    );

    let round = &mut ctx.accounts.round;
    let claim_window_end = round
        .finalized_ts
        .checked_add(WINNERS_CLAIM_WINDOW_SECS)
        .ok_or(OpenJackError::MathOverflow)?;
    let source_pool = if now <= claim_window_end { 0 } else { 1 };
    debit_claim_source_pool(round, source_pool, expected_amount)?;
    pay_claim_to_claimer(round, &ctx.accounts.claimer.to_account_info(), expected_amount)?;

    let record = &mut ctx.accounts.claim_record;
    record.claimer = ctx.accounts.claimer.key();
    record.tier = args.tier;
    record.amount = expected_amount;
    record.claimed_ts = now;
    record.source_pool = source_pool;
    record.bump = ctx.bumps.claim_record;

    emit!(Claimed {
        round_id: round.round_id,
        leaf_index: args.leaf_index,
        claimer: ctx.accounts.claimer.key(),
        tier: args.tier,
        amount: expected_amount,
        source_pool: record.source_pool,
        ts: record.claimed_ts,
    });
    Ok(())
}

fn pay_claim_to_claimer(round: &mut Account<Round>, claimer: &AccountInfo, amount: u64) -> Result<()> {
    let round_info = round.to_account_info();
    let round_data_len = round_info.data_len();
    let min_rent_lamports = Rent::get()?.minimum_balance(round_data_len);
    let round_balance = **round_info.lamports.borrow();
    let post_balance = round_balance
        .checked_sub(amount)
        .ok_or(OpenJackError::InsufficientPoolBalance)?;
    require!(
        post_balance >= min_rent_lamports,
        OpenJackError::InsufficientPoolBalance
    );

    **round_info.try_borrow_mut_lamports()? = post_balance;
    **claimer.try_borrow_mut_lamports()? = claimer
        .lamports()
        .checked_add(amount)
        .ok_or(OpenJackError::MathOverflow)?;
    Ok(())
}

fn verify_owner_matches_claimer(claimer: Pubkey, ticket_owner: Pubkey) -> Result<()> {
    require!(ticket_owner == claimer, OpenJackError::NotTicketOwner);
    Ok(())
}

fn extract_ticket_proof_from_remaining(ctx: &Context<Claim>) -> Result<Vec<[u8; 32]>> {
    require!(
        !ctx.remaining_accounts.is_empty(),
        OpenJackError::OwnershipProofInvalid
    );
    require!(
        ctx.remaining_accounts.len() <= 64,
        OpenJackError::OwnershipProofInvalid
    );
    Ok(ctx
        .remaining_accounts
        .iter()
        .map(|account| account.key().to_bytes())
        .collect())
}

fn verify_ticket_proof_binding(round: &Round, args: &ClaimArgs, ticket_proof: &[[u8; 32]]) -> Result<()> {
    let computed = compute_ticket_proof_hash(
        round.round_id,
        round.tree_address,
        args.leaf_index,
        args.ticket_owner,
        ticket_proof,
    );
    require!(
        computed == args.ticket_proof_hash,
        OpenJackError::OwnershipProofInvalid
    );
    Ok(())
}

fn verify_compression_membership_raw<'info>(
    merkle_tree_info: AccountInfo<'info>,
    compression_program_info: AccountInfo<'info>,
    remaining_accounts: Vec<AccountInfo<'info>>,
    expected_tree_address: Pubkey,
    args: &ClaimArgs,
) -> Result<()> {
    require!(
        merkle_tree_info.key() == expected_tree_address,
        OpenJackError::CompressionProofInvalid
    );
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

fn verify_winner_root_proof(round: &Round, args: &ClaimArgs) -> Result<()> {
    let tier = args.tier as usize;
    let expected_root = round.roots[tier];
    require!(
        expected_root == args.winner_root_hash,
        OpenJackError::WinnerProofInvalid
    );
    let computed = compute_merkle_root_for_leaf(args.leaf_index, &args.winner_root_proof);
    require!(
        computed == args.winner_root_hash,
        OpenJackError::WinnerProofInvalid
    );
    Ok(())
}

fn compute_merkle_root_for_leaf(leaf_index: u32, proof: &[[u8; 32]]) -> [u8; 32] {
    let mut node = hash_leaf_index(leaf_index);
    for sibling in proof {
        node = hash_pair(node, *sibling);
    }
    node
}

fn hash_leaf_index(leaf_index: u32) -> [u8; 32] {
    let idx = leaf_index.to_string();
    hashv(&[b"leaf:", idx.as_bytes()]).to_bytes()
}

fn hash_pair(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[lo.as_ref(), hi.as_ref()]).to_bytes()
}

fn compute_ticket_proof_hash(
    round_id: u64,
    tree_address: Pubkey,
    leaf_index: u32,
    ticket_owner: Pubkey,
    ticket_proof: &[[u8; 32]],
) -> [u8; 32] {
    let round_id_le = round_id.to_le_bytes();
    let leaf_index_le = leaf_index.to_le_bytes();
    let mut slices: Vec<&[u8]> = Vec::with_capacity(5 + ticket_proof.len());
    slices.push(b"ticket-proof:");
    slices.push(round_id_le.as_ref());
    slices.push(tree_address.as_ref());
    slices.push(leaf_index_le.as_ref());
    slices.push(ticket_owner.as_ref());
    for node in ticket_proof {
        slices.push(node.as_ref());
    }
    hashv(&slices).to_bytes()
}

pub fn sweep_winners_to_unclaimed(ctx: Context<SweepWinnersToUnclaimed>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    validate_sweep_ready(round.status, round.finalized_ts, now)?;

    let amount = round.winners_pool_balance;
    let (new_winners, new_unclaimed) =
        move_winners_to_unclaimed(round.winners_pool_balance, round.unclaimed_pool_balance)?;
    round.winners_pool_balance = new_winners;
    round.unclaimed_pool_balance = new_unclaimed;

    emit!(SweptToUnclaimed {
        round_id: round.round_id,
        amount,
        ts: now,
    });
    Ok(())
}

fn validate_sweep_ready(round_status: u8, finalized_ts: i64, now: i64) -> Result<()> {
    require!(
        round_status == RoundStatus::Finalized as u8,
        OpenJackError::InvalidRoundState
    );
    let sweep_ready_ts = finalized_ts
        .checked_add(WINNERS_CLAIM_WINDOW_SECS)
        .ok_or(OpenJackError::MathOverflow)?;
    require!(now > sweep_ready_ts, OpenJackError::SweepNotReady);
    Ok(())
}

fn move_winners_to_unclaimed(winners: u64, unclaimed: u64) -> Result<(u64, u64)> {
    let new_unclaimed = unclaimed
        .checked_add(winners)
        .ok_or(OpenJackError::MathOverflow)?;
    Ok((0, new_unclaimed))
}

fn debit_claim_source_pool(round: &mut Round, source_pool: u8, amount: u64) -> Result<()> {
    match source_pool {
        0 => {
            require!(
                round.winners_pool_balance >= amount,
                OpenJackError::InsufficientPoolBalance
            );
            round.winners_pool_balance = round
                .winners_pool_balance
                .checked_sub(amount)
                .ok_or(OpenJackError::MathOverflow)?;
        }
        1 => {
            require!(
                round.unclaimed_pool_balance >= amount,
                OpenJackError::InsufficientPoolBalance
            );
            round.unclaimed_pool_balance = round
                .unclaimed_pool_balance
                .checked_sub(amount)
                .ok_or(OpenJackError::MathOverflow)?;
        }
        _ => return Err(OpenJackError::InvalidClaimAmount.into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debits_winners_pool() {
        let mut round = Round {
            round_id: 1,
            status: RoundStatus::Finalized as u8,
            open_ts: 0,
            close_ts: 0,
            draw_ts: 0,
            settle_deadline_ts: 0,
            tree_address: Pubkey::default(),
            ticket_count: 0,
            sales_lamports: 0,
            treasury_paid_lamports: 0,
            jackpot_pool_balance: 0,
            tier_pool_balances: [0; 5],
            winners_pool_balance: 100,
            unclaimed_pool_balance: 50,
            winning_main: [0; 5],
            winning_bonus: 0,
            vrf_request: Pubkey::default(),
            tier_winner_counts: [0; 6],
            tier_payout_per_winner: [0; 6],
            tier_remainders: [0; 6],
            roots: [[0; 32]; 6],
            roots_committed_mask: 0,
            scanner_commitment_hash: [0; 32],
            scanner_observed_ticket_count: 0,
            finalized_ts: 0,
            bump: 0,
        };

        debit_claim_source_pool(&mut round, 0, 40).unwrap();
        assert_eq!(round.winners_pool_balance, 60);
        assert_eq!(round.unclaimed_pool_balance, 50);
    }

    #[test]
    fn debits_unclaimed_pool() {
        let mut round = Round {
            round_id: 1,
            status: RoundStatus::Finalized as u8,
            open_ts: 0,
            close_ts: 0,
            draw_ts: 0,
            settle_deadline_ts: 0,
            tree_address: Pubkey::default(),
            ticket_count: 0,
            sales_lamports: 0,
            treasury_paid_lamports: 0,
            jackpot_pool_balance: 0,
            tier_pool_balances: [0; 5],
            winners_pool_balance: 100,
            unclaimed_pool_balance: 50,
            winning_main: [0; 5],
            winning_bonus: 0,
            vrf_request: Pubkey::default(),
            tier_winner_counts: [0; 6],
            tier_payout_per_winner: [0; 6],
            tier_remainders: [0; 6],
            roots: [[0; 32]; 6],
            roots_committed_mask: 0,
            scanner_commitment_hash: [0; 32],
            scanner_observed_ticket_count: 0,
            finalized_ts: 0,
            bump: 0,
        };

        debit_claim_source_pool(&mut round, 1, 40).unwrap();
        assert_eq!(round.winners_pool_balance, 100);
        assert_eq!(round.unclaimed_pool_balance, 10);
    }

    #[test]
    fn fails_on_insufficient_pool() {
        let mut round = Round {
            round_id: 1,
            status: RoundStatus::Finalized as u8,
            open_ts: 0,
            close_ts: 0,
            draw_ts: 0,
            settle_deadline_ts: 0,
            tree_address: Pubkey::default(),
            ticket_count: 0,
            sales_lamports: 0,
            treasury_paid_lamports: 0,
            jackpot_pool_balance: 0,
            tier_pool_balances: [0; 5],
            winners_pool_balance: 10,
            unclaimed_pool_balance: 0,
            winning_main: [0; 5],
            winning_bonus: 0,
            vrf_request: Pubkey::default(),
            tier_winner_counts: [0; 6],
            tier_payout_per_winner: [0; 6],
            tier_remainders: [0; 6],
            roots: [[0; 32]; 6],
            roots_committed_mask: 0,
            scanner_commitment_hash: [0; 32],
            scanner_observed_ticket_count: 0,
            finalized_ts: 0,
            bump: 0,
        };

        let result = debit_claim_source_pool(&mut round, 0, 50);
        assert!(result.is_err());
    }

    #[test]
    fn sweep_not_ready_before_30_days() {
        let finalized_ts = 1_000;
        let now = finalized_ts + WINNERS_CLAIM_WINDOW_SECS - 1;
        let result = validate_sweep_ready(RoundStatus::Finalized as u8, finalized_ts, now);
        assert!(result.is_err());
    }

    #[test]
    fn sweep_ready_after_30_days() {
        let finalized_ts = 1_000;
        let now = finalized_ts + WINNERS_CLAIM_WINDOW_SECS + 1;
        let result = validate_sweep_ready(RoundStatus::Finalized as u8, finalized_ts, now);
        assert!(result.is_ok());
    }

    #[test]
    fn claim_source_switches_after_window() {
        let finalized_ts = 1_000;
        let before = finalized_ts + WINNERS_CLAIM_WINDOW_SECS;
        let after = finalized_ts + WINNERS_CLAIM_WINDOW_SECS + 1;
        let before_source = if before <= finalized_ts + WINNERS_CLAIM_WINDOW_SECS {
            0
        } else {
            1
        };
        let after_source = if after <= finalized_ts + WINNERS_CLAIM_WINDOW_SECS {
            0
        } else {
            1
        };
        assert_eq!(before_source, 0);
        assert_eq!(after_source, 1);
    }

    #[test]
    fn sweep_conserves_funds_and_is_idempotent() {
        let (w0, u0) = move_winners_to_unclaimed(100, 25).unwrap();
        assert_eq!(w0, 0);
        assert_eq!(u0, 125);

        let (w1, u1) = move_winners_to_unclaimed(w0, u0).unwrap();
        assert_eq!(w1, 0);
        assert_eq!(u1, 125);
    }

    #[test]
    fn merkle_root_single_leaf_proof_is_self_hash() {
        let leaf = 7u32;
        let root = compute_merkle_root_for_leaf(leaf, &[]);
        assert_eq!(root, hash_leaf_index(leaf));
    }

    #[test]
    fn merkle_root_two_leafs_matches_fold() {
        let a = hash_leaf_index(0);
        let b = hash_leaf_index(1);
        let root = hash_pair(a, b);

        let proof_for_zero = vec![b];
        let proof_for_one = vec![a];
        assert_eq!(compute_merkle_root_for_leaf(0, &proof_for_zero), root);
        assert_eq!(compute_merkle_root_for_leaf(1, &proof_for_one), root);
    }

    #[test]
    fn owner_must_match_claimer() {
        let owner = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        assert!(verify_owner_matches_claimer(owner, owner).is_ok());
        assert!(verify_owner_matches_claimer(owner, other).is_err());
    }

    #[test]
    fn ticket_proof_hash_is_deterministic() {
        let owner = Pubkey::new_unique();
        let tree = Pubkey::new_unique();
        let proof = vec![[1u8; 32], [2u8; 32]];
        let h1 = compute_ticket_proof_hash(42, tree, 7, owner, &proof);
        let h2 = compute_ticket_proof_hash(42, tree, 7, owner, &proof);
        assert_eq!(h1, h2);
    }

    #[test]
    fn ticket_proof_hash_changes_with_owner() {
        let owner_a = Pubkey::new_unique();
        let owner_b = Pubkey::new_unique();
        let tree = Pubkey::new_unique();
        let proof = vec![[3u8; 32]];
        let h1 = compute_ticket_proof_hash(42, tree, 7, owner_a, &proof);
        let h2 = compute_ticket_proof_hash(42, tree, 7, owner_b, &proof);
        assert_ne!(h1, h2);
    }

    #[test]
    fn ticket_proof_hash_changes_with_round_context() {
        let owner = Pubkey::new_unique();
        let tree_a = Pubkey::new_unique();
        let tree_b = Pubkey::new_unique();
        let proof = vec![[4u8; 32]];
        let h1 = compute_ticket_proof_hash(42, tree_a, 7, owner, &proof);
        let h2 = compute_ticket_proof_hash(43, tree_a, 7, owner, &proof);
        let h3 = compute_ticket_proof_hash(42, tree_b, 7, owner, &proof);
        assert_ne!(h1, h2);
        assert_ne!(h1, h3);
    }
}
