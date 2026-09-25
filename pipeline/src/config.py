"""
config.py — Central Configuration
Trading Data Pipeline v1.0
All settings in one place. Override via environment variables or .env file.
"""
import os
from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Dict

# ─── Load .env FIRST — must happen before any os.getenv() call ───────────────
# FIX: .env was never loaded; all secrets resolved to "" or 0 silently.
try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env", override=False)
except ImportError:
    pass   # python-dotenv not installed; fall back to shell env vars

# ─── Base paths ───────────────────────────────────────────────────────────────

ROOT_DIR    = Path(__file__).parent.parent
DATA_DIR    = ROOT_DIR / "data"
LOG_DIR     = ROOT_DIR / "logs"
RAW_DIR     = DATA_DIR / "raw"
CLEAN_DIR   = DATA_DIR / "clean"          # partitioned Parquet files
FEATURE_DIR = DATA_DIR / "features"       # feature-engineered Parquet
LABEL_DIR   = DATA_DIR / "labels"         # labeled datasets
TEMP_DIR    = DATA_DIR / ".tmp"

# Create all directories
for d in [RAW_DIR, CLEAN_DIR, FEATURE_DIR, LABEL_DIR, TEMP_DIR, LOG_DIR]:
    d.mkdir(parents=True, exist_ok=True)


# ─── Markets & Symbols ────────────────────────────────────────────────────────

@dataclass
class MarketConfig:
    name:         str
    symbols:      List[str]
    base_tf:      str = "1m"              # always collect 1-minute
    session_open: int = 0                 # UTC hour
    session_close:int = 24


BINANCE_CONFIG = MarketConfig(
    name    = "binance",
    symbols = [
        "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT",
        "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT",
    ],
)

MT5_CONFIG = MarketConfig(
    name    = "mt5",
    symbols = [
        "EURUSD", "GBPUSD", "USDJPY", "AUDUSD",
        "USDCAD", "USDCHF", "NZDUSD", "EURGBP",
        "EURJPY", "GBPJPY",
        "XAUUSD", "XAGUSD",       # metals
        "US30", "NAS100", "SPX500", "GER40",  # indices
    ],
    session_open  = 0,
    session_close = 24,
)

ALL_MARKETS: Dict[str, MarketConfig] = {
    "binance": BINANCE_CONFIG,
    "mt5":     MT5_CONFIG,
}


# ─── Timeframes ───────────────────────────────────────────────────────────────

BASE_TIMEFRAME = "1m"

RESAMPLE_TIMEFRAMES = {
    "5m":  "5min",
    "15m": "15min",
    "1h":  "1h",
    "4h":  "4h",
}

ALL_TIMEFRAMES = [BASE_TIMEFRAME] + list(RESAMPLE_TIMEFRAMES.keys())


# ─── Data Ingestion ───────────────────────────────────────────────────────────

@dataclass
class BinanceConfig:
    base_url:   str = "https://api.binance.com"
    klines_ep:  str = "/api/v3/klines"
    limit:      int = 1000                # max per request
    rate_limit_sleep: float = 0.15       # seconds between requests


@dataclass
class MT5Config:
    login:        int   = int(os.getenv("MT5_LOGIN", "0"))
    password:     str   = os.getenv("MT5_PASSWORD", "")
    server:       str   = os.getenv("MT5_SERVER", "")
    timeout:      int   = 60_000
    path:         str   = os.getenv("MT5_PATH", "")  # path to terminal


BINANCE_CFG = BinanceConfig()
MT5_CFG     = MT5Config()


# ─── Data Collection Window ───────────────────────────────────────────────────

COLLECT_YEARS = int(os.getenv("COLLECT_YEARS", "2"))   # how many years back
COLLECT_START = None   # None = auto (COLLECT_YEARS ago), or "2023-01-01"
COLLECT_END   = None   # None = now


# ─── Cleaning Parameters ──────────────────────────────────────────────────────

@dataclass
class CleaningConfig:
    # Required columns — nothing else kept
    keep_columns: List[str] = field(default_factory=lambda: [
        "time", "open", "high", "low", "close", "volume"
    ])

    # Anomaly detection
    max_price_spike_pct: float = 0.20    # >20% change in 1 candle = spike
    min_volume:          float = 0.0     # volume must be >= this
    min_candles_per_day: int   = 100     # if fewer → low liquidity day

    # Gap filling
    max_gap_minutes:     int   = 5       # gaps > 5 min → fill with ffill
    fill_method:         str   = "ffill" # forward-fill

    # Session filters (MT5 forex: skip weekends)
    skip_weekends:       bool  = True
    weekend_days:        List[int] = field(default_factory=lambda: [5, 6])  # Sat=5, Sun=6


