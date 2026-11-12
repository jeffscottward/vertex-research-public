"""Dark HTML report of the Triple RSI study (research only; one self-contained file, inline SVG charts)."""
from __future__ import annotations

import html
import math
from collections.abc import Mapping, Sequence

from . import document, rules, study
from .document import COST_LABEL, EXECUTION_LABEL, VARIANT_LABEL, num, pct

__all__ = ["render"]

STYLE = """
:root{color-scheme:dark}
body{background:#0f1115;color:#e7e7e7;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0}
main{max-width:1240px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px;border-bottom:1px solid #2a2f3a;padding-bottom:4px}
.dim{color:#9aa3b2}.pass{color:#4ade80}.fail{color:#f87171}.note{color:#fbbf24}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13.5px}
th,td{border-bottom:1px solid #232834;padding:4px 8px;text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:#9aa3b2;font-weight:600}
table.text th,table.text td{text-align:left;white-space:normal}
.box{background:#161a22;border:1px solid #2a2f3a;border-radius:8px;padding:12px 16px;margin:12px 0}
.wrap{overflow-x:auto}svg{background:#12151c;border:1px solid #232834;border-radius:6px}
code{background:#1b2030;padding:1px 4px;border-radius:4px}
"""
COLORS = ("#60a5fa", "#9aa3b2", "#4ade80", "#f472b6")


def _e(text) -> str:
    return html.escape(str(text))


def _table(head: Sequence[str], rows: Sequence[Sequence], *, text: bool = False) -> str:
    """`head` is plain text (escaped here); `rows` hold HTML. `text`: every column left-aligned and wrapped."""
    klass = " class='text'" if text else ""
    out = [f"<div class='wrap'><table{klass}><tr>",
           *(f"<th>{_e(cell)}</th>" for cell in head), "</tr>"]
    for row in rows:
        out.append("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>")
    out.append("</table></div>")
    return "".join(out)


def _mark(ok) -> str:
    if ok is None:
        return "<span class='dim'>info</span>"
    return "<span class='pass'>pass</span>" if ok else "<span class='fail'>fail</span>"


