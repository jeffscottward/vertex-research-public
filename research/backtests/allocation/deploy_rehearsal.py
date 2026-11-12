"""Deployability rehearsal of the funded pie, on paper only (card vertex-deploy-readiness-dryrun).

Replays one strong-market window and the last three months through every step between a signal and an
exit, and records for each step whether code exists, whether it ran here and what it refused:

  signal -> sleeve budget and caps -> sizing -> paper deployment request -> engine strategy
  -> order -> order policy -> simulated fill -> exit rule

It places no order, creates no deployment request row and reads no account. It does not arm anything
and it never contacts the Quant VPS, the Vertex database or a broker:

- signals, caps, sizing, fills and exits are the functions of funded_pie.py (option model of options.py);
- the deployment-request rules run in a `bun` child process (scripts/research-deploy-rehearsal-requests.ts)
  without a database;
- the order policy is `arm_gate.check_order_policy` (infra/quant-vps/exec-node), a read-only check, run
  in this process against a temporary account-snapshot file that this script writes and deletes;
- no engine strategy reads a deployment request. The orders checked here are built by a shim in this
  file (`leg_orders`); they are labelled as such in the output.

The window rule is fixed before any result is read: the six full calendar months with the highest SPY
total return since the first full month in which all three sleeves can run. Every window starts with no
position; a monthly decision belongs to a window when its entry bar (the next session) is in the window.
The counts of the engine, policy and exit stops are "would also stop here" counts: every sized trade is
checked at those steps, although it already stops at the request step.

Run (rig, venv with the Nautilus lock):
  python research/backtests/allocation/deploy_rehearsal.py --data <qc-ports data dir> \
      --capital <account value, rounded> --out <report work dir>/rehearsal.json
"""
from __future__ import annotations

import argparse
import ast
import dataclasses
import json
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "services" / "research"))
sys.path.insert(0, str(ROOT / "infra" / "quant-vps" / "exec-node" / "runtime" / "nautilus"))

# The exec-node folder must stay exactly its listed files (test_exec_node.py): no __pycache__ from this import.
_bytecode = sys.dont_write_bytecode
sys.dont_write_bytecode = True
import arm_gate  # noqa: E402

sys.dont_write_bytecode = _bytecode
import funded_pie as fp  # noqa: E402
import run as base  # noqa: E402
from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports import book as bk  # noqa: E402
from strategies.qc_ports import ideas as qi  # noqa: E402
from strategies.qc_ports import options as om  # noqa: E402
from strategies.qc_ports import portfolio as pf  # noqa: E402
from strategies.qc_ports import study  # noqa: E402
from strategies.qc_ports.calendar import parse  # noqa: E402
from strategies.qc_ports.data import IV_INDEX  # noqa: E402
from strategies.qc_ports.ledger import run_ledger  # noqa: E402

WINDOW_MONTHS = 6
CORE7 = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
CONTRAST_SESSIONS = 63
OPEN = "9999-12-31"
REQUEST_CLI = ROOT / "scripts" / "research-deploy-rehearsal-requests.ts"
ENGINE_SOURCE = ROOT / "infra" / "quant-vps" / "exec-node" / "runtime" / "nautilus" / "run_live.py"
TARGET_RISK_PCT = sum(budget for _sleeve, budget in fp.POOL.values())

# cause -> (kind, "missing piece" | "collision" | "rule working as designed", what it means)
CAUSES = {
    "gate:volRegime": ("gate", "rule", "The volatility-regime gate was closed at the month end."),
    "signal:noMember": ("signal", "rule", "The rotation selected no ETF: none had positive 12-1 momentum with a volatility index."),
    "signal:false": ("signal", "rule", "The entry rule was false."),
    "busy": ("signal", "rule", "The sleeve still held its last spread in that ETF."),
    "data:noIvIndex": ("data", "missing", "The ETF has no volatility index on that date, so no option price."),
    "data:book": ("data", "missing", "The option model could not price the spread."),
    "cap:openRisk": ("cap", "collision", "The 4% open-risk cap was full."),
    "cap:sleeveRisk": ("cap", "collision", "The sleeve budget was full: the last spread of the sleeve was still open."),
    "cap:maxPositions": ("cap", "collision", "The position count cap was full."),
    "cap:nameRisk": ("cap", "collision", "The 2% per-name cap was full."),
    "size:zero": ("sizing to 0 contracts", "collision", "One contract can lose more than the position budget, or cash is short."),
    "request:refused": ("deployment request", "missing", "The request rules refused the request."),
    "request:notDispatched": ("missing wiring", "missing",
                              "An approved paper request is a record. Nothing sends it to the engine."),
    "engine:noIntake": ("missing wiring", "missing",
                        "The engine runs the observation strategy only and reads no request and no signal."),
    "policy:combo_refused": ("order policy", "collision",
                             "The policy refuses a combo order. Every sleeve of the pie is a vertical spread."),
    "policy:short_option_open": ("order policy", "collision",
                                 "The policy refuses an opening option sale: the short leg cannot be opened."),
    "policy:max_loss_exceeded": ("order policy", "collision",
                                 "The long leg alone costs more than 2% of the account: the policy caps "
                                 "premium per order, the pie caps the loss of the spread."),
    "policy:other": ("order policy", "collision", "The policy refused the order for another reason (code in the detail)."),
    "exit:noEngineCode": ("missing wiring", "missing", "The engine has no code for the owner exit rule."),
}


