# Troubleshooting

## `npm ci` / build cannot run

Install dependencies with network access and commit the resulting lockfiles. Do not replace this with `npm install` in production containers.

## Python compression test fails on `pyarrow`

Install the required `pyarrow>=15.0.0` from `pipeline/requirements.txt`, then rerun `pytest -q`.

## Live startup blocks

Inspect the execution ledger, broker connectivity, protective orders, and reconciliation events. A block is intentional when state cannot be proven safe.

## ML unavailable

With `ML_REQUIRED=true`, a missing/unavailable ML service results in NO TRADE. In paper mode, explicit fallback behavior may be configured.
