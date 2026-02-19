import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { classifyTier } from "../packages/shared/src/index.js";
import { applyProfileDefaults, buildProfileFingerprint, validateProfileEnv } from "./profile-config.mjs";
import { loadEnvLocal } from "./env-local.mjs";

loadEnvLocal();

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const { Keypair, PublicKey, Transaction, Connection, SystemInstruction, SystemProgram } = scannerRequire("@solana/web3.js");

const API_BASE = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const FALLBACK_RPC_URL = process.env.OPENJACK_GATE_FALLBACK_RPC_URL || "https://api.devnet.solana.com";
const BUYER_KEYPAIR_PATH =
  process.env.OPENJACK_GATE_BUYER_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  usage();
  process.exit(0);
}

const PROFILE = (process.env.OPENJACK_GATE_PROFILE || cliArgs[0] || "dev-fast").toLowerCase();
const EFFECTIVE_ENV = applyProfileDefaults(PROFILE, process.env);
validateProfileEnv(PROFILE, EFFECTIVE_ENV, "protocol-gate");
const PROFILE_FINGERPRINT = buildProfileFingerprint(PROFILE, EFFECTIVE_ENV);
const CYCLES = Number(process.env.OPENJACK_GATE_CYCLES || cliArgs[1] || 1);
const CLOSE_IN_SECS = Number(process.env.OPENJACK_GATE_CLOSE_IN_SECS || 90);
const OPEN_OFFSET_SECS = Number(process.env.OPENJACK_GATE_OPEN_OFFSET_SECS || -10);
const defaultSettlingWaitMs = PROFILE === "qa-fast" ? 4 * 60 * 1000 : 12 * 60 * 1000;
const defaultFinalizedWaitMs = PROFILE === "qa-fast" ? 5 * 60 * 1000 : 12 * 60 * 1000;
const WAIT_SETTLING_MS = Number(process.env.OPENJACK_GATE_WAIT_SETTLING_MS || defaultSettlingWaitMs);
const WAIT_FINALIZED_MS = Number(process.env.OPENJACK_GATE_WAIT_FINALIZED_MS || defaultFinalizedWaitMs);
const POLL_MS = Number(process.env.OPENJACK_GATE_POLL_MS || 5000);
const KEEPER_TRANSIENT_MAX_WAIT_MS = Number(process.env.OPENJACK_GATE_KEEPER_TRANSIENT_MAX_WAIT_MS || 30_000);
const INGEST_PROBE_MIN_INTERVAL_MS = Number(process.env.OPENJACK_GATE_INGEST_PROBE_MIN_INTERVAL_MS || 10000);
const SEND_TX_MIN_INTERVAL_MS = Number(process.env.OPENJACK_GATE_SEND_TX_MIN_INTERVAL_MS || 1200);
const BUILD_ASSET_MAP = process.env.OPENJACK_GATE_BUILD_ASSET_MAP === "true";
const SKIP_AUTO_CLAIM = String(EFFECTIVE_ENV.OPENJACK_GATE_SKIP_AUTO_CLAIM || "false").toLowerCase() === "true";
const REPORT_DIR = process.env.OPENJACK_GATE_REPORT_DIR || path.resolve(process.cwd(), "reports/protocol-gate");
const CONTINUE_ON_FAIL = process.env.OPENJACK_GATE_CONTINUE_ON_FAIL === "true";
let lastTxSentAt = 0;
const lastIngestProbeAtByRound = new Map();
const PROFILE_PROGRAM_ID =
  EFFECTIVE_ENV.OPENJACK_PROGRAM_ID;

function usage() {
  console.error("Usage: node scripts/protocol-gate.mjs [profile=dev-fast|qa-fast|prod-like] [cycles=1]");
}

if (!Number.isInteger(CYCLES) || CYCLES <= 0) {
  usage();
  process.exit(1);
}