def _chart(series: Sequence[tuple[str, Sequence[Mapping]]], key: str, *, title: str, log: bool = False,
           percent: bool = True, height: int = 260) -> str:
    """Line chart of monthly points (`month`, `key`); every series on the same month axis."""
    width, left, right, top, bottom = 1120, 64, 16, 28, 28
    months = sorted({point["month"] for _, points in series for point in points})
    if len(months) < 2:
        return ""
    position = {month: index for index, month in enumerate(months)}

    def level(value: float) -> float:
        return math.log(1 + value) if log else value

    values = [level(point[key]) for _, points in series for point in points]
    low, high = min(values), max(values)
    if high == low:
        high = low + 1
    span_x = width - left - right
    span_y = height - top - bottom

    def x(month: str) -> float:
        return left + span_x * position[month] / (len(months) - 1)

    def y(value: float) -> float:
        return top + span_y * (1 - (level(value) - low) / (high - low))

    parts = [f"<svg viewBox='0 0 {width} {height}' width='100%' role='img' aria-label='{_e(title)}'>",
             f"<text x='{left}' y='18' fill='#e7e7e7' font-size='13'>{_e(title)}</text>"]
    for step in range(5):
        raw = low + (high - low) * step / 4
        value = math.exp(raw) - 1 if log else raw
        yy = top + span_y * (1 - step / 4)
        digits = 0 if not log and (high - low) >= 0.1 or log else 1
        label = (f"{value * 100:.{digits}f}%" if percent else f"{value:.2f}").replace("-0%", "0%").replace("-0.0%", "0.0%")
        parts.append(f"<line x1='{left}' x2='{width - right}' y1='{yy:.1f}' y2='{yy:.1f}' stroke='#232834'/>"
                     f"<text x='{left - 6}' y='{yy + 4:.1f}' fill='#9aa3b2' font-size='11' text-anchor='end'>"
                     f"{_e(label)}</text>")
    for month in months[:: max(1, len(months) // 10)]:
        parts.append(f"<text x='{x(month):.1f}' y='{height - 8}' fill='#9aa3b2' font-size='11' "
                     f"text-anchor='middle'>{_e(month[:4])}</text>")
    for number, (name, points) in enumerate(series):
        color = COLORS[number % len(COLORS)]
        path = " ".join(f"{'M' if index == 0 else 'L'}{x(point['month']):.1f},{y(point[key]):.1f}"
                        for index, point in enumerate(points))
        parts.append(f"<path d='{path}' fill='none' stroke='{color}' stroke-width='1.6'/>")
        parts.append(f"<text x='{left + 8 + 260 * number}' y='{top + 14}' fill='{color}' font-size='12'>"
                     f"{_e(name)}</text>")
    parts.append("</svg>")
    return "".join(parts)


def _share_rows(results: Mapping, symbol: str | None = None, execution: str | None = None,
                cost: float | None = None) -> list[Mapping]:
    return [row for row in results["shares"] if row["params"] == rules.STATED.key() and row["basis"] == "total"
            and (symbol is None or row["symbol"] == symbol) and (execution is None or row["execution"] == execution)
            and (cost is None or row["costPerSide"] == cost)]


def _stats_cells(stats: Mapping) -> list[str]:
    return [str(stats["trades"]), pct(stats["winRate"]), pct(stats["averageReturn"], 2), num(stats["profitFactor"]),
            pct(stats["cagr"], 2), pct(stats["maxDrawdown"]), pct(stats["exposure"]),
            num(stats["averageHoldDays"], 1), pct(stats["worstTrade"]), num(stats["sharpe"]), num(stats["oosSharpe"])]


STATS_HEAD = ["Trades", "Win rate", "Avg trade", "Profit factor", "CAGR", "Max DD", "In market", "Avg hold (d)",
              "Worst trade", "Sharpe", "OOS Sharpe"]


def render(results: Mapping, doc: Mapping) -> str:
    decision = results["decision"]
    stated = _share_rows(results, "SPY", "close", 0.0)[0]["stats"]
    base = _share_rows(results, "SPY", "close", study.COSTS["base"])[0]["stats"]
    hold = results["buyHold"]["SPY"]
    deciding = next(row for row in results["options"] if (row["symbol"], row["variant"]) == study.DECIDING_OPTIONS)
    ds = deciding["stats"]
    verdict = doc["verdict"]
    verdict_class = "pass" if verdict == "edge" else "fail"
    body = [f"<h1>Triple RSI (QuantifiedStrategies, \"90% win rate\"): Vertex backtest</h1>",
            f"<p class='dim'>Card vertex-triple-rsi. Ran {_e(results['provenance']['ran'])} on the rig, commit "
            f"<code>{_e(results['provenance']['commit'][:10])}</code>. Research only: no order, no deployment, Nautilus "
            "disarmed. Spec: <code>docs/specs/strategies/triple-rsi.md</code>.</p>",
            "<div class='box'>",
            f"<p><b>Verdict: <span class='{verdict_class}'>{_e(verdict.upper())}</span></b>. "
            f"Strict gate: {_mark(decision['passesGate'])}. Lower bar: {_mark(decision['passesLowerBar'])}. "
            f"\"90% win rate\" reproduces: {_mark(decision['winRateReproduces'])}.</p>",
            f"<p>{_e(doc['verdictReason'])}</p>",
            f"<p>Library: {'validated' if decision['passesGate'] else 'tested, failed'} (status backtested, tag "
            f"<code>{'validated' if decision['passesGate'] else 'failed'}</code>).</p></div>"]

    body.append("<h2>Rules (as stated)</h2><ol>" + "".join(f"<li>{_e(rule['rule'])}</li>" for rule in doc["rules"])
                + "</ol><p class='dim'>Choices for what the post leaves open:</p>"
                + _table(["Gap", "Choice"], [[_e(gap["gap"]), _e(gap["choice"])] for gap in doc["gaps"]], text=True))

    body.append("<h2>Claim vs ours (SPY)</h2>" + _table(
        ["Measure", "Claim", "Ours, as stated (no cost)", "Ours, 5 bp/side", "Buy-and-hold"],
        [["Period", "1993 to the article", f"{stated['start']} to {stated['end']}", "same", "same"],
         ["Trades", "103 (post: 97)", str(stated["trades"]), str(base["trades"]), "1"],
         ["Win rate", "90%", pct(stated["winRate"]), pct(base["winRate"]), ""],
         ["Average gain per trade", "1.2%", pct(stated["averageReturn"], 2), pct(base["averageReturn"], 2), ""],
         ["Profit factor", "4 (post: 8)", num(stated["profitFactor"]), num(base["profitFactor"]), ""],
         ["End value from 100,000", "304,857 (post chart)", f"{stated['finalEquity']:,.0f}", f"{base['finalEquity']:,.0f}",
          f"{hold['finalEquity']:,.0f}"],
         ["CAGR", "not stated", pct(stated["cagr"], 2), pct(base["cagr"], 2), pct(hold["cagr"], 2)],
         ["Max drawdown", "not stated", pct(stated["maxDrawdown"]), pct(base["maxDrawdown"]), pct(hold["maxDrawdown"])],
         ["Time in market", "not stated", pct(stated["exposure"]), pct(base["exposure"]), "100%"],
         ["Average hold (trading days)", "not stated", num(stated["averageHoldDays"], 1),
          num(base["averageHoldDays"], 1), ""],
         ["Worst trade", "not stated", pct(stated["worstTrade"]), pct(base["worstTrade"]), ""],
         ["Sharpe", "not stated", num(stated["sharpe"]), num(base["sharpe"]), num(hold["sharpe"])]]))

    curves = results["curves"]
    hold_curve = curves["buyHoldSpy"]
    body.append("<h2>Equity and drawdown (SPY)</h2>")
    body.append(_chart([("Triple RSI shares, as stated", curves["statedSpy"]), ("Buy-and-hold SPY", hold_curve)],
                       "value", title="Return since the start (log scale)", log=True))
    body.append(_chart([("Triple RSI shares, as stated", curves["statedSpy"]), ("Buy-and-hold SPY", hold_curve)],
                       "drawdown", title="Drawdown from the high", height=200))
    body.append(_chart([("Options form, SPY 30-day call vertical, 2% risk", curves["optionsSpy"])], "value",
                       title="Vertex options form: return since the start", height=220))
    body.append(_chart([("Options form drawdown", curves["optionsSpy"])], "drawdown",
                       title="Vertex options form: drawdown", height=180))

    body.append("<h2>Core 7 ETF twins, shares (signal close)</h2>")
    for cost in study.COSTS.values():
        rows = []
        for row in _share_rows(results, execution="close", cost=cost):
            hold_row = row["buyHold"]
            rows.append([row["symbol"], *_stats_cells(row["stats"]), pct(hold_row["cagr"], 2), num(hold_row["sharpe"])])
        body.append(f"<p class='dim'>{_e(COST_LABEL[cost])}</p>"
                    + _table(["Symbol", *STATS_HEAD, "B&H CAGR", "B&H Sharpe"], rows))

    body.append("<h2>Execution and costs (SPY shares)</h2>")
    rows = [[f"{EXECUTION_LABEL[row['execution']]}, {COST_LABEL[row['costPerSide']]}", *_stats_cells(row["stats"]),
             f"{row['nautilusGap']:.1e}"] for row in _share_rows(results, "SPY")]
    body.append(_table(["Run", *STATS_HEAD, "Nautilus gap"], rows))

    body.append("<h2>Options form (Vertex: defined risk, 2% max loss per spread)</h2>")
    rows = []
    for row in results["options"]:
        label = _e(VARIANT_LABEL[row["variant"]])
        if row["stats"] is None:
            rows.append([row["symbol"], label, "no trade", *[""] * 11])
            continue
        stats = row["stats"]
        carlo = stats["monteCarlo"] or {}
        rows.append([row["symbol"], label, str(stats["trades"]), pct(stats["winRate"]), pct(stats["averageReturn"]),
                     pct(stats["worstTrade"]), pct(stats["cagr"], 2), pct(stats["maxDrawdown"]), num(stats["sharpe"]),
                     num(stats["oosSharpe"]), num(stats["deflatedSharpe"]), pct(carlo.get("probabilityOfProfit")),
                     num(row["baselineSharpe"]), _mark(all(check["pass"] for check in row["checks"])),
                     _mark(row["lowerBar"])])
    body.append(_table(["Symbol", "Form", "Trades", "Win rate", "Avg trade", "Worst trade", "CAGR", "Max DD", "Sharpe",
                        "OOS Sharpe", "DSR", "MC P(profit)", "Always-on", "Gate", "Lower bar"], rows))
    body.append("<p class='dim'>Average trade and worst trade of the options rows are returns on the risked amount. "
                "Prices: Black-Scholes on the IV index (qc-ports option book), no chain history.</p>")

    body.append("<h2>Gate (the deciding row: options, SPY, 30-day call vertical)</h2>")
    rows = [[_e(check["check"]), _mark(check["pass"]), _e(document.check_value(check, ds))]
            for check in [*decision["checks"], *decision["extras"]]]
    body.append(_table(["Check", "Result", "Value"], rows))
    lower = (f"Lower bar (owner 2026-11-11): Sharpe {num(ds['sharpe'])} (needs 0.30), out-of-sample "
             f"{num(ds['oosSharpe'])} (needs above 0), Monte Carlo P(profit) "
             f"{pct((ds['monteCarlo'] or {}).get('probabilityOfProfit'))} (needs 80%), max drawdown "
             f"{pct(ds['maxDrawdown'])} (needs at most 25%), {ds['trades']} trades (needs 30): "
             f"{'pass' if decision['passesLowerBar'] else 'fail'}.")
    body.append(f"<p>{_e(lower)}</p>")

    body.append("<h2>Robustness</h2>")
    body.append(_table(["Check", "Result", "Detail"],
                       [[_e(item["check"]), _mark(item["pass"]), _e(item["result"])] for item in doc["robustness"]],
                       text=True))
    walk = results["walkForward"]
    if walk:
        body.append("<p class='dim'>Walk-forward folds (pick = best in-sample Sharpe of the grid):</p>" + _table(
            ["Fold", "In-sample days", "Pick", "OOS Sharpe (pick)", "OOS Sharpe (stated)", "OOS return (pick)",
             "OOS return (stated)"],
            [[str(item["fold"]), str(item["inSampleDays"]), _e(item["pick"]), num(item["outOfSampleSharpe"]),
              num(item["fixedSharpe"]), pct(item["outOfSampleReturn"]), pct(item["fixedReturn"])]
             for item in walk["picks"]]))
    stated_row = _share_rows(results, "SPY", "close", study.COSTS["base"])[0]["stats"]
    carlo = stated_row["monteCarlo"] or {}
    body.append(f"<p>Monte Carlo (SPY shares, 5 bp/side, 10,000 bootstrap paths of the trade returns): P(profit) "
                f"{pct(carlo.get('probabilityOfProfit'))}, drawdown p5 {pct(carlo.get('drawdownP5'))}, worst "
                f"{pct(carlo.get('drawdownWorst'))}, median end multiple {num(carlo.get('medianMultiple'))}. "
                f"Deflated Sharpe of that row: {num(stated_row['deflatedSharpe'])} with N = {results['trials']['n']} "
                f"runs (every variant, symbol, execution, cost level and form of this study).</p>")

    body.append("<h2>Parameter sensitivity (SPY shares, signal close, 5 bp/side)</h2>")
    body.append(_table(["Parameter", "Value", "Trades", "Sharpe", "CAGR", "Max DD"],
                       [[_e(row["param"]), _e(row["value"]), str(row["trades"]), num(row["sharpe"]),
                         pct(row["cagr"], 2), pct(row["maxDrawdown"])] for row in doc["sensitivity"]]))
    grid = results["grid"]
    sharpes = sorted(row["sharpe"] for row in grid)
    body.append(f"<p>All {len(grid)} variants (RSI 3-7 x entry 25/30/35 x exit 45/50/55 x average 150/200/250 x "
                f"Wilder/Cutler): Sharpe from {num(sharpes[0])} to {num(sharpes[-1])}, median "
                f"{num(sharpes[len(sharpes) // 2])}; {pct(results['neighbourShare'])} above 0.</p>")

    dsl = results["dsl"]
    body.append("<h2>DSL definition</h2>" + f"<p>The rule as a Vertex DSL definition ran in the NautilusTrader DSL "
                f"engine on SPY {dsl['from']} to {dsl['to']} (next-open fills, no cost): {dsl['trades']} trades, "
                f"{'the same' if dsl['sameTrades'] else 'NOT the same'} entry and exit dates as the rule, equity gap "
                f"{dsl['equityGap']:.1e} to the share ledger.</p>")

    body.append("<h2>Comparison</h2>" + _table(
        ["Name", "Kind", "CAGR", "Sharpe", "Max DD"],
        [[_e(row["name"]), _e(row["kind"]), pct(row["cagr"], 2), num(row["sharpe"]), pct(row["maxDrawdown"])]
         for row in doc["comparison"]]))
    body.append("<p class='dim'>The RSI(2) row is the ADX study's baseline (other sample and cost model).</p>")

    provenance = results["provenance"]
    body.append("<h2>Data and provenance</h2>" + _table(
        ["File", "SHA-256"], [[_e(name), f"<code>{_e(digest[:16])}</code>"]
                              for name, digest in provenance["dataFiles"].items()]))
    body.append(f"<p class='dim'>Daily bars: IBKR first, Yahoo fills gaps (options-forms fetch). Every share run "
                f"booked by the ledger and NautilusTrader 1.227.0 (largest equity gap "
                f"{max(row['nautilusGap'] for row in results['shares']):.1e}); every options run by the qc-ports ledger "
                f"and NautilusTrader. Source: <a href='{document.SOURCE_URL}' style='color:#60a5fa'>QuantifiedStrategies"
                f"</a> (untrusted marketing claim).</p>")
    return ("<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' "
            "content='width=device-width,initial-scale=1'><title>Triple RSI: Vertex backtest</title>"
            f"<style>{STYLE}</style></head><body><main>{''.join(body)}</main></body></html>\n")
