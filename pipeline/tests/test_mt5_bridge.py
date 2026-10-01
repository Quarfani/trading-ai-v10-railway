import types
import pytest

from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location("mt5_bridge", "bot/mt5_bridge.py")
bridge = module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)


def info(**kwargs):
    defaults = {"volume_min": 0.01, "volume_max": 100.0, "volume_step": 0.01, "trade_exemode": 1, "filling_mode": 3}
    defaults.update(kwargs)
    return types.SimpleNamespace(**defaults)


def fake_mt5():
    return types.SimpleNamespace(
        SYMBOL_TRADE_EXECUTION_MARKET=2,
        SYMBOL_FILLING_FOK=1,
        SYMBOL_FILLING_IOC=2,
        ORDER_FILLING_FOK=0,
        ORDER_FILLING_IOC=1,
        ORDER_FILLING_RETURN=2,
    )


def test_volume_limits_and_step():
    ok, _ = bridge.validate_trade_volume(0.03, info(),)
    assert ok
    assert not bridge.validate_trade_volume(0.005, info())[0]
    assert not bridge.validate_trade_volume(100.01, info())[0]
    assert not bridge.validate_trade_volume(0.025, info())[0]


def test_return_filling_for_non_market_execution():
    mt5 = fake_mt5()
    assert bridge.choose_market_filling_mode(info(trade_exemode=1), mt5) == mt5.ORDER_FILLING_RETURN


def test_market_execution_uses_supported_ioc():
    mt5 = fake_mt5()
    assert bridge.choose_market_filling_mode(info(trade_exemode=mt5.SYMBOL_TRADE_EXECUTION_MARKET, filling_mode=2), mt5) == mt5.ORDER_FILLING_IOC


def test_market_execution_fails_when_no_supported_fill_policy():
    mt5 = fake_mt5()
    with pytest.raises(ValueError):
        bridge.choose_market_filling_mode(info(trade_exemode=mt5.SYMBOL_TRADE_EXECUTION_MARKET, filling_mode=0), mt5)



def deal(**kwargs):
    defaults = {
        "ticket": 100,
        "order": 200,
        "position_id": 42,
        "entry": 1,
        "time": 1000,
        "time_msc": 1000000,
        "price": 1.2345,
        "profit": 25.0,
        "commission": -2.0,
        "swap": -1.0,
        "fee": -0.5,
        "comment": "",
    }
    defaults.update(kwargs)
    return types.SimpleNamespace(**defaults)


def test_position_history_aggregates_net_pnl_and_uses_latest_close():
    deals = [
        deal(ticket=10, entry=0, time_msc=100, price=1.20, profit=0.0, commission=-1.0, comment="ta_open"),
        deal(ticket=11, entry=1, time_msc=200, price=1.25, profit=40.0, commission=-1.5, swap=-0.5, fee=-0.2, comment=""),
        deal(ticket=12, entry=1, time_msc=300, price=1.26, profit=10.0, commission=-0.5, fee=-0.1, comment="sl"),
    ]
    summary = bridge.summarize_position_deals(deals)
    assert summary is not None
    assert summary["position_id"] == 42
    assert summary["close_price"] == 1.26
    assert summary["close_reason"] == "SL"
    assert summary["net_profit"] == 43.7


def test_position_history_requires_a_closing_deal():
    assert bridge.summarize_position_deals([deal(entry=0, profit=0)]) is None


def test_position_ticket_resolution_prefers_deal_position_id():
    mt5 = types.SimpleNamespace(
        history_deals_get=lambda ticket: [
            types.SimpleNamespace(position_id=777)
        ],
        history_orders_get=lambda ticket: [],
    )
    result = types.SimpleNamespace(order=123, deal=456)
    position, deal = bridge.resolve_position_ticket(result, mt5)
    assert position == 777
    assert deal == 456


def test_position_ticket_resolution_falls_back_to_order_position_id():
    mt5 = types.SimpleNamespace(
        history_deals_get=lambda ticket: [],
        history_orders_get=lambda ticket: [
            types.SimpleNamespace(position_id=888)
        ],
    )
    result = types.SimpleNamespace(order=123, deal=0)
    position, deal = bridge.resolve_position_ticket(result, mt5)
    assert position == 888
    assert deal == 0


def test_position_ticket_resolution_fails_closed_without_identity():
    mt5 = types.SimpleNamespace(
        history_deals_get=lambda ticket: [],
        history_orders_get=lambda ticket: [],
    )
    result = types.SimpleNamespace(order=123, deal=456)
    position, deal = bridge.resolve_position_ticket(result, mt5)
    assert position == 0
    assert deal == 456


