"""
STEP 1 — MT5 Ingestor
Downloads 1-minute candles from MetaTrader 5.

Requires:
  pip install MetaTrader5
  MT5 terminal installed and running on Windows.

For Linux/Mac servers: use wine + MT5 or the bridge approach.
"""
import pandas as pd
from pathlib import Path
from typing import List, Optional
from datetime import datetime, timezone

from src.config import MT5_CFG, MT5_CONFIG, RAW_DIR, COLLECT_YEARS
from src.utils.logger import get_logger
from src.utils.time_utils import utc_now

logger = get_logger("MT5Ingestor")

# MT5 timeframe constant for 1 minute
MT5_TIMEFRAME_M1 = 1  # TIMEFRAME_M1 in MetaTrader5 library

KEEP_COLS = ["time", "open", "high", "low", "close", "volume"]


class MT5Ingestor:
    """
    Downloads 1m OHLCV candles from MetaTrader 5 terminal.
    Stores raw data as Parquet in: data/raw/mt5/{symbol}/1m/
    """

    def __init__(self):
        self._mt5 = None
        self._connected = False

    # ─── Connection ──────────────────────────────────────────────────────────

    def connect(self) -> bool:
        """Initialize MT5 connection."""
        try:
            import MetaTrader5 as mt5
            self._mt5 = mt5

            init_kwargs = {"timeout": MT5_CFG.timeout}
            if MT5_CFG.path:
                init_kwargs["path"] = MT5_CFG.path

            if not mt5.initialize(**init_kwargs):
                logger.error(f"MT5 initialize failed: {mt5.last_error()}")
                return False

            if MT5_CFG.login and MT5_CFG.password:
                ok = mt5.login(
                    login    = MT5_CFG.login,
                    password = MT5_CFG.password,
                    server   = MT5_CFG.server,
                )
                if not ok:
                    logger.error(f"MT5 login failed: {mt5.last_error()}")
                    mt5.shutdown()
                    return False

            info = mt5.account_info()
            logger.info(
                f"MT5 connected: {info.server if info else 'unknown'} "
                f"login={MT5_CFG.login}"
            )
            self._connected = True
            return True

        except ImportError:
            logger.error(
                "MetaTrader5 package not installed. "
                "Install with: pip install MetaTrader5\n"
                "Note: requires Windows + MT5 terminal."
            )
            return False
        except Exception as e:
            logger.error(f"MT5 connect error: {e}")
            return False

    def disconnect(self):
        if self._mt5 and self._connected:
            self._mt5.shutdown()
            self._connected = False

    # ─── Public API ──────────────────────────────────────────────────────────

    def ingest_symbol(
        self,
        symbol:    str,
        years:     int = COLLECT_YEARS,
        start_str: Optional[str] = None,
    ) -> Path:
        """Download all 1m candles for a symbol."""
        if not self._connected:
            raise RuntimeError("Not connected to MT5. Call connect() first.")

        mt5 = self._mt5

        # Validate symbol
        sym_info = mt5.symbol_info(symbol)
        if sym_info is None:
            logger.error(f"[{symbol}] Symbol not found in MT5")
            return Path()

        if not sym_info.visible:
            mt5.symbol_select(symbol, True)

        # Date range
        if start_str:
            start_dt = datetime.fromisoformat(start_str).replace(tzinfo=timezone.utc)
        else:
            from datetime import timedelta
            start_dt = utc_now() - timedelta(days=years * 365)

        end_dt = utc_now()

        logger.info(
            f"[{symbol}] Fetching 1m candles: "
            f"{start_dt.date()} → {end_dt.date()}"
        )

        rates = mt5.copy_rates_range(symbol, MT5_TIMEFRAME_M1, start_dt, end_dt)

        if rates is None or len(rates) == 0:
            logger.warning(f"[{symbol}] No data from MT5: {mt5.last_error()}")
            return Path()

        df = pd.DataFrame(rates)

        # MT5 returns: time (unix), open, high, low, close, tick_volume, spread, real_volume
        # Convert time to milliseconds
        df["time"] = (df["time"] * 1000).astype("int64")

        # Use tick_volume as volume (real_volume often 0 for forex)
        if "real_volume" in df.columns:
            df["volume"] = df["real_volume"].where(df["real_volume"] > 0, df["tick_volume"])
        else:
            df["volume"] = df["tick_volume"]

        df = df[KEEP_COLS].copy()
        for col in ["open", "high", "low", "close", "volume"]:
            df[col] = df[col].astype("float64")

        df = df.drop_duplicates(subset=["time"]).sort_values("time").reset_index(drop=True)

        logger.info(
            f"[{symbol}] Total: {len(df):,} bars "
            f"({pd.Timestamp(df['time'].iloc[0], unit='ms')} → "
            f"{pd.Timestamp(df['time'].iloc[-1], unit='ms')})"
        )

        out_path = self._save_raw(df, symbol)
        return out_path

    def ingest_all(self, symbols: Optional[List[str]] = None) -> List[Path]:
        """Ingest all configured MT5 symbols."""
        if not self._connected:
            logger.warning("Not connected — attempting to connect...")
            if not self.connect():
                return []

        syms  = symbols or MT5_CONFIG.symbols
        paths = []

        for sym in syms:
            try:
                p = self.ingest_symbol(sym)
                if p:
                    paths.append(p)
            except Exception as e:
                logger.error(f"[{sym}] Failed: {e}")

        return paths

    def list_available_symbols(self) -> List[str]:
        """Return all symbols available in the connected MT5 terminal."""
        if not self._connected:
            return []
        syms = self._mt5.symbols_get()
        return [s.name for s in syms] if syms else []

    # ─── Internal ────────────────────────────────────────────────────────────

    def _save_raw(self, df: pd.DataFrame, symbol: str) -> Path:
        out_dir  = RAW_DIR / "mt5" / symbol / "1m"
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

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *args):
        self.disconnect()
