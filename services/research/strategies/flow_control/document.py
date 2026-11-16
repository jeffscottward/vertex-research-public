"""Study document (research_studies, kind "strategy-backtest") of the options-side continuation study.

The importer validates it with StrategyBacktestStudySchema (packages/api/src/contracts/research-studies.ts); the
schema is strict, so this module writes exactly its keys. Research only.
"""
from __future__ import annotations

from collections.abc import Mapping

from . import rules as rule_module
from . import study
from .control import RULES
from .options import ACCOUNT, MAX_LOSS_PCT
from .study import BASE_TICKS, CAPITAL, FEES_USD, POINT_USD, TICK_USD, stats_of, usd

STUDY_ID = "flow-control-continuation"
SPEC_PATH = "docs/specs/strategies/flow-control-continuation.md"
RULES_VERSION_ITEM = "Rules version"
FILTER_PROFILE_ITEM = "Filter profile"
SOURCE_URL = "https://quantdata.us/api/docs/endpoints/net-drift"
SOURCE_LABEL = "QuantData net drift (vendor documentation); rule by Vertex"
TITLE = ("Options-side continuation rule (modelled fills): net drift state with trend on ES, NQ, SPY and QQQ")
EQUITY_LABEL = ("C0 on 1 ES and 1 NQ contract (modelled from index prices), 1 tick per side and fees, on $200,000")


def _clock(minute: int) -> str:
    total = rule_module.OPEN_MINUTE_OF_DAY + minute
    return f"{total // 60:02d}:{total % 60:02d}"


_ES_FEE = f"${FEES_USD:.2f}"
RULE_ITEMS: tuple[tuple[str, str, str], ...] = (
    (RULES_VERSION_ITEM, RULES.version, "Spec: Rules"),
    (FILTER_PROFILE_ITEM, "otm-clean.v1", "Spec: Data"),
    ("Trend", ("Long only when the price of the group's primary ticker (SPX or QQQ) is above its 09:30 price and "
               f"above its price {rule_module.TREND_LOOKBACK} minutes earlier; short only when it is below both. "
               "Before 10:00 the earlier price is the 09:30 price."), "Spec: Rules"),
    ("Options state", (f"Net drift ratio of the total of all expiries over the last {RULES.window_minutes} minutes: "
                       f"buyers after {RULES.min_minutes} minutes in a row at or above {RULES.enter_ratio:.2f}, lost "
                       f"below {RULES.exit_ratio:.2f}; sellers is the mirror. The check ticker on the opposite side "
                       "gives mixed."), "Spec: Rules"),
    ("Entry", (f"Between {_clock(rule_module.ENTRY_FIRST)} and {_clock(rule_module.ENTRY_LAST)} New York, at the end "
               "of a minute with the group state buyers (long) or sellers (short) and the trend on the same side. "
               "Fill at the price of the next minute. At most one trade per instrument and session."), "Spec: Rules"),
    ("Exit", ("When the group state is no longer the entry state (fill at the price of the next minute), or at "
              f"{_clock(rule_module.TIME_EXIT)} New York at the price of that minute."), "Spec: Rules"),
    ("Hard stop", (f"Exit when the price at the end of a minute is {rule_module.HARD_STOP_PCT:.2f}% of the entry price "
                   "or more against the position; fill at the price of the next minute."), "Spec: Rules"),
    ("FOMC days", "The 16 scheduled FOMC decision days of 2025 and 2026 are skipped in the main run.", "Spec: Rules"),
    ("Futures model", (f"1 ES and 1 NQ contract from the SPX and NDX index price per minute: ${POINT_USD['ES']:.0f} "
                       f"and ${POINT_USD['NQ']:.0f} per point, {_ES_FEE} fees per round turn, slippage of 0, 1 or 2 "
                       f"ticks per side (${TICK_USD['ES']:.2f} and ${TICK_USD['NQ']:.2f} per tick)."),
     "Spec: Futures model"),
    ("Option position", ("Debit vertical on SPY and QQQ, nearest Friday weekly expiry with at least one trading day "
                         "left, long leg near 0.50 delta, Black-Scholes prices from the previous close of VIX or VXN, "
                         f"maximum loss {MAX_LOSS_PCT:.0f}% of a ${ACCOUNT:,.0f} account per symbol."),
     "Spec: Option position"),
    ("Split", ("60% train, 20% validation and 20% test by time with gaps of 5 sessions. The 13 sessions from "
               "2026-10-28 to 2026-11-13 are taken out of their part and reported alone."), "Spec: Split"),
    ("Verdict bar", ("At least 100 trades in the out-of-sample part (validation and test), net above 0 at 1 tick per "
                     "side and a deflated Sharpe ratio of at least 0.95 with N = 10 trials."), "Spec: Pass/fail rule"),
)

