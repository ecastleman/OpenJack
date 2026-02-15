import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

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
const CALLBACK_KEYPAIR_PATH =
  process.env.VRF_CALLBACK_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

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

function num(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v?.toString === "function") return Number(v.toString());
  return Number(v);
}

function pass(label, actual) {
  console.log(`PASS  ${label} - ${actual}`);
}

function fail(label, expected, actual) {
  console.log(`FAIL  ${label} - expected=${expected} actual=${actual}`);
}

async function main() {
  const authority = readKeypair(AUTHORITY_KEYPAIR_PATH).publicKey;
  const scanner = process.env.SCANNER_PUBKEY
    ? new PublicKey(process.env.SCANNER_PUBKEY)
    : readKeypair(SCANNER_KEYPAIR_PATH).publicKey;
  const callback = process.env.VRF_CALLBACK_PUBKEY
    ? new PublicKey(process.env.VRF_CALLBACK_PUBKEY)
    : readKeypair(CALLBACK_KEYPAIR_PATH).publicKey;
  const treasury = process.env.OPENJACK_TREASURY_PUBKEY
    ? new PublicKey(process.env.OPENJACK_TREASURY_PUBKEY)
    : authority;
  const oracle = process.env.OPENJACK_ORACLE_PUBKEY
    ? new PublicKey(process.env.OPENJACK_ORACLE_PUBKEY)
    : SystemProgram.programId;

  const expected = {
    authority: authority.toBase58(),
    scanner: scanner.toBase58(),
    callback: callback.toBase58(),
    treasury: treasury.toBase58(),
    oracle: oracle.toBase58(),
    oracleMaxAge: Number(process.env.OPENJACK_ORACLE_MAX_AGE_SECS || 600),
    ticketPrice: Number(process.env.OPENJACK_TICKET_PRICE_USD_CENTS || 200),
  };

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const resolvedProgramId = process.env.OPENJACK_PROGRAM_ID || loadProgramIdFromAnchorToml();
  if (!resolvedProgramId) {
    throw new Error("OPENJACK_PROGRAM_ID missing and Anchor.toml has no [programs.devnet].openjack");
  }
  const programId = new PublicKey(resolvedProgramId);
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(readKeypair(AUTHORITY_KEYPAIR_PATH));
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  let program;
  try {
    program = new anchor.Program(idl, programId, provider);
  } catch {
    program = new anchor.Program({ ...idl, address: programId.toBase58() }, provider);
  }

  const config = deriveConfigPda(programId);
  const cfg = await program.account.lotteryConfig.fetch(config).catch(() => null);
  if (!cfg) {
    console.log(`FAIL  config_account - missing at ${config.toBase58()}`);
    process.exit(1);
  }

  console.log(`Config verify for program=${programId.toBase58()} config=${config.toBase58()}`);
  let failures = 0;

  const checks = [
    ["authority", expected.authority, (cfg.authority || "").toBase58?.() || String(cfg.authority || "")],
    [
      "treasury_pubkey",
      expected.treasury,
      (cfg.treasuryPubkey || cfg.treasury_pubkey || "").toBase58?.() ||
        String(cfg.treasuryPubkey || cfg.treasury_pubkey || ""),
    ],
    [
      "official_scanner_pubkey",
      expected.scanner,
      (cfg.officialScannerPubkey || cfg.official_scanner_pubkey || "").toBase58?.() ||
        String(cfg.officialScannerPubkey || cfg.official_scanner_pubkey || ""),
    ],
    [
      "vrf_callback_authority",
      expected.callback,
      (cfg.vrfCallbackAuthority || cfg.vrf_callback_authority || "").toBase58?.() ||
        String(cfg.vrfCallbackAuthority || cfg.vrf_callback_authority || ""),
    ],
    [
      "sol_usd_oracle",
      expected.oracle,
      (cfg.solUsdOracle || cfg.sol_usd_oracle || "").toBase58?.() ||
        String(cfg.solUsdOracle || cfg.sol_usd_oracle || ""),
    ],
    ["oracle_max_age_secs", expected.oracleMaxAge, num(cfg.oracleMaxAgeSecs ?? cfg.oracle_max_age_secs)],
    ["ticket_price_usd_cents", expected.ticketPrice, num(cfg.ticketPriceUsdCents ?? cfg.ticket_price_usd_cents)],
  ];

  for (const [label, exp, act] of checks) {
    if (String(exp) === String(act)) {
      pass(label, act);
    } else {
      failures += 1;
      fail(label, exp, act);
    }
  }

  if (failures > 0) {
    console.log(`NOT_READY config failures=${failures}`);
    process.exit(1);
  }

  console.log("READY config ok");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

