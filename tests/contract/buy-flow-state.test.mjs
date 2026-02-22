import test from "node:test";
import assert from "node:assert/strict";

import { BUY_TX_STATE, runPreparedTxFlow } from "../../apps/web/src/buyFlow.js";

test("buy flow success transitions SIGNING -> PENDING -> CONFIRMED", async () => {
  const transitions = [];
  const result = await runPreparedTxFlow({
    prepare: async () => ({ unsigned: "tx" }),
    sign: async (prepared) => ({ prepared, signed: true }),
    send: async () => "sig-123",
    confirm: async () => {},
    onState: (state) => transitions.push(state),
  });

  assert.deepEqual(transitions, [BUY_TX_STATE.SIGNING, BUY_TX_STATE.PENDING, BUY_TX_STATE.CONFIRMED]);
  assert.equal(result.submission, "sig-123");
});

test("buy flow signature rejection transitions SIGNING -> FAILED", async () => {
  const transitions = [];
  await assert.rejects(
    runPreparedTxFlow({
      prepare: async () => ({ unsigned: "tx" }),
      sign: async () => {
        throw new Error("User rejected the request");
      },
      send: async () => "sig-unused",
      confirm: async () => {},
      onState: (state) => transitions.push(state),
    }),
    /User rejected the request/,
  );

  assert.deepEqual(transitions, [BUY_TX_STATE.SIGNING, BUY_TX_STATE.FAILED]);
});

test("buy flow send failure transitions SIGNING -> PENDING -> FAILED", async () => {
  const transitions = [];
  await assert.rejects(
    runPreparedTxFlow({
      prepare: async () => ({ unsigned: "tx" }),
      sign: async (prepared) => ({ prepared, signed: true }),
      send: async () => {
        throw new Error("RPC timeout");
      },
      confirm: async () => {},
      onState: (state) => transitions.push(state),
    }),
    /RPC timeout/,
  );

  assert.deepEqual(transitions, [BUY_TX_STATE.SIGNING, BUY_TX_STATE.PENDING, BUY_TX_STATE.FAILED]);
});
