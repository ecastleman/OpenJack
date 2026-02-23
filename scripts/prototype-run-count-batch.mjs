import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  classifyRunnerError,
  decideBatchSubmission,
  estimateFeeLamports,
  extractErrorClass,
  extractErrorSurface,
  DEFAULT_BASE_FEE_LAMPORTS,
  DEFAULT_EXPECTED_RETRIES,
  DEFAULT_FEE_MULTIPLIER_BPS,
  DEFAULT_FORCE_COMPLETE_REMAINING,
  DEFAULT_MIN_NET_LAMPORTS,
} from "./lib/count-batch-runner-policy.mjs";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const anchor = scannerRequire("@coral-xyz/anchor");
const { Keypair, PublicKey, ComputeBudgetProgram } = scannerRequire("@solana/web3.js");

const BN = anchor.BN || anchor.default?.BN;
if (!BN) throw new Error("anchor BN constructor unavailable");

const IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const AUTHORITY_KEYPAIR_PATH =
  process.env.AUTHORITY_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const ROUND_ID = Number(process.env.OPENJACK_BENCH_ROUND_ID || process.env.READY_ROUND_ID || 0);
const BATCH_LEN = Number(process.env.OPENJACK_COUNT_BATCH_LEN || 6);
const DRY_RUN = String(process.env.OPENJACK_COUNT_BATCH_DRY_RUN || "false").toLowerCase() === "true";
const MIN_NET_LAMPORTS = Number(process.env.OPENJACK_RUNNER_MIN_NET_LAMPORTS || DEFAULT_MIN_NET_LAMPORTS);
const BASE_FEE_LAMPORTS = Number(process.env.OPENJACK_RUNNER_BASE_FEE_LAMPORTS || DEFAULT_BASE_FEE_LAMPORTS);
const EXPECTED_RETRIES = Number(process.env.OPENJACK_RUNNER_EXPECTED_RETRIES || DEFAULT_EXPECTED_RETRIES);
const FEE_MULTIPLIER_BPS = Number(
  process.env.OPENJACK_RUNNER_FEE_MULTIPLIER_BPS || DEFAULT_FEE_MULTIPLIER_BPS,
);
const FORCE_COMPLETE_REMAINING = Number(
  process.env.OPENJACK_RUNNER_FORCE_COMPLETE_REMAINING || DEFAULT_FORCE_COMPLETE_REMAINING,
);
const FORCE_COMPLETE_ENABLED =
  String(process.env.OPENJACK_RUNNER_FORCE_COMPLETE_ENABLED || "true").toLowerCase() !== "false";
const MAX_RETRYABLE_FAILS = Number(process.env.OPENJACK_RUNNER_MAX_RETRYABLE_FAILS || 10);
const MAX_HARD_FAILS = Number(process.env.OPENJACK_RUNNER_MAX_HARD_FAILS || 1);
const RETRY_BACKOFF_MS = Number(process.env.OPENJACK_RUNNER_RETRY_BACKOFF_MS || 750);
const RETRY_MAX_BACKOFF_MS = Number(process.env.OPENJACK_RUNNER_RETRY_MAX_BACKOFF_MS || 8_000);
const RETRY_JITTER_MS = Number(process.env.OPENJACK_RUNNER_RETRY_JITTER_MS || 500);
const STRESS_REMAINING_THRESHOLD = Number(process.env.OPENJACK_STRESS_REMAINING_THRESHOLD || 24);
const STRESS_BATCH_LEN = Number(process.env.OPENJACK_STRESS_BATCH_LEN || 3);
const STRESS_USE_COMPUTE_BUDGET =
  String(process.env.OPENJACK_STRESS_USE_COMPUTE_BUDGET || "true").toLowerCase() !== "false";
