# OpenJack

OpenJack is a Powerball-inspired lottery dApp on Solana with tradable cNFT tickets, VRF-based draws, SOL/USD oracle pricing, and claim-only payouts after finalization.

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
