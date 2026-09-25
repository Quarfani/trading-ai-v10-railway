import sqlite3
from pathlib import Path

from src.storage.mega_backup import MegaBackupAgent, BackupConfig, restore_check


def make_db(path: Path):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE trades(id INTEGER PRIMARY KEY, symbol TEXT, pnl REAL)")
    con.execute("INSERT INTO trades(symbol, pnl) VALUES('BTCUSDT', 1.25)")
    con.commit()
    con.close()


def test_backup_archive_and_restore_check(tmp_path, monkeypatch):
    db = tmp_path / "trading.db"
    make_db(db)
    cfg = BackupConfig(
        email="", password="", remote_root="/TradingAI/backups",
        db_path=db, local_root=tmp_path / "backups", verify_remote=False,
    )
    agent = MegaBackupAgent(cfg)
    snap = agent.snapshot_sqlite()
    archive, digest = agent.build_archive(snap)
    assert archive.exists()
    assert len(digest) == 64
    sha = archive.with_suffix(archive.suffix + ".sha256")
    assert sha.exists()
    out = tmp_path / "restore"
    assert restore_check(archive, out) is True
    con = sqlite3.connect(out / "trading.db")
    assert con.execute("SELECT COUNT(*) FROM trades").fetchone()[0] == 1
    con.close()


def test_tamper_is_detected(tmp_path):
    db = tmp_path / "trading.db"
    make_db(db)
    cfg = BackupConfig(db_path=db, local_root=tmp_path / "backups", verify_remote=False)
    agent = MegaBackupAgent(cfg)
    archive, _ = agent.build_archive(agent.snapshot_sqlite())
    archive.write_bytes(archive.read_bytes() + b"tamper")
    try:
        restore_check(archive, tmp_path / "restore")
        assert False, "tampered archive must fail verification"
    except RuntimeError as exc:
        assert "SHA-256 mismatch" in str(exc)
