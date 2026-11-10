"""Academy modelled options backtest: the Python port and the NautilusTrader run match TypeScript.

academy-golden.json is written by scripts/research-academy-golden.ts from the TypeScript engine
(packages/academy/src/backtest.ts): all 19 structures on three synthetic daily series, rule
variants and input errors. Two checks per case:

- the float-ledger port (academy/simulator.py `run_model`) equals TypeScript to float precision;
  it needs no NautilusTrader and runs in the base lane;
- the NautilusTrader run (academy/engine.py `run_academy`) is inside the parity tolerances of
  docs/vertex-rebuild/nautilus-backtest-engine.md: the same trades in the same order, fill prices
  within 1e-6 (relative), equity within 1e-5 (relative) at every bar, Sharpe within 1e-3, max
  drawdown and total return within 1e-5, and the same input-error messages. These tests need
  nautilus-trader==1.227.0; without it they skip, unless VERTEX_REQUIRE_NAUTILUS=1 (the Nautilus
  CI run), where a missing engine is a failure.

Synthetic and committed fixture data only: no network, model or broker.
"""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import pytest

from nautilus_backtest.academy import engine as academy_engine
from nautilus_backtest.academy.model import STRUCTURES, js_number, norm_cdf, resolve_rules
from nautilus_backtest.academy.result import EXIT_REASONS, engine_result
from nautilus_backtest.academy.simulator import AcademyInput, iso_date, run_model
from nautilus_backtest.bars import InputError

RESEARCH = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((RESEARCH / "tests/fixtures/nautilus_backtest/academy-golden.json").read_text())
CASES = GOLDEN["cases"]
RUNS = [case for case in CASES if "result" in case]
ERRORS = [case for case in CASES if "error" in case]
# The port repeats the TypeScript arithmetic; only libm (exp, log) may differ in the last bits.
PORT_REL_TOL = 1e-9
# docs/vertex-rebuild/nautilus-backtest-engine.md "Parity tolerances".
EQUITY_REL_TOL = 1e-5
PRICE_REL_TOL = 1e-6
SHARPE_ABS_TOL = 1e-3
RETURN_ABS_TOL = 1e-5
# Nautilus prices have 9 decimals: a fill is at most half a tick from the modelled price. The ledger
# currency has 9 decimals too (engine.LEDGER_CURRENCY), so fees are not rounded to cents.
HALF_TICK = 0.5e-9
MONEY_KEYS = ("entryNet", "exitValue", "pnl")
STOCK_LOT = 100

pytestmark = pytest.mark.filterwarnings("ignore:The 'generic' unit for NumPy timedelta:DeprecationWarning")


def _installed() -> bool:
    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        academy_engine.require()
        return True
    try:
        academy_engine.require()
    except academy_engine.NautilusUnavailable:
        return False
    return True


needs_nautilus = pytest.mark.skipif(not _installed(), reason="nautilus-trader 1.227.0 not installed")


def _rel(left: float, right: float) -> float:
    return 0.0 if left == right else abs(left - right) / max(abs(left), abs(right), 1e-12)


def _request(case: dict) -> dict:
    series = GOLDEN["series"][case["series"]]
    size = case.get("bars")
    bars = {key: values if size is None else values[:size] for key, values in series.items()}
    return {"bars": bars, "structure": case["structure"], "rules": case["rules"], "capital": case["capital"]}


def _input(case: dict) -> AcademyInput:
    return AcademyInput.from_json(_request(case))


def _identity(trade: dict) -> tuple:
    return (trade["entryIndex"], trade["exitIndex"], trade["reason"], trade["role"], tuple(trade["legs"]),
            trade["units"], trade["entryT"], trade["exitT"], trade["spotEntry"], trade["spotExit"])


def _ids(cases: list[dict]) -> list[str]:
    return [case["id"] for case in cases]


def test_fixture_covers_every_structure_on_every_series():
    assert len(STRUCTURES) == 19
    for series in GOLDEN["series"]:
        covered = {case["structure"] for case in RUNS if case["series"] == series and not case["rules"]}
        assert covered == set(STRUCTURES), series
    reasons = {trade["reason"] for case in RUNS for trade in case["result"]["trades"]}
    assert reasons == set(EXIT_REASONS)
    for structure in STRUCTURES:
        assert any(case["result"]["trades"] for case in RUNS if case["structure"] == structure), structure


