import test from "node:test";
import assert from "node:assert/strict";
import {
  calcMaxRetryableBurst,
  calcMaxStallWindowMs,
  countTerminalHardStops,
  evaluateRoundSlo,
  evaluateSuiteSlo,
} from "../../scripts/lib/rehearsal-metrics.mjs";

test("calcMaxRetryableBurst tracks consecutive retryable errors", () => {
  const rows = [
    { event: "COUNT_BATCH_RUNNER_ERROR", policy: "retryable" },
    { event: "COUNT_BATCH_RUNNER_ERROR", policy: "retryable" },
    { event: "COUNT_BATCH_RUNNER_TX" },
    { event: "COUNT_BATCH_RUNNER_ERROR", policy: "retryable" },
  ];
  assert.equal(calcMaxRetryableBurst(rows), 2);
});

test("countTerminalHardStops ignores handled ClientOffsetOutOfRange with same-attempt adjust", () => {
  const rows = [
    {
      event: "COUNT_BATCH_RUNNER_ERROR",
      policy: "hard_stop",
      class: "ClientOffsetOutOfRange",
      attempt_id: "r-1",
      attempt_seq: 1,
    },
    {
      event: "COUNT_BATCH_RUNNER_ADJUST",
      class: "ClientOffsetOutOfRange",
      resolved_class: "ClientOffsetOutOfRange",
      adjust_handled: true,
      attempt_id: "r-1",
      attempt_seq: 1,
    },
    {
      event: "COUNT_BATCH_RUNNER_ERROR",
      policy: "hard_stop",
      class: "CountBatchOutOfBounds",
      attempt_id: "r-2",
      attempt_seq: 2,
    },
  ];
  assert.equal(countTerminalHardStops(rows), 1);
});

test("countTerminalHardStops keeps ClientOffsetOutOfRange terminal without handled adjust", () => {
  const rows = [
    {
      event: "COUNT_BATCH_RUNNER_ERROR",
      policy: "hard_stop",
      class: "ClientOffsetOutOfRange",
      attempt_id: "r-3",
      attempt_seq: 3,
    },
  ];
  assert.equal(countTerminalHardStops(rows), 1);
});

test("calcMaxStallWindowMs computes max gap between progress moves", () => {
  const rows = [
    { event: "COUNT_BATCH_RUNNER", _ts: 1000, progress: 0 },
    { event: "COUNT_BATCH_RUNNER", _ts: 3000, progress: 2 },
    { event: "COUNT_BATCH_RUNNER", _ts: 7000, progress: 5 },
  ];
  const max = calcMaxStallWindowMs({
    rows,
    startMs: 0,
    endMs: 9000,
    initialProgress: 0,
    finalProgress: 7,
  });
  assert.equal(max, 4000);
});

test("evaluateRoundSlo returns fail when any threshold breaks", () => {
  const result = evaluateRoundSlo({
    thresholds: {
      maxCompletionMs: 1000,
      maxRetryableErrors: 1,
      maxRetryableBurst: 1,
      maxStallWindowMs: 1000,
      requireBountyConservation: true,
      requireProgressCompleteInLiveMode: true,
    },
    liveMode: true,
    completionMs: 1500,
    retryableErrors: 0,
    retryableBurst: 0,
    stallWindowMs: 100,
    bountyConservation: true,
    progressComplete: true,
  });
  assert.equal(result.pass, false);
  assert.equal(result.checks.completionWithinLimit, false);
});

test("evaluateSuiteSlo passes only when all round verdict+slo pass", () => {
  const pass = evaluateSuiteSlo({
    reports: [
      { verdict: "PASS", slo: { pass: true } },
      { verdict: "PASS", slo: { pass: true } },
    ],
  });
  assert.equal(pass.pass, true);

  const fail = evaluateSuiteSlo({
    reports: [
      { verdict: "PASS", slo: { pass: true } },
      { verdict: "FAIL", slo: { pass: true } },
    ],
  });
  assert.equal(fail.pass, false);
});