# --------------------------------------------------------------------------- windows

def strong_window(dates, adj_close, first_month: str, months: int = WINDOW_MONTHS) -> dict:
    """The `months` full calendar months with the highest total return, first month >= `first_month`.

    The last month of the data is not used (it may be incomplete). Returns the rule, the window and the
    five best windows, so a reader can check the pick.
    """
    by_month: dict[str, list[int]] = {}
    for index, day in enumerate(dates):
        by_month.setdefault(day[:7], []).append(index)
    names = sorted(by_month)
    ranked = []
    for position, month in enumerate(names):
        last = position + months - 1
        if month < first_month or position == 0 or last >= len(names) - 1:
            continue
        before = by_month[names[position - 1]][-1]
        end = by_month[names[last]][-1]
        ranked.append((adj_close[end] / adj_close[before] - 1.0, dates[by_month[month][0]], dates[end]))
    if not ranked:
        raise ValueError("No full window in the data")
    ranked.sort(key=lambda item: (-item[0], item[1]))
    best = ranked[0]
    return {"rule": f"the {months} full calendar months with the highest SPY total return since {first_month}",
            "start": best[1], "end": best[2], "return": best[0],
            "top": [{"start": start, "end": end, "return": value} for value, start, end in ranked[:5]]}


def contrast_window(calendar, sessions: int = CONTRAST_SESSIONS) -> dict:
    """The last `sessions` sessions, moved back to the entry day of the last monthly decision before them.

    The rehearsal starts each window with no position, so a window that starts in the middle of a month
    would show nothing at risk until the next month end.
    """
    first = len(calendar) - sessions
    entries = [index + 1 for index in pf.month_end_indices(calendar) if index + 1 <= first]
    return {"rule": f"the last {sessions} sessions of the data (three months), from the entry day of the last "
                    "monthly decision before them", "start": calendar[entries[-1] if entries else first], "end": calendar[-1]}


# --------------------------------------------------------------------------- step 1: signals

def _gate_detail(data: pf.Dataset, day: str, rule: dict) -> str:
    """Which condition of the volatility-regime gate was false on `day` (for the report text)."""
    def last(series_id: str):
        values = data.series.get(series_id) or {}
        days = [key for key in values if key <= day]
        return values[max(days)] if days else None

    vix, far = last("VIX"), last("VIX3M")
    bars = data.bars["SPY"]
    closes = [close for date, close in zip(bars.dates, bars.close) if date <= day]
    length = rule["trendLength"]
    parts = []
    if vix is not None and vix > rule["maxVix"]:
        parts.append(f"VIX {vix:.1f} above {rule['maxVix']}")
    if vix is not None and far and vix / far > rule["maxTermRatio"]:
        parts.append(f"VIX/VIX3M {vix / far:.2f} above {rule['maxTermRatio']}")
    if len(closes) >= length and closes[-1] <= sum(closes[-length:]) / length:
        parts.append(f"SPY below its {length}-day average")
    return "; ".join(parts) or "gate closed"


