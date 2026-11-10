"""NautilusTrader engine for Quant Lab: parity with the standard-library engine.

The parity tests need nautilus-trader==1.227.0 (lock:
requirements-nautilus-linux-py312.lock). Without it they skip, unless
VERTEX_REQUIRE_NAUTILUS=1 (set by scripts/ci/research-python.sh for the
Nautilus run), where a missing engine is a failure. The error-path tests run in
both environments. Synthetic data only: no network, model or broker.
"""
import hashlib
import json
import math
import os
import sys
import types
from datetime import date, timedelta
from pathlib import Path

import pytest

from quantlab import __main__ as cli
from quantlab import backtest, data, engine, nautilus_engine
from quantlab.spec import build_spec
from quantlab.ssrn import capture_from_crossref

DRAFT = json.loads((Path(__file__).resolve().parents[1] / "quantlab/drafts/zakamulin-2013-sma-timing.json").read_text())
ITEM = {"DOI": "10.2139/ssrn.2242795", "title": ["The Real-Life Performance of Market Timing"],
        "author": [{"given": "Valeriy", "family": "Zakamulin"}], "posted": {"date-parts": [[2013, 3, 29]]},
        "deposited": {"date-time": "2020-01-01T00:00:00Z"}, "abstract": "<jats:p>Out-of-sample.</jats:p>"}
COSTS = engine.Costs(0.5, 0.5, 1.0)
# Close-equity tolerance: whole-share sizing from 1e8 USD, cent-rounded fees and
# interest, and fee charged on notional instead of on equity (O(cost^2)).
EQUITY_REL_TOL = 1e-5

# numpy 2.5 warns inside pandas/nautilus import code (generic timedelta unit); not ours.
pytestmark = pytest.mark.filterwarnings("ignore:The 'generic' unit for NumPy timedelta:DeprecationWarning")


def _installed() -> bool:
    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        nautilus_engine.require()  # the Nautilus CI run fails here instead of skipping
        return True
    try:
        nautilus_engine.require()
    except nautilus_engine.NautilusUnavailable:
        return False
    return True


needs_nautilus = pytest.mark.skipif(not _installed(), reason="nautilus-trader==1.227.0 not installed")


def bars(n=1500, seed=11):
    out, price, day, state = [], 100.0, date(2001, 1, 2), seed
    while len(out) < n:
        if day.weekday() < 5:
            state = (state * 1103515245 + 12345) % 2**31
            change = (state / 2**31 - 0.48) * 0.03
            open_ = price * (1 + change / 3)
            price = price * (1 + change)
            out.append(data.Bar(day.isoformat(), open_, price, price * 0.9))  # adjusted below raw
        day += timedelta(days=1)
    return out


def both(b, rf, **kw):
    args = dict(signal_type="price_above_sma", lookback=3, unit="months", rebalance="monthly", execution="next_open",
                weight=1.0, costs=COSTS)
    args.update(kw)
    return engine.simulate(b, rf, **args), nautilus_engine.simulate(b, rf, **args)


def legs(run):
    return [(t["entry_t"], t["exit_t"], t["side"]) for t in run.trades]


def close_equity(run):
    return math.prod(1 + r for r in run.returns)


@needs_nautilus
@pytest.mark.parametrize("kw", [
    dict(),
    dict(signal_type="momentum", lookback=6),
    dict(execution="next_close", unit="days", lookback=40, rebalance="daily"),
], ids=["sma-monthly-next-open", "momentum-monthly-next-open", "sma-daily-next-close"])
def test_same_trades_and_close_equity_as_stdlib(kw):
    b = bars()
    rf = [0.00012] * len(b)
    stdlib, nautilus = both(b, rf, **kw)
    assert len(stdlib.trades) >= 3
    assert legs(nautilus) == legs(stdlib)
    assert nautilus.weights == stdlib.weights
    assert nautilus.warmup_end == stdlib.warmup_end
    assert [t["entry_px"] for t in nautilus.trades] == [t["entry_px"] for t in stdlib.trades]
    assert close_equity(nautilus) == pytest.approx(close_equity(stdlib), rel=EQUITY_REL_TOL)
    assert nautilus.costs_paid == pytest.approx(stdlib.costs_paid, rel=1e-2)


@needs_nautilus
def test_cash_interest_accrues_out_of_market():
    b = bars(300)
    rf = [0.0001] * len(b)
    stdlib, nautilus = both(b, rf, lookback=400, unit="days", rebalance="daily", costs=engine.Costs(0, 0, 0))
    assert all(w == 0 for w in nautilus.weights) and not nautilus.trades
    assert close_equity(nautilus) == pytest.approx(close_equity(stdlib), rel=1e-7)


