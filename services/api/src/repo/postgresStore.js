import { Pool } from "pg";
import { ROUND_STATUS } from "../../../../packages/shared/src/index.js";

function toRound(row) {
  if (!row) return null;
  return {
    roundId: Number(row.round_id),
    status: row.status,
    openTs: Number(row.open_ts),
    closeTs: Number(row.close_ts),
    drawTs: Number(row.draw_ts),
    settleDeadlineTs: Number(row.settle_deadline_ts),
    jackpotPoolBalance: Number(row.jackpot_pool_balance),
    tierPoolBalances: row.tier_pool_balances || [0, 0, 0, 0, 0],
    winningMain: row.winning_main || [0, 0, 0, 0, 0],
    winningBonus: Number(row.winning_bonus || 0),
  };
}

function toRoot(row) {
  return {
    tier: Number(row.tier),
    label: row.label,
    rootHash: row.root_hash,
    winnerCount: Number(row.winner_count),
    observedTicketCount: Number(row.observed_ticket_count),
    commitmentHash: row.commitment_hash,
    published: row.published,
  };
}

export class PostgresStore {
  constructor(databaseUrl = process.env.DATABASE_URL || "postgres://localhost:5432/openjack") {
    this.pool = new Pool({ connectionString: databaseUrl });
    this.ready = false;
  }

