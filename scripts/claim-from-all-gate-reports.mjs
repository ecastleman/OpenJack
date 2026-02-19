import fs from "node:fs";
import path from "node:path";
import { loadEnvLocal } from "./env-local.mjs";

loadEnvLocal();

const ROOT = process.cwd();
const REPORT_DIR = path.resolve(ROOT, "reports/protocol-gate");
const API_BASE = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");

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
        byRound.get(roundId).sourceReports.push(reportPath);
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

async function main() {
  const reports = listGateReports();
  if (reports.length === 0) {
    throw new Error(`no protocol gate reports found in ${REPORT_DIR}`);
  }
  const rounds = collectRoundsFromReports(reports);
  if (rounds.length === 0) {
    throw new Error("no successful rounds found across protocol gate reports");
  }

  // Reuse existing single-report claimer by generating a synthetic report of unique rounds.
  const syntheticReportPath = path.resolve(
    REPORT_DIR,
    `protocol-gate-all-claim-input-${Date.now()}.json`,
  );
  const buyer = rounds.find((r) => r.buyer)?.buyer || "";
  const synthetic = {
    generatedAt: new Date().toISOString(),
    source: "claim-from-all-gate-reports",
    buyer,
    results: rounds.map((r) => ({ ok: true, roundId: r.roundId })),
  };
  fs.writeFileSync(syntheticReportPath, `${JSON.stringify(synthetic, null, 2)}\n`, "utf8");

  console.log(`[claim-all] reports_scanned=${reports.length} unique_successful_rounds=${rounds.length}`);
  console.log(`[claim-all] synthetic_report=${syntheticReportPath}`);

  // Execute existing claim flow.
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("npm", ["run", "claim:gate-report", "--", syntheticReportPath], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  // Optional quick summary ping for one round to confirm API is reachable.
  const first = rounds[0];
  if (first?.buyer) {
    const estimate = await getJson(`/claims/estimate?roundId=${first.roundId}&wallet=${first.buyer}`);
    console.log(
      `[claim-all] sample_post_state round=${first.roundId} estimated=${Number(estimate.estimatedLamports || 0)} claimableTickets=${Number(estimate.claimableTickets || 0)}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
