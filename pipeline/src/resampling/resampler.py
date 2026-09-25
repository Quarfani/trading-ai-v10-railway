"""
STEP 4 — Resampler
Aggregates 1-minute OHLCV data into higher timeframes.

Aggregation rules:
  open   → first
  high   → max
  low    → min
  close  → last
  volume → sum

No look-ahead: each bar aggregates only its constituent 1m candles.
"""
import pandas as pd
from pathlib import Path
from typing import Dict, List

from src.config import RESAMPLE_TIMEFRAMES
from src.utils.logger import get_logger

logger = get_logger("Resampler")


class Resampler:
    """
    Resamples 1m OHLCV data to higher timeframes.
    Returns a dict {timeframe: DataFrame}.
    """

    AGG_RULES = {
        "open":   "first",
        "high":   "max",
        "low":    "min",
        "close":  "last",
        "volume": "sum",
    }

    def resample_all(
        self, df_1m: pd.DataFrame, symbol: str
    ) -> Dict[str, pd.DataFrame]:
        """
        Generate all configured higher timeframes from 1m data.
        Input df_1m must have: time (ms int64), open, high, low, close, volume.
        Returns dict: { "5m": df, "15m": df, "1h": df, "4h": df }
        """
        results: Dict[str, pd.DataFrame] = {"1m": df_1m.copy()}

        for tf_name, pd_freq in RESAMPLE_TIMEFRAMES.items():
            try:
                resampled = self._resample_one(df_1m, pd_freq, tf_name, symbol)
                results[tf_name] = resampled
                logger.info(
                    f"  [{symbol}] {tf_name}: {len(resampled):,} bars "
                    f"(from {len(df_1m):,} 1m bars)"
                )
            except Exception as e:
                logger.error(f"  [{symbol}] Failed to resample to {tf_name}: {e}")

        return results

    def _resample_one(
        self,
        df:      pd.DataFrame,
        freq:    str,
        tf_name: str,
        symbol:  str,
    ) -> pd.DataFrame:
        """Resample 1m DataFrame to a higher timeframe."""
        # Convert time (ms) to datetime index
        df = df.copy()
        df.index = pd.to_datetime(df["time"], unit="ms", utc=True)
        df = df[["open", "high", "low", "close", "volume"]]

        # Resample
        resampled = df.resample(freq, closed="left", label="left").agg(self.AGG_RULES)

        # Drop incomplete bars at the end (last bar may be partial)
        resampled = resampled.dropna(subset=["close"])

        # Drop bars with zero volume (usually gaps or bad aggregation)
        before = len(resampled)
        resampled = resampled[resampled["volume"] > 0]
        if len(resampled) < before:
            logger.debug(
                f"  [{symbol}] {tf_name}: dropped "
                f"{before - len(resampled)} zero-volume bars"
            )

        # Convert index back to ms timestamp
        resampled = resampled.reset_index()
        resampled.rename(columns={"index": "datetime"}, inplace=True)

        # Use the left edge of the bar as the time
        time_col = resampled.columns[0]  # first column is datetime
        resampled["time"] = (
            resampled[time_col].astype("int64") // 1_000_000
        ).astype("int64")

        resampled = resampled[["time", "open", "high", "low", "close", "volume"]].copy()

        # Validate output
        assert (resampled["high"] >= resampled["low"]).all(), \
            f"{tf_name}: High < Low after resampling"
        assert resampled["time"].is_monotonic_increasing, \
            f"{tf_name}: Time not monotonic after resampling"

        return resampled.reset_index(drop=True)

    def stats(self, results: Dict[str, pd.DataFrame]) -> dict:
        return {
            tf: {
                "bars": len(df),
                "from": pd.Timestamp(df["time"].iloc[0],  unit="ms").isoformat(),
                "to":   pd.Timestamp(df["time"].iloc[-1], unit="ms").isoformat(),
            }
            for tf, df in results.items()
        }
