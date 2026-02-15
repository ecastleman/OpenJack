import { normalizeTicket } from "./tier.js";

export function assertTicketPurchasedEvent(event) {
  const required = [
    "roundId",
    "leafIndex",
    "main",
    "bonus",
    "purchaser",
    "paidLamports",
    "ts",
  ];
  for (const field of required) {
    if (!(field in event)) {
      throw new Error(`missing ${field}`);
    }
  }

  const normalized = normalizeTicket(event.main, event.bonus);
  return {
    ...event,
    main: normalized.main,
    bonus: normalized.bonus,
  };
}

export function createWinnerRootPayload({
  roundId,
  tier,
  rootHash,
  winnerCount,
  observedTicketCount,
  commitmentHash,
}) {
  return {
    roundId,
    tier,
    rootHash,
    winnerCount,
    observedTicketCount,
    commitmentHash,
  };
}
