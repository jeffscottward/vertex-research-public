"""golive: the draft candidates of an allocation plan for one trading day (synthetic data, no network)."""
import copy
import dataclasses
import io
import json
import math
import os
import re
import sys
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from golive import __main__ as cli
from golive import generator as gl
from strategies.qc_ports import allocation as al
from strategies.qc_ports import ideas as qi
from strategies.qc_ports import portfolio as pf
from strategies.qc_ports.book import STRUCTURES as BOOK_STRUCTURES
from strategies.qc_ports.book import choose_expiry
from strategies.qc_ports.data import IV_INDEX
from tests.qc_ports_synthetic import trading_days

FIRST_DAY = "2025-07-01"
# Daily growth of each ETF: GLD has the best 12-1 momentum, IWM a negative one.
DRIFT = {"SPY": 0.0005, "QQQ": 0.0006, "DIA": 0.0002, "IWM": -0.0002, "GLD": 0.0012, "SLV": 0.0003, "USO": 0.0001}
FIRST_CLOSE = {"SPY": 500.0, "QQQ": 400.0, "DIA": 300.0, "IWM": 200.0, "GLD": 250.0, "SLV": 40.0, "USO": 80.0}
VIX, VIX3M, RATE = 18.0, 20.0, 4.0
NOW = datetime(2026, 12, 1, 14, 0, tzinfo=UTC)  # Tuesday 09:00 New York

SLEEVES = {
    "long-index": {"anchorDelta": 0.5, "budgetPct": 2, "definitionNote": "", "definitionVariant": "always_on_entry",
                   "dteMin": 45, "dteTarget": 60, "key": "long-index", "name": "Long index",
                   "runKey": "oil-predicts-equity/B", "structure": "callDebitVertical", "symbols": ["SPY", "QQQ"],
                   "widthSigma": 1},
    "rotation": {"anchorDelta": 0.5, "budgetPct": 1, "definitionNote": "", "definitionVariant": "top_1", "dteMin": 45,
                 "dteTarget": 60, "key": "rotation", "name": "Momentum rotation", "runKey": "momentum-rotation/A",
                 "structure": "callDebitVertical", "symbols": list(qi.CORE7), "widthSigma": 1},
    "vol-premium": {"anchorDelta": 0.25, "budgetPct": 1, "definitionNote": "", "definitionVariant": "as_studied",
                    "dteMin": 30, "dteTarget": 45, "key": "vol-premium", "name": "Put credit, gated",
                    "runKey": "regime-put-vrp/A", "structure": "putCreditVertical", "symbols": ["SPY"],
                    "widthSigma": 0.5},
}


def _plan(**changes) -> dict:
    """The plan document of the funded lower-bar pie, as goLiveDrafts.queue returns it (the fields the generator reads)."""
    plan = {"id": "funded-lower-bar-pie", "version": 3, "name": "Funded lower-bar pie", "status": "approved",
            "limits": {"maxPositions": 4, "nameRiskCapPct": 2, "openRiskCapPct": 4, "positionRiskPct": 1},
            "sleeves": [copy.deepcopy(sleeve) for sleeve in SLEEVES.values()]}
    return {**plan, **changes}


def _sleeve(key: str, **changes) -> dict:
    return {**copy.deepcopy(SLEEVES[key]), **changes}


def _facts() -> qi.Facts:
    first = {symbol: FIRST_DAY for symbol in qi.CORE7}
    return qi.Facts(iv_start=first, iv_rank_join=first, starts={idea: first for idea in qi.ELIGIBILITY},
                    gold_last_input=FIRST_DAY)


def _dataset(last_day: str, short: str | None = None, last_vix: float = VIX) -> pf.Dataset:
    """Seven ETFs on a steady path from FIRST_DAY to `last_day`, calm volatility indices and a flat rate.
    `short`: one ETF whose bars end a day early. `last_vix`: the VIX close of the last day."""
    days = [day for day in trading_days(FIRST_DAY, 420) if day <= last_day]
    rows = {}
    for symbol in qi.CORE7:
        own = days[:-1] if symbol == short else days
        closes = [FIRST_CLOSE[symbol] * (1 + DRIFT[symbol]) ** number for number in range(len(own))]
        rows[symbol] = {"dates": own, **{key: list(closes) for key in ("open", "high", "low", "close", "adjClose")}}
    for index_id in IV_INDEX.values():
        rows[index_id] = {"dates": days, "close": [VIX] * len(days)}
    rows["VIX"] = {"dates": days, "close": [VIX] * (len(days) - 1) + [last_vix]}
    rows["VIX3M"] = {"dates": days, "close": [VIX3M] * len(days)}
    rows["IRX"] = {"dates": days, "close": [RATE] * len(days)}
    return pf.dataset_from_rows(rows)


# Every index series of the data set: the implied-volatility indices (VIX is one), VIX3M and the rate.
INDEX_SERIES = (*dict.fromkeys(IV_INDEX.values()), "VIX3M", "IRX")


def _gap(data: pf.Dataset, from_day: str, *series_ids: str) -> pf.Dataset:
    """`data` where the named series have no value dated `from_day` or later (the bars go on)."""
    cut = {series_id: {day: value for day, value in data.series[series_id].items() if day < from_day}
           for series_id in series_ids}
    return pf.Dataset(data.bars, {**data.series, **cut})


def _generate(last_day: str, trading_day: str, store, plan: dict | None = None, now: datetime = NOW) -> dict:
    return gl.generate(plan or _plan(), _dataset(last_day), _facts(), store, trading_day, now)


def _picked(document: dict, basis: str) -> list[tuple[str, str]]:
    return [(item["sleeveKey"], item["symbol"]) for item in document["candidates"] if item["entryBasis"] == basis]


def _one(document: dict, basis: str, sleeve: str, symbol: str) -> dict:
    return next(item for item in document["candidates"]
                if (item["entryBasis"], item["sleeveKey"], item["symbol"]) == (basis, sleeve, symbol))


@pytest.fixture(scope="module")
def roll_day(tmp_path_factory) -> dict:
    """Tuesday 2026-12-01, the first trading day of the month, from data that ends on Monday 2026-11-30."""
    return _generate("2026-11-30", "2026-12-01", tmp_path_factory.mktemp("no-chains"))


@pytest.fixture(scope="module")
def mid_month(tmp_path_factory) -> dict:
    return _generate("2026-11-11", "2026-11-12", tmp_path_factory.mktemp("no-chains"))


# --------------------------------------------------------------------------- hand-written mirror of the contract

STRUCTURES = {"callDebitVertical", "putDebitVertical", "putCreditVertical", "callCreditVertical"}
CANDIDATE_KEYS = {"entryBasis", "expiry", "longStrike", "quote", "shortStrike", "signalFacts", "sleeveKey",
                  "structure", "symbol"}
QUOTE_KEYS = {"asOf", "longAsk", "longBid", "shortAsk", "shortBid", "source"}


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def assert_collect_input(document: dict) -> None:
    """GoLiveCollectInputSchema and GoLiveDraftCandidateSchema of packages/api/src/contracts/golive-drafts.ts,
    field by field (both are strict: no other key)."""
    assert set(document) == {"candidates", "generatedAt", "planId", "planVersion", "tradingDay"}
    assert isinstance(document["planId"], str) and 1 <= len(document["planId"].strip()) <= 128
    assert type(document["planVersion"]) is int and document["planVersion"] > 0
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", document["tradingDay"])
    assert datetime.fromisoformat(document["generatedAt"]).tzinfo is not None
    assert isinstance(document["candidates"], list) and len(document["candidates"]) <= 50
    for item in document["candidates"]:
        assert set(item) == CANDIDATE_KEYS
        assert item["entryBasis"] in ("signal_today", "model_holds_account_does_not")
        assert re.fullmatch(r"\d{8}", item["expiry"])
        for strike in (item["longStrike"], item["shortStrike"]):
            assert _is_number(strike) and 0 < strike <= 100_000
        assert item["longStrike"] != item["shortStrike"]
        assert isinstance(item["signalFacts"], list) and len(item["signalFacts"]) <= 20
        assert all(isinstance(fact, str) and len(fact) <= 200 for fact in item["signalFacts"])
        assert isinstance(item["sleeveKey"], str) and 1 <= len(item["sleeveKey"]) <= 40
        assert item["structure"] in STRUCTURES
        assert re.fullmatch(r"[A-Z][A-Z0-9.]{0,9}", item["symbol"])
        quote = item["quote"]
        if quote is not None:
            assert set(quote) == QUOTE_KEYS
            assert datetime.fromisoformat(quote["asOf"]).tzinfo is not None
            assert quote["source"] in ("ibkr_live", "yahoo_delayed_snapshot", "model")
            assert all(_is_number(quote[key]) and quote[key] >= 0 for key in QUOTE_KEYS - {"asOf", "source"})
    json.dumps(document, allow_nan=False)


# --------------------------------------------------------------------------- definition variants

def test_as_studied_is_the_study_definition_unchanged_from_its_study_start():
    facts = _facts()
    runs = qi.family(facts)
    definition, start = gl.build_definition(_sleeve("vol-premium"), runs, facts)
    studied = runs["regime-put-vrp/A"]
    assert definition == studied.definition and start == studied.start == qi.VIX3M_START
    assert definition["filters"] == [qi.GATES["volRegime"]]
    # The same sleeve funded_pie.py runs, and a copy: a change here never reaches the study definition.
    assert (definition, start) == gl.funded_pie().sleeve_definitions(runs, facts)["regime-put-vrp/A"]
    definition["options"]["dte"]["target"] = 7
    assert studied.definition["options"]["dte"]["target"] == 45


def test_as_studied_builds_any_run_of_the_family():
    facts = _facts()
    runs = qi.family(facts)
    definition, start = gl.build_definition(_sleeve("long-index", definitionVariant="as_studied"), runs, facts)
    assert definition == runs["oil-predicts-equity/B"].definition and start == runs["oil-predicts-equity/B"].start
    assert definition["entry"] != {"all": [qi.ALWAYS]}


def test_always_on_entry_is_the_long_index_sleeve_of_funded_pie():
    facts = _facts()
    facts = qi.Facts(iv_start={**facts.iv_start, "QQQ": "2025-09-02"}, iv_rank_join=facts.iv_rank_join,
                     starts=facts.starts, gold_last_input=facts.gold_last_input)
    runs = qi.family(facts)
    definition, start = gl.build_definition(_sleeve("long-index"), runs, facts)
    assert (definition, start) == gl.funded_pie().sleeve_definitions(runs, facts)["oil-predicts-equity/B"]
    assert definition["entry"] == {"all": [qi.ALWAYS]} and definition["name"] == "Always-on SPY and QQQ"
    assert start == "2025-09-02"  # the first day both members have an IV index, not the study start
    studied = runs["oil-predicts-equity/B"].definition
    assert studied["entry"] != definition["entry"]
    assert {key: value for key, value in definition.items() if key not in ("entry", "name")} == {
        key: value for key, value in studied.items() if key not in ("entry", "name")}


