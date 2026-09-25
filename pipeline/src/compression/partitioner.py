"""
STEPS 5 & 6 — Smart Compression + Partitioning
===============================================
STEP 5: Save as Parquet with ZSTD compression (NOT CSV, NOT ZIP)
STEP 6: Partition as /data/clean/{market}/{symbol}/{timeframe}/{year}/{month}/

Partition format:
  /data/clean/binance/BTCUSDT/1m/2024/01/data.parquet
  /data/clean/binance/BTCUSDT/5m/2024/01/data.parquet
  /data/clean/mt5/EURUSD/1h/2023/06/data.parquet
  ...

Benefits:
  - Selective loading (only load what you need)
  - Parallel reads by partition
  - Scalable to years of data
  - Fast filtering by date
"""
import hashlib
import pyarrow as pa
import pyarrow.parquet as pq
import pandas as pd
from pathlib import Path
from typing import Dict, List, Optional

from src.config import CLEAN_DIR, COMPRESSION_CFG, CompressionConfig
from src.utils.logger import get_logger

logger = get_logger("Partitioner")


# ─── PyArrow schema for strict typing ────────────────────────────────────────

OHLCV_SCHEMA = pa.schema([
    pa.field("time",   pa.int64(),   nullable=False),
    pa.field("open",   pa.float64(), nullable=False),
    pa.field("high",   pa.float64(), nullable=False),
    pa.field("low",    pa.float64(), nullable=False),
    pa.field("close",  pa.float64(), nullable=False),
    pa.field("volume", pa.float64(), nullable=False),
])


