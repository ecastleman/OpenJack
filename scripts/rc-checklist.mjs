import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const { Connection } = scannerRequire("@solana/web3.js");

const API_BASE = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const REPORT_DIR = process.env.OPENJACK_GATE_REPORT_DIR || path.resolve(process.cwd(), "reports/protocol-gate");
const explicitReport = process.argv[2] || "";

function latestReportFile(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^protocol-gate-\d+\.json$/.test(f))
    .sort();
  if (!files.length) return null;
  return path.resolve(dir, files[files.length - 1]);
}

async function getJson(pathname) {
  const res = await fetch(`${API_BASE}${pathname}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${pathname} failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

function pass(name, detail) {
  console.log(`PASS  ${name} - ${detail}`);
  return true;
}

function fail(name, detail) {
  console.log(`FAIL  ${name} - ${detail}`);
  return false;
}

function warn(name, detail) {
  console.log(`WARN  ${name} - ${detail}`);
  return true;
}

async function main() {
  const reportPath = explicitReport || latestReportFile(REPORT_DIR);
  if (!reportPath || !fs.existsSync(reportPath)) {
    throw new Error(`No protocol gate report found in ${REPORT_DIR}. Provide a path: npm run rc:checklist -- <report.json>`);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const successful = (report.results || []).filter((r) => r && r.ok && r.roundId);
  if (!successful.length) {
    throw new Error(`No successful cycles in report: ${reportPath}`);
  }

  console.log(`RC checklist report=${reportPath}`);
  console.log(`profile=${report.profile} cycles=${report.cycles} successful=${successful.length}`);

  const conn = new Connection(RPC_URL, "confirmed");
  let allOk = true;

  for (const cycle of successful) {
    const roundId = Number(cycle.roundId);
    console.log(`\nRound ${roundId}`);
    const roundResp = await getJson(`/rounds/${roundId}`);
    const rootsResp = await getJson(`/rounds/${roundId}/roots`);
    const ingestionResp = await getJson(`/rounds/${roundId}/ingestion`);
    const claimResp = await getJson(`/claims/estimate?roundId=${roundId}&wallet=${report.buyer}`);

    const round = roundResp.round || {};
    const roots = Array.isArray(rootsResp.roots) ? rootsResp.roots : [];
    const ingestion = ingestionResp.ingestionState || {};
    const snapshot = ingestionResp.snapshot || {};

    allOk = (String(round.status || "").toUpperCase() === "FINALIZED"
      ? pass("round_lifecycle", "finalized")
      : fail("round_lifecycle", `status=${round.status}`)) && allOk;

    const publishedRoots = roots.filter((r) => Boolean(r.published));
    allOk = (publishedRoots.length === 6
      ? pass("roots_published", "6/6 tiers")
      : fail("roots_published", `${publishedRoots.length}/6 tiers`)) && allOk;

    const commitmentSet = new Set(roots.map((r) => String(r.commitmentHash || "")));
    allOk = (commitmentSet.size === 1
      ? pass("roots_commitment", "single round commitment hash")
      : fail("roots_commitment", `mismatch hashes=${commitmentSet.size}`)) && allOk;

    const winnerTotal = roots.reduce((acc, r) => acc + Number(r.winnerCount || 0), 0);
    allOk = (winnerTotal > 0
      ? pass("winner_counts", `total_winners=${winnerTotal}`)
      : fail("winner_counts", "no winners counted")) && allOk;

    const parityOk = Number(ingestion.ledgerTicketCount || 0) === Number(ingestion.onchainTicketCount || 0);
    allOk = (ingestion.sealed && parityOk
      ? pass("ingestion_seal", `sealed rows=${snapshot.rowCount || 0}`)
      : fail(
          "ingestion_seal",
          `sealed=${Boolean(ingestion.sealed)} parity=${Number(ingestion.ledgerTicketCount || 0)}/${Number(
            ingestion.onchainTicketCount || 0,
          )}`,
        )) && allOk;

    const beforeLamports = Number(cycle.claimEstimatedBefore || 0);
    const afterLamports = Number(claimResp.estimatedLamports || 0);
    allOk = (beforeLamports > 0
      ? pass("claim_estimate_before", `estimated=${beforeLamports}`)
      : fail("claim_estimate_before", `estimated=${beforeLamports}`)) && allOk;

    const claimSigs = Array.isArray(cycle.claimed) ? cycle.claimed.map((c) => c.sig).filter(Boolean) : [];
    if (!claimSigs.length) {
      allOk = fail("claim_execution", "no claim signatures in gate report") && allOk;
    } else {
      const statuses = await conn.getSignatureStatuses(claimSigs, { searchTransactionHistory: true });
      const bad = (statuses.value || []).filter((v) => !v || v.err);
      allOk = (bad.length === 0
        ? pass("claim_execution", `confirmed=${claimSigs.length}`)
        : fail("claim_execution", `failed=${bad.length}/${claimSigs.length}`)) && allOk;
    }

    if (Number(claimResp.estimatedLamports || 0) === 0 && Array.isArray(claimResp.tickets) && claimResp.tickets.length === 0) {
      pass("post_claim_zero", "estimated=0 tickets=0");
    } else {
      allOk = fail(
        "post_claim_zero",
        `estimated=${Number(claimResp.estimatedLamports || 0)} tickets=${Array.isArray(claimResp.tickets) ? claimResp.tickets.length : -1}`,
      ) && allOk;
    }
  }

  console.log(`\nRC_RESULT=${allOk ? "PASS" : "FAIL"}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

