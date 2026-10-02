"""
tests/test_models.py — Model unit tests (no ML dependencies required)
"""
import pytest
import numpy as np
import pandas as pd
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.models.base_model import BaseModel, PredictResult, FEATURE_COLS


def make_xy(n=200):
    np.random.seed(0)
    X = np.random.randn(n, len(FEATURE_COLS)).astype("float32")
    y = np.random.choice([-1, 0, 1], size=n).astype("int32")
    return X, y


def make_labeled_df(n=300):
    np.random.seed(0)
    df = pd.DataFrame(
        np.random.randn(n, len(FEATURE_COLS)),
        columns=FEATURE_COLS
    )
    df["time"]           = np.arange(n) * 3_600_000
    df["close"]          = 1.08 + np.cumsum(np.random.randn(n) * 0.0001)
    df["label"]          = np.random.choice([-1, 0, 1], size=n).astype("float32")
    df["forward_return"] = np.random.randn(n) * 0.002
    return df


class TestBaseModelInterface:

    def test_prepare_xy_shapes(self):
        df = make_labeled_df(100)
        X, y = BaseModel.prepare_xy(df)
        assert X.shape[0] == len(df)
        assert X.shape[1] == len(FEATURE_COLS)
        assert y.shape[0] == len(df)

    def test_prepare_xy_rejects_nan(self):
        df = make_labeled_df(100)
        df.iloc[10, 0] = np.nan  # inject NaN
        with pytest.raises(ValueError, match="NaN|infinite"):
            BaseModel.prepare_xy(df)

    def test_prepare_xy_dtypes(self):
        df = make_labeled_df(100)
        X, y = BaseModel.prepare_xy(df)
        assert X.dtype == np.float32
        assert y.dtype == np.int32

    def test_evaluate_rejects_empty_dataset(self):
        class DummyModel(BaseModel):
            name = "dummy"

            def train(self, X_train, y_train, X_val, y_val):
                raise NotImplementedError

            def predict_proba(self, X):
                return np.tile(np.asarray([[0.2, 0.5, 0.3]]), (len(X), 1))

            def save(self):
                raise NotImplementedError

            def load(self):
                return False

        model = DummyModel("TEST", "1h")
        with pytest.raises(ValueError, match="evaluation"):
            model.evaluate(np.empty((0, len(FEATURE_COLS))), np.empty((0,), dtype="int32"))

    def test_evaluate_rejects_invalid_label(self):
        class DummyModel(BaseModel):
            name = "dummy2"

            def train(self, X_train, y_train, X_val, y_val):
                raise NotImplementedError

            def predict_proba(self, X):
                return np.tile(np.asarray([[0.2, 0.5, 0.3]]), (len(X), 1))

            def save(self):
                raise NotImplementedError

            def load(self):
                return False

        model = DummyModel("TEST", "1h")
        X = np.zeros((2, len(FEATURE_COLS)), dtype="float32")
        y = np.asarray([-1, 7], dtype="int32")
        with pytest.raises(ValueError, match="evaluation"):
            model.evaluate(X, y)

    def test_predict_result_signal(self):
        r = PredictResult(
            buy_prob=0.60, sell_prob=0.25, hold_prob=0.15,
            label=1, confidence=0.60, model_name="test", latency_ms=1.0
        )
        assert r.signal == "BUY"
        assert r.to_dict()["signal"] == "BUY"
        assert r.to_dict()["confidence"] == 0.60

    def test_predict_result_sell(self):
        r = PredictResult(
            buy_prob=0.15, sell_prob=0.70, hold_prob=0.15,
            label=-1, confidence=0.70, model_name="test", latency_ms=1.0
        )
        assert r.signal == "SELL"

    def test_predict_result_hold(self):
        r = PredictResult(
            buy_prob=0.33, sell_prob=0.33, hold_prob=0.34,
            label=0, confidence=0.34, model_name="test", latency_ms=1.0
        )
        assert r.signal == "HOLD"


