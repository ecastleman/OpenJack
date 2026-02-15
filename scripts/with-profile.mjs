import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function parseEnvFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const out = {};
  const stripOuterQuotes = (input) => {
    if (input.length < 2) return input;
    const first = input[0];
    const last = input[input.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return input.slice(1, -1);
    }
    return input;
  };
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = stripOuterQuotes(trimmed.slice(idx + 1).trim());
    out[key] = value;
  }
  return out;
}

function usage() {
  console.error("Usage: node scripts/with-profile.mjs <dev-fast|qa-fast|prod-like> <command> [args...]");
}

const [, , profileName, command, ...args] = process.argv;
if (!profileName || !command) {
  usage();
  process.exit(1);
}

const profilePath = path.resolve(process.cwd(), "config", "profiles", `${profileName}.env`);
if (!fs.existsSync(profilePath)) {
  console.error(`profile not found: ${profilePath}`);
  process.exit(1);
}

const profileEnv = parseEnvFile(profilePath);
// Allow caller-exported vars (like OPENJACK_PROGRAM_ID) to override profile defaults.
const env = { ...profileEnv, ...process.env, OPENJACK_PROFILE: profileName };

const child = spawn(command, args, {
  stdio: "inherit",
  shell: false,
  env,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
