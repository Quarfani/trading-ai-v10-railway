"""
STEP 9 — Feature Engineering
==============================
Generate technical indicators from clean OHLCV data.

Features computed:
  ─── Trend ───────────────────────────────
  ema_50        EMA 50 periods
  ema_200       EMA 200 periods
  ema_cross     (ema_50 - ema_200) / close   (normalized)
  ema_50_slope  (ema_50 - ema_50[5]) / ema_50[5]
  price_vs_ema50 (close - ema_50) / close
  price_vs_ema200 (close - ema_200) / close

  ─── Momentum ────────────────────────────
  rsi_14        RSI 14
  rsi_norm      (rsi - 50) / 50             (centered, -1..+1)
  macd          MACD line
  macd_signal   Signal line
  macd_hist     Histogram
  macd_hist_norm macd_hist / close

  ─── Volatility ──────────────────────────
  atr_14        ATR 14
  atr_pct       atr / close                 (% of price)
  volatility_20 Rolling std of log returns (20 bars)
  bb_upper      Bollinger Band upper
  bb_lower      Bollinger Band lower
  bb_width      (bb_upper - bb_lower) / close
  bb_position   (close - bb_lower) / (bb_upper - bb_lower)  [0..1]

  ─── Trend strength ──────────────────────
  adx_14        ADX 14
  plus_di       +DI
  minus_di      -DI
  di_diff       (plus_di - minus_di) / 100

  ─── Volume ──────────────────────────────
  vol_ma_20     SMA of volume (20)
  vol_ratio     volume / vol_ma_20          (relative volume)
  vol_norm      log(volume + 1) / log(max_vol + 1)

  ─── Price action ────────────────────────
  returns_1     log return 1 bar
  returns_5     log return 5 bars
  returns_15    log return 15 bars
  body_ratio    |close - open| / (high - low + eps)
  upper_wick    (high - max(open, close)) / (high - low + eps)
  lower_wick    (min(open, close) - low) / (high - low + eps)
  candle_dir    +1 bullish, -1 bearish, 0 doji

STRICT NO-LEAKAGE: All features use ONLY past data.
NaN warmup bars (< min_warmup_bars) are DROPPED, not filled.
"""
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional

from src.config import FEATURE_CFG, FEATURE_DIR, FeatureConfig
from src.utils.logger import get_logger

logger = get_logger("FeatureEngineer")

EPS = 1e-10   # prevent division by zero


