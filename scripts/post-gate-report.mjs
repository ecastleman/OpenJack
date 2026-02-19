import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnvLocal } from "./env-local.mjs";

loadEnvLocal();

const ROOT = process.cwd();
const REPORT_DIR = path.resolve(ROOT, "reports/protocol-gate");
const API_BASE = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const PROOF_MODE = process.env.OPENJACK_PROOF_MODE || "das";
const ASSET_RESOLVER_MODE = process.env.OPENJACK_ASSET_RESOLVER_MODE || "derived";
const STACK_SESSION_ID = process.env.OPENJACK_STACK_SESSION_ID || null;
const API_LOG_PATH = process.env.OPENJACK_API_LOG_PATH || "/tmp/openjack-api.log";
const KEEPER_LOG_PATH = process.env.OPENJACK_KEEPER_LOG_PATH || "/tmp/openjack-keeper.log";

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

async function getJson(pathname) {
  const res = await fetch(`${API_BASE}${pathname}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${pathname} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function runNpm(args, env = {}) {
  const result = spawnSync("npm", args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed with status=${result.status}`);
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

function parseRoundsFromReport(report) {
  return [...new Set((report.results || []).filter((r) => r?.ok === true).map((r) => Number(r.roundId || 0)).filter(Boolean))];
}

function extractLastJsonObject(text) {
  const input = String(text || "").trim();
  if (!input) return null;
  for (let i = input.lastIndexOf("{"); i >= 0; i = input.lastIndexOf("{", i - 1)) {
    const candidate = input.slice(i);
    try {
      return JSON.parse(candidate);
    } catch {
      // keep scanning
    }
  }
  return null;
}

async function main() {
  const reportPath = process.argv[2] ? path.resolve(process.argv[2]) : latestReportPath();
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const wallet = String(report?.buyer || "").trim();
  const rounds = parseRoundsFromReport(report);
  if (!wallet) throw new Error("report buyer wallet is missing");
  if (rounds.length === 0) throw new Error(`no successful rounds in report ${reportPath}`);

  await getJson("/health");

  console.log(`[post-gate] report=${reportPath}`);
  console.log(`[post-gate] rounds=${rounds.length} wallet=${wallet}`);

  const failures = [];
  for (const roundId of rounds) {
    console.log(`[post-gate] hydrate round=${roundId}`);
    try {
      runNpm(["run", "scanner"], {
        OPENJACK_SCAN_ROUND_ID: String(roundId),
        OPENJACK_SCANNER_MODE: "once",
        OPENJACK_SCANNER_CLAIMS_ONLY: "true",
        OPENJACK_PROOF_MODE: PROOF_MODE,
        OPENJACK_ASSET_RESOLVER_MODE: ASSET_RESOLVER_MODE,
      });
    } catch (error) {
      failures.push({
        stage: "hydrate",
        roundId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let claimSummary = null;
  try {
    const claimRun = runNpm(["run", "claim:gate-report", "--", reportPath]);
    claimSummary = extractLastJsonObject(claimRun.stdout);
  } catch (error) {
    failures.push({
      stage: "claim",
      roundId: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const verification = [];
  for (const roundId of rounds) {
    try {
      const verifyRun = runNpm(["run", "verify:claimed-round", "--", String(roundId), wallet]);
      const verifyJson = extractLastJsonObject(verifyRun.stdout);
      verification.push({
        roundId,
        verdict: String(verifyJson?.verdict || "UNKNOWN"),
      });
    } catch (error) {
      failures.push({
        stage: "verify",
        roundId,
        error: error instanceof Error ? error.message : String(error),
      });
      verification.push({
        roundId,
        verdict: "FAILED",
      });
    }
  }

  const claimedRounds = verification.filter((v) => v.verdict === "CLAIMED").length;
  const summary = {
    generatedAt: new Date().toISOString(),
    stackSessionId: STACK_SESSION_ID,
    sourceReportPath: reportPath,
    apiLogPath: API_LOG_PATH,
    keeperLogPath: KEEPER_LOG_PATH,
    roundsProcessed: rounds,
    roundsClaimed: claimedRounds,
    totalLamportsClaimed: Number(claimSummary?.claimedLamports || 0),
    claimedCount: Number(claimSummary?.claimedCount || 0),
    failures,
  };
  const summaryPath = path.resolve(
    REPORT_DIR,
    `protocol-gate-post-summary-${Date.now()}.json`,
  );
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[post-gate] summary=${summaryPath}`);

  if (failures.length > 0) {
    throw new Error(`post-gate encountered ${failures.length} failure(s)`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
