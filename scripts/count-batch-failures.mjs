import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const anchor = scannerRequire("@coral-xyz/anchor");
const { Keypair, PublicKey } = scannerRequire("@solana/web3.js");

const IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const AUTHORITY_KEYPAIR_PATH =
  process.env.AUTHORITY_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const ROUND_ID = Number(process.env.OPENJACK_BENCH_ROUND_ID || process.env.READY_ROUND_ID || 0);
const LIMIT = Number(process.env.OPENJACK_COUNT_FAIL_LIMIT || 100);

if (!ROUND_ID) throw new Error("OPENJACK_BENCH_ROUND_ID (or READY_ROUND_ID) is required");
if (!Number.isFinite(LIMIT) || LIMIT <= 0) throw new Error("OPENJACK_COUNT_FAIL_LIMIT must be > 0");

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

function buildErrorMap(idl) {
  const map = new Map();
  for (const entry of idl.errors || []) {
    if (typeof entry.code === "number" && entry.name) {
      map.set(entry.code, entry.name);
    }
  }
  return map;
}

function parseErrorClass(tx, errorMap) {
  const logs = tx?.meta?.logMessages || [];
  const anchorMatch = logs
    .map((line) => line.match(/Error Code:\s*([A-Za-z0-9_]+)/))
    .find(Boolean);
  if (anchorMatch?.[1]) return anchorMatch[1];

  const instructionError = tx?.meta?.err?.InstructionError;
  if (Array.isArray(instructionError) && instructionError.length === 2) {
    const detail = instructionError[1];
    if (detail && typeof detail === "object" && typeof detail.Custom === "number") {
      return errorMap.get(detail.Custom) || `Custom(${detail.Custom})`;
    }
  }

  return "UnknownFailure";
}

function isFailedCountBatchForProgram(tx, programId) {
  if (!tx?.meta?.err) return false;
  const logs = tx?.meta?.logMessages || [];
  const hasCountBatchIx = logs.some((line) => line.includes("Instruction: CountBatch"));
  const hasProgram = logs.some((line) => line.includes(`Program ${programId.toBase58()} `));
  return hasCountBatchIx && hasProgram;
}

async function main() {
  const authority = readKeypair(AUTHORITY_KEYPAIR_PATH);
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const errorMap = buildErrorMap(idl);
  const resolvedProgramId = process.env.OPENJACK_PROGRAM_ID || loadProgramIdFromAnchorToml();
  if (!resolvedProgramId) throw new Error("OPENJACK_PROGRAM_ID missing and Anchor.toml has no [programs.devnet].openjack");
  const programId = new PublicKey(resolvedProgramId);

  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  // Keep provider construction for parity with sibling scripts even though this script only needs connection.
  void provider;

  const roundPda = deriveRoundPda(programId, ROUND_ID);
  const signatures = await connection.getSignaturesForAddress(roundPda, { limit: LIMIT }, "confirmed");
  const failed = [];

  for (const sig of signatures) {
    const tx = await connection.getTransaction(sig.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!isFailedCountBatchForProgram(tx, programId)) continue;
    const errorClass = parseErrorClass(tx, errorMap);
    failed.push({
      signature: sig.signature,
      slot: sig.slot,
      blockTime: sig.blockTime,
      errorClass,
    });
  }

  const counts = new Map();
  for (const item of failed) {
    counts.set(item.errorClass, (counts.get(item.errorClass) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const summary = sorted.map(([k, v]) => `${k}=${v}`).join(",");
  const latest = failed[0]?.errorClass || "None";

  console.log(
    `COUNT_BATCH_FAILS: round=${ROUND_ID} inspected=${signatures.length} failed=${failed.length} latest=${latest} classes=${summary || "None"}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
