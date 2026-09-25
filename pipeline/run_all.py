#!/usr/bin/env python3
"""
run_all.py — Master CLI for the complete Trading AI System
==========================================================
Commands:
  download    Download 2 years of historical data
  train       Train AI models on downloaded data
  serve       Start ML API server (for the trading bot)
  pipeline    Full pipeline: download + train + upload to Mega
  test        Run all tests
  status      Show data + model status
  upload      Upload data to Mega.nz
  backup      Snapshot SQLite + archive + SHA-256 + upload to MEGA
  restore-check Verify a downloaded MEGA backup before use

Usage:
  python run_all.py download --market binance --years 2
  python run_all.py train --symbol BTCUSDT --tf 1h
  python run_all.py serve --port 5001
  python run_all.py pipeline --market binance --upload
  python run_all.py status
  python run_all.py test
"""
import sys
import subprocess
import argparse
import os
import json
from pathlib import Path

# ─── Commands ────────────────────────────────────────────────────────────────

def cmd_download(args):
    """Download historical data from Binance/MT5/Yahoo."""
    cmd = [sys.executable, "-m", "src.backtest.runDownloadHistory"] \
          if Path("src/backtest/runDownloadHistory.ts").exists() else [
        sys.executable, "-c", f"""
import sys; sys.path.insert(0, '.')
from src.ingestion.binance_ingestor import BinanceIngestor
from src.ingestion.yahoo_ingestor   import YahooIngestor
from src.cleaning.cleaner           import DataCleaner
from src.resampling.resampler       import Resampler
from src.compression.partitioner    import Partitioner
from src.features.feature_engineer  import FeatureEngineer
from src.labeling.labeler           import DataLabeler

market  = '{args.market}'
symbols = '{args.symbols}'.split(',') if '{args.symbols}' else None
years   = {args.years}

if market == 'binance':
    from src.config import BINANCE_CONFIG
    syms = symbols or BINANCE_CONFIG.symbols
    ing  = BinanceIngestor()
else:
    from src.config import MT5_CONFIG
    syms = symbols or MT5_CONFIG.symbols
    from src.ingestion.mt5_ingestor import MT5Ingestor
    ing = MT5Ingestor()

cleaner = DataCleaner()
resampler = Resampler()
partitioner = Partitioner()
fe = FeatureEngineer()
labeler = DataLabeler()

failures = 0
for sym in syms:
    print(f'Processing {{sym}}...')
    try:
        if market == 'binance':
            path = ing.ingest_symbol(sym, years=years)
        else:
            # Real MT5 ingestion on Windows. Optional Yahoo fallback can be
            # enabled explicitly for environments where MT5 is unavailable.
            if not ing._connected and not ing.connect():
                if os.getenv('MT5_FALLBACK_YAHOO', 'false').lower() == 'true':
                    from src.ingestion.yahoo_ingestor import YahooIngestor
                    yahoo = YahooIngestor()
                    df = yahoo.fetch(sym, years)
                    if df is None:
                        continue
                    path = True
                else:
                    raise RuntimeError('MT5 connection unavailable; set MT5_FALLBACK_YAHOO=true to use Yahoo fallback')
            else:
                path = ing.ingest_symbol(sym, years=years)
                if not path:
                    continue

        import pyarrow.parquet as pq
        from src.config import RAW_DIR
        raw_path = RAW_DIR / market / sym / '1m' / 'raw.parquet'
        if not raw_path.exists(): continue

        import pandas as pd
        df_raw = pd.read_parquet(raw_path)
        df_clean = cleaner.clean(df_raw, sym, market, '1m')
        all_tf = resampler.resample_all(df_clean, sym)
        partitioner.write_all_timeframes(all_tf, market, sym)
        for tf, df in all_tf.items():
            if len(df) >= 300:
                df_feat = fe.generate(df, sym)
                df_lab  = labeler.label(df_feat, sym)
                labeler.save(df_lab, market, sym, tf)
                fe.save(df_feat, market, sym, tf)
        print(f'  {{sym}}: done')
    except Exception as e:
        failures += 1
        print(f'  {{sym}}: ERROR {{e}}')
if failures:
    raise SystemExit(failures)
"""
    ]
    subprocess.run(cmd, check=True)


