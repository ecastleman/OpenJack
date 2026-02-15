import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { PublicKey } from "@solana/web3.js";
import { fetchRoundTreeAddress } from "../solana/openjack.js";

class OffAssetResolver {
  async resolve() {
    return null;
  }
}

class FileAssetResolver {
  constructor({ mapPath }) {
    this.mapPath = mapPath;
    this.loaded = false;
    this.entries = {};
  }

  ensureLoaded() {
    if (this.loaded) return;
    if (!this.mapPath) {
      throw new Error("OPENJACK_ASSET_MAP_PATH is required for asset resolver mode=file");
    }
    const resolved = path.resolve(process.cwd(), this.mapPath);
    this.entries = JSON.parse(fs.readFileSync(resolved, "utf8"));
    this.loaded = true;
  }

  async resolve({ roundId, leafIndex }) {
    this.ensureLoaded();
    const byRound = this.entries.byRound || {};
    const byLeaf = this.entries.byLeafIndex || {};

    const roundKey = String(roundId);
    const leafKey = String(leafIndex);

    if (byRound[roundKey] && byRound[roundKey][leafKey]) {
      return byRound[roundKey][leafKey];
    }
    return byLeaf[leafKey] || null;
  }
}

class PostgresAssetResolver {
  constructor({ databaseUrl, table, roundColumn, leafColumn, assetColumn }) {
    this.pool = new Pool({ connectionString: databaseUrl });
    this.table = table;
    this.roundColumn = roundColumn;
    this.leafColumn = leafColumn;
    this.assetColumn = assetColumn;
  }

  async resolve({ roundId, leafIndex }) {
    const query = `
      SELECT ${this.assetColumn} AS asset_id
      FROM ${this.table}
      WHERE ${this.roundColumn} = $1 AND ${this.leafColumn} = $2
      LIMIT 1
    `;
    const { rows } = await this.pool.query(query, [roundId, leafIndex]);
    return rows[0]?.asset_id || null;
  }
}

function toLe8(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

class DerivedAssetResolver {
  constructor({ bubblegumProgramId }) {
    this.bubblegumProgramId = new PublicKey(
      bubblegumProgramId || process.env.OPENJACK_BUBBLEGUM_PROGRAM_ID || "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY",
    );
    this.treeCache = new Map();
  }

  async resolve({ roundId, leafIndex }) {
    const key = String(roundId);
    let treeAddress = this.treeCache.get(key);
    if (!treeAddress) {
      treeAddress = await fetchRoundTreeAddress(roundId);
      this.treeCache.set(key, treeAddress);
    }
    const tree = new PublicKey(treeAddress);
    const [assetId] = PublicKey.findProgramAddressSync(
      [Buffer.from("asset"), tree.toBuffer(), toLe8(leafIndex)],
      this.bubblegumProgramId,
    );
    return assetId.toBase58();
  }
}

export function getAssetResolverFromEnv() {
  const mode = (process.env.OPENJACK_ASSET_RESOLVER_MODE || "off").toLowerCase();
  if (mode === "off") return new OffAssetResolver();

  if (mode === "file") {
    return new FileAssetResolver({
      mapPath: process.env.OPENJACK_ASSET_MAP_PATH || "",
    });
  }

  if (mode === "postgres") {
    return new PostgresAssetResolver({
      databaseUrl:
        process.env.OPENJACK_ASSET_DATABASE_URL ||
        process.env.SCANNER_DATABASE_URL ||
        process.env.DATABASE_URL ||
        "postgres://localhost:5432/openjack",
      table: process.env.OPENJACK_ASSET_TABLE || "ticket_ledger",
      roundColumn: process.env.OPENJACK_ASSET_ROUND_COLUMN || "round_id",
      leafColumn: process.env.OPENJACK_ASSET_LEAF_COLUMN || "leaf_index",
      assetColumn: process.env.OPENJACK_ASSET_ID_COLUMN || "asset_id",
    });
  }

  if (mode === "derived") {
    return new DerivedAssetResolver({
      bubblegumProgramId: process.env.OPENJACK_BUBBLEGUM_PROGRAM_ID,
    });
  }

  throw new Error(`unknown OPENJACK_ASSET_RESOLVER_MODE: ${mode}`);
}
