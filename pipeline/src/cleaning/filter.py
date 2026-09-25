"""
STEP 8 — Data Filtering for Training (CRITICAL)
================================================
We do NOT use all data blindly.

Filter OUT:
  - Low liquidity periods (thin market, wide spread proxy)
  - Abnormal price spikes (bad data or flash crashes)
  - Duplicate or corrupted candles
  - Extremely high volatility candles (news spikes = data glitches)
  - Zero-volume candles

KEEP:
  - Clean price action
  - Normal market behavior
  - Realistic volatility
  - Sufficient liquidity

This runs AFTER cleaning, BEFORE feature generation.
Result is stored in /data/clean/{market}/{symbol}/{tf}/ with
a filter_mask column so you can reconstruct what was removed.
"""
import numpy as np
import pandas as pd
from dataclasses import dataclass
from typing import Tuple

from src.config import FILTER_CFG, FilterConfig
from src.utils.logger import get_logger

logger = get_logger("DataFilter")


@dataclass
class FilterReport:
    original:         int
    kept:             int
    removed_spike:    int
    removed_volume:   int
    removed_spread:   int
    removed_session:  int
    removed_other:    int

    @property
    def kept_pct(self) -> float:
        return self.kept / self.original if self.original else 0

    def __str__(self) -> str:
        return (
            f"Original={self.original:,} "
            f"Kept={self.kept:,} ({self.kept_pct:.1%}) | "
            f"Removed: spike={self.removed_spike:,} "
            f"vol={self.removed_volume:,} "
            f"spread={self.removed_spread:,} "
            f"session={self.removed_session:,}"
        )


