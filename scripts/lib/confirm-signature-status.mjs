export async function confirmSignatureByPolling(
  connection,
  signature,
  {
    timeoutMs = 90_000,
    pollMs = 800,
    requireFinalized = false,
    searchTransactionHistory = false,
  } = {},
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory });
    const status = statuses?.value?.[0] || null;
    if (status?.err) {
      throw new Error(`confirm_err=${JSON.stringify(status.err)}`);
    }
    const level = status?.confirmationStatus || "";
    const isConfirmed = level === "confirmed" || level === "finalized";
    const isFinalized = level === "finalized";
    if ((requireFinalized && isFinalized) || (!requireFinalized && isConfirmed)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`confirm_timeout_${timeoutMs}ms`);
}
