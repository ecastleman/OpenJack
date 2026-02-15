import crypto from "node:crypto";
import { assertTicketPurchasedEvent, classifyTier } from "../../../packages/shared/src/index.js";
import { buildMerkleRootAndProofs } from "./merkle.js";

function stableHash(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function rollingTicketCommitment(events) {
  let acc = "";
  for (const e of events) {
    acc = stableHash(`${acc}|${e.roundId}|${e.leafIndex}|${e.main.join(",")}|${e.bonus}|${e.purchaser}`);
  }
  return acc;
}

function normalizeCanonicalEvents(events) {
  return (events || []).map(assertTicketPurchasedEvent);
}

function buildTierRoots(events, winning) {
  const buckets = [[], [], [], [], [], []];
  const winners = [];
  for (const event of events) {
    const tier = classifyTier({ main: event.main, bonus: event.bonus }, winning);
    if (tier >= 0) {
      buckets[tier].push(event.leafIndex);
      winners.push({
        wallet: event.purchaser,
        leafIndex: event.leafIndex,
        tier,
        amount: 0,
        assetId: event.assetId || null,
      });
    }
  }

  const roots = buckets.map((leafIndexes, tier) => {
    const { rootHash, proofsByLeaf } = buildMerkleRootAndProofs(leafIndexes);
    return {
      tier,
      rootHash,
      winnerCount: leafIndexes.length,
      leafIndexes,
      proofsByLeaf,
    };
  });

  const rootByTier = new Map(roots.map((r) => [r.tier, r]));
  const claimCandidates = winners.map((w) => ({
    ...w,
    winnerRootHash: rootByTier.get(w.tier)?.rootHash || null,
    winnerRootProof: rootByTier.get(w.tier)?.proofsByLeaf.get(w.leafIndex) || [],
    ticketProof: [],
    ownershipProof: {
      owner: w.wallet,
      delegate: null,
    },
  }));

  return {
    roots: roots.map(({ proofsByLeaf, ...rest }) => rest),
    claimCandidates,
  };
}

export function buildRoundArtifactsFromCanonicalEvents(events, winning) {
  const normalized = normalizeCanonicalEvents(events);
  const { roots, claimCandidates } = buildTierRoots(normalized, winning);
  return {
    ok: true,
    observedTicketCount: normalized.length,
    commitmentHash: rollingTicketCommitment(normalized),
    roots,
    claimCandidates,
  };
}
