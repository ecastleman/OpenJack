import fs from "node:fs";
import path from "node:path";

function stripOuterQuotes(input) {
  if (input.length < 2) return input;
  const first = input[0];
  const last = input[input.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return input.slice(1, -1);
  }
  return input;
}

function expandShellLikeValue(input) {
  let out = String(input || "");
  const home = process.env.HOME || "";
  if (home) {
    if (out === "~") out = home;
    if (out.startsWith("~/")) out = `${home}/${out.slice(2)}`;
    out = out.replace(/\$\{HOME\}/g, home);
    out = out.replace(/\$HOME/g, home);
  }
  return out;
}

function parseEnvFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = expandShellLikeValue(stripOuterQuotes(trimmed.slice(idx + 1).trim()));
    out[key] = value;
  }
  return out;
}

export function loadEnvLocal({ cwd = process.cwd(), filename = ".env.local" } = {}) {
  const filePath = path.resolve(cwd, filename);
  if (!fs.existsSync(filePath)) return { loaded: false, filePath, keys: [], parsedKeys: [] };
  const parsed = parseEnvFile(filePath);
  const loadedKeys = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
      loadedKeys.push(key);
    }
  }
  return { loaded: true, filePath, keys: loadedKeys, parsedKeys: Object.keys(parsed) };
}
