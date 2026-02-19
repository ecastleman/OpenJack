import { spawnSync } from "node:child_process";

const retainDays = Math.max(1, Number(process.env.OPENJACK_PROOF_RETENTION_DAYS || 45));
const dryRun = String(process.env.OPENJACK_PROOF_CLEANUP_DRY_RUN || "true").toLowerCase() !== "false";
const dbUrl = process.env.SCANNER_DATABASE_URL || process.env.DATABASE_URL || "postgres://localhost:5432/openjack";

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

function main() {
  const ageExpr = `now() - interval '${retainDays} days'`;
  const countSql = `
    SELECT COUNT(*)::int
    FROM scanner_proof_hydration h
    JOIN rounds r ON r.round_id = h.round_id
    WHERE r.status = 'FINALIZED'
      AND h.updated_at < ${ageExpr};
  `;

  const eligible = Number(runPsql(countSql) || 0);
  console.log(`[proof-cleanup] retention_days=${retainDays} eligible_rows=${eligible} dry_run=${dryRun}`);

  if (dryRun || eligible === 0) return;

  const deleteSql = `
    WITH deleted AS (
      DELETE FROM scanner_proof_hydration h
      USING rounds r
      WHERE r.round_id = h.round_id
        AND r.status = 'FINALIZED'
        AND h.updated_at < ${ageExpr}
      RETURNING 1
    )
    SELECT COUNT(*)::int FROM deleted;
  `;

  const deleted = Number(runPsql(deleteSql) || 0);
  console.log(`[proof-cleanup] deleted_rows=${deleted}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
