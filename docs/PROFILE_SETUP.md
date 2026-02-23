# OpenJack Profiles

OpenJack supports two local/devnet operating profiles:

- `dev-fast`: short settlement window (3 minutes) for rapid testing.
- `qa-fast`: short settlement window (120 seconds) for automated protocol gate cycles.
- `prod-like`: standard settlement window (1 hour) for realistic behavior.

Note:
- `qa-fast` currently reuses the `dev-fast` program id feature flag (`dev-fast-program-id`) and is intended for temporary test deployments over the dev-fast program id.

## 1) Configure Profile Program IDs

Edit:

- `config/profiles/dev-fast.env`
- `config/profiles/prod-like.env`

Set:

- `OPENJACK_PROGRAM_ID` for each deployment.

These IDs should be different.

## 2) Build Program Variants

Prod-like build (1h settlement):

```bash
cd "."
npm run build:program:prod-like
```

Dev-fast build (3m settlement):

```bash
cd "."
npm run build:program:dev-fast
```

QA-fast build (20s settlement):

```bash
cd "."
npm run build:program:qa-fast
```

`dev-fast` uses Cargo feature `dev-fast-timers`, which sets:

- `SETTLEMENT_WINDOW_SECS = 180`

`dev-fast` is the default demo/operator convenience profile:

- proof mode defaults to `das`
- gate auto-claim defaults to `false` (explicit in profile env)
- if you enable auto-claim, gate logs a startup warning that estimates will drop after claim execution

`qa-fast` uses Cargo feature `qa-fast-timers`, which sets:

- `SETTLEMENT_WINDOW_SECS = 120`

## 3) Deploy Separate Program IDs

Deploy each built artifact to its own program keypair/program ID using your normal Solana deploy flow.

After deploy, update each profile env file with the correct `OPENJACK_PROGRAM_ID`.

## 4) Run with Profile Wrapper

Run vertical stack:

```bash
npm run vertical:dev-fast
npm run vertical:qa-fast
npm run vertical:prod-like
```

One-command full launch (schema + config sync + create round + vertical):

```bash
export OPENJACK_PROGRAM_ID=<DEV_FAST_PROGRAM_ID>
npm run launch:dev-fast

export OPENJACK_PROGRAM_ID=<QA_FAST_PROGRAM_ID>
npm run launch:qa-fast

# gate mode (API only; recommended for protocol-gate automation)
GATE_MODE=true npm run launch:qa-fast

export OPENJACK_PROGRAM_ID=<PROD_LIKE_PROGRAM_ID>
npm run launch:prod-like
```

Create round:

```bash
npm run round:create-open:dev-fast
npm run round:create-open:qa-fast
npm run round:create-open:prod-like
```

Or run any command under a profile:

```bash
npm run with-profile -- dev-fast npm run seeker:vertical
```

## 5) Important Notes

- `dev-fast` and `prod-like` are intended to stay operationally separate.
- Keep scanner/keeper/API/frontend on the same profile/program ID during a test session.
- Do not reuse `dev-fast` program IDs for production-like validation.

## 6) Frozen Profile Defaults

- `dev-fast`:
  - `OPENJACK_PROOF_MODE=das`
  - `OPENJACK_GATE_SKIP_AUTO_CLAIM=false` (demo mode)
- `qa-fast`:
  - `OPENJACK_PROOF_MODE=off`
  - `OPENJACK_GATE_SKIP_AUTO_CLAIM=true`
- `prod-like`:
  - `OPENJACK_PROOF_MODE=das`
  - `OPENJACK_GATE_SKIP_AUTO_CLAIM=true`

`scripts/with-profile.mjs` and `scripts/protocol-gate.mjs` enforce:

- profile program-id assertions
- proof-mode schema validation (`off|das`)
- runtime profile fingerprint logging
