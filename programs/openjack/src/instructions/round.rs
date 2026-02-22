use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
#[cfg(feature = "canonical-freeze-prototype")]
use anchor_lang::solana_program::ed25519_program;
#[cfg(feature = "canonical-freeze-prototype")]
use anchor_lang::solana_program::instruction::Instruction;
#[cfg(feature = "canonical-freeze-prototype")]
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::constants::SETTLEMENT_WINDOW_SECS;
#[cfg(feature = "canonical-freeze-prototype")]
use crate::constants::PROTOTYPE_COUNT_BATCH_MAX_LEN;
use crate::errors::OpenJackError;
use crate::events::{DrawFulfilled, RoundStatusChanged};
#[cfg(feature = "canonical-freeze-prototype")]
use crate::events::CountBatchObserved;
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

#[cfg(feature = "canonical-freeze-prototype")]
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CountBatchArgs {
    pub start_index: u32,
    pub batch_len: u32,
    pub batch_hash: [u8; 32],
    pub leaf_proofs: Vec<Vec<[u8; 32]>>,
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

#[cfg(feature = "canonical-freeze-prototype")]
#[derive(Accounts)]
pub struct BeginFreeze<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

#[cfg(feature = "canonical-freeze-prototype")]
#[derive(Accounts)]
pub struct FreezeTicketSet<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

#[cfg(feature = "canonical-freeze-prototype")]
#[derive(Accounts)]
pub struct CountBatch<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

#[cfg(feature = "canonical-freeze-prototype")]
#[derive(Accounts)]
pub struct FinalizeCountsFastPath<'info> {
    /// CHECK: instruction sysvar account is address-checked.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub round: Account<'info, Round>,
}

#[cfg(feature = "canonical-freeze-prototype")]
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FinalizeCountsFastPathArgs {
    pub round_id: u64,
    pub ticket_set_root: [u8; 32],
    pub ticket_count_frozen: u32,
    pub winning_main: [u8; 5],
    pub winning_bonus: u8,
    pub tier_winner_counts: [u32; 6],
    pub verifier_pubkey: Pubkey,
    pub mock_public_inputs: [u8; 32],
    pub mock_proof: [u8; 32],
    pub mock_verifier_ok: bool,
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
    #[cfg(feature = "canonical-freeze-prototype")]
    {
        round.freeze_committed = false;
        round.ticket_set_root = [0u8; 32];
        round.ticket_count_frozen = 0;
        round.leaf_start_index = 0;
        round.leaf_end_index = 0;
        round.freeze_committed_ts = 0;
        round.freeze_attempts = 0;
        round.count_progress_index = 0;
        round.count_finalized = false;
        round.count_last_batch_set = false;
        round.count_last_batch_start = 0;
        round.count_last_batch_len = 0;
        round.count_last_batch_hash = [0u8; 32];
        round.count_batches_accepted = 0;
        round.count_batches_noop_replay = 0;
        round.count_last_result_code = 0;
        round.count_last_result_count = 0;
    }
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

#[cfg(feature = "canonical-freeze-prototype")]
pub fn begin_freeze(ctx: Context<BeginFreeze>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let now = Clock::get()?.unix_timestamp;
    validate_begin_freeze_state(round.status, now, round.close_ts)?;

    round.status = RoundStatus::ClosedPendingFreeze as u8;
    emit!(RoundStatusChanged {
        round_id: round.round_id,
        from_status: RoundStatus::Closed as u8,
        to_status: RoundStatus::ClosedPendingFreeze as u8,
        ts: now,
    });
    Ok(())
}

#[cfg(feature = "canonical-freeze-prototype")]
pub fn freeze_ticket_set(ctx: Context<FreezeTicketSet>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let now = Clock::get()?.unix_timestamp;
    let changed = apply_prototype_freeze(round, now)?;
    if changed {
        let from_status = round.status;
        round.status = RoundStatus::ClosedFrozen as u8;
        emit!(RoundStatusChanged {
            round_id: round.round_id,
            from_status,
            to_status: RoundStatus::ClosedFrozen as u8,
            ts: now,
        });
    }

    Ok(())
}

#[cfg(feature = "canonical-freeze-prototype")]
pub fn count_batch(ctx: Context<CountBatch>, args: CountBatchArgs) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let now = Clock::get()?.unix_timestamp;
    let outcome = apply_count_batch(round, &args)?;
    let remaining = round
        .ticket_count_frozen
        .saturating_sub(round.count_progress_index);
    emit!(CountBatchObserved {
        round_id: round.round_id,
        processed: round.count_progress_index,
        total: round.ticket_count_frozen,
        remaining,
        last_result_code: outcome.result_code,
        last_result_count: round.count_last_result_count,
        accepted_batches: round.count_batches_accepted,
        noop_replay_batches: round.count_batches_noop_replay,
        ts: now,
    });
    Ok(())
}

#[cfg(feature = "canonical-freeze-prototype")]
pub fn finalize_counts_fast_path(
    ctx: Context<FinalizeCountsFastPath>,
    args: FinalizeCountsFastPathArgs,
) -> Result<()> {
    validate_fast_path_verifier_instruction(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &args.verifier_pubkey,
        &args.mock_public_inputs,
    )?;
    let round = &mut ctx.accounts.round;
    apply_finalize_counts_fast_path(round, &args)?;
    Ok(())
}

