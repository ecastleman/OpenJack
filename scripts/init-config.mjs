import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { sendAnchorMethodWithPolling } from "./lib/send-anchor-method.mjs";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const anchor = scannerRequire("@coral-xyz/anchor");
const { Keypair, PublicKey, SystemProgram } = scannerRequire("@solana/web3.js");

const ANCHOR_TOML_PATH = path.resolve(process.cwd(), "Anchor.toml");
const IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const AUTHORITY_KEYPAIR_PATH =
  process.env.AUTHORITY_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const SCANNER_KEYPAIR_PATH =
  process.env.SCANNER_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

function loadProgramIdFromAnchorToml() {
  if (!fs.existsSync(ANCHOR_TOML_PATH)) {
    return null;
  }
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

async function main() {
  const authority = readKeypair(AUTHORITY_KEYPAIR_PATH);
  const scanner = readKeypair(SCANNER_KEYPAIR_PATH).publicKey;
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
  const existing = await connection.getAccountInfo(config, "confirmed");
  if (existing) {
    console.log(`config already initialized: ${config.toBase58()}`);
    return;
  }

  const treasuryPubkey = process.env.OPENJACK_TREASURY_PUBKEY
    ? new PublicKey(process.env.OPENJACK_TREASURY_PUBKEY)
    : authority.publicKey;
  const oraclePubkey = process.env.OPENJACK_ORACLE_PUBKEY
    ? new PublicKey(process.env.OPENJACK_ORACLE_PUBKEY)
    : SystemProgram.programId;
  const vrfCallbackAuthority = process.env.VRF_CALLBACK_PUBKEY
    ? new PublicKey(process.env.VRF_CALLBACK_PUBKEY)
    : authority.publicKey;

  const scannerBondLamports = Number(process.env.OPENJACK_SCANNER_BOND_LAMPORTS || 1_000_000);
  const scannerSlashLamports = Number(process.env.OPENJACK_SCANNER_SLASH_LAMPORTS || 100_000);
  const oracleMaxAgeSecs = Number(process.env.OPENJACK_ORACLE_MAX_AGE_SECS || 600);
  const ticketPriceUsdCents = Number(process.env.OPENJACK_TICKET_PRICE_USD_CENTS || 200);
  const finderFeeBps = Number(process.env.OPENJACK_FINDER_FEE_BPS || 0);
  const cadenceMinGapSecs = Number(process.env.OPENJACK_CADENCE_MIN_GAP_SECS || 172_800);
  const cadenceMaxGapSecs = Number(process.env.OPENJACK_CADENCE_MAX_GAP_SECS || 345_600);

  const sig = await sendAnchorMethodWithPolling(
    program.methods
      .initConfig({
        treasuryPubkey,
        officialScannerPubkey: scanner,
        vrfCallbackAuthority,
        scannerBondLamports: new anchor.BN(scannerBondLamports),
        scannerSlashLamports: new anchor.BN(scannerSlashLamports),
        solUsdOracle: oraclePubkey,
        oracleMaxAgeSecs,
        ticketPriceUsdCents,
        finderFeeBps,
        cadenceMinGapSecs,
        cadenceMaxGapSecs,
      })
      .accounts({
        payer: wallet.publicKey,
        config,
        systemProgram: SystemProgram.programId,
      }),
    { connection, signer: authority },
  );

  console.log(`init_config sig=${sig}`);
  console.log(`config=${config.toBase58()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