function readKeypair(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(pathname) {
  let res;
  try {
    res = await fetch(`${API_BASE}${pathname}`);
  } catch (error) {
    throw new Error(`GET ${API_BASE}${pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GET ${pathname} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function postJson(pathname, payload) {
  let res;
  try {
    res = await fetch(`${API_BASE}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(`POST ${API_BASE}${pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`POST ${pathname} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function runNpm(args, env = {}) {
  const result = spawnSync("npm", args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function parseCreateRoundOutput(output) {
  const lines = String(output || "").split("\n");
  const roundIdLine = lines.find((l) => l.startsWith("round_id="));
  const roundId = Number((roundIdLine || "").split("=")[1] || 0);
  if (!roundId) {
    throw new Error(`failed to parse round_id from output:\n${output}`);
  }
  return { roundId };
}

function deriveWinning(roundId) {
  const out = runNpm(["run", "-s", "round:predict-winning-ticket", "--", String(roundId)]);
  if (!out.ok) {
    throw new Error(`predict-winning-ticket failed:\n${out.stderr || out.stdout}`);
  }
  const mainLine = out.stdout
    .split("\n")
    .find((l) => l.startsWith("predicted_main="));
  const bonusLine = out.stdout
    .split("\n")
    .find((l) => l.startsWith("predicted_bonus="));
  const main = (mainLine || "")
    .split("=")[1]
    ?.split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n));
  const bonus = Number((bonusLine || "").split("=")[1] || 0);
  if (!main || main.length !== 5 || !bonus) {
    throw new Error(`failed to parse predicted winning numbers:\n${out.stdout}`);
  }
  return { main, bonus };
}

function extractAssetIdFromLogs(logs) {
  for (const line of logs || []) {
    const msg = String(line || "");
    const match = msg.match(/Leaf asset ID:?\s*([1-9A-HJ-NP-Za-km-z]{32,64})/i);
    if (match?.[1]) return match[1];
  }
  for (const line of logs || []) {
    const msg = String(line || "");
    const match = msg.match(/Program return:\s+[1-9A-HJ-NP-Za-km-z]{32,44}\s+([A-Za-z0-9+/=]+)/);
    if (!match?.[1]) continue;
    try {
      const bytes = Buffer.from(match[1], "base64");
      if (bytes.length >= 33) {
        return new PublicKey(bytes.subarray(1, 33)).toBase58();
      }
    } catch {
      // ignore malformed lines
    }
  }
  return null;
}

function extractAssetIdFromText(text) {
  if (!text) return null;
  const lines = String(text).split("\n");
  return extractAssetIdFromLogs(lines);
}

function extractAssetIdFromMeta(meta) {
  const returnData = meta?.returnData;
  if (!returnData?.data) return null;
  const raw = Array.isArray(returnData.data) ? returnData.data[0] : returnData.data;
  if (!raw || typeof raw !== "string") return null;
  try {
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length >= 33) {
      return new PublicKey(bytes.subarray(1, 33)).toBase58();
    }
  } catch {
    // ignore malformed payload
  }
  return null;
}

function fetchAssetIdViaCli(signature, rpcUrl) {
  const result = spawnSync("solana", ["confirm", "-v", "--url", rpcUrl, signature], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  return extractAssetIdFromText(combined);
}

async function fetchAssetIdForSignature(signature, timeoutMs = 90_000) {
  const rpcCandidates = [RPC_URL, FALLBACK_RPC_URL].filter((v, i, arr) => v && arr.indexOf(v) === i);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const rpcUrl of rpcCandidates) {
      try {
        const connection = new Connection(rpcUrl, "confirmed");
        let tx =
          (await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          })) ||
          (await connection.getTransaction(signature, {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          })) ||
          (await connection.getParsedTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          }));
        const meta = tx?.meta || null;
        const logs = meta?.logMessages || [];
        const assetId = extractAssetIdFromMeta(meta) || extractAssetIdFromLogs(logs);
        if (assetId) return assetId;
      } catch {
        // try next rpc candidate
      }
    }
    await sleep(1200);
  }
  for (const rpcUrl of rpcCandidates) {
    const viaCli = fetchAssetIdViaCli(signature, rpcUrl);
    if (viaCli) return viaCli;
  }
  return null;
}

function pickNonWinningNumbers(winningMain, needed) {
  const winSet = new Set(winningMain);
  const available = [];
  for (let n = 1; n <= 50; n += 1) {
    if (!winSet.has(n)) available.push(n);
  }
  return available.slice(0, needed);
}

function buildTierTickets(winning) {
  const wm = [...winning.main].sort((a, b) => a - b);
  const wb = winning.bonus;
  const non = pickNonWinningNumbers(wm, 8);
  const make = (main, bonus, label) => ({ main: [...main].sort((a, b) => a - b), bonus, label });

  const candidates = [
    make(wm, wb, "jackpot"),
    make(wm, wb === 10 ? 9 : 10, "t5_only"),
    make([wm[0], wm[1], wm[2], wm[3], non[0]], wb, "t4_bonus"),
    make([wm[0], wm[1], wm[2], wm[3], non[1]], wb === 10 ? 9 : 10, "t4_only"),
    make([wm[0], wm[1], wm[2], non[2], non[3]], wb, "t3_bonus"),
    make([wm[0], wm[1], non[4], non[5], non[6]], wb, "t2_bonus"),
    make([wm[0], non[0], non[1], non[2], non[3]], wb === 10 ? 9 : 10, "non_winner"),
  ];

  for (const ticket of candidates) {
    const tier = classifyTier({ main: ticket.main, bonus: ticket.bonus }, winning);
    if (ticket.label === "non_winner" && tier !== -1) {
      throw new Error(`generated non_winner ticket matched tier=${tier}`);
    }
  }
  return candidates;
}

function computeMinimumCloseInSecs(ticketCount) {
  const perTicketMs = Math.max(SEND_TX_MIN_INTERVAL_MS, 1000) + 2500;
  const fixedOverheadMs = 10_000;
  return Math.ceil((ticketCount * perTicketMs + fixedOverheadMs) / 1000);
}

async function signAndSend(unsignedTxBase64, buyerKeypair) {
  const connection = new Connection(RPC_URL, "confirmed");
  const decoded = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: buyerKeypair.publicKey,
    blockhash: latest.blockhash,
  });
  tx.recentBlockhash = latest.blockhash;
  for (const ix of decoded.instructions) tx.add(ix);
  tx.sign(buyerKeypair);
  if (SEND_TX_MIN_INTERVAL_MS > 0) {
    const now = Date.now();
    const waitMs = SEND_TX_MIN_INTERVAL_MS - (now - lastTxSentAt);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });
  lastTxSentAt = Date.now();
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );
  return sig;
}

async function prepareBuyTicket(roundId, wallet, ticket) {
  return postJson("/tx/prepare/buy", {
    wallet,
    roundId,
    payload: {
      qty: 1,
      quickPick: false,
      tickets: [{ main: ticket.main, bonus: ticket.bonus }],
    },
  });
}

