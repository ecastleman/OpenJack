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
if (!BN) throw new Error("anchor BN constructor unavailable");

const IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const AUTHORITY_KEYPAIR_PATH =
  process.env.AUTHORITY_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const ROUND_ID = Number(process.env.OPENJACK_BENCH_ROUND_ID || process.env.READY_ROUND_ID || 0);
const BATCH_LEN = Number(process.env.OPENJACK_COUNT_BATCH_LEN || 6);
const DRY_RUN = String(process.env.OPENJACK_COUNT_BATCH_DRY_RUN || "false").toLowerCase() === "true";

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

  if (DRY_RUN) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          roundId: ROUND_ID,
          roundPda: roundPda.toBase58(),
          ticketCountFrozen,
          countProgressIndex: progress,
          remaining: Math.max(0, ticketCountFrozen - progress),
          batchLen: BATCH_LEN,
        },
        null,
        2,
      ),
    );
    return;
  }

  while (progress < ticketCountFrozen) {
    const batchLen = Math.min(BATCH_LEN, ticketCountFrozen - progress);
    const leafProofs = [];
    for (let i = 0; i < batchLen; i += 1) {
      leafProofs.push(derivePrototypeTicketProof(roundContext, progress + i));
    }
    const batchHash = deriveCountBatchWorkDigest(ticketSetRoot, progress, batchLen, leafProofs);
    const sig = await program.methods
      .countBatch({
        startIndex: new BN(progress),
        batchLen: new BN(batchLen),
        batchHash,
        leafProofs,
      })
      .accounts({ round: roundPda })
      .rpc();
    round = await program.account.round.fetch(roundPda);
    progress = Number(round.countProgressIndex.toString());
    console.log(`[count-batch] sig=${sig} progress=${progress}/${ticketCountFrozen} batch_len=${batchLen}`);
  }

  console.log(
    JSON.stringify(
      {
        roundId: ROUND_ID,
        roundPda: roundPda.toBase58(),
        ticketCountFrozen,
        countProgressIndex: progress,
        countFinalized: Boolean(round.countFinalized),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
