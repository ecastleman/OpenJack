import { spawnSync } from "node:child_process";

const roundId = Number(process.argv[2] || 0);
if (!roundId) {
  console.error("usage: node scripts/rehydrate-failed-round.mjs <roundId>");
  process.exit(1);
}

const dbUrl = process.env.SCANNER_DATABASE_URL || process.env.DATABASE_URL || "postgres://localhost:5432/openjack";
const apiBase = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const ingestKey = process.env.INGEST_API_KEY || "dev-ingest-key";
const programId = process.env.OPENJACK_PROGRAM_ID || "";
const proofMode = (process.env.OPENJACK_PROOF_MODE || "das").toLowerCase();
const assetResolverMode = (process.env.OPENJACK_ASSET_RESOLVER_MODE || "derived").toLowerCase();

function runPsql(sql) {
  const child = spawnSync("psql", [dbUrl, "-t", "-A", "-c", sql], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (child.status !== 0) {
    const out = `${child.stdout || ""}\n${child.stderr || ""}`.trim();
    if (/relation\s+"scanner_proof_hydration"\s+does not exist/i.test(out)) {
      throw new Error(
        "scanner_proof_hydration table is missing; run scanner schema migration first (e.g. scanner once or psql services/scanner/data/schema.sql)",
      );
    }
    throw new Error(out || `psql failed with status=${child.status}`);
  }
  return String(child.stdout || "").trim();
}

function resetFailedRows() {
  const sql = `
    WITH updated AS (
      UPDATE scanner_proof_hydration
      SET status = 'pending',
          attempt_count = 0,
          last_error = NULL,
          first_attempt_at = NULL,
          last_attempt_at = NULL,
          updated_at = now()
      WHERE round_id = ${roundId} AND status = 'failed'
      RETURNING 1
    )
    SELECT COUNT(*)::int FROM updated;
  `;
  const out = runPsql(sql);
  return Number(out || 0);
}

function runScannerHydrationPass() {
  const env = {
    ...process.env,
    OPENJACK_SCAN_ROUND_ID: String(roundId),
    OPENJACK_SCANNER_MODE: "once",
    OPENJACK_SCANNER_CLAIMS_ONLY: "true",
    OPENJACK_PROOF_MODE: proofMode,
    OPENJACK_ASSET_RESOLVER_MODE: assetResolverMode,
    OPENJACK_API_BASE: apiBase,
    OPENJACK_PROGRAM_ID: programId,
    INGEST_API_KEY: ingestKey,
  };

  const child = spawnSync("npm", ["run", "scanner"], {
    env,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (child.status !== 0) {
    const out = `${child.stdout || ""}\n${child.stderr || ""}`.trim();
    throw new Error(out || `scanner failed with status=${child.status}`);
  }
}

async function main() {
  if (proofMode !== "das") {
    console.warn(`[rehydrate] warning: OPENJACK_PROOF_MODE=${proofMode}; usually this command is run with OPENJACK_PROOF_MODE=das`);
  }
  const resetCount = resetFailedRows();
  console.log(`[rehydrate] round=${roundId} reset_failed_rows=${resetCount}`);
  runScannerHydrationPass();
  console.log(`[rehydrate] round=${roundId} hydration pass complete`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
