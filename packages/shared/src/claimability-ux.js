import { CLAIMABILITY_REASON, normalizeReasons } from "./claimability.js";

export const UX_CLAIM_STATUS = Object.freeze({
  NO_WINS: "NO_WINS",
  WINS_NOT_CLAIMABLE: "WINS_NOT_CLAIMABLE",
  CLAIMABLE_NOW: "CLAIMABLE_NOW",
  UNKNOWN_REASON: "UNKNOWN_REASON",
});

export const UX_TICKET_STATUS = Object.freeze({
  CLAIMABLE: "CLAIMABLE",
  PENDING_PROOF: "PENDING_PROOF",
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  OWNER_MISMATCH: "OWNER_MISMATCH",
  ROUND_NOT_FINALIZED: "ROUND_NOT_FINALIZED",
  INGESTION_NOT_READY: "INGESTION_NOT_READY",
  PAYOUT_NOT_READY_OR_ZERO: "PAYOUT_NOT_READY_OR_ZERO",
  PROOF_FAILED: "PROOF_FAILED",
  UNKNOWN_REASON: "UNKNOWN_REASON",
});

export const REASON_PRIORITY = Object.freeze([
  CLAIMABILITY_REASON.ALREADY_CLAIMED,
  CLAIMABILITY_REASON.OWNER_MISMATCH,
  CLAIMABILITY_REASON.PROOF_FAILED,
  CLAIMABILITY_REASON.PENDING_PROOF,
  CLAIMABILITY_REASON.ROUND_NOT_FINALIZED,
  CLAIMABILITY_REASON.INGESTION_NOT_READY,
  CLAIMABILITY_REASON.PAYOUT_NOT_READY_OR_ZERO,
  CLAIMABILITY_REASON.NOT_WINNER,
]);

export const REASON_TO_TICKET_STATUS = Object.freeze({
  [CLAIMABILITY_REASON.PENDING_PROOF]: UX_TICKET_STATUS.PENDING_PROOF,
  [CLAIMABILITY_REASON.PROOF_FAILED]: UX_TICKET_STATUS.PROOF_FAILED,
  [CLAIMABILITY_REASON.ALREADY_CLAIMED]: UX_TICKET_STATUS.ALREADY_CLAIMED,
  [CLAIMABILITY_REASON.OWNER_MISMATCH]: UX_TICKET_STATUS.OWNER_MISMATCH,
  [CLAIMABILITY_REASON.ROUND_NOT_FINALIZED]: UX_TICKET_STATUS.ROUND_NOT_FINALIZED,
  [CLAIMABILITY_REASON.INGESTION_NOT_READY]: UX_TICKET_STATUS.INGESTION_NOT_READY,
  [CLAIMABILITY_REASON.PAYOUT_NOT_READY_OR_ZERO]: UX_TICKET_STATUS.PAYOUT_NOT_READY_OR_ZERO,
  [CLAIMABILITY_REASON.NOT_WINNER]: UX_TICKET_STATUS.UNKNOWN_REASON,
});

export const REASON_LABELS = Object.freeze({
  [CLAIMABILITY_REASON.ROUND_NOT_FINALIZED]: "Round not finalized",
  [CLAIMABILITY_REASON.NOT_WINNER]: "Not a winner",
  [CLAIMABILITY_REASON.PENDING_PROOF]: "Proof pending",
  [CLAIMABILITY_REASON.PROOF_FAILED]: "Proof failed",
  [CLAIMABILITY_REASON.ALREADY_CLAIMED]: "Already claimed",
  [CLAIMABILITY_REASON.OWNER_MISMATCH]: "Owner mismatch",
  [CLAIMABILITY_REASON.PAYOUT_NOT_READY_OR_ZERO]: "Payout not ready",
  [CLAIMABILITY_REASON.INGESTION_NOT_READY]: "Ingestion not ready",
});

