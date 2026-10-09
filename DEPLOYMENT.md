# Deployment Guide

## Operating model

- GitHub: version control and configured CI checks.
- Railway: single-replica Paper runtime for the initial deployment.
- Windows development machine: local dashboard/development and optional backup-agent host.
- MEGA/S3-compatible storage: archive and disaster-recovery targets only; never treat the archive as live trading state.

## Local validation

Use Node.js >=20 and npm >=9. Run clean installs from the committed lockfiles:

```powershell
Set-Location bot/backend
npm ci
npm run typecheck
npm test
npm run build
```

Then validate the frontend:

```powershell
Set-Location bot/frontend
npm ci
npm run build
```

Python dependencies are declared in `pipeline/requirements.txt`. Run only the pipeline/research commands you need; model training and walk-forward optimization are disabled by default in lightweight profiles.

## CI

`.github/workflows/ci.yml` is configured for pushes to `main` and pull requests targeting `main`. Its jobs install dependencies from lockfiles, run the Python suite, backend typecheck/build/tests, frontend build, and production dependency audits. This candidate branch has not yet been validated by a completed CI run; configured checks must not be presented as passing checks.

## Docker

Build the backend and frontend images from their respective directories. A clean Docker build is still required before declaring a cloud release. Verify that the image contains no `.env` files, that the service honors the platform-injected port, and that SQLite state is stored on a persistent volume.

## Railway Paper

Use `RAILWAY_PAPER_DEPLOYMENT.md` and `bot/backend/.env.railway-paper.example`. Keep `MODE=paper`, Binance market data, one replica, and a persistent volume at `/app/data`. Do not add real broker order-entry credentials. Configure `/ready` as the healthcheck and observe the deployment reach a successful terminal state before calling it deployed.

## Testnet / Production

See `TESTNET.md` and `PRODUCTION.md`. Live-money trading is blocked until reproducible builds, full test suites, broker accounting/reconciliation, protective-order failure handling, Testnet and Paper soak evidence, backup restore tests, cost/slippage calibration, independent strategy evaluation, security review, and rollback/DR drills pass.
