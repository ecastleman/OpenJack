import crypto from "node:crypto";
import { Pool } from "pg";

const DEFAULT_DB_URL = process.env.SCANNER_DATABASE_URL || process.env.DATABASE_URL || "postgres://localhost:5432/openjack";

function toBigInt(value, fallback = 0n) {
  try {
    if (value == null) return fallback;
    if (typeof value === "bigint") return value;
    return BigInt(value);
  } catch {
    return fallback;
  }
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toByte(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.floor(n)));
}

function asSortedMain(main) {
  const values = Array.isArray(main) ? main.map((n) => Number(n)) : [];
  values.sort((a, b) => a - b);
  return [values[0] || 0, values[1] || 0, values[2] || 0, values[3] || 0, values[4] || 0];
}

function writeU32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Math.max(0, Number(value) >>> 0));
  return b;
}

function writeU64(value) {
  const b = Buffer.alloc(8);
  const v = toBigInt(value, 0n);
  b.writeBigUInt64LE(v < 0n ? 0n : v);
  return b;
}

function writeI32(value) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(Number(value) | 0);
  return b;
}

function writeLenPrefixedUtf8(value) {
  const str = String(value || "");
  const bytes = Buffer.from(str, "utf8");
  return Buffer.concat([writeU32(bytes.length), bytes]);
}

function computeSnapshotHashHex({ schemaVersion, roundId, closeSlot, finalizedWatermarkSlot, rows }) {
  const hash = crypto.createHash("sha256");
  hash.update(writeU32(schemaVersion));
  hash.update(writeU64(roundId));
  hash.update(writeU64(closeSlot));
  hash.update(writeU64(finalizedWatermarkSlot));
  hash.update(writeU32(rows.length));
  for (const row of rows) {
    const [m1, m2, m3, m4, m5] = asSortedMain(row.main);
    hash.update(writeU64(row.round_id));
    hash.update(writeI32(row.leaf_index));
    hash.update(Buffer.from([toByte(m1), toByte(m2), toByte(m3), toByte(m4), toByte(m5)]));
    hash.update(Buffer.from([toByte(row.bonus)]));
    hash.update(writeLenPrefixedUtf8(row.purchaser));
    hash.update(writeLenPrefixedUtf8(row.asset_id || ""));
    hash.update(writeLenPrefixedUtf8(row.tx_signature || ""));
    hash.update(writeU64(row.paid_lamports || 0));
    hash.update(writeU64(row.ts || 0));
    hash.update(writeU64(row.slot || 0));
  }
  return hash.digest("hex");
}

