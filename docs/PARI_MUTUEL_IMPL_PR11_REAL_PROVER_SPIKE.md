# Pari-Mutuel PR11: Real Prover Integration Spike (Non-Activating)

Date: 2026-02-21  
Scope: feature-gated feasibility spike only (`canonical-freeze-prototype`)

## Constraint Check
- No migration.
- No settlement activation.
- No economics changes.
- No governance/timeout bypass.
- `first valid finalize wins` semantics unchanged.

## Verifier Path Implemented
- Replaced trusted-authority verifier binding with permissionless prover binding:
  - `FinalizeCountsFastPathArgs` now carries `verifier_pubkey`.
  - `finalize_counts_fast_path` requires an ed25519 verify instruction immediately before the finalize instruction.
  - Program checks that ed25519 instruction pubkey matches `args.verifier_pubkey`.
  - Program checks that ed25519 message matches bound digest (`mock_public_inputs`).
- All round/public-input binders from PR6/PR10 remain unchanged:
  - `round_id`
  - `ticket_set_root`
  - `ticket_count_frozen`
  - `winning_main`
  - `winning_bonus`
  - `tier_winner_counts`

## Gate Results (PASS/FAIL)

### 1) Binding correctness
PASS
- Positive path succeeds only when all binders + verifier instruction match.
- Mismatch matrix rejects with specific errors (see artifact taxonomy):
  - 6043 round id mismatch
  - 6044 ticket root mismatch
  - 6045 ticket count mismatch
  - 6046 winning main mismatch
  - 6047 winning bonus mismatch
  - 6049 mock public inputs mismatch
  - 6050 mock proof mismatch
  - 6053 verifier pubkey mismatch
  - 6054 verifier message mismatch
  - 6042 verifier rejected flag

### 2) Empirical CU envelope (devnet, Alchemy)
PASS
- Artifact benchmark (30 successful runs):
  - mean CU: `7442`
  - p95 CU: `7442`
  - max CU: `7442`
- Headroom:
  - p95 is far below practical Solana transaction limits.
  - No indication of verifier CU pressure in this spike path.

### 3) Proof ops feasibility (reference run + failure taxonomy)
PASS (spike-level)
- Reference prover path: ed25519 signature generation over bound public-input digest.
- Proof generation latency distribution (30 runs):
  - mean: `0.8 ms`
  - p95: `1 ms`
  - max: `1 ms`
- Reliability:
  - success: `30/30`
  - failure rate: `0%` in positive-path benchmark runs.
- Failure taxonomy for negative scenarios is explicit in artifact.

### 4) No new dead-end states
PASS
- Batch fallback path unchanged and still permissionless-progress.
- No timeout/deadline coupling added.
- Mixed-mode case (partial batch progress then fast-path finalize) remains covered by:
  - `finalize_counts_fast_path_short_circuits_partial_batch_progress`
- Post-finalization immutability/replay behavior unchanged.

## Artifacts
- Full spike run (matrix + distributions):
  - `reports/protocol-gate/fast-path-mock-harness-1771702886962.json`
- Single summary artifact:
  - `reports/protocol-gate/fast-path-verifier-spike-summary-1771702886962.json`

## Code/Trace Links
- Verifier/binding enforcement:
  - `programs/openjack/src/instructions/round.rs`
  - `programs/openjack/src/errors.rs`
- Harness:
  - `scripts/fast-path-mock-harness.mjs`
- Invariants:
  - `docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md`

## Go/No-Go Conclusion (PR11 Scope)
GO for continued prototype work.
- This verifier path is stable, permissionless in principle, and low-CU.
- It remains non-activating and does not change settlement/economic behavior.

No activation recommendation in PR11.
