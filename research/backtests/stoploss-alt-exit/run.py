"""Dry-run study of alternative exit rules (card stoploss-alt-exit-dryrun; research only, no live change).

Evaluates alternatives to the three live exit rules studied in PR #489 (`stoploss-stopping-premium-backtests`):
  * Family A: No share stop / wider ATR stops / close-confirmed ladder vs live 5-rung 1x ATR ladder
              (on BOTH survivorship-free PIT S&P 500 and current-constituent S&P 500 for bias delta).
  * Family B: Cheaper LEAPS exit ladder variants (close-confirmed, wider ATR, 3-rung, 2-rung, single deep
              stop, grace-period, premium stops) vs live 5-rung intraday ladder
              (on BOTH real historical option quotes SPY/QQQ/IWM 2008-2025 AND model-priced PIT stocks).
  * Family C: Hold losing options to 15:45 expiry-day close (T-0, plus 2x expiry spread stress), T-1 close,
              deep-loser-only T-3, and salvage-filtered T-3 vs live T-3 loser close
              (on BOTH real historical option quotes SPY/QQQ/IWM 2008-2025 AND model-priced PIT stocks).

Outputs (written ONLY to `--out`, which must be outside the repository):
  * `results.json`: full structured results, PIT coverage, real-quote spread diagnostics, recovery stats, git SHA.
  * Dark-mode charts: `summary-vs-live.png`, `leaps-frontier.png`, `share-pit-vs-current.png`, `expiry-recovery.png`.
  * `index.html`: dark mobile-friendly HTML report with head-to-head vs-live tables.

Usage:
    uv run --no-project --python 3.12 --with pydantic==2.13.4 --with duckdb --with matplotlib==3.10.7 python \\
        research/backtests/stoploss-alt-exit/run.py \\
        --data /tmp/stoploss-alt-data \\
        --out /tmp/stoploss-alt-out
"""
from __future__ import annotations

import argparse
from datetime import UTC, date, datetime
import hashlib
import html
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))

from strategies.stoploss_premium import (  # noqa: E402
    alternatives,
    bars,
    entries,
    pit,
    real_quotes,
    report,
    study,
)

WATCHED = (
    "services/research/strategies/stoploss_premium",
    "services/research/strategies/qc_ports",
    "services/research/indicators",
    "research/backtests/stoploss-alt-exit",
)
REAL_OPTION_SYMBOLS = ("SPY", "QQQ", "IWM")
REAL_OPTION_START = "2008-01-02"


def log(text: str) -> None:
    print(f"{datetime.now(UTC):%H:%M:%SZ} {text}", file=sys.stderr, flush=True)


def git_state() -> dict:
    def git(*args: str) -> str:
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=False).stdout.strip()
    return {"commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain", "--", *WATCHED))}


def load_bars_resilient(bars_dir: Path) -> tuple[study.Data, list[str]]:
    """Load daily bars like `study.load()`, skipping non-SPY tickers with calendar gaps (e.g. trading halts)."""
    raw_names: dict[str, bars.Series] = {}
    for p in sorted(bars_dir.glob("*.csv")):
        sym = p.stem
        if sym in study.INDEX_FILES or sym == "SHILLER" or "=" in sym or p.name.endswith(".splits.csv"):
            continue
        s = bars.load_bars(p, sym)
        if len(s.dates) > study.WARMUP:
            raw_names[sym] = s
    if "SPY" not in raw_names:
        raise FileNotFoundError(f"SPY.csv is required in {bars_dir}")
    indexes = {i: bars.load_index(bars_dir / f"{i}.csv")
               for i in study.INDEX_FILES if (bars_dir / f"{i}.csv").exists()}
    calendar = list(raw_names["SPY"].dates)
    aligned: dict[str, bars.Series] = {}
    skipped: list[str] = []
    for sym, s in raw_names.items():
        try:
            aligned[sym] = study.on_calendar(s, calendar)
        except ValueError:
            if sym == "SPY":
                raise
            skipped.append(sym)
    data = study.Data(calendar, bars.daily_rf(indexes.get("IRX", {}), calendar), aligned, indexes)
    return data, sorted(skipped)