function estimateInstructionDebitLamports(ix, buyerPubkey) {
  if (!ix?.programId?.equals?.(SystemProgram.programId)) return 0;
  try {
    const kind = SystemInstruction.decodeInstructionType(ix);
    if (kind === "Transfer") {
      const decoded = SystemInstruction.decodeTransfer(ix);
      return decoded?.fromPubkey?.equals?.(buyerPubkey) ? Number(decoded.lamports || 0) : 0;
    }
    if (kind === "TransferWithSeed") {
      const decoded = SystemInstruction.decodeTransferWithSeed(ix);
      return decoded?.fromPubkey?.equals?.(buyerPubkey) ? Number(decoded.lamports || 0) : 0;
    }
    if (kind === "Create") {
      const decoded = SystemInstruction.decodeCreateAccount(ix);
      return decoded?.fromPubkey?.equals?.(buyerPubkey) ? Number(decoded.lamports || 0) : 0;
    }
    if (kind === "CreateWithSeed") {
      const decoded = SystemInstruction.decodeCreateWithSeed(ix);
      return decoded?.fromPubkey?.equals?.(buyerPubkey) ? Number(decoded.lamports || 0) : 0;
    }
  } catch {
    // Ignore undecodable system instructions and continue with best-effort estimate.
  }
  return 0;
}

async function estimateBuyerDebitLamports(unsignedTxBase64, buyerPubkey) {
  let tx;
  try {
    tx = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  } catch {
    return 0;
  }
  let debitLamports = 0;
  for (const ix of tx.instructions || []) {
    debitLamports += estimateInstructionDebitLamports(ix, buyerPubkey);
  }
  try {
    const connection = new Connection(RPC_URL, "confirmed");
    const fee = await connection.getFeeForMessage(tx.compileMessage(), "confirmed");
    debitLamports += Number(fee?.value || 0);
  } catch {
    // Fall back to debit estimate without fee if RPC fee lookup is unavailable.
  }
  return debitLamports;
}

async function assertSufficientFundsForCycle({ buyerPubkey, preparedBuys, cycleNumber, roundId }) {
  const connection = new Connection(RPC_URL, "confirmed");
  const balanceLamports = await connection.getBalance(buyerPubkey, "confirmed");
  let estimatedLamportsNeeded = 0;
  for (const prepared of preparedBuys) {
    estimatedLamportsNeeded += await estimateBuyerDebitLamports(prepared.unsignedTxBase64, buyerPubkey);
  }
  const safetyLamports = 1_000_000; // 0.001 SOL safety buffer for fee/rent drift.
  const requiredLamports = estimatedLamportsNeeded + safetyLamports;
  if (balanceLamports < requiredLamports) {
    const shortfallLamports = requiredLamports - balanceLamports;
    throw new Error(
      `insufficient_funds_for_cycle cycle=${cycleNumber} round=${roundId} ` +
        `balance_lamports=${balanceLamports} estimated_lamports_needed=${requiredLamports} shortfall_lamports=${shortfallLamports}`,
    );
  }
}

async function buyPreparedTicket(prepared, buyer) {
  const sig = await signAndSend(prepared.unsignedTxBase64, buyer);
  return sig;
}

async function waitForStatus(roundId, targetStatuses, timeoutMs, onPoll) {
  const target = new Set(targetStatuses.map((s) => String(s).toUpperCase()));
  const start = Date.now();
  let lastSeen = "UNKNOWN";
  while (Date.now() - start < timeoutMs) {
    let round = null;
    let status = "";
    try {
      round = (await getJson(`/rounds/${roundId}`)).round;
      status = String(round?.status || "").toUpperCase();
      lastSeen = status || lastSeen;
      if (target.has(status)) return round;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(" 404 ") && !message.includes("404")) {
        throw error;
      }
      status = "NOT_INGESTED";
      lastSeen = status;
    }
    if (onPoll) await onPoll(status);
    await sleep(POLL_MS);
  }
  // One final read avoids false negatives where API/state crosses target right after loop deadline.
  try {
    const finalRound = (await getJson(`/rounds/${roundId}`)).round;
    const finalStatus = String(finalRound?.status || "").toUpperCase();
    if (target.has(finalStatus)) {
      console.log(`[gate] round=${roundId} late_status_check=${finalStatus} accepted_after_timeout_window`);
      return finalRound;
    }
    lastSeen = finalStatus || lastSeen;
  } catch {
    // keep timeout error with last seen status
  }
  throw new Error(`timeout waiting for ${[...target].join("|")} round=${roundId} last_status=${lastSeen}`);
}

function createStatusPhaseLogger({ cycle, roundId, phase }) {
  let lastStatus = null;
  return (status) => {
    const normalized = String(status || "UNKNOWN").toUpperCase();
    if (normalized === lastStatus) return;
    lastStatus = normalized;
    console.log(`[gate] cycle=${cycle} round=${roundId} phase=${phase} status=${normalized}`);
  };
}

function kickKeeper(roundId, programId = PROFILE_PROGRAM_ID, { ingestOnly = false } = {}) {
  return runNpm(["run", "-s", "keeper"], {
    OPENJACK_KEEPER_MODE: "once",
    OPENJACK_KEEPER_ROUND_ID: String(roundId),
    OPENJACK_AUTO_FULFILL_DRAW: process.env.OPENJACK_AUTO_FULFILL_DRAW || "true",
    OPENJACK_KEEPER_INGEST_ONLY: ingestOnly ? "true" : "false",
    OPENJACK_PROGRAM_ID: programId,
    OPENJACK_API_BASE: API_BASE,
    INGEST_API_KEY: process.env.INGEST_API_KEY || "dev-ingest-key",
  });
}

