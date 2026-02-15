import fs from "node:fs";
import path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";

const ANCHOR_TOML_PATH = path.resolve(process.cwd(), "Anchor.toml");
const DEFAULT_IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const DEFAULT_KEYPAIR_PATH =
  process.env.SCANNER_KEYPAIR_PATH || path.resolve(process.env.HOME || "", ".config/solana/id.json");

let cached = null;

function loadProgramIdFromAnchorToml() {
  if (!fs.existsSync(ANCHOR_TOML_PATH)) {
    return null;
  }
  const raw = fs.readFileSync(ANCHOR_TOML_PATH, "utf8");
  const devnetSection = raw.match(/\[programs\.devnet\]([\s\S]*?)(?:\n\[|$)/);
  if (!devnetSection) {
    return null;
  }
  const openjackLine = devnetSection[1].match(/^\s*openjack\s*=\s*"([^"]+)"/m);
  return openjackLine?.[1] || null;
}

function readKeypair(filePath) {
  const secret = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function loadIdl() {
  const raw = fs.readFileSync(DEFAULT_IDL_PATH, "utf8");
  return JSON.parse(raw);
}

export function getScannerProgram() {
  if (cached) return cached;

  const keypair = readKeypair(DEFAULT_KEYPAIR_PATH);
  const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";
  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = loadIdl();
  const resolvedProgramId = process.env.OPENJACK_PROGRAM_ID || loadProgramIdFromAnchorToml();
  if (!resolvedProgramId) {
    throw new Error("OPENJACK_PROGRAM_ID is not set and Anchor.toml has no [programs.devnet].openjack");
  }
  const programId = new PublicKey(resolvedProgramId);

  let program;
  try {
    program = new anchor.Program(idl, programId, provider);
  } catch {
    const idlWithAddress = { ...idl, address: programId.toBase58() };
    program = new anchor.Program(idlWithAddress, provider);
  }

  cached = { keypair, connection, wallet, provider, idl, programId, program };
  return cached;
}

export function deriveConfigPda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

export function deriveRoundPda(programId, roundId) {
  return PublicKey.findProgramAddressSync([Buffer.from("round"), toLe8(roundId)], programId)[0];
}

export function deriveBondPda(programId, roundId) {
  return PublicKey.findProgramAddressSync([Buffer.from("bond"), toLe8(roundId)], programId)[0];
}

function toLe8(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

export function hexToU8_32(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = Buffer.from(clean.padStart(64, "0"), "hex");
  if (bytes.length !== 32) {
    throw new Error("expected 32-byte hex");
  }
  return [...bytes];
}

export async function fetchRoundTierPayouts(roundId) {
  const { program, programId } = getScannerProgram();
  const round = deriveRoundPda(programId, roundId);
  const roundAccount = await program.account.round.fetch(round);
  const payouts = roundAccount.tierPayoutPerWinner || [];
  return payouts.map((v) => Number(v.toString()));
}
