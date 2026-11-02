"""Independent spot check of real-data trigger dates for the alert-template backtests.

Recomputes each checked trigger from the raw CSV with separate, plain code (not the strategy
module) and draws one chart per check (close, 50/200-day averages, prior 52-week high, trigger
marker). Research only; reads local files and writes local files.

Run (rig):
  uv run --no-project --python 3.12 --with matplotlib==3.10.7 python \
      research/backtests/freestockalerts/spot_check.py --data <data dir> \
      --results research/backtests/freestockalerts/results.json --charts <chart dir> \
      --out research/backtests/freestockalerts/spot-checks.json
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

CHECKS = {  # strategy -> (result path inside results.json, check kind)
    "quality-breakout-radar": (("quality-breakout-radar",), "year-high"),
    "under-the-radar-breakouts": (("under-the-radar-breakouts",), "year-high"),
    "quality-compounders-on-pullback": (("quality-compounders-on-pullback",), "cross-50"),
    "leader-pullback-and-reclaim": (("leader-pullback-and-reclaim",), "cross-50"),
    "200-day-comeback-watchlist": (("200-day-comeback-watchlist",), "cross-200"),
    "dividend-growth-buy-zones": (("dividend-growth-buy-zones",), "dividend"),
    "sector-leadership-radar": (("sector-leadership-radar", "all"), "cross-50"),
    "earnings-calendar-alerts": (("earnings-calendar-alerts", "large-moves-all"), "move"),
}
MOVE = {"AAPL": 0.05, "NVDA": 0.07, "TSLA": 0.07, "SPY": 0.02}
# Market stress: one latest event from each of three alert types; (results key, CSV symbol, check kind).
STRESS_CHECKS = (("^VIX vix-above-25", "^VIX", "vix-25"), ("SPY move-down", "SPY", "move"),
                 ("SPY crosses-above-200-day", "SPY", "cross-200"))


def rows(data: Path, symbol: str) -> list[dict]:
    return [{"date": r["date"], **{k: float(r[k]) for k in ("open", "high", "low", "close", "volume")}}
            for r in csv.DictReader((data / f"{symbol}.csv").open())]


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs)


def check(kind: str, bars: list[dict], t: int, symbol: str, level: float | None) -> dict:
    c = [b["close"] for b in bars]
    h = [b["high"] for b in bars]
    lo = [b["low"] for b in bars]
    info: dict = {"close": c[t], "high": h[t], "low": lo[t], "prev_close": c[t - 1]}
    if kind == "year-high":
        level = max(h[t - 252:t])
        info.update(level=level, ok=h[t] > level)
    elif kind in ("cross-50", "cross-200"):
        n = 50 if kind == "cross-50" else 200
        level = mean(c[t - n:t])  # the average as of the previous close
        info.update(level=round(level, 4), ok=c[t - 1] < level < h[t])
    elif kind == "move":
        up, down = h[t] / c[t - 1] - 1, lo[t] / c[t - 1] - 1
        info.update(up=round(up, 4), down=round(down, 4), ok=max(up, -down) >= MOVE[symbol])
    elif kind == "vix-25":
        info.update(level=25.0, ok=h[t] > 25.0)
    else:  # dividend price-level alert: the low reaches forward dividend / buy-zone yield
        info.update(level=level, ok=level is not None and lo[t] <= level)
    return info


def chart(path: Path, bars: list[dict], t: int, title: str, level: float | None) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    lo, hi = max(t - 260, 0), min(t + 40, len(bars))
    c = [b["close"] for b in bars]
    xs = list(range(lo, hi))
    fig, ax = plt.subplots(figsize=(8, 3.2), dpi=90)
    ax.plot(xs, c[lo:hi], color="black", lw=1, label="close")
    for n, color in ((50, "tab:blue"), (200, "tab:orange")):
        ma = [mean(c[i - n + 1:i + 1]) if i >= n - 1 else None for i in xs]
        ax.plot(xs, ma, color=color, lw=1, label=f"{n}-day")
    ax.axvline(t, color="tab:red", lw=1, ls="--")
    if level is not None:
        ax.axhline(level, color="tab:green", lw=0.8, ls=":", label="trigger level")
    ax.set_title(title, fontsize=9)
    ax.legend(fontsize=7, loc="upper left")
    ax.set_xticks([lo, t, hi - 1], [bars[lo]["date"], bars[t]["date"], bars[hi - 1]["date"]], fontsize=7)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--results", required=True)
    p.add_argument("--charts", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    data, charts = Path(a.data).expanduser(), Path(a.charts).expanduser()
    charts.mkdir(parents=True, exist_ok=True)
    results = json.loads(Path(a.results).read_text())
    out: dict = {}
    for slug, (keys, kind) in CHECKS.items():
        node = results
        for k in keys:
            node = node[k]
        picks = node["sample"][-3:]  # the three most recent events
        checked = []
        for ev in picks:
            bars = rows(data, ev["symbol"])
            t = next(i for i, b in enumerate(bars) if b["date"] == ev["day"])
            ev_kind = "cross-200" if ev["kind"] == "reclaims-200-day" else kind
            info = check(ev_kind, bars, t, ev["symbol"], ev.get("level"))
            name = f"{slug}_{ev['symbol']}_{ev['day']}.png"
            chart(charts / name, bars, t, f"{slug}: {ev['symbol']} {ev['day']} {ev['kind']}", info.get("level"))
            checked.append({"symbol": ev["symbol"], "day": ev["day"], "kind": ev["kind"], "chart": name, **info})
        out[slug] = checked
    stress = []
    for key, symbol, kind in STRESS_CHECKS:
        ev = results["market-stress-alerts"][key]["sample"][-1]
        bars = rows(data, symbol)
        t = next(i for i, b in enumerate(bars) if b["date"] == ev["day"])
        info = check(kind, bars, t, symbol, None)
        name = f"market-stress-alerts_{symbol.strip('^')}_{ev['day']}.png"
        chart(charts / name, bars, t, f"market-stress-alerts: {symbol} {ev['day']} {ev['kind']}", info.get("level"))
        stress.append({"symbol": symbol, "day": ev["day"], "kind": ev["kind"], "chart": name, **info})
    out["market-stress-alerts"] = stress
    Path(a.out).write_text(json.dumps(out, indent=1))
    for slug, items in out.items():
        print(slug, [(i["symbol"], i["day"], i["ok"]) for i in items])


if __name__ == "__main__":
    main()
