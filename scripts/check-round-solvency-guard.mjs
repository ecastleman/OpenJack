import fs from "node:fs";
import path from "node:path";

const INSTRUCTIONS_DIR = path.resolve(process.cwd(), "programs/openjack/src/instructions");

function listRsFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".rs"))
    .map((name) => path.join(dir, name));
}

function main() {
  const files = listRsFiles(INSTRUCTIONS_DIR);
  const violations = [];

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const mutatesRoundLamports = src.includes("**round_info.try_borrow_mut_lamports()?");
    if (!mutatesRoundLamports) continue;
    const hasSolvencyCheck = src.includes("assert_round_solvency_floor(");
    if (!hasSolvencyCheck) {
      violations.push(path.relative(process.cwd(), file));
    }
  }

  if (violations.length > 0) {
    console.error("Round solvency guard FAILED: missing assert_round_solvency_floor in:");
    for (const file of violations) console.error(`- ${file}`);
    process.exit(1);
  }

  console.log("Round solvency guard PASS: all round lamport debit files call assert_round_solvency_floor.");
}

main();
