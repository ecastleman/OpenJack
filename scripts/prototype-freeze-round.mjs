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
if (!BN) throw new Error("anchor BN constructor unavailable");

const IDL_PATH = process.env.OPENJACK_IDL_PATH || path.resolve(process.cwd(), "target/idl/openjack.json");
const AUTHORITY_KEYPAIR_PATH =
  process.env.AUTHORITY_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const READ_RPC_URL = process.env.OPENJACK_READ_RPC_URL || RPC_URL;
const ROUND_ID = Number(process.env.OPENJACK_PROTOTYPE_ROUND_ID || process.env.READY_ROUND_ID || Math.floor(Date.now() / 1000));
const OPEN_OFFSET_SECS = Number(process.env.OPENJACK_OPEN_OFFSET_SECS || -30);
const CLOSE_IN_SECS = Number(process.env.OPENJACK_CLOSE_IN_SECS || 300);
const BUY_TICKETS = Number(process.env.OPENJACK_PROTOTYPE_BUY_TICKETS || 10);
const BUY_TICKETS_PER_TX = Number(process.env.OPENJACK_PROTOTYPE_BUY_TICKETS_PER_TX || 2);
const ORACLE_PRICE_MICRO_USD_PER_SOL = Number(process.env.OPENJACK_ORACLE_PRICE_MICRO_USD_PER_SOL || 20_000_000);
const ORACLE_PUBLISH_OFFSET_SECS = Number(process.env.OPENJACK_ORACLE_PUBLISH_OFFSET_SECS || -30);
const TX_MAX_ATTEMPTS = Number(process.env.OPENJACK_TX_MAX_ATTEMPTS || 3);
const TX_BACKOFF_MS = Number(process.env.OPENJACK_TX_BACKOFF_MS || 1500);
const STATE_POLL_MS = Number(process.env.OPENJACK_STATE_POLL_MS || 1500);
const STATE_POLL_TIMEOUT_MS = Number(process.env.OPENJACK_STATE_POLL_TIMEOUT_MS || 180_000);

const STATUS = {
  0: "OPEN",
  1: "CLOSED",
  2: "DRAWING",
  3: "SETTLING",
  4: "FINALIZED",
  5: "CLOSED_PENDING_FREEZE",
  6: "CLOSED_FROZEN",
};

const BUBBLEGUM_PROGRAM_ID = new PublicKey("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");
const COMPRESSION_PROGRAM_ID = new PublicKey("cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK");
const LOG_WRAPPER_PROGRAM_ID = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");

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

function deriveConfigPda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

function deriveRoundPda(programId, roundId) {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync([Buffer.from("round"), le], programId)[0];
}

function deriveUserRoundPda(programId, roundId, buyer) {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(roundId));
  return PublicKey.findProgramAddressSync([Buffer.from("user_round"), le, buyer.toBuffer()], programId)[0];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, conditionFn, timeoutMs = STATE_POLL_TIMEOUT_MS, pollMs = STATE_POLL_MS) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const res = await conditionFn();
    if (res) return res;
    await sleep(pollMs);
  }
  throw new Error(`timeout_waiting_for_${label}`);
}

function randomTicket(seed) {
  const pool = Array.from({ length: 50 }, (_, i) => i + 1);
  const main = [];
  let n = seed * 1103515245 + 12345;
  for (let i = 0; i < 5; i += 1) {
    n = (n * 1664525 + 1013904223) >>> 0;
    const idx = n % pool.length;
    main.push(pool.splice(idx, 1)[0]);
  }
  main.sort((a, b) => a - b);
  const bonus = ((seed * 7) % 10) + 1;
  return { main, bonus };
}

