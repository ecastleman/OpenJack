use crate::constants::*;
use crate::errors::OpenJackError;
use anchor_lang::prelude::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PurchaseSplit {
    pub treasury: u64,
    pub bounty: u64,
    pub jackpot: u64,
    pub lower_total: u64,
    pub lower_tiers: [u64; 5],
    pub dust: u64,
}

pub fn split_ticket_revenue(total_lamports: u64) -> PurchaseSplit {
    let treasury = total_lamports.saturating_mul(TREASURY_BPS as u64) / BPS_DENOMINATOR;
    let bounty = total_lamports.saturating_mul(BOUNTY_BPS as u64) / BPS_DENOMINATOR;
    let jackpot = total_lamports.saturating_mul(JACKPOT_BPS as u64) / BPS_DENOMINATOR;
    let lower_total = total_lamports.saturating_mul(LOWER_POOL_BPS as u64) / BPS_DENOMINATOR;

    let t5_only = lower_total.saturating_mul(LOWER_T5_ONLY_BPS as u64) / BPS_DENOMINATOR;
    let t4_bonus = lower_total.saturating_mul(LOWER_T4_BONUS_BPS as u64) / BPS_DENOMINATOR;
    let t4_only = lower_total.saturating_mul(LOWER_T4_ONLY_BPS as u64) / BPS_DENOMINATOR;
    let t3_bonus = lower_total.saturating_mul(LOWER_T3_BONUS_BPS as u64) / BPS_DENOMINATOR;
    let t2_bonus = lower_total.saturating_mul(LOWER_T2_BONUS_BPS as u64) / BPS_DENOMINATOR;

    let allocated = treasury
        .saturating_add(bounty)
        .saturating_add(jackpot)
        .saturating_add(t5_only)
        .saturating_add(t4_bonus)
        .saturating_add(t4_only)
        .saturating_add(t3_bonus)
        .saturating_add(t2_bonus);

    PurchaseSplit {
        treasury,
        bounty,
        jackpot,
        lower_total,
        lower_tiers: [t5_only, t4_bonus, t4_only, t3_bonus, t2_bonus],
        dust: total_lamports.saturating_sub(allocated),
    }
}

pub fn usd_cents_to_lamports_ceil(usd_cents: u64, price_micro_usd_per_sol: u64) -> Result<u64> {
    if price_micro_usd_per_sol == 0 {
        return Err(OpenJackError::OracleInvalid.into());
    }

    // 1 USD = 1_000_000 micro-USD; 1 SOL = 1_000_000_000 lamports
    // lamports = ceil((usd * 1e6 * 1e9) / price_micro_usd_per_sol)
    let numerator = usd_cents
        .checked_mul(10_000)
        .and_then(|v| v.checked_mul(1_000_000_000))
        .ok_or(OpenJackError::MathOverflow)?;

    let result = numerator
        .checked_add(price_micro_usd_per_sol - 1)
        .and_then(|v| v.checked_div(price_micro_usd_per_sol))
        .ok_or(OpenJackError::MathOverflow)?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_does_not_over_allocate() {
        let total = 1_000_000_u64;
        let split = split_ticket_revenue(total);
        let allocated = split.treasury
            + split.bounty
            + split.jackpot
            + split.lower_tiers.iter().sum::<u64>()
            + split.dust;
        assert_eq!(allocated, total);
    }

    #[test]
    fn lower_tier_subsplit_never_exceeds_lower_pool() {
        for total in [1_u64, 10, 1_000, 1_000_000, 10_000_001] {
            let split = split_ticket_revenue(total);
            assert!(split.lower_tiers.iter().sum::<u64>() <= split.lower_total);
        }
    }

    #[test]
    fn usd_to_lamports_ceil_rounds_up() {
        // 1 SOL = 20 USD, so $2 = 0.1 SOL = 100_000_000 lamports exactly.
        let exact = usd_cents_to_lamports_ceil(200, 20_000_000).unwrap();
        assert_eq!(exact, 100_000_000);

        // 1 SOL = 19.999999 USD, require upward rounding.
        let rounded = usd_cents_to_lamports_ceil(200, 19_999_999).unwrap();
        assert!(rounded > 100_000_000);
    }
}