def cmd_train(args):
    """Train AI models."""
    cmd = [
        sys.executable, "-m", "src.training.run_training",
        "--market",  args.market,
        "--tf",      args.tf,
        "--model",   args.model,
    ]
    if args.symbol:
        cmd += ["--symbol", args.symbol]
    else:
        cmd += ["--all"]
    if args.use_lstm:
        cmd += ["--use-lstm"]
    subprocess.run(cmd, check=True)


def cmd_serve(args):
    """Start the ML API server."""
    from src.serving.ml_api_server import run_server
    print(f"Starting ML API Server on port {args.port}...")
    print(f"Bot connects via: ML_SERVER_URL=http://localhost:{args.port}")
    run_server(port=args.port)


def cmd_pipeline(args):
    """Full: download + process + train + upload."""
    print("=" * 60)
    print("  FULL PIPELINE")
    print("=" * 60)

    # Step 1: Download
    print("\n[1/3] Downloading historical data...")
    cmd_download(args)

    # Step 2: Train
    print("\n[2/3] Training AI models...")
    cmd_train(args)

    # Step 3: Upload to Mega
    if args.upload:
        print("\n[3/3] Uploading to Mega...")
        from src.storage.mega_uploader import MegaUploader
        uploader = MegaUploader()
        results  = uploader.upload_all()
        ok = sum(1 for r in results if r.ok)
        print(f"  Uploaded {ok}/{len(results)} files")
    else:
        print("\n[3/3] Skipping Mega upload (use --upload to enable)")

    print("\n✅ Pipeline complete!")
    print("   Run: python run_all.py serve")
    print("   Then start the trading bot: cd ../trading-v7/backend && npm run dev")


def cmd_status(args):
    """Show data catalog and model status."""
    from src.compression.partitioner import Partitioner
    from src.models.base_model       import MODEL_DIR
    import json

    print("\n=== DATA CATALOG ===")
    p  = Partitioner()
    df = p.catalog()
    if df.empty:
        print("  No data yet. Run: python run_all.py download")
    else:
        print(df.to_string())

    print("\n=== TRAINED MODELS ===")
    reports = list(MODEL_DIR.glob("*/*/*/training_report.json"))
    if not reports:
        print("  No models yet. Run: python run_all.py train")
    else:
        for rp in reports:
            try:
                with open(rp) as f:
                    r = json.load(f)
                print(
                    f"  {r['symbol']:12}/{r['timeframe']:4} "
                    f"acc={r.get('test_accuracy',0):.3f} "
                    f"WF={r.get('wf_mean_accuracy',0):.3f} "
                    f"{r.get('recommendation','')}"
                )
            except Exception:
                pass


def cmd_test(args):
    """Run all tests."""
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/", "-v", "--tb=short"],
        check=False,
    )
    sys.exit(result.returncode)


def cmd_backup(args):
    from src.storage.mega_backup import MegaBackupAgent
    agent = MegaBackupAgent()
    result = agent.backup()
    print(json.dumps(result, indent=2))


def cmd_download_backup(args):
    from src.storage.mega_backup import MegaBackupAgent
    agent = MegaBackupAgent()
    path = agent.download_backup(args.remote, Path(args.output))
    print(f"DOWNLOADED={path}")


def cmd_restore_check(args):
    from src.storage.mega_backup import restore_check
    ok = restore_check(Path(args.archive), Path(args.output))
    print('RESTORE_CHECK=' + ('PASS' if ok else 'FAIL'))


def cmd_mega_status(args):
    from src.storage.mega_backup import MegaBackupAgent
    agent = MegaBackupAgent()
    names = agent.remote_files()
    print(f"REMOTE_FILES={len(names)}")
    for name in names:
        print(name)