def trace_signals(key: str, definition: dict, data: pf.Dataset, sleeve_start: str, start: str, end: str) -> tuple[list, list]:
    """(trades that enter in [start, end], stops) of one sleeve.

    Every sleeve of the pie decides at month ends and enters on the next bar. A decision belongs to the
    window when its entry bar is in the window, so the decision of the last month end before `start`
    counts and the one at `end` does not. A stop is a decision without a trade, with its cause. The
    trades are those of `allocation.owner_rule_trades` (same prices, same owner exits); this function
    adds the reasons and raises if it does not find exactly those trades.
    """
    al.sig.normalize_definition(definition)
    legs, flags, selected = pf._signals(definition, data, None)
    before = [day for day in data.calendar if day < start]
    signal_start = max(sleeve_start, before[-1] if before else start)
    priced = [trade for trade in al.owner_rule_trades(definition, data, start=signal_start) if start <= trade.entry_date <= end]
    by_entry = {(trade.symbol, trade.entry_index): trade for trade in priced}
    gate = next((item for item in definition.get("filters", []) if item.get("type") == "volRegime"), None)
    ungated = None
    if gate is not None:  # the same sleeve without its gate: tells a closed gate from a false entry rule
        opened = {**definition, "filters": [item for item in definition["filters"] if item is not gate]}
        al.sig.normalize_definition(opened)
        ungated = pf._signals(opened, data, None)[1]
    trades, stops, months, booked = [], [], {}, set()
    for leg in legs:
        market = pf.market_of(data, leg.symbol)
        dates = market.dates
        join = pf._join_index(market)
        entries, exits = flags[leg.order]
        options = al.hold_options(leg.definition["options"])
        held = dataclasses.replace(leg, definition={**leg.definition, "options": options})
        chosen = None if selected is None else selected[leg.order]
        leg_trades, skips, _count = pf.leg_trades(held, data, signal_start, entries, exits, chosen)
        booked.update((trade.symbol, trade.entry_index) for trade in leg_trades if start <= trade.entry_date <= end)
        skipped = {item.event.entry_index: item.reason for item in skips}
        for index in pf.month_end_indices(dates):
            day = dates[index]
            if index + 1 >= len(dates) or not start <= dates[index + 1] <= end or day < signal_start:
                continue
            signalled = index >= join and entries[index] and (chosen is None or day in chosen)
            if selected is not None:  # a rotation: one decision per month, made for the ETF it selects
                months[day[:7]] = (months.get(day[:7], (False, day))[0] or signalled, day)
                if not signalled:
                    continue
            if index < join:
                stop = ("data:noIvIndex", f"{leg.symbol} has no volatility index on that date")
            elif not entries[index]:
                closed = ungated is not None and ungated[leg.order][0][index]
                stop = ("gate:volRegime", _gate_detail(data, day, gate)) if closed else ("signal:false", "entry rule false")
            elif (leg.symbol, index + 1) in by_entry:
                trades.append(by_entry[(leg.symbol, index + 1)])
                continue
            elif index in skipped:
                stop = ("data:book", skipped[index])
            else:
                stop = ("busy", f"the last {leg.symbol} spread of the sleeve was still open")
            stops.append({"date": day, "sleeve": key, "symbol": leg.symbol, "cause": stop[0], "detail": stop[1]})
    stops.extend({"date": day, "sleeve": key, "symbol": None, "cause": "signal:noMember",
                  "detail": CAUSES["signal:noMember"][2]} for _month, (hit, day) in sorted(months.items()) if not hit)
    trades.sort(key=lambda trade: (trade.entry_date, trade.symbol))
    # three views of the same entries: the book of each leg, owner_rule_trades, and the decisions walked above
    if not booked == set(by_entry) == {(trade.symbol, trade.entry_index) for trade in trades}:
        raise RuntimeError(f"The signal trace of {key} does not find the trades of allocation.owner_rule_trades")
    return trades, stops


# --------------------------------------------------------------------------- step 2: caps

def trace_caps(books: dict, risk_pct: dict, caps: al.Caps) -> tuple[al.Combined, list]:
    """`allocation.combine` plus the date and the cause of each refusal.

    `combine` keeps counts only. The loop repeats its order with its own `_refusal` to date each refusal;
    it must accept the same trades in the same order and count the same refusals, or this raises.
    """
    combined = al.combine(books, risk_pct, caps)
    order = {key: position for position, key in enumerate(books)}
    queue = sorted(((trade.entry_date, order[key], trade.trade_id, key, trade)
                    for key, trades in books.items() if risk_pct.get(key, 0.0) > 0 for trade in trades),
                   key=lambda item: item[:3])
    open_trades, refused, accepted = [], [], []
    for entry_date, _order, _id, key, trade in queue:
        open_trades = [item for item in open_trades if item[0] > entry_date]
        sleeve = caps.sleeve_of.get(key)
        reason = al._refusal(open_trades, trade.symbol, sleeve, risk_pct[key], caps)
        if reason is not None:
            refused.append({"date": entry_date, "sleeve": key, "symbol": trade.symbol, "cause": f"cap:{reason}",
                            "detail": CAUSES[f"cap:{reason}"][2]})
            continue
        accepted.append(trade)
        open_trades.append((trade.exit_date, trade.symbol, risk_pct[key], sleeve))
    counts: dict[str, dict[str, int]] = {}
    for item in refused:
        bucket = counts.setdefault(item["sleeve"], {})
        bucket[item["cause"][4:]] = bucket.get(item["cause"][4:], 0) + 1
    same = [(t.symbol, t.entry_date, t.exit_date, t.entry_price) for t in accepted] == [
        (t.symbol, t.entry_date, t.exit_date, t.entry_price) for t in combined.trades]
    if counts != {key: dict(value) for key, value in combined.refused.items()} or not same:
        raise RuntimeError("The cap trace and allocation.combine disagree")
    return combined, refused


# --------------------------------------------------------------------------- steps 4-5: request, engine

