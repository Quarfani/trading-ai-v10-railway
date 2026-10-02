from src.training.trainer import ModelTrainer


def test_recommendation_requires_test_accuracy_to_clear_majority_baseline():
    trainer = ModelTrainer()

    deploy = trainer._recommend(0.58, 0.54, 0.55, 0.02)
    blocked = trainer._recommend(0.55, 0.54, 0.55, 0.02)

    assert deploy == "DEPLOY ✅"
    assert blocked.startswith("CAUTION")


def test_recommendation_uses_wfo_stability_thresholds():
    trainer = ModelTrainer()

    assert trainer._recommend(0.60, 0.54, 0.52, 0.02).startswith("CAUTION")
    assert trainer._recommend(0.60, 0.54, 0.50, 0.02).startswith("DO_NOT_DEPLOY")
    assert trainer._recommend(0.60, 0.54, 0.54, 0.07).startswith("CAUTION")


def test_recommendation_rejects_invalid_metrics():
    trainer = ModelTrainer()

    assert trainer._recommend(float('nan'), 0.54, 0.55, 0.02).startswith("DO_NOT_DEPLOY")
    assert trainer._recommend(0.60, float('nan'), 0.55, 0.02).startswith("DO_NOT_DEPLOY")
    assert trainer._recommend(0.60, 0.54, float('nan'), 0.02).startswith("DO_NOT_DEPLOY")


def test_recommendation_requires_baseline_clearance_even_with_strong_wfo():
    trainer = ModelTrainer()

    assert trainer._recommend(0.56, 0.55, 0.58, 0.02).startswith("CAUTION")
    assert trainer._recommend(0.58, 0.55, 0.58, 0.02) == "DEPLOY ✅"



def test_load_labeled_sorts_and_rejects_duplicate_or_future_times(tmp_path):
    import pandas as pd
    import pytest
    from src.training import trainer as trainer_module

    trainer = ModelTrainer()
    original_dir = trainer_module.LABEL_DIR
    market_dir = tmp_path / "labels" / "binance" / "TEST" / "1h"
    market_dir.mkdir(parents=True)

    frame = pd.DataFrame({
        "time": [3000, 1000, 2000],
        "label": [1, -1, 0],
    })
    frame.to_parquet(market_dir / "labeled.parquet", index=False)

    trainer_module.LABEL_DIR = tmp_path / "labels"
    try:
        loaded = trainer._load_labeled("binance", "TEST", "1h")
        assert loaded["time"].tolist() == [1000, 2000, 3000]

        duplicate = pd.DataFrame({
            "time": [1000, 1000, 2000],
            "label": [1, -1, 0],
        })
        duplicate.to_parquet(market_dir / "labeled.parquet", index=False)
        with pytest.raises(ValueError, match="Duplicate timestamps"):
            trainer._load_labeled("binance", "TEST", "1h")
    finally:
        trainer_module.LABEL_DIR = original_dir
