import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const anchor = scannerRequire("@coral-xyz/anchor");
const { Ed25519Program, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } = scannerRequire("@solana/web3.js");

const BN = anchor.BN || anchor.default?.BN;
if (!BN) throw new Error("anchor BN constructor unavailable");

const IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const AUTHORITY_KEYPAIR_PATH =
  process.env.AUTHORITY_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const ROUND_ID = Number(process.env.OPENJACK_BENCH_ROUND_ID || process.env.READY_ROUND_ID || 0);
const CU_RUNS = Number(process.env.OPENJACK_FAST_PATH_CU_RUNS || 30);

if (!ROUND_ID) throw new Error("OPENJACK_BENCH_ROUND_ID (or READY_ROUND_ID) is required");

function hashv(parts) {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(Buffer.from(p));
  return h.digest();
}

function deriveMockPublicInputsDigest(round, tierWinnerCounts, verifierPubkey) {
  const tierCounts = Buffer.alloc(24);
  tierWinnerCounts.forEach((c, i) => tierCounts.writeUInt32LE(c, i * 4));
  const roundId = Buffer.alloc(8);
  roundId.writeBigUInt64LE(BigInt(round.roundId), 0);
  const ticketCount = Buffer.alloc(4);
  ticketCount.writeUInt32LE(Number(round.ticketCountFrozen), 0);
  return hashv([
    Buffer.from("openjack:prototype:fast_path:public_inputs:v1"),
    roundId,
    Buffer.from(round.ticketSetRoot),
    ticketCount,
    Buffer.from(round.winningMain),
    Buffer.from([round.winningBonus]),
    tierCounts,
    Buffer.from(verifierPubkey.toBytes()),
  ]);
}

function deriveMockProofDigest(mockPublicInputs) {
  return hashv([
    Buffer.from("openjack:prototype:fast_path:proof:v1"),
    mockPublicInputs,
  ]);
}

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

function deriveConfigPda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

function mutateCase(baseArgs, mode) {
  const args = JSON.parse(JSON.stringify(baseArgs));
  const bump32 = (arr) => {
    const next = [...arr];
    next[0] = (next[0] + 1) % 256;
    return next;
  };
  switch (mode) {
    case "round_id":
      args.roundId = String(BigInt(args.roundId) + 1n);
      break;
    case "ticket_set_root":
      args.ticketSetRoot = bump32(args.ticketSetRoot);
      break;
    case "ticket_count_frozen":
      args.ticketCountFrozen += 1;
      break;
    case "winning_main":
      args.winningMain = [2, 4, 6, 8, 10];
      break;
    case "winning_bonus":
      args.winningBonus = ((args.winningBonus % 10) + 1);
      break;
    case "mock_public_inputs":
      args.mockPublicInputs = bump32(args.mockPublicInputs);
      break;
    case "mock_proof":
      args.mockProof = bump32(args.mockProof);
      break;
    case "verifier_false":
      args.mockVerifierOk = false;
      break;
    default:
      break;
  }
  return args;
}