def request_inputs(trades_by_key: dict, contracts: dict, capital: float) -> list[dict]:
    """One paper deployment request per sleeve and symbol (a request names exactly one symbol)."""
    inputs = []
    for key, trades in trades_by_key.items():
        for symbol in sorted({trade.symbol for trade in trades}):
            size = max([contracts.get((key, trade.entry_date, trade.symbol), 0) for trade in trades
                        if trade.symbol == symbol] + [1])
            inputs.append({"strategyId": "library:qc-" + key.split("/")[0], "symbol": symbol, "timeframe": "1d", "mode": "paper",
                           "limits": {"maxOrderSize": size, "maxPosition": size, "maxOrdersPerMinute": 2,
                                      "dailyLossLimit": round(capital * fp.POSITION_RISK_PCT / 100.0, 2)}})
    return inputs


def rehearse_requests(inputs: list[dict]) -> dict:
    """The request rules of the API and the repository, in a child process, or why they did not run."""
    probes = [{**(inputs[0] if inputs else {"strategyId": "library:probe", "timeframe": "1d",
                                            "limits": {"maxOrderSize": 1, "maxPosition": 1,
                                                       "maxOrdersPerMinute": 1, "dailyLossLimit": 1}}),
               "symbol": ",".join(CORE7), "mode": "paper"},
              {**(inputs[0] if inputs else {"strategyId": "library:probe", "symbol": "SPY", "timeframe": "1d",
                                            "limits": {"maxOrderSize": 1, "maxPosition": 1,
                                                       "maxOrdersPerMinute": 1, "dailyLossLimit": 1}}),
               "mode": "live"}]
    bun = shutil.which("bun")
    if bun is None:
        return {"ran": False, "why": "bun is not installed", "requests": [], "probes": []}
    try:
        done = subprocess.run([bun, "--no-env-file", str(REQUEST_CLI)], input=json.dumps(inputs + probes),
                              capture_output=True, text=True, cwd=ROOT, timeout=120, check=True)
        report = json.loads(done.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        detail = getattr(error, "stderr", None) or str(error)
        return {"ran": False, "why": detail.strip()[-400:], "requests": [], "probes": []}
    rows = [{**outcome, "input": item} for outcome, item in zip(report["requests"], inputs + probes)]
    names = ["one request for all Core 7 symbols", "mode live"]
    return {"ran": True, "requests": rows[:len(inputs)],
            "probes": [{**row, "probe": name} for row, name in zip(rows[len(inputs):], names)],
            "lock": report["lock"], "notRehearsed": report["notRehearsed"]}


def engine_intake() -> dict:
    """Static read of the engine runner (its syntax tree and text): the strategy classes it builds, and
    whether anything calls its order intake or names a deployment request or an exit rule."""
    source = ENGINE_SOURCE.read_text()
    calls = [node.func for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)]
    names = [func.id if isinstance(func, ast.Name) else func.attr for func in calls if isinstance(func, ast.Name | ast.Attribute)]
    text = source.lower()
    facts = {"file": str(ENGINE_SOURCE.relative_to(ROOT)),
             "strategies": sorted({name for name in names if name.endswith("Strategy")}),
             "readsDeploymentRequests": "deployment_request" in text or "deploymentrequest" in text,
             "orderIntentCallers": names.count("submit_order_intent"),
             "ownerExitRuleCode": any(word in text for word in ("loser", "exit_dte", "days_to_expiry", "expiry_close"))}
    facts["noIntake"] = (facts["strategies"] == ["SafeExampleStrategy"] and not facts["readsDeploymentRequests"]
                         and facts["orderIntentCallers"] == 0)
    return facts


# --------------------------------------------------------------------------- steps 6-7: order, policy

def leg_mids(trade, data: pf.Dataset) -> tuple[float, float]:
    """Entry mid per share of the long and the short leg, priced as book._price_event prices them."""
    market = pf.market_of(data, trade.symbol)
    entry = trade.entry_index
    right, kind = bk.STRUCTURES[trade.structure]
    expiry = parse(trade.expiry)
    days = (expiry - parse(market.dates[entry])).days
    pricing = bk._Pricing(market.close[entry], days / bk.DAYS_PER_YEAR, market.rate[entry],
                          om.DIVIDEND_YIELD.get(trade.symbol, 0.0),
                          om.atm_iv(IV_INDEX[trade.symbol], market.iv_index[entry]), om.SKEW[trade.symbol])
    long_mid, short_mid = bk.spread_legs(pricing, right, trade.long_strike, trade.short_strike)
    if abs(bk.instrument_value(kind, long_mid, short_mid, trade.width) - trade.entry_price) > 0.011:
        raise RuntimeError(f"Leg prices of {trade.symbol} {trade.entry_date} do not rebuild the spread price")
    return long_mid, short_mid


