# OpenJack Repository Structure

## Top-level layout

```text
OpenJack/
  apps/
    web/
  docs/
    ANCHOR_IDL_SPEC.md
    MILESTONES.md
    REPO_STRUCTURE.md
  infra/
  packages/
    idl/
    shared/
  programs/
    openjack/
      src/
  services/
    api/
    scanner/
```

## Directory responsibilities

- `programs/openjack`
  - Anchor/Rust on-chain program.
  - Contains account types, instructions, events, errors, and invariants.

- `packages/idl`
  - Canonical IDL JSON and generated TS client bindings.
  - IDL versioning and changelog.

- `packages/shared`
  - Shared constants and deterministic logic reused across scanner/API/frontend.
  - Tier classifier, split math, serialization schemas.

- `services/scanner`
  - Official scanner and publisher.
  - Dual ingestion, reconciliation, winner computation, Merkle root publication.

- `services/api`
  - Thin read API for active rounds, pots, roots, and claimability hints.

- `apps/web`
  - Seeker-first UX: buy, draw, settle status, and claims.

- `infra`
  - Docker, deployment manifests, monitoring, alerting, and runbooks.

- `docs`
  - Product and protocol specs, milestone plans, threat model, and ops guides.

## Suggested next files

- `programs/openjack/src/lib.rs`
- `programs/openjack/src/state.rs`
- `programs/openjack/src/instructions/*.rs`
- `packages/shared/src/constants.ts`
- `packages/shared/src/tier.ts`
- `services/scanner/src/index.ts`
- `services/api/src/server.ts`
- `apps/web/src/main.tsx`
