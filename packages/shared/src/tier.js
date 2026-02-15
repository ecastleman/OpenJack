import { OPENJACK_CONSTANTS } from "./constants.js";

export function normalizeTicket(main, bonus) {
  if (!Array.isArray(main) || main.length !== OPENJACK_CONSTANTS.MAIN_K) {
    throw new Error("main must be an array of 5 numbers");
  }

  const sorted = [...main].sort((a, b) => a - b);
  const unique = new Set(sorted);
  if (unique.size !== OPENJACK_CONSTANTS.MAIN_K) {
    throw new Error("main numbers must be unique");
  }

  for (const n of sorted) {
    if (n < 1 || n > OPENJACK_CONSTANTS.MAIN_N) {
      throw new Error("main number out of range");
    }
  }

  if (bonus < 1 || bonus > OPENJACK_CONSTANTS.BONUS_N) {
    throw new Error("bonus number out of range");
  }

  return { main: sorted, bonus };
}

export function classifyTier(ticket, winning) {
  const ticketMain = new Set(ticket.main);
  let mainMatches = 0;
  for (const n of winning.main) {
    if (ticketMain.has(n)) {
      mainMatches += 1;
    }
  }
  const bonusMatch = ticket.bonus === winning.bonus;

  if (mainMatches === 5 && bonusMatch) {
    return 0;
  }
  if (mainMatches === 5) {
    return 1;
  }
  if (mainMatches === 4 && bonusMatch) {
    return 2;
  }
  if (mainMatches === 4) {
    return 3;
  }
  if (mainMatches === 3 && bonusMatch) {
    return 4;
  }
  if (mainMatches === 2 && bonusMatch) {
    return 5;
  }

  return -1;
}
