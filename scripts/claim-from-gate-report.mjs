import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnvLocal } from "./env-local.mjs";
import { confirmSignatureByPolling } from "./lib/confirm-signature-status.mjs";

loadEnvLocal();

const ROOT = process.cwd();
const REPORT_DIR = path.resolve(ROOT, "reports/protocol-gate");
const API_BASE = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const BUYER_KEYPAIR_PATH =
  process.env.OPENJACK_GATE_BUYER_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");

const scannerPkgJson = path.resolve(ROOT, "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const { Keypair, Transaction, Connection } = scannerRequire("@solana/web3.js");

function latestReportPath() {
  const files = fs
    .readdirSync(REPORT_DIR)
    .filter((name) => name.startsWith("protocol-gate-") && name.endsWith(".json"))
    .map((name) => path.resolve(REPORT_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) {
    throw new Error(`no protocol gate reports found in ${REPORT_DIR}`);
  }
  return files[0];
}

function readKeypair(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function getJson(pathname) {
  const res = await fetch(`${API_BASE}${pathname}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GET ${pathname} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function postJson(pathname, payload) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`POST ${pathname} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function signAndSend(unsignedTxBase64, buyer) {
  const connection = new Connection(RPC_URL, "confirmed");
  const decoded = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: buyer.publicKey,
    blockhash: latest.blockhash,
  });
  tx.recentBlockhash = latest.blockhash;
  for (const ix of decoded.instructions) tx.add(ix);
  tx.sign(buyer);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });
  await confirmSignatureByPolling(connection, sig);
  return sig;
}

function parseRoundsFromReport(report) {
  const rounds = [];
  for (const result of report.results || []) {
    if (result?.ok !== true) continue;
    const roundId = Number(result.roundId || 0);
    if (!roundId) continue;
    rounds.push(roundId);
  }
  return [...new Set(rounds)];
}

async function claimRound(roundId, wallet, buyer) {
  const estimate = await getJson(`/claims/estimate?roundId=${roundId}&wallet=${wallet}`);
  const claimableTickets = (estimate.tickets || []).filter((t) => t?.claimable === true);
  const pendingProofTickets = (estimate.tickets || []).filter(
    (t) =>
      Number(t?.amount || 0) > 0 &&
      t?.claimable !== true &&
      Array.isArray(t?.readinessReasons) &&
      t.readinessReasons.includes("PENDING_PROOF"),
  );
  if (claimableTickets.length === 0) {
    return {
      roundId,
      claimableTickets: 0,
      pendingProofTickets: pendingProofTickets.length,
      claimed: [],
      skippedReason: "no_claimable_tickets",
    };
  }

  const claimed = [];
  const failed = [];
  for (const ticket of claimableTickets) {
    try {
      const normalized = {
        ...ticket,
        ownershipProof: {
          ...(ticket.ownershipProof || {}),
          owner: wallet,
        },
      };
      const prepared = await postJson("/tx/prepare/claim", {
        wallet,
        roundId,
        payload: normalized,
      });
      const sig = await signAndSend(prepared.unsignedTxBase64, buyer);
      claimed.push({
        leafIndex: Number(ticket.leafIndex),
        tier: Number(ticket.tier),
        amount: Number(ticket.amount || 0),
        sig,
      });
    } catch (error) {
      failed.push({
        leafIndex: Number(ticket.leafIndex),
        tier: Number(ticket.tier),
        amount: Number(ticket.amount || 0),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    roundId,
    claimableTickets: claimableTickets.length,
    pendingProofTickets: pendingProofTickets.length,
    claimed,
    failed,
  };
}

async function main() {
  const reportPath = process.argv[2] ? path.resolve(process.argv[2]) : latestReportPath();
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const buyer = readKeypair(BUYER_KEYPAIR_PATH);
  const wallet = report.buyer || buyer.publicKey.toBase58();
  const rounds = parseRoundsFromReport(report);
  if (rounds.length === 0) {
    throw new Error(`no successful rounds in report ${reportPath}`);
  }

  const summary = [];
  for (const roundId of rounds) {
    const row = await claimRound(roundId, wallet, buyer);
    summary.push(row);
    console.log(
      `[claim] round=${roundId} claimable=${row.claimableTickets} pending_proof=${row.pendingProofTickets || 0} claimed=${row.claimed.length} failed=${Array.isArray(row.failed) ? row.failed.length : 0}`,
    );
  }

  const out = {
    reportPath,
    wallet,
    rounds: summary,
    claimedCount: summary.reduce((acc, s) => acc + s.claimed.length, 0),
    claimedLamports: summary.reduce(
      (acc, s) => acc + s.claimed.reduce((a, c) => a + Number(c.amount || 0), 0),
      0,
    ),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
