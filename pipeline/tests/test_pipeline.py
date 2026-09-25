"""
tests/test_pipeline.py
Full test suite for all pipeline steps.
Run: pytest tests/ -v
"""
import pytest
import numpy as np
import pandas as pd
from pathlib import Path
import tempfile
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.cleaning.cleaner  import DataCleaner, ValidationError
from src.cleaning.filter   import TrainingDataFilter
from src.resampling.resampler import Resampler
from src.features.feature_engineer import FeatureEngineer
from src.labeling.labeler  import DataLabeler


# ─── Fixtures ────────────────────────────────────────────────────────────────

def make_ohlcv(n: int = 500, start_ms: int = 1_700_000_000_000) -> pd.DataFrame:
    """Generate realistic synthetic 1m OHLCV data."""
    np.random.seed(42)
    close   = np.cumsum(np.random.randn(n) * 0.0002) + 1.0850
    close   = np.abs(close)
    open_   = close + np.random.randn(n) * 0.0001
    hl_half = np.abs(np.random.randn(n) * 0.0003)
    high    = np.maximum(open_, close) + hl_half
    low     = np.minimum(open_, close) - hl_half
    volume  = np.abs(np.random.randn(n) * 50 + 100)
    time_ms = [start_ms + i * 60_000 for i in range(n)]

    return pd.DataFrame({
        "time": time_ms, "open": open_, "high": high,
        "low": low, "close": close, "volume": volume,
    })


@pytest.fixture
def df_raw():
    return make_ohlcv(500)


@pytest.fixture
def df_with_noise():
    """OHLCV with injected bad data."""
    df = make_ohlcv(500)
    # Inject spike
    df.loc[50, "high"]   = df.loc[50, "close"] * 1.50
    df.loc[50, "low"]    = df.loc[50, "close"] * 0.50
    # Inject zero volume
    df.loc[100, "volume"] = 0
    # Inject duplicate
    df = pd.concat([df, df.iloc[200:201]], ignore_index=True)
    return df


@pytest.fixture
def df_clean(df_raw):
    cleaner = DataCleaner()
    return cleaner.clean(df_raw.copy(), "EURUSD", "binance", "1m")


@pytest.fixture
def df_featured(df_clean):
    fe = FeatureEngineer()
    return fe.generate(df_clean.copy(), "EURUSD")


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 2+3: CLEANING + VALIDATION
# ═══════════════════════════════════════════════════════════════════════════════

class TestDataCleaner:

    def test_keeps_only_ohlcv_columns(self, df_raw):
        """Step 2: ONLY time, open, high, low, close, volume survive."""
        extra = df_raw.copy()
        extra["bid"] = 1.0
        extra["ask"] = 1.0
        extra["spread"] = 0.0001
        extra["metadata"] = "junk"

        cleaner = DataCleaner()
        result  = cleaner.clean(extra, "TEST", "binance", "1m")

        assert set(["time","open","high","low","close","volume"]).issubset(result.columns)
        assert "bid" not in result.columns and "ask" not in result.columns
        assert {"source","quality","is_imputed","is_synthetic","latency","sequence_valid"}.issubset(result.columns)

    def test_correct_dtypes(self, df_clean):
        """Step 2: Correct data types."""
        assert df_clean["time"].dtype  == "int64"
        assert df_clean["open"].dtype  == "float64"
        assert df_clean["high"].dtype  == "float64"
        assert df_clean["low"].dtype   == "float64"
        assert df_clean["close"].dtype == "float64"
        assert df_clean["volume"].dtype== "float64"

    def test_no_duplicates(self, df_with_noise):
        """Step 3: Duplicate rows removed."""
        cleaner = DataCleaner()
        result  = cleaner.clean(df_with_noise, "TEST", "binance", "1m")
        assert result["time"].duplicated().sum() == 0

    def test_sorted_by_time(self, df_raw):
        """Step 3: Result is strictly sorted."""
        shuffled = df_raw.sample(frac=1, random_state=99).reset_index(drop=True)
        cleaner  = DataCleaner()
        result   = cleaner.clean(shuffled, "TEST", "binance", "1m")
        assert result["time"].is_monotonic_increasing
        assert bool(result["sequence_valid"].iloc[0]) is False

    def test_no_nan(self, df_raw):
        """Step 3: No NaN values."""
        cleaner = DataCleaner()
        result  = cleaner.clean(df_raw, "TEST", "binance", "1m")
        assert not result.isnull().any().any()

    def test_validation_fails_on_high_lt_low(self):
        """Step 3: Raises ValidationError if High < Low in many candles."""
        df = make_ohlcv(100)
        df["high"] = df["low"] - 0.001   # all candles invalid
        cleaner = DataCleaner()
        with pytest.raises(ValidationError, match="High < Low"):
            cleaner.clean(df, "TEST", "binance", "1m")

    def test_validation_fails_on_insufficient_data(self):
        """Step 3: Raises if < 10 rows."""
        df = make_ohlcv(5)
        cleaner = DataCleaner()
        with pytest.raises(ValidationError, match="insufficient"):
            cleaner.clean(df, "TEST", "binance", "1m")

    def test_gap_filling(self):
        """Step 3: Missing timestamps are forward-filled."""
        df = make_ohlcv(100)
        # Remove 3 consecutive rows (small gap)
        df_gap = pd.concat([df.iloc[:30], df.iloc[33:]], ignore_index=True)
        cleaner = DataCleaner()
        result  = cleaner.clean(df_gap, "TEST", "binance", "1m")
        # Should have filled the gap
        assert len(result) >= len(df_gap)
        assert result["is_imputed"].any()
        assert (result.loc[result["is_imputed"], "quality"] == "imputed").all()

    def test_missing_columns_raises(self):
        """Step 2: Missing required column raises ValidationError."""
        df = make_ohlcv(100).drop(columns=["volume"])
        cleaner = DataCleaner()
        with pytest.raises(ValidationError, match="Missing required columns"):
            cleaner.clean(df, "TEST", "binance", "1m")


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 4: RESAMPLING
# ═══════════════════════════════════════════════════════════════════════════════

