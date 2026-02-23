# Pari-Mutuel PR19: Multi-Round Rehearsal Suite (Non-Activating)

Date: 2026-02-22  
Scope: evidence + ops hardening only. No migration, no settlement activation.

## Purpose
1. Convert rehearsal verdicts from "best effort" to objective PASS/FAIL with explicit SLO thresholds.
2. Produce a single suite artifact over multiple rounds with reproducible metrics and evidence links.
3. Keep batch-canonical activation lane unambiguous (`B4` treated as N/A for this lane).

## Commands
Single round (existing):
```bash
npm run count-batch:rehearsal
```

Suite run (new):
```bash
OPENJACK_REHEARSAL_ROUND_IDS=1771,1772,1773,1774,1775 npm run count-batch:rehearsal:suite
```

## Objective SLO Gates
Round-level defaults (override via env):
1. `OPENJACK_SLO_MAX_COMPLETION_MS=300000`
2. `OPENJACK_SLO_MAX_RETRYABLE_ERRORS=10`
3. `OPENJACK_SLO_MAX_RETRYABLE_BURST=3`
4. `OPENJACK_SLO_MAX_STALL_WINDOW_MS=120000`
5. `OPENJACK_SLO_REQUIRE_BOUNTY_CONSERVATION=true`
6. `OPENJACK_SLO_REQUIRE_PROGRESS_COMPLETE_LIVE=true`

Suite verdict requires:
1. minimum rounds executed (`required_rounds`)
2. all round rehearsal verdicts = PASS
3. all round SLO verdicts = PASS
4. suite reward conservation = true

## Metrics Included
Per round:
1. completion time (`completion_time_ms`)
2. retryable error count + max burst
3. max stall window without observed progress
4. reward distribution (`initial/distributed/remaining`) + conservation check
5. RPC fetch latency summary (`mean/p95/max`) if available

Suite aggregate:
1. latency distributions (`completion`, `stall`, `rpc`)
2. total/max retryable and hard errors
3. cumulative reward conservation

## Artifact Paths
1. Round artifacts:
   - `reports/protocol-gate/activation-rehearsal-<timestamp>.json`
   - pointer: `reports/protocol-gate/latest.json`
2. Suite artifact:
   - `reports/protocol-gate/activation-rehearsal-suite-<timestamp>.json`
   - pointer: `reports/protocol-gate/latest-suite.json`

## Locked PASS Evidence
1. PASS suite artifact (locked profile, five-round set):
   - `reports/protocol-gate/activation-rehearsal-suite-1771779958870.json`
2. Inputs used in that PASS run:
   - round IDs: `1771776441,1771776801,1771777601,1771778155,1771774597`
   - stress round policy: `OPENJACK_SUITE_STRESS_BATCH_LEN=3`, `OPENJACK_SUITE_STRESS_REMAINING_THRESHOLD=36`
   - force-complete window: `OPENJACK_RUNNER_FORCE_COMPLETE_REMAINING=40`
3. Final clean sanity rerun PASS artifact (same IDs, locked profile):
   - `reports/protocol-gate/activation-rehearsal-suite-1771781562242.json`
4. Latest 5-round PASS artifact with regression guard enabled:
   - `reports/protocol-gate/activation-rehearsal-suite-1771806831505.json`
   - gates: `roundsMeetMinimum=true`, `suiteSloPass=true`, `regressionGuardPass=true`
5. Script-only ping-isolation rehearsal PASS artifact (post-confirmation standardization):
   - `reports/protocol-gate/activation-rehearsal-1771823534746.json`
   - round: `1771823445`
   - gates: `guardPass=true`, `contractPass=true`, `noHardStopErrors=true`, `sloPass=true`

## Stabilized Execution Profile (Deterministic)
1. `ClientOffsetOutOfRange` is a deterministic client construction/window error and is classified as non-retryable hard-stop for the attempted payload.
2. On this deterministic class, runner logs the full request tuple and applies adaptive downshift (`batch_len -> batch_len - 1`) to avoid retrying the same invalid window.
3. Tuple fields are logged for every relevant error surface: `start_index`, `remaining`, `expected_total`, `requested_batch_len`, `page_size`, `stress_mode`.
4. Safety invariant enforced in runner path:
   - `start_index + batch_len <= expected_total`

## Locked Baseline Env (Copy/Paste)
```bash
OPENJACK_REHEARSAL_ROUND_IDS=1771776441,1771776801,1771777601,1771778155,1771774597
OPENJACK_SUITE_STRESS_BATCH_LEN=3
OPENJACK_SUITE_STRESS_REMAINING_THRESHOLD=36
OPENJACK_RUNNER_FORCE_COMPLETE_REMAINING=40
OPENJACK_SUITE_MAX_RERUNS_PER_ROUND=0
OPENJACK_SUITE_ENFORCE_REGRESSION_GUARD=true
OPENJACK_SUITE_ALLOW_SLO_REGRESSION=false
npm run count-batch:rehearsal:suite
```

Rationale:
1. `OPENJACK_RUNNER_FORCE_COMPLETE_REMAINING=40` is a runner-only liveness override that prevents late-stage profitability skips; it does not change protocol rules.

## ClientOffsetOutOfRange Playbook
1. Expected behavior: runner self-heals by adaptive downshift and continues with a valid smaller batch.
2. If downshift does not converge, halt the run and attach tuple + logs (`start_index`, `remaining`, `expected_total`, `requested_batch_len`, `page_size`, `stress_mode`) for triage.
3. Do not classify this as infra flakiness; treat it as deterministic construction/window mismatch until proven otherwise.

## SLO Regression Guard
1. Suite compares current p95 completion/stall against prior `latest-suite` artifact and fails on large regressions by default.
2. Override only when intentionally accepted:
   - `OPENJACK_SUITE_ALLOW_SLO_REGRESSION=true`

## RPC Confirmation Strategy (Locked)
1. Script lane is standardized on HTTP status polling (`getSignatureStatuses`) for tx confirmation.
2. Script lane no longer uses `confirmTransaction(...)` or Anchor `.rpc()` confirmation paths.
3. If Alchemy shows `Unsupported method: ping` during an isolation window that runs only scripts, treat it as external/non-script client traffic and isolate by timestamp.

## Activation Contract Note
After checklist freeze, only bug fixes should modify activation readiness surfaces (scripts/docs/thresholds).
