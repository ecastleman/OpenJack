import { Pool } from "pg";

const DEFAULT_DB_URL = process.env.SCANNER_DATABASE_URL || process.env.DATABASE_URL || "postgres://localhost:5432/openjack";

export class PublishLogRepo {
  constructor(connectionString = DEFAULT_DB_URL) {
    this.pool = new Pool({ connectionString });
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS scanner_root_publishes (
        id BIGSERIAL PRIMARY KEY,
        round_id BIGINT NOT NULL,
        tier INTEGER NOT NULL,
        root_hash TEXT NOT NULL,
        winner_count INTEGER NOT NULL,
        observed_ticket_count INTEGER NOT NULL,
        commitment_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_signature TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at TIMESTAMPTZ,
        UNIQUE (round_id, tier, root_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_scanner_root_publishes_round_tier
        ON scanner_root_publishes(round_id, tier);

      CREATE TABLE IF NOT EXISTS scanner_publish_dead_letters (
        id BIGSERIAL PRIMARY KEY,
        round_id BIGINT NOT NULL,
        tier INTEGER NOT NULL,
        root_hash TEXT NOT NULL,
        winner_count INTEGER NOT NULL,
        observed_ticket_count INTEGER NOT NULL,
        commitment_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        tx_signature TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ,
        UNIQUE (round_id, tier, root_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_scanner_dead_letters_next_attempt
        ON scanner_publish_dead_letters(status, next_attempt_at);
    `);
    this.ready = true;
  }

  async getPublished(roundId, tier, rootHash) {
    await this.init();
    const { rows } = await this.pool.query(
      `
      SELECT *
      FROM scanner_root_publishes
      WHERE round_id = $1 AND tier = $2 AND root_hash = $3 AND status = 'published'
      LIMIT 1
      `,
      [roundId, tier, rootHash],
    );
    return rows[0] || null;
  }

  async markAttempt(payload) {
    await this.init();
    const { roundId, tier, rootHash, winnerCount, observedTicketCount, commitmentHash } = payload;
    await this.pool.query(
      `
      INSERT INTO scanner_root_publishes (
        round_id, tier, root_hash, winner_count, observed_ticket_count,
        commitment_hash, status, attempt_count, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,'pending',1,now())
      ON CONFLICT (round_id, tier, root_hash)
      DO UPDATE SET
        winner_count = EXCLUDED.winner_count,
        observed_ticket_count = EXCLUDED.observed_ticket_count,
        commitment_hash = EXCLUDED.commitment_hash,
        status = 'pending',
        attempt_count = scanner_root_publishes.attempt_count + 1,
        updated_at = now()
      `,
      [roundId, tier, rootHash, winnerCount, observedTicketCount, commitmentHash],
    );
  }

  async markPublished(payload, txSignature) {
    await this.init();
    await this.pool.query(
      `
      UPDATE scanner_root_publishes
      SET status = 'published', tx_signature = $4, last_error = null,
          updated_at = now(), published_at = now()
      WHERE round_id = $1 AND tier = $2 AND root_hash = $3
      `,
      [payload.roundId, payload.tier, payload.rootHash, txSignature],
    );
  }

  async markFailure(payload, errorMessage) {
    await this.init();
    await this.pool.query(
      `
      UPDATE scanner_root_publishes
      SET status = 'failed', last_error = $4, updated_at = now()
      WHERE round_id = $1 AND tier = $2 AND root_hash = $3
      `,
      [payload.roundId, payload.tier, payload.rootHash, errorMessage],
    );
  }

  async upsertDeadLetter(payload, errorMessage, delayMs) {
    await this.init();
    await this.pool.query(
      `
      INSERT INTO scanner_publish_dead_letters (
        round_id, tier, root_hash, winner_count, observed_ticket_count,
        commitment_hash, status, attempt_count, last_error, next_attempt_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,'pending',1,$7, now() + ($8 * interval '1 millisecond'), now()
      )
      ON CONFLICT (round_id, tier, root_hash)
      DO UPDATE SET
        winner_count = EXCLUDED.winner_count,
        observed_ticket_count = EXCLUDED.observed_ticket_count,
        commitment_hash = EXCLUDED.commitment_hash,
        status = 'pending',
        last_error = EXCLUDED.last_error,
        attempt_count = scanner_publish_dead_letters.attempt_count + 1,
        next_attempt_at = now() + ($8 * interval '1 millisecond'),
        updated_at = now()
      `,
      [
        payload.roundId,
        payload.tier,
        payload.rootHash,
        payload.winnerCount,
        payload.observedTicketCount,
        payload.commitmentHash,
        errorMessage,
        delayMs,
      ],
    );
  }

  async getDueDeadLetters(limit = 50) {
    await this.init();
    const { rows } = await this.pool.query(
      `
      SELECT *
      FROM scanner_publish_dead_letters
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT $1
      `,
      [limit],
    );
    return rows;
  }

  async markDeadLetterResolved(id, txSignature) {
    await this.init();
    await this.pool.query(
      `
      UPDATE scanner_publish_dead_letters
      SET status = 'resolved',
          tx_signature = $2,
          last_error = null,
          resolved_at = now(),
          updated_at = now()
      WHERE id = $1
      `,
      [id, txSignature],
    );
  }

  async rescheduleDeadLetter(id, errorMessage, delayMs) {
    await this.init();
    await this.pool.query(
      `
      UPDATE scanner_publish_dead_letters
      SET status = 'pending',
          last_error = $2,
          attempt_count = attempt_count + 1,
          next_attempt_at = now() + ($3 * interval '1 millisecond'),
          updated_at = now()
      WHERE id = $1
      `,
      [id, errorMessage, delayMs],
    );
  }

  async markDeadLetterTerminal(id, errorMessage) {
    await this.init();
    await this.pool.query(
      `
      UPDATE scanner_publish_dead_letters
      SET status = 'failed_terminal',
          last_error = $2,
          updated_at = now()
      WHERE id = $1
      `,
      [id, errorMessage],
    );
  }
}