def cmd_upload(args):
    """Upload data to Mega."""
    from src.storage.mega_uploader import MegaUploader
    uploader = MegaUploader()
    results  = uploader.upload_all()
    ok = sum(1 for r in results if r.ok)
    print(f"Uploaded {ok}/{len(results)} files to Mega")


# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        prog        = "trading-ai",
        description = "Trading AI Data Pipeline + Model Server",
    )
    sub = parser.add_subparsers(dest="command")

    # download
    dl = sub.add_parser("download", help="Download historical data")
    dl.add_argument("--market",  default="binance", choices=["binance","mt5","all"])
    dl.add_argument("--symbols", default="",        help="Comma-separated, empty=all")
    dl.add_argument("--years",   type=int, default=2)

    # train
    tr = sub.add_parser("train", help="Train AI models")
    tr.add_argument("--market",   default="binance")
    tr.add_argument("--symbol",   default="",       help="Single symbol or empty=all")
    tr.add_argument("--tf",       default="1h")
    tr.add_argument("--model",    default="xgboost", choices=["xgboost","ensemble"])
    tr.add_argument("--use-lstm", action="store_true")

    # serve
    sv = sub.add_parser("serve", help="Start ML API server")
    sv.add_argument("--port",    type=int, default=5001)
    sv.add_argument("--workers", type=int, default=1)

    # pipeline
    pl = sub.add_parser("pipeline", help="Full pipeline: download+train+upload")
    pl.add_argument("--market",   default="binance", choices=["binance","mt5","all"])
    pl.add_argument("--symbols",  default="")
    pl.add_argument("--years",    type=int, default=2)
    pl.add_argument("--tf",       default="1h")
    pl.add_argument("--model",    default="xgboost", choices=["xgboost","ensemble"])
    pl.add_argument("--use-lstm", action="store_true")
    pl.add_argument("--upload",   action="store_true", help="Upload to Mega after")

    # backup
    bk = sub.add_parser("backup", help="Snapshot SQLite + upload to MEGA")
    # download-backup
    dbk = sub.add_parser("download-backup", help="Download one verified MEGA archive")
    dbk.add_argument("remote", help="Full MEGA remote path")
    dbk.add_argument("--output", default="./data/mega-download")
    # restore-check
    rc = sub.add_parser("restore-check", help="Verify and extract a downloaded backup")
    rc.add_argument("archive", help="Path to tradingai_db_full_*.zip")
    rc.add_argument("--output", default="./data/restore-test")

    # status
    sub.add_parser("status",  help="Show data + model status")
    # test
    sub.add_parser("test",    help="Run all tests")
    # mega-status
    sub.add_parser("mega-status", help="List MEGA backup archive files")
    # upload
    sub.add_parser("upload",  help="Upload data to Mega")

    args = parser.parse_args()

    dispatch = {
        "download": cmd_download,
        "train":    cmd_train,
        "serve":    cmd_serve,
        "pipeline": cmd_pipeline,
        "backup":   cmd_backup,
        "download-backup": cmd_download_backup,
        "restore-check": cmd_restore_check,
        "status":   cmd_status,
        "test":     cmd_test,
        "upload":   cmd_upload,
        "mega-status": cmd_mega_status,
    }

    if not args.command:
        parser.print_help()
        print("\nQuick start:")
        print("  python run_all.py download          # get 2 years of data")
        print("  python run_all.py train             # train XGBoost models")
        print("  python run_all.py serve             # start API on port 5001")
        print("  python run_all.py pipeline --upload # research pipeline + Mega data upload")
        print("  python run_all.py backup           # consistent SQLite snapshot + MEGA archive")
        print("  python run_all.py restore-check <archive.zip> --output ./data/restore-test")
        return

    dispatch[args.command](args)


if __name__ == "__main__":
    main()
