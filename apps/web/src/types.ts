export type Round = {
  roundId: number;
  status: string;
  openTs?: number;
  closeTs?: number;
  drawTs?: number;
  settleDeadlineTs: number;
  jackpotPoolBalance: number;
  winnersPoolBalance?: number;
  unclaimedPoolBalance?: number;
  winningMain?: number[];
  winningBonus?: number;
};

export type RootRow = {
  tier: number;
  label: string;
  winnerCount: number;
  published: boolean;
};

export type ClaimEstimate = {
  contractVersion: string;
  wallet: string;
  roundId: number;
  roundStatus?: number;
  winnerTickets: number;
  claimableTickets: number;
  nonClaimableWinnerTickets: number;
  estimatedLamports: number;
  potentialLamports: number;
  readinessReasons: string[];
  nonClaimableReasonCounts: Record<string, number>;
  tickets: ClaimTicket[];
};

export type ClaimTicket = {
  leafIndex: number;
  tier: number;
  amount: number;
  claimable?: boolean;
  proofStatus?: string | null;
  readinessReasons?: string[];
  assetId?: string | null;
  winnerRootHash?: string | null;
  winnerRootProof?: string[];
  compressionRoot?: string | null;
  compressionLeaf?: string | null;
  compressionIndex?: number | null;
  ticketProof?: string[];
  ownershipProof?: {
    owner?: string | null;
    delegate?: string | null;
    ownershipModel?: string | null;
  } | null;
};

export type PreparedTx = {
  action: "BUY_TICKETS" | "CLAIM";
  roundId: number;
  wallet: string;
  unsignedTxBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  claim?: ClaimTicket;
};

export type ScannerStatus = {
  roundId: number;
  publishes: Array<{
    tier: number;
    status: string;
    txSignature: string | null;
    attemptCount: number;
    lastError: string | null;
    publishedAt: string | null;
    updatedAt: string | null;
  }>;
  deadLetters: Array<{
    status: string;
    count: number;
  }>;
  warnings: string[];
};

export type RoundIngestionStatus = {
  roundId: number;
  ingestionState: {
    roundId: number;
    closeSlot: number;
    finalizedWatermarkSlot: number;
    ledgerTicketCount: number;
    onchainTicketCount: number;
    maxLedgerSlot: number;
    sealed: boolean;
    sealedAt: string | null;
    readinessReason: string | null;
    updatedAt: string | null;
  } | null;
  snapshot: {
    roundId: number;
    schemaVersion: number;
    rowCount: number;
    snapshotMaxSlot: number;
    finalizedWatermarkSlot: number;
    closeSlot: number;
    snapshotHashHex: string | null;
    createdAt: string | null;
    createdBy: string | null;
  } | null;
  warnings: string[];
};