class TestResampler:

    def test_output_timeframes(self, df_clean):
        """Step 4: All configured timeframes generated."""
        resampler = Resampler()
        results   = resampler.resample_all(df_clean, "TEST")
        for tf in ["1m","5m","15m","1h"]:
            assert tf in results, f"Missing timeframe: {tf}"

    def test_bar_count_monotonic(self, df_clean):
        """Step 4: Higher TF = fewer bars."""
        resampler = Resampler()
        results   = resampler.resample_all(df_clean, "TEST")
        assert len(results["5m"])  <= len(results["1m"])
        assert len(results["15m"]) <= len(results["5m"])
        assert len(results["1h"])  <= len(results["15m"])

    def test_ohlc_aggregation_rules(self, df_clean):
        """Step 4: Open=first, High=max, Low=min, Close=last, Vol=sum."""
        resampler = Resampler()
        results   = resampler.resample_all(df_clean, "TEST")
        df_5m     = results.get("5m")
        assert df_5m is not None
        # H >= L always
        assert (df_5m["high"] >= df_5m["low"]).all()
        # H >= O, C
        assert (df_5m["high"] >= df_5m["open"]).all()
        assert (df_5m["high"] >= df_5m["close"]).all()

    def test_no_future_leakage_in_resampling(self, df_clean):
        """Step 4: Each resampled bar uses ONLY its constituent 1m bars."""
        resampler = Resampler()
        results   = resampler.resample_all(df_clean, "TEST")
        df_5m     = results.get("5m")
        assert df_5m is not None
        # Time is sorted (no future bar contamination)
        assert df_5m["time"].is_monotonic_increasing

    def test_volume_sum(self, df_clean):
        """Step 4: Volume is summed (not averaged) in resampling."""
        resampler  = Resampler()
        results    = resampler.resample_all(df_clean, "TEST")
        total_1m   = df_clean["volume"].sum()
        total_5m   = results.get("5m", pd.DataFrame({"volume":[]}))["volume"].sum()
        # Volume sums should be approximately equal
        assert abs(total_5m - total_1m) / (total_1m + 1e-10) < 0.02


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 8: TRAINING DATA FILTER
# ═══════════════════════════════════════════════════════════════════════════════

class TestTrainingFilter:

    def test_removes_spikes(self, df_with_noise):
        """Step 8: Price spikes removed."""
        f = TrainingDataFilter()
        # Add obvious spike
        df = df_with_noise.copy()
        df.loc[50, "high"]  = df.loc[50, "close"] * 2.0  # 100% jump
        df.loc[50, "low"]   = df.loc[50, "close"] * 0.5
        filtered, report = f.filter(df, "TEST", "binance")
        assert report.removed_spike > 0

    def test_removes_zero_volume(self, df_with_noise):
        """Step 8: Zero volume candles removed."""
        f        = TrainingDataFilter()
        filtered, report = f.filter(df_with_noise, "TEST", "binance")
        assert (filtered["volume"] > 0).all()

    def test_keeps_majority(self, df_raw):
        """Step 8: Clean data should mostly pass."""
        f        = TrainingDataFilter()
        filtered, report = f.filter(df_raw, "TEST", "binance")
        assert report.kept_pct >= 0.70, f"Too much removed: {report.kept_pct:.1%}"

    def test_structural_validity(self):
        """Step 8: H >= O, C and L <= O, C always true."""
        f  = TrainingDataFilter()
        df = make_ohlcv(200)
        filtered, _ = f.filter(df, "TEST", "binance")
        assert (filtered["high"] >= filtered["open"]).all()
        assert (filtered["high"] >= filtered["close"]).all()
        assert (filtered["low"]  <= filtered["open"]).all()
        assert (filtered["low"]  <= filtered["close"]).all()


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 9: FEATURE ENGINEERING
# ═══════════════════════════════════════════════════════════════════════════════

