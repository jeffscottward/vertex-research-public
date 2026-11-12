"""golive: the draft candidates of an allocation plan for one trading day (synthetic data, no network)."""
import copy
import dataclasses
import io
import json
import math
import os
import re
import sys
from datetime import UTC, datetime, timedelta
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


# The day the sleeves of the test plan start. From this day on the data reaches back far enough for every look-back
# (the 12-1 momentum needs 13 month ends, the trend gate 200 days); a sleeve that starts earlier is refused.
SLEEVE_START = "2026-08-03"


def _facts(start: str = SLEEVE_START) -> qi.Facts:
    first = {symbol: start for symbol in qi.CORE7}
    return qi.Facts(iv_start=first, iv_rank_join=first, starts={idea: first for idea in qi.ELIGIBILITY},
                    gold_last_input=start)


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


def _drop(data: pf.Dataset, series_id: str, *days: str) -> pf.Dataset:
    """`data` where the series has no value on the named days (every other day and the bars stay)."""
    kept = {day: value for day, value in data.series[series_id].items() if day not in days}
    return pf.Dataset(data.bars, {**data.series, series_id: kept})


# The holes of the synthetic data: none. Every history starts on FIRST_DAY (generator.check_history).
SYNTHETIC_PINS = gl.data_gaps(_dataset("2027-12-31"))


