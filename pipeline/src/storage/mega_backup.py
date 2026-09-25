"""
MEGA backup/recovery agent for the real deployment split.

Role:
- Railway: keep short-lived runtime backups on its persistent volume.
- Windows/Research host: archive consistent SQLite snapshots + manifests to MEGA.
- MEGA is an archive/DR target, never the live database.

Commands are exposed through run_all.py: backup, restore-check.
Requires MEGAcmd/mega-cmd for remote operations.
"""
from __future__ import annotations
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional

from src.utils.logger import get_logger

logger = get_logger("MegaBackup")


@dataclass
class BackupConfig:
    email: str = os.getenv("MEGA_EMAIL", "")
    password: str = os.getenv("MEGA_PASSWORD", "")
    remote_root: str = os.getenv("MEGA_FOLDER", "/TradingAI/backups")
    db_path: Path = Path(os.getenv("MEGA_DB_PATH", "../bot/backend/data/trading.db"))
    local_root: Path = Path(os.getenv("MEGA_LOCAL_BACKUP_DIR", "./data/backups"))
    daily_keep: int = int(os.getenv("MEGA_RETENTION_DAILY", "14"))
    weekly_keep: int = int(os.getenv("MEGA_RETENTION_WEEKLY", "8"))
    monthly_keep: int = int(os.getenv("MEGA_RETENTION_MONTHLY", "3"))
    verify_remote: bool = os.getenv("MEGA_VERIFY_REMOTE", "true").lower() == "true"
    backup_class: str = os.getenv("MEGA_BACKUP_CLASS", "daily")