class TestXGBoostModel:

    def test_train_and_predict(self, tmp_path):
        try:
            import xgboost
        except ImportError:
            pytest.skip("xgboost not installed")

        from src.models.xgboost_model import XGBoostModel

        X_train, y_train = make_xy(300)
        X_val,   y_val   = make_xy(80)

        model = XGBoostModel("TEST", "1h")
        model.model_dir = tmp_path / "xgb"
        model.model_dir.mkdir(parents=True)
        model.params["n_estimators"] = 50  # fast for tests

        result = model.train(X_train, y_train, X_val, y_val)

        assert result.accuracy > 0
        assert result.accuracy <= 1.0
        assert result.train_samples == 300
        assert result.val_samples   == 80
        assert isinstance(result.feature_importance, dict)

    def test_predict_shape(self, tmp_path):
        try:
            import xgboost
        except ImportError:
            pytest.skip("xgboost not installed")

        from src.models.xgboost_model import XGBoostModel

        X_train, y_train = make_xy(200)
        X_val,   y_val   = make_xy(50)

        model = XGBoostModel("TEST", "1h")
        model.model_dir = tmp_path / "xgb2"
        model.model_dir.mkdir(parents=True)
        model.params["n_estimators"] = 30

        model.train(X_train, y_train, X_val, y_val)
        proba = model.predict_proba(X_val)

        assert proba.shape == (len(X_val), 3)
        assert np.allclose(proba.sum(axis=1), 1.0, atol=1e-5)

    def test_predict_label_in_range(self, tmp_path):
        try:
            import xgboost
        except ImportError:
            pytest.skip("xgboost not installed")

        from src.models.xgboost_model import XGBoostModel

        X_train, y_train = make_xy(200)
        X_val,   y_val   = make_xy(50)

        model = XGBoostModel("TEST", "1h")
        model.model_dir = tmp_path / "xgb3"
        model.model_dir.mkdir(parents=True)
        model.params["n_estimators"] = 30

        model.train(X_train, y_train, X_val, y_val)
        result = model.predict(X_val[:1])

        assert result.label in [-1, 0, 1]
        assert 0.0 <= result.confidence <= 1.0
        assert result.latency_ms >= 0

    def test_save_load(self, tmp_path):
        try:
            import xgboost
        except ImportError:
            pytest.skip("xgboost not installed")

        from src.models.xgboost_model import XGBoostModel

        X_train, y_train = make_xy(200)
        X_val,   y_val   = make_xy(50)

        m1 = XGBoostModel("TEST", "1h")
        m1.model_dir = tmp_path / "xgb_save"
        m1.model_dir.mkdir(parents=True)
        m1.params["n_estimators"] = 30
        m1.train(X_train, y_train, X_val, y_val)
        proba1 = m1.predict_proba(X_val[:5])

        m2 = XGBoostModel("TEST", "1h")
        m2.model_dir = tmp_path / "xgb_save"
        ok = m2.load()
        assert ok
        proba2 = m2.predict_proba(X_val[:5])

        np.testing.assert_allclose(proba1, proba2, atol=1e-5)

    def test_load_rejects_missing_scaler(self, tmp_path):
        try:
            import xgboost
        except ImportError:
            pytest.skip("xgboost not installed")

        from src.models.xgboost_model import XGBoostModel

        X_train, y_train = make_xy(200)
        X_val, y_val = make_xy(50)

        model = XGBoostModel("TEST", "1h")
        model.model_dir = tmp_path / "xgb_missing_scaler"
        model.model_dir.mkdir(parents=True)
        model.params["n_estimators"] = 20
        model.train(X_train, y_train, X_val, y_val)

        (model.model_dir / "scaler.pkl").unlink()

        reloaded = XGBoostModel("TEST", "1h")
        reloaded.model_dir = model.model_dir
        assert not reloaded.load()

    def test_load_rejects_checksum_corruption(self, tmp_path):
        try:
            import xgboost
        except ImportError:
            pytest.skip("xgboost not installed")

        from src.models.xgboost_model import XGBoostModel

        X_train, y_train = make_xy(200)
        X_val, y_val = make_xy(50)

        model = XGBoostModel("TEST", "1h")
        model.model_dir = tmp_path / "xgb_corrupt_meta"
        model.model_dir.mkdir(parents=True)
        model.params["n_estimators"] = 20
        model.train(X_train, y_train, X_val, y_val)

        import json
        meta_path = model.model_dir / "meta.json"
        meta = json.loads(meta_path.read_text())
        meta["checksum"] = "000000000000"
        meta_path.write_text(json.dumps(meta))

        reloaded = XGBoostModel("TEST", "1h")
        reloaded.model_dir = model.model_dir
        assert not reloaded.load()

    def test_evaluate_returns_correct_structure(self, tmp_path):
        try:
            import xgboost
        except ImportError:
            pytest.skip("xgboost not installed")

        from src.models.xgboost_model import XGBoostModel

        X_train, y_train = make_xy(200)
        X_val,   y_val   = make_xy(50)

        model = XGBoostModel("TEST", "1h")
        model.model_dir = tmp_path / "xgb_eval"
        model.model_dir.mkdir(parents=True)
        model.params["n_estimators"] = 30
        model.train(X_train, y_train, X_val, y_val)

        metrics = model.evaluate(X_val, y_val)

        assert "accuracy"  in metrics
        assert "precision" in metrics
        assert "recall"    in metrics
        assert "f1"        in metrics
        assert 0.0 <= metrics["accuracy"] <= 1.0
        for cls in ["-1", "0", "1"]:
            assert cls in metrics["f1"]

    def test_online_update(self, tmp_path):
        try:
            import xgboost
        except ImportError:
            pytest.skip("xgboost not installed")

        from src.models.xgboost_model import XGBoostModel

        X_train, y_train = make_xy(200)
        X_val,   y_val   = make_xy(50)
        X_new,   y_new   = make_xy(30)

        model = XGBoostModel("TEST", "1h")
        model.model_dir = tmp_path / "xgb_online"
        model.model_dir.mkdir(parents=True)
        model.params["n_estimators"] = 30
        model.train(X_train, y_train, X_val, y_val)

        ok = model.online_update(X_new, y_new)
        assert ok  # XGBoost supports incremental learning
        meta = model.load_meta()
        assert meta.get("checksum") == model._model_checksum()


