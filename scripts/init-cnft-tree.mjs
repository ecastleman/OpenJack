import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = scannerRequire("@solana/web3.js");

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PAYER_KEYPAIR_PATH =
  process.env.AUTHORITY_KEYPAIR_PATH || process.env.SCANNER_KEYPAIR_PATH || path.resolve(os.homedir(), ".config/solana/id.json");
const TREE_KEYPAIR_PATH =
  process.env.OPENJACK_TREE_KEYPAIR_PATH || path.resolve(process.cwd(), "keys", "openjack-cnft-tree-keypair.json");

const BUBBLEGUM_PROGRAM_ID = new PublicKey(
  process.env.OPENJACK_BUBBLEGUM_PROGRAM_ID || "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY",
);
const COMPRESSION_PROGRAM_ID = new PublicKey(
  process.env.OPENJACK_COMPRESSION_PROGRAM_ID || "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK",
);
const LOG_WRAPPER_PROGRAM_ID = new PublicKey(
  process.env.OPENJACK_LOG_WRAPPER_PROGRAM_ID || "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV",
);

const MAX_DEPTH = Number(process.env.OPENJACK_TREE_MAX_DEPTH || 14);
const MAX_BUFFER_SIZE = Number(process.env.OPENJACK_TREE_MAX_BUFFER_SIZE || 64);
const PUBLIC_TREE = (process.env.OPENJACK_TREE_PUBLIC || "true").toLowerCase() !== "false";
const JSON_OUTPUT = process.argv.includes("--json");

const CREATE_TREE_CONFIG_DISCRIMINATOR = Buffer.from([165, 83, 136, 142, 89, 202, 47, 220]);
const CONCURRENT_MERKLE_TREE_HEADER_SIZE = 56;

function toU32Le(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}

function encodeOptionBool(v) {
  return Buffer.from([1, v ? 1 : 0]);
}

function readKeypair(filePath) {
  const secret = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function writeKeypair(filePath, keypair) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
  fs.chmodSync(filePath, 0o600);
}

function ensureTreeKeypair(filePath) {
  if (fs.existsSync(filePath)) return readKeypair(filePath);
  const k = Keypair.generate();
  writeKeypair(filePath, k);
  return k;
}

function deriveTreeConfig(treePubkey) {
  // Bubblegum tree config PDA seeds are [merkle_tree_pubkey].
  return PublicKey.findProgramAddressSync([treePubkey.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

function concurrentTreeSize(maxDepth, maxBufferSize) {
  const changeLogOrPathSize = 32 * (maxDepth + 1) + 8;
  return 24 + (maxBufferSize + 1) * changeLogOrPathSize;
}

function merkleTreeAccountSize(maxDepth, maxBufferSize) {
  return CONCURRENT_MERKLE_TREE_HEADER_SIZE + concurrentTreeSize(maxDepth, maxBufferSize);
}

function buildCreateTreeConfigData(maxDepth, maxBufferSize, isPublic) {
  return Buffer.concat([
    CREATE_TREE_CONFIG_DISCRIMINATOR,
    toU32Le(maxDepth),
    toU32Le(maxBufferSize),
    encodeOptionBool(isPublic),
  ]);
}

async function ensureTreeInitialized() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = readKeypair(PAYER_KEYPAIR_PATH);
  const tree = ensureTreeKeypair(TREE_KEYPAIR_PATH);
  const treeConfig = deriveTreeConfig(tree.publicKey);

  const treeConfigInfo = await connection.getAccountInfo(treeConfig, "confirmed");
  if (treeConfigInfo) {
    return { alreadyInitialized: true, payer, tree, treeConfig };
  }

  const size = merkleTreeAccountSize(MAX_DEPTH, MAX_BUFFER_SIZE);
  const rentLamports = await connection.getMinimumBalanceForRentExemption(size);

  const createTreeAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: tree.publicKey,
    lamports: rentLamports,
    space: size,
    programId: COMPRESSION_PROGRAM_ID,
  });

  const createTreeConfigIx = {
    programId: BUBBLEGUM_PROGRAM_ID,
    keys: [
      { pubkey: treeConfig, isSigner: false, isWritable: true },
      { pubkey: tree.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: LOG_WRAPPER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: buildCreateTreeConfigData(MAX_DEPTH, MAX_BUFFER_SIZE, PUBLIC_TREE),
  };

  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(createTreeAccountIx, createTreeConfigIx);

  const sig = await connection.sendTransaction(tx, [payer, tree], {
    preflightCommitment: "confirmed",
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed",
  );

  return { alreadyInitialized: false, payer, tree, treeConfig, sig, size, rentLamports };
}

async function main() {
  const result = await ensureTreeInitialized();
  const payload = {
    treeAddress: result.tree.publicKey.toBase58(),
    treeConfigAddress: result.treeConfig.toBase58(),
    treeKeypairPath: TREE_KEYPAIR_PATH,
    alreadyInitialized: result.alreadyInitialized,
    maxDepth: MAX_DEPTH,
    maxBufferSize: MAX_BUFFER_SIZE,
    publicTree: PUBLIC_TREE,
  };
  if (result.sig) {
    payload.signature = result.sig;
    payload.accountSize = result.size;
    payload.rentLamports = result.rentLamports;
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(payload));
    return;
  }

  if (result.alreadyInitialized) {
    console.log(`tree already initialized: ${payload.treeAddress}`);
  } else {
    console.log(`init_cnft_tree sig=${payload.signature}`);
    console.log(`tree_address=${payload.treeAddress}`);
    console.log(`tree_config=${payload.treeConfigAddress}`);
    console.log(`tree_account_size=${payload.accountSize}`);
    console.log(`tree_rent_lamports=${payload.rentLamports}`);
  }
  console.log(`tree_keypair_path=${payload.treeKeypairPath}`);
  console.log(`export OPENJACK_TREE_ADDRESS=${payload.treeAddress}`);
  console.log(`export OPENJACK_TREE_CONFIG_ADDRESS=${payload.treeConfigAddress}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
