"""Dark HTML report of the Trend Trio study (research only; one self-contained file, inline SVG charts, no
external assets). Style and table helpers are the Triple RSI report's (strategies/triple_rsi/report.py)."""
from __future__ import annotations

from collections.abc import Mapping, Sequence

from strategies.triple_rsi.report import STYLE, _e, _mark, _table

from . import document, study
from .document import usd

__all__ = ["render"]

# Options-form arithmetic (decision record Q8): NDX / QQQ of the Yahoo daily closes was 39.6 to 41.6 over 2004-2026;
# an at-the-money option has a delta of about 0.5.
OPTIONS_NDX_PER_QQQ = 41.0
OPTIONS_DELTA = 0.5
OPTIONS_MIN_COST = 1.00  # $0.01 per share x 100 shares: entering and leaving a one-cent-wide market
EXTRA_STYLE = ".plot rect{shape-rendering:crispEdges}.verdict{font-size:18px;font-weight:600}"
BAR_COLORS = ("#9aa3b2", "#60a5fa", "#f472b6")
INDICATORS = (
    ("SuperTrend", "TradingView built-in ta.supertrend (Pine v6 reference)",
     "https://www.tradingview.com/pine-script-reference/v6/#fun_ta.supertrend"),
    ("Ultimate MA", "ChrisMoody, CM_Ultimate_MA_MTF_V2 (eight average types)",
     "https://www.tradingview.com/script/8KVcQiJM-CM-Ultimate-MA-MTF-V2/"),
    ("AlphaTrend", "KivancOzbilgic, AlphaTrend (MPL-2.0; MFI or RSI momentum)",
     "https://www.tradingview.com/script/o50NYLAZ-AlphaTrend/"),
    ("Chandelier Exit", "Chuck LeBeau; everget's TradingView script (GPL-3.0; formula only)",
     "https://www.tradingview.com/script/AqXxNS7j-Chandelier-Exit-everget/"),
    ("Slingshot", "ChrisMoody, CM Sling Shot System (EMA 38 / 62)",
     "https://www.tradingview.com/script/GE7tSQK1-CM-Sling-Shot-System/"),
)
LIMITS = (
    ("Rules guessed; this tests a reconstruction. The paid rules may differ: a fail does not disprove the video and "
     "a pass does not confirm it."),
    ("No NQ 1-minute history: dataset (a) is the Dukascopy NAS100 CFD (mid prices, tick volume), dataset (b) QQQ "
     "5-minute bars scaled to NDX points; real NQ 5-minute bars (2024-2025) are a tracking check only."),
    "The CFD spread is reported, never charged; costs are NQ ticks and fees.",
    "Regular-session indicators put the overnight gap into the 09:30 bars (row V8 uses full-session bars).",
    "Fractions in the study document use a $100,000 capital basis per contract without compounding.",
    "Research only: nothing here places, arms or sizes an order.",
)


def _usd_short(value: float) -> str:
    sign = "-" if value < 0 else ""
    value = abs(value)
    return f"{sign}${value / 1000:.0f}k" if value >= 10_000 else f"{sign}${value:,.0f}"


