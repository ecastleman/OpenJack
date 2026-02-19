import fs from "node:fs";
import path from "node:path";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHttpUrl(input) {
  return /^https?:\/\//i.test(input || "");
}

function loadJsonFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

class OffProofProvider {
  async enrich(ticket) {
    return {
      ...ticket,
      proofProvider: "off",
      proofStatus: "PENDING_PROOF",
      proofAttemptCount: 0,
      proofError: null,
      ticketProof: Array.isArray(ticket.ticketProof) ? ticket.ticketProof : [],
      ownershipProof: ticket.ownershipProof ?? null,
      compressionRoot: ticket.compressionRoot || null,
      compressionLeaf: ticket.compressionLeaf || null,
      compressionIndex:
        ticket.compressionIndex === undefined || ticket.compressionIndex === null
          ? null
          : Number(ticket.compressionIndex),
    };
  }
}

class FileProofProvider {
  constructor({ mapPath }) {
    this.mapPath = mapPath;
    this.loaded = false;
    this.entries = {};
  }

  ensureLoaded() {
    if (this.loaded) return;
    if (!this.mapPath) {
      throw new Error("OPENJACK_PROOF_MAP_PATH is required for proof mode=file");
    }
    this.entries = loadJsonFile(this.mapPath);
    this.loaded = true;
  }

  async enrich(ticket) {
    this.ensureLoaded();
    const byLeaf = this.entries.byLeafIndex || {};
    const byAsset = this.entries.byAssetId || {};
    const fromLeaf = byLeaf[String(ticket.leafIndex)] || {};
    const fromAsset = ticket.assetId ? byAsset[String(ticket.assetId)] || {} : {};
    const proof = { ...fromLeaf, ...fromAsset };

    return {
      ...ticket,
      proofProvider: "file",
      proofStatus: "READY",
      proofAttemptCount: 1,
      proofError: null,
      assetId: ticket.assetId || proof.assetId || null,
      ticketProof: Array.isArray(proof.ticketProof) ? proof.ticketProof : [],
      ownershipProof: proof.ownershipProof ?? null,
      compressionRoot: proof.compressionRoot || null,
      compressionLeaf: proof.compressionLeaf || null,
      compressionIndex:
        proof.compressionIndex === undefined || proof.compressionIndex === null
          ? null
          : Number(proof.compressionIndex),
    };
  }
}

class DasProofProvider {
  constructor({ rpcUrl, fallbackRpcUrl = "" }) {
    this.rpcUrl = rpcUrl;
    this.fallbackRpcUrl = fallbackRpcUrl;
    this.maxAttempts = Math.max(1, Number(process.env.OPENJACK_PROOF_MAX_ATTEMPTS || 3));
    this.backoffBaseMs = Math.max(0, Number(process.env.OPENJACK_PROOF_BACKOFF_BASE_MS || 400));
    this.backoffMaxMs = Math.max(this.backoffBaseMs, Number(process.env.OPENJACK_PROOF_BACKOFF_MAX_MS || 5000));
    this.jitterMs = Math.max(0, Number(process.env.OPENJACK_PROOF_JITTER_MS || 200));
  }

  async rpcOnce(method, params, url) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });
    if (!res.ok) {
      throw new Error(`DAS rpc failed: ${res.status}`);
    }
    const json = await res.json();
    if (json.error) {
      throw new Error(`DAS rpc error: ${json.error.message || "unknown_error"}`);
    }
    return json.result;
  }

  async rpc(method, params) {
    try {
      return await this.rpcOnce(method, params, this.rpcUrl);
    } catch (primaryError) {
      if (!this.fallbackRpcUrl || this.fallbackRpcUrl === this.rpcUrl || !this.shouldFallback(primaryError)) {
        throw primaryError;
      }
      return this.rpcOnce(method, params, this.fallbackRpcUrl);
    }
  }

  shouldFallback(error) {
    const text = String(error instanceof Error ? error.message : error || "");
    if (/RecordNotFound|Asset Proof Not Found|missing_asset_id|incomplete_proof_payload/i.test(text)) {
      return false;
    }
    if (/DAS rpc failed:\s*(408|425|429|500|502|503|504)\b/i.test(text)) {
      return true;
    }
    if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i.test(text)) {
      return true;
    }
    return false;
  }

  classifyFinalState(errorMessage) {
    const text = String(errorMessage || "");
    if (/DAS rpc failed:\s*(401|403)\b/i.test(text)) {
      return "FAILED";
    }
    if (/invalid|malformed|parse|ownership mismatch|bad request/i.test(text)) {
      return "FAILED";
    }
    if (/RecordNotFound|Asset Proof Not Found/i.test(text)) {
      return "PENDING_PROOF";
    }
    if (/DAS rpc failed:\s*(408|425|429|500|502|503|504)\b/i.test(text)) {
      return "PENDING_PROOF";
    }
    if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i.test(text)) {
      return "PENDING_PROOF";
    }
    return "FAILED";
  }

  nextBackoffMs(attempt) {
    const exp = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
    const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
    return exp + jitter;
  }

  async enrich(ticket) {
    const assetId = ticket.assetId;
    if (!assetId) {
      return {
        ...ticket,
        proofProvider: "das",
        proofStatus: "PENDING_PROOF",
        proofAttemptCount: 0,
        proofError: "missing_asset_id",
        ticketProof: [],
        ownershipProof: null,
      };
    }

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const [asset, assetProof] = await Promise.all([
          this.rpc("getAsset", { id: assetId }),
          this.rpc("getAssetProof", { id: assetId }),
        ]);

        const ticketProof = Array.isArray(assetProof?.proof) ? assetProof.proof : [];
        const compressionRoot = assetProof?.root || null;
        const compressionLeaf = assetProof?.leaf || null;
        const compressionIndex =
          assetProof?.node_index === undefined || assetProof?.node_index === null
            ? ticket.leafIndex
            : Number(assetProof.node_index);
        const owner = asset?.ownership?.owner || null;
        if (!ticketProof.length || !compressionRoot || !compressionLeaf || !owner) {
          lastError = "incomplete_proof_payload";
          if (attempt < this.maxAttempts) {
            await sleep(this.nextBackoffMs(attempt));
            continue;
          }
          return {
            ...ticket,
            proofProvider: "das",
            proofStatus: "PENDING_PROOF",
            proofAttemptCount: attempt,
            proofError: lastError,
            assetId,
            ticketProof,
            compressionRoot,
            compressionLeaf,
            compressionIndex,
            ownershipProof: {
              owner,
              delegate: asset?.ownership?.delegate || null,
              ownershipModel: asset?.ownership?.ownership_model || null,
            },
          };
        }

        return {
          ...ticket,
          proofProvider: "das",
          proofStatus: "READY",
          proofAttemptCount: attempt,
          proofError: null,
          assetId,
          ticketProof,
          compressionRoot,
          compressionLeaf,
          compressionIndex,
          ownershipProof: {
            owner,
            delegate: asset?.ownership?.delegate || null,
            ownershipModel: asset?.ownership?.ownership_model || null,
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < this.maxAttempts) {
          await sleep(this.nextBackoffMs(attempt));
          continue;
        }
      }
    }

    const finalStatus = this.classifyFinalState(lastError);
    return {
      ...ticket,
      proofProvider: "das",
      proofStatus: finalStatus,
      proofAttemptCount: this.maxAttempts,
      proofError: lastError || "proof_hydration_failed",
      ticketProof: Array.isArray(ticket.ticketProof) ? ticket.ticketProof : [],
      ownershipProof: ticket.ownershipProof ?? null,
      compressionRoot: ticket.compressionRoot || null,
      compressionLeaf: ticket.compressionLeaf || null,
      compressionIndex:
        ticket.compressionIndex === undefined || ticket.compressionIndex === null
          ? null
          : Number(ticket.compressionIndex),
    };
  }
}

