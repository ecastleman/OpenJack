# Pari-Mutuel PR18: Activation Rehearsal Runbook (Non-Activating)

Date: 2026-02-22  
Scope: scripted drill + artifact generation only. No activation, no migration.

## Command
```bash
npm run count-batch:rehearsal
```

Optional live-mode drill:
```bash
OPENJACK_REHEARSAL_LIVE=true npm run count-batch:rehearsal
```

Optional preflight-only mode (never submits):
```bash
OPENJACK_REHEARSAL_PREFLIGHT_ONLY=true npm run count-batch:rehearsal
```

Five-round suite (objective PASS/FAIL):
```bash
OPENJACK_REHEARSAL_ROUND_IDS=1771,1772,1773,1774,1775 npm run count-batch:rehearsal:suite
```

## Minimal Required Env Vars
1. `OPENJACK_BENCH_ROUND_ID` (or `READY_ROUND_ID`)
2. `RPC_URL`
3. `OPENJACK_PROGRAM_ID` (or configured in `Anchor.toml`)
4. `AUTHORITY_KEYPAIR_PATH` (defaults to `~/.config/solana/id.json`)
5. Suite mode only: `OPENJACK_REHEARSAL_ROUND_IDS` (comma-separated round IDs)

## SLO Threshold Env Vars (objective verdict)
1. `OPENJACK_SLO_MAX_COMPLETION_MS` (default `300000`)
2. `OPENJACK_SLO_MAX_RETRYABLE_ERRORS` (default `10`)
3. `OPENJACK_SLO_MAX_RETRYABLE_BURST` (default `3`)
4. `OPENJACK_SLO_MAX_STALL_WINDOW_MS` (default `120000`)
5. `OPENJACK_SLO_REQUIRE_BOUNTY_CONSERVATION` (default `true`)
6. `OPENJACK_SLO_REQUIRE_PROGRESS_COMPLETE_LIVE` (default `true`)

## What the rehearsal executes
1. `check:round-solvency`
2. `test:contract`
3. `count-batch:bot` (dry-run by default; live when `OPENJACK_REHEARSAL_LIVE=true`)
4. Post-run round snapshot + determinism assertions
5. Optional intentional retryable failure drill (`CountReplayMismatch`) in live mode

## Artifact
The script writes one JSON artifact under:
- `reports/protocol-gate/activation-rehearsal-<timestamp>.json`
- and updates:
  - `reports/protocol-gate/latest.json`

Artifact metadata includes:
1. `git_commit`
2. `git_tag` (if exact match exists)
3. `program_id`
4. `feature_flags`
5. `profile_name`
6. `timestamp`
7. `preflight_only`
8. SLO thresholds + check results (`slo`)

Suite artifact:
- `reports/protocol-gate/activation-rehearsal-suite-<timestamp>.json`
- and pointer:
  - `reports/protocol-gate/latest-suite.json`

## Determinism/Drift Checks
After run completion:
1. `bountyDistributed + bountyRemaining == bountyInitial`
2. `countProgressIndex == ticketCountFrozen` (live mode only)
3. no post-finalization reward mutation (economic fields unchanged during retryable failure drill)

## PASS / FAIL Gates
PASS requires all:
1. solvency guard command passes
2. contract tests pass
3. no hard-stop runner errors
4. progress monotonic (`after >= before`)
5. runner output parseable as key=value rows
6. determinism checks pass
7. SLO checks pass

FAIL on any gate:
1. report verdict set to `FAIL`
2. script exits non-zero
3. next action is to inspect `gates` + `retryableFailureDrill` + `aggregates` in the artifact.

## Notes
1. This runbook remains non-activating.
2. Blocker snapshot (`B1..B8`) is copied into the artifact from:
   - `docs/PARI_MUTUEL_IMPL_PR13_1_ACTIVATION_SCOREBOARD.md`
