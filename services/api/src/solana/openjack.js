import fs from "node:fs";
import path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { fileURLToPath } from "node:url";

const ANCHOR_TOML_PATH = path.resolve(process.cwd(), "Anchor.toml");
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "../../../..");
const IDL_PATH_CANDIDATES = [
  process.env.OPENJACK_IDL_PATH,
  path.resolve(process.cwd(), "target/idl/openjack.json"),
  path.resolve(REPO_ROOT, "target/idl/openjack.json"),
].filter(Boolean);

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

export function getConnection() {
  const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";
  return new anchor.web3.Connection(rpcUrl, "confirmed");
}

function loadIdl() {
  const idlPath = IDL_PATH_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!idlPath) {
    throw new Error(
      `IDL not found; checked: ${IDL_PATH_CANDIDATES.join(", ")}. Set OPENJACK_IDL_PATH to a valid openjack.json`,
    );
  }
  const raw = fs.readFileSync(idlPath, "utf8");
  return JSON.parse(raw);
}

export function getProgramForBuilder() {
  if (cached) return cached;

  const connection = getConnection();
  const provider = new anchor.AnchorProvider(
    connection,
    {
      publicKey: new PublicKey("11111111111111111111111111111111"),
      signAllTransactions: async (txs) => txs,
      signTransaction: async (tx) => tx,
    },
    { commitment: "confirmed" },
  );

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

  cached = { connection, provider, idl, program, programId };
  return cached;
}

export function deriveRoundPda(programId, roundId) {
  return PublicKey.findProgramAddressSync([Buffer.from("round"), toLe8(roundId)], programId)[0];
}

export function deriveConfigPda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

export function deriveUserRoundPda(programId, roundId, wallet) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_round"), toLe8(roundId), new PublicKey(wallet).toBuffer()],
    programId,
  )[0];
}

export function deriveClaimRecordPda(programId, roundId, leafIndex) {
  return PublicKey.findProgramAddressSync([Buffer.from("claim"), toLe8(roundId), toLe4(leafIndex)], programId)[0];
}

export function hexToU8_32(hex) {
  const clean = String(hex || "").startsWith("0x") ? String(hex).slice(2) : String(hex || "");
  const bytes = Buffer.from(clean.padStart(64, "0"), "hex");
  if (bytes.length !== 32) {
    throw new Error("expected 32-byte hex");
  }
  return [...bytes];
}

export function bytes32FromHexOrBase58(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("expected 32-byte hex or base58");
  }
  const clean = raw.startsWith("0x") ? raw.slice(2) : raw;
  const looksHex = /^[0-9a-fA-F]+$/.test(clean);
  if (looksHex && clean.length <= 64) {
    return hexToU8_32(clean);
  }
  try {
    const pk = new PublicKey(raw);
    const bytes = pk.toBytes();
    if (bytes.length !== 32) {
      throw new Error("expected 32-byte hex or base58");
    }
    return [...bytes];
  } catch {
    throw new Error("expected 32-byte hex or base58");
  }
}

function toLe8(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function toLe4(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(value));
  return b;
}
