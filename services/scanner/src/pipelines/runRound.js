import { buildRoundArtifactsFromCanonicalEvents } from "../core.js";
import { RootPublisher } from "../adapters/publisher.js";
import { TicketLedgerRepo } from "../repo/ticketLedger.js";
import { getScannerProgram } from "../solana/openjack.js";

export async function runAndPublishRound({
  roundId,
  winning,
  publishMode = "dry-run",
  assetResolver = null,
  proofProvider = null,
}) {
  const artifactSource = "sealed_snapshot";
  if (artifactSource !== "sealed_snapshot") {
    throw new Error(`invalid_artifact_source ${artifactSource}`);
  }

  const publisher = new RootPublisher({ mode: publishMode });
  const { program, connection } = getScannerProgram();
  const readinessStart = Date.now();
  const canPublish = await publisher.canPublishRoundNow({ program, roundId, connection });
  if (!canPublish.ok) {
    throw new Error(`publish_precondition_failed round=${roundId} reason=${canPublish.reason}`);
  }
  const tReadinessMs = Date.now() - readinessStart;

  const ledgerRepo = new TicketLedgerRepo();
  const computeStart = Date.now();
  const sealed = await ledgerRepo.getSealedCanonicalEvents(roundId);
  const scan = buildRoundArtifactsFromCanonicalEvents(sealed.events, winning);
  const tComputeArtifactsMs = Date.now() - computeStart;

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

  const publish = await publisher.publishRoundRoots({
    roundId,
    roots: scan.roots,
    observedTicketCount: scan.observedTicketCount,
    commitmentHash: scan.commitmentHash,
    prechecked: canPublish,
  });
  if (!publish.ok) {
    throw new Error(`publish_failed round=${roundId} failed=${Number(publish.summary?.failed || 0)}`);
  }

  const settlementMetrics = {
    artifact_source: artifactSource,
    t_ingest_to_watermark_ms: Number(canPublish.metrics?.t_ingest_to_watermark_ms || 0),
    t_seal_snapshot_ms: Number(canPublish.metrics?.t_seal_snapshot_ms || 0),
    t_compute_artifacts_ms: tComputeArtifactsMs,
    t_publish_roots_total_ms: Number(publish.metrics?.t_publish_roots_total_ms || 0),
    per_tier_publish_latency_ms: publish.metrics?.per_tier_publish_latency_ms || {},
    t_readiness_gate_ms: tReadinessMs,
    close_slot: Number(canPublish.metrics?.close_slot || 0),
    finalized_watermark_slot: Number(canPublish.metrics?.finalized_watermark_slot || 0),
  };
  console.log(`[scanner] settlement_metrics round=${roundId} ${JSON.stringify(settlementMetrics)}`);

  return {
    ...scan,
    claimCandidates,
    publish,
    artifactSource,
    settlementMetrics,
  };
}
