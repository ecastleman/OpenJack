import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getScannerProgram } from "../solana/openjack.js";

const MAX_SIGNATURE_LOOKBACK = 1000;

function ensureIdentifier(name, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid ${label}: ${name}`);
  }
  return name;
}

function clampPositiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const floored = Math.floor(n);
  return Math.min(floored, max);
}

function toNum(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "object" && typeof value.toString === "function") {
    const n = Number(value.toString());
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function isTicketPurchasedEventName(name) {
  const normalized = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return normalized === "ticketpurchased";
}

function normalizeAssetId(raw) {
  if (!raw) return null;
  const value = String(raw);
  if (value === "11111111111111111111111111111111") return null;
  return value;
}

function assetHeuristicFallbackEnabled() {
  const raw = String(process.env.OPENJACK_ASSET_HEURISTIC_FALLBACK || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

let heuristicAssetWarningShown = false;

function extractLeafAssetIds(logs) {
  const ids = [];
  for (const line of logs || []) {
    const msg = String(line || "");
    const directMatch = msg.match(/Leaf asset ID:?\s*([^\s,;]+)/i);
    if (directMatch?.[1]) {
      const candidate = directMatch[1].trim();
      if (/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(candidate)) {
        ids.push(candidate);
        continue;
      }
    }

    const lower = msg.toLowerCase();
    const marker = "leaf asset id";
    const markerPos = lower.indexOf(marker);
    if (markerPos >= 0) {
      const tail = msg.slice(markerPos + marker.length).replace(/^[:\s-]+/, "");
      const token = tail.split(/[\s,;]+/).find(Boolean);
      if (token && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(token)) {
        ids.push(token);
      }
    }
  }
  return ids;
}

function extractAssetIdsFromProgramReturnLogs(logs) {
  const result = [];
  for (const line of logs || []) {
    const msg = String(line || "");
    const match = msg.match(/Program return:\s+[1-9A-HJ-NP-Za-km-z]{32,44}\s+([A-Za-z0-9+/=]+)/);
    if (!match?.[1]) continue;
    try {
      const bytes = Buffer.from(match[1], "base64");
      if (bytes.length >= 33) {
        const keyBytes = bytes.subarray(1, 33);
        const candidate = new PublicKey(keyBytes).toBase58();
        if (candidate !== "11111111111111111111111111111111") {
          result.push(candidate);
        }
      }
    } catch {
      // ignore malformed lines
    }
  }
  return result;
}

function extractAssetIdsFromReturnData(meta) {
  const result = [];
  const returnData = meta?.returnData;
  if (!returnData?.data) return result;
  const raw = Array.isArray(returnData.data) ? returnData.data[0] : returnData.data;
  if (!raw || typeof raw !== "string") return result;
  try {
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length >= 33) {
      const keyBytes = bytes.subarray(1, 33);
      const candidate = new PublicKey(keyBytes).toBase58();
      if (candidate !== "11111111111111111111111111111111") {
        result.push(candidate);
      }
    }
  } catch {
    // ignore malformed payloads
  }
  return result;
}

function attachAssetIds(events, { logs, meta }) {
  if (!Array.isArray(events) || events.length === 0) return events;
  if (!assetHeuristicFallbackEnabled()) return events;
  const ids = [
    ...extractAssetIdsFromReturnData(meta),
    ...extractAssetIdsFromProgramReturnLogs(logs),
    ...extractLeafAssetIds(logs),
  ];
  if (ids.length === 0) return events;
  if (!heuristicAssetWarningShown) {
    heuristicAssetWarningShown = true;
    console.warn("[scanner] asset_id_source=heuristic (OPENJACK_ASSET_HEURISTIC_FALLBACK=true)");
  }
  let idx = 0;
  return events.map((event) => {
    if (event.assetId) return event;
    const assetId = ids[idx] || null;
    idx += 1;
    return {
      ...event,
      assetId: normalizeAssetId(assetId),
    };
  });
}

async function fetchTransactionWithFallback(connection, signature) {
  const options = { commitment: "finalized", maxSupportedTransactionVersion: 0 };
  let tx = await connection.getTransaction(signature, options);
  if (tx) return tx;
  tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (tx) return tx;
  const parsed = await connection.getParsedTransaction(signature, options);
  return parsed || null;
}

function readJson(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function parseEventsPayload(payload, roundId) {
  if (!Array.isArray(payload)) throw new Error("events payload must be an array");
  return payload
    .filter((e) => Number(e.roundId) === Number(roundId))
    .map((e) => ({
      roundId: Number(e.roundId),
      leafIndex: Number(e.leafIndex),
      main: e.main,
      bonus: Number(e.bonus),
      purchaser: e.purchaser,
      paidLamports: Number(e.paidLamports || 0),
      ts: Number(e.ts || Math.floor(Date.now() / 1000)),
      assetId: e.assetId || null,
      txSignature: e.txSignature || null,
      slot: Number(e.slot || 0),
      blockTime: Number(e.blockTime || e.ts || 0),
      commitment: String(e.commitment || "finalized"),
      provider: e.provider || "file",
      seqInTx: e.seqInTx == null ? null : Number(e.seqInTx),
    }));
}

class SampleEventSource {
  async load(roundId) {
    return [
      {
        roundId,
        leafIndex: 0,
        main: [1, 2, 3, 4, 5],
        bonus: 1,
        purchaser: "11111111111111111111111111111111",
        paidLamports: 100,
        ts: 1700000000,
        assetId: null,
        txSignature: null,
        slot: 0,
        blockTime: 1700000000,
        commitment: "finalized",
        provider: "sample",
        seqInTx: 0,
      },
    ];
  }
}

class FileEventSource {
  constructor({ wsPath, backfillPath }) {
    this.wsPath = wsPath;
    this.backfillPath = backfillPath || wsPath;
  }

  async load(roundId) {
    const ws = parseEventsPayload(readJson(this.wsPath), roundId);
    const backfill = parseEventsPayload(readJson(this.backfillPath), roundId);
    return { wsEvents: ws, backfillEvents: backfill };
  }
}

class PostgresEventSource {
  constructor({ databaseUrl, table, roundColumn, leafColumn }) {
    this.pool = new Pool({ connectionString: databaseUrl });
    this.table = ensureIdentifier(table, "table");
    this.roundColumn = ensureIdentifier(roundColumn, "round column");
    this.leafColumn = ensureIdentifier(leafColumn, "leaf column");
  }

  async load(roundId) {
    const query = `
      SELECT
        ${this.roundColumn} AS round_id,
        ${this.leafColumn} AS leaf_index,
        main,
        bonus,
        purchaser,
        paid_lamports,
        ts,
        asset_id,
        tx_signature,
        slot,
        EXTRACT(EPOCH FROM block_time)::BIGINT AS block_time_unix,
        commitment,
        provider,
        seq_in_tx
      FROM ${this.table}
      WHERE ${this.roundColumn} = $1
      ORDER BY ${this.leafColumn} ASC
    `;
    const { rows } = await this.pool.query(query, [roundId]);
    const events = rows.map((r) => ({
      roundId: Number(r.round_id),
      leafIndex: Number(r.leaf_index),
      main: r.main,
      bonus: Number(r.bonus),
        purchaser: r.purchaser,
        paidLamports: Number(r.paid_lamports || 0),
        ts: Number(r.ts || Math.floor(Date.now() / 1000)),
        assetId: r.asset_id || null,
        txSignature: r.tx_signature || null,
        slot: Number(r.slot || 0),
        blockTime: Number(r.block_time_unix || 0),
        commitment: String(r.commitment || "finalized"),
        provider: r.provider || null,
        seqInTx: r.seq_in_tx == null ? null : Number(r.seq_in_tx),
      }));
    return { wsEvents: events, backfillEvents: events };
  }
}

class RpcEventSource {
  constructor({ limit }) {
    this.limit = limit;
  }

  async load(roundId) {
    const { connection, programId, program } = getScannerProgram();
    const parser = new anchor.EventParser(programId, program.coder);
    const explicitSignatures = String(process.env.OPENJACK_RPC_SIGNATURES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ordered = [];
    if (explicitSignatures.length > 0) {
      for (const signature of explicitSignatures) {
        ordered.push({ signature });
      }
    } else {
      const signatures = await connection.getSignaturesForAddress(programId, {
        limit: this.limit,
        commitment: "finalized",
      });
      ordered.push(...[...signatures].reverse());
    }
    const events = [];

    let parsedCount = 0;
    for (const sigInfo of ordered) {
      const signature = sigInfo.signature;
      const tx = await fetchTransactionWithFallback(connection, signature);
      if (!tx) {
        if (process.env.OPENJACK_DEBUG_EVENTS === "true") {
          console.log(`[scanner] rpc tx not found signature=${signature}`);
        }
        continue;
      }
      const logs = tx?.meta?.logMessages || [];
      const parsedInTx = [];
      let seqInTx = 0;
      for (const ev of parser.parseLogs(logs)) {
        if (!isTicketPurchasedEventName(ev.name)) continue;
        parsedCount += 1;
        const data = ev.data || {};
        const eventRoundId = toNum(data.roundId ?? data.round_id ?? 0);
        if (eventRoundId !== Number(roundId)) continue;
        parsedInTx.push({
          roundId: eventRoundId,
          leafIndex: toNum(data.leafIndex ?? data.leaf_index ?? 0),
          main: data.main,
          bonus: toNum(data.bonus ?? 0),
          purchaser: String(data.purchaser || ""),
          paidLamports: toNum(data.paidLamports ?? data.paid_lamports ?? 0),
          ts: toNum(data.ts || 0),
          assetId: normalizeAssetId(data.assetId ?? data.asset_id ?? null),
          txSignature: signature,
          slot: toNum(sigInfo?.slot ?? tx?.slot ?? 0),
          blockTime: toNum(tx?.blockTime ?? sigInfo?.blockTime ?? 0),
          commitment: "finalized",
          provider: "rpc",
          seqInTx: seqInTx++,
        });
      }
      events.push(...attachAssetIds(parsedInTx, { logs, meta: tx?.meta }));
    }

    if (process.env.OPENJACK_DEBUG_EVENTS === "true") {
      console.log(
        `[scanner] rpc events parsed=${parsedCount} matched_round=${events.length} requested_round=${roundId} signatures=${ordered.length}`,
      );
    }

    return { wsEvents: events, backfillEvents: events };
  }
}

function parseTicketPurchasedEvents(parser, logs, roundId, txSignature = null, txMeta = null) {
  const events = [];
  let seqInTx = 0;
  for (const ev of parser.parseLogs(logs || [])) {
    if (!isTicketPurchasedEventName(ev.name)) continue;
    const data = ev.data || {};
    const eventRoundId = toNum(data.roundId ?? data.round_id ?? 0);
    if (eventRoundId !== Number(roundId)) continue;
    events.push({
      roundId: eventRoundId,
      leafIndex: toNum(data.leafIndex ?? data.leaf_index ?? 0),
      main: data.main,
      bonus: toNum(data.bonus ?? 0),
      purchaser: String(data.purchaser || ""),
      paidLamports: toNum(data.paidLamports ?? data.paid_lamports ?? 0),
      ts: toNum(data.ts || 0),
      assetId: normalizeAssetId(data.assetId ?? data.asset_id ?? null),
      txSignature: txSignature || null,
      slot: toNum(txMeta?.slot ?? 0),
      blockTime: toNum(txMeta?.blockTime ?? 0),
      commitment: "finalized",
      provider: "rpc-dual",
      seqInTx: seqInTx++,
    });
  }
  return attachAssetIds(events, { logs, meta: txMeta });
}

class RpcDualEventSource {
  constructor({ signatureLimit, slotBackfillLimit }) {
    this.signatureLimit = signatureLimit;
    this.slotBackfillLimit = slotBackfillLimit;
  }

  async load(roundId) {
    const { connection, programId, program } = getScannerProgram();
    const parser = new anchor.EventParser(programId, program.coder);

    const signatures = await connection.getSignaturesForAddress(programId, {
      limit: this.signatureLimit,
      commitment: "finalized",
    });
    const orderedSigs = [...signatures].reverse();

    const wsEvents = [];
    for (const sigInfo of orderedSigs) {
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      const txMeta = {
        ...(tx?.meta || {}),
        slot: toNum(sigInfo?.slot ?? tx?.slot ?? 0),
        blockTime: toNum(tx?.blockTime ?? sigInfo?.blockTime ?? 0),
      };
      wsEvents.push(
        ...parseTicketPurchasedEvents(parser, tx?.meta?.logMessages || [], roundId, sigInfo.signature, txMeta),
      );
    }

    const slots = [...new Set(signatures.map((s) => Number(s.slot)).filter((s) => Number.isFinite(s)))].sort(
      (a, b) => a - b,
    );
    const backfillSlots = slots.slice(Math.max(0, slots.length - this.slotBackfillLimit));
    const backfillEvents = [];
    for (const slot of backfillSlots) {
      const block = await connection.getBlock(slot, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
        transactionDetails: "full",
        rewards: false,
      });
      const txs = block?.transactions || [];
      for (const tx of txs) {
        const signature = tx?.transaction?.signatures?.[0] || null;
        const txMeta = {
          ...(tx?.meta || {}),
          slot: toNum(slot),
          blockTime: toNum(block?.blockTime || 0),
        };
        backfillEvents.push(
          ...parseTicketPurchasedEvents(parser, tx?.meta?.logMessages || [], roundId, signature, txMeta),
        );
      }
    }

    return { wsEvents, backfillEvents };
  }
}

export function parseWinningFromEnv() {
  const mainRaw = process.env.OPENJACK_WINNING_MAIN || "1,2,3,4,5";
  const bonusRaw = process.env.OPENJACK_WINNING_BONUS || "1";
  return {
    main: mainRaw.split(",").map((x) => Number(x.trim())),
    bonus: Number(bonusRaw),
  };
}

export async function loadRoundEvents({ roundId }) {
  const mode = (process.env.OPENJACK_EVENT_SOURCE_MODE || "sample").toLowerCase();
  if (mode === "sample") {
    const source = new SampleEventSource();
    const events = await source.load(roundId);
    return { wsEvents: events, backfillEvents: events };
  }
  if (mode === "file") {
    const source = new FileEventSource({
      wsPath: process.env.OPENJACK_WS_EVENTS_PATH || "",
      backfillPath: process.env.OPENJACK_BACKFILL_EVENTS_PATH || "",
    });
    return source.load(roundId);
  }
  if (mode === "postgres") {
    const source = new PostgresEventSource({
      databaseUrl:
        process.env.OPENJACK_EVENT_DATABASE_URL ||
        process.env.SCANNER_DATABASE_URL ||
        process.env.DATABASE_URL ||
        "postgres://localhost:5432/openjack",
      table: process.env.OPENJACK_EVENT_TABLE || "ticket_events",
      roundColumn: process.env.OPENJACK_EVENT_ROUND_COLUMN || "round_id",
      leafColumn: process.env.OPENJACK_EVENT_LEAF_COLUMN || "leaf_index",
    });
    return source.load(roundId);
  }
  if (mode === "rpc") {
    const source = new RpcEventSource({
      limit: clampPositiveInt(process.env.OPENJACK_RPC_LOOKBACK_LIMIT || 300, 300, MAX_SIGNATURE_LOOKBACK),
    });
    return source.load(roundId);
  }
  if (mode === "rpc-dual") {
    const source = new RpcDualEventSource({
      signatureLimit: clampPositiveInt(
        process.env.OPENJACK_RPC_LOOKBACK_LIMIT || 300,
        300,
        MAX_SIGNATURE_LOOKBACK,
      ),
      slotBackfillLimit: Number(process.env.OPENJACK_RPC_SLOT_BACKFILL_LIMIT || 200),
    });
    return source.load(roundId);
  }
  throw new Error(`unknown OPENJACK_EVENT_SOURCE_MODE: ${mode}`);
}
