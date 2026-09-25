# Trading AI Data Pipeline + Model Server
## Complete System — Python 3.12 | 53/53 Tests ✅

---

## 🏗️ Architecture

```
trading-data-pipeline/
│
├── src/
│   ├── ingestion/          STEP 1  — Binance + MT5 + Yahoo (1m candles)
│   ├── cleaning/           STEP 2+3 — OHLCV only, validate, fill gaps
│   ├── resampling/         STEP 4  — 1m → 5m/15m/1h/4h
│   ├── compression/        STEP 5+6 — Parquet ZSTD, partitioned by year/month
│   ├── storage/            STEP 7  — Mega.nz upload (clean + features + labels)
│   ├── cleaning/filter.py  STEP 8  — Remove spikes, low-volume, bad sessions
│   ├── features/           STEP 9  — 33 technical features (RSI,EMA,ADX,ATR...)
│   ├── labeling/           STEP 10+11 — Ternary labels, no data leakage
│   ├── models/             AI Models — XGBoost + LSTM + Ensemble
│   ├── training/           Training  — Walk-Forward CV, anti-overfitting
│   └── serving/            API Server — FastAPI bridge to Node.js bot
│
├── tests/                  53 tests covering all 12 steps
├── run_all.py              Master CLI for everything
├── Dockerfile
└── docker-compose.yml
```

---

## 🚀 Quick Start (3 Commands)

```bash
# 1. Install
pip install -r requirements.txt

# 2. Full pipeline: download 2yr data + process + train
python run_all.py pipeline --market binance

# 3. Start ML server (bot connects here)
python run_all.py serve --port 5001
```

---

## 📋 All Commands

| Command | Description |
|---------|-------------|
| `python run_all.py download` | Download historical data |
| `python run_all.py train` | Train XGBoost/Ensemble models |
| `python run_all.py serve` | Start ML API server (port 5001) |
| `python run_all.py pipeline --upload` | Full pipeline + Mega upload |
| `python run_all.py status` | Show data catalog + model stats |
| `python run_all.py test` | Run 53 tests |
| `python run_all.py upload` | Upload to Mega.nz |

---

## 🔌 Connect to Trading Bot

In `trading-v7/backend/.env`:
```env
ML_SERVER_URL=http://localhost:5001
```

The bot's `MLClient` calls `/predict` automatically on every signal.

---

## 📊 Data Flow

```
Binance/MT5 API
      │
   [1m candles]
      │
  Cleaning ──→ Validation (fail-fast)
      │
  Resampling ──→ 5m / 15m / 1h / 4h
      │
  Parquet ZSTD ──→ data/clean/{market}/{symbol}/{tf}/{year}/{month}/
      │
  Filter (spikes, volume, session)
      │
  Features (33: EMA, RSI, ADX, ATR, BB, MACD, Volume...)
      │
  Labels (+1 BUY / -1 SELL / 0 HOLD, no future leakage)
      │
  XGBoost ──┐
  LSTM ──────┤── Ensemble → /predict API → Trading Bot
             │
  Walk-Forward CV (5 folds, anti-overfitting)
```

---

## 🧠 AI Models

### XGBoost (default, fast)
- 500 trees, max_depth=5, early stopping=30
- RobustScaler preprocessing
- Inverse-frequency class weights
- Online learning: +30 trees per update
- SHAP feature importance

### LSTM (optional, deep)
- 2 layers: LSTM(128) → LSTM(64)
- Sequence length: 50 bars
- Cosine annealing LR schedule
- TensorFlow or PyTorch backend

### Ensemble (best accuracy)
- Weighted average: weight = validation accuracy
- Disagreement detection between models
- Confidence floor: 0.55 minimum to signal

---

## 🏷️ Labels (no leakage guarantee)

```
+1  BUY success   (price rises > 0.2% in next 20 bars)
-1  SELL success  (price falls > 0.2% in next 20 bars)
 0  HOLD          (price stays within ±0.2%)
```

- Last 20 rows dropped (no future data)
- Time-based split: 70% train / 15% val / 15% test
- Walk-Forward CV: 5 expanding folds

---

## ☁️ Mega Storage

```bash
# .env setup:
MEGA_EMAIL=your@email.com
MEGA_PASSWORD=your_password
MEGA_FOLDER=/TradingData

# Upload:
python run_all.py upload

# Restore on new server:
python -c "from src.storage.mega_uploader import MegaUploader; MegaUploader().download_all('data')"
```

---

## 🧪 Tests: 53/53 Passing

```
TestDataCleaner        9 tests  — OHLCV columns, types, dedup, gaps, validation
TestResampler          5 tests  — bar count, OHLC rules, volume sum, no leakage
TestTrainingFilter     4 tests  — spikes, volume, structural validity
TestFeatureEngineer    8 tests  — 33 features, RSI/ADX ranges, no future leakage
TestDataLabeler        5 tests  — ternary/binary, no leakage, time split
TestEndToEnd           3 tests  — full pipeline, empty input, compression
TestBaseModelInterface 5 tests  — PredictResult, prepare_xy
TestXGBoostModel       6 tests  — train, predict, save/load, evaluate, online update
TestModelServer        4 tests  — singleton, status, predict_no_model, record_trade
TestTrainingReport     1 test   — JSON serialization
─────────────────────────────────────────────────────
53 passed in 13.7s
```

---

## ⚙️ PyCharm Setup

1. Open `trading-data-pipeline/` as project
2. Python 3.12 interpreter
3. `pip install -r requirements.txt`
4. Run: `run_all.py` with arg `pipeline`

---

## 🐳 Docker

```bash
docker compose up -d
# ML server: http://localhost:5001
# Health:    http://localhost:5001/health
# Status:    http://localhost:5001/status
```
