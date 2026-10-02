#!/usr/bin/env python3
"""
MT5 PYTHON BRIDGE — v9.0
=========================
Flask HTTP server that receives trade commands from the Node.js bot
and executes them via MetaTrader 5 Python API.

Run this script BEFORE starting the trading bot:
  python mt5_bridge.py

The bot connects at: MT5_BRIDGE_URL=http://127.0.0.1:5000

Endpoints:
  GET  /ping            — liveness check
  GET  /account         — equity, balance, margin
  GET  /tick?symbol=X   — current bid/ask
  GET  /candles?symbol=X&timeframe=H1&count=250 — recent closed candles
  POST /trade           — open market order with SL/TP
  POST /modify          — modify SL/TP of open position
  POST /close           — close position by ticket
  POST /close_partial   — close N% of position
  GET  /positions       — all open positions
  GET  /history         — last 50 closed trades

Install:
  pip install flask MetaTrader5
  Only runs on Windows with MT5 terminal installed.
"""
import json
import threading
import logging
import time
import hmac
import math
import hashlib
from datetime import datetime, timezone
from typing import Optional

logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s | %(levelname)s | %(message)s",
    datefmt = "%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("MT5Bridge")

try:
    from flask import Flask, request, jsonify
except ImportError:
    print("Install Flask: pip install flask")
    exit(1)

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    log.warning("MetaTrader5 not installed — running in SIMULATION mode")

import os
from dotenv import load_dotenv
load_dotenv()

# ─── Configuration ────────────────────────────────────────────────────────────

MT5_LOGIN    = int(os.getenv("MT5_LOGIN",    "0"))
MT5_PASSWORD = os.getenv("MT5_PASSWORD",     "")
MT5_SERVER   = os.getenv("MT5_SERVER_NAME",  "")
MT5_PATH     = os.getenv("MT5_PATH",         "")
BRIDGE_PORT  = int(os.getenv("MT5_BRIDGE_PORT", "5000"))
API_KEY      = os.getenv("MT5_BRIDGE_API_KEY", "")
BRIDGE_MODE  = os.getenv("MT5_BRIDGE_MODE", "live").lower()
ALLOW_ANON   = os.getenv("MT5_BRIDGE_ALLOW_ANONYMOUS", "false").lower() == "true"

# ─── Flask app ────────────────────────────────────────────────────────────────

app    = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 64 * 1024
_lock  = threading.Lock()
_idempotency_lock = threading.RLock()
_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60
_idempotency_cache: dict[str, tuple[float, str, dict, str | None]] = {}
_IDEMPOTENCY_STATE_PATH = os.getenv(
    "MT5_IDEMPOTENCY_STATE_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "mt5_idempotency.json"),
)

def _idempotency_load_disk():
    with _idempotency_lock:
        try:
            with open(_IDEMPOTENCY_STATE_PATH, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
            if not isinstance(raw, dict):
                return
            now = time.time()
            for key, value in raw.items():
                if not isinstance(value, list) or len(value) not in (3, 4):
                    continue
                if len(value) == 3:
                    ts, status, payload = value
                    fingerprint = None
                else:
                    ts, status, payload, fingerprint = value
                if (
                    isinstance(ts, (int, float))
                    and math.isfinite(float(ts))
                    and 0 <= now - float(ts) <= _IDEMPOTENCY_TTL_SEC
                    and status in ("SUCCESS", "UNKNOWN")
                    and isinstance(payload, dict)
                ):
                    _idempotency_cache[str(key)] = (float(ts), status, payload, str(fingerprint) if fingerprint is not None else None)
        except (FileNotFoundError, OSError, ValueError, TypeError, OverflowError):
            return


def _idempotency_persist():
    directory = os.path.dirname(_IDEMPOTENCY_STATE_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp_path = (
        f"{_IDEMPOTENCY_STATE_PATH}."
        f"{os.getpid()}.{threading.get_ident()}.tmp"
    )
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                key: [ts, status, payload] if fingerprint is None else [ts, status, payload, fingerprint]
                for key, (ts, status, payload, fingerprint) in _idempotency_cache.items()
            },
            handle,
            separators=(",", ":"),
        )
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, _IDEMPOTENCY_STATE_PATH)


