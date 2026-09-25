"""
STEP 1 — Binance Ingestor
Downloads 1-minute candles from Binance public API.

No API key required for historical klines.
Handles rate limits, retries, and pagination automatically.
"""
import time
import requests
import pandas as pd
from pathlib import Path
from typing import List, Optional, Iterator
from datetime import datetime

from src.config import BINANCE_CFG, BINANCE_CONFIG, RAW_DIR, COLLECT_YEARS
from src.utils.logger import get_logger
from src.utils.time_utils import date_range_ms, ms_to_datetime

logger = get_logger("BinanceIngestor")

# Column names returned by Binance klines endpoint
BINANCE_COLS = [
    "time", "open", "high", "low", "close", "volume",
    "close_time", "quote_volume", "trade_count",
    "taker_buy_volume", "taker_buy_quote_volume", "ignore",
]

# Only these survive ingestion
KEEP_COLS = ["time", "open", "high", "low", "close", "volume"]


class BinanceIngestor:
    """
    Downloads 1m OHLCV candles from Binance.
    Stores raw data as Parquet in: data/raw/binance/{symbol}/1m/
    """

    def __init__(self):
        self.session   = requests.Session()
        self.session.headers.update({"User-Agent": "TradingDataPipeline/1.0"})
        self.base_url  = BINANCE_CFG.base_url
        self.endpoint  = BINANCE_CFG.klines_ep
        self.limit     = BINANCE_CFG.limit

    # ─── Public API ──────────────────────────────────────────────────────────

    def ingest_symbol(
        self,
        symbol:    str,
        years:     int = COLLECT_YEARS,
        start_str: Optional[str] = None,
        end_str:   Optional[str] = None,
    ) -> Path:
        """
        Download all 1m candles for a symbol and save to raw Parquet.
        Returns path to saved file.
        """
        start_ms, end_ms = date_range_ms(years, start_str, end_str)

        logger.info(
            f"[{symbol}] Fetching 1m candles: "
            f"{ms_to_datetime(start_ms).date()} → {ms_to_datetime(end_ms).date()}"
        )

        frames: List[pd.DataFrame] = []
        total_bars = 0
        cursor = start_ms

        while cursor < end_ms:
            batch = self._fetch_batch(symbol, cursor, end_ms)
            if batch is None or batch.empty:
                break

            frames.append(batch)
            total_bars += len(batch)
            cursor = int(batch["time"].iloc[-1]) + 60_000  # next minute

            logger.debug(f"[{symbol}] Fetched {total_bars:,} bars so far (last: {ms_to_datetime(cursor).date()})")
            time.sleep(BINANCE_CFG.rate_limit_sleep)

        if not frames:
            logger.warning(f"[{symbol}] No data received")
            return Path()

        df = pd.concat(frames, ignore_index=True)
        df = df.drop_duplicates(subset=["time"]).sort_values("time").reset_index(drop=True)

        logger.info(f"[{symbol}] Total: {len(df):,} bars "
                    f"({ms_to_datetime(df['time'].iloc[0]).date()} → "
                    f"{ms_to_datetime(df['time'].iloc[-1]).date()})")

        out_path = self._save_raw(df, symbol)
        return out_path

    def fetch_range(self, symbol: str, start_ms: int, end_ms: int) -> Optional[pd.DataFrame]:
        """Fetch a bounded range using the same pagination/retry logic as ingest_symbol."""
        frames: List[pd.DataFrame] = []
        cursor = start_ms
        while cursor < end_ms:
            batch = self._fetch_batch(symbol, cursor, end_ms)
            if batch is None or batch.empty:
                break
            frames.append(batch)
            cursor = int(batch["time"].iloc[-1]) + 60_000
            if cursor >= end_ms:
                break
            time.sleep(BINANCE_CFG.rate_limit_sleep)
        if not frames:
            return None
        return (pd.concat(frames, ignore_index=True)
                .drop_duplicates(subset=["time"])
                .sort_values("time")
                .reset_index(drop=True))

    def ingest_all(self, symbols: Optional[List[str]] = None) -> List[Path]:
        """Ingest all configured Binance symbols."""
        syms   = symbols or BINANCE_CONFIG.symbols
        paths  = []
        for sym in syms:
            try:
                p = self.ingest_symbol(sym)
                if p:
                    paths.append(p)
            except Exception as e:
                logger.error(f"[{sym}] Ingestion failed: {e}")
        return paths

    # ─── Internal ────────────────────────────────────────────────────────────

    def _fetch_batch(
        self, symbol: str, start_ms: int, end_ms: int
    ) -> Optional[pd.DataFrame]:
        """Fetch one batch of up to `limit` candles with retry logic."""
        for attempt in range(3):
            try:
                resp = self.session.get(
                    self.base_url + self.endpoint,
                    params={
                        "symbol":    symbol,
                        "interval":  "1m",
                        "startTime": start_ms,
                        "endTime":   end_ms,
                        "limit":     self.limit,
                    },
                    timeout=15,
                )
                resp.raise_for_status()
                data = resp.json()

                if not data:
                    return None

                df = pd.DataFrame(data, columns=BINANCE_COLS)

                # Cast types — only keep OHLCV
                df = df[KEEP_COLS].copy()
                df["time"]   = df["time"].astype("int64")
                df["open"]   = df["open"].astype("float64")
                df["high"]   = df["high"].astype("float64")
                df["low"]    = df["low"].astype("float64")
                df["close"]  = df["close"].astype("float64")
                df["volume"] = df["volume"].astype("float64")

                return df

            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 429:
                    # Rate limited — wait longer
                    wait = (attempt + 1) * 30
                    logger.warning(f"[{symbol}] Rate limited. Waiting {wait}s...")
                    time.sleep(wait)
                else:
                    logger.error(f"[{symbol}] HTTP error: {e}")
                    break
            except Exception as e:
                logger.warning(f"[{symbol}] Attempt {attempt + 1} failed: {e}")
                time.sleep(2 ** attempt)

        return None

    def _save_raw(self, df: pd.DataFrame, symbol: str) -> Path:
        """Save raw DataFrame to Parquet in raw directory."""
        out_dir = RAW_DIR / "binance" / symbol / "1m"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / "raw.parquet"

        df.to_parquet(
            out_path,
            engine="pyarrow",
            compression="zstd",
            index=False,
        )
        size_mb = out_path.stat().st_size / 1e6
        logger.info(f"[{symbol}] Saved raw: {out_path} ({size_mb:.2f} MB)")
        return out_path
