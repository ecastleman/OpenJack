import fs from "node:fs";
import path from "node:path";

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
      ticketProof: Array.isArray(ticket.ticketProof) ? ticket.ticketProof : [],
      ownershipProof: ticket.ownershipProof ?? null,
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
      assetId: ticket.assetId || proof.assetId || null,
      ticketProof: Array.isArray(proof.ticketProof) ? proof.ticketProof : [],
      ownershipProof: proof.ownershipProof ?? null,
    };
  }
}

class DasProofProvider {
  constructor({ rpcUrl }) {
    this.rpcUrl = rpcUrl;
  }

  async rpc(method, params) {
    const res = await fetch(this.rpcUrl, {
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

  async enrich(ticket) {
    const assetId = ticket.assetId;
    if (!assetId) {
      return {
        ...ticket,
        ticketProof: [],
        ownershipProof: null,
      };
    }

    const [asset, assetProof] = await Promise.all([
      this.rpc("getAsset", { id: assetId }),
      this.rpc("getAssetProof", { id: assetId }),
    ]);

    return {
      ...ticket,
      assetId,
      ticketProof: Array.isArray(assetProof?.proof) ? assetProof.proof : [],
      ownershipProof: {
        owner: asset?.ownership?.owner || null,
        delegate: asset?.ownership?.delegate || null,
        ownershipModel: asset?.ownership?.ownership_model || null,
      },
    };
  }
}

export function getProofProviderFromEnv() {
  const mode = (process.env.OPENJACK_PROOF_MODE || "off").toLowerCase();
  if (mode === "off") return new OffProofProvider();
  if (mode === "file") {
    return new FileProofProvider({ mapPath: process.env.OPENJACK_PROOF_MAP_PATH || "" });
  }
  if (mode === "das") {
    const rpcUrl = process.env.OPENJACK_DAS_RPC_URL || process.env.RPC_URL;
    if (!rpcUrl || !isHttpUrl(rpcUrl)) {
      throw new Error("OPENJACK_DAS_RPC_URL (or RPC_URL) must be set for proof mode=das");
    }
    return new DasProofProvider({ rpcUrl });
  }
  throw new Error(`unknown OPENJACK_PROOF_MODE: ${mode}`);
}
