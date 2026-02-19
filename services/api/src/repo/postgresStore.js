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
    winnersPoolBalance: Number(row.winners_pool_balance || 0),
    unclaimedPoolBalance: Number(row.unclaimed_pool_balance || 0),
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
        winners_pool_balance BIGINT NOT NULL DEFAULT 0,
        unclaimed_pool_balance BIGINT NOT NULL DEFAULT 0,
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

      ALTER TABLE rounds
        ADD COLUMN IF NOT EXISTS winners_pool_balance BIGINT NOT NULL DEFAULT 0;

      ALTER TABLE rounds
        ADD COLUMN IF NOT EXISTS unclaimed_pool_balance BIGINT NOT NULL DEFAULT 0;
    `);

    this.ready = true;
  }

  async getActiveRound() {
    await this.init();
    const nowTs = Math.floor(Date.now() / 1000);
    const { rows } = await this.pool.query(
      `
      SELECT *
      FROM rounds
      WHERE status <> $1
        AND NOT (status = $2 AND close_ts > 0 AND close_ts < $3)
      ORDER BY round_id DESC
      LIMIT 1
      `,
      [ROUND_STATUS.FINALIZED, ROUND_STATUS.OPEN, nowTs],
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
        jackpot_pool_balance, winners_pool_balance, unclaimed_pool_balance,
        tier_pool_balances, winning_main, winning_bonus
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
      ON CONFLICT (round_id) DO UPDATE SET
        status = EXCLUDED.status,
        open_ts = EXCLUDED.open_ts,
        close_ts = EXCLUDED.close_ts,
        draw_ts = EXCLUDED.draw_ts,
        settle_deadline_ts = EXCLUDED.settle_deadline_ts,
        jackpot_pool_balance = EXCLUDED.jackpot_pool_balance,
        winners_pool_balance = EXCLUDED.winners_pool_balance,
        unclaimed_pool_balance = EXCLUDED.unclaimed_pool_balance,
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
        round.winnersPoolBalance || 0,
        round.unclaimedPoolBalance || 0,
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

  async getRoundIngestionStatus(roundId) {
    await this.init();
    const result = {
      roundId: Number(roundId),
      ingestionState: null,
      snapshot: null,
      hydration: null,
      warnings: [],
    };

    try {
      result.hydration = await this.getRoundHydrationStatus(roundId);
    } catch (error) {
      result.warnings.push(`scanner_proof_hydration_unavailable: ${error.message}`);
    }

    try {
      const { rows } = await this.pool.query(
        `
        SELECT
          round_id,
          close_slot,
          finalized_watermark_slot,
          ledger_ticket_count,
          onchain_ticket_count,
          max_ledger_slot,
          sealed,
          sealed_at,
          readiness_reason,
          updated_at
        FROM round_ingestion_state
        WHERE round_id = $1
        LIMIT 1
        `,
        [roundId],
      );
      const row = rows[0];
      if (row) {
        result.ingestionState = {
          roundId: Number(row.round_id),
          closeSlot: Number(row.close_slot || 0),
          finalizedWatermarkSlot: Number(row.finalized_watermark_slot || 0),
          ledgerTicketCount: Number(row.ledger_ticket_count || 0),
          onchainTicketCount: Number(row.onchain_ticket_count || 0),
          maxLedgerSlot: Number(row.max_ledger_slot || 0),
          sealed: Boolean(row.sealed),
          sealedAt: row.sealed_at || null,
          readinessReason: row.readiness_reason || null,
          updatedAt: row.updated_at || null,
        };
      }
    } catch (error) {
      result.warnings.push(`round_ingestion_state_unavailable: ${error.message}`);
    }

    try {
      const { rows } = await this.pool.query(
        `
        SELECT
          round_id,
          schema_version,
          row_count,
          snapshot_max_slot,
          finalized_watermark_slot,
          close_slot,
          snapshot_hash_hex,
          created_at,
          created_by
        FROM round_ledger_snapshot
        WHERE round_id = $1
        LIMIT 1
        `,
        [roundId],
      );
      const row = rows[0];
      if (row) {
        result.snapshot = {
          roundId: Number(row.round_id),
          schemaVersion: Number(row.schema_version || 0),
          rowCount: Number(row.row_count || 0),
          snapshotMaxSlot: Number(row.snapshot_max_slot || 0),
          finalizedWatermarkSlot: Number(row.finalized_watermark_slot || 0),
          closeSlot: Number(row.close_slot || 0),
          snapshotHashHex: row.snapshot_hash_hex || null,
          createdAt: row.created_at || null,
          createdBy: row.created_by || null,
        };
      }
    } catch (error) {
      result.warnings.push(`round_ledger_snapshot_unavailable: ${error.message}`);
    }

    return result;
  }

  async getRoundHydrationStatus(roundId) {
    await this.init();
    const output = {
      roundId: Number(roundId),
      counts: {
        pendingProof: 0,
        hydrated: 0,
        failed: 0,
        total: 0,
      },
      provider: null,
      lastHydrationAt: null,
      lastError: null,
      oldestPendingAgeMs: null,
      sampleFailures: [],
    };

    const countsRes = await this.pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending_count,
        COALESCE(SUM(CASE WHEN status = 'hydrated' THEN 1 ELSE 0 END), 0)::int AS hydrated_count,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed_count,
        COUNT(*)::int AS total_count
      FROM scanner_proof_hydration
      WHERE round_id = $1
      `,
      [Number(roundId)],
    );
    const c = countsRes.rows[0] || {};
    output.counts = {
      pendingProof: Number(c.pending_count || 0),
      hydrated: Number(c.hydrated_count || 0),
      failed: Number(c.failed_count || 0),
      total: Number(c.total_count || 0),
    };

    const latestRes = await this.pool.query(
      `
      SELECT provider
      FROM scanner_proof_hydration
      WHERE round_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [Number(roundId)],
    );
    if (latestRes.rows[0]) {
      output.provider = latestRes.rows[0].provider || null;
    }

    const hydratedRes = await this.pool.query(
      `
      SELECT MAX(hydrated_at) AS last_hydrated_at
      FROM scanner_proof_hydration
      WHERE round_id = $1
      `,
      [Number(roundId)],
    );
    output.lastHydrationAt = hydratedRes.rows[0]?.last_hydrated_at || null;

    const errorRes = await this.pool.query(
      `
      SELECT last_error
      FROM scanner_proof_hydration
      WHERE round_id = $1 AND last_error IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [Number(roundId)],
    );
    if (errorRes.rows[0]) {
      output.lastError = errorRes.rows[0].last_error || null;
    }

    const pendingAgeRes = await this.pool.query(
      `
      SELECT EXTRACT(EPOCH FROM (now() - MIN(first_attempt_at))) * 1000 AS oldest_pending_age_ms
      FROM scanner_proof_hydration
      WHERE round_id = $1 AND status = 'pending' AND first_attempt_at IS NOT NULL
      `,
      [Number(roundId)],
    );
    const age = Number(pendingAgeRes.rows[0]?.oldest_pending_age_ms || 0);
    output.oldestPendingAgeMs = age > 0 ? Math.round(age) : null;

    const failuresRes = await this.pool.query(
      `
      SELECT leaf_index, asset_id, last_error, attempt_count
      FROM scanner_proof_hydration
      WHERE round_id = $1 AND status = 'failed'
      ORDER BY updated_at DESC
      LIMIT 5
      `,
      [Number(roundId)],
    );
    output.sampleFailures = failuresRes.rows.map((row) => ({
      leafIndex: Number(row.leaf_index || 0),
      assetId: row.asset_id || null,
      lastError: row.last_error || null,
      attemptCount: Number(row.attempt_count || 0),
    }));

    return output;
  }
}
