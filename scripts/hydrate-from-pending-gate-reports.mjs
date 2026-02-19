import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnvLocal } from "./env-local.mjs";

loadEnvLocal();

const ROOT = process.cwd();
const REPORT_DIR = path.resolve(ROOT, "reports/protocol-gate");
const API_BASE = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const PROGRAM_ID = process.env.OPENJACK_PROGRAM_ID || "Cnraeedx3R74G42eLHBz1rTbSwCQt62C2RC7iaejWSW3";
const INGEST_API_KEY = process.env.INGEST_API_KEY || "dev-ingest-key";
const PROOF_MODE = process.env.OPENJACK_PROOF_MODE || "das";
const ASSET_RESOLVER_MODE = process.env.OPENJACK_ASSET_RESOLVER_MODE || "derived";
const ALLOW_FAILED = String(process.env.OPENJACK_HYDRATE_ALLOW_FAILED || "false").toLowerCase() === "true";
const INCLUDE_CLAIMED = String(process.env.OPENJACK_HYDRATE_INCLUDE_CLAIMED || "false").toLowerCase() === "true";

function listGateReports() {
  if (!fs.existsSync(REPORT_DIR)) return [];
  return fs
    .readdirSync(REPORT_DIR)
    .filter((name) => name.startsWith("protocol-gate-") && name.endsWith(".json"))
    .map((name) => path.resolve(REPORT_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function collectRoundsFromReports(reportPaths) {
  const byRound = new Map();
  for (const reportPath of reportPaths) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch {
      continue;
    }
    const buyer = String(report?.buyer || "");
    for (const result of report?.results || []) {
      if (result?.ok !== true) continue;
      const roundId = Number(result?.roundId || 0);
      if (!roundId) continue;
      if (!byRound.has(roundId)) {
        byRound.set(roundId, { roundId, buyer, sourceReports: [reportPath] });
      } else {
        const entry = byRound.get(roundId);
        entry.sourceReports.push(reportPath);
        if (!entry.buyer && buyer) entry.buyer = buyer;
      }
    }
  }
  return [...byRound.values()].sort((a, b) => a.roundId - b.roundId);
}

async function getJson(pathname) {
  const res = await fetch(`${API_BASE}${pathname}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GET ${pathname} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function runHydrateRound(roundId) {
  const env = {
    ...process.env,
    OPENJACK_SCAN_ROUND_ID: String(roundId),
    OPENJACK_SCANNER_MODE: "once",
    OPENJACK_SCANNER_CLAIMS_ONLY: "true",
    OPENJACK_PROOF_MODE: PROOF_MODE,
    OPENJACK_ASSET_RESOLVER_MODE: ASSET_RESOLVER_MODE,
    OPENJACK_API_BASE: API_BASE,
    OPENJACK_PROGRAM_ID: PROGRAM_ID,
    INGEST_API_KEY,
  };
  const result = spawnSync("npm", ["run", "scanner"], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function parseHydrationSummary(output) {
  const text = String(output || "");
  const jsonStart = text.lastIndexOf("\n{");
  if (jsonStart >= 0) {
    try {
      return JSON.parse(text.slice(jsonStart + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

function summarizeProofStatuses(summary) {
  const tickets = Array.isArray(summary?.claimCandidates) ? summary.claimCandidates : [];
  let ready = 0;
  let pending = 0;
  let failed = 0;
  for (const ticket of tickets) {
    const status = String(ticket?.proofStatus || "").toUpperCase();
    if (status === "READY") {
      ready += 1;
    } else if (status === "FAILED") {
      failed += 1;
    } else {
      pending += 1;
    }
  }
  return {
    total: tickets.length,
    ready,
    pending,
    failed,
  };
}

function hasWinnerCandidates(estimate) {
  const tickets = Array.isArray(estimate?.tickets) ? estimate.tickets : [];
  return tickets.some((t) => Number(t?.amount || 0) > 0);
}

function isAlreadyClaimedForWallet(estimate) {
  const tickets = Array.isArray(estimate?.tickets) ? estimate.tickets : [];
  const potential = Number(estimate?.potentialLamports || 0);
  return tickets.length === 0 && potential === 0;
}

function chooseAction({ hydration, estimate, includeClaimed }) {
  const counts = hydration?.counts || {};
  const pending = Number(counts.pendingProof || 0);
  const failed = Number(counts.failed || 0);
  const total = Number(counts.total || 0);
  const hasWinners = hasWinnerCandidates(estimate);
  const alreadyClaimed = isAlreadyClaimedForWallet(estimate);

  if (!hasWinners) {
    if (!includeClaimed && alreadyClaimed) return { hydrate: false, reason: "already_claimed_or_no_winners" };
    return { hydrate: false, reason: "no_winner_candidates" };
  }
  if (pending > 0 || failed > 0) return { hydrate: true, reason: "pending_or_failed_proofs" };
  if (total === 0) return { hydrate: true, reason: "unhydrated_winner_candidates" };
  return { hydrate: false, reason: "already_hydrated" };
}

async function main() {
  const reports = listGateReports();
  if (reports.length === 0) {
    throw new Error(`no protocol gate reports found in ${REPORT_DIR}`);
  }
  const rounds = collectRoundsFromReports(reports);
  if (rounds.length === 0) {
    throw new Error("no successful rounds found across protocol gate reports");
  }

  if (PROOF_MODE === "das" && !process.env.OPENJACK_DAS_RPC_URL && !process.env.RPC_URL) {
    throw new Error("OPENJACK_DAS_RPC_URL (or RPC_URL) is required for hydrate:gate-pending when OPENJACK_PROOF_MODE=das");
  }

  console.log(
    `[hydrate-pending] reports_scanned=${reports.length} unique_successful_rounds=${rounds.length} proof_mode=${PROOF_MODE} allow_failed=${ALLOW_FAILED} include_claimed=${INCLUDE_CLAIMED}`,
  );

  const decisions = [];
  for (const { roundId, buyer } of rounds) {
    const hydration = await getJson(`/rounds/${roundId}/hydration`).catch(() => ({ roundId, counts: { pendingProof: 0, hydrated: 0, failed: 0, total: 0 } }));
    const estimate = buyer
      ? await getJson(`/claims/estimate?roundId=${roundId}&wallet=${buyer}`).catch(() => ({ tickets: [], potentialLamports: 0 }))
      : { tickets: [], potentialLamports: 0 };
    const action = chooseAction({ hydration, estimate, includeClaimed: INCLUDE_CLAIMED });
    decisions.push({ roundId, buyer, hydration, action });
  }

  const actionable = decisions.filter((d) => d.action.hydrate);
  const skipped = decisions.filter((d) => !d.action.hydrate);
  console.log(
    `[hydrate-pending] actionable_rounds=${actionable.length} skipped_rounds=${skipped.length}`,
  );

  const results = [];
  for (const row of actionable) {
    const { roundId, action } = row;
    const run = runHydrateRound(roundId);
    const combined = `${run.stdout}\n${run.stderr}`;
    if (!run.ok) {
      const brief = combined.split("\n").slice(-8).join("\n");
      console.log(`[hydrate] round=${roundId} FAIL reason=${action.reason}\n${brief}`);
      results.push({ roundId, ok: false, reason: action.reason, error: brief });
      continue;
    }
    const summary = parseHydrationSummary(run.stdout);
    const proof = summarizeProofStatuses(summary);
    const hardFail = proof.failed > 0 && !ALLOW_FAILED;
    const tag = hardFail ? "FAIL" : proof.failed > 0 ? "WARN" : "PASS";
    console.log(
      `[hydrate] round=${roundId} ${tag} reason=${action.reason} claimCandidates=${proof.total} ready=${proof.ready} pending=${proof.pending} failed=${proof.failed}`,
    );
    results.push({
      roundId,
      ok: !hardFail,
      reason: action.reason,
      hydration: proof,
      proofFailed: proof.failed > 0,
      skippedByFlag: proof.failed > 0 && ALLOW_FAILED,
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    reportsScanned: reports.length,
    roundsTotal: rounds.length,
    actionableRounds: actionable.length,
    skippedRounds: skipped.map((s) => ({ roundId: s.roundId, reason: s.action.reason })),
    roundsPassed: results.filter((r) => r.ok).length,
    roundsFailed: results.filter((r) => !r.ok).length,
    roundsWithFailedProofs: results.filter((r) => r.proofFailed).length,
    results,
  };
  const outPath = path.resolve(REPORT_DIR, `protocol-gate-pending-hydrate-${Date.now()}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`[hydrate-pending] report=${outPath}`);
  if (out.roundsFailed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