pub fn request_draw(ctx: Context<RequestDraw>, args: RequestDrawArgs) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let now = Clock::get()?.unix_timestamp;
    require!(can_request_draw_from_status(round.status), OpenJackError::InvalidRoundState);
    require!(now >= round.close_ts, OpenJackError::RoundNotClosable);
    require!(
        args.vrf_request != Pubkey::default(),
        OpenJackError::VrfUnauthorized
    );

    round.vrf_request = args.vrf_request;
    let from_status = round.status;
    round.status = RoundStatus::Drawing as u8;
    emit!(RoundStatusChanged {
        round_id: round.round_id,
        from_status,
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

fn can_request_draw_from_status(status: u8) -> bool {
    let base = status == RoundStatus::Closed as u8;
    #[cfg(feature = "canonical-freeze-prototype")]
    let prototype = status == RoundStatus::ClosedFrozen as u8;
    #[cfg(not(feature = "canonical-freeze-prototype"))]
    let prototype = false;
    base || prototype
}

#[cfg(feature = "canonical-freeze-prototype")]
fn derive_prototype_ticket_set_root(
    round_id: u64,
    tree_address: Pubkey,
    ticket_count: u32,
    close_ts: i64,
    leaf_start_index: u32,
    leaf_end_index: u32,
) -> [u8; 32] {
    if ticket_count == 0 {
        return derive_prototype_empty_ticket_set_root(
            round_id,
            tree_address,
            close_ts,
            leaf_start_index,
            leaf_end_index,
        );
    }

    let mut level = build_prototype_merkle_leaves(round_id, tree_address, ticket_count, close_ts);
    while level.len() > 1 {
        level = fold_prototype_merkle_level(&level);
    }
    level[0]
}

#[cfg(feature = "canonical-freeze-prototype")]
fn derive_prototype_empty_ticket_set_root(
    round_id: u64,
    tree_address: Pubkey,
    close_ts: i64,
    leaf_start_index: u32,
    leaf_end_index: u32,
) -> [u8; 32] {
    hashv(&[
        b"openjack:prototype:ticket_set_root:empty:v1",
        round_id.to_le_bytes().as_ref(),
        tree_address.as_ref(),
        close_ts.to_le_bytes().as_ref(),
        leaf_start_index.to_le_bytes().as_ref(),
        leaf_end_index.to_le_bytes().as_ref(),
    ])
    .to_bytes()
}

#[cfg(feature = "canonical-freeze-prototype")]
fn build_prototype_merkle_leaves(
    round_id: u64,
    tree_address: Pubkey,
    ticket_count: u32,
    close_ts: i64,
) -> Vec<[u8; 32]> {
    let width = prototype_merkle_width(ticket_count);
    let mut leaves = Vec::with_capacity(width);
    for i in 0..width {
        let index = i as u32;
        let leaf = if index < ticket_count {
            derive_prototype_ticket_leaf(round_id, tree_address, ticket_count, close_ts, index)
        } else {
            derive_prototype_padding_leaf(round_id, tree_address, ticket_count, close_ts, index)
        };
        leaves.push(leaf);
    }
    leaves
}

#[cfg(feature = "canonical-freeze-prototype")]
fn fold_prototype_merkle_level(level: &[[u8; 32]]) -> Vec<[u8; 32]> {
    let mut next = Vec::with_capacity(level.len() / 2);
    for pair in level.chunks_exact(2) {
        next.push(hash_prototype_merkle_node(pair[0], pair[1]));
    }
    next
}

#[cfg(feature = "canonical-freeze-prototype")]
fn prototype_merkle_width(ticket_count: u32) -> usize {
    let count = usize::max(1, ticket_count as usize);
    count.next_power_of_two()
}

#[cfg(feature = "canonical-freeze-prototype")]
fn prototype_merkle_depth(ticket_count: u32) -> usize {
    let mut width = prototype_merkle_width(ticket_count);
    let mut depth = 0usize;
    while width > 1 {
        width >>= 1;
        depth += 1;
    }
    depth
}

#[cfg(feature = "canonical-freeze-prototype")]
fn derive_prototype_ticket_leaf(
    round_id: u64,
    tree_address: Pubkey,
    ticket_count: u32,
    close_ts: i64,
    leaf_index: u32,
) -> [u8; 32] {
    hashv(&[
        b"openjack:prototype:ticket_leaf:v1",
        round_id.to_le_bytes().as_ref(),
        tree_address.as_ref(),
        ticket_count.to_le_bytes().as_ref(),
        close_ts.to_le_bytes().as_ref(),
        leaf_index.to_le_bytes().as_ref(),
    ])
    .to_bytes()
}

#[cfg(feature = "canonical-freeze-prototype")]
fn derive_prototype_padding_leaf(
    round_id: u64,
    tree_address: Pubkey,
    ticket_count: u32,
    close_ts: i64,
    leaf_index: u32,
) -> [u8; 32] {
    hashv(&[
        b"openjack:prototype:ticket_leaf:pad:v1",
        round_id.to_le_bytes().as_ref(),
        tree_address.as_ref(),
        ticket_count.to_le_bytes().as_ref(),
        close_ts.to_le_bytes().as_ref(),
        leaf_index.to_le_bytes().as_ref(),
    ])
    .to_bytes()
}

#[cfg(feature = "canonical-freeze-prototype")]
fn hash_prototype_merkle_node(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    hashv(&[
        b"openjack:prototype:ticket_node:v1",
        left.as_ref(),
        right.as_ref(),
    ])
    .to_bytes()
}

#[cfg(feature = "canonical-freeze-prototype")]
fn verify_prototype_ticket_membership(
    round: &Round,
    leaf_index: u32,
    siblings: &[[u8; 32]],
) -> bool {
    if leaf_index >= round.ticket_count_frozen {
        return false;
    }

    let expected_depth = prototype_merkle_depth(round.ticket_count_frozen);
    if siblings.len() != expected_depth {
        return false;
    }

    let mut cursor = derive_prototype_ticket_leaf(
        round.round_id,
        round.tree_address,
        round.ticket_count_frozen,
        round.close_ts,
        leaf_index,
    );
    let mut idx = leaf_index as usize;
    for sibling in siblings {
        cursor = if (idx & 1) == 0 {
            hash_prototype_merkle_node(cursor, *sibling)
        } else {
            hash_prototype_merkle_node(*sibling, cursor)
        };
        idx >>= 1;
    }

    cursor == round.ticket_set_root
}

#[cfg(feature = "canonical-freeze-prototype")]
#[cfg(test)]
fn derive_prototype_ticket_membership_proof(round: &Round, leaf_index: u32) -> Option<Vec<[u8; 32]>> {
    if leaf_index >= round.ticket_count_frozen {
        return None;
    }
    let mut level = build_prototype_merkle_leaves(
        round.round_id,
        round.tree_address,
        round.ticket_count_frozen,
        round.close_ts,
    );
    let mut idx = leaf_index as usize;
    let mut siblings = Vec::new();
    while level.len() > 1 {
        let sibling = if (idx & 1) == 0 {
            level[idx + 1]
        } else {
            level[idx - 1]
        };
        siblings.push(sibling);
        level = fold_prototype_merkle_level(&level);
        idx >>= 1;
    }
    Some(siblings)
}

#[cfg(feature = "canonical-freeze-prototype")]
fn apply_prototype_freeze(round: &mut Round, now: i64) -> Result<bool> {
    require!(
        round.status == RoundStatus::ClosedPendingFreeze as u8
            || round.status == RoundStatus::ClosedFrozen as u8,
        OpenJackError::FreezeStateInvalid
    );

    round.freeze_attempts = round
        .freeze_attempts
        .checked_add(1)
        .ok_or(OpenJackError::MathOverflow)?;

    let leaf_start_index = 0u32;
    let leaf_end_index = round.ticket_count;
    validate_freeze_source_bounds(leaf_start_index, leaf_end_index)?;

    let derived_root = derive_prototype_ticket_set_root(
        round.round_id,
        round.tree_address,
        round.ticket_count,
        round.close_ts,
        leaf_start_index,
        leaf_end_index,
    );

    if round.freeze_committed {
        require!(
            round.ticket_set_root == derived_root
                && round.ticket_count_frozen == round.ticket_count
                && round.leaf_start_index == leaf_start_index
                && round.leaf_end_index == leaf_end_index,
            OpenJackError::FreezeCommitmentMismatch
        );
    } else {
        round.freeze_committed = true;
        round.ticket_set_root = derived_root;
        round.ticket_count_frozen = round.ticket_count;
        round.leaf_start_index = leaf_start_index;
        round.leaf_end_index = leaf_end_index;
        round.freeze_committed_ts = now;
    }

    Ok(round.status != RoundStatus::ClosedFrozen as u8)
}

#[cfg(feature = "canonical-freeze-prototype")]
const COUNT_RESULT_ACCEPTED: u16 = 1;
#[cfg(feature = "canonical-freeze-prototype")]
const COUNT_RESULT_NOOP_REPLAY: u16 = 2;

#[cfg(feature = "canonical-freeze-prototype")]
#[derive(Debug)]
struct CountBatchOutcome {
    result_code: u16,
}

#[cfg(feature = "canonical-freeze-prototype")]
fn apply_count_batch(round: &mut Round, args: &CountBatchArgs) -> Result<CountBatchOutcome> {
    require!(
        round.status == RoundStatus::ClosedFrozen as u8,
        OpenJackError::InvalidRoundState
    );
    require!(round.freeze_committed, OpenJackError::FreezeStateInvalid);
    require!(args.batch_len > 0, OpenJackError::CountBatchEmpty);
    require!(
        args.batch_len <= PROTOTYPE_COUNT_BATCH_MAX_LEN,
        OpenJackError::CountBatchTooLarge
    );

    let batch_end = args
        .start_index
        .checked_add(args.batch_len)
        .ok_or(OpenJackError::MathOverflow)?;
    require!(
        batch_end <= round.ticket_count_frozen,
        OpenJackError::CountBatchOutOfBounds
    );
    require!(
        args.leaf_proofs.len() == args.batch_len as usize,
        OpenJackError::CountBatchMembershipInvalid
    );

    if args.start_index > round.count_progress_index {
        return Err(OpenJackError::CountProgressGap.into());
    }

    for offset in 0..(args.batch_len as usize) {
        let leaf_index = args.start_index + offset as u32;
        require!(
            verify_prototype_ticket_membership(round, leaf_index, &args.leaf_proofs[offset]),
            OpenJackError::CountBatchMembershipInvalid
        );
    }

    let expected_batch_hash = derive_count_batch_work_digest(
        round.ticket_set_root,
        args.start_index,
        args.batch_len,
        &args.leaf_proofs,
    );
    require!(
        expected_batch_hash == args.batch_hash,
        OpenJackError::CountBatchWorkMismatch
    );

    if args.start_index < round.count_progress_index {
        require!(round.count_last_batch_set, OpenJackError::CountReplayMismatch);
        require!(
            round.count_last_batch_start == args.start_index
                && round.count_last_batch_len == args.batch_len
                && round.count_last_batch_hash == args.batch_hash,
            OpenJackError::CountReplayMismatch
        );
        round.count_batches_noop_replay = round
            .count_batches_noop_replay
            .checked_add(1)
            .ok_or(OpenJackError::MathOverflow)?;
        set_count_last_result(round, COUNT_RESULT_NOOP_REPLAY)?;
        return Ok(CountBatchOutcome {
            result_code: COUNT_RESULT_NOOP_REPLAY,
        });
    }

    round.count_progress_index = batch_end;
    round.count_last_batch_set = true;
    round.count_last_batch_start = args.start_index;
    round.count_last_batch_len = args.batch_len;
    round.count_last_batch_hash = args.batch_hash;
    round.count_batches_accepted = round
        .count_batches_accepted
        .checked_add(1)
        .ok_or(OpenJackError::MathOverflow)?;
    set_count_last_result(round, COUNT_RESULT_ACCEPTED)?;
    if round.count_progress_index == round.ticket_count_frozen {
        round.count_finalized = true;
    }
    Ok(CountBatchOutcome {
        result_code: COUNT_RESULT_ACCEPTED,
    })
}

#[cfg(feature = "canonical-freeze-prototype")]
fn set_count_last_result(round: &mut Round, result_code: u16) -> Result<()> {
    if round.count_last_result_code == result_code {
        round.count_last_result_count = round
            .count_last_result_count
            .checked_add(1)
            .ok_or(OpenJackError::MathOverflow)?;
    } else {
        round.count_last_result_code = result_code;
        round.count_last_result_count = 1;
    }
    Ok(())
}

#[cfg(feature = "canonical-freeze-prototype")]
fn apply_finalize_counts_fast_path(
    round: &mut Round,
    args: &FinalizeCountsFastPathArgs,
) -> Result<bool> {
    require!(
        round.status == RoundStatus::ClosedFrozen as u8,
        OpenJackError::InvalidRoundState
    );
    require!(round.freeze_committed, OpenJackError::FreezeStateInvalid);
    require!(
        args.mock_verifier_ok,
        OpenJackError::FastPathVerifierRejected
    );
    validate_fast_path_bindings(round, args)?;
    validate_fast_path_mock_interface(round, args)?;

    if round.count_finalized {
        require!(
            round.count_progress_index == round.ticket_count_frozen
                && round.tier_winner_counts == args.tier_winner_counts,
            OpenJackError::CountReplayMismatch
        );
        return Ok(false);
    }

    round.tier_winner_counts = args.tier_winner_counts;
    round.count_progress_index = round.ticket_count_frozen;
    round.count_finalized = true;
    Ok(true)
}

#[cfg(feature = "canonical-freeze-prototype")]
fn validate_fast_path_bindings(round: &Round, args: &FinalizeCountsFastPathArgs) -> Result<()> {
    require!(
        args.round_id == round.round_id,
        OpenJackError::FastPathRoundIdMismatch
    );
    require!(
        args.ticket_set_root == round.ticket_set_root,
        OpenJackError::FastPathTicketSetRootMismatch
    );
    require!(
        args.ticket_count_frozen == round.ticket_count_frozen,
        OpenJackError::FastPathTicketCountMismatch
    );
    require!(
        args.winning_main == round.winning_main,
        OpenJackError::FastPathWinningMainMismatch
    );
    require!(
        args.winning_bonus == round.winning_bonus,
        OpenJackError::FastPathWinningBonusMismatch
    );
    require!(
        args.tier_winner_counts == round.tier_winner_counts || !round.count_finalized,
        OpenJackError::FastPathTierWinnerCountsMismatch
    );
    Ok(())
}

#[cfg(feature = "canonical-freeze-prototype")]
fn derive_mock_public_inputs_digest(
    round_id: u64,
    ticket_set_root: [u8; 32],
    ticket_count_frozen: u32,
    winning_main: [u8; 5],
    winning_bonus: u8,
    tier_winner_counts: [u32; 6],
    verifier_pubkey: Pubkey,
) -> [u8; 32] {
    let mut tier_counts_le = [0u8; 24];
    for (i, c) in tier_winner_counts.iter().enumerate() {
        let start = i * 4;
        tier_counts_le[start..start + 4].copy_from_slice(&c.to_le_bytes());
    }
    hashv(&[
        b"openjack:prototype:fast_path:public_inputs:v1",
        round_id.to_le_bytes().as_ref(),
        ticket_set_root.as_ref(),
        ticket_count_frozen.to_le_bytes().as_ref(),
        winning_main.as_ref(),
        &[winning_bonus],
        tier_counts_le.as_ref(),
        verifier_pubkey.as_ref(),
    ])
    .to_bytes()
}

#[cfg(feature = "canonical-freeze-prototype")]
fn derive_mock_proof_digest(mock_public_inputs: [u8; 32]) -> [u8; 32] {
    hashv(&[
        b"openjack:prototype:fast_path:proof:v1",
        mock_public_inputs.as_ref(),
    ])
    .to_bytes()
}

#[cfg(feature = "canonical-freeze-prototype")]
fn validate_fast_path_mock_interface(round: &Round, args: &FinalizeCountsFastPathArgs) -> Result<()> {
    let expected_inputs = derive_mock_public_inputs_digest(
        round.round_id,
        round.ticket_set_root,
        round.ticket_count_frozen,
        round.winning_main,
        round.winning_bonus,
        args.tier_winner_counts,
        args.verifier_pubkey,
    );
    require!(
        args.mock_public_inputs == expected_inputs,
        OpenJackError::FastPathMockPublicInputsMismatch
    );

    let expected_proof = derive_mock_proof_digest(args.mock_public_inputs);
    require!(
        args.mock_proof == expected_proof,
        OpenJackError::FastPathMockProofMismatch
    );
    Ok(())
}

#[cfg(feature = "canonical-freeze-prototype")]
fn validate_fast_path_verifier_instruction(
    ix_sysvar_ai: &AccountInfo,
    expected_pubkey: &Pubkey,
    expected_message: &[u8; 32],
) -> Result<()> {
    let current_ix_index = load_current_index_checked(ix_sysvar_ai)
        .map_err(|_| error!(OpenJackError::FastPathVerifierInstructionMissing))?;
    require!(
        current_ix_index > 0,
        OpenJackError::FastPathVerifierInstructionMissing
    );

    let verifier_ix = load_instruction_at_checked((current_ix_index - 1) as usize, ix_sysvar_ai)
        .map_err(|_| error!(OpenJackError::FastPathVerifierInstructionMissing))?;
    validate_single_ed25519_verify_ix(&verifier_ix, expected_pubkey, expected_message)
}

#[cfg(feature = "canonical-freeze-prototype")]
fn validate_single_ed25519_verify_ix(
    ix: &Instruction,
    expected_pubkey: &Pubkey,
    expected_message: &[u8; 32],
) -> Result<()> {
    require!(
        ix.program_id == ed25519_program::id(),
        OpenJackError::FastPathVerifierInstructionInvalid
    );

    let data = ix.data.as_slice();
    require!(
        data.len() >= 16 && data[0] == 1u8,
        OpenJackError::FastPathVerifierInstructionInvalid
    );

    let read_u16 = |offset: usize| -> Result<u16> {
        let bytes = data
            .get(offset..offset + 2)
            .ok_or_else(|| error!(OpenJackError::FastPathVerifierInstructionInvalid))?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    };

    let signature_offset = read_u16(2)? as usize;
    let signature_ix_index = read_u16(4)?;
    let pubkey_offset = read_u16(6)? as usize;
    let pubkey_ix_index = read_u16(8)?;
    let message_offset = read_u16(10)? as usize;
    let message_size = read_u16(12)? as usize;
    let message_ix_index = read_u16(14)?;
    require!(
        signature_ix_index == u16::MAX
            && pubkey_ix_index == u16::MAX
            && message_ix_index == u16::MAX,
        OpenJackError::FastPathVerifierInstructionInvalid
    );

    let pubkey_bytes = data
        .get(pubkey_offset..pubkey_offset + 32)
        .ok_or_else(|| error!(OpenJackError::FastPathVerifierInstructionInvalid))?;
    let signature_bytes = data
        .get(signature_offset..signature_offset + 64)
        .ok_or_else(|| error!(OpenJackError::FastPathVerifierInstructionInvalid))?;
    let message_bytes = data
        .get(message_offset..message_offset + message_size)
        .ok_or_else(|| error!(OpenJackError::FastPathVerifierInstructionInvalid))?;
    require!(
        !signature_bytes.is_empty(),
        OpenJackError::FastPathVerifierInstructionInvalid
    );

    require!(
        pubkey_bytes == expected_pubkey.as_ref(),
        OpenJackError::FastPathVerifierPubkeyMismatch
    );
    require!(
        message_size == expected_message.len() && message_bytes == expected_message,
        OpenJackError::FastPathVerifierMessageMismatch
    );
    Ok(())
}

#[cfg(feature = "canonical-freeze-prototype")]
fn derive_count_batch_work_digest(
    ticket_set_root: [u8; 32],
    start_index: u32,
    batch_len: u32,
    leaf_proofs: &[Vec<[u8; 32]>],
) -> [u8; 32] {
    let mut acc = hashv(&[
        b"openjack:prototype:count_batch:v1",
        ticket_set_root.as_ref(),
        start_index.to_le_bytes().as_ref(),
        batch_len.to_le_bytes().as_ref(),
    ])
    .to_bytes();
    for (i, siblings) in leaf_proofs.iter().enumerate() {
        let idx = start_index + (i as u32);
        acc = hashv(&[
            b"leaf",
            ticket_set_root.as_ref(),
            idx.to_le_bytes().as_ref(),
            hashv(
                siblings
                    .iter()
                    .map(|s| s.as_ref())
                    .collect::<Vec<_>>()
                    .as_slice(),
            )
            .as_ref(),
            acc.as_ref(),
        ])
        .to_bytes();
    }
    acc
}

#[cfg(feature = "canonical-freeze-prototype")]
fn validate_begin_freeze_state(status: u8, now: i64, close_ts: i64) -> Result<()> {
    require!(
        status == RoundStatus::Closed as u8,
        OpenJackError::FreezeStateInvalid
    );
    require!(now >= close_ts, OpenJackError::RoundNotClosable);
    Ok(())
}

#[cfg(feature = "canonical-freeze-prototype")]
fn validate_freeze_source_bounds(leaf_start_index: u32, leaf_end_index: u32) -> Result<()> {
    require!(
        leaf_end_index >= leaf_start_index,
        OpenJackError::FreezeSourceInvalid
    );
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
    fn request_draw_status_gate_accepts_closed() {
        assert!(can_request_draw_from_status(RoundStatus::Closed as u8));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn request_draw_status_gate_accepts_closed_frozen_in_prototype() {
        assert!(can_request_draw_from_status(RoundStatus::ClosedFrozen as u8));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn prototype_ticket_set_root_is_deterministic() {
        let tree = Pubkey::new_unique();
        let a = derive_prototype_ticket_set_root(42, tree, 123, 1_700_000_000, 0, 123);
        let b = derive_prototype_ticket_set_root(42, tree, 123, 1_700_000_000, 0, 123);
        assert_eq!(a, b);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn prototype_ticket_set_root_changes_when_inputs_change() {
        let tree = Pubkey::new_unique();
        let base = derive_prototype_ticket_set_root(42, tree, 123, 1_700_000_000, 0, 123);
        let changed_count = derive_prototype_ticket_set_root(42, tree, 124, 1_700_000_000, 0, 124);
        assert_ne!(base, changed_count);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    fn prototype_round(status: RoundStatus) -> Round {
        Round {
            round_id: 99,
            status: status as u8,
            open_ts: 0,
            close_ts: 1_700_000_000,
            draw_ts: 0,
            settle_deadline_ts: 0,
            tree_address: Pubkey::new_unique(),
            ticket_count: 42,
            sales_lamports: 0,
            treasury_paid_lamports: 0,
            jackpot_pool_balance: 0,
            tier_pool_balances: [0; 5],
            winners_pool_balance: 0,
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
            freeze_committed: false,
            ticket_set_root: [0; 32],
            ticket_count_frozen: 0,
            leaf_start_index: 0,
            leaf_end_index: 0,
            freeze_committed_ts: 0,
            freeze_attempts: 0,
            count_progress_index: 0,
            count_finalized: false,
            count_last_batch_set: false,
            count_last_batch_start: 0,
            count_last_batch_len: 0,
            count_last_batch_hash: [0; 32],
            count_batches_accepted: 0,
            count_batches_noop_replay: 0,
            count_last_result_code: 0,
            count_last_result_count: 0,
            bump: 0,
        }
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    fn batch_args(round: &Round, start_index: u32, batch_len: u32) -> CountBatchArgs {
        let mut leaf_proofs = Vec::with_capacity(batch_len as usize);
        for i in 0..batch_len {
            let idx = start_index + i;
            let proof = derive_prototype_ticket_membership_proof(round, idx)
                .expect("membership proof must exist for in-range fixture");
            leaf_proofs.push(proof);
        }
        CountBatchArgs {
            start_index,
            batch_len,
            batch_hash: derive_count_batch_work_digest(
                round.ticket_set_root,
                start_index,
                batch_len,
                &leaf_proofs,
            ),
            leaf_proofs,
        }
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    fn commit_test_frozen_root(round: &mut Round) {
        round.ticket_set_root = derive_prototype_ticket_set_root(
            round.round_id,
            round.tree_address,
            round.ticket_count_frozen,
            round.close_ts,
            0,
            round.ticket_count_frozen,
        );
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    fn fast_path_args(
        round: &Round,
        tier_winner_counts: [u32; 6],
        mock_verifier_ok: bool,
    ) -> FinalizeCountsFastPathArgs {
        let verifier_pubkey = Pubkey::new_from_array([42; 32]);
        let mock_public_inputs = derive_mock_public_inputs_digest(
            round.round_id,
            round.ticket_set_root,
            round.ticket_count_frozen,
            round.winning_main,
            round.winning_bonus,
            tier_winner_counts,
            verifier_pubkey,
        );
        let mock_proof = derive_mock_proof_digest(mock_public_inputs);
        FinalizeCountsFastPathArgs {
            round_id: round.round_id,
            ticket_set_root: round.ticket_set_root,
            ticket_count_frozen: round.ticket_count_frozen,
            winning_main: round.winning_main,
            winning_bonus: round.winning_bonus,
            tier_winner_counts,
            verifier_pubkey,
            mock_public_inputs,
            mock_proof,
            mock_verifier_ok,
        }
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn apply_prototype_freeze_commits_then_is_idempotent_on_retry() {
        let mut round = prototype_round(RoundStatus::ClosedPendingFreeze);
        let changed = apply_prototype_freeze(&mut round, 1_700_000_010).unwrap();
        assert!(changed);
        assert!(round.freeze_committed);
        assert_eq!(round.freeze_attempts, 1);
        assert_eq!(round.ticket_count_frozen, round.ticket_count);
        assert_eq!(round.leaf_start_index, 0);
        assert_eq!(round.leaf_end_index, round.ticket_count);
        let committed_root = round.ticket_set_root;
        let committed_ts = round.freeze_committed_ts;

        round.status = RoundStatus::ClosedFrozen as u8;
        let changed_again = apply_prototype_freeze(&mut round, 1_700_000_020).unwrap();
        assert!(!changed_again);
        assert_eq!(round.freeze_attempts, 2);
        assert_eq!(round.ticket_set_root, committed_root);
        assert_eq!(round.freeze_committed_ts, committed_ts);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn apply_prototype_freeze_rejects_commitment_mismatch() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        let expected = derive_prototype_ticket_set_root(
            round.round_id,
            round.tree_address,
            round.ticket_count,
            round.close_ts,
            0,
            round.ticket_count,
        );
        round.freeze_committed = true;
        round.ticket_set_root = expected;
        round.ticket_count_frozen = round.ticket_count + 1;
        round.leaf_start_index = 0;
        round.leaf_end_index = round.ticket_count;

        let err = apply_prototype_freeze(&mut round, 1_700_000_020).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("FreezeCommitmentMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn begin_freeze_validation_rejects_before_close() {
        let err = validate_begin_freeze_state(
            RoundStatus::Closed as u8,
            1_700_000_000,
            1_700_000_001,
        )
        .unwrap_err();
        assert!(err.to_string().contains("RoundNotClosable"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn begin_freeze_validation_rejects_wrong_state() {
        let err =
            validate_begin_freeze_state(RoundStatus::Open as u8, 1_700_000_010, 1_700_000_001)
                .unwrap_err();
        assert!(err.to_string().contains("FreezeStateInvalid"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn apply_prototype_freeze_rejects_invalid_state() {
        let mut round = prototype_round(RoundStatus::Open);
        let err = apply_prototype_freeze(&mut round, 1_700_000_020).unwrap_err();
        assert!(err.to_string().contains("FreezeStateInvalid"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn freeze_source_bounds_reject_inverted_range() {
        let err = validate_freeze_source_bounds(5, 4).unwrap_err();
        assert!(err.to_string().contains("FreezeSourceInvalid"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn apply_prototype_freeze_rejects_attempt_counter_overflow() {
        let mut round = prototype_round(RoundStatus::ClosedPendingFreeze);
        round.freeze_attempts = u32::MAX;
        let err = apply_prototype_freeze(&mut round, 1_700_000_020).unwrap_err();
        assert!(err.to_string().contains("MathOverflow"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn freeze_commitment_is_derived_only_from_round_state_not_caller_timing() {
        let mut round = prototype_round(RoundStatus::ClosedPendingFreeze);
        let expected = derive_prototype_ticket_set_root(
            round.round_id,
            round.tree_address,
            round.ticket_count,
            round.close_ts,
            0,
            round.ticket_count,
        );

        let _ = apply_prototype_freeze(&mut round, 1_700_000_010).unwrap();
        assert_eq!(round.ticket_set_root, expected);
        let first_ts = round.freeze_committed_ts;

        round.status = RoundStatus::ClosedFrozen as u8;
        let _ = apply_prototype_freeze(&mut round, 1_800_000_010).unwrap();
        assert_eq!(round.ticket_set_root, expected);
        assert_eq!(round.freeze_committed_ts, first_ts);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn multi_caller_race_order_keeps_same_canonical_commitment_state() {
        let mut caller_a_first = prototype_round(RoundStatus::ClosedPendingFreeze);
        let mut caller_b_first = caller_a_first.clone();

        let _ = apply_prototype_freeze(&mut caller_a_first, 1_700_000_010).unwrap();
        caller_a_first.status = RoundStatus::ClosedFrozen as u8;
        let _ = apply_prototype_freeze(&mut caller_a_first, 1_700_000_020).unwrap();

        let _ = apply_prototype_freeze(&mut caller_b_first, 1_700_000_020).unwrap();
        caller_b_first.status = RoundStatus::ClosedFrozen as u8;
        let _ = apply_prototype_freeze(&mut caller_b_first, 1_700_000_010).unwrap();

        assert_eq!(caller_a_first.freeze_committed, caller_b_first.freeze_committed);
        assert_eq!(caller_a_first.ticket_set_root, caller_b_first.ticket_set_root);
        assert_eq!(
            caller_a_first.ticket_count_frozen,
            caller_b_first.ticket_count_frozen
        );
        assert_eq!(caller_a_first.leaf_start_index, caller_b_first.leaf_start_index);
        assert_eq!(caller_a_first.leaf_end_index, caller_b_first.leaf_end_index);
        assert_eq!(caller_a_first.freeze_attempts, caller_b_first.freeze_attempts);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_advances_progress_monotonically() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 10;
        commit_test_frozen_root(&mut round);
        let args = batch_args(&round, 0, 3);

        let outcome = apply_count_batch(&mut round, &args).unwrap();
        assert_eq!(outcome.result_code, COUNT_RESULT_ACCEPTED);
        assert_eq!(round.count_progress_index, 3);
        assert!(!round.count_finalized);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_rejects_skip_ahead() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 10;
        commit_test_frozen_root(&mut round);
        round.count_progress_index = 2;
        let args = batch_args(&round, 3, 2);

        let err = apply_count_batch(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("CountProgressGap"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_replay_same_batch_is_idempotent_noop() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 10;
        commit_test_frozen_root(&mut round);
        let args = batch_args(&round, 0, 2);

        let first = apply_count_batch(&mut round, &args).unwrap();
        assert_eq!(first.result_code, COUNT_RESULT_ACCEPTED);
        let replay = apply_count_batch(&mut round, &args).unwrap();
        assert_eq!(replay.result_code, COUNT_RESULT_NOOP_REPLAY);
        assert_eq!(round.count_progress_index, 2);
        assert_eq!(round.count_batches_accepted, 1);
        assert_eq!(round.count_batches_noop_replay, 1);
        assert_eq!(round.count_last_result_code, COUNT_RESULT_NOOP_REPLAY);
        assert_eq!(round.count_last_result_count, 1);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_observability_does_not_mutate_progress_semantics() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 5;
        commit_test_frozen_root(&mut round);

        let args = batch_args(&round, 0, 2);
        let prior_finalized = round.count_finalized;
        let prior_last_batch_set = round.count_last_batch_set;
        let outcome = apply_count_batch(&mut round, &args).unwrap();

        assert_eq!(outcome.result_code, COUNT_RESULT_ACCEPTED);
        assert_eq!(round.count_progress_index, 2);
        assert_eq!(round.count_finalized, prior_finalized);
        assert_ne!(round.count_last_batch_set, prior_last_batch_set);
        assert_eq!(round.count_last_batch_start, 0);
        assert_eq!(round.count_last_batch_len, 2);
        assert_eq!(round.count_batches_accepted, 1);
        assert_eq!(round.count_batches_noop_replay, 0);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_replay_with_mismatch_rejected() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 10;
        commit_test_frozen_root(&mut round);
        let first = batch_args(&round, 0, 2);
        let mut replay_mismatch = batch_args(&round, 0, 2);
        replay_mismatch.batch_hash = [6; 32];

        apply_count_batch(&mut round, &first).unwrap();
        let err = apply_count_batch(&mut round, &replay_mismatch).unwrap_err();
        assert!(err.to_string().contains("CountBatchWorkMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_rejects_double_count_old_range() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 10;
        commit_test_frozen_root(&mut round);
        let first = batch_args(&round, 0, 2);
        let second = batch_args(&round, 2, 2);
        let old_again = batch_args(&round, 0, 2);

        apply_count_batch(&mut round, &first).unwrap();
        apply_count_batch(&mut round, &second).unwrap();
        let err = apply_count_batch(&mut round, &old_again).unwrap_err();
        assert!(err.to_string().contains("CountReplayMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_is_not_deadline_coupled() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 4;
        commit_test_frozen_root(&mut round);
        round.settle_deadline_ts = 1;
        let args = batch_args(&round, 0, 4);

        let outcome = apply_count_batch(&mut round, &args).unwrap();
        assert_eq!(outcome.result_code, COUNT_RESULT_ACCEPTED);
        assert!(round.count_finalized);
        assert_eq!(round.count_progress_index, 4);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_rejects_out_of_bounds_batch() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 3;
        commit_test_frozen_root(&mut round);
        let args = CountBatchArgs {
            start_index: 2,
            batch_len: 2,
            batch_hash: [0; 32],
            leaf_proofs: Vec::new(),
        };
        let err = apply_count_batch(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("CountBatchOutOfBounds"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_rejects_empty_batch() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 3;
        commit_test_frozen_root(&mut round);
        let args = batch_args(&round, 0, 0);
        let err = apply_count_batch(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("CountBatchEmpty"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_rejects_over_max_batch_size() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = PROTOTYPE_COUNT_BATCH_MAX_LEN + 2;
        commit_test_frozen_root(&mut round);
        let args = batch_args(&round, 0, PROTOTYPE_COUNT_BATCH_MAX_LEN + 1);
        let err = apply_count_batch(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("CountBatchTooLarge"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_multi_batch_progress_reaches_finalized_end_state() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 7;
        commit_test_frozen_root(&mut round);

        let a = batch_args(&round, 0, 3);
        apply_count_batch(&mut round, &a).unwrap();
        assert_eq!(round.count_progress_index, 3);
        assert!(!round.count_finalized);

        let b = batch_args(&round, 3, 2);
        apply_count_batch(&mut round, &b).unwrap();
        assert_eq!(round.count_progress_index, 5);
        assert!(!round.count_finalized);

        let c = batch_args(&round, 5, 2);
        apply_count_batch(&mut round, &c).unwrap();
        assert_eq!(round.count_progress_index, 7);
        assert!(round.count_finalized);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_marks_terminal_count_state() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 9;
        round.count_progress_index = 0;
        round.count_finalized = false;
        round.winning_main = [1, 2, 3, 4, 5];
        round.winning_bonus = 1;
        let expected_counts = [11, 12, 13, 14, 15, 16];
        let args = fast_path_args(&round, expected_counts, true);

        let changed = apply_finalize_counts_fast_path(&mut round, &args).unwrap();
        assert!(changed);
        assert!(round.count_finalized);
        assert_eq!(round.count_progress_index, 9);
        assert_eq!(round.tier_winner_counts, expected_counts);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_short_circuits_partial_batch_progress() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 7;
        commit_test_frozen_root(&mut round);
        round.winning_main = [2, 4, 6, 8, 10];
        round.winning_bonus = 3;
        let final_counts = [3, 2, 1, 0, 0, 0];
        let partial = batch_args(&round, 0, 3);
        apply_count_batch(&mut round, &partial).unwrap();
        assert_eq!(round.count_progress_index, 3);
        assert!(!round.count_finalized);
        let args = fast_path_args(&round, final_counts, true);
        let changed = apply_finalize_counts_fast_path(&mut round, &args).unwrap();
        assert!(changed);
        assert!(round.count_finalized);
        assert_eq!(round.count_progress_index, 7);
        assert_eq!(round.tier_winner_counts, final_counts);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_replay_is_noop_and_immutable() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 6;
        round.winning_main = [3, 6, 9, 12, 15];
        round.winning_bonus = 4;
        let counts = [6, 5, 4, 3, 2, 1];
        let args = fast_path_args(&round, counts, true);
        let changed = apply_finalize_counts_fast_path(&mut round, &args).unwrap();
        assert!(changed);
        let progress = round.count_progress_index;
        let finalized = round.count_finalized;
        let tier_counts = round.tier_winner_counts;

        let replay = apply_finalize_counts_fast_path(&mut round, &args).unwrap();
        assert!(!replay);
        assert_eq!(round.count_progress_index, progress);
        assert_eq!(round.count_finalized, finalized);
        assert_eq!(round.tier_winner_counts, tier_counts);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_after_fast_path_finalized_rejects_new_range() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 6;
        commit_test_frozen_root(&mut round);
        round.winning_main = [4, 8, 12, 16, 20];
        round.winning_bonus = 5;
        let args = fast_path_args(&round, [1, 1, 1, 1, 1, 1], true);
        apply_finalize_counts_fast_path(&mut round, &args).unwrap();

        let new_range = batch_args(&round, 0, 1);
        let err = apply_count_batch(&mut round, &new_range).unwrap_err();
        assert!(err.to_string().contains("CountReplayMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_rejects_round_id_mismatch() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 5;
        round.winning_main = [1, 3, 5, 7, 9];
        round.winning_bonus = 2;
        let mut args = fast_path_args(&round, [0; 6], true);
        args.round_id += 1;
        let err = apply_finalize_counts_fast_path(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("FastPathRoundIdMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_rejects_ticket_set_root_mismatch() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 5;
        round.ticket_set_root = [31; 32];
        round.winning_main = [1, 3, 5, 7, 9];
        round.winning_bonus = 2;
        let mut args = fast_path_args(&round, [0; 6], true);
        args.ticket_set_root = [32; 32];
        let err = apply_finalize_counts_fast_path(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("FastPathTicketSetRootMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_rejects_ticket_count_mismatch() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 5;
        round.winning_main = [1, 3, 5, 7, 9];
        round.winning_bonus = 2;
        let mut args = fast_path_args(&round, [0; 6], true);
        args.ticket_count_frozen += 1;
        let err = apply_finalize_counts_fast_path(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("FastPathTicketCountMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_rejects_winning_main_mismatch() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 5;
        round.winning_main = [1, 3, 5, 7, 9];
        round.winning_bonus = 2;
        let mut args = fast_path_args(&round, [0; 6], true);
        args.winning_main = [2, 4, 6, 8, 10];
        let err = apply_finalize_counts_fast_path(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("FastPathWinningMainMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_rejects_winning_bonus_mismatch() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 5;
        round.winning_main = [1, 3, 5, 7, 9];
        round.winning_bonus = 2;
        let mut args = fast_path_args(&round, [0; 6], true);
        args.winning_bonus = 9;
        let err = apply_finalize_counts_fast_path(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("FastPathWinningBonusMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_rejects_mock_verifier_false() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 5;
        round.winning_main = [1, 3, 5, 7, 9];
        round.winning_bonus = 2;
        let args = fast_path_args(&round, [0; 6], false);
        let err = apply_finalize_counts_fast_path(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("FastPathVerifierRejected"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_rejects_tier_winner_count_mismatch_on_replay() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 5;
        round.winning_main = [1, 3, 5, 7, 9];
        round.winning_bonus = 2;
        let args = fast_path_args(&round, [1, 2, 3, 4, 5, 6], true);
        apply_finalize_counts_fast_path(&mut round, &args).unwrap();

        let mismatch = fast_path_args(&round, [6, 5, 4, 3, 2, 1], true);
        let err = apply_finalize_counts_fast_path(&mut round, &mismatch).unwrap_err();
        assert!(err.to_string().contains("FastPathTierWinnerCountsMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_rejects_mock_public_inputs_mismatch() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 5;
        round.winning_main = [1, 3, 5, 7, 9];
        round.winning_bonus = 2;
        let mut args = fast_path_args(&round, [0; 6], true);
        args.mock_public_inputs = [99; 32];
        let err = apply_finalize_counts_fast_path(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("FastPathMockPublicInputsMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn finalize_counts_fast_path_rejects_mock_proof_mismatch() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 5;
        round.winning_main = [1, 3, 5, 7, 9];
        round.winning_bonus = 2;
        let mut args = fast_path_args(&round, [0; 6], true);
        args.mock_proof = [88; 32];
        let err = apply_finalize_counts_fast_path(&mut round, &args).unwrap_err();
        assert!(err.to_string().contains("FastPathMockProofMismatch"));
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_replay_last_batch_after_finalized_is_noop() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 4;
        commit_test_frozen_root(&mut round);

        let first = batch_args(&round, 0, 2);
        apply_count_batch(&mut round, &first).unwrap();
        let second = batch_args(&round, 2, 2);
        apply_count_batch(&mut round, &second).unwrap();
        assert!(round.count_finalized);
        assert_eq!(round.count_progress_index, 4);

        let replay = batch_args(&round, 2, 2);
        let outcome = apply_count_batch(&mut round, &replay).unwrap();
        assert_eq!(outcome.result_code, COUNT_RESULT_NOOP_REPLAY);
        assert_eq!(round.count_progress_index, 4);
        assert_eq!(round.count_batches_accepted, 2);
        assert_eq!(round.count_batches_noop_replay, 1);
        assert_eq!(round.count_last_result_code, COUNT_RESULT_NOOP_REPLAY);
    }

    #[cfg(feature = "canonical-freeze-prototype")]
    #[test]
    fn count_batch_after_finalized_new_range_rejected() {
        let mut round = prototype_round(RoundStatus::ClosedFrozen);
        round.freeze_committed = true;
        round.ticket_count_frozen = 4;
        commit_test_frozen_root(&mut round);

        let all = batch_args(&round, 0, 4);
        apply_count_batch(&mut round, &all).unwrap();
        assert!(round.count_finalized);

        let new_range = CountBatchArgs {
            start_index: 4,
            batch_len: 1,
            batch_hash: [0; 32],
            leaf_proofs: Vec::new(),
        };
        let err = apply_count_batch(&mut round, &new_range).unwrap_err();
        assert!(err.to_string().contains("CountBatchOutOfBounds"));
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
