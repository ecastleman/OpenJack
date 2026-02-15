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