def _year_bars(title: str, series: Sequence[tuple[str, Mapping[str, float]]], height: int = 220) -> str:
    """Grouped bars of net dollars per year (one bar per series and year), around a zero line. The SVG holds only
    the grid and the bars; title, legend and axis labels are HTML (fixed text size)."""
    years = sorted({year for _, per in series for year in per})
    if not years:
        return ""
    values = [value for _, per in series for value in per.values()]
    high, low = max(0.0, *values), min(0.0, *values)
    if high == low:
        high = low + 1

    def y(value: float) -> float:
        return 100 * (high - value) / (high - low)

    marks, levels = [], []
    for step in range(5):
        value = low + (high - low) * step / 4
        marks.append(f"<line x1='0' x2='100' y1='{y(value):.2f}' y2='{y(value):.2f}' stroke='#232834'/>")
        levels.append(f"<span class='y' style='top:{y(value):.2f}%'>{_e(_usd_short(value))}</span>")
    marks.append(f"<line x1='0' x2='100' y1='{y(0):.2f}' y2='{y(0):.2f}' stroke='#9aa3b2'/>")
    slot = 100 / len(years)
    width = slot * 0.8 / len(series)
    legend = []
    for number, (name, per) in enumerate(series):
        color = BAR_COLORS[number % len(BAR_COLORS)]
        legend.append(f"<span class='key' style='color:{color}'>{_e(name)}</span>")
        for index, year in enumerate(years):
            if year not in per:
                continue
            top, bottom = sorted((y(per[year]), y(0)))
            marks.append(f"<rect x='{index * slot + slot * 0.1 + number * width:.3f}' y='{top:.3f}' "
                         f"width='{width:.3f}' height='{max(bottom - top, 0.3):.3f}' fill='{color}'/>")
    labels = [f"<span style='left:{(index + 0.5) * slot:.2f}%'>{_e(year)}</span>" for index, year in enumerate(years)]
    return (f"<figure class='chart'><figcaption><span>{_e(title)}</span>{''.join(legend)}</figcaption>"
            f"<div class='plot' style='height:{height}px' aria-hidden='true'><svg viewBox='0 0 100 100' "
            f"preserveAspectRatio='none'>{''.join(marks)}</svg>{''.join(levels)}"
            f"<div class='xs'>{''.join(labels)}</div></div></figure>")


def _row(results: Mapping, row: str) -> Mapping:
    return next(item for item in results["rows"] if item["row"] == row)


def _per_year(row: Mapping, tick: int) -> dict[str, float]:
    return dict(row["stats"][str(tick)]["perYear"]) if row["status"] == "ran" else {}


def _header(results: Mapping) -> str:
    claim = results["claim"]
    passed = results["outcome"] == document.PASSED
    counts = []
    for row, label in (("P1", "(a) NAS100 CFD 1-minute, P1"), ("P3", "(b) QQQ 5-minute in NDX points, P3")):
        if row in claim:
            zero, one = claim[row]["0"], claim[row][str(study.BASE_TICKS)]
            counts.append(f"<li>{_e(label)}: <b>{zero[0]}/{zero[1]}</b> full years profitable at 0 tick, "
                          f"<b>{one[0]}/{one[1]}</b> at 1 tick per side</li>")
        else:
            counts.append(f"<li>{_e(label)}: not run</li>")
    if "P3window" in claim:
        window = claim["P3window"][str(study.BASE_TICKS)]
        counts.append(f"<li>(b) in the claim's window 2010-2025: <b>{window[0]}/{window[1]}</b> at 1 tick</li>")
    la, p1 = results["diagnostics"]["rows"].get("LA", {}), _row(results, "P1")
    if la.get("status") == "ran" and p1["status"] == "ran":
        k, n = _years_up(_per_year(la, 0), p1["fullYears"])
        counts.append(f"<li>Look-ahead diagnostic (invalid timing, outside the tests): <b>{k}/{n}</b> at 0 tick</li>")
    deciding = f" (first failing test {_e(results['decidingTest'])})" if results["decidingTest"] else ""
    pilot = "<p class='note'>Pilot run (2024 only): timing check, not the graded study.</p>" if results["pilot"] else ""
    return (f"<h1>Trend Trio: a test of the \"16 of 16 years\" claim</h1>"
            f"<p class='note'>Rules guessed; this tests a reconstruction, not the paid rules.</p>{pilot}"
            f"<div class='box'><p class='verdict {'pass' if passed else 'fail'}'>{_e(results['outcome'])}{deciding}</p>"
            f"<p>Claim: one NQ contract made money in each of the last <b>16 of 16</b> years (fees included, no "
            f"slippage). Reconstruction:</p><ul>{''.join(counts)}</ul></div>")