def test_top_1_is_the_rotation_sleeve_of_funded_pie():
    facts = _facts()
    runs = qi.family(facts)
    definition, start = gl.build_definition(_sleeve("rotation"), runs, facts)
    assert (definition, start) == gl.funded_pie().sleeve_definitions(runs, facts)["momentum-rotation/A"]
    studied = runs["momentum-rotation/A"]
    assert definition["portfolio"]["select"]["top"] == 1 and studied.definition["portfolio"]["select"]["top"] == 2
    assert start == studied.start and definition["entry"] == studied.definition["entry"]


@pytest.mark.parametrize(("variant", "run_key"), [("always_on_entry", "momentum-rotation/A"),
                                                  ("top_1", "oil-predicts-equity/B"),
                                                  ("top_1", "regime-put-vrp/A")])
def test_a_changed_variant_is_refused_for_a_run_it_was_not_tested_on(variant, run_key):
    facts = _facts()
    with pytest.raises(gl.GoLiveError, match=f"Sleeve rotation: this variant is tested .* only, not {run_key}"):
        gl.build_definition(_sleeve("rotation", definitionVariant=variant, runKey=run_key), qi.family(facts), facts)


@pytest.mark.parametrize("variant", ["top_2", "", None, 1])
def test_an_unknown_variant_is_refused(variant):
    facts = _facts()
    with pytest.raises(gl.GoLiveError, match="Sleeve rotation: unknown definitionVariant .*known: as_studied, "
                                             "always_on_entry, top_1"):
        gl.build_definition(_sleeve("rotation", definitionVariant=variant), qi.family(facts), facts)


def test_the_builders_are_the_contract_variants():
    # GOLIVE_DEFINITION_VARIANT_VALUES of packages/api/src/contracts/golive-drafts.ts
    assert set(gl.BUILDERS) == {"as_studied", "always_on_entry", "top_1"}


def test_a_run_key_outside_the_family_is_refused():
    facts = _facts()
    with pytest.raises(gl.GoLiveError, match="Sleeve vol-premium: run key 'regime-put-vrp/Z' is not a run of ideas.family"):
        gl.build_definition(_sleeve("vol-premium", runKey="regime-put-vrp/Z"), qi.family(facts), facts)


def test_funded_pie_loads_without_nautilus_and_leaves_the_import_state_as_it_was():
    def engine_modules() -> set[str]:
        return {name for name in sys.modules if name.split(".")[0] == "nautilus_trader"}

    gl.funded_pie.cache_clear()
    path, modules, engine = list(sys.path), set(sys.modules), engine_modules()
    module = gl.funded_pie()
    assert set(module.POOL) == {"oil-predicts-equity/B", "momentum-rotation/A", "regime-put-vrp/A"}
    assert sys.path == path and engine_modules() == engine
    assert not {"run", "sensitivity"} & (set(sys.modules) - modules)
    assert gl.funded_pie() is module


def test_a_sleeve_must_state_the_terms_of_its_tested_definition():
    facts = _facts()
    runs = qi.family(facts)
    for key in SLEEVES:
        gl.check_sleeve(_sleeve(key), gl.build_definition(_sleeve(key), runs, facts)[0])
    definition = gl.build_definition(_sleeve("vol-premium"), runs, facts)[0]
    gl.check_sleeve(_sleeve("rotation", symbols=list(reversed(qi.CORE7))),
                    gl.build_definition(_sleeve("rotation"), runs, facts)[0])
    with pytest.raises(gl.GoLiveError, match=r"Sleeve vol-premium does not state its tested definition: "
                                             r"dteTarget 60 \(tested: 45\); anchorDelta 0.3 \(tested: 0.25\)"):
        gl.check_sleeve(_sleeve("vol-premium", dteTarget=60, anchorDelta=0.3), definition)
    for field, value in (("structure", "putDebitVertical"), ("symbols", ["SPY", "QQQ"]), ("dteMin", 21),
                         ("widthSigma", 1)):
        with pytest.raises(gl.GoLiveError, match=field):
            gl.check_sleeve(_sleeve("vol-premium", **{field: value}), definition)
    two_legs = runs["futures-trend-carry/A"].definition
    with pytest.raises(gl.GoLiveError, match="more than one leg"):
        gl.check_sleeve(_sleeve("rotation"), two_legs)


@pytest.mark.parametrize(("change", "message"), [
    (lambda plan: [], "must be a JSON object"),
    (lambda plan: {**plan, "id": ""}, "needs an id"),
    (lambda plan: {**plan, "version": True}, "needs a version"),
    (lambda plan: {**plan, "version": 0}, "needs a version"),
    (lambda plan: {**plan, "limits": {**plan["limits"], "openRiskCapPct": 0}}, "limits need a positive"),
    (lambda plan: {**plan, "limits": None}, "limits need a positive"),
    (lambda plan: {**plan, "limits": {**plan["limits"], "maxPositions": 4.5}}, "maxPositions must be an integer"),
    (lambda plan: {**plan, "sleeves": []}, "at least one sleeve"),
    (lambda plan: {**plan, "sleeves": [{"key": "a"}]}, "Every sleeve needs key, runKey"),
    (lambda plan: {**plan, "sleeves": [_sleeve("rotation", symbols="SPY")]}, "a list of symbols"),
    (lambda plan: {**plan, "sleeves": [_sleeve("rotation"), _sleeve("rotation")]}, "Sleeve keys must be unique"),
])
def test_a_plan_without_the_fields_the_generator_reads_is_refused(change, message):
    with pytest.raises(gl.GoLiveError, match=message):
        gl.checked_plan(change(_plan()))
    assert gl.checked_plan(_plan())["id"] == "funded-lower-bar-pie"


# --------------------------------------------------------------------------- days and data

def test_the_data_must_end_the_trading_day_before_the_trading_day():
    days = trading_days("2026-11-02", 7)  # through Tuesday 2026-11-10
    assert gl.last_data_day(days, "2026-11-11") == "2026-11-10"
    # Friday's data serves Monday; Wednesday's data serves the Friday after Thanksgiving.
    assert gl.last_data_day(trading_days("2026-11-02", 10), "2026-11-16") == "2026-11-13"
    assert gl.last_data_day(trading_days("2026-11-02", 18), "2026-11-27") == "2026-11-25"
    with pytest.raises(gl.StaleDataError, match="The data ends on 2026-11-10. Trading day 2026-11-12 needs data "
                                                "through 2026-11-11"):
        gl.last_data_day(days, "2026-11-12")
    for day in ("2026-11-10", "2026-11-09"):
        with pytest.raises(gl.StaleDataError, match=f"The data ends on 2026-11-10, at or after trading day {day}"):
            gl.last_data_day(days, day)


@pytest.mark.parametrize("day", ["2026-11-14", "2026-11-15", "2026-11-26", "2026-12-25"])
def test_a_closed_day_is_its_own_error(day):
    with pytest.raises(gl.NotTradingDayError, match=f"{day} is not an NYSE trading day"):
        gl.last_data_day(trading_days("2026-11-02", 7), day)
    assert issubclass(gl.NotTradingDayError, gl.GoLiveError) and not issubclass(gl.NotTradingDayError, gl.StaleDataError)


@pytest.mark.parametrize("day", ["12/01/2026", "2026-13-01", "", None])
def test_a_trading_day_that_is_not_a_date_is_refused(day):
    with pytest.raises(gl.GoLiveError, match="The trading day must be YYYY-MM-DD"):
        gl.last_data_day(trading_days("2026-11-02", 7), day)


def test_pending_days_are_the_trading_day_and_the_next_one():
    days = trading_days("2026-11-02", 7)
    assert gl.pending_days(days, "2026-11-11") == ("2026-11-11", "2026-11-12")
    assert gl.pending_days(days, "2026-11-13") == ("2026-11-13", "2026-11-16")  # over the weekend
    assert gl.pending_days(days, "2026-11-25") == ("2026-11-25", "2026-11-27")  # over Thanksgiving


def test_pending_bars_repeat_the_last_close_and_leave_the_data_as_it_was():
    data = _dataset("2026-11-30")
    pending = gl.with_pending_days(data, ("2026-12-01", "2026-12-02"))
    for symbol in qi.CORE7:
        before, after = data.bars[symbol], pending.bars[symbol]
        assert after.dates == before.dates + ("2026-12-01", "2026-12-02") and before.dates[-1] == "2026-11-30"
        for column in ("open", "high", "low", "close"):
            assert getattr(after, column) == getattr(before, column) + (before.close[-1],) * 2
        assert after.adj_close == before.adj_close + (before.adj_close[-1],) * 2
        assert pending.series[f"{symbol}:TR"]["2026-12-02"] == before.adj_close[-1]
        assert "2026-12-01" not in data.series[f"{symbol}:TR"]
    # No index or rate value is invented: the book carries the last one, as on a day without a print.
    assert "2026-12-01" not in pending.series["VIX"] and pending.series["VIX"] == data.series["VIX"]
    assert pf.market_of(pending, "SPY").iv_index[-2:] == (VIX, VIX)
    assert pending.calendar[-3:] == ("2026-11-30", "2026-12-01", "2026-12-02")
    # A day the data already has is not added again.
    assert gl.with_pending_days(data, ("2026-11-30",)).bars["SPY"] is data.bars["SPY"]


def test_stale_data_is_refused_and_the_message_names_the_last_data_day(tmp_path):
    with pytest.raises(gl.StaleDataError, match="The data ends on 2026-11-10") as stale:
        _generate("2026-11-10", "2026-11-12", tmp_path)
    assert "2026-11-11" in str(stale.value)  # the day the data must reach
    with pytest.raises(gl.StaleDataError, match="The data ends on 2026-11-12, at or after trading day 2026-11-12"):
        _generate("2026-11-12", "2026-11-12", tmp_path)


def test_one_etf_with_older_bars_is_stale_data(tmp_path):
    data = _dataset("2026-11-30", short="GLD")
    with pytest.raises(gl.StaleDataError, match="The GLD bars end on 2026-11-27, the data on 2026-11-30"):
        gl.generate(_plan(), data, _facts(), tmp_path, "2026-12-01", NOW)
    # A plan that does not trade GLD is not held up by it.
    document = gl.generate(_plan(sleeves=[_sleeve("vol-premium")]), data, _facts(), tmp_path, "2026-12-01", NOW)
    assert _picked(document, gl.MODEL_HOLDS) == [("vol-premium", "SPY")]


def _made(plan: dict) -> dict:
    facts = _facts()
    return {sleeve["key"]: gl.build_definition(sleeve, qi.family(facts), facts) for sleeve in plan["sleeves"]}