class MegaBackupAgent:
    def __init__(self, cfg: BackupConfig | None = None):
        self.cfg = cfg or BackupConfig()
        self.cfg.db_path = Path(self.cfg.db_path).resolve()
        self.cfg.local_root = Path(self.cfg.local_root).resolve()
        self.cfg.local_root.mkdir(parents=True, exist_ok=True)

    def _run(self, args: list[str], timeout: int = 300, check: bool = False) -> subprocess.CompletedProcess:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if check and p.returncode != 0:
            raise RuntimeError((p.stderr or p.stdout or "MEGA command failed").strip())
        return p

    def ensure_tool(self) -> None:
        candidates = ["mega-login", "mega-put", "MEGAcmd", "megacmd"]
        if not any(shutil.which(x) for x in candidates):
            raise RuntimeError("MEGAcmd/mega-cmd is required for MEGA archive operations")
        if not self.cfg.email or not self.cfg.password:
            raise RuntimeError("MEGA_EMAIL and MEGA_PASSWORD are required for archive operations")

    def login(self) -> None:
        self.ensure_tool()
        p = self._run(["mega-login", self.cfg.email, self.cfg.password], timeout=60)
        if p.returncode != 0 and "already logged in" not in (p.stderr or "").lower():
            raise RuntimeError((p.stderr or p.stdout or "MEGA login failed").strip())

    @staticmethod
    def sha256(path: Path) -> str:
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()

    def snapshot_sqlite(self) -> Path:
        source = self.cfg.db_path
        if not source.exists():
            raise FileNotFoundError(f"Database not found: {source}")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        snap = self.cfg.local_root / f"tradingai_db_snapshot_{stamp}.sqlite"
        src = sqlite3.connect(str(source), timeout=30)
        dst = sqlite3.connect(str(snap))
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        con = sqlite3.connect(str(snap))
        try:
            row = con.execute("PRAGMA integrity_check").fetchone()
            if not row or row[0] != "ok":
                raise RuntimeError(f"SQLite integrity check failed: {row}")
        finally:
            con.close()
        return snap

    def build_archive(self, snapshot: Path) -> tuple[Path, str]:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        archive = self.cfg.local_root / f"tradingai_db_full_{stamp}.zip"
        commit = self.git_sha()
        manifest = {
            "backup_id": stamp,
            "environment": os.getenv("MODE", "paper"),
            "type": "db_full",
            "timestamp_utc": stamp,
            "git_sha": commit,
            "schema_version": os.getenv("DB_SCHEMA_VERSION", "unknown"),
            "source_snapshot": snapshot.name,
        }
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.write(snapshot, arcname="trading.db")
            z.writestr("manifest.json", json.dumps(manifest, indent=2, sort_keys=True))
        digest = self.sha256(archive)
        sha_file = archive.with_suffix(archive.suffix + ".sha256")
        sha_file.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
        archive_manifest = archive.with_suffix(archive.suffix + ".manifest.json")
        manifest["sha256"] = digest
        manifest["archive_size_bytes"] = archive.stat().st_size
        archive_manifest.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        snapshot.unlink(missing_ok=True)
        return archive, digest

    @staticmethod
    def git_sha() -> str:
        try:
            p = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10)
            return p.stdout.strip() if p.returncode == 0 else "unknown"
        except Exception:
            return "unknown"

    def upload(self, archive: Path) -> str:
        self.login()
        root = f"{self.cfg.remote_root.rstrip('/')}/{self.cfg.backup_class}"
        remote = f"{root}/{archive.name}"
        self._run(["mega-mkdir", "-p", root], timeout=60, check=True)
        self._run(["mega-put", str(archive), remote], timeout=600, check=True)
        self._run(["mega-put", str(archive.with_suffix(archive.suffix + '.sha256')), f"{remote}.sha256"], timeout=120, check=True)
        self._run(["mega-put", str(archive.with_suffix(archive.suffix + '.manifest.json')), f"{remote}.manifest.json"], timeout=120, check=True)
        return remote

    def verify_remote(self, archive: Path, remote: str) -> bool:
        if not self.cfg.verify_remote:
            return True
        with tempfile.TemporaryDirectory(prefix="mega-verify-") as td:
            target = Path(td) / archive.name
            self._run(["mega-get", remote, str(target)], timeout=900, check=True)
            remote_hash = self.sha256(target)
            local_hash = self.sha256(archive)
            if remote_hash != local_hash:
                raise RuntimeError(f"SHA-256 mismatch: local={local_hash} remote={remote_hash}")
        return True

    def apply_retention_local(self) -> None:
        files = sorted(self.cfg.local_root.glob("tradingai_db_full_*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
        keep = max(self.cfg.daily_keep + self.cfg.weekly_keep + self.cfg.monthly_keep, 1)
        for old in files[keep:]:
            for suffix in ["", ".sha256", ".manifest.json"]:
                old.with_suffix(old.suffix + suffix).unlink(missing_ok=True)

    def remote_files(self) -> list[str]:
        self.login()
        root = f"{self.cfg.remote_root.rstrip('/')}/{self.cfg.backup_class}"
        p = self._run(["mega-ls", "-R", root], timeout=120, check=True)
        return [line.strip() for line in (p.stdout or "").splitlines() if line.strip()]

    @staticmethod
    def _stamp_from_name(name: str) -> Optional[datetime]:
        m = re.search(r"tradingai_db_full_(\d{8}T\d{6}Z)\.zip$", name)
        if not m:
            return None
        return datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)

    def apply_remote_retention(self) -> list[str]:
        """Keep newest 14 daily + 8 ISO-week representatives + 3 month representatives."""
        names = [Path(x).name for x in self.remote_files()]
        backups = []
        for name in names:
            dt = self._stamp_from_name(name)
            if dt:
                backups.append((dt, name))
        backups.sort(reverse=True)
        if not backups:
            return []

        keep: set[str] = {name for _, name in backups[: self.cfg.daily_keep]}
        seen_weeks: set[tuple[int, int]] = set()
        for dt, name in backups:
            key = (dt.isocalendar().year, dt.isocalendar().week)
            if key not in seen_weeks and len(seen_weeks) < self.cfg.weekly_keep:
                keep.add(name)
                seen_weeks.add(key)

        seen_months: set[tuple[int, int]] = set()
        for dt, name in backups:
            key = (dt.year, dt.month)
            if key not in seen_months and len(seen_months) < self.cfg.monthly_keep:
                keep.add(name)
                seen_months.add(key)

        deleted: list[str] = []
        for _, name in backups:
            if name in keep:
                continue
            for suffix in ["", ".sha256", ".manifest.json"]:
                remote = f"{self.cfg.remote_root.rstrip('/')}/{self.cfg.backup_class}/{name}{suffix}"
                p = self._run(["mega-rm", remote], timeout=60)
                if p.returncode != 0:
                    logger.warning(f"MEGA retention could not delete {remote}: {(p.stderr or '').strip()}")
            deleted.append(name)
        return deleted

    def download_backup(self, remote: str, output_dir: Path) -> Path:
        self.login()
        output_dir.mkdir(parents=True, exist_ok=True)
        target = output_dir / Path(remote).name
        self._run(["mega-get", remote, str(target)], timeout=900, check=True)
        sha_remote = f"{remote}.sha256"
        sha_target = target.with_suffix(target.suffix + ".sha256")
        p = self._run(["mega-get", sha_remote, str(sha_target)], timeout=120)
        if p.returncode != 0:
            raise RuntimeError("Remote SHA-256 sidecar could not be downloaded")
        expected = sha_target.read_text(encoding="utf-8").split()[0]
        actual = self.sha256(target)
        if expected != actual:
            raise RuntimeError(f"SHA-256 mismatch after MEGA download: expected={expected} actual={actual}")
        return target

    def backup(self) -> dict:
        snapshot = self.snapshot_sqlite()
        archive, digest = self.build_archive(snapshot)
        remote = self.upload(archive)
        verified = self.verify_remote(archive, remote)
        deleted = self.apply_remote_retention()
        self.apply_retention_local()
        return {"archive": str(archive), "remote": remote, "sha256": digest, "verified": verified, "remote_deleted": deleted}


def restore_check(archive: Path, output_dir: Path) -> bool:
    archive = Path(archive).resolve()
    output_dir = Path(output_dir).resolve()
    if not archive.exists():
        raise FileNotFoundError(archive)
    sha_file = archive.with_suffix(archive.suffix + ".sha256")
    if not sha_file.exists():
        raise RuntimeError("SHA-256 sidecar missing")
    expected = sha_file.read_text(encoding="utf-8").split()[0]
    actual = MegaBackupAgent.sha256(archive)
    if expected != actual:
        raise RuntimeError(f"SHA-256 mismatch: expected={expected} actual={actual}")
    output_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "r") as z:
        z.testzip()
        z.extractall(output_dir)
    db = output_dir / "trading.db"
    con = sqlite3.connect(str(db))
    try:
        ok = con.execute("PRAGMA integrity_check").fetchone()
        if not ok or ok[0] != "ok":
            raise RuntimeError("Restored SQLite integrity check failed")
    finally:
        con.close()
    return True