@pytest.mark.parametrize("case", RUNS, ids=_ids(RUNS))
def test_port_matches_typescript(case):
    got = run_model(_input(case))
    want = case["result"]
    assert [_identity(trade) for trade in got["trades"]] == [_identity(trade) for trade in want["trades"]]
    for mine, theirs in zip(got["trades"], want["trades"], strict=True):
        for key in (*MONEY_KEYS, "costs"):
            assert math.isclose(mine[key], theirs[key], rel_tol=PORT_REL_TOL, abs_tol=1e-9), key
    assert got["firstIndex"] == want["firstIndex"]
    assert len(got["equity"]) == len(want["equity"])
    assert max(_rel(a, b) for a, b in zip(got["equity"], want["equity"], strict=True)) <= PORT_REL_TOL
    assert got["rules"] == want["rules"]
    assert got["assumptions"] == want["assumptions"]
    assert got["ivSource"] == want["ivSource"]
    for key, value in want["stats"].items():
        if value is None:
            assert got["stats"][key] is None, key
        else:
            assert math.isclose(got["stats"][key], value, rel_tol=PORT_REL_TOL, abs_tol=1e-9), key


@pytest.mark.parametrize("case", ERRORS, ids=_ids(ERRORS))
def test_port_gives_the_typescript_input_error(case):
    with pytest.raises(InputError) as raised:
        run_model(_input(case))
    assert str(raised.value) == case["error"]


def test_rules_and_inputs_are_checked():
    with pytest.raises(InputError, match="^dte must be a finite number$"):
        resolve_rules("long_call", {"dte": math.inf})
    with pytest.raises(InputError, match="^dte must be a finite number$"):
        resolve_rules("long_call", {"dte": "45"})
    with pytest.raises(InputError, match="^straddle is not an Academy structure$"):
        resolve_rules("straddle", {})
    request = _request(RUNS[0])
    with pytest.raises(InputError, match="^capital must be a positive number$"):
        AcademyInput.from_json({**request, "capital": 0})
    with pytest.raises(InputError, match="^bars.c must hold finite numbers$"):
        AcademyInput.from_json({**request, "bars": {**request["bars"], "c": [1.0, None]}})
    assert resolve_rules("long_call", {"dte": 45})["dte"] == 45


def test_javascript_number_text_and_normal_distribution():
    assert [js_number(value) for value in (430.0, 432.5, 2, 0.65, 1.1)] == ["430", "432.5", "2", "0.65", "1.1"]
    # JavaScript's notation: positional from 1e-6 up to 1e21, else an exponent without padding.
    assert [js_number(value) for value in (0.00001, 0.000001, 1e-7, 1.5e-7, 1e20, 1e21, 1.25e22, -0.5, 0, 123456789.125)] == [
        "0.00001", "0.000001", "1e-7", "1.5e-7", "100000000000000000000", "1e+21", "1.25e+22", "-0.5", "0",
        "123456789.125"]
    # Whole numbers from 2**53 up: JavaScript prints the shortest digits, not the exact value.
    assert js_number(25732502797880530.0) == "25732502797880530"
    assert js_number(9007199254740991.0) == "9007199254740991"
    assert js_number(-0.0) == "0"
    assert norm_cdf(0) == 0.5
    assert math.isclose(norm_cdf(1.96), 0.9750021048517795, rel_tol=1e-12)
    assert math.isclose(norm_cdf(-8) + norm_cdf(8), 1.0, rel_tol=1e-12)
    assert norm_cdf(-40) == 0.0


def test_engine_result_maps_an_academy_result():
    case = next(item for item in RUNS if item["id"] == "pmcc:mid")
    data = _input(case)
    mapped = engine_result(run_model(data), data)
    want = case["result"]
    assert len(mapped["equity"]) == len(data.t)
    assert mapped["equity"][:20] == [1.0] * 20
    assert math.isclose(mapped["equity"][-1], want["equity"][-1] / data.capital, rel_tol=PORT_REL_TOL)
    assert [(t["entryIndex"], t["exitIndex"], t["exitReason"]) for t in mapped["trades"]] == [
        (t["entryIndex"], t["exitIndex"], EXIT_REASONS[t["reason"]]) for t in want["trades"]]
    first, source = mapped["trades"][0], want["trades"][0]
    assert first["entryPrice"] == source["spotEntry"]
    assert first["exitPrice"] == source["spotExit"]
    assert math.isclose(first["pnl"], source["pnl"] / data.capital, rel_tol=PORT_REL_TOL)
    assert math.isclose(first["units"], source["units"] / data.capital, rel_tol=PORT_REL_TOL)
    assert math.isclose(first["netReturn"], source["pnl"] / abs(source["entryNet"]), rel_tol=PORT_REL_TOL)
    stats = mapped["stats"]
    assert stats["bars"] == len(data.t)
    assert stats["trades"] == len(want["trades"])
    assert math.isclose(stats["totalReturn"], want["stats"]["totalReturn"], rel_tol=PORT_REL_TOL)
    assert math.isclose(stats["maxDrawdown"], want["stats"]["maxDrawdown"], rel_tol=PORT_REL_TOL)


