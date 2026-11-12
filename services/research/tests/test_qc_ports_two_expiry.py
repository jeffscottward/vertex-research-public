"""qc-ports two-expiry structure: the IV term structure and the long calendar spread of book.py.

Synthetic SPY market without skew or dividends and r = 0. VIX (30 days) gives ATM IV 0.2, VIX3M (93 days)
gives ATM IV 0.22 unless a test says otherwise, so every expected price is plain Black-Scholes at the ATM IV
interpolated by hand in total variance.
"""
import math
import random

import pytest

from strategies.qc_ports import allocation as al
from strategies.qc_ports import book as bk
from strategies.qc_ports import data
from strategies.qc_ports import forms as fm
from strategies.qc_ports import forms_other as fo
from strategies.qc_ports import options as om
from strategies.qc_ports import portfolio as pf
from strategies.qc_ports.data import Market
from strategies.qc_ports.ledger import run_ledger
from tests.qc_ports_synthetic import VIX_FOR_20, flat_model, trading_days
from tests.qc_ports_synthetic import market as vertical_market

CALENDAR = {"structure": "callCalendar", "dte": {"target": 30, "min": 21}, "farDte": {"target": 60, "min": 45},
            "maxLossPct": 2}
VIX3M_FOR_22 = 22 / 0.9  # ATM 0.22 at 93 days (factor 0.9)
COUNT = 45
DATES = trading_days("2024-01-02", COUNT)
# Signal at bar 0 -> entry at the close of bar 1 (2024-01-03). Monthly expirations: 2024-01-19 (16 days, under
# the minimum 21), 2024-02-16 (44 days, near), 2024-03-15 (72 days, far).
ENTRY = 1
NEAR, FAR = "2024-02-16", "2024-03-15"
NEAR_BAR = DATES.index(NEAR)


def calendar_market(closes, *, vix=VIX_FOR_20, vix3m=VIX3M_FOR_22, rate=0.0, term=True, vix3ms=None,
                    vixes=None) -> Market:
    """VIX6M carries the VIX3M levels: the ATM IV is flat past 93 days, so under 93 days only VIX and VIX3M count."""
    dates = trading_days("2024-01-02", len(closes))
    size = len(closes)
    levels = tuple(vix3ms) if vix3ms is not None else (vix3m,) * size
    return Market("SPY", dates, tuple(float(value) for value in closes),
                  tuple(vixes) if vixes is not None else (vix,) * size, (rate,) * size,
                  (("VIX3M", levels), ("VIX6M", levels)) if term else ())


def term_atm(days, near_atm=0.2, far_atm=0.22):
    """Hand interpolation between (30, near_atm) and (93, far_atm) in total variance, flat outside."""
    if days <= 30:
        return near_atm
    if days >= 93:
        return far_atm
    total = near_atm ** 2 * 30 + (far_atm ** 2 * 93 - near_atm ** 2 * 30) * (days - 30) / 63
    return math.sqrt(total / days)


def call(spot, strike, days, sigma):
    return om.bs_price("call", spot, strike, days / 365, 0, 0, sigma)


def leg_fee(*mids):
    return round(sum(0.65 + 100 * max(0.01, 0.01 * mid) for mid in mids), 2)


def run(closes, block=CALENDAR, events=(("SPY", 0, None),), **kwargs):
    return bk.build_book(events, block, {"SPY": calendar_market(closes, **kwargs)})


@pytest.fixture(autouse=True)
def _flat(monkeypatch):
    flat_model(monkeypatch)


# ---------------------------------------------------------------- IV term structure

