import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { confirmSignatureByPolling } from "./lib/confirm-signature-status.mjs";
import { sendAnchorMethodWithPolling } from "./lib/send-anchor-method.mjs";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const anchor = scannerRequire("@coral-xyz/anchor");
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } = scannerRequire("@solana/web3.js");
const COMPRESSION_PROGRAM_ID = new PublicKey("cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK");

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const ANCHOR_TOML_PATH = path.resolve(process.cwd(), "Anchor.toml");
const IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const KEYPAIR_PATH =
  process.env.E2E_KEYPAIR_PATH || path.resolve(process.env.HOME || "", ".config/solana/id.json");
const ROUND_ID = Number(process.env.E2E_ROUND_ID || Math.floor(Date.now() / 1000));
const WAIT_FOR_FINALIZE = process.env.E2E_WAIT_FOR_FINALIZE === "true";
const WAIT_FOR_SWEEP = process.env.E2E_WAIT_FOR_SWEEP === "true";

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

const RESOLVED_PROGRAM_ID = process.env.OPENJACK_PROGRAM_ID || loadProgramIdFromAnchorToml();
if (!RESOLVED_PROGRAM_ID) {
  throw new Error("OPENJACK_PROGRAM_ID is not set and Anchor.toml has no [programs.devnet].openjack");
}
const PROGRAM_ID = new PublicKey(RESOLVED_PROGRAM_ID);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readKeypair(filePath) {
  const secret = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function bytes32FromHex(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const b = Buffer.from(clean.padStart(64, "0"), "hex");
  if (b.length !== 32) throw new Error("expected 32-byte hex");
  return [...b];
}

function ticketProofHash({ roundId, treeAddress, leafIndex, owner, proof }) {
  const hasher = crypto.createHash("sha256");
  const roundIdLe = Buffer.alloc(8);
  roundIdLe.writeBigUInt64LE(BigInt(roundId));
  const le = Buffer.alloc(4);
  le.writeUInt32LE(Number(leafIndex));
  hasher.update(Buffer.from("ticket-proof:"));
  hasher.update(roundIdLe);
  hasher.update(treeAddress.toBuffer());
  hasher.update(le);
  hasher.update(owner.toBuffer());
  for (const node of proof) {
    hasher.update(Buffer.from(node));
  }
  return [...hasher.digest()];
}

function le8(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function le4(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n));
  return b;
}

async function getProgram() {
  const keypair = readKeypair(KEYPAIR_PATH);
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  let program;
  try {
    program = new anchor.Program(idl, PROGRAM_ID, provider);
  } catch {
    program = new anchor.Program({ ...idl, address: PROGRAM_ID.toBase58() }, provider);
  }

  return { keypair, connection, wallet, provider, program };
}

function pdaConfig() {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
}

function pdaRound(roundId) {
  return PublicKey.findProgramAddressSync([Buffer.from("round"), le8(roundId)], PROGRAM_ID)[0];
}

function pdaBond(roundId) {
  return PublicKey.findProgramAddressSync([Buffer.from("bond"), le8(roundId)], PROGRAM_ID)[0];
}

function pdaUserRound(roundId, userPk) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_round"), le8(roundId), userPk.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function pdaClaim(roundId, leafIndex) {
  return PublicKey.findProgramAddressSync([Buffer.from("claim"), le8(roundId), le4(leafIndex)], PROGRAM_ID)[0];
}

async function ensureFunds(connection, pubkey) {
  const balance = await connection.getBalance(pubkey, "confirmed");
  if (balance >= 0.5 * LAMPORTS_PER_SOL) return;
  const sig = await connection.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL);
  await confirmSignatureByPolling(connection, sig);
}

async function assertRpcReachable(connection) {
  try {
    await connection.getLatestBlockhash("confirmed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `RPC not reachable at ${RPC_URL}. Check network access or set RPC_URL to a reachable endpoint. Original error: ${message}`,
    );
  }
}