export class TicketLedgerRepo {
  constructor(connectionString = DEFAULT_DB_URL) {
    this.pool = new Pool({ connectionString });
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ticket_ledger (
        round_id BIGINT NOT NULL,
        leaf_index INTEGER NOT NULL,
        main JSONB NOT NULL,
        bonus INTEGER NOT NULL,
        purchaser TEXT NOT NULL,
        paid_lamports BIGINT NOT NULL DEFAULT 0,
        ts BIGINT NOT NULL DEFAULT 0,
        asset_id TEXT,
        tx_signature TEXT NOT NULL,
        slot BIGINT NOT NULL,
        block_time TIMESTAMPTZ,
        commitment TEXT NOT NULL DEFAULT 'finalized',
        provider TEXT,
        seq_in_tx INTEGER,
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (round_id, leaf_index)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_ledger_round_sig_leaf
        ON ticket_ledger(round_id, tx_signature, leaf_index);
      CREATE INDEX IF NOT EXISTS idx_ticket_ledger_round_slot
        ON ticket_ledger(round_id, slot);

      CREATE TABLE IF NOT EXISTS round_ingestion_state (
        round_id BIGINT PRIMARY KEY,
        close_slot BIGINT NOT NULL DEFAULT 0,
        finalized_watermark_slot BIGINT NOT NULL DEFAULT 0,
        ledger_ticket_count INTEGER NOT NULL DEFAULT 0,
        onchain_ticket_count INTEGER NOT NULL DEFAULT 0,
        max_ledger_slot BIGINT NOT NULL DEFAULT 0,
        sealed BOOLEAN NOT NULL DEFAULT false,
        sealed_at TIMESTAMPTZ,
        readiness_reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS round_ledger_snapshot (
        round_id BIGINT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        snapshot_max_slot BIGINT NOT NULL,
        finalized_watermark_slot BIGINT NOT NULL,
        close_slot BIGINT NOT NULL,
        snapshot_hash_hex TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by TEXT
      );
    `);
    this.ready = true;
  }

  async upsertMany(events) {
    await this.init();
    if (!Array.isArray(events) || events.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const e of events) {
        const roundId = Number(e.roundId);
        const leafIndex = Number(e.leafIndex);
        const slot = Math.max(0, Number(e.slot || 0));
        await client.query(
          `
          INSERT INTO ticket_ledger (
            round_id, leaf_index, main, bonus, purchaser, paid_lamports, ts,
            asset_id, tx_signature, slot, block_time, commitment, provider, seq_in_tx
          ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (round_id, leaf_index) DO UPDATE SET
            main = EXCLUDED.main,
            bonus = EXCLUDED.bonus,
            purchaser = EXCLUDED.purchaser,
            paid_lamports = EXCLUDED.paid_lamports,
            ts = EXCLUDED.ts,
            asset_id = COALESCE(EXCLUDED.asset_id, ticket_ledger.asset_id),
            tx_signature = EXCLUDED.tx_signature,
            slot = GREATEST(ticket_ledger.slot, EXCLUDED.slot),
            block_time = COALESCE(EXCLUDED.block_time, ticket_ledger.block_time),
            commitment = EXCLUDED.commitment,
            provider = EXCLUDED.provider,
            seq_in_tx = COALESCE(EXCLUDED.seq_in_tx, ticket_ledger.seq_in_tx)
          `,
          [
            roundId,
            leafIndex,
            JSON.stringify(e.main),
            Number(e.bonus),
            String(e.purchaser),
            Number(e.paidLamports || 0),
            Number(e.ts || 0),
            e.assetId || null,
            String(e.txSignature || ""),
            slot,
            e.blockTime ? new Date(e.blockTime * 1000) : null,
            String(e.commitment || "finalized"),
            e.provider || null,
            e.seqInTx == null ? null : Number(e.seqInTx),
          ],
        );
      }
      await client.query("COMMIT");
      return events.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async syncLegacyTicketEvents(events) {
    await this.init();
    if (!Array.isArray(events) || events.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const e of events) {
        await client.query(
          `
          INSERT INTO ticket_events (
            round_id, leaf_index, main, bonus, purchaser, paid_lamports, ts, asset_id,
            tx_signature, slot, block_time, commitment, provider, seq_in_tx
          ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (round_id, leaf_index) DO UPDATE SET
            main = EXCLUDED.main,
            bonus = EXCLUDED.bonus,
            purchaser = EXCLUDED.purchaser,
            paid_lamports = EXCLUDED.paid_lamports,
            ts = EXCLUDED.ts,
            asset_id = COALESCE(EXCLUDED.asset_id, ticket_events.asset_id),
            tx_signature = EXCLUDED.tx_signature,
            slot = GREATEST(ticket_events.slot, EXCLUDED.slot),
            block_time = COALESCE(EXCLUDED.block_time, ticket_events.block_time),
            commitment = EXCLUDED.commitment,
            provider = EXCLUDED.provider,
            seq_in_tx = COALESCE(EXCLUDED.seq_in_tx, ticket_events.seq_in_tx)
          `,
          [
            Number(e.roundId),
            Number(e.leafIndex),
            JSON.stringify(e.main),
            Number(e.bonus),
            String(e.purchaser),
            Number(e.paidLamports || 0),
            Number(e.ts || 0),
            e.assetId || null,
            String(e.txSignature || ""),
            Math.max(0, Number(e.slot || 0)),
            e.blockTime ? new Date(e.blockTime * 1000) : null,
            String(e.commitment || "finalized"),
            e.provider || null,
            e.seqInTx == null ? null : Number(e.seqInTx),
          ],
        );
      }
      await client.query("COMMIT");
      return events.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateRoundWatermark({ roundId, closeSlot, finalizedWatermarkSlot, onchainTicketCount }) {
    await this.init();
    await this.pool.query(
      `
      INSERT INTO round_ingestion_state (
        round_id, close_slot, finalized_watermark_slot, onchain_ticket_count, updated_at
      ) VALUES ($1, GREATEST($2, 0), GREATEST($3, 0), GREATEST($4, 0), now())
      ON CONFLICT (round_id) DO UPDATE SET
        close_slot = CASE
          WHEN round_ingestion_state.close_slot = 0 AND EXCLUDED.close_slot > 0 THEN EXCLUDED.close_slot
          ELSE round_ingestion_state.close_slot
        END,
        finalized_watermark_slot = GREATEST(round_ingestion_state.finalized_watermark_slot, EXCLUDED.finalized_watermark_slot),
        onchain_ticket_count = GREATEST(EXCLUDED.onchain_ticket_count, 0),
        updated_at = now()
      `,
      [Number(roundId), Number(closeSlot || 0), Number(finalizedWatermarkSlot || 0), Number(onchainTicketCount || 0)],
    );
  }

  async refreshRoundCounts(roundId) {
    await this.init();
    const { rows } = await this.pool.query(
      `
      SELECT
        COUNT(*)::INT AS count,
        COALESCE(MAX(slot), 0)::BIGINT AS max_slot
      FROM ticket_ledger
      WHERE round_id = $1
      `,
      [Number(roundId)],
    );
    const count = Number(rows[0]?.count || 0);
    const maxSlot = toBigInt(rows[0]?.max_slot || 0);
    await this.pool.query(
      `
      INSERT INTO round_ingestion_state (
        round_id, ledger_ticket_count, max_ledger_slot, updated_at
      ) VALUES ($1, $2, $3, now())
      ON CONFLICT (round_id) DO UPDATE SET
        ledger_ticket_count = EXCLUDED.ledger_ticket_count,
        max_ledger_slot = EXCLUDED.max_ledger_slot,
        updated_at = now()
      `,
      [Number(roundId), count, maxSlot.toString()],
    );
    return { count, maxSlot };
  }

  async getReadiness(roundId, { requireSealed = false } = {}) {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT * FROM round_ingestion_state WHERE round_id = $1 LIMIT 1`,
      [Number(roundId)],
    );
    const state = rows[0] || null;
    const reasons = [];
    if (!state) {
      reasons.push("missing_ingestion_state");
      return {
        roundId: Number(roundId),
        ready: false,
        reasons,
        closeSlot: 0n,
        finalizedWatermarkSlot: 0n,
        ledgerTicketCount: 0,
        onchainTicketCount: 0,
        maxLedgerSlot: 0n,
        sealed: false,
        readinessReason: reasons.join(","),
      };
    }

    const closeSlot = toBigInt(state.close_slot || 0);
    const finalizedWatermarkSlot = toBigInt(state.finalized_watermark_slot || 0);
    const ledgerTicketCount = toNum(state.ledger_ticket_count || 0);
    const onchainTicketCount = toNum(state.onchain_ticket_count || 0);
    const maxLedgerSlot = toBigInt(state.max_ledger_slot || 0);
    const sealed = Boolean(state.sealed);

    if (closeSlot <= 0n) reasons.push("close_slot_not_set");
    if (finalizedWatermarkSlot < closeSlot) reasons.push("watermark_before_close_slot");
    if (ledgerTicketCount !== onchainTicketCount) reasons.push("ticket_count_parity_mismatch");
    if (maxLedgerSlot > finalizedWatermarkSlot) reasons.push("max_ledger_slot_after_watermark");
    if (requireSealed && !sealed) reasons.push("ledger_not_sealed");

    const ready = reasons.length === 0;
    const readinessReason = ready ? "ready" : reasons.join(",");
    await this.pool.query(
      `UPDATE round_ingestion_state SET readiness_reason=$2, updated_at=now() WHERE round_id=$1`,
      [Number(roundId), readinessReason],
    );
    return {
      roundId: Number(roundId),
      ready,
      reasons,
      closeSlot,
      finalizedWatermarkSlot,
      ledgerTicketCount,
      onchainTicketCount,
      maxLedgerSlot,
      sealed,
      readinessReason,
    };
  }

  async sealRoundSnapshot(roundId, { schemaVersion = 1, createdBy = "scanner" } = {}) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lock = await client.query(
        `SELECT * FROM round_ingestion_state WHERE round_id=$1 FOR UPDATE`,
        [Number(roundId)],
      );
      if (lock.rowCount === 0) {
        throw new Error(`round ${roundId} missing ingestion state`);
      }
      if (lock.rows[0].sealed) {
        const existing = await client.query(
          `SELECT * FROM round_ledger_snapshot WHERE round_id=$1 LIMIT 1`,
          [Number(roundId)],
        );
        await client.query("COMMIT");
        return existing.rows[0] || null;
      }

      const agg = await client.query(
        `
        SELECT COUNT(*)::INT AS count, COALESCE(MAX(slot),0)::BIGINT AS max_slot
        FROM ticket_ledger WHERE round_id=$1
        `,
        [Number(roundId)],
      );
      const rowCount = Number(agg.rows[0]?.count || 0);
      const snapshotMaxSlot = toBigInt(agg.rows[0]?.max_slot || 0);

      await client.query(
        `
        UPDATE round_ingestion_state
        SET ledger_ticket_count=$2, max_ledger_slot=$3, updated_at=now()
        WHERE round_id=$1
        `,
        [Number(roundId), rowCount, snapshotMaxSlot.toString()],
      );

      const refreshed = await client.query(
        `SELECT * FROM round_ingestion_state WHERE round_id=$1 LIMIT 1`,
        [Number(roundId)],
      );
      const state = refreshed.rows[0];
      const closeSlot = toBigInt(state.close_slot || 0);
      const finalizedWatermarkSlot = toBigInt(state.finalized_watermark_slot || 0);
      const onchainTicketCount = toNum(state.onchain_ticket_count || 0);
      const reasons = [];
      if (closeSlot <= 0n) reasons.push("close_slot_not_set");
      if (finalizedWatermarkSlot < closeSlot) reasons.push("watermark_before_close_slot");
      if (rowCount !== onchainTicketCount) reasons.push("ticket_count_parity_mismatch");
      if (snapshotMaxSlot > finalizedWatermarkSlot) reasons.push("max_ledger_slot_after_watermark");
      if (reasons.length > 0) {
        throw new Error(`cannot seal round ${roundId}: ${reasons.join(",")}`);
      }

      const rows = await client.query(
        `
        SELECT round_id, leaf_index, main, bonus, purchaser, paid_lamports, ts, asset_id, tx_signature, slot
        FROM ticket_ledger
        WHERE round_id=$1
        ORDER BY leaf_index ASC
        `,
        [Number(roundId)],
      );

      const snapshotHashHex = computeSnapshotHashHex({
        schemaVersion: Number(schemaVersion),
        roundId: Number(roundId),
        closeSlot,
        finalizedWatermarkSlot,
        rows: rows.rows,
      });

      await client.query(
        `
        INSERT INTO round_ledger_snapshot (
          round_id, schema_version, row_count, snapshot_max_slot,
          finalized_watermark_slot, close_slot, snapshot_hash_hex, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (round_id) DO UPDATE SET
          schema_version=EXCLUDED.schema_version,
          row_count=EXCLUDED.row_count,
          snapshot_max_slot=EXCLUDED.snapshot_max_slot,
          finalized_watermark_slot=EXCLUDED.finalized_watermark_slot,
          close_slot=EXCLUDED.close_slot,
          snapshot_hash_hex=EXCLUDED.snapshot_hash_hex,
          created_at=now(),
          created_by=EXCLUDED.created_by
        `,
        [
          Number(roundId),
          Number(schemaVersion),
          rowCount,
          snapshotMaxSlot.toString(),
          finalizedWatermarkSlot.toString(),
          closeSlot.toString(),
          snapshotHashHex,
          createdBy,
        ],
      );

      await client.query(
        `
        UPDATE round_ingestion_state
        SET sealed=true, sealed_at=now(), readiness_reason='sealed', updated_at=now()
        WHERE round_id=$1
        `,
        [Number(roundId)],
      );

      await client.query("COMMIT");
      return {
        roundId: Number(roundId),
        schemaVersion: Number(schemaVersion),
        rowCount,
        snapshotMaxSlot,
        finalizedWatermarkSlot,
        closeSlot,
        snapshotHashHex,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getSnapshot(roundId) {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT * FROM round_ledger_snapshot WHERE round_id=$1 LIMIT 1`,
      [Number(roundId)],
    );
    return rows[0] || null;
  }

  async getSealedCanonicalEvents(roundId) {
    await this.init();
    const readiness = await this.getReadiness(roundId, { requireSealed: true });
    if (!readiness.ready) {
      throw new Error(`round ${roundId} not sealed/publishable: ${readiness.readinessReason}`);
    }

    const snapshot = await this.getSnapshot(roundId);
    if (!snapshot) {
      throw new Error(`round ${roundId} missing snapshot`);
    }

    const { rows } = await this.pool.query(
      `
      SELECT round_id, leaf_index, main, bonus, purchaser, paid_lamports, ts, asset_id, tx_signature, slot, block_time
      FROM ticket_ledger
      WHERE round_id=$1
      ORDER BY leaf_index ASC
      `,
      [Number(roundId)],
    );

    const expectedCount = Number(snapshot.row_count || 0);
    if (rows.length !== expectedCount) {
      throw new Error(`round ${roundId} snapshot row count mismatch ledger=${rows.length} snapshot=${expectedCount}`);
    }

    const computedHash = computeSnapshotHashHex({
      schemaVersion: Number(snapshot.schema_version || 1),
      roundId: Number(roundId),
      closeSlot: toBigInt(snapshot.close_slot || 0),
      finalizedWatermarkSlot: toBigInt(snapshot.finalized_watermark_slot || 0),
      rows,
    });
    const expectedHash = String(snapshot.snapshot_hash_hex || "");
    if (!expectedHash || computedHash !== expectedHash) {
      throw new Error(`round ${roundId} snapshot hash mismatch computed=${computedHash} expected=${expectedHash}`);
    }

    const events = rows.map((row) => {
      const blockTimeUnix =
        row.block_time && row.block_time instanceof Date
          ? Math.floor(row.block_time.getTime() / 1000)
          : 0;
      return {
        roundId: Number(row.round_id),
        leafIndex: Number(row.leaf_index),
        main: Array.isArray(row.main) ? row.main : [],
        bonus: Number(row.bonus),
        purchaser: String(row.purchaser || ""),
        paidLamports: Number(row.paid_lamports || 0),
        ts: Number(row.ts || 0),
        assetId: row.asset_id || null,
        txSignature: row.tx_signature || null,
        slot: Number(row.slot || 0),
        blockTime: blockTimeUnix,
        commitment: "finalized",
        provider: "sealed_snapshot",
        seqInTx: null,
      };
    });

    return {
      roundId: Number(roundId),
      snapshot,
      events,
    };
  }
}
