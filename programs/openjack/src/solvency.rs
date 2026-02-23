use anchor_lang::prelude::*;

use crate::errors::OpenJackError;
use crate::state::Round;

pub fn required_settlement_reserve(round: &Round) -> Result<u64> {
    required_settlement_reserve_values(round.winners_pool_balance, round.unclaimed_pool_balance)
}

pub fn required_settlement_reserve_values(
    winners_pool_balance: u64,
    unclaimed_pool_balance: u64,
) -> Result<u64> {
    winners_pool_balance
        .checked_add(unclaimed_pool_balance)
        .ok_or(OpenJackError::MathOverflow.into())
}

#[cfg(feature = "canonical-freeze-prototype")]
pub fn required_undistributed_bounty(round: &Round) -> u64 {
    round.bounty_pool_balance
}

#[cfg(not(feature = "canonical-freeze-prototype"))]
pub fn required_undistributed_bounty(_: &Round) -> u64 {
    0
}

pub fn assert_round_solvency_floor(
    round: &Account<Round>,
    debit_lamports: u64,
    next_undistributed_bounty: u64,
    next_settlement_reserve: u64,
) -> Result<()> {
    let round_info = round.to_account_info();
    let round_data_len = round_info.data_len();
    let min_rent_lamports = Rent::get()?.minimum_balance(round_data_len);
    let round_balance = **round_info.try_borrow_lamports()?;
    let post_balance = round_balance
        .checked_sub(debit_lamports)
        .ok_or(OpenJackError::InsufficientPoolBalance)?;
    let required_floor = min_rent_lamports
        .checked_add(next_undistributed_bounty)
        .and_then(|v| v.checked_add(next_settlement_reserve))
        .ok_or(OpenJackError::MathOverflow)?;
    require!(
        post_balance >= required_floor,
        OpenJackError::RoundSolvencyFloorViolated
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settlement_reserve_is_sum_of_claim_obligations() {
        assert_eq!(required_settlement_reserve_values(120, 30).unwrap(), 150);
    }

    #[test]
    fn arithmetic_sequence_model_preserves_floor_terms() {
        let mut winners = 1_000u64;
        let unclaimed = 0u64;
        let mut bounty = 300u64;
        let mut balance = 5_000u64;
        let rent_floor = 500u64;

        // batch payout
        let reward_1 = 60u64;
        let reserve_1 = winners + unclaimed;
        let floor_1 = rent_floor + (bounty - reward_1) + reserve_1;
        let post_1 = balance - reward_1;
        assert!(post_1 >= floor_1);
        balance = post_1;
        bounty -= reward_1;

        // claim payout
        let claim_1 = 200u64;
        let reserve_2 = (winners - claim_1) + unclaimed;
        let floor_2 = rent_floor + bounty + reserve_2;
        let post_2 = balance - claim_1;
        assert!(post_2 >= floor_2);
        balance = post_2;
        winners -= claim_1;

        // additional batch payout
        let reward_2 = 30u64;
        let reserve_3 = winners + unclaimed;
        let floor_3 = rent_floor + (bounty - reward_2) + reserve_3;
        let post_3 = balance - reward_2;
        assert!(post_3 >= floor_3);
        balance = post_3;
        bounty -= reward_2;

        // partial batch -> fast finalize does not debit balance
        let reserve_4 = winners + unclaimed;
        let floor_4 = rent_floor + bounty + reserve_4;
        assert!(balance >= floor_4);
    }

    #[test]
    fn edge_of_rent_floor_arithmetic_detects_violation() {
        let rent_floor = 500u64;
        let bounty = 200u64;
        let reserve = 800u64;
        let balance = 1_600u64;
        let debit = 101u64;

        let floor = rent_floor + bounty + reserve;
        let post = balance - debit;
        assert_eq!(floor, 1_500);
        assert_eq!(post, 1_499);
        assert!(post < floor);
    }
}