def test_required_series_are_what_the_gates_the_signal_and_the_options_book_of_a_sleeve_read():
    made = _made(_plan())
    assert gl.required_series(made["long-index"][0]) == {
        "VIX": ["strike-width volatility of SPY"], "VXN": ["strike-width volatility of QQQ"], "IRX": ["rate"]}
    assert gl.required_series(made["vol-premium"][0]) == {
        "VIX": ["gate", "strike-width volatility of SPY"], "VIX3M": ["gate"], "SPY": ["gate"], "IRX": ["rate"]}
    # The rotation asks of every member that its volatility index is live, and prices each on it.
    assert gl.required_series(made["rotation"][0]) == {
        **{IV_INDEX[symbol]: [f"gate of {symbol}", f"strike-width volatility of {symbol}"] for symbol in qi.CORE7},
        "IRX": ["rate"]}
    # The study entry of the long-index run reads the rate and the oil total return as signal inputs.
    as_studied = _plan(sleeves=[_sleeve("long-index", definitionVariant="as_studied")])
    studied = gl.required_series(_made(as_studied)["long-index"][0])
    assert studied["USO:TR"] == ["signal input"] and studied["IRX"] == ["signal input", "rate"]
    assert set(studied) == {"USO:TR", "IRX", "VIX", "VXN"}


def test_index_series_that_stopped_while_the_bars_went_on_refuse_the_run(tmp_path):
    data = _dataset("2026-11-30")
    days = data.calendar
    stale = _gap(data, days[-7], *INDEX_SERIES)  # seven trading days without a print; every ETF bar is there
    assert all(bar.dates[-1] == "2026-11-30" for bar in stale.bars.values())
    # What the signal code makes of it without a word: nothing entered today and nothing held.
    plan = _plan()
    silent = gl.model_trades(_made(plan), gl.with_pending_days(stale, gl.pending_days(days, "2026-12-01")), plan)
    assert not [trade for trade in silent.trades if trade.entry_date == "2026-12-01" or trade.exit_date > "2026-11-30"]
    with pytest.raises(gl.StaleDataError) as refused:
        gl.generate(plan, stale, _facts(), tmp_path, "2026-12-01", NOW)
    lines = str(refused.value).splitlines()
    assert len(lines) == len(INDEX_SERIES) == 9
    for series_id in INDEX_SERIES:  # the series, its last date and the date needed
        assert sum(line.startswith(
            f"The {series_id} series has no value of 2026-11-30: its last value before that day is of {days[-8]}. "
            "Trading day 2026-12-01 needs its value of 2026-11-30; a value carried forward does not count. Read by: ")
            for line in lines) == 1


def test_a_stale_volatility_index_of_one_etf_refuses_the_run(tmp_path):
    data = _dataset("2026-11-30")
    stale = _gap(data, data.calendar[-7], "VXN")
    with pytest.raises(gl.StaleDataError) as refused:
        gl.generate(_plan(), stale, _facts(), tmp_path, "2026-12-01", NOW)
    assert str(refused.value) == (
        f"The VXN series has no value of 2026-11-30: its last value before that day is of {data.calendar[-8]}. "
        "Trading day 2026-12-01 needs its value of 2026-11-30; a value carried forward does not count. Read by: "
        "long-index (strike-width volatility of QQQ); rotation (gate of QQQ, strike-width volatility of QQQ).")
    # A plan without a sleeve that reads VXN is not held up by it.
    document = gl.generate(_plan(sleeves=[_sleeve("vol-premium")]), stale, _facts(), tmp_path, "2026-12-01", NOW)
    assert document["candidates"] == gl.generate(_plan(sleeves=[_sleeve("vol-premium")]), data, _facts(), tmp_path,
                                                 "2026-12-01", NOW)["candidates"]
    assert _picked(document, gl.MODEL_HOLDS) == [("vol-premium", "SPY")]


def test_a_stale_rate_refuses_the_run(tmp_path):
    data = _dataset("2026-11-30")
    stale = _gap(data, data.calendar[-7], "IRX")
    with pytest.raises(gl.StaleDataError, match=r"The IRX series has no value of 2026-11-30: .* Read by: "
                                                r"long-index \(rate\); rotation \(rate\); vol-premium \(rate\)\.$"):
        gl.generate(_plan(), stale, _facts(), tmp_path, "2026-12-01", NOW)


@pytest.mark.parametrize("series_id", ["VIX", "VIX3M"])
def test_a_gate_series_without_a_value_of_the_signal_day_refuses_the_run(tmp_path, series_id):
    # 2026-09-01 is the day the gated put credit spread is entered (test_a_gated_entry_states_...). The gate
    # reads the value of the signal day itself, so one missing print would drop that entry without a word.
    data = _gap(_dataset("2026-08-31"), "2026-08-31", series_id)
    with pytest.raises(gl.StaleDataError) as refused:
        gl.generate(_plan(), data, _facts(), tmp_path, "2026-09-01", NOW)
    line = next(line for line in str(refused.value).splitlines() if line.startswith(f"The {series_id} series"))
    assert line.startswith(f"The {series_id} series has no value of 2026-08-31: its last value before that day is of "
                           "2026-08-28. Trading day 2026-09-01 needs its value of 2026-08-31;")
    assert "vol-premium (gate" in line


def test_a_value_carried_forward_is_not_a_value_of_the_last_data_day(tmp_path):
    made = _made(_plan())
    data = _dataset("2026-11-11")
    gl.check_series(_plan()["sleeves"], made, data, "2026-11-11", "2026-11-12")
    # One day without a print: the book would carry the value of 2026-11-10 and say nothing.
    with pytest.raises(gl.StaleDataError, match="The GVZ series has no value of 2026-11-11: its last value before that "
                                                "day is of 2026-11-10"):
        gl.check_series(_plan()["sleeves"], made, _gap(data, "2026-11-11", "GVZ"), "2026-11-11", "2026-11-12")
    # A value that is not a finite number is no value; a series that is not there has none at all.
    broken = pf.Dataset(data.bars, {**data.series, "IRX": {**data.series["IRX"], "2026-11-11": math.nan}})
    with pytest.raises(gl.StaleDataError, match="The IRX series has no value of 2026-11-11"):
        gl.check_series(_plan()["sleeves"], made, broken, "2026-11-11", "2026-11-12")
    absent = pf.Dataset(data.bars, {key: value for key, value in data.series.items() if key != "VIX3M"})
    with pytest.raises(gl.StaleDataError, match="The VIX3M series has no value of 2026-11-11: it has no value before "
                                                "that day"):
        gl.check_series(_plan()["sleeves"], made, absent, "2026-11-11", "2026-11-12")


def test_an_etf_read_as_a_series_must_reach_the_last_data_day_too():
    # The study entry of the long-index run reads the USO total return; the sleeve trades SPY and QQQ only.
    plan = _plan(sleeves=[_sleeve("long-index", definitionVariant="as_studied")])
    with pytest.raises(gl.StaleDataError, match="The USO:TR series has no value of 2026-11-30: its last value before "
                                                r"that day is of 2026-11-27\. .* Read by: long-index \(signal input\)"):
        gl.check_series(plan["sleeves"], _made(plan), _dataset("2026-11-30", short="USO"), "2026-11-30", "2026-12-01")


# --------------------------------------------------------------------------- candidates

def test_a_model_entry_dated_on_the_trading_day_is_a_signal_today(roll_day):
    assert_collect_input(roll_day)
    assert (roll_day["planId"], roll_day["planVersion"], roll_day["tradingDay"], roll_day["generatedAt"]) == (
        "funded-lower-bar-pie", 3, "2026-12-01", "2026-12-01T14:00:00Z")
    # The monthly roll: both index verticals and the momentum pick. The put credit sleeve still holds its
    # November spread (one spread at a time), so it has no entry today.
    assert _picked(roll_day, gl.SIGNAL_TODAY) == [("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD")]
    spy = _one(roll_day, gl.SIGNAL_TODAY, "long-index", "SPY")
    assert spy["structure"] == "callDebitVertical" and spy["quote"] is None
    assert spy["expiry"] == choose_expiry("2026-12-01", 60, 45).strftime("%Y%m%d") == "20270115"
    assert spy["longStrike"] < spy["shortStrike"]
    close = _dataset("2026-11-30").bars["SPY"].close[-1]
    assert abs(spy["longStrike"] - close) < 0.05 * close  # a 50-delta call of the last real close
    assert spy["signalFacts"][:4] == [
        "Data last day 2026-11-30.",
        "Model entry date 2026-12-01; its signal is the close of 2026-11-30.",
        "Timing: a signal at one close is traded at the close of the next trading day (the tested entry time).",
        "Entry rule: always on (this sleeve has no entry gate).",
    ]
    assert "Model expiry 2027-01-15: 45 days after the entry date (target 60, minimum 45)." in spy["signalFacts"]
    assert (f"Model strikes {spy['longStrike']:g}/{spy['shortStrike']:g} use the 2026-11-30 close (SPY {close:.2f}); "
            "the tested entry sets them at the 2026-12-01 close.") in spy["signalFacts"]


def test_a_gated_entry_states_the_gate_values_of_its_signal_day(tmp_path):
    # Tuesday 2026-09-01: the put credit spread of July expired on 2026-08-21, so the sleeve is free, and
    # the volatility-regime gate held at the close of Monday 2026-08-31.
    document = _generate("2026-08-31", "2026-09-01", tmp_path)
    assert _picked(document, gl.SIGNAL_TODAY) == [
        ("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD"), ("vol-premium", "SPY")]
    put = _one(document, gl.SIGNAL_TODAY, "vol-premium", "SPY")
    assert (put["structure"], put["expiry"]) == ("putCreditVertical", "20261016")
    spy = _dataset("2026-08-31").bars["SPY"]
    assert put["signalFacts"][:6] == [
        "Data last day 2026-08-31.",
        "Model entry date 2026-09-01; its signal is the close of 2026-08-31.",
        "Timing: a signal at one close is traded at the close of the next trading day (the tested entry time).",
        "VIX 18.00 on 2026-08-31 (gate: at most 25).",
        "VIX/VIX3M ratio 0.900 on 2026-08-31 (gate: at most 1).",
        f"SPY close {spy.close[-1]:.2f}, its 200-day average {sum(spy.close[-200:]) / 200:.2f} on 2026-08-31 "
        "(gate: close above the average).",
    ]
    assert put["shortStrike"] < spy.close[-1]  # a 25-delta put of the last real close


def test_a_gate_that_fails_on_the_signal_day_gives_no_draft(tmp_path):
    # The same day with VIX at 30 on the signal close (the gate allows 25 at most, and VIX/VIX3M 1.0).
    data = _dataset("2026-08-31", last_vix=30.0)
    document = gl.generate(_plan(), data, _facts(), tmp_path, "2026-09-01", NOW)
    assert _picked(document, gl.SIGNAL_TODAY) == [("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD")]
    assert ("vol-premium", "SPY") not in _picked(document, gl.MODEL_HOLDS)


def test_the_rotation_pick_states_its_momentum_and_its_rank(roll_day):
    pick = _one(roll_day, gl.SIGNAL_TODAY, "rotation", "GLD")
    closes = _dataset("2026-11-30").bars["GLD"]
    ends = pf.month_end_indices(closes.dates + ("2026-12-01",))
    momentum = closes.close[ends[-2]] / closes.close[ends[-13]] - 1  # month ends of October 2026 and November 2025
    facts = pick["signalFacts"]
    assert f"Entry condition 1: 12-1 momentum {momentum:.4g} > 0 on 2026-11-30." in facts
    assert "GVZ 18 on 2026-11-30 (gate: > 0)." in facts
    assert (f"Selection: GLD ranks 1 of 7 members by 12-1 momentum ({momentum:.4g}) in 2026-11; the sleeve holds "
            "the top 1.") in facts
    assert momentum > 0.3