def test_position_history_summary_distinguishes_partial_close():
    Deal = types.SimpleNamespace
    deals = [
        Deal(
            time_msc=1_000,
            ticket=1,
            entry=0,
            volume=1.0,
            profit=0.0,
            commission=-1.0,
            swap=0.0,
            fee=0.0,
            position_id=77,
            price=100.0,
            comment="bot-open",
        ),
        Deal(
            time_msc=2_000,
            ticket=2,
            entry=1,
            volume=0.4,
            profit=40.0,
            commission=-0.4,
            swap=0.0,
            fee=0.0,
            position_id=77,
            price=110.0,
            comment="bot-partial-40pct",
        ),
    ]

    summary = bridge.summarize_position_deals(deals)
    assert summary is not None
    assert summary["closed"] is False
    assert summary["opened_volume"] == 1.0
    assert summary["closed_volume"] == 0.4
    assert summary["remaining_volume"] == 0.6
    assert summary["net_profit"] == 38.6


def test_partial_execution_retcode_is_accepted():
    mt5 = types.SimpleNamespace(
        TRADE_RETCODE_DONE=10009,
        TRADE_RETCODE_DONE_PARTIAL=10010,
    )
    assert bridge.is_successful_trade_retcode(10009, mt5)
    assert bridge.is_successful_trade_retcode(10010, mt5)
    assert not bridge.is_successful_trade_retcode(10006, mt5)


def test_account_position_mode_detects_hedging():
    mt5 = types.SimpleNamespace(
        ACCOUNT_MARGIN_MODE_RETAIL_HEDGING=2,
        ACCOUNT_MARGIN_MODE_RETAIL_NETTING=0,
        ACCOUNT_MARGIN_MODE_EXCHANGE=1,
    )
    assert bridge.account_position_mode(types.SimpleNamespace(margin_mode=2), mt5) == "HEDGING"


def test_account_position_mode_detects_netting():
    mt5 = types.SimpleNamespace(
        ACCOUNT_MARGIN_MODE_RETAIL_HEDGING=2,
        ACCOUNT_MARGIN_MODE_RETAIL_NETTING=0,
        ACCOUNT_MARGIN_MODE_EXCHANGE=1,
    )
    assert bridge.account_position_mode(types.SimpleNamespace(margin_mode=0), mt5) == "NETTING_OR_EXCHANGE"


def test_account_position_mode_fails_closed_unknown():
    mt5 = types.SimpleNamespace(
        ACCOUNT_MARGIN_MODE_RETAIL_HEDGING=2,
        ACCOUNT_MARGIN_MODE_RETAIL_NETTING=0,
        ACCOUNT_MARGIN_MODE_EXCHANGE=1,
    )
    assert bridge.account_position_mode(types.SimpleNamespace(margin_mode=99), mt5) == "UNKNOWN"

def test_aggregate_volume_limit_blocks_same_direction():
    mt5 = types.SimpleNamespace(POSITION_TYPE_BUY=0)
    positions = [
        types.SimpleNamespace(type=0, volume=1.5),
        types.SimpleNamespace(type=1, volume=0.5),
    ]
    mt5.positions_get = lambda symbol: positions
    ok, reason = bridge.validate_aggregate_volume(
        "EURUSD.a", "BUY", 1.0,
        info(volume_limit=2.0), mt5
    )
    assert not ok
    assert "volume_limit" in reason


def test_aggregate_volume_limit_allows_other_direction():
    mt5 = types.SimpleNamespace(POSITION_TYPE_BUY=0)
    positions = [
        types.SimpleNamespace(type=0, volume=1.5),
        types.SimpleNamespace(type=1, volume=0.5),
    ]
    mt5.positions_get = lambda symbol: positions
    ok, _ = bridge.validate_aggregate_volume(
        "EURUSD.a", "SELL", 1.0,
        info(volume_limit=2.0), mt5
    )
    assert ok

def test_trade_permissions_respect_direction():
    mt5 = types.SimpleNamespace(
        SYMBOL_TRADE_MODE_DISABLED=0,
        SYMBOL_TRADE_MODE_LONGONLY=1,
        SYMBOL_TRADE_MODE_SHORTONLY=2,
        SYMBOL_TRADE_MODE_CLOSEONLY=3,
    )
    assert bridge.validate_trade_permissions(
        "BUY", info(trade_mode=1), mt5
    )[0]
    assert not bridge.validate_trade_permissions(
        "SELL", info(trade_mode=1), mt5
    )[0]
    assert not bridge.validate_trade_permissions(
        "BUY", info(trade_mode=3), mt5
    )[0]


def test_stop_distance_uses_broker_points():
    symbol = info(point=0.01, trade_stops_level=10)
    ok, _ = bridge.validate_stop_distance("BUY", 100.0, 99.9, 100.1, symbol)
    assert ok
    assert not bridge.validate_stop_distance("BUY", 100.0, 99.95, 100.1, symbol)[0]
    assert not bridge.validate_stop_distance("SELL", 100.0, 100.1, 99.95, symbol)[0]


