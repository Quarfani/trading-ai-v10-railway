# START HERE — v10

1. Keep the repository root as: `C:\Users\<you>\Downloads\trading-ai-v10-railway-mega-ready\repo`.
2. Do not run `git add` until `.gitignore` is reviewed.
3. Local 4GB mode: run `SETUP_WINDOWS.bat` once, then `START.bat`.
4. Railway: deploy only `bot/backend`, set Root Directory `/bot/backend`, use `DEPLOYMENT_PROFILE=railway-paper`, and keep `MODE=paper`.
5. MEGA: install MEGAcmd on an always-on Windows host when possible; fill `pipeline/.env` and run `INSTALL_MEGA_BACKUP_TASK.bat`.
6. For a manual backup: `cd pipeline` then `python run_all.py backup`.
7. For a restore test: `python run_all.py download-backup <remote-path> --output ./data/mega-download`, then `python run_all.py restore-check ./data/mega-download/<archive.zip> --output ./data/restore-test`.

The v10 design intentionally keeps the 4GB PC out of heavy ML/training/WFO workloads.
