"""Long option proxy of the allocation sensitivity study (research/backtests/allocation/sensitivity.py):
the structure overrides, the scenario list and the decision rule.
Synthetic inputs; no network, no database, no NautilusTrader."""
import copy
import importlib.util
import sys
from pathlib import Path

import pytest

from strategies.qc_ports import allocation as al
from strategies.qc_ports import book
from strategies.qc_ports import ideas as qi
from strategies.qc_ports import portfolio as pf
from tests.qc_ports_synthetic import trading_days

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "research" / "backtests" / "allocation" / "sensitivity.py"
ALWAYS_ON = "gold-fed-model/B"  # always on, monthly roll of the GLD call vertical
INDEX_OF = {"SPY": "VIX", "QQQ": "VXN", "DIA": "VXD", "IWM": "RVX", "GLD": "GVZ", "SLV": "VXSLV", "USO": "OVX"}
PROXY = {"structure": "longProxy"}


@pytest.fixture(scope="module")
def sens():
    spec = importlib.util.spec_from_file_location("allocation_sensitivity", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["allocation_sensitivity"] = module
    spec.loader.exec_module(module)
    return module


def _definition() -> dict:
    """A debit call block at the top, and a debit put leg and a credit put leg in the portfolio."""
    return {"name": "synthetic", "options": dict(qi.MONTHLY_CALL),
            "portfolio": {"legs": [{"options": dict(qi.MONTHLY_PUT)}, {"options": dict(qi.PUT_CREDIT)}, {"entry": []}]}}


# --------------------------------------------------------------------------- restructure

def test_long_proxy_widens_every_debit_vertical_and_nothing_else(sens):
    definition = _definition()
    before = copy.deepcopy(definition)
    made = sens.restructure(definition, PROXY)
    assert definition == before  # the input is not mutated
    assert made["options"] == {**qi.MONTHLY_CALL, "widthSigma": 3.0}
    put, credit, bare = made["portfolio"]["legs"]
    assert put["options"] == {**qi.MONTHLY_PUT, "widthSigma": 3.0}
    assert credit["options"] == qi.PUT_CREDIT
    assert bare == {"entry": []}
    for options in (made["options"], put["options"]):
        assert options["dte"] == {"target": 60, "min": 45} and options["longDelta"] == 0.5
        assert book.parse_options(options).width_sigma == 3.0


def test_the_proxy_keeps_the_expiry_of_a_30_day_candidate(sens):
    made = sens.restructure({"options": dict(qi.HOST_CALL)}, PROXY)
    assert made["options"] == {**qi.HOST_CALL, "widthSigma": 3.0}
    assert made["options"]["dte"] == {"target": 30, "min": 21}


def test_rewritten_blocks_do_not_share_the_override(sens):
    made = sens.restructure(_definition(), PROXY)
    made["options"]["widthSigma"] = 1.0
    assert sens.STRUCTURE_OVERRIDES["longProxy"] == {"widthSigma": 3.0}
    assert made["portfolio"]["legs"][0]["options"]["widthSigma"] == 3.0


def test_wide_itm_is_unchanged(sens):
    made = sens.restructure(_definition(), {"costs": "liquid", "structure": "wideItm"})
    assert made["options"] == {**qi.MONTHLY_CALL, "longDelta": 0.7, "widthSigma": 2.0}
    assert made["portfolio"]["legs"][1]["options"] == qi.PUT_CREDIT


def test_a_scenario_without_structure_returns_the_same_object(sens):
    definition = _definition()
    assert sens.restructure(definition, {"costs": "none"}) is definition


def test_an_unknown_structure_is_refused(sens):
    with pytest.raises(ValueError, match="longProxi"):
        sens.restructure(_definition(), {"structure": "longProxi"})


# --------------------------------------------------------------------------- scenarios

def test_the_proxy_scenarios_reuse_the_cost_models(sens):
    assert sens.SCENARIOS["longProxy"] == {"structure": "longProxy"}
    assert sens.SCENARIOS["longProxyNoCosts"] == {**sens.SCENARIOS["noCosts"], "structure": "longProxy"}
    assert sens.SCENARIOS["longProxyCalibrated"] == {**sens.SCENARIOS["calibrated"], "structure": "longProxy"}
    assert all(sens.SCENARIOS[name]["structure"] == "longProxy" for name in sens.PROXY_SCENARIOS)


def test_scenarios_with_measured_costs_need_the_chain_snapshot(sens):
    every = list(sens.SCENARIOS)
    assert sens.scenario_names(Path("summary.json")) == every
    without = sens.scenario_names(None)
    assert without == [name for name in every if name not in ("calibrated", "longProxyCalibrated")]
    assert without[:6] == ["base", "noCosts", "liquidCosts", "flatCallSkew", "realistic", "realisticWideItm"]


# --------------------------------------------------------------------------- the proxy through the pricing path

def _market_data(days: int = 260):
    dates = list(trading_days("2023-01-03", days))
    rows = {}
    for number, symbol in enumerate(qi.CORE7):
        closes = [100.0 * (1 + number) * 1.0005 ** n for n in range(days)]
        rows[symbol] = {"dates": dates, **{key: list(closes) for key in ("open", "high", "low", "close", "adjClose")}}
        rows[INDEX_OF[symbol]] = {"dates": dates, "close": [16.0] * days}
    rows["VIX3M"] = {"dates": dates, "close": [18.0] * days}
    rows["IRX"] = {"dates": dates, "close": [1.0] * days}
    start = {symbol: dates[0] for symbol in qi.CORE7}
    starts = {idea: dict(start) for idea in ("qc-asset-class-trend", "qc-futures-trend-carry", "qc-momentum-rotation",
                                             "qc-same-month-seasonality")}
    starts["qc-gold-fed-model"] = {"GLD": dates[0]}
    starts["qc-oil-predicts-equity"] = {"SPY": dates[0], "QQQ": dates[0]}
    facts = qi.Facts(iv_start=start, iv_rank_join=start, starts=starts, gold_last_input=dates[-1])
    return pf.dataset_from_rows(rows), facts, dates


def test_the_proxy_block_prices_through_the_owner_rule(sens):
    data, facts, dates = _market_data()
    run = qi.family(facts)[ALWAYS_ON]
    base = al.owner_rule_trades(run.definition, data, start=dates[0])
    proxy = al.owner_rule_trades(sens.restructure(run.definition, PROXY), data, start=dates[0])
    assert base and len(proxy) == len(base)
    for plain, wide in zip(base, proxy):
        assert (wide.symbol, wide.entry_date, wide.expiry, wide.long_strike) == (
            plain.symbol, plain.entry_date, plain.expiry, plain.long_strike)
        assert wide.width > 2.5 * plain.width  # 3 sigma against 1 sigma, on the strike grid
        assert wide.entry_price > plain.entry_price  # the far short leg pays for less of the long leg
        assert wide.max_loss > plain.max_loss


# --------------------------------------------------------------------------- the decision rule

G4 = ("G4 Sharpe >= 0.5", "G4 out-of-sample Sharpe >= 0.5")


def _row(sharpe=0.6, oos=0.6, *, role="strategy", duplicate=None, restructured=True, deflated=0.4):
    checks = al.gate_checks({"trades": 40, "sharpe": sharpe, "oosSharpe": oos, "deflatedSharpe": deflated,
                             "maxDrawdown": -0.1, "monteCarlo": {"probabilityOfProfit": 0.9, "drawdownP5": -0.2}}, None)
    return {"role": role, "duplicateOf": duplicate, "restructured": restructured, "sharpe": sharpe, "oosSharpe": oos,
            "deflatedSharpe": deflated, "checks": checks}


def _scenarios(study=(), no_costs=(), calibrated=()):
    fail = {"a/A": _row(0.42, 0.17)}
    return {"base": {"a/A": _row(0.9, 0.9, restructured=False)},
            "longProxy": {**fail, **dict(study)},
            "longProxyNoCosts": {**fail, **dict(no_costs)},
            "longProxyCalibrated": {**fail, **dict(calibrated)}}


def test_no_when_no_run_counts_in_any_of_the_three_scenarios(sens):
    decision = sens.proxy_decision(_scenarios())
    assert decision["outcome"] == "no"
    assert decision["runs"] == {name: [] for name in sens.PROXY_SCENARIOS}
    assert decision["scenarios"] == list(sens.PROXY_SCENARIOS)
    assert decision["floors"] == {"sharpe": al.GATE["minSharpe"], "oosSharpe": al.GATE["minOosSharpe"]}
    assert decision["rule"] == sens.PROXY_RULE


def test_candidate_when_a_run_counts_in_the_study_model(sens):
    decision = sens.proxy_decision(_scenarios(study={"b/A": _row(0.55, 0.5)}, no_costs={"b/A": _row(0.7, 0.6)}))
    assert decision["outcome"] == "candidate"
    assert decision["runs"]["longProxy"] == [
        {"key": "b/A", "sharpe": 0.55, "oosSharpe": 0.5, "deflatedSharpe": 0.4, "failed": ["G5 deflated Sharpe >= 0.95"]}]
    assert [run["key"] for run in decision["runs"]["longProxyNoCosts"]] == ["b/A"]


@pytest.mark.parametrize("where", ["no_costs", "calibrated"])
def test_model_dependent_when_only_another_cost_model_has_a_run(sens, where):
    decision = sens.proxy_decision(_scenarios(**{where: {"b/A": _row()}}))
    assert decision["outcome"] == "model-dependent"
    assert decision["runs"]["longProxy"] == []


def test_incomplete_when_a_proxy_scenario_is_missing_and_nothing_counts(sens):
    scenarios = _scenarios()
    del scenarios["longProxyCalibrated"]
    decision = sens.proxy_decision(scenarios)
    assert decision["outcome"] == "incomplete"
    assert decision["scenarios"] == ["longProxy", "longProxyNoCosts"]


@pytest.mark.parametrize("row", [
    _row(0.49, 0.9),                      # below the Sharpe floor
    _row(0.9, 0.49),                      # below the out-of-sample floor
    _row(None, 0.9),                      # no Sharpe
    _row(duplicate="a/A"),                # the equity curve of another run
    _row(role="overlay"),
    _row(role="host"),
    _row(role="reference"),
    _row(restructured=False),             # the proxy did not change the definition
])
def test_a_run_that_does_not_count_triggers_nothing(sens, row):
    assert sens.proxy_decision(_scenarios(study={"b/A": row}))["outcome"] == "no"


def test_the_g4_check_names_are_the_ones_the_rule_reads():
    names = [check["check"] for check in al.gate_checks({}, None)]
    assert [name for name in names if name.startswith("G4")] == list(G4)