def test_an_older_open_model_trade_is_model_holds_account_does_not(mid_month):
    assert_collect_input(mid_month)
    # No entry on a day in the middle of the month: the rule fires at the monthly roll only.
    assert _picked(mid_month, gl.SIGNAL_TODAY) == []
    assert _picked(mid_month, gl.MODEL_HOLDS) == [
        ("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD"), ("vol-premium", "SPY")]
    put = _one(mid_month, gl.MODEL_HOLDS, "vol-premium", "SPY")
    assert put["structure"] == "putCreditVertical" and put["expiry"] == "20261218"
    assert put["longStrike"] < put["shortStrike"]  # the short put is the anchor, the long put is below it
    spy = _dataset("2026-11-11").series["SPY"]
    closes = [close for day, close in sorted(spy.items()) if day <= "2026-10-30"]
    assert put["signalFacts"][:6] == [
        "Data last day 2026-11-11.",
        "Model entry date 2026-11-02; its signal is the close of 2026-10-30.",
        "Timing: a signal at one close is traded at the close of the next trading day (the tested entry time).",
        "VIX 18.00 on 2026-10-30 (gate: at most 25).",
        "VIX/VIX3M ratio 0.900 on 2026-10-30 (gate: at most 1).",
        f"SPY close {closes[-1]:.2f}, its 200-day average {sum(closes[-200:]) / 200:.2f} on 2026-10-30 "
        "(gate: close above the average).",
    ]
    assert not any("the tested entry sets them" in fact or "The model closes" in fact for fact in put["signalFacts"])


def test_the_open_list_is_the_open_today_list_of_the_data_without_pending_days(mid_month):
    data, facts, plan = _dataset("2026-11-11"), _facts(), _plan()
    made = {sleeve["key"]: gl.build_definition(sleeve, qi.family(facts), facts) for sleeve in plan["sleeves"]}
    plain = gl.model_trades(made, data, plan)
    # funded_pie.py openToday: the trades the run ends with on the last data day.
    open_today = sorted((plain.owner[trade.trade_id], trade.symbol, trade.expiry.replace("-", ""))
                        for trade in plain.trades if trade.exit_reason == "end" and trade.exit_date == "2026-11-11")
    assert open_today == sorted((item["sleeveKey"], item["symbol"], item["expiry"])
                                for item in mid_month["candidates"])
    assert len(open_today) == 4


def test_on_the_roll_day_the_held_spreads_say_when_the_model_closes_them(roll_day):
    assert _picked(roll_day, gl.MODEL_HOLDS) == [
        ("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD"), ("vol-premium", "SPY")]
    closing = "The model closes this position at the close of 2026-12-01 (exit signal at the 2026-11-30 close)."
    for sleeve, symbol in (("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD")):
        held = _one(roll_day, gl.MODEL_HOLDS, sleeve, symbol)
        assert held["expiry"] == "20261218" and closing in held["signalFacts"]
        assert "Model entry date 2026-11-02; its signal is the close of 2026-10-30." in held["signalFacts"]
    assert closing not in _one(roll_day, gl.MODEL_HOLDS, "vol-premium", "SPY")["signalFacts"]
    # Signal-today candidates first, then the held ones; in each group the plan's sleeve order.
    assert [item["entryBasis"] for item in roll_day["candidates"]] == [gl.SIGNAL_TODAY] * 3 + [gl.MODEL_HOLDS] * 4


def test_an_entry_made_on_the_last_data_day_is_held_by_the_model(tmp_path):
    # Tuesday 2026-11-03 from data through Monday 2026-11-02, the roll day itself. The data alone has no
    # bar after that entry, so the book cannot price it; with the pending days it is an open model trade.
    document = _generate("2026-11-02", "2026-11-03", tmp_path)
    assert _picked(document, gl.SIGNAL_TODAY) == []
    assert _picked(document, gl.MODEL_HOLDS) == [
        ("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD"), ("vol-premium", "SPY")]
    assert all("Model entry date 2026-11-02; its signal is the close of 2026-10-30." in item["signalFacts"]
               for item in document["candidates"])
    data, facts, plan = _dataset("2026-11-02"), _facts(), _plan()
    made = {sleeve["key"]: gl.build_definition(sleeve, qi.family(facts), facts) for sleeve in plan["sleeves"]}
    assert not [trade for trade in gl.model_trades(made, data, plan).trades if trade.entry_date == "2026-11-02"]


def test_a_model_trade_that_expires_on_the_trading_day_is_no_candidate(tmp_path):
    # Friday 2026-12-18: the put credit spread of November expires today. The contract refuses a whole batch
    # for one expiry on or before the trading day, so it is left out and the other candidates stay.
    before = _generate("2026-12-16", "2026-12-17", tmp_path)
    assert ("vol-premium", "SPY", "20261218") in [(item["sleeveKey"], item["symbol"], item["expiry"])
                                                   for item in before["candidates"]]
    document = _generate("2026-12-17", "2026-12-18", tmp_path)
    assert_collect_input(document)
    assert _picked(document, gl.MODEL_HOLDS) == [("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD")]
    assert all(item["expiry"] > "20261218" for item in document["candidates"])
    # The model itself still holds the spread until that close.
    plan = _plan()
    pending = gl.with_pending_days(_dataset("2026-12-17"), gl.pending_days(_dataset("2026-12-17").calendar, "2026-12-18"))
    trades = gl.model_trades(_made(plan), pending, plan).trades
    assert [(trade.symbol, trade.exit_date, trade.exit_reason) for trade in trades
            if trade.expiry == "2026-12-18" and trade.structure == "putCreditVertical"] == [("SPY", "2026-12-18", "expiry")]


def test_every_candidate_states_the_date_of_the_volatility_and_the_rate_that_set_its_strikes(tmp_path, roll_day, mid_month):
    for document in (roll_day, mid_month):
        for item in document["candidates"]:
            assert sum(fact.startswith("Strike inputs: ") for fact in item["signalFacts"]) == 1
    # An entry of today: both values are of the last data day (check_series refuses any other).
    assert ("Strike inputs: VXN 18.00 of 2026-11-30 (implied volatility), IRX 4.00 of 2026-11-30 (rate)."
            in _one(roll_day, gl.SIGNAL_TODAY, "long-index", "QQQ")["signalFacts"])
    # A held spread: the values of its entry day, not of today.
    assert ("Strike inputs: VIX 18.00 of 2026-11-02 (implied volatility), IRX 4.00 of 2026-11-02 (rate)."
            in _one(mid_month, gl.MODEL_HOLDS, "vol-premium", "SPY")["signalFacts"])
    # VXN had no print on the entry day 2026-11-02: the book carried the value of 2026-10-30, and the fact says so.
    data = _dataset("2026-11-11")
    vxn = {**{day: value for day, value in data.series["VXN"].items() if day != "2026-11-02"}, "2026-10-30": 19.5}
    gapped = pf.Dataset(data.bars, {**data.series, "VXN": vxn})
    carried = gl.generate(_plan(), gapped, _facts(), tmp_path, "2026-11-12", NOW)
    held = _one(carried, gl.MODEL_HOLDS, "long-index", "QQQ")
    assert ("Strike inputs: VXN 19.50 of 2026-10-30 (implied volatility), IRX 4.00 of 2026-11-02 (rate)."
            in held["signalFacts"])
    usual = _one(mid_month, gl.MODEL_HOLDS, "long-index", "QQQ")
    # The higher volatility was used: one sigma is wider.
    assert held["shortStrike"] - held["longStrike"] > usual["shortStrike"] - usual["longStrike"]


def test_every_gate_value_in_the_facts_has_its_date(tmp_path, roll_day, mid_month):
    gated = _generate("2026-08-31", "2026-09-01", tmp_path)
    lines = [fact for document in (roll_day, mid_month, gated) for item in document["candidates"]
             for fact in item["signalFacts"] if "(gate:" in fact or fact.startswith("Entry condition")]
    assert len(lines) >= 15 and all(re.search(r" on \d{4}-\d{2}-\d{2}[ .]", line) for line in lines)


def test_strike_inputs_that_are_not_the_ones_the_book_reads_are_refused():
    plan, data = _plan(), _dataset("2026-11-11")
    trade = next(trade for trade in gl.model_trades(_made(plan), data, plan).trades
                 if (trade.symbol, trade.entry_date, trade.structure) == ("QQQ", "2026-11-02", "callDebitVertical"))
    assert gl.strike_input_facts(trade, data) == [
        "Strike inputs: VXN 18.00 of 2026-11-02 (implied volatility), IRX 4.00 of 2026-11-02 (rate)."]
    # A bar that is not the entry date of the trade (another data set than the one it was priced on).
    with pytest.raises(gl.GoLiveError, match="QQQ entry 2026-11-02: the VXN and IRX values dated 2026-11-02 and "
                                             "2026-11-02 are not the ones the options book reads on that bar"):
        gl.strike_input_facts(dataclasses.replace(trade, entry_index=trade.entry_index - 1), data)
    # A print too old to be carried: the book has no value on the entry bar, so none is named.
    old = _gap(data, data.calendar[data.calendar.index("2026-11-02") - 6], "VXN")
    with pytest.raises(gl.GoLiveError, match="are not the ones the options book reads on that bar"):
        gl.strike_input_facts(trade, old)


def test_the_plan_caps_decide_which_model_trades_exist(tmp_path):
    limits = {"maxPositions": 1, "nameRiskCapPct": 2, "openRiskCapPct": 4, "positionRiskPct": 1}
    document = _generate("2026-11-11", "2026-11-12", tmp_path, _plan(limits=limits))
    assert len(document["candidates"]) == 1
    # The sleeve budget is a cap too: 1% holds one index vertical, not two.
    small = _plan(sleeves=[_sleeve("long-index", budgetPct=1), _sleeve("rotation"), _sleeve("vol-premium")])
    assert _picked(_generate("2026-11-11", "2026-11-12", tmp_path, small), gl.MODEL_HOLDS) == [
        ("long-index", "SPY"), ("rotation", "GLD"), ("vol-premium", "SPY")]


def test_a_plan_that_states_untested_terms_gives_no_document(tmp_path):
    plan = _plan(sleeves=[_sleeve("vol-premium", dteTarget=30)])
    with pytest.raises(gl.GoLiveError, match=r"dteTarget 30 \(tested: 45\)"):
        _generate("2026-11-11", "2026-11-12", tmp_path, plan)


def test_zero_candidates_is_a_valid_document(tmp_path):
    # 2025-07-02: the second day of the data. No sleeve has a trade yet.
    document = _generate(FIRST_DAY, "2025-07-02", tmp_path)
    assert_collect_input(document)
    assert document["candidates"] == [] and document["tradingDay"] == "2025-07-02"


# --------------------------------------------------------------------------- entry filters