function normalizeRawReasons(reasons) {
  return Array.from(
    new Set(
      (Array.isArray(reasons) ? reasons : [])
        .map((reason) => String(reason || "").trim())
        .filter(Boolean),
    ),
  ).sort();
}

export function assertReasonCoverage() {
  const known = Object.values(CLAIMABILITY_REASON).sort();
  const mapperKeys = Object.keys(REASON_LABELS).sort();
  if (known.length !== mapperKeys.length) {
    throw new Error(`reason_coverage_count_mismatch known=${known.length} mapped=${mapperKeys.length}`);
  }
  for (const reason of known) {
    if (!REASON_LABELS[reason]) {
      throw new Error(`reason_coverage_missing_label:${reason}`);
    }
    if (!(reason in REASON_TO_TICKET_STATUS)) {
      throw new Error(`reason_coverage_missing_status_map:${reason}`);
    }
  }
  return known;
}

export function getUnsupportedReasons(reasons) {
  const normalized = normalizeRawReasons(reasons || []);
  const known = new Set(Object.values(CLAIMABILITY_REASON));
  return normalized.filter((reason) => !known.has(reason));
}

function pickPrimaryReason(reasons) {
  for (const reason of REASON_PRIORITY) {
    if (reasons.includes(reason)) return reason;
  }
  return reasons[0] || null;
}

export function mapTicketClaimabilityToUx(ticket) {
  const rawReasons = normalizeRawReasons(ticket?.readinessReasons || []);
  const unsupported = getUnsupportedReasons(rawReasons);
  const reasons = unsupported.length > 0 ? rawReasons : normalizeReasons(rawReasons);
  if (reasons.length === 0) {
    return {
      status: UX_TICKET_STATUS.CLAIMABLE,
      label: "Claimable",
      reasons: [],
      unknownReasons: [],
    };
  }

  if (unsupported.length > 0) {
    return {
      status: UX_TICKET_STATUS.UNKNOWN_REASON,
      label: "Unknown readiness reason",
      reasons,
      unknownReasons: unsupported,
    };
  }

  const primary = pickPrimaryReason(reasons);
  const status = primary ? REASON_TO_TICKET_STATUS[primary] : UX_TICKET_STATUS.UNKNOWN_REASON;
  return {
    status: status || UX_TICKET_STATUS.UNKNOWN_REASON,
    label: primary ? REASON_LABELS[primary] : "Unknown readiness reason",
    reasons,
    unknownReasons: [],
  };
}

export function deriveClaimSummaryUx(claimability) {
  const winnerTickets = Number(claimability?.winnerTickets || 0);
  const claimableTickets = Number(claimability?.claimableTickets || 0);
  const topReasonsRaw = normalizeRawReasons(claimability?.readinessReasons || []);
  const topReasonsUnsupported = getUnsupportedReasons(topReasonsRaw);
  const topReasons = topReasonsUnsupported.length > 0 ? topReasonsRaw : normalizeReasons(topReasonsRaw);
  const unsupportedTopReasons = topReasonsUnsupported;

  if (unsupportedTopReasons.length > 0) {
    return {
      state: UX_CLAIM_STATUS.UNKNOWN_REASON,
      label: "Unknown claimability reason",
      reasons: topReasons,
      unknownReasons: unsupportedTopReasons,
    };
  }

  if (winnerTickets === 0) {
    return {
      state: UX_CLAIM_STATUS.NO_WINS,
      label: "No winning tickets",
      reasons: topReasons,
      unknownReasons: [],
    };
  }

  if (claimableTickets > 0) {
    return {
      state: UX_CLAIM_STATUS.CLAIMABLE_NOW,
      label: "Claimable now",
      reasons: topReasons,
      unknownReasons: [],
    };
  }

  return {
    state: UX_CLAIM_STATUS.WINS_NOT_CLAIMABLE,
    label: "Wins found, not claimable yet",
    reasons: topReasons,
    unknownReasons: [],
  };
}