async function simulate(program, authority, roundPda, args, verifierMode = "match") {
  const tx = await program.methods.finalizeCountsFastPath({
    roundId: new BN(args.roundId),
    ticketSetRoot: args.ticketSetRoot,
    ticketCountFrozen: new BN(args.ticketCountFrozen),
    winningMain: args.winningMain,
    winningBonus: args.winningBonus,
    tierWinnerCounts: args.tierWinnerCounts.map((x) => new BN(x)),
    verifierPubkey: new PublicKey(args.verifierPubkey),
    mockPublicInputs: args.mockPublicInputs,
    mockProof: args.mockProof,
    mockVerifierOk: args.mockVerifierOk,
  }).accounts({
    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    round: roundPda,
  }).transaction();

  const signer = verifierMode === "pubkey_mismatch" ? Keypair.generate() : authority;
  const message =
    verifierMode === "message_mismatch"
      ? Uint8Array.from(
          Uint8Array.from(args.mockPublicInputs).map((b, i) => (i === 0 ? (b + 1) % 256 : b))
        )
      : Uint8Array.from(args.mockPublicInputs);
  const proofStart = Date.now();
  const verifyIx = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: signer.secretKey,
    message,
  });
  const proofPrepMs = Date.now() - proofStart;
  tx.instructions.unshift(verifyIx);

  tx.feePayer = authority.publicKey;
  const { blockhash } = await program.provider.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(authority);

  let sim;
  try {
    sim = await program.provider.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (!message.toLowerCase().includes("invalid arguments")) {
      throw error;
    }
    sim = await program.provider.connection.simulateTransaction(tx);
  }
  const logs = sim.value?.logs || [];
  const err = sim.value?.err || null;
  return {
    ok: !err,
    err,
    unitsConsumed: sim.value?.unitsConsumed ?? null,
    proofPrepMs,
    logs,
  };
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
  const configPda = deriveConfigPda(programId);
  await program.account.lotteryConfig.fetch(configPda);
  const round = await program.account.round.fetch(roundPda);
  const status = Number(round.status);
  if (status !== 6) {
    throw new Error(`round ${ROUND_ID} must be CLOSED_FROZEN (status=6), got ${status}`);
  }

  const tierWinnerCounts = [3, 2, 1, 0, 0, 0];
  const verifierPubkey = authority.publicKey;
  const mockPublicInputs = deriveMockPublicInputsDigest(round, tierWinnerCounts, verifierPubkey);
  const mockProof = deriveMockProofDigest(mockPublicInputs);

  const baseArgs = {
    roundId: round.roundId.toString(),
    ticketSetRoot: [...round.ticketSetRoot],
    ticketCountFrozen: Number(round.ticketCountFrozen),
    winningMain: [...round.winningMain],
    winningBonus: round.winningBonus,
    tierWinnerCounts,
    verifierPubkey: verifierPubkey.toBase58(),
    mockPublicInputs: [...mockPublicInputs],
    mockProof: [...mockProof],
    mockVerifierOk: true,
  };

  const scenarios = [
    { name: "positive", mode: "positive" },
    { name: "mismatch_round_id", mode: "round_id" },
    { name: "mismatch_ticket_set_root", mode: "ticket_set_root" },
    { name: "mismatch_ticket_count", mode: "ticket_count_frozen" },
    { name: "mismatch_winning_main", mode: "winning_main" },
    { name: "mismatch_winning_bonus", mode: "winning_bonus" },
    { name: "mismatch_mock_public_inputs", mode: "mock_public_inputs" },
    { name: "mismatch_mock_proof", mode: "mock_proof" },
    { name: "mismatch_verifier_pubkey", mode: "positive", verifierMode: "pubkey_mismatch" },
    { name: "mismatch_verifier_message", mode: "positive", verifierMode: "message_mismatch" },
    { name: "verifier_false", mode: "verifier_false" },
  ];

  const results = [];
  for (const s of scenarios) {
    const args = s.mode === "positive" ? baseArgs : mutateCase(baseArgs, s.mode);
    const result = await simulate(
      program,
      authority,
      roundPda,
      args,
      s.verifierMode || "match"
    );
    results.push({ scenario: s.name, ...result });
  }

  const benchmarkRuns = [];
  for (let i = 0; i < CU_RUNS; i += 1) {
    benchmarkRuns.push(await simulate(program, authority, roundPda, baseArgs));
  }
  const benchSuccess = benchmarkRuns.filter((r) => r.ok);
  const cuValues = benchSuccess.map((r) => r.unitsConsumed).filter((v) => Number.isFinite(v));
  const proofMsValues = benchmarkRuns
    .map((r) => r.proofPrepMs)
    .filter((v) => Number.isFinite(v));
  const benchmark = {
    runs: CU_RUNS,
    okRuns: benchSuccess.length,
    failedRuns: CU_RUNS - benchSuccess.length,
    cu: {
      mean: cuValues.length ? cuValues.reduce((a, b) => a + b, 0) / cuValues.length : null,
      p95: percentile(cuValues, 95),
      max: cuValues.length ? Math.max(...cuValues) : null,
      min: cuValues.length ? Math.min(...cuValues) : null,
    },
    proofPrepMs: {
      mean: proofMsValues.length
        ? proofMsValues.reduce((a, b) => a + b, 0) / proofMsValues.length
        : null,
      p95: percentile(proofMsValues, 95),
      max: proofMsValues.length ? Math.max(...proofMsValues) : null,
      min: proofMsValues.length ? Math.min(...proofMsValues) : null,
    },
  };

  const out = {
    generatedAt: new Date().toISOString(),
    rpcUrl: RPC_URL,
    programId: programId.toBase58(),
    configPda: configPda.toBase58(),
    roundId: ROUND_ID,
    roundPda: roundPda.toBase58(),
    results,
    benchmark,
  };

  const outDir = path.resolve(process.cwd(), "reports/protocol-gate");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `fast-path-mock-harness-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(outPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