def _idempotency_fingerprint(operation: str, data: dict) -> str:
    request = {
        str(key): value
        for key, value in data.items()
        if str(key) != "idempotency_key"
    }
    canonical = json.dumps(
        {"operation": operation, "request": request},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _idempotency_lookup(key: str, fingerprint: str | None = None):
    if not key:
        return None
    with _idempotency_lock:
        now = time.time()
        stale = [
            k for k, (ts, _status, _payload, _fingerprint) in _idempotency_cache.items()
            if now - ts > _IDEMPOTENCY_TTL_SEC
        ]
        for k in stale:
            _idempotency_cache.pop(k, None)
        cached = _idempotency_cache.get(key)
        if (
            cached is not None and
            fingerprint is not None and
            cached[3] is not None and
            cached[3] != fingerprint
        ):
            return (
                0.0,
                "CONFLICT",
                {"ok": False, "error": "idempotency_key is already bound to a different request"},
                cached[3],
            )
        return cached


def _idempotency_record(
    key: str,
    status: str,
    payload: dict,
    fingerprint: str | None = None,
):
    if not key:
        return
    with _idempotency_lock:
        _idempotency_cache[key] = (
            time.time(),
            status,
            dict(payload),
            fingerprint,
        )
        try:
            _idempotency_persist()
        except OSError as exc:
            log.error("Failed to persist idempotency state: %s", exc)


_idempotency_load_disk()


def auth_check() -> bool:
    """Verify API key; live bridge is never anonymously accessible."""
    if not API_KEY:
        return BRIDGE_MODE == 'simulation' and ALLOW_ANON
    provided = request.headers.get("X-Api-Key", "")
    return hmac.compare_digest(provided, API_KEY)


def err(msg: str, code: int = 400):
    return jsonify({"ok": False, "error": msg}), code


# ─── MT5 Connection ───────────────────────────────────────────────────────────

def ensure_connected() -> bool:
    """Ensure MT5 is initialized and logged in."""
    if BRIDGE_MODE == 'simulation':
        return True  # explicitly configured simulation mode

    if not mt5.initialize(path=MT5_PATH if MT5_PATH else None):
        log.error(f"MT5 init failed: {mt5.last_error()}")
        return False

    if MT5_LOGIN:
        if not mt5.login(MT5_LOGIN, MT5_PASSWORD, MT5_SERVER):
            log.error(f"MT5 login failed: {mt5.last_error()}")
            return False

    return True


def get_magic() -> int:
    return 20240901  # unique magic number for this bot


# ─── Simulation fallback ─────────────────────────────────────────────────────

_sim_ticket = 1000
_sim_positions: dict = {}

def sim_open(symbol, side, volume, sl, tp, price) -> dict:
    global _sim_ticket, _sim_positions
    _sim_ticket += 1
    pos = {
        "ticket": _sim_ticket, "symbol": symbol, "type": side,
        "volume": volume, "price": price, "sl": sl, "tp": tp,
        "time": int(datetime.now(timezone.utc).timestamp()),
    }
    _sim_positions[_sim_ticket] = pos
    return pos


def sim_close(ticket: int, fraction: float = 1.0) -> dict:
    pos = _sim_positions.get(ticket)
    if not pos:
        return {"ok": False, "error": "ticket not found"}
    fraction = max(0.0, min(1.0, float(fraction)))
    close_volume = pos["volume"] * fraction
    import random
    close_price = pos["price"] * (1 + random.uniform(-0.005, 0.005))
    pnl = (close_price - pos["price"]) * (1 if pos["type"] == "BUY" else -1) * close_volume
    if fraction >= 1.0:
        _sim_positions.pop(ticket, None)
        remaining = 0.0
    else:
        pos["volume"] = round(pos["volume"] - close_volume, 8)
        remaining = pos["volume"]
    return {"ok": True, "ticket": ticket, "closed_volume": round(close_volume, 8),
            "remaining_volume": remaining, "close_price": close_price, "profit": round(pnl, 2)}


def resolve_position_ticket(order_result, mt5_module):
    """Resolve the MT5 position id from an executed order/deal."""
    deal_ticket = int(getattr(order_result, "deal", 0) or 0)
    if deal_ticket:
        deals = mt5_module.history_deals_get(ticket=deal_ticket)
        if deals:
            for deal in reversed(deals):
                position_id = int(getattr(deal, "position_id", 0) or 0)
                if position_id > 0:
                    return position_id, deal_ticket

    order_ticket = int(getattr(order_result, "order", 0) or 0)
    if order_ticket:
        orders = mt5_module.history_orders_get(ticket=order_ticket)
        if orders:
            for order in reversed(orders):
                position_id = int(getattr(order, "position_id", 0) or 0)
                if position_id > 0:
                    return position_id, deal_ticket

    return 0, deal_ticket

def account_position_mode(info, mt5_module):
    """Return explicit MT5 position-account mode for execution safety."""
    margin_mode = getattr(info, "margin_mode", None)
    if margin_mode is None:
        return "UNKNOWN"
    hedging_mode = getattr(mt5_module, "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING", None)
    netting_mode = getattr(mt5_module, "ACCOUNT_MARGIN_MODE_RETAIL_NETTING", None)
    exchange_mode = getattr(mt5_module, "ACCOUNT_MARGIN_MODE_EXCHANGE", None)
    if hedging_mode is not None and margin_mode == hedging_mode:
        return "HEDGING"
    if netting_mode is not None and margin_mode == netting_mode:
        return "NETTING_OR_EXCHANGE"
    if exchange_mode is not None and margin_mode == exchange_mode:
        return "NETTING_OR_EXCHANGE"
    return "UNKNOWN"

def is_successful_trade_retcode(retcode, mt5_module) -> bool:
    """Accept both full and broker-reported partial market executions."""
    return int(retcode) in {
        int(getattr(mt5_module, "TRADE_RETCODE_DONE", -1)),
        int(getattr(mt5_module, "TRADE_RETCODE_DONE_PARTIAL", -2)),
    }


MT5_TIMEFRAMES = {
    "M1": "TIMEFRAME_M1",
    "M5": "TIMEFRAME_M5",
    "M15": "TIMEFRAME_M15",
    "M30": "TIMEFRAME_M30",
    "H1": "TIMEFRAME_H1",
    "H4": "TIMEFRAME_H4",
    "D1": "TIMEFRAME_D1",
}


def timeframe_constant(timeframe: str, mt5_module):
    """Resolve a domain timeframe to the corresponding MetaTrader5 constant."""
    key = str(timeframe or "").strip().upper()
    attr = MT5_TIMEFRAMES.get(key)
    if not attr:
        raise ValueError(
            "Unsupported timeframe; expected one of " +
            ", ".join(MT5_TIMEFRAMES.keys())
        )
    value = getattr(mt5_module, attr, None)
    if value is None:
        raise RuntimeError(f"MT5 timeframe constant {attr} is unavailable")
    return value


def _rate_field(row, name, default=0):
    """Read a field from a numpy record or dict-like fixture."""
    try:
        return getattr(row, name)
    except AttributeError:
        try:
            return row[name]
        except (KeyError, TypeError, IndexError):
            return default


def normalize_rates(rates) -> list[dict]:
    """Convert MT5 rates into the Node bridge candle schema."""
    if rates is None:
        return []

    result = []
    for row in rates:
        try:
            time_s = int(_rate_field(row, "time"))
            candle = {
                "time": time_s * 1000,
                "open": float(_rate_field(row, "open")),
                "high": float(_rate_field(row, "high")),
                "low": float(_rate_field(row, "low")),
                "close": float(_rate_field(row, "close")),
            }
            real_volume = float(_rate_field(row, "real_volume", 0) or 0)
            tick_volume = float(_rate_field(row, "tick_volume", 0) or 0)
            candle["volume"] = real_volume if real_volume > 0 else tick_volume
        except (TypeError, ValueError, KeyError, IndexError, AttributeError):
            continue

        if not all(
            isinstance(value, (int, float)) and
            value == value and
            value not in (float("inf"), float("-inf"))
            for value in candle.values()
        ):
            continue

        if any(candle[field] <= 0 for field in ("open", "high", "low", "close")):
            continue

        result.append(candle)

    result.sort(key=lambda candle: candle["time"])
    dedup = {}
    for candle in result:
        dedup[candle["time"]] = candle
    return list(dedup.values())


def fetch_closed_candles(mt5_module, symbol: str, timeframe: str, count: int):
    """Fetch only closed bars; position 0 is the still-forming bar in MT5."""
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 5000:
        raise ValueError("count must be an integer between 1 and 5000")

    tf = timeframe_constant(timeframe, mt5_module)
    rates = mt5_module.copy_rates_from_pos(symbol, tf, 1, count)
    return normalize_rates(rates)


# ─── Endpoints ───────────────────────────────────────────────────────────────

def validate_trade_permissions(side: str, symbol_info, mt5_module) -> tuple[bool, str]:
    """Validate broker trade-mode permission for the requested direction."""
    mode = int(getattr(symbol_info, "trade_mode", 4) or 0)
    disabled = int(getattr(mt5_module, "SYMBOL_TRADE_MODE_DISABLED", 0))
    long_only = int(getattr(mt5_module, "SYMBOL_TRADE_MODE_LONGONLY", 1))
    short_only = int(getattr(mt5_module, "SYMBOL_TRADE_MODE_SHORTONLY", 2))
    close_only = int(getattr(mt5_module, "SYMBOL_TRADE_MODE_CLOSEONLY", 3))

    if mode in (disabled, close_only):
        return False, f"symbol trade mode {mode} does not allow opening positions"
    if side == "BUY" and mode == short_only:
        return False, "symbol is short-only"
    if side == "SELL" and mode == long_only:
        return False, "symbol is long-only"
    return True, "OK"


def validate_stop_distance(side: str, price: float, sl: float, tp: float, symbol_info) -> tuple[bool, str]:
    """Validate SL/TP against broker-declared stop distance in points."""
    point = float(getattr(symbol_info, "point", 0) or 0)
    stops_level = float(getattr(symbol_info, "trade_stops_level", 0) or 0)
    if not (point > 0 and stops_level > 0):
        return True, "OK"

    minimum = stops_level * point
    if side == "BUY":
        sl_distance = price - sl
        tp_distance = tp - price
    else:
        sl_distance = sl - price
        tp_distance = price - tp

    if sl_distance < minimum - max(1e-12, minimum * 1e-9):
        return False, f"SL distance {sl_distance} below broker minimum {minimum}"
    if tp_distance < minimum - max(1e-12, minimum * 1e-9):
        return False, f"TP distance {tp_distance} below broker minimum {minimum}"
    return True, "OK"


def validate_trade_volume(volume: float, symbol_info) -> tuple[bool, str]:
    """Validate requested lots against broker symbol limits."""
    import math
    try:
        volume = float(volume)
        minimum = float(getattr(symbol_info, "volume_min", 0))
        maximum = float(getattr(symbol_info, "volume_max", 0))
        step = float(getattr(symbol_info, "volume_step", 0))
    except (TypeError, ValueError):
        return False, "Invalid broker volume metadata"
    if not all(math.isfinite(v) and v > 0 for v in (volume, minimum, maximum, step)):
        return False, "Invalid broker volume metadata"
    if maximum < minimum:
        return False, "Broker volume_max is below volume_min"
    eps = max(step * 1e-9, 1e-12)
    if volume < minimum - eps:
        return False, f"Volume {volume} below broker minimum {minimum}"
    if volume > maximum + eps:
        return False, f"Volume {volume} above broker maximum {maximum}"
    units = (volume - minimum) / step
    if abs(units - round(units)) > max(1e-8, eps / step):
        return False, f"Volume {volume} is not aligned to broker step {step}"
    return True, "OK"

def validate_aggregate_volume(symbol: str, side: str, volume: float, symbol_info, mt5_module) -> tuple[bool, str]:
    """Validate the broker's aggregate per-direction volume limit."""
    limit = float(getattr(symbol_info, "volume_limit", 0) or 0)
    if not (limit > 0):
        return True, "OK"

    positions = mt5_module.positions_get(symbol=symbol) or []
    buy_type = getattr(mt5_module, "POSITION_TYPE_BUY", 0)
    current = 0.0
    wanted_type = buy_type if side == "BUY" else 1

    for pos in positions:
        if int(getattr(pos, "type", 1)) == wanted_type:
            current += float(getattr(pos, "volume", 0) or 0)

    projected = current + float(volume)
    eps = max(1e-9, limit * 1e-8)
    if projected > limit + eps:
        return False, (
            f"Aggregate {side} volume {projected} exceeds "
            f"broker volume_limit {limit}"
        )
    return True, "OK"


def calculate_order_estimates(mt5_module, order_type, symbol, volume, open_price, stop_price) -> tuple[float, float]:
    """Return estimated stop-loss loss and required margin in account currency."""
    try:
        profit = mt5_module.order_calc_profit(
            order_type, symbol, volume, open_price, stop_price
        )
    except (TypeError, ValueError, OverflowError) as exc:
        raise RuntimeError(f"order_calc_profit returned invalid data: {exc}") from exc
    if profit is None:
        raise RuntimeError(
            f"order_calc_profit failed: {mt5_module.last_error()}"
        )
    try:
        profit_value = float(profit)
    except (TypeError, ValueError, OverflowError) as exc:
        raise RuntimeError(f"order_calc_profit returned non-numeric data: {exc}") from exc
    if not math.isfinite(profit_value):
        raise RuntimeError("MT5 returned non-finite order_calc_profit")

    try:
        margin = mt5_module.order_calc_margin(
            order_type, symbol, volume, open_price
        )
    except (TypeError, ValueError, OverflowError) as exc:
        raise RuntimeError(f"order_calc_margin returned invalid data: {exc}") from exc
    if margin is None:
        raise RuntimeError(
            f"order_calc_margin failed: {mt5_module.last_error()}"
        )
    try:
        margin_value = float(margin)
    except (TypeError, ValueError, OverflowError) as exc:
        raise RuntimeError(f"order_calc_margin returned non-numeric data: {exc}") from exc
    if not math.isfinite(margin_value) or margin_value < 0:
        raise RuntimeError("MT5 returned invalid risk estimates")

    loss = max(0.0, -profit_value)
    if not math.isfinite(loss):
        raise RuntimeError("MT5 returned invalid stop-loss estimate")
    return loss, margin_value

def choose_market_filling_mode(symbol_info, mt5_module):
    """Choose a filling policy permitted by the symbol execution mode."""
    execution_market = getattr(mt5_module, "SYMBOL_TRADE_EXECUTION_MARKET", None)
    execution_mode = getattr(symbol_info, "trade_exemode", None)
    order_return = getattr(mt5_module, "ORDER_FILLING_RETURN", None)
    order_ioc = getattr(mt5_module, "ORDER_FILLING_IOC", None)
    order_fok = getattr(mt5_module, "ORDER_FILLING_FOK", None)
    if execution_mode != execution_market and order_return is not None:
        return order_return
    flags = int(getattr(symbol_info, "filling_mode", 0) or 0)
    symbol_ioc = int(getattr(mt5_module, "SYMBOL_FILLING_IOC", 2))
    symbol_fok = int(getattr(mt5_module, "SYMBOL_FILLING_FOK", 1))
    if order_ioc is not None and (flags & symbol_ioc):
        return order_ioc
    if order_fok is not None and (flags & symbol_fok):
        return order_fok
    raise ValueError("No broker-supported market filling mode is available")

@app.route("/ping", methods=["GET"])
def ping():
    if not auth_check():
        return err("Unauthorized", 401)

    if BRIDGE_MODE == 'simulation':
        ok = ALLOW_ANON or bool(API_KEY)
        return jsonify({
            "ok": ok, "mode": BRIDGE_MODE, "mt5_available": MT5_AVAILABLE,
            "connected": True,
            "ts": datetime.now(timezone.utc).isoformat(),
        }), (200 if ok else 503)

    with _lock:
        connected = bool(MT5_AVAILABLE and API_KEY and ensure_connected())

    status = 200 if connected else 503
    return jsonify({
        "ok": connected,
        "mode": BRIDGE_MODE,
        "mt5_available": MT5_AVAILABLE,
        "connected": connected,
        "ts": datetime.now(timezone.utc).isoformat(),
    }), status


@app.route("/health", methods=["GET"])
def health():
    return ping()


@app.route("/account", methods=["GET"])
def account():
    if not auth_check():
        return err("Unauthorized", 401)

    if BRIDGE_MODE == 'simulation':
        return jsonify({
            "equity": 10000.0,
            "balance": 10000.0,
            "margin": 0.0,
            "free_margin": 10000.0,
            "margin_level": 0.0,
        })

    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)

        info = mt5.account_info()
        if not info:
            return err(f"Account info failed: {mt5.last_error()}")

        return jsonify({
            "equity":       info.equity,
            "balance":      info.balance,
            "margin":       info.margin,
            "free_margin":  info.margin_free,
            "margin_level": info.margin_level,
            "currency":     info.currency,
            "server":       info.server,
            "login":        info.login,
            "position_mode": account_position_mode(info, mt5),
        })


