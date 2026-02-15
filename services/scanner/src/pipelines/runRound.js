import { runScannerRound } from "../core.js";
import { RootPublisher } from "../adapters/publisher.js";

export async function runAndPublishRound({
  roundId,
  wsEvents,
  backfillEvents,
  winning,
  publishMode = "dry-run",
  assetResolver = null,
  proofProvider = null,
}) {
  const scan = runScannerRound({ wsEvents, backfillEvents, winning });
  if (!scan.ok) {
    return scan;
  }

  let claimCandidates = scan.claimCandidates;
  if (assetResolver && Array.isArray(claimCandidates)) {
    claimCandidates = await Promise.all(
      claimCandidates.map(async (t) => {
        if (t.assetId) return t;
        const assetId = await assetResolver.resolve({
          roundId,
          leafIndex: t.leafIndex,
          wallet: t.wallet,
        });
        return { ...t, assetId: assetId || null };
      }),
    );
  }

  if (proofProvider && Array.isArray(claimCandidates)) {
    claimCandidates = await Promise.all(claimCandidates.map((t) => proofProvider.enrich(t)));
  }

  const publisher = new RootPublisher({ mode: publishMode });
  const publish = await publisher.publishRoundRoots({
    roundId,
    roots: scan.roots,
    observedTicketCount: scan.observedTicketCount,
    commitmentHash: scan.commitmentHash,
  });

  return {
    ...scan,
    claimCandidates,
    publish,
  };
}
