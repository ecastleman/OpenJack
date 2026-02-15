import { runScannerRound } from "./core.js";
import { runAndPublishRound } from "./pipelines/runRound.js";
import { getProofProviderFromEnv } from "./proofs/provider.js";
import { getAssetResolverFromEnv } from "./assets/resolver.js";
import { loadRoundEvents, parseWinningFromEnv } from "./events/source.js";
import { fetchRoundTierPayouts } from "./solana/openjack.js";
import { TicketEventsRepo } from "./repo/ticketEvents.js";
export { runScannerRound } from "./core.js";

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
  const source = (process.env.OPENJACK_WINNING_SOURCE || "env").toLowerCase();
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
  for (const ticket of result.claimCandidates) {
    const wallet = ticket.wallet;
    if (!wallet) continue;
    const entry = grouped.get(wallet) || { estimatedLamports: 0, tickets: [] };
    entry.estimatedLamports += Number(ticket.amount || 0);
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

async function runOnce() {
  const roundId = await discoverRoundId();
  if (!roundId) {
    console.log("[scanner] no active round");
    return;
  }
  const winning = await discoverWinning(roundId);
  const assetResolver = getAssetResolverFromEnv();
  const proofProvider = getProofProviderFromEnv();

  const { wsEvents, backfillEvents } = await loadRoundEvents({ roundId });
  if (process.env.OPENJACK_PERSIST_EVENTS === "true") {
    const repo = new TicketEventsRepo();
    const canonical = wsEvents.length >= backfillEvents.length ? wsEvents : backfillEvents;
    const count = await repo.upsertMany(canonical);
    console.log(`[scanner] persisted ticket_events rows=${count}`);
  }
  const result = await runAndPublishRound({
    roundId,
    wsEvents,
    backfillEvents,
    winning,
    publishMode: process.env.SCANNER_PUBLISH_MODE || "dry-run",
    assetResolver,
    proofProvider,
  });

  if (result.ok) {
    const useOnchainPayouts = process.env.OPENJACK_FETCH_TIER_PAYOUTS === "true";
    if (useOnchainPayouts) {
      const tierPayouts = await fetchRoundTierPayouts(roundId);
      result.claimCandidates = applyTierPayouts(result.claimCandidates || [], tierPayouts);
    }
    await pushRootsToApi(result, roundId);
    await pushClaimCandidatesToApi(result, roundId);
  }
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
