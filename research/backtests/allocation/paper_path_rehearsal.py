"""Paper path rehearsal: the funded pie's trades through the engine paper path (paper only).

Card vertex-paper-deploy-path. It replays the same windows as deploy_rehearsal.py and sends each sized
trade down the paper path of services/execution/vertex_execution/paper_deploy:

    approved paper request -> paper strategy -> order policy -> simulated fill -> owner exit rule

What is real and what is a model:

- request: the create inputs go through the real request rules (API contract, field rules, the options
  block with its 2% ceiling, submit and approve) in a child process. No database row is written.
- strategy: `PaperSpreadStrategy` builds one combo order per trade. It computes no signal: strikes and
  expiry come from the research trade (the "intent"). It sizes the order itself.
- policy: the engine order policy `arm_gate.check_order_policy`, called through `ArmGatePolicy`, against
  a temporary account snapshot. `--policy-root` loads another `arm_gate.py` (for example policy v3 from
  its branch). The spreads switch is set only in the environment of this process.
- fill: `SimulatedPaperVenue` (the existing `PaperSimulator`). Quotes are the study option model: mid
  plus and minus the model half-spread. No real quote, no queue, no broker.
- exit: `decide_exit` once per session at the exit time (close minus 15 minutes). The monthly roll is the
  signal exit of the research trade. Marks are the daily model values.

Nothing here talks to a broker, a gateway, a database or the network. It arms nothing.

    python research/backtests/allocation/paper_path_rehearsal.py --data DIR --capital 360000 --out FILE
        [--extra-window name=start:end] [--policy-root DIR] [--spreads-decision URL]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import shutil
import subprocess
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "services" / "execution"))

import deploy_rehearsal as dr  # noqa: E402
import funded_pie as fp  # noqa: E402
from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports import book as bk  # noqa: E402
from strategies.qc_ports import ideas as qi  # noqa: E402
from strategies.qc_ports import options as om  # noqa: E402
from strategies.qc_ports import portfolio as pf  # noqa: E402
from strategies.qc_ports import study  # noqa: E402
from strategies.qc_ports.calendar import parse  # noqa: E402
from strategies.qc_ports.data import IV_INDEX  # noqa: E402
from strategies.qc_ports.ledger import run_ledger  # noqa: E402
from vertex_execution.paper_deploy.calendar import NYSE  # noqa: E402
from vertex_execution.paper_deploy.exit_rule import SpreadMark  # noqa: E402
from vertex_execution.paper_deploy.policy import ArmGatePolicy, synthetic_con_id  # noqa: E402
from vertex_execution.paper_deploy.runner import PaperPath  # noqa: E402
from vertex_execution.paper_deploy.strategy import SpreadIntent  # noqa: E402
from vertex_execution.paper_deploy.venue import (  # noqa: E402
    LegQuote,
    PaperVenueModel,
    SimulatedPaperVenue,
    SpreadQuote,
    epoch_ns,
)

NEW_YORK = ZoneInfo("America/New_York")
REQUEST_CLI = ROOT / "scripts" / "research-paper-path-requests.ts"
TICK = Decimal("0.01")
QUOTE_SIZE = 100_000
MAX_LOSS_PCT = 2.0
ENTRY_AFTER_EXIT = timedelta(minutes=5)
SPREADS_FLAG_ENV = "NAUTILUS_ORDER_POLICY_ALLOW_DEFINED_RISK_SPREADS"
OPEN_RISK_ENV = "NAUTILUS_ORDER_POLICY_OPEN_RISK_PATH"
EXPIRED_WORTHLESS = "expired_out_of_the_money"
OPEN_AT_END = "open_at_data_end"


# --------------------------------------------------------------------------- requests (F5)

def _options_block(definition: dict) -> dict:
    """The request `options` block of one sleeve, from its research definition."""
    options = (definition.get("legs") or [definition])[0]["options"]
    structure = options["structure"]
    kind = bk.STRUCTURES[structure][1]
    delta_key, default = ("longDelta", bk.DEFAULT_LONG_DELTA) if kind == "debit" else ("shortDelta", bk.DEFAULT_SHORT_DELTA)
    if "widthSigma" not in options:
        raise RuntimeError(f"{structure}: this rehearsal needs a width in sigma")
    return {"structure": structure, "dte": dict(options["dte"]),
            "width": {"unit": "sigma", "value": options["widthSigma"]},
            "anchorDelta": options.get(delta_key, default),
            "budgetPctOfAccount": fp.POSITION_RISK_PCT, "maxLossPctOfAccount": MAX_LOSS_PCT}


def request_items(taken: dict, contracts: dict, capital: float, made: dict) -> list[dict]:
    """Create inputs with the options block: one per sleeve and symbol, and one group for the rotation."""
    items = []
    for key, trades in taken.items():
        if not trades:
            continue
        symbols = sorted({trade.symbol for trade in trades})
        size = max([contracts.get((key, trade.entry_date, trade.symbol), 0) for trade in trades] + [1])
        base = {"strategyId": "library:qc-" + key.split("/")[0], "timeframe": "1d", "mode": "paper",
                "limits": {"maxOrderSize": size, "maxPosition": size, "maxOrdersPerMinute": 2,
                           "dailyLossLimit": round(capital * fp.POSITION_RISK_PCT / 100.0, 2)},
                "options": _options_block(made[key][0])}
        if fp.POOL[key][0] == "rotation":
            # The rotation trades one ETF of its universe at a time: one request per ETF, made together.
            items.append({"kind": "group", "sleeve": key, "input": {**base, "symbols": list(dr.CORE7)}})
        else:
            items.extend({"kind": "single", "sleeve": key, "input": {**base, "symbol": symbol}} for symbol in symbols)
    return items


def request_records(items: list[dict]) -> dict:
    """The request rules in a child process. Returns approved records, refusals and probes, or why it did not run."""
    probes = [
        {"kind": "single", "probe": "max loss 2.5% of the account",
         "input": {**items[0]["input"], "symbol": "SPY", "symbols": None,
                   "options": {**items[0]["input"]["options"], "maxLossPctOfAccount": 2.5}}},
        {"kind": "single", "probe": "mode live", "input": {**items[0]["input"], "symbol": "SPY", "symbols": None, "mode": "live"}},
        {"kind": "single", "probe": "old format (no options block)",
         "input": {key: value for key, value in {**items[0]["input"], "symbol": "SPY"}.items()
                   if key not in ("options", "symbols")}},
    ] if items else []
    for probe in probes:
        probe["input"] = {key: value for key, value in probe["input"].items() if value is not None}
    bun = shutil.which("bun")
    if bun is None:
        return {"ran": False, "why": "bun is not installed", "records": [], "refusals": [], "probes": []}
    try:
        done = subprocess.run([bun, "--no-env-file", str(REQUEST_CLI)], input=json.dumps({"items": items, "probes": probes}),
                              capture_output=True, text=True, cwd=ROOT, timeout=120, check=True)
        report = json.loads(done.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        detail = getattr(error, "stderr", None) or str(error)
        return {"ran": False, "why": detail.strip()[-400:], "records": [], "refusals": [], "probes": []}
    return {"ran": True, **report}


# --------------------------------------------------------------------------- model quotes and marks

def daily_legs(trade, data: pf.Dataset) -> dict[str, tuple[float, float, float, float]]:
    """date -> (spot, long mid, short mid, value per contract) for each bar the research book held `trade`.

    The same prices as book._price_event (stale IV and rate carry forward); the values must rebuild its marks.
    """
    market = pf.market_of(data, trade.symbol)
    right, kind = bk.STRUCTURES[trade.structure]
    expiry = parse(trade.expiry)
    q = om.DIVIDEND_YIELD.get(trade.symbol, 0.0)
    index_id, slope = IV_INDEX[trade.symbol], om.SKEW[trade.symbol]
    level, rate = market.iv_index[trade.entry_index], market.rate[trade.entry_index]
    marks = dict(trade.marks)
    rows = {}
    for bar in range(trade.entry_index, trade.exit_index + 1):
        level = market.iv_index[bar] if market.iv_index[bar] is not None else level
        rate = market.rate[bar] if market.rate[bar] is not None else rate
        days_left = (expiry - parse(market.dates[bar])).days
        pricing = bk._Pricing(market.close[bar], max(0, days_left) / bk.DAYS_PER_YEAR, rate, q, om.atm_iv(index_id, level), slope)
        long_mid, short_mid = bk.spread_legs(pricing, right, trade.long_strike, trade.short_strike)
        value = bk.instrument_value(kind, long_mid, short_mid, trade.width)
        day = market.dates[bar]
        if day in marks and abs(marks[day] - value) > 0.011:
            raise RuntimeError(f"Leg prices of {trade.symbol} {day} do not rebuild the research mark")
        rows[day] = (market.close[bar], long_mid, short_mid, value)
    return rows


def _money(value: float, rounding: str) -> Decimal:
    return Decimal(str(value)).quantize(TICK, rounding=rounding)


def leg_quote(symbol: str, mid: float) -> LegQuote:
    """Model top of book of one option: mid minus and plus the model half-spread, on the cent grid."""
    half = om.half_spread(symbol, mid)
    bid = max(Decimal("0"), _money(mid - half, ROUND_FLOOR))
    ask = max(_money(mid + half, ROUND_CEILING), bid + TICK)
    return LegQuote(bid=bid, ask=ask, bid_size=QUOTE_SIZE, ask_size=QUOTE_SIZE)


def spread_quote(symbol: str, long_mid: float, short_mid: float, moment: datetime) -> SpreadQuote:
    return SpreadQuote(observed_at_ns=epoch_ns(moment), long_leg=leg_quote(symbol, long_mid), short_leg=leg_quote(symbol, short_mid))


def exit_moment(day: str) -> datetime:
    """The exit time of a session in New York: its close minus 15 minutes."""
    session = date.fromisoformat(day)
    close = datetime.combine(session, NYSE.close_time(session), NEW_YORK)
    return close - timedelta(minutes=15)


def venue_model() -> PaperVenueModel:
    """Fees as the study model (commission per leg and contract); the spread is in the quote, so no extra slippage."""
    return PaperVenueModel(tick_size=TICK, fee_per_contract=Decimal(str(om.COMMISSION)), fee_rate=Decimal("0"),
                           minimum_fee=Decimal("0"), slippage_bps=Decimal("0"), slippage_ticks=0,
                           quote_ttl_ns=60 * 10**9, submit_latency_ns=0, depth_fraction=Decimal("1"),
                           participation_rate=Decimal("1"), max_fill_contracts=QUOTE_SIZE)


# --------------------------------------------------------------------------- policy

def load_policy(root: Path | None):
    """The engine order policy module: this checkout's (already loaded by deploy_rehearsal), or `root`/arm_gate.py."""
    if root is None:
        return dr.arm_gate, str(Path(dr.arm_gate.__file__).resolve().relative_to(ROOT))
    path = Path(root).expanduser().resolve() / "arm_gate.py"
    spec = importlib.util.spec_from_file_location("arm_gate_candidate", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    before, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = before
    return module, str(path)


class PolicyDesk:
    """`ArmGatePolicy` over a temporary account snapshot that follows the paper book (never the live node)."""

    def __init__(self, module, bench: dr.PolicyBench, spreads_decision: str | None) -> None:
        self.module, self.bench = module, bench
        self.now = time.time()
        env = {"NAUTILUS_ACCOUNT_SNAPSHOT_DIR": str(bench.dir),
               module.RESERVATIONS_ENV: str(bench.dir / "order-policy-reservations.json"),
               OPEN_RISK_ENV: str(bench.dir / "order-policy-open-risk.json")}
        if spreads_decision:
            env[SPREADS_FLAG_ENV] = "owner-decision:" + spreads_decision
        self.policy = ArmGatePolicy(module, env, clock=lambda: self.now)

    def set(self, moment: datetime, net_liquidation: float, positions: list[dict]) -> None:
        """Write the account the policy will read: NLV and the open legs of the paper book at `moment`."""
        for old in self.bench.dir.glob("ibkr-account-snapshot-*.json"):
            old.unlink()
        self.now = moment.timestamp()
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(self.now))
        (self.bench.dir / f"ibkr-account-snapshot-{stamp}.json").write_text(json.dumps({
            "schemaVersion": "ibkr-account-snapshot/v1", "captured_at_epoch": self.now - 1, "positions": positions,
            "summary": {"NetLiquidation": {"USD": f"{net_liquidation:.2f}"}}}))


