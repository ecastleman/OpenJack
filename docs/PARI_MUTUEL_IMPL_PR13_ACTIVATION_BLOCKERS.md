# Pari-Mutuel PR13: Activation Blockers (Batch-Canonical Baseline)

Date: 2026-02-21  
Scope: governance/activation readiness checklist only (no behavior changes)

## Canonical Architecture Lock
1. Batch counting is canonical correctness + liveness path.
2. Signature fast finalize is optional acceleration only.
3. No activation decision may assume fast path availability.

## Blockers (Must All Be Cleared)

### B1. Batch-canonical invariants locked and green
- Required:
  - `INV-06` first-valid-finalize-wins semantics remain deterministic.
  - `INV-07` post-finalization immutability remains enforced.
  - `INV-08` fast-path binding integrity remains explicit and tested.
- Evidence:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md`
  - `cargo test -p openjack --lib --features canonical-freeze-prototype`

### B2. Batch progress operations playbook exists
- Required:
  - one-command status visibility (`processed/total/remaining`, last result counters)
  - one-command hard-fail diagnosis workflow (tx logs/simulation summary)
  - runner decision policy (profitability + force-complete) documented and machine-parseable output contract locked
- Evidence:
  - `/Users/ernesto/Documents/New project/scripts/count-batch-status.mjs`
  - `/Users/ernesto/Documents/New project/scripts/count-batch-failures.mjs`
  - `/Users/ernesto/Documents/New project/scripts/prototype-run-count-batch.mjs`
  - `/Users/ernesto/Documents/New project/scripts/rehearse-count-batch-activation.mjs`
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR17_RUNNER_OPS_POLICY.md`
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR18_REHEARSAL_RUNBOOK.md`

### B3. Signature fast-path trust model approved
- Required:
  - verifier key ownership policy
  - rotation/revocation workflow
  - multisig/committee option and escalation
  - monitoring + alert thresholds
- Evidence:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR13_SIGNATURE_FAST_PATH_TRUST_MODEL.md`

### B4. ZK status explicitly resolved
- Required:
  - PR12 Gate A result acknowledged (`FAIL`)
  - final empirical Groth16 viability re-check run on target cluster(s)
  - explicit PASS/FAIL outcome with stop policy
  - explicit lane policy: `N/A` for batch-canonical activation, `REQUIRED` for any ZK-fast-path activation
- Evidence:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR12_GATE_A_REPORT.md`
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR13_ZK_RECHECK_GATES.md`

### B5. No activation bypasses
- Required:
  - no governance timeout bypass
  - no deadline-based fallback-to-finalization shortcut
  - no economics changes bundled with activation review

### B6. Two-lane authority + guarantee language lock
- Required:
  - fast path explicitly classified as readiness signal only
  - canonical claim unlock explicitly classified as batch authority only
  - user guarantee language approved and linked
- Evidence:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR14_ACTIVATION_PLAN.md`
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR14_USER_GUARANTEES.md`

### B7. Settlement bounty economics lock
- Required:
  - activation economics split documented: 2% treasury, 3% bounty, 85% jackpot, 10% lower-tier pools
  - deterministic reward accounting rules documented (99% distributed, 1% carry-forward)
  - optional Earn/Help Finalize UX requirement documented
  - prototype implementation + invariant tests linked (still non-activating)
- Evidence:
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR14_ACTIVATION_PLAN.md`
  - `/Users/ernesto/Documents/New project/docs/PARI_MUTUEL_IMPL_PR15_BOUNTY_ACCOUNTING_REPORT.md`

### B8. Round solvency floor invariant is structurally enforced
- Required:
  - all round-debiting paths enforce: `round_lamports_after >= rent_exempt_min + undistributed_bounty + required_settlement_reserve`
  - invariant has executable tests for claim path, count-batch bounty payout path, and mixed-mode finalize interactions
  - no instruction path can starve canonical claimability funds or bounty carry via unrelated debit
- Evidence:
  - `/Users/ernesto/Documents/New project/programs/openjack/src/solvency.rs` (`assert_round_solvency_floor`, `required_settlement_reserve`)
  - `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/claim.rs` (pre-debit solvency check in `claim`)
  - `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs` (pre-transfer solvency check in `pay_count_batch_bounty`)
  - `npm run check:round-solvency` (regression guard for new round lamport debit callsites)
  - `cargo test -p openjack --lib --features canonical-freeze-prototype` (solvency + mixed sequencing tests)

#### B8 Debit-Path Inventory (Round Lamports)
1. `claim` payout transfer
   - File: `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/claim.rs`
   - Debit site: `pay_claim_to_claimer` mutates round lamports.
   - Solvency guard: `assert_round_solvency_floor` executed before `debit_claim_source_pool` and lamport transfer.
2. `count_batch` bounty payout transfer
   - File: `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs`
   - Debit site: `pay_count_batch_bounty` mutates round lamports.
   - Solvency guard: `assert_round_solvency_floor` executed before round->caller transfer and before bounty accounting mutation.
3. Non-debit note
   - `purchase` credits round lamports via system transfer and does not debit round account.

## Activation Decision Policy
- If any blocker is open: **NO-GO**.
- If all blockers are cleared:
  - fast path may be enabled only as acceleration,
  - batch remains canonical and always operable.