async function maybeInitConfig(program, walletPk) {
  const config = pdaConfig();
  const existing = await program.provider.connection.getAccountInfo(config, "confirmed");
  if (existing) {
    console.log("config exists", config.toBase58());
    return config;
  }

  const args = {
    treasuryPubkey: walletPk,
    officialScannerPubkey: walletPk,
    vrfCallbackAuthority: walletPk,
    scannerBondLamports: new anchor.BN(100_000),
    scannerSlashLamports: new anchor.BN(10_000),
    solUsdOracle: walletPk,
    oracleMaxAgeSecs: 120,
    ticketPriceUsdCents: 200,
    finderFeeBps: 0,
    cadenceMinGapSecs: 60,
    cadenceMaxGapSecs: 7 * 24 * 3600,
  };

  const sig = await sendAnchorMethodWithPolling(
    program.methods
      .initConfig(args)
      .accounts({
        payer: walletPk,
        config,
        systemProgram: SystemProgram.programId,
      }),
    { connection: program.provider.connection, signer: program.provider.wallet.payer },
  );

  console.log("initConfig", sig);
  return config;
}

async function run() {
  const { program, wallet, connection } = await getProgram();
  const walletPk = wallet.publicKey;

  console.log("RPC", RPC_URL);
  console.log("Program", PROGRAM_ID.toBase58());
  console.log("Wallet", walletPk.toBase58());
  console.log("Round", ROUND_ID);

  await assertRpcReachable(connection);
  await ensureFunds(connection, walletPk);

  const config = await maybeInitConfig(program, walletPk);
  const round = pdaRound(ROUND_ID);
  const bond = pdaBond(ROUND_ID);
  const userRound = pdaUserRound(ROUND_ID, walletPk);

  const now = Math.floor(Date.now() / 1000);
  const openTs = now - 30;
  const closeTs = now + 4;

  const roundExists = await connection.getAccountInfo(round, "confirmed");
  if (!roundExists) {
    const sigCreate = await sendAnchorMethodWithPolling(
      program.methods
        .createRound({
          roundId: new anchor.BN(ROUND_ID),
          openTs: new anchor.BN(openTs),
          closeTs: new anchor.BN(closeTs),
          treeAddress: walletPk,
        })
        .accounts({
          authority: walletPk,
          config,
          round,
          systemProgram: SystemProgram.programId,
        }),
      { connection: program.provider.connection, signer: program.provider.wallet.payer },
    );
    console.log("createRound", sigCreate);
  }

  const sigBuy = await sendAnchorMethodWithPolling(
    program.methods
      .buyTickets({
        tickets: [{ main: [1, 2, 3, 4, 5], bonus: 1 }],
        oraclePriceMicroUsdPerSol: new anchor.BN(20_000_000),
        oraclePublishTs: new anchor.BN(Math.floor(Date.now() / 1000)),
      })
      .accounts({
        buyer: walletPk,
        config,
        round,
        treasury: walletPk,
        oracleFeed: walletPk,
        userRoundStats: userRound,
        systemProgram: SystemProgram.programId,
      }),
    { connection: program.provider.connection, signer: program.provider.wallet.payer },
  );
  console.log("buyTickets", sigBuy);

  console.log("waiting for closeTs...");
  while (Math.floor(Date.now() / 1000) <= closeTs) {
    await sleep(1000);
  }

  const sigClose = await sendAnchorMethodWithPolling(
    program.methods.closeRound().accounts({ round }),
    { connection: program.provider.connection, signer: program.provider.wallet.payer },
  );
  console.log("closeRound", sigClose);

  const vrfRequest = Keypair.generate().publicKey;
  const sigReq = await sendAnchorMethodWithPolling(
    program.methods
      .requestDraw({ vrfRequest })
      .accounts({ config, round }),
    { connection: program.provider.connection, signer: program.provider.wallet.payer },
  );
  console.log("requestDraw", sigReq);

  const vrfSeed = crypto.createHash("sha256").update(`round-${ROUND_ID}`).digest("hex");
  const vrfResult = bytes32FromHex(vrfSeed);
  const sigFulfill = await sendAnchorMethodWithPolling(
    program.methods
      .fulfillDraw({ vrfRequest, vrfResult })
      .accounts({
        config,
        vrfCallbackAuthority: walletPk,
        round,
      }),
    { connection: program.provider.connection, signer: program.provider.wallet.payer },
  );
  console.log("fulfillDraw", sigFulfill);

  const sigBond = await sendAnchorMethodWithPolling(
    program.methods
      .postScannerBond()
      .accounts({
        scanner: walletPk,
        config,
        round,
        scannerBond: bond,
        systemProgram: SystemProgram.programId,
      }),
    { connection: program.provider.connection, signer: program.provider.wallet.payer },
  );
  console.log("postScannerBond", sigBond);

  const commitmentHash = bytes32FromHex(crypto.createHash("sha256").update(`commit-${ROUND_ID}`).digest("hex"));
  const rootHash = bytes32FromHex(crypto.createHash("sha256").update(`tier0-${ROUND_ID}`).digest("hex"));
  const sigRoot = await sendAnchorMethodWithPolling(
    program.methods
      .publishWinnerRoot({
        tier: 0,
        rootHash,
        winnerCount: 1,
        observedTicketCount: 1,
        commitmentHash,
      })
      .accounts({
        scanner: walletPk,
        config,
        round,
        scannerBond: bond,
      }),
    { connection: program.provider.connection, signer: program.provider.wallet.payer },
  );
  console.log("publishWinnerRoot", sigRoot);

  if (!WAIT_FOR_FINALIZE) {
    console.log("E2E_WAIT_FOR_FINALIZE=false -> stopping at SETTLING stage.");
    console.log("Set E2E_WAIT_FOR_FINALIZE=true to wait 1h and continue finalize/claim.");
    return;
  }

  console.log("Waiting for settlement window to close (about 1 hour)...");
  await sleep(3605 * 1000);

  const sigFinalize = await sendAnchorMethodWithPolling(
    program.methods.finalizePrizes().accounts({ round }),
    { connection: program.provider.connection, signer: program.provider.wallet.payer },
  );
  console.log("finalizePrizes", sigFinalize);

  const roundAccount = await program.account.round.fetch(round);
  const claimAmount = Number(roundAccount.tierPayoutPerWinner[0].toString());

  const sigClaim = await sendAnchorMethodWithPolling(
    program.methods
      .claim({
        leafIndex: 0,
        tier: 0,
        amount: new anchor.BN(claimAmount),
        ticketOwner: walletPk,
        compressionRoot: rootHash,
        compressionLeaf: rootHash,
        compressionIndex: 0,
        ticketProofHash: ticketProofHash({
          roundId: ROUND_ID,
          treeAddress: walletPk,
          leafIndex: 0,
          owner: walletPk,
          proof: [rootHash],
        }),
        ticketProof: [rootHash],
        winnerRootHash: rootHash,
        winnerRootProof: [],
      })
      .accounts({
        claimer: walletPk,
        round,
        claimRecord: pdaClaim(ROUND_ID, 0),
        merkleTree: walletPk,
        compressionProgram: COMPRESSION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: new PublicKey(Buffer.from(rootHash)), isSigner: false, isWritable: false }]),
    { connection: program.provider.connection, signer: program.provider.wallet.payer },
  );
  console.log("claim", sigClaim);

  if (!WAIT_FOR_SWEEP) {
    console.log("E2E_WAIT_FOR_SWEEP=false -> skipping sweep (requires +30 days).");
    return;
  }

  console.log("Sweep requires finalized_ts + 30 days; run later:");
  console.log("program.methods.sweepWinnersToUnclaimed().accounts({ round }) (send via sendAnchorMethodWithPolling)");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
