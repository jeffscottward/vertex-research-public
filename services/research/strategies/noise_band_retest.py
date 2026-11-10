"""Noise-band re-test (card vertex-noise-band-retest): fresh SPY data and other ETFs, same frozen rules.

Research only: reads local files, writes local files, places no orders. Spec:
docs/specs/strategies/noise-band-intraday-momentum.md, section "Re-test 2026-11" (pass/fail set before the runs).

Inputs
  --ib DIR        output of noise_band_ib_fetch.py: DIR/<SYMBOL>/<YYYY-MM>.csv with epoch_utc,open,high,low,close,volume
                  (5-minute TRADES bars, regular trading hours, bar start time).
  --daily DIR     DIR/<SYMBOL>.json: daily bars with dividend events in the Yahoo chart API layout (see
                  fetch_daily()). Source: IBKR first, Yahoo fills gaps: with VERTEX_HISTORY_URL and
                  VERTEX_DEPLOY_STATUS_TOKEN set, the bars are IBKR TRADES daily bars (unadjusted for
                  dividends) and Yahoo's fill the dates before IBKR's first date; dividend events are
                  Yahoo's (IBKR history has no dividend feed). Without IBKR the Yahoo response is saved verbatim.
  --kaggle FILE   the 2008-2021 SPY 1-minute CSV used by the first test (ibkr-mt format), aggregated here to 5 minutes.

Usage
  python -m strategies.noise_band_retest --ib bars --daily daily --kaggle spy_1min.csv --out retest.json SPY QQQ IWM DIA
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import time
import urllib.request
from dataclasses import asdict, replace
from datetime import date, datetime, timezone
from typing import Sequence
from zoneinfo import ZoneInfo

import ibkr_history as ih

from strategies.noise_band import (
    BacktestResult,
    Bar,
    DayResult,
    Params,
    Session,
    metrics,
    run_backtest,
)
from strategies.noise_band_run import NO_COSTS, PAPER_COSTS, TASK_COSTS, load_sessions

ET = ZoneInfo("America/New_York")
FIVE_FULL_LAST = 385  # 15:55 bar start
FIVE_HALF_LASTS = {205, 220}  # 12:55 bar start (13:00 close); 13:10 bar start (13:15 close, 2008 ETF half-days)
FRESH_START = date(2021, 5, 7)  # first session after the first test's data
PRIMARY5 = Params(bar_minutes=5, **TASK_COSTS)


# ---------------------------------------------------------------- loading


def load_ib_sessions(directory: str, dividends: dict[date, float] | None = None) -> tuple[list[Session], dict]:
    """5-minute sessions from the month files; overlapping months are deduplicated by bar time."""
    dividends = dividends or {}
    by_day: dict[date, dict[int, Bar]] = {}
    rows = 0
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".csv"):
            continue
        with open(os.path.join(directory, name), newline="") as f:
            for r in csv.reader(f):
                rows += 1
                ts = datetime.fromtimestamp(int(r[0]), tz=timezone.utc).astimezone(ET)
                minute = ts.hour * 60 + ts.minute - (9 * 60 + 30)
                if minute < 0 or minute > FIVE_FULL_LAST or minute % 5:
                    continue
                by_day.setdefault(ts.date(), {})[minute] = Bar(minute, float(r[1]), float(r[2]), float(r[3]),
                                                               float(r[4]), float(r[5]))
    return _complete_sessions(by_day, dividends, rows)


def _complete_sessions(by_day: dict[date, dict[int, Bar]], dividends: dict[date, float], rows: int) -> tuple[list[Session], dict]:
    """Keep a day when it has the 09:30 bar and a regular last bar (15:55, or 12:55 on a 13:00 half-day).
    Missing interior bars (halts, no prints) are forward-filled with the previous close and zero volume, so
    a day is never dropped for what happened inside it (that would tie the sample to outcomes)."""
    sessions: list[Session] = []
    dropped: list[str] = []
    filled: dict[str, int] = {}
    for d in sorted(by_day):
        bars = by_day[d]
        last = max(bars)
        if 0 not in bars or not (last == FIVE_FULL_LAST or last in FIVE_HALF_LASTS):
            dropped.append(f"{d.isoformat()} ({len(bars)} bars, last minute {last})")
            continue
        seq: list[Bar] = []
        for m in range(0, last + 1, 5):
            b = bars.get(m)
            if b is None:
                c = seq[-1].close
                b = Bar(m, c, c, c, c, 0.0)
                filled[d.isoformat()] = filled.get(d.isoformat(), 0) + 1
            seq.append(b)
        sessions.append(Session(d, tuple(seq), dividends.get(d, 0.0)))
    return sessions, {
        "rows_read": rows,
        "sessions_used": len(sessions),
        "half_day_sessions": [s.day.isoformat() for s in sessions if len(s.bars) != FIVE_FULL_LAST // 5 + 1],
        "sessions_dropped_incomplete": dropped,
        "forward_filled_bars": sum(filled.values()),
        "sessions_with_filled_bars": sorted(filled),
        "first_session": sessions[0].day.isoformat() if sessions else None,
        "last_session": sessions[-1].day.isoformat() if sessions else None,
        "dividends_applied": sum(1 for s in sessions if s.dividend),
    }


def to_five_minute(sessions: Sequence[Session]) -> list[Session]:
    """Aggregate 1-minute sessions to 5-minute bars (bucket = minute // 5 * 5). Half-days that end at a
    non-5-minute boundary keep their last partial bucket, as an exchange 5-minute bar would."""
    out = []
    for s in sessions:
        buckets: dict[int, list[Bar]] = {}
        for b in s.bars:
            buckets.setdefault(b.minute // 5 * 5, []).append(b)
        bars = tuple(Bar(m, g[0].open, max(x.high for x in g), min(x.low for x in g), g[-1].close, sum(x.volume for x in g))
                     for m, g in sorted(buckets.items()))
        out.append(Session(s.day, bars, s.dividend))
    return out


DAILY_START = "2007-12-01"  # period1=1196467200


def fetch_yahoo_daily(symbol: str) -> bytes:
    """Yahoo chart API daily bars (unadjusted OHLC) with dividend events, verbatim."""
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1=1196467200"
           f"&period2={int(time.time())}&interval=1d&events=div")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    json.loads(data)
    return data


def merge_daily(yahoo: bytes, symbol: str, client: ih.Client | None = None) -> bytes:
    """IBKR first, Yahoo fills gaps, in the Yahoo chart layout load_daily() reads: the quote arrays hold the
    merged bars (IBKR dates stamped 14:30 UTC, the same New York date in summer and winter), events keep
    Yahoo's dividends, and `vertex_sources` records the merge. Without IBKR rows the Yahoo bytes are returned
    unchanged."""
    doc = json.loads(yahoo)
    res = doc["chart"]["result"][0]
    quote = res["indicators"]["quote"][0]
    stamps = {}
    rows = []
    for i, ts in enumerate(res["timestamp"]):
        day = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(ET).date().isoformat()
        stamps[day] = ts
        rows.append({"date": day, **{key: quote.get(key, [None] * len(res["timestamp"]))[i]
                                     for key in ("open", "high", "low", "close", "volume")}})
    merged = ih.merged_daily(symbol, lambda: rows, start=DAILY_START, client=client)
    if "ibkr" not in merged.sources:
        return yahoo
    out = merged.rows
    res["timestamp"] = [stamps[row["date"]] if row["source"] == "yahoo"
                        else int(datetime.fromisoformat(row["date"]).replace(hour=14, minute=30,
                                                                              tzinfo=timezone.utc).timestamp())
                        for row in out]
    res["indicators"] = {"quote": [{key: [row[key] for row in out]
                                    for key in ("open", "high", "low", "close", "volume")}]}
    doc["vertex_sources"] = merged.summary()
    return json.dumps(doc).encode()


def fetch_daily(symbol: str, path: str, client: ih.Client | None = None) -> None:
    """Daily bars with dividend events, saved in the Yahoo chart layout: IBKR first, Yahoo fills gaps.
    The Yahoo download always runs (dividend events)."""
    data = merge_daily(fetch_yahoo_daily(symbol), symbol, client)
    with open(path, "wb") as f:
        f.write(data)


def load_daily(path: str) -> tuple[dict[date, float], dict[date, float]]:
    """(close by session date, cash dividend by ex-date) from a saved Yahoo chart response."""
    res = json.load(open(path))["chart"]["result"][0]
    closes = {}
    for ts, c in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]):
        if c is not None:
            closes[datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(ET).date()] = float(c)
    divs = {datetime.fromtimestamp(int(v["date"]), tz=timezone.utc).astimezone(ET).date(): float(v["amount"])
            for v in res.get("events", {}).get("dividends", {}).values()}
    return closes, divs


def calendar_check(sessions: Sequence[Session], closes: dict[date, float]) -> dict:
    """Sessions missing against the Yahoo daily calendar inside the bar range, and last-close agreement."""
    if not sessions:
        return {}
    have = {s.day for s in sessions}
    lo, hi = sessions[0].day, sessions[-1].day
    missing = sorted(d for d in closes if lo <= d <= hi and d not in have)
    diffs = sorted(abs(s.bars[-1].close / closes[s.day] - 1.0) for s in sessions if s.day in closes)
    return {
        "yahoo_sessions_in_range": sum(1 for d in closes if lo <= d <= hi),
        "missing_sessions": [d.isoformat() for d in missing],
        "last_close_vs_yahoo_median_abs": round(diffs[len(diffs) // 2], 6) if diffs else None,
        "last_close_vs_yahoo_over_0.5pct": sum(1 for x in diffs if x > 0.005),
    }


# ---------------------------------------------------------------- evaluation


def window(res: BacktestResult, start: date | None = None, end: date | None = None) -> tuple[list[DayResult], list]:
    days = [d for d in res.days if (start is None or d.day >= start) and (end is None or d.day <= end)]
    keep = {d.day for d in days}
    return days, [t for t in res.trades if t.day in keep]


def evaluate(res: BacktestResult, start: date | None = None, end: date | None = None,
             min_trades: int = 300, min_sharpe: float = 0.5) -> dict:
    """Pre-set rule on a date window: >= min_trades round trips and Sharpe > min_sharpe in both equal-count halves."""
    days, trades = window(res, start, end)
    if not days:
        return {"verdict": "inconclusive", "reason": "no sessions"}
    mid = len(days) // 2
    first, second = days[:mid], days[mid:]
    sub = BacktestResult(res.params, days, trades)
    m_full, m1, m2 = metrics(sub), metrics(sub, first), metrics(sub, second)
    if len(trades) < min_trades:
        v = "inconclusive"
    else:
        v = "pass" if m1.sharpe > min_sharpe and m2.sharpe > min_sharpe else "fail"
    r6 = lambda m: {k: (round(x, 6) if isinstance(x, float) else x) for k, x in asdict(m).items()}  # noqa: E731
    return {
        "verdict": v,
        "from": days[0].day.isoformat(), "to": days[-1].day.isoformat(),
        "full": r6(m_full),
        "first_half": {"from": first[0].day.isoformat(), "to": first[-1].day.isoformat(), **r6(m1)} if first else None,
        "second_half": {"from": second[0].day.isoformat(), "to": second[-1].day.isoformat(), **r6(m2)},
    }


def buy_hold(sessions: Sequence[Session], start: date | None = None) -> dict:
    rets = []
    for i in range(1, len(sessions)):
        if start is None or sessions[i].day >= start:
            rets.append((sessions[i].bars[-1].close + sessions[i].dividend) / sessions[i - 1].bars[-1].close - 1.0)
    from strategies.noise_band import metrics_from_returns
    m = metrics_from_returns(rets)
    return {k: (round(x, 6) if isinstance(x, float) else x) for k, x in asdict(m).items()}


def run_symbol(sessions: list[Session], fresh_start: date = FRESH_START) -> dict:
    """Primary (verdict), paper-cost and no-cost runs; full window and the fresh window."""
    out: dict = {}
    for name, costs in (("primary", TASK_COSTS), ("paper_costs", PAPER_COSTS), ("no_costs", NO_COSTS)):
        res = run_backtest(sessions, replace(PRIMARY5, **costs))
        out[name] = {"full": evaluate(res), "fresh": evaluate(res, fresh_start)}
        if name == "primary":
            out["daily_equity"] = [(d.day.isoformat(), round(d.aum_end, 2)) for d in res.days]
    out["buy_and_hold"] = {"full": buy_hold(sessions[15:]), "fresh": buy_hold(sessions, fresh_start)}
    return out


def splice(early: Sequence[Session], late: Sequence[Session]) -> list[Session]:
    """early sessions before the first late session, then all late sessions."""
    if not late:
        return list(early)
    cut = late[0].day
    return [s for s in early if s.day < cut] + list(late)


# ---------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="+")
    ap.add_argument("--ib", required=True)
    ap.add_argument("--daily", required=True)
    ap.add_argument("--kaggle")
    ap.add_argument("--kaggle-dividends")
    ap.add_argument("--fetch-daily", action="store_true")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    os.makedirs(a.daily, exist_ok=True)
    report: dict = {"rules": "frozen rules 1-13, primary = band+VWAP stop, vol target, 0.0035/sh + 1 bp/side, 5-min bars",
                    "fresh_start": FRESH_START.isoformat(), "symbols": {}}
    kaggle5: list[Session] = []
    if a.kaggle:
        from strategies.noise_band_run import load_dividends
        k1, kinfo = load_sessions(a.kaggle, "ibkr-mt", load_dividends(a.kaggle_dividends))
        kaggle5 = to_five_minute(k1)
        r1 = run_backtest(k1, Params(**TASK_COSTS))
        r5 = run_backtest(kaggle5, replace(PRIMARY5))
        report["validation_1min_vs_5min"] = {"kaggle_info": {k: v for k, v in kinfo.items() if k != "sessions_dropped_incomplete"},
                                             "one_minute": evaluate(r1), "five_minute": evaluate(r5)}
    for sym in a.symbols:
        dpath = os.path.join(a.daily, sym + ".json")
        if a.fetch_daily or not os.path.exists(dpath):
            fetch_daily(sym, dpath)
        closes, divs = load_daily(dpath)
        sessions, info = load_ib_sessions(os.path.join(a.ib, sym), divs)
        entry: dict = {"data": info, "calendar": calendar_check(sessions, closes)}
        if sym == "SPY" and kaggle5:
            k_div = [replace(s, dividend=divs.get(s.day, s.dividend)) for s in kaggle5]
            overlap = [s.day for s in sessions if s.day <= kaggle5[-1].day]
            kd = {s.day: s for s in kaggle5}
            diffs = sorted(abs(s.bars[-1].close / kd[s.day].bars[-1].close - 1.0) for s in sessions if s.day in kd)
            entry["overlap_with_kaggle"] = {"sessions": len(overlap),
                                            "last_close_median_abs_diff": round(diffs[len(diffs) // 2], 6) if diffs else None}
            full = splice(k_div, sessions)
            entry["spliced_full"] = {"first": full[0].day.isoformat(), "last": full[-1].day.isoformat(), "sessions": len(full)}
            entry["results"] = run_symbol(full)
        else:
            entry["results"] = run_symbol(sessions)
        report["symbols"][sym] = entry
    for sym, entry in report["symbols"].items():  # pre-registered verdict window: SPY fresh, other ETFs full
        graded = "fresh" if sym == "SPY" else "full"
        for name, runs in entry["results"].items():
            if name in ("primary", "paper_costs", "no_costs"):
                for w, e in runs.items():
                    e["graded"] = name == "primary" and w == graded
    tests = [s for s in report["symbols"] if s != "SPY"]
    for sym in tests:  # variant 3 verdict = full window; label a pass as one test among several (pre-registered)
        e = report["symbols"][sym]["results"]["primary"]["full"]
        if e["verdict"] == "pass":
            e["label"] = f"PASS (single test among {len(tests)}; needs a forward check)"
    with open(a.out, "w") as f:
        json.dump(report, f, indent=1)
    return report


if __name__ == "__main__":
    r = main()
    brief = {s: {k: v["results"]["primary"][k]["verdict"] + ("" if v["results"]["primary"][k]["graded"] else " (rule only, no verdict)")
                 for k in ("full", "fresh")} for s, v in r["symbols"].items()}
    print(json.dumps(brief))