@needs_nautilus
def test_run_spec_record_has_engine_field_and_matches_stdlib():
    b = bars(3000)
    spec = build_spec(capture_from_crossref(ITEM, topic="t", captured_at="2026-10-18T00:00:00Z").to_dict(),
                      {**DRAFT, "validation": {**DRAFT["validation"], "in_sample_end": "2006-12-31",
                                               "walk_forward": {"train_years": 3, "test_years": 2,
                                                                "lookback_grid": [3, 6], "objective": "sharpe"}}})
    stdlib = backtest.run_spec(spec, b, None, data_label="synthetic")
    nautilus = backtest.run_spec(spec, b, None, data_label="synthetic", engine="nautilus")
    assert (stdlib["engine"], nautilus["engine"]) == ("stdlib-daily-v1", "nautilus-trader-1.227.0")
    assert stdlib["strategy"].endswith("(walk-forward)")
    assert nautilus["strategy"].endswith("(walk-forward, nautilus-trader-1.227.0)")
    assert "engine" not in nautilus["runConfig"]  # the stored runConfig is a closed contract
    assert set(nautilus) == set(stdlib) and set(nautilus["metrics"]) == set(stdlib["metrics"])
    assert [(t["entry_t"], t["exit_t"]) for t in nautilus["trades"]] == \
        [(t["entry_t"], t["exit_t"]) for t in stdlib["trades"]]
    assert [f["label"] for f in nautilus["folds"]] == [f["label"] for f in stdlib["folds"]]
    assert nautilus["equity"][-1]["equity"] == pytest.approx(stdlib["equity"][-1]["equity"], rel=EQUITY_REL_TOL)


# Error paths (no Nautilus needed)

def test_package_imports_without_nautilus_and_stdlib_stays_selectable(monkeypatch):
    monkeypatch.setitem(sys.modules, "nautilus_trader", None)  # import now raises ImportError
    simulate, engine_id = backtest.select_engine("stdlib")
    assert simulate is engine.simulate and engine_id == engine.ENGINE_ID == "stdlib-daily-v1"


def test_missing_nautilus_gives_a_clear_error(monkeypatch):
    monkeypatch.setitem(sys.modules, "nautilus_trader", None)
    with pytest.raises(nautilus_engine.NautilusUnavailable, match=r"nautilus-trader==1\.227\.0 is not installed.*lock"):
        backtest.select_engine("nautilus")
    with pytest.raises(nautilus_engine.NautilusUnavailable):
        nautilus_engine.simulate(bars(30), [0.0] * 30, signal_type="price_above_sma", lookback=3, unit="days",
                                 rebalance="daily", execution="next_open", weight=1.0, costs=COSTS)


def test_wrong_nautilus_version_is_refused(monkeypatch):
    monkeypatch.setitem(sys.modules, "nautilus_trader", types.SimpleNamespace(__version__="1.200.0"))
    with pytest.raises(nautilus_engine.NautilusUnavailable, match=r"1\.200\.0 found, 1\.227\.0 is pinned"):
        nautilus_engine.require()


# Validation windows that fit the synthetic bars (2001 to about 2012), as in the run_spec test above.
SHORT_VALIDATION = {**DRAFT["validation"], "in_sample_end": "2006-12-31",
                    "walk_forward": {"train_years": 3, "test_years": 2, "lookback_grid": [3, 6], "objective": "sharpe"}}


def _cli_inputs(tmp_path, n=40):
    csv = tmp_path / "bars.csv"
    rows = ["date,open,high,low,close,adj_close,volume"] + [
        f"{x.date},{x.open:.6f},{x.open:.6f},{x.open:.6f},{x.close:.6f},{x.adj_close:.6f},0" for x in bars(n)]
    csv.write_text("\n".join(rows) + "\n")
    manifest = {"symbol": "SYN", "source": "synthetic", "path": str(csv),
                "sha256": hashlib.sha256(csv.read_bytes()).hexdigest()}
    (tmp_path / "bars.json").write_text(json.dumps(manifest))
    spec = build_spec(capture_from_crossref(ITEM, topic="t", captured_at="2026-10-18T00:00:00Z").to_dict(),
                      {**DRAFT, "validation": SHORT_VALIDATION})
    (tmp_path / "spec.json").write_text(json.dumps(spec))
    return ["backtest", "--spec", str(tmp_path / "spec.json"), "--bars", str(tmp_path / "bars.json")]


@pytest.mark.parametrize("engine_args", [["--engine", "nautilus"], []], ids=["explicit", "default"])
def test_cli_reports_missing_engine_and_writes_nothing(monkeypatch, tmp_path, capsys, engine_args):
    # Nautilus is the CLI default since 2026-11-08 (switch plan step 3), so a bare run needs it too.
    monkeypatch.setitem(sys.modules, "nautilus_trader", None)
    monkeypatch.setenv("QUANTLAB_HOME", str(tmp_path / "home"))
    code = cli.main(_cli_inputs(tmp_path) + engine_args)
    assert code == 2
    error = json.loads(capsys.readouterr().err)["error"]
    assert "not installed" in error and "--engine stdlib" in error
    assert not (tmp_path / "home" / "results").exists()


def test_cli_stdlib_engine_still_runs_without_nautilus(monkeypatch, tmp_path, capsys):
    monkeypatch.setitem(sys.modules, "nautilus_trader", None)
    monkeypatch.setenv("QUANTLAB_HOME", str(tmp_path / "home"))
    assert cli.main(_cli_inputs(tmp_path, n=3000) + ["--engine", "stdlib"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["engine"] == "stdlib-daily-v1"
    assert not Path(out["written"]).name.endswith("-stdlib.json")  # stored names stay as before
