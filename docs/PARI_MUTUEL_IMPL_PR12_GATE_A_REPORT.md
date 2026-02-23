# Pari-Mutuel PR12 Gate A Report

Date: 2026-02-21  
Scope executed: Gate A only (proof system + on-chain verifier primitive feasibility)

## Decision
FAIL

## Stop Condition
Triggered. Per PR12 plan, Gates B/C/D were **not executed**.

## Evidence Artifact
- `reports/protocol-gate/zk-gate-a-feasibility-1771703535854.json`

## Why FAIL
The current toolchain/runtime surface used by this repo exposes:
- ed25519 verifier primitive
- secp256k1 verifier primitive

and does **not** expose a detectable BN254/pairing verifier primitive surface for the planned Groth16-on-chain path in this gate.

Observed in artifact:
- web3 exports: `Ed25519Program`, `Secp256k1Program`
- solana-program module hits: `ed25519_program`, `secp256k1_program`
- no `bn254` / `alt_bn128` / `pairing` signal in checked surfaces

## Consequence
- No activation path discussion.
- Batch remains liveness-only fallback.
- PR12 Gate A ends at report.

## Notes
- This gate evaluated primitive availability for the planned verifier path.
- It did not evaluate alternate architectures (e.g., custom in-program verifier implementation with different cost/risk profile).