def build_real_option_sets(
    data: study.Data,
    options_dir: Path,
    *,
    symbols: tuple[str, ...] = REAL_OPTION_SYMBOLS,
) -> dict[str, list[alternatives.AltEntryTrade]]:
    """Build real-quote LEAPS, 45d calls, and 45d debit spreads for SPY/QQQ/IWM from Parquet archives."""
    out: dict[str, list[alternatives.AltEntryTrade]] = {
        "leaps": [],
        "call45": [],
        "spread45": [],
        "leaps_expiry": [],
    }
    for sym in symbols:
        sym_dir = options_dir / sym.lower()
        if not sym_dir.exists() or sym not in data.names:
            continue
        s = data.names[sym]
        lo = next((i for i, d in enumerate(s.dates) if d >= REAL_OPTION_START and i >= study.WARMUP), None)
        if lo is None:
            continue
        # Generate proxy entries across full series, load quote book, then derive exact book end date dynamically.
        sigs_all = entries.signals(s, lo=lo, hi=len(s.dates))
        entry_dates = [s.dates[e.i] for e in sigs_all]
        log(f"loading real option quotes for {sym}: {len(sigs_all)} candidate entry dates")
        book = real_quotes.load_quotes_parquet_dir(sym_dir, sym, entry_dates=entry_dates, right="call")
        log(f"  {sym} quote book: {book.stats}, last_date={book.last_date}")
        if not book.last_date:
            continue
        last_opt_date = date.fromisoformat(book.last_date)
        u = real_quotes.RealUnderlying(s)
        rf = data.name_rf(s)

        for e in sigs_all:
            d_e = date.fromisoformat(s.dates[e.i])
            if d_e > last_opt_date:
                continue
            k = data.first_k(s, e.i + 1)
            if k is None:
                continue
            tr_l = real_quotes.make_real_leaps(u, book, e.i, last_chance=2)
            if tr_l is not None:
                out["leaps"].append(alternatives.AltEntryTrade(e, tr_l, k, rf))
            tr_le = real_quotes.make_real_leaps(u, book, e.i, last_chance=0)
            if tr_le is not None:
                out["leaps_expiry"].append(alternatives.AltEntryTrade(e, tr_le, k, rf))
            tr_c = real_quotes.make_real_call45(u, book, e.i)
            if tr_c is not None:
                out["call45"].append(alternatives.AltEntryTrade(e, tr_c, k, rf))
            tr_s = real_quotes.make_real_spread45(u, book, e.i)
            if tr_s is not None:
                out["spread45"].append(alternatives.AltEntryTrade(e, tr_s, k, rf))
    log(
        f"real-quote trades built: leaps={len(out['leaps'])}, call45={len(out['call45'])}, "
        f"spread45={len(out['spread45'])}, leaps_expiry={len(out['leaps_expiry'])}"
    )
    return out


