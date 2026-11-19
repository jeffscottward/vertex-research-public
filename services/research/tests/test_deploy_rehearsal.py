"""Deployability rehearsal (research/backtests/allocation/deploy_rehearsal.py): window rule, cap trace,
shim orders and the order policy in a test process. Synthetic inputs; no network, no database, no node."""
import importlib.util
import json
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from strategies.qc_ports import allocation as al
from strategies.qc_ports import ideas as qi
from strategies.qc_ports import portfolio as pf
from tests.qc_ports_synthetic import trading_days

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "research" / "backtests" / "allocation" / "deploy_rehearsal.py"


@pytest.fixture(scope="module")
def dr():
    spec = importlib.util.spec_from_file_location("deploy_rehearsal", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["deploy_rehearsal"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def bench(dr):
    made = dr.PolicyBench()
    yield made
    made.close()
    assert not made.dir.exists()


def _trade(number: int, symbol: str, entry: str, exit_: str, structure: str = "callDebitVertical") -> al.PricedTrade:
    return al.PricedTrade(
        trade_id=number, symbol=symbol, structure=structure, expiry="2024-03-15", long_strike=100.0,
        short_strike=105.0, width=5.0, entry_index=1, exit_index=2, entry_date=entry, exit_date=exit_,
        entry_price=200.0, exit_price=300.0, entry_fee=2.0, exit_fee=2.0, max_loss=204.0, max_loss_pct=2.0,
        premium=2.0, exit_reason="expiry", marks=((entry, 200.0), (exit_, 300.0)))


def test_strong_window_is_the_best_run_of_full_months(dr):
    dates = list(trading_days("2023-11-01", 400))
    close, level = [], 100.0
    for day in dates:
        level *= 1.004 if "2024-03" <= day[:7] <= "2024-08" else 0.9995
        close.append(level)
    window = dr.strong_window(dates, close, "2024-01")
    assert (window["start"][:7], window["end"][:7]) == ("2024-03", "2024-08")
    assert window["start"] == next(day for day in dates if day.startswith("2024-03"))
    assert window["end"] == [day for day in dates if day.startswith("2024-08")][-1]
    assert window["top"][0]["return"] == window["return"] > window["top"][1]["return"]
    # the first month allowed is a bound, and the last (maybe incomplete) month is never used
    assert dr.strong_window(dates, close, "2024-06")["start"][:7] == "2024-06"
    assert all(item["end"][:7] < dates[-1][:7] for item in window["top"])
    with pytest.raises(ValueError, match="No full window"):
        dr.strong_window(dates[:60], close[:60], "2023-11")


def test_contrast_window_starts_on_the_entry_day_of_the_last_decision_before_it(dr):
    days = list(trading_days("2024-01-02", 100))
    window = dr.contrast_window(days, 63)
    month = days[-63][:7]
    first_of_month = next(day for day in days if day[:7] == month)
    assert days[-63] != first_of_month  # the plain window would start inside a month
    assert (window["start"], window["end"]) == (first_of_month, days[-1])
    # no month end before the window: the plain start
    assert dr.contrast_window(days[:10], 8)["start"] == days[2]


def test_cap_trace_matches_combine_and_dates_each_refusal(dr):
    books = {
        "a": [_trade(1, "SPY", "2024-01-02", "2024-01-10"), _trade(2, "QQQ", "2024-01-03", "2024-01-10")],
        "b": [_trade(1, "SPY", "2024-01-02", "2024-01-05"), _trade(2, "GLD", "2024-01-04", "2024-01-09"),
              _trade(3, "SPY", "2024-01-10", "2024-01-12")],
        "off": [_trade(1, "IWM", "2024-01-02", "2024-01-03")],
    }
    risk = {"a": 1.5, "b": 1.0, "off": 0.0}
    caps = al.Caps(open_risk_pct=3.0, name_risk_pct=2.0)
    combined, refused = dr.trace_caps(books, risk, caps)
    assert combined == al.combine(books, risk, caps)
    assert [(item["date"], item["sleeve"], item["symbol"], item["cause"]) for item in refused] == [
        ("2024-01-02", "b", "SPY", "cap:nameRisk"), ("2024-01-04", "b", "GLD", "cap:openRisk")]
    sleeves = al.Caps(open_risk_pct=10.0, sleeve_of={"a": "s", "b": "s"}, sleeve_risk_pct={"s": 1.0})
    _combined, refused = dr.trace_caps(
        {"a": [_trade(1, "SPY", "2024-01-02", "2024-01-10")], "b": [_trade(1, "QQQ", "2024-01-03", "2024-01-10")]},
        {"a": 1.0, "b": 1.0}, sleeves)
    assert [item["cause"] for item in refused] == ["cap:sleeveRisk"]


def test_cap_trace_raises_when_it_differs_from_combine(dr, monkeypatch):
    books = {"a": [_trade(1, "SPY", "2024-01-02", "2024-01-10"), _trade(2, "SPY", "2024-01-03", "2024-01-10")]}
    real = al.combine
    monkeypatch.setattr(dr.al, "combine", lambda books, risk, caps: real(books, risk, al.Caps(open_risk_pct=10.0)))
    with pytest.raises(RuntimeError, match="disagree"):
        dr.trace_caps(books, {"a": 1.5}, al.Caps(open_risk_pct=2.0, name_risk_pct=2.0))


def test_every_cause_has_a_kind_and_a_class(dr):
    assert {value[1] for value in dr.CAUSES.values()} == {"missing", "collision", "rule"}
    assert all(len(value) == 3 and all(value) for value in dr.CAUSES.values())


def test_policy_refuses_the_vertical_and_allows_the_long_leg(dr, bench):
    trade = _trade(1, "SPY", "2024-01-02", "2024-01-10")
    orders = dr.leg_orders(trade, 3, 4.0, 1.5)
    combo, combo_order = orders["combo"]
    assert (combo.secType, combo_order.action, combo_order.lmtPrice) == ("BAG", "BUY", 2.5)
    assert [(leg.action, leg.strike) for leg in combo.comboLegs] == [("BUY", 100.0), ("SELL", 105.0)]
    assert bench.check(combo, combo_order, 100_000.0) == "refused:combo_refused"
    assert bench.check(*orders["longLeg"], 100_000.0) == "long_option_open"
    held = [dr._held(trade, trade.long_strike, 3)]
    assert bench.check(*orders["shortLeg"], 100_000.0, held) == "refused:short_option_open"
    assert bench.check(dr._option(trade, 100.0), dr._order("SELL", 3, 4.0), 100_000.0, held) == "position_close"
    assert bench.check(dr._option(trade, 100.0), dr._order("SELL", 4, 4.0), 100_000.0, held) == "refused:exceeds_held_quantity"
    # 3 contracts * $4.00 * 100 = $1,200: more than 2% of $50,000
    assert bench.check(*orders["longLeg"], 50_000.0) == "refused:max_loss_exceeded"
    assert len(list(bench.dir.glob("ibkr-account-snapshot-*.json"))) == 1
    # every path the policy reads is inside the temporary folder
    assert all(Path(value).parent == bench.dir or Path(value) == bench.dir for value in bench.env.values())
    assert dr.arm_gate.RESERVATIONS_ENV in bench.env


def test_a_credit_vertical_buys_the_combo_for_a_credit_and_a_put_long_leg(dr):
    trade = _trade(1, "SPY", "2024-01-02", "2024-01-10", "putCreditVertical")
    orders = dr.leg_orders(trade, 2, 0.5, 1.7)
    assert (orders["combo"][1].action, orders["combo"][1].lmtPrice) == ("BUY", -1.2)
    contract, order = orders["longLeg"]
    assert (contract.right, contract.lastTradeDateOrContractMonth, order.action) == ("P", "20240315", "BUY")
    assert orders["shortLeg"][1].action == "SELL"


def test_leveraged_what_if_passes_as_a_long_call_only(dr, bench):
    rows = dr.leveraged_probe(100_000.0, bench)
    assert [row["symbol"] for row in rows] == ["TQQQ", "SOXL", "UPRO"]
    for row in rows:
        assert row["contractsAt2Pct"] == 4
        assert row["longCall"] == "long_option_open"
        assert row["longCallOneMore"] == "refused:max_loss_exceeded"
        assert row["sharesBuyWhatIf"] == "refused:new_share_buy"


def test_engine_has_no_intake_for_a_request(dr):
    facts = dr.engine_intake()
    assert facts["strategies"] == ["SafeExampleStrategy"]
    assert facts["readsDeploymentRequests"] is False
    assert facts["orderIntentCallers"] == 0
    assert facts["noIntake"] is True


def test_engine_read_reports_an_intake_when_the_runner_has_one(dr, monkeypatch, tmp_path):
    runner = tmp_path / "run_live.py"
    runner.write_text("strategy = PieStrategy(load_deployment_requests())\nnode.submit_order_intent(strategy.next())\n")
    monkeypatch.setattr(dr, "ENGINE_SOURCE", runner)
    monkeypatch.setattr(dr, "ROOT", tmp_path)
    facts = dr.engine_intake()
    assert (facts["strategies"], facts["readsDeploymentRequests"], facts["orderIntentCallers"], facts["noIntake"]) == (
        ["PieStrategy"], True, 1, False)


def test_request_inputs_name_one_symbol_each(dr):
    trades = {"momentum-rotation/A": [_trade(1, "GLD", "2024-01-02", "2024-01-10"), _trade(2, "SPY", "2024-02-01", "2024-02-10")]}
    inputs = dr.request_inputs(trades, {("momentum-rotation/A", "2024-01-02", "GLD"): 7}, 100_000.0)
    assert [(item["symbol"], item["limits"]["maxOrderSize"], item["mode"]) for item in inputs] == [
        ("GLD", 7, "paper"), ("SPY", 1, "paper")]
    assert inputs[0]["strategyId"] == "library:qc-momentum-rotation"
    assert inputs[0]["limits"]["dailyLossLimit"] == 1000.0


def test_request_rules_run_or_say_why_not(dr, monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    assert dr.rehearse_requests([]) == {"ran": False, "why": "bun is not installed", "requests": [], "probes": []}
    monkeypatch.setattr(shutil, "which", lambda _name: "/bin/false")
    failed = dr.rehearse_requests([])
    assert (failed["ran"], failed["requests"]) == (False, [])


def test_request_rules_report_each_request_and_both_probes(dr, monkeypatch):
    seen = {}

    def child(command, *, input, **_options):  # noqa: A002 - subprocess.run keyword
        seen["inputs"] = json.loads(input)
        rows = [{"index": n, "symbol": item["symbol"], "reached": "approve", "status": "approved",
                 "refusedAt": "dispatch", "refusal": "locked"} for n, item in enumerate(seen["inputs"])]
        return SimpleNamespace(stdout=json.dumps({"requests": rows, "lock": {"dispatchState": "not-dispatched"},
                                                  "notRehearsed": ["x"]}))

    monkeypatch.setattr(shutil, "which", lambda _name: "bun")
    monkeypatch.setattr(dr.subprocess, "run", child)
    one = {"strategyId": "library:qc-x", "symbol": "SPY", "timeframe": "1d", "mode": "paper",
           "limits": {"maxOrderSize": 1, "maxPosition": 1, "maxOrdersPerMinute": 2, "dailyLossLimit": 10.0}}
    report = dr.rehearse_requests([one])
    assert report["ran"] is True
    assert [row["input"] for row in report["requests"]] == [one]
    assert [probe["probe"] for probe in report["probes"]] == ["one request for all Core 7 symbols", "mode live"]
    assert [item["symbol"] for item in seen["inputs"]] == ["SPY", "SPY,QQQ,DIA,IWM,GLD,SLV,USO", "SPY"]
    assert seen["inputs"][2]["mode"] == "live"


# --------------------------------------------------------------------------- a whole window on synthetic data

INDEX_OF = {"SPY": "VIX", "QQQ": "VXN", "DIA": "VXD", "IWM": "RVX", "GLD": "GVZ", "SLV": "VXSLV", "USO": "OVX"}


def _pie_data(days: int = 420, vix_high_from: str | None = None, falling: tuple[str, ...] = (), leader: str = "GLD"):
    """Every ETF rises (`leader` the most, so the rotation picks it), or falls when named in `falling`."""
    dates = list(trading_days("2023-01-03", days))
    rows = {}
    for number, symbol in enumerate(qi.CORE7):
        drift = -0.0006 if symbol in falling else (0.0012 if symbol == leader else 0.0004 + 0.00002 * number)
        closes = [100.0 * (1 + number) * (1 + drift) ** n for n in range(days)]
        rows[symbol] = {"dates": dates, **{key: list(closes) for key in ("open", "high", "low", "close", "adjClose")}}
        rows[INDEX_OF[symbol]] = {"dates": dates, "close": [
            30.0 if symbol == "SPY" and vix_high_from and day >= vix_high_from else 16.0 for day in dates]}
    rows["VIX3M"] = {"dates": dates, "close": [35.0] * days}
    rows["IRX"] = {"dates": dates, "close": [1.0] * days}
    data = pf.dataset_from_rows(rows)
    start = {symbol: dates[0] for symbol in qi.CORE7}
    starts = {idea: dict(start) for idea in ("qc-asset-class-trend", "qc-futures-trend-carry", "qc-momentum-rotation",
                                             "qc-same-month-seasonality")}
    starts["qc-gold-fed-model"] = {"GLD": dates[0]}
    starts["qc-oil-predicts-equity"] = {"SPY": dates[0], "QQQ": dates[0]}
    return data, qi.Facts(iv_start=start, iv_rank_join=start, starts=starts, gold_last_input=dates[-1]), dates


def _window(dr, monkeypatch, bench, capital: float = 1_000_000.0, **data_options):
    data, facts, dates = _pie_data(**data_options)
    monkeypatch.setattr(dr, "rehearse_requests", lambda inputs: {
        "ran": True, "probes": [], "lock": {"dispatchState": "not-dispatched"}, "notRehearsed": [],
        "requests": [{"input": item, "symbol": item["symbol"], "status": "approved", "refusedAt": "dispatch",
                      "refusal": "locked"} for item in inputs]})
    months = sorted({day[:7] for day in dates})
    first, last = months[-7], months[-2]
    window = {"rule": "test", "start": next(day for day in dates if day[:7] == first),
              "end": [day for day in dates if day[:7] == last][-1]}
    return dr.rehearse_window(data, facts, window, capital, False, bench), window, dates


def test_a_window_counts_each_decision_once_and_is_at_risk_from_its_first_day(dr, monkeypatch, bench):
    out, window, dates = _window(dr, monkeypatch, bench)
    counts = out["counts"]
    assert len(out["decisionDays"]) == 6
    assert all(day < window["end"] for day in out["decisionDays"]) and out["decisionDays"][0] < window["start"]
    # long index: SPY and QQQ at each of the 6 decisions; rotation: 1; vol premium: the gate is open (VIX 16 < VIX3M)
    by_sleeve = {}
    for trade in out["trades"]:
        by_sleeve[trade["sleeve"]] = by_sleeve.get(trade["sleeve"], 0) + 1
        assert window["start"] <= trade["entryDate"] <= window["end"]
    assert by_sleeve["oil-predicts-equity/B"] == 12 and by_sleeve["momentum-rotation/A"] == 6
    assert by_sleeve["regime-put-vrp/A"] >= 3
    assert counts["refusedByCaps"] == 0 and counts["offered"] == counts["acceptedByCaps"] == len(out["trades"])
    assert counts["sized"] + counts["sizedToZero"] == counts["acceptedByCaps"]
    assert (counts["reachedEngine"], counts["ordersSent"]) == (0, 0)
    daily = out["deployment"]["daily"]
    assert (daily[0]["t"], daily[-1]["t"]) == (window["start"], window["end"])
    assert daily[0]["atRiskPct"] > 0 and out["deployment"]["daysAtZero"] == 0
    assert all(item["atRiskPct"] <= item["reservedPct"] + 1e-9 <= 4.0 + 1e-9 for item in daily)
    causes = {item["cause"]: item["count"] for item in out["refusalsByCause"]}
    assert causes["policy:combo_refused"] == causes["policy:short_option_open"] == causes["engine:noIntake"] == counts["sized"]
    assert "gate:volRegime" not in causes and "signal:noMember" not in causes
    assert {trade["stoppedAt"] for trade in out["trades"] if trade["contracts"]} == {"request -> engine"}
    steps = {step["step"]: step for step in dr.chain_steps({"w": out})}
    assert steps["simulated fill"]["ran"] == "yes (ledger only)"
    assert steps["order policy"]["refused"] == 2 * counts["sized"]
    assert steps["engine strategy"]["exists"] == "no"


def test_a_closed_gate_and_a_rotation_without_a_member_are_stops_with_a_cause(dr, monkeypatch, bench):
    data, _facts, dates = _pie_data()
    months = sorted({day[:7] for day in dates})
    high_from = next(day for day in dates if day[:7] == months[-5])
    out, _window_used, _dates = _window(dr, monkeypatch, bench, vix_high_from=high_from,
                                        falling=("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO"))
    causes = {item["cause"]: item["count"] for item in out["refusalsByCause"]}
    assert causes["signal:noMember"] == 6  # every ETF has negative 12-1 momentum
    gate = [item for item in out["refusals"] if item["cause"] == "gate:volRegime"]
    assert len(gate) == 6  # SPY falls, so the trend condition is false at every decision
    assert all("SPY below its 200-day average" in item["detail"] for item in gate)
    assert [("VIX 30.0 above 25" in item["detail"]) for item in gate] == [item["date"] >= high_from for item in gate]
    assert any(item["date"] >= high_from for item in gate) and any(item["date"] < high_from for item in gate)
    assert not [trade for trade in out["trades"] if trade["sleeve"] == "momentum-rotation/A"]
    none = [item for item in out["refusals"] if item["cause"] == "signal:noMember"]
    assert [item["date"] for item in none] == out["decisionDays"]  # one stop per decision, dated on its day


def test_signal_trace_raises_when_owner_rule_trades_lacks_a_trade(dr, monkeypatch):
    data, facts, dates = _pie_data()
    made = dr.fp.sleeve_definitions(qi.family(facts), facts)
    definition, sleeve_start = made["oil-predicts-equity/B"]
    trades, stops = dr.trace_signals("oil-predicts-equity/B", definition, data, sleeve_start, dates[-120], dates[-30])
    assert len(trades) >= 6 and stops == []
    real = al.owner_rule_trades
    lost = trades[0]
    monkeypatch.setattr(dr.al, "owner_rule_trades", lambda *args, **options: tuple(
        trade for trade in real(*args, **options) if (trade.symbol, trade.entry_date) != (lost.symbol, lost.entry_date)))
    with pytest.raises(RuntimeError, match="does not find the trades"):
        dr.trace_signals("oil-predicts-equity/B", definition, data, sleeve_start, dates[-120], dates[-30])


def test_a_refused_request_is_where_its_trades_stop(dr, monkeypatch, bench):
    data, facts, dates = _pie_data()

    def requests(inputs):
        rows = [{"input": item, "symbol": None if item["symbol"] == "QQQ" else item["symbol"],
                 "status": None if item["symbol"] == "QQQ" else "approved",
                 "refusedAt": "contract" if item["symbol"] == "QQQ" else "dispatch", "refusal": "x"} for item in inputs]
        return {"ran": True, "probes": [], "lock": {"dispatchState": "not-dispatched"}, "notRehearsed": [], "requests": rows}

    monkeypatch.setattr(dr, "rehearse_requests", requests)
    window = {"rule": "test", "start": dates[-120], "end": dates[-30]}
    out = dr.rehearse_window(data, facts, window, 1_000_000.0, False, bench)
    stopped = {(trade["symbol"], trade["stoppedAt"]) for trade in out["trades"] if trade["sleeve"] == "oil-predicts-equity/B"}
    assert stopped == {("QQQ", "paper deployment request"), ("SPY", "request -> engine")}
    refused = [item for item in out["refusals"] if item["cause"] == "request:refused"]
    assert [item["symbol"] for item in refused] == ["QQQ"]


def test_a_trade_open_at_the_end_of_the_data_is_at_risk_on_the_last_day(dr, monkeypatch, bench):
    data, facts, dates = _pie_data()
    monkeypatch.setattr(dr, "rehearse_requests", lambda inputs: {
        "ran": False, "why": "not in this test", "requests": [], "probes": []})
    out = dr.rehearse_window(data, facts, dr.contrast_window(data.calendar), 1_000_000.0, False, bench)
    assert "end" in out["exitReasons"]
    assert out["deployment"]["daily"][-1]["t"] == dates[-1] and out["deployment"]["daily"][-1]["atRiskPct"] > 0
    assert {trade["stoppedAt"] for trade in out["trades"]} == {"paper deployment request (not rehearsed)"}
    steps = {step["step"]: step for step in dr.chain_steps({"w": out})}
    assert (steps["paper deployment request"]["ran"], steps["paper deployment request"]["note"]) == ("no", "not in this test")


def test_a_small_account_sizes_every_trade_to_zero(dr, monkeypatch, bench):
    out, _window_used, _dates = _window(dr, monkeypatch, bench, capital=2_000.0)
    counts = out["counts"]
    assert counts["sized"] == 0 and counts["sizedToZero"] == counts["acceptedByCaps"] > 0
    assert {trade["stoppedAt"] for trade in out["trades"]} == {"sizing"}
    # no sized trade, so no engine, policy or exit stop; "busy" is the put-credit sleeve holding its spread
    assert {item["cause"] for item in out["refusalsByCause"]} == {"size:zero", "busy"}
    assert out["deployment"]["averageAtRiskPct"] == 0.0


def test_importing_the_policy_writes_no_bytecode_into_the_exec_node(dr):
    assert not (Path(dr.arm_gate.__file__).parent / "__pycache__").exists()


def test_the_name_cap_refuses_the_third_spread_in_one_etf(dr, monkeypatch, bench):
    out, _window_used, _dates = _window(dr, monkeypatch, bench, leader="SPY")
    # long index 1% + rotation 1% in SPY fill the 2% per-name cap: the SPY put credit spread is refused
    refused = [item for item in out["refusals"] if item["cause"] == "cap:nameRisk"]
    assert refused and {(item["sleeve"], item["symbol"]) for item in refused} == {("regime-put-vrp/A", "SPY")}
    assert out["counts"]["refusedByCaps"] == len(refused)
    assert out["counts"]["offered"] == out["counts"]["acceptedByCaps"] + len(refused)