@pytest.fixture(scope="module", autouse=True)
def _pinned_synthetic_history():
    """The tested data of these tests is the synthetic data: its histories are pinned in place of the rig's
    (module scope, so the module fixtures roll_day and mid_month see it too)."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(gl, "TESTED_GAPS", SYNTHETIC_PINS)
        yield


def _at(trading_day: str) -> datetime:
    """14:00 UTC of the trading day (09:00 or 10:00 New York): the time of a run before the open."""
    return datetime.fromisoformat(f"{trading_day}T14:00:00+00:00")


def _list_model_strikes(store, data: pf.Dataset, trading_day: str, plan: dict | None = None, facts=None,
                        shift: float = 0.0, clock: str = "203000", day: str | None = None):
    """One snapshot run of the last data day in `store` that lists, with a bid and an ask, the model strikes
    (plus `shift`) of every spread the document of `trading_day` can hold. `day`: another day for the run.
    Returns the run directory, or None when the store is not a directory or the run is there already."""
    plan, facts, last_day = plan or _plan(), facts or _facts(), data.calendar[-1]
    day = day or last_day
    if not store.is_dir() or (store / day / f"{clock}Z").exists():
        return None
    made = {sleeve["key"]: gl.build_definition(sleeve, qi.family(facts), facts) for sleeve in plan["sleeves"]}
    combined = gl.model_trades(made, gl.with_pending_days(data, gl.pending_days(data.calendar, trading_day)), plan)
    chains: dict[tuple[str, str, str], dict] = {}
    for trade in combined.trades:
        wanted = trade.entry_date == trading_day or trade.entry_date <= last_day < trade.exit_date
        if wanted and trade.expiry > trading_day:
            side = "calls" if trade.structure.startswith("call") else "puts"
            chains.setdefault((trade.symbol, trade.expiry, side), {}).update(
                {trade.long_strike + shift: (2.0, 2.1), trade.short_strike + shift: (1.0, 1.2),
                 1.0: (0.0, 0.05), 5000.0: (0.0, 0.05)})  # the wings of a listing
    run = _run(store, day, clock, symbols=qi.CORE7)
    for (symbol, expiry, side), quotes in chains.items():
        _chain(run, symbol, expiry, side, quotes)
    return run


def _generate(last_day: str, trading_day: str, store, plan: dict | None = None, now: datetime | None = None,
              data: pf.Dataset | None = None, facts=None, listed: bool = True) -> dict:
    """The document of the synthetic data (or `data`) at 14:00 UTC of the trading day. `listed`: the store first
    gets a snapshot run of the last data day that lists every model strike (_list_model_strikes)."""
    data = data or _dataset(last_day)
    if listed and last_day < trading_day:
        _list_model_strikes(store, data, trading_day, plan, facts)
    return gl.generate(plan or _plan(), data, facts or _facts(), store, trading_day, now or _at(trading_day))


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
    facts = qi.Facts(iv_start={**facts.iv_start, "QQQ": "2026-09-02"}, iv_rank_join=facts.iv_rank_join,
                     starts=facts.starts, gold_last_input=facts.gold_last_input)
    runs = qi.family(facts)
    definition, start = gl.build_definition(_sleeve("long-index"), runs, facts)
    assert (definition, start) == gl.funded_pie().sleeve_definitions(runs, facts)["oil-predicts-equity/B"]
    assert definition["entry"] == {"all": [qi.ALWAYS]} and definition["name"] == "Always-on SPY and QQQ"
    assert start == "2026-09-02"  # the first day both members have an IV index, not the study start
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


# --------------------------------------------------------------------------- gaps on older days

def _held(data: pf.Dataset, trading_day: str, plan: dict | None = None) -> list[tuple]:
    """What the signal code makes of `data` without any check: (sleeve, symbol, long strike, short strike) of the
    model trades open after the last data day."""
    plan = plan or _plan()
    last_day = data.calendar[-1]
    combined = gl.model_trades(_made(plan), gl.with_pending_days(data, gl.pending_days(data.calendar, trading_day)), plan)
    return sorted((combined.owner[trade.trade_id], trade.symbol, trade.long_strike, trade.short_strike)
                  for trade in combined.trades if trade.entry_date <= last_day < trade.exit_date)


def _history_line(name: str, shown: str, read_by: str, trading_day: str = "2026-11-12") -> str:
    return (f"The {name} history has no value on {shown}: older days the tested data has values for. A gap on an "
            "older day changes the model's trades or strikes without a word; it must be filled by a refresh, or "
            f"checked and pinned (python -m golive.pin). Trading day {trading_day} is refused. Read by: {read_by}.")


@pytest.mark.parametrize("series_id", ["VIX3M", "VIX"])
def test_a_gate_series_without_the_value_of_an_older_signal_day_refuses_the_run(tmp_path, series_id):
    # 2026-10-30 is the signal day of the put credit spread the model holds on 2026-11-12. The gate reads the
    # value of that day itself: without it the spread is never entered, and nothing says so.
    data = _dataset("2026-11-11")
    gapped = _drop(data, series_id, "2026-10-30")
    assert [item[:2] for item in _held(data, "2026-11-12")] == [
        ("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD"), ("vol-premium", "SPY")]
    assert [item[:2] for item in _held(gapped, "2026-11-12")] == [
        ("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD")]
    with pytest.raises(gl.StaleDataError) as refused:
        gl.generate(_plan(), gapped, _facts(), tmp_path, "2026-11-12", NOW)
    line, = [line for line in str(refused.value).splitlines() if line.startswith(f"The {series_id} history")]
    assert line.startswith(f"The {series_id} history has no value on 2026-10-30: older days the tested data has values "
                           "for.")
    assert "vol-premium (gate" in line


@pytest.mark.parametrize(("series_id", "sleeve", "symbol"), [("VXN", "long-index", "QQQ"), ("GVZ", "rotation", "GLD")])
def test_a_volatility_index_without_the_value_of_an_entry_day_refuses_the_run(tmp_path, series_id, sleeve, symbol):
    # 2026-11-02 is the entry day of the spreads the model holds. Without the print of that day the options book
    # carries the one of 2026-10-30 (here a higher one) and the strikes move, with no error.
    data = _dataset("2026-11-11")
    series = {**data.series[series_id], "2026-10-30": 24.0}
    gapped = _drop(pf.Dataset(data.bars, {**data.series, series_id: series}), series_id, "2026-11-02")
    usual = next(item for item in _held(pf.Dataset(data.bars, {**data.series, series_id: series}), "2026-11-12")
                 if item[:2] == (sleeve, symbol))
    moved = next(item for item in _held(gapped, "2026-11-12") if item[:2] == (sleeve, symbol))
    assert moved[3] > usual[3] and moved[2:] != usual[2:]  # other strikes, so another draft id
    with pytest.raises(gl.StaleDataError, match=(
            f"^The {series_id} history has no value on 2026-11-02: .* Read by: .*strike-width volatility of {symbol}")):
        gl.generate(_plan(), gapped, _facts(), tmp_path, "2026-11-12", NOW)


def test_a_rate_without_the_value_of_a_day_a_held_spread_is_marked_on_refuses_the_run(tmp_path):
    # The book marks an open spread every day with the volatility index and the rate of that day; a carried
    # value changes the mark, and the mark decides the profit-take exit.
    data = _drop(_dataset("2026-11-11"), "IRX", "2026-11-05")
    with pytest.raises(gl.StaleDataError) as refused:
        gl.generate(_plan(), data, _facts(), tmp_path, "2026-11-12", NOW)
    assert str(refused.value) == _history_line("IRX", "2026-11-05", "long-index (rate); rotation (rate); vol-premium "
                                                                     "(rate)")


def test_a_gap_on_any_older_day_refuses_the_run_also_before_the_open_positions(tmp_path, mid_month):
    # The model account is one path: a sleeve that holds one spread at a time enters only after the last one
    # closed, so a gap months back can change today's spread. Every older day counts, not only the days the
    # open spreads were entered on.
    data = _drop(_dataset("2026-11-11"), "VIX3M", "2025-08-13", "2025-08-14", "2025-09-02")
    with pytest.raises(gl.StaleDataError) as refused:
        _generate("2026-11-11", "2026-11-12", tmp_path, data=data)
    assert str(refused.value) == _history_line("VIX3M", "2025-08-13 to 2025-08-14, 2025-09-02", "vol-premium (gate)")


def test_a_hole_the_tested_data_had_is_read_as_the_backtest_read_it(tmp_path, monkeypatch, mid_month):
    # The same hole, pinned: the data the plan was tested on had it, so it is no new gap.
    data = _drop(_dataset("2026-11-11"), "VIX3M", "2025-08-13", "2025-08-14", "2025-09-02")
    monkeypatch.setattr(gl, "TESTED_GAPS", {**SYNTHETIC_PINS, "VIX3M": (FIRST_DAY, (
        ("2025-08-12", "2025-08-14"), ("2025-09-02", "2025-09-02")))})
    assert _generate("2026-11-11", "2026-11-12", tmp_path, data=data)["candidates"] == mid_month["candidates"]
    # A hole that only starts inside a pinned one, or runs past it, has new days: refused.
    longer = _drop(data, "VIX3M", "2025-08-15")
    with pytest.raises(gl.StaleDataError, match="^The VIX3M history has no value on 2025-08-13 to 2025-08-15: "):
        gl.generate(_plan(), longer, _facts(), tmp_path, "2026-11-12", NOW)


def test_a_history_that_starts_later_than_the_tested_one_refuses_the_run(tmp_path):
    data = _dataset("2026-11-11")
    last = sorted(data.series["VIX3M"])[-3:]
    cut = pf.Dataset(data.bars, {**data.series, "VIX3M": {day: data.series["VIX3M"][day] for day in last}})
    assert ("vol-premium", "SPY") not in [item[:2] for item in _held(cut, "2026-11-12")]  # the silent loss
    with pytest.raises(gl.StaleDataError) as refused:
        gl.generate(_plan(), cut, _facts(), tmp_path, "2026-11-12", NOW)
    assert str(refused.value) == ("The VIX3M history starts on 2026-11-09; the tested data starts on 2025-07-01. "
                                  "Trading day 2026-11-12 is refused. Read by: vol-premium (gate).")
    # A history without any value (generate refuses it earlier, in check_series).
    empty = pf.Dataset(data.bars, {**data.series, "VIX3M": {}})
    with pytest.raises(gl.StaleDataError, match="^The VIX3M history has no value; the tested data starts on 2025-07-01. "):
        gl.check_history(_plan()["sleeves"], _made(_plan()), empty, "2026-11-11", "2026-11-12", SYNTHETIC_PINS)


def test_a_history_that_is_not_pinned_refuses_the_run(tmp_path, monkeypatch):
    monkeypatch.setattr(gl, "TESTED_GAPS", {name: pin for name, pin in SYNTHETIC_PINS.items() if name != "GVZ"})
    with pytest.raises(gl.StaleDataError) as refused:
        _generate("2026-11-11", "2026-11-12", tmp_path)
    assert str(refused.value) == (
        "The GVZ history is not pinned (golive/tested_gaps.py): a new gap cannot be told from one the plan was tested "
        "with. Trading day 2026-11-12 is refused. Read by: rotation (gate of GLD, strike-width volatility of GLD).")


def test_a_hole_that_ends_before_the_tested_history_starts_is_not_read(tmp_path, monkeypatch, mid_month):
    # The refresh found older history than the tested data had, with a hole in it: the test never read those days.
    data = _drop(_dataset("2026-11-11"), "VIX3M", "2025-07-03")
    monkeypatch.setattr(gl, "TESTED_GAPS", {**SYNTHETIC_PINS, "VIX3M": ("2025-07-07", ())})
    assert _generate("2026-11-11", "2026-11-12", tmp_path, data=data)["candidates"] == mid_month["candidates"]
    # A hole that reaches the first tested day is a new gap.
    with pytest.raises(gl.StaleDataError, match="^The VIX3M history has no value on 2025-07-03 to 2025-07-07: "):
        gl.generate(_plan(), _drop(data, "VIX3M", "2025-07-07"), _facts(), tmp_path, "2026-11-12", NOW)


def test_a_gap_inside_a_look_back_refuses_the_run(tmp_path):
    # The 200-day average of the trend gate is a mean of the last 200 values there are: a missing close shifts it
    # by a day without a word.
    data = _drop(_dataset("2026-11-11"), "SPY", "2026-03-10")
    with pytest.raises(gl.StaleDataError) as refused:
        gl.generate(_plan(), data, _facts(), tmp_path, "2026-11-12", NOW)
    assert str(refused.value) == _history_line("SPY", "2026-03-10", "vol-premium (gate)")


def _without_bar(data: pf.Dataset, symbol: str, *days: str) -> pf.Dataset:
    bar = data.bars[symbol]
    keep = [index for index, day in enumerate(bar.dates) if day not in days]
    holed = type(bar)(symbol, *(tuple(column[index] for index in keep) for column in (
        bar.dates, bar.open, bar.high, bar.low, bar.close, bar.adj_close)))
    return pf.Dataset({**data.bars, symbol: holed}, data.series)


def test_bars_of_a_traded_etf_with_a_missing_day_refuse_the_run(tmp_path):
    data = _without_bar(_dataset("2026-11-11"), "GLD", "2026-10-14")
    with pytest.raises(gl.StaleDataError) as refused:
        gl.generate(_plan(), data, _facts(), tmp_path, "2026-11-12", NOW)
    assert str(refused.value) == _history_line("GLD bars", "2026-10-14", "rotation (traded)")


def test_a_day_missing_from_the_calendar_bars_refuses_the_run(tmp_path):
    # SPY sets the trading days (portfolio.CALENDAR_SYMBOL). A day the other ETFs have and SPY lacks is a gap of
    # the calendar itself, even for a plan that does not trade SPY.
    data = _without_bar(_dataset("2026-11-11"), "SPY", "2026-10-14")
    plan = _plan(sleeves=[_sleeve("rotation", symbols=["QQQ", "DIA", "IWM", "GLD", "SLV", "USO", "SPY"])])
    with pytest.raises(gl.StaleDataError) as refused:
        gl.generate(plan, data, _facts(), tmp_path, "2026-11-12", NOW)
    assert _history_line("SPY bars", "2026-10-14", "the trading calendar; rotation (traded)") in str(
        refused.value).splitlines()


def test_an_extra_bar_of_one_etf_on_a_closed_day_is_no_gap_of_the_others(tmp_path, mid_month):
    # USO with a bar on Monday 2026-01-19 (Martin Luther King Jr. Day), when the other ETFs have none.
    data = _dataset("2026-11-11")
    bar = data.bars["USO"]
    at = bar.dates.index("2026-01-20")
    columns = [list(column) for column in (bar.dates, bar.open, bar.high, bar.low, bar.close, bar.adj_close)]
    columns[0].insert(at, "2026-01-19")
    for column in columns[1:]:
        column.insert(at, column[at])
    extra = pf.Dataset({**data.bars, "USO": type(bar)("USO", *(tuple(column) for column in columns))}, data.series)
    assert gl.data_gaps(extra)["SPY bars"] == (FIRST_DAY, ())
    assert _generate("2026-11-11", "2026-11-12", tmp_path, data=extra)["candidates"] == mid_month["candidates"]


def test_bars_lost_by_one_of_two_etfs_or_by_most_etfs_on_one_day_are_holes():
    data = _dataset("2026-01-30")
    # Two ETFs only (the years before the others started): the one bar the other lacks still counts.
    two = pf.Dataset({symbol: data.bars[symbol] for symbol in ("SPY", "DIA")}, data.series)
    assert gl.data_gaps(_without_bar(two, "DIA", "2025-09-15"))["DIA bars"] == (FIRST_DAY, (("2025-09-15", "2025-09-15"),))
    # Five of seven ETFs lose one calendar day at once.
    many = data
    for symbol in ("QQQ", "DIA", "IWM", "GLD", "USO"):
        many = _without_bar(many, symbol, "2025-09-15")
    gaps = gl.data_gaps(many)
    assert all(gaps[f"{symbol} bars"][1] == (("2025-09-15", "2025-09-15"),) for symbol in ("QQQ", "DIA", "IWM", "GLD", "USO"))
    assert gaps["SPY bars"] == gaps["SLV bars"] == (FIRST_DAY, ())


def test_a_refusal_names_five_holes_of_a_history_and_counts_the_rest(tmp_path):
    days = [day for day in _dataset("2026-11-11").calendar if "2026-03-01" <= day <= "2026-03-31"][::2][:8]
    data = _drop(_dataset("2026-11-11"), "VIX3M", *days)
    with pytest.raises(gl.StaleDataError) as refused:
        gl.generate(_plan(), data, _facts(), tmp_path, "2026-11-12", NOW)
    assert str(refused.value).startswith(f"The VIX3M history has no value on {', '.join(days[:5])} and 3 more: ")


def test_data_gaps_lists_each_run_of_missing_days_from_the_first_value_on():
    data = _without_bar(_drop(_dataset("2026-01-30"), "VIX3M", "2025-07-01", "2025-07-02", "2025-08-04", "2025-08-05",
                              "2025-08-06", "2026-01-29"), "USO", "2025-12-01")
    data = pf.Dataset(data.bars, {**data.series, "NAN": {"2025-07-01": math.nan}, "EMPTY": {}})
    gaps = gl.data_gaps(data)
    # A series counts from its first value on: the two days before it are no hole.
    assert gaps["VIX3M"] == ("2025-07-03", (("2025-08-04", "2025-08-06"), ("2026-01-29", "2026-01-29")))
    assert gaps["USO bars"] == (FIRST_DAY, (("2025-12-01", "2025-12-01"),))
    assert gaps["SPY bars"] == (FIRST_DAY, ())
    # Every ETF and every series but the total-return series of the bars; a series without a value is left out.
    assert set(gaps) == {*(f"{symbol} bars" for symbol in qi.CORE7), *(name for name in data.series
                                                                      if not name.endswith(":TR"))} - {"NAN", "EMPTY"}
    # `until`: only days before it; `names`: those names only, a missing ETF left out.
    assert gl.data_gaps(data, ["VIX3M", "TLT bars"], until="2026-01-29") == {"VIX3M": ("2025-07-03", (
        ("2025-08-04", "2025-08-06"),))}


def test_history_readers_are_the_bars_and_the_series_of_each_sleeve():
    readers = gl.history_readers(_plan()["sleeves"], _made(_plan()))
    assert readers["SPY bars"] == ["the trading calendar", "long-index (traded)", "rotation (traded)",
                                   "vol-premium (traded)"]
    assert readers["VIX3M"] == ["vol-premium (gate)"]
    # A total-return series is the ETF's bars.
    studied = _plan(sleeves=[_sleeve("long-index", definitionVariant="as_studied")])
    readers = gl.history_readers(studied["sleeves"], _made(studied))
    assert "USO:TR" not in readers and readers["USO bars"] == ["long-index (signal input)"]


def test_the_pinned_holes_are_the_module_golive_pin_prints():
    from golive import pin, tested_gaps
    text = pin.module_text(tested_gaps.TESTED_GAPS, tested_gaps.PINNED_THROUGH)
    assert (gl.Path(tested_gaps.__file__).read_text()) == text
    # Every history the funded lower-bar pie reads is pinned, with the holes of the tested data.
    assert set(gl.history_readers(_plan()["sleeves"], _made(_plan()))) <= set(tested_gaps.TESTED_GAPS)
    assert tested_gaps.TESTED_GAPS["VIX3M"] == ("2006-07-17", ())
    assert ("2016-11-11", "2016-11-11") in tested_gaps.TESTED_GAPS["IRX"][1]


def test_golive_pin_prints_the_module_of_a_data_directory(monkeypatch):
    from golive import pin
    data = _drop(_dataset("2026-01-30"), "VIX3M", "2025-08-04")
    loaded = []

    def load(path):
        loaded.append(path)
        print("a loader note")  # goes to stderr, never into the module
        return SimpleNamespace(dataset=data)

    monkeypatch.setattr(pin.study, "load_study_data", load)
    stdout, stderr = io.StringIO(), io.StringIO()
    assert pin.main(["--data", "/srv/qc-ports"], stdout=stdout, stderr=stderr) == 0
    assert stderr.getvalue() == "a loader note\n" and str(loaded[0]) == "/srv/qc-ports"
    namespace = {}
    exec(stdout.getvalue(), namespace)
    assert namespace["PINNED_THROUGH"] == "2026-01-30"
    assert namespace["TESTED_GAPS"] == gl.data_gaps(data)
    assert namespace["TESTED_GAPS"]["VIX3M"] == (FIRST_DAY, (("2025-08-04", "2025-08-04"),))


def test_golive_pin_reports_a_file_that_is_not_qc_ports_data(monkeypatch):
    from golive import pin

    def load(path):
        raise KeyError("close")

    monkeypatch.setattr(pin.study, "load_study_data", load)
    stdout, stderr = io.StringIO(), io.StringIO()
    assert pin.main(["--data", "/srv/qc-ports"], stdout=stdout, stderr=stderr) == 1
    assert (stdout.getvalue(), stderr.getvalue()) == (
        "", "golive.pin: the data directory /srv/qc-ports cannot be read: 'close'\n")


def test_golive_pin_reports_a_data_directory_it_cannot_read(tmp_path):
    from golive import pin
    stdout, stderr = io.StringIO(), io.StringIO()
    assert pin.main(["--data", str(tmp_path / "missing")], stdout=stdout, stderr=stderr) == 1
    assert stdout.getvalue() == "" and stderr.getvalue().startswith(
        f"golive.pin: the data directory {tmp_path / 'missing'} cannot be read: ")


# --------------------------------------------------------------------------- candidates

def test_a_model_entry_dated_on_the_trading_day_is_a_signal_today(roll_day):
    assert_collect_input(roll_day)
    assert (roll_day["planId"], roll_day["planVersion"], roll_day["tradingDay"], roll_day["generatedAt"]) == (
        "funded-lower-bar-pie", 3, "2026-12-01", "2026-12-01T14:00:00Z")
    # The monthly roll: both index verticals and the momentum pick. The put credit sleeve still holds its
    # November spread (one spread at a time), so it has no entry today.
    assert _picked(roll_day, gl.SIGNAL_TODAY) == [("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD")]
    spy = _one(roll_day, gl.SIGNAL_TODAY, "long-index", "SPY")
    assert spy["structure"] == "callDebitVertical" and spy["quote"]["asOf"] == "2026-11-30T20:30:00Z"
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
    document = _generate("2026-08-31", "2026-09-01", tmp_path, data=data)
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
    # The date is always the entry date (for an entry of today: the last data day): a run that would carry an
    # older value is refused (test_a_volatility_index_without_the_value_of_an_entry_day_refuses_the_run).
    for document in (roll_day, mid_month):
        for item in document["candidates"]:
            entered = re.search(r"Model entry date (\d{4}-\d{2}-\d{2})", item["signalFacts"][1]).group(1)
            day = "2026-11-30" if item["entryBasis"] == gl.SIGNAL_TODAY else entered
            assert sum(fact.count(f" of {day} ") for fact in item["signalFacts"] if fact.startswith("Strike inputs")) == 2


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
    (tmp_path / "one").mkdir()
    document = _generate("2026-11-11", "2026-11-12", tmp_path / "one", _plan(limits=limits))
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
           expiry="2027-01-15") -> al.PricedTrade:
    return al.PricedTrade(
        trade_id=1, symbol=symbol, structure=structure, expiry=expiry, long_strike=long_strike,
        short_strike=short_strike, width=abs(short_strike - long_strike), entry_index=1, exit_index=2,
        entry_date="2026-11-02", exit_date="2026-11-30", entry_price=200.0, exit_price=300.0, entry_fee=2.0,
        exit_fee=2.0, max_loss=204.0, max_loss_pct=1.0, premium=2.0, exit_reason="end", marks=())


def _priced(store, trade=None, now: datetime = NOW, oldest_day: str = "2026-11-27", trading_day: str = "2026-12-01"):
    return gl.price_candidate(trade or _trade(), gl.snapshots(store, now), oldest_day, trading_day)


def _no_strikes(why: str, chain: str = "2027-01-15 calls of SPY", model: str = "756/807") -> str:
    return (f"No listed strikes for the {chain} (model strikes {model}): {why}. A draft names listed strikes only; "
            "no document.")


def _refused(store, trade=None, **options) -> str:
    with pytest.raises(gl.NoChainError) as refused:
        _priced(store, trade, **options)
    return str(refused.value)


SPY_CALLS = {756.0: (17.63, 17.78), 807.0: (0.76, 0.78)}
NO_YAHOO = "RuntimeError: Yahoo listed no monthly expiry"
needs_file_modes = pytest.mark.skipif(os.geteuid() == 0, reason="root reads a file whatever its mode")


def test_listed_strikes_get_the_bid_and_ask_of_the_snapshot_with_its_source_and_time(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2027-01-15", "calls", {755.0: (18.4, 18.6), 756.0: (17.63, 17.78), 807.0: (0.76, 0.78)})
    _chain(run, "SPY", "2027-01-15", "puts", {756.0: (9.0, 9.1), 807.0: (50.0, 50.5)})
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
    assert issubclass(gl.NoChainError, gl.GoLiveError)


def test_a_model_strike_moves_to_the_nearest_listed_strike(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2027-01-15", "puts", {685.0: (1.9, 2.0), 690.0: (2.16, 2.17), 692.0: (2.3, 2.4),
                                              716.0: (3.83, 3.86), 720.0: (4.2, 4.3)})
    long_strike, short_strike, quote, facts = _priced(tmp_path, _trade("putCreditVertical", 691.0, 716.0))
    # 690 and 692 are both one step from 691: the lower one.
    assert (long_strike, short_strike) == (690.0, 716.0)
    assert (quote["longBid"], quote["longAsk"], quote["shortBid"], quote["shortAsk"]) == (2.16, 2.17, 3.83, 3.86)
    assert facts[:2] == ["Long leg: model strike 691 -> listed 690.", "Short leg: model strike 716 -> listed 716."]


# A real-shaped chain away from the money: the 2027-01-15 SPY calls of the 2026-11-11 snapshot are listed in 5-dollar
# steps throughout, so about 40% of the whole-dollar strikes of the model are more than one dollar from a listed one.
FIVE_DOLLAR_CALLS = {float(strike): (max(0.05, (900 - strike) / 10), max(0.06, (900 - strike) / 10 + 0.2))
                     for strike in range(600, 901, 5)}


@pytest.mark.parametrize(("model", "listed"), [((756.0, 807.0), (755.0, 805.0)), ((758.0, 808.0), (760.0, 810.0)),
                                               ((697.0, 762.0), (695.0, 760.0)), ((757.5, 812.5), (755.0, 810.0))])
def test_a_chain_listed_in_five_dollar_steps_names_its_nearest_strikes(tmp_path, model, listed):
    _chain(_run(tmp_path, "2026-11-30", "203000"), "SPY", "2027-01-15", "calls", FIVE_DOLLAR_CALLS)
    long_strike, short_strike, quote, facts = _priced(tmp_path, _trade(long_strike=model[0], short_strike=model[1],
                                                                       expiry="2027-01-15"))
    assert (long_strike, short_strike) == listed and quote is not None
    assert facts[:2] == [f"Long leg: model strike {model[0]:g} -> listed {listed[0]:g}.",
                         f"Short leg: model strike {model[1]:g} -> listed {listed[1]:g}."]


def test_a_model_strike_outside_the_listed_strikes_refuses_the_run(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2027-01-15", "calls", {755.0: (18.4, 18.6), 756.0: (17.63, 17.78), 800.0: (0.9, 1.0)})
    assert _refused(tmp_path) == _no_strikes(
        "the short leg 807 is outside the listed strikes 755 to 800 of the snapshot of 2026-11-30T20:30:00Z")
    assert _refused(tmp_path, _trade(long_strike=750.0, short_strike=790.0)) == _no_strikes(
        "the long leg 750 is outside the listed strikes 755 to 800 of the snapshot of 2026-11-30T20:30:00Z",
        model="750/790")
    # The ends of the listing are listed strikes.
    assert _priced(tmp_path, _trade(long_strike=755.0, short_strike=800.0))[:2] == (755.0, 800.0)



def test_an_expiry_or_a_side_that_is_not_in_any_snapshot_refuses_the_run(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2027-01-15", "calls", SPY_CALLS)
    assert _refused(tmp_path, _trade(expiry="2027-01-08")) == _no_strikes(
        "the snapshot of 2026-11-30T20:30:00Z has no 2027-01-08 calls chain of SPY", "2027-01-08 calls of SPY")
    assert _refused(tmp_path, _trade("putCreditVertical", 756.0, 807.0)) == _no_strikes(
        "the snapshot of 2026-11-30T20:30:00Z has no 2027-01-15 puts chain of SPY", "2027-01-15 puts of SPY")
    # A chain file without a row is no chain.
    (run / "SPY-2027-01-08-calls.csv").write_text(HEADER + "\n")
    assert _refused(tmp_path, _trade(expiry="2027-01-08")) == _no_strikes(
        "the snapshot of 2026-11-30T20:30:00Z has a 2027-01-08 calls chain of SPY without a strike",
        "2027-01-08 calls of SPY")
    # A symbol no run is done with, and a store without a snapshot.
    assert _refused(tmp_path, _trade(symbol="QQQ")) == _no_strikes(
        "the chain store has no snapshot of QQQ", "2027-01-15 calls of QQQ")
    (tmp_path / "empty").mkdir()
    assert _refused(tmp_path / "empty") == _no_strikes("the chain store has no snapshot of SPY")


def test_two_legs_on_one_listed_strike_refuse_the_run(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2027-01-15", "calls", {756.0: (17.63, 17.78), 800.0: (1.0, 1.1)})
    assert _refused(tmp_path, _trade(long_strike=756.0, short_strike=757.0)) == _no_strikes(
        "both legs meet on the listed strike 756 in the snapshot of 2026-11-30T20:30:00Z", model="756/757")


@pytest.mark.parametrize("short_quote", [("", ""), ("0.0", "0.0"), ("0.8", "0.7"), ("-0.1", "0.2"), ("nan", "0.5"),
                                         ("0.5", "inf"), ("x", "0.5")])
def test_a_listed_leg_without_a_usable_bid_and_ask_gives_no_quote(tmp_path, short_quote):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2027-01-15", "calls", {756.0: (17.63, 17.78), 807.0: short_quote})
    assert _priced(tmp_path) == (756.0, 807.0, None, [
        "Long leg: model strike 756 -> listed 756.",
        "Short leg: model strike 807 -> listed 807.",
        "No usable bid and ask for both legs in the chain snapshot of 2026-11-30T20:30:00Z: no quote.",
    ])


def test_a_zero_bid_with_an_ask_is_a_quote(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2027-01-15", "calls", {756.0: (17.63, 17.78), 807.0: (0.0, 0.01), 0.0: (1.0, 2.0)})
    quote = _priced(tmp_path)[2]
    assert (quote["shortBid"], quote["shortAsk"]) == (0.0, 0.01)
    assert 0.0 not in gl.chain_quotes(gl.snapshots(tmp_path, NOW)[0], "SPY", "2027-01-15", "call")


def _day_of_snapshots(store) -> None:
    """Four runs with different listings. The model short strike 806 is between 805 and 807 in the first run of
    2026-11-30; the later runs also list 806."""
    for day, clock, bid, strikes in (("2026-11-27", "173000", 15.0, (800.0, 806.0)),
                                     ("2026-11-30", "173000", 16.0, (805.0, 807.0)),
                                     ("2026-11-30", "203000", 17.0, (805.0, 806.0, 807.0)),
                                     ("2026-12-01", "173000", 18.0, (806.0, 807.0))):
        _chain(_run(store, day, clock), "SPY", "2027-01-15", "calls",
               {756.0: (bid, bid + 0.1), **{strike: (0.7, 0.8) for strike in strikes}})


def test_the_strikes_come_from_the_oldest_usable_snapshot_and_the_quote_from_the_newest(tmp_path):
    _day_of_snapshots(tmp_path)
    trade = _trade(short_strike=806.0)
    assert [run.stamp for run in gl.snapshots(tmp_path, NOW)] == [
        "2026-11-30T20:30:00Z", "2026-11-30T17:30:00Z", "2026-11-27T17:30:00Z"]
    # 2026-11-30 is the oldest day allowed: the run of 2026-11-27 is not read. 805 and 807 are both one step
    # from 806: the lower one. The newest run lists 806 itself, and that changes nothing.
    long_strike, short_strike, quote, facts = _priced(tmp_path, trade, oldest_day="2026-11-30")
    assert (long_strike, short_strike, quote["asOf"], quote["longBid"]) == (756.0, 805.0, "2026-11-30T20:30:00Z", 17.0)
    assert facts == [
        "Long leg: model strike 756 -> listed 756.",
        "Short leg: model strike 806 -> listed 805.",
        "Quote: Yahoo chain snapshot of 2026-11-30T20:30:00Z, delayed, not a live quote.",
    ]
    # The run of exactly `now` counts for the quote; one second earlier it does not.
    at = datetime(2026, 11, 30, 20, 30, tzinfo=UTC)
    assert _priced(tmp_path, trade, now=at, oldest_day="2026-11-30")[2]["longBid"] == 17.0
    early = _priced(tmp_path, trade, now=datetime(2026, 11, 30, 20, 29, 59, tzinfo=UTC), oldest_day="2026-11-30")
    assert early[:2] == (756.0, 805.0) and early[2]["longBid"] == 16.0
    # A newest run that does not list both strikes gives no quote; the strikes stay.
    late = _priced(tmp_path, trade, now=datetime(2026, 12, 1, 17, 30, tzinfo=UTC), oldest_day="2026-11-30")
    assert late[:3] == (756.0, 805.0, None)
    assert late[3][-1] == "No quote: the chain snapshot of 2026-12-01T17:30:00Z does not list both strikes."
    # Before the first run of the oldest day there are no strikes to name.
    assert _refused(tmp_path, trade, now=datetime(2026, 11, 30, 17, 0, tzinfo=UTC), oldest_day="2026-11-30") == (
        _no_strikes("the newest chain snapshot of SPY is of 2026-11-27 (2026-11-27T17:30:00Z), older than "
                    "2026-11-30, the oldest day strikes may come from", model="756/806"))


def test_two_runs_of_one_day_never_name_different_strikes_for_one_model_trade(tmp_path):
    _day_of_snapshots(tmp_path)
    trade, named, refusals = _trade(short_strike=806.0), set(), 0
    for hour in range(48):  # every hour of 2026-11-30 and 2026-12-01, with one, two and three usable runs
        now = datetime(2026, 11, 30, tzinfo=UTC) + timedelta(hours=hour, minutes=45)
        try:
            named.add(_priced(tmp_path, trade, now=now, oldest_day="2026-11-30")[:2])
        except gl.NoChainError:
            refusals += 1
            assert not named  # a refusal comes only before the first usable run, never after strikes were named
    assert named == {(756.0, 805.0)} and refusals == 17
    # The newest listing alone would have named 806 from 20:30 on.
    newest = gl.snapshots(tmp_path, NOW)[0]
    assert 806.0 in gl.chain_quotes(newest, "SPY", "2027-01-15", "call")


def test_runs_that_cannot_be_read_or_have_not_reached_the_symbol_are_passed_over(tmp_path):
    good = _run(tmp_path, "2026-11-30", "173000", symbols=("SPY", "QQQ"))
    _chain(good, "SPY", "2027-01-15", "calls", {756.0: (16.0, 16.1), 807.0: (0.7, 0.8)})
    # A later run that is still writing: it has finished QQQ only. Its SPY file is not complete yet.
    running = _run(tmp_path, "2026-11-30", "203000", symbols=("QQQ",))
    _chain(running, "SPY", "2027-01-15", "calls", {756.0: (99.0, 99.1)})
    _run(tmp_path, "2026-11-30", "203100", summary="{not json")
    _run(tmp_path, "2026-11-30", "203200", summary=json.dumps({"schema": 2, "symbols": {"SPY": []}}))
    _run(tmp_path, "2026-11-30", "203300", summary=json.dumps({"fetchedAt": "yesterday", "symbols": {"SPY": []}}))
    _run(tmp_path, "2026-11-30", "203400", summary=json.dumps({"fetchedAt": "2026-11-30T20:34:00+00:00", "symbols": 7}))
    (tmp_path / "2026-11-30" / "203500Z").mkdir()  # a run that has written no summary yet
    assert [run.stamp for run in gl.snapshots(tmp_path, NOW)] == ["2026-11-30T20:30:00Z", "2026-11-30T17:30:00Z"]
    assert _priced(tmp_path)[2]["asOf"] == "2026-11-30T17:30:00Z"


def test_a_fetch_time_without_an_offset_is_utc_and_the_new_york_day_folder_is_not_the_clock(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000", fetched="2026-11-30T15:30:00-05:00")
    _chain(run, "SPY", "2027-01-15", "calls", {756.0: (17.0, 17.1), 807.0: (0.7, 0.8)})
    assert _priced(tmp_path)[2]["asOf"] == "2026-11-30T20:30:00Z"
    _run(tmp_path, "2026-11-30", "210000", fetched="2026-11-30T21:00:00")
    assert gl.snapshots(tmp_path, NOW)[0].stamp == "2026-11-30T21:00:00Z"


def test_a_snapshot_older_than_the_trading_day_before_the_trading_day_gives_no_strikes(tmp_path):
    assert gl.MAX_AGE_TRADING_DAYS == 1  # the same rule as the bars: nothing older than the trading day before
    _chain(_run(tmp_path, "2026-11-27", "203000"), "SPY", "2027-01-15", "calls", SPY_CALLS)
    assert gl.snapshots(tmp_path, NOW)[0].day == "2026-11-27"
    assert _refused(tmp_path, oldest_day="2026-11-30") == _no_strikes(
        "the newest chain snapshot of SPY is of 2026-11-27 (2026-11-27T20:30:00Z), older than 2026-11-30, the oldest "
        "day strikes may come from")
    assert _priced(tmp_path, oldest_day="2026-11-27")[2]["asOf"] == "2026-11-27T20:30:00Z"
    # The day of a snapshot is the New York day of its fetch: 01:00 UTC on Monday is Sunday evening there.
    _chain(_run(tmp_path, "2026-11-29", "010000", fetched="2026-11-30T01:00:00+00:00"), "SPY", "2027-01-15", "calls",
           SPY_CALLS)
    assert gl.snapshots(tmp_path, NOW)[0].day == "2026-11-29"
    assert "is of 2026-11-29 (2026-11-30T01:00:00Z), older than 2026-11-30" in _refused(tmp_path, oldest_day="2026-11-30")
    # A snapshot of the day itself, whatever its hour.
    _chain(_run(tmp_path, "2026-11-30", "144500"), "SPY", "2027-01-15", "calls", SPY_CALLS)
    assert _priced(tmp_path, oldest_day="2026-11-30")[2]["asOf"] == "2026-11-30T14:45:00Z"


def test_a_newer_run_whose_fetch_failed_does_not_hide_an_older_good_one(tmp_path):
    _chain(_run(tmp_path, "2026-11-30", "173000"), "SPY", "2027-01-15", "calls", SPY_CALLS)
    failed = _run(tmp_path, "2026-11-30", "203000", errors={"SPY": NO_YAHOO})  # SPY is in `symbols`, no chain file
    newest = gl.snapshots(tmp_path, NOW)[0]
    assert (newest.path, "SPY" in newest.symbols, newest.errors, gl.has_chains(newest, "SPY")) == (
        failed, True, {"SPY": NO_YAHOO}, False)
    long_strike, short_strike, quote, facts = _priced(tmp_path)
    assert (long_strike, short_strike, quote["asOf"], quote["longBid"]) == (756.0, 807.0, "2026-11-30T17:30:00Z", 17.63)
    assert facts == [
        f"Newest snapshot not read: the SPY chain fetch failed in the snapshot of 2026-11-30T20:30:00Z ({NO_YAHOO}).",
        "Long leg: model strike 756 -> listed 756.",
        "Short leg: model strike 807 -> listed 807.",
        "Quote: Yahoo chain snapshot of 2026-11-30T17:30:00Z, delayed, not a live quote.",
    ]
    # A report too long for a fact line is cut.
    _run(tmp_path, "2026-11-30", "204500", errors={"SPY": "HTTPError: 429\n" + "x" * 500})
    fact = _priced(tmp_path)[3][0]
    assert fact.startswith("Newest snapshot not read: the SPY chain fetch failed in the snapshot of 2026-11-30T20:45:00Z "
                           "(HTTPError: 429 x")
    assert len(fact) <= gl.FACT_MAX_CHARS and "\n" not in fact


def test_the_longest_fact_of_a_failed_newer_run_fits_the_contract(tmp_path):
    # A four-letter symbol, a report longer than any fact line, the longest stamp: at most FACT_MAX_CHARS.
    _chain(_run(tmp_path, "2026-11-30", "173000", symbols=("ABCD",)), "ABCD", "2027-01-15", "calls", SPY_CALLS)
    _run(tmp_path, "2026-11-30", "203000", symbols=("ABCD",), errors={"ABCD": "y" * 500})
    facts = _priced(tmp_path, _trade(symbol="ABCD"))[3]
    assert facts[0].startswith("Newest snapshot not read: the ABCD chain fetch failed in the snapshot of ")
    assert max(len(fact) for fact in facts) <= gl.FACT_MAX_CHARS
    # A run that has chains of the symbol, but a header-only file of the expiry, and the longest report.
    (tmp_path / "2026-11-30" / "203000Z" / "ABCD-2027-01-15-calls.csv").write_text(HEADER + "\n")
    facts = _priced(tmp_path, _trade(symbol="ABCD"))[3]
    assert "without a strike" in facts[0] and max(len(fact) for fact in facts) <= gl.FACT_MAX_CHARS


def test_a_run_with_an_earlier_time_added_later_becomes_the_oldest_one(tmp_path):
    # The limit of the rule: the store is read as it is. A restore or a hand-made run stamped before the first one
    # of the day is the oldest run from then on, and its listing sets the strikes.
    _chain(_run(tmp_path, "2026-11-30", "203000"), "SPY", "2027-01-15", "calls", SPY_CALLS)
    assert _priced(tmp_path)[:2] == (756.0, 807.0)
    _chain(_run(tmp_path, "2026-11-30", "170000"), "SPY", "2027-01-15", "calls", {755.0: (18.0, 18.2), 810.0: (1.0, 1.1)})
    long_strike, short_strike, quote, _facts = _priced(tmp_path)
    assert (long_strike, short_strike, quote) == (755.0, 810.0, None)  # the newest run does not list 755/810


def test_a_failed_fetch_without_an_older_good_run_refuses_the_run_and_is_named_as_a_failed_fetch(tmp_path):
    # The only good run is older than the freshness rule allows.
    _chain(_run(tmp_path, "2026-11-27", "203000"), "SPY", "2027-01-15", "calls", SPY_CALLS)
    _run(tmp_path, "2026-11-30", "173000", errors={"SPY": NO_YAHOO})
    assert _refused(tmp_path, oldest_day="2026-11-30") == _no_strikes(
        f"the SPY chain fetch failed in the snapshot of 2026-11-30T17:30:00Z ({NO_YAHOO})")
    # A run that lists the symbol without a chain file and without a report.
    _run(tmp_path, "2026-11-30", "203000")
    assert _refused(tmp_path, oldest_day="2026-11-30") == _no_strikes(
        "the SPY chain fetch failed in the snapshot of 2026-11-30T20:30:00Z, and none of the 1 older ones since "
        "2026-11-30 has it")


@pytest.mark.parametrize("newer", ["another expiry only", "a file without a row"])
def test_a_newer_run_that_lacks_one_expiry_does_not_hide_an_older_run_that_has_it(tmp_path, newer):
    _chain(_run(tmp_path, "2026-11-30", "173000"), "SPY", "2027-01-15", "calls", SPY_CALLS)
    run = _run(tmp_path, "2026-11-30", "203000")
    _chain(run, "SPY", "2027-01-08", "calls", {756.0: (30.0, 30.2), 807.0: (5.0, 5.1)})
    _chain(run, "SPY", "2027-01-15", "puts", {756.0: (9.0, 9.1), 807.0: (50.0, 50.5)})
    if newer == "a file without a row":
        (run / "SPY-2027-01-15-calls.csv").write_text(HEADER + "\n")
    newest, older = gl.snapshots(tmp_path, NOW)
    # The run has chains of the symbol, but not this expiry and side.
    assert gl.has_chains(newest, "SPY") and not gl.chain_quotes(newest, "SPY", "2027-01-15", "call")
    long_strike, short_strike, quote, facts = _priced(tmp_path)
    assert (long_strike, short_strike, quote["asOf"], quote["longBid"]) == (756.0, 807.0, "2026-11-30T17:30:00Z", 17.63)
    lacks = {"another expiry only": "has no 2027-01-15 calls chain of SPY",
             "a file without a row": "has a 2027-01-15 calls chain of SPY without a strike"}[newer]
    assert facts == [
        f"Newest snapshot not read: the snapshot of 2026-11-30T20:30:00Z {lacks}.",
        "Long leg: model strike 756 -> listed 756.",
        "Short leg: model strike 807 -> listed 807.",
        "Quote: Yahoo chain snapshot of 2026-11-30T17:30:00Z, delayed, not a live quote.",
    ]
    # The other expiry is read from the newer run, the only one that has it.
    assert _priced(tmp_path, _trade(expiry="2027-01-08"))[2]["asOf"] == "2026-11-30T20:30:00Z"
    # Without the older run inside the age rule there is nothing to name.
    (tmp_path / "2026-11-30" / "173000Z" / "SPY-2027-01-15-calls.csv").unlink()
    assert _refused(tmp_path) == _no_strikes(
        f"the snapshot of 2026-11-30T20:30:00Z {lacks}, and none of the 1 older ones since 2026-11-27 has it")



def test_a_run_that_reports_a_problem_but_stored_the_chains_is_read(tmp_path):
    report = "1 of 2 expiries without usable quotes"
    _chain(_run(tmp_path, "2026-11-30", "203000", errors={"SPY": report}), "SPY", "2027-01-15", "calls", SPY_CALLS)
    assert _priced(tmp_path)[2]["asOf"] == "2026-11-30T20:30:00Z"
    assert _refused(tmp_path, _trade(expiry="2027-01-08")) == _no_strikes(
        f"the snapshot of 2026-11-30T20:30:00Z has no 2027-01-08 calls chain of SPY ({report})",
        "2027-01-08 calls of SPY")


# 2026-12-18 is 30 days after 2026-11-18, 29 days after 2026-11-19 and 28 days after 2026-11-20.
DECEMBER = _trade(expiry="2026-12-18")
NOT_STORED = ["Listed strikes not checked: the chain store keeps expiries 30 to 75 days out, and 2026-12-18 is 28 days "
              "after the trading day; no snapshot holds it. These are the model's strikes.",
              "No quote: the chain is not stored."]


def test_the_stored_range_is_the_range_of_the_snapshot_script():
    text = gl.SNAPSHOT_SCRIPT.read_text()
    low, high = re.search(r"^DTE_RANGE = \((\d+), (\d+)\)", text, re.MULTILINE).groups()
    assert gl.stored_dte_range() == (int(low), int(high)) == (30, 75)
    # The script keeps an expiry when DTE_RANGE[0] <= days <= DTE_RANGE[1], counted from the day of the snapshot.
    assert "DTE_RANGE[0] <= (day - today).days <= DTE_RANGE[1]" in text


def test_a_range_of_days_that_is_not_one_is_refused(tmp_path, monkeypatch):
    script = tmp_path / "snapshot.py"
    script.write_text("DTE_RANGE = (75, 30)\n")
    monkeypatch.setattr(gl, "SNAPSHOT_SCRIPT", script)
    gl.stored_dte_range.cache_clear()
    try:
        with pytest.raises(gl.GoLiveError, match=r"DTE_RANGE of .*snapshot.py is not a range of days: \(75, 30\)"):
            gl.stored_dte_range()
    finally:
        gl.stored_dte_range.cache_clear()


def test_a_spread_whose_expiry_no_readable_snapshot_holds_has_model_strikes_and_no_quote(tmp_path):
    near = {"trade": DECEMBER, "oldest_day": "2026-11-19", "now": _at("2026-11-20"), "trading_day": "2026-11-20"}
    # 29 days after the last data day: no snapshot the run may read keeps it. No error, the model strikes, two
    # plain fact lines.
    assert _priced(tmp_path, **near) == (756.0, 807.0, None, NOT_STORED)
    assert all(len(fact) <= gl.FACT_MAX_CHARS for fact in NOT_STORED)
    # The rule reads the dates only: a store that does hold the chain changes nothing.
    _chain(_run(tmp_path, "2026-11-19", "203000"), "SPY", "2026-12-18", "calls", {757.0: (17.0, 17.1), 808.0: (0.7, 0.8)})
    assert _priced(tmp_path, **near) == (756.0, 807.0, None, NOT_STORED)
    # An entry further out than the store reaches: 2027-02-19 is 77 days after the trading day 2026-12-04.
    far = _trade(expiry="2027-02-19")
    (tmp_path / "empty").mkdir()
    long_strike, short_strike, quote, facts = _priced(tmp_path / "empty", far, oldest_day="2026-12-03",
                                                      trading_day="2026-12-04")
    assert (long_strike, short_strike, quote) == (756.0, 807.0, None)
    assert facts[0].startswith("Listed strikes not checked: the chain store keeps expiries 30 to 75 days out, and "
                               "2027-02-19 is 77 days after the trading day;")


@pytest.mark.parametrize(("expiry", "exempt"), [("2027-02-14", False), ("2027-02-15", True),
                                                ("2026-12-30", False), ("2026-12-29", True)])
def test_the_date_exemption_ends_at_the_bounds_of_the_store(tmp_path, expiry, exempt):
    # Trading day Tuesday 2026-12-01, last data day Monday 2026-11-30: 2027-02-14 is 75 days after the trading day,
    # 2026-12-30 is 30 days after the last data day (29 after the trading day), 2026-12-29 is 29 after it.
    trade = _trade(expiry=expiry)
    dates = {"oldest_day": "2026-11-30", "trading_day": "2026-12-01"}
    (tmp_path / "empty").mkdir()
    if exempt:
        assert _priced(tmp_path / "empty", trade, **dates)[2:3] == (None,)
    else:
        assert _refused(tmp_path / "empty", trade, **dates) == _no_strikes(
            "the chain store has no snapshot of SPY", f"{expiry} calls of SPY")


def test_an_expiry_a_readable_snapshot_can_hold_names_listed_strikes_or_refuses_the_run(tmp_path):
    # 30 days after the last data day: the snapshots of that day keep this expiry, so a missing chain is a fault.
    held = {"trade": DECEMBER, "oldest_day": "2026-11-18", "now": _at("2026-11-19"), "trading_day": "2026-11-19"}
    assert _refused(tmp_path, **held) == _no_strikes("the chain store has no snapshot of SPY", "2026-12-18 calls of SPY")
    _chain(_run(tmp_path, "2026-11-18", "203000"), "SPY", "2026-12-18", "calls", {756.0: (17.5, 17.6), 757.0: (17.0, 17.1),
                                                                                    808.0: (0.7, 0.8)})
    long_strike, short_strike, quote, _facts = _priced(tmp_path, **held)
    assert (long_strike, short_strike, quote["asOf"]) == (756.0, 808.0, "2026-11-18T20:30:00Z")
    # A Monday roll: 74 days after the trading day 2026-12-07, 77 after the last data day, Friday 2026-12-04. Only a
    # snapshot of the trading day keeps it. Until one is stored the run is refused; then every run of the day reads it.
    far, store = _trade(expiry="2027-02-19"), tmp_path / "far"
    dates = {"oldest_day": "2026-12-04", "trading_day": "2026-12-07", "now": datetime(2026, 12, 7, 18, tzinfo=UTC)}
    _chain(_run(store, "2026-12-04", "203000"), "SPY", "2027-01-15", "calls", {756.0: (20.0, 20.2)})
    assert _refused(store, far, **dates) == _no_strikes(
        "the snapshot of 2026-12-04T20:30:00Z has no 2027-02-19 calls chain of SPY", chain="2027-02-19 calls of SPY")
    _chain(_run(store, "2026-12-07", "173000"), "SPY", "2027-02-19", "calls", {755.0: (30.0, 30.4), 810.0: (5.0, 5.2)})
    assert _priced(store, far, **dates)[:2] == (755.0, 810.0)



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


def test_a_chain_file_that_is_not_text_refuses_the_run(tmp_path):
    run = _run(tmp_path, "2026-11-30", "203000")
    (run / "SPY-2027-01-15-calls.csv").write_bytes(b"strike,bid,ask\n\xff\xfe,1,2\n")
    with pytest.raises(gl.ChainStoreError, match="SPY-2027-01-15-calls.csv cannot be read"):
        _priced(tmp_path)


IDENTITY = ("sleeveKey", "symbol", "structure", "expiry", "longStrike", "shortStrike")  # the fields of the draft id


def _identity(document: dict) -> list[tuple]:
    return [tuple(item[field] for field in IDENTITY) for item in document["candidates"]]


def test_a_store_without_a_chain_of_a_candidate_refuses_the_run(tmp_path):
    # An empty store is no fault of its own on a day without a candidate ...
    assert _generate(FIRST_DAY, "2025-07-02", tmp_path, listed=False)["candidates"] == []
    # ... but a candidate without a listed chain is no order: no document, not model strikes.
    with pytest.raises(gl.NoChainError, match=r"No listed strikes for the 2026-12-18 calls of QQQ \(model strikes "
                                              r"\d+/\d+\): the chain store has no snapshot of QQQ\. A draft names "
                                              r"listed strikes only; no document\.$"):
        _generate("2026-11-11", "2026-11-12", tmp_path, listed=False)
    # One chain missing among the others refuses the run too.
    run = _list_model_strikes(tmp_path, _dataset("2026-11-11"), "2026-11-12")
    (run / "SPY-2026-12-18-calls.csv").unlink()  # the puts of SPY are still there
    with pytest.raises(gl.NoChainError, match="No listed strikes for the 2026-12-18 calls of SPY .*: the snapshot of "
                                              "2026-11-11T20:30:00Z has no 2026-12-18 calls chain of SPY"):
        _generate("2026-11-11", "2026-11-12", tmp_path)


def test_the_run_takes_no_strikes_from_a_snapshot_older_than_its_last_data_day(tmp_path):
    # Thursday 2026-11-12 from data through Wednesday: a snapshot of Tuesday is one trading day too old.
    data = _dataset("2026-11-11")
    _list_model_strikes(tmp_path, data, "2026-11-12", day="2026-11-10")
    with pytest.raises(gl.NoChainError, match=r"the newest chain snapshot of QQQ is of 2026-11-10 "
                                              r"\(2026-11-10T20:30:00Z\), older than 2026-11-11, the oldest day"):
        _generate("2026-11-11", "2026-11-12", tmp_path, listed=False)
    _list_model_strikes(tmp_path, data, "2026-11-12", shift=1.0)
    document = _generate("2026-11-11", "2026-11-12", tmp_path, listed=False)
    assert all(item["quote"]["asOf"] == "2026-11-11T20:30:00Z" for item in document["candidates"])


@needs_file_modes
@pytest.mark.parametrize("locked", ["store", "day", "run", "summary", "chain"])
def test_a_chain_store_that_cannot_be_read_refuses_the_run(tmp_path, mid_month, locked):
    store = tmp_path / "store"
    store.mkdir()
    assert _identity(_generate("2026-11-11", "2026-11-12", store)) == _identity(mid_month)
    run = store / "2026-11-11" / "203000Z"
    path = {"store": store, "day": run.parent, "run": run, "summary": run / "summary.json",
            "chain": run / "SPY-2026-12-18-calls.csv"}[locked]
    mode = path.stat().st_mode
    path.chmod(0)
    try:
        with pytest.raises(gl.ChainStoreError, match="cannot be read"):
            _generate("2026-11-11", "2026-11-12", store, listed=False)
    finally:
        path.chmod(mode)
    assert _identity(_generate("2026-11-11", "2026-11-12", store)) == _identity(mid_month)


def test_a_failed_fetch_in_a_newer_run_leaves_the_strikes_of_the_candidates_as_they_were(tmp_path, mid_month):
    _list_model_strikes(tmp_path, _dataset("2026-11-11"), "2026-11-12", shift=1.0, clock="173000")
    before = _generate("2026-11-11", "2026-11-12", tmp_path, listed=False)
    _run(tmp_path, "2026-11-11", "203000", symbols=qi.CORE7, errors=dict.fromkeys(qi.CORE7, NO_YAHOO))
    after = _generate("2026-11-11", "2026-11-12", tmp_path, listed=False)
    assert _identity(before) == _identity(after) and len(after["candidates"]) == 4
    assert all(item["longStrike"] == model["longStrike"] + 1
               for item, model in zip(after["candidates"], mid_month["candidates"]))
    assert all(item["quote"]["asOf"] == "2026-11-11T17:30:00Z" for item in after["candidates"])
    assert all(f"Newest snapshot not read: the {item['symbol']} chain fetch failed in the snapshot of "
               f"2026-11-11T20:30:00Z ({NO_YAHOO})." in item["signalFacts"] for item in after["candidates"])
    assert_collect_input(after)


def test_the_runs_of_one_trading_day_never_print_different_strikes(tmp_path, mid_month):
    """The store as the runs of Thursday 2026-11-12 find it, hour by hour: nothing fresh, the first snapshot of
    Wednesday, a second one with other listed strikes, a failed one, and one of Thursday without one expiry."""
    data = _dataset("2026-11-11")
    _list_model_strikes(tmp_path, data, "2026-11-12", shift=-1.0, day="2026-11-10")  # too old for this day
    printed, refused = [], 0

    def run_at(clock: str) -> None:
        nonlocal refused
        try:
            printed.append(_identity(_generate("2026-11-11", "2026-11-12", tmp_path, listed=False,
                                               now=datetime.fromisoformat(f"2026-11-12T{clock}+00:00"))))
        except gl.NoChainError:
            assert not printed  # a refusal comes only before the first usable snapshot
            refused += 1

    run_at("12:15:00")  # only the snapshot of Tuesday: no document
    _list_model_strikes(tmp_path, data, "2026-11-12", clock="173000")  # the model strikes themselves
    run_at("12:15:00")
    _list_model_strikes(tmp_path, data, "2026-11-12", shift=1.0, clock="203000")  # one strike step higher
    run_at("12:15:00")
    _run(tmp_path, "2026-11-12", "150000", symbols=qi.CORE7, errors=dict.fromkeys(qi.CORE7, NO_YAHOO))
    run_at("15:30:00")
    late = _list_model_strikes(tmp_path, data, "2026-11-12", shift=2.0, day="2026-11-12", clock="170000")
    (late / "SPY-2026-12-18-calls.csv").unlink()  # the run still has the puts of SPY
    run_at("17:40:00")
    assert refused == 1 and len(printed) == 4
    assert all(identity == _identity(mid_month) for identity in printed)  # the strikes of the first usable snapshot
    # The quote follows the newest usable chain: here it does not list the strikes of the first one.
    last = _generate("2026-11-11", "2026-11-12", tmp_path, listed=False,
                     now=datetime.fromisoformat("2026-11-12T17:40:00+00:00"))
    qqq = _one(last, gl.MODEL_HOLDS, "long-index", "QQQ")
    assert qqq["quote"] is None and qqq["signalFacts"][-1:] == [
        "No quote: the chain snapshot of 2026-11-12T17:00:00Z does not list both strikes."]
    spy = _one(last, gl.MODEL_HOLDS, "long-index", "SPY")
    assert spy["quote"] is None and spy["signalFacts"][-4].startswith("Newest snapshot not read: ") and [
        spy["signalFacts"][-4], spy["signalFacts"][-1]] == [
        "Newest snapshot not read: the snapshot of 2026-11-12T17:00:00Z has no 2026-12-18 calls chain of SPY.",
        "No quote: the chain snapshot of 2026-11-11T20:30:00Z does not list both strikes."]


def test_the_candidates_carry_the_listed_strikes_and_the_snapshot_quote(tmp_path, roll_day):
    # Tuesday 2026-12-01. Listed one dollar above each model strike, so every leg moves by one step.
    _list_model_strikes(tmp_path, _dataset("2026-11-30"), "2026-12-01", shift=1.0)
    document = _generate("2026-11-30", "2026-12-01", tmp_path)
    assert_collect_input(document)
    assert len(document["candidates"]) == len(roll_day["candidates"]) == 7
    for item, model in zip(document["candidates"], roll_day["candidates"]):
        assert (item["entryBasis"], item["sleeveKey"], item["symbol"], item["expiry"]) == (
            model["entryBasis"], model["sleeveKey"], model["symbol"], model["expiry"])
        if item["entryBasis"] == gl.MODEL_HOLDS:
            # Held since November, expiry 2026-12-18: 17 days out, which the chain store does not keep.
            assert item["expiry"] == "20261218" and item["quote"] is None
            assert (item["longStrike"], item["shortStrike"]) == (model["longStrike"], model["shortStrike"])
            assert item["signalFacts"][-2:] == [
                "Listed strikes not checked: the chain store keeps expiries 30 to 75 days out, and 2026-12-18 is 17 "
                "days after the trading day; no snapshot holds it. These are the model's strikes.",
                "No quote: the chain is not stored."]
            continue
        assert item["quote"] == {"asOf": "2026-11-30T20:30:00Z", "longAsk": 2.1, "longBid": 2.0, "shortAsk": 1.2,
                                 "shortBid": 1.0, "source": "yahoo_delayed_snapshot"}
        assert (item["longStrike"], item["shortStrike"]) == (model["longStrike"] + 1, model["shortStrike"] + 1)
        assert item["signalFacts"][-3:] == [
            f"Long leg: model strike {model['longStrike']:g} -> listed {item['longStrike']:g}.",
            f"Short leg: model strike {model['shortStrike']:g} -> listed {item['shortStrike']:g}.",
            "Quote: Yahoo chain snapshot of 2026-11-30T20:30:00Z, delayed, not a live quote.",
        ]
    # The fixture run listed the model strikes themselves.
    assert all(item["quote"] is not None for item in roll_day["candidates"] if item["entryBasis"] == gl.SIGNAL_TODAY)


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
    monkeypatch.setattr(gl, "price_candidate", lambda trade, runs, oldest_day, trading_day: priced(trade))
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
    """python -m golive on the synthetic data (`data`: another data set) at 14:00 UTC of the trading day.
    `chains`: the chain store, by default <tmp_path>/chains, which a test makes or leaves missing."""
    def study_data(root):
        assert root == tmp_path / "data"
        return SimpleNamespace(dataset=data or _dataset(last_day), facts=_facts())

    monkeypatch.setattr(cli.study, "load_study_data", load or study_data)
    out, err = io.StringIO(), io.StringIO()
    code = cli.main(["--data", str(tmp_path / "data"), "--chain-store", str(chains or tmp_path / "chains"),
                     "--trading-day", trading_day, "--now", f"{trading_day}T14:00:00"],
                    stdin=io.StringIO(json.dumps(_plan()) if stdin is None else stdin), stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


def test_main_prints_one_json_document_and_nothing_else(monkeypatch, tmp_path):
    (tmp_path / "chains").mkdir()
    run = _list_model_strikes(tmp_path / "chains", _dataset("2026-11-11"), "2026-11-12")
    (run / "SPY-2026-12-18-puts.csv").write_text(
        (run / "SPY-2026-12-18-puts.csv").read_text().replace(",1.0,1.2,", ",,,"))  # the short put has no bid and ask
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12")
    assert (code, err) == (0, "") and out.endswith("\n") and out.count("\n") == 1
    document = json.loads(out)
    assert_collect_input(document)
    assert document["generatedAt"] == "2026-11-12T14:00:00Z"  # --now without an offset is UTC
    assert _picked(document, gl.MODEL_HOLDS) == [
        ("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD"), ("vol-premium", "SPY")]
    spy = _one(document, gl.MODEL_HOLDS, "long-index", "SPY")
    assert spy["quote"]["source"] == "yahoo_delayed_snapshot" and spy["quote"]["asOf"] == "2026-11-11T20:30:00Z"
    assert _one(document, gl.MODEL_HOLDS, "vol-premium", "SPY")["quote"] is None


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


@pytest.mark.parametrize(("series_id", "day"), [("VIX3M", "2026-10-30"), ("VXN", "2026-11-02")])
def test_main_refuses_a_series_without_the_value_of_an_older_day_a_spread_rests_on(monkeypatch, tmp_path, series_id,
                                                                                   day):
    (tmp_path / "chains").mkdir()
    data = _dataset("2026-11-11")
    _list_model_strikes(tmp_path / "chains", data, "2026-11-12")
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12")
    assert (code, err) == (0, "") and len(json.loads(out)["candidates"]) == 4
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12", data=_drop(data, series_id, day))
    assert (code, out) == (1, "") and err.count("\n") == 1
    assert err.startswith(f"golive: The {series_id} history has no value on {day}: older days the tested data has "
                          "values for. ")


def test_main_refuses_a_candidate_without_listed_strikes(monkeypatch, tmp_path):
    (tmp_path / "chains").mkdir()  # a store without a snapshot
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-11", "2026-11-12")
    assert (code, out) == (1, "")
    assert re.fullmatch(r"golive: No listed strikes for the 2026-12-18 calls of QQQ \(model strikes \d+/\d+\): the "
                        r"chain store has no snapshot of QQQ\. A draft names listed strikes only; no document\.\n", err)


def test_main_keeps_the_model_strikes_of_a_held_spread_only_below_the_range_the_store_keeps(monkeypatch, tmp_path):
    (tmp_path / "chains").mkdir()  # a store without a snapshot
    # Thursday 2026-11-19: the spreads held expire on 2026-12-18, 30 days after the last data day. The snapshots of
    # that day keep the expiry, so a store without them is a fault.
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-18", "2026-11-19")
    assert (code, out) == (1, "") and err.startswith("golive: No listed strikes for the 2026-12-18 calls of QQQ")
    # Friday 2026-11-20: 29 days after the last data day. Not stored by design: the model strikes, no quote, no error.
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-19", "2026-11-20")
    assert (code, err) == (0, "")
    document = json.loads(out)
    assert_collect_input(document)
    assert _picked(document, gl.MODEL_HOLDS) == [
        ("long-index", "QQQ"), ("long-index", "SPY"), ("rotation", "GLD"), ("vol-premium", "SPY")]
    assert all(item["quote"] is None and item["signalFacts"][-2:] == NOT_STORED for item in document["candidates"])
    plan, data = _plan(), _dataset("2026-11-19")
    model = {(key, symbol): (long_strike, short_strike) for key, symbol, long_strike, short_strike
             in _held(data, "2026-11-20", plan)}
    assert all((item["longStrike"], item["shortStrike"]) == model[item["sleeveKey"], item["symbol"]]
               for item in document["candidates"])
    # Tuesday 2026-12-01: the held spreads are exempt, the entries of the day are not.
    code, out, err = _main(monkeypatch, tmp_path, "2026-11-30", "2026-12-01")
    assert (code, out) == (1, "") and err.startswith("golive: No listed strikes for the 2027-01-15 calls of QQQ")


def test_main_needs_its_arguments(capsys):
    with pytest.raises(SystemExit) as usage:
        cli.main(["--data", "x"], stdin=io.StringIO("{}"))
    assert usage.value.code == 2
    assert "--chain-store" in capsys.readouterr().err