def test_timeframe_constant_supports_all_trading_timeframes():
    mt5 = types.SimpleNamespace(
        TIMEFRAME_M1=1, TIMEFRAME_M5=5, TIMEFRAME_M15=15,
        TIMEFRAME_M30=30, TIMEFRAME_H1=60, TIMEFRAME_H4=240,
        TIMEFRAME_D1=1440,
    )
    assert bridge.timeframe_constant("M1", mt5) == 1
    assert bridge.timeframe_constant("M5", mt5) == 5
    assert bridge.timeframe_constant("M15", mt5) == 15
    assert bridge.timeframe_constant("M30", mt5) == 30
    assert bridge.timeframe_constant("H1", mt5) == 60
    assert bridge.timeframe_constant("H4", mt5) == 240
    assert bridge.timeframe_constant("D1", mt5) == 1440


def test_timeframe_constant_rejects_unknown_timeframe():
    mt5 = types.SimpleNamespace(TIMEFRAME_H1=60)
    with pytest.raises(ValueError):
        bridge.timeframe_constant("H2", mt5)


def test_normalize_rates_uses_real_volume_then_tick_volume_and_milliseconds():
    rows = [
        {
            "time": 1002, "open": 1.2, "high": 1.3, "low": 1.1, "close": 1.25,
            "tick_volume": 7, "real_volume": 11,
        },
        {
            "time": 1001, "open": 1.1, "high": 1.2, "low": 1.0, "close": 1.15,
            "tick_volume": 9, "real_volume": 0,
        },
    ]
    candles = bridge.normalize_rates(rows)
    assert [c["time"] for c in candles] == [1001000, 1002000]
    assert candles[0]["volume"] == 9
    assert candles[1]["volume"] == 11


def test_fetch_closed_candles_skips_forming_bar_and_passes_count():
    class FakeMT5:
        TIMEFRAME_H1 = 60

        def __init__(self):
            self.calls = []

        def copy_rates_from_pos(self, symbol, timeframe, start_pos, count):
            self.calls.append((symbol, timeframe, start_pos, count))
            return [{
                "time": 1000, "open": 1.0, "high": 1.1, "low": 0.9, "close": 1.05,
                "tick_volume": 10, "real_volume": 0,
            }]

    mt5 = FakeMT5()
    result = bridge.fetch_closed_candles(mt5, "EURUSD.a", "H1", 250)
    assert result[0]["time"] == 1000000
    assert mt5.calls == [("EURUSD.a", 60, 1, 250)]


def test_fetch_closed_candles_rejects_unsafe_count():
    mt5 = types.SimpleNamespace(TIMEFRAME_H1=60)
    with pytest.raises(ValueError):
        bridge.fetch_closed_candles(mt5, "EURUSD", "H1", 0)
    with pytest.raises(ValueError):
        bridge.fetch_closed_candles(mt5, "EURUSD", "H1", 5001)


