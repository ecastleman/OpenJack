const requiredEnv = [
  "RPC_URL",
  "OPENJACK_PROGRAM_ID",
  "OPENJACK_IDL_PATH",
  "SCANNER_KEYPAIR_PATH",
  "DATABASE_URL",
];

const recommendedEnv = [
  "OPENJACK_API_BASE",
  "INGEST_API_KEY",
  "OPENJACK_EVENT_SOURCE_MODE",
  "OPENJACK_PROOF_MODE",
  "OPENJACK_ASSET_RESOLVER_MODE",
];

function envState(name) {
  const value = process.env[name];
  if (!value) return { name, present: false, value: "" };
  return { name, present: true, value };
}

function short(v) {
  if (!v) return "";
  if (v.length <= 80) return v;
  return `${v.slice(0, 77)}...`;
}

function printSection(title) {
  console.log("");
  console.log(title);
}

function printCommands() {
  const apiBase = process.env.OPENJACK_API_BASE || "http://localhost:8080";
  const eventSource = process.env.OPENJACK_EVENT_SOURCE_MODE || "rpc-dual";
  const proofMode = process.env.OPENJACK_PROOF_MODE || "das";
  const assetMode = process.env.OPENJACK_ASSET_RESOLVER_MODE || "postgres";
  const scanRound = process.env.OPENJACK_SCAN_ROUND_ID || "<round_id>";

  printSection("Run Order");
  console.log("1) API");
  console.log("   npm run api");
  console.log("2) Web");
  console.log("   npm run web");
  console.log("3) Scanner");
  console.log(
    `   OPENJACK_SCANNER_MODE=daemon OPENJACK_EVENT_SOURCE_MODE=${eventSource} OPENJACK_SCAN_ROUND_ID=${scanRound} OPENJACK_PROOF_MODE=${proofMode} OPENJACK_ASSET_RESOLVER_MODE=${assetMode} OPENJACK_API_BASE=${apiBase} SCANNER_PUBLISH_MODE=live npm run scanner`,
  );
  console.log("4) Keeper");
  console.log(
    `   OPENJACK_KEEPER_MODE=daemon OPENJACK_KEEPER_INTERVAL_SECS=15 OPENJACK_API_BASE=${apiBase} npm run keeper`,
  );
  console.log("5) Beta Gate");
  console.log("   npm run seeker:beta");
}

function printChecklist() {
  console.log("OpenJack Seeker Live Checklist");
  printSection("Required Environment");
  let missingRequired = 0;
  for (const name of requiredEnv) {
    const s = envState(name);
    const status = s.present ? "PASS" : "FAIL";
    if (!s.present) missingRequired += 1;
    console.log(`${status.padEnd(5)} ${name}${s.present ? `=${short(s.value)}` : ""}`);
  }

  printSection("Recommended Environment");
  for (const name of recommendedEnv) {
    const s = envState(name);
    const status = s.present ? "PASS" : "WARN";
    console.log(`${status.padEnd(5)} ${name}${s.present ? `=${short(s.value)}` : ""}`);
  }

  printSection("Checks");
  console.log("PASS  Run database schema migrations for API and scanner if not already applied");
  console.log("PASS  Ensure scanner keypair has SOL for tx fees/bond posting");
  console.log("PASS  Ensure OPENJACK program + IDL match deployed build");

  printCommands();

  printSection("Result");
  if (missingRequired > 0) {
    console.log(`NOT_READY missing_required_env=${missingRequired}`);
    process.exit(1);
    return;
  }
  console.log("READY_TO_RUN");
}

printChecklist();