const STRESS_CU_LIMIT = Number(process.env.OPENJACK_STRESS_CU_LIMIT || 350_000);
const STRESS_CU_PRICE_MICRO_LAMPORTS = Number(process.env.OPENJACK_STRESS_CU_PRICE_MICRO_LAMPORTS || 0);
const MAX_TX_SIZE_BYTES = Number(process.env.OPENJACK_RUNNER_MAX_TX_SIZE_BYTES || 1100);
const SIMULATE_PREFLIGHT = String(process.env.OPENJACK_RUNNER_SIMULATE_PREFLIGHT || "true").toLowerCase() !== "false";
const DEBUG_RPC_SHAPE = String(process.env.OPENJACK_RUNNER_DEBUG_RPC_SHAPE || "true").toLowerCase() !== "false";
const SIM_SIG_VERIFY = String(process.env.OPENJACK_RUNNER_SIM_SIG_VERIFY || "true").toLowerCase() !== "false";
const SIM_FALLBACK_SIG_VERIFY_TRUE =
  String(process.env.OPENJACK_RUNNER_SIM_FALLBACK_SIG_VERIFY_TRUE || "true").toLowerCase() !== "false";

if (!ROUND_ID) throw new Error("OPENJACK_BENCH_ROUND_ID (or READY_ROUND_ID) is required");
if (BATCH_LEN <= 0) throw new Error("OPENJACK_COUNT_BATCH_LEN must be > 0");

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

function hashv(parts) {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(Buffer.from(p));
  return h.digest();
}

function nextPowerOfTwo(n) {
  let value = 1;
  while (value < n) value <<= 1;
  return value;
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
    throw new Error(`leaf index ${leafIndex} out of bounds for ticket_count_frozen=${round.ticketCountFrozen}`);
  }
  let level = buildPrototypeMerkleLeaves(round);
  let idx = leafIndex;
  const siblings = [];
  while (level.length > 1) {
    siblings.push(level[(idx ^ 1)]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hashPrototypeMerkleNode(level[i], level[i + 1]));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return siblings.map((s) => Array.from(s));
}

function deriveCountBatchWorkDigest(ticketSetRoot, startIndex, batchLen, leafProofs) {
  const start = Buffer.alloc(4);
  start.writeUInt32LE(startIndex, 0);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(batchLen, 0);
  let acc = hashv([
    Buffer.from("openjack:prototype:count_batch:v1"),
    ticketSetRoot,
    start,
    len,
  ]);
  for (let i = 0; i < batchLen; i += 1) {
    const idx = Buffer.alloc(4);
    idx.writeUInt32LE(startIndex + i, 0);
    const proofHash = hashv((leafProofs[i] || []).map((s) => Buffer.from(s)));
    acc = hashv([Buffer.from("leaf"), ticketSetRoot, idx, proofHash, acc]);
  }
  return Array.from(acc);
}

function deriveRewardPerTicket(round) {
  const bountyInitial = Number(round.bountyPoolInitial?.toString?.() ?? 0);
  const ticketCountFrozen = Number(round.ticketCountFrozen?.toString?.() ?? 0);
  if (ticketCountFrozen <= 0 || bountyInitial <= 0) return 0;
  const maxDistributable = Math.floor((bountyInitial * 9_900) / 10_000);
  return Math.floor(maxDistributable / ticketCountFrozen);
}

