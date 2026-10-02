"""
models/base_model.py — Abstract Base Model
==========================================
All trading AI models must inherit from BaseModel.
Enforces a consistent interface for:
  - train()
  - predict()
  - save() / load()
  - evaluate()
  - online_update() (incremental learning)
"""
import json
import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from datetime import datetime

import numpy as np
import pandas as pd

MODEL_DIR = Path("data/models")
MODEL_DIR.mkdir(parents=True, exist_ok=True)

FEATURE_COLS = [
    "ema_50","ema_200","ema_cross","price_vs_ema50","price_vs_ema200","ema_50_slope",
    "rsi_14","rsi_norm","macd","macd_signal","macd_hist","macd_hist_norm",
    "atr_14","atr_pct","volatility_20","bb_width","bb_position",
    "adx_14","plus_di","minus_di","di_diff",
    "vol_ratio","vol_norm",
    "returns_1","returns_5","returns_15",
    "body_ratio","upper_wick","lower_wick","candle_dir",
]

LABEL_COL = "label"  # -1, 0, +1


@dataclass
class TrainResult:
    model_name:    str
    symbol:        str
    timeframe:     str
    train_samples: int
    val_samples:   int
    accuracy:      float
    precision:     Dict[str, float]
    recall:        Dict[str, float]
    f1:            Dict[str, float]
    feature_importance: Dict[str, float]
    trained_at:    str = field(default_factory=lambda: datetime.utcnow().isoformat())
    model_path:    str = ""
    hyperparams:   dict = field(default_factory=dict)

    def __str__(self) -> str:
        return (
            f"{self.model_name} | {self.symbol}/{self.timeframe} | "
            f"acc={self.accuracy:.3f} | "
            f"train={self.train_samples:,} val={self.val_samples:,}"
        )


@dataclass
class PredictResult:
    buy_prob:   float   # probability of +1 (BUY)
    sell_prob:  float   # probability of -1 (SELL)
    hold_prob:  float   # probability of 0  (HOLD)
    label:      int     # argmax: -1, 0, or +1
    confidence: float   # max probability
    model_name: str
    latency_ms: float

    @property
    def signal(self) -> str:
        return {1: "BUY", -1: "SELL", 0: "HOLD"}[self.label]

    def to_dict(self) -> dict:
        return {
            "buy_prob": round(self.buy_prob, 4),
            "sell_prob": round(self.sell_prob, 4),
            "hold_prob": round(self.hold_prob, 4),
            "label": self.label,
            "signal": self.signal,
            "confidence": round(self.confidence, 4),
            "model": self.model_name,
            "latency_ms": round(self.latency_ms, 2),
        }


