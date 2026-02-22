import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const anchor = scannerRequire("@coral-xyz/anchor");
const { Keypair, PublicKey } = scannerRequire("@solana/web3.js");

const BN = anchor.BN || anchor.default?.BN;
if (!BN) {
  throw new Error("anchor BN constructor unavailable");
}

const IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const AUTHORITY_KEYPAIR_PATH =
  process.env.AUTHORITY_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const RPC_URL =
  process.env.OPENJACK_CU_RPC_URL || process.env.RPC_URL || "https://api.devnet.solana.com";
const ROUND_ID = Number(process.env.OPENJACK_BENCH_ROUND_ID || process.env.READY_ROUND_ID || 0);
const BATCH_SIZES = (process.env.OPENJACK_BENCH_BATCH_SIZES || "1,2,3,4,5,6,7")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0);
const RUNS_PER_SIZE = Number(process.env.OPENJACK_BENCH_RUNS_PER_SIZE || 5);

if (!ROUND_ID) {
  throw new Error("OPENJACK_BENCH_ROUND_ID (or READY_ROUND_ID) is required");
}
if (!BATCH_SIZES.length) {
  throw new Error("OPENJACK_BENCH_BATCH_SIZES resolved to empty set");
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

function readKeypair(filePath) {
  const secret = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function deriveRoundPda(programId, roundId) {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync([Buffer.from("round"), le], programId)[0];
}

function hashv(parts) {
  const h = crypto.createHash("sha256");
  for (const part of parts) h.update(Buffer.from(part));
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

function toNumber(value) {
  if (typeof value === "number") return value;
  if (value && typeof value.toNumber === "function") return value.toNumber();
  if (value && typeof value.toString === "function") return Number(value.toString());
  return Number(value);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

async function main() {
  const authority = readKeypair(AUTHORITY_KEYPAIR_PATH);
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const resolvedProgramId = process.env.OPENJACK_PROGRAM_ID || loadProgramIdFromAnchorToml();
  if (!resolvedProgramId) {
    throw new Error("OPENJACK_PROGRAM_ID missing and Anchor.toml has no [programs.devnet].openjack");
  }
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
  const round = await program.account.round.fetch(roundPda);
  const startIndex = toNumber(round.countProgressIndex);
  const ticketCountFrozen = toNumber(round.ticketCountFrozen);
  const remaining = Math.max(0, ticketCountFrozen - startIndex);
  const ticketSetRoot = Buffer.from(round.ticketSetRoot);
  const roundContext = {
    roundId: Number(round.roundId.toString()),
    treeAddress: round.treeAddress,
    ticketCountFrozen,
    closeTs: Number(round.closeTs.toString()),
  };

  const evaluated = [];
  for (const batchLen of BATCH_SIZES) {
    if (batchLen > remaining) {
      evaluated.push({ batchLen, skipped: true, reason: "out_of_bounds_for_current_round_progress" });
      continue;
    }

    const leafProofs = [];
    for (let i = 0; i < batchLen; i += 1) {
      leafProofs.push(derivePrototypeTicketProof(roundContext, startIndex + i));
    }
    const batchHash = deriveCountBatchWorkDigest(ticketSetRoot, startIndex, batchLen, leafProofs);
    const runs = [];
    for (let i = 0; i < RUNS_PER_SIZE; i += 1) {
      const tx = await program.methods
        .countBatch({
          startIndex: new BN(startIndex),
          batchLen: new BN(batchLen),
          batchHash,
          leafProofs,
        })
        .accounts({ round: roundPda })
        .transaction();

      tx.feePayer = wallet.publicKey;
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(authority);

      let sim;
      try {
        sim = await connection.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
        });
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        if (!message.toLowerCase().includes("invalid arguments")) {
          throw error;
        }
        // Some RPC providers reject simulate options; retry with minimal args.
        sim = await connection.simulateTransaction(tx);
      }
      if (sim.value.err) {
        runs.push({ err: sim.value.err, unitsConsumed: null });
      } else {
        runs.push({ err: null, unitsConsumed: Number(sim.value.unitsConsumed ?? 0) });
      }
    }

    const ok = runs.filter((r) => !r.err && Number.isFinite(r.unitsConsumed)).map((r) => r.unitsConsumed);
    evaluated.push({
      batchLen,
      skipped: false,
      runs,
      stats: ok.length
        ? {
            n: ok.length,
            mean: ok.reduce((a, b) => a + b, 0) / ok.length,
            p95: percentile(ok, 95),
            max: Math.max(...ok),
            min: Math.min(...ok),
          }
        : null,
    });
  }

  const all = evaluated
    .filter((e) => !e.skipped && e.stats)
    .flatMap((e) => e.runs.filter((r) => !r.err).map((r) => r.unitsConsumed));
  const worstEntry = evaluated
    .filter((e) => !e.skipped && e.stats)
    .sort((a, b) => (b.stats?.max ?? 0) - (a.stats?.max ?? 0))[0];

  const report = {
    generatedAt: new Date().toISOString(),
    rpcUrl: RPC_URL,
    roundId: ROUND_ID,
    roundPda: roundPda.toBase58(),
    startIndex,
    ticketCountFrozen,
    remaining,
    batchSizesRequested: BATCH_SIZES,
    runsPerSize: RUNS_PER_SIZE,
    evaluated,
    aggregate: all.length
      ? {
          n: all.length,
          mean: all.reduce((a, b) => a + b, 0) / all.length,
          p95: percentile(all, 95),
          max: Math.max(...all),
          min: Math.min(...all),
        }
      : null,
    worstCaseFixture: worstEntry
      ? {
          batchLen: worstEntry.batchLen,
          maxUnitsConsumed: worstEntry.stats.max,
          p95UnitsConsumed: worstEntry.stats.p95,
        }
      : null,
    notes: [
      "Simulation-based CU harness for count_batch membership-verification path.",
      "No transaction state writes are committed via simulateTransaction.",
      "Use a frozen round with remaining ticket_count_frozen > start_index for meaningful samples.",
    ],
  };

  const outDir = path.resolve(process.cwd(), "reports/protocol-gate");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `count-batch-cu-benchmark-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(outPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
