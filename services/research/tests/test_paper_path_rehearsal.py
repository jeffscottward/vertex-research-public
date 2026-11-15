"""Paper path rehearsal (research/backtests/allocation/paper_path_rehearsal.py): request items, model
quotes, exit time and the engine order policy in a test process. Synthetic inputs; no network, no
database, no node."""
import importlib.util
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

ROOT = Path(__file__).resolve().parents[3]
FOLDER = ROOT / "research" / "backtests" / "allocation"
NEW_YORK = ZoneInfo("America/New_York")
OPTIONS = {"structure": "callDebitVertical", "dte": {"target": 60, "min": 45}, "width": {"unit": "sigma", "value": 1.0},
           "anchorDelta": 0.5, "budgetPctOfAccount": 1.0, "maxLossPctOfAccount": 2.0, "group": None,
           "legs": [{"role": "anchor", "action": "buy", "right": "call"}, {"role": "wing", "action": "sell", "right": "call"}]}


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, FOLDER / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def pp():
    if "deploy_rehearsal" not in sys.modules:
        _load("deploy_rehearsal")
    return _load("paper_path_rehearsal")


def _record(**changes) -> dict:
    record = {"id": "request-1", "strategyId": "library:qc-oil-predicts-equity", "presetId": None, "params": {},
              "symbol": "SPY", "timeframe": "1d", "mode": "paper", "status": "approved", "options": OPTIONS,
              "limits": {"maxOrderSize": 50, "maxPosition": 50, "maxOrdersPerMinute": 2, "dailyLossLimit": 3600},
              "executionAuthorized": False, "brokerSubmissionAllowed": False}
    return {**record, **changes}


def _open(pp, desk, record: dict, moment: datetime):
    quote = pp.spread_quote("SPY", 12.0, 7.0, moment)
    intent = pp.SpreadIntent(intent_id="t-1", request_id=record["id"], kind="open", strategy_id=record["strategyId"],
                             symbol="SPY", structure="callDebitVertical", expiry=date(2026, 1, 16),
                             long_strike=Decimal("680"), short_strike=Decimal("700"),
                             net_limit=quote.long_leg.ask - quote.short_leg.bid, signal_date=moment.date())
    path = pp.PaperPath(desk.policy, pp.SimulatedPaperVenue(pp.venue_model(), provenance_id="test"))
    desk.set(moment, 360000.0, pp.held_legs(path))
    return path, path.open(record, intent, Decimal("360000"), quote, moment)


@pytest.fixture
def desk(pp):
    bench = pp.dr.PolicyBench()
    yield pp.PolicyDesk(pp.dr.arm_gate, bench, None)
    bench.close()
    assert not bench.dir.exists()


def test_exit_moment_is_the_close_minus_15_minutes(pp):
    assert pp.exit_moment("2026-11-25").strftime("%H:%M") == "15:45"
    assert pp.exit_moment("2026-11-27").strftime("%H:%M") == "12:45"  # early close after Thanksgiving


def test_leg_quote_is_a_market_on_the_cent_grid(pp):
    for mid in (0.0, 0.004, 0.37, 12.3456):
        quote = pp.leg_quote("SPY", mid)
        assert Decimal("0") <= quote.bid < quote.ask
        assert quote.bid % pp.TICK == 0 and quote.ask % pp.TICK == 0
        assert quote.bid <= Decimal(str(mid)) <= quote.ask


def test_options_block_takes_the_anchor_delta_of_the_structure(pp):
    debit = {"options": {"structure": "callDebitVertical", "dte": {"target": 60, "min": 45}, "longDelta": 0.5, "widthSigma": 1.0}}
    credit = {"legs": [{"options": {"structure": "putCreditVertical", "dte": {"target": 45, "min": 30}, "shortDelta": 0.25,
                                    "widthSigma": 0.5, "profitTakePct": 50}}]}
    assert pp._options_block(debit) == {"structure": "callDebitVertical", "dte": {"target": 60, "min": 45},
                                        "width": {"unit": "sigma", "value": 1.0}, "anchorDelta": 0.5,
                                        "budgetPctOfAccount": pp.fp.POSITION_RISK_PCT, "maxLossPctOfAccount": 2.0}
    assert pp._options_block(credit)["anchorDelta"] == 0.25
    with pytest.raises(RuntimeError):
        pp._options_block({"options": {"structure": "callDebitVertical", "dte": {"target": 60, "min": 45}, "shortDelta": 0.25}})


def test_engine_policy_of_this_checkout_decides_the_combo(pp, desk):
    """Spreads switch off: the engine policy refuses the combo and nothing is filled.
    A policy with the switch (v3) refuses the same way while the switch is off."""
    moment = datetime(2025, 11, 12, 15, 50, tzinfo=NEW_YORK)
    path, result = _open(pp, desk, _record(), moment)
    assert result.order is not None and result.order.quantity > 0
    assert (result.outcome, result.refusal_stage, result.refusal_code) == ("refused", "policy", "combo_refused")
    assert result.fill is None and path.positions == ()


def test_a_request_that_is_not_paper_never_reaches_the_policy(pp, desk):
    moment = datetime(2025, 11, 12, 15, 50, tzinfo=NEW_YORK)
    _path, result = _open(pp, desk, _record(mode="live"), moment)
    assert result.outcome == "refused" and result.refusal_stage in ("request", "strategy")
    assert result.refusal_code == "mode_not_paper" and result.policy is None and result.fill is None


def test_old_format_request_loads_and_builds_no_order(pp, desk):
    moment = datetime(2025, 11, 12, 15, 50, tzinfo=NEW_YORK)
    _path, result = _open(pp, desk, _record(options=None), moment)
    assert (result.outcome, result.refusal_stage, result.refusal_code) == ("refused", "strategy", "no_option_structure")
