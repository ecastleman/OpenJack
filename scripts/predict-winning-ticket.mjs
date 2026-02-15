import crypto from "node:crypto";

function usage() {
  console.error("Usage: node scripts/predict-winning-ticket.mjs <round_id>");
}

function vrfResultForRound(roundId) {
  return crypto.createHash("sha256").update(`keeper-${roundId}`).digest();
}

function drawIndex(seedBuf, domain, nonce, modulus) {
  const nonceBuf = Buffer.from([nonce & 0xff]);
  const digest = crypto
    .createHash("sha256")
    .update(seedBuf)
    .update(Buffer.from(domain, "utf8"))
    .update(nonceBuf)
    .digest();
  const n = digest.readBigUInt64LE(0);
  return Number(n % BigInt(modulus));
}

function deriveWinningNumbers(seedBuf) {
  const available = Array.from({ length: 50 }, (_, i) => i + 1);
  const selected = [];
  for (let pick = 0; pick < 5; pick += 1) {
    const idx = drawIndex(seedBuf, "OPENJACK_MAIN", pick, available.length);
    selected.push(available[idx]);
    available.splice(idx, 1);
  }
  selected.sort((a, b) => a - b);
  const bonus = drawIndex(seedBuf, "OPENJACK_BONUS", 0, 10) + 1;
  return { main: selected, bonus };
}

const roundIdArg = process.argv[2];
if (!roundIdArg || Number.isNaN(Number(roundIdArg))) {
  usage();
  process.exit(1);
}

const roundId = Number(roundIdArg);
const seed = vrfResultForRound(roundId);
const winning = deriveWinningNumbers(seed);

console.log(`round_id=${roundId}`);
console.log(`predicted_main=${winning.main.join(",")}`);
console.log(`predicted_bonus=${winning.bonus}`);
console.log("");
console.log(
  `buy_ticket_example_main=[${winning.main.join(",")}] bonus=${winning.bonus}`
);