def test_term_atm_iv_is_linear_in_total_variance_and_flat_outside_the_tenors():
    points = [(93, 0.22), (30, 0.2)]
    assert om.term_atm_iv(points, 10) == 0.2
    assert om.term_atm_iv(points, 30) == 0.2
    assert om.term_atm_iv(points, 93) == 0.22
    assert om.term_atm_iv(points, 200) == 0.22
    for days in (31, 44, 60, 72, 92.5):
        assert om.term_atm_iv(points, days) == pytest.approx(term_atm(days), rel=1e-15)
    # Three points: each pair interpolates on its own.
    three = [(30, 0.2), (93, 0.22), (182, 0.25)]
    assert om.term_atm_iv(three, 120) == pytest.approx(math.sqrt((0.22 ** 2 * 93 + (0.25 ** 2 * 182 - 0.22 ** 2 * 93)
                                                                 * 27 / 89) / 120), rel=1e-15)
    assert om.term_atm_iv([(30, 0.3)], 400) == 0.3


@pytest.mark.parametrize(("points", "days", "message"), [
    ([], 30, "at least one point"),
    ([(30, 0.2), (30, 0.25)], 40, "must differ"),
    ([(0, 0.2)], 40, "above 0"),
    ([(30, -0.2)], 40, "above 0"),
    ([(30, float("nan"))], 40, "finite"),
    ([(30, 0.2)], float("inf"), "finite"),
])
def test_term_atm_iv_refuses_bad_points(points, days, message):
    with pytest.raises(ValueError, match=message):
        om.term_atm_iv(points, days)


def test_intrinsic():
    assert om.intrinsic("call", 105, 100) == 5 and om.intrinsic("call", 95, 100) == 0
    assert om.intrinsic("put", 95, 100) == 5 and om.intrinsic("put", 105, 100) == 0


def test_market_iv_term_validation():
    dates, one = ("2024-01-02", "2024-01-03"), (1.0, 1.0)
    assert Market("SPY", dates, one, (20.0, None), (0.0, 0.0), (("VIX3M", (21.0, None)),)).iv_term[0][0] == "VIX3M"
    with pytest.raises(ValueError, match="one value per date"):
        Market("SPY", dates, one, (20.0, 20.0), (0.0, 0.0), (("VIX3M", (21.0,)),))
    with pytest.raises(ValueError, match="above 0"):
        Market("SPY", dates, one, (20.0, 20.0), (0.0, 0.0), (("VIX3M", (21.0, 0.0)),))
    with pytest.raises(ValueError, match="at most once"):
        Market("SPY", dates, one, (20.0, 20.0), (0.0, 0.0), (("VIX3M", (21.0, 21.0)),) * 2)
    with pytest.raises(ValueError, match="at most once"):
        Market("SPY", dates, one, (20.0, 20.0), (0.0, 0.0), (("VXN", (21.0, 21.0)),))
    with pytest.raises(ValueError, match="at most once"):
        Market("QQQ", dates, one, (20.0, 20.0), (0.0, 0.0), (("VIX3M", (21.0, 21.0)),))


def test_term_columns_align_the_term_indices_of_the_symbol():
    dates = ("2024-01-02", "2024-01-03", "2024-01-04")
    series = {"VIX3M": {"2024-01-02": 18.0, "2024-01-04": 19.0}, "VXN": {"2024-01-02": 25.0}}
    assert data.term_columns("SPY", series, dates) == (("VIX3M", (18.0, 18.0, 19.0)),)
    assert data.term_columns("SPY", {}, dates) == ()
    assert data.term_columns("QQQ", series, dates) == ()


def test_load_market_reads_the_term_file_when_there_is_one(tmp_path):
    (tmp_path / "SPY.csv").write_text("date,open,high,low,close,adj_close\n2024-01-02,1,1,1,100,100\n"
                                      "2024-01-03,1,1,1,101,101\n")
    (tmp_path / "VIX.csv").write_text("date,close\n2024-01-02,13.0\n")
    (tmp_path / "IRX.csv").write_text("date,close\n2024-01-02,5.0\n")
    assert data.load_market("SPY", tmp_path).iv_term == ()
    (tmp_path / "VIX3M.csv").write_text("date,close\n2024-01-03,15.5\n")
    assert data.load_market("SPY", tmp_path).iv_term == (("VIX3M", (None, 15.5)),)


