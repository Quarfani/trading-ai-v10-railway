"""
STEP 10 — Data Labeling (STRICT NO DATA LEAKAGE)
==================================================
Creates forward-looking labels for supervised AI training.

Option 1 — Binary:
  1 = profitable trade (future return > threshold)
  0 = losing trade (future return <= threshold)

Option 2 — Ternary (default):
  +1 = BUY success  (price rises > profit_threshold in next N bars)
  -1 = SELL success (price falls > |loss_threshold| in next N bars)
   0 = no trade     (price stays within thresholds)

NO LEAKAGE RULES:
  - Labels look forward ONLY using future closes
  - No indicator values used in label computation
  - Last `forward_bars` rows get NaN labels (no future data)
  - These NaN rows are DROPPED before training

Recommended use:
  - forward_bars = 20  (20-bar horizon)
  - profit_threshold = 0.002  (0.2%)
"""
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional

from src.config import LABEL_CFG, LABEL_DIR, LabelConfig
from src.utils.logger import get_logger

logger = get_logger("Labeler")


class DataLabeler:
    """
    Creates training labels from OHLCV data.
    Uses ONLY future close prices — zero indicator leakage.
    """

    def __init__(self, cfg: LabelConfig = LABEL_CFG):
        self.cfg = cfg

    # ─── Main ────────────────────────────────────────────────────────────────

    def label(
        self,
        df:     pd.DataFrame,
        symbol: str,
        scheme: Optional[str] = None,
    ) -> pd.DataFrame:
        """
        Add label column to df. Returns df with labels.
        Last `forward_bars` rows will have NaN labels — MUST be dropped.

        Args:
            df:     DataFrame with at minimum 'time' and 'close' columns
            symbol: for logging
            scheme: 'binary' or 'ternary' (overrides config)
        """
        scheme = scheme or self.cfg.scheme
        n      = len(df)

        logger.info(
            f"[{symbol}] Labeling {n:,} bars "
            f"(forward={self.cfg.forward_bars}, scheme={scheme})"
        )

        df    = df.copy()
        close = df["close"].values
        fwd   = self.cfg.forward_bars

        # ── FIX: vectorised forward return — was a Python loop (100x slower) ─
        # forward_return[t] = (close[t + N] - close[t]) / close[t]
        # Last `fwd` rows have no future data → NaN.
        forward_return = np.empty(n, dtype="float64")
        forward_return[:] = np.nan

        valid_src = close[:-fwd] > 0          # avoid division by zero
        forward_return[:-fwd] = np.where(
            valid_src,
            (close[fwd:] - close[:-fwd]) / close[:-fwd],
            np.nan,
        )

        df["forward_return"] = forward_return

        # ── Assign labels ─────────────────────────────────────────────────
        if scheme == "binary":
            df["label"] = self._binary_labels(forward_return)
        else:
            df["label"] = self._ternary_labels(forward_return)

        # ── Drop NaN rows (last forward_bars rows + any leakage guard) ────
        n_before = len(df)
        df = df.dropna(subset=["label", "forward_return"]).reset_index(drop=True)
        dropped = n_before - len(df)

        # ── Label distribution stats ───────────────────────────────────────
        dist = df["label"].value_counts(normalize=True).sort_index()
        logger.info(
            f"[{symbol}] Labels: {len(df):,} usable rows "
            f"(dropped {dropped:,} | no-future)"
        )
        for lbl, pct in dist.items():
            logger.info(f"  label {lbl:+.0f}: {pct:.1%}")

        # Warn on extreme imbalance
        if scheme == "binary":
            pos_pct = (df["label"] == 1).mean()
            if pos_pct < 0.30 or pos_pct > 0.70:
                logger.warning(
                    f"[{symbol}] Class imbalance: {pos_pct:.1%} positive "
                    f"— consider resampling or adjusting thresholds"
                )

        return df

    # ─── Label schemes ────────────────────────────────────────────────────────

    def _binary_labels(self, forward_return: np.ndarray) -> pd.Series:
        """
        1 = future return > profit_threshold
        0 = otherwise
        """
        labels = np.where(
            forward_return >  self.cfg.profit_threshold, 1,
            np.where(
                ~np.isnan(forward_return), 0, np.nan
            )
        )
        return pd.Series(labels, dtype="float32")

    def _ternary_labels(self, forward_return: np.ndarray) -> pd.Series:
        """
        +1 = BUY success  (return > profit_threshold)
        -1 = SELL success (return < loss_threshold)
         0 = no trade     (return within thresholds)
        NaN = no future data (last forward_bars rows)
        """
        labels = np.full(len(forward_return), np.nan, dtype="float64")

        valid = ~np.isnan(forward_return)
        labels[valid & (forward_return >  self.cfg.profit_threshold)] =  1.0
        labels[valid & (forward_return <  self.cfg.loss_threshold)]   = -1.0
        labels[valid
               & (forward_return <= self.cfg.profit_threshold)
               & (forward_return >= self.cfg.loss_threshold)]         =  0.0

        return pd.Series(labels, dtype="float32")

    # ─── No-leakage validation ────────────────────────────────────────────────

    def validate_no_leakage(self, df: pd.DataFrame) -> bool:
        """Structural checks only; correlation with labels is not proof of leakage and can reject real alpha."""
        if "time" in df.columns:
            ts=pd.to_datetime(df["time"],errors="coerce")
            if ts.isna().any() or not ts.is_monotonic_increasing or ts.duplicated().any():
                logger.error("Leakage validation failed: timestamps must be valid, ordered and unique")
                return False
        suspicious=[c for c in df.columns if any(k in c.lower() for k in ("future","next_bar","lead"))]
        if suspicious:
            logger.error(f"Leakage validation failed: suspicious columns {suspicious}")
            return False
        logger.info("No-leakage structural validation passed ✓")
        return True

    # ─── Save ────────────────────────────────────────────────────────────────

    def save(
        self, df: pd.DataFrame, market: str, symbol: str, timeframe: str
    ) -> Path:
        """Save labeled DataFrame to Parquet."""
        out_dir  = LABEL_DIR / market / symbol / timeframe
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / "labeled.parquet"

        df.to_parquet(out_path, engine="pyarrow", compression="zstd", index=False)
        size_mb = out_path.stat().st_size / 1e6
        logger.info(
            f"[{market}/{symbol}/{timeframe}] Labels saved: "
            f"{out_path} ({size_mb:.2f} MB)"
        )
        return out_path

    # ─── Dataset split ────────────────────────────────────────────────────────

    def train_val_test_split(self, df:pd.DataFrame, train_pct:float=0.70, val_pct:float=0.15, test_pct:float=0.15, purge_bars:Optional[int]=None, embargo_bars:Optional[int]=None)->tuple:
        if not np.isclose(train_pct+val_pct+test_pct,1.0): raise ValueError("Split percentages must sum to 1")
        n=len(df); purge=self.cfg.forward_bars if purge_bars is None else max(0,int(purge_bars)); embargo=self.cfg.forward_bars if embargo_bars is None else max(0,int(embargo_bars))
        t_end=int(n*train_pct); v_end=int(n*(train_pct+val_pct))
        train_end=max(0,t_end-purge); val_start=min(n,t_end+embargo); val_end=max(val_start,v_end-purge); test_start=min(n,v_end+embargo)
        train=df.iloc[:train_end].reset_index(drop=True); val=df.iloc[val_start:val_end].reset_index(drop=True); test=df.iloc[test_start:].reset_index(drop=True)
        if not train.size or not val.size or not test.size: raise ValueError(f"Purged split empty: train={len(train)} val={len(val)} test={len(test)}")
        logger.info(f"Purged split: train={len(train):,} val={len(val):,} test={len(test):,} purge={purge} embargo={embargo}")
        return train,val,test
