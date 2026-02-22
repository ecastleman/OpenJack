import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const scannerPkg = path.resolve('/Users/ernesto/Documents/New project/services/scanner/package.json');
const req = createRequire(scannerPkg);
const { Connection, PublicKey } = req('@solana/web3.js');

const POST_SUMMARY = '/Users/ernesto/Documents/New project/reports/protocol-gate/protocol-gate-post-summary-1771524408750.json';
const OUT_PATH = '/Users/ernesto/Documents/New project/reports/protocol-gate/devnet-claim-cu-statistics.json';
const FIXED_SIGS_PATH = '/Users/ernesto/Documents/New project/reports/protocol-gate/devnet-claim-signatures.txt';

const post = JSON.parse(fs.readFileSync(POST_SUMMARY, 'utf8'));
const baseSigs = [];
for (const r of post.claimSummary?.rounds || []) {
  for (const c of r.claimed || []) if (c.sig) baseSigs.push(c.sig);
}
const sourceReportPath = post.sourceReportPath || null;
let sourceReport = null;
if (sourceReportPath && fs.existsSync(sourceReportPath)) {
  sourceReport = JSON.parse(fs.readFileSync(sourceReportPath, 'utf8'));
}

const rpc =
  process.env.OPENJACK_CU_RPC_URL ||
  process.env.RPC_URL ||
  'https://api.devnet.solana.com';
const conn = new Connection(rpc, 'confirmed');
const targetProgram = (process.env.OPENJACK_PROGRAM_ID || '').trim();

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[i];
}

function parseProgramConsumed(logMessages, programId) {
  if (!Array.isArray(logMessages)) return null;
  let max = null;
  const rx = new RegExp(`^Program\\s+${programId}\\s+consumed\\s+(\\d+)\\s+of\\s+(\\d+)\\s+compute units`);
  for (const line of logMessages) {
    const m = String(line).match(rx);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) max = max === null ? v : Math.max(max, v);
    }
  }
  return max;
}

async function signaturesForAddress(address, limit = 300) {
  const page = await rpcWithRetry(() =>
    conn.getSignaturesForAddress(
      new PublicKey(address),
      { limit: Math.min(160, limit) },
      'confirmed',
    ),
  );
  return (page || []).map((x) => x.signature);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcWithRetry(fn, maxAttempts = 8) {
  let delay = 400;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable =
        message.includes('429') ||
        message.includes('Too Many Requests') ||
        message.includes('fetch failed') ||
        message.includes('ETIMEDOUT');
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 6000);
    }
  }
  return null;
}

function deriveSafeBatch(perLeafP95) {
  if (!perLeafP95) return null;
  const safe = (limit, marginPct) => {
    const usable = limit * (1 - marginPct / 100);
    return Math.max(1, Math.floor(usable / perLeafP95));
  };
  return {
    perLeafProxyCu: perLeafP95,
    under200k: { margin20: safe(200_000, 20), margin30: safe(200_000, 30) },
    under400k: { margin20: safe(400_000, 20), margin30: safe(400_000, 30) },
  };
}

function txCountsForScale(B) {
  const count = (n, b) => (b ? Math.ceil(n / b) : null);
  return {
    tickets100k: count(100_000, B),
    tickets1m: count(1_000_000, B),
    tickets10m: count(10_000_000, B),
  };
}

