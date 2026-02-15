import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const API_BASE = (process.env.SMOKE_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const WALLET = process.env.SMOKE_WALLET || "11111111111111111111111111111111";
const ROUND_ID_OVERRIDE = process.env.SMOKE_ROUND_ID ? Number(process.env.SMOKE_ROUND_ID) : null;
const REPORT_DIR = process.env.SMOKE_REPORT_DIR || path.resolve(process.cwd(), "reports/seeker");
const WRITE_REPORT = process.env.SMOKE_WRITE_REPORT === "true" || process.argv.includes("--report");

const checks = [];
const warnings = [];
let context = {
  roundId: null,
  rootsCount: 0,
  claimTickets: 0,
  buyPrepared: false,
  claimPrepared: false,
};

function addCheck(name, ok, details, fatal = true) {
  checks.push({ name, ok, details, fatal });
}

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function postJson(path, payload) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

function firstClaimTicket(claim) {
  if (!Array.isArray(claim?.tickets) || claim.tickets.length === 0) return null;
  return claim.tickets.find((t) => Number(t.amount || 0) > 0) || claim.tickets[0];
}

async function loadScannerPublishContext(roundId) {
  try {
    const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
    const scannerRequire = createRequire(scannerPkgJson);
    const { Pool } = scannerRequire("pg");
    const connectionString =
      process.env.SCANNER_DATABASE_URL ||
      process.env.DATABASE_URL ||
      "postgres://localhost:5432/openjack";
    const pool = new Pool({ connectionString });
    try {
      const published = await pool.query(
        `
        SELECT tier, tx_signature, status, published_at
        FROM scanner_root_publishes
        WHERE round_id = $1
        ORDER BY published_at DESC NULLS LAST, updated_at DESC
        LIMIT 20
        `,
        [roundId],
      );
      const deadLetters = await pool.query(
        `
        SELECT status, count(*)::int AS count
        FROM scanner_publish_dead_letters
        WHERE round_id = $1
        GROUP BY status
        ORDER BY status ASC
        `,
        [roundId],
      );
      return {
        publishRows: published.rows,
        deadLetters: deadLetters.rows,
      };
    } finally {
      await pool.end();
    }
  } catch (error) {
    warnings.push(
      `scanner_publish_context_unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { publishRows: [], deadLetters: [] };
  }
}

function writeReport(report) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(REPORT_DIR, `seeker-smoke-${ts}.json`);
  const mdPath = path.join(REPORT_DIR, `seeker-smoke-${ts}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const lines = [];
  lines.push(`# Seeker Smoke Report`);
  lines.push(`- generated_at: ${report.generatedAt}`);
  lines.push(`- api_base: ${report.apiBase}`);
  lines.push(`- round_id: ${report.roundId ?? "n/a"}`);
  lines.push(`- wallet: ${report.wallet}`);
  lines.push(``);
  lines.push(`## Checks`);
  for (const c of report.checks) {
    const status = c.ok ? "PASS" : c.fatal ? "FAIL" : "WARN";
    lines.push(`- ${status} ${c.name}: ${c.details}`);
  }
  lines.push(``);
  lines.push(`## Scanner Publish Rows`);
  if (report.scanner.publishRows.length === 0) {
    lines.push(`- none`);
  } else {
    for (const row of report.scanner.publishRows) {
      lines.push(
        `- tier=${row.tier} status=${row.status} sig=${row.tx_signature || "n/a"} published_at=${row.published_at || "n/a"}`,
      );
    }
  }
  lines.push(``);
  lines.push(`## Dead Letters`);
  if (report.scanner.deadLetters.length === 0) {
    lines.push(`- none`);
  } else {
    for (const row of report.scanner.deadLetters) {
      lines.push(`- status=${row.status} count=${row.count}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push(``);
    lines.push(`## Warnings`);
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  fs.writeFileSync(mdPath, `${lines.join("\n")}\n`);
  return { jsonPath, mdPath };
}

async function run() {
  try {
    const health = await getJson("/health");
    addCheck(
      "api_health",
      health.res.ok && health.body?.ok === true,
      health.res.ok ? "ok" : `status=${health.res.status}`,
    );

    const activeRoundResp = await getJson("/rounds/active");
    const activeRound = activeRoundResp.body?.round || null;
    const roundId = ROUND_ID_OVERRIDE || Number(activeRound?.roundId || 0);
    context.roundId = roundId || null;
    addCheck(
      "active_round",
      Boolean(roundId),
      roundId ? `roundId=${roundId}` : "no active round and SMOKE_ROUND_ID not set",
    );

    if (!roundId) {
      const report = await buildReport();
      printSummary(report);
      process.exit(1);
      return;
    }

    const rootsResp = await getJson(`/rounds/${roundId}/roots`);
    const rootsCount = Array.isArray(rootsResp.body?.roots) ? rootsResp.body.roots.length : 0;
    context.rootsCount = rootsCount;
    addCheck(
      "roots_visible",
      rootsResp.res.ok,
      rootsResp.res.ok ? `roots=${rootsCount}` : `status=${rootsResp.res.status}`,
      false,
    );

    const claimResp = await getJson(`/claims/estimate?roundId=${roundId}&wallet=${WALLET}`);
    const claimTicketCount = Array.isArray(claimResp.body?.tickets) ? claimResp.body.tickets.length : 0;
    context.claimTickets = claimTicketCount;
    addCheck(
      "claim_estimate",
      claimResp.res.ok,
      claimResp.res.ok ? `tickets=${claimTicketCount}` : `status=${claimResp.res.status}`,
      false,
    );

    const buyResp = await postJson("/tx/prepare/buy", {
      wallet: WALLET,
      roundId,
      payload: {
        tickets: [{ main: [1, 2, 3, 4, 5], bonus: 1 }],
        oraclePriceMicroUsdPerSol: 20_000_000,
        oraclePublishTs: Math.floor(Date.now() / 1000),
      },
    });
    const buyPrepared = buyResp.res.ok && typeof buyResp.body?.unsignedTxBase64 === "string";
    context.buyPrepared = buyPrepared;
    addCheck(
      "prepare_buy_tx",
      buyPrepared,
      buyPrepared ? "unsigned tx prepared" : `status=${buyResp.res.status}`,
    );

    const claimTicket = firstClaimTicket(claimResp.body);
    if (!claimTicket) {
      addCheck("prepare_claim_tx", false, "no claim tickets available", false);
    } else {
      const claimPrepareResp = await postJson("/tx/prepare/claim", {
        wallet: WALLET,
        roundId,
        payload: claimTicket,
      });
      const claimPrepared =
        claimPrepareResp.res.ok && typeof claimPrepareResp.body?.unsignedTxBase64 === "string";
      context.claimPrepared = claimPrepared;
      addCheck(
        "prepare_claim_tx",
        claimPrepared,
        claimPrepared ? `leaf=${claimTicket.leafIndex} tier=${claimTicket.tier}` : `status=${claimPrepareResp.res.status}`,
        false,
      );
    }
  } catch (error) {
    addCheck("smoke_runner", false, error instanceof Error ? error.message : String(error));
  }

  const report = await buildReport();
  printSummary(report);
  const fatalFail = checks.some((c) => c.fatal && !c.ok);
  process.exit(fatalFail ? 1 : 0);
}

async function buildReport() {
  const scanner = context.roundId
    ? await loadScannerPublishContext(context.roundId)
    : { publishRows: [], deadLetters: [] };
  const report = {
    generatedAt: new Date().toISOString(),
    apiBase: API_BASE,
    wallet: WALLET,
    roundId: context.roundId,
    context,
    checks,
    warnings,
    scanner,
  };

  if (WRITE_REPORT) {
    const paths = writeReport(report);
    report.reportPaths = paths;
  }
  return report;
}

function printSummary(report) {
  console.log(`Seeker smoke check against ${API_BASE}`);
  for (const c of report.checks) {
    const status = c.ok ? "PASS" : c.fatal ? "FAIL" : "WARN";
    console.log(`${status.padEnd(5)} ${c.name} - ${c.details}`);
  }
  const sigs = (report.scanner.publishRows || [])
    .map((r) => r.tx_signature)
    .filter(Boolean)
    .slice(0, 5);
  if (sigs.length > 0) {
    console.log(`INFO  recent_root_publish_signatures - ${sigs.join(", ")}`);
  }
  const dl = report.scanner.deadLetters || [];
  if (dl.length > 0) {
    const text = dl.map((r) => `${r.status}:${r.count}`).join(", ");
    console.log(`INFO  dead_letters - ${text}`);
  }
  if (report.reportPaths) {
    console.log(`INFO  report_json - ${report.reportPaths.jsonPath}`);
    console.log(`INFO  report_md - ${report.reportPaths.mdPath}`);
  }
  if (report.warnings.length > 0) {
    for (const w of report.warnings) {
      console.log(`WARN  ${w}`);
    }
  }
}

run();