function deriveRemainingDistributable(round) {
  const bountyInitial = Number(round.bountyPoolInitial?.toString?.() ?? 0);
  const distributed = Number(round.bountyDistributedSoFar?.toString?.() ?? 0);
  const maxDistributable = Math.floor((bountyInitial * 9_900) / 10_000);
  return Math.max(0, maxDistributable - distributed);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoffMs(failures) {
  const exp = Math.min(RETRY_MAX_BACKOFF_MS, RETRY_BACKOFF_MS * Math.max(1, failures));
  const jitter = RETRY_JITTER_MS > 0 ? Math.floor(Math.random() * RETRY_JITTER_MS) : 0;
  return exp + jitter;
}

function sanitizeValue(value) {
  return String(value ?? "")
    .replace(/\s+/g, "_")
    .replace(/[^\w:.,=+\-()[\]{}]/g, "")
    .slice(0, 220);
}

function selectBatchLen(remaining, maxBatchLen = BATCH_LEN) {
  const stressMode = remaining >= STRESS_REMAINING_THRESHOLD && STRESS_BATCH_LEN > 0;
  const effectiveMax = Math.max(1, Number(maxBatchLen) || 1);
  const target = stressMode ? Math.min(effectiveMax, STRESS_BATCH_LEN) : effectiveMax;
  return { batchLen: Math.max(1, Math.min(target, remaining)), stressMode };
}

function formatRunnerLine(values) {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}

function tupleForAttempt({ progress, remaining, total, batchLen, stressMode }) {
  return {
    start_index: progress,
    remaining,
    expected_total: total,
    requested_batch_len: batchLen,
    page_size: batchLen,
    stress_mode: stressMode,
  };
}

async function simulateViaRpc(connection, wire, sigVerify) {
  const response = await connection._rpcRequest("simulateTransaction", [
    wire.toString("base64"),
    {
      encoding: "base64",
      sigVerify,
      commitment: "confirmed",
    },
  ]);
  if (response?.error) {
    const code = Number(response.error?.code);
    const message = String(response.error?.message || "Simulation RPC error");
    const error = new Error(`${message}`);
    if (Number.isFinite(code)) error.code = code;
    throw error;
  }
  const value = response?.result?.value || response?.result || {};
  return {
    unitsConsumed: Number(value?.unitsConsumed || 0),
    err: value?.err ?? null,
  };
}

async function main() {
  const authority = readKeypair(AUTHORITY_KEYPAIR_PATH);
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const resolvedProgramId = process.env.OPENJACK_PROGRAM_ID || loadProgramIdFromAnchorToml();
  if (!resolvedProgramId) throw new Error("OPENJACK_PROGRAM_ID missing and Anchor.toml has no [programs.devnet].openjack");
  const programId = new PublicKey(resolvedProgramId);

  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  let program;
  try {
    program = new anchor.Program(idl, programId, provider);
  } catch {
    program = new anchor.Program({ ...idl, address: programId.toBase58() }, provider);
  }

  const roundPda = deriveRoundPda(programId, ROUND_ID);
  let round = await program.account.round.fetch(roundPda);
  const ticketSetRoot = Buffer.from(round.ticketSetRoot);
  const ticketCountFrozen = Number(round.ticketCountFrozen.toString());
  const roundContext = {
    roundId: Number(round.roundId.toString()),
    treeAddress: round.treeAddress,
    ticketCountFrozen,
    closeTs: Number(round.closeTs.toString()),
  };
  let progress = Number(round.countProgressIndex.toString());
  let retryableFailures = 0;
  let hardFailures = 0;
  let attemptSeq = 0;
  let adaptiveMaxBatchLen = BATCH_LEN;
  const feeEstimateLamports = estimateFeeLamports({
    baseFeeLamports: BASE_FEE_LAMPORTS,
    expectedRetries: EXPECTED_RETRIES,
    feeMultiplierBps: FEE_MULTIPLIER_BPS,
  });

  if (DRY_RUN) {
    const remaining = Math.max(0, ticketCountFrozen - progress);
    const selected = selectBatchLen(remaining || 1);
    const effectiveBatchLen = remaining > 0 ? selected.batchLen : 0;
    const rewardPerTicket = deriveRewardPerTicket(round);
    const rewardEstimateLamports = Math.min(
      rewardPerTicket * effectiveBatchLen,
      deriveRemainingDistributable(round),
    );
    const decision = decideBatchSubmission({
      rewardEstimateLamports,
      feeEstimateLamports,
      remainingTickets: remaining,
      minNetLamports: MIN_NET_LAMPORTS,
      forceCompleteRemaining: FORCE_COMPLETE_REMAINING,
      forceCompleteEnabled: FORCE_COMPLETE_ENABLED,
    });
    console.log(
      formatRunnerLine({
        event: "COUNT_BATCH_RUNNER",
        mode: "dry_run",
        attempt_id: `${ROUND_ID}-dryrun-1`,
        round: ROUND_ID,
        progress,
        total: ticketCountFrozen,
        remaining,
        batch_len: effectiveBatchLen,
        stress_mode: selected.stressMode,
        reward_est: rewardEstimateLamports,
        fee_est: feeEstimateLamports,
        net_est: decision.netEstimateLamports,
        min_net: MIN_NET_LAMPORTS,
        decision: decision.submit ? "submit" : "skip",
        reason: decision.reason,
      }),
    );
    return;
  }

  while (progress < ticketCountFrozen) {
    attemptSeq += 1;
    const attemptId = `${ROUND_ID}-${attemptSeq}`;
    const remaining = Math.max(0, ticketCountFrozen - progress);
    const selected = selectBatchLen(remaining, adaptiveMaxBatchLen);
    const batchLen = selected.batchLen;
    const requestTuple = tupleForAttempt({
      progress,
      remaining,
      total: ticketCountFrozen,
      batchLen,
      stressMode: selected.stressMode,
    });
    // Safety invariant: every submitted batch must stay fully within the frozen ticket universe.
    // Equivalent bound: start_index + batch_len <= expected_total (and start_index >= 0).
    if (progress < 0 || progress > ticketCountFrozen || batchLen <= 0 || progress + batchLen > ticketCountFrozen) {
      const msg = `invalid_batch_window_start_${progress}_len_${batchLen}_total_${ticketCountFrozen}`;
      console.log(
        formatRunnerLine({
          event: "COUNT_BATCH_RUNNER_ERROR",
          attempt_id: attemptId,
          round: ROUND_ID,
          class: "CountBatchOutOfBounds",
          policy: classifyRunnerError("CountBatchOutOfBounds"),
          stage: "client_validate",
          rpc_code: "none",
          rpc_message: msg,
          retryable_fails: retryableFailures,
          hard_fails: hardFailures + 1,
          ...requestTuple,
        }),
      );
      throw new Error(msg);
    }
    const rewardPerTicket = deriveRewardPerTicket(round);
    const rewardEstimateLamports = Math.min(
      rewardPerTicket * batchLen,
      deriveRemainingDistributable(round),
    );
    const decision = decideBatchSubmission({
      rewardEstimateLamports,
      feeEstimateLamports,
      remainingTickets: remaining,
      minNetLamports: MIN_NET_LAMPORTS,
      forceCompleteRemaining: FORCE_COMPLETE_REMAINING,
      forceCompleteEnabled: FORCE_COMPLETE_ENABLED,
    });
    console.log(
      formatRunnerLine({
        event: "COUNT_BATCH_RUNNER",
        mode: "run",
        attempt_id: attemptId,
        round: ROUND_ID,
        progress,
        total: ticketCountFrozen,
        remaining,
        batch_len: batchLen,
        stress_mode: selected.stressMode,
        reward_est: rewardEstimateLamports,
        fee_est: feeEstimateLamports,
        net_est: decision.netEstimateLamports,
        min_net: MIN_NET_LAMPORTS,
        decision: decision.submit ? "submit" : "skip",
        reason: decision.reason,
      }),
    );
    if (!decision.submit) break;
    const leafProofs = [];
    for (let i = 0; i < batchLen; i += 1) {
      leafProofs.push(derivePrototypeTicketProof(roundContext, progress + i));
    }
    const batchHash = deriveCountBatchWorkDigest(ticketSetRoot, progress, batchLen, leafProofs);
    try {
      const methodBuilder = program.methods
        .countBatch({
          startIndex: new BN(progress),
          batchLen: new BN(batchLen),
          batchHash,
          leafProofs,
        })
        .accounts({
          caller: authority.publicKey,
          round: roundPda,
        });
      let tx;
      try {
        tx = await methodBuilder.transaction();
      } catch (error) {
        const surface = extractErrorSurface(error, "build");
        const isOffsetRange = String(surface.className || "").includes("OffsetOutOfRange")
          || String(surface.message || "").includes("offset");
        const className = isOffsetRange ? "ClientOffsetOutOfRange" : (surface.className || "InstructionSerializationOutOfRange");
        console.log(
          formatRunnerLine({
            event: "COUNT_BATCH_RUNNER_ERROR",
            attempt_id: attemptId,
            round: ROUND_ID,
            class: className,
            policy: classifyRunnerError(className),
            stage: "build",
            rpc_code: surface.rpcCode ?? "none",
            rpc_message: sanitizeValue(surface.message || error?.message || "build_failed"),
            retryable_fails: retryableFailures,
            hard_fails: hardFailures + 1,
            ...requestTuple,
          }),
        );
        const buildErr = new Error(surface.message || "build_failed");
        buildErr._handledStageError = true;
        buildErr._surface = {
          className,
          rpcCode: surface.rpcCode ?? null,
          message: surface.message || "build_failed",
          stage: "build",
        };
        throw buildErr;
      }
      tx.feePayer = authority.publicKey;
      if (selected.stressMode && STRESS_USE_COMPUTE_BUDGET) {
        const cbIxs = [];
        if (STRESS_CU_LIMIT > 0) cbIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: STRESS_CU_LIMIT }));
        if (STRESS_CU_PRICE_MICRO_LAMPORTS > 0) {
          cbIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: STRESS_CU_PRICE_MICRO_LAMPORTS }));
        }
        if (cbIxs.length > 0) tx.instructions.unshift(...cbIxs);
      }

      const latest = await connection.getLatestBlockhashAndContext("confirmed");
      tx.recentBlockhash = latest.value.blockhash;
      tx.sign(authority);
      const wire = tx.serialize();
      const txSize = wire.length;
      const txB64Len = wire.toString("base64").length;
      const currentSlot = await connection.getSlot("confirmed");
      const blockhashAgeSlots = Math.max(0, currentSlot - latest.context.slot);

      if (txSize > MAX_TX_SIZE_BYTES) {
        const surface = {
          className: "TxSizeGuardExceeded",
          rpcCode: null,
          message: `serialized_tx_size_${txSize}_exceeds_${MAX_TX_SIZE_BYTES}`,
          stage: "send",
        };
        console.log(
          formatRunnerLine({
            event: "COUNT_BATCH_RUNNER_ERROR",
            attempt_id: attemptId,
            round: ROUND_ID,
            class: surface.className,
            policy: classifyRunnerError(surface.className),
            stage: surface.stage,
            rpc_code: "none",
            rpc_message: surface.message,
            blockhash_age_slots: blockhashAgeSlots,
            tx_size: txSize,
            cu_limit: selected.stressMode && STRESS_USE_COMPUTE_BUDGET ? STRESS_CU_LIMIT : "none",
            cu_price: selected.stressMode && STRESS_USE_COMPUTE_BUDGET ? STRESS_CU_PRICE_MICRO_LAMPORTS : "none",
            preflight_cu: 0,
            sim_err: "none",
            retryable_fails: retryableFailures,
            hard_fails: hardFailures + 1,
          }),
        );
        const sizeErr = new Error(surface.message);
        sizeErr._handledStageError = true;
        sizeErr._surface = surface;
        throw sizeErr;
      }

      let simulateUnits = 0;
      let simErr = "none";
      let simSigVerifyUsed = SIM_SIG_VERIFY;
      if (SIMULATE_PREFLIGHT) {
        try {
          const runSim = async (sigVerify) => {
            const sim = await simulateViaRpc(connection, wire, sigVerify);
            const units = Number(sim.unitsConsumed || 0);
            if (sim.err) {
              const e = new Error(`Simulation failed: ${sanitizeValue(JSON.stringify(sim.err))}`);
              e.cause = sim.err;
              e._simUnits = units;
              throw e;
            }
            return { sim, units };
          };
          try {
            const { units } = await runSim(SIM_SIG_VERIFY);
            simulateUnits = units;
            simSigVerifyUsed = SIM_SIG_VERIFY;
          } catch (error) {
            const surface = extractErrorSurface(error, "preflight");
            const maybeInvalidArgs =
              surface.className === "SimulationError" &&
              String(surface.message || "").toLowerCase().includes("invalid_arguments");
            if (maybeInvalidArgs && SIM_FALLBACK_SIG_VERIFY_TRUE && !SIM_SIG_VERIFY) {
              const { units } = await runSim(true);
              simulateUnits = units;
              simSigVerifyUsed = true;
            } else {
              throw error;
            }
          }
        } catch (error) {
          const surface = extractErrorSurface(error, "preflight");
          const rawMessage = String(error?.stack || error?.message || "");
          const rawSanitized = sanitizeValue(rawMessage);
          console.log(
            formatRunnerLine({
              event: "COUNT_BATCH_RUNNER_ERROR",
              attempt_id: attemptId,
              round: ROUND_ID,
              class: surface.className,
              policy: classifyRunnerError(surface.className),
              stage: "preflight",
              rpc_code: surface.rpcCode ?? "none",
              rpc_message: surface.message,
              blockhash_age_slots: blockhashAgeSlots,
              tx_size: txSize,
              cu_limit: selected.stressMode && STRESS_USE_COMPUTE_BUDGET ? STRESS_CU_LIMIT : "none",
              cu_price: selected.stressMode && STRESS_USE_COMPUTE_BUDGET ? STRESS_CU_PRICE_MICRO_LAMPORTS : "none",
              preflight_cu: simulateUnits,
              sim_err: simErr,
              rpc_method: DEBUG_RPC_SHAPE ? "simulateTransaction" : "suppressed",
              rpc_params_shape: DEBUG_RPC_SHAPE
                ? `simulateTransaction([base64_tx],{encoding:base64,sigVerify:${simSigVerifyUsed},commitment:confirmed})`
                : "suppressed",
              rpc_tx_b64_len: DEBUG_RPC_SHAPE ? txB64Len : "suppressed",
              tx_format: "legacy",
              tx_alt_count: 0,
              tx_ix_count: tx.instructions.length,
              sim_sig_verify: simSigVerifyUsed,
              rpc_raw: DEBUG_RPC_SHAPE ? rawSanitized : "suppressed",
              retryable_fails: retryableFailures + 1,
              hard_fails: hardFailures,
              ...requestTuple,
            }),
          );
          throw Object.assign(error, { _handledStageError: true, _surface: surface });
        }
      }

      let sig;
      try {
        sig = await connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 0 });
      } catch (error) {
        const surface = extractErrorSurface(error, "send");
        console.log(
          formatRunnerLine({
            event: "COUNT_BATCH_RUNNER_ERROR",
            attempt_id: attemptId,
            round: ROUND_ID,
            class: surface.className,
            policy: classifyRunnerError(surface.className),
            stage: "send",
            rpc_code: surface.rpcCode ?? "none",
            rpc_message: surface.message,
            blockhash_age_slots: blockhashAgeSlots,
            tx_size: txSize,
            cu_limit: selected.stressMode && STRESS_USE_COMPUTE_BUDGET ? STRESS_CU_LIMIT : "none",
            cu_price: selected.stressMode && STRESS_USE_COMPUTE_BUDGET ? STRESS_CU_PRICE_MICRO_LAMPORTS : "none",
            preflight_cu: simulateUnits,
            sim_err: simErr,
            retryable_fails: retryableFailures + 1,
            hard_fails: hardFailures,
            ...requestTuple,
          }),
        );
        throw Object.assign(error, { _handledStageError: true, _surface: surface });
      }
      try {
        const conf = await connection.confirmTransaction(
          {
            signature: sig,
            blockhash: latest.value.blockhash,
            lastValidBlockHeight: latest.value.lastValidBlockHeight,
          },
          "confirmed",
        );
        if (conf?.value?.err) {
          throw new Error(`confirm_err=${sanitizeValue(JSON.stringify(conf.value.err))}`);
        }
      } catch (error) {
        const surface = extractErrorSurface(error, "confirm");
        console.log(
          formatRunnerLine({
            event: "COUNT_BATCH_RUNNER_ERROR",
            attempt_id: attemptId,
            round: ROUND_ID,
            class: surface.className,
            policy: classifyRunnerError(surface.className),
            stage: "confirm",
            rpc_code: surface.rpcCode ?? "none",
            rpc_message: surface.message,
            blockhash_age_slots: blockhashAgeSlots,
            tx_size: txSize,
            cu_limit: selected.stressMode && STRESS_USE_COMPUTE_BUDGET ? STRESS_CU_LIMIT : "none",
            cu_price: selected.stressMode && STRESS_USE_COMPUTE_BUDGET ? STRESS_CU_PRICE_MICRO_LAMPORTS : "none",
            preflight_cu: simulateUnits,
            sim_err: simErr,
            retryable_fails: retryableFailures + 1,
            hard_fails: hardFailures,
            sig,
            ...requestTuple,
          }),
        );
        throw Object.assign(error, { _handledStageError: true, _surface: surface });
      }
      round = await program.account.round.fetch(roundPda);
      progress = Number(round.countProgressIndex.toString());
      retryableFailures = 0;
      hardFailures = 0;
      console.log(
        formatRunnerLine({
          event: "COUNT_BATCH_RUNNER_TX",
          attempt_id: attemptId,
          round: ROUND_ID,
          sig,
          progress,
          total: ticketCountFrozen,
          batch_len: batchLen,
          stage: "confirmed",
          tx_size: txSize,
          blockhash_age_slots: blockhashAgeSlots,
          cu_limit: selected.stressMode && STRESS_USE_COMPUTE_BUDGET ? STRESS_CU_LIMIT : "none",
          cu_price: selected.stressMode && STRESS_USE_COMPUTE_BUDGET ? STRESS_CU_PRICE_MICRO_LAMPORTS : "none",
          preflight_cu: simulateUnits,
        }),
      );
    } catch (error) {
      const surface = error?._surface || extractErrorSurface(error, "unknown");
      const errorClass = surface.className || extractErrorClass(error);
      if (errorClass === "ClientOffsetOutOfRange" && batchLen > 1) {
        adaptiveMaxBatchLen = Math.max(1, batchLen - 1);
        console.log(
          formatRunnerLine({
            event: "COUNT_BATCH_RUNNER_ADJUST",
            round: ROUND_ID,
            attempt_id: attemptId,
            class: errorClass,
            action: "reduce_batch_len",
            from_batch_len: batchLen,
            to_batch_len: adaptiveMaxBatchLen,
            ...requestTuple,
          }),
        );
        round = await program.account.round.fetch(roundPda);
        progress = Number(round.countProgressIndex.toString());
        continue;
      }
      const policy = classifyRunnerError(errorClass);
      if (policy === "hard_stop") hardFailures += 1;
      else retryableFailures += 1;
      if (!error?._handledStageError) {
        console.log(
          formatRunnerLine({
            event: "COUNT_BATCH_RUNNER_ERROR",
            attempt_id: attemptId,
            round: ROUND_ID,
            class: errorClass,
            policy,
            stage: surface.stage || "unknown",
            rpc_code: surface.rpcCode ?? "none",
            rpc_message: sanitizeValue(surface.message || error?.message || "unknown"),
            retryable_fails: retryableFailures,
            hard_fails: hardFailures,
            ...requestTuple,
          }),
        );
      }
      if (hardFailures >= MAX_HARD_FAILS) {
        throw new Error(`hard-stop error threshold reached: class=${errorClass}`);
      }
      if (retryableFailures >= MAX_RETRYABLE_FAILS) {
        throw new Error(`retryable error threshold reached: class=${errorClass}`);
      }
      await sleep(jitteredBackoffMs(retryableFailures));
      round = await program.account.round.fetch(roundPda);
      progress = Number(round.countProgressIndex.toString());
      continue;
    }
  }

  console.log(
    formatRunnerLine({
      event: "COUNT_BATCH_RUNNER_DONE",
      round: ROUND_ID,
      round_pda: roundPda.toBase58(),
      total: ticketCountFrozen,
      progress,
      finalized: Boolean(round.countFinalized),
      attempts: attemptSeq,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
