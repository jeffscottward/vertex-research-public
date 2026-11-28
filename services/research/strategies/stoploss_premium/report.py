"""Dark HTML report of the stopping-premium study: one result table per test (pure Python)."""
from __future__ import annotations

import html
from collections.abc import Sequence

from . import premium

VERDICT_CLASS = {premium.ADDS_RETURN: "pass", premium.PAID_INSURANCE: "ins", premium.FAIL: "fail",
                 premium.NOT_ENOUGH: "nd", premium.INCONCLUSIVE: "inc"}

CSS = """
body{background:#0e1116;color:#e6e6e6;font:15px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;margin:0;padding:16px}
main{max-width:1180px;margin:auto}h1{font-size:1.5em}h2{margin-top:2em;border-bottom:1px solid #333;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}th,td{border-bottom:1px solid #2a2f37;
padding:5px 6px;text-align:right;vertical-align:top}th{color:#9aa4b2;font-weight:600}td:first-child,th:first-child{text-align:left}
.v{font-weight:700;padding:2px 6px;border-radius:4px;white-space:nowrap}.pass{background:#14532d}.ins{background:#1e3a8a}
.fail{background:#7f1d1d}.nd{background:#374151}.inc{background:#713f12}.badge{display:inline-block;padding:1px 8px;
border-radius:10px;font-size:12px;margin-left:8px}.real{background:#14532d}.model{background:#78350f}.none{background:#374151}
img{max-width:100%;border:1px solid #2a2f37;border-radius:6px;margin:6px 0}.note{color:#9aa4b2;font-size:13px}
.wrap{overflow-x:auto}code{color:#fbbf24}ul{padding-left:20px}
"""


def pct(x: float | None, digits: int = 1) -> str:
    return "–" if x is None else f"{x * 100:+.{digits}f}%"


METHOD_HTML = """
<h2 id=method>Method</h2>
<p>The full method, its decisions, alternatives, risks and the 🐘🐟 EGM review are in
<code>research/backtests/stoploss-premium/design.md</code> (vertex-research-public repository). In short:</p>
<ul>
<li>Each test runs the same entries with the exit rule and without it. Δμ is the stopping premium of Kaminski and
Lo (2014): the annualized mean daily return with the rule minus without it, after costs.</li>
<li>Results (fixed before the run): fewer than 100 stop events = "not enough data"; "pass: adds return" needs
Δμ &gt; 0, the 90% block-bootstrap interval above 0, both halves and both threshold checks positive; "pass: paid
insurance" = Δμ ≤ 0 and the maximum drawdown at least 10% smaller; "fail" = Δμ &lt; 0, the interval below 0 and
no 10% drawdown cut; anything else = "inconclusive".</li>
<li>Only the headline row (★) of a live rule (tests A, B, C) can raise an owner question. Other rows are
diagnostics. Rows are exploratory evidence: with about 40 rows, a few cross a 90% interval by chance.</li>
<li>Option prices are MODEL PRICES (no historical option bid/ask exists in our data). A result on model prices is
an evidence gap, not a proof.</li>
<li>Research only. No order, arming flag, size, cap, gate or other risk setting was changed.</li>
</ul>
"""


def plain_pct(x: float | None, digits: int = 1) -> str:
    return "–" if x is None else f"{x * 100:.{digits}f}%"


def num(x: float | None, digits: int = 2) -> str:
    return "–" if x is None else f"{x:.{digits}f}"


def esc(text: object) -> str:
    return html.escape(str(text))


def variant_row(v: dict) -> str:
    s = v["summary"]
    verdict = v["verdict"]
    cls = VERDICT_CLASS.get(verdict, "nd")
    if "premium" not in s:
        return (f"<tr><td>{esc(v['name'])}<div class=note>{esc(v.get('note', ''))}</div></td>"
                f"<td><span class='v {cls}'>{esc(verdict)}</span></td>" + "<td>–</td>" * 9
                + f"<td>{s.get('stopEvents', '–')}</td><td>–</td></tr>")
    lo, hi = s["interval"]
    cond = s["condition"]
    met = {True: "met", False: "not met", None: "–"}[cond["met"]]
    thr = " / ".join(pct(t, 2) for t in v["thresholds"]) or "–"
    cost = v.get("insuranceCost")
    note = v.get("note", "")
    tr = v.get("perTrade")
    if tr and tr.get("trades"):
        note += (f"; per trade: {pct(tr['meanWith'])} with vs {pct(tr['meanWithout'])} without the rule "
                 f"(of the entry debit or capital), rule better in {plain_pct(tr['shareBetter'], 0)} of trades")
    if v.get("exposure", 1.0) < 1:
        note += f"; account view: {plain_pct(v['exposure'], 0)} of the account in premium, the rest in T-bills"
    by = v.get("byExposure")
    if by:
        note += "; result at a premium share of " + ", ".join(
            f"{plain_pct(float(e), 0)}: {x['verdict']}" for e, x in by.items())
    if s.get("stopDays"):
        note += f"; {s['stopDays']:,} distinct stop days"
    halves = s.get("drawdownCutHalves")
    if halves:
        note += f"; drawdown cut per half {plain_pct(halves[0], 0)} / {plain_pct(halves[1], 0)}"
    return (
        f"<tr><td>{'★ ' if v.get('headline') else ''}{esc(v['name'])}<div class=note>{esc(note)}</div></td>"
        f"<td><span class='v {cls}'>{esc(verdict)}</span></td>"
        f"<td>{pct(s['premium'], 2)}</td><td>{pct(lo, 2)} to {pct(hi, 2)}</td>"
        f"<td>{pct(s['halves'][0], 2)} / {pct(s['halves'][1], 2)}</td><td>{thr}</td>"
        f"<td>{plain_pct(s['volWith'])} vs {plain_pct(s['volWithout'])}</td>"
        f"<td>{plain_pct(s['mddWith'])} vs {plain_pct(s['mddWithout'])}</td>"
        f"<td>{plain_pct(s['p0'])}</td><td>{pct(s['impliedStoppedReturn'])} vs rf {plain_pct(s['rf'])}</td>"
        f"<td>ρ {num(cond['rho'])} vs Sharpe {num(cond['sharpe'])} at {cond['stepDays']} d: {met}</td>"
        f"<td>{s['stopEvents']:,}</td><td>{'–' if cost is None else f'{cost * 100:.2f} pp'}</td></tr>")