function normalizeStatus(status) {
  return String(status || "UNKNOWN").toUpperCase();
}

function computeKeeperActionForPhase(phase, status) {
  const s = normalizeStatus(status);
  const autoFulfill = String(process.env.OPENJACK_AUTO_FULFILL_DRAW || "true").toLowerCase() === "true";
  if (phase === "to_settling") {
    if (s === "OPEN") return "close_round_if_due";
    if (s === "CLOSED") return "request_draw";
    if (s === "DRAWING") return autoFulfill ? "fulfill_draw" : "wait_drawing";
    if (s === "SETTLING") return "none";
    if (s === "FINALIZED") return "none";
    if (s === "NOT_INGESTED") return "ingest_probe";
    return null;
  }
  if (phase === "to_finalized") {
    if (s === "SETTLING") return "finalize_prizes_if_due";
    if (s === "FINALIZED") return "none";
    if (s === "NOT_INGESTED") return "ingest_probe";
    return null;
  }
  return null;
}

function shouldExecuteKeeperAction(action) {
  return (
    action === "close_round_if_due" ||
    action === "request_draw" ||
    action === "fulfill_draw" ||
    action === "finalize_prizes_if_due" ||
    action === "ingest_probe"
  );
}

function isTransientKeeperError(message = "") {
  const m = String(message || "");
  return (
    m.includes("RoundNotClosable") ||
    m.includes("Round is not yet closable") ||
    m.includes("SettlementWindowOpen") ||
    m.includes("settlement window is still open") ||
    m.includes("Invalid round state for this instruction") ||
    m.includes("Account does not exist or has no data") ||
    // Intermittent devnet/provider flake observed during keeper finalize RPC.
    m.includes("Unknown action 'undefined'")
  );
}

async function getRoundSnapshotSafe(roundId) {
  try {
    const round = (await getJson(`/rounds/${roundId}`))?.round;
    return {
      status: normalizeStatus(round?.status || "UNKNOWN"),
      drawTs: Number(round?.drawTs || 0),
      winningBonus: Number(round?.winningBonus || 0),
      settleDeadlineTs: Number(round?.settleDeadlineTs || 0),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      return { status: "NOT_INGESTED", drawTs: 0, winningBonus: 0, settleDeadlineTs: 0 };
    }
    return { status: "UNKNOWN", drawTs: 0, winningBonus: 0, settleDeadlineTs: 0 };
  }
}

function hasActionProgressed({ action, initialSnapshot, currentSnapshot }) {
  const from = normalizeStatus(initialSnapshot?.status);
  const now = normalizeStatus(currentSnapshot?.status);
  if (action === "request_draw") {
    return (
      (from === "CLOSED" && (now === "DRAWING" || now === "SETTLING" || now === "FINALIZED")) ||
      Number(currentSnapshot?.drawTs || 0) > Number(initialSnapshot?.drawTs || 0)
    );
  }
  if (action === "close_round_if_due") {
    return from === "OPEN" && (now === "CLOSED" || now === "DRAWING" || now === "SETTLING" || now === "FINALIZED");
  }
  if (action === "fulfill_draw") {
    return (
      (from === "DRAWING" && (now === "SETTLING" || now === "FINALIZED")) ||
      Number(currentSnapshot?.winningBonus || 0) !== 0
    );
  }
  if (action === "finalize_prizes_if_due") {
    return (from === "SETTLING" && now === "FINALIZED") || now === "FINALIZED";
  }
  return false;
}

async function confirmOrRetryCustom6000({
  roundId,
  action,
  initialSnapshot,
  retries = 3,
  retryDelayMs = 1200,
  maxWaitMs = 30_000,
  programId = PROFILE_PROGRAM_ID,
  ingestOnly = false,
}) {
  const startedAtMs = Date.now();
  let lastSnapshot = await getRoundSnapshotSafe(roundId);
  if (hasActionProgressed({ action, initialSnapshot, currentSnapshot: lastSnapshot })) {
    return { confirmedTransient: true, lastStatus: lastSnapshot.status, retriesUsed: 0, elapsedMs: Date.now() - startedAtMs };
  }
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (Date.now() - startedAtMs >= maxWaitMs) {
      break;
    }
    await sleep(retryDelayMs);
    const retry = kickKeeper(roundId, programId, { ingestOnly });
    if (retry.ok) {
      lastSnapshot = await getRoundSnapshotSafe(roundId);
      return {
        confirmedTransient: true,
        lastStatus: lastSnapshot.status,
        retriesUsed: attempt,
        elapsedMs: Date.now() - startedAtMs,
      };
    }
    const retryOutput = String(retry.stderr || retry.stdout || "");
    lastSnapshot = await getRoundSnapshotSafe(roundId);
    if (hasActionProgressed({ action, initialSnapshot, currentSnapshot: lastSnapshot })) {
      return {
        confirmedTransient: true,
        lastStatus: lastSnapshot.status,
        retriesUsed: attempt,
        elapsedMs: Date.now() - startedAtMs,
      };
    }
    if (!retryOutput.includes("Custom: 6000")) {
      return {
        confirmedTransient: false,
        lastStatus: lastSnapshot.status,
        retriesUsed: attempt,
        lastOutput: retryOutput,
        elapsedMs: Date.now() - startedAtMs,
      };
    }
  }
  return {
    confirmedTransient: false,
    lastStatus: lastSnapshot.status,
    retriesUsed: retries,
    elapsedMs: Date.now() - startedAtMs,
  };
}