class TestEnsembleSafety:

    def test_ensemble_predict_holds_when_all_submodels_fail(self):
        from src.models.ensemble_model import EnsembleModel

        ensemble = EnsembleModel("TEST", "1h", use_lstm=False)
        ensemble._trained = True
        ensemble._trained_models = ["xgboost"]
        ensemble._weights = {"xgboost": 1.0}

        def fail_predict(_X):
            raise ValueError("corrupt probability output")

        ensemble.xgb.predict_proba = fail_predict

        X = np.zeros((1, len(FEATURE_COLS)), dtype="float32")
        result = ensemble.predict(X)

        assert result.label == 0
        assert result.hold_prob == 1.0
        assert result.confidence == 1.0

    def test_ensemble_predict_ignores_invalid_submodel_and_uses_valid_one(self):
        from src.models.ensemble_model import EnsembleModel

        ensemble = EnsembleModel("TEST", "1h", use_lstm=False)
        ensemble._trained = True
        ensemble._trained_models = ["xgboost"]
        ensemble._weights = {"xgboost": 1.0}
        ensemble.xgb.predict_proba = lambda _X: np.asarray([[0.1, 0.2, 0.7]])

        X = np.zeros((1, len(FEATURE_COLS)), dtype="float32")
        result = ensemble.predict(X)

        assert result.label == 1
        assert abs(result.buy_prob - 0.7) < 1e-12
        assert abs(result.confidence - 0.7) < 1e-12


    def test_ensemble_load_rejects_config_fingerprint_corruption(self, tmp_path):
        from src.models.ensemble_model import EnsembleModel

        ensemble = EnsembleModel("TEST", "1h", use_lstm=False)
        ensemble.model_dir = tmp_path / "ensemble"
        ensemble.model_dir.mkdir(parents=True)
        ensemble._weights = {"xgboost": 1.0}
        ensemble._trained_models = ["xgboost"]
        ensemble.confidence_min = 0.55
        ensemble.disagreement_penalty = 0.10

        import json
        payload = {
            "model": "ensemble",
            "symbol": "TEST",
            "timeframe": "1h",
            "feature_cols": FEATURE_COLS,
            "weights": {"xgboost": 1.0},
            "trained_models": ["xgboost"],
            "confidence_min": 0.55,
            "disagreement_penalty": 0.10,
        }
        payload["fingerprint"] = ensemble._config_fingerprint(payload)
        (ensemble.model_dir / "ensemble_config.json").write_text(json.dumps(payload))

        loaded = json.loads((ensemble.model_dir / "ensemble_config.json").read_text())
        loaded["symbol"] = "OTHER"
        (ensemble.model_dir / "ensemble_config.json").write_text(json.dumps(loaded))

        assert not ensemble.load()


