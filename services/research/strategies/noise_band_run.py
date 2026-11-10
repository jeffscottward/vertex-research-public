"""Run the frozen noise-band backtest on SPY 1-minute CSV data and write a JSON report.

Research only: reads local files, writes local files, places no orders.

Usage:
  python -m strategies.noise_band_run --bars spy_1min.csv --format ibkr-mt \
      --dividends dividends.csv --out results.json [--trades trades.csv]

Formats:
  ibkr-mt  columns date,open,high,low,close,volume,... with naive US Mountain time stamps (TWS export,
           bar start). Mountain time is US Eastern minus 2 hours all year, so ET = MT + 2 h.
  et       columns ts,open,high,low,close,volume with naive US Eastern bar-start time stamps.
Dividends CSV: date,dividend (ex-date, cash per share).
"""
from __future__ import annotations

import argparse
import csv
import json
from dataclasses import asdict
from datetime import date, datetime, timedelta

from strategies.noise_band import (
    BacktestResult,
    Bar,
    Params,
    Session,
    halves,
    metrics,
    metrics_from_returns,
    run_backtest,
    verdict,
)

FULL_DAY_LAST = 389
HALF_DAY_LASTS = {209, 224}  # 13:00 close (and 13:15 bars seen in 2008 data)


def load_sessions(path: str, fmt: str, dividends: dict[date, float]) -> tuple[list[Session], dict]:
    shift = timedelta(hours=2) if fmt == "ibkr-mt" else timedelta(0)
    ts_col = "date" if fmt == "ibkr-mt" else "ts"
    by_day: dict[date, dict[int, Bar]] = {}
    rows = 0
    dup = 0
    for r in csv.DictReader(open(path, newline="")):
        rows += 1
        ts = datetime.fromisoformat(r[ts_col]) + shift
        minute = ts.hour * 60 + ts.minute - (9 * 60 + 30)
        if minute < 0 or minute > FULL_DAY_LAST:
            continue
        day = by_day.setdefault(ts.date(), {})
        if minute in day:
            dup += 1
            continue
        day[minute] = Bar(minute, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
                          float(r["volume"]))
    sessions: list[Session] = []
    dropped: list[str] = []
    for d in sorted(by_day):
        bars = by_day[d]
        last = max(bars)
        complete = 0 in bars and len(bars) == last + 1 and (last == FULL_DAY_LAST or last in HALF_DAY_LASTS)
        if not complete:
            dropped.append(f"{d.isoformat()} ({len(bars)} bars, last minute {last})")
            continue
        sessions.append(Session(d, tuple(bars[m] for m in range(last + 1)), dividends.get(d, 0.0)))
    info = {
        "rows_read": rows,
        "duplicate_regular_session_rows_skipped": dup,
        "sessions_used": len(sessions),
        "half_day_sessions": sum(1 for s in sessions if len(s.bars) != FULL_DAY_LAST + 1),
        "sessions_dropped_incomplete": dropped,
        "first_session": sessions[0].day.isoformat() if sessions else None,
        "last_session": sessions[-1].day.isoformat() if sessions else None,
        "dividends_applied": sum(1 for s in sessions if s.dividend),
    }
    return sessions, info


def load_dividends(path: str | None) -> dict[date, float]:
    if not path:
        return {}
    return {date.fromisoformat(r["date"][:10]): float(r["dividend"]) for r in csv.DictReader(open(path, newline=""))}


def buy_and_hold(sessions: list[Session], days: list[date]) -> list[float]:
    """Daily close-to-close SPY return with the ex-date dividend added, on the evaluated days."""
    idx = {s.day: i for i, s in enumerate(sessions)}
    out = []
    for d in days:
        i = idx[d]
        prev = sessions[i - 1].bars[-1].close
        out.append((sessions[i].bars[-1].close + sessions[i].dividend) / prev - 1.0)
    return out


def m2d(m) -> dict:
    return {k: (round(v, 6) if isinstance(v, float) else v) for k, v in asdict(m).items()}


def summarize(res: BacktestResult) -> dict:
    first, second = halves(res)
    by_year: dict[int, list[float]] = {}
    for d in res.days:
        by_year.setdefault(d.day.year, []).append(d.ret)
    yearly = {}
    for y, rets in sorted(by_year.items()):
        eq = 1.0
        for r in rets:
            eq *= 1.0 + r
        yearly[str(y)] = round(eq - 1.0, 6)
    reasons: dict[str, int] = {}
    for t in res.trades:
        reasons[t.exit_reason] = reasons.get(t.exit_reason, 0) + 1
    return {
        "params": asdict(res.params),
        "full": m2d(metrics(res)),
        "first_half": {"from": first[0].day.isoformat(), "to": first[-1].day.isoformat(), **m2d(metrics(res, first))},
        "second_half": {"from": second[0].day.isoformat(), "to": second[-1].day.isoformat(),
                        **m2d(metrics(res, second))},
        "yearly_return": yearly,
        "long_trades": sum(1 for t in res.trades if t.side == 1),
        "short_trades": sum(1 for t in res.trades if t.side == -1),
        "exit_reasons": reasons,
        "avg_leverage": round(sum(d.leverage for d in res.days) / len(res.days), 4),
    }