def simulation_tick(symbol: str) -> dict:
    import random
    mid = {"EURUSD": 1.0850, "GBPUSD": 1.2700, "USDJPY": 149.50,
           "XAUUSD": 2020.0, "BTCUSDT": 50000.0}.get(symbol, 1.0)
    spread = mid * 0.0002
    return {
        "symbol": symbol,
        "bid": mid - spread / 2,
        "ask": mid + spread / 2,
        "time": int(datetime.now(timezone.utc).timestamp()),
    }


@app.route("/tick", methods=["GET"])
def tick():
    if not auth_check():
        return err("Unauthorized", 401)

    symbol = request.args.get("symbol", "")
    if not symbol:
        return err("symbol required")

    if BRIDGE_MODE == 'simulation':
        return jsonify(simulation_tick(symbol))
    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)
        sym = mt5.symbol_info(symbol)
        if not sym:
            return err(f"Symbol {symbol} not found")
        if not sym.visible:
            mt5.symbol_select(symbol, True)
        tick_data = mt5.symbol_info_tick(symbol)
        if not tick_data:
            return err(f"No tick for {symbol}: {mt5.last_error()}")
        return jsonify({
            "symbol": symbol,
            "bid":    tick_data.bid,
            "ask":    tick_data.ask,
            "time":   tick_data.time,
            "spread": round((tick_data.ask - tick_data.bid) / sym.point, 1),
        })


