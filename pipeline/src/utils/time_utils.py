"""
utils/time_utils.py — Time Utilities (no data leakage guarantees)
"""
from datetime import datetime, timezone, timedelta
from typing import Tuple, Optional
import pandas as pd


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def date_range_ms(years_back: int = 2, start: Optional[str] = None, end: Optional[str] = None) -> Tuple[int, int]:
    """Return (start_ms, end_ms) for data collection window."""
    now_ms  = int(utc_now().timestamp() * 1000)
    end_ms  = now_ms

    if end:
        end_ms = int(pd.Timestamp(end, tz="UTC").timestamp() * 1000)

    if start:
        start_ms = int(pd.Timestamp(start, tz="UTC").timestamp() * 1000)
    else:
        start_ms = now_ms - years_back * 365 * 24 * 3_600_000

    return start_ms, end_ms


def ms_to_datetime(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def datetime_to_ms(dt: datetime) -> int:
    return int(to_utc(dt).timestamp() * 1000)


def month_start_end(year: int, month: int) -> Tuple[int, int]:
    """Return (start_ms, end_ms) for a given year/month."""
    start = pd.Timestamp(year=year, month=month, day=1, tz="UTC")
    end   = start + pd.offsets.MonthEnd(0) + pd.Timedelta(hours=23, minutes=59, seconds=59)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def is_weekend(dt: datetime) -> bool:
    return dt.weekday() >= 5  # Saturday=5, Sunday=6


def is_fx_session(dt: datetime) -> bool:
    """True if within normal FX trading hours (Mon 00:00 - Fri 21:00 UTC)."""
    if dt.weekday() == 5:  # Saturday
        return False
    if dt.weekday() == 6:  # Sunday before 22:00
        return dt.hour >= 22
    if dt.weekday() == 4 and dt.hour >= 21:  # Friday after 21:00
        return False
    return True
