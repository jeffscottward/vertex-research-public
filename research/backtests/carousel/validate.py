"""Reproduce the published reference result of each carousel strategy within a stated tolerance.

Research only. Reads local CSV files written by fetch_data.py; places no orders.
Run (rig, from the repository root):
  PYTHONPATH=services/research uv run --no-project --python 3.12 \
      python research/backtests/carousel/validate.py \
      --data ~/Documents/reports/vertex-ig-carousel-strategies/data \
      --out research/backtests/carousel/validation.json
  bunx --bun --no-install biome format --write research/backtests/carousel/validation.json

A strategy passes only when every primary check is inside its tolerance. Secondary checks are
recorded for information and do not decide the result.

Tolerances were set on 2026-10-29 after a first prototype run on the same data. They are not
pre-registered; each one is stated next to its check so a reader can judge it.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from strategies import published_rules as pr

OAL = "https://github.com/Guillain-RDCDE/Open-Alpha-Lab/blob/main/studies"
OAL_QUALITY = ("third-party open-source study (Open Alpha Lab, MIT licence; small repository, 2 GitHub stars on "
               "2026-10-29); not peer reviewed")


def load_bars(path: Path, first: str, last: str) -> list[pr.Bar]:
    with path.open() as fh:
        return [pr.Bar(r["date"], float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
                       float(r["dividend"]))
                for r in csv.DictReader(fh) if first <= r["date"] <= last]


def load_closes(path: Path) -> dict[str, float]:
    with path.open() as fh:
        return {r["date"]: float(r["adj_close"]) for r in csv.DictReader(fh)}


def check(name: str, reference: float, reproduced: float, tolerance: float, unit: str,
          primary: bool = True) -> dict[str, object]:
    return {"name": name, "reference": reference, "reproduced": round(reproduced, 6), "tolerance": tolerance,
            "unit": unit, "primary": primary, "pass": abs(reproduced - reference) <= tolerance}


def close_to_open(data: Path) -> dict[str, object]:
    bars = load_bars(data / "SPY.raw.csv", "1993-01-29", "2026-06-01")
    split = pr.session_split(bars)
    knuteson = pr.session_split(load_bars(data / "SPY.raw.csv", "1993-01-29", "2018-10-31"),
                                include_dividends=True)
    return {
        "slug": "close-to-open-edge",
        "reference": f"{OAL}/01-overnight-anomaly/docs/results.md (SPY, Yahoo split-only OHLC, "
                     "1993-01-29 to 2026-06-01, as-of 2026-06-01)",
        "reference_quality": OAL_QUALITY,
        "checks": [
            check("SPY sessions", 8391, split.sessions, 0, "rows"),
            check("overnight cumulative return", 1185.0, split.overnight_total * 100, 1.0, "percent"),
            check("intraday cumulative return", 34.0, split.intraday_total * 100, 1.0, "percent"),
            check("overnight mean", 3.27, split.overnight_mean_bps, 0.01, "bps per day"),
            check("Knuteson (2018 letter) overnight 1993-01-29 to 2018-10-31, dividends in the overnight leg",
                  1171.0, knuteson.overnight_total * 100, 0.0, "percent", primary=False),
            check("Knuteson (2018 letter) intraday 1993-01-29 to 2018-10-31", -21.0,
                  knuteson.intraday_total * 100, 0.0, "percent", primary=False),
        ],
        "secondary_note": "Knuteson's figures (letter of 2018-11-02 in "
                          "https://bruceknuteson.github.io/spy-day-and-night/correspondence/1/OFR.pdf) were not "
                          "reproduced; the source and adjustment of his data are not stated, so the difference is "
                          "unexplained.",
    }


def pairs(data: Path) -> dict[str, object]:
    gld, gdx = load_closes(data / "chan" / "GLD.csv"), load_closes(data / "chan" / "GDX.csv")
    days = sorted(set(gld) & set(gdx))
    result = pr.pair_spread_backtest([gld[d] for d in days], [gdx[d] for d in days], train=252)
    return {
        "slug": "pairs-trading-divergence",
        "reference": "Ernest Chan, Quantitative Trading (Wiley, 2008), example 3.6, author MATLAB code and the "
                     "GLD.xls/GDX.xls files (copy: github.com/egorpe/EPChan-QuantitativeTrading); "
                     "training set = first 252 joint days",
        "reference_quality": "author's book code and data files",
        "checks": [
            check("training-set Sharpe ratio (code comment: about 2.3)", 2.3, result.sharpe_train, 0.05, "ratio"),
            check("test-set Sharpe ratio (code comment: about 1.5)", 1.5, result.sharpe_test, 0.05, "ratio"),
        ],
        "data_provenance": {"joint_days": len(days), "first": days[0], "last": days[-1]},
        "hedge_ratio": round(result.hedge_ratio, 6),
    }


def nr7(data: Path) -> dict[str, object]:
    bars = load_bars(data / "SPY.adj.csv", "2000-01-03", "2026-06-15")
    signals = pr.nr7_days(bars)
    ratios = pr.range_expansion_ratios(bars, signals)
    trades = pr.summarize(pr.nr7_breakout_trades(bars, signals))
    return {
        "slug": "volatility-compression-breakout",
        "reference": f"{OAL}/190-nr7/docs/results.md (SPY, Yahoo split- and dividend-adjusted OHLC, "
                     "2000-01-03 to 2026-06-15, as-of 2026-06-15)",
        "reference_quality": OAL_QUALITY,
        "note": "This run has one NR7 day and one trade more than the reference. Without the trade on the "
                "2022-10-12 NR7 day (short on 2022-10-13, -479.9 bps) the mean is +5.407 bps over 1,009 "
                "trades, equal to the reference. Why the reference lacks this trade is not known.",
        "checks": [
            check("SPY sessions", 6652, len(bars), 0, "rows"),
            check("NR7 days", 1035, sum(signals), 10, "days"),
            check("next-day range / 20-day mean range", 0.910, pr.mean(ratios), 0.005, "ratio"),
            check("breakout trades", 1009, trades.count, 10, "trades"),
            check("breakout mean gross return", 5.4, trades.mean_bps, 1.0, "bps per trade"),
        ],
    }


def zscore(data: Path) -> dict[str, object]:
    ref = {"SPY": (149, 140), "QQQ": (140, 226), "AAPL": (112, 116), "MSFT": (119, 219), "JPM": (139, 354),
           "XLE": (152, 105)}
    checks, pooled = [], []
    for symbol, (count, mean_bps) in ref.items():
        bars = load_bars(data / f"{symbol}.adj.csv", "2005-01-03", "2026-06-12")
        trades = pr.time_exit_trades(bars, pr.lower_band_entries([b.close for b in bars]), hold=20)
        summary = pr.summarize(trades)
        pooled += trades
        checks += [check(f"{symbol} trades", count, summary.count, 0, "trades"),
                   check(f"{symbol} mean gross 20-day return", mean_bps, summary.mean_bps, 1.0, "bps per trade")]
    summary = pr.summarize(pooled)
    checks += [check("pooled trades", 811, summary.count, 0, "trades"),
               check("pooled mean gross 20-day return", 193.09, summary.mean_bps, 0.5, "bps per trade"),
               check("pooled win rate", 64.6, summary.win_rate * 100, 0.1, "percent")]
    return {
        "slug": "zscore-mean-reversion",
        "reference": f"{OAL}/104-bollinger-reversion/docs/results.md (SPY, QQQ, AAPL, MSFT, JPM, XLE; Yahoo "
                     "adjusted OHLC 2005-01-03 to 2026-06-12; lower band = 20-day mean minus 2 standard "
                     "deviations; enter next open; exit at the close 20 sessions later)",
        "reference_quality": OAL_QUALITY,
        "checks": checks,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    data: Path = args.data.expanduser()
    results = [close_to_open(data), pairs(data), nr7(data), zscore(data)]
    for item in results:
        primary = [c for c in item["checks"] if c["primary"]]  # type: ignore[index]
        item["validated"] = all(c["pass"] for c in primary)
        print(f"{item['slug']}: {'PASS' if item['validated'] else 'FAIL'}")
        for c in item["checks"]:  # type: ignore[union-attr]
            tag = "pass" if c["pass"] else "FAIL" if c["primary"] else "info"
            print(f"  [{tag}] {c['name']}: reference {c['reference']} reproduced {c['reproduced']} "
                  f"(tolerance {c['tolerance']} {c['unit']})")
    if args.out:
        manifest = data / "manifest.json"
        payload = {"tolerance_note": "Tolerances were set on 2026-10-29 after a first prototype run on the same data; "
                                     "they are not pre-registered.",
                   "data_manifest": json.loads(manifest.read_text()) if manifest.exists() else None,
                   "strategies": results}
        args.out.write_text(json.dumps(payload, indent=1) + "\n")
    return 0 if all(item["validated"] for item in results) else 1


if __name__ == "__main__":
    sys.exit(main())
