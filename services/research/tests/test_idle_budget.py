"""Idle budget study (research/backtests/allocation/idle_budget.py): the move, the caps and one synthetic pie.
Synthetic inputs; no network, no database, no NautilusTrader."""
import dataclasses
import importlib.util
import sys
from pathlib import Path

import pytest

from strategies.qc_ports import allocation as al
from strategies.qc_ports import ideas as qi
from strategies.qc_ports import portfolio as pf
from strategies.qc_ports.ledger import run_ledger
from tests.qc_ports_synthetic import trading_days

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "research" / "backtests" / "allocation" / "idle_budget.py"
LONG, ROTATION, VOL = "oil-predicts-equity/B", "momentum-rotation/A", "regime-put-vrp/A"
DAYS = trading_days("2024-01-02", 130)
MONTHS = sorted({day[:7] for day in DAYS})
FIRST = {month: next(day for day in DAYS if day[:7] == month) for month in MONTHS}  # entry bars
LAST = {month: [day for day in DAYS if day[:7] == month][-1] for month in MONTHS}  # decision days


@pytest.fixture(scope="module")
def ib():
    spec = importlib.util.spec_from_file_location("idle_budget", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["idle_budget"] = module
    spec.loader.exec_module(module)
    return module


def _trade(number: int, symbol: str, entry: str, exit_: str, structure: str = "callDebitVertical") -> al.PricedTrade:
    return al.PricedTrade(
        trade_id=number, symbol=symbol, structure=structure, expiry="2024-12-20", long_strike=100.0,
        short_strike=105.0, width=5.0, entry_index=1, exit_index=2, entry_date=entry, exit_date=exit_,
        entry_price=200.0, exit_price=300.0, entry_fee=2.0, exit_fee=2.0, max_loss=204.0, max_loss_pct=2.0,
        premium=2.0, exit_reason="expiry", marks=((entry, 200.0), (exit_, 300.0)))


def _monthly(symbols, months=("2024-02", "2024-03", "2024-04", "2024-05")) -> list:
    """One spread per symbol and month: in on the first session, out on the first session of the next month."""
    out = []
    for month in months:
        following = MONTHS[MONTHS.index(month) + 1]
        symbol_list = symbols(month) if callable(symbols) else symbols
        out.extend(_trade(len(out) + 1 + n, symbol, FIRST[month], FIRST[following]) for n, symbol in enumerate(symbol_list))
    return out


def _books(vol=(), rotation="GLD") -> dict:
    return {LONG: _monthly(("SPY", "QQQ")), ROTATION: _monthly(rotation if callable(rotation) else (rotation,)), VOL: list(vol)}


def _risk(ib) -> dict:
    return dict.fromkeys(ib.fp.POOL, ib.fp.POSITION_RISK_PCT)


def _sizes(lent, key) -> dict:
    return {trade.entry_date: trade.max_loss_pct for trade in lent.combined.trades if lent.combined.owner[trade.trade_id] == key}


def _day_by_day(trades) -> tuple[float, float]:
    """(largest open budget, largest budget in one underlying) over every session, counted without the script."""
    worst_open = worst_name = 0.0
    for day in DAYS:
        held = [trade for trade in trades if trade.entry_date <= day < trade.exit_date]
        worst_open = max(worst_open, sum(trade.max_loss_pct for trade in held))
        for symbol in {trade.symbol for trade in held}:
            worst_name = max(worst_name, sum(trade.max_loss_pct for trade in held if trade.symbol == symbol))
    return worst_open, worst_name


def test_the_variants_are_shares_of_the_idle_one_percent(ib):
    extras = {name: ib.variant_extra(shares) for name, shares in ib.VARIANTS.items()}
    assert extras == {"cash": {}, "rotation": {ROTATION: 1.0}, "longIndex": {LONG: 0.5}, "split": {ROTATION: 0.5, LONG: 0.25}}
    for extra in extras.values():  # every variant stays within the 2% per position of the owner gate
        assert ib.check_extra(extra, _risk(ib), ib.pie_caps()) == 2.0
    caps = ib.pie_caps()
    assert (caps.open_risk_pct, caps.name_risk_pct, dict(caps.sleeve_risk_pct)) == (
        4.0, 2.0, {"long index": 2.0, "rotation": 1.0, "vol premium": 1.0})


def test_the_move_applies_only_at_a_closed_gate(ib):
    books, caps = _books(), ib.pie_caps()
    closed = {LAST[month]: month in ("2024-02", "2024-04") for month in MONTHS}
    lent = ib.lend_idle(books, _risk(ib), caps, {ROTATION: 1.0}, closed, DAYS)
    assert _sizes(lent, ROTATION) == {FIRST["2024-02"]: 1.0, FIRST["2024-03"]: 2.0, FIRST["2024-04"]: 1.0, FIRST["2024-05"]: 2.0}
    assert set(_sizes(lent, LONG).values()) == {1.0}
    assert lent.applied == (LAST["2024-02"], LAST["2024-04"]) and lent.offered == 2 and len(lent.topped) == 2
    assert len(lent.combined.trades) == len(al.combine(books, _risk(ib), caps).trades)  # an addition is no new trade
    # the long index gets it at the same decisions, both of its positions
    long = ib.lend_idle(books, _risk(ib), caps, {LONG: 0.5}, closed, DAYS)
    assert [(trade.entry_date, trade.max_loss_pct) for trade in long.combined.trades if trade.symbol in ("SPY", "QQQ")] == [
        (FIRST[month], 1.5 if month in ("2024-03", "2024-05") else 1.0) for month in ("2024-02", "2024-03", "2024-04", "2024-05")
        for _symbol in ("SPY", "QQQ")]
    # an open gate at every decision: the pie as it is
    open_gate = ib.lend_idle(books, _risk(ib), caps, {ROTATION: 1.0}, dict.fromkeys(DAYS, False), DAYS)
    assert open_gate.combined == al.combine(books, _risk(ib), caps) and not open_gate.topped and open_gate.offered == 0


def test_the_move_reads_the_decision_day_only(ib):
    books, caps = _books(), ib.pie_caps()
    assert ib.decision_day(DAYS, FIRST["2024-03"]) == LAST["2024-02"] and ib.decision_day(DAYS, DAYS[0]) is None
    # closed on every day except the decision days (the entry day and all later days included): no move
    later = {day: day not in LAST.values() for day in DAYS}
    assert not ib.lend_idle(books, _risk(ib), caps, {ROTATION: 1.0}, later, DAYS).topped
    # a day without a gate value is not a closed gate
    assert not ib.lend_idle(books, _risk(ib), caps, {ROTATION: 1.0}, {}, DAYS).topped
    # what the gate does after a decision changes nothing at that decision
    closed = {LAST[month]: month == "2024-02" for month in MONTHS}
    flipped = {**dict.fromkeys(DAYS, True), **closed}
    first = ib.lend_idle(books, _risk(ib), caps, {ROTATION: 1.0}, closed, DAYS)
    second = ib.lend_idle(books, _risk(ib), caps, {ROTATION: 1.0}, flipped, DAYS)
    assert first.combined == second.combined and first.applied == second.applied == (LAST["2024-02"],)


def test_the_move_waits_while_vol_premium_holds_a_position(ib):
    caps, closed = ib.pie_caps(), dict.fromkeys(DAYS, True)
    held = _trade(1, "IWM", FIRST["2024-02"], DAYS[DAYS.index(FIRST["2024-03"]) + 10], "putCreditVertical")
    books = {ROTATION: _monthly(("GLD",)), VOL: [held]}
    lent = ib.lend_idle(books, _risk(ib), caps, {ROTATION: 1.0}, closed, DAYS)
    # February and March enter while the put spread is open: its sleeve budget is not idle
    assert _sizes(lent, ROTATION) == {FIRST["2024-02"]: 1.0, FIRST["2024-03"]: 1.0, FIRST["2024-04"]: 2.0, FIRST["2024-05"]: 2.0}
    assert lent.combined.refused == {ROTATION + ib.IDLE_SUFFIX: {"sleeveRisk": 2}}
    # with the long index the account is at 4%, so the open-risk cap answers first
    full = ib.lend_idle({**_books(), VOL: [held]}, _risk(ib), caps, {ROTATION: 1.0}, closed, DAYS)
    assert full.combined.refused == {ROTATION + ib.IDLE_SUFFIX: {"openRisk": 2}}
    # the lent budget is busy until the position exits: a put spread in that time is refused
    late = _trade(1, "IWM", DAYS[DAYS.index(FIRST["2024-03"]) + 5], FIRST["2024-05"], "putCreditVertical")
    busy = ib.lend_idle({ROTATION: _monthly(("GLD",)), VOL: [late]}, _risk(ib), caps, {ROTATION: 1.0}, closed, DAYS)
    assert busy.combined.refused[VOL] == {"sleeveRisk": 1} and VOL not in busy.combined.owner.values()


def test_caps_hold_in_every_variant(ib):
    caps, closed = ib.pie_caps(), dict.fromkeys(DAYS, True)
    put = _trade(1, "IWM", FIRST["2024-04"], DAYS[DAYS.index(FIRST["2024-05"]) + 8], "putCreditVertical")
    # the rotation picks SPY in March: with the long index the underlying is at its 2%
    books = _books(vol=[put], rotation=lambda month: ("SPY",) if month == "2024-03" else ("GLD",))
    reached = set()
    for name, shares in ib.VARIANTS.items():
        lent = ib.lend_idle(books, _risk(ib), caps, ib.variant_extra(shares), closed, DAYS)
        peaks = ib.budget_peaks(lent.combined.trades)
        worst_open, worst_name = _day_by_day(lent.combined.trades)
        assert (peaks["openPct"], peaks["namePct"]) == pytest.approx((worst_open, worst_name))
        assert worst_open <= 4.0 + 1e-9 and worst_name <= 2.0 + 1e-9 and peaks["positionPct"] <= 2.0 + 1e-9, name
        assert len(lent.combined.trades) == len(al.combine(books, _risk(ib), caps).trades), name
        reached.add((name, round(worst_open, 6), round(peaks["positionPct"], 6)))
    assert reached == {("cash", 4.0, 1.0), ("rotation", 4.0, 2.0), ("longIndex", 4.0, 1.5), ("split", 4.0, 1.5)}
    rotation = ib.lend_idle(books, _risk(ib), caps, {ROTATION: 1.0}, closed, DAYS)
    # March: SPY would be at 3%, so the name cap refuses the addition. April and May: the put spread holds the budget.
    assert _sizes(rotation, ROTATION)[FIRST["2024-03"]] == 1.0
    assert rotation.combined.refused[ROTATION + ib.IDLE_SUFFIX] == {"nameRisk": 1, "openRisk": 2}


def test_an_addition_is_dropped_with_its_position(ib):
    caps = ib.pie_caps()
    # the gate is open at the decision of March only, so the March spread holds 1% and lends nothing
    closed = {LAST[month]: month != "2024-02" for month in MONTHS}
    # the March rotation spread is still open in April, so the 1% rotation budget refuses the April one
    long_one = _trade(2, "GLD", FIRST["2024-03"], FIRST["2024-05"])
    rotation = [_trade(1, "GLD", FIRST["2024-02"], FIRST["2024-03"]), long_one, _trade(3, "SLV", FIRST["2024-04"], FIRST["2024-05"]),
                _trade(4, "GLD", FIRST["2024-05"], FIRST["2024-06"])]
    books = {LONG: [], ROTATION: rotation, VOL: []}
    plain = al.combine(books, _risk(ib), caps)
    assert plain.refused == {ROTATION: {"sleeveRisk": 1}}
    lent = ib.lend_idle(books, _risk(ib), caps, {ROTATION: 1.0}, closed, DAYS)
    # April: the caps would take the addition (the idle budget is free), but its position is refused, so it is not made
    assert [(trade.symbol, trade.entry_date, trade.max_loss_pct) for trade in lent.combined.trades] == [
        ("GLD", FIRST["2024-02"], 2.0), ("GLD", FIRST["2024-03"], 1.0), ("GLD", FIRST["2024-05"], 2.0)]
    assert lent.dropped == 1 and lent.offered == 3 and len(lent.topped) == 2
    assert lent.combined.refused == {ROTATION: {"sleeveRisk": 1}}
    assert ib.budget_peaks(lent.combined.trades) == {"openPct": 2.0, "namePct": 2.0, "positionPct": 2.0}


def test_the_cash_variant_is_the_unmodified_pie(ib):
    caps, closed = ib.pie_caps(), dict.fromkeys(DAYS, True)
    put = _trade(1, "SPY", FIRST["2024-02"], DAYS[DAYS.index(FIRST["2024-03"]) + 8], "putCreditVertical")
    books = _books(vol=[put], rotation="SPY")
    plain = al.combine(books, _risk(ib), caps)
    assert plain.refused  # the pie itself has a refusal here, and the cash variant keeps it
    lent = ib.lend_idle(books, _risk(ib), caps, ib.variant_extra(ib.VARIANTS["cash"]), closed, DAYS)
    assert lent.combined == plain and not lent.topped and lent.applied == () and lent.offered == 0
    out = ib.replay(books, {}, closed, DAYS, 1_000_000.0, DAYS[0], DAYS[-1], nautilus=False)
    ledger = run_ledger(plain.trades, 1_000_000.0, dates=list(DAYS))
    assert out["trades"] == len(ledger.trades) == len(plain.trades)
    assert out["pnl"] == pytest.approx(sum(record["pnl"] for record in ledger.trades))
    assert out["move"]["appliedDecisions"] == 0 and out["capRefusals"]["moveTotal"] == 0
    assert out["capRefusals"]["pieTotal"] == sum(sum(reasons.values()) for reasons in plain.refused.values())


def test_a_variant_above_two_percent_per_position_is_refused(ib, monkeypatch):
    caps, closed = ib.pie_caps(), dict.fromkeys(DAYS, True)
    monkeypatch.setattr(ib.al, "combine", lambda *args, **kwargs: pytest.fail("a refused variant must not reach the caps"))
    with pytest.raises(ValueError, match=r"refused: momentum-rotation/A would hold 2.5% of equity per position, above the 2% cap"):
        ib.lend_idle(_books(), _risk(ib), caps, {ROTATION: 1.5}, closed, DAYS)
    with pytest.raises(ValueError, match="above the 2% cap"):
        ib.replay(_books(), {LONG: 1.01}, closed, DAYS, 1_000_000.0, DAYS[0], DAYS[-1], nautilus=False)
    with pytest.raises(ValueError, match="above the 2% cap"):  # a position that already has 2% takes nothing
        ib.check_extra({ROTATION: 0.5}, {ROTATION: 2.0}, caps)
    with pytest.raises(ValueError, match="above the 1.5% cap"):  # a lower per-name cap is the cap of one position too
        ib.check_extra({ROTATION: 1.0}, _risk(ib), al.Caps(open_risk_pct=4.0, name_risk_pct=1.5))
    with pytest.raises(ValueError, match="must be 0 or more"):
        ib.check_extra({ROTATION: -0.5}, _risk(ib), caps)
    assert ib.check_extra({ROTATION: 1.0}, _risk(ib), caps) == 2.0  # exactly 2% is allowed
    with pytest.raises(ValueError, match="sum to at most 1"):
        ib.variant_extra({ROTATION: 1.0, LONG: 0.5})
    with pytest.raises(ValueError, match="a funded sleeve other than"):
        ib.variant_extra({VOL: 1.0})
    probe = ib.cap_probe()
    assert probe["refused"] and "above the 2% cap" in probe["reason"]


def test_a_run_that_passes_a_cap_raises(ib, monkeypatch):
    books, closed = _books(), dict.fromkeys(DAYS, True)
    real = ib.lend_idle

    def too_big(*args, **kwargs):
        lent = real(*args, **kwargs)
        trades = tuple(dataclasses.replace(trade, max_loss_pct=2.0) for trade in lent.combined.trades)
        return ib.Lent(al.Combined(trades, lent.combined.owner, lent.combined.refused), {}, (), 0, 0)

    monkeypatch.setattr(ib, "lend_idle", too_big)
    with pytest.raises(RuntimeError, match="A cap does not hold"):
        ib.replay(books, {}, closed, DAYS, 1_000_000.0, DAYS[0], DAYS[-1], nautilus=False)


# --------------------------------------------------------------------------- the pie on synthetic data

INDEX_OF = {"SPY": "VIX", "QQQ": "VXN", "DIA": "VXD", "IWM": "RVX", "GLD": "GVZ", "SLV": "VXSLV", "USO": "OVX"}


def _pie_data(days: int = 420, vix_high_from: str | None = None):
    """Every ETF rises, GLD the most (the rotation picks it). VIX 16 under VIX3M 35: the gate is open until
    `vix_high_from`, from where VIX is 30. The data of test_deploy_rehearsal._pie_data."""
    dates = list(trading_days("2023-01-03", days))
    rows = {}
    for number, symbol in enumerate(qi.CORE7):
        drift = 0.0012 if symbol == "GLD" else 0.0004 + 0.00002 * number
        closes = [100.0 * (1 + number) * (1 + drift) ** n for n in range(days)]
        rows[symbol] = {"dates": dates, **{key: list(closes) for key in ("open", "high", "low", "close", "adjClose")}}
        rows[INDEX_OF[symbol]] = {"dates": dates, "close": [
            30.0 if symbol == "SPY" and vix_high_from and day >= vix_high_from else 16.0 for day in dates]}
    rows["VIX3M"] = {"dates": dates, "close": [35.0] * days}
    rows["IRX"] = {"dates": dates, "close": [1.0] * days}
    start = {symbol: dates[0] for symbol in qi.CORE7}
    starts = {idea: dict(start) for idea in ("qc-asset-class-trend", "qc-futures-trend-carry", "qc-momentum-rotation",
                                             "qc-same-month-seasonality")}
    starts["qc-gold-fed-model"] = {"GLD": dates[0]}
    starts["qc-oil-predicts-equity"] = {"SPY": dates[0], "QQQ": dates[0]}
    facts = qi.Facts(iv_start=start, iv_rank_join=start, starts=starts, gold_last_input=dates[-1])
    return pf.dataset_from_rows(rows), facts, dates


@pytest.fixture(scope="module")
def pie(ib):
    plain, facts, dates = _pie_data()
    months = sorted({day[:7] for day in dates})
    high_from = next(day for day in dates if day[:7] == months[-5])
    data, _facts, _dates = _pie_data(vix_high_from=high_from)
    made = ib.fp.sleeve_definitions(qi.family(facts), facts)
    window = {"rule": "test", "start": next(day for day in dates if day[:7] == months[-7]),
              "end": [day for day in dates if day[:7] == months[-2]][-1]}
    return {"data": data, "plain": plain, "made": made, "dates": dates, "highFrom": high_from, "window": window}


def test_the_gate_is_read_per_day_and_without_later_data(ib, pie):
    data, made, dates, high_from = pie["data"], pie["made"], pie["dates"], pie["highFrom"]
    closed = ib.gate_closed_days(made[VOL][0], data)
    known = [day for day in dates[220:]]  # past the 200-day average of the gate
    assert [closed[day] for day in known] == [day >= high_from for day in known]
    assert not any(ib.gate_closed_days(made[VOL][0], pie["plain"])[day] for day in known)
    # the same days from data that ends on the decision day: nothing after a day changes its value
    cut = dates[dates.index(high_from) + 3]
    earlier = ib.gate_closed_days(made[VOL][0], pf._slice(data, cut))
    assert earlier == {day: closed[day] for day in dates if day <= cut}
    with pytest.raises(ValueError, match="no volRegime gate"):
        ib.gate_closed_days(made[ROTATION][0], data)


def test_the_cash_variant_has_the_trades_of_the_unmodified_pie_in_a_window(ib, pie):
    data, made, window = pie["data"], pie["made"], pie["window"]
    books = ib.window_books(made, data, window["start"], window["end"])
    assert all(window["start"] <= trade.entry_date <= window["end"] for trades in books.values() for trade in trades)
    assert len(books[LONG]) == 12 and len(books[ROTATION]) == 6  # SPY and QQQ, and one rotation spread, at 6 decisions
    plain = al.combine(books, _risk(ib), ib.pie_caps())
    ledger = run_ledger(plain.trades, 1_000_000.0, dates=[day for day in data.calendar if day >= window["start"]])
    closed = ib.gate_closed_days(made[VOL][0], data)
    out = ib.replay(books, {}, closed, data.calendar, 1_000_000.0, window["start"], window["end"], nautilus=False)
    assert out["trades"] == len(ledger.trades) and out["trades"] + out["sizedToZero"] == len(plain.trades)
    assert out["pnl"] == pytest.approx(sum(record["pnl"] for record in ledger.trades))
    assert out["finalEquity"] == pytest.approx(ledger.equity[-1])
    assert out["budgetPeaks"]["positionPct"] == 1.0 and out["move"]["appliedPositions"] == 0


def test_the_study_moves_budget_only_at_closed_gate_decisions_and_keeps_the_caps(ib, pie):
    data, made, window, high_from = pie["data"], pie["made"], pie["window"], pie["highFrom"]
    out = ib.run_study(data, made, {"test": window}, 1_000_000.0, False)
    assert set(out) == {"test", "full"} and all(set(item["variants"]) == set(ib.VARIANTS) for item in out.values())
    closed = ib.gate_closed_days(made[VOL][0], data)
    for name, item in out.items():
        days = ib.decisions_in(data.calendar, item["window"]["start"], item["window"]["end"])
        assert item["decisions"] == len(days) and item["gateClosedDecisions"] == sum(closed[day] for day in days) > 0
        cash = item["variants"]["cash"]
        assert cash["move"]["appliedDecisions"] == 0 and cash["budgetPeaks"]["positionPct"] == 1.0
        for variant, run in item["variants"].items():
            peaks, move = run["budgetPeaks"], run["move"]
            assert peaks["openPct"] <= 4.0 + 1e-9 and peaks["namePct"] <= 2.0 + 1e-9 and peaks["positionPct"] <= 2.0 + 1e-9
            assert all(closed[day] for day in move["appliedDecisionDays"])
            assert name == "full" or all(day >= high_from for day in move["appliedDecisionDays"])
            assert move["appliedDecisions"] <= item["gateClosedDecisions"]
            assert run["trades"] + run["sizedToZero"] == cash["trades"] + cash["sizedToZero"], (name, variant)
            assert run["monteCarlo"]["paths"] == al.MONTE_CARLO_PATHS and run["monteCarlo"]["worstDrawdown"] <= 0
            if variant != "cash":
                assert move["appliedDecisions"] > 0
                assert peaks["positionPct"] == max(run["positionPct"].values()) > 1.0
    full = out["full"]["variants"]
    assert set(full["cash"]["stats"]) == set(ib.FULL_STAT_KEYS) and full["cash"]["baselineByGate"][LONG]["gateClosed"]["trades"] > 0
    assert full["rotation"]["baselineByGate"] is None and full["rotation"]["monteCarloSeeds"]["worstDrawdown"] <= 0
    # the rotation position holds 2% only when decided on a closed-gate day, in every variant run above
    lent = ib.lend_idle(ib.full_books(made, data)[1], _risk(ib), ib.pie_caps(), {ROTATION: 1.0}, closed, data.calendar)
    for trade in lent.combined.trades:
        decided = ib.decision_day(data.calendar, trade.entry_date)
        if trade.max_loss_pct > 1.0:
            assert lent.combined.owner[trade.trade_id] == ROTATION and closed[decided] and trade.max_loss_pct == 2.0
    document = {"windows": out, "limits": {"positionRiskPct": 1.0, "positionRiskCapPct": 2.0},
                "variants": {name: {"positionPct": run["positionPct"], "aboveThePieFigure": name != "cash"}
                             for name, run in full.items()}}
    table = ib.markdown(document)
    assert table.count("| test ") == table.count("| full ") == len(ib.VARIANTS)
    for block in table.split("\n\n"):  # every row of a table has the cells of its header
        rows = [line for line in block.splitlines() if line.startswith("|")]
        assert len({line.count("|") for line in rows}) <= 1, block
    assert "Engine: ledger only." in table
    assert "- rotation: long index 1%, rotation 2% (above the pie's figure, within the owner gate)" in table


def test_the_windows_are_those_of_the_rehearsal(ib, pie):
    windows = ib.study_windows(pie["data"], pie["made"], {"by-hand": ("2024-02-01", "2024-03-28")})
    assert list(windows) == ["strong", "contrast", "by-hand"]
    assert all(set(window) == {"rule", "start", "end"} and window["start"] < window["end"] for window in windows.values())
    assert windows["contrast"]["end"] == pie["dates"][-1] and windows["by-hand"]["start"] == "2024-02-01"
