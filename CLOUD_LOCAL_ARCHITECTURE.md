# Current operating model

## GitHub
Source of truth, reviews, history and CI. GitHub does not run the trading engine.

## Railway
Paper Trading runtime: Node backend + risk/execution/reconciliation + persistent `/app/data` volume. One replica. ML/training/WFO are off.

## Windows 4GB PC
Development, dashboard, monitoring and the MEGA archive agent. The local profile is paper-only and does not run heavy ML.

## MEGA
Long-term archive for snapshots, reports and research datasets. It is never the live database.

## Research workloads
Large backtests, training, WFO and Monte Carlo should be run away from the 4GB PC (cloud/temporary compute when available).