def test_market_of_carries_the_term_of_spy_only():
    dates = trading_days("2024-01-02", 3)
    bars = {symbol: data.Bars(symbol, dates, (1.0,) * 3, (1.0,) * 3, (1.0,) * 3, (100.0,) * 3, (100.0,) * 3)
            for symbol in ("SPY", "QQQ")}
    series = {"VIX": dict.fromkeys(dates, 20.0), "VXN": dict.fromkeys(dates, 25.0), "IRX": dict.fromkeys(dates, 5.0),
              "VIX3M": dict.fromkeys(dates, 21.0)}
    dataset = pf.Dataset(bars=bars, series=series)
    assert pf.market_of(dataset, "SPY").iv_term == (("VIX3M", (21.0, 21.0, 21.0)),)
    assert pf.market_of(dataset, "QQQ").iv_term == ()


# ---------------------------------------------------------------- calendar block

def test_parse_calendar_defaults_and_fields():
    spec = bk.parse_calendar(CALENDAR)
    assert (spec.right, spec.dte_target, spec.dte_min, spec.far_target, spec.far_min) == ("call", 30, 21, 60, 45)
    assert (spec.strike_delta, spec.max_term_ratio, spec.profit_take_pct, spec.exit_dte) == (0.5, None, None, None)
    spec = bk.parse_calendar({**CALENDAR, "structure": "putCalendar", "strikeDelta": 0.3, "maxTermRatio": 1.1,
                              "profitTakePct": 50, "exitDte": 3})
    assert (spec.right, spec.strike_delta, spec.max_term_ratio, spec.profit_take_pct, spec.exit_dte) == (
        "put", 0.3, 1.1, 50.0, 3)


@pytest.mark.parametrize(("change", "message"), [
    ({"maxLossPct": 2.5}, "refused"),
    ({"maxLossPct": 0}, "maxLossPct"),
    ({"structure": "callDebitVertical"}, "structure"),
    ({"farDte": {"target": 30, "min": 21}}, "farDte.target"),
    ({"farDte": {"target": 60}}, "farDte"),
    ({"dte": {"target": 5, "min": 1}}, "target"),
    ({"widthSigma": 1}, "Unknown"),
    ({"maxTermRatio": 0.2}, "maxTermRatio"),
    ({"strikeDelta": 1.0}, "strikeDelta"),
])
def test_parse_calendar_refuses_bad_blocks(change, message):
    with pytest.raises(ValueError, match=message):
        bk.parse_calendar({**CALENDAR, **change})


def test_the_dsl_parser_and_the_vertical_registry_do_not_know_calendars():
    with pytest.raises(ValueError, match="Unknown options field: farDte"):
        bk.parse_options(CALENDAR)
    with pytest.raises(ValueError, match="structure must be one of"):
        bk.parse_options({key: value for key, value in CALENDAR.items() if key != "farDte"})
    assert not set(bk.CALENDARS) & set(bk.STRUCTURES)


# ---------------------------------------------------------------- calendar pricing

def test_calendar_entry_prices_both_legs_on_the_term_structure_and_settles_the_near_leg():
    book = run([100.0] * COUNT)
    trade = book.trades[0]
    near_atm, far_atm = term_atm(44), term_atm(72)
    near, far = call(100, 100, 44, near_atm), call(100, 100, 72, far_atm)
    assert (trade.structure, trade.expiry, trade.far_expiry) == ("callCalendar", NEAR, FAR)
    assert (trade.long_strike, trade.short_strike, trade.width) == (100.0, 100.0, 0.0)
    assert (trade.entry_index, trade.entry_date) == (ENTRY, DATES[ENTRY])
    assert trade.entry_price == round((far - near) * 100, 2)
    assert trade.premium == pytest.approx(far - near, rel=1e-12)
    assert trade.entry_fee == leg_fee(far, near)
    worst = round(2 * (0.65 + 100 * 0.01 * far), 2)
    assert trade.max_loss == round(trade.entry_price + trade.entry_fee + worst, 2)
    # Held to the near expiry: the near leg is out of the money (spot = strike) and settles at 0 without a cost;
    # the far leg (28 days left, flat ATM 0.2 under 30 days) is sold at its model value.
    assert (trade.exit_reason, trade.exit_date, trade.exit_index) == ("expiry", NEAR, NEAR_BAR)
    far_exit = call(100, 100, 28, 0.2)
    assert trade.exit_price == round(far_exit * 100, 2)
    assert trade.exit_fee == leg_fee(far_exit)
    assert len(trade.marks) == NEAR_BAR - ENTRY + 1 and trade.marks[0] == (DATES[ENTRY], trade.entry_price)
    # Time decay: a calendar at the strike gains while the spot stands still.
    assert trade.exit_price > trade.entry_price


