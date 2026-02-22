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
    #[msg("Compression proof is invalid")]
    CompressionProofInvalid,
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
    #[msg("Invalid ticket price")]
    InvalidTicketPrice,
    #[msg("Invalid cNFT mint accounts")]
    CnftMintAccountsInvalid,
    #[msg("Winner roots are incomplete for this round")]
    WinnerRootsIncomplete,
    #[msg("Freeze state is invalid for this instruction")]
    FreezeStateInvalid,
    #[msg("Freeze commitment mismatch on idempotent call")]
    FreezeCommitmentMismatch,
    #[msg("Freeze source data is invalid")]
    FreezeSourceInvalid,
    #[msg("Count batch length must be greater than zero")]
    CountBatchEmpty,
    #[msg("Count batch start is ahead of current progress")]
    CountProgressGap,
    #[msg("Count batch replay does not match the last accepted batch")]
    CountReplayMismatch,
    #[msg("Count batch exceeds frozen ticket bounds")]
    CountBatchOutOfBounds,
    #[msg("Count batch length exceeds prototype max batch size")]
    CountBatchTooLarge,
    #[msg("Count batch leaf membership proof is invalid")]
    CountBatchMembershipInvalid,
    #[msg("Count batch work digest mismatch")]
    CountBatchWorkMismatch,
    #[msg("Fast-path verifier rejected proof")]
    FastPathVerifierRejected,
    #[msg("Fast-path round id binding mismatch")]
    FastPathRoundIdMismatch,
    #[msg("Fast-path ticket_set_root binding mismatch")]
    FastPathTicketSetRootMismatch,
    #[msg("Fast-path ticket_count_frozen binding mismatch")]
    FastPathTicketCountMismatch,
    #[msg("Fast-path winning main numbers binding mismatch")]
    FastPathWinningMainMismatch,
    #[msg("Fast-path winning bonus binding mismatch")]
    FastPathWinningBonusMismatch,
    #[msg("Fast-path tier winner counts binding mismatch")]
    FastPathTierWinnerCountsMismatch,
    #[msg("Fast-path mock public inputs digest mismatch")]
    FastPathMockPublicInputsMismatch,
    #[msg("Fast-path mock proof digest mismatch")]
    FastPathMockProofMismatch,
    #[msg("Fast-path verifier instruction missing from transaction")]
    FastPathVerifierInstructionMissing,
    #[msg("Fast-path verifier instruction is invalid")]
    FastPathVerifierInstructionInvalid,
    #[msg("Fast-path verifier pubkey mismatch")]
    FastPathVerifierPubkeyMismatch,
    #[msg("Fast-path verifier message mismatch")]
    FastPathVerifierMessageMismatch,
}
