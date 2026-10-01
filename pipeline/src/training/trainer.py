"""
training/trainer.py — Model Training Orchestrator
==================================================
Handles the complete training workflow:

  1. Load labeled data from data/labels/
  2. Time-based train/val/test split (NO shuffling)
  3. Walk-Forward Cross-Validation (anti-overfitting)
  4. Train Ensemble (XGBoost + LSTM)
  5. Evaluate on held-out test set
  6. Save model + training report
  7. Export to ONNX for production serving
"""
import json
import time
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional, List, Dict
from dataclasses import dataclass, field, asdict
from datetime import datetime

from src.models.base_model    import BaseModel, TrainResult, FEATURE_COLS, MODEL_DIR
from src.models.ensemble_model import EnsembleModel
from src.models.xgboost_model  import XGBoostModel
from src.labeling.labeler      import DataLabeler
from src.utils.logger          import get_logger

logger = get_logger("Trainer")

LABEL_DIR = Path("data/labels")


@dataclass
class WalkForwardFold:
    fold:         int
    train_start:  str
    train_end:    str
    val_start:    str
    val_end:      str
    accuracy:     float
    f1_buy:       float
    f1_sell:      float


@dataclass
class TrainingReport:
    symbol:             str
    timeframe:          str
    model_name:         str
    total_samples:      int
    train_samples:      int
    val_samples:        int
    test_samples:       int
    test_accuracy:      float
    test_f1_buy:        float
    test_f1_sell:       float
    test_f1_hold:       float
    wf_folds:           List[WalkForwardFold] = field(default_factory=list)
    wf_mean_accuracy:   float = 0.0
    wf_std_accuracy:    float = 0.0
    feature_importance: dict  = field(default_factory=dict)
    trained_at:         str   = field(default_factory=lambda: datetime.utcnow().isoformat())
    elapsed_sec:        float = 0.0
    model_path:         str   = ""
    recommendation:     str   = ""     # DEPLOY | CAUTION | DO_NOT_DEPLOY

    def to_json(self, path: Path) -> None:
        with open(path, "w") as f:
            json.dump(asdict(self), f, indent=2, default=str)