@pytest.mark.parametrize("case", RUNS, ids=_ids(RUNS))
def test_engine_result_matches_the_typescript_mapping(case):
    """The API recomputes the statistics of a worker result and refuses a difference above 1e-9."""
    data = _input(case)
    mapped = engine_result(run_model(data), data)
    want = case["result"]["engine"]
    assert [[t["entryIndex"], t["exitIndex"], t["exitReason"]] for t in mapped["trades"]] == want["trades"]
    assert set(mapped["stats"]) == set(want["stats"])
    for key, value in want["stats"].items():
        if value is None:
            assert mapped["stats"][key] is None, key
        else:
            assert math.isclose(mapped["stats"][key], value, rel_tol=PORT_REL_TOL, abs_tol=1e-12), key


def test_engine_result_refuses_an_equity_at_or_below_zero():
    case = RUNS[0]
    data = _input(case)
    result = run_model(data)
    result["equity"][5] = 0.0
    with pytest.raises(InputError, match="fell to zero or below"):
        engine_result(result, data)


# ---------------------------------------------------------------- NautilusTrader

def _leg_quantity(label: str) -> int:
    """Shares or contracts x 100 of a leg label ("Long 900 shares", "Short 9 109 call 2022-03-02")."""
    words = label.split()
    return int(words[1]) if words[2] == "shares" else int(words[1]) * STOCK_LOT


@needs_nautilus
@pytest.mark.parametrize("case", RUNS, ids=_ids(RUNS))
def test_nautilus_run_matches_typescript(case):
    data = _input(case)
    got = academy_engine.run_academy(data)
    want = case["result"]
    assert got["engine"] == "nautilus-trader-1.227.0"
    assert got["modelVersion"] == academy_engine.ACADEMY_MODEL_VERSION
    # The same trades in the same order: bars, reason, role, legs (strike, expiry, contracts), units.
    assert [_identity(trade) for trade in got["trades"]] == [_identity(trade) for trade in want["trades"]]
    # Fill prices: every leg fill is the modelled price on the 9-decimal price grid.
    model = run_model(data)
    for mine, ported, theirs in zip(got["trades"], model["trades"], want["trades"], strict=True):
        quantity = 0
        for label, fill, modelled in zip(mine["legs"], mine["legFills"], ported["legFills"], strict=True):
            quantity += _leg_quantity(label)
            for side in ("entry", "exit"):
                assert abs(fill[side] - modelled[side]) <= HALF_TICK * 1.01, (label, side)
                assert _rel(fill[side], modelled[side]) <= PRICE_REL_TOL or modelled[side] < 1e-3, (label, side)
        # The cash of the fills: relative tolerance, or the price grid on a value near zero.
        for key in MONEY_KEYS:
            assert math.isclose(mine[key], theirs[key], rel_tol=PRICE_REL_TOL,
                                abs_tol=2 * quantity * HALF_TICK * 1.01), key
        assert math.isclose(mine["costs"], theirs["costs"], rel_tol=PORT_REL_TOL, abs_tol=1e-9)
    assert len(got["equity"]) == len(want["equity"])
    assert max(_rel(a, b) for a, b in zip(got["equity"], want["equity"], strict=True)) <= EQUITY_REL_TOL
    stats, reference = got["stats"], want["stats"]
    assert abs(stats["sharpe"] - reference["sharpe"]) <= SHARPE_ABS_TOL
    assert abs(stats["totalReturn"] - reference["totalReturn"]) <= RETURN_ABS_TOL
    assert abs(stats["maxDrawdown"] - reference["maxDrawdown"]) <= RETURN_ABS_TOL
    assert abs(stats["cagr"] - reference["cagr"]) <= RETURN_ABS_TOL
    assert _rel(stats["finalEquity"], reference["finalEquity"]) <= EQUITY_REL_TOL
    for key in ("trades", "wins", "winRate", "exposure", "benchmarkReturn"):
        assert stats[key] == pytest.approx(reference[key], rel=PORT_REL_TOL, abs=1e-12), key
    assert got["assumptions"] == want["assumptions"]
    assert got["rules"] == want["rules"]
    assert got["ivSource"] == want["ivSource"]


