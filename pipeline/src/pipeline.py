"""
MASTER PIPELINE ORCHESTRATOR
==============================
Runs all 8 steps in sequence:

  STEP 1  → Ingest raw 1m candles (Binance / MT5)
  STEP 2  → Clean + Validate (keep ONLY OHLCV, no NaN, sorted, no dups)
  STEP 3  → Resample 1m → 5m / 15m / 1h / 4h
  STEP 4  → Compress to Parquet ZSTD + Partition by market/symbol/tf/year/month
  STEP 5  → Filter for training quality
  STEP 6  → Generate features (RSI, EMA, ADX, ATR, BB...)
  STEP 7  → Label data (ternary or binary, no leakage) + no-leakage validation
  STEP 8  → Upload to Mega (clean + features + labels)  [only with --upload]

Usage:
  python -m src.pipeline --market binance --symbols BTCUSDT,ETHUSDT --years 2
  python -m src.pipeline --market mt5     --symbols EURUSD,XAUUSD   --years 1
  python -m src.pipeline --all            --years 2 --upload
"""
import argparse
import time
import sys
from pathlib import Path
from typing import List, Optional
from datetime import datetime

from src.config import ALL_MARKETS, ALL_TIMEFRAMES
from src.utils.logger import get_logger

from src.ingestion.binance_ingestor  import BinanceIngestor
from src.ingestion.mt5_ingestor      import MT5Ingestor
from src.cleaning.cleaner            import DataCleaner, ValidationError
from src.cleaning.filter             import TrainingDataFilter
from src.resampling.resampler        import Resampler
from src.compression.partitioner     import Partitioner
from src.features.feature_engineer   import FeatureEngineer
from src.labeling.labeler            import DataLabeler
from src.storage.mega_uploader       import MegaUploader

import pandas as pd

logger = get_logger("Pipeline")

TOTAL_STEPS = 8


