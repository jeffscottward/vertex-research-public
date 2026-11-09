"""NautilusTrader backtest engine: parity with the TypeScript engine on the golden cases.

golden.json is written by scripts/research-nautilus-golden.ts from the TS engine
(packages/api/src/instant-backtest-engine.ts and strategy-dsl-compile.ts). Every
engine case must give the same trades (entry bar, exit bar, exit reason) and the
same fill prices, and unit equity within EQUITY_REL_TOL. The parity tests need
nautilus-trader==1.227.0 (requirements-nautilus-linux-py312.lock). Without it they
skip, unless VERTEX_REQUIRE_NAUTILUS=1 (the Nautilus CI run), where a missing
engine is a failure. Synthetic and committed fixture data only: no network,
model or broker.
"""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import pytest

from nautilus_backtest import engine
from nautilus_backtest.bars import Bars, InputError
from nautilus_backtest.signals import Compiled, RunOptions

RESEARCH = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((RESEARCH / "tests/fixtures/nautilus_backtest/golden.json").read_text())
# Fees are booked in whole cents and Nautilus prices and quantities have 9 decimals.
EQUITY_REL_TOL = 1e-5
PRICE_REL_TOL = 1e-9
SHARPE_ABS_TOL = 1e-3

pytestmark = pytest.mark.filterwarnings("ignore:The 'generic' unit for NumPy timedelta:DeprecationWarning")


def _installed() -> bool:
    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        engine.require()
        return True
    try:
        engine.require()
    except engine.NautilusUnavailable:
        return False
    return True


needs_nautilus = pytest.mark.skipif(not _installed(), reason="nautilus-trader 1.227.0 not installed")
BARS = {key: Bars.from_columns(columns) for key, columns in GOLDEN["bars"].items()}


def _rel(left: float, right: float) -> float:
    return 0.0 if left == right else abs(left - right) / max(abs(left), abs(right), 1e-12)


@needs_nautilus
@pytest.mark.parametrize("case", GOLDEN["engine"], ids=[case["id"] for case in GOLDEN["engine"]])
def test_golden_case_matches_typescript(case):
    result = engine.run_spec(BARS[case["symbol"]], case["spec"])
    expected = [(t["entryIndex"], t["exitIndex"], t["exitReason"]) for t in case["trades"]]
    assert [(t["entryIndex"], t["exitIndex"], t["exitReason"]) for t in result.trades] == expected
    for want, got in zip(case["trades"], result.trades):
        assert _rel(want["entryPrice"], got["entryPrice"]) <= PRICE_REL_TOL
        assert _rel(want["exitPrice"], got["exitPrice"]) <= PRICE_REL_TOL
        assert ("costs" in want) == ("costs" in got)
    assert len(result.equity) == len(case["equity"])
    assert max(_rel(a, b) for a, b in zip(case["equity"], result.equity)) <= EQUITY_REL_TOL
    want_sharpe, got_sharpe = case["stats"]["sharpe"], result.stats["sharpe"]
    assert (want_sharpe is None) == (got_sharpe is None)
    if want_sharpe is not None:
        assert abs(want_sharpe - got_sharpe) <= SHARPE_ABS_TOL
    assert abs(case["stats"]["maxDrawdown"] - result.stats["maxDrawdown"]) <= EQUITY_REL_TOL
    assert result.stats["trades"] == case["stats"]["trades"]
    assert result.stats["exposure"] == case["stats"]["exposure"]


@needs_nautilus
def test_both_levels_in_one_bar_fill_the_stop_first():
    case = next(case for case in GOLDEN["engine"] if case["id"] == "synthetic:bothHit")
    reasons = [trade["exitReason"] for trade in engine.run_spec(BARS[case["symbol"]], case["spec"]).trades]
    assert "stop" in reasons and reasons == [trade["exitReason"] for trade in case["trades"]]