class Partitioner:
    """
    Writes DataFrames to partitioned Parquet files with ZSTD compression.
    Maintains a manifest (checksum file) for integrity verification.
    """

    def __init__(self, cfg: CompressionConfig = COMPRESSION_CFG, base_dir: Path = CLEAN_DIR):
        self.cfg      = cfg
        self.base_dir = base_dir

    # ─── Write ───────────────────────────────────────────────────────────────

    def write(
        self,
        df:        pd.DataFrame,
        market:    str,
        symbol:    str,
        timeframe: str,
    ) -> List[Path]:
        """
        Partition df by year/month and write to Parquet files.
        Returns list of written file paths.
        """
        if df.empty:
            logger.warning(f"[{market}/{symbol}/{timeframe}] Empty DataFrame — skipping")
            return []

        # Add datetime helpers for partitioning
        df = df.copy()
        ts = pd.to_datetime(df["time"], unit="ms", utc=True)
        df["_year"]  = ts.dt.year.astype("int32")
        df["_month"] = ts.dt.month.astype("int32")

        written_paths = []

        for (year, month), partition in df.groupby(["_year", "_month"]):
            partition = partition.drop(columns=["_year", "_month"]).reset_index(drop=True)

            out_path = self._build_path(market, symbol, timeframe, year, month)
            out_path.parent.mkdir(parents=True, exist_ok=True)

            self._write_parquet(partition, out_path)
            self._write_checksum(partition, out_path)
            written_paths.append(out_path)

        total_bars = len(df)
        total_size = sum(p.stat().st_size for p in written_paths) / 1e6
        logger.info(
            f"[{market}/{symbol}/{timeframe}] Written {total_bars:,} bars "
            f"across {len(written_paths)} partitions ({total_size:.2f} MB total)"
        )

        return written_paths

    def write_all_timeframes(
        self,
        data:   Dict[str, pd.DataFrame],
        market: str,
        symbol: str,
    ) -> Dict[str, List[Path]]:
        """Write all timeframes for a symbol."""
        all_paths = {}
        for tf, df in data.items():
            paths = self.write(df, market, symbol, tf)
            all_paths[tf] = paths
        return all_paths

    # ─── Read ────────────────────────────────────────────────────────────────

    def read(
        self,
        market:    str,
        symbol:    str,
        timeframe: str,
        year:      Optional[int] = None,
        month:     Optional[int] = None,
    ) -> pd.DataFrame:
        """
        Read partitioned data back into a single DataFrame.
        Optional year/month filtering for selective loading.
        """
        base = self.base_dir / market / symbol / timeframe

        if not base.exists():
            logger.warning(f"No data found: {base}")
            return pd.DataFrame()

        parquet_files = []
        if year and month:
            path = base / str(year) / f"{month:02d}" / "data.parquet"
            if path.exists():
                parquet_files = [path]
        elif year:
            parquet_files = sorted(base.glob(f"{year}/*/data.parquet"))
        else:
            parquet_files = sorted(base.glob("*/*/data.parquet"))

        if not parquet_files:
            return pd.DataFrame()

        # Verify checksums before loading
        valid_files = [f for f in parquet_files if self._verify_checksum(f)]
        if len(valid_files) < len(parquet_files):
            logger.warning(
                f"[{market}/{symbol}/{timeframe}] "
                f"{len(parquet_files)-len(valid_files)} files failed checksum"
            )

        frames = [pd.read_parquet(f, engine="pyarrow") for f in valid_files]
        if not frames:
            return pd.DataFrame()

        df = pd.concat(frames, ignore_index=True)
        df = df.sort_values("time").reset_index(drop=True)
        return df

    # ─── Available data catalog ───────────────────────────────────────────────

    def catalog(self) -> pd.DataFrame:
        """Return a catalog of all available data partitions."""
        records = []
        for parquet_file in self.base_dir.glob("*/*/*/*/*/data.parquet"):
            parts = parquet_file.relative_to(self.base_dir).parts
            if len(parts) >= 5:
                market, symbol, tf, year, month = parts[:5]
                size_kb = parquet_file.stat().st_size / 1024
                records.append({
                    "market":    market,
                    "symbol":    symbol,
                    "timeframe": tf,
                    "year":      year,
                    "month":     month,
                    "size_kb":   round(size_kb, 1),
                    "checksum_ok": self._verify_checksum(parquet_file),
                })

        return pd.DataFrame(records)

    # ─── Internal ────────────────────────────────────────────────────────────

    def _build_path(
        self, market: str, symbol: str, timeframe: str, year: int, month: int
    ) -> Path:
        return (
            self.base_dir / market / symbol / timeframe /
            str(year) / f"{month:02d}" / "data.parquet"
        )

    def _write_parquet(self, df: pd.DataFrame, path: Path) -> None:
        table = pa.Table.from_pandas(df, schema=OHLCV_SCHEMA, preserve_index=False)
        pq.write_table(
            table, path,
            compression        = self.cfg.compression,
            row_group_size     = self.cfg.row_group_size,
            use_dictionary     = self.cfg.use_dictionary,
            write_statistics   = self.cfg.write_statistics,
        )

    def _write_checksum(self, df: pd.DataFrame, parquet_path: Path) -> None:
        checksum = hashlib.sha256(
            df[["time","open","high","low","close","volume"]].values.tobytes()
        ).hexdigest()
        checksum_path = parquet_path.with_suffix(".sha256")
        checksum_path.write_text(checksum)

    def _verify_checksum(self, parquet_path: Path) -> bool:
        checksum_path = parquet_path.with_suffix(".sha256")
        if not checksum_path.exists():
            return True  # no checksum file = skip verification
        try:
            stored = checksum_path.read_text().strip()
            df     = pd.read_parquet(parquet_path, engine="pyarrow")
            actual = hashlib.sha256(
                df[["time","open","high","low","close","volume"]].values.tobytes()
            ).hexdigest()
            return stored == actual
        except Exception:
            return False

    def compression_ratio(self, original_rows: int, written_paths: List[Path]) -> dict:
        """Calculate compression stats."""
        raw_bytes  = original_rows * 6 * 8    # 6 float64 columns
        disk_bytes = sum(p.stat().st_size for p in written_paths if p.exists())
        return {
            "raw_estimated_mb":  raw_bytes / 1e6,
            "compressed_mb":     disk_bytes / 1e6,
            "compression_ratio": raw_bytes / disk_bytes if disk_bytes > 0 else 0,
        }