def held_legs(path: PaperPath) -> list[dict]:
    """The open legs of the paper book in the shape of the account snapshot (made-up contract ids)."""
    rows = []
    for position in path.positions:
        price_of = {(fill.action, fill.strike): fill.price for fill in position.open_fill.legs}
        for leg in position.open_fill.order.legs:
            sign = 1 if leg.action == "BUY" else -1
            rows.append({"symbol": position.held.symbol, "sec_type": "OPT", "currency": "USD",
                         "quantity": sign * position.held.quantity,
                         # per contract, as the account snapshot reports it
                         "average_cost": float(price_of[(leg.action, leg.strike)] * leg.multiplier),
                         "contract": {"symbol": position.held.symbol, "secType": "OPT", "exchange": "", "currency": "USD",
                                      "lastTradeDateOrContractMonth": leg.expiry.strftime("%Y%m%d"),
                                      "strike": float(leg.strike), "right": "C" if leg.right == "call" else "P",
                                      "multiplier": "100", "tradingClass": position.held.symbol,
                                      "conId": synthetic_con_id(position.held.symbol, leg)}})
    return rows


# --------------------------------------------------------------------------- one window

def window_trades(data: pf.Dataset, facts, window: dict, capital: float, made: dict):
    """The sized research trades of one window (the same steps as deploy_rehearsal.rehearse_window)."""
    start, end = window["start"], window["end"]
    books = {key: dr.trace_signals(key, made[key][0], data, made[key][1], start, end)[0] for key in fp.POOL}
    caps = al.Caps(open_risk_pct=fp.OPEN_RISK_CAP_PCT, name_risk_pct=fp.NAME_RISK_CAP_PCT,
                   sleeve_of={key: fp.POOL[key][0] for key in fp.POOL},
                   sleeve_risk_pct={sleeve: budget for sleeve, budget in fp.POOL.values()})
    combined, _refusals = dr.trace_caps(books, dict.fromkeys(fp.POOL, fp.POSITION_RISK_PCT), caps)
    dates = [day for day in data.calendar if day >= start]
    result = run_ledger(combined.trades, capital, dates=dates)
    sized = {record["id"]: record for record in result.trades}
    return combined, sized, dict(zip(result.dates, result.equity)), sum(len(book) for book in books.values())


