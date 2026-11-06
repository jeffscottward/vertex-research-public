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
