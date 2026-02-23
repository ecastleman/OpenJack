import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRunnerError,
  decideBatchSubmission,
  estimateFeeLamports,
  extractErrorClass,
  extractErrorSurface,
} from "../../scripts/lib/count-batch-runner-policy.mjs";

test("runner policy submits profitable batch", () => {
  const fee = estimateFeeLamports({
    baseFeeLamports: 10_000,
    expectedRetries: 1,
    feeMultiplierBps: 12_000,
  });
  const decision = decideBatchSubmission({
    rewardEstimateLamports: fee + 5_000,
    feeEstimateLamports: fee,
    remainingTickets: 100,
    minNetLamports: 0,
    forceCompleteEnabled: true,
    forceCompleteRemaining: 10,
  });
  assert.equal(decision.submit, true);
  assert.equal(decision.reason, "profitable");
  assert.equal(decision.netEstimateLamports, 5_000);
});

test("runner policy skips unprofitable batch outside force-complete threshold", () => {
  const decision = decideBatchSubmission({
    rewardEstimateLamports: 1_000,
    feeEstimateLamports: 2_000,
    remainingTickets: 40,
    minNetLamports: 0,
    forceCompleteEnabled: true,
    forceCompleteRemaining: 10,
  });
  assert.equal(decision.submit, false);
  assert.equal(decision.reason, "below_min_net");
  assert.equal(decision.netEstimateLamports, -1_000);
});

test("runner policy force-completes near end despite low net", () => {
  const decision = decideBatchSubmission({
    rewardEstimateLamports: 1_000,
    feeEstimateLamports: 2_000,
    remainingTickets: 6,
    minNetLamports: 0,
    forceCompleteEnabled: true,
    forceCompleteRemaining: 12,
  });
  assert.equal(decision.submit, true);
  assert.equal(decision.reason, "force_complete");
});

test("runner error taxonomy maps hard-stop and retryable classes", () => {
  assert.equal(classifyRunnerError("CountBatchTooLarge"), "hard_stop");
  assert.equal(classifyRunnerError("ClientOffsetOutOfRange"), "hard_stop");
  assert.equal(classifyRunnerError("CountReplayMismatch"), "retryable");
  assert.equal(classifyRunnerError("UnknownFailure"), "retryable");
});

test("runner error extraction classifies infra and tx-size surfaces", () => {
  assert.equal(extractErrorClass(new Error("429 Too Many Requests from upstream")), "RateLimited");
  assert.equal(extractErrorClass(new Error("Node is unhealthy: lagging")), "NodeUnhealthy");
  assert.equal(extractErrorClass(new Error("Transaction too large: 1300 bytes")), "TransactionTooLarge");
  assert.equal(extractErrorClass(new Error("Blockhash not found")), "BlockhashNotFound");
  assert.equal(
    extractErrorClass(new Error('The value of "offset" is out of range. It must be >= 0 and <= 999. Received 1000')),
    "ClientOffsetOutOfRange",
  );
});

test("runner error surface emits stage-aware class and rpc code", () => {
  const preflight = extractErrorSurface(new Error("Simulation failed: AccountNotFound"), "preflight");
  assert.equal(preflight.className, "SimulationError");
  assert.equal(preflight.stage, "preflight");

  const send = extractErrorSurface(new Error("status=429 Too Many Requests"), "send");
  assert.equal(send.className, "RateLimited");
  assert.equal(send.rpcCode, 429);
  assert.equal(send.stage, "send");
});
