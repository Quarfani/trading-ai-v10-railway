from src.training.trainer import ModelTrainer


def test_recommendation_is_independent_of_held_out_test_accuracy():
    trainer = ModelTrainer()
    deploy_high_test = trainer._recommend(0.99, 0.54, 0.02)
    deploy_low_test = trainer._recommend(0.40, 0.54, 0.02)
    assert deploy_high_test == "DEPLOY ✅"
    assert deploy_low_test == deploy_high_test


def test_recommendation_uses_wfo_stability_thresholds():
    trainer = ModelTrainer()
    assert trainer._recommend(0.99, 0.52, 0.02).startswith("CAUTION")
    assert trainer._recommend(0.99, 0.50, 0.02).startswith("DO_NOT_DEPLOY")
    assert trainer._recommend(0.99, 0.54, 0.07).startswith("CAUTION")
