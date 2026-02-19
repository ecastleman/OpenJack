import http from "node:http";
import { deriveClaimRecordPda, deriveRoundPda, getProgramForBuilder } from "./solana/openjack.js";
import { CLAIMABILITY_REASON, ROUND_STATUS, buildClaimabilityResponse } from "../../../packages/shared/src/index.js";
import { loadEnvLocal } from "../../../scripts/env-local.mjs";
import { applyProfileDefaults, buildProfileFingerprint, validateProfileEnv } from "../../../scripts/profile-config.mjs";
import {
  getActiveRound,
  getClaimEstimate,
  getRound,
  getRoundRoots,
  getRoundIngestionStatus,
  getRoundHydrationStatus,
  getScannerStatus,
  setClaimEstimate,
  setRoundRoots,
  upsertRound,
} from "./data/store.js";
import { prepareBuyTx, prepareClaimTx } from "./tx/prepare.js";

const ENV_LOCAL = loadEnvLocal();

const API_PROFILE = String(process.env.OPENJACK_PROFILE || process.env.OPENJACK_GATE_PROFILE || "dev-fast").toLowerCase();
const API_ENV = applyProfileDefaults(API_PROFILE, process.env);
validateProfileEnv(API_PROFILE, API_ENV, "api");
const API_FINGERPRINT = buildProfileFingerprint(API_PROFILE, API_ENV);

const PORT = Number(process.env.PORT || 8080);
const INGEST_API_KEY = process.env.INGEST_API_KEY || "dev-ingest-key";

function detectEnvSource(key, effectiveEnv) {
  const current = String(process.env[key] || "").trim();
  const parsedSet = new Set(ENV_LOCAL.parsedKeys || []);
  const loadedSet = new Set(ENV_LOCAL.keys || []);
  if (current) {
    if (loadedSet.has(key)) return ".env.local";
    if (parsedSet.has(key)) return "shell/env (overrides .env.local)";
    return "shell/env";
  }
  if (String(effectiveEnv[key] || "").trim()) return "profile-default";
  return "unset";
}

function send(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key",
  });
  res.end(JSON.stringify(data));
}

