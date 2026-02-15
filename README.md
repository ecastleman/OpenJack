# OpenJack

**OpenJack is a fully on-chain lottery protocol built on Solana with cryptographic settlement guarantees.**
Tickets are issued as compressed NFTs (cNFTs), enabling scalable ownership tracking and wallet-native ticket management. After each round, winners are computed off-chain and a Merkle root of payouts is committed on-chain. Claims require both valid cNFT ownership and a verified Merkle proof, ensuring payouts are enforced by the program itself. The stack includes an Anchor-based program, a Postgres-backed API, a dual-ingestion scanner, and a React frontend with real devnet transaction flows.

## Workspace

- `programs/openjack`: Anchor on-chain program
- `packages/idl`: IDL artifacts and generated client types
- `services/scanner`: Official scanner/indexer publisher
- `services/api`: Thin backend API
- `apps/web`: Seeker-optimized frontend
- `packages/shared`: Shared constants, schemas, tier math
- `infra`: Deployment and ops configuration
- `docs`: Specifications, milestones, runbooks

See:
- `docs/REPO_STRUCTURE.md`
- `docs/ANCHOR_IDL_SPEC.md`
- `docs/MILESTONES.md`
- `docs/DEPENDENCY_VENDORING.md`
- `docs/M7_INTEGRATION.md`
- `docs/PROFILE_SETUP.md`

## Quick Commands

- `npm run preflight`
- `npm run api`
- `npm run scanner`
- `npm run web`
- `npm run e2e:devnet`
- `npm run seeker:smoke`
- `npm run seeker:report`
- `npm run seeker:ready`
- `npm run seeker:beta`
- `npm run seeker:live`
- `npm run keeper`
