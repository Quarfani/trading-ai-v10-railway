"""
serving/model_server.py — Production Model Server
==================================================
Bridges the trained AI models with the trading bot.

Functions:
  1. load_best_model()    — loads ensemble or best XGBoost
  2. predict_signal()     — converts features → BUY/SELL/HOLD
  3. record_outcome()     — records closed trade for online learning
  4. auto_retrain()       — triggers retraining when model degrades
  5. export_onnx()        — exports model for lightweight serving

This replaces the MLEnhancer's HTTP call with a direct Python call.
"""
import json
import os
import time
import threading
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional, Dict, List
from datetime import datetime

from src.models.base_model     import PredictResult, FEATURE_COLS, MODEL_DIR
from src.models.ensemble_model import EnsembleModel
from src.models.xgboost_model  import XGBoostModel
from src.utils.logger          import get_logger

logger = get_logger("ModelServer")

ONLINE_BUFFER_SIZE  = 50    # collect N samples before online update
DEGRADATION_WINDOW  = 100   # recent trades to monitor accuracy
DEGRADATION_THRESHOLD = 0.48  # below this → trigger retraining
ONLINE_LEARNING_ENABLED = os.getenv('ML_ONLINE_LEARNING_ENABLED', 'false').lower() == 'true'
AUTO_RETRAIN_ENABLED = os.getenv('ML_AUTO_RETRAIN_ENABLED', 'false').lower() == 'true'


