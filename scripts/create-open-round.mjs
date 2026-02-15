import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const anchor = scannerRequire("@coral-xyz/anchor");
const { Keypair, PublicKey, SystemProgram } = scannerRequire("@solana/web3.js");

const BN = anchor.BN || anchor.default?.BN;
if (!BN) {
  throw new Error("anchor BN constructor unavailable");
}

const ANCHOR_TOML_PATH = path.resolve(process.cwd(), "Anchor.toml");
const IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const AUTHORITY_KEYPAIR_PATH =
  process.env.AUTHORITY_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

const ROUND_ID = Number(process.env.OPENJACK_NEW_ROUND_ID || Math.floor(Date.now() / 1000));
const OPEN_OFFSET_SECS = Number(process.env.OPENJACK_OPEN_OFFSET_SECS || -30);
const CLOSE_IN_SECS = Number(process.env.OPENJACK_CLOSE_IN_SECS || 900);

function loadProgramIdFromAnchorToml() {
  if (!fs.existsSync(ANCHOR_TOML_PATH)) return null;
  const raw = fs.readFileSync(ANCHOR_TOML_PATH, "utf8");
  const devnetSection = raw.match(/\[programs\.devnet\]([\s\S]*?)(?:\n\[|$)/);
  if (!devnetSection) return null;
  const openjackLine = devnetSection[1].match(/^\s*openjack\s*=\s*"([^"]+)"/m);
  return openjackLine?.[1] || null;
}

function readKeypair(filePath) {
  const secret = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function deriveConfigPda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

function deriveRoundPda(programId, roundId) {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync([Buffer.from("round"), le], programId)[0];
}

async function main() {
  const authority = readKeypair(AUTHORITY_KEYPAIR_PATH);
  let treeAddress = process.env.OPENJACK_TREE_ADDRESS ? new PublicKey(process.env.OPENJACK_TREE_ADDRESS) : null;
  let treeConfigAddress = process.env.OPENJACK_TREE_CONFIG_ADDRESS || null;

  if (!treeAddress && process.env.OPENJACK_CNFT_MINT_ENABLED === "true") {
    const initTree = spawnSync("node", ["scripts/init-cnft-tree.mjs", "--json"], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    });
    if (initTree.status !== 0) {
      const stderr = (initTree.stderr || "").trim();
      throw new Error(stderr || "failed to initialize cNFT tree");
    }
    const parsed = JSON.parse((initTree.stdout || "").trim());
    treeAddress = new PublicKey(parsed.treeAddress);
    treeConfigAddress = parsed.treeConfigAddress || treeConfigAddress;
    process.env.OPENJACK_TREE_ADDRESS = treeAddress.toBase58();
    if (treeConfigAddress) {
      process.env.OPENJACK_TREE_CONFIG_ADDRESS = treeConfigAddress;
    }
  }
  if (!treeAddress) {
    treeAddress = authority.publicKey;
  }
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

  const config = deriveConfigPda(programId);
  const round = deriveRoundPda(programId, ROUND_ID);
  const existing = await connection.getAccountInfo(round, "confirmed");
  if (existing) {
    throw new Error(`round already exists: ${ROUND_ID}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const openTs = now + OPEN_OFFSET_SECS;
  const closeTs = now + CLOSE_IN_SECS;

  const sig = await program.methods
    .createRound({
      roundId: new BN(ROUND_ID),
      openTs: new BN(openTs),
      closeTs: new BN(closeTs),
      treeAddress,
    })
    .accounts({
      authority: wallet.publicKey,
      config,
      round,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`create_round sig=${sig}`);
  console.log(`round_id=${ROUND_ID}`);
  console.log(`round_pda=${round.toBase58()}`);
  console.log(`open_ts=${openTs} close_ts=${closeTs}`);
  console.log(`tree_address=${treeAddress.toBase58()}`);
  if (treeConfigAddress) {
    console.log(`tree_config=${treeConfigAddress}`);
  }
  console.log("");
  console.log("Use this round in local services:");
  console.log(`export OPENJACK_KEEPER_ROUND_ID=${ROUND_ID}`);
  console.log(`export OPENJACK_SCAN_ROUND_ID=${ROUND_ID}`);
  console.log(`export READY_ROUND_ID=${ROUND_ID}`);
  console.log(`export SMOKE_ROUND_ID=${ROUND_ID}`);
  console.log(`export OPENJACK_TREE_ADDRESS=${treeAddress.toBase58()}`);
  if (treeConfigAddress) {
    console.log(`export OPENJACK_TREE_CONFIG_ADDRESS=${treeConfigAddress}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
