"""Dark HTML report of the options-side continuation study (research only; one self-contained page, no script, no
external request). Style and table helpers are the Triple RSI report's (strategies/triple_rsi/report.py)."""
from __future__ import annotations

from collections.abc import Mapping

from strategies.triple_rsi.report import STYLE, _e, _mark, _table

from . import rules as rule_module
from . import study
from .control import RULES
from .document import nautilus_text
from .study import stats_of, usd

__all__ = ["render"]

HEADING = "Options-side continuation rule (modelled fills)"
PART_LABELS = (("train", "Train"), ("validation", "Validation"), ("test", "Test"),
               ("outOfSample", "Out-of-sample (validation + test)"), ("windowChoice", "Window-choice sessions"),
               ("whole", "Whole period"))
STAT_HEAD = ("Part", "Sessions", "Trades", "Net", "Win rate", "Profit factor", "Sharpe (ann.)", "Max drawdown",
             "Max drawdown $")


def _pct(value) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _num(value, digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def _stat_cells(label: str, s: Mapping) -> list[str]:
    return [_e(label), str(s["sessions"]), str(s["trades"]), _e(usd(s["netUsd"])), _pct(s["winRate"]),
            _num(s["profitFactor"]), _num(s["sharpe"]), _pct(s["maxDrawdown"]), _e(usd(s["maxDrawdownUsd"]))]


def _parts_table(results: Mapping, row: str, tick: int = study.BASE_TICKS) -> str:
    return _table(STAT_HEAD, [_stat_cells(label, stats_of(results, row, part, tick)) for part, label in PART_LABELS])


def _row_table(results: Mapping, names, part: str, tick: int = study.BASE_TICKS) -> str:
    head = ("Row", *STAT_HEAD[1:])
    return _table(head, [[_e(name), *_stat_cells(name, stats_of(results, name, part, tick))[1:]] for name in names])


def render(results: Mapping) -> str:
    data, split, diag = results["data"], results["split"], results["diagnostics"]
    oos = stats_of(results, study.PRIMARY, "outOfSample")
    dsr = results["deflatedSharpe"]
    p = dsr.get("probability")
    out = ["<!doctype html><html lang='en'><head><meta charset='utf-8'>",
           "<meta name='viewport' content='width=device-width, initial-scale=1'>",
           f"<title>{_e(HEADING)}</title><style>{STYLE}</style></head><body><main>",
           f"<h1>{_e(HEADING)}</h1>",
           "<p class='dim'>Research only. No order, no deployment. The study tests the options side of the flow "
           "control signals with modelled fills; the futures and options agreement is not tested.</p>"]

    verdict_class = "pass" if results["verdict"] == "edge" else "fail"
    label = {"edge": "validated (edge)", "no-edge": "tested-failed (no edge)",
             "needs-more-data": "needs more data"}.get(results["verdict"], results["verdict"])
    out += ["<h2>Verdict</h2>", f"<p><span class='{verdict_class}'>{_e(label)}</span></p>",
            f"<p>{_e(results['verdictReason'])}</p>",
            "<p>Sample size: " + _e(f"{data['days']} usable sessions ({data['first']} to {data['last']}); "
                                     f"{oos['trades']} out-of-sample trades of C0-F in {oos['sessions']} sessions; "
                                     f"{stats_of(results, study.PRIMARY, 'whole')['trades']} C0-F trades in total.")
            + "</p>"]

    reasons: dict[str, int] = {}
    for item in data["skipped"]:
        reasons[item["reason"]] = reasons.get(item["reason"], 0) + 1
    skipped_days = len({item["day"] for item in data["skipped"]})
    out += ["<h2>Data</h2>", _table(("Item", "Value"), [
        ["Usable sessions", str(data["days"])], ["First and last", _e(f"{data['first']} to {data['last']}")],
        ["Skipped days", _e(f"{skipped_days} ({', '.join(f'{k}: {v}' for k, v in sorted(reasons.items())) or 'none'})")],
        ["Early-close days left out", str(data["earlyCloseDays"])],
        ["Days with a derived total (zero_dte + longer)", str(data["derivedTotalDays"])],
        ["Net drift files", str(data["files"])], ["Market files", str(len(data["marketFiles"]))],
        ["Data hash", _e("sha256:" + data["dataHash"])]], text=True)]

    out += ["<h2>Rules</h2>", _table(("Constant", "Value"), [
        ["Rules version", _e(RULES.version)], ["Window", f"{RULES.window_minutes} min"],
        ["Enter ratio", _num(RULES.enter_ratio)], ["Exit ratio", _num(RULES.exit_ratio)],
        ["Minutes in a row", str(RULES.min_minutes)], ["Minimum buckets", str(RULES.min_buckets)],
        ["Entry window (minutes after 09:30)", f"{rule_module.ENTRY_FIRST} to {rule_module.ENTRY_LAST}"],
        ["Late entry (V3)", str(rule_module.ENTRY_LAST_LATE)], ["Time exit", str(rule_module.TIME_EXIT)],
        ["Trend lookback", f"{rule_module.TREND_LOOKBACK} min"], ["Hard stop", f"{rule_module.HARD_STOP_PCT:.2f}%"],
        ["Spec SHA-256", _e(rule_module.SPEC_SHA256)]], text=True)]

    out += ["<h2>Walk-forward split</h2>",
            "<p>60% train, 20% validation, 20% test by time with gaps of 5 sessions; no parameter is fitted. The "
            "window-choice sessions (2026-10-28 to 2026-11-13) are reported alone and are not in the verdict.</p>",
            _table(("Part", "First", "Last", "Sessions"),
                   [[_e(lbl), _e(split[k]["first"]), _e(split[k]["last"]), str(split[k]["sessions"])]
                    for k, lbl in PART_LABELS])]

    out += ["<h2>Costs and slippage</h2>",
            "<p>Futures (modelled from index prices): $50 (ES) and $20 (NQ) per point, $4.50 fees per round turn, "
            "slippage 0, 1 or 2 ticks per side ($12.50 / $5.00 per tick); 1 tick is the base. Options: $0.65 per "
            "contract and half the modelled spread per leg, exit cost capped at the worst case; maximum loss 2% of a "
            "$100,000 account per symbol. Cost stress: twice the spread part.</p>"]
    for tick in study.SLIPPAGE_TICKS:
        out += [f"<h3>C0-F (ES + NQ, $200,000), {tick} tick(s) per side</h3>", _parts_table(results, "C0-F", tick)]

    out += ["<h2>Instruments (C0, 1 tick per side; options at the modelled cost)</h2>",
            "<h3>Whole period</h3>", _row_table(results, ("C0-F-ES", "C0-F-NQ", "C0-O-SPY", "C0-O-QQQ"), "whole"),
            "<h3>Out-of-sample</h3>",
            _row_table(results, ("C0-F-ES", "C0-F-NQ", "C0-O-SPY", "C0-O-QQQ"), "outOfSample")]

    skipped = diag["optionsSkipped"]
    out += ["<h2>Option form (debit verticals, modelled)</h2>", _parts_table(results, "C0-O"),
            f"<p>Priced spreads: {results['rows']['C0-O'].get('priced', 0)}; skipped: {skipped['count']} "
            + _e(str(skipped["byReason"])) + "</p>",
            "<h3>Twice the spread cost</h3>", _parts_table(results, "C0-O-stress")]

    names = [f"{cfg}-{form}" for form in study.FORMS for cfg in study.CONFIGS]
    out += ["<h2>Variants (N = 10 trials)</h2>", "<h3>Whole period</h3>", _row_table(results, names, "whole"),
            "<h3>Out-of-sample</h3>", _row_table(results, names, "outOfSample")]

    dsr_text = (f"{p:.3f} (per-session Sharpe {dsr['sharpe']:.4f}, expected maximum {dsr['expectedMax']:.4f}, "
                f"{dsr['observations']} sessions, N = {dsr['trials']})" if p is not None
                else f"not computable: {dsr.get('error')}")
    out += ["<h2>Deflated Sharpe</h2>", f"<p>{_mark(p is not None and p >= study.DSR_PASS)} {_e(dsr_text)}; bar 0.95.</p>"]

    naut = diag["nautilus"]
    gap = naut.get("optionsMaxGap")
    out += ["<h2>NautilusTrader fill check</h2>", f"<p>{_mark(naut.get('same') if naut.get('status') == 'ran' else None)} "
            + _e(nautilus_text(results)) + (f" Option ledger vs engine: largest equity gap {gap:.4f}." if gap is not None
                                             else "") + "</p>"]
    if naut.get("mismatches"):
        out.append(_table(("Instrument", "Side", "Rule", "Engine"),
                          [[_e(m["instrument"]), str(m["side"]), _e(m["rule"]), _e(m["engine"])]
                           for m in naut["mismatches"]], text=True))

    out += ["<h2>FOMC days</h2>", f"<p>{len(diag['fomc']['days'])} usable sessions are scheduled decision days "
            f"(skipped in C0). Source: {_e(diag['fomc']['source'])}, read {_e(diag['fomc']['readOn'])}.</p>"]

    live = diag["liveRows"]
    out.append("<h2>Stored rows against the downloaded values</h2>")
    if live.get("status") == "ran":
        out.append(_table(("Ticker", "Part", "Stored", "Downloaded", "Common", "Equal", "Largest difference"),
                          [[_e(x["ticker"]), _e(x["part"]), str(x["stored"]), str(x["downloaded"]), str(x["common"]),
                            str(x["equal"]), _e(usd(x["maxAbsDiffUsd"]))] for x in live["pairs"]]))
    else:
        out.append("<p>not provided</p>")

    out.append("<h2>Futures and options agreement: not tested</h2>")
    if diag["twoSided"]:
        out.append(_table(("Day", "Trades", "Buy", "Sell", "Net", "Control min", "Trade min", "Same sign min"),
                          [[_e(x["day"]), str(x["trades"]), _num(x["buyVolume"], 0), _num(x["sellVolume"], 0),
                            _num(x["netVolume"], 0), str(x["controlMinutes"]), str(x["tradeMinutes"]),
                            str(x["sameSignMinutes"])] for x in diag["twoSided"]]))
    else:
        out.append("<p>not provided</p>")

    out += ["<h2>Limits</h2><ul>",
            "<li>Futures results are modelled from SPX and NDX index prices per minute; no futures bar or real fill.</li>",
            "<li>Option prices are Black-Scholes on the previous close of VIX or VXN; no option quotes.</li>",
            "<li>Net drift is vendor data (personal use); a derived total sums the zero_dte and longer parts.</li>",
            "<li>One rule, frozen before the run; the verdict gives no trading authority.</li></ul>",
            "</main></body></html>"]
    return "\n".join(out)