CLEANING_CFG = CleaningConfig()


# ─── Compression ──────────────────────────────────────────────────────────────

@dataclass
class CompressionConfig:
    format:      str = "parquet"
    compression: str = "zstd"           # ZSTD preferred
    row_group_size: int = 100_000       # rows per parquet row group
    use_dictionary: bool = True         # parquet dictionary encoding
    write_statistics: bool = True


COMPRESSION_CFG = CompressionConfig()


# ─── Filtering (Training Data Quality) ───────────────────────────────────────

@dataclass
class FilterConfig:
    # Spike detection
    max_price_spike_pct: float = 0.20   # >20% close-to-close jump = spike
    max_hl_ratio:        float = 0.10   # (high - low) / close > 10% = suspicious
    max_body_ratio:      float = 0.08   # |close - open| / close > 8% = suspicious

    # Volume filter
    min_volume:            float = 0.0   # volume must be >= 0
    min_volume_percentile: float = 0.05  # bottom 5% volume → exclude
    max_volume_percentile: float = 0.999 # top 0.1% volume → exclude (flash crash)

    # Spread proxy (for forex): skip high-spread candles
    max_spread_proxy_pct: float = 0.005  # (high - low) / close > 0.5% on M1

    # Liquidity: exclude overnight low-activity hours (only for FX)
    fx_skip_hours_utc: List[int] = field(default_factory=lambda: [21, 22, 23, 0])

    # Crypto: no session filter
    crypto_session_filter: bool = False


FILTER_CFG = FilterConfig()


# ─── Feature Engineering ─────────────────────────────────────────────────────

@dataclass
class FeatureConfig:
    # Indicators to compute
    rsi_period:    int   = 14
    ema_fast:      int   = 50
    ema_slow:      int   = 200
    adx_period:    int   = 14
    bb_period:     int   = 20
    bb_std:        float = 2.0
    atr_period:    int   = 14
    macd_fast:     int   = 12
    macd_slow:     int   = 26
    macd_signal:   int   = 9
    vol_window:    int   = 20    # rolling volatility window

    # Lookback: how many candles of history needed before first valid row
    min_warmup_bars: int = 210   # EMA200 needs 200 bars


FEATURE_CFG = FeatureConfig()


# ─── Labeling ─────────────────────────────────────────────────────────────────

@dataclass
class LabelConfig:
    # Forward-looking window for label
    forward_bars:     int   = 20         # look 20 bars ahead
    profit_threshold: float = 0.002      # 0.2% = profitable
    loss_threshold:   float = -0.002     # -0.2% = losing

    # Label scheme
    # "binary":     1 = profit, 0 = loss
    # "ternary":   +1 = BUY success, -1 = SELL success, 0 = neutral
    scheme:           str   = "ternary"

    # Strict no-leakage: labels use ONLY future closes, never indicators
    strict_no_leakage: bool = True


LABEL_CFG = LabelConfig()


# ─── Mega Upload ─────────────────────────────────────────────────────────────

@dataclass
class MegaConfig:
    email:         str  = os.getenv("MEGA_EMAIL", "")
    password:      str  = os.getenv("MEGA_PASSWORD", "")
    remote_root:   str  = os.getenv("MEGA_FOLDER", "/TradingData")
    enc_key:       str  = os.getenv("MEGA_ENC_KEY", "")
    retry_count:   int  = 3
    retry_sleep:   float = 5.0
    verify_checksum: bool = True
    upload_features: bool = True
    upload_labels:   bool = True
    upload_raw:      bool = False    # never upload raw


MEGA_CFG = MegaConfig()


# ─── Logging ─────────────────────────────────────────────────────────────────

LOG_LEVEL  = os.getenv("LOG_LEVEL", "INFO")
LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)-20s | %(message)s"
LOG_FILE   = LOG_DIR / "pipeline.log"


# ─── Performance ─────────────────────────────────────────────────────────────

MAX_WORKERS        = int(os.getenv("MAX_WORKERS", "1"))    # parallel downloads
CHUNK_SIZE_MB      = 15                                     # process in chunks — reduced for 4GB RAM devices
MEMORY_LIMIT_GB    = float(os.getenv("MEMORY_LIMIT_GB", "4.0"))

# ─── Model settings ───────────────────────────────────────────────────────────

@dataclass
class ModelConfig:
    min_confidence:        float = 0.55
    online_buffer_size:    int   = 50
    degradation_threshold: float = 0.48
    degradation_window:    int   = 100
    retrain_on_degrade:    bool  = True
    export_onnx:           bool  = False
    use_lstm:              bool  = False   # set True if TF/PyTorch installed

MODEL_CFG = ModelConfig()