class TradingDataPipeline:
    """
    Orchestrates the full 8-step data pipeline.
    Each step is logged and timed independently.
    Failures on individual symbols are logged but do not stop the pipeline.
    """

    def __init__(self):
        self.cleaner    = DataCleaner()
        self.filter     = TrainingDataFilter()
        self.resampler  = Resampler()
        self.partitioner= Partitioner()
        self.features   = FeatureEngineer()
        self.labeler    = DataLabeler()
        self.uploader   = MegaUploader()
        self.report     = []

    # ─── Main entry point ─────────────────────────────────────────────────────

    def run(
        self,
        market:  str,
        symbols: List[str],
        years:   int  = 2,
        upload:  bool = False,
        tf_filter: Optional[List[str]] = None,
    ) -> dict:
        """
        Run the full pipeline for a market and set of symbols.
        Returns summary dict.
        """
        start_time = time.time()
        logger.info(
            f"\n{'═'*65}\n"
            f"  TRADING DATA PIPELINE v1.0\n"
            f"  Market: {market.upper()} | Symbols: {len(symbols)} | "
            f"Years: {years}\n"
            f"{'═'*65}\n"
        )

        timeframes = tf_filter or ALL_TIMEFRAMES
        success, failed = [], []

        for symbol in symbols:
            t0 = time.time()
            logger.info(f"\n{'─'*50}\n  Processing: {market}/{symbol}\n{'─'*50}")

            try:
                result = self._process_symbol(symbol, market, years, timeframes)
                result["elapsed_sec"] = round(time.time() - t0, 1)
                success.append(result)
                self.report.append({"symbol": symbol, "market": market, **result})
                logger.info(
                    f"  ✅ {symbol} done in {result['elapsed_sec']}s | "
                    f"bars_1m={result.get('bars_1m', 0):,}"
                )

            except Exception as e:
                logger.error(f"  ❌ {symbol} FAILED: {e}", exc_info=True)
                failed.append({"symbol": symbol, "error": str(e)})

        # ── STEP 8: Upload to Mega ─────────────────────────────────────────
        if upload:
            logger.info(f"\n{'─'*50}\n  STEP 8/{TOTAL_STEPS}: Uploading to Mega\n{'─'*50}")
            upload_results = self.uploader.upload_all()
            ok_uploads = sum(1 for r in upload_results if r.ok)
            logger.info(f"  Mega upload: {ok_uploads}/{len(upload_results)} files OK")

        total_elapsed = round(time.time() - start_time, 1)
        summary = self._print_summary(market, success, failed, total_elapsed)
        return summary

    # ─── Per-symbol processing ────────────────────────────────────────────────

    def _process_symbol(
        self,
        symbol:     str,
        market:     str,
        years:      int,
        timeframes: List[str],
    ) -> dict:
        result = {}

        # ── STEP 1/8: Ingest ──────────────────────────────────────────────
        logger.info(f"  [1/{TOTAL_STEPS}] Ingesting {symbol}...")
        raw_df = self._ingest(symbol, market, years)
        if raw_df is None or raw_df.empty:
            raise ValueError(f"No data ingested for {symbol}")
        result["bars_raw"] = len(raw_df)

        # ── STEP 2/8: Clean + Validate ────────────────────────────────────
        logger.info(f"  [2/{TOTAL_STEPS}] Cleaning + validating {len(raw_df):,} bars...")
        clean_df = self.cleaner.clean(raw_df, symbol, market, "1m")
        result["bars_1m"] = len(clean_df)

        # ── STEP 3/8: Resample ────────────────────────────────────────────
        logger.info(f"  [3/{TOTAL_STEPS}] Resampling to {timeframes}...")
        all_tf = self.resampler.resample_all(clean_df, symbol)
        all_tf = {k: v for k, v in all_tf.items() if k in timeframes}
        result["timeframes"] = list(all_tf.keys())

        # ── STEP 4/8: Compress + Partition ───────────────────────────────
        logger.info(f"  [4/{TOTAL_STEPS}] Partitioning (Parquet/ZSTD)...")
        written = self.partitioner.write_all_timeframes(all_tf, market, symbol)
        total_files = sum(len(v) for v in written.values())
        result["parquet_files"] = total_files

        # ── STEP 5/8: Filter for training quality ─────────────────────────
        logger.info(f"  [5/{TOTAL_STEPS}] Filtering for training quality...")
        filtered_tf = self.filter.filter_batch(all_tf, symbol, market)

        # ── STEP 6/8: Feature Engineering ────────────────────────────────
        logger.info(f"  [6/{TOTAL_STEPS}] Generating features...")
        feature_paths = []
        featured_tf   = {}
        for tf, df in filtered_tf.items():
            if len(df) < 250:
                logger.warning(f"    {tf}: too few bars ({len(df)}) for features")
                continue
            feat_df = self.features.generate(df, symbol)
            path    = self.features.save(feat_df, market, symbol, tf)
            feature_paths.append(path)
            featured_tf[tf] = feat_df

        result["feature_files"] = len(feature_paths)

        # ── STEP 7/8: Labeling + no-leakage validation ───────────────────
        # FIX: previously labels were computed twice — once to save (step 10)
        # and again for the leakage check (step 11). Now computed once, saved,
        # and the leakage check runs on the already-labeled DataFrame.
        logger.info(f"  [7/{TOTAL_STEPS}] Labeling (no-leakage) + validating...")
        label_paths = []
        for tf, df in featured_tf.items():
            if len(df) < 100:
                continue
            labeled_df = self.labeler.label(df, symbol)

            # No-leakage check runs on the labeled df (not a second label() call)
            ok = self.labeler.validate_no_leakage(labeled_df)
            if not ok:
                logger.warning(
                    f"    [{symbol}/{tf}] Leakage check FAILED — "
                    f"review features! Saving skipped for safety."
                )
                continue

            path = self.labeler.save(labeled_df, market, symbol, tf)
            label_paths.append(path)

        result["label_files"] = len(label_paths)
        result["ok"] = True
        return result

    # ─── Ingestion router ─────────────────────────────────────────────────────

    def _ingest(self, symbol: str, market: str, years: int) -> Optional[pd.DataFrame]:
        """Route to correct ingestor based on market."""
        from src.config import RAW_DIR

        # Check if raw data already exists and is fresh
        raw_path = RAW_DIR / market / symbol / "1m" / "raw.parquet"
        if raw_path.exists():
            age_hours = (time.time() - raw_path.stat().st_mtime) / 3600
            if age_hours < 24:
                logger.info(f"    Using cached raw data ({age_hours:.1f}h old)")
                return pd.read_parquet(raw_path, engine="pyarrow")

        if market == "binance":
            ingestor = BinanceIngestor()
            path = ingestor.ingest_symbol(symbol, years=years)
        elif market == "mt5":
            ingestor = MT5Ingestor()
            if not ingestor.connect():
                logger.warning("MT5 not available — trying Yahoo Finance fallback")
                return self._yahoo_fallback(symbol, years)
            with ingestor:
                path = ingestor.ingest_symbol(symbol, years=years)
        else:
            raise ValueError(f"Unknown market: {market}")

        if path and path.exists():
            return pd.read_parquet(path, engine="pyarrow")
        return None

    def _yahoo_fallback(self, symbol: str, years: int) -> Optional[pd.DataFrame]:
        """Fallback to Yahoo Finance if MT5 is not available."""
        try:
            from src.ingestion.yahoo_ingestor import YahooIngestor
            ingestor = YahooIngestor()
            return ingestor.fetch(symbol, years)
        except ImportError:
            logger.error("Yahoo fallback not available")
            return None

    # ─── Summary ──────────────────────────────────────────────────────────────

    def _print_summary(
        self,
        market:  str,
        success: list,
        failed:  list,
        elapsed: float,
    ) -> dict:
        logger.info(f"\n{'═'*65}")
        logger.info(f"  PIPELINE SUMMARY — {market.upper()}")
        logger.info(f"{'═'*65}")
        logger.info(f"  ✅ Successful: {len(success)}")
        logger.info(f"  ❌ Failed:     {len(failed)}")
        logger.info(f"  ⏱  Total time: {elapsed:.0f}s")

        if success:
            total_bars  = sum(r.get("bars_1m", 0) for r in success)
            total_files = sum(r.get("parquet_files", 0) for r in success)
            logger.info(f"  📊 Total 1m bars: {total_bars:,}")
            logger.info(f"  📦 Parquet files: {total_files:,}")

        if failed:
            logger.info(f"\n  Failed symbols:")
            for f in failed:
                logger.info(f"    {f['symbol']}: {f['error']}")

        logger.info(
            f"\n  Data ready in:\n"
            f"    Clean:    data/clean/\n"
            f"    Features: data/features/\n"
            f"    Labels:   data/labels/\n"
        )
        logger.info("═"*65)

        return {
            "market":      market,
            "success":     len(success),
            "failed":      len(failed),
            "elapsed_sec": elapsed,
            "symbols":     [r.get("symbol") for r in success],
        }


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Trading Data Pipeline — STEPS 1-8"
    )
    parser.add_argument("--market",  default="binance",
                        choices=["binance", "mt5", "all"])
    parser.add_argument("--symbols", default="",
                        help="Comma-separated symbols, or empty for all")
    parser.add_argument("--years",   type=int, default=2)
    parser.add_argument("--upload",  action="store_true",
                        help="Upload to Mega after processing (step 8)")
    parser.add_argument("--tf",      default="",
                        help="Timeframes to process, e.g. 1m,1h,4h")
    args = parser.parse_args()

    pipeline  = TradingDataPipeline()
    tf_filter = args.tf.split(",") if args.tf else None

    markets = (
        list(ALL_MARKETS.keys()) if args.market == "all"
        else [args.market]
    )

    for market in markets:
        market_cfg = ALL_MARKETS[market]
        symbols = (
            [s.strip() for s in args.symbols.split(",")]
            if args.symbols
            else market_cfg.symbols
        )
        pipeline.run(
            market    = market,
            symbols   = symbols,
            years     = args.years,
            upload    = args.upload,
            tf_filter = tf_filter,
        )


if __name__ == "__main__":
    main()