def test_calendar_strike_follows_the_near_leg_delta():
    trade = run([100.0] * COUNT, {**CALENDAR, "strikeDelta": 0.3}).trades[0]
    near_atm = term_atm(44)
    deltas = {strike: om.bs_delta("call", 100, strike, 44 / 365, 0, 0, near_atm) for strike in range(95, 115)}
    assert trade.long_strike == min(deltas, key=lambda strike: abs(deltas[strike] - 0.3))
    assert trade.long_strike > 100


def test_in_the_money_near_leg_costs_its_close_at_the_near_expiry():
    closes = [100.0] * 2 + [110.0] * (COUNT - 2)
    trade = run(closes).trades[0]
    assert trade.exit_reason == "expiry"
    far_mid = max(call(110, 100, 28, 0.2), 10.0)
    assert trade.exit_price == round((far_mid - 10.0) * 100, 2)
    worst = round(2 * (0.65 + 100 * 0.01 * call(100, 100, 72, term_atm(72))), 2)
    assert trade.exit_fee == min(leg_fee(far_mid, 10.0), worst)


def test_term_structure_check_and_missing_term_refuse_the_entry():
    # ATM 0.3 at 93 days: far/near = 1.144 > 1.1.
    steep = 30 / 0.9
    assert run([100.0] * COUNT, {**CALENDAR, "maxTermRatio": 1.1}, vix3m=steep).skipped[0].reason == "term structure"
    assert len(run([100.0] * COUNT, {**CALENDAR, "maxTermRatio": 1.1}).trades) == 1
    assert len(run([100.0] * COUNT, vix3m=steep).trades) == 1  # no check without maxTermRatio
    assert run([100.0] * COUNT, term=False).skipped[0].reason == "no IV term"
    # Part of the term (VIX3M without VIX6M): no calendar either, a 100/200 one would get a flat IV past 93 days.
    base = calendar_market([100.0] * COUNT)
    part = Market("SPY", base.dates, base.close, base.iv_index, base.rate, base.iv_term[:1])
    assert bk.build_book([("SPY", 0, None)], CALENDAR, {"SPY": part}).skipped[0].reason == "no IV term"
    assert fm.first_priced(part, [CALENDAR]) == COUNT
    assert run([100.0] * COUNT, vix3ms=[VIX3M_FOR_22, None] + [VIX3M_FOR_22] * (COUNT - 2)).skipped[0].reason == (
        "no IV term")
    assert run([100.0] * COUNT, vixes=[VIX_FOR_20, None] + [VIX_FOR_20] * (COUNT - 2)).skipped[0].reason == "no IV"


def test_other_skips():
    assert run([100.0] * COUNT, events=(("SPY", COUNT - 2, None),)).skipped[0].reason == "no bar to enter and exit"
    assert run([100.0] * COUNT, {**CALENDAR, "exitDte": 44}).skipped[0].reason == "exitDte at entry"
    market = calendar_market([100.0] * COUNT)
    no_rate = Market("SPY", market.dates, market.close, market.iv_index, (0.0, None) + (0.0,) * (COUNT - 2),
                     market.iv_term)
    assert bk.build_book([("SPY", 0, None)], CALENDAR, {"SPY": no_rate}).skipped[0].reason == "no rate"
    with pytest.raises(ValueError, match="outside"):
        run([100.0] * COUNT, events=(("SPY", COUNT, None),))
    with pytest.raises(ValueError, match="after the entry"):
        run([100.0] * COUNT, events=(("SPY", 3, 3),))


