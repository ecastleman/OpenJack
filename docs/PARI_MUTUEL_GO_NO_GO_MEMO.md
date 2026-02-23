# Pari-Mutuel Canonical Count: Go/No-go Memo

Date: 2026-02-20
Scope: Spike A (canonical freeze feasibility) + Spike B (realistic batch envelope)
Constraint: analysis only (no production state changes, no partial migration)

## Canonical Source Definition (Phase 2 Lock)
Canonical source (one sentence):
- The canonical ticket-set commitment is deterministically derived from `Round` account state only (`round_id`, `tree_address`, `ticket_count`, `close_ts`, `leaf_start_index`, `leaf_end_index`) and written as `ticket_set_root`.

Code path pointer:
- Derivation function: `programs/openjack/src/instructions/round.rs` (`derive_prototype_ticket_set_root`)
- Commit/apply logic: `programs/openjack/src/instructions/round.rs` (`apply_prototype_freeze`, called by `freeze_ticket_set`)

## Executive Verdict

1. Canonical freeze feasibility (current architecture): **FAIL**
2. Canonical freeze feasibility (with required protocol shape): **PASS (conditional)**
3. Realistic batch envelope as fallback liveness path: **PASS (bounded)**
4. Realistic batch envelope as primary scaling path (1M+ tickets): **FAIL**
5. Program-level decision today: **NO-GO for immediate implementation** until freeze preconditions are proven in a focused implementation spike.

## What Was Verified In Code

1. Round currently stores `tree_address` and `ticket_count`, but no canonical `ticket_set_root` or immutable close-time range commitment.
2. Round close is currently just state transition (`OPEN -> CLOSED`), no ticket universe freeze.
3. Tier counts are currently scanner-published in settling; finalization requires all tier roots and is bounded by `settle_deadline_ts`.
4. Runtime currently initializes/reuses one cNFT tree by default (`OPENJACK_TREE_MAX_DEPTH` default `14`, i.e. ~16,384 leaves).

Primary references:
- `programs/openjack/src/state.rs`
- `programs/openjack/src/instructions/round.rs`
- `programs/openjack/src/instructions/purchase.rs`
- `services/scanner/src/adapters/publisher.js`
- `scripts/init-cnft-tree.mjs`

## Spike A: Canonical Freeze Feasibility

### Pass/Fail Outcome

- Current v1 shape: **FAIL**
- With required state-machine/storage changes: **PASS (conditional)**

### Why Current Shape Fails

1. No on-chain canonical ticket-set commitment exists at close.
2. Shared tree usage is the default operational mode; round state does not currently bind an immutable global leaf interval `[start,end)` to the round.
3. Without immutable root/range commitment, inclusion proofs can be valid structurally but not guaranteed to target the exact round ticket universe.

### What Must Be True For PASS

At close-time freeze, program must commit immutable round-universe anchors from program-maintained state:

1. `ticket_set_root` (or equivalent canonical inclusion commitment)
2. `ticket_count_frozen`
3. round-scoped immutable leaf boundary metadata (if shared tree)

Operationally safe form:

1. `OPEN -> CLOSED_PENDING_FREEZE` (close remains O(1), no deadlines)
2. `freeze_ticket_set` instruction, idempotent and retryable
3. `CLOSED_PENDING_FREEZE -> CLOSED_FROZEN` on success

### Practical Feasibility Assessment

1. **Path A (recommended): dedicated tree per round**
- Feasibility: **PASS (strong)**
- Reason: root and leaf namespace are round-local by construction; freeze logic is straightforward and auditable.

2. **Path B: shared tree with immutable range commitment**
- Feasibility: **PASS (weaker, higher complexity)**
- Reason: requires robust round-scoped range tracking and strict invariants to avoid ambiguity/drift.

3. **Current implementation (shared tree, no immutable range commit, no ticket_set_root)**
- Feasibility: **FAIL**

## Spike B: Realistic Batch Envelope

## Empirical CU Inputs (Measured)

Source report:
- `reports/protocol-gate/devnet-claim-cu-statistics.json`
- `reports/protocol-gate/devnet-claim-cu-refresh-validation.json`

Baseline sample details:
1. RPC: `ALCHEMY_DEVNET_RPC_URL`
2. Fixed claim signatures sampled: `60`
3. Matched with compute units: `60/60`
4. Failed fetches: `0`

Baseline claim-proxy CU:
1. Mean: `38,123`
2. p95: `42,623`
3. Max: `45,624`
4. Min: `36,622`
5. Std dev: `1,953`
6. CV: `0.0512` (low spread)

