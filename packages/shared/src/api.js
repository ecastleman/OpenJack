export function assertRoundUpdate(payload) {
  const required = ["roundId", "status"];
  for (const key of required) {
    if (!(key in payload)) {
      throw new Error(`missing ${key}`);
    }
  }
  return payload;
}

export function assertRootsUpdate(payload) {
  const required = ["roundId", "roots", "observedTicketCount", "commitmentHash"];
  for (const key of required) {
    if (!(key in payload)) {
      throw new Error(`missing ${key}`);
    }
  }
  if (!Array.isArray(payload.roots)) {
    throw new Error("roots must be an array");
  }
  return payload;
}

function assertClaimTicket(ticket, index) {
  const required = ["leafIndex", "tier"];
  for (const key of required) {
    if (!(key in ticket)) {
      throw new Error(`tickets[${index}] missing ${key}`);
    }
  }
  const ticketProof = Array.isArray(ticket.ticketProof) ? ticket.ticketProof : [];
  const ownershipProof = ticket.ownershipProof || null;
  const ownershipOwner = ownershipProof?.owner ? String(ownershipProof.owner) : "";
  if (ticketProof.length > 0 && !ownershipOwner) {
    throw new Error(`tickets[${index}] ownershipProof.owner required when ticketProof is present`);
  }
  const compressionRoot = ticket.compressionRoot || null;
  const compressionLeaf = ticket.compressionLeaf || null;
  const compressionIndex =
    ticket.compressionIndex === undefined || ticket.compressionIndex === null
      ? null
      : Number(ticket.compressionIndex);
  if (ticketProof.length > 0) {
    if (!compressionRoot || !compressionLeaf || compressionIndex === null || Number.isNaN(compressionIndex)) {
      throw new Error(`tickets[${index}] compression proof fields are required when ticketProof is present`);
    }
  }
  return {
    leafIndex: Number(ticket.leafIndex),
    tier: Number(ticket.tier),
    amount: Number(ticket.amount || 0),
    assetId: ticket.assetId || null,
    winnerRootHash: ticket.winnerRootHash || null,
    winnerRootProof: Array.isArray(ticket.winnerRootProof) ? ticket.winnerRootProof : [],
    compressionRoot,
    compressionLeaf,
    compressionIndex,
    ticketProof,
    ownershipProof,
  };
}

export function assertClaimEstimateUpdate(payload) {
  const required = ["roundId", "wallet", "estimatedLamports", "tickets"];
  for (const key of required) {
    if (!(key in payload)) {
      throw new Error(`missing ${key}`);
    }
  }
  if (!Array.isArray(payload.tickets)) {
    throw new Error("tickets must be an array");
  }

  return {
    roundId: Number(payload.roundId),
    wallet: String(payload.wallet),
    estimatedLamports: Number(payload.estimatedLamports),
    tickets: payload.tickets.map(assertClaimTicket),
  };
}

export function createTxPrepareRequest({ wallet, action, roundId, payload }) {
  return {
    wallet,
    action,
    roundId,
    payload: payload || {},
  };
}
