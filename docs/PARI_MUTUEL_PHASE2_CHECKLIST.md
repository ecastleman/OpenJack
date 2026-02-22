# Pari-Mutuel Phase 2 Checklist PR

Date: 2026-02-20
Baseline: `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE1_PROTOTYPE_STATUS.md` (locked)
Scope: checklist/spec hardening only (no production migration). Phase 2 remains prototype-gated.
Execution board: `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_TASK_BOARD.md`
Invariant matrix: `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md`
Error taxonomy: `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_ERROR_TAXONOMY.md`
P2-05 rent artifact: `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_P2_05_RENT_MEASUREMENT.md`
Implementation checklist: `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_IMPLEMENTATION_CHECKLIST.md`
Traceability bundle: `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_TRACEABILITY_BUNDLE.md`
Exit review: `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_EXIT_REVIEW.md`
Follow-on PR template: `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_IMPL_PR_TEMPLATE.md`

## 1) Canonical Source Definition (Audit Clarity)
Canonical source (one sentence):
- The canonical ticket-set commitment is deterministically derived from `Round` account state only (`round_id`, `tree_address`, `ticket_count`, `close_ts`, `leaf_start_index`, `leaf_end_index`) and written as `ticket_set_root`.

Code path pointer:
- Derivation function: `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`derive_prototype_ticket_set_root`)
- Commit/apply logic: `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (`apply_prototype_freeze`, called by `freeze_ticket_set`)

Audit note:
- `freeze_ticket_set` currently accepts no caller-provided commitment args; caller timing/signer identity do not alter derived root.

## 2) Liveness Policy for `CLOSED_PENDING_FREEZE`
Protocol policy (explicit):
- `CLOSED_PENDING_FREEZE` is permissionless-progress state.
- Any caller may invoke `freeze_ticket_set`.
- Failures are retryable; state remains unchanged on failure.
- No protocol deadline invalidates freeze retries.
- No automatic timeout-based mode switch in Phase 2 checklist scope.

Escape hatch policy (explicit):
- Protocol-level escape hatch: **none in this phase**.
- Governance/manual intervention path: **not introduced in this checklist PR** (must be separately specified if desired).

Required invariants:
- Once freeze committed, future retries must equality-check and no-op (or reject mismatch) without mutating canonical commitment.
- `request_draw` may proceed from frozen state per locked Phase 1 semantics.

## 2.1) Required Invariants (PASS/FAIL Gates)
1. Mutual exclusion (`OPEN` buy window vs freeze):
- PASS if buys are only valid in `OPEN`, freeze is only valid in `CLOSED_PENDING_FREEZE`/`CLOSED_FROZEN`, and no state allows both operations.
- FAIL if any reachable state permits buy + freeze concurrently.

2. Freeze replay/versioning:
- PASS if repeated `freeze_ticket_set` calls can only:
  - no-op with identical canonical commitment state, or
  - reject with deterministic mismatch error.
- FAIL if replay can produce divergent `ticket_set_root` for same round state.

3. No deadline-based orphan vector:
- PASS if no timeout invalidates all freeze/finalization progress paths.
- FAIL if any deadline can permanently disable all completion paths.

4. Governance escape hatch scope (Phase 2):
- PASS if no protocol governance escape hatch is introduced in Phase 2 checklist work.
- FAIL if governance/manual override logic is added in this phase.

## 3) Account Size / Rent Delta + CU Guardrails

### Account size delta (Round)
Prototype-added fields payload:
- `freeze_committed: bool` = 1 byte
- `ticket_set_root: [u8;32]` = 32 bytes
- `ticket_count_frozen: u32` = 4 bytes
- `leaf_start_index: u32` = 4 bytes
- `leaf_end_index: u32` = 4 bytes
- `freeze_committed_ts: i64` = 8 bytes
- `freeze_attempts: u32` = 4 bytes

Payload delta:
- Exact payload increase: **+57 bytes**
- Conservative allocation guardrail for planning: **+64 bytes**

