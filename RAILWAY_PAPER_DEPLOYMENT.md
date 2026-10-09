## Current operating model (v10)

GitHub = source control/CI; Railway = paper runtime; Windows 4GB PC = development/dashboard/MEGA archive agent; MEGA = backup/archive only. Heavy ML/WFO/Monte Carlo stays off the 4GB PC.

# Railway Paper Deployment — Safe First Run

## Purpose

This deployment profile is intentionally **PAPER ONLY**. It uses public Binance market data and the local paper executor. It must not be used as a live-money environment.

The backend is designed to run as one Railway service from `bot/backend` using the included Dockerfile. Railway injects `PORT`; the application listens on it and exposes `/health`, `/ready`, and `/liveness`.

## Railway settings

Create a new project and add the GitHub repository.

Set the service **Root Directory** to:

```text
/bot/backend
```

Railway will detect the `Dockerfile` in that directory. This is the most reliable configuration for the current repository. Railway's Dockerfile builder expects the Dockerfile in the service source root. See Railway's Dockerfile documentation for the root-directory behavior.

Set the healthcheck path to:

```text
/ready
```

Use a healthcheck timeout of at least 180 seconds.

Keep the service at **1 replica**. Do not enable horizontal scaling for the trading core.

For Trial/Free accounts, Railway's restart policy is limited; use the platform default `On Failure` while testing. Railway documents that `Always` is not available on Trial/Free.

## Required Railway variables

Copy the values from:

```text
bot/backend/.env.railway-paper.example
```

into Railway > Service > Variables.

You must replace:

```text
DASHBOARD_PASSWORD
SESSION_SECRET
```

with unique random secrets. Use at least 12 characters for the dashboard password and at least 32 characters for the session secret.

If you use the Windows PowerShell MEGA backup agent, generate a separate random `BACKUP_API_TOKEN` with at least 32 characters and set the same secret in both Railway service variables and `pipeline/.env` on Windows. The Windows script intentionally refuses to run if that token is missing. Do not commit either copy.

Do not add Binance API keys to this paper profile.

## Persistent volume

Add a Railway volume mounted at:

```text
/app/data
```

The database and local backups are stored below that directory.

This preserves Paper state across ordinary restarts/redeploys. Trial stateful volumes have a limited lifecycle, so this is suitable for the trial/paper phase, not as the final disaster-recovery design.

## Safety gates built into the application

The `railway-paper` profile refuses to start unless:

- `MODE=paper`
- `DATA_SOURCE=binance`
- all symbols are Binance quote symbols (`USDT`, `USDC`, `BUSD`)
- `ML_ENABLED` is not `true`
- `ML_AUTO_TRAIN_ENABLED` is not `true`
- `AUTO_WFO_ENABLED` is not `true`
- `S3_BACKUP_ENABLED` is not `true`

The engine also refuses to become Ready when no valid market symbols are available.

## First deployment sequence

1. Push the audited project to GitHub.
2. In Railway, create a new project from the repository.
3. Set Root Directory to `/bot/backend`.
4. Add the volume at `/app/data`.
5. Add the variables from `.env.railway-paper.example`.
6. Set healthcheck path to `/ready`.
7. Keep replicas at 1.
8. Deploy.
9. Wait for the deployment to report healthy.
10. Open `/health` and `/ready`.
11. Verify `mode=paper` and `ready=true`.
12. Open `/api/auth/login` and authenticate with the dashboard password.
13. Do not add live broker credentials.

## What to verify in logs

A correct first boot should show, in order:

```text
Database ready
Running startup reconciliation...
TradingEngine started
Valid symbols: BTCUSDT, ETHUSDT
API listening on Railway PORT
```

A safe failure should stop the deployment rather than silently trade:

```text
NO valid symbols
ML/training configuration forbidden by railway-paper profile
unresolved execution ledger entries
```

## Optional local dashboard

Keep the 4GB PC lightweight by running the React dashboard locally and pointing it at the Railway backend. Copy `bot/frontend/.env.railway-backend.example` to `bot/frontend/.env.local` and set `VITE_API_URL` to the public Railway backend URL. Keep `CORS_ORIGIN=http://localhost:3000` in the Railway service for this setup.

## Validation status and release gates

A healthy Railway deployment proves only process and readiness health; it does not prove profitability, economic edge, or production readiness.

At the current development checkpoint, full TypeScript checks, the complete backend test suite, frontend build, Docker build, and broker end-to-end tests have **not** been executed from a complete local checkout. The repository has cost-model and exposure/leverage controls in source, but they still need executable regression evidence and configuration-specific review.

Before calling the project complete for a paper release:

- Run backend `npm run typecheck`, backend `npm test`, and backend `npm run build` from a clean lockfile install.
- Run frontend `npm ci` and `npm run build`.
- Build both Docker images and verify runtime health/readiness, persistent-volume behavior, restart recovery, and backup restore.
- Exercise the public market-data path and dashboard login in a separate local/staging environment.
- Verify any S3 backup profile against the actual target service, including encryption, SigV4 authorization, restore integrity, and retention. The local test suite is not a substitute for this.
- Keep broker execution disabled until controlled Binance Futures Testnet tests cover entry, partial/full close, SL/TP placement/replacement, unknown outcomes, and restart reconciliation.

Production/live-money release remains a separate gate requiring paper soak, Testnet evidence, OOS/WFO/Monte Carlo/stress testing, cost/slippage calibration, recovery drills, and review of broker accounting. A clean build or healthy service is not proof of profitability.
