import { spawn } from "node:child_process";

const runKeeperOnce = process.env.BETA_RUN_KEEPER_ONCE === "true";
const runScannerOnce = process.env.BETA_RUN_SCANNER_ONCE === "true";
const strictReady = process.env.BETA_READY_STRICT === "true";

const steps = [];

function runCmd(name, cmd, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, ...extraEnv },
    });
    child.on("close", (code) => {
      resolve({
        name,
        ok: code === 0,
        code: code ?? 1,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

async function run() {
  console.log("OpenJack Seeker beta orchestration start");

  if (runKeeperOnce) {
    steps.push(
      await runCmd("keeper_once", "npm", ["run", "keeper"], {
        OPENJACK_KEEPER_MODE: "once",
      }),
    );
  }

  if (runScannerOnce) {
    steps.push(
      await runCmd("scanner_once", "npm", ["run", "scanner"], {
        OPENJACK_SCANNER_MODE: "once",
      }),
    );
  }

  steps.push(
    await runCmd("seeker_ready", "npm", ["run", "seeker:ready"], strictReady ? { READY_STRICT: "true" } : {}),
  );

  steps.push(await runCmd("seeker_report", "npm", ["run", "seeker:report"]));

  console.log("");
  console.log("Seeker beta summary");
  for (const s of steps) {
    const status = s.ok ? "PASS" : "FAIL";
    console.log(`${status.padEnd(5)} ${s.name} code=${s.code} elapsed_ms=${s.elapsedMs}`);
  }

  const failed = steps.some((s) => !s.ok && (s.name === "seeker_ready" || s.name === "seeker_report"));
  if (failed) {
    console.log("BETA_NOT_READY");
    process.exit(1);
    return;
  }

  console.log("BETA_READY");
  process.exit(0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
