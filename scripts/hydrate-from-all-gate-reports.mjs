import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const REPORT_DIR = path.resolve(ROOT, "reports/protocol-gate");
const API_BASE = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const PROGRAM_ID = process.env.OPENJACK_PROGRAM_ID || "Cnraeedx3R74G42eLHBz1rTbSwCQt62C2RC7iaejWSW3";
const INGEST_API_KEY = process.env.INGEST_API_KEY || "dev-ingest-key";
const PROOF_MODE = process.env.OPENJACK_PROOF_MODE || "das";
const ASSET_RESOLVER_MODE = process.env.OPENJACK_ASSET_RESOLVER_MODE || "derived";

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
    for (const result of report?.results || []) {
      if (result?.ok !== true) continue;
      const roundId = Number(result?.roundId || 0);
      if (!roundId) continue;
      if (!byRound.has(roundId)) {
        byRound.set(roundId, { roundId, sourceReports: [reportPath] });
      } else {
        byRound.get(roundId).sourceReports.push(reportPath);
      }
    }
  }
  return [...byRound.values()].sort((a, b) => a.roundId - b.roundId);
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
    throw new Error("OPENJACK_DAS_RPC_URL (or RPC_URL) is required for hydrate:gate-all when OPENJACK_PROOF_MODE=das");
  }

  console.log(
    `[hydrate-all] reports_scanned=${reports.length} unique_successful_rounds=${rounds.length} proof_mode=${PROOF_MODE}`,
  );

  const results = [];
  for (const { roundId } of rounds) {
    const run = runHydrateRound(roundId);
    const combined = `${run.stdout}\n${run.stderr}`;
    if (!run.ok) {
      const brief = combined.split("\n").slice(-8).join("\n");
      console.log(`[hydrate] round=${roundId} FAIL\n${brief}`);
      results.push({ roundId, ok: false, error: brief });
      continue;
    }
    const summary = parseHydrationSummary(run.stdout);
    const candidates = Array.isArray(summary?.claimCandidates) ? summary.claimCandidates.length : null;
    console.log(`[hydrate] round=${roundId} PASS claimCandidates=${candidates ?? "unknown"}`);
    results.push({ roundId, ok: true, claimCandidates: candidates });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    reportsScanned: reports.length,
    roundsTotal: rounds.length,
    roundsPassed: results.filter((r) => r.ok).length,
    roundsFailed: results.filter((r) => !r.ok).length,
    results,
  };
  const outPath = path.resolve(REPORT_DIR, `protocol-gate-all-hydrate-${Date.now()}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`[hydrate-all] report=${outPath}`);
  if (out.roundsFailed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
