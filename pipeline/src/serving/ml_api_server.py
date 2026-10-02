"""
serving/ml_api_server.py — FastAPI ML Server
============================================
Bridges Python AI models → Node.js Trading Bot.

The bot's MLClient calls this server at:
  POST /predict     → get BUY/SELL/HOLD probabilities
  GET  /health      → liveness check  (no auth required)
  GET  /params/:sym → get optimized trading params
  POST /retrain     → trigger async retraining
  GET  /status      → all loaded models + stats
  GET  /features    → list feature names

Authentication:
  Set ML_SERVER_API_KEY in your .env.
  Pass it as:  Authorization: Bearer <key>
  /health is intentionally public (used by Docker health checks).

Run:
  python -m src.serving.ml_api_server
  or: uvicorn src.serving.ml_api_server:app --host 0.0.0.0 --port 5001

Install:
  pip install fastapi uvicorn
"""
import asyncio
import os
import threading
import time
import uuid
import numpy as np
import pandas as pd
from pathlib import Path
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone

try:
    from fastapi import FastAPI, HTTPException, Header, Request, Depends
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
    from pydantic import BaseModel as PydanticModel
    import uvicorn
    FASTAPI_AVAILABLE = True
except ImportError:
    FASTAPI_AVAILABLE = False
    # Provide stubs so file is importable without FastAPI
    class FastAPI:
        def __init__(self, **kw): pass
        def get(self, *a, **kw): return lambda f: f
        def post(self, *a, **kw): return lambda f: f
        def add_middleware(self, *a, **kw): pass
    class PydanticModel:
        pass
    def HTTPException(**kw): pass
    def Header(*a, **kw): return None
    def Depends(*a, **kw): return None

from src.serving.model_server import ModelServer, get_server
from src.models.base_model    import FEATURE_COLS
from src.features.feature_engineer import FeatureEngineer
from src.utils.logger         import get_logger

logger = get_logger("MLApiServer")

# ─── API key — FIX: was hardcoded to ""; now reads from env ──────────────────
# Set ML_SERVER_API_KEY in pipeline/.env before starting the server.
_api_key: str = os.getenv("ML_SERVER_API_KEY", "")
_allow_anonymous = os.getenv("ML_SERVER_ALLOW_ANONYMOUS", "false").lower() == "true"
if not _api_key and not _allow_anonymous:
    raise RuntimeError("ML_SERVER_API_KEY must be configured; set ML_SERVER_ALLOW_ANONYMOUS=true only for isolated local testing")

# ─── FastAPI app ──────────────────────────────────────────────────────────────

# FIX: CORS was allow_origins=["*"] — now restricted to localhost only.
# Adjust CORS_ALLOWED_ORIGINS in .env if the bot runs on a different host.
_cors_origins_raw = os.getenv("ML_CORS_ORIGINS", "http://localhost:3000,http://localhost:4000")
_cors_origins = [o.strip() for o in _cors_origins_raw.split(",") if o.strip()]

app = FastAPI(
    title       = "Trading AI Model Server",
    description = "Serves XGBoost/LSTM predictions to Node.js trading bot",
    version     = "1.0.0",
)

if FASTAPI_AVAILABLE:
    app.add_middleware(
        CORSMiddleware,
        allow_origins     = _cors_origins,
        allow_methods     = ["GET", "POST"],
        allow_headers     = ["Authorization", "Content-Type"],
        allow_credentials = False,
    )

# ─── Auth dependency ──────────────────────────────────────────────────────────

_bearer = HTTPBearer(auto_error=False) if FASTAPI_AVAILABLE else None


def require_auth(
    creds: Optional["HTTPAuthorizationCredentials"] = Depends(_bearer) if FASTAPI_AVAILABLE else None,
):
    """
    Dependency that enforces Bearer token auth.
    Skipped (returns None) when ML_SERVER_API_KEY is not configured,
    so development works out of the box with a warning.
    """
    if not _api_key and _allow_anonymous:
        return  # explicit local-development override only
    if creds is None or creds.credentials != _api_key:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


# ─── Global server + feature engineer ────────────────────────────────────────

_server: Optional[ModelServer] = None
_fe = FeatureEngineer()


# ─── Pydantic request/response models ────────────────────────────────────────

class CandleList(PydanticModel):
    symbol:     str
    timeframe:  str
    candles:    List[List[float]]   # [[time, o, h, l, c, v], ...]
    candles_h4: Optional[List[List[float]]] = None


class PredictResponse(PydanticModel):
    symbol:     str
    timeframe:  str
    prediction_id: str
    signal:     str          # BUY | SELL | NO_TRADE
    prob_buy:   float
    prob_sell:  float
    prob_hold:  float
    confidence: float
    has_model:  bool
    latency_ms: float
    model:      str


class RetrainRequest(PydanticModel):
    symbol:    str
    timeframe: str
    market:    str = "binance"


# ─── Startup ──────────────────────────────────────────────────────────────────

_start_time  = time.time()
_total_preds = 0


