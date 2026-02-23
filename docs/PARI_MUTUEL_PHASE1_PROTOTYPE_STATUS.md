# Phase 1 Prototype Status (Canonical Freeze + Fallback Guardrails)

Date: 2026-02-20
Scope: prototype-only, no migration and no production state changes.

## Decision
- Prototype Gate Verdict: PASS
- Migration Verdict: NOT AUTHORIZED (requires Phase 2 design/implementation decision)

## Implemented in Prototype (feature-gated)
Feature flag: `canonical-freeze-prototype`

- Added prototype statuses:
  - `ClosedPendingFreeze`
  - `ClosedFrozen`
- Added prototype round fields:
  - `freeze_committed`
  - `ticket_set_root`
  - `ticket_count_frozen`
  - `leaf_start_index`
  - `leaf_end_index`
  - `freeze_committed_ts`
  - `freeze_attempts`
- Added prototype instructions:
  - `begin_freeze`
  - `freeze_ticket_set`
- Added freeze error taxonomy:
  - `FreezeStateInvalid`
  - `FreezeCommitmentMismatch`
  - `FreezeSourceInvalid`
- Updated `request_draw` gating to allow `ClosedFrozen` in prototype mode.

## Locked Semantics Verified
- Freeze is permissionless in prototype path.
- Freeze is retryable/idempotent:
  - Repeated freeze attempts increment attempt counter.
  - Existing commitment is accepted only if derived values match exactly.
- Commitment mismatch is deterministic hard-reject.
- `request_draw` accepts:
  - baseline: `Closed`
  - prototype: `Closed` and `ClosedFrozen`

## Canonical Derivation Evidence (No Caller Influence)
- `freeze_ticket_set` takes no caller-provided commitment inputs; it derives commitment from round-owned fields only.
- Prototype derivation function inputs are:
  - `round_id`
  - `tree_address`
  - `ticket_count`
  - `close_ts`
  - `leaf_start_index`
  - `leaf_end_index`
- These are read from `Round` account state, not from instruction args.
- Test proof:
  - `freeze_commitment_is_derived_only_from_round_state_not_caller_timing`
  - Confirms different caller timing (`now`) does not alter `ticket_set_root`.

## Multi-Caller Race Determinism Evidence
- Test proof:
  - `multi_caller_race_order_keeps_same_canonical_commitment_state`
- Simulates two callers submitting freeze retries in different order.
- Verified canonical commitment end-state invariants remain identical:
  - `freeze_committed`
  - `ticket_set_root`
  - `ticket_count_frozen`
  - `leaf_start_index`
  - `leaf_end_index`
  - `freeze_attempts`
- Note:
  - `freeze_committed_ts` is intentionally first-writer timestamp metadata and may differ by winner timing; canonical commitment fields remain deterministic.

## Path Decision (Phase 1 Prototype)
| Path | Verdict | Rationale |
|---|---|---|
| Path A: dedicated per-round ticket universe commitment | `PASS (prototype)` | Prototype commitment derivation is round-local and deterministic from round-owned state. |
| Path B: shared tree + global range commitment | `FAIL (not implemented in prototype)` | No global shared-tree start/end commitment model implemented in Phase 1 prototype. |

Chosen path for Phase 1 prototype: **Path A**.

## Test Evidence
Commands run:
- `cargo test -p openjack --lib --features canonical-freeze-prototype`
- `cargo test -p openjack --lib`

Results:
- Prototype mode: 40 passed, 0 failed.
- Baseline mode: 33 passed, 0 failed.

New/extended prototype tests include:
- deterministic prototype root
- prototype root input sensitivity
- freeze commit + retry idempotency behavior
- freeze mismatch rejection behavior
- caller-independence of freeze commitment derivation
- multi-caller race order determinism of canonical commitment state
- request-draw gate acceptance for `ClosedFrozen` in prototype mode

## Stop Conditions Check
- No production behavior change in default build: PASS
- No partial migration started: PASS
- Invariants captured by tests (retryable, immutable-once-committed semantics): PASS

## Notes
- This is a feature-gated prototype proving semantics and testability.
- This artifact does **not** claim end-to-end production readiness for canonical freeze architecture.
- Phase 2 remains conditional on explicit go/no-go for full architecture rollout.
- Phase 2 checklist artifact: `docs/PARI_MUTUEL_PHASE2_CHECKLIST.md`
