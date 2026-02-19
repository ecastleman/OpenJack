import { Pool } from "pg";

const DEFAULT_DB_URL = process.env.SCANNER_DATABASE_URL || process.env.DATABASE_URL || "postgres://localhost:5432/openjack";

function normalizeStatus(proofStatus) {
  const status = String(proofStatus || "").toUpperCase();
  if (status === "READY") return "hydrated";
  if (status === "FAILED") return "failed";
  return "pending";
}

export class ProofHydrationRepo {
  constructor(connectionString = DEFAULT_DB_URL) {
    this.pool = new Pool({ connectionString });
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS scanner_proof_hydration (
        round_id BIGINT NOT NULL,
        leaf_index INTEGER NOT NULL,
        wallet TEXT,
        asset_id TEXT,
        provider TEXT,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        first_attempt_at TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        hydrated_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (round_id, leaf_index)
      );

      CREATE INDEX IF NOT EXISTS idx_scanner_proof_hydration_round_status
        ON scanner_proof_hydration(round_id, status);
    `);
    this.ready = true;
  }

  async upsertMany(roundId, tickets) {
    await this.init();
    if (!Array.isArray(tickets) || tickets.length === 0) return 0;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const ticket of tickets) {
        const status = normalizeStatus(ticket?.proofStatus);
        const attemptCount = Math.max(0, Number(ticket?.proofAttemptCount || 0));
        await client.query(
          `
          INSERT INTO scanner_proof_hydration (
            round_id, leaf_index, wallet, asset_id, provider,
            status, attempt_count, last_error,
            first_attempt_at, last_attempt_at, hydrated_at, updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,
            $6,$7,$8,
            CASE WHEN $7 > 0 THEN now() ELSE NULL END,
            CASE WHEN $7 > 0 THEN now() ELSE NULL END,
            CASE WHEN $6 = 'hydrated' THEN now() ELSE NULL END,
            now()
          )
          ON CONFLICT (round_id, leaf_index) DO UPDATE SET
            wallet = EXCLUDED.wallet,
            asset_id = EXCLUDED.asset_id,
            provider = EXCLUDED.provider,
            status = EXCLUDED.status,
            attempt_count = GREATEST(scanner_proof_hydration.attempt_count, EXCLUDED.attempt_count),
            last_error = EXCLUDED.last_error,
            first_attempt_at = COALESCE(scanner_proof_hydration.first_attempt_at, EXCLUDED.first_attempt_at),
            last_attempt_at = CASE
              WHEN EXCLUDED.attempt_count > 0 THEN now()
              ELSE scanner_proof_hydration.last_attempt_at
            END,
            hydrated_at = CASE
              WHEN EXCLUDED.status = 'hydrated' THEN now()
              ELSE scanner_proof_hydration.hydrated_at
            END,
            updated_at = now()
          `,
          [
            Number(roundId),
            Number(ticket?.leafIndex || 0),
            ticket?.wallet || null,
            ticket?.assetId || null,
            ticket?.proofProvider || null,
            status,
            attemptCount,
            ticket?.proofError || null,
          ],
        );
      }
      await client.query("COMMIT");
      return tickets.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
