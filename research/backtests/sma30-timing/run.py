"""Reproduce and stress-test the 30-day moving average market timing rule.

Research only. Reads local CSV files written by fetch_data.py; places no orders.
Run (rig, from the repository root):
  PYTHONPATH=services/research uv run --no-project --python 3.12 \
      python research/backtests/sma30-timing/run.py \
      --data ~/Documents/reports/vertex-30dma/data \
      --out research/backtests/sma30-timing/results.json
  bunx --bun --no-install biome format --write research/backtests/sma30-timing/results.json

Pass/fail rule, fixed on 2026-10-30 before the first full run (card vertex-30dma-timing):
the 30-day rule (signal at the close of day t, position on day t+1) passes only if, after 0.1% per
trade, it has a higher Sharpe ratio AND a smaller maximum drawdown than buy-and-hold in BOTH halves
of the Ken French sample AND on the SPY + T-bill ETF proxy since 1993. Return alone is not the bar.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections.abc import Sequence
from datetime import date
from pathlib import Path

from strategies import sma_timing as st

CREATOR = {
    "source": "Instagram @alanintelligence (untrusted claims); "
              "owner Discord message (private)",
    "period": "1926-07 to 2026-06",
    "start_usd": 1000,
    "timing_final_usd": 339.9e6,
    "buy_hold_final_usd": 17.7e6,
    "trades": 1936,
    "fraction_out": 0.3612,
    "timing_max_drawdown": -0.3952,
    "buy_hold_max_drawdown": -0.8407,
    "at_0_2pct_vs_buy_hold": -0.6013,
}
FIRST, LAST = "1926-07-01", "2026-06-30"
COSTS = (0.0, 0.0005, 0.001, 0.002)
WINDOWS = (10, 20, 30, 50, 100, 200)
PASS_COST, PASS_WINDOW, PASS_LAG = 0.001, 30, 1


def as_dict(s: st.Stats) -> dict[str, float | int]:
    return {
        "days": s.days, "final_wealth": round(s.final_wealth, 6), "cagr": round(s.cagr, 6),
        "volatility": round(s.volatility, 6), "sharpe": round(s.sharpe, 4),
        "max_drawdown": round(s.max_drawdown, 6), "trades": s.trades, "fraction_out": round(s.fraction_out, 6),
    }


def pair(timed: st.Stats, held: st.Stats) -> dict[str, object]:
    return {"timing": as_dict(timed), "buy_hold": as_dict(held),
            "beats_on_sharpe_and_drawdown": timed.sharpe > held.sharpe and timed.max_drawdown > held.max_drawdown}


def autocorrelation(xs: Sequence[float]) -> float:
    m = math.fsum(xs) / len(xs)
    num = math.fsum((a - m) * (b - m) for a, b in zip(xs, xs[1:], strict=False))
    return num / math.fsum((x - m) ** 2 for x in xs)


def per_year(days: Sequence[str], a: int, b: int) -> float:
    """Return days per calendar year in days[a:b] (about 300 while the NYSE traded on Saturdays)."""
    span = (date.fromisoformat(days[b - 1]) - date.fromisoformat(days[a])).days + 1
    return (b - a) / (span / 365.25)


def load_french(path: Path) -> tuple[list[str], list[float], list[float]]:
    with path.open() as fh:
        rows = [r for r in csv.DictReader(fh) if FIRST <= r["date"] <= LAST]
    return ([r["date"] for r in rows], [(float(r["mkt_rf"]) + float(r["rf"])) / 100 for r in rows],
            [float(r["rf"]) / 100 for r in rows])


def load_yahoo(path: Path) -> dict[str, tuple[float, float]]:
    with path.open() as fh:
        return {r["date"]: (float(r["open"]), float(r["close"])) for r in csv.DictReader(fh)}


def french_section(days: list[str], mkt: list[float], rf: list[float]) -> dict[str, object]:
    n = len(days)
    half = n // 2
    out: dict[str, object] = {"first": days[0], "last": days[-1], "days": n}

    def run(window: int, lag: int, cost: float, a: int = 0, b: int = n) -> tuple[st.Stats, st.Stats]:
        return st.run(mkt, rf, window, lag, cost, a, b, per_year=per_year(days, a, b))

    repro = {}
    for lag, label in ((1, "lag1_close_t_to_t+1"), (0, "lag0_same_close_lookahead"), (2, "lag2_one_day_late")):
        timed, held = run(30, lag, 0.0)
        cost2, _ = run(30, lag, 0.002)
        repro[label] = {**pair(timed, held), "timing_final_usd": round(1000 * timed.final_wealth, 2),
                        "buy_hold_final_usd": round(1000 * held.final_wealth, 2),
                        "at_0_2pct_vs_buy_hold": round(cost2.final_wealth / held.final_wealth - 1, 6)}
    out["reproduction"] = repro

    out["costs"] = {f"{c:.4f}": {f"lag{lag}": pair(*run(30, lag, c)) for lag in (1, 2)} for c in COSTS}
    out["windows"] = {str(w): {f"{c:.4f}": pair(*run(w, PASS_LAG, c)) for c in (0.0, PASS_COST)}
                      for w in WINDOWS}
    out["windows_lag2"] = {str(w): pair(*run(w, 2, PASS_COST)) for w in WINDOWS}
    out["start_by_decade"] = {}
    for year in range(1930, 2030, 10):
        start = next(i for i, d in enumerate(days) if d >= f"{year}-01-01")
        out["start_by_decade"][str(year)] = {"first": days[start], **pair(*run(30, PASS_LAG, PASS_COST, start))}
    out["halves"] = {}
    for label, (a, b) in (("first", (0, half)), ("second", (half, n))):
        out["halves"][label] = {
            "first": days[a], "last": days[b - 1],
            "lag1_daily_return_autocorrelation": round(autocorrelation(mkt[a:b]), 4),
            **{f"{c:.4f}": pair(*run(30, PASS_LAG, c, a, b)) for c in COSTS},
            "lag2_0.0010": pair(*run(30, 2, PASS_COST, a, b)),
        }
    return out


def spy_section(spy: dict[str, tuple[float, float]], cash_etf: dict[str, tuple[float, float]],
                french: dict[str, float], cash_symbol: str) -> dict[str, object]:
    days = sorted(spy)
    asset, cash, overnight, intraday, used = [], [], [], [], {"french_rf": 0, cash_symbol: 0}
    for prev, day in zip(days, days[1:], strict=False):
        asset.append(spy[day][1] / spy[prev][1] - 1)
        overnight.append(spy[day][0] / spy[prev][1] - 1)
        intraday.append(spy[day][1] / spy[day][0] - 1)
        if day in cash_etf and prev in cash_etf:
            cash.append(cash_etf[day][1] / cash_etf[prev][1] - 1)
            used[cash_symbol] += 1
        else:
            cash.append(french[day])
            used["french_rf"] += 1
    yearly = per_year(days, 1, len(days))
    levels = st.total_return_index(asset)
    held = st.positions(st.sma_states(levels, 30), 1)
    out: dict[str, object] = {"first_return_day": days[1], "last": days[-1], "days": len(asset), "cash_days": used}
    out["costs"] = {}
    for c in COSTS:
        timed, bh = st.run(asset, cash, 30, 1, c, per_year=yearly)
        late, _ = st.run(asset, cash, 30, 2, c, per_year=yearly)
        nxt, trades = st.next_open_returns(overnight, intraday, cash, held, c)
        out["costs"][f"{c:.4f}"] = {
            "close_t_to_t+1": pair(timed, bh),
            "next_open": pair(st.stats(nxt, cash, trades, held, yearly), bh),
            "one_day_late": pair(late, bh),
        }
    out["windows_0.0010"] = {str(w): pair(*st.run(asset, cash, w, 1, PASS_COST, per_year=yearly)) for w in WINDOWS}
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    data: Path = args.data.expanduser()
    days, mkt, rf = load_french(data / "french_daily.csv")
    with (data / "french_daily.csv").open() as fh:
        french_rf = {r["date"]: float(r["rf"]) / 100 for r in csv.DictReader(fh)}
    spy = load_yahoo(data / "SPY.adj.csv")
    last_rf = max(french_rf)
    spy = {d: v for d, v in spy.items() if d <= last_rf}  # cash needs a T-bill rate before BIL exists

    ken = french_section(days, mkt, rf)
    proxy = {s: spy_section(spy, load_yahoo(data / f"{s}.adj.csv"), french_rf, s) for s in ("BIL", "SHV")}
    halves = ken["halves"]
    checks = {
        "first_half": halves["first"][f"{PASS_COST:.4f}"]["beats_on_sharpe_and_drawdown"],
        "second_half": halves["second"][f"{PASS_COST:.4f}"]["beats_on_sharpe_and_drawdown"],
        "spy_bil_proxy": proxy["BIL"]["costs"][f"{PASS_COST:.4f}"]["close_t_to_t+1"]["beats_on_sharpe_and_drawdown"],
    }
    result = {
        "rule": __doc__.split("Pass/fail rule, ")[1].strip(),
        "creator_claims": CREATOR,
        "data_manifest": json.loads((data / "manifest.json").read_text()),
        "ken_french": ken,
        "spy_proxy": proxy,
        "pass_fail": {"checks": checks, "passed": all(checks.values())},
    }
    args.out.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps({"reproduction": ken["reproduction"]["lag1_close_t_to_t+1"], "pass_fail": result["pass_fail"]},
                     indent=1))


if __name__ == "__main__":
    main()
