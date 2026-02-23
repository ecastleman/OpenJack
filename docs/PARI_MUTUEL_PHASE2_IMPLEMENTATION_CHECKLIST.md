# Pari-Mutuel Phase 2 Implementation Checklist (Locked Policy)

Date: 2026-02-20  
Scope: prototype-gated planning only (no behavior changes in this document)

Policy lock:
- This document is normative for fallback batch sizing policy.
- No soft recommendation language applies.

## CU Guardrail Constants (Locked)
1. `B=3` at `200k` CU cap (hard default)
2. `B=6` at `400k` CU cap (hard default)
3. `B=7` at `400k` CU cap is aggressive opt-in only and must remain disabled by default.

Trace evidence artifact:
- `reports/protocol-gate/count-batch-cu-summary-1771655463798.json`
- Note: current prototype on-chain max-batch guard rejects `B=7` (`CountBatchTooLarge`/custom `6039`).

## Settlement Role Policy (Locked)
- Batch counting is the canonical correctness + liveness settlement path.
- Signature fast finalize is optional acceleration/readiness signaling only and must never be required for eventual correctness or claim unlock authority.
- zk fast-path remains blocked behind empirical re-check gates after PR12 Gate A fail.

## Change Control for `B` (Locked)
- Any proposed change to `B` values is rejected unless accompanied by a new empirical CU measurement artifact.
- Required evidence for change:
  1. refreshed transaction sample method
  2. updated mean/p95/max CU statistics
  3. updated safety-margin derivation (20-30%)
  4. explicit replacement values for `B`

## Canonical Derivation Input Change Gate (Locked)
- Any change to canonical derivation inputs (`round_id`, `tree_address`, `ticket_count`, `close_ts`, `leaf_start_index`, `leaf_end_index`) requires:
  1. spec diff in `docs/PARI_MUTUEL_CANONICAL_COUNT_SPEC_DRAFT.md`
  2. checklist update in `docs/PARI_MUTUEL_PHASE2_CHECKLIST.md`
  3. test update in `programs/openjack/src/instructions/round.rs`
- No exception path in Phase 2.

## PASS/FAIL for P2-06
PASS:
1. Hard defaults for `B` are present exactly as above.
2. Liveness-only fallback statement is explicit.
3. `B` change gate requires new empirical artifact.
4. CU artifact trace is explicit.

FAIL:
1. Any default uses non-normative wording.
2. Fallback is described as primary settlement.
3. `B` can change without new empirical measurement.