function parsePath(pathname) {
  return pathname.split("/").filter(Boolean);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("payload_too_large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function authorizeIngest(req) {
  return req.headers["x-api-key"] === INGEST_API_KEY;
}

async function enrichClaimEstimate(roundId, estimate) {
  const tickets = Array.isArray(estimate?.tickets) ? estimate.tickets : [];

  const { connection, program, programId } = getProgramForBuilder();
  const roundPda = deriveRoundPda(programId, roundId);
  const round = await program.account.round.fetch(roundPda);
  const roundStatus = Number(round?.status ?? 0);
  const roundIsFinalized = roundStatus === ROUND_STATUS.FINALIZED || roundStatus === 4;

  const ingestion = await getRoundIngestionStatus(roundId).catch(() => null);
  const ingestionReady = Boolean(ingestion?.ingestionState?.sealed);

  if (tickets.length === 0) {
    const readinessReasons = [];
    if (!roundIsFinalized) {
      readinessReasons.push(CLAIMABILITY_REASON.ROUND_NOT_FINALIZED);
    }
    if (!ingestionReady) {
      readinessReasons.push(CLAIMABILITY_REASON.INGESTION_NOT_READY);
    }
    if (roundIsFinalized) {
      readinessReasons.push(CLAIMABILITY_REASON.NOT_WINNER);
    }
    return buildClaimabilityResponse({
      wallet: estimate?.wallet || "",
      roundId,
      roundStatus,
      tickets: [],
      estimatedLamports: 0,
      potentialLamports: 0,
      readinessReasons,
    });
  }

  const tierPayoutsRaw = round.tierPayoutPerWinner || round.tier_payout_per_winner || [];
  const tierPayouts = tierPayoutsRaw.map((v) => Number(v?.toString?.() ?? v ?? 0));

  const claimRecordPdas = tickets.map((t) => deriveClaimRecordPda(programId, roundId, Number(t.leafIndex)));
  const claimRecords = await connection.getMultipleAccountsInfo(claimRecordPdas, "confirmed");
  const requestedWallet = String(estimate?.wallet || "");

  const withReadiness = tickets.map((t, i) => {
    const tier = Number(t?.tier ?? -1);
    const onchainAmount = Number(tierPayouts[tier] || 0);
    const claimed = Boolean(claimRecords[i]);
    const derivedProofReady = Boolean(
      t?.winnerRootHash &&
        t?.ownershipProof?.owner &&
        t?.compressionRoot &&
        t?.compressionLeaf &&
        Number.isInteger(Number(t?.compressionIndex)) &&
        Array.isArray(t?.ticketProof) &&
        t.ticketProof.length > 0,
    );
    const proofStatus = String(t?.proofStatus || (derivedProofReady ? "READY" : "PENDING_PROOF")).toUpperCase();
    const proofReady = proofStatus === "READY";
    const owner = String(t?.ownershipProof?.owner || "");
    const ownerMatches = owner ? owner === requestedWallet : true;
    const readinessReasons = [];

    if (!roundIsFinalized) {
      readinessReasons.push(CLAIMABILITY_REASON.ROUND_NOT_FINALIZED);
    }
    if (!ingestionReady) {
      readinessReasons.push(CLAIMABILITY_REASON.INGESTION_NOT_READY);
    }
    if (claimed) {
      readinessReasons.push(CLAIMABILITY_REASON.ALREADY_CLAIMED);
    }
    if (!ownerMatches) {
      readinessReasons.push(CLAIMABILITY_REASON.OWNER_MISMATCH);
    }
    if (proofStatus === "FAILED") {
      readinessReasons.push(CLAIMABILITY_REASON.PROOF_FAILED);
    } else if (!proofReady) {
      readinessReasons.push(CLAIMABILITY_REASON.PENDING_PROOF);
    }
    if (onchainAmount <= 0) {
      readinessReasons.push(CLAIMABILITY_REASON.PAYOUT_NOT_READY_OR_ZERO);
    }

    return {
      ...t,
      amount: onchainAmount,
      proofStatus,
      readinessReasons,
      claimable: false,
    };
  });

  const estimatedLamports = withReadiness
    .filter((ticket) => Array.isArray(ticket.readinessReasons) && ticket.readinessReasons.length === 0)
    .reduce((acc, ticket) => acc + Number(ticket.amount || 0), 0);
  const potentialLamports = withReadiness.reduce((acc, ticket) => acc + Number(ticket.amount || 0), 0);

  return buildClaimabilityResponse({
    wallet: requestedWallet,
    roundId,
    roundStatus,
    tickets: withReadiness,
    estimatedLamports,
    potentialLamports,
    readinessReasons: [],
  });
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-api-key",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const parts = parsePath(url.pathname);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "openjack-api" });
  }

  if (req.method === "GET" && url.pathname === "/rounds/active") {
    return send(res, 200, { round: await getActiveRound() });
  }

  if (req.method === "GET" && parts.length === 2 && parts[0] === "rounds") {
    const roundId = Number(parts[1]);
    const round = await getRound(roundId);
    if (!round) {
      return send(res, 404, { error: "round_not_found" });
    }
    return send(res, 200, { round });
  }

  if (req.method === "GET" && parts.length === 3 && parts[0] === "rounds" && parts[2] === "roots") {
    const roundId = Number(parts[1]);
    return send(res, 200, { roundId, roots: await getRoundRoots(roundId) });
  }

  if (req.method === "GET" && parts.length === 3 && parts[0] === "rounds" && parts[2] === "ingestion") {
    const roundId = Number(parts[1]);
    if (!roundId) {
      return send(res, 400, { error: "roundId_required" });
    }
    return send(res, 200, await getRoundIngestionStatus(roundId));
  }

  if (req.method === "GET" && parts.length === 3 && parts[0] === "rounds" && parts[2] === "hydration") {
    const roundId = Number(parts[1]);
    if (!roundId) {
      return send(res, 400, { error: "roundId_required" });
    }
    return send(res, 200, await getRoundHydrationStatus(roundId));
  }

  if (req.method === "GET" && url.pathname === "/claims/estimate") {
    const roundId = Number(url.searchParams.get("roundId") || 0);
    const wallet = url.searchParams.get("wallet") || "";
    if (!roundId || !wallet) {
      return send(res, 400, { error: "roundId_and_wallet_required" });
    }
    const estimate = await getClaimEstimate(roundId, wallet);
    return send(res, 200, await enrichClaimEstimate(roundId, estimate));
  }

  if (req.method === "GET" && url.pathname === "/scanner/status") {
    const roundId = Number(url.searchParams.get("roundId") || 0);
    if (!roundId) {
      return send(res, 400, { error: "roundId_required" });
    }
    return send(res, 200, await getScannerStatus(roundId));
  }

  if (req.method === "POST" && url.pathname === "/ingest/round") {
    if (!authorizeIngest(req)) {
      return send(res, 401, { error: "unauthorized" });
    }
    const body = await parseBody(req);
    return send(res, 200, { round: await upsertRound(body) });
  }

  if (req.method === "POST" && url.pathname === "/ingest/roots") {
    if (!authorizeIngest(req)) {
      return send(res, 401, { error: "unauthorized" });
    }
    const body = await parseBody(req);
    return send(res, 200, {
      roundId: body.roundId,
      roots: await setRoundRoots(body.roundId, body),
    });
  }

  if (req.method === "POST" && url.pathname === "/ingest/claim-estimate") {
    if (!authorizeIngest(req)) {
      return send(res, 401, { error: "unauthorized" });
    }
    const body = await parseBody(req);
    return send(res, 200, {
      claim: await setClaimEstimate(body.roundId, body.wallet, body),
    });
  }

  if (req.method === "POST" && url.pathname === "/tx/prepare/buy") {
    const body = await parseBody(req);
    return send(
      res,
      200,
      await prepareBuyTx({
        wallet: body.wallet,
        roundId: body.roundId,
        payload: body.payload,
      }),
    );
  }

  if (req.method === "POST" && url.pathname === "/tx/prepare/claim") {
    const body = await parseBody(req);
    return send(
      res,
      200,
      await prepareClaimTx({
        wallet: body.wallet,
        roundId: body.roundId,
        payload: body.payload,
      }),
    );
  }

  return send(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    send(res, 500, { error: err.message || "internal_error" });
  });
});

server.listen(PORT, () => {
  console.log(
    `[api] profile=${API_PROFILE} fingerprint=${API_FINGERPRINT.id} program_id=${String(API_ENV.OPENJACK_PROGRAM_ID || "")}`,
  );
  console.log(
    `[api] env_sources program_id=${detectEnvSource("OPENJACK_PROGRAM_ID", API_ENV)} proof_mode=${detectEnvSource(
      "OPENJACK_PROOF_MODE",
      API_ENV,
    )} rpc_url=${detectEnvSource("RPC_URL", API_ENV)}`,
  );
  console.log(`openjack-api listening on :${PORT}`);
});
