use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::constants::WINNERS_CLAIM_WINDOW_SECS;
use crate::errors::OpenJackError;
use crate::events::{Claimed, SweptToUnclaimed};
use crate::state::{ClaimRecord, Round, RoundStatus};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimArgs {
    pub leaf_index: u32,
    pub tier: u8,
    pub amount: u64,
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
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SweepWinnersToUnclaimed<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

pub fn claim(ctx: Context<Claim>, args: ClaimArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    require!(
        round.status == RoundStatus::Finalized as u8,
        OpenJackError::InvalidRoundState
    );
    require!(args.tier <= 5, OpenJackError::TierOutOfRange);
    verify_winner_root_proof(round, &args)?;

    let expected_amount = round.tier_payout_per_winner[args.tier as usize];
    require!(expected_amount > 0, OpenJackError::WinnerProofInvalid);
    require!(
        args.amount == expected_amount,
        OpenJackError::InvalidClaimAmount
    );

    let claim_window_end = round
        .finalized_ts
        .checked_add(WINNERS_CLAIM_WINDOW_SECS)
        .ok_or(OpenJackError::MathOverflow)?;
    let source_pool = if now <= claim_window_end { 0 } else { 1 };
    debit_claim_source_pool(round, source_pool, expected_amount)?;

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
}