def test_close_endpoint_replays_idempotent_success(monkeypatch):
    bridge._idempotency_cache.clear()
    bridge.BRIDGE_MODE = "simulation"
    bridge._sim_positions.clear()
    bridge._sim_positions[900] = {
        "symbol": "EURUSD.a",
        "type": "BUY",
        "volume": 1.0,
        "price": 100.0,
        "sl": 99.0,
        "tp": 102.0,
    }

    calls = {"count": 0}

    def fake_close(ticket, fraction=1.0):
        calls["count"] += 1
        return {
            "ok": True,
            "ticket": ticket,
            "closed_volume": 1.0,
            "remaining_volume": 0.0,
            "profit": 1.0,
        }

    monkeypatch.setattr(bridge, "sim_close", fake_close)
    monkeypatch.setattr(bridge, "auth_check", lambda: True)

    client = bridge.app.test_client()
    payload = {"ticket": 900, "idempotency_key": "close-replay-1"}

    first = client.post("/close", json=payload)
    second = client.post("/close", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json() == second.get_json()
    assert calls["count"] == 1


def test_idempotency_cache_replays_success_and_unknown():
    bridge._idempotency_cache.clear()

    payload = {"ok": True, "ticket": 42, "symbol": "EURUSD.a"}
    bridge._idempotency_record("trade-1", "SUCCESS", payload)
    cached = bridge._idempotency_lookup("trade-1")
    assert cached is not None
    assert cached[1] == "SUCCESS"
    assert cached[2] == payload

    unknown_payload = {"ok": False, "error": "identity unresolved"}
    bridge._idempotency_record("trade-2", "UNKNOWN", unknown_payload)
    cached_unknown = bridge._idempotency_lookup("trade-2")
    assert cached_unknown is not None
    assert cached_unknown[1] == "UNKNOWN"
    assert cached_unknown[2] == unknown_payload


def test_account_position_mode_requires_known_constants():
    mt5 = types.SimpleNamespace()
    assert bridge.account_position_mode(
        types.SimpleNamespace(margin_mode=0), mt5
    ) == "UNKNOWN"


def test_simulation_trade_replays_success(monkeypatch):
    bridge._idempotency_cache.clear()
    bridge.BRIDGE_MODE = "simulation"
    bridge._sim_positions.clear()
    monkeypatch.setattr(bridge, "auth_check", lambda: True)
    client = bridge.app.test_client()
    payload = {
        "symbol": "EURUSD",
        "side": "BUY",
        "volume": 1.0,
        "sl": 0.99,
        "tp": 1.02,
        "idempotency_key": "sim-open-replay-1",
    }
    first = client.post("/trade", json=payload)
    second = client.post("/trade", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json() == second.get_json()
    assert bridge._sim_ticket == 1001


def test_simulation_partial_close_replays_success(monkeypatch):
    bridge._idempotency_cache.clear()
    bridge.BRIDGE_MODE = "simulation"
    bridge._sim_positions.clear()
    bridge._sim_positions[901] = {
        "symbol": "EURUSD", "type": "BUY", "volume": 1.0,
        "price": 100.0, "sl": 99.0, "tp": 102.0,
    }
    monkeypatch.setattr(bridge, "auth_check", lambda: True)
    monkeypatch.setattr(
        bridge, "sim_close",
        lambda ticket, fraction=1.0: {
            "ok": True, "ticket": ticket, "closed_volume": 0.5,
            "remaining_volume": 0.5, "profit": 0.5,
        },
    )
    client = bridge.app.test_client()
    payload = {"ticket": 901, "fraction": 0.5, "idempotency_key": "sim-partial-replay-1"}
    first = client.post("/close_partial", json=payload)
    second = client.post("/close_partial", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json() == second.get_json()


def test_simulation_modify_replays_success(monkeypatch):
    bridge._idempotency_cache.clear()
    bridge.BRIDGE_MODE = "simulation"
    bridge._sim_positions.clear()
    bridge._sim_positions[902] = {
        "symbol": "EURUSD", "type": "BUY", "volume": 1.0,
        "price": 100.0, "sl": 99.0, "tp": 102.0,
    }
    monkeypatch.setattr(bridge, "auth_check", lambda: True)
    client = bridge.app.test_client()
    payload = {
        "ticket": 902, "sl": 98.0, "tp": 103.0,
        "idempotency_key": "sim-modify-replay-1",
    }
    first = client.post("/modify", json=payload)
    second = client.post("/modify", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json() == second.get_json()

def test_idempotency_persistence_roundtrip(tmp_path, monkeypatch):
    bridge._idempotency_cache.clear()
    monkeypatch.setattr(
        bridge,
        "_IDEMPOTENCY_STATE_PATH",
        str(tmp_path / "idempotency.json"),
    )
    payload = {"ok": False, "error": "uncertain broker state"}
    bridge._idempotency_record("persist-1", "UNKNOWN", payload)
    bridge._idempotency_cache.clear()
    bridge._idempotency_load_disk()
    cached = bridge._idempotency_lookup("persist-1")
    assert cached is not None
    assert cached[1] == "UNKNOWN"
    assert cached[2] == payload


def test_idempotency_loader_rejects_future_timestamps(tmp_path, monkeypatch):
    bridge._idempotency_cache.clear()
    state = tmp_path / "idempotency.json"
    state.write_text(
        '{"future":[99999999999,"SUCCESS",{"ok":true}]}',
        encoding="utf-8",
    )
    monkeypatch.setattr(bridge, "_IDEMPOTENCY_STATE_PATH", str(state))
    bridge._idempotency_load_disk()
    assert bridge._idempotency_lookup("future") is None


def test_idempotency_loader_rejects_infinite_timestamps(tmp_path, monkeypatch):
    bridge._idempotency_cache.clear()
    state = tmp_path / "idempotency.json"
    state.write_text(
        '{"infinite":[Infinity,"SUCCESS",{"ok":true}]}',
        encoding="utf-8",
    )
    # JSON rejects bare Infinity in strict parsers, so this verifies malformed
    # state remains fail-closed through the loader's exception path.
    monkeypatch.setattr(bridge, "_IDEMPOTENCY_STATE_PATH", str(state))
    bridge._idempotency_load_disk()
    assert bridge._idempotency_lookup("infinite") is None

def test_simulation_tick_helper_is_independent_of_flask_request():
    bridge.BRIDGE_MODE = "simulation"
    tick = bridge.simulation_tick("EURUSD")
    assert tick["symbol"] == "EURUSD"
    assert tick["ask"] > tick["bid"] > 0