def test_filter_facts_give_each_gate_value_with_its_date():
    closes = {day: 100.0 + number for number, day in enumerate(trading_days("2026-01-02", 30))}
    day = max(closes)
    series = {"VIX": {day: 19.456, "2026-01-02": 30.0}, "VIX3M": {day: 20.0}, "SPY": closes,
              "GVZ": {"2026-02-10": 17.5, day: 16.25}}
    gate = {"type": "volRegime", "maxVix": 25, "maxTermRatio": 1.0, "trendLength": 20}
    assert gl.filter_facts(gate, "SPY", day, series) == [
        f"VIX 19.46 on {day} (gate: at most 25).",
        f"VIX/VIX3M ratio 0.973 on {day} (gate: at most 1).",
        f"SPY close 129.00, its 20-day average 119.50 on {day} (gate: close above the average).",
    ]
    assert gl.filter_facts(qi.GATES["vixTermStructure"], "SPY", day, series) == [
        f"VIX/VIX3M ratio 0.973 on {day} (gate: at most 1)."]
    assert gl.filter_facts(qi.IV_LIVE, "GLD", day, series) == [f"GVZ 16.25 on {day} (gate: > 0)."]
    assert gl.filter_facts({"type": "calendarWindow", "window": "opexWeek"}, "SPY", day, series) == [
        f"Filter calendarWindow: passed on {day}."]


def test_filter_facts_say_no_value_instead_of_a_number_they_do_not_have():
    series = {"VIX": {"2026-02-10": 19.0}, "VIX3M": {"2026-02-10": 0.0}, "SPY": {"2026-02-10": 500.0}}
    gate = {"type": "volRegime", "maxVix": 25, "maxTermRatio": 1.0, "trendLength": 200}
    assert gl.filter_facts(gate, "SPY", "2026-02-10", series) == [
        "VIX 19.00 on 2026-02-10 (gate: at most 25).",
        "VIX/VIX3M ratio no value on 2026-02-10 (gate: at most 1).",
        "SPY close 500.00, its 200-day average no value on 2026-02-10 (gate: close above the average).",
    ]
    # The gates read the value of the signal day itself: a value of another day is not shown as that day's.
    assert gl.filter_facts(gate, "SPY", "2026-02-11", {})[0] == "VIX no value on 2026-02-11 (gate: at most 25)."
    # A series filter carries the latest value and shows the day it is from.
    assert gl.filter_facts(qi.IV_LIVE, "SPY", "2026-02-12", series) == ["VIX 19 on 2026-02-10 (gate: > 0)."]
    assert gl.filter_facts(qi.IV_LIVE, "SPY", "2026-02-09", series) == ["VIX no value on 2026-02-09 (gate: > 0)."]


def test_the_iv_rank_fact_is_the_rank_signals_py_computes():
    days = trading_days("2026-01-02", 10)
    values = [10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 18.0, 16.0, 14.0, 15.0]
    series = {"VXN": dict(zip(days, values))}
    gate = {"type": "ivRank", "length": 5, "min": 50}
    # The last five values run from 14 to 20; 15 is one sixth of the way up.
    assert gl.filter_facts(gate, "QQQ", days[-1], series) == [
        f"IV rank of VXN over 5 days: 16.7 on {days[-1]} (gate: at least 50)."]
    assert gl.filter_facts(gate, "QQQ", days[2], series) == [
        f"IV rank of VXN over 5 days: no value on {days[2]} (gate: at least 50)."]
    assert gl.filter_facts(gate, "QQQ", "2025-12-31", series) == [
        "IV rank of VXN over 5 days: no value on 2025-12-31 (gate: at least 50)."]


# --------------------------------------------------------------------------- strikes and quotes

HEADER = "contractSymbol,lastTradeDate,strike,lastPrice,bid,ask,change,percentChange,volume,openInterest," \
         "impliedVolatility,inTheMoney,contractSize,currency"


def _run(store, day: str, clock: str, symbols=("SPY",), fetched: str | None = None, summary: str | None = None,
         errors: dict | None = None):
    """One stored snapshot run: <store>/<New York day>/<HHMMSS>Z/summary.json, as snapshot.py writes it.
    `errors`: symbol -> what the run reports for it (snapshot.py lists a failed symbol in `symbols` too)."""
    run = store / day / f"{clock}Z"
    run.mkdir(parents=True)
    stamp = fetched or f"{day}T{clock[:2]}:{clock[2:4]}:{clock[4:]}+00:00"
    (run / "summary.json").write_text(summary if summary is not None else json.dumps(
        {"schema": 2, "day": day, "fetchedAt": stamp, "complete": not errors, "errors": errors or {},
         "symbols": {symbol: [] for symbol in symbols}}))
    return run


def _chain(run, symbol: str, expiry: str, side: str, quotes: dict) -> None:
    """One chain file of a run: strike -> (bid, ask), in the columns yfinance writes."""
    lines = [HEADER, *(f"{symbol}X,2026-11-30 20:10:00+00:00,{strike},1.0,{bid},{ask},0.0,0.0,1.0,10,0.2,False,REGULAR,USD"
                       for strike, (bid, ask) in quotes.items())]
    (run / f"{symbol}-{expiry}-{side}.csv").write_text("\n".join(lines) + "\n")


def _trade(structure="callDebitVertical", long_strike=756.0, short_strike=807.0, symbol="SPY",
           expiry="2026-12-18") -> al.PricedTrade:
    return al.PricedTrade(
        trade_id=1, symbol=symbol, structure=structure, expiry=expiry, long_strike=long_strike,
        short_strike=short_strike, width=abs(short_strike - long_strike), entry_index=1, exit_index=2,
        entry_date="2026-11-02", exit_date="2026-11-30", entry_price=200.0, exit_price=300.0, entry_fee=2.0,
        exit_fee=2.0, max_loss=204.0, max_loss_pct=1.0, premium=2.0, exit_reason="end", marks=())


def _priced(store, trade=None, now: datetime = NOW, oldest_day: str = "2026-11-27"):
    return gl.price_candidate(trade or _trade(), gl.snapshots(store, now), oldest_day)


def test_listed_strikes_get_the_bid_and_ask_of_the_snapshot_with_its_source_and_time(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2026-12-18", "calls", {755.0: (18.4, 18.6), 756.0: (17.63, 17.78), 807.0: (0.76, 0.78)})
    _chain(run, "SPY", "2026-12-18", "puts", {756.0: (9.0, 9.1), 807.0: (50.0, 50.5)})
    assert _priced(tmp_path) == (756.0, 807.0, {
        "asOf": "2026-11-30T20:30:00Z", "longAsk": 17.78, "longBid": 17.63, "shortAsk": 0.78, "shortBid": 0.76,
        "source": "yahoo_delayed_snapshot"}, [
        "Long leg: model strike 756 -> listed 756.",
        "Short leg: model strike 807 -> listed 807.",
        "Quote: Yahoo chain snapshot of 2026-11-30T20:30:00Z, delayed, not a live quote.",
    ])
    assert gl.QUOTE_SOURCE == "yahoo_delayed_snapshot"  # never ibkr_live: the store holds delayed Yahoo quotes
    # A put structure reads the puts file of the same expiry.
    put = _priced(tmp_path, _trade("putCreditVertical", long_strike=756.0, short_strike=807.0))
    assert (put[2]["longBid"], put[2]["longAsk"], put[2]["shortBid"], put[2]["shortAsk"]) == (9.0, 9.1, 50.0, 50.5)


def test_a_model_strike_moves_to_the_nearest_listed_strike_within_one_step(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2026-12-18", "puts", {685.0: (1.9, 2.0), 690.0: (2.16, 2.17), 692.0: (2.3, 2.4),
                                              716.0: (3.83, 3.86), 720.0: (4.2, 4.3)})
    long_strike, short_strike, quote, facts = _priced(tmp_path, _trade("putCreditVertical", 691.0, 716.0))
    # 690 and 692 are both one step from 691: the lower one.
    assert (long_strike, short_strike) == (690.0, 716.0)
    assert (quote["longBid"], quote["longAsk"], quote["shortBid"], quote["shortAsk"]) == (2.16, 2.17, 3.83, 3.86)
    assert facts[:2] == ["Long leg: model strike 691 -> listed 690.", "Short leg: model strike 716 -> listed 716."]


def test_a_strike_that_is_not_listed_within_one_step_keeps_the_model_strikes_without_a_quote(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2026-12-18", "calls", {755.0: (18.4, 18.6), 756.0: (17.63, 17.78), 805.0: (0.9, 1.0),
                                               810.0: (0.6, 0.7)})
    assert _priced(tmp_path) == (756.0, 807.0, None, [
        "Long leg: model strike 756 -> listed 756.",
        "Short leg: model strike 807 -> not listed within 1 (nearest listed 805).",
        "Model strikes kept, no quote (chain snapshot of 2026-11-30T20:30:00Z).",
    ])
    # Below 25 the strike grid of the model is 0.5 wide.
    low = _run(tmp_path, "2026-11-30", "204000", symbols=("SLV",))
    _chain(low, "SLV", "2026-12-18", "calls", {20.0: (1.0, 1.1), 22.5: (0.4, 0.5), 23.0: (0.3, 0.4)})
    assert _priced(tmp_path, _trade(long_strike=20.5, short_strike=23.0, symbol="SLV"))[:3] == (20.0, 23.0, {
        "asOf": "2026-11-30T20:40:00Z", "longAsk": 1.1, "longBid": 1.0, "shortAsk": 0.4, "shortBid": 0.3,
        "source": "yahoo_delayed_snapshot"})
    assert _priced(tmp_path, _trade(long_strike=21.0, short_strike=23.0, symbol="SLV"))[:3] == (21.0, 23.0, None)


