import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { parseKeyValueLine } from "./lib/kv-line-parser.mjs";
import { extractErrorClass } from "./lib/count-batch-runner-policy.mjs";
import {
  calcMaxRetryableBurst,
  calcMaxStallWindowMs,
  countTerminalHardStops,
  evaluateRoundSlo,
  getRehearsalSloFromEnv,
  summarizeLatency,
} from "./lib/rehearsal-metrics.mjs";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const anchor = scannerRequire("@coral-xyz/anchor");
const { Keypair, PublicKey } = scannerRequire("@solana/web3.js");
const BN = anchor.BN || anchor.default?.BN;
if (!BN) throw new Error("anchor BN constructor unavailable");

const IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const AUTHORITY_KEYPAIR_PATH =
  process.env.AUTHORITY_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const ROUND_ID = Number(process.env.OPENJACK_BENCH_ROUND_ID || process.env.READY_ROUND_ID || 0);
const PROFILE_NAME = process.env.OPENJACK_REHEARSAL_PROFILE || "official-bot";
const LIVE_MODE = String(process.env.OPENJACK_REHEARSAL_LIVE || "false").toLowerCase() === "true";
const DRILL_RETRYABLE = String(process.env.OPENJACK_REHEARSAL_DRILL_RETRYABLE || "true").toLowerCase() !== "false";
const PREFLIGHT_ONLY = String(process.env.OPENJACK_REHEARSAL_PREFLIGHT_ONLY || "false").toLowerCase() === "true";

if (!ROUND_ID) {
  throw new Error(
    "OPENJACK_BENCH_ROUND_ID (or READY_ROUND_ID) is required. Example: OPENJACK_BENCH_ROUND_ID=<round> npm run count-batch:rehearsal",
  );
}