GAPS: tuple[tuple[str, str], ...] = (
    ("Size of the hard stop", "0.40% of the entry price, tested on minute prices."),
    ("Trend level in the first 30 minutes", "The 09:30 price is used as the earlier price."),
    ("Number of trades per session", "At most one per instrument and session: the first entry."),
    ("Futures prices and fees", ("No futures bar is read. ES and NQ results are modelled from the SPX and NDX index "
                                 "price per minute. The ES fee equals the NQ fee of $4.50 by decision.")),
    ("Futures and options agreement", ("Not tested: large-trade history exists for days only. This study tests the "
                                       "options side alone.")),
    ("Sessions used to choose the 30-minute window", ("The 13 sessions from 2026-10-28 to 2026-11-13 are not in the "
                                                      "out-of-sample part.")),
)

VARIANT_LABELS = {"V1": "V1 window 15 min", "V2": "V2 window 60 min", "V3": "V3 entry until 15:30",
                  "V4": "V4 FOMC days included"}


def cut(text: str, limit: int) -> str:
    return text[:limit].strip()


def nautilus_text(results: Mapping) -> str:
    item = results["diagnostics"]["nautilus"]
    if item.get("status") != "ran":
        state, counts = "not run", ""
    else:
        state = "same" if item.get("same") else "NOT the same"
        counts = f" ({item.get('booked')} of {item.get('trades')} trades)"
    return f"NautilusTrader entry/exit bars and fill prices vs the rule module: {state}{counts}."


def _run(results: Mapping, row: str, symbol: str, market: str, tick: int = BASE_TICKS) -> dict:
    whole = stats_of(results, row, "whole", tick)
    oos = stats_of(results, row, "outOfSample", tick)
    return {"buyHoldCagr": None, "buyHoldSharpe": None, "cagr": max(-1.0, whole["cagr"]),
            "exposure": max(0.0, min(1.0, whole["timeInMarket"])), "from": results["data"]["first"],
            "market": cut(market, 60), "maxDrawdown": max(-1.0, min(0.0, whole["maxDrawdown"])),
            "oosCagr": max(-1.0, oos["cagr"]), "oosSharpe": oos["sharpe"],
            "profitFactor": whole["profitFactor"], "sharpe": whole["sharpe"], "symbol": cut(symbol, 40),
            "to": results["data"]["last"], "trades": int(whole["trades"]),
            "winRate": max(0.0, min(1.0, whole["winRate"]))}


def _forms(results: Mapping) -> list[dict]:
    fee = f"fees ${FEES_USD:.2f}"
    runs = [_run(results, "C0-F", "ES + NQ (modelled from SPX and NDX)", f"C0, {t} ticks/side, {fee}", t)
            for t in study.SLIPPAGE_TICKS]
    runs += [_run(results, "C0-F-ES", "ES (modelled from SPX)", f"C0, 1 ticks/side, {fee}"),
             _run(results, "C0-F-NQ", "NQ (modelled from NDX)", f"C0, 1 ticks/side, {fee}")]
    forms = [{"description": cut("Futures results are modelled: SPX and NDX index points per minute times $50 and $20 "
                                 "per point, $4.50 fees per round turn and slippage per side. No futures bar and no "
                                 "real fill is used. Returns are fractions of $100,000 per contract. "
                                 + nautilus_text(results), 600),
              "key": "underlying", "label": "1 ES and 1 NQ contract (modelled from index prices)", "runs": runs}]
    if results["rows"]["C0-O"].get("priced", 0) > 0:
        market = "C0, modelled option prices and costs"
        forms.append({
            "description": cut("One debit vertical per trade of the rule on SPY or QQQ, priced with Black-Scholes on "
                               "the previous close of VIX or VXN (no option quotes), $0.65 per contract and half the "
                               "modelled spread per leg. Maximum loss 2% of a $100,000 account per symbol; returns are "
                               "fractions of $200,000.", 600),
            "key": "options", "label": "Debit verticals on SPY and QQQ (modelled option prices)",
            "runs": [_run(results, "C0-O", "SPY + QQQ debit verticals (modelled)", market),
                     _run(results, "C0-O-SPY", "SPY debit verticals (modelled)", market),
                     _run(results, "C0-O-QQQ", "QQQ debit verticals (modelled)", market)]})
    return forms


