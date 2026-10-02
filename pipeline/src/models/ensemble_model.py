"""
models/ensemble_model.py — Ensemble Model (XGBoost + LSTM)
===========================================================
Combines XGBoost and LSTM predictions using confidence-weighted voting.

Strategy:
  1. Run both models on same features
  2. Weight each model's probability by its validation accuracy
  3. Only signal if ensemble confidence > threshold (default 0.60)
  4. Disagreements between models → reduce confidence or HOLD

Benefits vs single model:
  - XGBoost is better at sharp regime changes
  - LSTM is better at trend continuation
  - Ensemble reduces false signals significantly
  - Naturally handles model uncertainty
"""
import json
import pickle
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional, List, Dict

from src.models.base_model import (
    BaseModel, TrainResult, PredictResult, FEATURE_COLS
)
from src.models.xgboost_model import XGBoostModel
from src.models.lstm_model    import LSTMModel
from src.utils.logger         import get_logger

logger = get_logger("EnsembleModel")


class EnsembleModel(BaseModel):
    """
    Weighted ensemble of XGBoost + LSTM.
    Weights are derived from each model's validation accuracy.
    """

    name = "ensemble"

    def __init__(
        self,
        symbol:          str,
        timeframe:       str,
        confidence_min:  float = 0.55,    # minimum confidence to signal
        disagreement_penalty: float = 0.10,  # reduce confidence if models disagree
        use_lstm:        bool = True,      # set False if TF/PyTorch not available
    ):
        super().__init__(symbol, timeframe)
        self.confidence_min       = confidence_min
        self.disagreement_penalty = disagreement_penalty
        self.use_lstm             = use_lstm

        self.xgb  = XGBoostModel(symbol, timeframe)
        self.lstm = LSTMModel(symbol, timeframe) if use_lstm else None

        self._weights: Dict[str, float] = {"xgboost": 1.0, "lstm": 1.0}
        self._trained_models: List[str] = []

    # ─── Train ───────────────────────────────────────────────────────────────

    def train(
        self,
        X_train: np.ndarray, y_train: np.ndarray,
        X_val:   np.ndarray, y_val:   np.ndarray,
    ) -> TrainResult:
        """Train all sub-models and compute ensemble weights."""
        results = {}

        # ── XGBoost (always trained) ──────────────────────────────────────
        logger.info(f"[{self.symbol}] Training XGBoost sub-model...")
        try:
            xgb_result = self.xgb.train(X_train, y_train, X_val, y_val)
            results["xgboost"] = xgb_result
            self._weights["xgboost"] = xgb_result.accuracy
            self._trained_models.append("xgboost")
            logger.info(f"  XGBoost: acc={xgb_result.accuracy:.3f}")
        except Exception as e:
            logger.error(f"XGBoost training failed: {e}")

        # ── LSTM (optional) ───────────────────────────────────────────────
        if self.use_lstm and self.lstm is not None:
            logger.info(f"[{self.symbol}] Training LSTM sub-model...")
            try:
                lstm_result = self.lstm.train(X_train, y_train, X_val, y_val)
                results["lstm"] = lstm_result
                self._weights["lstm"] = lstm_result.accuracy
                self._trained_models.append("lstm")
                logger.info(f"  LSTM: acc={lstm_result.accuracy:.3f}")
            except Exception as e:
                logger.warning(f"LSTM training failed (will use XGBoost only): {e}")

        if not self._trained_models:
            raise RuntimeError("No models trained successfully")

        # ── Normalize weights ─────────────────────────────────────────────
        total_w = sum(self._weights[m] for m in self._trained_models)
        for m in self._trained_models:
            self._weights[m] /= total_w

        # ── Ensemble evaluation ───────────────────────────────────────────
        self._trained = True
        metrics = self.evaluate(X_val, y_val)

        logger.info(
            f"[{self.symbol}] Ensemble: acc={metrics['accuracy']:.3f} "
            f"models={self._trained_models} "
            f"weights={self._weights}"
        )

        # Use best single-model result + ensemble accuracy
        base_result = results.get("xgboost", list(results.values())[0])
        result = TrainResult(
            model_name    = self.name,
            symbol        = self.symbol,
            timeframe     = self.timeframe,
            train_samples = base_result.train_samples,
            val_samples   = base_result.val_samples,
            accuracy      = metrics["accuracy"],
            precision     = metrics["precision"],
            recall        = metrics["recall"],
            f1            = metrics["f1"],
            feature_importance = base_result.feature_importance,
            hyperparams   = {
                "weights":        self._weights,
                "models":         self._trained_models,
                "confidence_min": self.confidence_min,
            },
        )

        path = self.save()
        result.model_path = str(path)
        self.save_meta(result)

        return result

    # ─── Predict ─────────────────────────────────────────────────────────────

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """Weighted average of all sub-model probabilities."""
        if not self._trained and not self.load():
            raise RuntimeError("Ensemble not trained")

        ensemble_proba = np.zeros((len(X) if X.ndim > 1 else 1, 3))

        for model_name in self._trained_models:
            w = self._weights.get(model_name, 0.0)
            if w == 0:
                continue

            successful_weight = 0.0

        for model_name in self._trained_models:
            w = float(self._weights.get(model_name, 0.0))
            if not np.isfinite(w) or w <= 0:
                continue

            try:
                if model_name == "xgboost":
                    proba = self.xgb.predict_proba(X)
                elif model_name == "lstm":
                    proba = self.lstm.predict_proba(X)
                else:
                    continue

                if proba.ndim == 1:
                    proba = proba.reshape(1, -1)
                if len(proba) != len(ensemble_proba):
                    proba = np.tile(proba, (len(ensemble_proba), 1))

                if (
                    proba.shape[1] != 3 or
                    not np.all(np.isfinite(proba)) or
                    np.any(proba < 0) or
                    np.any(proba > 1)
                ):
                    raise ValueError("sub-model returned invalid probabilities")

                row_sums = proba.sum(axis=1, keepdims=True)
                if np.any(np.abs(row_sums - 1.0) > 0.02):
                    raise ValueError("sub-model probabilities are not normalized")

                ensemble_proba += w * proba
                successful_weight += w

            except Exception as e:
                logger.warning(f"Sub-model {model_name} predict failed: {e}")

        if successful_weight <= 0 or not np.isfinite(successful_weight):
            return np.tile(
                np.asarray([0.0, 1.0, 0.0], dtype="float64"),
                (len(ensemble_proba), 1),
            )

        ensemble_proba /= successful_weight
        if (
            not np.all(np.isfinite(ensemble_proba)) or
            np.any(ensemble_proba < 0) or
            np.any(ensemble_proba > 1)
        ):
            return np.tile(
                np.asarray([0.0, 1.0, 0.0], dtype="float64"),
                (len(ensemble_proba), 1),
            )

        return ensemble_proba

    def predict(self, X: np.ndarray) -> PredictResult:
        """
        Enhanced predict with:
          - Disagreement detection between models
          - Confidence floor (min threshold)
          - Returns HOLD if models disagree strongly
        """
        import time
        t0 = time.perf_counter()

        if not self._trained and not self.load():
            raise RuntimeError("Not trained")

        # Get individual model predictions
        model_preds: Dict[str, np.ndarray] = {}
        for model_name in self._trained_models:
            try:
                if model_name == "xgboost":
                    model_preds[model_name] = self.xgb.predict_proba(X)
                elif model_name == "lstm":
                    model_preds[model_name] = self.lstm.predict_proba(X)
            except Exception:
                pass

        # Compute weighted ensemble
        ensemble_p = np.zeros(3)
        for mname, proba in model_preds.items():
            p = proba[0] if proba.ndim > 1 else proba
            ensemble_p += self._weights.get(mname, 0.5) * p

        # Normalize
        total = ensemble_p.sum()
        if total > 0:
            ensemble_p /= total

        sell_p, hold_p, buy_p = float(ensemble_p[0]), float(ensemble_p[1]), float(ensemble_p[2])
        max_idx = int(np.argmax(ensemble_p))
        label   = [-1, 0, 1][max_idx]
        conf    = float(np.max(ensemble_p))

        # ── Disagreement penalty ──────────────────────────────────────────
        if len(model_preds) >= 2:
            labels_each = [
                [-1, 0, 1][int(np.argmax(p[0] if p.ndim > 1 else p))]
                for p in model_preds.values()
            ]
            if len(set(labels_each)) > 1:
                # Models disagree → penalize confidence
                conf -= self.disagreement_penalty
                logger.debug(
                    f"[{self.symbol}] Model disagreement: {dict(zip(model_preds.keys(), labels_each))} "
                    f"→ conf reduced to {conf:.3f}"
                )

        # ── Confidence floor → HOLD ───────────────────────────────────────
        if conf < self.confidence_min:
            label   = 0
            hold_p += (1 - conf)
            conf    = float(ensemble_p[1])  # hold probability

        ms = (time.perf_counter() - t0) * 1000
        return PredictResult(
            buy_prob=buy_p, sell_prob=sell_p, hold_prob=hold_p,
            label=label, confidence=conf, model_name=self.name,
            latency_ms=ms,
        )

    # ─── Online update ────────────────────────────────────────────────────────

    def online_update(self, X: np.ndarray, y: np.ndarray) -> bool:
        """Update all sub-models that support online learning."""
        updated = False
        for model_name in self._trained_models:
            try:
                if model_name == "xgboost":
                    ok = self.xgb.online_update(X, y)
                else:
                    ok = False

                if ok:
                    updated = True
                    # Re-evaluate and update weight
                    new_metrics = self.xgb.evaluate(X, y)
                    self._weights["xgboost"] = max(0.3, new_metrics["accuracy"])
                    # Renormalize
                    total_w = sum(self._weights[m] for m in self._trained_models)
                    for m in self._trained_models:
                        self._weights[m] /= total_w

            except Exception as e:
                logger.warning(f"Online update {model_name}: {e}")

        if updated:
            self.save()
        return updated

    # ─── Save / Load ─────────────────────────────────────────────────────────

    def save(self) -> Path:
        # Save ensemble meta (weights, config)
        meta_path = self.model_dir / "ensemble_config.json"
        with open(meta_path, "w") as f:
            json.dump({
                "weights":              self._weights,
                "trained_models":       self._trained_models,
                "confidence_min":       self.confidence_min,
                "disagreement_penalty": self.disagreement_penalty,
            }, f, indent=2)

        # Sub-models save themselves
        return meta_path

    def load(self) -> bool:
        meta_path = self.model_dir / "ensemble_config.json"
        if not meta_path.exists():
            return False

        with open(meta_path) as f:
            cfg = json.load(f)

        self._weights        = cfg.get("weights", {})
        self._trained_models = cfg.get("trained_models", [])
        self.confidence_min  = cfg.get("confidence_min", 0.55)

        ok = True
        if "xgboost" in self._trained_models:
            ok = ok and self.xgb.load()
        if "lstm" in self._trained_models and self.lstm:
            self.lstm.load()  # non-critical

        self._trained = ok
        return ok

    # ─── Comparison report ────────────────────────────────────────────────────

    def model_comparison(
        self, X_val: np.ndarray, y_val: np.ndarray
    ) -> pd.DataFrame:
        """Compare individual model performance vs ensemble."""
        rows = []
        for model_name in self._trained_models:
            try:
                if model_name == "xgboost":
                    m = self.xgb
                elif model_name == "lstm":
                    m = self.lstm
                else:
                    continue
                met = m.evaluate(X_val, y_val)
                rows.append({
                    "model":    model_name,
                    "weight":   round(self._weights.get(model_name, 0), 4),
                    "accuracy": round(met["accuracy"], 4),
                    "f1_buy":   round(met["f1"].get("1", 0), 4),
                    "f1_sell":  round(met["f1"].get("-1", 0), 4),
                    "f1_hold":  round(met["f1"].get("0", 0), 4),
                })
            except Exception:
                pass

        # Ensemble
        met = self.evaluate(X_val, y_val)
        rows.append({
            "model":    "ENSEMBLE",
            "weight":   1.0,
            "accuracy": round(met["accuracy"], 4),
            "f1_buy":   round(met["f1"].get("1", 0), 4),
            "f1_sell":  round(met["f1"].get("-1", 0), 4),
            "f1_hold":  round(met["f1"].get("0", 0), 4),
        })

        return pd.DataFrame(rows).set_index("model")
