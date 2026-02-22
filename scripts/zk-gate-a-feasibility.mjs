import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const root = process.cwd();
const outDir = path.join(root, "reports/protocol-gate");
fs.mkdirSync(outDir, { recursive: true });

const scannerPkgJson = path.resolve(root, "services/scanner/package.json");
const scannerRequire = createRequire(scannerPkgJson);
const web3 = scannerRequire("@solana/web3.js");

const solanaProgramLib = path.join(
  os.homedir(),
  ".cargo/registry/src/index.crates.io-1949cf8c6b5b557f/solana-program-2.3.0/src/lib.rs"
);

function findRuntimeVerifierSurface(text) {
  const lines = text.split("\n");
  const modLines = lines.filter((l) => l.includes("pub mod "));
  const hits = modLines.filter(
    (l) =>
      l.includes("ed25519") ||
      l.includes("secp256k1") ||
      l.toLowerCase().includes("pairing") ||
      l.toLowerCase().includes("bn254") ||
      l.toLowerCase().includes("alt_bn128")
  );
  return { hits, modCount: modLines.length };
}

const web3VerifierKeys = Object.keys(web3).filter((k) => {
  const x = k.toLowerCase();
  return (
    x.includes("ed25519") ||
    x.includes("secp256k1") ||
    x.includes("bn254") ||
    x.includes("alt_bn128") ||
    x.includes("pairing")
  );
});

let solanaProgramReadOk = false;
let solanaProgramSurface = { hits: [], modCount: 0 };
if (fs.existsSync(solanaProgramLib)) {
  const txt = fs.readFileSync(solanaProgramLib, "utf8");
  solanaProgramReadOk = true;
  solanaProgramSurface = findRuntimeVerifierSurface(txt);
}

const primitiveSignals = {
  web3: {
    verifierLikeExports: web3VerifierKeys,
    hasEd25519: web3VerifierKeys.includes("Ed25519Program"),
    hasSecp256k1: web3VerifierKeys.includes("Secp256k1Program"),
    hasBnOrPairing: web3VerifierKeys.some((k) => {
      const x = k.toLowerCase();
      return x.includes("bn254") || x.includes("alt_bn128") || x.includes("pairing");
    }),
  },
  solanaProgram: {
    libPath: solanaProgramLib,
    readOk: solanaProgramReadOk,
    hits: solanaProgramSurface.hits,
    hasEd25519Module: solanaProgramSurface.hits.some((l) => l.includes("ed25519_program")),
    hasSecp256k1Module: solanaProgramSurface.hits.some((l) => l.includes("secp256k1_program")),
    hasBnOrPairingModule: solanaProgramSurface.hits.some((l) => {
      const x = l.toLowerCase();
      return x.includes("bn254") || x.includes("alt_bn128") || x.includes("pairing");
    }),
  },
};

const gateAPass =
  primitiveSignals.web3.hasBnOrPairing || primitiveSignals.solanaProgram.hasBnOrPairingModule;

const result = {
  generatedAt: new Date().toISOString(),
  gate: "PR12-Gate-A",
  scope: "proof-system + on-chain verifier primitive feasibility",
  decision: gateAPass ? "PASS" : "FAIL",
  stop: !gateAPass,
  reason: gateAPass
    ? "Detected candidate BN/pairing verifier primitive surface."
    : "No BN254/pairing verifier primitive surface detected in current web3 + solana-program toolchain path.",
  primitiveSignals,
  notes: [
    "This gate does not evaluate circuit correctness or proving economics.",
    "If FAIL, stop at Gate A per PR12 and do not proceed to B/C/D in this run.",
  ],
};

const ts = Date.now();
const outPath = path.join(outDir, `zk-gate-a-feasibility-${ts}.json`);
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(outPath);
