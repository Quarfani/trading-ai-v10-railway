# ابدأ من هنا — COMPLETE SETUP GUIDE
## Trading AI Complete System v9.0

---

## 📋 Requirements
- Python 3.12
- Node.js 22
- npm 9+
- MT5 terminal (Windows) — only if MODE=mt5

---

## 🚀 Setup in Order

### Terminal 1 — Python ML Server
```bash
cd pipeline
pip install -r requirements.txt

# Full pipeline: download 2yr data + train models (60-90 min first time)
python run_all.py pipeline --market binance --years 2

# Start ML server (keep running)
python run_all.py serve --port 5001
# ✅ http://localhost:5001/health
```

### Terminal 2 — MT5 Bridge (Windows only, skip for paper/binance)
```bash
cd bot
pip install flask MetaTrader5 python-dotenv

# Copy and fill MT5 credentials
cp .env.example .env

# Start bridge (keep running)
python mt5_bridge.py
# ✅ http://127.0.0.1:5000/ping
```

### Terminal 3 — Trading Bot
```bash
cd bot/backend
npm install
cp .env.example .env

# Edit .env:
#   MODE=paper          ← start here always
#   ML_SERVER_URL=http://localhost:5001
#   MT5_BRIDGE_URL=http://127.0.0.1:5000  ← if using MT5

npm run dev
# ✅ API: http://localhost:4000/api/health
```

### Terminal 4 — Dashboard
```bash
cd bot/frontend
npm install
npm run dev
# ✅ Dashboard: http://localhost:3000
```

---

## ⚙️ .env Quick Config

```env
# bot/backend/.env
MODE=paper
ACCOUNT_BALANCE=10000
SYMBOLS=EURUSD,GBPUSD,USDJPY,XAUUSD,BTCUSDT
TIMEFRAMES=H1,H4
ML_SERVER_URL=http://localhost:5001
ML_ENABLED=true
MIN_RR=1.5
MIN_CONFIDENCE=0.60
TELEGRAM_TOKEN=          ← optional but recommended
TELEGRAM_CHAT_ID=        ← optional
```

---

## 🐳 Docker (Easiest)
```bash
# Bot
cd bot && docker compose up -d

# ML Pipeline
cd pipeline && docker compose -f docker-compose.pipeline.yml up -d
```

---

## ✅ Pre-Live Checklist

| Check | Command | Target |
|-------|---------|--------|
| ML health | `curl localhost:5001/health` | `{"ok":true}` |
| Bot health | `curl localhost:4000/api/health` | `{"ok":true}` |
| MT5 bridge | `curl localhost:5000/ping` | `{"ok":true}` |
| Walk-Forward | `npm run wfo EURUSD H1 2000` | TRADE ✅ |
| Paper 2 weeks | Dashboard | Win Rate > 54% |
| Monte Carlo | Telegram `/montecarlo` | P(ruin) < 2% |
| Max Drawdown | Dashboard | < 5% |

---

## 🆘 Common Issues

| Issue | Fix |
|-------|-----|
| `better-sqlite3` error | `cd bot/backend && npm rebuild` |
| ML server not loading | `python run_all.py train` (no data yet) |
| Port 5001 busy | `kill $(lsof -t -i:5001)` |
| No Telegram messages | Add `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` |
| MT5 bridge crash | Install: `pip install MetaTrader5` (Windows only) |
| TypeScript errors | `npm run typecheck` (warnings OK, errors not) |

---

## 📡 API Reference

### ML Server (port 5001)
```
GET  /health        → {"ok": true}
GET  /status        → models loaded + stats
POST /predict       → {"signal":"BUY","confidence":0.72}
GET  /features      → list of 33 features
POST /retrain       → trigger async retraining
POST /record_trade  → online learning update
```

### Bot API (port 4000)
```
GET  /api/status          → full bot status
GET  /api/consensus       → 10 strategy weights
GET  /api/positions       → open trades
GET  /api/recovery        → drawdown level
GET  /api/heatmap         → hourly win rate
GET  /api/journal         → trade journal
POST /api/backtest        → run backtest
POST /api/walkforward     → run WFO
POST /api/montecarlo      → Monte Carlo
POST /api/control/emergency → stop bot
```

---

## 📁 File Map

```
trading-ai-complete/
├── START_HERE.md          ← You are here
├── pipeline/              ← Python AI pipeline
│   ├── run_all.py         ← Master CLI
│   ├── src/models/        ← XGBoost + LSTM + Ensemble
│   ├── src/serving/       ← FastAPI ML server
│   └── tests/             ← 53 tests ✅
└── bot/
    ├── mt5_bridge.py      ← MT5 HTTP bridge
    ├── backend/           ← Node.js + 10 strategies
    └── frontend/          ← React dashboard
```
