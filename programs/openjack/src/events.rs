use anchor_lang::prelude::*;

#[event]
pub struct TicketPurchased {
    pub round_id: u64,
    pub leaf_index: u32,
    pub main: [u8; 5],
    pub bonus: u8,
    pub asset_id: Pubkey,
    pub purchaser: Pubkey,
    pub paid_lamports: u64,
    pub ts: i64,
}

#[event]
pub struct RoundStatusChanged {
    pub round_id: u64,
    pub from_status: u8,
    pub to_status: u8,
    pub ts: i64,
}

#[event]
pub struct DrawFulfilled {
    pub round_id: u64,
    pub winning_main: [u8; 5],
    pub winning_bonus: u8,
    pub vrf_request: Pubkey,
    pub ts: i64,
}

#[event]
pub struct WinnerRootPublished {
    pub round_id: u64,
    pub tier: u8,
    pub root_hash: [u8; 32],
    pub winner_count: u32,
    pub observed_ticket_count: u32,
    pub ts: i64,
}

#[event]
pub struct WinnerChallenged {
    pub round_id: u64,
    pub tier: u8,
    pub leaf_index: u32,
    pub challenger: Pubkey,
    pub slash_lamports: u64,
    pub ts: i64,
}

#[event]
pub struct Claimed {
    pub round_id: u64,
    pub leaf_index: u32,
    pub claimer: Pubkey,
    pub tier: u8,
    pub amount: u64,
    pub source_pool: u8,
    pub ts: i64,
}

#[event]
pub struct SweptToUnclaimed {
    pub round_id: u64,
    pub amount: u64,
    pub ts: i64,
}

#[cfg(feature = "canonical-freeze-prototype")]
#[event]
pub struct CountBatchObserved {
    pub round_id: u64,
    pub processed: u32,
    pub total: u32,
    pub remaining: u32,
    pub last_result_code: u16,
    pub last_result_count: u32,
    pub accepted_batches: u32,
    pub noop_replay_batches: u32,
    pub ts: i64,
}