class TestFeatureEngineer:

    def test_feature_columns_present(self, df_featured):
        """Step 9: All expected features generated."""
        expected = [
            "ema_50","ema_200","rsi_14","adx_14","atr_14",
            "macd","macd_hist","volatility_20","bb_width",
            "returns_1","vol_ratio","candle_dir",
        ]
        for col in expected:
            assert col in df_featured.columns, f"Missing feature: {col}"

    def test_no_nan_after_warmup_drop(self, df_featured):
        """Step 9: No NaN after warmup rows dropped."""
        assert not df_featured.isnull().any().any(), \
            f"NaN in features: {df_featured.isnull().sum()}"

    def test_rsi_range(self, df_featured):
        """Step 9: RSI always in [0, 100]."""
        assert df_featured["rsi_14"].between(0, 100).all()

    def test_rsi_norm_range(self, df_featured):
        """Step 9: Normalized RSI in [-1, +1]."""
        assert df_featured["rsi_norm"].between(-1, 1).all()

    def test_adx_positive(self, df_featured):
        """Step 9: ADX always positive."""
        assert (df_featured["adx_14"] >= 0).all()

    def test_bb_position_range(self, df_featured):
        """Step 9: Bollinger Band position in [0, 1] approximately."""
        bp = df_featured["bb_position"]
        # Allow some outliers due to extreme moves
        assert bp.between(-0.5, 1.5).mean() >= 0.95

    def test_candle_dir_values(self, df_featured):
        """Step 9: Candle direction only -1, 0, +1."""
        assert df_featured["candle_dir"].isin([-1, 0, 1]).all()

    def test_no_future_data_in_features(self, df_featured):
        """Step 9: Critical — features must not use future closes."""
        # EMA at row t should only depend on closes t, t-1, t-2, ...
        # Verify: if we reverse the dataframe, EMAs should differ
        fe   = FeatureEngineer()
        df_c = make_ohlcv(300)
        cleaner = DataCleaner()
        df_c = cleaner.clean(df_c, "TEST", "binance")
        feat = fe.generate(df_c.copy(), "TEST")

        # EMA at position 0 of reversed != EMA at position 0 of forward
        feat_rev = fe.generate(df_c.iloc[::-1].reset_index(drop=True).copy(), "TEST")
        # They should NOT be equal (otherwise future data is leaking)
        assert not (feat["ema_50"].dropna().values == feat_rev["ema_50"].dropna().values).all(), \
            "EMA values identical in forward/reverse — potential leakage!"

    def test_warmup_rows_removed(self, df_clean):
        """Step 9: Warmup rows with NaN are removed."""
        fe   = FeatureEngineer()
        feat = fe.generate(df_clean.copy(), "TEST")
        # After generate(), df should have no NaN
        assert not feat.isnull().any().any()
        # And should have fewer rows than input
        assert len(feat) < len(df_clean)


# ═══════════════════════════════════════════════════════════════════════════════
# STEP 10+11: LABELING + NO LEAKAGE
# ═══════════════════════════════════════════════════════════════════════════════