def build_model_pit_sets(
    data: study.Data,
    pit_membership: pit.PitMembership | None,
    *,
    start: str = "2005-01-03",
    max_stocks: int | None = None,
) -> tuple[dict[str, list[alternatives.AltEntryTrade]], dict[str, int]]:
    """Build model-priced stock option trades (PIT-filtered when PIT membership is present) plus dropped counts."""
    stock_names = {sym: data.names[sym] for sym in data.stocks()}
    if max_stocks is not None and len(stock_names) > max_stocks:
        # Deterministic evenly spaced subsample when requested for fast diagnostics
        keys = sorted(stock_names)
        step = max(1, len(keys) // max_stocks)
        stock_names = {k: stock_names[k] for k in keys[::step][:max_stocks]}

    if pit_membership is not None:
        ent = pit.pit_entries(stock_names, data.calendar, pit_membership, start, 400, warmup=study.WARMUP)
    else:
        ent = study.entry_list(data, start, 400, sorted(stock_names))
    log(f"model stock entries: {sum(len(v) for v in ent.values())} across {len(ent)} stocks")

    dropped: dict[str, int] = {}
    total_entries = sum(len(v) for v in ent.values())

    def wrap(name: str, maker) -> list[alternatives.AltEntryTrade]:
        ets = study.build_trades(data, ent, maker)
        dropped[name] = max(0, total_entries - len(ets))
        return [alternatives.AltEntryTrade(x.entry, x.trade, x.k, x.rf) for x in ets]

    sets = {
        "leaps": wrap("leaps", study.make_leaps),
        "call45": wrap("call45", study.make_call45),
        "spread45": wrap("spread45", study.make_spread45),
    }
    return sets, dropped

# --- Dark-mode charts --------------------------------------------------------------------------------

BG = "#0b0f17"
PANEL = "#111827"
GRID = "#263042"
TEXT = "#e5e7eb"
MUTED = "#94a3b8"
GREEN = "#22c55e"
BLUE = "#3b82f6"
RED = "#ef4444"
AMBER = "#f59e0b"
GOLD = "#eab308"
PURPLE = "#a855f7"


def _style_ax(ax) -> None:
    ax.set_facecolor(PANEL)
    ax.tick_params(colors=MUTED, labelsize=8.5)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    ax.grid(True, color=GRID, linestyle="--", alpha=0.45)


def make_charts(results: dict, out: Path) -> dict[str, str]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    charts: dict[str, str] = {}
    tests = results["tests"]

    # 1. Summary before-vs-after chart (headline vs-live gains across all 3 families)
    rows: list[tuple[str, float, float, float, str]] = []
    picks = [
        ("A-alt-pit", "A0:", "A: No share stop\n(PIT S&P 500, real)"),
        ("A-alt-pit", "A4:", "A: Close 5-rung 2xATR\n(PIT S&P 500, real)"),
        ("A-alt-pit", "A6:", "A: Trailing 4xATR\n(PIT S&P 500, real)"),
        ("B-alt-real", "B0:", "B: No LEAPS ladder\n(Real SPY/QQQ/IWM)"),
        ("B-alt-real", "B2:", "B: Close 5-rung 1xATR\n(Real SPY/QQQ/IWM)"),
        ("B-alt-real", "B4:", "B: Wider close ladder\n(Real SPY/QQQ/IWM)"),
        ("B-alt-real", "B7:", "B: Single deep stop\n(Real SPY/QQQ/IWM)"),
        ("B-alt-real", "B10:", "B: 50% prem stop\n(Real SPY/QQQ/IWM)"),
        ("C-alt-real", f"{study.CALL45} — C0:", "C: Hold 45d call T-0\n(Real SPY/QQQ/IWM)"),
        ("C-alt-real", f"{study.SPREAD45} — C0:", "C: Hold 45d spread T-0\n(Real SPY/QQQ/IWM)"),
        ("C-alt-real", f"{study.CALL45} — C3:", "C: Deep-loser >=50%\n(Real SPY/QQQ/IWM)"),
    ]
    for tid, prefix, label in picks:
        t = tests.get(tid)
        if not t:
            continue
        for v in t.get("variants", []):
            if v["name"].startswith(prefix) and "vsLive" in v:
                vl = v["vsLive"]
                rows.append((label, vl["premiumVsLive"] * 100, vl["intervalVsLive"][0] * 100,
                             vl["intervalVsLive"][1] * 100,
                             GREEN if vl["beatsLive90"] else (BLUE if vl["premiumVsLive"] > 0 else RED)))
                break

    if rows:
        fig, ax = plt.subplots(figsize=(10.5, max(4.8, 0.55 * len(rows) + 1.4)), facecolor=BG)
        _style_ax(ax)
        y = list(range(len(rows)))[::-1]
        for yi, (lbl, dmu, lo, hi, col) in zip(y, rows):
            ax.barh(yi, dmu, color=col, alpha=0.85, height=0.62)
            ax.plot([lo, hi], [yi, yi], color=TEXT, linewidth=1.6)
            ax.plot([lo, hi], [yi, yi], "|", color=TEXT, markersize=8)
            off = 0.25 if dmu >= 0 else -0.25
            ha = "left" if dmu >= 0 else "right"
            ax.text(max(hi, dmu) + off if dmu >= 0 else min(lo, dmu) + off, yi,
                    f"{dmu:+.2f}%/yr", va="center", ha=ha, color=TEXT, fontsize=8.5, fontweight="bold")
        ax.axvline(0, color=GOLD, linewidth=1.2, linestyle="-")
        ax.set_yticks(y)
        ax.set_yticklabels([r[0] for r in rows], color=TEXT, fontsize=8.5)
        ax.set_xlabel("Annualized return vs live rule (Δμ vs live, %/yr, with 90% block-bootstrap CI)", color=TEXT)
        ax.set_title("Alternative Exit Rules vs Live Rules (Dry-Run Study — Real Bars & Real Option Quotes)",
                     color=TEXT, fontsize=11.5, fontweight="bold", pad=12)
        fig.tight_layout()
        fig.savefig(out / "summary-vs-live.png", dpi=150, facecolor=BG)
        plt.close(fig)
        charts["summary"] = "summary-vs-live.png"

    # 2. LEAPS insurance-cost frontier (Real quotes vs Model PIT)
    b_real = tests.get("B-alt-real")
    if b_real and b_real.get("variants"):
        fig, ax = plt.subplots(figsize=(9.5, 5.4), facecolor=BG)
        _style_ax(ax)
        for v in b_real["variants"]:
            s = v["summary"]
            dmu = s["premium"] * 100
            mdd_cut = v["drawdownCut"] * 100
            code = v["name"].split(":")[0]
            col = GOLD if v.get("isLive") else (GREEN if dmu >= 0 else (BLUE if mdd_cut >= 10 else MUTED))
            size = 140 if v.get("isLive") else 80
            marker = "*" if v.get("isLive") else "o"
            ax.scatter(mdd_cut, dmu, s=size, color=col, marker=marker, zorder=5, edgecolors=TEXT, linewidths=0.7)
            ax.annotate(code, (mdd_cut, dmu), textcoords="offset points", xytext=(6, 4),
                        color=TEXT, fontsize=8.5, fontweight="bold" if v.get("isLive") else "normal")
        ax.axhline(0, color=GRID, linewidth=1.0)
        ax.axvline(10, color=AMBER, linewidth=1.0, linestyle=":", label="10% MDD-cut threshold (paid insurance)")
        ax.set_xlabel("Relative maximum drawdown removed vs T-2 Hold (%)", color=TEXT)
        ax.set_ylabel("Stopping premium Δμ vs T-2 Hold (%/yr, higher = cheaper)", color=TEXT)
        ax.set_title("LEAPS Ladder Frontier on Real Option Quotes (SPY/QQQ/IWM 2008-2025): Higher & Right = Better",
                     color=TEXT, fontsize=11, fontweight="bold", pad=10)
        ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=TEXT, fontsize=8.5)
        fig.tight_layout()
        fig.savefig(out / "leaps-frontier.png", dpi=150, facecolor=BG)
        plt.close(fig)
        charts["leaps_frontier"] = "leaps-frontier.png"

    # 3. Share stop: PIT survivorship-free vs current-constituent comparison
    a_pit = tests.get("A-alt-pit")
    a_cur = tests.get("A-alt-current")
    if a_pit and a_pit.get("variants"):
        fig, ax = plt.subplots(figsize=(10.0, 5.2), facecolor=BG)
        _style_ax(ax)
        cur_map = {v["name"].split(":")[0]: v["summary"]["premium"] * 100
                   for v in (a_cur.get("variants", []) if a_cur else [])}
        labels, pit_vals, cur_vals = [], [], []
        for v in a_pit["variants"]:
            code = v["name"].split(":")[0]
            if code == "A0":
                continue
            labels.append(v["name"].replace(" (reference)", ""))
            pit_vals.append(v["summary"]["premium"] * 100)
            cur_vals.append(cur_map.get(code, 0.0))
        idx = list(range(len(labels)))[::-1]
        h = 0.36
        ax.barh([i + h / 2 for i in idx], pit_vals, height=h, color=BLUE, label="PIT survivorship-free S&P 500")
        if cur_map:
            ax.barh([i - h / 2 for i in idx], cur_vals, height=h, color=AMBER, alpha=0.8,
                    label="Current constituents (survivorship-biased)")
        ax.axvline(0, color=TEXT, linewidth=1.0)
        ax.set_yticks(idx)
        ax.set_yticklabels(labels, color=TEXT, fontsize=8.2)
        ax.set_xlabel("Stopping premium Δμ vs buy-and-hold (%/yr, after costs)", color=TEXT)
        ax.set_title("Share Stop Alternatives: Survivorship-Free PIT S&P 500 vs Current Constituents",
                     color=TEXT, fontsize=11, fontweight="bold", pad=10)
        ax.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=TEXT, fontsize=8.5)
        fig.tight_layout()
        fig.savefig(out / "share-pit-vs-current.png", dpi=150, facecolor=BG)
        plt.close(fig)
        charts["share_pit"] = "share-pit-vs-current.png"

    # 4. Pre-expiry loss close & recovery chart (real option quotes)
    c_real = tests.get("C-alt-real")
    if c_real and c_real.get("variants"):
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11.5, 4.8), facecolor=BG)
        _style_ax(ax1)
        _style_ax(ax2)
        # Left: Δμ vs Live T-3 across variants for 45d call & 45d spread
        c_rows = []
        for v in c_real["variants"]:
            if f"{study.CALL45} —" in v["name"] and not v.get("isLive"):
                short = v["name"].split("— ", 1)[1].split(" (")[0]
                c_rows.append((short, v["vsLive"]["premiumVsLive"] * 100))
        if c_rows:
            yy = list(range(len(c_rows)))[::-1]
            cols = [GREEN if x > 0 else RED for _, x in c_rows]
            ax1.barh(yy, [x for _, x in c_rows], color=cols, height=0.58)
            ax1.axvline(0, color=GOLD, linewidth=1.1)
            ax1.set_yticks(yy)
            ax1.set_yticklabels([lbl for lbl, _ in c_rows], color=TEXT, fontsize=8.2)
            ax1.set_xlabel("Δμ vs Live T-3 close (%/yr)", color=TEXT)
            ax1.set_title("45-Day Call (Real Quotes): Gain vs Live T-3", color=TEXT, fontsize=10, fontweight="bold")

        # Right: T-3 loser recovery rates by structure
        rec = c_real.get("recoveryStats", {})
        if rec:
            s_names = list(rec.keys())
            above_bid = [rec[k]["finishedAboveEarlyBidShare"] * 100 for k in s_names]
            to_prof = [rec[k]["recoveredToProfitShare"] * 100 for k in s_names]
            x = list(range(len(s_names)))
            w = 0.35
            ax2.bar([i - w / 2 for i in x], above_bid, width=w, color=BLUE, label="T-0 payout > T-3 bid")
            ax2.bar([i + w / 2 for i in x], to_prof, width=w, color=GREEN, label="Recovered to full profit")
            ax2.set_xticks(x)
            ax2.set_xticklabels([n.replace("📅 ", "").replace(" (delta 0.75)", "").replace(" (0.50 / 0.30 delta)", "").replace(" (delta 0.50)", "")
                                 for n in s_names], color=TEXT, fontsize=8.2, rotation=10)
            ax2.set_ylabel("% of T-3 losing trades", color=TEXT)
            ax2.set_title("Real Quotes: T-3 Losers Held to 15:45 Expiry Close", color=TEXT, fontsize=10, fontweight="bold")
            ax2.legend(facecolor=PANEL, edgecolor=GRID, labelcolor=TEXT, fontsize=8.2)
        fig.tight_layout()
        fig.savefig(out / "expiry-recovery.png", dpi=150, facecolor=BG)
        plt.close(fig)
        charts["expiry_recovery"] = "expiry-recovery.png"

    return charts