def _option(trade, strike: float) -> SimpleNamespace:
    right = "C" if "call" in trade.structure.lower() else "P"
    return SimpleNamespace(symbol=trade.symbol, secType="OPT", currency="USD", tradingClass=trade.symbol,
                           exchange="SMART", lastTradeDateOrContractMonth=trade.expiry.replace("-", ""),
                           right=right, strike=float(strike), multiplier="100")


def _order(action: str, quantity: int, price: float) -> SimpleNamespace:
    return SimpleNamespace(action=action, totalQuantity=Decimal(quantity), orderType="LMT", lmtPrice=round(price, 2), whatIf=False)


def leg_orders(trade, contracts: int, long_mid: float, short_mid: float) -> dict:
    """SHIM (no engine code builds these): the orders that would open `trade`, as ibapi-shaped objects.

    combo: one BAG order that buys the vertical (long leg bought, short leg sold) at the net price of the
    legs; a credit vertical has a negative price. Then the long leg and the short leg as single orders.
    """
    combo = SimpleNamespace(symbol=trade.symbol, secType="BAG", currency="USD", exchange="SMART",
                            comboLegs=[SimpleNamespace(action="BUY", ratio=1, strike=trade.long_strike),
                                       SimpleNamespace(action="SELL", ratio=1, strike=trade.short_strike)])
    return {"combo": (combo, _order("BUY", contracts, long_mid - short_mid)),
            "longLeg": (_option(trade, trade.long_strike), _order("BUY", contracts, max(long_mid, 0.01))),
            "shortLeg": (_option(trade, trade.short_strike), _order("SELL", contracts, max(short_mid, 0.01)))}


def _held(trade, strike: float, quantity: int) -> dict:
    contract = _option(trade, strike)
    return {"symbol": trade.symbol, "sec_type": "OPT", "currency": "USD", "quantity": quantity,
            "contract": {"symbol": trade.symbol, "secType": "OPT", "exchange": "", "currency": "USD",
                         "lastTradeDateOrContractMonth": contract.lastTradeDateOrContractMonth,
                         "strike": contract.strike, "right": contract.right, "multiplier": "100",
                         "tradingClass": trade.symbol, "conId": 0}}


class PolicyBench:
    """`arm_gate.check_order_policy` against a temporary account snapshot (never the live node)."""

    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="deploy-rehearsal-policy-"))
        # Both paths the policy reads stay inside the temporary folder (the reservation file never exists).
        self.env = {"NAUTILUS_ACCOUNT_SNAPSHOT_DIR": str(self.dir),
                    arm_gate.RESERVATIONS_ENV: str(self.dir / "order-policy-reservations.json")}

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def check(self, contract, order, net_liquidation: float, positions: list | None = None) -> str:
        """The policy decision (`long_option_open`, `position_close`) or `refused:<code>`."""
        for old in self.dir.glob("ibkr-account-snapshot-*.json"):
            old.unlink()
        now = time.time()
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now))
        (self.dir / f"ibkr-account-snapshot-{stamp}.json").write_text(json.dumps({
            "schemaVersion": "ibkr-account-snapshot/v1", "captured_at_epoch": now - 1, "positions": positions or [],
            "summary": {"NetLiquidation": {"USD": f"{net_liquidation:.2f}"}}}))
        try:
            return arm_gate.check_order_policy(contract, order, env=self.env)
        except arm_gate.OrderPolicyError as error:
            return f"refused:{error.code}"


def policy_trace(trade, contracts: int, equity: float, data: pf.Dataset, bench: PolicyBench) -> dict:
    """The policy decision for the combo order, for each leg, and for the close of the long leg."""
    long_mid, short_mid = leg_mids(trade, data)
    orders = leg_orders(trade, contracts, long_mid, short_mid)
    held = [_held(trade, trade.long_strike, contracts)]
    return {"longMid": round(long_mid, 4), "shortMid": round(short_mid, 4),
            "longLegPremiumPct": 100.0 * contracts * round(max(long_mid, 0.01), 2) * 100 / equity,
            "combo": bench.check(*orders["combo"], equity),
            "longLeg": bench.check(*orders["longLeg"], equity),
            "shortLeg": bench.check(*orders["shortLeg"], equity, held),
            "closeLongLeg": bench.check(_option(trade, trade.long_strike), _order("SELL", contracts, max(long_mid, 0.01)),
                                        equity, held)}


