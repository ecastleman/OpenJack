# Pari-Mutuel PR12: Real ZK Verifier Feasibility Plan (Non-Activating)

Date: 2026-02-21  
Scope: planning-only feasibility spike for proof-of-correctness (no activation)

## 1) Purpose
PR11 proved binding mechanics, permissionless submission shape, and stable CU for verifier plumbing.  
PR12 defines the first **actual proof-of-correctness** spike: prove `tier_winner_counts[6]` is correct for the full canonical round ticket set committed by `ticket_set_root`.

## 2) Hard Constraints (unchanged)
- Feature-gated only.
- No migration.
- No settlement activation.
- No economics changes.
- No governance/timeout bypass.
- Keep finalize semantics unchanged:
  - first valid finalize wins
  - post-finalization replay is no-op/equality-check
  - batch fallback remains permissionless liveness path.

## 3) Target Proof System (and why)
Target for spike: **Groth16 proof with on-chain BN254 verifier path** (or cluster-equivalent pairing verifier path), wrapped behind current fast-path verifier interface.

Why this target:
- Small on-chain verification footprint compared with proving on-chain.
- Widely used proving model for succinct on-chain verification.
- Fits current need: one-shot global count finalization proof.

Gate 0 (prerequisite): verifier primitive availability on target runtime (devnet profile used for prototype runs).  
If unavailable or unstable on target runtime: **NO-GO for this path**.

## 4) Exact Statement to Prove
For a round with frozen canonical commitment:
- Public inputs:
  - `round_id`
  - `ticket_set_root`
  - `ticket_count_frozen`
  - `winning_main[5]`
  - `winning_bonus`
  - `tier_winner_counts[6]`
  - `verifier_pubkey` (or proving-key identity binding, if retained in interface)
- Statement:
  1. There exists a canonical ticket set of size `ticket_count_frozen` whose Merkle root is `ticket_set_root`.
  2. For each ticket in that set, tier classification under (`winning_main`, `winning_bonus`) is computed by protocol rules.
  3. Aggregating those per-ticket classifications yields exactly `tier_winner_counts[6]`.
  4. No skipped tickets, no double-counted tickets.

This is the minimum correctness claim needed for pari-mutuel exact counts without scanner trust.

## 5) Stop Gates (PASS/FAIL)
All gates must pass for any follow-on activation discussion.

### Gate A: Proof System/Verifier Feasibility
PASS:
- Can generate proof for the statement above.
- Can verify proof on target runtime through intended on-chain verifier path.
- Deterministic verification result across repeated runs.

FAIL:
- Verifier primitive unavailable/unstable.
- Proof verifies inconsistently.
- Binding cannot be preserved exactly with existing public inputs.

### Gate B: Binding Correctness
PASS:
- Existing binding matrix remains intact (round/root/count/draw/tier counts).
- Any mismatch rejects with specific error.
- Mixed-mode invariant holds: partial batch progress -> valid ZK finalize short-circuits to same terminal state.

FAIL:
- Any binder can drift or mismatch without deterministic reject.
- Mixed-mode behavior diverges from locked invariants.

### Gate C: Verifier CU Envelope (devnet target)
Report required:
- mean / p95 / max CU for `verify + finalize` path.

Target thresholds (for feasibility pass):
- p95 <= 120,000 CU
- max <= 160,000 CU

If exceeded:
- **NO-GO for activation** (remain fallback-only architecture; iterate verifier/circuit or choose different proving path).

### Gate D: Prover Latency + Reliability
Report required:
- mean / p95 / max proving latency per round size bucket.
- failure rate and categorized failure causes.

Target thresholds (initial feasibility):
- p95 proving latency <= 120s at expected launch-scale benchmark.
- failure rate <= 1% over controlled run set.

If unstable/noisy/too high:
- **NO-GO for activation**.

## 6) Required PR12 Artifacts
- Single plan+results report:
  - `docs/PARI_MUTUEL_IMPL_PR12_ZK_VERIFIER_FEASIBILITY_PLAN.md` (this doc, then append measured outcomes in execution phase)
- Measurement artifacts:
  - `reports/protocol-gate/zk-fast-path-cu-*.json`
  - `reports/protocol-gate/zk-prover-latency-*.json`
  - `reports/protocol-gate/zk-fast-path-failure-taxonomy-*.json`
- Invariant trace updates:
  - `docs/PARI_MUTUEL_PHASE2_INVARIANT_MATRIX.md`

## 7) Failure Taxonomy Expectations
Minimum categories to capture:
- `PROVER_UNAVAILABLE`
- `PROVER_TIMEOUT`
- `PROOF_INVALID`
- `PUBLIC_INPUT_MISMATCH`
- `VERIFIER_CU_EXCEEDED`
- `RPC_SIMULATION_FAILURE`
- `RUNTIME_VERIFIER_UNSUPPORTED`

Each category must include retry guidance and whether state remains unchanged (required for no-dead-end property).

## 8) Explicit No-Go Policy
If any stop gate fails:
- Do not activate fast path.
- Do not change economics.
- Keep batch fallback as liveness-only safety path.
- Publish failure findings and recommended next branch (optimize circuit/verifier or choose alternate proving stack).

## 9) Decision Output Required at End of PR12
Single clear conclusion:
- `GO (prototype-continue only)` or
- `NO-GO (stop at report; no activation path)`

No ambiguous “partial go” for activation.
