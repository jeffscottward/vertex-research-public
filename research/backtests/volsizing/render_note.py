"""Render the vol-sizing research note (dark HTML with an inline SVG chart) from results.json.

    python3 research/backtests/volsizing/render_note.py research/backtests/volsizing/results.json \
        ~/Documents/reports/web/vertex-volsizing/index.html

Research only: the note never authorizes a trade. Only derived statistics of public Yahoo data
and a dummy $1,000,000 account appear in it.
"""
from __future__ import annotations

import html
import json
import math
import sys
from pathlib import Path

COLORS = {"current": "#e7e7e7", "vt-matched": "#4fb3ff", "vt-buffer": "#b48cff",
          "brake": "#3ccf91", "vt-16": "#f0a35a"}


def pct(x, d=2):
    return "–" if x is None else f"{x * 100:.{d}f}%"


def num(x, d=2):
    return "–" if x is None else f"{x:.{d}f}"


def chart(strategies) -> str:
    """Three log-scale equity panels (monthly NLV / starting capital)."""
    w, h, pad_l, pad_b, pad_t = 360, 260, 46, 28, 26
    panels = []
    for n, s in enumerate(strategies):
        curves = s["curves"]
        values = [v for c in curves.values() for _, v in c]
        lo, hi = math.log(min(values)), math.log(max(values))
        lo, hi = lo - 0.02, hi + 0.02
        months = len(next(iter(curves.values())))
        x0 = n * (w + 14)

        def px(i, _x0=x0, _m=months):
            return _x0 + pad_l + (w - pad_l - 8) * i / (_m - 1)

        def py(v, _lo=lo, _hi=hi):
            return pad_t + (h - pad_t - pad_b) * (1 - (math.log(v) - _lo) / (_hi - _lo))

        parts = [f'<rect x="{x0}" y="0" width="{w}" height="{h}" fill="#151821" rx="6"/>',
                 f'<text x="{x0 + 10}" y="17" fill="#c9a54a" font-size="12">'
                 f'{html.escape(s["id"] + " " + s["name"])}</text>']
        for tick in (0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.6, 2.0, 2.5):
            if lo <= math.log(tick) <= hi:
                y = py(tick)
                parts.append(f'<line x1="{x0 + pad_l}" x2="{x0 + w - 8}" y1="{y:.1f}" y2="{y:.1f}" '
                             f'stroke="#2a2e36"/><text x="{x0 + 6}" y="{y + 4:.1f}" fill="#8a8f98" '
                             f'font-size="10">{tick:.1f}x</text>')
        labels = [k for k, _ in next(iter(curves.values()))]
        for i, label in enumerate(labels):
            if label.endswith("-01") and int(label[:4]) % 4 == 0:
                parts.append(f'<text x="{px(i):.1f}" y="{h - 9}" fill="#8a8f98" font-size="10" '
                             f'text-anchor="middle">{label[:4]}</text>')
        for key in ("vt-16", "vt-buffer", "brake", "vt-matched", "current"):
            pts = " ".join(f"{px(i):.1f},{py(v):.1f}" for i, (_, v) in enumerate(curves[key]))
            width = 1.8 if key in ("current", "vt-matched") else 1.2
            parts.append(f'<polyline fill="none" stroke="{COLORS[key]}" stroke-width="{width}" '
                         f'points="{pts}"/>')
        panels.append("".join(parts))
    total_w = len(strategies) * (w + 14) - 14
    legend = "".join(
        f'<span style="color:{c}">&#9632; {html.escape(k)}</span> ' for k, c in COLORS.items())
    return (f'<div class="wrap"><svg viewBox="0 0 {total_w} {h}" width="100%" '
            f'role="img" aria-label="Equity curves per strategy, log scale">{"".join(panels)}</svg>'
            f'</div><p class="legend">{legend}</p>')


def ci(c) -> str:
    return "–" if not c else f"{c['p05']:+.2f} to {c['p95']:+.2f}"


