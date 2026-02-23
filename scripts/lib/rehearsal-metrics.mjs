function readInt(env, key, fallback) {
  const raw = env?.[key];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function readBool(env, key, fallback) {
  const raw = env?.[key];
  if (raw == null || raw === "") return fallback;
  return String(raw).toLowerCase() === "true";
}

export function getRehearsalSloFromEnv(env = process.env) {
  return {
    maxCompletionMs: readInt(env, "OPENJACK_SLO_MAX_COMPLETION_MS", 300_000),
    maxRetryableErrors: readInt(env, "OPENJACK_SLO_MAX_RETRYABLE_ERRORS", 10),
    maxRetryableBurst: readInt(env, "OPENJACK_SLO_MAX_RETRYABLE_BURST", 3),
    maxStallWindowMs: readInt(env, "OPENJACK_SLO_MAX_STALL_WINDOW_MS", 120_000),
    requireBountyConservation: readBool(env, "OPENJACK_SLO_REQUIRE_BOUNTY_CONSERVATION", true),
    requireProgressCompleteInLiveMode: readBool(env, "OPENJACK_SLO_REQUIRE_PROGRESS_COMPLETE_LIVE", true),
  };
}

export function calcMaxRetryableBurst(rows) {
  let maxBurst = 0;
  let burst = 0;
  for (const row of rows || []) {
    if (row?.event === "COUNT_BATCH_RUNNER_ERROR" && row?.policy !== "hard_stop") {
      burst += 1;
      if (burst > maxBurst) maxBurst = burst;
      continue;
    }
    if (row?.event === "COUNT_BATCH_RUNNER_TX" || row?.event === "COUNT_BATCH_RUNNER_DONE") {
      burst = 0;
      continue;
    }
  }
  return maxBurst;
}

export function calcMaxStallWindowMs({ rows, startMs, endMs, initialProgress, finalProgress }) {
  const ordered = (rows || []).slice().sort((a, b) => Number(a?._ts || 0) - Number(b?._ts || 0));
  let maxStall = 0;
  let lastProgress = Number(initialProgress || 0);
  let lastProgressTs = Number(startMs || 0);

  for (const row of ordered) {
    if (row?.event !== "COUNT_BATCH_RUNNER") continue;
    const ts = Number(row?._ts || 0);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const progress = Number(row?.progress ?? lastProgress);
    if (progress > lastProgress) {
      maxStall = Math.max(maxStall, Math.max(0, ts - lastProgressTs));
      lastProgress = progress;
      lastProgressTs = ts;
    }
  }

  const doneMs = Number(endMs || startMs || 0);
  if (Number.isFinite(doneMs) && doneMs > 0) {
    if (Number(finalProgress || 0) > lastProgress) {
      maxStall = Math.max(maxStall, Math.max(0, doneMs - lastProgressTs));
    } else {
      maxStall = Math.max(maxStall, Math.max(0, doneMs - lastProgressTs));
    }
  }
  return maxStall;
}

export function summarizeLatency(samples) {
  const values = (samples || [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x >= 0)
    .sort((a, b) => a - b);
  if (!values.length) return { count: 0, mean: 0, p95: 0, max: 0 };
  const count = values.length;
  const sum = values.reduce((acc, v) => acc + v, 0);
  const p95Index = Math.max(0, Math.ceil(values.length * 0.95) - 1);
  return {
    count,
    mean: Math.round(sum / count),
    p95: values[p95Index],
    max: values[values.length - 1],
  };
}

export function evaluateRoundSlo({
  thresholds,
  liveMode,
  completionMs,
  retryableErrors,
  retryableBurst,
  stallWindowMs,
  bountyConservation,
  progressComplete,
}) {
  const checks = {
    completionWithinLimit: Number(completionMs || 0) <= thresholds.maxCompletionMs,
    retryableErrorsWithinLimit: Number(retryableErrors || 0) <= thresholds.maxRetryableErrors,
    retryableBurstWithinLimit: Number(retryableBurst || 0) <= thresholds.maxRetryableBurst,
    stallWindowWithinLimit: Number(stallWindowMs || 0) <= thresholds.maxStallWindowMs,
    bountyConservation: thresholds.requireBountyConservation ? Boolean(bountyConservation) : true,
    progressCompleteInLiveMode:
      thresholds.requireProgressCompleteInLiveMode && liveMode ? Boolean(progressComplete) : true,
  };
  return {
    thresholds,
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}

export function evaluateSuiteSlo({ reports }) {
  const rows = reports || [];
  if (!rows.length) {
    return {
      checks: {
        roundsPresent: false,
        allRoundVerdictsPass: false,
        allRoundSloPass: false,
      },
      pass: false,
    };
  }
  const checks = {
    roundsPresent: rows.length > 0,
    allRoundVerdictsPass: rows.every((r) => r?.verdict === "PASS"),
    allRoundSloPass: rows.every((r) => r?.slo?.pass === true),
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}
