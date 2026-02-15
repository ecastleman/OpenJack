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

function reconcileByLeafIndex(wsEvents, backfillEvents) {
  const mapA = new Map(wsEvents.map((e) => [e.leafIndex, e]));
  const mapB = new Map(backfillEvents.map((e) => [e.leafIndex, e]));

  const mismatches = [];
  const allKeys = [...new Set([...mapA.keys(), ...mapB.keys()])].sort((a, b) => a - b);
  for (const key of allKeys) {
    const a = mapA.get(key);
    const b = mapB.get(key);
    if (!a || !b) {
      mismatches.push({ leafIndex: key, reason: "missing_in_one_pipeline" });
      continue;
    }
    const ha = stableHash(JSON.stringify(a));
    const hb = stableHash(JSON.stringify(b));
    if (ha !== hb) {
      mismatches.push({ leafIndex: key, reason: "payload_mismatch" });
    }
  }

  return {
    mismatches,
    canonical: allKeys.map((k) => mapA.get(k) || mapB.get(k)),
  };
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
    ownershipProof: null,
  }));

  return {
    roots: roots.map(({ proofsByLeaf, ...rest }) => rest),
    claimCandidates,
  };
}

export function runScannerRound({ wsEvents, backfillEvents, winning }) {
  const normalizedWs = wsEvents.map(assertTicketPurchasedEvent);
  const normalizedBackfill = backfillEvents.map(assertTicketPurchasedEvent);

  const reconciliation = reconcileByLeafIndex(normalizedWs, normalizedBackfill);
  if (reconciliation.mismatches.length > 0) {
    return {
      ok: false,
      mismatches: reconciliation.mismatches,
      message: "reconciliation failed; roots not published",
    };
  }

  const { roots, claimCandidates } = buildTierRoots(reconciliation.canonical, winning);
  return {
    ok: true,
    observedTicketCount: reconciliation.canonical.length,
    commitmentHash: rollingTicketCommitment(reconciliation.canonical),
    roots,
    claimCandidates,
  };
}