def test_a_spread_without_premium_is_refused():
    # A deep in-the-money put at r = 5% and a tiny IV: both European prices lie under the exercise value, so both
    # legs are worth their intrinsic value and the spread is worth 0.
    block = {**CALENDAR, "structure": "putCalendar", "strikeDelta": 0.95}
    book = run([100.0] * COUNT, block, vix=1.0, vix3m=1.0, rate=0.05)
    assert book.skipped and book.skipped[0].reason == "no premium"


def test_exits_stale_term_exit_dte_profit_take_signal_and_end():
    stale = [VIX3M_FOR_22] * 10 + [None] + [VIX3M_FOR_22] * (COUNT - 11)
    trade = run([100.0] * COUNT, vix3ms=stale).trades[0]
    assert (trade.exit_reason, trade.exit_index, trade.stale_days) == ("stale-iv", 10, 1)
    trade = run([100.0] * COUNT, {**CALENDAR, "exitDte": 3}).trades[0]
    assert (trade.exit_reason, trade.exit_date) == ("exitDte", "2024-02-13")
    trade = run([100.0] * COUNT, {**CALENDAR, "profitTakePct": 10}).trades[0]
    assert trade.exit_reason == "profitTake" and trade.exit_price >= trade.entry_price * 1.1
    trade = run([100.0] * COUNT, events=(("SPY", 0, 5),)).trades[0]
    assert (trade.exit_reason, trade.exit_index) == ("signal", 6)
    trade = run([100.0] * 20).trades[0]
    assert (trade.exit_reason, trade.exit_index, trade.exit_date) == ("end", 19, "2024-01-30")
    # 17 days to the near expiry, 45 days to the far one: both legs are bought or sold back at their mids.
    near, far = call(100, 100, 17, term_atm(17)), call(100, 100, 45, term_atm(45))
    assert trade.exit_price == round((far - near) * 100, 2)
    assert trade.exit_fee == leg_fee(far, near)


def test_put_calendar_is_never_worth_less_than_zero_and_never_loses_more_than_its_max_loss():
    rng = random.Random(4)
    for seed in range(12):
        price, closes = 100.0, []
        for _ in range(COUNT):
            price *= math.exp(rng.gauss(0, 0.03))
            closes.append(price)
        for structure in ("callCalendar", "putCalendar"):
            book = run(closes, {**CALENDAR, "structure": structure}, rate=0.05)
            for trade in book.trades:
                assert all(value >= 0 for _, value in trade.marks), (seed, structure)
                pnl = trade.exit_price - trade.entry_price - trade.entry_fee - trade.exit_fee
                assert pnl >= -trade.max_loss - 1e-9, (seed, structure)


def test_owner_exit_keeps_the_book_closing_cost_of_a_calendar_and_cuts_a_loser():
    market = calendar_market([100.0] * COUNT)
    held = bk.build_book([("SPY", 0, None)], CALENDAR, {"SPY": market}).trades[0]
    assert al.owner_exit(held, CALENDAR, market) == held  # a winner at the near expiry keeps the book fee
    falling = calendar_market([100.0] * 2 + [100.0 - 2 * index for index in range(1, COUNT - 1)])
    trade = bk.build_book([("SPY", 0, None)], CALENDAR, {"SPY": falling}).trades[0]
    cut = al.owner_exit(trade, CALENDAR, falling)
    assert (cut.exit_reason, cut.exit_date) == (al.OWNER_CUT_REASON, "2024-02-13")
    assert cut.far_expiry == FAR


# ---------------------------------------------------------------- the form of the library strategy

def test_first_priced_waits_for_the_term_only_for_a_calendar():
    market = calendar_market([100.0] * 6, vix3ms=[None, None, VIX3M_FOR_22, None, VIX3M_FOR_22, VIX3M_FOR_22],
                             vixes=[None] + [VIX_FOR_20] * 5)
    assert fm.first_priced(market, [CALENDAR]) == 2
    assert fm.first_priced(market, [{"structure": "callDebitVertical"}]) == 1
    assert fm.first_priced(calendar_market([100.0] * 6, term=False), [CALENDAR]) == 6


