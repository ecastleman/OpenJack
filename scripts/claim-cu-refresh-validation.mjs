import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const scannerPkg = path.resolve('/Users/ernesto/Documents/New project/services/scanner/package.json');
const req = createRequire(scannerPkg);
const { Connection, PublicKey } = req('@solana/web3.js');

const POST_SUMMARY = '/Users/ernesto/Documents/New project/reports/protocol-gate/protocol-gate-post-summary-1771524408750.json';
const OUT_PATH = '/Users/ernesto/Documents/New project/reports/protocol-gate/devnet-claim-cu-refresh-validation.json';
const PROGRAM_ID = (process.env.OPENJACK_PROGRAM_ID || '').trim();
const RPC = process.env.OPENJACK_CU_RPC_URL || process.env.RPC_URL || 'https://api.devnet.solana.com';

const TARGET_CLAIMS = Number(process.env.OPENJACK_CU_TARGET_CLAIMS || 120);
const MAX_SIGNATURES = Number(process.env.OPENJACK_CU_MAX_SIGNATURES || 1400);
const PAGE_SIZE = 100;
const BATCH_SIZE = 12;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[idx];
}

async function rpcBatch(payload, maxAttempts = 8) {
  let delay = 400;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 429) {
      if (attempt === maxAttempts) throw new Error('429 Too Many Requests');
      await sleep(delay);
      delay = Math.min(delay * 2, 6000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('rpcBatch exhausted');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function extractProgramConsumed(logMessages, programId) {
  if (!Array.isArray(logMessages) || !programId) return null;
  const rx = new RegExp(`^Program\\s+${programId}\\s+consumed\\s+(\\d+)\\s+of\\s+(\\d+)\\s+compute units`);
  let max = null;
  for (const line of logMessages) {
    const m = String(line).match(rx);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) max = max === null ? v : Math.max(max, v);
    }
  }
  return max;
}

const post = JSON.parse(fs.readFileSync(POST_SUMMARY, 'utf8'));
const sourceReportPath = post.sourceReportPath;
let wallet = null;
if (sourceReportPath && fs.existsSync(sourceReportPath)) {
  const source = JSON.parse(fs.readFileSync(sourceReportPath, 'utf8'));
  wallet = source?.buyer || null;
}
if (!wallet) throw new Error('wallet not found from source report');

const conn = new Connection(RPC, 'confirmed');
const walletPk = new PublicKey(wallet);

const signatures = [];
let before = undefined;
while (signatures.length < MAX_SIGNATURES) {
  const page = await conn.getSignaturesForAddress(walletPk, { before, limit: PAGE_SIZE }, 'confirmed');
  if (!page.length) break;
  signatures.push(...page.map((s) => s.signature));
  before = page[page.length - 1].signature;
  if (page.length < PAGE_SIZE) break;
  await sleep(120);
}

const rows = [];
let rpcErrors = 0;
let scanned = 0;
for (const sigChunk of chunk(signatures, BATCH_SIZE)) {
  const payload = sigChunk.map((sig, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'getTransaction',
    params: [sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
  }));

  let resp;
  try {
    resp = await rpcBatch(payload);
  } catch {
    rpcErrors += sigChunk.length;
    continue;
  }

  const arr = Array.isArray(resp) ? resp : [];
  const byId = new Map(arr.map((x) => [x.id, x]));
  for (let i = 0; i < sigChunk.length; i += 1) {
    const sig = sigChunk[i];
    const tx = byId.get(i + 1)?.result;
    scanned += 1;
    if (!tx || tx.meta?.err) continue;
    const logs = tx.meta?.logMessages || [];
    const isClaim = logs.some((l) => String(l).includes('Instruction: Claim'));
    if (!isClaim) continue;
    const txCu = Number(tx.meta?.computeUnitsConsumed);
    if (!Number.isFinite(txCu) || txCu <= 0) continue;
    const ixCu = extractProgramConsumed(logs, PROGRAM_ID);
    rows.push({ sig, txCu, ixCu, slot: tx.slot ?? null, blockTime: tx.blockTime ?? null });
    if (rows.length >= TARGET_CLAIMS) break;
  }
  if (rows.length >= TARGET_CLAIMS) break;
  await sleep(180);
}

