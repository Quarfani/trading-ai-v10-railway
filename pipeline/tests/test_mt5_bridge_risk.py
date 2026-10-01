from bot.mt5_bridge import calculate_order_estimates


class FakeMT5:
    def __init__(self, profit=-25.0, margin=100.0):
        self.profit = profit
        self.margin = margin
        self.last_error_value = 'fake-error'
        self.profit_calls = []
        self.margin_calls = []

    def order_calc_profit(self, *args):
        self.profit_calls.append(args)
        return self.profit

    def order_calc_margin(self, *args):
        self.margin_calls.append(args)
        return self.margin

    def last_error(self):
        return self.last_error_value


def test_calculate_order_estimates_returns_loss_and_margin():
    mt5 = FakeMT5(profit=-25.0, margin=100.0)
    loss, margin = calculate_order_estimates(mt5, 0, 'EURUSD.a', 0.10, 1.10, 1.095)
    assert loss == 25.0
    assert margin == 100.0
    assert mt5.profit_calls == [(0, 'EURUSD.a', 0.10, 1.10, 1.095)]
    assert mt5.margin_calls == [(0, 'EURUSD.a', 0.10, 1.10)]


def test_calculate_order_estimates_never_treats_positive_profit_as_loss():
    mt5 = FakeMT5(profit=8.0, margin=100.0)
    loss, _ = calculate_order_estimates(mt5, 0, 'EURUSD', 1.0, 1.10, 1.095)
    assert loss == 0.0


def test_calculate_order_estimates_fails_closed_when_profit_is_unavailable():
    mt5 = FakeMT5(profit=None, margin=100.0)
    try:
        calculate_order_estimates(mt5, 0, 'EURUSD', 1.0, 1.10, 1.095)
    except RuntimeError as exc:
        assert 'order_calc_profit failed' in str(exc)
    else:
        raise AssertionError('missing profit estimate must fail closed')


def test_calculate_order_estimates_fails_closed_when_margin_is_unavailable():
    mt5 = FakeMT5(profit=-25.0, margin=None)
    try:
        calculate_order_estimates(mt5, 0, 'EURUSD', 1.0, 1.10, 1.095)
    except RuntimeError as exc:
        assert 'order_calc_margin failed' in str(exc)
    else:
        raise AssertionError('missing margin estimate must fail closed')



def test_calculate_order_estimates_rejects_non_finite_profit():
    mt5 = FakeMT5(profit=float("inf"), margin=100.0)
    try:
        calculate_order_estimates(mt5, 0, "EURUSD", 1.0, 1.10, 1.095)
    except RuntimeError as exc:
        assert "non-finite" in str(exc)
    else:
        raise AssertionError("non-finite profit estimate must fail closed")


def test_calculate_order_estimates_rejects_non_finite_margin():
    mt5 = FakeMT5(profit=-25.0, margin=float("inf"))
    try:
        calculate_order_estimates(mt5, 0, "EURUSD", 1.0, 1.10, 1.095)
    except RuntimeError as exc:
        assert "invalid risk estimates" in str(exc)
    else:
        raise AssertionError("non-finite margin estimate must fail closed")
