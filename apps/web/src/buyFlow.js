export const BUY_TX_STATE = Object.freeze({
  IDLE: "IDLE",
  SIGNING: "SIGNING",
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
});

/**
 * Runs prepare -> sign -> send -> confirm and emits deterministic tx-state transitions.
 * Any failure guarantees FAILED is emitted exactly once.
 */
export async function runPreparedTxFlow({ prepare, sign, send, confirm, onState }) {
  const emit = (state) => {
    if (typeof onState === "function") onState(state);
  };

  try {
    emit(BUY_TX_STATE.SIGNING);
    const prepared = await prepare();
    const signed = await sign(prepared);

    emit(BUY_TX_STATE.PENDING);
    const submission = await send({ prepared, signed });
    await confirm({ prepared, signed, submission });

    emit(BUY_TX_STATE.CONFIRMED);
    return { prepared, signed, submission };
  } catch (error) {
    emit(BUY_TX_STATE.FAILED);
    throw error;
  }
}