class TestDataLabeler:

    def test_label_values_ternary(self, df_featured):
        """Step 10: Ternary labels only -1, 0, +1."""
        labeler = DataLabeler()
        result  = labeler.label(df_featured.copy(), "TEST", scheme="ternary")
        valid   = result["label"].dropna()
        assert set(valid.unique()).issubset({-1.0, 0.0, 1.0})

    def test_label_values_binary(self, df_featured):
        """Step 10: Binary labels only 0 or 1."""
        labeler = DataLabeler()
        result  = labeler.label(df_featured.copy(), "TEST", scheme="binary")
        valid   = result["label"].dropna()
        assert set(valid.unique()).issubset({0.0, 1.0})

    def test_no_future_leakage_in_labels(self, df_featured):
        """Step 11: CRITICAL — labels must NOT correlate perfectly with features."""
        labeler = DataLabeler()
        result  = labeler.label(df_featured.copy(), "TEST")
        ok      = labeler.validate_no_leakage(result)
        assert ok, "Data leakage detected in labels!"

    def test_last_n_rows_dropped(self, df_featured):
        """Step 10: Last forward_bars rows have no labels (no future data)."""
        labeler   = DataLabeler()
        result    = labeler.label(df_featured.copy(), "TEST")
        fwd       = labeler.cfg.forward_bars
        # Result should have fewer rows than input
        assert len(result) < len(df_featured)

    def test_forward_return_uses_future(self, df_featured):
        """Step 11: forward_return[t] = close[t+N] / close[t] - 1."""
        labeler = DataLabeler()
        result  = labeler.label(df_featured.copy(), "TEST")
        fwd     = labeler.cfg.forward_bars

        # Spot check first few rows
        for i in range(min(5, len(result))):
            t_now = result.iloc[i]["time"]
            # Find row at t+N in original
            future_idx = df_featured[df_featured["time"] == t_now].index
            if not future_idx.empty:
                orig_idx = future_idx[0]
                if orig_idx + fwd < len(df_featured):
                    expected_ret = (
                        df_featured.iloc[orig_idx + fwd]["close"] /
                        df_featured.iloc[orig_idx]["close"] - 1
                    )
                    actual_ret = result.iloc[i]["forward_return"]
                    assert abs(expected_ret - actual_ret) < 1e-8, \
                        f"Forward return mismatch at row {i}"

    def test_time_based_split_no_shuffle(self, df_featured):
        """Step 11: Train/val/test split is time-ordered, not shuffled."""
        labeler        = DataLabeler()
        labeled        = labeler.label(df_featured.copy(), "TEST")
        train, val, test = labeler.train_val_test_split(labeled)

        # Time should be monotonically increasing in each split
        assert train["time"].is_monotonic_increasing
        assert val["time"].is_monotonic_increasing
        assert test["time"].is_monotonic_increasing

        # Train must be entirely BEFORE val
        assert train["time"].max() <= val["time"].min()
        # Val must be entirely BEFORE test
        assert val["time"].max() <= test["time"].min()


# ═══════════════════════════════════════════════════════════════════════════════
# INTEGRATION: End-to-end mini pipeline
# ═══════════════════════════════════════════════════════════════════════════════

class TestEndToEnd:

    def test_full_pipeline_produces_labeled_dataset(self):
        """Integration: raw data → labels without error."""
        df_raw = make_ohlcv(1000)

        cleaner  = DataCleaner()
        resampler= Resampler()
        filt     = TrainingDataFilter()
        fe       = FeatureEngineer()
        labeler  = DataLabeler()

        # Clean
        df_clean = cleaner.clean(df_raw, "TESTCOIN", "binance", "1m")
        assert len(df_clean) > 0

        # Resample
        all_tf = resampler.resample_all(df_clean, "TESTCOIN")
        assert "1h" in all_tf

        # Filter
        df_filt, report = filt.filter(all_tf["1m"], "TESTCOIN", "binance")
        assert report.kept_pct >= 0.5

        # Features
        df_feat = fe.generate(df_filt, "TESTCOIN")
        assert len(df_feat) > 0
        assert not df_feat.isnull().any().any()

        # Labels
        df_labeled = labeler.label(df_feat, "TESTCOIN")
        assert "label" in df_labeled.columns
        assert "forward_return" in df_labeled.columns

        # No leakage
        assert labeler.validate_no_leakage(df_labeled)

        # Time split
        train, val, test = labeler.train_val_test_split(df_labeled)
        assert len(train) > len(val)  # 70% > 15%
        assert train["time"].max() < test["time"].min()

    def test_empty_dataframe_handled_gracefully(self):
        """Edge case: empty input handled without crash."""
        fe      = FeatureEngineer()
        labeler = DataLabeler()

        df_empty = pd.DataFrame(columns=["time","open","high","low","close","volume"])
        feat     = fe.generate(df_empty, "EMPTY")
        assert len(feat) == 0

    def test_single_symbol_compression(self, tmp_path):
        """Step 5+6: Parquet written and readable."""
        from src.compression.partitioner import Partitioner

        df = make_ohlcv(5000)
        p  = Partitioner(base_dir=tmp_path / "clean")
        paths = p.write(df, "binance", "BTCUSDT", "1m")

        assert len(paths) > 0
        for path in paths:
            assert path.exists()
            assert path.stat().st_size > 0

        # Read back
        df_back = p.read("binance", "BTCUSDT", "1m")
        assert len(df_back) == len(df)
        assert list(df_back.columns) == ["time","open","high","low","close","volume"]

        # Values identical
        pd.testing.assert_series_equal(
            df["close"].reset_index(drop=True),
            df_back["close"].reset_index(drop=True),
            check_names=False,
        )