def _charts(results: Mapping) -> str:
    out = ["<h2>Net P&amp;L per year</h2>"]
    for row, label in (("P1", "P1, dataset (a)"), ("P3", "P3, dataset (b)")):
        item = _row(results, row)
        series = [(f"{tick} tick/side", _per_year(item, tick)) for tick in (0, study.BASE_TICKS)]
        out.append(_year_bars(f"{label}: net dollars per calendar year, 1 NQ contract", series)
                   or f"<p class='dim'>{_e(label)}: not run.</p>")
        if item["status"] == "ran":
            zero, one = series[0][1], series[1][1]
            out.append(_table(["Year", "Net, 0 tick", "Net, 1 tick"],
                              [[_e(year), usd(zero[year]), usd(one.get(year))] for year in sorted(zero)]))
    return "".join(out)


def _costs(results: Mapping) -> str:
    rows = []
    for row in ("P1", "P2", "P3"):
        item = _row(results, row)
        if item["status"] != "ran":
            rows.append([_e(row), "n/a", *[""] * 8])
            continue
        for tick in study.SLIPPAGE_TICKS:
            s = item["stats"][str(tick)]
            rows.append([_e(row), str(tick), str(s["trades"]), usd(s["grossUsd"]), usd(s["feesUsd"]),
                         usd(s["slippageUsd"]), usd(s["netUsd"]), f"${s['netPerTrade']:,.2f}",
                         f"{s['winRate'] * 100:.1f}%", usd(s["maxDrawdownUsd"])])
    costs = results["costs"]
    return ("<h2>Costs</h2>" + f"<p>1 NQ contract = ${costs['pointUsd']:g} per point; tick {costs['tickPoints']:g} "
            f"point = ${costs['tickUsd']:g}; fees ${costs['feesUsd']:.2f} per round trip; slippage per side on "
            "every entry and exit fill. Tests use 1 tick per side.</p>"
            + _table(["Row", "Ticks/side", "Trades", "Gross", "Fees", "Slippage", "Net", "Net/trade", "Win rate",
                      "Max DD"], rows))


def _tests(results: Mapping) -> str:
    wf = results["walkForward"]
    folds = _table(["Test year", "Pick", "Training net", "Test net"],
                   [[str(f["year"]), _e(f["pick"]), usd(f["trainNet"]), usd(f["testNet"])] for f in wf["folds"]])
    return ("<h2>Tests T1-T7</h2>" + _table(["Test", "Pass when", "Value", "Result"],
                                           [[_e(t["id"]), _e(t["name"]), _e(t["value"]), _mark(t["pass"])]
                                            for t in results["tests"]], text=True)
            + "<p class='dim'>Outcome: \"reconstruction passed\" when T1-T7 all pass; otherwise the first test "
              "that does not pass decides (a test that could not be computed does not pass).</p>"
            + f"<h2>Walk-forward</h2><p>Anchored: training years from 2013 pick the (a) row with the highest net at "
              f"1 tick; stitched test-year net {usd(wf['stitchedNet'])}.</p>" + (folds if wf["folds"] else ""))


def _variants(results: Mapping) -> str:
    rows = []
    for item in results["rows"]:
        if item["status"] != "ran":
            rows.append([_e(item["row"]), _e(item["dataset"]), _e(item["change"]), _e(item["status"]),
                         "", "", "", "", ""])
            continue
        s = item["stats"][str(study.BASE_TICKS)]
        years = [y for y in item["fullYears"]]
        good = sum(1 for y in years if s["perYear"].get(str(y), 0.0) > 0)
        rows.append([_e(item["row"]), _e(item["dataset"]), _e(item["change"]), str(s["trades"]), usd(s["netUsd"]),
                     f"${s['netPerTrade']:,.2f}", f"{s['winRate'] * 100:.1f}%", f"{s['sharpe']:.2f}",
                     f"{good}/{len(years)}"])
    return ("<h2>Variants (N = 33, 1 tick/side)</h2>"
            + _table(["Row", "Data", "Change from P1", "Trades", "Net", "Net/trade", "Win rate", "Sharpe",
                      "Years +"], rows))


