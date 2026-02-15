import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import * as anchor from "@coral-xyz/anchor";
import { getScannerProgram } from "../solana/openjack.js";

function ensureIdentifier(name, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid ${label}: ${name}`);
  }
  return name;
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
        asset_id
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

    const signatures = await connection.getSignaturesForAddress(programId, {
      limit: this.limit,
    });
    const ordered = [...signatures].reverse();
    const events = [];

    for (const sigInfo of ordered) {
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const logs = tx?.meta?.logMessages || [];
      for (const ev of parser.parseLogs(logs)) {
        if (ev.name !== "TicketPurchased") continue;
        const data = ev.data || {};
        const eventRoundId = Number(data.roundId ?? data.round_id ?? 0);
        if (eventRoundId !== Number(roundId)) continue;
        events.push({
          roundId: eventRoundId,
          leafIndex: Number(data.leafIndex ?? data.leaf_index ?? 0),
          main: data.main,
          bonus: Number(data.bonus ?? 0),
          purchaser: String(data.purchaser || ""),
          paidLamports: Number(data.paidLamports ?? data.paid_lamports ?? 0),
          ts: Number(data.ts || 0),
          assetId: null,
        });
      }
    }

    return { wsEvents: events, backfillEvents: events };
  }
}

function parseTicketPurchasedEvents(parser, logs, roundId) {
  const events = [];
  for (const ev of parser.parseLogs(logs || [])) {
    if (ev.name !== "TicketPurchased") continue;
    const data = ev.data || {};
    const eventRoundId = Number(data.roundId ?? data.round_id ?? 0);
    if (eventRoundId !== Number(roundId)) continue;
    events.push({
      roundId: eventRoundId,
      leafIndex: Number(data.leafIndex ?? data.leaf_index ?? 0),
      main: data.main,
      bonus: Number(data.bonus ?? 0),
      purchaser: String(data.purchaser || ""),
      paidLamports: Number(data.paidLamports ?? data.paid_lamports ?? 0),
      ts: Number(data.ts || 0),
      assetId: null,
    });
  }
  return events;
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
    });
    const orderedSigs = [...signatures].reverse();

    const wsEvents = [];
    for (const sigInfo of orderedSigs) {
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      wsEvents.push(...parseTicketPurchasedEvents(parser, tx?.meta?.logMessages || [], roundId));
    }

    const slots = [...new Set(signatures.map((s) => Number(s.slot)).filter((s) => Number.isFinite(s)))].sort(
      (a, b) => a - b,
    );
    const backfillSlots = slots.slice(Math.max(0, slots.length - this.slotBackfillLimit));
    const backfillEvents = [];
    for (const slot of backfillSlots) {
      const block = await connection.getBlock(slot, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
        transactionDetails: "full",
        rewards: false,
      });
      const txs = block?.transactions || [];
      for (const tx of txs) {
        backfillEvents.push(...parseTicketPurchasedEvents(parser, tx?.meta?.logMessages || [], roundId));
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
      limit: Number(process.env.OPENJACK_RPC_LOOKBACK_LIMIT || 300),
    });
    return source.load(roundId);
  }
  if (mode === "rpc-dual") {
    const source = new RpcDualEventSource({
      signatureLimit: Number(process.env.OPENJACK_RPC_LOOKBACK_LIMIT || 300),
      slotBackfillLimit: Number(process.env.OPENJACK_RPC_SLOT_BACKFILL_LIMIT || 200),
    });
    return source.load(roundId);
  }
  throw new Error(`unknown OPENJACK_EVENT_SOURCE_MODE: ${mode}`);
}
