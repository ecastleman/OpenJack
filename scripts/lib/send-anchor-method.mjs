import { confirmSignatureByPolling } from "./confirm-signature-status.mjs";

export async function sendAnchorMethodWithPolling(
  methodBuilder,
  {
    connection,
    signer,
    extraSigners = [],
    latestBlockhashCommitment = "confirmed",
    sendOpts = { skipPreflight: false, maxRetries: 5, preflightCommitment: "confirmed" },
    confirmOpts = { timeoutMs: 90_000, pollMs: 800 },
  },
) {
  if (!connection) throw new Error("sendAnchorMethodWithPolling: connection is required");
  if (!signer?.publicKey) throw new Error("sendAnchorMethodWithPolling: signer is required");

  const tx = await methodBuilder.transaction();
  const latest = await connection.getLatestBlockhash(latestBlockhashCommitment);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer, ...extraSigners);

  const sig = await connection.sendRawTransaction(tx.serialize(), sendOpts);
  await confirmSignatureByPolling(connection, sig, confirmOpts);
  return sig;
}
