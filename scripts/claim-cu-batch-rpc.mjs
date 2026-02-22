import fs from 'node:fs';

const RPC = process.env.OPENJACK_CU_RPC_URL || process.env.RPC_URL || 'https://api.devnet.solana.com';
const SIG_PATH = '/Users/ernesto/Documents/New project/reports/protocol-gate/devnet-claim-signatures.txt';
const OUT_PATH = '/Users/ernesto/Documents/New project/reports/protocol-gate/devnet-claim-cu-statistics.json';
const PROGRAM_ID = (process.env.OPENJACK_PROGRAM_ID || '').trim();

const sigs = fs.readFileSync(SIG_PATH, 'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function percentile(sorted, q){ if(!sorted.length) return null; const i=Math.min(sorted.length-1, Math.floor((sorted.length-1)*q)); return sorted[i]; }

async function rpcBatch(payload, maxAttempts = 8){
  let delay=500;
  for(let attempt=1; attempt<=maxAttempts; attempt++){
    const res = await fetch(RPC, {
      method: 'POST',
      headers: {'content-type':'application/json'},
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

function chunk(arr, size){
  const out=[];
  for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}

function extractProgramConsumed(logs, programId){
  if(!Array.isArray(logs) || !programId) return null;
  const rx = new RegExp(`^Program\\s+${programId}\\s+consumed\\s+(\\d+)\\s+of\\s+(\\d+)\\s+compute units`);
  let max = null;
  for(const line of logs){
    const m = String(line).match(rx);
    if(m){
      const v = Number(m[1]);
      if(Number.isFinite(v)) max = max === null ? v : Math.max(max, v);
    }
  }
  return max;
}

const txRows = [];
let failed = 0;
let batchCalls = 0;
for (const group of chunk(sigs, 12)) {
  const payload = group.map((sig, idx) => ({
    jsonrpc: '2.0',
    id: idx + 1,
    method: 'getTransaction',
    params: [sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
  }));
  batchCalls += 1;
  let resp;
  try {
    resp = await rpcBatch(payload);
  } catch (e) {
    failed += group.length;
    continue;
  }
  const arr = Array.isArray(resp) ? resp : [];
  const byId = new Map(arr.map((r)=>[r.id,r]));
  for (let i=0;i<group.length;i++) {
    const sig = group[i];
    const item = byId.get(i+1);
    const tx = item?.result;
    if (!tx || tx.meta?.err) { failed += 1; continue; }
    const txCu = Number(tx.meta?.computeUnitsConsumed);
    if (!Number.isFinite(txCu) || txCu <= 0) { failed += 1; continue; }
    const logs = tx.meta?.logMessages || [];
    const ixCu = extractProgramConsumed(logs, PROGRAM_ID);
    txRows.push({ sig, txCu, ixCu });
  }
  await sleep(300);
}

const txVals = txRows.map(r=>r.txCu).sort((a,b)=>a-b);
const ixVals = txRows.filter(r=>Number.isFinite(r.ixCu)).map(r=>r.ixCu).sort((a,b)=>a-b);
const mean = (arr)=> arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
const std = (arr,mu)=> {
  if(arr.length<=1 || mu===null) return null;
  const v = arr.reduce((acc,x)=>acc + (x-mu)*(x-mu),0)/(arr.length-1);
  return Math.round(Math.sqrt(v));
};

const txMean = mean(txVals);
const txStd = std(txVals, txMean);
const txCv = txMean && txStd ? Number((txStd/txMean).toFixed(4)) : null;
const txP95 = percentile(txVals,0.95);
const txMax = txVals.length ? txVals[txVals.length-1] : null;

function safeB(limit, marginPct, perLeaf){
  if(!perLeaf) return null;
  const usable = limit * (1 - marginPct/100);
  return Math.max(1, Math.floor(usable/perLeaf));
}
function txCount(n,b){ return b ? Math.ceil(n/b) : null; }

const out = {
  generatedAt: new Date().toISOString(),
  rpc: RPC,
  sample: {
    fixedSignatures: sigs.length,
    matchedWithComputeUnits: txVals.length,
    instructionRows: ixVals.length,
    failed,
    batchCalls,
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
    mean: mean(ixVals),
    p95: percentile(ixVals,0.95),
    max: ixVals.length ? ixVals[ixVals.length-1] : null,
    min: ixVals[0] ?? null,
    stdev: std(ixVals, mean(ixVals)),
    cv: mean(ixVals) && std(ixVals, mean(ixVals)) ? Number((std(ixVals, mean(ixVals))/mean(ixVals)).toFixed(4)) : null,
    programId: PROGRAM_ID || null,
  },
  safeBatchSizing: {
    conservativeProxy: 'claim tx computeUnitsConsumed p95',
    perLeafP95: txP95,
    under200k: {
      margin20: safeB(200000,20,txP95),
      margin30: safeB(200000,30,txP95),
    },
    under400k: {
      margin20: safeB(400000,20,txP95),
      margin30: safeB(400000,30,txP95),
    },
  },
  scaleTxCounts: {
    tickets100k: {
      b200k20: txCount(100000, safeB(200000,20,txP95)),
      b200k30: txCount(100000, safeB(200000,30,txP95)),
      b400k20: txCount(100000, safeB(400000,20,txP95)),
      b400k30: txCount(100000, safeB(400000,30,txP95)),
    },
    tickets1m: {
      b200k20: txCount(1000000, safeB(200000,20,txP95)),
      b200k30: txCount(1000000, safeB(200000,30,txP95)),
      b400k20: txCount(1000000, safeB(400000,20,txP95)),
      b400k30: txCount(1000000, safeB(400000,30,txP95)),
    },
    tickets10m: {
      b200k20: txCount(10000000, safeB(200000,20,txP95)),
      b200k30: txCount(10000000, safeB(200000,30,txP95)),
      b400k20: txCount(10000000, safeB(400000,20,txP95)),
      b400k30: txCount(10000000, safeB(400000,30,txP95)),
    },
  },
  notes: {
    varianceInterpretation: 'Use p95 + margin for deterministic cap; mean is informational only.',
    conservativeUpperBound: 'Claim includes state writes/nullifier and payout-side balance mutation not needed in pure batch counting, so this is conservative.',
    congestion: '429 responses observed during fetch imply public RPC contention; batch call approach mitigates but does not eliminate external rate-limit noise.',
  },
};

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ outPath: OUT_PATH, sample: out.sample, stats: out.txComputeUnitsConsumed, safeBatchSizing: out.safeBatchSizing }, null, 2));