const wallet = post.claimSummary?.wallet || sourceReport?.buyer || null;
const fixedSigs = fs.existsSync(FIXED_SIGS_PATH)
  ? fs
      .readFileSync(FIXED_SIGS_PATH, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
const expanded = fixedSigs.length === 0 && wallet ? await signaturesForAddress(wallet, 160) : [];
const unique = [...new Set([...fixedSigs, ...baseSigs, ...expanded])];

const samples = [];
let fetchErrors = 0;
for (const sig of unique.slice(0, 120)) {
  try {
    const tx = await rpcWithRetry(() =>
      conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
    );
    if (!tx || tx.meta?.err) continue;
    const logs = tx.meta?.logMessages || [];
    const claimLike = logs.some((l) => String(l).includes('Instruction: Claim'));
    if (!claimLike) continue;

    const txCu = Number(tx.meta?.computeUnitsConsumed);
    if (!Number.isFinite(txCu) || txCu <= 0) continue;
    const ixCu = targetProgram ? parseProgramConsumed(logs, targetProgram) : null;

    samples.push({ sig, txCu, ixCu });
    if (samples.length >= 40) break;
    await sleep(250);
  } catch {
    fetchErrors += 1;
  }
}

const txVals = samples.map((s) => s.txCu).sort((a, b) => a - b);
const ixVals = samples.filter((s) => Number.isFinite(s.ixCu)).map((s) => s.ixCu).sort((a, b) => a - b);

const mean = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
const std = (arr, mu) => {
  if (arr.length <= 1 || mu === null) return null;
  const variance = arr.reduce((acc, v) => acc + ((v - mu) ** 2), 0) / (arr.length - 1);
  return Math.round(Math.sqrt(variance));
};

const txMean = mean(txVals);
const txStd = std(txVals, txMean);
const txCv = txMean && txStd ? Number((txStd / txMean).toFixed(4)) : null;

const ixMean = mean(ixVals);
const ixStd = std(ixVals, ixMean);
const ixCv = ixMean && ixStd ? Number((ixStd / ixMean).toFixed(4)) : null;

const txP95 = percentile(txVals, 0.95);
const ixP95 = percentile(ixVals, 0.95);
const txMax = txVals.length ? txVals[txVals.length - 1] : null;
const ixMax = ixVals.length ? ixVals[ixVals.length - 1] : null;

const batchFromTx = deriveSafeBatch(txP95);
const batchFromIx = deriveSafeBatch(ixP95);

const report = {
  generatedAt: new Date().toISOString(),
  rpc,
  sample: {
    fixedSignatureSource: fs.existsSync(FIXED_SIGS_PATH) ? FIXED_SIGS_PATH : null,
    fixedSignaturesLoaded: fixedSigs.length,
    baseClaimSignatures: baseSigs.length,
    sourceReportPath,
    sourceReportBuyer: sourceReport?.buyer || null,
    expandedWalletSignatures: expanded.length,
    searchedUniqueSignatures: unique.length,
    matchedClaimTransactions: samples.length,
    txWithInstructionCu: ixVals.length,
    fetchErrors,
  },
  txComputeUnitsConsumed: {
    n: txVals.length,
    mean: txMean,
    p95: txP95,
    max: txMax,
    min: txVals[0] ?? null,
    stdev: txStd,
    cv: txCv,
  },
  instructionOpenjackConsumedFromLogs: {
    n: ixVals.length,
    mean: ixMean,
    p95: ixP95,
    max: ixMax,
    min: ixVals[0] ?? null,
    stdev: ixStd,
    cv: ixCv,
    programId: targetProgram || null,
  },
  safeBatchSizing: {
    conservativeProxy: 'claim tx computeUnitsConsumed p95',
    fromTxP95: batchFromTx,
    fromInstructionP95: batchFromIx,
    scaleTxCountsUsingTxP95: batchFromTx
      ? {
          under200k_margin20: txCountsForScale(batchFromTx.under200k.margin20),
          under200k_margin30: txCountsForScale(batchFromTx.under200k.margin30),
          under400k_margin20: txCountsForScale(batchFromTx.under400k.margin20),
          under400k_margin30: txCountsForScale(batchFromTx.under400k.margin30),
        }
      : null,
  },
  interpretation: {
    variance: 'Use p95 with safety margins, not mean, for deterministic batch limits.',
    conservativeUpperBound: 'Claim CU includes additional claim-record write/nullifier and balance mutation logic. Pure count-batch per-leaf verification should be lighter, so claim-based sizing is conservative.',
    cpiTransferInflation: 'Claim path includes compression CPI verify + state writes. It does not do token program transfer CPI, but does mutate lamport balances and create claim record account; fallback count-batch would skip these payout-side writes.',
  },
};

fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outPath: OUT_PATH, summary: report.txComputeUnitsConsumed, instructionSummary: report.instructionOpenjackConsumedFromLogs }, null, 2));
