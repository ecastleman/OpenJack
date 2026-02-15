import { Pool } from "pg";

const DEFAULT_DB_URL = process.env.SCANNER_DATABASE_URL || process.env.DATABASE_URL || "postgres://localhost:5432/openjack";

export class TicketEventsRepo {
  constructor(connectionString = DEFAULT_DB_URL) {
    this.pool = new Pool({ connectionString });
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ticket_events (
        round_id BIGINT NOT NULL,
        leaf_index INTEGER NOT NULL,
        main JSONB NOT NULL,
        bonus INTEGER NOT NULL,
        purchaser TEXT NOT NULL,
        paid_lamports BIGINT NOT NULL DEFAULT 0,
        ts BIGINT NOT NULL DEFAULT 0,
        asset_id TEXT,
        PRIMARY KEY (round_id, leaf_index)
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
        await client.query(
          `
          INSERT INTO ticket_events (
            round_id, leaf_index, main, bonus, purchaser, paid_lamports, ts, asset_id
          ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
          ON CONFLICT (round_id, leaf_index) DO UPDATE SET
            main = EXCLUDED.main,
            bonus = EXCLUDED.bonus,
            purchaser = EXCLUDED.purchaser,
            paid_lamports = EXCLUDED.paid_lamports,
            ts = EXCLUDED.ts,
            asset_id = EXCLUDED.asset_id
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
}
