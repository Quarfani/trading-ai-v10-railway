"""
training/run_training.py — Training CLI
========================================
Usage:
  python -m src.training.run_training
  python -m src.training.run_training --market binance --symbol BTCUSDT --tf 1h
  python -m src.training.run_training --all --model ensemble
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.training.trainer import ModelTrainer
from src.utils.logger     import get_logger

logger = get_logger("RunTraining")


def main():
    parser = argparse.ArgumentParser(description="Train Trading AI Models")
    parser.add_argument("--market",  default="binance")
    parser.add_argument("--symbol",  default="",
                        help="Single symbol, or empty for all available")
    parser.add_argument("--tf",      default="1h",
                        help="Timeframe: 1h, 4h, etc.")
    parser.add_argument("--model",   default="xgboost",
                        choices=["xgboost", "ensemble"])
    parser.add_argument("--all",     action="store_true",
                        help="Train all available symbols/timeframes")
    parser.add_argument("--wf-folds", type=int, default=5)
    parser.add_argument("--use-lstm", action="store_true",
                        help="Include LSTM in ensemble (requires TF/PyTorch)")
    args = parser.parse_args()

    trainer = ModelTrainer(
        n_wf_folds = args.wf_folds,
        use_lstm   = args.use_lstm,
    )

    if args.all or not args.symbol:
        logger.info("Training all available symbols...")
        results = trainer.train_all(
            market     = args.market,
            model_type = args.model,
            timeframes = [args.tf],
        )
        deploy  = [k for k, r in results.items() if "DEPLOY" in r.recommendation]
        caution = [k for k, r in results.items() if "CAUTION" in r.recommendation]
        skip    = [k for k, r in results.items() if "DO_NOT" in r.recommendation]

        print(f"\n✅ DEPLOY:     {deploy}")
        print(f"⚠️  CAUTION:    {caution}")
        print(f"❌ DO_NOT:     {skip}")

    else:
        report = trainer.train(
            symbol     = args.symbol.upper(),
            timeframe  = args.tf,
            market     = args.market,
            model_type = args.model,
        )
        print(f"\n{'═'*50}")
        print(f"  Symbol:     {report.symbol}/{report.timeframe}")
        print(f"  Accuracy:   {report.test_accuracy:.3f}")
        print(f"  WF Mean:    {report.wf_mean_accuracy:.3f} ± {report.wf_std_accuracy:.3f}")
        print(f"  F1-BUY:     {report.test_f1_buy:.3f}")
        print(f"  F1-SELL:    {report.test_f1_sell:.3f}")
        print(f"  Decision:   {report.recommendation}")
        print(f"  Time:       {report.elapsed_sec:.0f}s")
        print(f"{'═'*50}")


if __name__ == "__main__":
    main()