# Paper variants (Tables 1-3). Primary = row 3 (current band + VWAP stop, vol-targeted size).
TASK_COSTS = dict(commission_per_share=0.0035, slippage_bps=1.0, slippage_per_share=0.0)
PAPER_COSTS = dict(commission_per_share=0.0035, slippage_bps=0.0, slippage_per_share=0.001)
NO_COSTS = dict(commission_per_share=0.0, slippage_bps=0.0, slippage_per_share=0.0)
VARIANTS = {
    "primary_band_vwap_voltarget_taskcosts": Params(stop="band_vwap", sizing="vol_target", **TASK_COSTS),
    "band_vwap_voltarget_papercosts": Params(stop="band_vwap", sizing="vol_target", **PAPER_COSTS),
    "band_vwap_voltarget_gross": Params(stop="band_vwap", sizing="vol_target", **NO_COSTS),
    "band_vwap_full_taskcosts": Params(stop="band_vwap", sizing="full", **TASK_COSTS),
    "opposite_band_full_taskcosts": Params(stop="opposite_band", sizing="full", **TASK_COSTS),
}

# Paper-reported results, Table 3 (p. 15), 2007-05 to 2024-04, $0.0035 + $0.001/share.
PAPER_REPORTED = {
    "opposite_band_full": {"total_return": 1.78, "irr": 0.062, "vol": 0.109, "sharpe": 0.61, "daily_hit": 0.54,
                           "mdd": 0.21, "trades": 5494},
    "band_vwap_full": {"total_return": 3.80, "irr": 0.097, "vol": 0.077, "sharpe": 1.24, "daily_hit": 0.43,
                       "mdd": 0.12, "trades": 7668},
    "band_vwap_voltarget": {"total_return": 19.85, "irr": 0.196, "vol": 0.143, "sharpe": 1.33, "daily_hit": 0.43,
                            "mdd": 0.25, "trades": 7668, "trade_hit": 0.37},
    "spy_buy_hold": {"total_return": 2.27, "irr": 0.072, "vol": 0.202, "sharpe": 0.45, "mdd": 0.56},
}


def main(argv: list[str] | None = None) -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bars", required=True)
    ap.add_argument("--format", choices=["ibkr-mt", "et"], required=True)
    ap.add_argument("--dividends")
    ap.add_argument("--out", required=True)
    ap.add_argument("--trades")
    ap.add_argument("--label", default="")
    a = ap.parse_args(argv)
    sessions, info = load_sessions(a.bars, a.format, load_dividends(a.dividends))
    report: dict = {"label": a.label, "data": info, "variants": {}, "paper_reported": PAPER_REPORTED,
                    "pass_rule": "PASS only if primary has >= 300 trades and net Sharpe > 0.5 in both halves"}
    primary = None
    for name, p in VARIANTS.items():
        res = run_backtest(sessions, p)
        report["variants"][name] = summarize(res)
        if primary is None:
            primary = res
    assert primary is not None
    days = [d.day for d in primary.days]
    bh = buy_and_hold(sessions, days)
    first, second = halves(primary)
    n1 = len(first)
    report["buy_and_hold"] = {
        "full": m2d(metrics_from_returns(bh)),
        "first_half": m2d(metrics_from_returns(bh[:n1])),
        "second_half": m2d(metrics_from_returns(bh[n1:])),
    }
    strat = [d.ret for d in primary.days]
    mean_s = sum(strat) / len(strat)
    mean_b = sum(bh) / len(bh)
    cov = sum((x - mean_s) * (y - mean_b) for x, y in zip(strat, bh)) / (len(bh) - 1)
    var_b = sum((y - mean_b) ** 2 for y in bh) / (len(bh) - 1)
    report["primary_beta_to_spy"] = round(cov / var_b, 4)
    report["verdict"] = verdict(primary)
    with open(a.out, "w") as f:
        json.dump(report, f, indent=1, default=str)
    if a.trades:
        with open(a.trades, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["day", "side", "shares", "entry_minute", "entry_price", "exit_minute", "exit_price",
                        "exit_reason", "gross", "cost", "net"])
            for t in primary.trades:
                w.writerow([t.day, t.side, t.shares, t.entry_minute, round(t.entry_price, 4), t.exit_minute,
                            round(t.exit_price, 4), t.exit_reason, round(t.gross, 2), round(t.cost, 2),
                            round(t.net, 2)])
    return report


if __name__ == "__main__":
    r = main()
    v = r["variants"]["primary_band_vwap_voltarget_taskcosts"]
    print(json.dumps({"verdict": r["verdict"], "data": {k: r["data"][k] for k in ("sessions_used", "first_session",
                      "last_session")}, "primary": v["full"], "h1": v["first_half"], "h2": v["second_half"],
                      "buy_hold": r["buy_and_hold"]["full"]}, indent=1))
