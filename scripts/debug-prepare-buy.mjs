import path from "node:path";
import { createRequire } from "node:module";

const scannerPkgJson = path.resolve(process.cwd(), "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const { PublicKey, Transaction } = scannerRequire("@solana/web3.js");

const API_BASE = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const PROGRAM_ID = process.env.OPENJACK_PROGRAM_ID || "";
const wallet = process.argv[2];
const roundId = Number(process.argv[3]);

if (!wallet || !roundId || Number.isNaN(roundId)) {
  console.error("Usage: node scripts/debug-prepare-buy.mjs <wallet> <round_id>");
  process.exit(1);
}

async function main() {
  const res = await fetch(`${API_BASE}/tx/prepare/buy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet,
      roundId,
      payload: { qty: 1, quickPick: true },
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error("prepare failed", res.status, json);
    process.exit(1);
  }

  const tx = Transaction.from(Buffer.from(json.unsignedTxBase64, "base64"));
  const pid = PROGRAM_ID ? new PublicKey(PROGRAM_ID) : null;
  const ix =
    tx.instructions.find((i) => (pid ? i.programId.equals(pid) : true)) || tx.instructions[tx.instructions.length - 1];

  console.log(`api_base=${API_BASE}`);
  console.log(`round_id=${roundId}`);
  console.log(`wallet=${wallet}`);
  console.log(`ix_program=${ix.programId.toBase58()}`);
  console.log("accounts:");
  ix.keys.forEach((k, idx) => {
    console.log(
      `${idx}: ${k.pubkey.toBase58()} writable=${k.isWritable ? "true" : "false"} signer=${
        k.isSigner ? "true" : "false"
      }`,
    );
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