class ModelTrainer:
    """
    Trains and evaluates trading AI models with rigorous anti-overfitting.
    """

    def __init__(
        self,
        n_wf_folds:       int   = 5,     # walk-forward folds
        wf_train_pct:     float = 0.70,  # % of each fold for training
        min_test_accuracy:float = 0.52,  # minimum accuracy to recommend deployment
        use_lstm:         bool  = False,  # set True if TF/PyTorch available
    ):
        self.n_wf_folds        = n_wf_folds
        self.wf_train_pct      = wf_train_pct
        self.min_test_accuracy = min_test_accuracy
        self.use_lstm          = use_lstm
        self.labeler           = DataLabeler()

    # ─── Main entry ──────────────────────────────────────────────────────────

    def train(
        self,
        symbol:    str,
        timeframe: str,
        market:    str = "binance",
        model_type:str = "ensemble",   # "xgboost" | "ensemble"
    ) -> TrainingReport:
        """
        Full training pipeline for one symbol/timeframe.
        """
        t0 = time.time()
        logger.info(
            f"\n{'═'*55}\n"
            f"  Training: {market}/{symbol}/{timeframe} | {model_type}\n"
            f"{'═'*55}"
        )

        # ── 1. Load data ──────────────────────────────────────────────────
        df = self._load_labeled(market, symbol, timeframe)
        if df is None or len(df) < 500:
            raise ValueError(
                f"Insufficient labeled data for {symbol}/{timeframe} "
                f"({len(df) if df is not None else 0} rows)"
            )

        logger.info(f"  Loaded {len(df):,} labeled samples")
        self._log_class_distribution(df, symbol)

        # ── 2. Walk-Forward Cross-Validation ──────────────────────────────
        logger.info(f"  Running {self.n_wf_folds}-fold Walk-Forward CV...")
        wf_folds = self._walk_forward_cv(df, symbol, timeframe, model_type)

        wf_accs          = [f.accuracy for f in wf_folds]
        wf_mean_accuracy = float(np.mean(wf_accs))
        wf_std_accuracy  = float(np.std(wf_accs))

        logger.info(
            f"  Walk-Forward: mean_acc={wf_mean_accuracy:.3f} "
            f"± {wf_std_accuracy:.3f} "
            f"(folds: {[f'{a:.3f}' for a in wf_accs]})"
        )

        # ── 3. Final train on 85%, test on last 15% ───────────────────────
        train_df, val_df, test_df = self.labeler.train_val_test_split(
            df, train_pct=0.70, val_pct=0.15, test_pct=0.15
        )

        X_train, y_train = BaseModel.prepare_xy(train_df)
        X_val,   y_val   = BaseModel.prepare_xy(val_df)
        X_test,  y_test  = BaseModel.prepare_xy(test_df)

        # ── 4. Build and train model ──────────────────────────────────────
        if model_type == "xgboost":
            model = XGBoostModel(symbol, timeframe)
        else:
            model = EnsembleModel(symbol, timeframe, use_lstm=self.use_lstm)

        result = model.train(X_train, y_train, X_val, y_val)

        # ── 5. Test set evaluation ────────────────────────────────────────
        test_metrics = model.evaluate(X_test, y_test)

        logger.info(
            f"  TEST: acc={test_metrics['accuracy']:.3f} | "
            f"F1-BUY={test_metrics['f1'].get('1',0):.3f} | "
            f"F1-SELL={test_metrics['f1'].get('-1',0):.3f} | "
            f"F1-HOLD={test_metrics['f1'].get('0',0):.3f}"
        )

        # ── 6. Deployment recommendation ──────────────────────────────────
        recommendation = self._recommend(
            test_metrics["accuracy"],
            wf_mean_accuracy,
            wf_std_accuracy,
        )
        logger.info(f"  Recommendation: {recommendation}")

        # ── 7. Build report ───────────────────────────────────────────────
        report = TrainingReport(
            symbol         = symbol,
            timeframe      = timeframe,
            model_name     = model_type,
            total_samples  = len(df),
            train_samples  = len(X_train),
            val_samples    = len(X_val),
            test_samples   = len(X_test),
            test_accuracy  = test_metrics["accuracy"],
            test_f1_buy    = test_metrics["f1"].get("1",  0.0),
            test_f1_sell   = test_metrics["f1"].get("-1", 0.0),
            test_f1_hold   = test_metrics["f1"].get("0",  0.0),
            wf_folds       = wf_folds,
            wf_mean_accuracy = wf_mean_accuracy,
            wf_std_accuracy  = wf_std_accuracy,
            feature_importance = result.feature_importance,
            elapsed_sec    = round(time.time() - t0, 1),
            model_path     = result.model_path,
            recommendation = recommendation,
        )

        # Save report
        report_path = MODEL_DIR / model_type / symbol / timeframe / "training_report.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report.to_json(report_path)
        logger.info(f"  Report saved: {report_path}")

        return report

    def train_all(
        self,
        market:    str = "binance",
        symbols:   Optional[List[str]] = None,
        timeframes:Optional[List[str]] = None,
        model_type:str = "xgboost",
    ) -> Dict[str, TrainingReport]:
        """Train models for multiple symbols/timeframes."""
        syms = symbols   or self._discover_symbols(market)
        tfs  = timeframes or ["1h", "4h"]

        results = {}
        for sym in syms:
            for tf in tfs:
                key = f"{sym}/{tf}"
                try:
                    report = self.train(sym, tf, market, model_type)
                    results[key] = report
                    logger.info(
                        f"  ✅ {key}: {report.recommendation} "
                        f"(acc={report.test_accuracy:.3f})"
                    )
                except Exception as e:
                    logger.error(f"  ❌ {key}: {e}")

        self._print_summary(results)
        return results

    # ─── Walk-Forward CV ─────────────────────────────────────────────────────

    def _walk_forward_cv(
        self,
        df:        pd.DataFrame,
        symbol:    str,
        timeframe: str,
        model_type:str,
    ) -> List[WalkForwardFold]:
        """
        Expanding window walk-forward cross-validation.
        Each fold trains on more data, validates on next block.
        NEVER uses future data for training.
        """
        n     = len(df)
        folds = []
        block = n // (self.n_wf_folds + 1)

        for fold in range(self.n_wf_folds):
            # Expanding train window
            train_end   = block * (fold + 1)
            val_start   = train_end
            val_end     = min(val_start + block, n)

            purge=self.labeler.cfg.forward_bars
            if train_end-purge < 200 or val_end-val_start-purge < 50:
                continue

            train_end_clean=max(0,train_end-purge)
            val_start_clean=min(n,val_start+purge)
            train_df=df.iloc[:train_end_clean]
            val_df=df.iloc[val_start_clean:val_end]

            X_tr, y_tr = BaseModel.prepare_xy(train_df)
            X_vl, y_vl = BaseModel.prepare_xy(val_df)

            try:
                # Use lightweight XGBoost for CV (fast)
                cv_model = XGBoostModel(symbol, f"{timeframe}_cv{fold}")
                cv_model.params["n_estimators"] = 200   # faster for CV
                cv_result = cv_model.train(X_tr, y_tr, X_vl, y_vl)

                folds.append(WalkForwardFold(
                    fold       = fold + 1,
                    train_start= df["time"].iloc[0] if "time" in df.columns else "",
                    train_end  = df["time"].iloc[train_end_clean - 1] if "time" in df.columns else "",
                    val_start  = df["time"].iloc[val_start_clean] if "time" in df.columns else "",
                    val_end    = df["time"].iloc[val_end - 1] if "time" in df.columns else "",
                    accuracy   = cv_result.accuracy,
                    f1_buy     = float(cv_result.f1.get("1", 0)),
                    f1_sell    = float(cv_result.f1.get("-1", 0)),
                ))

                logger.debug(
                    f"    Fold {fold+1}: "
                    f"train=[0..{train_end}] val=[{val_start}..{val_end}] "
                    f"acc={cv_result.accuracy:.3f}"
                )

            except Exception as e:
                logger.warning(f"    Fold {fold+1} failed: {e}")

        return folds

    # ─── Deployment recommendation ────────────────────────────────────────────

    def _recommend(
        self,
        test_acc:    float,
        wf_mean:     float,
        wf_std:      float,
    ) -> str:
        """
        Deployment decision based only on WFO/OOS evidence.

        ``test_acc`` is intentionally accepted for API/report compatibility,
        but it must never influence deployment selection. The final test set
        remains report-only so repeated training decisions cannot optimize
        against the held-out test sample.
        """
        _ = test_acc  # report-only; do not use held-out test data for selection
        if wf_mean >= 0.53 and wf_std <= 0.06:
            return "DEPLOY ✅"
        elif wf_mean >= 0.51:
            return "CAUTION ⚠️ — paper trade first"
        else:
            return "DO_NOT_DEPLOY ❌ — collect more data"

    # ─── Helpers ──────────────────────────────────────────────────────────────

    def _load_labeled(
        self, market: str, symbol: str, timeframe: str
    ) -> Optional[pd.DataFrame]:
        path = LABEL_DIR / market / symbol / timeframe / "labeled.parquet"
        if not path.exists():
            logger.warning(f"No labeled data at {path}")
            return None
        df = pd.read_parquet(path, engine="pyarrow")
        df = df.dropna(subset=["label"]).reset_index(drop=True)
        return df

    def _log_class_distribution(self, df: pd.DataFrame, symbol: str) -> None:
        dist = df["label"].value_counts(normalize=True).sort_index()
        logger.info(
            f"  Class distribution: "
            + " | ".join(
                f"{'BUY' if k==1 else 'SELL' if k==-1 else 'HOLD'}={v:.1%}"
                for k, v in dist.items()
            )
        )

    def _discover_symbols(self, market: str) -> List[str]:
        base = LABEL_DIR / market
        if not base.exists():
            return []
        return [d.name for d in base.iterdir() if d.is_dir()]

    def _print_summary(self, results: Dict[str, TrainingReport]) -> None:
        logger.info(f"\n{'═'*55}\n  TRAINING SUMMARY\n{'═'*55}")
        for key, report in results.items():
            logger.info(
                f"  {key:20} | acc={report.test_accuracy:.3f} "
                f"| WF={report.wf_mean_accuracy:.3f}±{report.wf_std_accuracy:.3f} "
                f"| {report.recommendation}"
            )
        logger.info("═"*55)