def _validate_candles(rows: Any) -> tuple[bool, str]:
    if not isinstance(rows, list) or len(rows) < 50:
        return False, "At least 50 OHLCV candles are required"
    previous_time = 0.0
    now_ms = time.time() * 1000.0

    for index, row in enumerate(rows):
        if not isinstance(row, (list, tuple)) or len(row) != 6:
            return False, f"Invalid candle shape at index {index}"

        try:
            t, o, h, low, close, volume = [float(v) for v in row]
        except (TypeError, ValueError):
            return False, f"Non-numeric candle at index {index}"

        if not all(np.isfinite(v) for v in (t, o, h, low, close, volume)):
            return False, f"Non-finite candle at index {index}"
        if t <= 0 or t > now_ms + 5_000:
            return False, f"Invalid/future candle timestamp at index {index}"
        if t <= previous_time:
            return False, f"Candle timestamps must be strictly increasing at index {index}"
        if o <= 0 or h <= 0 or low <= 0 or close <= 0 or volume < 0:
            return False, f"Invalid OHLCV values at index {index}"
        if h < max(o, close) or low > min(o, close) or h < low:
            return False, f"Invalid OHLC geometry at index {index}"

        previous_time = t

    return True, ""


def get_ml_server() -> ModelServer:
    global _server
    if _server is None:
        _server = get_server(min_confidence=0.55)
        n = _server.load_all()
        logger.info(f"ML Server started: {n} models loaded")
    return _server


# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    """Simple service landing endpoint for cloud/container smoke tests."""
    return {
        "service": "trading-ai-ml",
        "ok": True,
        "health": "/health",
        "status": "/status",
        "predict": "/predict",
    }

@app.get("/health")
async def health():
    """Public — no auth required (used by Docker health checks)."""
    return {"ok": True, "ts": datetime.now(timezone.utc).isoformat()}


@app.get("/status", dependencies=[Depends(require_auth)])
async def status():
    server     = get_ml_server()
    srv_status = server.status()
    return {
        "ok":            True,
        "version":       "1.0.0",
        "loaded_models": srv_status["loaded_models"],
        "uptime_sec":    round(time.time() - _start_time, 1),
        "predictions":   _total_preds,
        "stats":         srv_status["stats"],
    }


@app.get("/features", dependencies=[Depends(require_auth)])
async def features():
    return {"features": FEATURE_COLS, "count": len(FEATURE_COLS)}


@app.post("/predict", dependencies=[Depends(require_auth)])
async def predict(body: CandleList):
    global _total_preds
    server = get_ml_server()

    ok, reason = _validate_candles(body.candles)
    if not ok:
        raise HTTPException(status_code=422, detail=reason)

    symbol = str(body.symbol).strip().upper()
    timeframe = str(body.timeframe).strip()
    if not symbol or not timeframe:
        raise HTTPException(status_code=422, detail="symbol and timeframe are required")

    cols   = ["time", "open", "high", "low", "close", "volume"]
    df_raw = pd.DataFrame(body.candles, columns=cols)

    try:
        df_feat = _fe.generate(df_raw, symbol)
    except Exception as e:
        logger.warning(f"Feature generation failed for {body.symbol}: {e}")
        return _no_trade_response(body)

    if df_feat.empty:
        return _no_trade_response(body)

    result = server.predict_signal(symbol, timeframe, df_feat.tail(1))
    _total_preds += 1

    if result is None:
        return _no_trade_response(body)

    signal_str = {1: "BUY", -1: "SELL", 0: "NO_TRADE"}[result.label]
    prediction_id = uuid.uuid4().hex
    return PredictResponse(
        symbol     = body.symbol,
        timeframe  = body.timeframe,
        prediction_id = prediction_id,
        signal     = signal_str,
        prob_buy   = result.buy_prob,
        prob_sell  = result.sell_prob,
        prob_hold  = result.hold_prob,
        confidence = result.confidence,
        has_model  = True,
        latency_ms = result.latency_ms,
        model      = result.model_name,
    )


def _no_trade_response(body: CandleList) -> PredictResponse:
    return PredictResponse(
        symbol    = body.symbol,
        timeframe = body.timeframe,
        prediction_id = "",
        signal    = "NO_TRADE",
        prob_buy  = 0.33, prob_sell = 0.33, prob_hold = 0.34,
        confidence = 0.0, has_model = False, latency_ms = 0.0, model = "none",
    )


@app.get("/params/{symbol}/{timeframe}", dependencies=[Depends(require_auth)])
async def get_params(symbol: str, timeframe: str):
    """Return WFO-optimized params if available."""
    from src.models.base_model import MODEL_DIR
    import json
    report_path = MODEL_DIR / "xgboost" / symbol / timeframe / "training_report.json"
    if report_path.exists():
        with open(report_path) as f:
            r = json.load(f)
        return {
            "symbol":    symbol,
            "timeframe": timeframe,
            "params":    r.get("hyperparams", {}),
            "accuracy":  r.get("test_accuracy", 0),
        }
    return {"symbol": symbol, "timeframe": timeframe, "params": {}, "accuracy": 0}