class BaseModel(ABC):
    """Abstract base for all trading AI models."""

    name: str = "base"

    def __init__(self, symbol: str, timeframe: str):
        self.symbol    = symbol
        self.timeframe = timeframe
        self.model_dir = MODEL_DIR / self.name / symbol / timeframe
        self.model_dir.mkdir(parents=True, exist_ok=True)
        self._model    = None
        self._trained  = False
        self._meta:    dict = {}

    # ─── Abstract interface ───────────────────────────────────────────────────

    @abstractmethod
    def train(self, X_train: np.ndarray, y_train: np.ndarray,
              X_val: np.ndarray, y_val: np.ndarray) -> TrainResult:
        """Train the model. Returns TrainResult with metrics."""

    @abstractmethod
    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """Return (N, 3) probability array: [P(sell), P(hold), P(buy)]."""

    @abstractmethod
    def save(self) -> Path:
        """Persist model to disk. Returns path."""

    @abstractmethod
    def load(self) -> bool:
        """Load model from disk. Returns True if successful."""

    # ─── Shared predict logic ─────────────────────────────────────────────────

    def predict(self, X: np.ndarray) -> PredictResult:
        """Predict class with probabilities and latency."""
        import time
        t0    = time.perf_counter()
        X = np.asarray(X, dtype="float32")
        if X.ndim != 2 or X.shape[1] != len(FEATURE_COLS):
            raise ValueError(
                f"Invalid inference feature shape: {X.shape}; expected (*,{len(FEATURE_COLS)})"
            )
        if not np.isfinite(X).all():
            raise ValueError("Inference feature matrix contains NaN or infinite values")

        proba = self.predict_proba(X)
        ms    = (time.perf_counter() - t0) * 1000

        if proba.ndim == 1:
            proba = proba.reshape(1, -1)

        if (
            proba.shape[0] < 1 or
            proba.shape[1] != 3 or
            not np.isfinite(proba).all() or
            np.any(proba < 0) or
            np.any(proba > 1)
        ):
            raise ValueError("Model returned invalid probability matrix")

        row_sum = float(proba[0].sum())
        if abs(row_sum - 1.0) > 0.02:
            raise ValueError(f"Model probabilities are not normalized: sum={row_sum:.6f}")

        p = proba[0]
        # Order: [P(-1), P(0), P(+1)]
        sell_p, hold_p, buy_p = float(p[0]), float(p[1]), float(p[2])
        idx   = int(np.argmax(p))
        label = [-1, 0, 1][idx]
        conf  = float(np.max(p))

        return PredictResult(
            buy_prob=buy_p, sell_prob=sell_p, hold_prob=hold_p,
            label=label, confidence=conf, model_name=self.name,
            latency_ms=ms,
        )

    def predict_from_df(self, df: pd.DataFrame) -> PredictResult:
        """Predict from a feature DataFrame row."""
        missing = [c for c in FEATURE_COLS if c not in df.columns]
        if missing:
            raise ValueError(f"Missing required inference features: {missing}")
        X = df[FEATURE_COLS].values.astype('float32')
        return self.predict(X)

    # ─── Evaluation ───────────────────────────────────────────────────────────

    def evaluate(self, X: np.ndarray, y: np.ndarray) -> dict:
        """Compute accuracy, precision, recall, F1 per class."""
        from collections import defaultdict

        proba = self.predict_proba(X)
        preds = np.argmax(proba, axis=1) - 1  # back to -1,0,+1

        # Map labels to indices
        classes   = [-1, 0, 1]
        n         = len(y)
        correct   = (preds == y).sum()

        tp = defaultdict(int)
        fp = defaultdict(int)
        fn = defaultdict(int)

        for c in classes:
            tp[c] = int(((preds == c) & (y == c)).sum())
            fp[c] = int(((preds == c) & (y != c)).sum())
            fn[c] = int(((preds != c) & (y == c)).sum())

        def safe_div(a, b): return a / b if b > 0 else 0.0

        precision = {str(c): safe_div(tp[c], tp[c] + fp[c]) for c in classes}
        recall    = {str(c): safe_div(tp[c], tp[c] + fn[c]) for c in classes}
        f1        = {str(c): safe_div(2 * precision[str(c)] * recall[str(c)],
                                      precision[str(c)] + recall[str(c)]) for c in classes}

        return {
            "accuracy":  correct / n,
            "precision": precision,
            "recall":    recall,
            "f1":        f1,
            "n_samples": n,
            "class_dist": {str(c): int((y == c).sum()) for c in classes},
        }

    # ─── Online update (incremental) ─────────────────────────────────────────

    def online_update(self, X: np.ndarray, y: np.ndarray) -> bool:
        """
        Update model with new samples (online learning).
        Override in subclasses that support it.
        Returns True if update was applied.
        """
        return False  # default: not supported

    # ─── Meta / versioning ────────────────────────────────────────────────────

    def save_meta(self, result: TrainResult) -> None:
        meta_path = self.model_dir / "meta.json"
        self._meta = {
            "model":     self.name,
            "symbol":    self.symbol,
            "timeframe": self.timeframe,
            "accuracy":  result.accuracy,
            "f1":        result.f1,
            "trained_at": result.trained_at,
            "train_samples": result.train_samples,
            "feature_cols": FEATURE_COLS,
            "checksum":  self._model_checksum(),
        }
        with open(meta_path, "w") as f:
            json.dump(self._meta, f, indent=2)

    def load_meta(self) -> dict:
        meta_path = self.model_dir / "meta.json"
        if meta_path.exists():
            with open(meta_path) as f:
                self._meta = json.load(f)
        return self._meta

    def validate_loaded_metadata(self) -> bool:
        """
        Verify that a persisted model belongs to this exact model/symbol/timeframe
        and that its feature schema and file checksum are intact.
        """
        try:
            meta = self.load_meta()
            if not isinstance(meta, dict) or not meta:
                return False
            if meta.get("model") != self.name:
                return False
            if str(meta.get("symbol")) != str(self.symbol):
                return False
            if str(meta.get("timeframe")) != str(self.timeframe):
                return False
            feature_cols = meta.get("feature_cols")
            if feature_cols != FEATURE_COLS:
                return False
            expected_checksum = str(meta.get("checksum") or "")
            actual_checksum = self._model_checksum()
            if not expected_checksum or expected_checksum != actual_checksum:
                return False
            return True
        except Exception:
            return False

    def is_trained(self) -> bool:
        return self._trained or (self.model_dir / "meta.json").exists()

    def get_accuracy(self) -> float:
        meta = self.load_meta()
        return meta.get("accuracy", 0.0)

    def _model_checksum(self) -> str:
        model_file = self.model_dir / "model.pkl"
        if not model_file.exists():
            return ""
        h = hashlib.md5()
        with open(model_file, "rb") as f:
            h.update(f.read())
        return h.hexdigest()[:12]

    # ─── Data prep helpers ────────────────────────────────────────────────────

    @staticmethod
    def prepare_xy(
        df: pd.DataFrame,
        feature_cols: Optional[List[str]] = None,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Extract X (features) and y (labels) from labeled DataFrame."""
        cols = feature_cols or FEATURE_COLS
        missing = [c for c in cols if c not in df.columns]
        if missing:
            raise ValueError(f"Missing required training features: {missing}")
        if LABEL_COL not in df.columns:
            raise ValueError(f"Missing required training label: {LABEL_COL}")

        X = df[cols].values.astype("float32")
        y = df[LABEL_COL].values.astype("int32")

        if not np.isfinite(X).all():
            raise ValueError("Training feature matrix contains NaN or infinite values")
        if not np.isin(y, [-1, 0, 1]).all():
            raise ValueError("Training labels must be -1, 0, or 1")

        return X, y