def results_table(strategies) -> str:
    head = ("<tr><th>Strategy</th><th>Sizing</th><th>τ</th><th>CAGR</th><th>Sharpe</th>"
            "<th>ΔSharpe vs current, 90% CI</th><th>Vol</th><th>Max DD</th><th>Worst month</th>"
            "<th>Contracts/trade (mean / max)</th><th>Max loss/trade (mean / max)</th>"
            "<th>Gate bound: entries / rolls</th><th>Resizes</th><th>Costs (% start cap.)</th>"
            "<th>Sharpe (ΔCI), IV = 252d RV</th><th>Sharpe (ΔCI), IV = Cboe index</th></tr>")
    rows = []
    for s in strategies:
        for v in s["variants"]:
            rb, rx = v["robustRv252"], v["robustIvIndex"]
            rows.append(
                f'<tr><td>{html.escape(s["id"])}</td><td style="color:{COLORS[v["id"]]}">'
                f'{html.escape(v["label"])}</td><td>{pct(v["tau"], 1)}</td><td>{pct(v["cagr"])}</td>'
                f'<td>{num(v["sharpe"])}</td><td>{ci(v["sharpeDiffCi"])}</td>'
                f'<td>{pct(v["vol"], 1)}</td><td>{pct(v["maxDrawdown"], 1)}</td>'
                f'<td>{pct(v["worstMonth"])} ({v["worstMonthAt"]})</td>'
                f'<td>{num(v["contractsMean"], 1)} / {v["contractsMax"]}</td>'
                f'<td>{pct(v["riskPctMean"])} / {pct(v["riskPctMax"])}</td>'
                f'<td>{v["gateBound"]} of {v["entries"]} / {v["rollGateBound"]} of {v["rolls"]}</td>'
                f'<td>{v["resizes"]}</td><td>{pct(v["costsPctCapital"], 1)}</td>'
                f'<td>{num(rb["sharpe"])} ({ci(rb.get("sharpeDiffCi"))})</td>'
                f'<td>{num(rx["sharpe"])} ({ci(rx.get("sharpeDiffCi"))})</td></tr>')
    return f'<div class="wrap"><table>{head}{"".join(rows)}</table></div>'


def implied_table(strategies, universe) -> str:
    head = "<tr><th>Strategy</th>" + "".join(f"<th>{u}</th>" for u in universe) + \
        "<th>All entries: mean</th><th>CV</th><th>CV, IV = 252d RV</th><th>CV, IV = Cboe index</th></tr>"
    rows = []
    for s in strategies:
        cur = next(v for v in s["variants"] if v["id"] == "current")
        by = cur["impliedTauBySymbol"]
        rows.append(f'<tr><td>{s["id"]}</td>' + "".join(
            f"<td>{pct(by.get(u), 2)}</td>" for u in universe) +
            f'<td>{pct(cur["impliedTauMean"], 2)}</td><td>{num(cur["impliedTauCv"], 2)}</td>'
            f'<td>{num(cur["robustRv252"]["impliedTauCv"], 2)}</td>'
            f'<td>{num(cur["robustIvIndex"]["impliedTauCv"], 2)}</td></tr>')
    return f'<div class="wrap"><table>{head}{"".join(rows)}</table></div>'


