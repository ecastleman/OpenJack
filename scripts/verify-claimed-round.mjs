import fs from "node:fs";
import path from "node:path";
import { loadEnvLocal } from "./env-local.mjs";

loadEnvLocal();

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: node scripts/verify-claimed-round.mjs <roundId> <wallet>");
  process.exit(1);
}

const roundId = Number(args[0]);
const wallet = String(args[1] || "").trim();
if (!roundId || !wallet) {
  console.error("invalid args: roundId and wallet are required");
  process.exit(1);
}

const apiBase = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function classify({ hydration, estimate }) {
  const roundStatus = Number(estimate?.roundStatus || 0);
  const tickets = Array.isArray(estimate?.tickets) ? estimate.tickets : [];
  const claimable = Number(estimate?.claimableTickets || 0);
  const potential = Number(estimate?.potentialLamports || 0);

  const h = hydration?.counts || {};
  const hydrated = Number(h.hydrated || 0);
  const failed = Number(h.failed || 0);
  const pending = Number(h.pendingProof || 0);
  const total = Number(h.total || 0);

  if (roundStatus !== 4) {
    return "NOT_FINALIZED";
  }
  // API estimate is the source of truth for wallet-claimability state.
  if (claimable === 0 && tickets.length === 0 && potential === 0) {
    return "CLAIMED";
  }
  if (claimable > 0) {
    return "CLAIMABLE";
  }
  if (failed > 0) {
    return "PROOF_FAILED";
  }
  if (pending > 0) {
    return "PENDING_PROOF";
  }
  if (total > 0 && hydrated > 0 && tickets.length === 0 && potential === 0) {
    return "CLAIMED";
  }
  if (total === 0) {
    return "NO_WINNERS_OBSERVED";
  }
  return "UNKNOWN";
}

async function main() {
  const hydration = await fetchJson(`${apiBase}/rounds/${roundId}/hydration`);
  const estimate = await fetchJson(
    `${apiBase}/claims/estimate?roundId=${roundId}&wallet=${encodeURIComponent(wallet)}`,
  );

  const verdict = classify({ hydration, estimate });
  const out = {
    roundId,
    wallet,
    verdict,
    roundStatus: Number(estimate?.roundStatus || 0),
    claimableTickets: Number(estimate?.claimableTickets || 0),
    potentialLamports: Number(estimate?.potentialLamports || 0),
    estimateTickets: Array.isArray(estimate?.tickets) ? estimate.tickets.length : 0,
    hydration,
  };

  const writePath = process.env.OPENJACK_VERIFY_WRITE_JSON || "";
  if (writePath) {
    const resolved = path.resolve(process.cwd(), writePath);
    fs.writeFileSync(resolved, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    console.log(`[verify-round] wrote=${resolved}`);
  }

  console.log(JSON.stringify(out, null, 2));

  if (verdict === "PROOF_FAILED" || verdict === "UNKNOWN") {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
