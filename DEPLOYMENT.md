## Current operating model (v10)

GitHub = source control/CI; Railway = paper runtime; Windows 4GB PC = development/dashboard/MEGA archive agent; MEGA = backup/archive only. Heavy ML/WFO/Monte Carlo stays off the 4GB PC.

# Deployment

## Local

Backend requires Node.js >=20. Python pipeline uses the dependencies in `pipeline/requirements.txt`.

## Docker

Backend and frontend both include committed npm lockfiles, and the backend Dockerfile uses `npm ci` when the lockfile is present. This keeps image dependency installation deterministic. CI already typechecks, builds, audits production dependencies, and runs the backend/Python/frontend validation suites.

## Cloud / Back4App

Use the repository Dockerfile as the service build artifact and configure secrets as server-side environment variables. Use a reachable database/storage design rather than assuming local container filesystem durability. The cloud profile should remain `MODE=paper` until the full gate is satisfied.

## Health

- `/health`
- `/ready`
- `/liveness`

Trading must not be enabled before readiness and startup reconciliation have passed.