function ensureTreeInitialized() {
  const envTreeAddress = process.env.OPENJACK_TREE_ADDRESS;
  const envTreeConfigAddress = process.env.OPENJACK_TREE_CONFIG_ADDRESS;
  if (envTreeAddress && envTreeConfigAddress) {
    return {
      treeAddress: envTreeAddress,
      treeConfigAddress: envTreeConfigAddress,
      source: "env",
    };
  }
  const out = spawnSync("node", ["scripts/init-cnft-tree.mjs", "--json"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (out.status !== 0) {
    throw new Error(`init-cnft-tree failed: ${(out.stderr || out.stdout || "").trim()}`);
  }
  const parsed = JSON.parse((out.stdout || "").trim());
  return { ...parsed, source: "init-cnft-tree" };
}

function extractTimedOutSignature(error) {
  const message = String(error instanceof Error ? error.message : error);
  const match = message.match(/signature\s+([1-9A-HJ-NP-Za-km-z]+)/i);
  return match?.[1] || null;
}

async function rpcWithTimeoutTolerance(label, sendFn) {
  try {
    return { timedOut: false, signature: await sendFn() };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (
      !message.includes("TransactionExpiredTimeoutError")
      && !message.includes("Transaction was not confirmed")
    ) {
      throw error;
    }
    const signature = extractTimedOutSignature(error);
    console.warn(`[prototype-freeze] ${label} timeout sig=${signature ?? "unknown"} (continuing)`);
    return { timedOut: true, signature };
  }
}

async function runWithRetries(label, fn, attempts = TX_MAX_ATTEMPTS, backoffMs = TX_BACKOFF_MS) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      console.warn(`[prototype-freeze] ${label} attempt=${attempt} failed: ${String(error?.message || error)}`);
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

async function sendMethodNoConfirm(methodBuilder, authority, connection) {
  const tx = await methodBuilder.transaction();
  tx.feePayer = authority.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(authority);
  return connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
}

async function main() {
  if (BUY_TICKETS < 0 || BUY_TICKETS > 40) {
    throw new Error("OPENJACK_PROTOTYPE_BUY_TICKETS must be between 0 and 40");
  }
  if (BUY_TICKETS_PER_TX <= 0 || BUY_TICKETS_PER_TX > 10) {
    throw new Error("OPENJACK_PROTOTYPE_BUY_TICKETS_PER_TX must be between 1 and 10");
  }

  const resolvedProgramId = process.env.OPENJACK_PROGRAM_ID || loadProgramIdFromAnchorToml();
  if (!resolvedProgramId) {
    throw new Error("OPENJACK_PROGRAM_ID missing and Anchor.toml has no [programs.devnet].openjack");
  }

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const authority = readKeypair(AUTHORITY_KEYPAIR_PATH);
  const wallet = new anchor.Wallet(authority);
  const connection = new anchor.web3.Connection(RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 120_000,
  });
  const readConnection = new anchor.web3.Connection(READ_RPC_URL, { commitment: "confirmed" });
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const programId = new PublicKey(resolvedProgramId);
  let program;
  try {
    program = new anchor.Program(idl, programId, provider);
  } catch {
    program = new anchor.Program({ ...idl, address: programId.toBase58() }, provider);
  }

  const tree = ensureTreeInitialized();
  const treeAddress = new PublicKey(tree.treeAddress);
  const treeConfigAddress = new PublicKey(tree.treeConfigAddress);
  const configPda = deriveConfigPda(programId);
  const roundPda = deriveRoundPda(programId, ROUND_ID);
  const userRoundPda = deriveUserRoundPda(programId, ROUND_ID, wallet.publicKey);

  const configAccountInfo = await connection.getAccountInfo(configPda, "confirmed");
  if (!configAccountInfo) {
    throw new Error("Config account missing. Run npm run config:init with the prototype profile first.");
  }

  const now = Math.floor(Date.now() / 1000);
  let roundInfo = await readConnection.getAccountInfo(roundPda, "confirmed");
  if (!roundInfo) {
    const openTs = now + OPEN_OFFSET_SECS;
    const closeTs = now + CLOSE_IN_SECS;
    await runWithRetries("createRound", async () => {
      const { signature } = await rpcWithTimeoutTolerance("createRound", () =>
        program.methods
          .createRound({
            roundId: new BN(ROUND_ID),
            openTs: new BN(openTs),
            closeTs: new BN(closeTs),
            treeAddress,
          })
          .accounts({
            authority: wallet.publicKey,
            config: configPda,
            round: roundPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
      );
      if (signature) {
        console.log(`[prototype-freeze] createRound sig=${signature} roundId=${ROUND_ID}`);
      }
      roundInfo = await waitFor("round_account_created", async () => readConnection.getAccountInfo(roundPda, "confirmed"));
      return roundInfo;
    });
  }

  let round = await waitFor("round_fetch_after_create", async () => {
    try {
      return await program.account.round.fetch(roundPda);
    } catch {
      return null;
    }
  });
  if (Number(round.status) !== 0) {
    throw new Error(`Round ${ROUND_ID} not OPEN (status=${STATUS[Number(round.status)] || round.status})`);
  }

  const config = await program.account.lotteryConfig.fetch(configPda);
  const treasury = new PublicKey(config.treasuryPubkey || config.treasury_pubkey);
  const oracleFeed = new PublicKey(config.solUsdOracle || config.sol_usd_oracle);
  if (BUY_TICKETS > 0) {
    const tickets = Array.from({ length: BUY_TICKETS }, (_, i) => randomTicket(i + 1));
    for (let i = 0; i < tickets.length; i += BUY_TICKETS_PER_TX) {
      const liveRound = await program.account.round.fetch(roundPda);
      if (Number(liveRound.status) !== 0) {
        console.warn(`[prototype-freeze] buyTickets halted at offset=${i} because status=${STATUS[Number(liveRound.status)] || liveRound.status}`);
        break;
      }
      const chunk = tickets.slice(i, i + BUY_TICKETS_PER_TX);
      const oraclePublishTs = Math.floor(Date.now() / 1000) + ORACLE_PUBLISH_OFFSET_SECS;
      let signature = null;
      try {
        signature = await sendMethodNoConfirm(
          program.methods
            .buyTickets({
              tickets: chunk,
              oraclePriceMicroUsdPerSol: new BN(ORACLE_PRICE_MICRO_USD_PER_SOL),
              oraclePublishTs: new BN(oraclePublishTs),
            })
            .accounts({
              buyer: wallet.publicKey,
              config: configPda,
              round: roundPda,
              treasury,
              oracleFeed,
              userRoundStats: userRoundPda,
              systemProgram: SystemProgram.programId,
            })
            .remainingAccounts([
              { pubkey: treeAddress, isSigner: false, isWritable: true },
              { pubkey: treeConfigAddress, isSigner: false, isWritable: true },
              { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: LOG_WRAPPER_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
            ]),
          authority,
          connection,
        );
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        if (message.includes("RoundClosed")) {
          console.warn(`[prototype-freeze] buyTickets halted at offset=${i} because round is closed`);
          break;
        }
        throw error;
      }
      if (signature) {
        console.log(`[prototype-freeze] buyTickets sig=${signature} qty=${chunk.length} offset=${i}`);
      }
      await sleep(200);
    }
  } else {
    console.log("[prototype-freeze] skipping buys (OPENJACK_PROTOTYPE_BUY_TICKETS=0)");
  }

  round = await program.account.round.fetch(roundPda);
  const closeTs = Number(round.closeTs.toString());
  while (Math.floor(Date.now() / 1000) <= closeTs) {
    await sleep(1000);
  }

  if (Number(round.status) === 0) {
    await runWithRetries("closeRound", async () => {
      const { signature } = await rpcWithTimeoutTolerance("closeRound", () =>
        program.methods.closeRound().accounts({ round: roundPda }).rpc(),
      );
      if (signature) {
        console.log(`[prototype-freeze] closeRound sig=${signature}`);
      }
      const updated = await waitFor("round_closed", async () => {
        const r = await program.account.round.fetch(roundPda);
        return Number(r.status) !== 0 ? r : null;
      });
      return updated;
    });
  }

  round = await program.account.round.fetch(roundPda);
  if (Number(round.status) === 1) {
    await runWithRetries("beginFreeze", async () => {
      const { signature } = await rpcWithTimeoutTolerance("beginFreeze", () =>
        program.methods.beginFreeze().accounts({ round: roundPda }).rpc(),
      );
      if (signature) {
        console.log(`[prototype-freeze] beginFreeze sig=${signature}`);
      }
      const updated = await waitFor("begin_freeze_committed", async () => {
        const r = await program.account.round.fetch(roundPda);
        return Number(r.status) === 5 || Number(r.status) === 6 ? r : null;
      });
      return updated;
    });
  }

  await runWithRetries("freezeTicketSet", async () => {
    const { signature: freezeSig } = await rpcWithTimeoutTolerance("freezeTicketSet", () =>
      program.methods.freezeTicketSet().accounts({ round: roundPda }).rpc(),
    );
    if (freezeSig) {
      console.log(`[prototype-freeze] freezeTicketSet sig=${freezeSig}`);
    }
    const updated = await waitFor("freeze_committed", async () => {
      const r = await program.account.round.fetch(roundPda);
      return Boolean(r.freezeCommitted) && Number(r.status) === 6 ? r : null;
    });
    return updated;
  });

  round = await program.account.round.fetch(roundPda);
  const statusCode = Number(round.status);
  const summary = {
    rpcUrl: RPC_URL,
    programId: programId.toBase58(),
    roundId: ROUND_ID,
    roundPda: roundPda.toBase58(),
    status: STATUS[statusCode] || `UNKNOWN_${statusCode}`,
    ticketCount: Number(round.ticketCount.toString()),
    freezeCommitted: Boolean(round.freezeCommitted),
    ticketCountFrozen: Number(round.ticketCountFrozen.toString()),
    countProgressIndex: Number(round.countProgressIndex.toString()),
    countFinalized: Boolean(round.countFinalized),
    treeAddress: treeAddress.toBase58(),
    treeConfigAddress: treeConfigAddress.toBase58(),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
