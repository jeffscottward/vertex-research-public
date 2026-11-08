"""qc-ports audit helpers (synthetic): gross trades, cost share, model override, spread monotonicity."""
import pytest

from strategies.qc_ports import audit
from strategies.qc_ports import options as om
from strategies.qc_ports.book import SignalEvent, build_book
from tests.qc_ports_synthetic import flat_model, market

DEBIT = {"structure": "callDebitVertical", "dte": {"target": 30, "min": 21}, "widthSigma": 1.0, "maxLossPct": 2}


def _trade():
    return build_book([SignalEvent("SPY", 0, 5)], DEBIT, {"SPY": market([100.0] * 45)}).trades[0]


def test_gross_trades_drop_costs_and_keep_sizing():
    trade = _trade()
    (gross,) = audit.gross_trades([trade])
    assert (gross.entry_fee, gross.exit_fee) == (0.0, 0.0)
    assert gross.max_loss == trade.max_loss and gross.marks == trade.marks


def test_cost_share_of_booked_trades():
    trade = _trade()
    share = audit.cost_share([trade], {trade.trade_id})
    assert share["trades"] == 1
    assert share["ofMaxLoss"] == pytest.approx((trade.entry_fee + trade.exit_fee) / trade.max_loss)
    assert share["ofPremium"] == pytest.approx((trade.entry_fee + trade.exit_fee) / (trade.premium * 100))
    assert audit.cost_share([trade], set())["ofMaxLoss"] is None


def test_model_override_restores_the_model():
    before = (dict(om.ATM_FACTOR), dict(om.SKEW))
    with audit.model_override(atm_factor=1.0, skew=0.0):
        assert set(om.ATM_FACTOR.values()) == {1.0} and set(om.SKEW.values()) == {0.0}
    assert (om.ATM_FACTOR, om.SKEW) == before
    with pytest.raises(RuntimeError), audit.model_override(atm_factor=2.0):
        raise RuntimeError
    assert (om.ATM_FACTOR, om.SKEW) == before


def test_flat_smile_spread_is_bounded_and_monotone(monkeypatch):
    flat_model(monkeypatch)
    bounded, violation = audit.monotone_violation(_trade(), 100.0, 30 / 365, 0.0, 0.2)
    assert bounded and violation == 0.0


@pytest.mark.parametrize("structure, long_strike, short_strike, spot, expected", [
    ("callDebitVertical", 100, 105, 103, 300.0),
    ("callDebitVertical", 100, 105, 110, 500.0),
    ("putDebitVertical", 105, 100, 102, 300.0),
    ("putCreditVertical", 95, 100, 97, 200.0),  # short put 3 in the money: (5 - 3) * 100
    ("putCreditVertical", 95, 100, 90, 0.0),
    ("putCreditVertical", 95, 100, 101, 500.0),
    ("callCreditVertical", 105, 100, 103, 200.0),
])
def test_expiry_value_from_leg_payoffs(structure, long_strike, short_strike, spot, expected):
    assert audit.expiry_value(structure, long_strike, short_strike, 5.0, spot) == expected


def test_credit_spread_held_to_expiry_settles_at_the_payoff_value():
    from strategies.qc_ports.ideas import PUT_CREDIT

    options = {key: value for key, value in PUT_CREDIT.items() if key not in ("profitTakePct", "exitDte")}
    closes = [100.0] * 5 + [93.5] * 60  # short put 95, long put 92: ends between them
    spy = market(closes)
    (trade,) = build_book([SignalEvent("SPY", 0, None)], options, {"SPY": spy}).trades
    assert trade.exit_reason == "expiry"
    spot = spy.close[trade.exit_index]
    value = audit.expiry_value(trade.structure, trade.long_strike, trade.short_strike, trade.width, spot)
    assert trade.short_strike > trade.long_strike
    assert trade.exit_price == value
    assert (trade.long_strike, trade.short_strike) == (92.0, 95.0)
    assert value == 150.0  # (3 - (95 - 93.5)) * 100