Refresh validation details:
1. RPC: `ALCHEMY_DEVNET_RPC_URL`
2. Wallet signatures collected: `1,400`
3. Transactions scanned: `1,174`
4. Matched claim transactions: `120`
5. Failed RPC calls: `0`

Refresh claim-proxy CU:
1. Mean: `38,996`
2. p95: `44,423`
3. Max: `50,123`
4. Min: `36,622`
5. Std dev: `2,684`
6. CV: `0.0688`

Interpretation:
1. Claim CU is a conservative proxy for per-leaf batch verification because claim path includes extra replay/account-write/payout-side state mutation not required in pure count-batch.
2. For deterministic safety, use refresh `p95` + margin (not mean).

## Safe Batch Size (Derived from refresh p95=44,423)

Formula:
1. `safe_B = floor((CU_limit * (1 - margin)) / p95_per_leaf)`

Results:
1. Under `200k` CU cap:
   - 20% margin: `B=3`
   - 30% margin: `B=3`
2. Under `400k` CU cap:
   - 20% margin: `B=7`
   - 30% margin: `B=6`

## Transaction Count Envelope (Empirical Safe B)

`tx_count = ceil(N / B)`

1. 100,000 tickets:
   - B=3: `33,334` tx
   - B=6: `16,667` tx
   - B=7: `14,286` tx
2. 1,000,000 tickets:
   - B=3: `333,334` tx
   - B=6: `166,667` tx
   - B=7: `142,858` tx
3. 10,000,000 tickets:
   - B=3: `3,333,334` tx
   - B=6: `1,666,667` tx
   - B=7: `1,428,572` tx

## Time/Cost Implication

Even with empirical conservative sizing, fallback remains operationally heavy at 1M+ scale and should be treated strictly as liveness recovery, not primary settlement throughput.

## Batch Verdict

1. As a **safety fallback** for permissionless eventual progress: **PASS**
2. As a **primary scaling path** for large rounds without zk fast-path: **FAIL**

Interpretation:

- Batch fallback is good for liveness guarantees.
- UX/performance at 1M+ requires a fast path (zk or equivalent aggregated proof path).

## Go/No-go Decision

## Immediate implementation decision

- **NO-GO** for direct build right now.

Reason: canonical freeze prerequisites are not yet present in current state model and tree binding strategy.

## Conditional GO criteria

Move to GO only after all are proven:

1. Canonical freeze from program-maintained state is implemented and reproducible (no off-chain correctness dependency).
2. Freeze path is retryable/idempotent and cannot dead-end.
3. Range/root invariants are auditable and enforceable.
4. Batch counting CU benchmark yields a validated safe `B` (not assumption-based).
5. Fast-path plan exists for 1M+ if target scale requires it.

## Recommended Next Spikes (still no migration)

1. Freeze feasibility prototype (dev branch only):
- Implement minimal `CLOSED_PENDING_FREEZE` + `freeze_ticket_set` skeleton and prove deterministic success/retry semantics.
- Prove invariant checks under forced instruction retries and contention.

2. CU benchmark harness:
- Implement synthetic `count_batch` verifier stub and measure CU vs batch size under realistic proof depth.
- Produce empirical safe `B` (p50/p95) and update envelope table.

3. Tree strategy decision gate:
- Decide Path A (dedicated tree/round) vs Path B (shared tree + immutable range commitment) before any broader protocol work.

## Final Pass/Fail Summary

1. Canonical freeze feasibility:
- Current architecture: **FAIL**
- With required protocol shape (recommended Path A): **PASS (conditional)**

2. Realistic batch envelope:
- Fallback liveness role: **PASS (empirically bounded)**
- Primary settlement scaling role (1M+ without fast path): **FAIL (empirically confirmed)**

## Appendix: Locked Fast-Path Semantics

This memo locks the intended path interaction semantics for future phases.
Normative detail lives in:
- `docs/PARI_MUTUEL_CANONICAL_COUNT_SPEC_DRAFT.md`
  - section: `Fast-Path Retry Semantics`

Locked rules:

1. zk finalize is permissionless and retryable:
   - callable any time in `DRAWN_COUNT_UNFINALIZED` while `counts_finalized == false`
   - failed zk attempts are atomic no-state-change failures
   - no protocol-level wait window

2. zk may short-circuit partial batch progress:
   - zk proof binds to same canonical commitment/draw inputs
   - on success: set final counts, set `counts_finalized = true`,
     set `count_progress_index = ticket_count_frozen`

3. Mutual exclusion after finalization:
   - once `counts_finalized == true`, both zk and batch are reject or equality-check no-op
   - `tier_winner_counts` immutable post-finalization

4. No cross-path dependency:
   - batch never depends on zk availability
   - zk never requires batch untouched
   - first valid finalize wins
