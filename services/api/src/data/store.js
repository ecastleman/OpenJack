import {
  assertClaimEstimateUpdate,
  assertRootsUpdate,
  assertRoundUpdate,
  TIER_LABELS,
} from "../../../../packages/shared/src/index.js";
import { PostgresStore } from "../repo/postgresStore.js";

const store = new PostgresStore();

export async function getActiveRound() {
  return store.getActiveRound();
}

export async function getRound(roundId) {
  return store.getRound(roundId);
}

export async function upsertRound(round) {
  const parsed = assertRoundUpdate(round);
  return store.upsertRound(parsed);
}

export async function getRoundRoots(roundId) {
  return store.getRoundRoots(roundId);
}

export async function setRoundRoots(roundId, rootsPayload) {
  const parsed = assertRootsUpdate(rootsPayload);
  const labeledRoots = parsed.roots.map((r) => ({
    ...r,
    label: TIER_LABELS[r.tier] || `TIER_${r.tier}`,
    observedTicketCount: parsed.observedTicketCount,
    commitmentHash: parsed.commitmentHash,
    published: true,
  }));
  return store.setRoundRoots(roundId, labeledRoots);
}

export async function getClaimEstimate(roundId, wallet) {
  return store.getClaimEstimate(roundId, wallet);
}

export async function setClaimEstimate(roundId, wallet, estimate) {
  const parsed = assertClaimEstimateUpdate({
    roundId,
    wallet,
    estimatedLamports: estimate.estimatedLamports || 0,
    tickets: estimate.tickets || [],
  });
  return store.setClaimEstimate(parsed.roundId, parsed.wallet, {
    estimatedLamports: parsed.estimatedLamports,
    tickets: parsed.tickets,
  });
}

export async function getScannerStatus(roundId) {
  return store.getScannerStatus(roundId);
}

export async function getRoundIngestionStatus(roundId) {
  return store.getRoundIngestionStatus(roundId);
}
