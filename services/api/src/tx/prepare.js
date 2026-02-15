import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import crypto from "node:crypto";
import {
  bytes32FromHexOrBase58,
  deriveClaimRecordPda,
  deriveConfigPda,
  deriveRoundPda,
  deriveUserRoundPda,
  getProgramForBuilder,
  hexToU8_32,
} from "../solana/openjack.js";

const BN = anchor.BN || anchor.default?.BN;
if (!BN) {
  throw new Error("anchor BN constructor unavailable");
}

function quickPickTicket() {
  return { main: [1, 2, 3, 4, 5], bonus: 1 };
}

function toLe4(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(value));
  return b;
}

function computeTicketProofHash({ roundId, treeAddress, leafIndex, owner, ticketProof }) {
  const hasher = crypto.createHash("sha256");
  hasher.update(Buffer.from("ticket-proof:"));
  hasher.update(Buffer.from(new BN(roundId).toArrayLike(Buffer, "le", 8)));
  hasher.update(new PublicKey(treeAddress).toBuffer());
  hasher.update(toLe4(leafIndex));
  hasher.update(new PublicKey(owner).toBuffer());
  for (const node of ticketProof) {
    hasher.update(Buffer.from(node));
  }
  return hasher.digest("hex");
}

async function toUnsignedBase64({ feePayer, ix }) {
  const { connection } = getProgramForBuilder();
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(ix);

  const bytes = tx.serialize({ verifySignatures: false, requireAllSignatures: false });
  return {
    unsignedTxBase64: Buffer.from(bytes).toString("base64"),
    recentBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

async function resolveChainNowTs() {
  const { connection } = getProgramForBuilder();
  try {
    const slot = await connection.getSlot("processed");
    const blockTime = await connection.getBlockTime(slot);
    if (typeof blockTime === "number" && Number.isFinite(blockTime) && blockTime > 0) {
      return blockTime;
    }
  } catch {
    // fallback below
  }
  return Math.floor(Date.now() / 1000);
}

export async function prepareBuyTx({ wallet, roundId, payload }) {
  const { program, programId } = getProgramForBuilder();
  const walletPk = new PublicKey(wallet);
  const configPda = deriveConfigPda(programId);
  const roundPda = deriveRoundPda(programId, roundId);
  const userRoundPda = deriveUserRoundPda(programId, roundId, wallet);
  let configAccount;
  try {
    configAccount = await program.account.lotteryConfig.fetch(configPda);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed_to_fetch_config ${configPda.toBase58()}: ${message}`);
  }
  const treasuryKey = configAccount.treasuryPubkey || configAccount.treasury_pubkey;
  const oracleKey = configAccount.solUsdOracle || configAccount.sol_usd_oracle;
  if (!treasuryKey || !oracleKey) {
    throw new Error("lottery config missing treasury/oracle keys");
  }
  const treasury = new PublicKey(treasuryKey);
  const oracleFeed = new PublicKey(oracleKey);
  const roundAccount = await program.account.round.fetch(roundPda);
  const treeAddress = roundAccount.treeAddress || roundAccount.tree_address;
  if (!treeAddress) {
    throw new Error("round tree address unavailable");
  }

  const chainNowTs = await resolveChainNowTs();
  const tickets = Array.isArray(payload?.tickets) && payload.tickets.length > 0 ? payload.tickets : [quickPickTicket()];
  const args = {
    tickets,
    oraclePriceMicroUsdPerSol: new BN(payload?.oraclePriceMicroUsdPerSol || 20_000_000),
    oraclePublishTs: new BN(payload?.oraclePublishTs || chainNowTs),
  };

  const builder = program.methods
    .buyTickets(args)
    .accounts({
      buyer: walletPk,
      config: configPda,
      round: roundPda,
      treasury,
      oracleFeed,
      userRoundStats: userRoundPda,
      systemProgram: SystemProgram.programId,
    });
  const cnftRemaining = buildBuyCnftRemainingAccounts(treeAddress);
  if (cnftRemaining.length > 0) {
    builder.remainingAccounts(cnftRemaining);
  }
  const ix = await builder.instruction();
  // Safety guard: treasury is transfer destination and must be writable on-chain.
  // This avoids failures if a stale client/IDL marks it readonly.
  ix.keys = ix.keys.map((meta) =>
    meta.pubkey.equals(treasury) ? { ...meta, isWritable: true } : meta,
  );

  const envelope = await toUnsignedBase64({ feePayer: walletPk, ix });
  return {
    action: "BUY_TICKETS",
    roundId,
    wallet,
    ...envelope,
  };
}

function buildBuyCnftRemainingAccounts(treeAddress) {
  const mintEnabledRaw = String(process.env.OPENJACK_CNFT_MINT_ENABLED ?? "true").toLowerCase();
  if (mintEnabledRaw === "false" || mintEnabledRaw === "0" || mintEnabledRaw === "no" || mintEnabledRaw === "off") {
    return [];
  }
  const bubblegumProgramId = new PublicKey(
    process.env.OPENJACK_BUBBLEGUM_PROGRAM_ID || "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY",
  );
  const treePubkey = new PublicKey(treeAddress);
  const treeConfig =
    process.env.OPENJACK_TREE_CONFIG_ADDRESS ||
    process.env.OPENJACK_CNFT_TREE_CONFIG_ADDRESS ||
    PublicKey.findProgramAddressSync([treePubkey.toBuffer()], bubblegumProgramId)[0].toBase58();
  return [
    {
      pubkey: treePubkey,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: new PublicKey(treeConfig),
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: bubblegumProgramId,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: new PublicKey(
        process.env.OPENJACK_LOG_WRAPPER_PROGRAM_ID || "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV",
      ),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: new PublicKey(
        process.env.OPENJACK_COMPRESSION_PROGRAM_ID || splAccountCompressionProgramId(),
      ),
      isSigner: false,
      isWritable: false,
    },
  ];
}

export async function prepareClaimTx({ wallet, roundId, payload }) {
  const { program, programId } = getProgramForBuilder();
  const walletPk = new PublicKey(wallet);
  const roundPda = deriveRoundPda(programId, roundId);
  const roundAccount = await program.account.round.fetch(roundPda);
  const roundStatus = Number(roundAccount.status);
  if (roundStatus !== 4) {
    throw new Error(`claim_not_ready: round status is ${roundStatus} (requires FINALIZED=4)`);
  }
  const treeAddress = roundAccount.treeAddress || roundAccount.tree_address;
  if (!treeAddress) {
    throw new Error("round tree address unavailable");
  }
  const leafIndex = Number(payload?.leafIndex);
  const tier = Number(payload?.tier);
  if (!Number.isInteger(leafIndex) || leafIndex < 0) {
    throw new Error("invalid claim payload: leafIndex must be a non-negative integer");
  }
  if (!Number.isInteger(tier) || tier < 0 || tier > 5) {
    throw new Error("invalid claim payload: tier must be in [0..5]");
  }
  const winnerRootHash = payload?.winnerRootHash;
  if (!winnerRootHash) {
    throw new Error("invalid claim payload: winnerRootHash is required");
  }
  const compressionRoot = payload?.compressionRoot;
  const compressionLeaf = payload?.compressionLeaf;
  const rawCompressionIndex = Number(payload?.compressionIndex);
  if (!compressionRoot || !compressionLeaf || !Number.isInteger(rawCompressionIndex) || rawCompressionIndex < 0) {
    throw new Error("invalid claim payload: compressionRoot/compressionLeaf/compressionIndex are required");
  }
  // Some DAS providers return the full tree node index (e.g. 2^depth + leaf_index)
  // while VerifyLeaf expects the leaf index in [0, 2^depth - 1].
  const treeDepth = Number(process.env.OPENJACK_TREE_MAX_DEPTH || 14);
  const leafCapacity = Number.isInteger(treeDepth) && treeDepth > 0 ? 2 ** treeDepth : 2 ** 14;
  const compressionIndex =
    rawCompressionIndex >= leafCapacity ? rawCompressionIndex - leafCapacity : rawCompressionIndex;
  const winnerRootProof = Array.isArray(payload?.winnerRootProof) ? payload.winnerRootProof : [];
  const ownershipOwner = payload?.ownershipProof?.owner;
  if (!ownershipOwner) {
    throw new Error("invalid claim payload: ownershipProof.owner is required");
  }
  const ownershipOwnerPk = new PublicKey(ownershipOwner);
  if (!ownershipOwnerPk.equals(walletPk)) {
    throw new Error("invalid claim payload: ownershipProof.owner must equal wallet");
  }
  const ticketProof = Array.isArray(payload?.ticketProof) ? payload.ticketProof : [];
  if (ticketProof.length === 0) {
    throw new Error("invalid claim payload: ticketProof is required");
  }
  const ticketProofBytes = ticketProof.map(bytes32FromHexOrBase58);
  const ticketProofHash = computeTicketProofHash({
    roundId,
    treeAddress,
    leafIndex,
    owner: ownershipOwner,
    ticketProof: ticketProofBytes,
  });
  const tierPayouts = roundAccount.tierPayoutPerWinner || roundAccount.tier_payout_per_winner || [];
  const onchainAmount = Number(tierPayouts[tier]?.toString?.() ?? tierPayouts[tier] ?? 0);
  if (!Number.isFinite(onchainAmount) || onchainAmount <= 0) {
    throw new Error(`claim_not_ready: onchain payout for tier ${tier} is ${onchainAmount}`);
  }

  const claimRecord = deriveClaimRecordPda(programId, roundId, leafIndex);

  const args = {
    leafIndex,
    tier,
    amount: new BN(onchainAmount),
    ticketOwner: ownershipOwnerPk,
    compressionRoot: bytes32FromHexOrBase58(compressionRoot),
    compressionLeaf: bytes32FromHexOrBase58(compressionLeaf),
    compressionIndex,
    ticketProofHash: hexToU8_32(ticketProofHash),
    winnerRootHash: bytes32FromHexOrBase58(winnerRootHash),
    winnerRootProof: winnerRootProof.map(bytes32FromHexOrBase58),
  };

  const remainingAccounts = ticketProofBytes.map((node) => ({
    pubkey: new PublicKey(Buffer.from(node)),
    isSigner: false,
    isWritable: false,
  }));

  const ix = await program.methods
    .claim(args)
    .accounts({
      claimer: walletPk,
      round: roundPda,
      claimRecord,
      merkleTree: new PublicKey(treeAddress),
      compressionProgram: new PublicKey(splAccountCompressionProgramId()),
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  const envelope = await toUnsignedBase64({ feePayer: walletPk, ix });
  return {
    action: "CLAIM",
    roundId,
    wallet,
    claim: {
      leafIndex,
      tier,
      amount: onchainAmount,
      assetId: payload?.assetId || null,
      winnerRootHash: payload?.winnerRootHash || null,
      winnerRootProof: Array.isArray(payload?.winnerRootProof) ? payload.winnerRootProof : [],
      compressionRoot: payload?.compressionRoot || null,
      compressionLeaf: payload?.compressionLeaf || null,
      compressionIndex: Number.isInteger(compressionIndex) ? compressionIndex : null,
      ticketProof: Array.isArray(payload?.ticketProof) ? payload.ticketProof : [],
      ownershipProof: payload?.ownershipProof || null,
    },
    ...envelope,
  };
}

function splAccountCompressionProgramId() {
  return "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK";
}
