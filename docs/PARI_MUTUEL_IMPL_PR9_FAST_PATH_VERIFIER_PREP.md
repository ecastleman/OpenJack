# Pari-Mutuel PR9: Fast-Path Verifier Integration Prep

Date: 2026-02-21  
Scope: prototype-gated, non-activating integration prep only

## Constraint Compliance
- Feature-gated only: `canonical-freeze-prototype`.
- No migration.
- No settlement activation.
- No governance/timeout bypass.
- No economics/primary-path release changes.

## Delivered
1. Fast-path mock verifier interface bindings added to finalize args:
   - `mock_public_inputs: [u8; 32]`
   - `mock_proof: [u8; 32]`
2. Stub verifier interface validation added:
   - `validate_fast_path_mock_interface(...)`
   - deterministic digest checks for `mock_public_inputs` and `mock_proof`
3. Expanded negative-binding coverage with specific error assertions:
   - `FastPathRoundIdMismatch` (6043)
   - `FastPathTicketSetRootMismatch` (6044)
   - `FastPathTicketCountMismatch` (6045)
   - `FastPathWinningMainMismatch` (6046)
   - `FastPathWinningBonusMismatch` (6047)
   - `FastPathTierWinnerCountsMismatch` (6048)
   - `FastPathMockPublicInputsMismatch` (6049)
   - `FastPathMockProofMismatch` (6050)
   - `FastPathVerifierRejected` (6042)
4. End-to-end mock verifier harness added:
   - `/Users/ernesto/Documents/New project/scripts/fast-path-mock-harness.mjs`
   - Script alias: `npm run fast-path:mock-harness`
   - Captures simulator logs/err/CU per scenario.

## Test + Trace Links
- Error definitions:
  - `/Users/ernesto/Documents/New project/programs/openjack/src/errors.rs`
- Enforcement path:
  - `/Users/ernesto/Documents/New project/programs/openjack/src/instructions/round.rs`
- Key tests:
  - `finalize_counts_fast_path_rejects_round_id_mismatch`
  - `finalize_counts_fast_path_rejects_ticket_set_root_mismatch`
  - `finalize_counts_fast_path_rejects_ticket_count_mismatch`
  - `finalize_counts_fast_path_rejects_winning_main_mismatch`
  - `finalize_counts_fast_path_rejects_winning_bonus_mismatch`
  - `finalize_counts_fast_path_rejects_tier_winner_count_mismatch_on_replay`
  - `finalize_counts_fast_path_rejects_mock_public_inputs_mismatch`
  - `finalize_counts_fast_path_rejects_mock_proof_mismatch`
  - `finalize_counts_fast_path_rejects_mock_verifier_false`
  - `finalize_counts_fast_path_replay_is_noop_and_immutable`

## Harness Artifact (Deterministic Trace)
- Artifact:
  - `/Users/ernesto/Documents/New project/reports/protocol-gate/fast-path-mock-harness-1771698289382.json`
- Result summary:
  - Positive scenario succeeds.
  - Every binder mismatch scenario fails with its expected specific custom error.
  - Replay semantics remain no-op/equality-checked after finalization.

## Explicit Pre-Activation Gates
Before any fast-path activation:
1. Real verifier CU re-measure on prototype program (no proxy assumptions).
2. Binding invariant audit pass (all binder checks + replay rules).
3. No activation until freeze invariants + fast-path verifier evidence are both green.