Rent delta guardrail (phase-2 checklist level):
- Treat +64 bytes as required reserve sizing delta.
- Record exact lamport delta via `getMinimumBalanceForRentExemption` in an RPC-enabled validation step before migration PR.
- Migration PR must include measured lamport delta (not estimate).

### CU guardrails (fallback batching)
Locked conservative defaults from CU spike artifacts:
- 200k CU cap: **B=3**
- 400k CU cap: **B=6**
- 400k CU aggressive toggle (opt-in only): **B=7**

Policy:
- Fallback batching is liveness path, not primary throughput path.
- zk/fast path remains target for scale; fallback must remain deterministic and bounded.

## 4) Error Taxonomy (Retryable vs Hard-Stop)
No timeout-based hard-stop is allowed in this phase.  
Normative row-level mapping is defined in:
- `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_ERROR_TAXONOMY.md`

Gate:
- PASS if taxonomy is documented and implemented without timeout-based bypass semantics.
- FAIL if any listed hard-stop is silently converted into time-based escape.

## 5) Concrete Measurement Tasks (Commands + Thresholds)
These are required before any migration PR.

### 5.1 Rent delta measurement
Command template (devnet or target cluster RPC):
```bash
curl -sS -H 'content-type: application/json' \"$OPENJACK_CU_RPC_URL\" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getMinimumBalanceForRentExemption\",\"params\":[<ROUND_SIZE_BYTES>]}' | jq -r '.result'
```
Run twice:
- `<ROUND_SIZE_BYTES>` = current round account size
- `<ROUND_SIZE_BYTES>` = current round account size + 64 (planning guardrail)

Acceptance thresholds:
- PASS if measured delta is positive and <= delta implied by +64-byte planning guardrail.
- FAIL if measured delta exceeds +64-byte planning envelope (requires re-sizing/re-scope).

### 5.2 CU guardrail verification
Command:
```bash
cargo test -p openjack --lib --features canonical-freeze-prototype
```
Empirical CU input artifact:
- `/Users/ernesto/Documents/New project/reports/protocol-gate/devnet-claim-cu-refresh-validation.json`

Acceptance thresholds:
- PASS if guardrails remain:
  - 200k cap: `B=3`
  - 400k cap: `B=6`
  - `B=7` only as explicitly aggressive opt-in
- FAIL if new empirical p95/max data invalidates these defaults under 30% safety margin.

## Phase 2 Checklist Tasks
- [x] Add canonical-source sentence + code pointers to canonical spec and migration notes.
- [x] Add explicit `CLOSED_PENDING_FREEZE` liveness subsection to protocol state-machine spec.
- [x] Add “no escape hatch in protocol path” statement (or introduce one via separate ADR, out of this checklist PR).
- [x] Add invariant matrix with explicit PASS/FAIL criteria and trace links to tests/code guards.
- [x] Add 1:1 freeze-path error taxonomy with retryable/hard-stop semantics, recovery guidance, and trace links.
- [x] Add account-size delta table to migration planning doc.
- [x] Add rent measurement task (RPC-backed command + expected artifact file path).
- [x] Add CU guardrail constants and rationale to implementation checklist.
- [x] Add acceptance gate: any change to canonical derivation inputs requires test + spec diff.

## Exit Criteria (Checklist PR)
- [x] The three requested gates are explicit in docs:
  - [x] canonical-source definition + code pointer
  - [x] `CLOSED_PENDING_FREEZE` liveness/escape-hatch policy
  - [x] account/rent delta + CU guardrails
- [x] Mutual exclusion invariant (no buys while freeze is possible) has explicit PASS/FAIL gate.
- [x] Freeze replay/versioning rule has explicit PASS/FAIL gate.
- [x] Error taxonomy includes retryable vs hard-stop classifications (no timeout bypass).
- [x] Measurement tasks include concrete commands and acceptance thresholds.
- [x] Phase 2 remains prototype-gated and introduces no governance escape hatch.
- [x] No protocol behavior changes in this checklist PR.
- [x] Follow-on implementation PR template references this checklist.