async function kickKeeperOrThrow(
  roundId,
  contextLabel,
  { allowTransient = false, programId = PROFILE_PROGRAM_ID, ingestOnly = false, action = "", status = "" } = {},
) {
  const result = kickKeeper(roundId, programId, { ingestOnly });
  if (!result.ok) {
    const output = result.stderr || result.stdout || "unknown keeper error";
    const hasCustom6000 = String(output).includes("Custom: 6000");
    if (allowTransient && hasCustom6000) {
      const initialSnapshot = await getRoundSnapshotSafe(roundId);
      const confirmation = await confirmOrRetryCustom6000({
        roundId,
        action,
        initialSnapshot,
        maxWaitMs: KEEPER_TRANSIENT_MAX_WAIT_MS,
        programId,
        ingestOnly,
      });
      if (confirmation.confirmedTransient) {
        console.log(
          `[gate] keeper_transient_confirmed round=${roundId} action=${action} initial=${normalizeStatus(status)} current=${confirmation.lastStatus} retries=${confirmation.retriesUsed} elapsed_ms=${confirmation.elapsedMs}`,
        );
        return result;
      }
      throw new Error(
        `keeper_custom_6000_not_progressing (${contextLabel}) round=${roundId} action=${action} initial_status=${normalizeStatus(status)} last_status=${confirmation.lastStatus} retries=${confirmation.retriesUsed} elapsed_ms=${confirmation.elapsedMs}`,
      );
    }
    if (allowTransient && isTransientKeeperError(output)) {
      return result;
    }
    throw new Error(
      `keeper failed (${contextLabel}) round=${roundId}\n${output}`,
    );
  }
  return result;
}

async function nudgeKeeperForPhase(
  roundId,
  { phase, status, allowTransient = true, programId = PROFILE_PROGRAM_ID, onDiagnostic = null },
) {
  const normalizedStatus = normalizeStatus(status);
  const computedAction = computeKeeperActionForPhase(phase, normalizedStatus);
  console.log(
    `[gate] keeper_nudge round=${roundId} phase=${phase} status=${normalizedStatus} action=${computedAction ?? "UNMAPPED"}`,
  );
  if (!computedAction) {
    if (onDiagnostic) {
      onDiagnostic({
        type: "keeper_action_unmapped",
        roundId,
        phase,
        status: normalizedStatus,
        computedAction: null,
        ts: new Date().toISOString(),
      });
    }
    return { skipped: true, reason: "keeper_action_unmapped" };
  }
  if (!shouldExecuteKeeperAction(computedAction)) {
    return { skipped: true, reason: "no_keeper_action_required", action: computedAction };
  }
  if (computedAction === "ingest_probe") {
    const now = Date.now();
    const last = Number(lastIngestProbeAtByRound.get(String(roundId)) || 0);
    const elapsed = now - last;
    if (elapsed < INGEST_PROBE_MIN_INTERVAL_MS) {
      if (onDiagnostic) {
        onDiagnostic({
          type: "keeper_ingest_probe_rate_limited",
          roundId,
          phase,
          status: normalizedStatus,
          computedAction,
          minIntervalMs: INGEST_PROBE_MIN_INTERVAL_MS,
          elapsedMs: elapsed,
          ts: new Date().toISOString(),
        });
      }
      return { skipped: true, reason: "keeper_ingest_probe_rate_limited", action: computedAction, elapsedMs: elapsed };
    }
    lastIngestProbeAtByRound.set(String(roundId), now);
  }
  return kickKeeperOrThrow(roundId, `${phase} status=${normalizedStatus} action=${computedAction}`, {
    allowTransient,
    programId,
    ingestOnly: computedAction === "ingest_probe",
    action: computedAction,
    status: normalizedStatus,
  });
}

function runScannerOnce(roundId, buySignatures, reportSlug, assetMapPath = null, { claimsOnly = false } = {}) {
  const auditLogPath = path.resolve(REPORT_DIR, `${reportSlug}.scanner-audit.jsonl`);
  const auditSummaryPath = path.resolve(REPORT_DIR, `${reportSlug}.scanner-summary.json`);
  const dasRpcUrl = process.env.OPENJACK_DAS_RPC_URL || process.env.RPC_URL || RPC_URL || "";
  return runNpm(["run", "-s", "scanner"], {
    OPENJACK_SCANNER_MODE: "once",
    OPENJACK_SCANNER_CLAIMS_ONLY: claimsOnly ? "true" : "false",
    OPENJACK_SCAN_ROUND_ID: String(roundId),
    OPENJACK_EVENT_SOURCE_MODE: "rpc",
    OPENJACK_RPC_SIGNATURES: buySignatures.join(","),
    OPENJACK_ASSET_RESOLVER_MODE: process.env.OPENJACK_ASSET_RESOLVER_MODE || (assetMapPath ? "file" : "derived"),
    OPENJACK_ASSET_MAP_PATH: assetMapPath || process.env.OPENJACK_ASSET_MAP_PATH || "",
    OPENJACK_PERSIST_EVENTS: "true",
    OPENJACK_DEBUG_EVENTS: "true",
    OPENJACK_ASSET_HEURISTIC_FALLBACK: "false",
    SCANNER_PUBLISH_MODE: "live",
    OPENJACK_WINNING_SOURCE: "api",
    OPENJACK_API_BASE: API_BASE,
    INGEST_API_KEY: process.env.INGEST_API_KEY || "dev-ingest-key",
    RPC_URL: process.env.RPC_URL || RPC_URL,
    OPENJACK_PROOF_MODE: EFFECTIVE_ENV.OPENJACK_PROOF_MODE || "das",
    OPENJACK_DAS_RPC_URL: dasRpcUrl,
    OPENJACK_FETCH_TIER_PAYOUTS: "true",
    OPENJACK_PROGRAM_ID: PROFILE_PROGRAM_ID,
    OPENJACK_AUDIT_LOG_PATH: auditLogPath,
    OPENJACK_AUDIT_SUMMARY_PATH: auditSummaryPath,
  });
}