class TestModelServer:

    def test_server_singleton(self):
        from src.serving.model_server import get_server, ModelServer
        s1 = get_server()
        s2 = get_server()
        assert s1 is s2

    def test_status_empty(self):
        from src.serving.model_server import ModelServer
        server = ModelServer()
        status = server.status()
        assert "loaded_models"  in status
        assert "stats"          in status
        assert "buffer_sizes"   in status

    def test_predict_no_model_returns_none(self):
        from src.serving.model_server import ModelServer
        server  = ModelServer()
        df      = pd.DataFrame([dict(zip(FEATURE_COLS, np.random.randn(len(FEATURE_COLS))))])
        result  = server.predict_signal("UNKNOWN", "1h", df)
        assert result is None

    def test_record_trade_closed(self, tmp_path):
        try:
            import xgboost
        except ImportError:
            pytest.skip("xgboost not installed")

        from src.serving.model_server import ModelServer
        from src.models.xgboost_model import XGBoostModel

        X_train, y_train = make_xy(200)
        X_val,   y_val   = make_xy(50)

        model = XGBoostModel("TEST", "1h")
        model.model_dir = tmp_path / "xgb_srv"
        model.model_dir.mkdir(parents=True)
        model.params["n_estimators"] = 30
        model.train(X_train, y_train, X_val, y_val)

        server = ModelServer()
        server._models["TEST/1h"]   = model
        server._buffers["TEST/1h"]  = []
        server._outcomes["TEST/1h"] = []
        server._stats["TEST/1h"]    = {"predictions": 0, "online_updates": 0,
                                       "last_accuracy": 0.5, "loaded_at": ""}

        server.record_trade_closed("TEST", "1h", X_val[0], profit=100.0, signal=1)
        server.record_trade_closed("TEST", "1h", X_val[1], profit=-50.0, signal=1)

        # Online learning is disabled by default in unit tests, so features
        # must not accumulate in the training buffer just for audit purposes.
        assert len(server._buffers["TEST/1h"]) == 0
        assert len(server._outcomes["TEST/1h"]) == 2
        assert server._outcomes["TEST/1h"][0]["actual_label"] == 1
        assert server._outcomes["TEST/1h"][1]["actual_label"] == -1


    def test_record_prediction_outcome_tracks_true_accuracy_and_deduplicates(self):
        from src.serving.model_server import ModelServer

        server = ModelServer()
        server._buffers["TEST/1h"] = []
        server._outcomes["TEST/1h"] = []
        server._stats["TEST/1h"] = {
            "predictions": 0,
            "last_accuracy": None,
            "online_updates": 0,
            "loaded_at": "",
        }

        server.record_prediction_outcome(
            "TEST", "1h", "pred-1", predicted_signal=1, actual_label=1, profit=10.0
        )
        server.record_prediction_outcome(
            "TEST", "1h", "pred-1", predicted_signal=1, actual_label=1, profit=10.0
        )
        server.record_prediction_outcome(
            "TEST", "1h", "pred-2", predicted_signal=-1, actual_label=1, profit=-5.0
        )

        assert len(server._outcomes["TEST/1h"]) == 2
        assert server._outcomes["TEST/1h"][0]["correct"] is True
        assert server._outcomes["TEST/1h"][1]["correct"] is False
class TestTrainingReport:

    def test_report_to_json(self, tmp_path):
        from src.training.trainer import TrainingReport, WalkForwardFold

        report = TrainingReport(
            symbol="BTCUSDT", timeframe="1h", model_name="xgboost",
            total_samples=5000, train_samples=3500, val_samples=750, test_samples=750,
            test_accuracy=0.578, test_majority_baseline=0.52,
            test_f1_buy=0.55, test_f1_sell=0.49, test_f1_hold=0.60,
            wf_folds=[
                WalkForwardFold(1,"2023-01","2023-06","2023-07","2023-09",0.55,0.52,0.48),
                WalkForwardFold(2,"2023-01","2023-09","2023-10","2023-12",0.57,0.54,0.50),
            ],
            wf_mean_accuracy=0.56, wf_std_accuracy=0.01,
            recommendation="DEPLOY ✅",
        )

        path = tmp_path / "report.json"
        report.to_json(path)
        assert path.exists()

        import json
        with open(path) as f:
            data = json.load(f)
        assert data["symbol"] == "BTCUSDT"
        assert data["test_accuracy"] == 0.578
        assert len(data["wf_folds"]) == 2
        assert data["recommendation"] == "DEPLOY ✅"