def _diagnostics(results: Mapping) -> str:
    diag = results["diagnostics"]
    items = []
    for row, label in (("LA", "Look-ahead row"), ("BR", "Bridge row ((b) rules on (a) at 5 minutes)"),
                       ("NQ", "P3 rules on real NQ 5-minute bars")):
        item = diag["rows"][row]
        if item["status"] == "ran":
            s = item["stats"][str(study.BASE_TICKS)]
            items.append([_e(label), f"{s['trades']} trades, net {usd(s['netUsd'])}, {item['from']} to {item['to']}"])
        else:
            items.append([_e(label), _e(item["status"])])
    for key, label in (("nqVsP3", "NQ vs QQQ per session (P3 rules)"), ("nqVsP1", "NQ (P3 rules) vs CFD P1")):
        t = diag["tracking"][key]
        corr = "n/a" if t["correlation"] is None else f"{t['correlation']:.2f}"
        items.append([_e(label), f"{t['sessions']} sessions, correlation {corr}"])
    rc = diag["randomControl"] or {}
    items.append(["Random-entry control (seed 7)", "not run" if rc.get("p95") is None else
                  f"P1 ${rc['actual']:,.2f}/trade vs 95th percentile ${rc['p95']:,.2f} of {rc['draws']} draws"])
    for row, item in diag["nautilus"].items():
        text = "not run" if not item else (item.get("reason") or
                                          f"{'same' if item.get('same') else 'NOT the same'} entry/exit bars and fill "
                                          f"prices on {item.get('booked')} of {item.get('trades')} trades")
        items.append([f"NautilusTrader, {_e(row)}", _e(text)])
    mfi = diag["mfi"] or {}
    items.append(["MFI state, CFD vs NQ volume", "not run" if mfi.get("agreement") is None else
                  f"{mfi['agreement'] * 100:.1f}% agree on {mfi['bars']} bars"])
    data = results["data"].get("datasets", {})
    a = data.get("a", {})
    if a:
        items.append(["CFD spread (median, never charged)", f"{a.get('spreadMedianPoints') or 0:.2f} points"])
        items.append(["Partial buckets (a)",
                      f"5-minute {a.get('partialBuckets5')}, 15-minute {a.get('partialBuckets15')}"])
    for key in ("a", "b", "c"):
        if key in data:
            d = data[key]
            text = f"{d.get('sessions')} sessions {d.get('from')} to {d.get('to')}, {d.get('dropped')} dropped"
            items.append([f"Dataset ({key})", text])
    full = data.get("a_full", {})
    items.append(["V8 full-session bars (Q-ETH)", _e(full.get("status", "unknown"))])
    return "<h2>Diagnostics (outside N)</h2>" + _table(["Check", "Result"], items, text=True)


def _years_up(per_year: Mapping[str, float], full: Sequence[int]) -> tuple[int, int]:
    years = [str(year) for year in full if str(year) in per_year]
    return sum(1 for year in years if per_year[year] > 0), len(years)


def _lookahead(results: Mapping) -> str:
    """The look-ahead diagnostic next to P1, fees only (the reel's cost setting): what a timing error does."""
    la, p1 = results["diagnostics"]["rows"]["LA"], _row(results, "P1")
    if la["status"] != "ran" or p1["status"] != "ran":
        return ""
    full = p1["fullYears"]
    la0, p10 = _per_year(la, 0), _per_year(p1, 0)
    k_la, n_la = _years_up(la0, full)
    k_p1, n_p1 = _years_up(p10, full)
    return ("<h2>What a look-ahead mistake does (diagnostic, outside the tests)</h2>"
            "<p>The look-ahead row uses the same rules as P1 but lets each 1-minute bar read the 5-minute bucket that "
            "is still forming (on TradingView: a higher-timeframe request with look-ahead on and no offset). It is a "
            "timing error, not a strategy, and it is never a library candidate.</p>"
            f"<p>Fees only, no slippage (the reel's setting): look-ahead <b>{k_la}/{n_la}</b> full years profitable, "
            f"net {usd(la['stats']['0']['netUsd'])}; honest P1 <b>{k_p1}/{n_p1}</b>, net "
            f"{usd(p1['stats']['0']['netUsd'])}. "
            + ("A result like \"profitable every year\" appears only with the error. This does not show that the "
               "reel's paid script has this error; it shows that this error alone can produce such a record."
               if k_la == n_la and k_p1 < n_p1 else
               "The look-ahead row does not separate from the honest rules here.")
            + "</p>"
            + _year_bars("Fees only: look-ahead diagnostic vs honest P1, net dollars per year, 1 NQ",
                         [("look-ahead (invalid)", la0), ("P1 honest", p10)]))