@needs_nautilus
@pytest.mark.parametrize("case", ERRORS, ids=_ids(ERRORS))
def test_nautilus_run_gives_the_typescript_input_error(case):
    with pytest.raises(InputError) as raised:
        academy_engine.run_academy(_input(case))
    assert str(raised.value) == case["error"]


@needs_nautilus
def test_nautilus_run_is_deterministic():
    data = _input(next(item for item in RUNS if item["id"] == "iron_condor:mid"))
    assert academy_engine.run_academy(data) == academy_engine.run_academy(data)


@needs_nautilus
def test_nautilus_run_refuses_bars_before_1970():
    request = _request(RUNS[0])
    times = [time - 2_000_000_000_000 for time in request["bars"]["t"]]
    data = AcademyInput.from_json({**request, "bars": {**request["bars"], "t": times}})
    assert run_model(data)["trades"]
    with pytest.raises(InputError, match="^Bar times before 1970 cannot run on Nautilus$"):
        academy_engine.run_academy(data)


@needs_nautilus
def test_nautilus_ledger_keeps_nine_decimals_when_the_currency_code_was_registered_before():
    from nautilus_trader.model.enums import CurrencyType
    from nautilus_trader.model.objects import Currency

    # What Nautilus registers when the unknown code is looked up first: a crypto currency, 8 decimals.
    Currency.register(Currency(academy_engine.LEDGER_CURRENCY, 8, 0, "USDX", CurrencyType.CRYPTO), overwrite=True)
    assert Currency.from_str(academy_engine.LEDGER_CURRENCY).precision == 8
    case = next(item for item in RUNS if item["id"] == "long_put:low:small-capital")
    got = academy_engine.run_academy(_input(case))
    assert max(_rel(a, b) for a, b in zip(got["equity"], case["result"]["equity"], strict=True)) <= 1e-8
    assert Currency.from_str(academy_engine.LEDGER_CURRENCY).precision == 9


@needs_nautilus
def test_nautilus_run_refuses_bar_times_that_do_not_increase():
    request = _request(RUNS[0])
    times = list(request["bars"]["t"])
    times[30] = times[29]
    with pytest.raises(InputError, match="^Bar times must be strictly increasing$"):
        academy_engine.run_academy(AcademyInput.from_json({**request, "bars": {**request["bars"], "t": times}}))


def _cli(*args: str, stdin: dict) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "nautilus_backtest", *args], cwd=RESEARCH, input=json.dumps(stdin),
                          capture_output=True, text=True, check=False, timeout=300)


def _ohlc(request: dict) -> dict:
    closes = request["bars"]["c"]
    return {"t": request["bars"]["t"], "o": closes, "h": closes, "l": closes, "c": closes}


def _spec(request: dict, **rule) -> dict:
    return {"rule": {"kind": "academy", "structure": request["structure"], "rules": request["rules"], **rule},
            "initialCapital": request["capital"], "costBps": 0, "stopLossPct": 0, "takeProfitPct": 0}


@needs_nautilus
def test_cli_runs_an_academy_rule_in_the_engine_result_shape():
    case = next(item for item in RUNS if item["id"] == "covered_call:high")
    request = _request(case)
    done = _cli("run", "-", stdin={"bars": _ohlc(request), "spec": _spec(request, iv=request["bars"]["iv"])})
    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout)
    data = _input(case)
    assert {key: result[key] for key in ("equity", "trades", "stats")} == engine_result(
        academy_engine.run_academy(data), data)
    assert result["engine"] == "nautilus-trader-1.227.0"
    assert result["capital"] == case["capital"]
    assert result["stats"]["bars"] == len(result["equity"]) == len(request["bars"]["t"])
    assert all(value > 0 for value in result["equity"])
    assert {trade["exitReason"] for trade in result["trades"]} <= {"signal", "stop", "target", "end"}
    assert abs(result["stats"]["totalReturn"] - case["result"]["stats"]["totalReturn"]) <= RETURN_ABS_TOL


@needs_nautilus
def test_cli_batch_runs_an_academy_case_on_its_slice_and_reports_input_errors():
    case = next(item for item in RUNS if item["id"] == "long_call:mid:min-bars")
    series = GOLDEN["series"]["mid"]
    whole = {"bars": {"t": series["t"], "c": series["c"]}, "structure": "long_call", "rules": {}, "capital": 1}
    request = _request(case)
    done = _cli("batch", "-", "-", stdin={"bars": _ohlc(whole), "cases": [
        {"id": "ok", "spec": _spec(request), "slice": [0, 60]},
        {"id": "short", "spec": _spec(request), "slice": [0, 59]},
        {"id": "iv", "spec": _spec(request, iv=[0.2, None]), "slice": [0, 60]},
        {"id": "rule", "spec": _spec({**request, "rules": {"coreDte": 90}}), "slice": [0, 60]},
    ]})
    assert done.returncode == 0, done.stderr
    results = {item["id"]: item for item in json.loads(done.stdout)["results"]}
    assert results["ok"]["result"]["stats"]["bars"] == 60
    assert abs(results["ok"]["result"]["stats"]["totalReturn"]
               - case["result"]["stats"]["totalReturn"]) <= RETURN_ABS_TOL
    assert results["short"]["error"] == "the backtest needs at least 60 daily bars"
    assert results["iv"]["error"] == "rule.iv must hold one value per bar"
    assert results["rule"]["error"] == "coreDte is not a rule of long_call"


