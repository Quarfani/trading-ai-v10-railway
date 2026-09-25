"""
Yahoo Finance Ingestor — Fallback for MT5 symbols when terminal unavailable.
Fetches OHLCV data for Forex, Metals, Indices.
"""
import time
import pandas as pd
import requests
from pathlib import Path
from typing import Optional

from src.config import RAW_DIR, COLLECT_YEARS
from src.utils.logger import get_logger
from src.utils.time_utils import date_range_ms

logger = get_logger("YahooIngestor")

YAHOO_MAP = {
    "EURUSD":"EURUSD=X","GBPUSD":"GBPUSD=X","USDJPY":"JPY=X",
    "AUDUSD":"AUDUSD=X","USDCAD":"CAD=X","USDCHF":"CHF=X",
    "NZDUSD":"NZDUSD=X","EURGBP":"EURGBP=X","EURJPY":"EURJPY=X",
    "GBPJPY":"GBPJPY=X","XAUUSD":"GC=F","XAGUSD":"SI=F",
    "US30":"YM=F","SPX500":"ES=F","NAS100":"NQ=F","GER40":"GDAXI",
}

KEEP_COLS = ["time","open","high","low","close","volume"]


class YahooIngestor:
    """Fetches H1 or D1 data from Yahoo Finance as MT5 fallback."""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "Mozilla/5.0"

    def fetch(self, symbol: str, years: int = COLLECT_YEARS) -> Optional[pd.DataFrame]:
        ticker = YAHOO_MAP.get(symbol.upper())
        if not ticker:
            logger.warning(f"[{symbol}] No Yahoo mapping found")
            return None

        start_ms, end_ms = date_range_ms(years)
        start_s  = start_ms // 1000
        end_s    = end_ms   // 1000

        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        try:
            resp = self.session.get(url, params={
                "period1": start_s, "period2": end_s, "interval": "1h"
            }, timeout=15)
            resp.raise_for_status()
            result = resp.json()["chart"]["result"][0]
            ts     = result["timestamp"]
            q      = result["indicators"]["quote"][0]

            df = pd.DataFrame({
                "time":   [t * 1000 for t in ts],
                "open":   q["open"],
                "high":   q["high"],
                "low":    q["low"],
                "close":  q["close"],
                "volume": q.get("volume", [0]*len(ts)),
            })
            df = df.dropna(subset=["close"])
            for col in ["open","high","low","close","volume"]:
                df[col] = df[col].astype("float64")
            df["time"] = df["time"].astype("int64")
            df = df[KEEP_COLS].sort_values("time").reset_index(drop=True)

            # Save raw
            out = RAW_DIR / "mt5" / symbol / "1m"
            out.mkdir(parents=True, exist_ok=True)
            df.to_parquet(out / "raw.parquet", compression="zstd", index=False)

            logger.info(f"[{symbol}] Yahoo: {len(df):,} bars (H1 → stored as 1h)")
            return df

        except Exception as e:
            logger.error(f"[{symbol}] Yahoo fetch failed: {e}")
            return None