def main(src: str, dest: str) -> int:
    r = json.loads(Path(src).read_text())
    strategies = r["strategies"]
    by = {s["id"]: {v["id"]: v for v in s["variants"]} for s in strategies}

    def d_sharpe(sid, key):
        v = by[sid][key]
        c = v["sharpeDiffCi"]
        return f"{sid} {v['sharpe'] - by[sid]['current']['sharpe']:+.2f} (90% CI {c['p05']:+.2f} to {c['p95']:+.2f})"

    def bound(sid):
        v = by[sid]["vt-16"]
        return f"{sid} {v['gateBound'] / v['entries']:.0%}"

    vt16_bound = ", ".join(bound(sid) for sid in by)
    matched = "; ".join(d_sharpe(sid, "vt-matched") for sid in by)
    buffered = "; ".join(d_sharpe(sid, "vt-buffer") for sid in by)
    brake = "; ".join(d_sharpe(sid, "brake") for sid in by)
    currents = [next(v for v in s["variants"] if v["id"] == "current") for s in strategies]
    tau_mean = sum(c["impliedTauMean"] for c in currents) / len(currents)
    tau_cv = max(c["impliedTauCv"] for c in currents)
    tau_cv_ix = max(c["robustIvIndex"]["impliedTauCv"] for c in currents)
    tau_cv_rv = max(c["robustRv252"]["impliedTauCv"] for c in currents)
    cov = r["ivxCoverage"]
    off_zero = [f"{sid} {key}" for sid in by for key in ("vt-matched", "vt-buffer", "brake")
                if by[sid][key]["sharpeDiffCi"]["p05"] > 0 or by[sid][key]["sharpeDiffCi"]["p95"] < 0]
    zero_text = ("Every one of these 9 intervals includes zero." if not off_zero else
                 f"{9 - len(off_zero)} of these 9 intervals include zero; the exception{'s' if len(off_zero) > 1 else ''}: "
                 f"{', '.join(off_zero)} (with 9 comparisons at 90%, about one is expected to exclude "
                 f"zero by chance).")
    worse = [k for k in off_zero if by[k.split()[0]][k.split()[1]]["sharpeDiffCi"]["p95"] < 0]
    better = [k for k in off_zero if k not in worse]
    sig_text = (f"{len(worse)} significantly worse" if worse else "") + \
        (" and " if worse and better else "") + (f"{len(better)} significantly better" if better else "")
    sig_text = f" ({sig_text})" if sig_text else ""
    o01_o12_same = by["O01"]["current"]["entries"] == by["O12"]["current"]["entries"]
    covered = ", ".join(f"{k} {v:.0%}" for k, v in cov.items())
    universe = r["universe"]
    twins = ", ".join(f"{u} ({r['futureOf'][u]})" for u in universe)
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vertex research: vol-target position sizing (Carver method)</title>
<style>body{{background:#0f1115;color:#e7e7e7;font:15px/1.55 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:1180px}}
h1{{font-size:21px}}h2{{font-size:16px;margin-top:28px;color:#f1f1f1}}a{{color:#4fb3ff}}
.wrap{{overflow-x:auto}}table{{border-collapse:collapse;width:100%;font-size:12.5px}}
th,td{{border-bottom:1px solid #2a2e36;padding:5px 7px;text-align:left;vertical-align:top;white-space:nowrap}}
th{{color:#c9a54a}}code,.f{{font-family:ui-monospace,monospace;font-size:13px}}
.f{{background:#151821;border:1px solid #2a2e36;border-radius:6px;padding:10px 12px;display:block;overflow-x:auto;white-space:pre}}
.box{{background:#151821;border-left:3px solid #c9a54a;padding:10px 14px;border-radius:4px}}
.note{{color:#9aa0aa;font-size:13px}}.legend span{{margin-right:14px;font-size:13px}}
li{{margin:3px 0}}</style></head><body>
<h1>Vol-target position sizing (Carver / pysystemtrade method) for Vertex</h1>
<p class="note">Research note, 2026-11-06. Card <code>vertex-volsizing-research</code>.
Research and analytics only: nothing here authorizes, creates or routes a trade, nothing was
deployed, and no trade path was changed. No pysystemtrade (GPL-3.0) code was copied; the method
below is described in our own words from Carver's books and the pysystemtrade docs. Data: public
Yahoo daily bars (derived statistics only), dummy $1,000,000 account.</p>

<div class="box"><b>Recommendation: not worth building vol-target sizing as a hot-swap tool.</b>
Vertex's current rule (fixed % of NLV max loss on a fixed-delta debit spread) already sizes close
to vol parity: the debit of a 0.60/0.30-delta spread grows with implied vol, so a fixed loss budget
buys fewer contracts when vol is high. Each signal entry's fixed-risk size implies a vol target of
about {pct(tau_mean, 1)}; its coefficient of variation across entries and instruments is at most
{num(tau_cv, 2)} with the main vol proxy and {num(tau_cv_ix, 2)} when the spreads are priced off the
public Cboe implied-vol indices (it widens to {num(tau_cv_rv, 2)} only when prices use a stale
252-day realized vol). At equal realized risk, vol targeting changed Sharpe by: {matched}. Carver's
weekly buffered resize: {buffered}. A shrink-only vol brake: {brake}. {zero_text} Carver's default 16% vol target is far above the
owner gate: the 2% max-loss cap bound on {vt16_bound} of signal entries. If anything from this
method is worth taking, it is the portfolio layer (correlation-aware total risk, the IDM idea),
not per-trade sizing.</div>

<h2>1. Carver's method (own words)</h2>
<ul>
<li><b>Instrument risk.</b> Annualized standard deviation of daily percentage returns from an
exponentially weighted estimate (span about 35 trading days), blended 70/30 with its own long-run
(10-year) average so one quiet or wild month does not swing the size.</li>
<li><b>Volatility target τ.</b> The account's target annual standard deviation as a fraction of
capital (pysystemtrade default 16%; Carver suggests at most about half the Kelly-optimal level and
far less for retail accounts).</li>
<li><b>Forecasts.</b> Every rule outputs a forecast scaled so its long-run average absolute value is
10, capped at ±20; combined forecasts are multiplied by a forecast diversification multiplier.
A binary long-only rule is a forecast of 10 when long, 0 when flat.</li>
<li><b>Instrument weights and IDM.</b> Capital is split across instruments by weights wᵢ (equal here);
the instrument diversification multiplier IDM = 1 / √(wᵀHw), with H the correlation matrix of
instrument returns (negative correlations set to zero, weekly returns), capped at 2.5, scales the
whole book up because diversified positions do not all lose together.</li>
<li><b>Position.</b> Contracts = (capital × τ × wᵢ × IDM × forecast / 10) / (cash vol of one contract),
where the cash vol of one contract is price × multiplier × instrument vol.</li>
<li><b>Buffering (position inertia).</b> Trade only when the held position leaves a band of ±10% of
the target, and then only to the edge of the band, to keep costs down.</li>
</ul>
<span class="f">N_i = round( C · τ · w_i · IDM · (f_i / 10) / (P_i · M · σ_i) ),   |f_i| ≤ 20
σ_i = 0.7 · EWMA₃₅(σ) + 0.3 · mean₁₀ᵧ(EWMA₃₅(σ))        IDM = min(2.5, 1 / √(wᵀ H⁺ w))</span>

<h2>2. Mapping to Vertex rules</h2>
<ul>
<li><b>Options only, defined risk, no new shares.</b> The position is a call debit spread with the
Vertex proposal shape (<code>packages/api/src/pick-list-proposal.ts</code>): about 120 DTE, long the
~0.60-delta call, short the ~0.30-delta call. Its max loss is the debit plus charges.</li>
<li><b>Exposure unit.</b> One spread carries Δ = Δ<sub>long</sub> − Δ<sub>short</sub> ≈ 0.30 of the
underlying, so its cash vol is Δ × S × 100 × σ. Vol-target contracts use that in the denominator.</li>
<li><b>2% max-loss gate.</b> Vol targeting may only shrink a position relative to the gate, never
exceed it: <code>contracts = min(vol-target contracts, floor(2% NLV / max loss per contract))</code>.
Buffered adds are also capped by the gate.</li>
<li><b>Shrink-only variant.</b> The "vol brake" keeps the current size and multiplies it by
min(1, long-run vol / fast vol): it can cut a position in a vol spike and never grows one.</li>
<li><b>Research only.</b> Sizing output would feed proposals and backtests; it never authorizes a
trade.</li>
</ul>
<span class="f">current:     n = min( floor(0.50% · NLV / L),  floor(2% · NLV / L) )      L = (debit + charges) · 100
vol target:  n = min( round(NLV · τ · (1/7) · IDM · (f/10) / (Δ_spread · S · 100 · σ_i)),  floor(2% · NLV / L) )
vol brake:   n = floor( current · min(1, σ_slow / σ_fast) )</span>
<p>Why the current rule is already vol-parity: with strikes set by delta, the debit is roughly
proportional to S · σ<sub>IV</sub> · √T, and the spread delta is fixed, so contracts at a fixed loss
budget scale as 1/(S · σ) — the same as Carver's denominator. The only differences are which vol is
used (implied vs. a blended realized estimate) and the portfolio-level scale (τ, IDM).</p>
{implied_table(strategies, universe)}
<p class="note">Vol target implied by each entry of the current rule (current contracts ÷ vol-target
contracts per unit τ). Near-equal values across instruments = vol parity.</p>

<h2>3. Backtest (Nautilus, rig)</h2>
<ul>
<li><b>Engine of record:</b> <code>{html.escape(r["engine"])}</code> via
<code>services/research/nautilus_backtest.run_spec</code>, on the rig (not QuantVPS). Nautilus produces each
strategy's entry and exit bars and fills on the underlying; the options overlay prices and sizes
the spreads.</li>
<li><b>Universe:</b> Core 7 ETF twins {html.escape(twins)} — the futures are research signals only and
the live expression is options on the ETF twin. Window {r["window"][0]} to {r["window"][1]}, one
account per strategy across all 7.</li>
<li><b>Strategies (library):</b> {"; ".join(html.escape(s["id"] + " " + s["name"] + ": " + s["definition"]["description"].rstrip(".")) for s in strategies)}</li>
<li><b>Options model:</b> Black-Scholes, r = 4%, no dividends; implied vol proxy 1.1 × EWMA(20)
realized vol (floor 8%); roll to a new 120 DTE spread at 30 DTE; close when the signal exits.
Costs: IBKR Pro $0.65/contract/leg ($1 minimum), OCC+CAT $0.0253/contract/leg, half spread
max($0.01, 0.5% of leg premium) per leg each way. Two robustness runs re-price every spread: with
the proposal model's 252-day realized vol, and with the public Cboe implied-vol index of each twin
(VIX, VXN, VXD, GVZ, OVX; Yahoo has no RVX or VXSLV history, so IWM and SLV keep the proxy;
coverage of the window: {covered}).</li>
<li><b>Timing:</b> signal entries and exits fill at the Nautilus fill price (bar open, or the
stop/target level) and are priced and sized with the previous session's vol and account value;
rolls, buffered resizes and marks use the session close.</li>
<li><b>Vol target inputs:</b> equal weights 1/7, IDM {num(r["idm"], 2)} from weekly correlations of
the 7 twins (in-sample; τ × IDM is what matters, and the risk-matched rows solve τ, so only the 16%
row is inflated by it), forecast 10 when long. The robustness runs reuse the τ solved under the
main pricing, so their Sharpe compares like for like but their CAGR and drawdown do not. "Risk-matched" τ is solved so the strategy's
realized portfolio vol equals the current rule's, so CAGR and drawdown compare like for like.
The buffered resize sizes each held spread at its entry delta (one spread = the exposure it was
bought as), checked every 5 sessions.</li>
</ul>
{chart(strategies)}
<p class="note">Account value / starting capital, month ends, log scale.</p>
{results_table(strategies)}
<p class="note">Max loss/trade = contracts × (debit + charges) ÷ NLV at a signal entry. Gate bound =
signal entries / rolls where the 2% gate cut the size. ΔSharpe CI: paired moving-block bootstrap
(21-session blocks, 1,000 draws) of the daily returns against the current rule. Costs are cumulative option charges over the window as a
share of starting capital. Contracts are for the dummy $1M account (SLV and USO carry the largest
counts because of their low prices).</p>

<h2>4. Risks and limits</h2>
<ul>
<li>No historical option chains: implied vol is a realized-vol proxy with no skew, term structure
or event premia in the main run, and fills are modeled, not quoted. The Cboe-index run checks the
main claim with real implied-vol levels (no skew); it held.</li>
<li>The finding depends on fixed-delta strikes. A fixed-width or fixed-moneyness spread would not
be vol-parity by construction, and then vol targeting would matter.</li>
<li>Binary library signals carry no forecast strength, so Carver's forecast scaling (the part of
the method that sizes by conviction) had nothing to work with here.</li>
<li>IDM and correlations are in-sample; one IDM for the whole window. Equal weights only.</li>
{'<li>O01 and O12 enter on the same SMA 20/50 up-cross (O12 adds a 6%/3% bracket), so the three strategies are two independent entry sets, not three.</li>' if o01_o12_same else ''}
<li>Low absolute returns (0.5% NLV per position on 7 instruments) mean costs and integer contracts
weigh heavily; results for small accounts would differ (fewer contracts, more skipped trades).</li>
<li>Survivorship: Core 7 is a fixed modern list; USO's contango history is included as is.</li>
<li>Any live use would still go through the 2% gate and the owner's order rules; this note changes
neither.</li>
</ul>

<h2>5. Recommendation and effort</h2>
<ul>
<li><b>Vol-target sizing as a hot-swap tool: not worth it now.</b> It reproduces what the current
rule already does for fixed-delta debit spreads; the measured Sharpe differences are within noise
{sig_text}, and buffered resizing adds hundreds of extra combo orders for no
clear gain. Estimated effort if built anyway: 4–6 days (TS sizing policy in
proposals and the backtest overlay, vol estimators, IDM estimation, buffered resize state, UI
switch, docs, Nautilus parity tests).</li>
<li><b>Cheaper option, only if wanted:</b> the shrink-only vol brake as a pure function in the
proposal sizer, about 1 day with tests and a UI note. Evidence is mixed (better on RSI reversion,
slightly worse on the trend rules), so it is not recommended by default.</li>
<li><b>Where Carver's ideas fit better:</b> a portfolio-level risk view — the 7 equity-heavy positions
at 0.5% each are partly one bet (IDM {num(r["idm"], 2)}, not 2.65). A correlation-aware total max-loss
budget is a separate research card.</li>
</ul>
<p class="note">Reproduce: <code>&lt;nautilus-venv&gt;/bin/python research/backtests/volsizing/volsizing.py
--data ~/Documents/reports/vertex-core7/data --out research/backtests/volsizing/results.json</code>, then
<code>python3 research/backtests/volsizing/render_note.py research/backtests/volsizing/results.json
~/Documents/reports/web/vertex-volsizing/index.html</code>. Tests:
<code>python -m pytest research/backtests/volsizing/test_volsizing.py</code>.</p>
</body></html>
"""
    out = Path(dest).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
