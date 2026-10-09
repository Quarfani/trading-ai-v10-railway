# Trading AI v10 — Paper-First Trading Platform

Trading AI contains a TypeScript/Node trading backend, a React/Vite dashboard, a Python data/research pipeline, and an MT5 bridge. The repository is designed to fail closed around uncertain execution outcomes, unverified market data, and risk-control failures.

**Release status: NOT RELEASE-READY for broker Testnet or real-money trading.** The current source branch has not yet passed a clean local TypeScript check, full backend/frontend validation, Docker builds, broker end-to-end tests, and paper recovery drills. Do not treat a healthy process or a successful build as evidence of profitability.

## Safety boundaries

- Start with `MODE=paper`; the local example uses public Binance Spot market data and does not need trading credentials.
- Never place real broker credentials in Git. Put secrets only in the target runtime's secret manager.
- Keep Binance Testnet and mainnet credentials separate.
- Do not use the production profile until the release gate in `PRODUCTION.md` is approved.
- The bot is not guaranteed to be profitable. Strategy promotion requires independent out-of-sample, walk-forward, cost, and stress evidence.

## Repository layout

```text
bot/
  backend/       TypeScript API, trading engine, risk, execution, reconciliation
  frontend/      React/Vite dashboard
  mt5_bridge.py  MT5 bridge and broker-facing integration
pipeline/        Python data ingestion, cleaning, research, and backup tooling
docs/            Architecture, risk, deployment, operations, and recovery notes
```

## Local Paper quick start

Requirements: Node.js 20 or newer and npm 9 or newer. Python dependencies are needed only when using the data/research pipeline.

### 1. Configure the backend

In PowerShell:

```powershell
Set-Location bot/backend
npm ci
Copy-Item .env.example .env
notepad .env
```

Replace `DASHBOARD_PASSWORD` and `SESSION_SECRET` with unique random values. Keep these values out of Git. The example configuration intentionally sets:

```env
DEPLOYMENT_PROFILE=local
MODE=paper
DATA_SOURCE=binance
SYMBOLS=BTCUSDT,ETHUSDT
ML_ENABLED=false
ML_AUTO_TRAIN_ENABLED=false
AUTO_WFO_ENABLED=false
```

It uses public Binance Spot market data, needs no Binance API key, and does not start MT5, ML training, or automatic parameter mutation. Keep `MODE=paper` during initial validation.

Validate the backend before starting it:

```powershell
npm run typecheck
npm test
npm run build
npm run dev
```

### 2. Start the dashboard

Open another PowerShell terminal:

```powershell
Set-Location bot/frontend
npm ci
npm run build
npm run dev
```

Open `http://localhost:3000`. The Vite development proxy forwards API and Socket.IO requests to the backend at `http://localhost:4000`.

## Commands

| Location | Command | Purpose |
| --- | --- | --- |
| `bot/backend` | `npm run typecheck` | TypeScript validation |
| `bot/backend` | `npm test` | Backend unit/integration suite |
| `bot/backend` | `npm run build` | Backend production build |
| `bot/frontend` | `npm run build` | Dashboard typecheck and production build |
| `pipeline` | `python run_all.py --help` | List data/research/backup commands |

Backend and frontend use committed npm lockfiles; use `npm ci` for clean, repeatable dependency installation. The CI workflow is configured for pushes to `main` and pull requests targeting `main`, but a configured workflow must not be confused with a passing run.

## Railway Paper profile

Use `bot/backend/.env.railway-paper.example` and follow `RAILWAY_PAPER_DEPLOYMENT.md`. Keep one backend replica and attach a persistent volume at `/app/data`. Configure the service root as `/bot/backend`, set the healthcheck path to `/ready`, and replace the example password/session secret values.

Do not place Binance order-entry credentials in the Railway Paper service. A successful `/ready` response checks process readiness; it does not verify profitability, broker execution, or disaster recovery.

## Testnet and production

Use `TESTNET.md` only after local typecheck, tests, and builds pass. Testnet checks must include entry, partial/full close, protective-order placement and replacement, uncertain request outcomes, restarts, and reconciliation. Redact API keys, signatures, and account details from logs.

Real-money execution remains blocked until all items in `PRODUCTION.md` are completed, including clean CI/build evidence, realistic costs, authoritative broker accounting, testnet and paper-soak evidence, security review, backup/restore drills, and a rollback procedure.