def _robustness(results: Mapping) -> list[dict]:
    oos = stats_of(results, "C0-F", "outOfSample")
    split = results["split"]["outOfSample"]
    dsr = results["deflatedSharpe"]
    p = dsr.get("probability")
    dsr_text = (f"{p:.3f}; per-session Sharpe {dsr['sharpe']:.3f}, expected maximum {dsr['expectedMax']:.3f}"
                if p is not None else f"not computable: {dsr.get('error')}")
    stress2 = stats_of(results, "C0-F", "outOfSample", 2)
    by_part = ", ".join(f"{name} {usd(stats_of(results, 'C0-F', part)['netUsd'])}"
                        for name, part in (("train", "train"), ("validation", "validation"), ("test", "test")))
    choice = stats_of(results, "C0-F", "windowChoice")
    v4 = stats_of(results, "V4-F", "outOfSample")
    stress = stats_of(results, "C0-O-stress", "outOfSample")
    base = stats_of(results, "C0-O", "outOfSample")
    live = results["diagnostics"]["liveRows"]
    if live.get("status") == "ran":
        live_pass = all(pair["equal"] == pair["common"] for pair in live["pairs"])
        live_text = "; ".join(f"{live['day']} {pair['ticker']} {pair['part']}: {pair['equal']} of {pair['common']} rows "
                              f"equal, largest difference {usd(pair['maxAbsDiffUsd'])}" for pair in live["pairs"])
    else:
        live_pass, live_text = None, "not provided"
    naut = results["diagnostics"]["nautilus"]
    rows = [
        ("Out-of-sample trades at least 100", oos["trades"] >= study.MIN_OOS_TRADES,
         f"{oos['trades']} trades in {split['sessions']} sessions ({split['first']} to {split['last']})"),
        ("Deflated Sharpe at least 0.95 (N = 10)", bool(p is not None and p >= study.DSR_PASS), dsr_text),
        ("Out-of-sample net above 0 at 1 tick per side", oos["netUsd"] > 0, f"net {usd(oos['netUsd'])}"),
        ("Out-of-sample net at 2 ticks per side", None, f"net {usd(stress2['netUsd'])}"),
        ("Net by part at 1 tick per side", None, by_part),
        ("Window-choice sessions 2026-10-28 to 2026-11-13 (not in the verdict)", None,
         f"{choice['sessions']} sessions, {choice['trades']} trades, net {usd(choice['netUsd'])}"),
        ("NautilusTrader fill check (C0, four instruments)", bool(naut.get("same")), nautilus_text(results)),
        ("FOMC days included (V4, out-of-sample)", None, f"net {usd(v4['netUsd'])} on {v4['trades']} trades"),
        ("Option form at twice the spread cost (out-of-sample)", None,
         f"net {usd(stress['netUsd'])} on {stress['trades']} trades; at the modelled cost {usd(base['netUsd'])}"),
        ("Stored net drift rows against the download", live_pass, live_text),
        ("Futures and options agreement", None,
         f"Not tested: large-trade history exists for {len(results['diagnostics']['twoSided'])} stored ES sessions "
         "only."),
    ]
    return [{"check": cut(check, 80), "pass": passed, "result": cut(text, 300)} for check, passed, text in rows]


