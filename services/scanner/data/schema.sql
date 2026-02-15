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
  tx_signature TEXT,
  slot BIGINT NOT NULL DEFAULT 0,
  block_time TIMESTAMPTZ,
  commitment TEXT NOT NULL DEFAULT 'finalized',
  provider TEXT,
  seq_in_tx INTEGER,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, leaf_index)
);

ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS tx_signature TEXT;
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS slot BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS block_time TIMESTAMPTZ;
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS commitment TEXT NOT NULL DEFAULT 'finalized';
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS seq_in_tx INTEGER;
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS inserted_at TIMESTAMPTZ NOT NULL DEFAULT now();

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

CREATE OR REPLACE FUNCTION reject_ticket_ledger_insert_if_sealed()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM round_ingestion_state
    WHERE round_id = NEW.round_id AND sealed = true
  ) THEN
    RAISE EXCEPTION 'round % is sealed; insert rejected', NEW.round_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ticket_ledger_reject_if_sealed ON ticket_ledger;
CREATE TRIGGER trg_ticket_ledger_reject_if_sealed
BEFORE INSERT ON ticket_ledger
FOR EACH ROW
EXECUTE FUNCTION reject_ticket_ledger_insert_if_sealed();
