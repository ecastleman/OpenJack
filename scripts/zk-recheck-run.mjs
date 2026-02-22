import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = process.cwd();
const outDir = path.join(root, "reports/protocol-gate");
fs.mkdirSync(outDir, { recursive: true });

const ts = Date.now();
const buildPath = path.join(outDir, `zk-recheck-build-${ts}.json`);
const invokePath = path.join(outDir, `zk-recheck-invoke-${ts}.json`);
const cuPath = path.join(outDir, `zk-recheck-cu-${ts}.json`);
const reliabilityPath = path.join(outDir, `zk-recheck-reliability-${ts}.json`);

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function sh(cmd, args, cwd = root) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function trySh(cmd, args, cwd = root) {
  try {
    const stdout = sh(cmd, args, cwd);
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
      message: String(error.message || error),
      status: Number(error.status ?? -1),
    };
  }
}

function findSolanaProgramLibPath() {
  const base = path.join(os.homedir(), ".cargo/registry/src");
  if (!fs.existsSync(base)) return null;
  const registries = fs.readdirSync(base);
  for (const reg of registries) {
    const candidate = path.join(base, reg, "solana-program-2.3.0/src/lib.rs");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function runtimePrimitiveSignals() {
  const web3Exports = (() => {
    try {
      const scannerPkgJson = path.resolve(root, "services/scanner/package.json");
      const scannerRequire = createRequire(scannerPkgJson);
      const web3 = scannerRequire("@solana/web3.js");
      return Object.keys(web3);
    } catch {
      return [];
    }
  })();
  const web3Keys = web3Exports.filter((k) => {
    const x = k.toLowerCase();
    return (
      x.includes("ed25519") ||
      x.includes("secp256k1") ||
      x.includes("bn254") ||
      x.includes("alt_bn128") ||
      x.includes("pairing")
    );
  });

  const libPath = findSolanaProgramLibPath();
  let libHits = [];
  if (libPath) {
    const txt = fs.readFileSync(libPath, "utf8");
    libHits = txt
      .split("\n")
      .filter((l) => l.includes("pub mod "))
      .filter((l) => {
        const x = l.toLowerCase();
        return (
          x.includes("ed25519") ||
          x.includes("secp256k1") ||
          x.includes("bn254") ||
          x.includes("alt_bn128") ||
          x.includes("pairing")
        );
      });
  }

  const hasBnPairingWeb3 = web3Keys.some((k) => {
    const x = k.toLowerCase();
    return x.includes("bn254") || x.includes("alt_bn128") || x.includes("pairing");
  });
  const hasBnPairingLib = libHits.some((l) => {
    const x = l.toLowerCase();
    return x.includes("bn254") || x.includes("alt_bn128") || x.includes("pairing");
  });

  return {
    web3Keys,
    libPath,
    libHits,
    hasBnPairingWeb3,
    hasBnPairingLib,
    hasBnPairing: hasBnPairingWeb3 || hasBnPairingLib,
  };
}

function compileAttemptForAltBn128() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openjack-zk-recheck-"));
  const crateDir = path.join(tmpRoot, "probe");
  fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(crateDir, "Cargo.toml"),
    [
      '[package]',
      'name = "probe"',
      'version = "0.1.0"',
      'edition = "2021"',
      '',
      '[dependencies]',
      'solana-program = "2.3.0"',
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(crateDir, "src/lib.rs"),
    [
      "use solana_program::alt_bn128;",
      "pub fn probe() {",
      "  let _ = core::mem::size_of::<usize>();",
      "  let _ = core::any::type_name::<Option<alt_bn128::compression::G1Point>>();",
      "}",
      "",
    ].join("\n")
  );
  const result = trySh("cargo", ["check", "--offline"], crateDir);
  return { crateDir, ...result };
}

function main() {
  const generatedAt = new Date().toISOString();

  const primitive = runtimePrimitiveSignals();
  const compileProbe = compileAttemptForAltBn128();

  const gateR1Pass = primitive.hasBnPairing && compileProbe.ok;
  const buildPayload = {
    generatedAt,
    gate: "R1",
    decision: gateR1Pass ? "PASS" : "FAIL",
    reason: gateR1Pass
      ? "BN/pairing primitive surface and compile probe both succeeded."
      : "BN/pairing primitive surface unavailable or compile probe failed.",
    primitiveSignals: primitive,
    compileProbe: {
      ok: compileProbe.ok,
      status: compileProbe.status ?? 0,
      crateDir: compileProbe.crateDir,
      stdoutTail: compileProbe.stdout.slice(-2000),
      stderrTail: compileProbe.stderr.slice(-2000),
    },
  };
  writeJson(buildPath, buildPayload);

  if (!gateR1Pass) {
    const skip = {
      generatedAt,
      decision: "FAIL",
      skipped: true,
      reason: "Skipped because R1 failed.",
      dependency: path.basename(buildPath),
    };
    writeJson(invokePath, { gate: "R1->invoke", ...skip });
    writeJson(cuPath, { gate: "R2", ...skip });
    writeJson(reliabilityPath, { gate: "R3", ...skip });
    console.log(
      JSON.stringify(
        {
          decision: "FAIL",
          stop: true,
          artifacts: {
            build: buildPath,
            invoke: invokePath,
            cu: cuPath,
            reliability: reliabilityPath,
          },
        },
        null,
        2
      )
    );
    return;
  }

  // R1 passed branch placeholder: this script intentionally stops at Gate A/Baseline flow today.
  const notImplemented = {
    generatedAt,
    decision: "FAIL",
    reason: "R1 passed but R2/R3 execution harness is not implemented in this runner.",
  };
  writeJson(invokePath, { gate: "R1->invoke", ...notImplemented });
  writeJson(cuPath, { gate: "R2", ...notImplemented });
  writeJson(reliabilityPath, { gate: "R3", ...notImplemented });
  console.log(
    JSON.stringify(
      {
        decision: "FAIL",
        stop: true,
        artifacts: {
          build: buildPath,
          invoke: invokePath,
          cu: cuPath,
          reliability: reliabilityPath,
        },
      },
      null,
      2
    )
  );
}

main();