  async init() {
    if (this.ready) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        round_id BIGINT PRIMARY KEY,
        status TEXT NOT NULL,
        open_ts BIGINT NOT NULL DEFAULT 0,
        close_ts BIGINT NOT NULL DEFAULT 0,
        draw_ts BIGINT NOT NULL DEFAULT 0,
        settle_deadline_ts BIGINT NOT NULL DEFAULT 0,
        jackpot_pool_balance BIGINT NOT NULL DEFAULT 0,
        tier_pool_balances JSONB NOT NULL DEFAULT '[0,0,0,0,0]'::jsonb,
        winning_main JSONB NOT NULL DEFAULT '[0,0,0,0,0]'::jsonb,
        winning_bonus INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS roots (
        round_id BIGINT NOT NULL,
        tier INTEGER NOT NULL,
        label TEXT NOT NULL,
        root_hash TEXT NOT NULL,
        winner_count INTEGER NOT NULL,
        observed_ticket_count INTEGER NOT NULL,
        commitment_hash TEXT,
        published BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (round_id, tier)
      );

      CREATE TABLE IF NOT EXISTS claim_estimates (
        round_id BIGINT NOT NULL,
        wallet TEXT NOT NULL,
        estimated_lamports BIGINT NOT NULL DEFAULT 0,
        tickets JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (round_id, wallet)
      );
    `);

    this.ready = true;
  }

  async getActiveRound() {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT * FROM rounds WHERE status <> $1 ORDER BY round_id DESC LIMIT 1`,
      [ROUND_STATUS.FINALIZED],
    );
    return toRound(rows[0] || null);
  }

  async getRound(roundId) {
    await this.init();
    const { rows } = await this.pool.query(`SELECT * FROM rounds WHERE round_id = $1`, [roundId]);
    return toRound(rows[0] || null);
  }

  async upsertRound(round) {
    await this.init();
    await this.pool.query(
      `
      INSERT INTO rounds (
        round_id, status, open_ts, close_ts, draw_ts, settle_deadline_ts,
        jackpot_pool_balance, tier_pool_balances, winning_main, winning_bonus
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
      ON CONFLICT (round_id) DO UPDATE SET
        status = EXCLUDED.status,
        open_ts = EXCLUDED.open_ts,
        close_ts = EXCLUDED.close_ts,
        draw_ts = EXCLUDED.draw_ts,
        settle_deadline_ts = EXCLUDED.settle_deadline_ts,
        jackpot_pool_balance = EXCLUDED.jackpot_pool_balance,
        tier_pool_balances = EXCLUDED.tier_pool_balances,
        winning_main = EXCLUDED.winning_main,
        winning_bonus = EXCLUDED.winning_bonus,
        updated_at = now()
      `,
      [
        round.roundId,
        round.status,
        round.openTs || 0,
        round.closeTs || 0,
        round.drawTs || 0,
        round.settleDeadlineTs || 0,
        round.jackpotPoolBalance || 0,
        JSON.stringify(round.tierPoolBalances || [0, 0, 0, 0, 0]),
        JSON.stringify(round.winningMain || [0, 0, 0, 0, 0]),
        round.winningBonus || 0,
      ],
    );
    return this.getRound(round.roundId);
  }

  async getRoundRoots(roundId) {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT * FROM roots WHERE round_id = $1 ORDER BY tier ASC`,
      [roundId],
    );
    return rows.map(toRoot);
  }

  async setRoundRoots(roundId, roots) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const root of roots) {
        await client.query(
          `
          INSERT INTO roots (
            round_id, tier, label, root_hash, winner_count, observed_ticket_count, commitment_hash, published
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (round_id, tier) DO UPDATE SET
            label = EXCLUDED.label,
            root_hash = EXCLUDED.root_hash,
            winner_count = EXCLUDED.winner_count,
            observed_ticket_count = EXCLUDED.observed_ticket_count,
            commitment_hash = EXCLUDED.commitment_hash,
            published = EXCLUDED.published,
            updated_at = now()
          `,
          [
            roundId,
            root.tier,
            root.label,
            root.rootHash,
            root.winnerCount,
            root.observedTicketCount,
            root.commitmentHash || null,
            root.published !== false,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.getRoundRoots(roundId);
  }

  async getClaimEstimate(roundId, wallet) {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT * FROM claim_estimates WHERE round_id = $1 AND wallet = $2`,
      [roundId, wallet],
    );
    const row = rows[0];
    if (!row) {
      return {
        wallet,
        roundId,
        estimatedLamports: 0,
        tickets: [],
      };
    }

    return {
      wallet: row.wallet,
      roundId: Number(row.round_id),
      estimatedLamports: Number(row.estimated_lamports),
      tickets: row.tickets || [],
    };
  }

  async setClaimEstimate(roundId, wallet, estimate) {
    await this.init();
    await this.pool.query(
      `
      INSERT INTO claim_estimates (round_id, wallet, estimated_lamports, tickets)
      VALUES ($1,$2,$3,$4::jsonb)
      ON CONFLICT (round_id, wallet) DO UPDATE SET
        estimated_lamports = EXCLUDED.estimated_lamports,
        tickets = EXCLUDED.tickets,
        updated_at = now()
      `,
      [roundId, wallet, estimate.estimatedLamports || 0, JSON.stringify(estimate.tickets || [])],
    );

    return this.getClaimEstimate(roundId, wallet);
  }

  async getScannerStatus(roundId) {
    await this.init();
    const result = {
      roundId: Number(roundId),
      publishes: [],
      deadLetters: [],
      warnings: [],
    };

    try {
      const { rows } = await this.pool.query(
        `
        SELECT tier, status, tx_signature, attempt_count, last_error, published_at, updated_at
        FROM scanner_root_publishes
        WHERE round_id = $1
        ORDER BY tier ASC, updated_at DESC
        `,
        [roundId],
      );
      result.publishes = rows.map((r) => ({
        tier: Number(r.tier),
        status: r.status,
        txSignature: r.tx_signature || null,
        attemptCount: Number(r.attempt_count || 0),
        lastError: r.last_error || null,
        publishedAt: r.published_at || null,
        updatedAt: r.updated_at || null,
      }));
    } catch (error) {
      result.warnings.push(`scanner_root_publishes_unavailable: ${error.message}`);
    }

    try {
      const { rows } = await this.pool.query(
        `
        SELECT status, count(*)::int AS count
        FROM scanner_publish_dead_letters
        WHERE round_id = $1
        GROUP BY status
        ORDER BY status ASC
        `,
        [roundId],
      );
      result.deadLetters = rows.map((r) => ({
        status: r.status,
        count: Number(r.count || 0),
      }));
    } catch (error) {
      result.warnings.push(`scanner_publish_dead_letters_unavailable: ${error.message}`);
    }

    return result;
  }
}
