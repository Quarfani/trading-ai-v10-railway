"""
models/xgboost_model.py — XGBoost Trading Classifier
======================================================
Why XGBoost first:
  - Handles tabular features better than deep learning
  - Faster training (minutes not hours)
  - Built-in feature importance (SHAP values)
  - Robust to class imbalance via scale_pos_weight
  - Supports incremental learning (partial_fit via warm_start)

Hyperparameter strategy:
  - n_estimators: 500 (enough for convergence)
  - max_depth: 5 (prevents overfitting on financial data)
  - learning_rate: 0.05 (slow learning = better generalization)
  - subsample: 0.8 (row sampling = less overfitting)
  - colsample_bytree: 0.8 (feature sampling)
  - early_stopping: 30 rounds on validation

Class handling (ternary: -1, 0, +1):
  XGBoost multi:softprob → 3 probability outputs
"""
import pickle
import json
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional, Dict

from src.models.base_model import BaseModel, TrainResult, FEATURE_COLS
from src.utils.logger import get_logger

logger = get_logger("XGBoostModel")


class XGBoostModel(BaseModel):
    """
    XGBoost multi-class classifier for BUY/HOLD/SELL prediction.
    Labels: -1=SELL, 0=HOLD, +1=BUY  →  XGB classes: 0,1,2
    """

    name = "xgboost"

    DEFAULT_PARAMS = {
        "n_estimators":     500,
        "max_depth":        5,
        "learning_rate":    0.05,
        "subsample":        0.80,
        "colsample_bytree": 0.80,
        "min_child_weight": 5,
        "gamma":            0.1,
        "reg_alpha":        0.1,
        "reg_lambda":       1.0,
        "objective":        "multi:softprob",
        "num_class":        3,
        "eval_metric":      "mlogloss",
        "random_state":     42,
        "n_jobs":           -1,
        "tree_method":      "hist",  # fast CPU training
    }

    def __init__(self, symbol: str, timeframe: str, params: Optional[dict] = None):
        super().__init__(symbol, timeframe)
        self.params     = {**self.DEFAULT_PARAMS, **(params or {})}
        self._scaler    = None
        self._feat_cols = FEATURE_COLS

    # ─── Train ───────────────────────────────────────────────────────────────

    def train(
        self,
        X_train: np.ndarray, y_train: np.ndarray,
        X_val:   np.ndarray, y_val:   np.ndarray,
    ) -> TrainResult:
        try:
            import xgboost as xgb
        except ImportError:
            raise ImportError("pip install xgboost>=2.0.0")

        logger.info(
            f"[{self.symbol}/{self.timeframe}] Training XGBoost "
            f"({len(X_train):,} train | {len(X_val):,} val)"
        )

        # Map labels -1,0,+1 → 0,1,2 for XGBoost
        y_train_xgb = y_train + 1
        y_val_xgb   = y_val   + 1

        # Normalize features
        from sklearn.preprocessing import RobustScaler
        self._scaler = RobustScaler()
        X_train_s    = self._scaler.fit_transform(X_train)
        X_val_s      = self._scaler.transform(X_val)

        # Compute class weights for imbalanced data
        weights = self._compute_sample_weights(y_train)

        # Build model
        self._model=xgb.XGBClassifier(**self.params,early_stopping_rounds=30)

        self._model.fit(
            X_train_s, y_train_xgb,
            sample_weight      = weights,
            eval_set           = [(X_val_s, y_val_xgb)],
            verbose            = 50,
        )

        self._trained = True

        # Evaluate
        metrics      = self.evaluate(X_val_s, y_val)
        fi           = self._feature_importance()
        best_iter    = self._model.best_iteration

        logger.info(
            f"[{self.symbol}/{self.timeframe}] XGBoost trained: "
            f"acc={metrics['accuracy']:.3f} "
            f"best_iter={best_iter}"
        )

        result = TrainResult(
            model_name    = self.name,
            symbol        = self.symbol,
            timeframe     = self.timeframe,
            train_samples = len(X_train),
            val_samples   = len(X_val),
            accuracy      = metrics["accuracy"],
            precision     = metrics["precision"],
            recall        = metrics["recall"],
            f1            = metrics["f1"],
            feature_importance = fi,
            hyperparams   = {**self.params, "best_iteration": best_iter},
        )

        path = self.save()
        result.model_path = str(path)
        self.save_meta(result)

        return result

    # ─── Predict ─────────────────────────────────────────────────────────────

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """Return (N, 3) array: [P(SELL), P(HOLD), P(BUY)]."""
        if not self._trained and not self.load():
            raise RuntimeError("Model not trained. Call train() first.")

        if self._scaler is not None:
            X = self._scaler.transform(X)

        proba = self._model.predict_proba(X)
        return proba  # already [P(0), P(1), P(2)] = [P(SELL), P(HOLD), P(BUY)]

    # ─── Online update ────────────────────────────────────────────────────────

    def online_update(self,X:np.ndarray,y:np.ndarray)->bool:
        if not self._trained or self._model is None or len(X)<10:return False
        try:
            import xgboost as xgb
            X_s=self._scaler.transform(X) if self._scaler is not None else X
            y_xgb=(y+1).astype('int32'); weights=self._compute_sample_weights(y)
            params={k:v for k,v in self.params.items() if k!='n_estimators'}; params['n_estimators']=25
            updater=xgb.XGBClassifier(**params)
            updater.fit(X_s,y_xgb,sample_weight=weights,xgb_model=self._model.get_booster(),verbose=False)
            self._model=updater; self._trained=True; self.save(); return True
        except Exception as e:
            logger.error(f"Online update failed: {e}"); return False

    # ─── SHAP feature importance ──────────────────────────────────────────────

    def explain(self, X: np.ndarray, n_samples: int = 100) -> pd.DataFrame:
        """
        Compute SHAP values for feature importance explanation.
        Returns DataFrame with mean |SHAP| per feature.
        """
        try:
            import shap
            X_s    = self._scaler.transform(X[:n_samples]) if self._scaler else X[:n_samples]
            explainer = shap.TreeExplainer(self._model)
            shap_v    = explainer.shap_values(X_s)

            if isinstance(shap_v, list):
                # Multi-class: average absolute SHAP across classes
                mean_abs = np.mean([np.abs(sv) for sv in shap_v], axis=0)
            else:
                mean_abs = np.abs(shap_v)

            importance = mean_abs.mean(axis=0)
            df = pd.DataFrame({
                "feature":    self._feat_cols[:len(importance)],
                "shap_mean":  importance,
            }).sort_values("shap_mean", ascending=False)

            return df

        except ImportError:
            logger.warning("shap not installed. pip install shap")
            return pd.DataFrame()

    # ─── Hyperparameter search ────────────────────────────────────────────────

    def hyperparameter_search(
        self,
        X_train: np.ndarray, y_train: np.ndarray,
        X_val:   np.ndarray, y_val:   np.ndarray,
        n_trials: int = 20,
    ) -> dict:
        """
        Optuna-based hyperparameter search.
        Returns best params dict.
        """
        try:
            import optuna
            optuna.logging.set_verbosity(optuna.logging.WARNING)
        except ImportError:
            logger.warning("optuna not installed. pip install optuna")
            return self.params

        import xgboost as xgb
        from sklearn.preprocessing import RobustScaler

        scaler  = RobustScaler()
        X_tr_s  = scaler.fit_transform(X_train)
        X_vl_s  = scaler.transform(X_val)
        y_tr    = y_train + 1
        y_vl    = y_val   + 1

        def objective(trial: optuna.Trial) -> float:
            params = {
                "n_estimators":     trial.suggest_int("n_estimators", 100, 600),
                "max_depth":        trial.suggest_int("max_depth", 3, 7),
                "learning_rate":    trial.suggest_float("lr", 0.01, 0.15, log=True),
                "subsample":        trial.suggest_float("subsample", 0.6, 1.0),
                "colsample_bytree": trial.suggest_float("colsample", 0.5, 1.0),
                "min_child_weight": trial.suggest_int("min_child", 1, 10),
                "gamma":            trial.suggest_float("gamma", 0, 0.5),
                "reg_alpha":        trial.suggest_float("alpha", 0, 1.0),
                "reg_lambda":       trial.suggest_float("lambda", 0.5, 2.0),
                "objective":        "multi:softprob",
                "num_class":        3,
                "eval_metric":      "mlogloss",
                "random_state":     42,
                "tree_method":      "hist",
                "n_jobs":           -1,
            }
            model = xgb.XGBClassifier(**params, early_stopping_rounds=20)
            model.fit(
                X_tr_s, y_tr,
                eval_set=[(X_vl_s, y_vl)],
                verbose=False,
            )
            preds = model.predict(X_vl_s) - 1
            acc   = (preds == y_val).mean()
            return acc

        study = optuna.create_study(direction="maximize")
        study.optimize(objective, n_trials=n_trials, show_progress_bar=True)

        best = study.best_params
        logger.info(f"Best params (acc={study.best_value:.4f}): {best}")
        self.params.update(best)
        return best

    # ─── Save / Load ─────────────────────────────────────────────────────────

    def save(self) -> Path:
        model_path  = self.model_dir / "model.pkl"
        scaler_path = self.model_dir / "scaler.pkl"

        with open(model_path, "wb") as f:
            pickle.dump(self._model, f, protocol=5)
        if self._scaler is not None:
            with open(scaler_path, "wb") as f:
                pickle.dump(self._scaler, f, protocol=5)

        logger.debug(
            f"[{self.symbol}] Model saved: {model_path} "
            f"({model_path.stat().st_size/1e3:.0f} KB)"
        )
        return model_path

    def load(self) -> bool:
        model_path  = self.model_dir / "model.pkl"
        scaler_path = self.model_dir / "scaler.pkl"

        if not model_path.exists():
            return False
        try:
            with open(model_path, "rb") as f:
                self._model = pickle.load(f)
            if scaler_path.exists():
                with open(scaler_path, "rb") as f:
                    self._scaler = pickle.load(f)
            self._trained = True
            return True
        except Exception as e:
            logger.error(f"Failed to load XGBoost model: {e}")
            return False

    # ─── Helpers ──────────────────────────────────────────────────────────────

    def _compute_sample_weights(self, y: np.ndarray) -> np.ndarray:
        """Inverse-frequency weighting for imbalanced classes."""
        classes, counts = np.unique(y, return_counts=True)
        total = len(y)
        class_weight = {c: total / (len(classes) * cnt)
                        for c, cnt in zip(classes, counts)}
        return np.array([class_weight[yi] for yi in y])

    def _feature_importance(self) -> Dict[str, float]:
        if self._model is None:
            return {}
        scores = self._model.feature_importances_
        cols   = self._feat_cols[:len(scores)]
        return dict(sorted(
            zip(cols, scores.tolist()),
            key=lambda x: x[1], reverse=True
        ))
