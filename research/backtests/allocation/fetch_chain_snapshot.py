"""One-day option-chain snapshot of the Core 7 ETF twins from Yahoo (research only, free public data).

Measures what the option model of the qc-ports runner assumes: the bid/ask half-spread in percent
of the mid, and the volatility skew in standardized moneyness. Writes the raw chains (CSV) and one
summary JSON to --out (a report work directory; not committed). Run while the US market is open,
otherwise the bid and ask are stale (the script does not check this):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/allocation/fetch_chain_snapshot.py --out <work dir>/chain
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import date, datetime, timezone
from pathlib import Path

SYMBOLS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
DTE_RANGE = (30, 75)  # monthly expiries (third Fridays) near the 30- to 60-day targets of the study


def third_friday(day: date) -> bool:
    return day.weekday() == 4 and 15 <= day.day <= 21


def usable(row) -> bool:
    return row.bid > 0 and row.ask > row.bid and math.isfinite(row.impliedVolatility) and row.impliedVolatility > 0.01


def nearest(rows, target: float):
    return min(rows, key=lambda row: abs(row.strike - target)) if rows else None


def half_spread_pct(row) -> float:
    mid = (row.bid + row.ask) / 2
    return 100 * (row.ask - row.bid) / 2 / mid


def slope(rows, spot: float, atm_iv: float, t: float, low: float, high: float) -> float | None:
    """Least-squares slope through (0, 1) of IV / ATM IV against x = ln(K/S) / (ATM IV * sqrt(t))."""
    points = [(math.log(row.strike / spot) / (atm_iv * math.sqrt(t)), row.impliedVolatility / atm_iv) for row in rows]
    points = [(x, y) for x, y in points if low <= x <= high and x != 0]
    if len(points) < 3:
        return None
    return sum(x * (y - 1) for x, y in points) / sum(x * x for x, _ in points)


def measure(ticker, symbol: str, expiry: str, today: date, out: Path) -> dict | None:
    days = (date.fromisoformat(expiry) - today).days
    chain = ticker.option_chain(expiry)
    spot = float(ticker.fast_info["last_price"])
    for side, frame in (("calls", chain.calls), ("puts", chain.puts)):
        frame.to_csv(out / f"{symbol}-{expiry}-{side}.csv", index=False)
    calls = [row for row in chain.calls.itertuples() if usable(row)]
    puts = [row for row in chain.puts.itertuples() if usable(row)]
    atm_call, atm_put = nearest(calls, spot), nearest(puts, spot)
    if atm_call is None or atm_put is None:
        return None
    t = days / 365
    atm_iv = (atm_call.impliedVolatility + atm_put.impliedVolatility) / 2
    sigma = spot * atm_iv * math.sqrt(t)
    otm_call = nearest([row for row in calls if row.strike > spot], spot + sigma)
    put_25 = nearest([row for row in puts if row.strike < spot], spot - 0.67 * sigma)  # about 25 delta
    put_far = nearest([row for row in puts if row.strike < spot], spot - 1.17 * sigma)  # half a sigma further out
    legs = {"atmCall": atm_call, "oneSigmaCall": otm_call, "put25Delta": put_25, "putFurtherOut": put_far}
    return {
        "expiry": expiry, "dte": days, "spot": spot, "atmIv": atm_iv,
        "halfSpreadPct": {name: (half_spread_pct(row) if row is not None else None) for name, row in legs.items()},
        "mid": {name: ((row.bid + row.ask) / 2 if row is not None else None) for name, row in legs.items()},
        "ivRatioOneSigmaCall": otm_call.impliedVolatility / atm_iv if otm_call is not None else None,
        "callSlope": slope(calls, spot, atm_iv, t, 0.0, 1.5), "putSlope": slope(puts, spot, atm_iv, t, -1.5, 0.0),
        "usableQuotes": {"calls": len(calls), "puts": len(puts)},
    }


def main() -> None:
    import yfinance as yf

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    today = now.date()
    summary = {"fetchedAt": now.isoformat(timespec="seconds"), "source": f"Yahoo Finance via yfinance {yf.__version__}", "symbols": {}}
    for symbol in SYMBOLS:
        ticker = yf.Ticker(symbol)
        expiries = [value for value in ticker.options
                    if DTE_RANGE[0] <= (date.fromisoformat(value) - today).days <= DTE_RANGE[1] and third_friday(date.fromisoformat(value))]
        summary["symbols"][symbol] = [item for item in (measure(ticker, symbol, value, today, args.out) for value in expiries) if item]
        print(symbol, [(item["expiry"], {k: None if v is None else round(v, 2) for k, v in item["halfSpreadPct"].items()},
                        None if item["callSlope"] is None else round(item["callSlope"], 3),
                        None if item["putSlope"] is None else round(item["putSlope"], 3)) for item in summary["symbols"][symbol]])
    (args.out / "summary.json").write_text(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