def test_an_expiry_that_is_not_in_the_snapshot_keeps_the_model_strikes_without_a_quote(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2026-12-18", "calls", {756.0: (17.63, 17.78), 807.0: (0.76, 0.78)})
    assert _priced(tmp_path, _trade(expiry="2027-01-15")) == (756.0, 807.0, None, [
        "Expiry 2027-01-15 of SPY is not in the chain snapshot of 2026-11-30T20:30:00Z: model strikes kept, no quote."])
    # A chain file without a row is no chain.
    (run / "SPY-2027-01-15-calls.csv").write_text(HEADER + "\n")
    assert _priced(tmp_path, _trade(expiry="2027-01-15"))[2] is None


def test_two_legs_on_one_listed_strike_keep_the_model_strikes_without_a_quote(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2026-12-18", "calls", {756.0: (17.63, 17.78), 800.0: (1.0, 1.1)})
    assert _priced(tmp_path, _trade(long_strike=756.0, short_strike=757.0)) == (756.0, 757.0, None, [
        "Long leg: model strike 756 -> listed 756.",
        "Short leg: model strike 757 -> listed 756.",
        "Model strikes kept, no quote (chain snapshot of 2026-11-30T20:30:00Z).",
    ])


@pytest.mark.parametrize("short_quote", [("", ""), ("0.0", "0.0"), ("0.8", "0.7"), ("-0.1", "0.2"), ("nan", "0.5"),
                                         ("0.5", "inf"), ("x", "0.5")])
def test_a_listed_leg_without_a_usable_bid_and_ask_gives_no_quote(tmp_path, short_quote):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2026-12-18", "calls", {756.0: (17.63, 17.78), 807.0: short_quote})
    assert _priced(tmp_path) == (756.0, 807.0, None, [
        "Long leg: model strike 756 -> listed 756.",
        "Short leg: model strike 807 -> listed 807.",
        "No usable bid and ask for both legs in the chain snapshot of 2026-11-30T20:30:00Z: no quote.",
    ])


def test_a_zero_bid_with_an_ask_is_a_quote(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2026-12-18", "calls", {756.0: (17.63, 17.78), 807.0: (0.0, 0.01), 0.0: (1.0, 2.0)})
    quote = _priced(tmp_path)[2]
    assert (quote["shortBid"], quote["shortAsk"]) == (0.0, 0.01)
    assert 0.0 not in gl.chain_quotes(gl.snapshots(tmp_path, NOW)[0], "SPY", "2026-12-18", "call")


def test_the_quote_comes_from_the_newest_snapshot_at_or_before_now(tmp_path):
    for day, clock, bid in (("2026-11-27", "173000", 15.0), ("2026-11-30", "173000", 16.0),
                            ("2026-11-30", "203000", 17.0), ("2026-12-01", "173000", 18.0)):
        _chain(_run(tmp_path, day, clock), "SPY", "2026-12-18", "calls", {756.0: (bid, bid + 0.1), 807.0: (0.7, 0.8)})
    assert [run.stamp for run in gl.snapshots(tmp_path, NOW)] == [
        "2026-11-30T20:30:00Z", "2026-11-30T17:30:00Z", "2026-11-27T17:30:00Z"]
    assert _priced(tmp_path)[2]["asOf"] == "2026-11-30T20:30:00Z" and _priced(tmp_path)[2]["longBid"] == 17.0
    # The run of exactly `now` counts; one second earlier it does not.
    at = datetime(2026, 12, 1, 17, 30, tzinfo=UTC)
    assert _priced(tmp_path, now=at)[2]["longBid"] == 18.0
    assert _priced(tmp_path, now=datetime(2026, 12, 1, 17, 29, 59, tzinfo=UTC))[2]["longBid"] == 17.0
    assert _priced(tmp_path, now=datetime(2026, 11, 27, 17, 0, tzinfo=UTC)) == (756.0, 807.0, None, [
        "No chain snapshot of SPY to read: model strikes kept, no quote."])


def test_runs_that_cannot_be_read_or_have_not_reached_the_symbol_are_passed_over(tmp_path):
    good = _run(tmp_path, "2026-11-30", "173000", symbols=("SPY", "QQQ"))
    _chain(good, "SPY", "2026-12-18", "calls", {756.0: (16.0, 16.1), 807.0: (0.7, 0.8)})
    # A later run that is still writing: it has finished QQQ only. Its SPY file is not complete yet.
    running = _run(tmp_path, "2026-11-30", "203000", symbols=("QQQ",))
    _chain(running, "SPY", "2026-12-18", "calls", {756.0: (99.0, 99.1)})
    _run(tmp_path, "2026-11-30", "203100", summary="{not json")
    _run(tmp_path, "2026-11-30", "203200", summary=json.dumps({"schema": 2, "symbols": {"SPY": []}}))
    _run(tmp_path, "2026-11-30", "203300", summary=json.dumps({"fetchedAt": "yesterday", "symbols": {"SPY": []}}))
    _run(tmp_path, "2026-11-30", "203400", summary=json.dumps({"fetchedAt": "2026-11-30T20:34:00+00:00", "symbols": 7}))
    (tmp_path / "2026-11-30" / "203500Z").mkdir()  # a run that has written no summary yet
    assert [run.stamp for run in gl.snapshots(tmp_path, NOW)] == ["2026-11-30T20:30:00Z", "2026-11-30T17:30:00Z"]
    assert _priced(tmp_path)[2]["asOf"] == "2026-11-30T17:30:00Z"


def test_a_fetch_time_without_an_offset_is_utc_and_the_new_york_day_folder_is_not_the_clock(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000", fetched="2026-11-30T15:30:00-05:00")
    _chain(run, "SPY", "2026-12-18", "calls", {756.0: (17.0, 17.1), 807.0: (0.7, 0.8)})
    assert _priced(tmp_path)[2]["asOf"] == "2026-11-30T20:30:00Z"
    _run(tmp_path, "2026-11-30", "210000", fetched="2026-11-30T21:00:00")
    assert gl.snapshots(tmp_path, NOW)[0].stamp == "2026-11-30T21:00:00Z"


SPY_CALLS = {756.0: (17.63, 17.78), 807.0: (0.76, 0.78)}
NO_YAHOO = "RuntimeError: Yahoo listed no monthly expiry"
needs_file_modes = pytest.mark.skipif(os.geteuid() == 0, reason="root reads a file whatever its mode")


def test_a_snapshot_older_than_the_trading_day_before_the_trading_day_gives_no_quote(tmp_path):
    assert gl.MAX_AGE_TRADING_DAYS == 1  # the same rule as the bars: nothing older than the trading day before
    _chain(_run(tmp_path, "2026-11-27", "203000"), "SPY", "2026-12-18", "calls", SPY_CALLS)
    assert gl.snapshots(tmp_path, NOW)[0].day == "2026-11-27"
    assert _priced(tmp_path, oldest_day="2026-11-30") == (756.0, 807.0, None, [
        "The newest chain snapshot of SPY is of 2026-11-27 (2026-11-27T20:30:00Z), older than 2026-11-30, the oldest "
        "day a quote may come from: model strikes kept, no quote."])
    assert _priced(tmp_path, oldest_day="2026-11-27")[2]["asOf"] == "2026-11-27T20:30:00Z"
    # The day of a snapshot is the New York day of its fetch: 01:00 UTC on Monday is Sunday evening there.
    _chain(_run(tmp_path, "2026-11-29", "010000", fetched="2026-11-30T01:00:00+00:00"), "SPY", "2026-12-18", "calls",
           SPY_CALLS)
    assert gl.snapshots(tmp_path, NOW)[0].day == "2026-11-29"
    assert _priced(tmp_path, oldest_day="2026-11-30")[2] is None
    # A snapshot of the day itself, whatever its hour.
    _chain(_run(tmp_path, "2026-11-30", "144500"), "SPY", "2026-12-18", "calls", SPY_CALLS)
    assert _priced(tmp_path, oldest_day="2026-11-30")[2]["asOf"] == "2026-11-30T14:45:00Z"


def test_the_run_reads_no_snapshot_older_than_its_last_data_day(tmp_path, roll_day):
    model = _one(roll_day, gl.MODEL_HOLDS, "vol-premium", "SPY")
    listed = {model["longStrike"] + 1: (2.0, 2.1), model["shortStrike"] + 1: (1.0, 1.2)}
    # Tuesday 2026-12-01 from data through Monday: the snapshot of Friday 2026-11-27 is one trading day too old.
    _chain(_run(tmp_path, "2026-11-27", "203000"), "SPY", "2026-12-18", "puts", listed)
    old = _one(_generate("2026-11-30", "2026-12-01", tmp_path), gl.MODEL_HOLDS, "vol-premium", "SPY")
    assert (old["quote"], old["longStrike"], old["shortStrike"]) == (None, model["longStrike"], model["shortStrike"])
    assert old["signalFacts"][-1] == (
        "The newest chain snapshot of SPY is of 2026-11-27 (2026-11-27T20:30:00Z), older than 2026-11-30, the oldest "
        "day a quote may come from: model strikes kept, no quote.")
    _chain(_run(tmp_path, "2026-11-30", "203000"), "SPY", "2026-12-18", "puts", listed)
    fresh = _one(_generate("2026-11-30", "2026-12-01", tmp_path), gl.MODEL_HOLDS, "vol-premium", "SPY")
    assert fresh["quote"]["asOf"] == "2026-11-30T20:30:00Z" and fresh["longStrike"] == model["longStrike"] + 1


def test_a_newer_run_whose_fetch_failed_does_not_hide_an_older_good_one(tmp_path):
    _chain(_run(tmp_path, "2026-11-30", "173000"), "SPY", "2026-12-18", "calls", SPY_CALLS)
    failed = _run(tmp_path, "2026-11-30", "203000", errors={"SPY": NO_YAHOO})  # SPY is in `symbols`, no chain file
    newest = gl.snapshots(tmp_path, NOW)[0]
    assert (newest.path, "SPY" in newest.symbols, newest.errors, gl.has_chains(newest, "SPY")) == (
        failed, True, {"SPY": NO_YAHOO}, False)
    long_strike, short_strike, quote, facts = _priced(tmp_path)
    assert (long_strike, short_strike, quote["asOf"], quote["longBid"]) == (756.0, 807.0, "2026-11-30T17:30:00Z", 17.63)
    assert facts == [
        f"The SPY chain fetch failed in the newest snapshot of 2026-11-30T20:30:00Z ({NO_YAHOO}); the snapshot of "
        "2026-11-30T17:30:00Z is read instead.",
        "Long leg: model strike 756 -> listed 756.",
        "Short leg: model strike 807 -> listed 807.",
        "Quote: Yahoo chain snapshot of 2026-11-30T17:30:00Z, delayed, not a live quote.",
    ]


def test_a_failed_fetch_is_named_as_a_failed_fetch(tmp_path):
    # The only good run is older than the freshness rule allows, so there is no quote: the fact says the fetch
    # failed, not that the expiry is missing from the chain.
    _chain(_run(tmp_path, "2026-11-27", "203000"), "SPY", "2026-12-18", "calls", SPY_CALLS)
    _run(tmp_path, "2026-11-30", "173000", errors={"SPY": NO_YAHOO})
    assert _priced(tmp_path, oldest_day="2026-11-30") == (756.0, 807.0, None, [
        f"The SPY chain fetch failed in the newest snapshot of 2026-11-30T17:30:00Z ({NO_YAHOO}): model strikes kept, "
        "no quote."])
    # A run that lists the symbol without a chain file and without a report, and a report too long for a fact line.
    _run(tmp_path, "2026-11-30", "203000")
    assert _priced(tmp_path, oldest_day="2026-11-30")[3] == [
        "The SPY chain fetch failed in the newest snapshot of 2026-11-30T20:30:00Z: model strikes kept, no quote."]
    _run(tmp_path, "2026-11-30", "204500", errors={"SPY": "HTTPError: 429\n" + "x" * 500})
    fact, = _priced(tmp_path, oldest_day="2026-11-30")[3]
    assert fact.startswith("The SPY chain fetch failed in the newest snapshot of 2026-11-30T20:45:00Z (HTTPError: 429 x")
    assert len(fact) <= gl.FACT_MAX_CHARS and "\n" not in fact


def test_a_run_that_reports_a_problem_but_stored_the_chains_is_read(tmp_path):
    report = "1 of 2 expiries without usable quotes"
    _chain(_run(tmp_path, "2026-11-30", "203000", errors={"SPY": report}), "SPY", "2026-12-18", "calls", SPY_CALLS)
    assert _priced(tmp_path)[2]["asOf"] == "2026-11-30T20:30:00Z"
    assert _priced(tmp_path, _trade(expiry="2027-01-15")) == (756.0, 807.0, None, [
        f"Expiry 2027-01-15 of SPY is not in the chain snapshot of 2026-11-30T20:30:00Z ({report}): model strikes "
        "kept, no quote."])
    (tmp_path / "2026-11-30" / "203000Z" / "SPY-2027-01-15-calls.csv").write_text(HEADER + "\n")
    assert _priced(tmp_path, _trade(expiry="2027-01-15"))[3] == [
        f"Expiry 2027-01-15 of SPY has no strike in the chain snapshot of 2026-11-30T20:30:00Z ({report}): model "
        "strikes kept, no quote."]


def test_a_chain_store_that_does_not_exist_refuses_the_run(tmp_path):
    with pytest.raises(gl.ChainStoreError, match="The chain store cannot be read .*missing: No such file or directory"):
        gl.snapshots(tmp_path / "missing", NOW)
    (tmp_path / "file").write_text("not a store")
    with pytest.raises(gl.ChainStoreError, match="The chain store cannot be read .*file: Not a directory"):
        gl.snapshots(tmp_path / "file", NOW)
    assert issubclass(gl.ChainStoreError, gl.GoLiveError)
    # Also on a day without a candidate: the document would not show that the quotes could not be read.
    with pytest.raises(gl.ChainStoreError):
        _generate(FIRST_DAY, "2025-07-02", tmp_path / "missing")
    with pytest.raises(gl.ChainStoreError):
        _generate("2026-11-30", "2026-12-01", tmp_path / "missing")
    assert gl.snapshots(tmp_path, NOW) == []  # an empty store is a store: no snapshot yet


@needs_file_modes
@pytest.mark.parametrize("locked", ["store", "day", "run", "summary", "chain"])
def test_a_chain_store_that_cannot_be_read_refuses_the_run(tmp_path, roll_day, locked):
    # Strikes are part of the draft id: with a store that cannot be read the candidates would fall back to their
    # model strikes, and the server would expire the proposed drafts and replace them.
    store = tmp_path / "store"
    run = _run(store, "2026-11-30", "203000")
    model = _one(roll_day, gl.MODEL_HOLDS, "long-index", "SPY")
    _chain(run, "SPY", "2026-12-18", "calls", {model["longStrike"] + 1: (2.0, 2.1), model["shortStrike"] + 1: (1.0, 1.2)})
    held = _one(_generate("2026-11-30", "2026-12-01", store), gl.MODEL_HOLDS, "long-index", "SPY")
    assert (held["longStrike"], held["shortStrike"]) == (model["longStrike"] + 1, model["shortStrike"] + 1)
    path = {"store": store, "day": run.parent, "run": run, "summary": run / "summary.json",
            "chain": run / "SPY-2026-12-18-calls.csv"}[locked]
    mode = path.stat().st_mode
    path.chmod(0)
    try:
        with pytest.raises(gl.ChainStoreError, match="cannot be read"):
            _generate("2026-11-30", "2026-12-01", store)
    finally:
        path.chmod(mode)
    assert _generate("2026-11-30", "2026-12-01", store)["candidates"][3:] != []


def test_a_chain_file_that_is_not_text_refuses_the_run(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    (run / "SPY-2026-12-18-calls.csv").write_bytes(b"strike,bid,ask\n\xff\xfe,1,2\n")
    with pytest.raises(gl.ChainStoreError, match="SPY-2026-12-18-calls.csv cannot be read"):
        _priced(tmp_path)


def test_a_failed_fetch_in_a_newer_run_leaves_the_strikes_of_the_candidates_as_they_were(tmp_path, roll_day):
    good = _run(tmp_path, "2026-11-30", "173000", symbols=qi.CORE7)
    for item in roll_day["candidates"]:
        side = "calls" if item["structure"].startswith("call") else "puts"
        expiry = f"{item['expiry'][:4]}-{item['expiry'][4:6]}-{item['expiry'][6:]}"
        _chain(good, item["symbol"], expiry, side,
               {item["longStrike"] + 1: (2.0, 2.1), item["shortStrike"] + 1: (1.0, 1.2)})
    before = _generate("2026-11-30", "2026-12-01", tmp_path)
    _run(tmp_path, "2026-11-30", "203000", symbols=qi.CORE7, errors=dict.fromkeys(qi.CORE7, NO_YAHOO))
    after = _generate("2026-11-30", "2026-12-01", tmp_path)
    identity = [(item["sleeveKey"], item["symbol"], item["structure"], item["expiry"], item["longStrike"],
                 item["shortStrike"]) for item in before["candidates"]]  # the fields of the draft id
    assert identity == [(item["sleeveKey"], item["symbol"], item["structure"], item["expiry"], item["longStrike"],
                         item["shortStrike"]) for item in after["candidates"]]
    assert all(item["longStrike"] == model["longStrike"] + 1
               for item, model in zip(after["candidates"], roll_day["candidates"]))
    assert all(item["quote"]["asOf"] == "2026-11-30T17:30:00Z" for item in after["candidates"])
    assert all(any(fact.startswith(f"The {item['symbol']} chain fetch failed in the newest snapshot of "
                                   "2026-11-30T20:30:00Z") for fact in item["signalFacts"]) for item in after["candidates"])
    assert_collect_input(after)


def test_the_candidates_carry_the_listed_strikes_and_the_snapshot_quote(tmp_path, roll_day):
    run = _run(tmp_path, "2026-11-30", "203000", symbols=qi.CORE7)
    for item in roll_day["candidates"]:
        side = "calls" if item["structure"].startswith("call") else "puts"
        expiry = f"{item['expiry'][:4]}-{item['expiry'][4:6]}-{item['expiry'][6:]}"
        if (item["sleeveKey"], item["entryBasis"]) == ("rotation", gl.SIGNAL_TODAY):
            continue  # this expiry is not stored
        # Listed one dollar above each model strike, so every leg moves by one step.
        _chain(run, item["symbol"], expiry, side, {item["longStrike"] + 1: (2.0, 2.1), item["shortStrike"] + 1: (1.0, 1.2)})
    document = _generate("2026-11-30", "2026-12-01", tmp_path)
    assert_collect_input(document)
    assert len(document["candidates"]) == len(roll_day["candidates"]) == 7
    for item, model in zip(document["candidates"], roll_day["candidates"]):
        assert (item["entryBasis"], item["sleeveKey"], item["symbol"], item["expiry"]) == (
            model["entryBasis"], model["sleeveKey"], model["symbol"], model["expiry"])
        if (item["sleeveKey"], item["entryBasis"]) == ("rotation", gl.SIGNAL_TODAY):
            assert item["quote"] is None
            assert (item["longStrike"], item["shortStrike"]) == (model["longStrike"], model["shortStrike"])
            assert item["signalFacts"][-1] == ("Expiry 2027-01-15 of GLD is not in the chain snapshot of "
                                               "2026-11-30T20:30:00Z: model strikes kept, no quote.")
            continue
        assert item["quote"] == {"asOf": "2026-11-30T20:30:00Z", "longAsk": 2.1, "longBid": 2.0, "shortAsk": 1.2,
                                 "shortBid": 1.0, "source": "yahoo_delayed_snapshot"}
        assert (item["longStrike"], item["shortStrike"]) == (model["longStrike"] + 1, model["shortStrike"] + 1)
        assert item["signalFacts"][-3:] == [
            f"Long leg: model strike {model['longStrike']:g} -> listed {item['longStrike']:g}.",
            f"Short leg: model strike {model['shortStrike']:g} -> listed {item['shortStrike']:g}.",
            "Quote: Yahoo chain snapshot of 2026-11-30T20:30:00Z, delayed, not a live quote.",
        ]
    assert all(item["quote"] is None and item["signalFacts"][-1].startswith("No chain snapshot of")
               for item in roll_day["candidates"])


def test_facts_over_the_contract_limit_are_an_error_not_a_cut(tmp_path, monkeypatch):
    monkeypatch.setattr(gl, "FACTS_MAX", 5)
    with pytest.raises(gl.GoLiveError, match="the facts pass the limit of 5 lines of 200 characters"):
        _generate("2026-11-11", "2026-11-12", tmp_path)


# --------------------------------------------------------------------------- output rules

def _safe(**changes) -> dict:
    return {"entryBasis": "signal_today", "expiry": "20270115", "longStrike": 756.0, "quote": None, "shortStrike": 807.0,
            "signalFacts": [], "sleeveKey": "long-index", "structure": "callDebitVertical", "symbol": "SPY", **changes}


def _quote(**changes) -> dict:
    return {"asOf": "2026-11-30T20:30:00Z", "longAsk": 17.78, "longBid": 17.63, "shortAsk": 0.78, "shortBid": 0.76,
            "source": "yahoo_delayed_snapshot", **changes}


def test_a_candidate_of_each_structure_passes_the_output_rules_the_right_way_round():
    assert set(gl.LONG_STRIKE_IS_LOWER) == set(BOOK_STRUCTURES) == STRUCTURES
    gl.check_candidate(_safe(quote=_quote()), "2026-12-01")
    for structure, long_strike, short_strike in (("callDebitVertical", 756.0, 807.0), ("putCreditVertical", 691.0, 716.0),
                                                 ("putDebitVertical", 716.0, 691.0), ("callCreditVertical", 807.0, 756.0)):
        gl.check_candidate(_safe(structure=structure, longStrike=long_strike, shortStrike=short_strike), "2026-12-01")
        with pytest.raises(gl.UnsafeOutputError, match=f"a {structure} has its long strike (below|above) its short strike"):
            gl.check_candidate(_safe(structure=structure, longStrike=short_strike, shortStrike=long_strike), "2026-12-01")
    assert issubclass(gl.UnsafeOutputError, gl.GoLiveError)


@pytest.mark.parametrize(("changes", "message"), [
    # A call debit vertical buys the lower strike; a put credit vertical sells the higher one.
    ({"longStrike": 807.0, "shortStrike": 756.0},
     "a callDebitVertical has its long strike below its short strike, not long 807 and short 756"),
    ({"structure": "putCreditVertical", "longStrike": 716.0, "shortStrike": 691.0},
     "a putCreditVertical has its long strike below its short strike, not long 716 and short 691"),
    ({"shortStrike": 756.0}, "both legs are on the strike 756"),
    ({"longStrike": 0.0}, "the strikes 0.0/807.0 must be numbers above 0"),
    ({"shortStrike": -5.0}, "must be numbers above 0"),
    ({"longStrike": "756"}, "must be numbers above 0"),
    ({"structure": "ironCondor"}, "unknown structure 'ironCondor'"),
    ({"expiry": "20261201"}, r"the expiry '20261201' must be a day \(YYYYMMDD\) after the trading day 2026-12-01"),
    ({"expiry": "20261130"}, "must be a day .* after the trading day 2026-12-01"),
    ({"expiry": "20270230"}, "the expiry '20270230' must be a day"),
    ({"expiry": "2027-01-15"}, "the expiry '2027-01-15' must be a day"),
    ({"longStrike": math.nan}, r"candidate\.longStrike is nan, not a finite number"),
    ({"shortStrike": math.inf}, r"candidate\.shortStrike is inf, not a finite number"),
    ({"quote": _quote(longBid=math.nan)}, r"candidate\.quote\.longBid is nan, not a finite number"),
    ({"quote": _quote(shortAsk=-math.inf)}, r"candidate\.quote\.shortAsk is -inf, not a finite number"),
    ({"quote": _quote(source="ibkr_live")}, "the quote source is 'ibkr_live'; this generator reads delayed snapshots "
                                            r"only \(yahoo_delayed_snapshot\)"),
    ({"quote": _quote(source="model")}, "the quote source is 'model'"),
    ({"quote": {key: value for key, value in _quote().items() if key != "source"}}, "the quote source is None"),
])
def test_a_candidate_that_breaks_an_output_rule_is_refused(changes, message):
    with pytest.raises(gl.UnsafeOutputError, match=f"Unsafe candidate long-index SPY: .*{message}"):
        gl.check_candidate(_safe(**changes), "2026-12-01")
    document = {"planId": "p", "planVersion": 1, "tradingDay": "2026-12-01", "generatedAt": "2026-12-01T14:00:00Z",
                "candidates": [_safe(), _safe(**changes)]}
    with pytest.raises(gl.UnsafeOutputError):
        gl.check_document(document)
    assert gl.check_document({**document, "candidates": [_safe()]})["candidates"] == [_safe()]


@pytest.mark.parametrize("priced", [
    lambda trade: (trade.short_strike, trade.long_strike, None, ["swapped"]),
    lambda trade: (trade.long_strike, trade.long_strike, None, ["one strike"]),
    lambda trade: (math.nan, trade.short_strike, None, ["no number"]),
    lambda trade: (trade.long_strike, trade.short_strike, _quote(longAsk=math.inf), ["no number in the quote"]),
    lambda trade: (trade.long_strike, trade.short_strike, _quote(source="ibkr_live"), ["a live label"]),
])
def test_a_run_with_one_unsafe_candidate_gives_no_document(tmp_path, monkeypatch, priced):
    monkeypatch.setattr(gl, "price_candidate", lambda trade, runs, oldest_day: priced(trade))
    with pytest.raises(gl.UnsafeOutputError, match="Unsafe candidate long-index QQQ: .*; no document"):
        _generate("2026-11-11", "2026-11-12", tmp_path)
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12", chains=tmp_path)
    assert (code, out) == (1, "") and err.startswith("golive: Unsafe candidate long-index QQQ: ")


def test_every_document_of_the_generator_passes_the_output_rules(roll_day, mid_month):
    for document in (roll_day, mid_month):
        assert gl.check_document(document) is document
        for item in document["candidates"]:
            assert (item["longStrike"] < item["shortStrike"]) == gl.LONG_STRIKE_IS_LOWER[item["structure"]]
            assert item["expiry"] > document["tradingDay"].replace("-", "")


# --------------------------------------------------------------------------- python -m golive

def _main(monkeypatch, tmp_path, last_day: str, trading_day: str, stdin: str | None = None, load=None, data=None,
          chains=None):
    """python -m golive on the synthetic data (`data`: another data set). `chains`: the chain store, by default
    <tmp_path>/chains, which a test makes or leaves missing."""
    def study_data(root):
        assert root == tmp_path / "data"
        return SimpleNamespace(dataset=data or _dataset(last_day), facts=_facts())

    monkeypatch.setattr(cli.study, "load_study_data", load or study_data)
    out, err = io.StringIO(), io.StringIO()
    code = cli.main(["--data", str(tmp_path / "data"), "--chain-store", str(chains or tmp_path / "chains"),
                     "--trading-day", trading_day, "--now", "2026-12-01T14:00:00"],
                    stdin=io.StringIO(json.dumps(_plan()) if stdin is None else stdin), stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


def test_main_prints_one_json_document_and_nothing_else(monkeypatch, tmp_path):
    run = _run(tmp_path / "chains", "2026-11-11", "203000")
    _chain(run, "SPY", "2026-12-18", "calls", {strike: (2.0, 2.1) for strike in range(400, 900)})
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12")
    assert (code, err) == (0, "") and out.endswith("\n") and out.count("\n") == 1
    document = json.loads(out)
    assert_collect_input(document)
    assert document["generatedAt"] == "2026-12-01T14:00:00Z"  # --now without an offset is UTC
    assert _picked(document, gl.MODEL_HOLDS) == [
        ("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD"), ("vol-premium", "SPY")]
    spy = _one(document, gl.MODEL_HOLDS, "long-index", "SPY")
    assert spy["quote"]["source"] == "yahoo_delayed_snapshot" and spy["quote"]["asOf"] == "2026-11-11T20:30:00Z"
    assert _one(document, gl.MODEL_HOLDS, "vol-premium", "SPY")["quote"] is None  # no puts file in the run


def test_main_refuses_stale_data_with_the_named_day_and_prints_nothing(monkeypatch, tmp_path):
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-10", "2026-11-12")
    assert (code, out) == (1, "")
    assert err == ("golive: The data ends on 2026-11-10. Trading day 2026-11-12 needs data through 2026-11-11: "
                   "no signal is drawn from older data.\n")


@pytest.mark.parametrize(("change", "message"), [
    ({"definitionVariant": "top_3"}, "golive: Sleeve rotation: unknown definitionVariant 'top_3'"),
    ({"runKey": "momentum-rotation/Q"}, "golive: Sleeve rotation: run key 'momentum-rotation/Q' is not a run of"),
])
def test_main_refuses_an_unknown_variant_or_run_key_and_prints_nothing(monkeypatch, tmp_path, change, message):
    plan = _plan(sleeves=[_sleeve("long-index"), _sleeve("rotation", **change), _sleeve("vol-premium")])
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12", stdin=json.dumps(plan))
    assert (code, out) == (1, "") and err.startswith(message)


def test_main_has_its_own_exit_code_for_a_closed_day(monkeypatch, tmp_path):
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-25", "2026-11-26")
    assert (code, out, err) == (3, "", "golive: 2026-11-26 is not an NYSE trading day\n")
    assert (cli.EXIT_REFUSED, cli.EXIT_NOT_TRADING_DAY) == (1, 3)


def test_main_refuses_a_plan_that_is_not_json_and_a_data_directory_it_cannot_read(monkeypatch, tmp_path):
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12", stdin="{")
    assert (code, out) == (1, "") and err.startswith("golive: the plan on stdin is not JSON")
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12", stdin="[]")
    assert (code, out, err) == (1, "", "golive: The plan must be a JSON object\n")

    def missing(root):
        raise FileNotFoundError(2, "No such file or directory", str(root / "SPY.csv"))

    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12", load=missing)
    assert (code, out) == (1, "") and err.startswith(f"golive: cannot read the data directory {tmp_path / 'data'}:")


def test_main_tells_zero_candidates_from_a_failure(monkeypatch, tmp_path):
    (tmp_path / "chains").mkdir()
    # Nothing wanted: exit 0, one document with an empty list, nothing on stderr.
    code, out, err = _main(monkeypatch, tmp_path, FIRST_DAY, "2025-07-02")
    assert (code, err) == (0, "") and out.count("\n") == 1 and json.loads(out)["candidates"] == []
    # Index series that stopped seven trading days ago under fresh bars: without the check this run also ended
    # with exit 0, an empty list and nothing on stderr.
    data = _dataset("2026-11-30")
    stale = _gap(data, data.calendar[-7], *INDEX_SERIES)
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-30", "2026-12-01", data=stale)
    assert (code, out) == (cli.EXIT_REFUSED, "")
    lines = err.splitlines()
    assert len(lines) == 9 and all(line.startswith("golive: The ") for line in lines)
    assert lines[0].startswith(f"golive: The VIX series has no value of 2026-11-30: its last value before that day is "
                               f"of {data.calendar[-8]}. Trading day 2026-12-01 needs its value of 2026-11-30;")


@pytest.mark.parametrize("series_id", ["VXN", "IRX", "VIX", "VIX3M"])
def test_main_refuses_one_series_without_a_value_of_the_last_data_day(monkeypatch, tmp_path, series_id):
    (tmp_path / "chains").mkdir()
    code, out, err = _main(monkeypatch, tmp_path, "2026-08-31", "2026-09-01",
                           data=_gap(_dataset("2026-08-31"), "2026-08-31", series_id))
    assert (code, out) == (1, "")
    assert err.startswith(f"golive: The {series_id} series has no value of 2026-08-31: its last value before that day "
                          "is of 2026-08-28. Trading day 2026-09-01 needs its value of 2026-08-31;")
    assert err.count("\n") == 1


def test_main_refuses_a_chain_store_that_does_not_exist(monkeypatch, tmp_path):
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12")  # <tmp_path>/chains is not there
    assert (code, out) == (1, "")
    assert err.startswith(f"golive: The chain store cannot be read ({tmp_path / 'chains'}: No such file or directory)")
    # The same on a day without a candidate.
    code, out, err = _main(monkeypatch, tmp_path, FIRST_DAY, "2025-07-02")
    assert (code, out) == (1, "") and err.startswith("golive: The chain store cannot be read")


def test_main_leaves_out_a_position_that_expires_on_the_trading_day(monkeypatch, tmp_path):
    (tmp_path / "chains").mkdir()
    code, out, err = _main(monkeypatch, tmp_path, "2026-12-17", "2026-12-18")
    assert (code, err) == (0, "")
    document = json.loads(out)
    assert_collect_input(document)
    assert _picked(document, gl.MODEL_HOLDS) == [("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD")]
    assert "20261218" not in [item["expiry"] for item in document["candidates"]]


def test_main_keeps_stdout_for_the_document(monkeypatch, tmp_path):
    def noisy(plan, dataset, facts, chain_store, trading_day, now):
        print("a line some code printed")
        return {"planId": "p", "planVersion": 1, "tradingDay": trading_day, "generatedAt": "2026-12-01T14:00:00Z",
                "candidates": []}

    monkeypatch.setattr(cli, "generate", noisy)
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12")
    assert (code, err) == (0, "a line some code printed\n")
    assert out.count("\n") == 1 and json.loads(out)["candidates"] == []

    def not_a_number(plan, dataset, facts, chain_store, trading_day, now):
        return {"candidates": [], "generatedAt": math.nan}

    # A number JSON cannot carry never reaches stdout (allow_nan=False).
    monkeypatch.setattr(cli, "generate", not_a_number)
    out, err = io.StringIO(), io.StringIO()
    with pytest.raises(ValueError, match="Out of range float values are not JSON compliant"):
        cli.main(["--data", str(tmp_path / "data"), "--chain-store", str(tmp_path), "--trading-day", "2026-11-12"],
                 stdin=io.StringIO(json.dumps(_plan())), stdout=out, stderr=err)
    assert out.getvalue() == ""


def test_main_needs_its_arguments(capsys):
    with pytest.raises(SystemExit) as usage:
        cli.main(["--data", "x"], stdin=io.StringIO("{}"))
    assert usage.value.code == 2
    assert "--chain-store" in capsys.readouterr().err
