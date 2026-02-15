use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RoundStatus {
    Open = 0,
    Closed = 1,
    Drawing = 2,
    Settling = 3,
    Finalized = 4,
}

impl RoundStatus {
    pub fn can_transition_to(self, next: RoundStatus) -> bool {
        matches!(
            (self, next),
            (RoundStatus::Open, RoundStatus::Closed)
                | (RoundStatus::Closed, RoundStatus::Drawing)
                | (RoundStatus::Drawing, RoundStatus::Settling)
                | (RoundStatus::Settling, RoundStatus::Finalized)
        )
    }
}

#[account]
pub struct LotteryConfig {
    pub authority: Pubkey,
    pub treasury_pubkey: Pubkey,
    pub official_scanner_pubkey: Pubkey,
    pub vrf_callback_authority: Pubkey,
    pub scanner_bond_lamports: u64,
    pub scanner_slash_lamports: u64,
    pub sol_usd_oracle: Pubkey,
    pub oracle_max_age_secs: u32,
    pub ticket_price_usd_cents: u32,
    pub finder_fee_bps: u16,
    pub cadence_min_gap_secs: u32,
    pub cadence_max_gap_secs: u32,
    pub bump: u8,
}

#[account]
pub struct Round {
    pub round_id: u64,
    pub status: u8,
    pub open_ts: i64,
    pub close_ts: i64,
    pub draw_ts: i64,
    pub settle_deadline_ts: i64,
    pub tree_address: Pubkey,
    pub ticket_count: u32,
    pub sales_lamports: u64,
    pub treasury_paid_lamports: u64,
    pub jackpot_pool_balance: u64,
    pub tier_pool_balances: [u64; 5],
    pub winners_pool_balance: u64,
    pub unclaimed_pool_balance: u64,
    pub winning_main: [u8; 5],
    pub winning_bonus: u8,
    pub vrf_request: Pubkey,
    pub tier_winner_counts: [u32; 6],
    pub tier_payout_per_winner: [u64; 6],
    pub tier_remainders: [u64; 6],
    pub roots: [[u8; 32]; 6],
    pub roots_committed_mask: u8,
    pub scanner_commitment_hash: [u8; 32],
    pub scanner_observed_ticket_count: u32,
    pub finalized_ts: i64,
    pub bump: u8,
}

#[account]
pub struct UserRoundStats {
    pub tickets_bought: u32,
    pub bump: u8,
}

#[account]
pub struct ClaimRecord {
    pub claimer: Pubkey,
    pub tier: u8,
    pub amount: u64,
    pub claimed_ts: i64,
    pub source_pool: u8,
    pub bump: u8,
}

#[account]
pub struct WinnerRecord {
    pub registered_by: Pubkey,
    pub registered_ts: i64,
    pub bump: u8,
}

#[account]
pub struct ScannerBond {
    pub posted: bool,
    pub amount: u64,
    pub slashed: u64,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::RoundStatus;

    #[test]
    fn round_status_transition_rules() {
        assert!(RoundStatus::Open.can_transition_to(RoundStatus::Closed));
        assert!(RoundStatus::Closed.can_transition_to(RoundStatus::Drawing));
        assert!(RoundStatus::Drawing.can_transition_to(RoundStatus::Settling));
        assert!(RoundStatus::Settling.can_transition_to(RoundStatus::Finalized));

        assert!(!RoundStatus::Open.can_transition_to(RoundStatus::Drawing));
        assert!(!RoundStatus::Finalized.can_transition_to(RoundStatus::Open));
        assert!(!RoundStatus::Closed.can_transition_to(RoundStatus::Finalized));
    }
}
