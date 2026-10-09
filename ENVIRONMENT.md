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

## Deployment profiles

- `local`: paper mode only; no automatic ML training or WFO.
- `railway-paper`: paper mode with `DATA_SOURCE=binance` and Binance-quoted symbols only; does not require broker API keys.
- `cloud-paper`: paper mode only.
- `cloud-testnet`: `MODE=binance`, `DATA_SOURCE=binance`, `BINANCE_ENV=testnet`, and Binance-quoted symbols only. Use Testnet-only credentials.
- `production`: non-paper mode only. Binance requires mainnet plus `LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_RISK`; MT5 separately requires `MT5_LIVE_TRADING_ACK=I_UNDERSTAND_MT5_LIVE_RISK`.

## Railway Paper Profile

Use `bot/backend/.env.railway-paper.example` for the first Railway deployment. It is deliberately paper-only, low-resource, Binance-market-data-only, and disables automatic ML training and WFO. See `RAILWAY_PAPER_DEPLOYMENT.md` for the exact deployment sequence.
