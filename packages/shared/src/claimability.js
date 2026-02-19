export const CLAIMABILITY_CONTRACT_VERSION = "2026-02-19.v1";

export const CLAIMABILITY_REASON = Object.freeze({
  ROUND_NOT_FINALIZED: "ROUND_NOT_FINALIZED",
  NOT_WINNER: "NOT_WINNER",
  PENDING_PROOF: "PENDING_PROOF",
  PROOF_FAILED: "PROOF_FAILED",
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  OWNER_MISMATCH: "OWNER_MISMATCH",
  PAYOUT_NOT_READY_OR_ZERO: "PAYOUT_NOT_READY_OR_ZERO",
  INGESTION_NOT_READY: "INGESTION_NOT_READY",
});

const CLAIMABILITY_REASON_VALUES = new Set(Object.values(CLAIMABILITY_REASON));

export function normalizeReasons(reasons) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(reasons) ? reasons : [])
        .map((reason) => String(reason || "").trim())
        .filter(Boolean),
    ),
  ).sort();
  for (const reason of normalized) {
    if (!CLAIMABILITY_REASON_VALUES.has(reason)) {
      throw new Error(`unknown_claimability_reason: ${reason}`);
    }
  }
  return normalized;
}

export function countReasonsFromTickets(tickets) {
  const counts = {};
  for (const ticket of Array.isArray(tickets) ? tickets : []) {
    for (const reason of normalizeReasons(ticket?.readinessReasons || [])) {
      counts[reason] = (counts[reason] || 0) + 1;
    }
  }
  return counts;
}

export function buildClaimabilityResponse({
  wallet,
  roundId,
  roundStatus,
  tickets,
  estimatedLamports,
  potentialLamports,
  readinessReasons,
}) {
  const winnerTickets = Array.isArray(tickets) ? tickets : [];
  const normalizedWinnerTickets = winnerTickets.map((ticket) => {
    const normalizedReasons = normalizeReasons(ticket?.readinessReasons || []);
    const claimable = normalizedReasons.length === 0;
    return {
      ...ticket,
      claimable,
      readinessReasons: normalizedReasons,
    };
  });

  const claimableTickets = normalizedWinnerTickets.filter((ticket) => ticket.claimable).length;
  const nonClaimableWinnerTickets = normalizedWinnerTickets.length - claimableTickets;
  const topLevelReasons = normalizeReasons(readinessReasons || []);
  const nonClaimableReasonCounts = countReasonsFromTickets(
    normalizedWinnerTickets.filter((ticket) => !ticket.claimable),
  );

  const response = {
    contractVersion: CLAIMABILITY_CONTRACT_VERSION,
    wallet: String(wallet || ""),
    roundId: Number(roundId || 0),
    roundStatus: Number(roundStatus ?? 0),
    winnerTickets: normalizedWinnerTickets.length,
    claimableTickets,
    nonClaimableWinnerTickets,
    estimatedLamports: Number(estimatedLamports || 0),
    potentialLamports: Number(potentialLamports || 0),
    readinessReasons: topLevelReasons,
    nonClaimableReasonCounts,
    tickets: normalizedWinnerTickets,
  };

  assertClaimabilityResponse(response);
  return response;
}

export function assertClaimabilityResponse(response) {
  if (!response || typeof response !== "object") {
    throw new Error("claimability_response_required");
  }
  if (response.contractVersion !== CLAIMABILITY_CONTRACT_VERSION) {
    throw new Error(`unsupported_claimability_contract_version: ${String(response.contractVersion || "")}`);
  }
  if (!Array.isArray(response.tickets)) {
    throw new Error("claimability_tickets_must_be_array");
  }

  const winnerTickets = Number(response.winnerTickets || 0);
  const claimableTickets = Number(response.claimableTickets || 0);
  const nonClaimableWinnerTickets = Number(response.nonClaimableWinnerTickets || 0);

  if (winnerTickets !== response.tickets.length) {
    throw new Error(`winner_ticket_count_mismatch expected=${winnerTickets} actual=${response.tickets.length}`);
  }

  const computedClaimable = response.tickets.filter((ticket) => Array.isArray(ticket.readinessReasons) && ticket.readinessReasons.length === 0)
    .length;
  if (claimableTickets !== computedClaimable) {
    throw new Error(`claimable_ticket_count_mismatch expected=${claimableTickets} actual=${computedClaimable}`);
  }

  if (nonClaimableWinnerTickets !== winnerTickets - claimableTickets) {
    throw new Error(
      `non_claimable_ticket_count_mismatch expected=${nonClaimableWinnerTickets} actual=${winnerTickets - claimableTickets}`,
    );
  }

  for (const ticket of response.tickets) {
    const reasons = normalizeReasons(ticket?.readinessReasons || []);
    const claimable = Boolean(ticket?.claimable);
    if (claimable !== (reasons.length === 0)) {
      throw new Error("ticket_claimable_reason_mismatch");
    }
  }

  normalizeReasons(response.readinessReasons || []);

  const reasonCounts = response.nonClaimableReasonCounts || {};
  for (const [reason, count] of Object.entries(reasonCounts)) {
    if (!CLAIMABILITY_REASON_VALUES.has(reason)) {
      throw new Error(`unknown_non_claimable_reason_count_key: ${reason}`);
    }
    if (!Number.isFinite(Number(count)) || Number(count) < 0) {
      throw new Error(`invalid_non_claimable_reason_count: ${reason}`);
    }
  }

  return response;
}
