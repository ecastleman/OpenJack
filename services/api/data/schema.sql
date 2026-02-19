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

ALTER TABLE rounds
  ADD COLUMN IF NOT EXISTS winners_pool_balance BIGINT NOT NULL DEFAULT 0;

ALTER TABLE rounds
  ADD COLUMN IF NOT EXISTS unclaimed_pool_balance BIGINT NOT NULL DEFAULT 0;

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
