"""
utils/logger.py — Structured Logging
"""
import logging
import sys
from pathlib import Path
from datetime import datetime


def get_logger(name: str, level: str = "INFO") -> logging.Logger:
    """Return a configured logger with console + file handlers."""
    from src.config import LOG_FILE, LOG_FORMAT

    logger = logging.getLogger(name)
    if logger.handlers:
        return logger  # already configured

    logger.setLevel(getattr(logging, level.upper(), logging.INFO))

    fmt = logging.Formatter(LOG_FORMAT, datefmt="%Y-%m-%d %H:%M:%S")

    # Console handler
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    # File handler
    try:
        fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    except Exception:
        pass

    return logger