class TrainingDataFilter:
    """
    Filters OHLCV data to keep only high-quality candles
    suitable for AI training.

    All filters are non-destructive: bad rows get mask=False,
    good rows get mask=True. The caller decides whether to drop.
    """

    def __init__(self, cfg: FilterConfig = FILTER_CFG):
        self.cfg = cfg

    # ─── Main ────────────────────────────────────────────────────────────────

    def filter(
        self,
        df:     pd.DataFrame,
        symbol: str,
        market: str,
    ) -> Tuple[pd.DataFrame, FilterReport]:
        """
        Apply all filters. Returns (filtered_df, report).
        filtered_df has only rows that passed all filters.
        """
        n = len(df)
        mask = pd.Series(True, index=df.index)

        # ── 1. Remove price spikes ────────────────────────────────────────────
        spike_mask = self._detect_spikes(df, symbol)
        mask &= spike_mask
        removed_spike = (~spike_mask).sum()

        # ── 2. Volume filter ──────────────────────────────────────────────────
        vol_mask = self._filter_volume(df)
        mask &= vol_mask
        removed_vol = (~vol_mask & spike_mask).sum()  # only newly removed

        # ── 3. Spread proxy filter (H-L range) ────────────────────────────────
        spread_mask = self._filter_spread(df, market)
        mask &= spread_mask
        removed_spread = (~spread_mask & spike_mask & vol_mask).sum()

        # ── 4. Session filter (FX only) ───────────────────────────────────────
        session_mask = self._filter_session(df, market)
        mask &= session_mask
        removed_session = (~session_mask & spike_mask & vol_mask & spread_mask).sum()

        # ── 5. Structural validity ────────────────────────────────────────────
        struct_mask = self._structural_validity(df)
        mask &= struct_mask
        removed_other = (~struct_mask).sum()

        filtered_df = df[mask].copy().reset_index(drop=True)

        report = FilterReport(
            original        = n,
            kept            = len(filtered_df),
            removed_spike   = int(removed_spike),
            removed_volume  = int(removed_vol),
            removed_spread  = int(removed_spread),
            removed_session = int(removed_session),
            removed_other   = int(removed_other),
        )

        logger.info(f"[{market}/{symbol}] Filter: {report}")

        # Warn if too much removed
        if report.kept_pct < 0.70:
            logger.warning(
                f"[{market}/{symbol}] Only {report.kept_pct:.1%} data kept — "
                f"check source quality"
            )

        return filtered_df, report

    # ─── Filter methods ───────────────────────────────────────────────────────

    def _detect_spikes(self, df: pd.DataFrame, symbol: str) -> pd.Series:
        """
        Remove abnormal price spikes.

        A candle is a spike if:
          |close_t - close_{t-1}| / close_{t-1} > max_price_spike_pct
        OR
          (high - low) / close > max_hl_ratio
        """
        close      = df["close"]
        prev_close = close.shift(1).fillna(close)

        # Close-to-close jump
        close_jump = (close - prev_close).abs() / prev_close.clip(lower=1e-10)
        spike_cc   = close_jump > self.cfg.max_price_spike_pct

        # High-Low range
        hl_ratio   = (df["high"] - df["low"]) / df["close"].clip(lower=1e-10)
        spike_hl   = hl_ratio > self.cfg.max_hl_ratio

        # Body ratio
        body_ratio = (df["close"] - df["open"]).abs() / df["close"].clip(lower=1e-10)
        spike_body = body_ratio > self.cfg.max_body_ratio

        spikes = spike_cc | spike_hl  # HL spike or close-jump are independent signals

        if spikes.sum() > 0:
            logger.debug(f"  Spike filter: {spikes.sum():,} candles removed")

        return ~spikes

    def _filter_volume(self, df: pd.DataFrame) -> pd.Series:
        """
        Remove candles with abnormally low or high volume.
        Uses percentile-based thresholds to be data-adaptive.
        """
        vol = df["volume"]

        # Remove zero volume
        zero_vol = vol <= self.cfg.min_volume

        # Use percentile thresholds if enough data
        if len(df) >= 1000:
            low_thresh  = vol.quantile(self.cfg.min_volume_percentile)
            high_thresh = vol.quantile(self.cfg.max_volume_percentile)
            bad_vol = (vol < low_thresh) | (vol > high_thresh)
        else:
            bad_vol = zero_vol

        return ~(zero_vol | bad_vol)

    def _filter_spread(self, df: pd.DataFrame, market: str) -> pd.Series:
        """
        Use high-low range as a spread proxy.
        For forex 1m candles: (H-L)/close > 0.5% = unusually wide.
        For crypto: looser threshold.
        """
        hl_pct = (df["high"] - df["low"]) / df["close"].clip(lower=1e-10)

        if market == "mt5":
            threshold = self.cfg.max_spread_proxy_pct       # 0.5% for forex
        else:
            threshold = self.cfg.max_spread_proxy_pct * 5   # 2.5% for crypto

        return hl_pct <= threshold

    def _filter_session(self, df: pd.DataFrame, market: str) -> pd.Series:
        """
        For FX (MT5): skip overnight low-activity hours.
        For crypto (Binance): no session filter.
        """
        if market != "mt5" or self.cfg.crypto_session_filter:
            return pd.Series(True, index=df.index)

        dts  = pd.to_datetime(df["time"], unit="ms", utc=True)
        hour = dts.dt.hour
        bad  = hour.isin(self.cfg.fx_skip_hours_utc)
        return ~bad

    def _structural_validity(self, df: pd.DataFrame) -> pd.Series:
        """Remove any remaining structurally invalid candles."""
        valid = (
            (df["high"] >= df["open"]) &
            (df["high"] >= df["close"]) &
            (df["low"]  <= df["open"]) &
            (df["low"]  <= df["close"]) &
            (df["high"] >= df["low"]) &
            (df["open"]  > 0) &
            (df["close"] > 0)
        )
        return valid

    # ─── Batch filter ─────────────────────────────────────────────────────────

    def filter_batch(
        self,
        df_dict: dict,  # {timeframe: df}
        symbol:  str,
        market:  str,
    ) -> dict:
        """Filter all timeframes for a symbol."""
        out = {}
        for tf, df in df_dict.items():
            filtered, report = self.filter(df, symbol, market)
            out[tf] = filtered
        return out