class ModelServer:
    """
    Production-ready model server.
    Thread-safe, handles one model per symbol/timeframe.
    """

    def __init__(self, min_confidence: float = 0.55):
        self.min_confidence = min_confidence
        self._models:    Dict[str, EnsembleModel | XGBoostModel] = {}
        self._buffers:   Dict[str, List[dict]] = {}   # online learning buffer
        self._outcomes:  Dict[str, List[dict]] = {}   # trade outcomes
        self._lock       = threading.RLock()
        self._stats:     Dict[str, dict] = {}

    # ─── Load / register ─────────────────────────────────────────────────────

    def load_model(
        self,
        symbol:    str,
        timeframe: str,
        market:    str    = "binance",
        model_type: str   = "ensemble",
    ) -> bool:
        """Load a trained model for serving."""
        key = self._key(symbol, timeframe)

        with self._lock:
            if model_type == "ensemble":
                model = EnsembleModel(symbol, timeframe, use_lstm=False)
            else:
                model = XGBoostModel(symbol, timeframe)

            ok = model.load()
            if ok:
                self._models[key]   = model
                self._buffers[key]  = []
                self._outcomes[key] = []
                self._stats[key]    = {
                    "predictions": 0, "last_accuracy": model.get_accuracy(),
                    "online_updates": 0, "loaded_at": datetime.utcnow().isoformat()
                }
                logger.info(
                    f"Model loaded: {symbol}/{timeframe} ({model_type}) "
                    f"acc={model.get_accuracy():.3f}"
                )
            else:
                logger.warning(
                    f"No saved model for {symbol}/{timeframe} — "
                    f"train first: python -m src.training.run_training"
                )

        return ok

    def load_all(self, market: str = "binance") -> int:
        """Load all available models."""
        n = 0
        for model_dir in MODEL_DIR.glob("*/*/*/"):
            if "meta.json" in [f.name for f in model_dir.iterdir()]:
                parts = model_dir.parts
                if len(parts) >= 3:
                    symbol = parts[-2]
                    tf     = parts[-1]
                    if self.load_model(symbol, tf, market):
                        n += 1
        return n

    # ─── Predict ─────────────────────────────────────────────────────────────

    def predict_signal(
        self,
        symbol:    str,
        timeframe: str,
        features:  pd.DataFrame,
    ) -> Optional[PredictResult]:
        """
        Main prediction entry point for the trading bot.
        Returns None if no model or low confidence.
        """
        key   = self._key(symbol, timeframe)
        model = self._models.get(key)

        if model is None:
            return None

        try:
            # Extract feature vector
            missing = [c for c in FEATURE_COLS if c not in features.columns]
            if missing:
                logger.error(f"Missing required model features for {symbol}/{timeframe}: {missing}")
                return None
            X = features[FEATURE_COLS].values.astype("float32")

            result = model.predict(X)

            probabilities = (
                float(result.buy_prob),
                float(result.sell_prob),
                float(result.hold_prob),
            )
            if (
                not all(np.isfinite(p) and 0.0 <= p <= 1.0 for p in probabilities) or
                not np.isfinite(float(result.confidence)) or
                not 0.0 <= float(result.confidence) <= 1.0 or
                result.label not in (-1, 0, 1)
            ):
                logger.error(
                    f"Predict returned invalid probabilities for {symbol}/{timeframe}"
                )
                return None

            prob_sum = sum(probabilities)
            if abs(prob_sum - 1.0) > 0.02:
                logger.error(
                    f"Predict probabilities are not normalized for {symbol}/{timeframe}: sum={prob_sum:.6f}"
                )
                return None

            # Apply confidence floor
            if result.confidence < self.min_confidence:
                return None

            with self._lock:
                self._stats[key]["predictions"] += 1

            logger.debug(
                f"[{symbol}/{timeframe}] Signal: {result.signal} "
                f"conf={result.confidence:.3f} "
                f"latency={result.latency_ms:.1f}ms"
            )

            return result

        except Exception as e:
            logger.error(f"Predict failed {symbol}/{timeframe}: {e}")
            return None

    # ─── Online learning ──────────────────────────────────────────────────────

    def record_trade_closed(
        self,
        symbol:          str,
        timeframe:       str,
        features:        np.ndarray,   # features at trade entry
        profit:          float,         # actual profit
        signal:          int,           # 1=BUY, -1=SELL that was taken
        prediction_id:   Optional[str] = None,
        predicted_signal: Optional[int] = None,
    ) -> None:
        """
        Record trade outcome for online learning.
        Builds a buffer; triggers update when buffer is full.
        """
        key = self._key(symbol, timeframe)
        if key not in self._buffers:
            return

        arr = np.asarray(features, dtype="float32")
        if arr.ndim != 1 or arr.shape[0] != len(FEATURE_COLS) or not np.isfinite(arr).all():
            logger.error(
                f"Rejected malformed online-learning feature vector for {symbol}/{timeframe}: "
                f"shape={arr.shape}, expected=({len(FEATURE_COLS)},)"
            )
            return

        # Convert profit to label
        profit_value = float(profit)
        if not np.isfinite(profit_value):
            logger.error(f"Rejected non-finite online-learning profit for {symbol}/{timeframe}")
            return

        if signal not in (-1, 0, 1):
            logger.error(f"Rejected invalid online-learning signal for {symbol}/{timeframe}: {signal}")
            return

        if prediction_id is not None:
            prediction_id = str(prediction_id).strip()
            if not prediction_id or len(prediction_id) > 128:
                logger.error(
                    f"Rejected invalid prediction_id for {symbol}/{timeframe}"
                )
                return

        if predicted_signal is not None and predicted_signal not in (-1, 0, 1):
            logger.error(
                f"Rejected invalid predicted_signal for {symbol}/{timeframe}: {predicted_signal}"
            )
            return

        label = self._profit_to_label(profit_value, signal)

        with self._lock:
            self._buffers[key].append({
                "X":     arr,
                "y":     label,
                "profit": profit_value,
                "ts":    time.time(),
            })
            self._outcomes[key].append({
                "prediction_id": prediction_id,
                "predicted_label": predicted_signal,
                "actual_label": label,
                "profit":       profit_value,
                "correct": (
                    predicted_signal == label
                    if predicted_signal is not None
                    else None
                ),
                "ts":           time.time(),
            })

        logger.debug(
            f"[{symbol}] Trade recorded: profit={profit:.2f} → label={label} "
            f"(buffer={len(self._buffers[key])}/{ONLINE_BUFFER_SIZE})"
        )

        # Trigger online update only when explicitly enabled.
        if ONLINE_LEARNING_ENABLED and len(self._buffers[key]) >= ONLINE_BUFFER_SIZE:
            self._trigger_online_update(symbol, timeframe)
        elif not ONLINE_LEARNING_ENABLED:
            logger.debug(f"[{symbol}/{timeframe}] Online learning disabled; buffer retained for audit only")

        # Check for model degradation
        self._check_degradation(symbol, timeframe)

    def record_prediction_outcome(
        self,
        symbol: str,
        timeframe: str,
        prediction_id: str,
        predicted_signal: int,
        actual_label: int,
        profit: float,
    ) -> None:
        """Record a durable prediction outcome without requiring entry features."""
        key = self._key(symbol, timeframe)

        prediction_id = str(prediction_id).strip()
        if not prediction_id or len(prediction_id) > 128:
            logger.error(f"Rejected invalid prediction_id for {symbol}/{timeframe}")
            return

        if predicted_signal not in (-1, 0, 1) or actual_label not in (-1, 0, 1):
            logger.error(
                f"Rejected invalid prediction/actual label for {symbol}/{timeframe}: "
                f"predicted={predicted_signal} actual={actual_label}"
            )
            return

        profit_value = float(profit)
        if not np.isfinite(profit_value):
            logger.error(f"Rejected non-finite prediction outcome profit for {symbol}/{timeframe}")
            return

        with self._lock:
            outcomes = self._outcomes.setdefault(key, [])
            existing = next(
                (
                    item for item in outcomes
                    if item.get("prediction_id") == prediction_id
                ),
                None,
            )

            if existing is not None:
                if (
                    existing.get("predicted_label") != predicted_signal or
                    existing.get("actual_label") != actual_label or
                    abs(float(existing.get("profit", 0.0)) - profit_value) > 1e-12
                ):
                    logger.error(
                        f"Conflicting duplicate prediction outcome rejected: "
                        f"{symbol}/{timeframe}/{prediction_id}"
                    )
                return

            outcomes.append({
                "prediction_id": prediction_id,
                "predicted_label": predicted_signal,
                "actual_label": actual_label,
                "profit": profit_value,
                "correct": predicted_signal == actual_label,
                "ts": time.time(),
            })

        self._check_degradation(symbol, timeframe)

    def _trigger_online_update(self, symbol: str, timeframe: str) -> None:
        """Apply buffered samples to model via incremental learning."""
        key    = self._key(symbol, timeframe)
        model  = self._models.get(key)
        buffer = self._buffers.get(key, [])

        if not buffer or model is None:
            return

        X = np.array([b["X"] for b in buffer], dtype="float32")
        y = np.array([b["y"] for b in buffer], dtype="int32")

        with self._lock:
            ok = model.online_update(X, y)
            if ok:
                self._stats[key]["online_updates"] += 1
                self._buffers[key] = []   # clear buffer
                logger.info(
                    f"[{symbol}/{timeframe}] Online update applied "
                    f"({len(X)} samples)"
                )

    def _check_degradation(self, symbol: str, timeframe: str) -> None:
        """Monitor recent accuracy; trigger retraining if degraded."""
        key      = self._key(symbol, timeframe)
        outcomes = self._outcomes.get(key, [])

        if len(outcomes) < DEGRADATION_WINDOW:
            return

        recent = outcomes[-DEGRADATION_WINDOW:]
        profitable = sum(1 for o in recent if float(o["profit"]) > 0)
        recent_win_rate = profitable / len(recent)
        self._stats[key]["recent_win_rate"] = recent_win_rate

        prediction_outcomes = [
            o for o in recent
            if (
                o.get("prediction_id") and
                o.get("predicted_label") in (-1, 0, 1) and
                o.get("actual_label") in (-1, 0, 1)
            )
        ]

        if len(prediction_outcomes) < DEGRADATION_WINDOW:
            logger.info(
                f"[{symbol}/{timeframe}] Prediction accuracy unavailable: "
                f"{len(prediction_outcomes)}/{DEGRADATION_WINDOW} outcomes carry a "
                "prediction identity"
            )
            self._stats[key]["last_accuracy"] = None
            return

        correct = sum(
            1 for o in prediction_outcomes
            if o.get("correct") is True
        )
        recent_accuracy = correct / len(prediction_outcomes)
        self._stats[key]["last_accuracy"] = recent_accuracy

        logger.info(
            f"[{symbol}/{timeframe}] True model accuracy="
            f"{recent_accuracy:.3f} over {len(prediction_outcomes)} predictions; "
            f"trading win-rate={recent_win_rate:.3f}"
        )

        if recent_accuracy < DEGRADATION_THRESHOLD:
            logger.warning(
                f"[{symbol}/{timeframe}] Model degradation detected: "
                f"accuracy={recent_accuracy:.3f} < threshold={DEGRADATION_THRESHOLD}"
            )
            if AUTO_RETRAIN_ENABLED:
                self._schedule_retrain(symbol, timeframe)

    def _schedule_retrain(self, symbol: str, timeframe: str) -> None:
        """Schedule async retraining (non-blocking)."""
        def _retrain():
            try:
                from src.training.trainer import ModelTrainer
                trainer = ModelTrainer()
                report  = trainer.train(symbol, timeframe)
                if report.recommendation == "DEPLOY ✅":
                    if self.load_model(symbol, timeframe):
                        logger.info(f"[{symbol}/{timeframe}] Retrained and reloaded ✅")
                    else:
                        logger.error(
                            f"[{symbol}/{timeframe}] Retraining produced a deploy recommendation "
                            "but artifact reload failed"
                        )
            except Exception as e:
                logger.error(f"Retraining failed {symbol}/{timeframe}: {e}")

        t = threading.Thread(target=_retrain, daemon=True, name=f"retrain_{symbol}")
        t.start()
        logger.info(f"[{symbol}/{timeframe}] Retraining scheduled in background")

    # ─── ONNX export ─────────────────────────────────────────────────────────

    def export_onnx(self, symbol: str, timeframe: str) -> Optional[Path]:
        """
        Export XGBoost model to ONNX format for lightweight production serving.
        Requires: pip install skl2onnx onnxmltools
        """
        key   = self._key(symbol, timeframe)
        model = self._models.get(key)

        if model is None:
            logger.error(f"No model loaded for {symbol}/{timeframe}")
            return None

        # Get the underlying XGBoost model
        xgb_model = model.xgb._model if hasattr(model, "xgb") else getattr(model, "_model", None)
        if xgb_model is None:
            logger.warning("ONNX export: no XGBoost model found")
            return None

        try:
            from onnxmltools import convert_xgboost
            from onnxconverter_common.data_types import FloatTensorType

            n_features = len(FEATURE_COLS)
            initial_type = [("input", FloatTensorType([None, n_features]))]
            onnx_model   = convert_xgboost(xgb_model, initial_types=initial_type)

            out_path = MODEL_DIR / "onnx" / symbol / f"{timeframe}.onnx"
            out_path.parent.mkdir(parents=True, exist_ok=True)

            with open(out_path, "wb") as f:
                f.write(onnx_model.SerializeToString())

            size_kb = out_path.stat().st_size / 1024
            logger.info(f"ONNX exported: {out_path} ({size_kb:.0f} KB)")
            return out_path

        except ImportError:
            logger.warning("ONNX export requires: pip install onnxmltools onnxruntime")
            return None
        except Exception as e:
            logger.error(f"ONNX export failed: {e}")
            return None

    # ─── Status ──────────────────────────────────────────────────────────────

    def status(self) -> dict:
        """Return current server status for monitoring."""
        return {
            "loaded_models": list(self._models.keys()),
            "stats":         self._stats,
            "buffer_sizes":  {k: len(v) for k, v in self._buffers.items()},
        }

    def get_prediction_stats(self, symbol: str, timeframe: str) -> dict:
        return self._stats.get(self._key(symbol, timeframe), {})

    # ─── Helpers ─────────────────────────────────────────────────────────────

    @staticmethod
    def _key(symbol: str, timeframe: str) -> str:
        return f"{symbol}/{timeframe}"

    @staticmethod
    def _profit_to_label(profit: float, signal: int) -> int:
        """Convert actual trade profit to training label."""
        if profit > 0:
            return signal   # correct direction → keep as +1 or -1
        elif profit < 0:
            return -signal  # wrong direction → flip
        return 0            # breakeven → hold


# ─── Global singleton ─────────────────────────────────────────────────────────

_server: Optional[ModelServer] = None

def get_server(min_confidence: float = 0.55) -> ModelServer:
    """Return the global ModelServer singleton."""
    global _server
    if _server is None:
        _server = ModelServer(min_confidence=min_confidence)
    return _server
