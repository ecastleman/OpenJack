import crypto from "node:crypto";

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hexToBuf(hex) {
  return Buffer.from(hex, "hex");
}

function sortPair(a, b) {
  return a <= b ? [a, b] : [b, a];
}

function hashPair(a, b) {
  const [lo, hi] = sortPair(a, b);
  return sha256Hex(Buffer.concat([hexToBuf(lo), hexToBuf(hi)]));
}

function leafHash(leafIndex) {
  return sha256Hex(`leaf:${leafIndex}`);
}

export function buildMerkleRootAndProofs(leafIndexes) {
  const uniqueSorted = [...new Set(leafIndexes)].sort((a, b) => a - b);
  if (uniqueSorted.length === 0) {
    return { rootHash: sha256Hex(""), proofsByLeaf: new Map() };
  }

  const levels = [];
  const firstLevel = uniqueSorted.map((leafIndex) => ({
    leafIndex,
    hash: leafHash(leafIndex),
  }));
  levels.push(firstLevel);

  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i];
      const right = prev[i + 1] || prev[i];
      next.push({ hash: hashPair(left.hash, right.hash) });
    }
    levels.push(next);
  }

  const rootHash = levels[levels.length - 1][0].hash;
  const proofsByLeaf = new Map();
  for (let idx = 0; idx < firstLevel.length; idx += 1) {
    const leafIndex = firstLevel[idx].leafIndex;
    let pos = idx;
    const proof = [];
    for (let depth = 0; depth < levels.length - 1; depth += 1) {
      const level = levels[depth];
      const siblingPos = pos % 2 === 0 ? pos + 1 : pos - 1;
      const sibling = level[siblingPos] || level[pos];
      proof.push(sibling.hash);
      pos = Math.floor(pos / 2);
    }
    proofsByLeaf.set(leafIndex, proof);
  }

  return { rootHash, proofsByLeaf };
}