@needs_nautilus
def test_result_json_has_the_engine_id_and_no_nan():
    case = GOLDEN["engine"][0]
    payload = engine.run_spec(BARS[case["symbol"]], case["spec"]).to_json()
    assert payload["engine"] == "nautilus-trader-1.227.0"
    json.dumps(payload, allow_nan=False)
    assert all(math.isfinite(value) for value in payload["equity"])


@needs_nautilus
def test_cli_run_and_input_error(tmp_path):
    case = GOLDEN["engine"][0]
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"bars": GOLDEN["bars"][case["symbol"]], "spec": case["spec"]}))
    done = subprocess.run([sys.executable, "-m", "nautilus_backtest", "run", str(request)], cwd=RESEARCH,
                          capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["stats"]["trades"] == case["stats"]["trades"]
    bad = {**case["spec"], "costBps": 900}
    request.write_text(json.dumps({"bars": GOLDEN["bars"][case["symbol"]], "spec": bad}))
    done = subprocess.run([sys.executable, "-m", "nautilus_backtest", "run", str(request)], cwd=RESEARCH,
                          capture_output=True, text=True, check=False)
    assert done.returncode == 2
    assert json.loads(done.stdout) == {"error": "costBps must be from 0 to 500"}


@needs_nautilus
def test_cli_batch_runs_cases_on_their_slices_with_times(tmp_path):
    case = GOLDEN["engine"][0]
    bars = GOLDEN["bars"][case["symbol"]]
    size = len(bars["c"])
    request = tmp_path / "in.json"
    output = tmp_path / "out.json"
    request.write_text(json.dumps({"bars": bars, "cases": [
        {"id": "whole", "spec": case["spec"]},
        {"id": "tail", "spec": case["spec"], "slice": [size // 2, size]},
        {"id": "bad", "spec": {**case["spec"], "costBps": 900}},
        {"id": "outside", "spec": case["spec"], "slice": [0, size + 1]},
    ]}))
    done = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", str(request), str(output)],
                          cwd=RESEARCH, capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr
    payload = json.loads(output.read_text())
    assert payload["engine"] == "nautilus-trader-1.227.0"
    results = {entry["id"]: entry for entry in payload["results"]}
    assert results["whole"]["result"]["stats"]["trades"] == case["stats"]["trades"]
    assert len(results["tail"]["result"]["equity"]) == size - size // 2
    assert results["bad"]["error"] == "costBps must be from 0 to 500"
    assert results["outside"]["error"] == f"slice 0..{size + 1} is outside the {size} bars"
    assert all(entry["wallMs"] >= 0 for entry in payload["results"])
    assert payload["usage"]["cpuMs"] > 0
    assert payload["usage"]["wallMs"] >= results["whole"]["wallMs"]
    # "-" reads the request from stdin and prints the output.
    piped = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", "-", "-"], cwd=RESEARCH,
                           input=json.dumps({"bars": bars, "cases": [{"id": "whole", "spec": case["spec"]}]}),
                           capture_output=True, text=True, check=False)
    assert piped.returncode == 0, piped.stderr
    assert json.loads(piped.stdout)["results"][0]["id"] == "whole"


def test_pre_1970_bars_are_an_input_error():
    bars = Bars.from_columns({"t": [-86_400_000.0, 0.0], "o": [1.0, 1.0], "h": [1.0, 1.0], "l": [1.0, 1.0],
                              "c": [1.0, 1.0]})
    spec = {"rule": {"kind": "smaCross", "fast": 1, "slow": 2}, "stopLossPct": 0, "takeProfitPct": 0,
            "costBps": 0, "costs": None}
    with pytest.raises(InputError, match="after 1970"):
        engine.run_spec(bars, spec)


# Stop management and maxLeverage: the cases of instant-backtest-engine.test.ts
# ("runSignalBacktest stop management" and "runSignalBacktest maxLeverage").

DAY_MS = 86_400_000.0
START_MS = 1_704_153_600_000.0  # 2024-01-02 UTC


def _rows_bars(rows):
    return Bars.from_columns({
        "t": [START_MS + index * DAY_MS for index in range(len(rows))],
        "o": [row[0] for row in rows], "h": [row[1] for row in rows],
        "l": [row[2] for row in rows], "c": [row[3] for row in rows],
    })


def _managed_run(rows, management=None, stop=5.0, **options):
    signals = (1,) + (0,) * (len(rows) - 1)
    compiled = Compiled(signals=signals, exits=None,
                        stop_distance=None if stop is None else (stop,) * len(rows),
                        target_distance=None, management=management)
    return engine.run_signal_backtest(_rows_bars(rows), compiled, RunOptions(
        cost_bps=0, stop_loss_pct=0, take_profit_pct=0, costs=None, **options))


def _exit(result):
    trade = result.trades[0]
    return trade["exitIndex"], trade["exitReason"], trade["exitPrice"]


# Entry at the bar 1 open (100) with a 5 stop: R = 5. Bar 2 reaches entry + 1R with a low below
# the entry; the raised stop applies from bar 3.
BREAKEVEN_ROWS = [
    (100, 100, 100, 100), (100, 103, 99, 102), (102, 106, 99, 104), (104, 104, 99.5, 100),
    (100, 101, 99.5, 100),
]
# The trail activates at a high of 105: stop 105 - 2 x 1 = 103, then 107 - 2 = 105; ATR 3 at bar 4
# would give 101, but the stop never moves down.
TRAIL_ROWS = [
    (100, 100, 100, 100), (100, 104, 99, 103), (103, 106, 102, 105), (105, 108, 104, 107),
    (107, 108, 106, 107), (107, 107, 104.5, 105), (105, 106, 104, 105),
]
TRAIL_ATR = (1.0, 1.0, 1.0, 1.0, 3.0, 1.0, 1.0)


@needs_nautilus
def test_breakeven_moves_the_stop_to_the_entry_from_the_next_bar():
    assert _exit(_managed_run(BREAKEVEN_ROWS, {"breakevenR": 1.0})) == (3, "stop", 100.0)
    assert _exit(_managed_run(BREAKEVEN_ROWS, {"breakevenR": 2.0}))[:2] == (4, "end")
    # Without a stop nothing moves.
    assert _exit(_managed_run(BREAKEVEN_ROWS, {"breakevenR": 1.0}, stop=None))[:2] == (4, "end")


@needs_nautilus
def test_trail_activates_follows_the_highest_close_and_never_lowers():
    trail = {"activateR": 1.0, "multiple": 2.0, "atr": TRAIL_ATR}
    assert _exit(_managed_run(TRAIL_ROWS, {"trail": trail})) == (5, "stop", 105.0)
    assert _exit(_managed_run(TRAIL_ROWS, {"trail": {**trail, "activateR": 2.0}}))[:2] == (6, "end")
    assert _exit(_managed_run(TRAIL_ROWS, {"breakevenR": 1.0, "trail": trail})) == (5, "stop", 105.0)


@needs_nautilus
def test_trail_leaves_the_stop_on_a_nan_atr():
    trail = {"activateR": 1.0, "multiple": 2.0, "atr": (math.nan,) * len(TRAIL_ROWS)}
    assert _exit(_managed_run(TRAIL_ROWS, {"trail": trail}))[:2] == (6, "end")


LEVERAGE_ROWS = [(100, 100, 100, 100), (100, 102, 100, 102), (102, 103, 101, 103)]


@needs_nautilus
@pytest.mark.parametrize(("max_leverage", "units", "equity"), [
    (None, 0.01, 1.02),  # capped at the cash
    (5.0, 0.05, 1.1),  # capped at cash x 5: rest -4 + 0.05 x 102
    (20.0, 0.1, 1.2),  # risk size (10) below the cap: rest -9 + 0.1 x 102
])
def test_max_leverage_caps_the_position_at_cash_times_leverage(max_leverage, units, equity):
    result = _managed_run(LEVERAGE_ROWS, stop=1.0, risk_pct=10.0, max_leverage=max_leverage)
    assert math.isclose(result.trades[0]["units"], units, rel_tol=1e-6)
    assert math.isclose(result.equity[1], equity, rel_tol=EQUITY_REL_TOL)


@pytest.mark.parametrize(("management", "options", "message"), [
    (None, {"max_leverage": 2.0}, "maxLeverage needs riskPct"),
    (None, {"max_leverage": 0.5, "risk_pct": 1.0}, "maxLeverage must be from 1 to 50"),
    (None, {"max_leverage": 51.0, "risk_pct": 1.0}, "maxLeverage must be from 1 to 50"),
    ({"breakevenR": 0.0}, {}, "breakevenR must be above 0"),
    ({"breakevenR": math.inf}, {}, "breakevenR must be above 0"),
    ({"trail": {"activateR": 0.0, "multiple": 1.0, "atr": (1.0,) * 7}}, {}, "trail activateR must be above 0"),
    ({"trail": {"activateR": 1.0, "multiple": math.nan, "atr": (1.0,) * 7}}, {}, "trail multiple must be above 0"),
    ({"trail": {"activateR": 1.0, "multiple": 1.0, "atr": (1.0,) * 6}}, {}, "trail ATR must match the bar count"),
])
def test_management_and_leverage_input_errors(management, options, message):
    with pytest.raises(InputError) as raised:
        _managed_run(TRAIL_ROWS, management, **options)
    assert str(raised.value) == message


# Entry 100, stop 95 (R = 5). Bar 1 reaches 106, so breakeven raises the stop to 100 at its close;
# bar 2 meets the raised stop (TS "raised stop" cases).
@needs_nautilus
@pytest.mark.parametrize(("bar", "price"), [
    ((98, 99, 97, 98), 98.0),  # opens below the raised stop: fills at the open
    ((100, 101, 99, 100), 100.0),  # opens exactly at the raised stop
    ((102, 103, 100, 101), 100.0),  # touches the raised stop inside the bar
])
def test_gap_and_touch_of_a_raised_stop(bar, price):
    rows = [(100, 100, 100, 100), (100, 106, 99, 104), bar, (100, 101, 99, 100)]
    assert _exit(_managed_run(rows, {"breakevenR": 1.0})) == (2, "stop", price)


@needs_nautilus
def test_raised_stop_above_the_raising_close_exits_at_the_next_open():
    rows = [(100, 100, 100, 100), (100, 106, 98, 99), (99.5, 100.5, 99, 100), (100, 101, 99, 100)]
    assert _exit(_managed_run(rows, {"breakevenR": 1.0})) == (2, "stop", 99.5)


def _ruin_run(rows, signals, **options):
    compiled = Compiled(signals=tuple(signals), exits=None, stop_distance=(1.0,) * len(rows),
                        target_distance=None)
    return engine.run_signal_backtest(_rows_bars(rows), compiled, RunOptions(
        stop_loss_pct=0, take_profit_pct=0, costs=None, max_leverage=20.0, **options))


@needs_nautilus
def test_ruin_after_a_gap_through_the_stop_stops_trading():
    # riskPct 10, stop 1 below, 20x cap: 0.1 units cost 10 (cash -9); the gap to 50 fills the stop
    # at the open: -9 + 0.1 x 50 = -4. The signal at bar 3 does not enter.
    rows = [(100, 100, 100, 100), (100, 100, 100, 100), (50, 50, 50, 50), (50, 51, 49, 50), (50, 50, 50, 50)]
    result = _ruin_run(rows, (1, 0, 0, 1, 0), cost_bps=0, risk_pct=10.0)
    assert [(t["exitIndex"], t["exitReason"], t["exitPrice"]) for t in result.trades] == [(2, "stop", 50.0)]
    assert [round(value, 6) for value in result.equity] == [1.0, 1.0, -4.0, -4.0, -4.0]


@needs_nautilus
def test_ruin_closes_the_position_at_the_close():
    # costBps 500, riskPct 50, 20x cap: spent 20, 0.19 units, cash -19. Close 99.5 (stop 99 not
    # reached) marks -19 + 0.19 x 99.5 < 0: exit at that close; the signal at bar 2 does not enter.
    rows = [(100, 100, 100, 100), (100, 100, 99.5, 99.5), (100, 101, 99.5, 100), (100, 101, 99.5, 100)]
    result = _ruin_run(rows, (1, 0, 1, 0), cost_bps=500, risk_pct=50.0)
    assert [(t["entryIndex"], t["exitIndex"], t["exitReason"]) for t in result.trades] == [(1, 1, "stop")]
    assert math.isclose(result.trades[0]["exitPrice"], 99.5, rel_tol=PRICE_REL_TOL)
    cash = -19 + 0.19 * 99.5 * 0.95
    assert all(math.isclose(value, cash, rel_tol=EQUITY_REL_TOL) for value in result.equity[1:])


# Day 3 closes early at 11:00 (30-minute bars, session 09:30-11:30, entries 10:00-11:00). volTarget
# has no leverage until day 2's last bar; day 3's 10:00 signal sells short at the 10:00 open (100)
# with leverage 0.1 / sqrt(0.02) and the market-on-close order buys back at the 11:00 close (98).
NY_0930 = 1_767_623_400_000
MINUTE_MS = 60_000


def _intraday_short_bars() -> Bars:
    rows = [(day, slot, close) for day, close in ((0, 100), (1, 110), (2, 99)) for slot in range(4)]
    rows += [(3, 0, 100), (3, 1, 100), (3, 2, 98)]
    opens = [100.0 if day == 3 else close for day, _slot, close in rows]
    return Bars.from_columns({
        "t": [NY_0930 + day * DAY_MS + slot * 30 * MINUTE_MS for day, slot, _close in rows],
        "o": opens, "h": [close + 1 for *_rest, close in rows], "l": [close - 1 for *_rest, close in rows],
        "c": [close for *_rest, close in rows],
    })


@needs_nautilus
def test_vol_target_short_exits_market_on_close_on_an_early_close_day():
    definition = {
        "version": 1, "name": "short volTarget", "side": "short",
        "entry": {"all": [
            {"left": {"type": "price", "field": "close"}, "op": ">", "right": {"type": "const", "value": 0}},
        ]},
        "intraday": {"timezone": "America/New_York", "open": "09:30", "close": "11:30",
                     "entryFrom": "10:00", "entryTo": "11:00"},
        "sizing": {"mode": "volTarget", "targetPct": 10, "length": 2, "maxLeverage": 5},
    }
    spec = {"rule": {"kind": "dsl", "definition": definition}, "costBps": 0}
    result = engine.run_spec(_intraday_short_bars(), spec)
    assert [(t["entryIndex"], t["exitIndex"], t["exitReason"]) for t in result.trades] == [(13, 14, "signal")]
    trade = result.trades[0]
    assert math.isclose(trade["entryPrice"], 100.0, rel_tol=PRICE_REL_TOL)
    assert math.isclose(trade["exitPrice"], 98.0, rel_tol=PRICE_REL_TOL)
    leverage = 0.1 / math.sqrt(0.02)
    assert math.isclose(trade["pnl"], leverage * 0.02, rel_tol=EQUITY_REL_TOL)
    assert math.isclose(result.equity[14], 1 + leverage * 0.02, rel_tol=EQUITY_REL_TOL)
    assert result.to_json()["modelVersion"] == engine.MODEL_VERSION == 3