HEAD = ("<tr><th>Variant</th><th>Result</th><th>Δμ / year after costs</th><th>90% interval</th>"
        "<th>1st / 2nd half</th><th>Threshold −25% / +25%</th><th>Volatility with vs without</th>"
        "<th>Max drawdown with vs without</th><th>p₀ (time out)</th><th>E[r | stopped] (eq. 4)</th>"
        "<th>Sufficient condition</th><th>Stop events</th><th>Return given up per point of drawdown removed</th></tr>")


def test_section(t: dict, charts: Sequence[str]) -> str:
    badge = {"real": "real", "model price": "model", "none": "none"}.get(t["prices"], "none")
    label = {"real": "real prices", "model price": "MODEL PRICE (no option bid/ask history)",
             "none": "no prices needed"}.get(t["prices"], t["prices"])
    rows = "".join(variant_row(v) for v in t["variants"])
    live = ("<p class=note>Live rule: a 'fail' or 'paid insurance' result on the headline row (★) goes to the owner "
            "as one question; other rows are diagnostics; on model prices a result is an evidence gap.</p>"
            if t.get("live") else
            "<p class=note>Not a live rule (dry run, not armed, or switched off): no owner question.</p>")
    bias = f"<p class=note>Bias: {esc(t['bias'])}.</p>" if t.get("bias") else ""
    imgs = "".join(f"<img src='{esc(c)}' alt='Test {esc(t['id'])} chart'>" for c in charts)
    return (f"<h2 id='test-{esc(t['id'])}'>Test {esc(t['id'])}: {esc(t['title'])}"
            f"<span class='badge {badge}'>{esc(label)}</span></h2>"
            f"<p class=note>{esc(t.get('universe', ''))}</p>{live}{bias}"
            f"<div class=wrap><table>{HEAD}{rows}</table></div>{imgs}")


def page(title: str, intro_html: str, tests: Sequence[dict], charts: dict[str, list[str]], method_html: str) -> str:
    body = "".join(test_section(t, charts.get(t["id"], [])) for t in tests)
    return (f"<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport "
            f"content='width=device-width,initial-scale=1'><title>{esc(title)}</title><style>{CSS}</style></head>"
            f"<body><main><h1>{esc(title)}</h1>{intro_html}{body}{method_html}</main></body></html>")


def overview(tests: Sequence[dict], summary_png: str | None) -> str:
    """Top of the page: the summary chart and one line per variant (test, variant, result, Δμ, drawdown)."""
    rows = []
    for t in tests:
        for v in t["variants"]:
            s = v["summary"]
            cls = VERDICT_CLASS.get(v["verdict"], "nd")
            prices = "model price" if t["prices"] == "model price" else ("real" if t["prices"] == "real" else "–")
            dd = (f"{plain_pct(s['mddWith'])} vs {plain_pct(s['mddWithout'])}" if "mddWith" in s else "–")
            n = s.get("stopEvents")
            events = f"{n:,}" if isinstance(n, int) else "–"
            star = "★ " if v.get("headline") else ""
            rows.append(f"<tr><td><a href='#test-{esc(t['id'])}'>{esc(t['id'])}</a></td><td>{star}{esc(v['name'])}</td>"
                        f"<td><span class='v {cls}'>{esc(v['verdict'])}</span></td>"
                        f"<td>{pct(s.get('premium'), 2)}</td><td>{dd}</td><td>{events}</td>"
                        f"<td>{prices}</td></tr>")
    img = f"<img src='{esc(summary_png)}' alt='Stopping premium of every test variant'>" if summary_png else ""
    head = ("<tr><th>Test</th><th>Variant</th><th>Result</th><th>Δμ / year after costs</th>"
            "<th>Max drawdown with vs without</th><th>Stop events</th><th>Prices</th></tr>")
    return f"{img}<h2 id=overview>All results</h2><div class=wrap><table>{head}{''.join(rows)}</table></div>"
