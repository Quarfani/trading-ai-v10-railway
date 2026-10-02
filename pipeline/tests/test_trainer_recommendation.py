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
