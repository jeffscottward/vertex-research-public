"""Session open momentum study (card vertex-session-open-momentum): the Chuk (2026, SSRN 7609644) NQ build.

Research only: reads local files, writes one JSON file, places no orders. Spec and the pass/fail rule set
before the first run: docs/specs/strategies/session-open-momentum-nq.md.

Inputs
  --qqq FILE    IBKR 5-minute TRADES bars, gzip CSV `timestamp,open,high,low,close,volume` (UTC ms, bar start).
  --ndx FILE    Yahoo chart API daily JSON for ^NDX; --qqq-daily FILE the same for QQQ with dividend events.
  --nq FILE...  optional NQ contract files `date,open,high,low,close,volume` (`YYYYMMDD  HH:MM:SS` UTC bar
                start) for the cross-check.

Usage
  python -m strategies.noise_band_futures_run --qqq QQQ.csv.gz --ndx ndx.json --qqq-daily qqq.json \
      [--nq NQ_202412.csv ...] --out results.json
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import random
import statistics
from collections import defaultdict
from dataclasses import asdict, replace
from datetime import date, datetime, timezone
from typing import Iterable, Sequence
from zoneinfo import ZoneInfo

from strategies.noise_band import Bar, FuturesDay, FuturesParams, FuturesResult, Session, run_futures_backtest

ET = ZoneInfo("America/New_York")
FULL_LAST = 385  # 15:55 bar start, minutes after 09:30
HALF_LASTS = (205, 220)  # 12:55 (13:00 close, ETF half-days) and 13:10 (13:15 close, CME equity index)
WINDOWS = {
    "replication": (date(2020, 1, 2), date(2026, 7, 2)),  # the paper's sample ends 07-03, a holiday
    "before": (date(2005, 1, 3), date(2019, 12, 31)),
    "after": (date(2026, 7, 6), date(2026, 11, 6)),
}
GRADED = ("replication", "before")
PAPER = {"usd_per_day": 10.26, "ci": [3.27, 17.25], "sharpe": 1.14, "trades_per_session": 1.35,
         "share_traded": 0.60, "max_drawdown": 2458.0, "years": {"2020": 49.0, "2025": 835.0}}
VARIANTS = {
    "primary": FuturesParams(),
    "stop_plus_1pt": FuturesParams(stop_slip_points=1.0),
    "entries_every_bar": FuturesParams(check_every=5),
    "close_based_exit": FuturesParams(stop_fill="next_open"),
    # Diagnostic added after the graded run (not pre-registered): the same rules without any cost.
    "frictionless": FuturesParams(commission_rt=0.0, entry_slip_ticks=0.0, stop_slip_ticks=0.0),
}
RESAMPLES = 10_000
SEED = 7


# --- loading -------------------------------------------------------------------------------------------

def _sessions(rows: Iterable[tuple[datetime, float, float, float, float, float]]) -> tuple[list[Session], dict]:
    """Regular-hours 5-minute sessions from (UTC bar start, o, h, l, c, v) rows. A session is kept only
    with a 09:30 bar, a last bar at 15:55 (or a half-day close) and no missing bar between. The session
    after a skipped one is kept as a reference that is never traded: its own previous close would be two
    days old, but it supplies the previous close and the sigma history of the session after it."""
    by_day: dict[date, dict[int, Bar]] = defaultdict(dict)
    for t, o, h, lo, c, v in rows:
        local = t.astimezone(ET)
        minute = local.hour * 60 + local.minute - 570
        if 0 <= minute <= FULL_LAST and minute % 5 == 0:
            by_day[local.date()][minute] = Bar(minute, o, h, lo, c, v)
    sessions: list[Session] = []
    skipped: list[str] = []
    after_skip: list[str] = []
    gap = False
    for day in sorted(by_day):
        bars = by_day[day]
        last = max(bars)
        if 0 not in bars or (last != FULL_LAST and last not in HALF_LASTS) or len(bars) != last // 5 + 1:
            skipped.append(day.isoformat())
            gap = True
            continue
        sessions.append(Session(day, tuple(bars[m] for m in sorted(bars)), tradable=not gap))
        if gap:
            after_skip.append(day.isoformat())
            gap = False
    return sessions, {"sessions": len(sessions), "skipped": len(skipped), "skipped_days": skipped[:50],
                      "skipped_after": after_skip[:50]}


def load_qqq(path: str) -> tuple[list[Session], dict]:
    def rows():
        with gzip.open(path, "rt") as f:
            for r in csv.DictReader(f):
                t = datetime.fromtimestamp(int(float(r["timestamp"])) / 1000, timezone.utc)
                yield t, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), float(r["volume"])
    return _sessions(rows())


def load_yahoo(path: str) -> tuple[dict[date, float], dict[date, float]]:
    """Daily closes and cash dividends (by ex-date) from a Yahoo chart API JSON."""
    res = json.load(open(path))["chart"]["result"][0]
    closes = {}
    for ts, c in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]):
        if c is not None:
            closes[datetime.fromtimestamp(ts, timezone.utc).astimezone(ET).date()] = float(c)
    divs = {datetime.fromtimestamp(int(d["date"]), timezone.utc).astimezone(ET).date(): float(d["amount"])
            for d in (res.get("events", {}).get("dividends") or {}).values()}
    return closes, divs


def qqq_scales(sessions: Sequence[Session], ndx: dict[date, float], qqq: dict[date, float]) -> list[float]:
    """k = NDX / QQQ close of the latest date before each session that both series have (no lookahead)."""
    both = sorted(d for d in ndx if d in qqq)
    out: list[float] = []
    j = 0
    k = float("nan")
    for s in sessions:
        while j < len(both) and both[j] < s.day:
            k = ndx[both[j]] / qqq[both[j]]
            j += 1
        out.append(k)
    return out


def load_nq(paths: Sequence[str]) -> tuple[list[list[Session]], list[list[float]], dict]:
    """Front-month NQ by the highest volume in the prior session, ratio back-adjusted at each roll so that
    bands and the previous close stay on one price path. Returns segments split at gaps over 5 days, and
    per-session scales k = 1 / adjustment so that P&L stays in real index points."""
    contracts: dict[str, dict[date, Session]] = {}
    for path in paths:
        name = path.rsplit("/", 1)[-1].split(".")[0]

        def rows(p=path):
            with open(p) as f:
                for r in csv.DictReader(f):
                    t = datetime.strptime(" ".join(r["date"].split()), "%Y%m%d %H:%M:%S").replace(tzinfo=timezone.utc)
                    yield t, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), float(r["volume"])
        contracts[name] = {s.day: s for s in _sessions(rows())[0]}
    days = sorted({d for c in contracts.values() for d in c})
    chosen: list[tuple[date, str]] = []
    for i, day in enumerate(days[1:], 1):
        prev = days[i - 1]
        live = [n for n, c in contracts.items() if day in c and prev in c]
        if live:
            chosen.append((day, max(live, key=lambda n: sum(b.volume for b in contracts[n][prev].bars))))
    # Back-adjust: walk backwards; at a roll from `old` to `new` on day d, scale earlier prices by
    # close_new(prev day) / close_old(prev day).
    factor = 1.0
    adjusted: list[tuple[Session, float]] = []
    for idx in range(len(chosen) - 1, -1, -1):
        day, name = chosen[idx]
        s = contracts[name][day]
        adjusted.append((Session(day, tuple(Bar(b.minute, b.open * factor, b.high * factor, b.low * factor,
                                                   b.close * factor, b.volume) for b in s.bars),
                                 tradable=s.tradable), 1.0 / factor))
        prev_day = chosen[idx - 1][0] if idx > 0 else None
        # If the new contract has no bars on the old one's last day (a data gap), keep the factor: the gap
        # splits the segments below, and k = 1 / factor keeps P&L in real points either way.
        if prev_day is not None and chosen[idx - 1][1] != name and prev_day in contracts[name]:
            old = contracts[chosen[idx - 1][1]][prev_day].bars[-1].close
            new = contracts[name][prev_day].bars[-1].close
            factor *= new / old
    adjusted.reverse()
    segments: list[list[Session]] = [[]]
    scales: list[list[float]] = [[]]
    for s, k in adjusted:
        if segments[-1] and (s.day - segments[-1][-1].day).days > 5:
            segments.append([])
            scales.append([])
        segments[-1].append(s)
        scales[-1].append(k)
    rolls = sum(1 for a, b in zip(chosen, chosen[1:]) if a[1] != b[1])
    return segments, scales, {"sessions": len(adjusted), "rolls": rolls, "segments": [
        [seg[0].day.isoformat(), seg[-1].day.isoformat(), len(seg)] for seg in segments]}


# --- statistics ----------------------------------------------------------------------------------------

def bootstrap_ci(values: Sequence[float], resamples: int = RESAMPLES, seed: int = SEED) -> tuple[float, float]:
    """Day-block bootstrap 95% interval of the mean (sessions resampled with replacement)."""
    rng = random.Random(seed)
    n = len(values)
    means = sorted(sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(resamples))
    return means[int(0.025 * resamples)], means[int(0.975 * resamples) - 1]


def max_drawdown_usd(pnl: Sequence[float]) -> float:
    peak = equity = mdd = 0.0
    for x in pnl:
        equity += x
        peak = max(peak, equity)
        mdd = max(mdd, peak - equity)
    return mdd


def summarize(res: FuturesResult, start: date, end: date, ci: bool = True) -> dict:
    days: list[FuturesDay] = [d for d in res.days if start <= d.day <= end]
    trades = [t for t in res.trades if start <= t.day <= end]
    pnl = [d.pnl for d in days]
    n = len(pnl)
    if n < 2:
        return {"sessions": n}
    mean = sum(pnl) / n
    sd = statistics.stdev(pnl)
    traded = sum(1 for d in days if d.trades)
    years: dict[str, list[float]] = defaultdict(list)
    for d in days:
        years[str(d.day.year)].append(d.pnl)
    out = {
        "first": days[0].day.isoformat(), "last": days[-1].day.isoformat(), "sessions": n,
        "usd_per_day": mean, "total": sum(pnl), "sharpe": mean / sd * math.sqrt(252) if sd else 0.0,
        "share_traded": traded / n, "trades": len(trades), "trades_per_session": len(trades) / n,
        "trades_per_traded_session": len(trades) / traded if traded else 0.0,
        "trade_hit": sum(1 for t in trades if t.usd > 0) / len(trades) if trades else 0.0,
        "stop_exits": sum(1 for t in trades if t.exit_reason == "stop") / len(trades) if trades else 0.0,
        "long_share": sum(1 for t in trades if t.side == 1) / len(trades) if trades else 0.0,
        "max_drawdown": max_drawdown_usd(pnl),
        "years": {y: {"total": sum(v), "usd_per_day": sum(v) / len(v), "sessions": len(v)} for y, v in sorted(years.items())},
    }
    if ci:
        lo, hi = bootstrap_ci(pnl)
        out["ci"] = [lo, hi]
    return out


def grade(window: str, s: dict) -> str:
    lo = s["ci"][0]
    if window == "replication":
        return "REPLICATES" if lo > 0 else ("WEAK" if s["usd_per_day"] > 0 else "DOES NOT REPLICATE")
    return "HOLDS" if lo > 0 else "DOES NOT HOLD"


def cross_check(qqq: FuturesResult, nq: list[FuturesResult]) -> dict:
    by_day = {d.day: d.pnl for d in qqq.days}
    pairs = [(d.pnl, by_day[d.day]) for r in nq for d in r.days if d.day in by_day]
    if len(pairs) < 3:
        return {"sessions": len(pairs)}
    a, b = [p[0] for p in pairs], [p[1] for p in pairs]
    nq_days = {d.day for r in nq for d in r.days}
    return {"sessions": len(pairs), "nq_usd_per_day": sum(a) / len(a), "qqq_usd_per_day": sum(b) / len(b),
            "correlation": statistics.correlation(a, b),
            "nq_trades": sum(1 for r in nq for t in r.trades if t.day in by_day),
            "qqq_trades": sum(1 for t in qqq.trades if t.day in nq_days)}


# --- main ----------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> dict:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--qqq", required=True)
    ap.add_argument("--ndx", required=True)
    ap.add_argument("--qqq-daily", required=True)
    ap.add_argument("--nq", nargs="*", default=[])
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)

    sessions, data = load_qqq(a.qqq)
    ndx, _ = load_yahoo(a.ndx)
    qqq_closes, divs = load_yahoo(a.qqq_daily)
    sessions = [replace(s, dividend=divs.get(s.day, 0.0)) for s in sessions]
    scales = qqq_scales(sessions, ndx, qqq_closes)
    keep = [i for i, k in enumerate(scales) if not math.isnan(k)]
    sessions = [sessions[i] for i in keep]
    scales = [scales[i] for i in keep]
    data.update(first=sessions[0].day.isoformat(), last=sessions[-1].day.isoformat(),
                scale_min=min(scales), scale_max=max(scales), dividends=sum(1 for s in sessions if s.dividend))

    out: dict = {"spec": "docs/specs/strategies/session-open-momentum-nq.md", "paper": PAPER, "data": data,
                 "params": {name: asdict(p) for name, p in VARIANTS.items()}, "variants": {}, "verdicts": {}}
    results: dict[str, FuturesResult] = {}
    for name, params in VARIANTS.items():
        res = run_futures_backtest(sessions, scales, params)
        results[name] = res
        out["variants"][name] = {w: summarize(res, *WINDOWS[w], ci=(name == "primary" or w in GRADED))
                                 for w in WINDOWS}
    primary = out["variants"]["primary"]
    for w in GRADED:
        out["verdicts"][w] = grade(w, primary[w])
    out["verdicts"]["overall"] = ("HOLDS UP" if out["verdicts"]["replication"] == "REPLICATES"
                                  and out["verdicts"]["before"] == "HOLDS" else "DOES NOT HOLD UP")
    out["daily"] = [[d.day.isoformat(), round(d.pnl, 2), d.trades] for d in results["primary"].days]

    if a.nq:
        segments, nq_scales, nq_data = load_nq(a.nq)
        nq_results = [run_futures_backtest(seg, sc) for seg, sc in zip(segments, nq_scales) if len(seg) > 15]
        out["nq"] = {"data": nq_data, "cross_check": cross_check(results["primary"], nq_results)}

    with open(a.out, "w") as f:
        json.dump(out, f, indent=1)
    return out


if __name__ == "__main__":
    o = main()
    for name, v in o["variants"].items():
        for w, s in v.items():
            if "usd_per_day" in s:
                print(f"{name:18} {w:12} n={s['sessions']:5} $/day={s['usd_per_day']:7.2f} "
                      f"sharpe={s['sharpe']:5.2f} ci={s.get('ci')}")
    print(o["verdicts"], o.get("nq", {}).get("cross_check"))
