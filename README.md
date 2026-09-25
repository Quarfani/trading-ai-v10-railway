# Trading AI — Complete System v9.0
## Bot (TypeScript/Node) + Data Pipeline (Python) + AI Models

---

## 📁 Structure

```
trading-ai-complete/
├── pipeline/              ← Python AI Data Pipeline
│   ├── src/
│   │   ├── ingestion/     STEP 1  Binance + MT5 + Yahoo
│   │   ├── cleaning/      STEP 2+3 OHLCV only + validate
│   │   ├── resampling/    STEP 4  1m→5m/15m/1h/4h
│   │   ├── compression/   STEP 5+6 Parquet ZSTD + partition
│   │   ├── storage/       STEP 7  Mega.nz upload
│   │   ├── features/      STEP 9  33 features
│   │   ├── labeling/      STEP 10 Labels, no leakage
│   │   ├── models/        XGBoost + LSTM + Ensemble
│   │   ├── training/      Walk-Forward CV
│   │   └── serving/       FastAPI ML server :5001
│   ├── tests/             53 tests ✅
│   └── run_all.py         Master CLI
│
└── bot/                   ← TypeScript Trading Bot
    ├── backend/            Node.js + 10 strategies + v9 risk
    ├── frontend/           React Dashboard (8 tabs)
    ├── SETUP.md            Full setup guide
    └── docker-compose.yml
```

---

## 🚀 START ORDER

### Step 1 — Python Pipeline
```bash
cd pipeline
pip install -r requirements.txt
python run_all.py pipeline --market binance --years 2
python run_all.py serve --port 5001
```

### Step 2 — Trading Bot
```bash
cd bot/backend
npm install
cp .env.example .env
# Edit .env: ML_SERVER_URL=http://localhost:5001
npm run dev
```

### Step 3 — Dashboard
```bash
cd bot/frontend
npm install
npm run dev
# Open: http://localhost:3000
```

---

## 📋 Key Commands

| Location | Command | Action |
|----------|---------|--------|
| pipeline/ | `python run_all.py download` | Get 2yr data |
| pipeline/ | `python run_all.py train` | Train models |
| pipeline/ | `python run_all.py serve` | Start ML API |
| pipeline/ | `python run_all.py status` | Show data/model status |
| pipeline/ | `python run_all.py test` | 53 tests |
| pipeline/ | `python run_all.py upload` | Mega backup |
| bot/backend/ | `npm run dev` | Start bot |
| bot/backend/ | `npm run wfo EURUSD H1 2000` | Walk-Forward |
| bot/backend/ | `npm run pretrain` | Download + optimize |
| bot/backend/ | `npm test` | Run bot tests |

---

## 🏗️ Complete Architecture

```
Market Data (Binance/MT5)
        │
   [Python Pipeline]
        │
   Clean + Resample + Filter
        │
   33 Features + Labels
        │
   XGBoost/LSTM/Ensemble
        │
   FastAPI ML Server :5001
        │
[Node.js Trading Bot]
        │
   10 Strategies + Consensus
        │
   9 Risk Filters + Recovery
        │
   MT5 / Binance / Paper
        │
  React Dashboard :3000
```

---

## ✅ Test Results
- **Python Pipeline**: 52/53 passing in the audit sandbox; 1 test requires `pyarrow`, which is declared in `pipeline/requirements.txt`.
- **Bot TypeScript**: All modules verified
- **Node.js**: v22 image configured
- **Python**: 3.12 compatible

---

## 📦 ML API Endpoints (port 5001)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness check |
| `/status` | GET | Models + stats |
| `/predict` | POST | BUY/SELL/HOLD signal |
| `/features` | GET | Feature list (33) |
| `/params/{sym}/{tf}` | GET | WFO-optimized params |
| `/retrain` | POST | Async retrain trigger |
| `/record_trade` | POST | Online learning update |


## Cloud Paper Test (Back4App)

For the first cloud test, keep the bot in paper mode and use Binance market data only:

```env
MODE=paper
DATA_SOURCE=binance
SYMBOLS=BTCUSDT
TIMEFRAMES=H1
ML_ENABLED=true
ML_SERVER_URL=https://YOUR-PIPELINE-URL
ML_SERVER_API_KEY=YOUR_SHARED_RANDOM_SECRET
DASHBOARD_PASSWORD=YOUR_STRONG_PASSWORD
SESSION_SECRET=YOUR_LONG_RANDOM_SECRET
BINANCE_ENV=testnet
BINANCE_FUTURES=true
```

Do not put real broker credentials in GitHub. Configure secrets in Back4App environment variables.