# --- Dark HTML Report --------------------------------------------------------------------------------

ALT_HEAD = (
    "<tr><th>Variant</th><th>Result (vs hold)</th><th>Δμ / yr vs hold</th><th>90% CI</th>"
    "<th>Δμ / yr vs live</th><th>90% CI vs live</th><th>Max DD (with / hold)</th>"
    "<th>MDD cut</th><th>Stop events</th><th>Insurance cost (pp / 1pp MDD)</th></tr>"
)


def _alt_row(v: dict) -> str:
    s = v["summary"]
    vl = v.get("vsLive") or {}
    cls = report.VERDICT_CLASS.get(v["verdict"], "inc")
    lo, hi = s["interval"]
    vlo, vhi = vl.get("intervalVsLive", (0.0, 0.0))
    cost = v.get("insuranceCost")
    star = "★ " if v.get("headline") else ""
    live_badge = " <span class='badge live'>LIVE</span>" if v.get("isLive") else ""
    beat_cls = " class='pos'" if vl.get("beatsLive90") else ""
    return (
        f"<tr><td>{star}{html.escape(v['name'])}{live_badge}<div class=note>{html.escape(v.get('note', ''))}</div></td>"
        f"<td><span class='badge {cls}'>{html.escape(v['verdict'])}</span></td>"
        f"<td>{report.pct(s['premium'])}</td>"
        f"<td>{report.pct(lo)} .. {report.pct(hi)}</td>"
        f"<td{beat_cls}>{report.pct(vl.get('premiumVsLive'))}</td>"
        f"<td>{report.pct(vlo)} .. {report.pct(vhi)}</td>"
        f"<td>{report.plain_pct(abs(s['mddWith']))} / {report.plain_pct(abs(s['mddWithout']))}</td>"
        f"<td>{report.pct(v.get('drawdownCut'))}</td>"
        f"<td>{s['stopEvents']:,}</td>"
        f"<td>{'–' if cost is None else f'{cost * 100:.2f} pp'}</td></tr>"
    )