@needs_nautilus
def test_cli_academy_command_prints_the_academy_result_and_exits_2_on_an_input_error():
    case = next(item for item in RUNS if item["id"] == "iron_butterfly:low")
    done = _cli("academy", "-", stdin=_request(case))
    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout)
    assert [trade["reason"] for trade in result["trades"]] == [trade["reason"] for trade in case["result"]["trades"]]
    assert _rel(result["stats"]["finalEquity"], case["result"]["stats"]["finalEquity"]) <= EQUITY_REL_TOL
    failed = _cli("academy", "-", stdin=_request(ERRORS[0]))
    assert failed.returncode == 2
    assert json.loads(failed.stdout) == {"error": ERRORS[0]["error"]}


def test_iso_date_is_the_javascript_date_text():
    day = 86_400_000
    assert iso_date(0) == "1970-01-01"
    assert iso_date(1_709_164_800_000) == "2024-02-29"
    assert iso_date(1_709_164_800_000 + day - 1) == "2024-02-29"
    assert iso_date(-1) == "1969-12-31"
    assert iso_date(951_782_400_000) == "2000-02-29"
    assert iso_date(4_102_444_800_000) == "2100-01-01"
    # new Date(260_000_000_000_000).toISOString().slice(0, 10) and new Date(-62_200_000_000_000)...
    assert iso_date(260_000_000_000_000) == "+010209-01"
    assert iso_date(-62_200_000_000_000) == "-000002-12"
    assert iso_date(253_402_300_799_999) == "9999-12-31"
    # A fractional time truncates toward zero; beyond 8.64e15 ms JavaScript has no date.
    assert iso_date(-0.5) == "1970-01-01"
    assert iso_date(86_399_999.9) == "1970-01-01"
    assert iso_date(-62_167_219_200_000.5) == "0000-01-01"
    with pytest.raises(InputError, match="^Invalid time value$"):
        iso_date(8_640_000_000_000_001)


def test_a_huge_days_to_expiry_runs_in_the_port_and_is_an_input_error_on_nautilus():
    request = {**_request(RUNS[0]), "structure": "call_debit_spread", "rules": {"dte": 3_000_000}}
    data = AcademyInput.from_json(request)
    labels = [leg for trade in run_model(data)["trades"] for leg in trade["legs"]]
    assert labels and all(label.split()[-1].startswith("+0102") for label in labels)
    if _installed():
        with pytest.raises(InputError, match="^An option expiry after the year 2262 cannot run on Nautilus$"):
            academy_engine.run_academy(data)


@needs_nautilus
def test_nautilus_run_fills_whole_quantities_that_a_float_cannot_hold():
    """float(Quantity.from_int(950100)) is not 950100.0; the fill check compares whole numbers."""
    case = next(item for item in RUNS if item["id"] == "covered_call:mid")
    data = AcademyInput.from_json({**_request(case), "capital": 100_000_000})
    got = academy_engine.run_academy(data)
    want = run_model(data)
    assert [_identity(trade) for trade in got["trades"]] == [_identity(trade) for trade in want["trades"]]
    assert any("Long 950100 shares" in trade["legs"] for trade in got["trades"])
    assert max(_rel(a, b) for a, b in zip(got["equity"], want["equity"], strict=True)) <= EQUITY_REL_TOL


@needs_nautilus
def test_nautilus_run_stops_when_it_leaves_the_modelled_plan(monkeypatch):
    """The quotes exist for the first pass's openings only: another bar or contract is an error."""
    data = _input(next(item for item in RUNS if item["id"] == "long_call:mid"))
    real = academy_engine._plan

    def shifted(value):
        plan, contracts = real(value)
        plan.opened[0].open_index += 1
        return plan, contracts

    monkeypatch.setattr(academy_engine, "_plan", shifted)
    with pytest.raises(RuntimeError, match="left the modelled plan"):
        academy_engine.run_academy(data)