def _close_value(trade, value: float, long_mid: float, short_mid: float, quantity: int) -> Decimal:
    """$ the whole position returns when closed at the model value, after the modeled closing cost."""
    kind = bk.STRUCTURES[trade.structure][1]
    fee = min(bk._fee(trade.symbol, long_mid, short_mid), bk.worst_exit_cost(trade.symbol, trade.width))
    per_contract = value if kind == "debit" else value - trade.width * om.MULTIPLIER
    return Decimal(str(round((per_contract - fee) * quantity, 2)))


def replay_window(data: pf.Dataset, facts, window: dict, capital: float, made: dict, desk: PolicyDesk) -> dict:
    start, end = window["start"], window["end"]
    combined, sized, equity_on, offered = window_trades(data, facts, window, capital, made)
    trades = [trade for trade in combined.trades if trade.trade_id in sized]
    contracts = {(combined.owner[t.trade_id], t.entry_date, t.symbol): sized[t.trade_id]["contracts"] for t in trades}
    taken = {key: [t for t in trades if combined.owner[t.trade_id] == key] for key in fp.POOL}
    requests = request_records(request_items(taken, contracts, capital, made))
    record_of = {(record["strategyId"], record["symbol"]): record for record in requests["records"]}

    path = PaperPath(desk.policy, SimulatedPaperVenue(venue_model(), provenance_id=f"paper-path-rehearsal:{window['name']}"))
    legs = {trade.trade_id: daily_legs(trade, data) for trade in trades}
    rows = {trade.trade_id: {
        "id": trade.trade_id, "sleeve": combined.owner[trade.trade_id], "symbol": trade.symbol,
        "structure": trade.structure, "entryDate": trade.entry_date, "expiry": trade.expiry,
        "longStrike": trade.long_strike, "shortStrike": trade.short_strike,
        "research": {"contracts": sized[trade.trade_id]["contracts"], "exitDate": trade.exit_date,
                     "exitReason": sized[trade.trade_id]["exitReason"], "pnl": sized[trade.trade_id]["pnl"]},
        "reached": "sizing", "stoppedAt": None, "refusal": None} for trade in trades}
    held: dict[int, str] = {}
    refusals, exits, daily = Counter(), Counter(), []
    by_entry: dict[str, list] = {}
    for trade in trades:
        by_entry.setdefault(trade.entry_date, []).append(trade)
    by_id = {trade.trade_id: trade for trade in trades}

    def stop(row: dict, stage: str, code: str, detail: str | None) -> None:
        row.update({"stoppedAt": stage, "refusal": {"code": code, "detail": detail}})
        refusals[f"{stage}:{code}"] += 1

    for day in (item for item in data.calendar if item >= start):
        if day > end and not held:
            break  # after the window only the exits of its positions run; no entry is dated there
        moment = exit_moment(day)
        equity = equity_on.get(day, capital)
        # 1. exits first: a roll frees its risk before the next spread of the sleeve opens.
        for number, position_id in list(held.items()):
            trade, row = by_id[number], rows[number]
            if day not in legs[number] or day == trade.entry_date:
                continue
            spot, long_mid, short_mid, value = legs[number][day]
            position = path.position(position_id)
            mark = SpreadMark(as_of=moment, spot=Decimal(str(spot)),
                              close_value=_close_value(trade, value, long_mid, short_mid, position.held.quantity))
            desk.set(moment, equity, held_legs(path))
            result = path.evaluate_exit(position_id, moment, mark, spread_quote(trade.symbol, long_mid, short_mid, moment),
                                        roll_due=trade.exit_reason == "signal" and day == trade.exit_date)
            if result.outcome == "held":
                continue
            if result.outcome in ("closed", "expired"):
                reason = EXPIRED_WORTHLESS if result.outcome == "expired" else result.exit.reason
                row.update({"reached": "exit", "exit": {
                    "date": day, "time": moment.strftime("%H:%M ET"), "reason": reason,
                    "late": bool(getattr(result.exit, "late", False)),
                    "policy": None if result.policy is None else result.policy.code,
                    "pnl": None if result.realized_pnl is None else float(result.realized_pnl)}})
                exits[reason] += 1
                del held[number]
            else:  # a refused close or an alert: the position stays, the next session decides again
                row.setdefault("exitRefusals", []).append({"date": day, "stage": result.refusal_stage, "code": result.refusal_code})
                refusals[f"exit {result.refusal_stage}:{result.refusal_code}"] += 1
        # 2. entries of the day
        for trade in by_entry.get(day, []):
            row, key = rows[trade.trade_id], combined.owner[trade.trade_id]
            record = record_of.get(("library:qc-" + key.split("/")[0], trade.symbol))
            if record is None:
                stop(row, "request", "no_approved_request", requests.get("why"))
                continue
            row["reached"] = "request"
            _spot, long_mid, short_mid, _value = legs[trade.trade_id][day]
            entry = moment + ENTRY_AFTER_EXIT
            quote = spread_quote(trade.symbol, long_mid, short_mid, entry)
            kind = bk.STRUCTURES[trade.structure][1]
            net = quote.long_leg.ask - quote.short_leg.bid if kind == "debit" else quote.short_leg.bid - quote.long_leg.ask
            if net <= 0:
                stop(row, "strategy", "no_premium_at_quote", "the model quote leaves no net price")
                continue
            intent = SpreadIntent(
                intent_id=f"{window['name']}:{trade.trade_id}", request_id=record["id"], kind="open",
                strategy_id=record["strategyId"], symbol=trade.symbol, structure=trade.structure,
                expiry=date.fromisoformat(trade.expiry), long_strike=Decimal(str(trade.long_strike)),
                short_strike=Decimal(str(trade.short_strike)), net_limit=net, signal_date=date.fromisoformat(day))
            desk.set(entry, equity, held_legs(path))
            result = path.open(record, intent, Decimal(str(round(equity, 2))), quote, entry)
            row["reached"] = result.reached
            if result.order is not None:
                row["order"] = {"contracts": result.order.quantity, "netLimit": float(result.order.net_limit),
                                "maxLoss": float(result.order.max_loss_total),
                                "maxLossPct": float(result.order.max_loss_pct_of_account)}
            if result.policy is not None:
                row["policy"] = {"allowed": result.policy.allowed, "code": result.policy.code}
            if result.outcome != "opened":
                stop(row, result.refusal_stage, result.refusal_code, result.refusal_detail)
                continue
            row["fill"] = {"contracts": result.fill.quantity, "fees": float(result.fill.fees),
                           "time": entry.strftime("%H:%M ET")}
            held[trade.trade_id] = result.position.position_id
        at_risk = sum(float(position.open_fill.order.max_loss_total) for position in path.positions)
        daily.append({"t": day, "atRiskPct": 100.0 * at_risk / equity})
    for number in held:
        rows[number].update({"reached": "fill", "exit": {"reason": OPEN_AT_END, "date": data.calendar[-1]}})
        exits[OPEN_AT_END] += 1

    listed = list(rows.values())
    built = [row for row in listed if "order" in row]
    allowed = [row for row in built if row.get("policy", {}).get("allowed")]
    filled = [row for row in listed if "fill" in row]
    exited = [row for row in filled if row["exit"]["reason"] != OPEN_AT_END]
    return {
        "window": window, "requests": {key: requests.get(key) for key in ("ran", "why", "lock", "probes", "refusals", "notRehearsed")}
        | {"approved": len(requests["records"]), "withOptions": sum(1 for r in requests["records"] if r.get("options")),
           "groups": sorted({r["options"]["group"]["key"] for r in requests["records"]
                             if r.get("options") and r["options"].get("group")})},
        "counts": {"offered": offered, "sized": len(trades), "requestsApproved": len(requests["records"]),
                   "reachedEngine": len(built), "policyAllowed": len(allowed), "policyRefused": len(built) - len(allowed),
                   "filled": len(filled), "exitedByRule": len(exited), "openAtDataEnd": exits[OPEN_AT_END],
                   "endToEnd": len(exited)},
        "refusalsByCause": dict(sorted(refusals.items())), "exitsByBranch": dict(sorted(exits.items())),
        "sizing": {"sameAsResearch": sum(1 for row in filled if row["fill"]["contracts"] == row["research"]["contracts"]),
                   "different": sum(1 for row in filled if row["fill"]["contracts"] != row["research"]["contracts"])},
        "exitDates": {"sameAsResearch": sum(1 for row in exited if row["exit"]["date"] == row["research"]["exitDate"]),
                      "different": sum(1 for row in exited if row["exit"]["date"] != row["research"]["exitDate"])},
        "deployment": {"averageAtRiskPct": sum(item["atRiskPct"] for item in daily) / len(daily) if daily else 0.0,
                       "peakAtRiskPct": max((item["atRiskPct"] for item in daily), default=0.0),
                       "note": "max loss of the open paper positions over the research equity of the day"},
        "ordersToBroker": 0, "trades": listed,
    }