async function waitForClaimable(roundId, wallet, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const estimate = await getJson(`/claims/estimate?roundId=${roundId}&wallet=${wallet}`);
    if (isEstimateClaimable(estimate)) {
      return estimate;
    }
    await sleep(3000);
  }
  throw new Error(`claim estimate not ready round=${roundId}`);
}

function isTicketClaimable(ticket) {
  if (ticket?.claimable === true) return true;
  if (Array.isArray(ticket?.readinessReasons) && ticket.readinessReasons.length > 0) return false;
  return Number(ticket?.amount || 0) > 0 && String(ticket?.proofStatus || "").toUpperCase() === "READY";
}

function summarizeEstimate(estimate) {
  const tickets = Array.isArray(estimate?.tickets) ? estimate.tickets : [];
  const reasons = {};
  let claimable = 0;
  let pendingProof = 0;
  let positiveAmount = 0;
  for (const t of tickets) {
    if (Number(t?.amount || 0) > 0) positiveAmount += 1;
    if (String(t?.proofStatus || "").toUpperCase() !== "READY") pendingProof += 1;
    if (isTicketClaimable(t)) {
      claimable += 1;
    }
    for (const reason of Array.isArray(t?.readinessReasons) ? t.readinessReasons : []) {
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
  }
  return {
    tickets: tickets.length,
    claimable,
    pendingProof,
    positiveAmount,
    estimatedLamports: Number(estimate?.estimatedLamports || 0),
    potentialLamports: Number(estimate?.potentialLamports || 0),
    roundStatus: estimate?.roundStatus || null,
    reasons,
  };
}

function isEstimateClaimable(estimate) {
  const tickets = Array.isArray(estimate?.tickets) ? estimate.tickets : [];
  return tickets.some(isTicketClaimable) && Number(estimate?.estimatedLamports || 0) > 0;
}

function hasWinnerVisibility(estimate) {
  return Array.isArray(estimate?.tickets) && estimate.tickets.length > 0;
}

async function waitForClaimableWithScannerRefresh({
  roundId,
  wallet,
  buySignatures,
  reportSlug,
  assetMapPath = null,
  timeoutMs = 4 * 60 * 1000,
  refreshIntervalMs = 20_000,
  readyCheck = isEstimateClaimable,
  notReadyLabel = "claim estimate not ready",
}) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    const estimate = await getJson(`/claims/estimate?roundId=${roundId}&wallet=${wallet}`);
    if (readyCheck(estimate)) {
      return estimate;
    }
    const scan = runScannerOnce(roundId, buySignatures, `${reportSlug}-refresh-${attempt}`, assetMapPath);
    if (!scan.ok) {
      const output = `${scan.stderr || ""}\n${scan.stdout || ""}`;
      const expectedPostFinalize =
        output.includes("publish_precondition_failed") &&
        (output.includes("round_status=4") || output.includes("requires SETTLING=3"));
      if (expectedPostFinalize) {
        // Scanner publish path is correctly blocked after FINALIZED; run claims-only refresh.
        console.log(
          `[gate] round=${roundId} refresh attempt=${attempt} publish blocked (already finalized), running claims-only refresh`,
        );
        const claimsRefresh = runScannerOnce(
          roundId,
          buySignatures,
          `${reportSlug}-claims-only-${attempt}`,
          assetMapPath,
          { claimsOnly: true },
        );
        if (!claimsRefresh.ok) {
          throw new Error(
            `claims-only refresh failed round=${roundId} attempt=${attempt}\n${claimsRefresh.stderr || claimsRefresh.stdout}`,
          );
        }
      } else {
        throw new Error(`scanner refresh failed round=${roundId} attempt=${attempt}\n${scan.stderr || scan.stdout}`);
      }
    }
    await sleep(refreshIntervalMs);
  }
  const finalEstimate = await getJson(`/claims/estimate?roundId=${roundId}&wallet=${wallet}`);
  const summary = summarizeEstimate(finalEstimate);
  throw new Error(
    `${notReadyLabel} round=${roundId} after refreshes details=${JSON.stringify(summary)}`,
  );
}

async function waitForSealedSnapshot(roundId, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const payload = await getJson(`/rounds/${roundId}/ingestion`);
    const sealed = Boolean(payload?.ingestionState?.sealed);
    const snapshotHash = String(payload?.snapshot?.snapshotHashHex || "");
    if (sealed && snapshotHash) {
      return payload;
    }
    await sleep(3000);
  }
  throw new Error(`ingestion snapshot not sealed round=${roundId}`);
}

async function claimAll(roundId, buyer) {
  const wallet = buyer.publicKey.toBase58();
  const estimate = await getJson(`/claims/estimate?roundId=${roundId}&wallet=${wallet}`);
  const claimed = [];
  for (const ticket of estimate.tickets || []) {
    if (Number(ticket.amount || 0) <= 0) continue;
    const normalizedTicket = {
      ...ticket,
      ownershipProof: {
        ...(ticket.ownershipProof || {}),
        owner: wallet,
      },
    };
    const prepared = await postJson("/tx/prepare/claim", {
      wallet,
      roundId,
      payload: normalizedTicket,
    });
    const sig = await signAndSend(prepared.unsignedTxBase64, buyer);
    claimed.push({ leafIndex: ticket.leafIndex, tier: ticket.tier, amount: ticket.amount, sig });
  }
  const after = await getJson(`/claims/estimate?roundId=${roundId}&wallet=${wallet}`);
  return { claimed, after };
}

