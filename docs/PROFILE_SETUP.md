# OpenJack Profiles

OpenJack supports two local/devnet operating profiles:

- `dev-fast`: short settlement window (3 minutes) for rapid testing.
- `qa-fast`: very short settlement window (20 seconds) for automated protocol gate cycles.
- `prod-like`: standard settlement window (1 hour) for realistic behavior.

Note:
- `qa-fast` currently reuses the `dev-fast` program id feature flag (`dev-fast-program-id`) and is intended for temporary test deployments over the dev-fast program id.

## 1) Configure Profile Program IDs

Edit:

- `/Users/ernesto/Documents/New project/config/profiles/dev-fast.env`
- `/Users/ernesto/Documents/New project/config/profiles/prod-like.env`

Set:

- `OPENJACK_PROGRAM_ID` for each deployment.

These IDs should be different.

## 2) Build Program Variants

Prod-like build (1h settlement):

```bash
cd "/Users/ernesto/Documents/New project"
npm run build:program:prod-like
```

Dev-fast build (3m settlement):

```bash
cd "/Users/ernesto/Documents/New project"
npm run build:program:dev-fast
```

QA-fast build (20s settlement):

```bash
cd "/Users/ernesto/Documents/New project"
npm run build:program:qa-fast
```

`dev-fast` uses Cargo feature `dev-fast-timers`, which sets:

- `SETTLEMENT_WINDOW_SECS = 180`

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
