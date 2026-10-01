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
