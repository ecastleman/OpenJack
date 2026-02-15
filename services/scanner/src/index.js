import { runAndPublishRound } from "./pipelines/runRound.js";
import { buildRoundArtifactsFromCanonicalEvents } from "./core.js";
import { getProofProviderFromEnv } from "./proofs/provider.js";
import { getAssetResolverFromEnv } from "./assets/resolver.js";
import { loadRoundEvents, parseWinningFromEnv } from "./events/source.js";
import { fetchRoundTierPayouts } from "./solana/openjack.js";
import { TicketLedgerRepo } from "./repo/ticketLedger.js";
import { createAuditLoggerFromEnv } from "./audit/logger.js";

const audit = createAuditLoggerFromEnv();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status}`);
  }
  return res.json();
}

async function discoverRoundId() {
  const fixedRoundId = process.env.OPENJACK_SCAN_ROUND_ID;
  if (fixedRoundId) {
    return Number(fixedRoundId);
  }

  const apiBase = (process.env.OPENJACK_API_BASE || "").replace(/\/$/, "");
  if (!apiBase) {
    throw new Error("OPENJACK_SCAN_ROUND_ID is required when OPENJACK_API_BASE is not set");
  }

  const payload = await fetchJson(`${apiBase}/rounds/active`);
  const roundId = Number(payload?.round?.roundId || 0);
  if (!roundId) {
    return null;
  }
  return roundId;
}

async function discoverWinning(roundId) {
  const defaultSource = process.env.OPENJACK_API_BASE ? "api" : "env";
  const source = (process.env.OPENJACK_WINNING_SOURCE || defaultSource).toLowerCase();
  if (source !== "api") {
    return parseWinningFromEnv();
  }

  const apiBase = (process.env.OPENJACK_API_BASE || "").replace(/\/$/, "");
  if (!apiBase) {
    throw new Error("OPENJACK_API_BASE is required when OPENJACK_WINNING_SOURCE=api");
  }

  const payload = await fetchJson(`${apiBase}/rounds/${roundId}`);
  const round = payload?.round;
  const main = Array.isArray(round?.winningMain) ? round.winningMain.map(Number) : null;
  const bonus = Number(round?.winningBonus || 0);
  if (!main || main.length !== 5 || !bonus) {
    return parseWinningFromEnv();
  }
  return { main, bonus };
}

async function postApi(apiBase, ingestKey, path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ingestKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} ingest failed: ${res.status}`);
  }
  return res.json();
}

async function pushRootsToApi(result, roundId) {
  const apiBase = (process.env.OPENJACK_API_BASE || "").replace(/\/$/, "");
  if (!apiBase || !Array.isArray(result.roots)) return;
  const ingestKey = process.env.INGEST_API_KEY || "dev-ingest-key";
  await postApi(apiBase, ingestKey, "/ingest/roots", {
    roundId,
    roots: result.roots,
    observedTicketCount: result.observedTicketCount,
    commitmentHash: result.commitmentHash,
  });
}

async function pushClaimCandidatesToApi(result, roundId) {
  const apiBase = (process.env.OPENJACK_API_BASE || "").replace(/\/$/, "");
  if (!apiBase || !Array.isArray(result.claimCandidates) || result.claimCandidates.length === 0) {
    return;
  }

  const ingestKey = process.env.INGEST_API_KEY || "dev-ingest-key";
  const grouped = new Map();

  const isProofReady = (ticket) =>
    Boolean(
      ticket?.winnerRootHash &&
        ticket?.ownershipProof?.owner &&
        ticket?.compressionRoot &&
        ticket?.compressionLeaf &&
        Number.isInteger(Number(ticket?.compressionIndex)) &&
        Array.isArray(ticket?.ticketProof) &&
        ticket.ticketProof.length > 0,
    );

  for (const rawTicket of result.claimCandidates) {
    const ticket = {
      ...rawTicket,
      proofStatus: isProofReady(rawTicket) ? "READY" : "PENDING_PROOF",
    };
    const wallet = ticket.wallet;
    if (!wallet) continue;
    const entry = grouped.get(wallet) || { estimatedLamports: 0, tickets: [] };
    if (ticket.proofStatus === "READY") {
      entry.estimatedLamports += Number(ticket.amount || 0);
    }
    entry.tickets.push(ticket);
    grouped.set(wallet, entry);
  }

  for (const [wallet, estimate] of grouped.entries()) {
    await postApi(apiBase, ingestKey, "/ingest/claim-estimate", {
      roundId,
      wallet,
      estimatedLamports: estimate.estimatedLamports,
      tickets: estimate.tickets,
    });
  }
}

