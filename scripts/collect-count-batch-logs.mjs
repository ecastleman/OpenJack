import fs from "node:fs";
import path from "node:path";
import { parseKeyValueLine } from "./lib/kv-line-parser.mjs";

const outPath = process.env.OPENJACK_COLLECT_OUT
  ? path.resolve(process.cwd(), process.env.OPENJACK_COLLECT_OUT)
  : null;

function appendIfNeeded(line) {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, `${line}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const input = await readStdin();
  const lines = input.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const parsed = parseKeyValueLine(line);
    if (!parsed) continue;
    const record = {
      ts: new Date().toISOString(),
      ...parsed,
      raw: line,
    };
    const jsonl = JSON.stringify(record);
    console.log(jsonl);
    appendIfNeeded(jsonl);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
