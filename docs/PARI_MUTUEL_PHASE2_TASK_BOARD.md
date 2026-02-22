# Pari-Mutuel Phase 2 Task Board (Dependency-Ordered)

Date: 2026-02-20  
Mode: checklist-to-execution planning only (no migration behavior changes)  
Baseline:
- `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE1_PROTOTYPE_STATUS.md`
- `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_CHECKLIST.md`

## Global Constraints
- Prototype-gated only.
- No governance escape hatch introduced in this phase.
- No deadline-based bypass that can recreate orphan risk.

## Progress Snapshot
- `P2-01`: COMPLETE (PASS)
- `P2-02`: COMPLETE (PASS)
- `P2-03`: COMPLETE (PASS)
- `P2-04`: COMPLETE (PASS)
- `P2-05`: COMPLETE (PASS)
- `P2-06`: COMPLETE (PASS)
- `P2-07`: COMPLETE (PASS)
- `P2-08`: COMPLETE (PASS)

## Task P2-01: Canonical Source Spec Lock
Depends on: none

Objective:
- Lock one-sentence canonical-source definition and code pointers in all Phase 2 planning docs.

Deliverables:
- Canonical-source statement duplicated into:
  - canonical architecture spec draft
  - migration planning notes
  - implementation checklist header

PASS gates:
- Canonical source text is identical across docs.
- Code pointers reference:
  - `derive_prototype_ticket_set_root`
  - `apply_prototype_freeze` / `freeze_ticket_set`
- No caller-provided commitment inputs in definition.

FAIL gates:
- Any document defines canonical source differently.
- Any definition introduces off-chain correctness dependency.

## Task P2-02: Freeze Liveness Policy Lock (`CLOSED_PENDING_FREEZE`)
Depends on: P2-01

Objective:
- Lock explicit state policy for retry semantics and no-timeout behavior.

Deliverables:
- State policy section in protocol state-machine doc with:
  - permissionless retry semantics
  - no timeout invalidation of freeze path
  - no governance escape hatch in Phase 2 scope

PASS gates:
- Policy explicitly states failures are retryable and leave state unchanged.
- Policy explicitly states no protocol timeout kills all completion paths.
- Escape hatch scope remains “not in this phase.”

FAIL gates:
- Any introduced timeout can disable freeze/finalization path.
- Any governance/manual override appears in Phase 2 planning.

## Task P2-03: Invariant Matrix (Mutual Exclusion + Replay Determinism)
Depends on: P2-02

Objective:
- Formalize and pin invariants that prevent reintroduction of orphan/stall vectors.

Deliverables:
- Invariant table in docs with:
  - buy/freeze mutual exclusion
  - freeze replay versioning rule
  - no deadline-based orphan vector

PASS gates:
- Mutual exclusion invariant: no reachable state permits buy + freeze together.
- Replay invariant: repeated freeze calls are identical no-op or deterministic mismatch reject.
- Invariants map to existing tests in `round.rs`.

FAIL gates:
- Any invariant cannot be mapped to a testable condition.
- Replay permits divergent root from same round state.

## Task P2-04: Error Taxonomy Lock (Retryable vs Hard-Stop)
Depends on: P2-03

Objective:
- Classify freeze-path errors with deterministic policy and no timeout bypass.

Deliverables:
- Error taxonomy table (retryable/hard-stop) with explicit policy for:
  - `FreezeStateInvalid`
  - `FreezeSourceInvalid`
  - `FreezeCommitmentMismatch`
  - freeze-path overflow defects

PASS gates:
- Every freeze-path error maps to one class and one policy.
- No hard-stop class has time-based silent escape.

FAIL gates:
- Ambiguous classification for any freeze error.
- Timeout-based bypass appears in taxonomy.

## Task P2-05: Account Size and Rent Measurement Spec
Depends on: P2-03

Objective:
- Convert planning deltas into measurable acceptance checks before any migration PR.

Deliverables:
- Measurement runbook with concrete commands and artifact path for:
  - current round account rent-exempt minimum
  - current +64 byte round account rent-exempt minimum

PASS gates:
- Commands are executable as written.
- Acceptance threshold defined:
  - measured rent delta must fit within +64 byte planning envelope.

FAIL gates:
- No concrete command path to reproduce measurement.
- No threshold to accept/reject measured delta.

## Task P2-06: CU Guardrail Lock for Fallback Batching
Depends on: P2-03

Objective:
- Lock conservative fallback defaults from empirical CU statistics.

Deliverables:
- Guardrail section in implementation checklist:
  - `B=3` @ 200k CU
  - `B=6` @ 400k CU
  - `B=7` as aggressive opt-in only
- Pointer to CU artifact:
  - `/Users/ernesto/Documents/New project/reports/protocol-gate/devnet-claim-cu-refresh-validation.json`

PASS gates:
- Guardrails include 30% safety-margin rationale.
- Any proposed change requires refreshed empirical artifact.

FAIL gates:
- Batch defaults changed without new evidence.
- No explicit aggressive-toggle labeling for `B=7`.

## Task P2-07: Traceability Bundle (Spec -> Tests -> Gates)
Depends on: P2-04, P2-05, P2-06

Objective:
- Produce a single traceability map proving each gate is testable/measurable.

Deliverables:
- Table with columns:
  - requirement
  - source doc section
  - enforcing test/measurement
  - PASS/FAIL criterion

PASS gates:
- All checklist exit criteria from Phase 2 checklist are trace-linked.
- No orphan-risk gate remains unowned.

FAIL gates:
- Any gate has no test/measurement owner.

## Task P2-08: Phase 2 Checklist Exit Review
Depends on: P2-07

Objective:
- Formal “ready/not-ready” decision for moving to implementation PRs.

Deliverables:
- One-page exit summary with:
  - completed tasks
  - unmet gates
  - explicit recommendation (`READY_FOR_IMPL` or `NOT_READY`)

PASS gates:
- All gates in `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_CHECKLIST.md` marked pass.
- No scope drift beyond prototype-gated planning.

FAIL gates:
- Any gate open.
- Any migration behavior change introduced.

## Stop Conditions (Immediate Halt)
- Canonical source definition changes to include off-chain trust dependency.
- Any timeout-based mechanism can invalidate all completion paths.
- Any proposal introduces governance escape hatch in Phase 2.
- Any replay path can yield divergent commitment for same round state.
