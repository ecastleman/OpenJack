export type Round = {
  roundId: number;
  status: string;
  settleDeadlineTs: number;
  jackpotPoolBalance: number;
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
  wallet: string;
  roundId: number;
  estimatedLamports: number;
  tickets: ClaimTicket[];
};

export type ClaimTicket = {
  leafIndex: number;
  tier: number;
  amount: number;
  assetId?: string | null;
  winnerRootHash?: string | null;
  winnerRootProof?: string[];
  ticketProof?: string[];
  ownershipProof?: unknown;
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