@app.post("/retrain", dependencies=[Depends(require_auth)])
async def trigger_retrain(body: RetrainRequest):
    """Trigger async model retraining."""
    def _do_retrain():
        try:
            from src.training.trainer import ModelTrainer
            trainer = ModelTrainer()
            report  = trainer.train(body.symbol, body.timeframe, body.market)
            logger.info(
                f"Retrain complete: {body.symbol}/{body.timeframe} "
                f"acc={report.test_accuracy:.3f} → {report.recommendation}"
            )
            server = get_ml_server()
            server.load_model(body.symbol, body.timeframe, body.market)
        except Exception as e:
            logger.error(f"Retrain failed: {e}")

    t = threading.Thread(target=_do_retrain, daemon=True)
    t.start()
    return {
        "ok":      True,
        "message": f"Retraining {body.symbol}/{body.timeframe} started in background",
    }


@app.post("/record_trade", dependencies=[Depends(require_auth)])
async def record_trade(body: dict):
    """Record either a prediction outcome or a feature-backed online-learning sample."""
    server = get_ml_server()
    symbol = str(body.get("symbol", "")).strip().upper()
    timeframe = str(body.get("timeframe", "")).strip()

    try:
        profit = float(body.get("profit"))
        signal = int(body.get("signal"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="profit and signal must be numeric")

    if (
        not symbol or
        not timeframe or
        not np.isfinite(profit) or
        signal not in (-1, 0, 1)
    ):
        raise HTTPException(status_code=422, detail="Invalid record_trade payload")

    prediction_id = body.get("prediction_id")
    if prediction_id is not None:
        prediction_id = str(prediction_id).strip()
        if not prediction_id or len(prediction_id) > 128:
            raise HTTPException(status_code=422, detail="Invalid prediction_id")

    predicted_signal = body.get("predicted_signal")
    if predicted_signal is not None:
        try:
            predicted_signal = int(predicted_signal)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="predicted_signal must be numeric")
        if predicted_signal not in (-1, 0, 1):
            raise HTTPException(status_code=422, detail="Invalid predicted_signal")

    actual_label = body.get("actual_label")
    if actual_label is not None:
        try:
            actual_label = int(actual_label)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="actual_label must be numeric")
        if actual_label not in (-1, 0, 1):
            raise HTTPException(status_code=422, detail="Invalid actual_label")

    if prediction_id and predicted_signal is not None and actual_label is not None:
        recorded = server.record_prediction_outcome(
            symbol=symbol,
            timeframe=timeframe,
            prediction_id=prediction_id,
            predicted_signal=predicted_signal,
            actual_label=actual_label,
            profit=profit,
        )
        if not recorded:
            raise HTTPException(
                status_code=409,
                detail="Conflicting prediction outcome for prediction_id",
            )
        return {"ok": True, "recorded": "prediction_outcome"}

    candles = body.get("entry_candles", [])
    if candles:
        ok, reason = _validate_candles(candles)
        if not ok:
            raise HTTPException(status_code=422, detail=reason)

        cols = ["time", "open", "high", "low", "close", "volume"]
        df_raw = pd.DataFrame(candles, columns=cols)
        try:
            df_feat = _fe.generate(df_raw, symbol)
            if not df_feat.empty:
                missing = [c for c in FEATURE_COLS if c not in df_feat.columns]
                if missing:
                    raise ValueError(f"Missing required model features: {missing}")
                X = df_feat[FEATURE_COLS].values[-1].astype("float32")
                if X.shape != (len(FEATURE_COLS),) or not np.isfinite(X).all():
                    raise ValueError("Entry feature vector is invalid or contains non-finite values")
                server.record_trade_closed(
                    symbol,
                    timeframe,
                    X,
                    profit,
                    signal,
                    prediction_id,
                    predicted_signal,
                )
        except Exception as e:
            logger.warning(f"record_trade feature error: {e}")

    return {"ok": True, "recorded": "trade_outcome"}


# ─── Main ────────────────────────────────────────────────────────────────────

def run_server(host: str = "0.0.0.0", port: int = 5001, workers: int = 1):
    """Start the ML API server."""
    if not FASTAPI_AVAILABLE:
        print("FastAPI not installed. Run: pip install fastapi uvicorn")
        return

    logger.info(f"Starting ML API Server on {host}:{port}")
    logger.info(f"  Auth:  {'enabled' if _api_key else 'DISABLED (set ML_SERVER_API_KEY)'}")
    logger.info(f"  CORS:  {_cors_origins}")
    get_ml_server()   # pre-load models

    uvicorn.run(
        "src.serving.ml_api_server:app",
        host      = host,
        port      = port,
        workers   = workers,
        log_level = "info",
    )


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--host",    default="0.0.0.0")
    parser.add_argument("--port",    type=int, default=5001)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    run_server(args.host, args.port, args.workers)