function readKeypair(filePath) {
  const secret = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function loadProgramIdFromAnchorToml() {
  const anchorTomlPath = path.resolve(process.cwd(), "Anchor.toml");
  if (!fs.existsSync(anchorTomlPath)) return null;
  const raw = fs.readFileSync(anchorTomlPath, "utf8");
  const devnetSection = raw.match(/\[programs\.devnet\]([\s\S]*?)(?:\n\[|$)/);
  if (!devnetSection) return null;
  const openjackLine = devnetSection[1].match(/^\s*openjack\s*=\s*"([^"]+)"/m);
  return openjackLine?.[1] || null;
}

function deriveRoundPda(programId, roundId) {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync([Buffer.from("round"), le], programId)[0];
}

function nextPowerOfTwo(n) {
  let value = 1;
  while (value < n) value <<= 1;
  return value;
}

function hashv(parts) {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(Buffer.from(p));
  return h.digest();
}

function derivePrototypeTicketLeaf(round, leafIndex) {
  const idx = Buffer.alloc(4);
  idx.writeUInt32LE(leafIndex, 0);
  const ticketCount = Buffer.alloc(4);
  ticketCount.writeUInt32LE(round.ticketCountFrozen, 0);
  const closeTs = Buffer.alloc(8);
  closeTs.writeBigInt64LE(BigInt(round.closeTs), 0);
  const roundId = Buffer.alloc(8);
  roundId.writeBigUInt64LE(BigInt(round.roundId), 0);
  return hashv([
    Buffer.from("openjack:prototype:ticket_leaf:v1"),
    roundId,
    Buffer.from(round.treeAddress.toBytes()),
    ticketCount,
    closeTs,
    idx,
  ]);
}

function derivePrototypePaddingLeaf(round, leafIndex) {
  const idx = Buffer.alloc(4);
  idx.writeUInt32LE(leafIndex, 0);
  const ticketCount = Buffer.alloc(4);
  ticketCount.writeUInt32LE(round.ticketCountFrozen, 0);
  const closeTs = Buffer.alloc(8);
  closeTs.writeBigInt64LE(BigInt(round.closeTs), 0);
  const roundId = Buffer.alloc(8);
  roundId.writeBigUInt64LE(BigInt(round.roundId), 0);
  return hashv([
    Buffer.from("openjack:prototype:ticket_leaf:pad:v1"),
    roundId,
    Buffer.from(round.treeAddress.toBytes()),
    ticketCount,
    closeTs,
    idx,
  ]);
}

function hashPrototypeMerkleNode(left, right) {
  return hashv([Buffer.from("openjack:prototype:ticket_node:v1"), left, right]);
}

function buildPrototypeMerkleLeaves(round) {
  const width = nextPowerOfTwo(Math.max(1, round.ticketCountFrozen));
  const leaves = [];
  for (let i = 0; i < width; i += 1) {
    leaves.push(i < round.ticketCountFrozen ? derivePrototypeTicketLeaf(round, i) : derivePrototypePaddingLeaf(round, i));
  }
  return leaves;
}

function derivePrototypeTicketProof(round, leafIndex) {
  if (leafIndex < 0 || leafIndex >= round.ticketCountFrozen) {
    throw new Error(`leaf index ${leafIndex} out of bounds`);
  }
  let level = buildPrototypeMerkleLeaves(round);
  let idx = leafIndex;
  const siblings = [];
  while (level.length > 1) {
    siblings.push(level[idx ^ 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(hashPrototypeMerkleNode(level[i], level[i + 1]));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return siblings.map((s) => Array.from(s));
}

function deriveCountBatchWorkDigest(ticketSetRoot, startIndex, batchLen, leafProofs) {
  function h(parts) {
    const c = crypto.createHash("sha256");
    for (const p of parts) c.update(Buffer.from(p));
    return c.digest();
  }
  const start = Buffer.alloc(4);
  start.writeUInt32LE(startIndex, 0);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(batchLen, 0);
  let acc = h([Buffer.from("openjack:prototype:count_batch:v1"), ticketSetRoot, start, len]);
  for (let i = 0; i < batchLen; i += 1) {
    const idx = Buffer.alloc(4);
    idx.writeUInt32LE(startIndex + i, 0);
    const proofHash = h((leafProofs[i] || []).map((s) => Buffer.from(s)));
    acc = h([Buffer.from("leaf"), ticketSetRoot, idx, proofHash, acc]);
  }
  return Array.from(acc);
}

function runCommand(cmd, args, env = process.env) {
  return new Promise((resolve) => {
    const startMs = Date.now();
    const child = spawn(cmd, args, { cwd: process.cwd(), env });
    let stdout = "";
    let stderr = "";
    const lines = [];
    let stdoutCarry = "";
    let stderrCarry = "";
    function pushCompleteLines(stream, chunk, isFinal = false) {
      let text = (stream === "stdout" ? stdoutCarry : stderrCarry) + chunk;
      if (!isFinal) {
        const idx = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
        if (idx < 0) {
          if (stream === "stdout") stdoutCarry = text;
          else stderrCarry = text;
          return;
        }
        const emit = text.slice(0, idx + 1);
        text = text.slice(idx + 1);
        if (stream === "stdout") stdoutCarry = text;
        else stderrCarry = text;
        for (const line of emit.split(/\r?\n/)) {
          if (!line) continue;
          lines.push({ _ts: Date.now(), stream, line });
        }
        return;
      }
      if (stream === "stdout") stdoutCarry = "";
      else stderrCarry = "";
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        lines.push({ _ts: Date.now(), stream, line });
      }
    }
    child.stdout.on("data", (d) => {
      const text = d.toString();
      process.stdout.write(text);
      stdout += text;
      pushCompleteLines("stdout", text, false);
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      process.stderr.write(text);
      stderr += text;
      pushCompleteLines("stderr", text, false);
    });
    child.on("exit", (code) => {
      pushCompleteLines("stdout", stdoutCarry, true);
      pushCompleteLines("stderr", stderrCarry, true);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        lines,
        startMs,
        endMs: Date.now(),
        durationMs: Date.now() - startMs,
      });
    });
  });
}

function parseRunnerLines(lineEvents) {
  const rows = [];
  for (const entry of lineEvents || []) {
    const parsed = parseKeyValueLine(entry.line);
    if (!parsed) continue;
    const row = { ...parsed, _ts: entry._ts, _stream: entry.stream };
    if (!String(row.event || "").startsWith("COUNT_BATCH_")) continue;
    rows.push(row);
  }
  return rows;
}

function computeRunnerAggregates(rows) {
  let submit = 0;
  let skip = 0;
  let tx = 0;
  let retryableErrors = 0;
  const hardErrors = countTerminalHardStops(rows);
  let rewardEstTotal = 0;
  let feeEstTotal = 0;
  let netEstTotal = 0;
  for (const r of rows) {
    if (r.event === "COUNT_BATCH_RUNNER") {
      if (r.decision === "submit") submit += 1;
      if (r.decision === "skip") skip += 1;
      rewardEstTotal += Number(r.reward_est || 0);
      feeEstTotal += Number(r.fee_est || 0);
      netEstTotal += Number(r.net_est || 0);
    }
    if (r.event === "COUNT_BATCH_RUNNER_TX") tx += 1;
    if (r.event === "COUNT_BATCH_RUNNER_ERROR" && r.policy !== "hard_stop") retryableErrors += 1;
  }
  return { submit, skip, tx, retryableErrors, hardErrors, rewardEstTotal, feeEstTotal, netEstTotal };
}

function parseScoreboardStatuses(markdownPath) {
  const raw = fs.readFileSync(markdownPath, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`(B\d+)`\s*[^|]*\|\s*([^|]+)\s*\|/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function sanitizeFeatureFlags() {
  const direct = process.env.OPENJACK_FEATURE_FLAGS;
  if (direct) return direct;
  return "canonical-freeze-prototype";
}

async function fetchRound(program, roundPda) {
  const round = await program.account.round.fetch(roundPda);
  return {
    roundId: Number(round.roundId?.toString?.() ?? 0),
    countProgressIndex: Number(round.countProgressIndex?.toString?.() ?? 0),
    ticketCountFrozen: Number(round.ticketCountFrozen?.toString?.() ?? 0),
    countFinalized: Boolean(round.countFinalized),
    bountyInitial: Number(round.bountyPoolInitial?.toString?.() ?? 0),
    bountyDistributed: Number(round.bountyDistributedSoFar?.toString?.() ?? 0),
    bountyRemaining: Number(round.bountyPoolBalance?.toString?.() ?? 0),
    countLastRewardPaid: Number(round.countLastRewardPaid?.toString?.() ?? 0),
    countAcceptedBatches: Number(round.countBatchesAccepted?.toString?.() ?? 0),
    countNoopReplayBatches: Number(round.countBatchesNoopReplay?.toString?.() ?? 0),
    treeAddress: round.treeAddress,
    closeTs: Number(round.closeTs?.toString?.() ?? 0),
  };
}

async function main() {
  const scriptStartMs = Date.now();
  const startedAt = new Date().toISOString();
  const runTs = Date.now();
  const reportPath =
    process.env.OPENJACK_REHEARSAL_REPORT ||
    path.resolve(process.cwd(), "reports/protocol-gate", `activation-rehearsal-${runTs}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const authority = readKeypair(AUTHORITY_KEYPAIR_PATH);
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const resolvedProgramId = process.env.OPENJACK_PROGRAM_ID || loadProgramIdFromAnchorToml();
  if (!resolvedProgramId) throw new Error("OPENJACK_PROGRAM_ID missing and Anchor.toml has no [programs.devnet].openjack");
  const programId = new PublicKey(resolvedProgramId);
  const roundPda = deriveRoundPda(programId, ROUND_ID);
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const rpcFetchLatenciesMs = [];
  async function fetchRoundTimed(label) {
    const t0 = Date.now();
    const snapshot = await fetchRound(program, roundPda);
    const elapsed = Date.now() - t0;
    rpcFetchLatenciesMs.push({ label, ms: elapsed });
    return snapshot;
  }
  let program;
  try {
    program = new anchor.Program(idl, programId, provider);
  } catch {
    program = new anchor.Program({ ...idl, address: programId.toBase58() }, provider);
  }

  const gitCommit = (await runCommand("git", ["rev-parse", "HEAD"])).stdout.trim();
  const gitTagRes = await runCommand("git", ["describe", "--tags", "--exact-match"]);
  const gitTag = gitTagRes.code === 0 ? gitTagRes.stdout.trim() : null;

  const before = await fetchRoundTimed("before");

  const guardRun = await runCommand("npm", ["run", "check:round-solvency"]);
  const contractRun = await runCommand("npm", ["run", "test:contract"]);

  const botEnv = {
    ...process.env,
    OPENJACK_BOT_DRY_RUN: LIVE_MODE && !PREFLIGHT_ONLY ? "false" : "true",
  };
  const botRun = await runCommand("npm", ["run", "count-batch:bot"], botEnv);
  const botRows = parseRunnerLines(botRun.lines);
  const botAgg = computeRunnerAggregates(botRows);
  const retryableErrorBurstMax = calcMaxRetryableBurst(botRows);

  let drill = {
    attempted: false,
    class: null,
    policy: null,
    stateChanged: null,
  };
  if (LIVE_MODE && !PREFLIGHT_ONLY && DRILL_RETRYABLE) {
    const preDrill = await fetchRoundTimed("pre_drill");
    if (preDrill.countProgressIndex > 0) {
      drill.attempted = true;
      const startIndex = 0;
      const batchLen = 1;
      const roundCtx = {
        roundId: preDrill.roundId,
        treeAddress: preDrill.treeAddress,
        ticketCountFrozen: preDrill.ticketCountFrozen,
        closeTs: preDrill.closeTs,
      };
      const leafProofs = [derivePrototypeTicketProof(roundCtx, startIndex)];
      const batchHash = deriveCountBatchWorkDigest(
        Buffer.from((await program.account.round.fetch(roundPda)).ticketSetRoot),
        startIndex,
        batchLen,
        leafProofs,
      );
      // Force mismatch with last accepted batch metadata to trigger retryable CountReplayMismatch.
      batchHash[0] = (batchHash[0] + 1) % 255;
      try {
        await program.methods
          .countBatch({
            startIndex: new BN(startIndex),
            batchLen: new BN(batchLen),
            batchHash,
            leafProofs,
          })
          .accounts({ caller: authority.publicKey, round: roundPda })
          .simulate();
      } catch (error) {
        drill.class = extractErrorClass(error);
        drill.policy = drill.class === "CountReplayMismatch" ? "retryable" : "other";
      }
      const postDrill = await fetchRoundTimed("post_drill");
      drill.stateChanged =
        postDrill.bountyDistributed !== preDrill.bountyDistributed ||
        postDrill.bountyRemaining !== preDrill.bountyRemaining;
    }
  }

  const after = await fetchRoundTimed("after");
  const scoreboard = parseScoreboardStatuses(
    path.resolve(process.cwd(), "docs/PARI_MUTUEL_IMPL_PR13_1_ACTIVATION_SCOREBOARD.md"),
  );

  const determinismChecks = {
    bountyConservation: after.bountyDistributed + after.bountyRemaining === after.bountyInitial,
    acceptedProgressComplete: LIVE_MODE && !PREFLIGHT_ONLY ? after.countProgressIndex === after.ticketCountFrozen : true,
    noPostFinalizationRewardMutation:
      LIVE_MODE && !PREFLIGHT_ONLY && drill.attempted ? drill.stateChanged === false : true,
  };

  const maxStallWindowMs = calcMaxStallWindowMs({
    rows: botRows,
    startMs: botRun.startMs,
    endMs: botRun.endMs,
    initialProgress: before.countProgressIndex,
    finalProgress: after.countProgressIndex,
  });
  const rpcLatencyStats = summarizeLatency(rpcFetchLatenciesMs.map((x) => x.ms));
  const completionTimeMs = botRun.durationMs;
  const slo = evaluateRoundSlo({
    thresholds: getRehearsalSloFromEnv(process.env),
    liveMode: LIVE_MODE && !PREFLIGHT_ONLY,
    completionMs: completionTimeMs,
    retryableErrors: botAgg.retryableErrors,
    retryableBurst: retryableErrorBurstMax,
    stallWindowMs: maxStallWindowMs,
    bountyConservation: determinismChecks.bountyConservation,
    progressComplete: determinismChecks.acceptedProgressComplete,
  });

  const gates = {
    guardPass: guardRun.code === 0,
    contractPass: contractRun.code === 0,
    noHardStopErrors: botAgg.hardErrors === 0,
    progressMonotonic: after.countProgressIndex >= before.countProgressIndex,
    outputParseable: botRows.length > 0,
    determinismChecksPass:
      determinismChecks.bountyConservation &&
      determinismChecks.acceptedProgressComplete &&
      determinismChecks.noPostFinalizationRewardMutation,
    sloPass: slo.pass,
  };

  const report = {
    metadata: {
      timestamp: startedAt,
      git_commit: gitCommit,
      git_tag: gitTag,
      program_id: programId.toBase58(),
      feature_flags: sanitizeFeatureFlags(),
      profile_name: PROFILE_NAME,
      preflight_only: PREFLIGHT_ONLY,
      live_mode: LIVE_MODE,
      round_id: ROUND_ID,
      round_pda: roundPda.toBase58(),
      rpc_url: RPC_URL,
    },
    commandResults: {
      check_round_solvency: { code: guardRun.code },
      test_contract: { code: contractRun.code },
      count_batch_bot: { code: botRun.code },
    },
    aggregates: botAgg,
    metrics: {
      completion_time_ms: completionTimeMs,
      retryable_error_burst_max: retryableErrorBurstMax,
      max_stall_window_ms: maxStallWindowMs,
      rpc_fetch_latency_ms: rpcLatencyStats,
      rpc_fetch_samples: rpcFetchLatenciesMs,
      reward_distribution: {
        initial: after.bountyInitial,
        distributed: after.bountyDistributed,
        remaining: after.bountyRemaining,
        conservation_ok: determinismChecks.bountyConservation,
      },
      rehearsal_duration_ms: Date.now() - scriptStartMs,
    },
    round: { before, after },
    driftChecks: determinismChecks,
    retryableFailureDrill: drill,
    slo,
    blockers: scoreboard,
    gates,
    verdict: Object.values(gates).every(Boolean) ? "PASS" : "FAIL",
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const latestPath = path.resolve(path.dirname(reportPath), "latest.json");
  fs.writeFileSync(
    latestPath,
    `${JSON.stringify(
      {
        report_path: reportPath,
        verdict: report.verdict,
        timestamp: report.metadata.timestamp,
        round_id: report.metadata.round_id,
        live_mode: report.metadata.live_mode,
        preflight_only: report.metadata.preflight_only,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`REHEARSAL_REPORT=${reportPath}`);
  console.log(`REHEARSAL_LATEST=${latestPath}`);
  if (report.verdict !== "PASS") process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