@app.route("/contract", methods=["GET"])
def contract():
    """Return broker-confirmed symbol economics from MT5 symbol_info."""
    if not auth_check():
        return err("Unauthorized", 401)
    symbol = request.args.get("symbol", "").strip()
    if not symbol:
        return err("symbol required")
    if BRIDGE_MODE == "simulation":
        return err("Broker contract metadata is unavailable in simulation mode", 503)
    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)
        info = mt5.symbol_info(symbol)
        if not info:
            return err(f"Symbol {symbol} not found")
        if not info.visible:
            mt5.symbol_select(symbol, True)
            info = mt5.symbol_info(symbol)
        if not info:
            return err(f"Symbol {symbol} unavailable after selection")
        return jsonify({
            "symbol": info.name,
            "description": getattr(info, "description", ""),
            "currency_base": getattr(info, "currency_base", ""),
            "currency_profit": getattr(info, "currency_profit", ""),
            "trade_contract_size": getattr(info, "trade_contract_size", 0),
            "point": getattr(info, "point", 0),
            "digits": getattr(info, "digits", 0),
            "volume_min": getattr(info, "volume_min", 0),
            "volume_max": getattr(info, "volume_max", 0),
            "volume_step": getattr(info, "volume_step", 0),
            "trade_calc_mode": getattr(info, "trade_calc_mode", None),
            "trade_mode": getattr(info, "trade_mode", None),
            "trade_exemode": getattr(info, "trade_exemode", None),
            "trade_tick_size": getattr(info, "trade_tick_size", 0),
            "trade_tick_value": getattr(info, "trade_tick_value", 0),
            "trade_tick_value_loss": getattr(info, "trade_tick_value_loss", 0),
            "trade_tick_value_profit": getattr(info, "trade_tick_value_profit", 0),
            "volume_limit": getattr(info, "volume_limit", 0),
            "trade_stops_level": getattr(info, "trade_stops_level", 0),
            "trade_freeze_level": getattr(info, "trade_freeze_level", 0),
            "margin_initial": getattr(info, "margin_initial", 0),
            "margin_maintenance": getattr(info, "margin_maintenance", 0),
            "currency_margin": getattr(info, "currency_margin", ""),
            "time": int(datetime.now(timezone.utc).timestamp()),
        })


@app.route("/candles", methods=["GET"])
def candles():
    if not auth_check():
        return err("Unauthorized", 401)

    symbol = request.args.get("symbol", "").strip()
    timeframe = request.args.get("timeframe", "H1").strip().upper()
    if not symbol:
        return err("symbol required", 400)

    try:
        count = int(request.args.get("count", "250"))
    except (TypeError, ValueError):
        return err("count must be an integer", 400)

    if BRIDGE_MODE == "simulation":
        return err("Candle bridge is unavailable in simulation mode", 503)

    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)

        info = mt5.symbol_info(symbol)
        if not info:
            return err(f"Symbol {symbol} not found", 404)

        if not info.visible:
            if not mt5.symbol_select(symbol, True):
                return err(f"Symbol {symbol} could not be selected", 503)
            info = mt5.symbol_info(symbol)
            if not info:
                return err(f"Symbol {symbol} unavailable after selection", 503)

        try:
            data = fetch_closed_candles(mt5, symbol, timeframe, count)
        except ValueError as exc:
            return err(str(exc), 400)
        except RuntimeError as exc:
            return err(str(exc), 503)

        if not data:
            return err(
                f"No closed candle data for {symbol}/{timeframe}: {mt5.last_error()}",
                503,
            )

        return jsonify({
            "ok": True,
            "symbol": info.name,
            "timeframe": timeframe,
            "candles": data,
            "count": len(data),
        })