const txVals = rows.map((r) => r.txCu).sort((a, b) => a - b);
const ixVals = rows.filter((r) => Number.isFinite(r.ixCu)).map((r) => r.ixCu).sort((a, b) => a - b);

const mean = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
const std = (arr, mu) => {
  if (arr.length <= 1 || mu === null) return null;
  const variance = arr.reduce((acc, v) => acc + ((v - mu) ** 2), 0) / (arr.length - 1);
  return Math.round(Math.sqrt(variance));
};

const txMean = mean(txVals);
const txStd = std(txVals, txMean);
const txCv = txMean && txStd ? Number((txStd / txMean).toFixed(4)) : null;
const txP95 = percentile(txVals, 0.95);

function safeB(limit, marginPct, perLeafP95) {
  if (!perLeafP95) return null;
  const usable = limit * (1 - marginPct / 100);
  return Math.max(1, Math.floor(usable / perLeafP95));
}
function txCount(n, b) { return b ? Math.ceil(n / b) : null; }

const out = {
  generatedAt: new Date().toISOString(),
  rpc: RPC,
  sample: {
    wallet,
    signaturesCollected: signatures.length,
    transactionsScanned: scanned,
    matchedClaimTransactions: rows.length,
    targetClaims: TARGET_CLAIMS,
    rpcErrors,
  },
  txComputeUnitsConsumed: {
    n: txVals.length,
    mean: txMean,
    p95: txP95,
    max: txVals.length ? txVals[txVals.length - 1] : null,
    min: txVals[0] ?? null,
    stdev: txStd,
    cv: txCv,
  },
  instructionOpenjackConsumedFromLogs: {
    n: ixVals.length,
    mean: mean(ixVals),
    p95: percentile(ixVals, 0.95),
    max: ixVals.length ? ixVals[ixVals.length - 1] : null,
    min: ixVals[0] ?? null,
    stdev: std(ixVals, mean(ixVals)),
    cv: mean(ixVals) && std(ixVals, mean(ixVals)) ? Number((std(ixVals, mean(ixVals)) / mean(ixVals)).toFixed(4)) : null,
    programId: PROGRAM_ID || null,
  },
  safeBatchSizing: {
    conservativeProxy: 'claim tx computeUnitsConsumed p95',
    perLeafP95: txP95,
    under200k: {
      margin20: safeB(200000, 20, txP95),
      margin30: safeB(200000, 30, txP95),
    },
    under400k: {
      margin20: safeB(400000, 20, txP95),
      margin30: safeB(400000, 30, txP95),
    },
  },
  scaleTxCounts: {
    tickets100k: {
      b200k20: txCount(100000, safeB(200000, 20, txP95)),
      b200k30: txCount(100000, safeB(200000, 30, txP95)),
      b400k20: txCount(100000, safeB(400000, 20, txP95)),
      b400k30: txCount(100000, safeB(400000, 30, txP95)),
    },
    tickets1m: {
      b200k20: txCount(1000000, safeB(200000, 20, txP95)),
      b200k30: txCount(1000000, safeB(200000, 30, txP95)),
      b400k20: txCount(1000000, safeB(400000, 20, txP95)),
      b400k30: txCount(1000000, safeB(400000, 30, txP95)),
    },
    tickets10m: {
      b200k20: txCount(10000000, safeB(200000, 20, txP95)),
      b200k30: txCount(10000000, safeB(200000, 30, txP95)),
      b400k20: txCount(10000000, safeB(400000, 20, txP95)),
      b400k30: txCount(10000000, safeB(400000, 30, txP95)),
    },
  },
  notes: {
    varianceInterpretation: 'Use p95 + margin for deterministic cap; mean is informational only.',
    conservativeUpperBound: 'Claim includes replay/account-write/payout-side state mutation that pure count-batch likely omits.',
  },
};

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ outPath: OUT_PATH, sample: out.sample, stats: out.txComputeUnitsConsumed, safeBatchSizing: out.safeBatchSizing }, null, 2));
