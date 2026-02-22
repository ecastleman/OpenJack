import type { ClaimEstimate, ClaimTicket } from "./types";

export const UX_CLAIM_STATUS = {
  NO_WINS: "NO_WINS",
  WINS_NOT_CLAIMABLE: "WINS_NOT_CLAIMABLE",
  CLAIMABLE_NOW: "CLAIMABLE_NOW",
  UNKNOWN_REASON: "UNKNOWN_REASON",
} as const;

const KNOWN_REASONS = new Set([
  "ROUND_NOT_FINALIZED",
  "NOT_WINNER",
  "PENDING_PROOF",
  "PROOF_FAILED",
  "ALREADY_CLAIMED",
  "OWNER_MISMATCH",
  "PAYOUT_NOT_READY_OR_ZERO",
  "INGESTION_NOT_READY",
]);

const PRIORITY = [
  "ALREADY_CLAIMED",
  "OWNER_MISMATCH",
  "PROOF_FAILED",
  "PENDING_PROOF",
  "ROUND_NOT_FINALIZED",
  "INGESTION_NOT_READY",
  "PAYOUT_NOT_READY_OR_ZERO",
  "NOT_WINNER",
] as const;

const REASON_LABELS: Record<string, string> = {
  ROUND_NOT_FINALIZED: "Round not finalized",
  NOT_WINNER: "Not a winner",
  PENDING_PROOF: "Winner proof pending",
  PROOF_FAILED: "Winner proof failed",
  ALREADY_CLAIMED: "Already claimed",
  OWNER_MISMATCH: "Ticket owner mismatch",
  PAYOUT_NOT_READY_OR_ZERO: "Payout unavailable",
  INGESTION_NOT_READY: "Ingestion not ready",
};

function normalizeReasons(reasons: string[] | undefined): string[] {
  return Array.from(new Set((Array.isArray(reasons) ? reasons : []).map((r) => String(r || "").trim()).filter(Boolean))).sort();
}

function unsupportedReasons(reasons: string[]): string[] {
  return reasons.filter((reason) => !KNOWN_REASONS.has(reason));
}

export function assertReasonCoverage(): string[] {
  const known = Array.from(KNOWN_REASONS).sort();
  for (const reason of known) {
    if (!REASON_LABELS[reason]) {
      throw new Error(`reason_coverage_missing_label:${reason}`);
    }
  }
  return known;
}

export function mapTicketClaimabilityToUx(ticket: ClaimTicket) {
  const reasons = normalizeReasons(ticket.readinessReasons);
  const unknownReasons = unsupportedReasons(reasons);
  if (reasons.length === 0) {
    return { status: "CLAIMABLE", label: "Claimable", reasons, unknownReasons };
  }
  if (unknownReasons.length > 0) {
    return { status: "UNKNOWN_REASON", label: "Unknown readiness reason", reasons, unknownReasons };
  }

  const primary = PRIORITY.find((reason) => reasons.includes(reason)) || reasons[0];
  const status = primary;
  const label = REASON_LABELS[primary] || "Unknown readiness reason";
  return { status, label, reasons, unknownReasons };
}

export function deriveClaimSummaryUx(claimability: ClaimEstimate) {
  const winnerTickets = Number(claimability?.winnerTickets || 0);
  const claimableTickets = Number(claimability?.claimableTickets || 0);
  const reasons = normalizeReasons(claimability?.readinessReasons);
  const unknownReasons = unsupportedReasons(reasons);

  if (unknownReasons.length > 0) {
    return {
      state: UX_CLAIM_STATUS.UNKNOWN_REASON,
      label: "Unknown claimability reason",
      reasons,
      unknownReasons,
    };
  }

  if (winnerTickets === 0) {
    return {
      state: UX_CLAIM_STATUS.NO_WINS,
      label: "No winning tickets",
      reasons,
      unknownReasons,
    };
  }

  if (claimableTickets > 0) {
    return {
      state: UX_CLAIM_STATUS.CLAIMABLE_NOW,
      label: "Claimable now",
      reasons,
      unknownReasons,
    };
  }

  return {
    state: UX_CLAIM_STATUS.WINS_NOT_CLAIMABLE,
    label: "Wins found, not claimable yet",
    reasons,
    unknownReasons,
  };
}