class FeatureEngineer:
    """
    Generates ML-ready features from clean OHLCV data.
    Strict no-look-ahead: only shift(1) or past windows.
    """

    def __init__(self, cfg: FeatureConfig = FEATURE_CFG):
        self.cfg = cfg

    # ─── Main ────────────────────────────────────────────────────────────────

    def generate(self, df: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """
        Generate all features. Returns df with feature columns added.
        Drops warmup rows (first min_warmup_bars rows with NaN indicators).
        """
        logger.info(f"[{symbol}] Generating features from {len(df):,} bars...")
        df = df.copy()

        df = self._add_ema_features(df)
        df = self._add_momentum_features(df)
        df = self._add_volatility_features(df)
        df = self._add_adx_features(df)
        df = self._add_volume_features(df)
        df = self._add_price_action(df)

        # Drop warmup rows (NaN features from indicator warmup)
        n_before = len(df)
        df = df.dropna().reset_index(drop=True)
        dropped = n_before - len(df)

        if dropped > 0:
            logger.info(
                f"[{symbol}] Dropped {dropped:,} warmup rows "
                f"({len(df):,} usable bars remaining)"
            )

        logger.info(
            f"[{symbol}] Features generated: "
            f"{len([c for c in df.columns if c not in ['time','open','high','low','close','volume']])} features"
        )

        return df

    # ─── EMA & Trend ─────────────────────────────────────────────────────────

    def _add_ema_features(self, df: pd.DataFrame) -> pd.DataFrame:
        close = df["close"]

        # EMA 50
        df["ema_50"]  = close.ewm(span=self.cfg.ema_fast, adjust=False).mean()
        # EMA 200
        df["ema_200"] = close.ewm(span=self.cfg.ema_slow, adjust=False).mean()

        # Normalized cross
        df["ema_cross"]       = (df["ema_50"] - df["ema_200"]) / (close + EPS)
        df["price_vs_ema50"]  = (close - df["ema_50"])  / (close + EPS)
        df["price_vs_ema200"] = (close - df["ema_200"]) / (close + EPS)

        # EMA slope (5-bar rate of change)
        df["ema_50_slope"] = (
            (df["ema_50"] - df["ema_50"].shift(5)) / (df["ema_50"].shift(5) + EPS)
        )

        return df

    # ─── Momentum (RSI, MACD) ────────────────────────────────────────────────

    def _add_momentum_features(self, df: pd.DataFrame) -> pd.DataFrame:
        close = df["close"]

        # RSI
        df["rsi_14"]   = self._rsi(close, self.cfg.rsi_period)
        df["rsi_norm"]  = (df["rsi_14"] - 50) / 50   # -1..+1

        # MACD
        ema_fast   = close.ewm(span=self.cfg.macd_fast,   adjust=False).mean()
        ema_slow   = close.ewm(span=self.cfg.macd_slow,   adjust=False).mean()
        macd_line  = ema_fast - ema_slow
        signal     = macd_line.ewm(span=self.cfg.macd_signal, adjust=False).mean()
        hist       = macd_line - signal

        df["macd"]           = macd_line
        df["macd_signal"]    = signal
        df["macd_hist"]      = hist
        df["macd_hist_norm"] = hist / (close + EPS)

        return df

    # ─── Volatility (ATR, Bollinger) ─────────────────────────────────────────

    def _add_volatility_features(self, df: pd.DataFrame) -> pd.DataFrame:
        close = df["close"]
        high  = df["high"]
        low   = df["low"]

        # ATR
        tr1 = high - low
        tr2 = (high - close.shift(1)).abs()
        tr3 = (low  - close.shift(1)).abs()
        tr  = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        df["atr_14"] = tr.ewm(span=self.cfg.atr_period, adjust=False).mean()
        df["atr_pct"] = df["atr_14"] / (close + EPS)

        # Rolling log-return volatility
        log_ret = np.log(close / close.shift(1))
        df["volatility_20"] = log_ret.rolling(self.cfg.vol_window).std()

        # Bollinger Bands
        sma   = close.rolling(self.cfg.bb_period).mean()
        std   = close.rolling(self.cfg.bb_period).std()
        df["bb_upper"]    = sma + self.cfg.bb_std * std
        df["bb_lower"]    = sma - self.cfg.bb_std * std
        df["bb_width"]    = (df["bb_upper"] - df["bb_lower"]) / (sma + EPS)
        bb_range          = (df["bb_upper"] - df["bb_lower"]).clip(lower=EPS)
        df["bb_position"] = (close - df["bb_lower"]) / bb_range  # 0..1

        return df

    # ─── ADX & Directional ───────────────────────────────────────────────────

    def _add_adx_features(self, df: pd.DataFrame) -> pd.DataFrame:
        period = self.cfg.adx_period
        high   = df["high"]
        low    = df["low"]
        close  = df["close"]

        # True Range
        tr1 = high - low
        tr2 = (high - close.shift(1)).abs()
        tr3 = (low  - close.shift(1)).abs()
        tr  = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

        # Directional Movement
        up   = high - high.shift(1)
        down = low.shift(1) - low

        plus_dm  = up.where((up > down) & (up > 0), 0)
        minus_dm = down.where((down > up) & (down > 0), 0)

        # Smoothed
        atr_s       = tr.ewm(span=period, adjust=False).mean()
        plus_di_s   = 100 * plus_dm.ewm(span=period, adjust=False).mean() / (atr_s + EPS)
        minus_di_s  = 100 * minus_dm.ewm(span=period, adjust=False).mean() / (atr_s + EPS)

        # DX and ADX
        di_sum  = (plus_di_s + minus_di_s).clip(lower=EPS)
        dx      = 100 * (plus_di_s - minus_di_s).abs() / di_sum
        adx     = dx.ewm(span=period, adjust=False).mean()

        df["adx_14"]    = adx
        df["plus_di"]   = plus_di_s
        df["minus_di"]  = minus_di_s
        df["di_diff"]   = (plus_di_s - minus_di_s) / 100   # -1..+1

        return df

    # ─── Volume Features ─────────────────────────────────────────────────────

    def _add_volume_features(self, df: pd.DataFrame) -> pd.DataFrame:
        vol = df["volume"]

        df["vol_ma_20"] = vol.rolling(20).mean()
        df["vol_ratio"] = vol / (df["vol_ma_20"] + EPS)

        # Log-normalized volume
        max_vol = vol.rolling(200).max().clip(lower=EPS)
        df["vol_norm"] = np.log1p(vol) / np.log1p(max_vol)

        return df

    # ─── Price Action Features ────────────────────────────────────────────────

    def _add_price_action(self, df: pd.DataFrame) -> pd.DataFrame:
        close = df["close"]
        high  = df["high"]
        low   = df["low"]
        open_ = df["open"]

        # Log returns
        lr = np.log(close / (close.shift(1) + EPS))
        df["returns_1"]  = lr
        df["returns_5"]  = np.log(close / (close.shift(5)  + EPS))
        df["returns_15"] = np.log(close / (close.shift(15) + EPS))

        # Candle body / wick ratios
        hl_range         = (high - low).clip(lower=EPS)
        df["body_ratio"] = (close - open_).abs() / hl_range
        df["upper_wick"] = (high - pd.concat([open_, close], axis=1).max(axis=1)) / hl_range
        df["lower_wick"] = (pd.concat([open_, close], axis=1).min(axis=1) - low) / hl_range

        # Candle direction: +1 bull, -1 bear
        df["candle_dir"] = np.sign(close - open_).astype("int8")

        return df

    # ─── RSI (Wilder's smoothing) ─────────────────────────────────────────────

    @staticmethod
    def _rsi(series: pd.Series, period: int) -> pd.Series:
        delta = series.diff()
        gain  = delta.clip(lower=0)
        loss  = (-delta).clip(lower=0)
        avg_gain = gain.ewm(alpha=1/period, adjust=False).mean()
        avg_loss = loss.ewm(alpha=1/period, adjust=False).mean()
        rs  = avg_gain / (avg_loss + EPS)
        rsi = 100 - (100 / (1 + rs))
        return rsi

    # ─── Save ────────────────────────────────────────────────────────────────

    def save(
        self, df: pd.DataFrame, market: str, symbol: str, timeframe: str
    ) -> Path:
        """Save feature DataFrame to Parquet."""
        out_dir  = FEATURE_DIR / market / symbol / timeframe
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / "features.parquet"

        df.to_parquet(out_path, engine="pyarrow", compression="zstd", index=False)
        size_mb = out_path.stat().st_size / 1e6
        logger.info(
            f"[{market}/{symbol}/{timeframe}] Features saved: "
            f"{out_path} ({size_mb:.2f} MB, {len(df.columns)} cols)"
        )
        return out_path

    def feature_names(self) -> list:
        """List all generated feature column names."""
        return [
            "ema_50","ema_200","ema_cross","price_vs_ema50","price_vs_ema200","ema_50_slope",
            "rsi_14","rsi_norm","macd","macd_signal","macd_hist","macd_hist_norm",
            "atr_14","atr_pct","volatility_20","bb_upper","bb_lower","bb_width","bb_position",
            "adx_14","plus_di","minus_di","di_diff",
            "vol_ma_20","vol_ratio","vol_norm",
            "returns_1","returns_5","returns_15","body_ratio","upper_wick","lower_wick","candle_dir",
        ]
