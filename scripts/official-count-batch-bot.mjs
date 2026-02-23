import { spawn } from "node:child_process";
import path from "node:path";

const defaults = {
  OPENJACK_RUNNER_MIN_NET_LAMPORTS: "0",
  OPENJACK_RUNNER_BASE_FEE_LAMPORTS: "10000",
  OPENJACK_RUNNER_EXPECTED_RETRIES: "2",
  OPENJACK_RUNNER_FEE_MULTIPLIER_BPS: "13000",
  OPENJACK_RUNNER_FORCE_COMPLETE_REMAINING: "40",
  OPENJACK_RUNNER_FORCE_COMPLETE_ENABLED: "true",
  OPENJACK_RUNNER_MAX_RETRYABLE_FAILS: "10",
  OPENJACK_RUNNER_MAX_HARD_FAILS: "1",
  OPENJACK_COUNT_BATCH_LEN: "6",
  OPENJACK_STRESS_REMAINING_THRESHOLD: "36",
  OPENJACK_STRESS_BATCH_LEN: "3",
  OPENJACK_STRESS_USE_COMPUTE_BUDGET: "true",
  OPENJACK_STRESS_CU_LIMIT: "350000",
  OPENJACK_STRESS_CU_PRICE_MICRO_LAMPORTS: "0",
  OPENJACK_RUNNER_MAX_TX_SIZE_BYTES: "1100",
  OPENJACK_RUNNER_SIMULATE_PREFLIGHT: "true",
  OPENJACK_RUNNER_SIM_SIG_VERIFY: "true",
  OPENJACK_RUNNER_SIM_FALLBACK_SIG_VERIFY_TRUE: "true",
  OPENJACK_RUNNER_RETRY_BACKOFF_MS: "750",
  OPENJACK_RUNNER_RETRY_MAX_BACKOFF_MS: "8000",
  OPENJACK_RUNNER_RETRY_JITTER_MS: "500",
};

function formatLine(values) {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}

function resolveConfig() {
  const cfg = {};
  for (const [key, value] of Object.entries(defaults)) {
    cfg[key] = process.env[key] ?? value;
  }
  const dryRun = String(process.env.OPENJACK_BOT_DRY_RUN || "false").toLowerCase() === "true";
  cfg.OPENJACK_COUNT_BATCH_DRY_RUN = dryRun ? "true" : (process.env.OPENJACK_COUNT_BATCH_DRY_RUN ?? "false");
  return cfg;
}

async function main() {
  const config = resolveConfig();
  const runnerPath = path.resolve(process.cwd(), "scripts/prototype-run-count-batch.mjs");
  console.log(
    formatLine({
      event: "COUNT_BATCH_BOT_CONFIG",
      mode: config.OPENJACK_COUNT_BATCH_DRY_RUN === "true" ? "dry_run" : "run",
      runner: "prototype-run-count-batch",
      ...config,
    }),
  );

  const env = { ...process.env, ...config };
  const child = spawn(process.execPath, [runnerPath], { stdio: "inherit", env });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  process.exit(code ?? 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