async function runCycle(index, buyer) {
  const keeperDiagnostics = [];
  const recordKeeperDiagnostic = (event) => {
    keeperDiagnostics.push(event);
  };
  try {
  const cycleNumber = index + 1;
  const reportSlug = `cycle-${index + 1}-${Date.now()}`;
  const profileProgramId = PROFILE_PROGRAM_ID;
  const minimumCloseInSecs = computeMinimumCloseInSecs(7);
  const effectiveCloseInSecs = Math.max(CLOSE_IN_SECS, minimumCloseInSecs);
  if (effectiveCloseInSecs !== CLOSE_IN_SECS) {
    console.log(
      `[gate] cycle=${cycleNumber} close_in_secs bumped ${CLOSE_IN_SECS} -> ${effectiveCloseInSecs} to fit sequential buys`,
    );
  }
  const createScript =
    PROFILE === "prod-like"
      ? "round:create-open:prod-like"
      : PROFILE === "qa-fast"
        ? "round:create-open:qa-fast"
        : "round:create-open:dev-fast";
  const createOut = runNpm(["run", "-s", createScript], {
    OPENJACK_OPEN_OFFSET_SECS: String(OPEN_OFFSET_SECS),
    OPENJACK_CLOSE_IN_SECS: String(effectiveCloseInSecs),
    OPENJACK_PROGRAM_ID: profileProgramId,
    // Avoid inheriting malformed shell values from prior manual sessions.
    OPENJACK_TREE_ADDRESS: "",
    OPENJACK_TREE_CONFIG_ADDRESS: "",
  });
  if (!createOut.ok) {
    throw new Error(
      `create round failed (script=${createScript}):\n${createOut.stderr || createOut.stdout}\n${createOut.stdout || ""}`,
    );
  }
  const { roundId } = parseCreateRoundOutput(createOut.stdout);
  const winning = deriveWinning(roundId);
  const tickets = buildTierTickets(winning);

  // Do not block the cycle on API ingest visibility for OPEN.
  // Buy preparation reads on-chain state directly, so ingest lag should not fail the cycle.
  await nudgeKeeperForPhase(roundId, {
    phase: "to_settling",
    status: "NOT_INGESTED",
    allowTransient: true,
    programId: profileProgramId,
    onDiagnostic: recordKeeperDiagnostic,
  });
  try {
    const visible = await waitForStatus(
      roundId,
      ["OPEN", "CLOSED", "DRAWING", "SETTLING", "FINALIZED"],
      20_000,
      async () => {
        await nudgeKeeperForPhase(roundId, {
          phase: "to_settling",
          status: "NOT_INGESTED",
          allowTransient: true,
          programId: profileProgramId,
          onDiagnostic: recordKeeperDiagnostic,
        });
      },
    );
    console.log(`[gate] cycle=${cycleNumber} round=${roundId} status=${visible.status}`);
  } catch {
    console.log(`[gate] cycle=${cycleNumber} round=${roundId} status=NOT_INGESTED_YET (continuing)`);
  }

  const preparedBuys = [];
  for (const ticket of tickets) {
    const prepared = await prepareBuyTicket(roundId, buyer.publicKey.toBase58(), ticket);
    preparedBuys.push(prepared);
  }
  await assertSufficientFundsForCycle({
    buyerPubkey: buyer.publicKey,
    preparedBuys,
    cycleNumber,
    roundId,
  });

  const buySigs = [];
  for (const ticket of tickets) {
    const prepared = preparedBuys[buySigs.length];
    const sig = await buyPreparedTicket(prepared, buyer);
    buySigs.push(sig);
    console.log(
      `[gate] buy round=${roundId} label=${ticket.label} main=${ticket.main.join(",")} bonus=${ticket.bonus} sig=${sig}`,
    );
  }

  let assetMapPath = null;
  if (BUILD_ASSET_MAP) {
    const assetByLeafIndex = {};
    const resolvedAssets = await Promise.all(buySigs.map((sig) => fetchAssetIdForSignature(sig)));
    for (let i = 0; i < resolvedAssets.length; i += 1) {
      const assetId = resolvedAssets[i];
      if (assetId) {
        assetByLeafIndex[String(i)] = assetId;
      }
    }

    assetMapPath = path.resolve(REPORT_DIR, `${reportSlug}.asset-map.json`);
    fs.writeFileSync(
      assetMapPath,
      JSON.stringify(
        {
          byRound: {
            [String(roundId)]: assetByLeafIndex,
          },
          byLeafIndex: assetByLeafIndex,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  const logToSettling = createStatusPhaseLogger({ cycle: cycleNumber, roundId, phase: "to_settling" });
  await waitForStatus(roundId, ["SETTLING"], WAIT_SETTLING_MS, async (status) => {
    logToSettling(status);
    await nudgeKeeperForPhase(roundId, {
      phase: "to_settling",
      status,
      allowTransient: true,
      programId: profileProgramId,
      onDiagnostic: recordKeeperDiagnostic,
    });
  });
  console.log(`[gate] cycle=${cycleNumber} round=${roundId} phase=to_settling status=SETTLING (reached)`);

  const scan = runScannerOnce(roundId, buySigs, reportSlug, assetMapPath);
  if (!scan.ok) {
    throw new Error(`scanner once failed:\n${scan.stderr || scan.stdout}`);
  }

  const logToFinalized = createStatusPhaseLogger({ cycle: cycleNumber, roundId, phase: "to_finalized" });
  await waitForStatus(roundId, ["FINALIZED"], WAIT_FINALIZED_MS, async (status) => {
    logToFinalized(status);
    await nudgeKeeperForPhase(roundId, {
      phase: "to_finalized",
      status,
      allowTransient: true,
      programId: profileProgramId,
      onDiagnostic: recordKeeperDiagnostic,
    });
  });
  console.log(`[gate] cycle=${cycleNumber} round=${roundId} phase=to_finalized status=FINALIZED (reached)`);

  // Protocol gate invariant: claim phase must not start before sealed scanner snapshot is present.
  await waitForSealedSnapshot(roundId);

  const claimable = await waitForClaimableWithScannerRefresh({
    roundId,
    wallet: buyer.publicKey.toBase58(),
    buySignatures: buySigs,
    reportSlug,
    assetMapPath,
    readyCheck: SKIP_AUTO_CLAIM ? hasWinnerVisibility : isEstimateClaimable,
    notReadyLabel: SKIP_AUTO_CLAIM ? "winner visibility not ready" : "claim estimate not ready",
  });
  if (SKIP_AUTO_CLAIM) {
    console.log(`[gate] cycle=${cycleNumber} round=${roundId} auto-claim skipped by OPENJACK_GATE_SKIP_AUTO_CLAIM=true`);
    return {
      roundId,
      winning,
      bought: tickets.map((t, i) => ({ ...t, txSignature: buySigs[i] })),
      scannerStdout: scan.stdout,
      claimEstimatedBefore: Number(claimable.estimatedLamports || 0),
      claimTicketsBefore: Array.isArray(claimable.tickets) ? claimable.tickets.length : 0,
      claimed: [],
      claimEstimatedAfter: Number(claimable.estimatedLamports || 0),
      claimTicketsAfter: Array.isArray(claimable.tickets) ? claimable.tickets.length : 0,
      autoClaimSkipped: true,
      claimReadiness: summarizeEstimate(claimable),
      keeperDiagnostics,
    };
  }
  const claims = await claimAll(roundId, buyer);

  return {
    roundId,
    winning,
    bought: tickets.map((t, i) => ({ ...t, txSignature: buySigs[i] })),
    scannerStdout: scan.stdout,
    claimEstimatedBefore: Number(claimable.estimatedLamports || 0),
    claimTicketsBefore: Array.isArray(claimable.tickets) ? claimable.tickets.length : 0,
    claimed: claims.claimed,
    claimEstimatedAfter: Number(claims.after.estimatedLamports || 0),
    claimTicketsAfter: Array.isArray(claims.after.tickets) ? claims.after.tickets.length : 0,
    claimReadiness: summarizeEstimate(claimable),
    keeperDiagnostics,
  };
  } catch (error) {
    if (error && typeof error === "object") {
      error.keeperDiagnostics = keeperDiagnostics;
    }
    throw error;
  }
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  if (PROFILE === "qa-fast" && !PROFILE_PROGRAM_ID) {
    throw new Error("qa-fast requires OPENJACK_PROGRAM_ID to be set");
  }
  console.log(
    `[gate] profile=${PROFILE} fingerprint=${PROFILE_FINGERPRINT.id} proof_mode=${String(
      EFFECTIVE_ENV.OPENJACK_PROOF_MODE || "",
    )} skip_auto_claim=${SKIP_AUTO_CLAIM} program_id=${PROFILE_PROGRAM_ID}`,
  );
  if (!SKIP_AUTO_CLAIM) {
    console.log("[gate] auto-claim enabled: claim estimates will drop to 0 after execution");
  }
  const buyer = readKeypair(BUYER_KEYPAIR_PATH);
  await getJson("/health");
  const report = {
    generatedAt: new Date().toISOString(),
    stackSessionId: process.env.OPENJACK_STACK_SESSION_ID || null,
    profile: PROFILE,
    cycles: CYCLES,
    rpcUrl: RPC_URL,
    apiBase: API_BASE,
    sendTxMinIntervalMs: SEND_TX_MIN_INTERVAL_MS,
    buyer: buyer.publicKey.toBase58(),
    results: [],
    ok: true,
    continueOnFail: CONTINUE_ON_FAIL,
    skipAutoClaim: SKIP_AUTO_CLAIM,
    profileFingerprint: PROFILE_FINGERPRINT.id,
    profileFingerprintPayload: PROFILE_FINGERPRINT.payload,
  };

  for (let i = 0; i < CYCLES; i += 1) {
    try {
      const result = await runCycle(i, buyer);
      report.results.push({ ok: true, ...result });
      console.log(`[gate] cycle=${i + 1} PASS round=${result.roundId}`);
    } catch (error) {
      report.ok = false;
      report.results.push({
        ok: false,
        cycle: i + 1,
        error: error instanceof Error ? error.message : String(error),
        keeperDiagnostics: Array.isArray(error?.keeperDiagnostics) ? error.keeperDiagnostics : [],
      });
      console.error(`[gate] cycle=${i + 1} FAIL ${error instanceof Error ? error.message : String(error)}`);
      if (!CONTINUE_ON_FAIL) break;
    }
  }

  const file = path.resolve(REPORT_DIR, `protocol-gate-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[gate] report=${file}`);
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