# --------------------------------------------------------------------------- run

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", required=True)
    parser.add_argument("--capital", type=float, default=360000.0)
    parser.add_argument("--out", required=True)
    parser.add_argument("--extra-window", action="append", default=[], metavar="name=start:end")
    parser.add_argument("--policy-root", default=None, help="folder with another arm_gate.py (default: this checkout)")
    parser.add_argument("--spreads-decision", default=None,
                        help="owner decision link; sets the policy's spreads switch ON in this process only")
    args = parser.parse_args(argv)

    loaded = study.load_study_data(args.data)
    data, facts = loaded.dataset, loaded.facts
    made = fp.sleeve_definitions(qi.family(facts), facts)
    first_all = max(start for _definition, start in made.values())
    year, month = int(first_all[:4]), int(first_all[5:7])
    first_month = f"{year + month // 12:04d}-{month % 12 + 1:02d}"
    spy = data.bars["SPY"]
    windows = [{"name": "strong", **dr.strong_window(spy.dates, spy.adj_close, first_month)},
               {"name": "contrast", **dr.contrast_window(data.calendar)}]
    for item in args.extra_window:
        name, span = item.split("=", 1)
        windows.append({"name": name, "rule": "added by hand as a check, not by the rule",
                        "start": span.split(":")[0], "end": span.split(":")[1]})

    module, source = load_policy(None if args.policy_root is None else Path(args.policy_root))
    bench = dr.PolicyBench()
    try:
        desk = PolicyDesk(module, bench, args.spreads_decision)
        replayed = [replay_window(data, facts, window, args.capital, made, desk) for window in windows]
    finally:
        bench.close()
    total = Counter()
    for item in replayed:
        total.update(item["counts"])
    document = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "capital": args.capital,
        "policy": {"name": getattr(module, "ORDER_POLICY", None), "source": source,
                   "takesLegs": desk.policy.passes_legs,
                   "spreadsSwitch": "on (this process only)" if args.spreads_decision else "off",
                   "spreadsDecision": args.spreads_decision},
        "venue": "SimulatedPaperVenue over PaperSimulator; model quotes; no broker",
        "exitRule": "owner_standing_rule_v1", "totals": dict(total), "windows": replayed,
        "safety": {"ordersToBroker": 0, "rowsWritten": 0, "armed": False, "network": False,
                   "policySnapshotDirRemoved": not bench.dir.exists()},
    }
    out = Path(args.out).expanduser()
    out.write_text(json.dumps(document, indent=1, default=str))
    print(f"{'window':<12} sized engine allowed filled exited open  refusals")
    for item in replayed:
        c = item["counts"]
        print(f"{item['window']['name']:<12} {c['sized']:>5} {c['reachedEngine']:>6} {c['policyAllowed']:>7} {c['filled']:>6} "
              f"{c['exitedByRule']:>6} {c['openAtDataEnd']:>4}  {item['refusalsByCause']}")
    print(f"policy {document['policy']['name']} spreads switch {document['policy']['spreadsSwitch']} -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
