import crypto from "node:crypto";

function h(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function buildUnsignedTxEnvelope({ wallet, action, roundId, payload }) {
  const body = JSON.stringify({ wallet, action, roundId, payload });
  return {
    action,
    roundId,
    wallet,
    // Placeholder envelope for pre-mainnet API integration.
    unsignedTxBase64: Buffer.from(body, "utf8").toString("base64"),
    txDigest: h(body),
  };
}
