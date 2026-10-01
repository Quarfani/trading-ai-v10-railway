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
