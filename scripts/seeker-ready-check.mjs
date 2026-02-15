import path from "node:path";
import { createRequire } from "node:module";

const API_BASE = (process.env.READY_API_BASE || process.env.SMOKE_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const WALLET = process.env.READY_WALLET || process.env.SMOKE_WALLET || "11111111111111111111111111111111";
const ROUND_ID_OVERRIDE = process.env.READY_ROUND_ID ? Number(process.env.READY_ROUND_ID) : null;
const STRICT = process.env.READY_STRICT === "true";

const checks = [];

function addCheck(name, ok, details, fatal = true) {
  checks.push({ name, ok, details, fatal });
}

async function getJson(pathname) {
  const res = await fetch(`${API_BASE}${pathname}`);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function postJson(pathname, payload) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

function findClaimTicket(claimEstimate) {
  const tickets = Array.isArray(claimEstimate?.tickets) ? claimEstimate.tickets : [];
  return tickets.find((t) => Number(t.amount || 0) > 0) || tickets[0] || null;
}

function getPg() {
  const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
  const req = createRequire(scannerPkgJson);
  return req("pg");
}

async function checkScannerDb(roundId) {
  try {
    const { Pool } = getPg();
    const connectionString =
      process.env.SCANNER_DATABASE_URL ||
      process.env.DATABASE_URL ||
      "postgres://localhost:5432/openjack";
    const pool = new Pool({ connectionString });
    try {
      const dead = await pool.query(
        `SELECT status, count(*)::int AS count FROM scanner_publish_dead_letters GROUP BY status ORDER BY status ASC`,
      );
      const roots = await pool.query(
        `SELECT count(*)::int AS count FROM scanner_root_publishes WHERE round_id = $1`,
        [roundId || 0],
      );
      const terminal = dead.rows.find((r) => r.status === "failed_terminal");
      const terminalCount = Number(terminal?.count || 0);
      addCheck(
        "scanner_dead_letters",
        terminalCount === 0,
        terminalCount === 0 ? "no terminal dead letters" : `failed_terminal=${terminalCount}`,
        false,
      );
      addCheck(
        "scanner_publish_rows",
        Number(roots.rows?.[0]?.count || 0) > 0,
        `rows_for_round=${Number(roots.rows?.[0]?.count || 0)}`,
        false,
      );
    } finally {
      await pool.end();
    }
  } catch (error) {
    addCheck(
      "scanner_db",
      false,
      `unavailable: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
}

async function run() {
  let roundId = ROUND_ID_OVERRIDE || 0;

  try {
    const health = await getJson("/health");
    addCheck(
      "api_health",
      health.res.ok && health.body?.ok === true,
      health.res.ok ? "ok" : `status=${health.res.status}`,
      true,
    );
  } catch (error) {
    addCheck("api_health", false, `fetch_failed: ${error instanceof Error ? error.message : String(error)}`, true);
    printSummary();
    process.exit(1);
    return;
  }

  const active = await getJson("/rounds/active");
  const activeRound = active.body?.round || null;
  roundId = roundId || Number(activeRound?.roundId || 0);
  addCheck(
    "active_round",
    Boolean(roundId),
    roundId ? `roundId=${roundId}` : "not found",
    true,
  );

  if (!roundId) {
    await checkScannerDb(roundId);
    printSummary();
    process.exit(1);
    return;
  }

  const roots = await getJson(`/rounds/${roundId}/roots`);
  const rootsCount = Array.isArray(roots.body?.roots) ? roots.body.roots.length : 0;
  addCheck(
    "roots_visible",
    roots.res.ok && rootsCount > 0,
    roots.res.ok ? `roots=${rootsCount}` : `status=${roots.res.status}`,
    !STRICT,
  );

  const claimEstimate = await getJson(`/claims/estimate?roundId=${roundId}&wallet=${WALLET}`);
  const claimTickets = Array.isArray(claimEstimate.body?.tickets) ? claimEstimate.body.tickets.length : 0;
  addCheck(
    "claim_estimate",
    claimEstimate.res.ok,
    claimEstimate.res.ok ? `tickets=${claimTickets}` : `status=${claimEstimate.res.status}`,
    !STRICT,
  );

  const buy = await postJson("/tx/prepare/buy", {
    wallet: WALLET,
    roundId,
    payload: {
      tickets: [{ main: [1, 2, 3, 4, 5], bonus: 1 }],
      oraclePriceMicroUsdPerSol: 20_000_000,
      oraclePublishTs: Math.floor(Date.now() / 1000),
    },
  });
  const buyOk = buy.res.ok && typeof buy.body?.unsignedTxBase64 === "string";
  addCheck(
    "prepare_buy_tx",
    buyOk,
    buyOk ? "unsigned tx prepared" : `status=${buy.res.status}`,
    true,
  );

  const ticket = findClaimTicket(claimEstimate.body);
  if (!ticket) {
    addCheck("prepare_claim_tx", false, "no claim tickets available", !STRICT);
  } else {
    const claim = await postJson("/tx/prepare/claim", {
      wallet: WALLET,
      roundId,
      payload: ticket,
    });
    const claimOk = claim.res.ok && typeof claim.body?.unsignedTxBase64 === "string";
    addCheck(
      "prepare_claim_tx",
      claimOk,
      claimOk ? `leaf=${ticket.leafIndex} tier=${ticket.tier}` : `status=${claim.res.status}`,
      !STRICT,
    );
  }

  await checkScannerDb(roundId);
  printSummary();

  const failed = checks.filter((c) => c.fatal && !c.ok);
  process.exit(failed.length > 0 ? 1 : 0);
}

function printSummary() {
  console.log(`Seeker readiness gate against ${API_BASE}`);
  for (const c of checks) {
    const status = c.ok ? "PASS" : c.fatal ? "FAIL" : "WARN";
    console.log(`${status.padEnd(5)} ${c.name} - ${c.details}`);
  }
  const failed = checks.filter((c) => c.fatal && !c.ok);
  if (failed.length === 0) {
    console.log("READY");
  } else {
    console.log("NOT_READY");
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