@app.route("/trade", methods=["POST"])
def trade():
    if not auth_check():
        return err("Unauthorized", 401)

    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return err("JSON object required", 422)

    symbol = str(data.get("symbol", "")).strip()
    side = str(data.get("side", "")).upper()
    comment = str(data.get("comment", "bot"))[:31]
    idempotency_key = str(data.get("idempotency_key", "")).strip()

    try:
        volume = float(data.get("volume", 0))
        sl = float(data.get("sl", 0))
        tp = float(data.get("tp", 0))
    except (TypeError, ValueError):
        return err("volume, sl and tp must be numeric", 422)

    if (
        not symbol or
        side not in ("BUY", "SELL") or
        not all(math.isfinite(value) for value in (volume, sl, tp)) or
        volume <= 0
    ):
        return err("Invalid parameters: symbol, side, finite volume/sl/tp required", 422)
    if BRIDGE_MODE == 'live' and not idempotency_key:
        return err("idempotency_key is required in live mode", 422)
    cached = _idempotency_lookup(idempotency_key)
    if cached:
        _, cached_status, cached_payload = cached
        if cached_status == "SUCCESS":
            return jsonify(cached_payload)
        if cached_status == "UNKNOWN":
            return err(
                "Previous execution with this idempotency_key is unresolved; reconciliation is required",
                503,
            )


    if BRIDGE_MODE == 'simulation':
        tick_data = simulation_tick(symbol)
        price = tick_data["ask"] if side == "BUY" else tick_data["bid"]
        pos = sim_open(symbol, side, volume, sl, tp, price)
        response_payload = {
            "ok": True, "ticket": pos["ticket"], "price": price,
            "volume": volume, "symbol": symbol, "mode": "simulation",
        }
        _idempotency_record(idempotency_key, "SUCCESS", response_payload)
        log.info(f"[SIM] {side} {volume} {symbol} @ {price} SL={sl} TP={tp}")
        return jsonify(response_payload)

    with _lock:
        cached = _idempotency_lookup(idempotency_key)
        if cached:
            _, cached_status, cached_payload = cached
            if cached_status == "SUCCESS":
                return jsonify(cached_payload)
            if cached_status == "UNKNOWN":
                return err(
                    "Previous execution with this idempotency_key is unresolved; reconciliation is required",
                    503,
                )
        if not ensure_connected():
            return err("MT5 not connected", 503)

        sym_info = mt5.symbol_info(symbol)
        if not sym_info:
            return err(f"Symbol {symbol} not found")
        if not sym_info.visible:
            if not mt5.symbol_select(symbol, True):
                return err(f"Symbol {symbol} could not be selected", 503)
            sym_info = mt5.symbol_info(symbol)
            if not sym_info:
                return err(f"Symbol {symbol} unavailable after selection", 503)

        if getattr(sym_info, "trade_mode", None) == getattr(mt5, "SYMBOL_TRADE_MODE_DISABLED", object()):
            return err(f"Symbol {symbol} trading is disabled", 409)

        permission_ok, permission_reason = validate_trade_permissions(
            side, sym_info, mt5
        )
        if not permission_ok:
            return err(permission_reason, 409)

        volume_ok, volume_reason = validate_trade_volume(volume, sym_info)
        if not volume_ok:
            return err(volume_reason, 422)

        aggregate_ok, aggregate_reason = validate_aggregate_volume(
            symbol, side, volume, sym_info, mt5
        )
        if not aggregate_ok:
            return err(aggregate_reason, 422)

        order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
        tick_data  = mt5.symbol_info_tick(symbol)
        if not tick_data:
            return err(f"No tick: {mt5.last_error()}")

        price = tick_data.ask if side == "BUY" else tick_data.bid

        # Final broker-side monetary risk guard. MT5 calculates profit and
        # margin in the current account/trading environment.
        if sl <= 0:
            return err("Live MT5 orders require a positive stop-loss", 422)
        if (side == "BUY" and sl >= price) or (side == "SELL" and sl <= price):
            return err("Stop-loss direction is invalid for the requested side", 422)
        if (side == "BUY" and tp <= price) or (side == "SELL" and tp >= price):
            return err("Take-profit direction is invalid for the requested side", 422)

        stops_ok, stops_reason = validate_stop_distance(
            side, price, sl, tp, sym_info
        )
        if not stops_ok:
            return err(stops_reason, 422)

        account = mt5.account_info()
        if not account:
            return err(f"Account info failed for risk guard: {mt5.last_error()}", 503)

        try:
            estimated_loss, estimated_margin = calculate_order_estimates(
                mt5, order_type, symbol, volume, price, sl
            )
        except RuntimeError as exc:
            return err(str(exc), 503)

        equity = float(getattr(account, "equity", 0.0))
        if not (equity > 0):
            return err("Invalid account equity for risk guard", 503)

        risk_limit = equity * 0.02
        if estimated_loss > risk_limit + max(0.01, risk_limit * 1e-9):
            return err(
                f"Estimated stop-loss risk {estimated_loss:.2f} exceeds "
                f"single-trade limit {risk_limit:.2f}",
                422,
            )

        try:
            free_margin = float(getattr(account, "margin_free", 0.0))
        except (TypeError, ValueError, OverflowError):
            return err("Invalid account free margin for risk guard", 503)
        if not math.isfinite(free_margin) or free_margin < 0:
            return err("Invalid account free margin for risk guard", 503)
        if estimated_margin > free_margin + max(0.01, free_margin * 1e-9):
            return err(
                f"Estimated margin {estimated_margin:.2f} exceeds "
                f"free margin {free_margin:.2f}",
                422,
            )

        try:
            deviation = int(os.getenv("MT5_MAX_DEVIATION_POINTS", "20"))
        except (TypeError, ValueError):
            return err("MT5_MAX_DEVIATION_POINTS must be an integer", 500)
        if deviation < 0:
            return err("MT5_MAX_DEVIATION_POINTS must be >= 0", 500)

        try:
            filling_mode = choose_market_filling_mode(sym_info, mt5)
        except ValueError as exc:
            return err(str(exc), 422)

        request_data = {
            "action":      mt5.TRADE_ACTION_DEAL,
            "symbol":      symbol,
            "volume":      volume,
            "type":        order_type,
            "price":       price,
            "sl":          sl,
            "tp":          tp,
            "deviation":   deviation,
            "magic":       get_magic(),
            "comment":     comment,
            "type_time":   mt5.ORDER_TIME_GTC,
            "type_filling": filling_mode,
        }

        check = mt5.order_check(request_data)
        if check is None:
            return err(f"order_check returned None: {mt5.last_error()}", 503)
        if int(getattr(check, "retcode", -1)) != 0:
            return err(
                f"Trade check failed: retcode={check.retcode} "
                f"comment={getattr(check, 'comment', '')}",
                422,
            )

        try:
            result = mt5.order_send(request_data)
        except Exception as exc:
            payload = {
                "ok": False,
                "error": f"order_send exception: {exc}",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        if result is None:
            payload = {
                "ok": False,
                "error": f"order_send returned None: {mt5.last_error()}",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        if not is_successful_trade_retcode(result.retcode, mt5):
            return err(f"Trade failed: retcode={result.retcode} comment={result.comment}")

        # Resolve the actual position ticket from the executed deal. MT5
        # distinguishes order, deal and position identifiers; downstream
        # close/modify operations require the position ticket.
        position_ticket, deal_ticket = resolve_position_ticket(result, mt5)

        positions_after = mt5.positions_get(ticket=position_ticket)
        if positions_after is None:
            payload = {
                "ok": False,
                "error": (
                    f"Trade executed but broker position state could not be queried: "
                    f"order={result.order} deal={deal_ticket}"
                ),
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        actual_volume = sum(
            float(getattr(position, "volume", 0.0) or 0.0)
            for position in positions_after
        )
        if not positions_after or not math.isfinite(actual_volume) or actual_volume <= 0:
            payload = {
                "ok": False,
                "error": (
                    f"Trade executed but position identity could not be resolved: "
                    f"order={result.order} deal={deal_ticket}"
                ),
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        primary_position = positions_after[0]
        actual_symbol = str(getattr(primary_position, "symbol", "") or "")
        actual_type = "BUY" if int(getattr(primary_position, "type", -1)) == int(
            getattr(mt5, "POSITION_TYPE_BUY", 0)
        ) else "SELL"
        actual_sl = float(getattr(primary_position, "sl", 0.0) or 0.0)
        actual_tp = float(getattr(primary_position, "tp", 0.0) or 0.0)
        price_tolerance = max(
            float(getattr(sym_info, "point", 0) or 0) * 1.5,
            1e-9,
        )
        if (
            actual_symbol.upper() != symbol.upper() or
            actual_type != side or
            not math.isfinite(actual_sl) or
            not math.isfinite(actual_tp) or
            actual_sl <= 0 or
            actual_tp <= 0 or
            abs(actual_sl - sl) > price_tolerance or
            abs(actual_tp - tp) > price_tolerance
        ):
            payload = {
                "ok": False,
                "error": (
                    f"Trade executed but broker position protection/state mismatched: "
                    f"symbol={actual_symbol} side={actual_type} sl={actual_sl} tp={actual_tp}"
                ),
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        log.info(
            f"[LIVE] {side} {volume} {symbol} order={result.order} deal={deal_ticket} "
            f"position={position_ticket} @ {result.price}"
        )
        response_payload = {
            "ok": True,
            "ticket": position_ticket,
            "order_ticket": int(result.order),
            "deal_ticket": deal_ticket,
            "price": result.price,
            "volume": actual_volume,
            "symbol": symbol,
            "retcode": result.retcode,
            "estimated_loss": estimated_loss,
            "risk_limit": risk_limit,
            "estimated_margin": float(estimated_margin),
            "free_margin": free_margin,
        }
        _idempotency_record(idempotency_key, "SUCCESS", response_payload)
        return jsonify(response_payload)


@app.route("/modify", methods=["POST"])
def modify():
    if not auth_check():
        return err("Unauthorized", 401)

    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return err("JSON object required", 422)

    idempotency_key = str(data.get("idempotency_key", "")).strip()
    try:
        ticket = int(data.get("ticket", 0))
        sl = float(data.get("sl", 0))
        tp = float(data.get("tp", 0))
    except (TypeError, ValueError):
        return err("ticket, sl and tp must be numeric", 422)

    if ticket <= 0:
        return err("ticket must be positive", 422)
    if BRIDGE_MODE == 'live' and not idempotency_key:
        return err("idempotency_key is required in live mode", 422)

    cached = _idempotency_lookup(idempotency_key)
    if cached:
        _, cached_status, cached_payload = cached
        if cached_status == "SUCCESS":
            return jsonify(cached_payload)
        if cached_status == "UNKNOWN":
            return err(
                "Previous modify execution with this idempotency_key is unresolved; reconciliation is required",
                503,
            )
    if not all(map(lambda value: value == value and abs(value) != float("inf"), (sl, tp))):
        return err("sl and tp must be finite", 422)

    if BRIDGE_MODE == 'simulation':
        if sl <= 0 or tp <= 0:
            return err("simulation SL/TP must be positive", 422)
        if ticket not in _sim_positions:
            return err(f"Position {ticket} not found", 404)
        _sim_positions[ticket]["sl"] = sl
        _sim_positions[ticket]["tp"] = tp
        response_payload = {"ok": True, "ticket": ticket, "sl": sl, "tp": tp}
        _idempotency_record(idempotency_key, "SUCCESS", response_payload)
        return jsonify(response_payload)

    with _lock:
        cached = _idempotency_lookup(idempotency_key)
        if cached:
            _, cached_status, cached_payload = cached
            if cached_status == "SUCCESS":
                return jsonify(cached_payload)
            if cached_status == "UNKNOWN":
                return err(
                    "Previous modify execution with this idempotency_key is unresolved; reconciliation is required",
                    503,
                )

        if not ensure_connected():
            return err("MT5 not connected", 503)

        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            return err(f"Position {ticket} not found: {mt5.last_error()}")

        pos = positions[0]
        sym_info = mt5.symbol_info(pos.symbol)
        if not sym_info:
            return err(f"Symbol {pos.symbol} metadata unavailable", 503)

        tick_data = mt5.symbol_info_tick(pos.symbol)
        if not tick_data:
            return err(f"No tick for modify {pos.symbol}: {mt5.last_error()}", 503)

        current_price = tick_data.bid if pos.type == 0 else tick_data.ask
        side = "BUY" if pos.type == 0 else "SELL"

        if sl <= 0 or tp <= 0:
            return err("Live MT5 protective SL/TP must be positive", 422)

        if (side == "BUY" and (sl >= current_price or tp <= current_price)) or (
            side == "SELL" and (sl <= current_price or tp >= current_price)
        ):
            return err("Modified SL/TP direction is invalid for the current market price", 422)

        stops_ok, stops_reason = validate_stop_distance(
            side, current_price, sl, tp, sym_info
        )
        if not stops_ok:
            return err(stops_reason, 422)

        request_data = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": pos.symbol,
            "position": ticket,
            "sl": sl,
            "tp": tp,
        }

        check = mt5.order_check(request_data)
        if check is None:
            return err(f"Modify order_check returned None: {mt5.last_error()}", 503)
        if int(getattr(check, "retcode", -1)) != 0:
            return err(
                f"Modify check failed: retcode={check.retcode} "
                f"comment={getattr(check, 'comment', '')}",
                422,
            )

        try:
            result = mt5.order_send(request_data)
        except Exception as exc:
            payload = {"ok": False, "error": f"Modify order_send exception: {exc}"}
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503
        if result is None:
            payload = {"ok": False, "error": f"Modify result unavailable: {mt5.last_error()}"}
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503
        if int(getattr(result, "retcode", -1)) != int(getattr(mt5, "TRADE_RETCODE_DONE", -2)):
            return err(f"Modify failed: {getattr(result, 'retcode', mt5.last_error())}")

        positions_after = mt5.positions_get(ticket=ticket)
        if positions_after is None:
            payload = {
                "ok": False,
                "error": f"Modify executed but post-modify position state is unavailable for {ticket}",
                "ticket": ticket,
                "status": "UNKNOWN",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503
        if not positions_after:
            payload = {
                "ok": False,
                "error": f"Modify executed but position {ticket} disappeared before verification",
                "ticket": ticket,
                "status": "UNKNOWN",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        verified = positions_after[0]
        verified_sl = float(getattr(verified, "sl", 0.0) or 0.0)
        verified_tp = float(getattr(verified, "tp", 0.0) or 0.0)
        price_tolerance = max(
            float(getattr(sym_info, "point", 0) or 0) * 1.5,
            1e-9,
        )
        if (
            not math.isfinite(verified_sl) or
            not math.isfinite(verified_tp) or
            verified_sl <= 0 or
            verified_tp <= 0 or
            abs(verified_sl - sl) > price_tolerance or
            abs(verified_tp - tp) > price_tolerance
        ):
            payload = {
                "ok": False,
                "error": (
                    f"Modify executed but broker SL/TP could not be verified for {ticket}: "
                    f"sl={verified_sl} tp={verified_tp}"
                ),
                "ticket": ticket,
                "status": "UNKNOWN",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        response_payload = {
            "ok": True,
            "ticket": ticket,
            "sl": sl,
            "tp": tp,
        }
        _idempotency_record(idempotency_key, "SUCCESS", response_payload)
        log.info(
            f"[LIVE] Modified {ticket} {pos.symbol} side={side} SL={sl} TP={tp}"
        )
        return jsonify(response_payload)


@app.route("/close", methods=["POST"])
def close():
    if not auth_check():
        return err("Unauthorized", 401)

    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return err("JSON object required", 422)

    idempotency_key = str(data.get("idempotency_key", "")).strip()
    try:
        ticket = int(data.get("ticket", 0))
    except (TypeError, ValueError):
        return err("ticket must be an integer", 422)

    if not ticket:
        return err("ticket required")
    if BRIDGE_MODE == 'live' and not idempotency_key:
        return err("idempotency_key is required in live mode", 422)

    cached = _idempotency_lookup(idempotency_key)
    if cached:
        _, cached_status, cached_payload = cached
        if cached_status == "SUCCESS":
            return jsonify(cached_payload)
        if cached_status == "UNKNOWN":
            return err(
                "Previous close with this idempotency_key is unresolved; reconciliation is required",
                503,
            )

    if BRIDGE_MODE == 'simulation':
        result = sim_close(ticket, 1.0)
        if result.get("ok"):
            _idempotency_record(idempotency_key, "SUCCESS", result)
        return jsonify(result)

    with _lock:
        cached = _idempotency_lookup(idempotency_key)
        if cached:
            _, cached_status, cached_payload = cached
            if cached_status == "SUCCESS":
                return jsonify(cached_payload)
            if cached_status == "UNKNOWN":
                return err(
                    "Previous close with this idempotency_key is unresolved; reconciliation is required",
                    503,
                )

        if not ensure_connected():
            return err("MT5 not connected", 503)

        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            return err(f"Position {ticket} not found")

        pos       = positions[0]
        tick_data = mt5.symbol_info_tick(pos.symbol)
        if not tick_data:
            return err(f"No tick for close {pos.symbol}: {mt5.last_error()}", 503)
        close_price = tick_data.bid if pos.type == 0 else tick_data.ask  # 0=BUY

        volume_ok, volume_reason = validate_trade_volume(float(pos.volume), mt5.symbol_info(pos.symbol))
        if not volume_ok:
            return err(volume_reason, 422)

        close_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY
        try:
            filling_mode = choose_market_filling_mode(mt5.symbol_info(pos.symbol), mt5)
        except ValueError as exc:
            return err(str(exc), 422)
        request_data = {
            "action":      mt5.TRADE_ACTION_DEAL,
            "symbol":      pos.symbol,
            "volume":      pos.volume,
            "type":        close_type,
            "position":    ticket,
            "price":       close_price,
            "deviation":   int(os.getenv("MT5_MAX_DEVIATION_POINTS", "20")),
            "magic":       get_magic(),
            "comment":     "bot-close",
            "type_time":   mt5.ORDER_TIME_GTC,
            "type_filling": filling_mode,
        }
        check = mt5.order_check(request_data)
        if check is None:
            return err(f"Close order_check returned None: {mt5.last_error()}", 503)
        if int(getattr(check, "retcode", -1)) != 0:
            return err(f"Close check failed: retcode={check.retcode} comment={getattr(check, 'comment', '')}", 422)
        try:
            result = mt5.order_send(request_data)
        except Exception as exc:
            payload = {"ok": False, "error": f"Close order_send exception: {exc}"}
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        if result is None:
            payload = {"ok": False, "error": f"Close result unavailable: {mt5.last_error()}"}
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        if not is_successful_trade_retcode(result.retcode, mt5):
            return err(f"Close failed: {result.retcode}")

        remaining_after_close = mt5.positions_get(ticket=ticket)
        if remaining_after_close is None:
            payload = {
                "ok": False,
                "error": f"Position {ticket} close was submitted but post-close position state is unavailable",
                "ticket": ticket,
                "status": "UNKNOWN",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        if remaining_after_close:
            remaining_volume = sum(
                float(getattr(position, "volume", 0.0) or 0.0)
                for position in remaining_after_close
            )
            payload = {
                "ok": False,
                "error": (
                    f"Position {ticket} was not fully closed; authoritative "
                    f"reconciliation required (remaining_volume={remaining_volume})"
                ),
                "ticket": ticket,
                "remaining_volume": remaining_volume,
                "status": "UNKNOWN",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        deals = mt5.history_deals_get(position=ticket)
        if deals is None:
            payload = {
                "ok": False,
                "error": f"Position {ticket} closed but realized deal history is unavailable",
                "ticket": ticket,
                "status": "UNKNOWN",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        summary = summarize_position_deals(deals)
        if not summary or not summary.get("closed"):
            # A successful server retcode is not sufficient: the authoritative
            # position/deal view must prove the whole position is closed.
            payload = {
                "ok": False,
                "error": (
                    f"Position {ticket} close execution is not yet authoritative "
                    "or remained partially open; reconciliation is required"
                ),
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        profit = summary["net_profit"]
        close_price_realized = summary["close_price"]
        log.info(
            f"[LIVE] Closed {ticket} {pos.symbol} realized_net={profit:.2f} "
            f"close_price={close_price_realized}"
        )
        response_payload = {
            "ok": True,
            "ticket": ticket,
            "profit": profit,
            "close_price": close_price_realized,
            "close_reason": summary["close_reason"],
            "close_deal_ticket": summary["close_deal_ticket"],
        }
        _idempotency_record(idempotency_key, "SUCCESS", response_payload)
        return jsonify(response_payload)


@app.route("/close_partial", methods=["POST"])
def close_partial():
    if not auth_check():
        return err("Unauthorized", 401)

    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return err("JSON object required", 422)

    idempotency_key = str(data.get("idempotency_key", "")).strip()
    try:
        ticket = int(data.get("ticket", 0))
        fraction = float(data.get("fraction", 0.5))
    except (TypeError, ValueError):
        return err("ticket and fraction must be numeric", 422)

    if not ticket or not (0 < fraction <= 1.0) or not math.isfinite(fraction):
        return err("ticket and finite fraction (0..1] required", 422)
    if BRIDGE_MODE == 'live' and not idempotency_key:
        return err("idempotency_key is required in live mode", 422)

    cached = _idempotency_lookup(idempotency_key)
    if cached:
        _, cached_status, cached_payload = cached
        if cached_status == "SUCCESS":
            return jsonify(cached_payload)
        if cached_status == "UNKNOWN":
            return err(
                "Previous partial close with this idempotency_key is unresolved; reconciliation is required",
                503,
            )

    if BRIDGE_MODE == 'simulation':
        result = sim_close(ticket, fraction)
        if result.get("ok"):
            _idempotency_record(idempotency_key, "SUCCESS", result)
        return jsonify(result)

    with _lock:
        cached = _idempotency_lookup(idempotency_key)
        if cached:
            _, cached_status, cached_payload = cached
            if cached_status == "SUCCESS":
                return jsonify(cached_payload)
            if cached_status == "UNKNOWN":
                return err(
                    "Previous partial close with this idempotency_key is unresolved; reconciliation is required",
                    503,
                )

        if not ensure_connected():
            return err("MT5 not connected", 503)

        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            return err(f"Position {ticket} not found")

        pos       = positions[0]
        sym_info  = mt5.symbol_info(pos.symbol)
        if not sym_info:
            return err(f"Symbol {pos.symbol} metadata unavailable", 503)
        vol_step  = float(getattr(sym_info, "volume_step", 0))
        if not vol_step > 0:
            return err(f"Invalid broker volume step for {pos.symbol}", 422)
        close_vol = max(vol_step, round(pos.volume * fraction / vol_step) * vol_step)
        close_vol = min(close_vol, pos.volume)
        if close_vol >= float(pos.volume) - max(1e-12, vol_step * 1e-9):
            return err(
                "Requested partial close rounds to full position; refusing implicit full close",
                422,
            )
        volume_ok, volume_reason = validate_trade_volume(close_vol, sym_info)
        if not volume_ok:
            return err(volume_reason, 422)

        tick_data   = mt5.symbol_info_tick(pos.symbol)
        if not tick_data:
            return err(f"No tick for partial close {pos.symbol}: {mt5.last_error()}", 503)
        close_price = tick_data.bid if pos.type == 0 else tick_data.ask
        close_type  = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY
        try:
            filling_mode = choose_market_filling_mode(sym_info, mt5)
        except ValueError as exc:
            return err(str(exc), 422)

        request_data = {
            "action":      mt5.TRADE_ACTION_DEAL,
            "symbol":      pos.symbol,
            "volume":      close_vol,
            "type":        close_type,
            "position":    ticket,
            "price":       close_price,
            "deviation":   int(os.getenv("MT5_MAX_DEVIATION_POINTS", "20")),
            "magic":       get_magic(),
            "comment":     f"bot-partial-{int(fraction*100)}pct",
            "type_time":   mt5.ORDER_TIME_GTC,
            "type_filling": filling_mode,
        }
        check = mt5.order_check(request_data)
        if check is None:
            return err(f"Partial close order_check returned None: {mt5.last_error()}", 503)
        if int(getattr(check, "retcode", -1)) != 0:
            return err(f"Partial close check failed: retcode={check.retcode} comment={getattr(check, 'comment', '')}", 422)
        try:
            result = mt5.order_send(request_data)
        except Exception as exc:
            payload = {"ok": False, "error": f"Partial close order_send exception: {exc}"}
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        if result is None:
            payload = {"ok": False, "error": f"Partial close result unavailable: {mt5.last_error()}"}
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        if not is_successful_trade_retcode(result.retcode, mt5):
            return err(f"Partial close failed: {result.retcode}")

        deal_ticket = int(getattr(result, "deal", 0) or 0)
        deals = mt5.history_deals_get(ticket=deal_ticket) if deal_ticket else []
        if not deals:
            payload = {
                "ok": False,
                "error": f"Partial close {ticket} executed but realized deal history is unavailable",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        close_deal = deals[-1]
        realized_profit = round(
            float(getattr(close_deal, "profit", 0) or 0) +
            float(getattr(close_deal, "commission", 0) or 0) +
            float(getattr(close_deal, "swap", 0) or 0) +
            float(getattr(close_deal, "fee", 0) or 0),
            8,
        )

        remaining_positions = mt5.positions_get(ticket=ticket) or []
        if not remaining_positions:
            payload = {
                "ok": False,
                "error": f"Partial close {ticket} executed but remaining position could not be verified",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503
        remaining_volume = float(remaining_positions[0].volume)
        if not (0 < remaining_volume < float(pos.volume)):
            payload = {
                "ok": False,
                "error": f"Partial close {ticket} returned invalid remaining volume {remaining_volume}",
            }
            _idempotency_record(idempotency_key, "UNKNOWN", payload)
            return jsonify(payload), 503

        log.info(
            f"[LIVE] Partial close {ticket}: {close_vol}/{pos.volume} lots "
            f"remaining={remaining_volume} realized={realized_profit:.8f}"
        )
        response_payload = {
            "ok": True,
            "ticket": ticket,
            "deal_ticket": deal_ticket,
            "closed_volume": close_vol,
            "remaining_volume": round(remaining_volume, 8),
            "close_price": float(getattr(close_deal, "price", close_price) or close_price),
            "profit": realized_profit,
        }
        _idempotency_record(idempotency_key, "SUCCESS", response_payload)
        return jsonify(response_payload)


@app.route("/positions", methods=["GET"])
def positions():
    if not auth_check():
        return err("Unauthorized", 401)

    if BRIDGE_MODE == 'simulation':
        return jsonify({"positions": list(_sim_positions.values()), "count": len(_sim_positions)})

    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)
        pos_list = mt5.positions_get()
        if pos_list is None:
            return err(f"MT5 positions query failed: {mt5.last_error()}", 503)
        result = []
        for p in pos_list:
            result.append({
                "ticket":  p.ticket,
                "symbol":  p.symbol,
                "type":    "BUY" if p.type == 0 else "SELL",
                "volume":  p.volume,
                "price":   p.price_open,
                "sl":      p.sl,
                "tp":      p.tp,
                "profit":  p.profit,
                "swap":    p.swap,
                "comment": p.comment,
                "time":    p.time,
            })
        return jsonify({"positions": result, "count": len(result)})


def summarize_position_deals(deals):
    """Build authoritative cumulative realized data from one MT5 position."""
    if not deals:
        return None

    def value(deal, name, default=0):
        try:
            return float(getattr(deal, name, default) or default)
        except (TypeError, ValueError):
            return float(default)

    def int_value(deal, name, default=0):
        try:
            return int(getattr(deal, name, default) or default)
        except (TypeError, ValueError):
            return int(default)

    ordered = sorted(
        deals,
        key=lambda d: (
            int_value(d, "time_msc", int_value(d, "time", 0) * 1000),
            int_value(d, "ticket", 0),
        ),
    )

    opening = [
        d for d in ordered
        if int_value(d, "entry", 0) == 0
    ]
    closing = [
        d for d in ordered
        if int_value(d, "entry", 0) in (1, 2, 3)
    ]
    if not closing:
        return None

    opened_volume = sum(value(d, "volume") for d in opening)
    closed_volume = sum(value(d, "volume") for d in closing)
    remaining_volume = max(0.0, opened_volume - closed_volume)

    latest = closing[-1]

    # Cumulative position-level realized result so far. This includes the
    # opening deal's commission/swap/fee because those costs belong to the
    # position and must be represented in the eventual net result.
    net_profit = sum(
        value(d, "profit") + value(d, "commission") +
        value(d, "swap") + value(d, "fee")
        for d in ordered
    )

    comments = [
        str(getattr(d, "comment", "") or "").lower()
        for d in reversed(closing)
    ]
    matched_comment = next(
        (c for c in comments if "sl" in c or "tp" in c),
        "",
    )
    close_reason = (
        "SL" if "sl" in matched_comment
        else "TP" if "tp" in matched_comment
        else "manual"
    )

    closed = (
        opened_volume > 0 and
        closed_volume >= opened_volume - max(1e-10, opened_volume * 1e-8)
    )

    close_time_msc = int_value(
        latest,
        "time_msc",
        int_value(latest, "time", 0) * 1000,
    )
    return {
        "close_price": value(latest, "price"),
        "net_profit": round(net_profit, 8),
        "close_reason": close_reason,
        "position_id": int_value(latest, "position_id"),
        "close_deal_ticket": int_value(latest, "ticket"),
        "close_time_msc": close_time_msc,
        "opened_volume": round(opened_volume, 8),
        "closed_volume": round(closed_volume, 8),
        "remaining_volume": round(remaining_volume, 8),
        "closed": closed,
    }

@app.route("/history", methods=["GET"])
def history():
    if not auth_check():
        return err("Unauthorized", 401)
    if BRIDGE_MODE == 'simulation':
        return jsonify({"deals": [], "count": 0, "closed": False})

    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)
        from datetime import timedelta
        position_raw = request.args.get("position", "").strip()
        if position_raw:
            try:
                position_id = int(position_raw)
            except ValueError:
                return err("position must be an integer", 400)
            if position_id <= 0:
                return err("position must be positive", 400)
            deals = mt5.history_deals_get(position=position_id)
            if deals is None:
                return err(
                    f"MT5 position history query failed: {mt5.last_error()}",
                    503,
                )
            summary = summarize_position_deals(deals)
            if not summary:
                return jsonify({"deals": [], "count": len(deals), "closed": False})
            return jsonify({"deals": [], "count": len(deals), **summary})

        utcnow = datetime.now(timezone.utc)
        deals = mt5.history_deals_get(utcnow - timedelta(days=30), utcnow)
        if deals is None:
            return err(
                f"MT5 history query failed: {mt5.last_error()}",
                503,
            )
        result = [
            {
                "ticket": d.ticket, "order": d.order,
                "position_id": getattr(d, "position_id", 0),
                "entry": getattr(d, "entry", None), "symbol": d.symbol,
                "type": d.type, "volume": d.volume, "price": d.price,
                "profit": d.profit, "commission": getattr(d, "commission", 0),
                "swap": getattr(d, "swap", 0), "fee": getattr(d, "fee", 0),
                "time": d.time, "time_msc": getattr(d, "time_msc", 0),
                "comment": d.comment,
            }
            for d in deals
        ]
        return jsonify({"deals": result[-50:], "count": len(deals)})


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info(f"MT5 Bridge starting on port {BRIDGE_PORT}")
    log.info(f"Configured mode: {BRIDGE_MODE}")
    if BRIDGE_MODE not in ('live', 'simulation'):
        log.error('MT5_BRIDGE_MODE must be live or simulation')
        raise SystemExit(1)
    if BRIDGE_MODE == 'live' and not MT5_AVAILABLE:
        log.error('Live bridge requested but MetaTrader5 package is unavailable — FAIL CLOSED')
        raise SystemExit(1)
    if BRIDGE_MODE == 'live' and not API_KEY:
        log.error('MT5_BRIDGE_API_KEY is required in live mode — FAIL CLOSED')
        raise SystemExit(1)
    if BRIDGE_MODE == 'simulation' and not ALLOW_ANON and not API_KEY:
        log.error('Simulation mode also requires MT5_BRIDGE_API_KEY unless MT5_BRIDGE_ALLOW_ANONYMOUS=true is explicitly set')
        raise SystemExit(1)
    if MT5_AVAILABLE:
        log.info(f"Connecting: login={MT5_LOGIN} server={MT5_SERVER}")
        if not ensure_connected():
            log.error("MT5 connection failed — check credentials in .env")
            exit(1)
        log.info("MT5 connected ✅")
    elif BRIDGE_MODE == 'simulation':
        log.info('Running in explicitly configured simulation mode')
    log.info(f"API Key: {'SET' if API_KEY else 'ANONYMOUS SIMULATION ONLY' if ALLOW_ANON else 'MISSING'}")
    app.run(host="127.0.0.1", port=BRIDGE_PORT, threaded=True, debug=False)
