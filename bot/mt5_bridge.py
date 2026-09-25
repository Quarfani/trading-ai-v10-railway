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


def auth_check() -> bool:
    """Verify API key; live bridge is never anonymously accessible."""
    if not API_KEY:
        return BRIDGE_MODE == 'simulation' and ALLOW_ANON
    return request.headers.get("X-Api-Key") == API_KEY


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


# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.route("/ping", methods=["GET"])
def ping():
    ok = (BRIDGE_MODE == 'simulation' and ALLOW_ANON) or (BRIDGE_MODE == 'live' and MT5_AVAILABLE and bool(API_KEY))
    status = 200 if ok else 503
    return jsonify({"ok": ok, "mode": BRIDGE_MODE, "mt5_available": MT5_AVAILABLE,
                    "ts": datetime.now(timezone.utc).isoformat()}), status


@app.route("/health", methods=["GET"])
def health():
    return ping()


@app.route("/account", methods=["GET"])
def account():
    if not auth_check():
        return err("Unauthorized", 401)

    if BRIDGE_MODE == 'simulation':
        return jsonify({"equity": 10000.0, "balance": 10000.0,
                        "margin": 0.0, "free_margin": 10000.0, "margin_level": 0.0})
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
        })


@app.route("/tick", methods=["GET"])
def tick():
    if not auth_check():
        return err("Unauthorized", 401)

    symbol = request.args.get("symbol", "")
    if not symbol:
        return err("symbol required")

    if BRIDGE_MODE == 'simulation':
        import random
        mid = {"EURUSD": 1.0850, "GBPUSD": 1.2700, "USDJPY": 149.50,
               "XAUUSD": 2020.0, "BTCUSDT": 50000.0}.get(symbol, 1.0)
        spread = mid * 0.0002
        return jsonify({"symbol": symbol, "bid": mid - spread/2,
                        "ask": mid + spread/2, "time": int(datetime.now(timezone.utc).timestamp())})
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


@app.route("/trade", methods=["POST"])
def trade():
    if not auth_check():
        return err("Unauthorized", 401)

    data   = request.get_json(force=True)
    symbol = data.get("symbol", "")
    side   = data.get("side", "").upper()
    volume = float(data.get("volume", 0))
    sl     = float(data.get("sl", 0))
    tp     = float(data.get("tp", 0))
    comment= str(data.get("comment", "bot"))[:31]

    if not symbol or side not in ("BUY", "SELL") or volume <= 0:
        return err("Invalid parameters: symbol, side, volume required")

    if BRIDGE_MODE == 'simulation':
        # Simulation mode
        tick_r = tick()
        if isinstance(tick_r, tuple):
            tick_data = tick_r[0].get_json()
        else:
            tick_data = tick_r.get_json()
        price = tick_data["ask"] if side == "BUY" else tick_data["bid"]
        pos   = sim_open(symbol, side, volume, sl, tp, price)
        log.info(f"[SIM] {side} {volume} {symbol} @ {price} SL={sl} TP={tp}")
        return jsonify({"ok": True, "ticket": pos["ticket"], "price": price,
                        "volume": volume, "symbol": symbol, "mode": "simulation"})

    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)

        sym_info = mt5.symbol_info(symbol)
        if not sym_info:
            return err(f"Symbol {symbol} not found")
        if not sym_info.visible:
            mt5.symbol_select(symbol, True)

        order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
        tick_data  = mt5.symbol_info_tick(symbol)
        if not tick_data:
            return err(f"No tick: {mt5.last_error()}")

        price = tick_data.ask if side == "BUY" else tick_data.bid
        deviation = 20  # max slippage in points

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
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        result = mt5.order_send(request_data)
        if result is None:
            return err(f"order_send returned None: {mt5.last_error()}")

        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return err(f"Trade failed: retcode={result.retcode} comment={result.comment}")

        log.info(f"[LIVE] {side} {volume} {symbol} ticket={result.order} @ {result.price}")
        return jsonify({
            "ok":     True,
            "ticket": result.order,
            "price":  result.price,
            "volume": volume,
            "symbol": symbol,
            "retcode": result.retcode,
        })


@app.route("/modify", methods=["POST"])
def modify():
    if not auth_check():
        return err("Unauthorized", 401)

    data   = request.get_json(force=True)
    ticket = int(data.get("ticket", 0))
    sl     = float(data.get("sl", 0))
    tp     = float(data.get("tp", 0))

    if not ticket:
        return err("ticket required")

    if BRIDGE_MODE == 'simulation':
        if ticket in _sim_positions:
            _sim_positions[ticket]["sl"] = sl
            _sim_positions[ticket]["tp"] = tp
        return jsonify({"ok": True, "ticket": ticket, "sl": sl, "tp": tp})

    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)

        # Find position
        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            return err(f"Position {ticket} not found: {mt5.last_error()}")

        pos = positions[0]
        request_data = {
            "action":   mt5.TRADE_ACTION_SLTP,
            "symbol":   pos.symbol,
            "position": ticket,
            "sl":       sl,
            "tp":       tp,
        }
        result = mt5.order_send(request_data)
        if not result or result.retcode != mt5.TRADE_RETCODE_DONE:
            return err(f"Modify failed: {result.retcode if result else mt5.last_error()}")

        return jsonify({"ok": True, "ticket": ticket, "sl": sl, "tp": tp})


