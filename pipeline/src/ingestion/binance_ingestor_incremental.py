"""
pipeline/src/ingestion/binance_ingestor_incremental.py
======================================================
INCREMENTAL UPDATE MODE — new feature.

WHY THIS IS NEEDED:
  The existing BinanceIngestor re-downloads ALL historical data from
  scratch on every pipeline run. For 2 years × 16 symbols × 1,440
  candles/day = ~16 million API calls. Runtime: several hours.

  Incremental mode reads the last saved timestamp from existing
  Parquet files and downloads ONLY new candles since then.
  Runtime drops from hours to seconds for daily updates.

HOW TO USE:
  from src.ingestion.binance_ingestor_incremental import IncrementalBinanceIngestor

  ingestor = IncrementalBinanceIngestor()
  path = ingestor.update_symbol("BTCUSDT")   # downloads only new bars

  # Or update all configured symbols:
  results = ingestor.update_all()

The incremental ingestor is fully backward-compatible — if no existing
data is found it falls back to a full historical download.
"""
import time
import pandas as pd
from pathlib import Path
from typing import Optional, List
from datetime import datetime, timezone

from src.config import (
    BINANCE_CFG, BINANCE_CONFIG, RAW_DIR, COLLECT_YEARS,
)
from src.ingestion.binance_ingestor import BinanceIngestor
from src.utils.logger import get_logger
from src.utils.time_utils import date_range_ms, ms_to_datetime

logger = get_logger("BinanceIncremental")


class IncrementalBinanceIngestor:
    """
    Downloads only candles newer than the last saved timestamp.
    Falls back to full download if no existing data is found.
    """

    def __init__(self):
        self._base = BinanceIngestor()

    # ─── Public API ──────────────────────────────────────────────────

    def update_symbol(
        self,
        symbol: str,
        force_full: bool = False,
    ) -> Optional[Path]:
        """
        Update one symbol. Downloads only new candles.
        Returns path to the updated Parquet file, or None on failure.
        """
        raw_path = RAW_DIR / "binance" / symbol / "1m" / "raw.parquet"
        last_ts  = self._get_last_timestamp(raw_path) if not force_full else None

        if last_ts is None:
            logger.info(f"[{symbol}] No existing data — running full download")
            return self._base.ingest_symbol(symbol)

        now_ms  = int(datetime.now(timezone.utc).timestamp() * 1000)
        new_bars = (now_ms - last_ts) // 60_000

        if new_bars < 2:
            logger.info(f"[{symbol}] Already up to date ({ms_to_datetime(last_ts).strftime('%Y-%m-%d %H:%M')})")
            return raw_path

        logger.info(
            f"[{symbol}] Incremental: fetching ~{new_bars:,} new bars "
            f"since {ms_to_datetime(last_ts).strftime('%Y-%m-%d %H:%M')}"
        )

        # Download only new candles
        cursor    = last_ts + 60_000  # start from next minute
        new_df    = self._base.fetch_range(symbol, cursor, now_ms)

        if new_df is None or new_df.empty:
            logger.info(f"[{symbol}] No new candles available")
            return raw_path

        # Load existing data and append
        existing = pd.read_parquet(raw_path, engine="pyarrow")
        combined = (
            pd.concat([existing, new_df], ignore_index=True)
            .drop_duplicates(subset=["time"])
            .sort_values("time")
            .reset_index(drop=True)
        )

        # Save back
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        combined.to_parquet(raw_path, engine="pyarrow", compression="zstd", index=False)

        added = len(combined) - len(existing)
        logger.info(
            f"[{symbol}] Updated: +{added:,} bars → {len(combined):,} total "
            f"(last: {ms_to_datetime(int(combined['time'].iloc[-1])).strftime('%Y-%m-%d %H:%M')})"
        )
        return raw_path

    def update_all(
        self,
        symbols: Optional[List[str]] = None,
        force_full: bool = False,
    ) -> dict:
        """Update all configured Binance symbols. Returns summary dict."""
        targets  = symbols or BINANCE_CONFIG.symbols
        results  = {}
        success  = 0

        for symbol in targets:
            try:
                path = self.update_symbol(symbol, force_full=force_full)
                results[symbol] = {"ok": True, "path": str(path)}
                success += 1
            except Exception as e:
                logger.error(f"[{symbol}] Update failed: {e}")
                results[symbol] = {"ok": False, "error": str(e)}
            time.sleep(BINANCE_CFG.rate_limit_sleep)

        logger.info(f"Incremental update complete: {success}/{len(targets)} symbols")
        return results

    # ─── Helpers ─────────────────────────────────────────────────────

    def _get_last_timestamp(self, path: Path) -> Optional[int]:
        """Return the last 'time' value in an existing Parquet file, or None."""
        if not path.exists():
            return None
        try:
            df = pd.read_parquet(path, engine="pyarrow", columns=["time"])
            if df.empty:
                return None
            return int(df["time"].iloc[-1])
        except Exception as e:
            logger.warning(f"Could not read last timestamp from {path}: {e}")
            return None


# ─── CLI ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Incremental Binance data update")
    parser.add_argument("--symbols", default="", help="Comma-separated symbols or empty for all")
    parser.add_argument("--full", action="store_true", help="Force full re-download")
    args = parser.parse_args()

    ingestor = IncrementalBinanceIngestor()
    symbols  = [s.strip() for s in args.symbols.split(",") if s.strip()] or None
    ingestor.update_all(symbols=symbols, force_full=args.full)
