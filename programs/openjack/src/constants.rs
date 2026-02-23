pub const MAX_TICKETS_PER_TX: u16 = 100;
pub const MAX_TICKETS_PER_WALLET_PER_ROUND: u32 = 10_000;
pub const MAIN_N: u8 = 50;
pub const MAIN_K: usize = 5;
pub const BONUS_N: u8 = 10;

pub const TREASURY_BPS: u16 = 200;
#[cfg(feature = "canonical-freeze-prototype")]
pub const BOUNTY_BPS: u16 = 300;
#[cfg(not(feature = "canonical-freeze-prototype"))]
pub const BOUNTY_BPS: u16 = 0;
#[cfg(feature = "canonical-freeze-prototype")]
pub const LOWER_POOL_BPS: u16 = 1000;
#[cfg(not(feature = "canonical-freeze-prototype"))]
pub const LOWER_POOL_BPS: u16 = 1300;
pub const JACKPOT_BPS: u16 = 8500;

pub const LOWER_T5_ONLY_BPS: u16 = 4500;
pub const LOWER_T4_BONUS_BPS: u16 = 2500;
pub const LOWER_T4_ONLY_BPS: u16 = 1500;
pub const LOWER_T3_BONUS_BPS: u16 = 1000;
pub const LOWER_T2_BONUS_BPS: u16 = 500;

pub const BPS_DENOMINATOR: u64 = 10_000;
#[cfg(feature = "qa-fast-timers")]
pub const SETTLEMENT_WINDOW_SECS: i64 = 120;
#[cfg(all(not(feature = "qa-fast-timers"), feature = "dev-fast-timers"))]
pub const SETTLEMENT_WINDOW_SECS: i64 = 180;
#[cfg(all(not(feature = "qa-fast-timers"), not(feature = "dev-fast-timers")))]
pub const SETTLEMENT_WINDOW_SECS: i64 = 3600;
pub const WINNERS_CLAIM_WINDOW_SECS: i64 = 30 * 24 * 60 * 60;
#[cfg(feature = "canonical-freeze-prototype")]
pub const PROTOTYPE_COUNT_BATCH_MAX_LEN: u32 = 6;
