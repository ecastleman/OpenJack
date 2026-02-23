# Phase 2 Implementation PR4: Batch Size Enforcement + Runner (Feature-Gated)

## Scope
- Feature-gate context:
  - `canonical-freeze-prototype` only.
- Behavior change summary:
  - Adds on-chain max batch-size enforcement for `count_batch`.
  - Adds simple count-batch runner script for prototype frozen rounds.
- Out-of-scope:
  - Settlement activation.
  - Migration.
  - Fast-path (zk) changes.

## Checklist Linkage
- Phase 2 checklist:
  - `docs/PARI_MUTUEL_PHASE2_CHECKLIST.md`
- Task board item(s):
  - `docs/PARI_MUTUEL_PHASE2_TASK_BOARD.md`
- Guardrail policy:
  - `docs/PARI_MUTUEL_PHASE2_IMPLEMENTATION_CHECKLIST.md`

## Guardrails
- On-chain guardrail:
  - `PROTOTYPE_COUNT_BATCH_MAX_LEN = 6` (hard default).
- No timeout/deadline coupling introduced.
- No governance escape hatch introduced.
- No settlement-path activation introduced.

## Evidence Targets
- Contract tests:
  - `cargo test -p openjack --lib --features canonical-freeze-prototype`
- New enforcement test:
  - `count_batch_rejects_over_max_batch_size`
- Runner script:
  - `scripts/prototype-run-count-batch.mjs`
  - Package alias: `npm run count-batch:run`

