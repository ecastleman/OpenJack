# Pari-Mutuel PR10: Verifier Feasibility Spike (Non-Activating)

Date: 2026-02-21  
Scope: prototype-gated verifier spike only (`canonical-freeze-prototype`)

## Constraints Check
- No migration.
- No settlement activation.
- No economics changes.
- No governance/timeout bypass.
- `First valid finalize wins` semantics unchanged.

## What Changed
1. Added real verifier-binding path in `finalize_counts_fast_path`:
   - Requires previous transaction instruction to be ed25519 precompile verify.
   - Verifies signed message matches bound fast-path digest (`mock_public_inputs`).
   - Verifies ed25519 pubkey matches `config.authority`.
2. Kept existing binding matrix checks unchanged:
   - `round_id`, `ticket_set_root`, `ticket_count_frozen`, draw result, tier counts.
3. Added explicit verifier-binding errors:
   - `FastPathVerifierInstructionMissing`
   - `FastPathVerifierInstructionInvalid`
   - `FastPathVerifierPubkeyMismatch`
   - `FastPathVerifierMessageMismatch`
4. Expanded integration harness to exercise verifier mismatch classes and collect CU + proof prep latency:
   - `scripts/fast-path-mock-harness.mjs`

## Artifacts
- Main spike artifact (matrix + benchmark):
  - `reports/protocol-gate/fast-path-mock-harness-1771699467707.json`
- Deployed prototype program used for run:
  - `BtTuYHeZ7r9KkWUrH4EgrkY29oPqfrLuhWWtWzrJCp8G`
- Frozen round used for run:
  - `1771720000`

## Gate Results (PASS/FAIL)

### Gate 1: Binding correctness
PASS
- Positive path succeeds.
- Mismatch matrix rejects with specific errors:
  - 6043 round id mismatch
  - 6044 ticket root mismatch
  - 6045 ticket count mismatch
  - 6046 winning main mismatch
  - 6047 winning bonus mismatch
  - 6049 mock public inputs mismatch
  - 6050 mock proof mismatch
  - 6053 verifier pubkey mismatch
  - 6054 verifier message mismatch
  - 6042 verifier rejected (`mock_verifier_ok=false`)
- Replay/no-op behavior remains covered by existing unit tests.

### Gate 2: Empirical CU envelope (verifier verify + finalize)
PASS
- Source: benchmark section in artifact (`30` successful positive simulations).
- CU (devnet, Alchemy):
  - mean: `9654`
  - p95: `9654`
  - max: `9654`
- Safety margins:
  - 20% padded max: `11585`
  - 30% padded max: `12551`
- Envelope conclusion:
  - Well below 200k compute budget with large headroom.

### Gate 3: Proof ops feasibility (reference prover run + failure taxonomy)
PASS (prototype-level)
- Reference proof path: ed25519 signature creation over bound digest.
- Proof prep latency (from harness):
  - mean: `0.97 ms`
  - p95: `2 ms`
  - max: `2 ms`
- Reliability in run:
  - 30/30 successful positive proof+verify simulations.
- Failure taxonomy captured in same artifact:
  - verifier pubkey mismatch
  - verifier message mismatch
  - binding mismatch classes (round/root/count/draw/proof digest)
  - explicit verifier reject flag

### Gate 4: No new dead-end states
PASS
- No new timeout/deadline coupling introduced.
- Batch fallback path unchanged and still permissionless-progress.
- `First valid finalize wins` and post-finalization immutability semantics unchanged.
- Existing prototype invariant tests remain passing.

## Trace Links
- Program enforcement:
  - `programs/openjack/src/instructions/round.rs`
  - `programs/openjack/src/errors.rs`
- Invariant matrix update:
  - `docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md`
- Test suite run:
  - `cargo test -p openjack --lib --features canonical-freeze-prototype` (71 passed)

## Notes / Next Gate
- This is still non-activating scaffolding.
- Before activation planning, run a dedicated real-prover implementation spike and repeat CU+reliability measurement with that prover path.
