import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  deriveClaimRecordPda,
  deriveConfigPda,
  deriveRoundPda,
  deriveUserRoundPda,
  getProgramForBuilder,
  hexToU8_32,
} from "../solana/openjack.js";

function quickPickTicket() {
  return { main: [1, 2, 3, 4, 5], bonus: 1 };
}

async function toUnsignedBase64({ feePayer, ix }) {
  const { connection } = getProgramForBuilder();
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer,
    recentBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(ix);

  const bytes = tx.serialize({ verifySignatures: false, requireAllSignatures: false });
  return {
    unsignedTxBase64: Buffer.from(bytes).toString("base64"),
    recentBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

export async function prepareBuyTx({ wallet, roundId, payload }) {
  const { program, programId } = getProgramForBuilder();
  const walletPk = new PublicKey(wallet);
  const configPda = deriveConfigPda(programId);
  const roundPda = deriveRoundPda(programId, roundId);
  const userRoundPda = deriveUserRoundPda(programId, roundId, wallet);
  const configAccount = await program.account.lotteryConfig.fetch(configPda);
  const treasuryKey = configAccount.treasuryPubkey || configAccount.treasury_pubkey;
  const oracleKey = configAccount.solUsdOracle || configAccount.sol_usd_oracle;
  if (!treasuryKey || !oracleKey) {
    throw new Error("lottery config missing treasury/oracle keys");
  }
  const treasury = new PublicKey(treasuryKey);
  const oracleFeed = new PublicKey(oracleKey);

  const tickets = Array.isArray(payload?.tickets) && payload.tickets.length > 0 ? payload.tickets : [quickPickTicket()];
  const args = {
    tickets,
    oraclePriceMicroUsdPerSol: new anchor.BN(payload?.oraclePriceMicroUsdPerSol || 20_000_000),
    oraclePublishTs: new anchor.BN(payload?.oraclePublishTs || Math.floor(Date.now() / 1000)),
  };

  const ix = await program.methods
    .buyTickets(args)
    .accounts({
      buyer: walletPk,
      config: configPda,
      round: roundPda,
      treasury,
      oracleFeed,
      userRoundStats: userRoundPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const envelope = await toUnsignedBase64({ feePayer: walletPk, ix });
  return {
    action: "BUY_TICKETS",
    roundId,
    wallet,
    ...envelope,
  };
}

export async function prepareClaimTx({ wallet, roundId, payload }) {
  const { program, programId } = getProgramForBuilder();
  const walletPk = new PublicKey(wallet);
  const roundPda = deriveRoundPda(programId, roundId);
  const leafIndex = Number(payload?.leafIndex);
  const tier = Number(payload?.tier);
  const amount = Number(payload?.amount ?? 0);
  if (!Number.isInteger(leafIndex) || leafIndex < 0) {
    throw new Error("invalid claim payload: leafIndex must be a non-negative integer");
  }
  if (!Number.isInteger(tier) || tier < 0 || tier > 5) {
    throw new Error("invalid claim payload: tier must be in [0..5]");
  }
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("invalid claim payload: amount must be >= 0");
  }
  const winnerRootHash = payload?.winnerRootHash;
  if (!winnerRootHash) {
    throw new Error("invalid claim payload: winnerRootHash is required");
  }
  const winnerRootProof = Array.isArray(payload?.winnerRootProof) ? payload.winnerRootProof : [];

  const claimRecord = deriveClaimRecordPda(programId, roundId, leafIndex);

  const args = {
    leafIndex,
    tier,
    amount: new anchor.BN(amount),
    winnerRootHash: hexToU8_32(winnerRootHash),
    winnerRootProof: winnerRootProof.map(hexToU8_32),
  };

  const ix = await program.methods
    .claim(args)
    .accounts({
      claimer: walletPk,
      round: roundPda,
      claimRecord,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const envelope = await toUnsignedBase64({ feePayer: walletPk, ix });
  return {
    action: "CLAIM",
    roundId,
    wallet,
    claim: {
      leafIndex,
      tier,
      amount,
      assetId: payload?.assetId || null,
      winnerRootHash: payload?.winnerRootHash || null,
      winnerRootProof: Array.isArray(payload?.winnerRootProof) ? payload.winnerRootProof : [],
      ticketProof: Array.isArray(payload?.ticketProof) ? payload.ticketProof : [],
      ownershipProof: payload?.ownershipProof || null,
    },
    ...envelope,
  };
}
