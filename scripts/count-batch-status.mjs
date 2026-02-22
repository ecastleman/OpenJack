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

if (!ROUND_ID) throw new Error("OPENJACK_BENCH_ROUND_ID (or READY_ROUND_ID) is required");

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

function mapResultCode(code) {
  switch (Number(code || 0)) {
    case 1:
      return "Accepted";
    case 2:
      return "NoopReplay";
    default:
      return "None";
  }
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
  const round = await program.account.round.fetch(roundPda);
  const processed = Number(round.countProgressIndex?.toString?.() ?? 0);
  const total = Number(round.ticketCountFrozen?.toString?.() ?? 0);
  const remaining = Math.max(0, total - processed);
  const pct = total > 0 ? ((processed / total) * 100).toFixed(2) : "0.00";
  const lastResult = mapResultCode(round.countLastResultCode);
  const resultCount = Number(round.countLastResultCount?.toString?.() ?? 0);

  console.log(
    `COUNTING: ${processed}/${total} (${pct}%) remaining=${remaining} lastResult=${lastResult} resultCount=${resultCount}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
