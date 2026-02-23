import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { evaluateSuiteSlo, getRehearsalSloFromEnv, summarizeLatency } from "./lib/rehearsal-metrics.mjs";

function parseRoundIds() {
  const raw = process.env.OPENJACK_REHEARSAL_ROUND_IDS || "";
  const ids = raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) {
    throw new Error(
      "OPENJACK_REHEARSAL_ROUND_IDS is required. Example: OPENJACK_REHEARSAL_ROUND_IDS=1771,1772,1773,1774,1775 npm run count-batch:rehearsal:suite",
    );
  }
  return ids;
}

function runCommand(cmd, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: process.cwd(), env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const text = d.toString();
      process.stdout.write(text);
      stdout += text;
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      process.stderr.write(text);
      stderr += text;
    });
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function extractReportPath(stdout) {
  const match = String(stdout || "").match(/REHEARSAL_REPORT=(.+)/);
  return match?.[1]?.trim() || null;
}

function extractRpcHost(rpcUrl) {
  if (!rpcUrl) return null;
  try {
    const u = new URL(String(rpcUrl));
    return u.host || null;
  } catch {
    return null;
  }
}

function resolveStressRound(roundIds) {
  const explicit = Number(process.env.OPENJACK_SUITE_STRESS_ROUND_ID || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const idx = Number(process.env.OPENJACK_SUITE_STRESS_ROUND_INDEX || 3);
  const zeroBased = Math.max(0, idx - 1);
  return roundIds[zeroBased] || roundIds[roundIds.length - 1];
}

function isExternalRpcIssue(text) {
  const raw = String(text || "");
  return (
    raw.includes("fetch failed") ||
    raw.includes("429") ||
    raw.includes("Too Many Requests") ||
    raw.includes("NodeUnhealthy") ||
    raw.includes("ECONNRESET") ||
    raw.includes("ETIMEDOUT")
  );
}

async function createReplacementRound(roundId) {
  const env = {
    ...process.env,
    OPENJACK_PROTOTYPE_ROUND_ID: String(roundId),
    OPENJACK_CLOSE_IN_SECS: String(process.env.OPENJACK_SUITE_REPLACEMENT_CLOSE_IN_SECS || 75),
    OPENJACK_PROTOTYPE_BUY_TICKETS: String(process.env.OPENJACK_SUITE_REPLACEMENT_TICKET_COUNT || 10),
  };
  const res = await runCommand("npm", ["run", "round:prototype-freeze"], env);
  if (res.code !== 0) {
    throw new Error(`Failed to create replacement round ${roundId}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function aggregateSuite(roundReports) {
  const completionSamples = roundReports.map((r) => Number(r.metrics?.completion_time_ms || 0));
  const stallSamples = roundReports.map((r) => Number(r.metrics?.max_stall_window_ms || 0));
  const rpcMeanSamples = roundReports.map((r) => Number(r.metrics?.rpc_fetch_latency_ms?.mean || 0));
  const retryableCounts = roundReports.map((r) => Number(r.aggregates?.retryableErrors || 0));
  const retryableBursts = roundReports.map((r) => Number(r.metrics?.retryable_error_burst_max || 0));
  const hardCounts = roundReports.map((r) => Number(r.aggregates?.hardErrors || 0));

  const rewardInitial = roundReports.reduce((acc, r) => acc + Number(r.metrics?.reward_distribution?.initial || 0), 0);
  const rewardDistributed = roundReports.reduce(
    (acc, r) => acc + Number(r.metrics?.reward_distribution?.distributed || 0),
    0,
  );
  const rewardRemaining = roundReports.reduce(
    (acc, r) => acc + Number(r.metrics?.reward_distribution?.remaining || 0),
    0,
  );
  const rewardConservation = rewardInitial === rewardDistributed + rewardRemaining;

  return {
    rounds: roundReports.length,
    completion_time_ms: summarizeLatency(completionSamples),
    stall_window_ms: summarizeLatency(stallSamples),
    rpc_latency_ms: summarizeLatency(rpcMeanSamples),
    retryable_errors: {
      total: retryableCounts.reduce((a, b) => a + b, 0),
      max_per_round: Math.max(0, ...retryableCounts),
      max_burst: Math.max(0, ...retryableBursts),
    },
    hard_errors: {
      total: hardCounts.reduce((a, b) => a + b, 0),
      max_per_round: Math.max(0, ...hardCounts),
    },
    reward_distribution: {
      initial: rewardInitial,
      distributed: rewardDistributed,
      remaining: rewardRemaining,
      conservation_ok: rewardConservation,
    },
  };
}

function readInt(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const v = String(raw).toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function evaluateRegressionGuard({ previousSuite, currentSuite, env }) {
  const enabled = readBool(env, "OPENJACK_SUITE_ENFORCE_REGRESSION_GUARD", true);
  const allowOverride = readBool(env, "OPENJACK_SUITE_ALLOW_SLO_REGRESSION", false);
  const completionMaxIncreasePct = readInt(env, "OPENJACK_SUITE_REGRESSION_MAX_P95_COMPLETION_INCREASE_PCT", 50);
  const stallMaxIncreasePct = readInt(env, "OPENJACK_SUITE_REGRESSION_MAX_P95_STALL_INCREASE_PCT", 50);
  if (!enabled || allowOverride || !previousSuite) {
    return {
      enabled,
      allow_override: allowOverride,
      baseline_present: Boolean(previousSuite),
      pass: true,
      checks: {
        completionP95WithinLimit: true,
        stallP95WithinLimit: true,
      },
      limits: {
        completionP95MaxIncreasePct: completionMaxIncreasePct,
        stallP95MaxIncreasePct: stallMaxIncreasePct,
      },
      deltas: null,
      reason: !enabled
        ? "disabled"
        : allowOverride
          ? "override_enabled"
          : "no_baseline",
    };
  }

  const prevCompletion = Number(previousSuite.completion_time_ms?.p95 || 0);
  const prevStall = Number(previousSuite.stall_window_ms?.p95 || 0);
  const currCompletion = Number(currentSuite.completion_time_ms?.p95 || 0);
  const currStall = Number(currentSuite.stall_window_ms?.p95 || 0);

  const completionIncreasePct = prevCompletion > 0 ? ((currCompletion - prevCompletion) / prevCompletion) * 100 : 0;
  const stallIncreasePct = prevStall > 0 ? ((currStall - prevStall) / prevStall) * 100 : 0;

  const completionP95WithinLimit = completionIncreasePct <= completionMaxIncreasePct;
  const stallP95WithinLimit = stallIncreasePct <= stallMaxIncreasePct;
  const pass = completionP95WithinLimit && stallP95WithinLimit;

  return {
    enabled,
    allow_override: allowOverride,
    baseline_present: true,
    pass,
    checks: {
      completionP95WithinLimit,
      stallP95WithinLimit,
    },
    limits: {
      completionP95MaxIncreasePct: completionMaxIncreasePct,
      stallP95MaxIncreasePct: stallMaxIncreasePct,
    },
    deltas: {
      completionP95PreviousMs: prevCompletion,
      completionP95CurrentMs: currCompletion,
      completionP95IncreasePct: Math.round(completionIncreasePct * 100) / 100,
      stallP95PreviousMs: prevStall,
      stallP95CurrentMs: currStall,
      stallP95IncreasePct: Math.round(stallIncreasePct * 100) / 100,
    },
    reason: pass ? "within_limits" : "exceeds_limits",
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const roundIds = parseRoundIds();
  const requiredRounds = Number(process.env.OPENJACK_SUITE_REQUIRED_ROUNDS || roundIds.length);
  const rerunOnExternalRpc = String(process.env.OPENJACK_SUITE_RERUN_ON_EXTERNAL_RPC || "true").toLowerCase() !== "false";
  const maxRerunsPerRound = Math.max(0, Number(process.env.OPENJACK_SUITE_MAX_RERUNS_PER_ROUND || 1));
  const stressRoundId = resolveStressRound(roundIds);
  const stressBatchLen = Number(process.env.OPENJACK_SUITE_STRESS_BATCH_LEN || process.env.OPENJACK_STRESS_BATCH_LEN || 3);
  const stressThreshold = Number(
    process.env.OPENJACK_SUITE_STRESS_REMAINING_THRESHOLD || process.env.OPENJACK_STRESS_REMAINING_THRESHOLD || 36,
  );
  const reportPath =
    process.env.OPENJACK_REHEARSAL_SUITE_REPORT ||
    path.resolve(process.cwd(), "reports/protocol-gate", `activation-rehearsal-suite-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const roundReports = [];
  const perRound = [];
  const reruns = [];
  const configSnapshot = {
    round_ids: roundIds,
    profile_name: process.env.OPENJACK_REHEARSAL_PROFILE || "official-bot",
    feature_flags: process.env.OPENJACK_FEATURE_FLAGS || "canonical-freeze-prototype",
    slo_thresholds: getRehearsalSloFromEnv(process.env),
    rerun_policy: {
      enabled: rerunOnExternalRpc,
      max_reruns_per_round: maxRerunsPerRound,
    },
    stress_policy: {
      stress_round_id: stressRoundId,
      stress_batch_len: stressBatchLen,
      stress_remaining_threshold: stressThreshold,
    },
  };

  for (const initialRoundId of roundIds) {
    let roundId = initialRoundId;
    let attempts = 0;
    let finalParsed = null;
    let finalReportPath = null;
    let exitCode = 1;
    while (attempts <= maxRerunsPerRound) {
      const env = {
        ...process.env,
        OPENJACK_BENCH_ROUND_ID: String(roundId),
        OPENJACK_REHEARSAL_LIVE: "true",
        OPENJACK_REHEARSAL_PREFLIGHT_ONLY: "false",
      };
      if (roundId === stressRoundId) {
        env.OPENJACK_STRESS_BATCH_LEN = String(stressBatchLen);
        env.OPENJACK_STRESS_REMAINING_THRESHOLD = String(stressThreshold);
      }
      const res = await runCommand("npm", ["run", "count-batch:rehearsal"], env);
      exitCode = res.code;
      const report = extractReportPath(res.stdout);
      if (report && fs.existsSync(report)) {
        const parsed = readJson(report);
        finalParsed = parsed;
        finalReportPath = report;
        if (parsed.verdict === "PASS") break;
      }
      const externalRpc = isExternalRpcIssue(`${res.stdout}\n${res.stderr}`);
      if (!(rerunOnExternalRpc && externalRpc && attempts < maxRerunsPerRound)) break;
      const replacementRoundId = Math.floor(Date.now() / 1000) + 120 + attempts;
      reruns.push({
        original_round_id: roundId,
        replacement_round_id: replacementRoundId,
        reason: "external_rpc_issue",
      });
      await createReplacementRound(replacementRoundId);
      roundId = replacementRoundId;
      attempts += 1;
    }

    if (!finalParsed || !finalReportPath) {
      throw new Error(`Missing rehearsal artifact for round ${initialRoundId} (exit=${exitCode})`);
    }
    roundReports.push(finalParsed);
    perRound.push({
      input_round_id: initialRoundId,
      round_id: finalParsed.metadata?.round_id ?? roundId,
      report_path: finalReportPath,
      verdict: finalParsed.verdict,
      completion_time_ms: finalParsed.metrics?.completion_time_ms ?? 0,
      max_stall_window_ms: finalParsed.metrics?.max_stall_window_ms ?? 0,
      retryable_errors: finalParsed.aggregates?.retryableErrors ?? 0,
      retryable_error_burst_max: finalParsed.metrics?.retryable_error_burst_max ?? 0,
      hard_errors: finalParsed.aggregates?.hardErrors ?? 0,
      reward_distribution: finalParsed.metrics?.reward_distribution ?? null,
      rpc_latency_ms: finalParsed.metrics?.rpc_fetch_latency_ms ?? null,
      slo: finalParsed.slo ?? null,
      attempts: attempts + 1,
    });
  }

  const suite = aggregateSuite(roundReports);
  const suiteSlo = evaluateSuiteSlo({ reports: roundReports });
  const latestPath = path.resolve(path.dirname(reportPath), "latest-suite.json");
  let previous = null;
  let previousReport = null;
  if (fs.existsSync(latestPath)) {
    try {
      previous = JSON.parse(fs.readFileSync(latestPath, "utf8"));
      if (previous?.report_path && fs.existsSync(previous.report_path)) {
        previousReport = readJson(previous.report_path);
      }
    } catch {
      previous = null;
      previousReport = null;
    }
  }
  const regressionGuard = evaluateRegressionGuard({
    previousSuite: previousReport?.suite || null,
    currentSuite: suite,
    env: process.env,
  });
  const gates = {
    roundsMeetMinimum: roundReports.length >= requiredRounds,
    suiteSloPass: suiteSlo.pass,
    rewardConservation: Boolean(suite.reward_distribution.conservation_ok),
    regressionGuardPass: regressionGuard.pass,
  };
  const verdict = Object.values(gates).every(Boolean) ? "PASS" : "FAIL";

  const artifact = {
    metadata: {
      timestamp: startedAt,
      required_rounds: requiredRounds,
      profile_name: configSnapshot.profile_name,
      feature_flags: configSnapshot.feature_flags,
      rpc_host: extractRpcHost(process.env.RPC_URL),
      program_id: roundReports[0]?.metadata?.program_id || null,
    },
    config: configSnapshot,
    per_round: perRound,
    reruns,
    suite,
    suite_slo: suiteSlo,
    regression_guard: regressionGuard,
    gates,
    verdict,
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    latestPath,
    `${JSON.stringify(
      {
        report_path: reportPath,
        verdict,
        timestamp: startedAt,
        rounds: roundIds.length,
        previous_report_path: previous?.report_path || null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`REHEARSAL_SUITE_REPORT=${reportPath}`);
  console.log(`REHEARSAL_SUITE_LATEST=${latestPath}`);
  if (verdict !== "PASS") process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
