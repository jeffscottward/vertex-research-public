"""Dark HTML report of the Triple RSI study (research only; one self-contained file, inline SVG charts).

Phone layout (640 px and narrower): tables stack into labelled blocks, charts keep their text size (see STYLE)."""
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
.wrap{overflow-x:auto}
code{background:#1b2030;padding:1px 4px;border-radius:4px}
.chart{background:#12151c;border:1px solid #232834;border-radius:6px;margin:8px 0;padding:8px 14px 28px 0}
.chart figcaption{display:flex;flex-wrap:wrap;gap:2px 16px;margin:0 0 12px 12px;font-size:13px}
.chart figcaption span:first-child{flex-basis:100%}.chart .key{font-size:12px}
.plot{position:relative;margin-left:56px}
.plot svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.plot path,.plot line{vector-effect:non-scaling-stroke}
.plot span{position:absolute;color:#9aa3b2;font-size:11px;line-height:1;white-space:nowrap}
.plot .y{right:100%;margin-right:6px;transform:translateY(-50%)}
.plot .xs span{top:100%;margin-top:8px;transform:translateX(-50%)}
@media(max-width:640px){
main{padding:16px}
thead{display:none}
table,tbody,tr,td{display:block}
tr{padding:8px 0;border-bottom:1px solid #2a2f3a}
td,table.text td{border:0;padding:2px 0;text-align:left;white-space:normal;overflow-wrap:anywhere}
td:empty{display:none}
td::before{content:attr(data-label);display:block;color:#9aa3b2;font-size:12px;font-weight:400}
td:first-child{font-weight:600}
td:first-child::before{display:inline;margin-right:6px}
table.list td:not(:first-child):not(:empty){text-align:right;display:flow-root}
table.list td:not(:first-child)::before{float:left;margin-right:12px}
table.grid tr{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:0 8px}
table.grid td:first-child{grid-column:1/-1}
.plot .xs span:nth-child(even){display:none}
}
"""
COLORS = ("#60a5fa", "#9aa3b2", "#4ade80", "#f472b6")


def _e(text) -> str:
    return html.escape(str(text))


# On a phone a table this wide stacks as a grid of label-over-value cells. A narrower one stacks as a list.
GRID_COLUMNS = 7


def _table(head: Sequence[str], rows: Sequence[Sequence], *, text: bool = False) -> str:
    """`head` is plain text (escaped here); `rows` hold HTML. `text`: every column left-aligned and wrapped.

    Every cell carries its column head as `data-label`: on a phone (STYLE, 640 px and narrower) the head row is
    hidden and each row is a block of labelled values, so no table scrolls sideways. The explicit ARIA roles keep
    the rows and cells for screen readers when CSS changes the display of the table elements. On a phone, screen
    readers do not get the head row either; they read each value's label from `data-label`."""
    labels = [_e(cell) for cell in head]
    klass = "text" if text else "grid" if len(head) >= GRID_COLUMNS else "list"
    out = [f"<div class='wrap'><table class='{klass}' role='table'><thead role='rowgroup'><tr role='row'>",
           *(f"<th role='columnheader' scope='col'>{label}</th>" for label in labels),
           "</tr></thead><tbody role='rowgroup'>"]
    for row in rows:
        out.append("<tr role='row'>" + "".join(f"<td role='cell' data-label='{label}'>{cell}</td>"
                                               for label, cell in zip(labels, row, strict=True)) + "</tr>")
    out.append("</tbody></table></div>")
    return "".join(out)


def _mark(ok) -> str:
    if ok is None:
        return "<span class='dim'>info</span>"
    return "<span class='pass'>pass</span>" if ok else "<span class='fail'>fail</span>"


def _chart(series: Sequence[tuple[str, Sequence[Mapping]]], key: str, *, title: str, log: bool = False,
           percent: bool = True, height: int = 220) -> str:
    """Line chart of monthly points (`month`, `key`); every series on the same month axis.

    The SVG holds only the grid and the lines. It stretches to the plot box (`height` CSS px tall, any width). The
    title, the legend and the axis labels are HTML. Their font size is fixed, so the screen width does not change
    it. They are placed in percent of the plot box. Screen readers get the figure caption; the plot is hidden from
    them (the tables give the numbers)."""
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

    def x(month: str) -> float:
        """Percent of the plot width."""
        return 100 * position[month] / (len(months) - 1)

    def y(value: float) -> float:
        """Percent of the plot height, from the top."""
        return 100 * (1 - (level(value) - low) / (high - low))

    marks, levels = [], []
    for step in range(5):
        raw = low + (high - low) * step / 4
        value = math.exp(raw) - 1 if log else raw
        top = 100 - 25 * step
        digits = 0 if not log and (high - low) >= 0.1 or log else 1
        label = (f"{value * 100:.{digits}f}%" if percent else f"{value:.2f}").replace("-0%", "0%").replace("-0.0%", "0.0%")
        marks.append(f"<line x1='0' x2='100' y1='{top}' y2='{top}' stroke='#232834'/>")
        levels.append(f"<span class='y' style='top:{top}%'>{_e(label)}</span>")
    years = [f"<span style='left:{x(month):.2f}%'>{_e(month[:4])}</span>"
             for month in months[:: max(1, len(months) // 10)]]
    legend = []
    for number, (name, points) in enumerate(series):
        color = COLORS[number % len(COLORS)]
        path = " ".join(f"{'M' if index == 0 else 'L'}{x(point['month']):.2f},{y(point[key]):.2f}"
                        for index, point in enumerate(points))
        marks.append(f"<path d='{path}' fill='none' stroke='{color}' stroke-width='1.6'/>")
        legend.append(f"<span class='key' style='color:{color}'>{_e(name)}</span>")
    return (f"<figure class='chart'><figcaption><span>{_e(title)}</span>{''.join(legend)}</figcaption>"
            f"<div class='plot' style='height:{height}px' aria-hidden='true'><svg viewBox='0 0 100 100' "
            f"preserveAspectRatio='none'>{''.join(marks)}</svg>{''.join(levels)}"
            f"<div class='xs'>{''.join(years)}</div></div></figure>")


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
                       "drawdown", title="Drawdown from the high", height=160))
    body.append(_chart([("Options form, SPY 30-day call vertical, 2% risk", curves["optionsSpy"])], "value",
                       title="Vertex options form: return since the start", height=180))
    body.append(_chart([("Options form drawdown", curves["optionsSpy"])], "drawdown",
                       title="Vertex options form: drawdown", height=140))

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
            rows.append([row["symbol"], label, "no trade", *[""] * 12])
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
                f"{pct(carlo.get('worstDrawdown'))}, median end multiple {num(carlo.get('medianMultiple'))}. "
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
