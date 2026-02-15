use anchor_lang::prelude::*;

#[error_code]
pub enum OpenJackError {
    #[msg("Invalid round state for this instruction")]
    InvalidRoundState,
    #[msg("Round is closed for ticket purchases")]
    RoundClosed,
    #[msg("Round is not yet closable")]
    RoundNotClosable,
    #[msg("Too many tickets in a single transaction")]
    TooManyTicketsPerTx,
    #[msg("Wallet cap exceeded for this round")]
    WalletRoundCapExceeded,
    #[msg("Invalid main numbers")]
    InvalidMainNumbers,
    #[msg("Invalid bonus number")]
    InvalidBonusNumber,
    #[msg("Oracle data is stale")]
    OracleStale,
    #[msg("Oracle data is invalid")]
    OracleInvalid,
    #[msg("Provided oracle account does not match config")]
    OracleAccountMismatch,
    #[msg("Provided treasury account does not match config")]
    TreasuryAccountMismatch,
    #[msg("Unauthorized VRF callback")]
    VrfUnauthorized,
    #[msg("VRF callback replay detected")]
    VrfReplay,
    #[msg("Settlement window is still open")]
    SettlementWindowOpen,
    #[msg("Settlement window has closed")]
    SettlementWindowClosed,
    #[msg("Scanner bond has not been posted")]
    ScannerBondMissing,
    #[msg("Unauthorized scanner")]
    ScannerUnauthorized,
    #[msg("Tier index out of range")]
    TierOutOfRange,
    #[msg("Winner already registered")]
    WinnerAlreadyRegistered,
    #[msg("Winner record PDA does not match expected seeds")]
    WinnerRecordPdaMismatch,
    #[msg("Winner proof is invalid")]
    WinnerProofInvalid,
    #[msg("Ownership proof is invalid")]
    OwnershipProofInvalid,
    #[msg("Ticket already claimed")]
    AlreadyClaimed,
    #[msg("Signer is not ticket owner")]
    NotTicketOwner,
    #[msg("Sweep is not ready")]
    SweepNotReady,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid claim amount")]
    InvalidClaimAmount,
    #[msg("Insufficient pool balance")]
    InsufficientPoolBalance,
}