def _options_form(results: Mapping) -> str:
    """Decision record Q8: no options form unless the futures test passes; the arithmetic for P1."""
    p1 = _row(results, "P1")
    if p1["status"] != "ran":
        return ""
    gross = p1["stats"]["0"]["grossPerTrade"]
    points = gross / study.POINT_USD
    qqq = points / OPTIONS_NDX_PER_QQQ
    per_option = qqq * OPTIONS_DELTA * 100
    passed = results["outcome"] == document.PASSED
    facts = (f"P1's average gross move is {usd(gross)} per NQ contract per trade = {points:.2f} index points = about "
             f"${qqq:.4f} per QQQ share (NDX / QQQ about {OPTIONS_NDX_PER_QQQ:g}). A 0-1 DTE at-the-money QQQ option "
             f"(delta about {OPTIONS_DELTA:g}) would gain about ${per_option:.2f} per contract on that move. QQQ options "
             "are quoted in $0.01 steps, so even a one-cent-wide market costs at least $1.00 per contract to enter and "
             "exit, before time decay over the hold.")
    if passed:
        verdict = ("The futures test passed, so decision record Q8 calls for a separate options study on real QQQ "
                   "quotes (a 0-1 DTE debit vertical, 2% maximum loss); it is not part of this run.")
    elif per_option < OPTIONS_MIN_COST:
        verdict = ("The futures result fails after costs and the per-trade move is smaller than the minimum option "
                   "cost, so the signal does not translate into a defined-risk QQQ option position. No options "
                   "backtest was run (decision record Q8).")
    else:
        verdict = ("The futures result fails after costs, so no options form is built (decision record Q8).")
    return f"<h2>Options form (options only, defined risk)</h2><p>{'Studied separately' if passed else 'Not translated'}. " \
        f"{facts} {verdict}</p>"


def _indicators() -> str:
    rows = [[_e(name), f"{_e(text)} <a href='{_e(url)}' style='color:#60a5fa'>source</a>"]
            for name, text, url in INDICATORS]
    return ("<h2>Indicators added</h2><p>Re-implemented from their public formulas in TypeScript and Python (one "
            "shared reference table); no Pine source copied.</p>" + _table(["Indicator", "Source"], rows, text=True))


def _data(results: Mapping) -> str:
    files = results["data"].get("files", [])
    rows = [[_e(f["path"].rsplit("/", 1)[-1]), f"{f['bytes']:,}", f"<code>{_e(f['sha256'][:16])}</code>"]
            for f in files[:40]]
    more = f"<p class='dim'>{len(files) - 40} more files in results.json.</p>" if len(files) > 40 else ""  # json-data-ignore: report text naming the run's output file; nothing is read
    provenance = results.get("provenance", {})
    commit = provenance.get("commit", "unknown")
    return ("<h2>Data and provenance</h2>" + (_table(["File", "Bytes", "SHA-256"], rows) if rows else "") + more
            + f"<p class='dim'>Commit <code>{_e(str(commit)[:12])}</code>, spec SHA-256 "
              f"<code>{_e(str(results['specSha256'])[:16])}</code>. Source: <a href='{document.SOURCE_URL}' "
              "style='color:#60a5fa'>Instagram reel</a> (untrusted marketing claim).</p>")


def render(results: Mapping) -> str:
    body = [_header(results), _charts(results), _lookahead(results), _costs(results), _tests(results),
            _variants(results), _options_form(results), _diagnostics(results), _indicators(),
            "<h2>Limits</h2><ul>" + "".join(f"<li>{_e(text)}</li>" for text in LIMITS) + "</ul>", _data(results)]
    return ("<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' "
            "content='width=device-width,initial-scale=1'><title>Trend Trio: Vertex reconstruction</title>"
            f"<style>{STYLE}{EXTRA_STYLE}</style></head><body><main>{''.join(body)}</main></body></html>\n")