def _sensitivity(results: Mapping) -> list[dict]:
    out = []
    for cfg, label in VARIANT_LABELS.items():
        for form, suffix in (("F", ", futures"), ("O", ", debit verticals")):
            whole = stats_of(results, f"{cfg}-{form}")
            out.append({"param": cut(label + suffix, 60), "value": cut(f"net {usd(whole['netUsd'])}", 40),
                        "sharpe": whole["sharpe"], "cagr": max(-1.0, whole["cagr"]),
                        "maxDrawdown": max(-1.0, min(0.0, whole["maxDrawdown"])), "trades": int(whole["trades"])})
    whole = stats_of(results, "C0-O-stress")
    out.append({"param": "C0 debit verticals, twice the spread cost", "value": cut(f"net {usd(whole['netUsd'])}", 40),
                "sharpe": whole["sharpe"], "cagr": max(-1.0, whole["cagr"]),
                "maxDrawdown": max(-1.0, min(0.0, whole["maxDrawdown"])), "trades": int(whole["trades"])})
    return out


def _comparison(results: Mapping) -> list[dict]:
    out = []
    for row, name in (("C0-F", "Options-side rule C0, ES + NQ modelled, 1 tick/side"),
                      ("C0-O", "Options-side rule C0, SPY + QQQ debit verticals (modelled)")):
        whole = stats_of(results, row)
        out.append({"name": cut(name, 80), "kind": "strategy", "sharpe": whole["sharpe"],
                    "cagr": max(-1.0, whole["cagr"]), "maxDrawdown": max(-1.0, min(0.0, whole["maxDrawdown"]))})
    return out


def _notes(results: Mapping) -> str:
    oos, data = results["split"]["outOfSample"], results["data"]
    return cut("Options-side rule only: the futures and options agreement is not tested. Futures results are modelled "
               "from index prices; option prices are modelled. "
               f"Out-of-sample part: {oos['first']} to {oos['last']}, {oos['sessions']} sessions. Data: QuantData net "
               f"drift, filter profile otm-clean.v1, {data['days']} sessions from {data['first']} to {data['last']}, "
               f"{data['derivedTotalDays']} with a derived total. Vendor data is for personal use and is not "
               "redistributed. Research only: no order, no deployment.", 4000)


def study_document(results: Mapping) -> dict:
    provenance = results["provenance"]
    if provenance.get("dirtyFiles"):
        raise ValueError("The study ran with uncommitted code; its document names a commit without that code")
    naut = results["diagnostics"]["nautilus"]
    if naut.get("status") != "ran" or not str(naut.get("engine", "")).startswith("nautilus-trader-"):
        raise ValueError("The NautilusTrader fill check did not run; the document needs one engine")
    if not naut.get("same"):
        raise ValueError("The NautilusTrader fill check found different fills; the study has no document")
    if len(results["curve"]) < 2:
        raise ValueError("The equity curve has fewer than 2 months; the study has no document")
    return {
        "comparison": _comparison(results),
        "equity": [{"drawdown": max(-1.0, min(0.0, p["drawdown"])), "month": p["month"], "value": max(-1.0, p["value"])}
                   for p in results["curve"]][-400:],
        "equityLabel": EQUITY_LABEL,
        "forms": _forms(results),
        "gaps": [{"choice": cut(choice, 400), "gap": cut(gap, 300)} for gap, choice in GAPS],
        "id": STUDY_ID,
        "kind": "strategy-backtest",
        "notes": _notes(results),
        "provenance": {"commit": provenance["commit"][:40], "dataHash": f"sha256:{results['data']['dataHash']}",
                       "engine": "nautilus_trader " + str(naut["engine"]).removeprefix("nautilus-trader-"),
                       "runId": cut(f"{STUDY_ID}-{provenance['ran']}-{provenance['commit'][:8]}", 80)},
        "ran": provenance["ran"],
        "robustness": _robustness(results),
        "rules": [{"item": cut(item, 60), "rule": cut(rule, 400), "source": cut(source, 200)}
                  for item, rule, source in RULE_ITEMS],
        "sensitivity": _sensitivity(results),
        "source": {"label": SOURCE_LABEL, "url": SOURCE_URL},
        "spec": SPEC_PATH,
        "title": cut(TITLE, 200),
        "verdict": results["verdict"],
        "verdictReason": cut(results["verdictReason"], 1000),
    }


__all__ = ["CAPITAL", "GAPS", "RULE_ITEMS", "STUDY_ID", "nautilus_text", "study_document", "usd"]