function applyTierPayouts(claimCandidates, tierPayouts) {
  return claimCandidates.map((t) => ({
    ...t,
    amount: Number(tierPayouts[t.tier] || 0),
  }));
}

async function auditLog(type, payload = {}) {
  if (!audit.enabled) return;
  try {
    await audit.log(type, payload);
  } catch (error) {
    console.error("[scanner] audit log write failed", error instanceof Error ? error.message : String(error));
  }
}

async function auditSummary(summary) {
  if (!audit.enabled) return;
  try {
    await audit.writeSummary(summary);
  } catch (error) {
    console.error("[scanner] audit summary write failed", error instanceof Error ? error.message : String(error));
  }
}

async function runOnce() {
  const roundId = await discoverRoundId();
  if (!roundId) {
    console.log("[scanner] no active round");
    await auditLog("scanner_no_active_round", {});
    return;
  }
  await auditLog("scanner_round_start", {
    roundId,
    eventSourceMode: (process.env.OPENJACK_EVENT_SOURCE_MODE || "sample").toLowerCase(),
    publishMode: process.env.SCANNER_PUBLISH_MODE || "dry-run",
  });
  const winning = await discoverWinning(roundId);
  await auditLog("scanner_winning_numbers", { roundId, winning });
  const assetResolver = getAssetResolverFromEnv();
  const claimsOnlyMode = String(process.env.OPENJACK_SCANNER_CLAIMS_ONLY || "").toLowerCase() === "true";
  let proofProvider = null;
  try {
    proofProvider = getProofProviderFromEnv();
  } catch (error) {
    // Settlement publication is ledger/snapshot-driven and must not be blocked by DAS/proof config.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[scanner] proof provider unavailable; continuing without proofs: ${message}`);
    await auditLog("scanner_proof_provider_unavailable", { roundId, message });
  }

  let result = null;
  if (claimsOnlyMode) {
    const repo = new TicketLedgerRepo();
    const sealed = await repo.getSealedCanonicalEvents(roundId);
    const scan = buildRoundArtifactsFromCanonicalEvents(sealed.events, winning);
    let claimCandidates = scan.claimCandidates || [];
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
    result = {
      ...scan,
      claimCandidates,
      publish: {
        ok: true,
        mode: "claims-only",
        txSignatures: [],
        summary: { total: 0, attempted: 0, published: 0, skipped: 0, failed: 0 },
      },
      artifactSource: "sealed_snapshot",
    };
    console.log(`[scanner] claims-only refresh round=${roundId} artifact_source=sealed_snapshot`);
    await auditLog("scanner_claims_only_refresh", {
      roundId,
      observedTicketCount: Number(result.observedTicketCount || 0),
      claimCandidatesCount: Array.isArray(result.claimCandidates) ? result.claimCandidates.length : 0,
    });
  } else {
    const { wsEvents, backfillEvents } = await loadRoundEvents({ roundId });
    await auditLog("scanner_events_loaded", {
      roundId,
      wsEvents: wsEvents.length,
      backfillEvents: backfillEvents.length,
    });
    const canonical = wsEvents.length >= backfillEvents.length ? wsEvents : backfillEvents;
    for (const event of canonical) {
      await auditLog("ticket_observed", {
        roundId,
        leafIndex: Number(event.leafIndex),
        wallet: String(event.purchaser || ""),
        main: Array.isArray(event.main) ? event.main : [],
        bonus: Number(event.bonus || 0),
        assetId: event.assetId || null,
        txSignature: event.txSignature || null,
        paidLamports: Number(event.paidLamports || 0),
        ticketTs: Number(event.ts || 0),
      });
    }
    if (process.env.OPENJACK_PERSIST_EVENTS === "true") {
      const repo = new TicketLedgerRepo();
      const finalizedEvents = canonical.filter(
        (e) => String(e.commitment || "finalized").toLowerCase() === "finalized",
      );
      let count = 0;
      try {
        count = await repo.upsertMany(finalizedEvents);
        await repo.syncLegacyTicketEvents(finalizedEvents);
        console.log(`[scanner] persisted ticket_ledger rows=${count} (finalized-only)`);
        await auditLog("scanner_events_persisted", { roundId, count, finalizedOnly: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("is sealed; insert rejected")) {
          // Expected during post-seal refresh passes; ledger is immutable by design.
          console.log(`[scanner] ledger sealed round=${roundId}; skipping event persistence`);
          await auditLog("scanner_events_persist_skipped_sealed", { roundId, finalizedOnly: true });
        } else {
          throw error;
        }
      }
    }
    result = await runAndPublishRound({
      roundId,
      winning,
      publishMode: process.env.SCANNER_PUBLISH_MODE || "dry-run",
      assetResolver,
      proofProvider,
    });
  }

  if (result.ok) {
    const useOnchainPayouts = process.env.OPENJACK_FETCH_TIER_PAYOUTS === "true";
    if (useOnchainPayouts) {
      const tierPayouts = await fetchRoundTierPayouts(roundId);
      result.claimCandidates = applyTierPayouts(result.claimCandidates || [], tierPayouts);
      await auditLog("scanner_tier_payouts_loaded", { roundId, tierPayouts });
    }
    await pushRootsToApi(result, roundId);
    await pushClaimCandidatesToApi(result, roundId);
  }
  await auditLog("scanner_round_result", {
    roundId,
    ok: Boolean(result.ok),
    observedTicketCount: Number(result.observedTicketCount || 0),
    commitmentHash: result.commitmentHash || null,
    roots: Array.isArray(result.roots)
      ? result.roots.map((r) => ({
          tier: Number(r.tier),
          rootHash: r.rootHash,
          winnerCount: Number(r.winnerCount),
          leafIndexes: Array.isArray(r.leafIndexes) ? r.leafIndexes : [],
        }))
      : [],
    publish: result.publish || null,
    claimCandidatesCount: Array.isArray(result.claimCandidates) ? result.claimCandidates.length : 0,
  });
  if (Array.isArray(result.claimCandidates)) {
    for (const ticket of result.claimCandidates) {
      await auditLog("claim_candidate", {
        roundId,
        wallet: ticket.wallet || null,
        leafIndex: Number(ticket.leafIndex),
        tier: Number(ticket.tier),
        amount: Number(ticket.amount || 0),
        assetId: ticket.assetId || null,
        txSignature: ticket.txSignature || null,
      });
    }
  }
  await auditSummary({
    roundId,
    ok: Boolean(result.ok),
    observedTicketCount: Number(result.observedTicketCount || 0),
    rootsPublished: Number(result.publish?.summary?.published || 0),
    rootsFailed: Number(result.publish?.summary?.failed || 0),
    claimCandidates: Array.isArray(result.claimCandidates) ? result.claimCandidates.length : 0,
    publishMode: process.env.SCANNER_PUBLISH_MODE || "dry-run",
    eventSourceMode: (process.env.OPENJACK_EVENT_SOURCE_MODE || "sample").toLowerCase(),
  });
  console.log(JSON.stringify({ roundId, ...result }, null, 2));
}

async function runDaemon() {
  const intervalSecs = Number(process.env.OPENJACK_SCAN_INTERVAL_SECS || 30);
  const intervalMs = Math.max(5, intervalSecs) * 1000;
  console.log(`[scanner] daemon mode enabled (interval=${intervalSecs}s)`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runOnce();
    } catch (error) {
      console.error("[scanner] daemon iteration failed", error);
      await auditLog("scanner_iteration_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(intervalMs);
  }
}

if (process.argv[1] && process.argv[1].endsWith("src/index.js")) {
  const mode = (process.env.OPENJACK_SCANNER_MODE || "once").toLowerCase();
  const runner = mode === "daemon" ? runDaemon : runOnce;
  runner().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
