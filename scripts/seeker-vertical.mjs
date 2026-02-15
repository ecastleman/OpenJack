import { spawn } from "node:child_process";

const requiredEnv = [
  "RPC_URL",
  "OPENJACK_PROGRAM_ID",
  "OPENJACK_IDL_PATH",
  "SCANNER_KEYPAIR_PATH",
  "DATABASE_URL",
];

const API_BASE = (process.env.OPENJACK_API_BASE || "http://localhost:8080").replace(/\/$/, "");
const RUN_BETA = (process.env.VERTICAL_RUN_BETA || "true") === "true";
const EXIT_AFTER_BETA = (process.env.VERTICAL_EXIT_AFTER_BETA || "false") === "true";
const STARTUP_DELAY_MS = Number(process.env.VERTICAL_STARTUP_DELAY_MS || 8000);

const children = [];
let shuttingDown = false;

function missingRequiredEnv() {
  return requiredEnv.filter((name) => !process.env[name]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApi(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await sleep(1000);
  }
  return false;
}

function startProcess(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...extraEnv },
  });
  children.push({ name, child });
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.log(`[vertical] ${name} exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    }
  });
  console.log(`[vertical] started ${name} pid=${child.pid}`);
  return child;
}

function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[vertical] stopping services...");
  for (const { child } of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

async function runCommand(name, command, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, ...extraEnv },
    });
    child.on("close", (code) => {
      resolve({ name, ok: code === 0, code: code ?? 1 });
    });
  });
}

async function run() {
  const missing = missingRequiredEnv();
  if (missing.length > 0) {
    console.error(`[vertical] missing required env: ${missing.join(", ")}`);
    process.exit(1);
    return;
  }

  process.on("SIGINT", () => {
    stopAll();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopAll();
    process.exit(0);
  });

  startProcess("api", "npm", ["run", "api"]);
  startProcess("web", "npm", ["run", "web"]);
  startProcess(
    "scanner",
    "npm",
    ["run", "scanner"],
    {
      OPENJACK_SCANNER_MODE: process.env.OPENJACK_SCANNER_MODE || "daemon",
      OPENJACK_EVENT_SOURCE_MODE: process.env.OPENJACK_EVENT_SOURCE_MODE || "rpc-dual",
      OPENJACK_PROOF_MODE: process.env.OPENJACK_PROOF_MODE || "das",
      OPENJACK_ASSET_RESOLVER_MODE: process.env.OPENJACK_ASSET_RESOLVER_MODE || "postgres",
      SCANNER_PUBLISH_MODE: process.env.SCANNER_PUBLISH_MODE || "live",
    },
  );
  startProcess(
    "keeper",
    "npm",
    ["run", "keeper"],
    {
      OPENJACK_KEEPER_MODE: process.env.OPENJACK_KEEPER_MODE || "daemon",
      OPENJACK_KEEPER_INTERVAL_SECS: process.env.OPENJACK_KEEPER_INTERVAL_SECS || "15",
    },
  );

  console.log(`[vertical] waiting for services startup (${STARTUP_DELAY_MS}ms)`);
  await sleep(STARTUP_DELAY_MS);
  const apiReady = await waitForApi();
  if (!apiReady) {
    console.error("[vertical] API health check failed");
    stopAll();
    process.exit(1);
    return;
  }
  console.log("[vertical] API health check passed");

  if (RUN_BETA) {
    const beta = await runCommand("seeker:beta", "npm", ["run", "seeker:beta"]);
    if (!beta.ok) {
      console.error(`[vertical] beta gate failed code=${beta.code}`);
      stopAll();
      process.exit(beta.code);
      return;
    }
    console.log("[vertical] beta gate passed");
  }

  if (EXIT_AFTER_BETA) {
    stopAll();
    process.exit(0);
    return;
  }

  console.log("[vertical] services are running for Seeker testing. Press Ctrl+C to stop.");
}

run().catch((error) => {
  console.error(`[vertical] error: ${error instanceof Error ? error.message : String(error)}`);
  stopAll();
  process.exit(1);
});