@app.route("/close", methods=["POST"])
def close():
    if not auth_check():
        return err("Unauthorized", 401)

    data   = request.get_json(force=True)
    ticket = int(data.get("ticket", 0))
    if not ticket:
        return err("ticket required")

    if BRIDGE_MODE == 'simulation':
        result = sim_close(ticket, 1.0)
        return jsonify(result)

    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)

        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            return err(f"Position {ticket} not found")

        pos       = positions[0]
        tick_data = mt5.symbol_info_tick(pos.symbol)
        close_price = tick_data.bid if pos.type == 0 else tick_data.ask  # 0=BUY

        close_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY
        request_data = {
            "action":      mt5.TRADE_ACTION_DEAL,
            "symbol":      pos.symbol,
            "volume":      pos.volume,
            "type":        close_type,
            "position":    ticket,
            "price":       close_price,
            "deviation":   20,
            "magic":       get_magic(),
            "comment":     "bot-close",
            "type_time":   mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        result = mt5.order_send(request_data)
        if not result or result.retcode != mt5.TRADE_RETCODE_DONE:
            return err(f"Close failed: {result.retcode if result else mt5.last_error()}")

        profit = pos.profit
        log.info(f"[LIVE] Closed {ticket} {pos.symbol} profit={profit:.2f}")
        return jsonify({"ok": True, "ticket": ticket, "profit": profit,
                        "close_price": close_price})


@app.route("/close_partial", methods=["POST"])
def close_partial():
    if not auth_check():
        return err("Unauthorized", 401)

    data     = request.get_json(force=True)
    ticket   = int(data.get("ticket", 0))
    fraction = float(data.get("fraction", 0.5))

    if not ticket or not (0 < fraction <= 1.0):
        return err("ticket and fraction (0..1] required")

    if BRIDGE_MODE == 'simulation':
        result = sim_close(ticket, fraction)
        return jsonify(result)

    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)

        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            return err(f"Position {ticket} not found")

        pos       = positions[0]
        sym_info  = mt5.symbol_info(pos.symbol)
        vol_step  = sym_info.volume_step if sym_info else 0.01
        close_vol = max(vol_step, round(pos.volume * fraction / vol_step) * vol_step)
        close_vol = min(close_vol, pos.volume)

        tick_data   = mt5.symbol_info_tick(pos.symbol)
        close_price = tick_data.bid if pos.type == 0 else tick_data.ask
        close_type  = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY

        request_data = {
            "action":      mt5.TRADE_ACTION_DEAL,
            "symbol":      pos.symbol,
            "volume":      close_vol,
            "type":        close_type,
            "position":    ticket,
            "price":       close_price,
            "deviation":   20,
            "magic":       get_magic(),
            "comment":     f"bot-partial-{int(fraction*100)}pct",
            "type_time":   mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        result = mt5.order_send(request_data)
        if not result or result.retcode != mt5.TRADE_RETCODE_DONE:
            return err(f"Partial close failed: {result.retcode if result else mt5.last_error()}")

        log.info(f"[LIVE] Partial close {ticket}: {close_vol}/{pos.volume} lots @ {close_price}")
        return jsonify({"ok": True, "ticket": ticket, "closed_volume": close_vol,
                        "remaining_volume": round(pos.volume - close_vol, 4),
                        "close_price": close_price})


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
            return jsonify({"positions": [], "count": 0})
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


@app.route("/history", methods=["GET"])
def history():
    if not auth_check():
        return err("Unauthorized", 401)
    if BRIDGE_MODE == 'simulation':
        return jsonify({"deals": [], "count": 0})

    with _lock:
        if not ensure_connected():
            return err("MT5 not connected", 503)
        from datetime import timedelta
        utcnow = datetime.now(timezone.utc)
        deals  = mt5.history_deals_get(utcnow - timedelta(days=30), utcnow)
        if deals is None:
            return jsonify({"deals": [], "count": 0})
        result = [
            {"ticket": d.ticket, "order": d.order, "symbol": d.symbol,
             "type": d.type, "volume": d.volume, "price": d.price,
             "profit": d.profit, "time": d.time, "comment": d.comment}
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