def leveraged_probe(capital: float, bench: PolicyBench) -> list[dict]:
    """WHAT-IF, policy only: a single long call on a leveraged ETF at an example premium of $5.00.

    The study data has no leveraged ETF and no option price for one, so signal, caps, sizing, fill and
    exit are not rehearsed for this form.
    """
    premium = 5.0
    fit = int(capital * float(arm_gate.DEFAULT_MAX_LOSS_PCT) / 100.0 // (premium * 100))
    rows = []
    for symbol in ("TQQQ", "SOXL", "UPRO"):
        contract = SimpleNamespace(symbol=symbol, secType="OPT", currency="USD", tradingClass=symbol, exchange="SMART",
                                   lastTradeDateOrContractMonth="20261218", right="C", strike=100.0, multiplier="100")
        shares = SimpleNamespace(symbol=symbol, secType="STK", currency="USD", exchange="SMART")
        rows.append({"symbol": symbol, "examplePremium": premium, "contractsAt2Pct": fit,
                     "longCall": bench.check(contract, _order("BUY", fit, premium), capital),
                     "longCallOneMore": bench.check(contract, _order("BUY", fit + 1, premium), capital),
                     "sharesBuyWhatIf": bench.check(shares, _order("BUY", 100, 50.0), capital)})
    return rows


# --------------------------------------------------------------------------- one window

def rehearse_window(data: pf.Dataset, facts, window: dict, capital: float, nautilus: bool, bench: PolicyBench) -> dict:
    start, end = window["start"], window["end"]
    runs = qi.family(facts)
    made = fp.sleeve_definitions(runs, facts)
    refusals: list[dict] = []
    books, offered = {}, 0
    for key in fp.POOL:
        trades, stops = trace_signals(key, made[key][0], data, made[key][1], start, end)
        books[key] = trades
        offered += len(trades)
        refusals.extend(stops)
    calendar = data.calendar
    decisions = [calendar[index] for index in pf.month_end_indices(calendar)
                 if index + 1 < len(calendar) and start <= calendar[index + 1] <= end]

    caps = al.Caps(open_risk_pct=fp.OPEN_RISK_CAP_PCT, name_risk_pct=fp.NAME_RISK_CAP_PCT,
                   sleeve_of={key: fp.POOL[key][0] for key in fp.POOL},
                   sleeve_risk_pct={sleeve: budget for sleeve, budget in fp.POOL.values()})
    risk = dict.fromkeys(fp.POOL, fp.POSITION_RISK_PCT)
    combined, cap_refusals = trace_caps(books, risk, caps)
    refusals.extend(cap_refusals)

    dates = [day for day in data.calendar if day >= start]
    if nautilus:
        result, gap, engine = base.nautilus_run(combined.trades, capital, dates)
    else:
        result, gap, engine = run_ledger(combined.trades, capital, dates=dates), None, "ledger only"
    sized = {record["id"]: record for record in result.trades}
    equity_on = dict(zip(result.dates, result.equity))
    for item in result.skipped:
        refusals.append({"date": item["entryDate"], "sleeve": combined.owner[item["id"]], "symbol": item["symbol"],
                         "cause": "size:zero", "detail": CAUSES["size:zero"][2]})

    contracts = {(combined.owner[number], trade.entry_date, trade.symbol): sized[number]["contracts"]
                 for number, trade in ((t.trade_id, t) for t in combined.trades) if number in sized}
    taken = {key: [t for t in combined.trades if combined.owner[t.trade_id] == key and t.trade_id in sized]
             for key in fp.POOL}
    requests = rehearse_requests(request_inputs({key: value for key, value in taken.items() if value}, contracts, capital))
    engine_facts = engine_intake()

    request_of = {(item["input"]["strategyId"], item["input"]["symbol"]): item for item in requests["requests"]}
    dispatched = requests["ran"] and requests["lock"]["dispatchState"] != "not-dispatched"
    trade_rows, exits, reached = [], Counter(), 0
    for trade in combined.trades:
        key = combined.owner[trade.trade_id]
        row = {"id": trade.trade_id, "sleeve": key, "symbol": trade.symbol, "structure": trade.structure,
               "entryDate": trade.entry_date, "exitDate": trade.exit_date, "expiry": trade.expiry,
               "longStrike": trade.long_strike, "shortStrike": trade.short_strike,
               "maxLossPerContract": trade.max_loss, "budgetPct": trade.max_loss_pct}
        record = sized.get(trade.trade_id)
        if record is None:
            row.update({"contracts": 0, "stoppedAt": "sizing"})
            trade_rows.append(row)
            continue
        request = request_of.get(("library:qc-" + key.split("/")[0], trade.symbol))
        if request is None:
            stopped = "paper deployment request (not rehearsed)"
        elif request["status"] != "approved":
            stopped = "paper deployment request"
        elif not dispatched:
            stopped = "request -> engine"
        elif engine_facts["noIntake"]:
            stopped = "engine strategy"
        else:
            stopped = None
            reached += 1
        equity = equity_on.get(trade.entry_date, capital)
        policy = policy_trace(trade, record["contracts"], equity, data, bench)
        row.update({"contracts": record["contracts"], "riskPct": 100.0 * record["contracts"] * trade.max_loss / equity,
                    "pnl": record["pnl"], "exitReason": record["exitReason"], "policy": policy, "stoppedAt": stopped})
        exits[record["exitReason"]] += 1
        stop = {"sleeve": key, "symbol": trade.symbol}
        if engine_facts["noIntake"]:
            refusals.append({**stop, "date": trade.entry_date, "cause": "engine:noIntake", "detail": CAUSES["engine:noIntake"][2]})
        for name in ("combo", "shortLeg", "longLeg"):  # orders built by the shim, not by the engine
            if policy[name].startswith("refused:"):
                cause = f"policy:{policy[name][8:]}"
                known = cause if cause in CAUSES else "policy:other"
                refusals.append({**stop, "date": trade.entry_date, "cause": known, "shim": True,
                                 "detail": f"{name} ({policy[name][8:]}): {CAUSES[known][2]}"})
        if not engine_facts["ownerExitRuleCode"]:
            refusals.append({**stop, "date": trade.exit_date, "cause": "exit:noEngineCode", "detail": CAUSES["exit:noEngineCode"][2]})
        trade_rows.append(row)
    for item in requests["requests"]:
        cause = "request:notDispatched" if item["refusedAt"] == "dispatch" else "request:refused"
        refusals.append({"date": start, "sleeve": item["input"]["strategyId"], "symbol": item["input"]["symbol"],
                         "cause": cause, "detail": item["refusal"]})

    max_loss = {trade.trade_id: trade.max_loss for trade in combined.trades}
    # A trade closed only because the data ends (exit reason "end") is still open on the last day.
    budget = [(trade.entry_date, OPEN if trade.exit_reason == "end" else trade.exit_date, trade.max_loss_pct)
              for trade in combined.trades]
    spans = [(r["entryDate"], OPEN if r["exitReason"] == "end" else r["exitDate"], r["contracts"] * max_loss[r["id"]])
             for r in result.trades]
    daily = []
    for day, equity in zip(result.dates, result.equity):
        if day > end:
            break
        at_risk = 100.0 * sum(amount for first, last, amount in spans if first <= day < last) / equity
        reserved = sum(pct for first, last, pct in budget if first <= day < last)
        daily.append({"t": day, "atRiskPct": at_risk, "reservedPct": reserved, "equity": equity})
    if not daily:
        raise ValueError(f"No session between {start} and {end}")
    average = sum(item["atRiskPct"] for item in daily) / len(daily)
    by_cause = Counter(item["cause"] for item in refusals)
    unknown = sorted(set(by_cause) - set(CAUSES))
    if unknown:
        raise RuntimeError(f"Stops without a class: {unknown}")
    return {
        "window": window, "decisionDays": decisions, "engine": engine, "nautilusGap": gap,
        "symbolsWithoutIvAtStart": sorted(symbol for symbol in CORE7 if facts.iv_start[symbol] > start),
        "counts": {"offered": offered, "refusedByCaps": len(cap_refusals), "acceptedByCaps": len(combined.trades),
                   "sizedToZero": len(result.skipped), "sized": len(result.trades),
                   "requestsApproved": sum(1 for item in requests["requests"] if item["status"] == "approved"),
                   # no call in this file sends an order: the count is 0 by construction
                   "reachedEngine": reached, "ordersSent": 0},
        "refusals": refusals,
        "refusalsByCause": [{"cause": cause, "count": count, "kind": CAUSES[cause][0], "class": CAUSES[cause][1],
                             "meaning": CAUSES[cause][2]} for cause, count in sorted(by_cause.items())],
        "requests": requests, "engineIntake": engine_facts, "trades": trade_rows, "exitReasons": dict(exits),
        "deployment": {"targetPct": TARGET_RISK_PCT, "openCapPct": fp.OPEN_RISK_CAP_PCT, "averageAtRiskPct": average,
                       "peakAtRiskPct": max(item["atRiskPct"] for item in daily),
                       "averageReservedPct": sum(item["reservedPct"] for item in daily) / len(daily),
                       "averageUnusedPct": TARGET_RISK_PCT - average,
                       "daysAtZero": sum(1 for item in daily if item["atRiskPct"] == 0.0), "days": len(daily),
                       "daily": daily},
        "finalEquity": result.equity[-1], "pnl": sum(record["pnl"] for record in result.trades),
    }


def chain_steps(windows: dict) -> list[dict]:
    """One row per chain step, over all windows: does code exist, did it run here, how many stops."""
    def total(*prefixes: str) -> int:
        return sum(item["count"] for window in windows.values() for item in window["refusalsByCause"]
                   if item["cause"].startswith(prefixes))

    runs = list(windows.values())
    intake = runs[0]["engineIntake"]
    requests = [window["requests"] for window in runs]
    requests_ran = all(item["ran"] for item in requests)
    rows = [row for item in requests for row in item["requests"]]
    approved = sum(1 for row in rows if row["status"] == "approved")
    nautilus = all(window["nautilusGap"] is not None for window in runs)
    no_code = "no" if intake["noIntake"] else "CHECK: the static read found an intake"
    return [
        {"step": "signal", "exists": "yes (research code)", "ran": "yes", "refused": total("gate:", "signal:", "busy", "data:"),
         "note": "qc_ports signals on daily data; the option price is a model, not a quote"},
        {"step": "sleeve budget and caps", "exists": "yes (research code)", "ran": "yes", "refused": total("cap:"),
         "note": "allocation.combine: 1% per position, 4% open, 2% per name, sleeve budgets"},
        {"step": "sizing", "exists": "yes (research code)", "ran": "yes", "refused": total("size:"),
         "note": "book.contracts_for: whole contracts inside the position budget"},
        {"step": "paper deployment request", "exists": "yes (web app)",
         "ran": "yes (rules only, no row)" if requests_ran else "no", "refused": total("request:refused"),
         "note": f"{approved} of {len(rows)} requests pass the contract, the field rules, submit and approve; "
                 "strategy lookup and database checks not rehearsed" if requests_ran
         else "; ".join(sorted({item.get("why", "") for item in requests if not item["ran"]}))},
        {"step": "request -> engine", "exists": "no", "ran": "no (no code to run)", "refused": total("request:notDispatched"),
         "note": "an approved request stays a record: executionAuthorized false, dispatch not-dispatched"},
        {"step": "engine strategy", "exists": no_code, "ran": "static read only", "refused": total("engine:"),
         "note": f"{intake['file']} builds {', '.join(intake['strategies']) or 'no strategy'}; "
                 f"callers of its order intake: {intake['orderIntentCallers']}"},
        {"step": "order built by the engine", "exists": no_code, "ran": "shim in the rehearsal", "refused": 0,
         "note": "the rehearsal builds the option orders itself (leg_orders)"},
        {"step": "order policy", "exists": "yes (engine)", "ran": "yes (test process, shim orders)", "refused": total("policy:"),
         "note": "arm_gate.check_order_policy, options_only_defined_risk_v2"},
        {"step": "simulated fill", "exists": "research code only",
         "ran": "yes (ledger and NautilusTrader backtest)" if nautilus else "yes (ledger only)", "refused": 0,
         "note": "the engine has no paper or simulated fill path of its own"},
        {"step": "exit rule (owner 2026-11-03)", "exists": "research code only", "ran": "yes (research code)", "refused": total("exit:"),
         "note": "exit-rule code in the engine runner: " + ("found" if intake["ownerExitRuleCode"] else "none")
                 + "; the policy does allow closing a held long option"},
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", required=True)
    parser.add_argument("--capital", type=float, required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ledger-only", action="store_true", help="skip the NautilusTrader parity run")
    parser.add_argument("--extra-window", action="append", default=[], metavar="NAME=START:END",
                        help="one more window, for example full-core7=2020-04-01:2020-09-30")
    args = parser.parse_args()
    loaded = study.load_study_data(args.data)
    data = loaded.dataset
    spy = data.bars["SPY"]
    first_all = max(start for _definition, start in fp.sleeve_definitions(qi.family(loaded.facts), loaded.facts).values())
    year, month = int(first_all[:4]), int(first_all[5:7])
    first_month = f"{year + month // 12:04d}-{month % 12 + 1:02d}"
    windows = {"strong": strong_window(spy.dates, spy.adj_close, first_month), "contrast": contrast_window(data.calendar)}
    for item in args.extra_window:
        name, span = item.split("=", 1)
        windows[name] = {"rule": "added by hand as a check, not by the rule", "start": span.split(":")[0], "end": span.split(":")[1]}
    bench = PolicyBench()
    try:
        out = {name: rehearse_window(data, loaded.facts, window, args.capital, not args.ledger_only, bench)
               for name, window in windows.items()}
        leveraged = leveraged_probe(args.capital, bench)
    finally:
        bench.close()
    document = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "capital": args.capital,
                "dataEnd": data.calendar[-1], "optionModel": "study (options.py)", "policy": arm_gate.ORDER_POLICY,
                "policyMaxLossPct": float(arm_gate.DEFAULT_MAX_LOSS_PCT), "chain": chain_steps(out), "windows": out,
                "leveragedWhatIf": leveraged, "causes": {key: {"kind": v[0], "class": v[1], "meaning": v[2]} for key, v in CAUSES.items()},
                # The first three are true by construction: this file has no call that sends an order, opens a database or arms a node.
                "safety": {"ordersSent": 0, "rowsWritten": 0, "armed": False,
                           "policySnapshotDirRemoved": not bench.dir.exists()}}
    Path(args.out).write_text(json.dumps(document, indent=1))
    for name, window in out.items():
        print(name, window["window"]["start"], window["window"]["end"], window["counts"],
              {item["cause"]: item["count"] for item in window["refusalsByCause"]})


if __name__ == "__main__":
    main()