function inferProofStatus(ticket) {
  const explicit = String(ticket?.proofStatus || "").toUpperCase();
  if (explicit === "READY" || explicit === "PENDING_PROOF" || explicit === "FAILED") {
    return explicit;
  }
  const ready = Boolean(
    ticket?.winnerRootHash &&
      ticket?.ownershipProof?.owner &&
      ticket?.compressionRoot &&
      ticket?.compressionLeaf &&
      Number.isInteger(Number(ticket?.compressionIndex)) &&
      Array.isArray(ticket?.ticketProof) &&
      ticket.ticketProof.length > 0,
  );
  return ready ? "READY" : "PENDING_PROOF";
}

function normalizeProofTicket(ticket) {
  const proofStatus = inferProofStatus(ticket);
  return {
    ...ticket,
    proofStatus,
    proofProvider: ticket?.proofProvider || null,
    proofAttemptCount: Number(ticket?.proofAttemptCount || 0),
    proofError: ticket?.proofError || null,
    ticketProof: Array.isArray(ticket?.ticketProof) ? ticket.ticketProof : [],
    ownershipProof: ticket?.ownershipProof ?? null,
    compressionRoot: ticket?.compressionRoot || null,
    compressionLeaf: ticket?.compressionLeaf || null,
    compressionIndex:
      ticket?.compressionIndex === undefined || ticket?.compressionIndex === null
        ? null
        : Number(ticket.compressionIndex),
  };
}

async function mapLimit(items, limit, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const concurrency = Math.max(1, Number(limit || 1));
  const out = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      out[idx] = await mapper(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

export async function enrichTicketsWithProofProvider(tickets, proofProvider) {
  if (!Array.isArray(tickets) || tickets.length === 0) return [];
  if (!proofProvider) return tickets.map(normalizeProofTicket);

  const concurrency = Math.max(1, Number(process.env.OPENJACK_PROOF_CONCURRENCY || 4));
  return mapLimit(tickets, concurrency, async (ticket) => {
    try {
      const enriched = await proofProvider.enrich(ticket);
      return normalizeProofTicket(enriched);
    } catch (error) {
      return normalizeProofTicket({
        ...ticket,
        proofStatus: "FAILED",
        proofError: error instanceof Error ? error.message : String(error),
        proofProvider: "unknown",
        proofAttemptCount: Number(ticket?.proofAttemptCount || 0) + 1,
      });
    }
  });
}

export function getProofProviderFromEnv() {
  const mode = (process.env.OPENJACK_PROOF_MODE || "off").toLowerCase();
  if (mode === "off") return new OffProofProvider();
  if (mode === "file") {
    return new FileProofProvider({ mapPath: process.env.OPENJACK_PROOF_MAP_PATH || "" });
  }
  if (mode === "das") {
    const rpcUrl = process.env.OPENJACK_DAS_RPC_URL || process.env.RPC_URL;
    const fallbackRpcUrl = process.env.OPENJACK_DAS_RPC_FALLBACK_URL || "";
    if (!rpcUrl || !isHttpUrl(rpcUrl)) {
      throw new Error("OPENJACK_DAS_RPC_URL (or RPC_URL) must be set for proof mode=das");
    }
    return new DasProofProvider({ rpcUrl, fallbackRpcUrl });
  }
  throw new Error(`unknown OPENJACK_PROOF_MODE: ${mode}`);
}
