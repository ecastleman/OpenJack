import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import {
  deriveConfigPda,
  deriveRoundPda,
  getScannerProgram,
} from "../services/scanner/src/solana/openjack.js";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const { Keypair } = scannerRequire("@solana/web3.js");

const API_BASE = (process.env.OPENJACK_API_BASE || "").replace(/\/$/, "");
const INGEST_API_KEY = process.env.INGEST_API_KEY || "dev-ingest-key";
const INTERVAL_SECS = Number(process.env.OPENJACK_KEEPER_INTERVAL_SECS || 15);
const KEEP_MODE = (process.env.OPENJACK_KEEPER_MODE || "daemon").toLowerCase();
const ROUND_ID_OVERRIDE = process.env.OPENJACK_KEEPER_ROUND_ID ? Number(process.env.OPENJACK_KEEPER_ROUND_ID) : null;
const AUTO_FULFILL = process.env.OPENJACK_AUTO_FULFILL_DRAW === "true";

const STATUS = {
  0: "OPEN",
  1: "CLOSED",
  2: "DRAWING",
  3: "SETTLING",
  4: "FINALIZED",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bnToNumber(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  return Number(v.toString());
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function toRoundUpdate(roundId, account) {
  const statusCode = Number(account.status);
  return {
    roundId,
    status: STATUS[statusCode] || `UNKNOWN_${statusCode}`,
    openTs: bnToNumber(account.openTs),
    closeTs: bnToNumber(account.closeTs),
    drawTs: bnToNumber(account.drawTs),
    settleDeadlineTs: bnToNumber(account.settleDeadlineTs),
    jackpotPoolBalance: bnToNumber(account.jackpotPoolBalance),
    winnersPoolBalance: bnToNumber(account.winnersPoolBalance),
    unclaimedPoolBalance: bnToNumber(account.unclaimedPoolBalance),
    tierPoolBalances: (account.tierPoolBalances || []).map(bnToNumber),
    winningMain: account.winningMain || [0, 0, 0, 0, 0],
    winningBonus: bnToNumber(account.winningBonus),
  };
}

async function postRoundUpdate(roundPayload) {
  if (!API_BASE) return;
  const res = await fetch(`${API_BASE}/ingest/round`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": INGEST_API_KEY,
    },
    body: JSON.stringify(roundPayload),
  });
  if (!res.ok) {
    throw new Error(`ingest/round failed: ${res.status}`);
  }
}

async function discoverRoundId() {
  if (ROUND_ID_OVERRIDE) return ROUND_ID_OVERRIDE;
  if (!API_BASE) throw new Error("OPENJACK_KEEPER_ROUND_ID required when OPENJACK_API_BASE is not set");
  const res = await fetch(`${API_BASE}/rounds/active`);
  if (!res.ok) throw new Error(`/rounds/active failed: ${res.status}`);
  const body = await res.json();
  return Number(body?.round?.roundId || 0) || null;
}

function vrfResultForRound(roundId) {
  const hex = crypto.createHash("sha256").update(`keeper-${roundId}`).digest("hex");
  const bytes = Buffer.from(hex, "hex");
  return [...bytes];
}

async function stepRound(roundId) {
  const { program, programId, wallet } = getScannerProgram();
  const roundPda = deriveRoundPda(programId, roundId);
  const configPda = deriveConfigPda(programId);
  const round = await program.account.round.fetch(roundPda);
  const status = Number(round.status);
  const now = nowTs();

  if (status === 0 && now >= bnToNumber(round.closeTs)) {
    const sig = await program.methods.closeRound().accounts({ round: roundPda }).rpc();
    console.log(`[keeper] closeRound round=${roundId} sig=${sig}`);
  } else if (status === 1) {
    const vrfRequest = Keypair.generate().publicKey;
    const sig = await program.methods
      .requestDraw({ vrfRequest })
      .accounts({ config: configPda, round: roundPda })
      .rpc();
    console.log(`[keeper] requestDraw round=${roundId} sig=${sig}`);
  } else if (status === 2 && AUTO_FULFILL) {
    const vrfRequest = round.vrfRequest;
    const sig = await program.methods
      .fulfillDraw({ vrfRequest, vrfResult: vrfResultForRound(roundId) })
      .accounts({
        config: configPda,
        vrfCallbackAuthority: wallet.publicKey,
        round: roundPda,
      })
      .rpc();
    console.log(`[keeper] fulfillDraw round=${roundId} sig=${sig}`);
  } else if (status === 3 && now > bnToNumber(round.settleDeadlineTs)) {
    const sig = await program.methods.finalizePrizes().accounts({ round: roundPda }).rpc();
    console.log(`[keeper] finalizePrizes round=${roundId} sig=${sig}`);
  }

  const refreshed = await program.account.round.fetch(roundPda);
  const payload = toRoundUpdate(roundId, refreshed);
  await postRoundUpdate(payload);
  console.log(`[keeper] round=${roundId} status=${payload.status}`);
}

async function runOnce() {
  const roundId = await discoverRoundId();
  if (!roundId) {
    console.log("[keeper] no active round");
    return;
  }
  await stepRound(roundId);
}

async function runDaemon() {
  console.log(`[keeper] daemon mode interval=${INTERVAL_SECS}s`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runOnce();
    } catch (error) {
      console.error("[keeper] iteration failed", error instanceof Error ? error.message : String(error));
    }
    await sleep(Math.max(5, INTERVAL_SECS) * 1000);
  }
}

const runner = KEEP_MODE === "once" ? runOnce : runDaemon;
runner().catch((error) => {
  console.error(error);
  process.exit(1);
});
