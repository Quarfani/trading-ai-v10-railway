# Environment

## Core

- Node.js >=20
- npm >=9
- Python dependencies from `pipeline/requirements.txt`
- Docker required for container builds

## Important variables

- `MODE`
- `DATA_SOURCE`
- `API_PORT`
- `SYMBOLS` / `TIMEFRAMES`
- `RISK_PER_TRADE`
- `MAX_DAILY_LOSS`
- `MAX_WEEKLY_LOSS`
- `MAX_DRAWDOWN`
- `MAX_PORTFOLIO_HEAT`
- `MAX_LEVERAGE`
- `MAX_EXPOSURE`
- `MAX_OPEN_TRADES`
- `MIN_CONFIDENCE`
- `MIN_RR`
- `MAX_SLIPPAGE_PIPS`
- `ML_REQUIRED`
- dashboard/operator/session secrets
- broker credentials

Never commit real values. `.env.example` files contain placeholders/defaults only.

## Railway Paper Profile

Use `bot/backend/.env.railway-paper.example` for the first Railway deployment. It is deliberately paper-only, low-resource, Binance-market-data-only, and disables automatic ML training and WFO. See `RAILWAY_PAPER_DEPLOYMENT.md` for the exact deployment sequence.