def render_html(results: dict, charts: dict[str, str]) -> str:
    extra_css = (
        "body{background:#0b0f17;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1.25rem;}"
        "main{max-width:1280px;margin:0 auto;} h1,h2,h3{color:#f8fafc;}"
        ".meta{color:#94a3b8;font-size:.9rem;margin-bottom:1rem;}"
        ".card{background:#111827;border:1px solid #263042;border-radius:10px;padding:1rem;margin:1rem 0;}"
        ".wrap{overflow-x:auto;} table{width:100%;border-collapse:collapse;font-size:.86rem;}"
        "th,td{border-bottom:1px solid #1f2937;padding:.45rem .55rem;text-align:left;vertical-align:top;}"
        "th{color:#94a3b8;font-weight:600;} .note{color:#94a3b8;font-size:.78rem;}"
        ".badge{display:inline-block;padding:.12rem .45rem;border-radius:999px;font-size:.75rem;font-weight:600;}"
        ".pass{background:#14532d;color:#86efac;} .ins{background:#1e3a8a;color:#93c5fd;}"
        ".fail{background:#7f1d1d;color:#fca5a5;} .nd{background:#374151;color:#d1d5db;}"
        ".inc{background:#78350f;color:#fde68a;} .live{background:#854d0e;color:#fef08a;margin-left:.3rem;}"
        ".pos{color:#4ade80;font-weight:700;} img{max-width:100%;border-radius:8px;border:1px solid #263042;margin:.6rem 0;}"
    )
    parts = [
        f"<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        f"<title>Alternative Exit Rules — Dry-Run Study</title><style>{extra_css}</style></head><body><main>",
        "<h1>Dry-Run Study of Alternative Exit Rules (No Live Change)</h1>",
        f"<div class=meta>Card: <code>stoploss-alt-exit-dryrun</code> · Generated {html.escape(results['generatedAt'])} · "
        f"Commit <code>{html.escape(results['code']['commit'][:10])}</code> · Research / dry-run only: all 3 live rules remain unchanged.</div>",
    ]
    for key in ("summary", "leaps_frontier", "share_pit", "expiry_recovery"):
        if key in charts:
            parts.append(f"<img src='{html.escape(charts[key])}' alt='{html.escape(key)}'>")
    for tid, t in results["tests"].items():
        rows = "".join(_alt_row(v) for v in t.get("variants", []))
        bias = f"<p class=note><b>Bias / caveat:</b> {html.escape(t['bias'])}</p>" if t.get("bias") else ""
        parts.append(
            f"<section class=card id='{html.escape(tid)}'><h2>{html.escape(tid)} — {html.escape(t['title'])}</h2>"
            f"<p class=note><b>Prices:</b> {html.escape(t['prices'])} · <b>Universe:</b> {html.escape(t['universe'])}</p>"
            f"{bias}<div class=wrap><table>{ALT_HEAD}{rows}</table></div></section>"
        )
    parts.append("</main></body></html>")
    return "".join(parts)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True, help="Data dir created by fetch_data.py (with bars/, sp500_pit.csv, real-options/)")
    ap.add_argument("--out", type=Path, required=True, help="Output report dir (must be outside the repo)")
    ap.add_argument("--pit-start", default="2005-01-03", help="Start date for PIT S&P 500 equity study")
    ap.add_argument("--max-model-stocks", type=int, default=120, help="Cap model-priced stocks for speed (0 = all)")
    ap.add_argument("--skip-model-options", action="store_true", help="Skip model-priced stock options (run real quotes + PIT shares only)")
    ap.add_argument("--allow-dirty", action="store_true", help="Allow uncommitted changes in watched files")
    args = ap.parse_args(argv)

    out = args.out.resolve()
    if out == ROOT or ROOT in out.parents:
        print("error: --out must be outside the repository", file=sys.stderr)
        return 2
    state = git_state()
    if state["dirty"] and not args.allow_dirty:
        print("error: watched code is dirty; commit or pass --allow-dirty", file=sys.stderr)
        return 2

    t0 = time.monotonic()
    bars_dir = args.data / "bars" if (args.data / "bars").is_dir() else args.data
    log(f"loading bars from {bars_dir}")
    data, skipped = load_bars_resilient(bars_dir)
    log(f"loaded {len(data.names)} symbols ({len(data.stocks())} stocks), skipped {len(skipped)} non-contiguous")

    pit_csv = args.data / "sp500_pit.csv"
    pit_mem = pit.load_pit_csv(pit_csv) if pit_csv.exists() else None
    options_dir = args.data / "real-options"

    tests: dict[str, dict] = {}

    # 1. Family A: Share stop alternatives (PIT survivorship-free + current-constituent comparison)
    if pit_mem is not None:
        log("running A-alt-pit (survivorship-free PIT S&P 500)")
        tests["A-alt-pit"] = alternatives.test_a_alternatives(
            data, pit_membership=pit_mem, start=args.pit_start, progress=log
        )
        tests["A-alt-pit"]["id"] = "A-alt-pit"
        # Current-constituent comparison on the latest PIT snapshot tickers (isolates survivorship bias!)
        latest_set = pit_mem.active_on(data.calendar[-1])
        cur_names = {k: v for k, v in data.names.items() if k in study.ETFS or pit.normalize_symbol(k) in latest_set}
        cur_data = study.Data(data.calendar, data.rf, cur_names, data.indexes)
        log("running A-alt-current (current constituents, survivorship-biased comparison)")
        tests["A-alt-current"] = alternatives.test_a_alternatives(
            cur_data, pit_membership=None, start=args.pit_start, progress=log
        )
        tests["A-alt-current"]["id"] = "A-alt-current"
    else:
        log("running A-alt (no PIT CSV provided)")
        tests["A-alt"] = alternatives.test_a_alternatives(data, start=args.pit_start, progress=log)

    # 2. Family B & C on REAL historical option quotes (SPY/QQQ/IWM 2008-2025)
    if options_dir.is_dir():
        real_sets = build_real_option_sets(data, options_dir)
        real_uni = "SPY (2008-2025), QQQ (2011-2025), IWM (2008-2025) — broad index ETFs (inherently survivorship-free)"
        real_bias = ("Real EOD bid/ask quotes from MIT mirror of philippdubach/options-dataset-hist; "
                     "close-confirmed rules use exact EOD real bid, intraday rungs use prior-day close and prior real bid/delta.")
        tests["B-alt-real"] = alternatives.test_b_alternatives(
            data, real_sets["leaps"], test_id="B-alt-real",
            title="Cheaper 📅 LEAPS ladder variants on REAL option quotes (SPY/QQQ/IWM)",
            prices_label="real", universe_label=real_uni, bias_note=real_bias, progress=log,
        )
        tests["C-alt-real"] = alternatives.test_c_alternatives(
            data,
            [
                (study.CALL45, real_sets["call45"]),
                (study.SPREAD45, real_sets["spread45"]),
                (study.LEAPS, real_sets["leaps_expiry"]),
            ],
            test_id="C-alt-real",
            title="Hold losing options to 15:45 expiry close on REAL option quotes (SPY/QQQ/IWM)",
            prices_label="real", universe_label=real_uni, bias_note=real_bias, progress=log,
        )

    # 3. Family B & C cross-check on Model-priced PIT stocks
    if not args.skip_model_options:
        cap = None if args.max_model_stocks <= 0 else args.max_model_stocks
        m_sets, dr = build_model_pit_sets(data, pit_mem, start=args.pit_start, max_stocks=cap)
        m_uni = f"PIT-filtered S&P 500 stocks (cap={cap or 'all'}) from {args.pit_start}"
        m_bias = (
            f"Black-Scholes model prices (3% stock half-spread); cross-check against PR #489 stock universe. "
            f"Entries whose ticker bars ended before option expiry (delisting/data-end) are dropped "
            f"(leaps={dr.get('leaps', 0)}, call45={dr.get('call45', 0)}, spread45={dr.get('spread45', 0)})."
        )
        tests["B-alt-model-pit"] = alternatives.test_b_alternatives(
            data, m_sets["leaps"], test_id="B-alt-model-pit",
            title="Cheaper 📅 LEAPS ladder variants on model-priced PIT stocks (PR #489 cross-check)",
            prices_label="model price", universe_label=m_uni, bias_note=m_bias, progress=log,
        )
        tests["C-alt-model-pit"] = alternatives.test_c_alternatives(
            data,
            [(study.CALL45, m_sets["call45"]), (study.SPREAD45, m_sets["spread45"])],
            test_id="C-alt-model-pit",
            title="Hold losing options to 15:45 expiry close on model-priced PIT stocks (PR #489 cross-check)",
            prices_label="model price", universe_label=m_uni, bias_note=m_bias, progress=log,
        )

    out.mkdir(parents=True, exist_ok=True)
    results = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "card": "stoploss-alt-exit-dryrun",
        "code": state,
        "dataDir": str(args.data),
        "dataEnd": data.calendar[-1],
        "skippedNonContiguous": skipped,
        "pitSha256": hashlib.sha256(pit_csv.read_bytes()).hexdigest() if pit_csv.exists() else None,
        "seconds": round(time.monotonic() - t0, 2),
        "tests": tests,
    }
    (out / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    charts = make_charts(results, out)
    (out / "index.html").write_text(render_html(results, charts), encoding="utf-8")
    log(f"done in {results['seconds']}s -> {out} ({len(tests)} test groups, {len(charts)} charts)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