def test_degenerate_ignores_the_width_of_a_calendar():
    trade = run([100.0] * COUNT).trades[0]
    assert not fm.degenerate(trade, 100.0)
    assert fm.degenerate(bk.PricedTrade(**{**trade.__dict__, "premium": 0.01}), 100.0)


def test_the_calendar_form_rolls_one_spread_after_the_other_from_the_first_term_value():
    form = fo.FORMS[-1]
    assert form.key == "lib/long-calendar-spread" and form.entry_only and form.baseline is None
    size = 200
    closes = [100.0 * (1 + 0.02 * math.sin(index / 9)) for index in range(size)]
    term = [None] * 30 + [VIX3M_FOR_22] * (size - 30)
    market = calendar_market(closes, vix3ms=term)
    bars = data.Bars("SPY", market.dates, market.close, market.close, market.close, market.close, market.close)
    inputs = fm.Inputs({"SPY": bars}, {"SPY": market.iv_index})
    book = fm.form_book(form, inputs, {"SPY": market}, start=market.dates[0])
    assert len(book.trades) >= 4
    assert book.trades[0].entry_index == 31  # the stance of the first term bar opens at the next close
    assert all(trade.structure == "callCalendar" and trade.far_expiry > trade.expiry for trade in book.trades)
    for before, after in zip(book.trades, book.trades[1:]):
        assert after.entry_index == before.exit_index + 1
    assert fm.is_always_on(fm.stance_of(form, inputs), form.symbols)


def test_a_100_200_calendar_prices_its_legs_on_the_vix6m_point_too():
    """Config B tenors: the near leg (107 days) between VIX3M and VIX6M, the far leg (198 days) past VIX6M."""
    size = 80
    base = calendar_market([100.0] * size)
    market = Market("SPY", base.dates, base.close, base.iv_index, base.rate,
                    (("VIX3M", (VIX3M_FOR_22,) * size), ("VIX6M", (24 / 0.9,) * size)))
    block = {**CALENDAR, "dte": {"target": 100, "min": 80}, "farDte": {"target": 200, "min": 160}}
    trade = bk.build_book([("SPY", 0, None)], block, {"SPY": market}).trades[0]
    assert (trade.expiry, trade.far_expiry) == ("2024-04-19", "2024-07-19")
    near_atm = math.sqrt((0.22 ** 2 * 93 + (0.24 ** 2 * 182 - 0.22 ** 2 * 93) * (107 - 93) / 89) / 107)
    deltas = {strike: om.bs_delta("call", 100, strike, 107 / 365, 0, 0, near_atm) for strike in range(95, 106)}
    strike = min(deltas, key=lambda value: (abs(deltas[value] - 0.5), abs(value - 100)))
    assert trade.long_strike == strike
    assert trade.entry_price == round((call(100, strike, 198, 0.24) - call(100, strike, 107, near_atm)) * 100, 2)
    # Without the VIX6M value the calendar opens no trade.
    gap = Market("SPY", base.dates, base.close, base.iv_index, base.rate,
                 (("VIX3M", (VIX3M_FOR_22,) * size), ("VIX6M", (None,) * size)))
    assert bk.build_book([("SPY", 0, None)], block, {"SPY": gap}).skipped[0].reason == "no IV term"


def test_ledger_records_name_the_far_expiry_of_a_calendar_only():
    calendar = run([100.0] * COUNT).trades
    record = run_ledger(calendar, 100_000.0).trades[0]
    assert (record["structure"], record["expiry"], record["farExpiry"]) == ("callCalendar", NEAR, FAR)
    vertical = bk.build_book([("SPY", 0, None)], {"structure": "callDebitVertical", "dte": {"target": 45, "min": 30},
                                                  "widthSigma": 0.5, "maxLossPct": 2},
                             {"SPY": vertical_market([100.0] * COUNT)}).trades
    assert "farExpiry" not in run_ledger(vertical, 100_000.0).trades[0]
