"""Daily option-chain snapshot of the Core 7 ETF twins from Yahoo (research only, free public data).

Measures what the option model of the qc-ports runner assumes (services/research/strategies/qc_ports/
options.py): the bid/ask half-spread in percent of the mid, and the volatility skew in standardized
moneyness. One run writes one directory <store>/<New York day>/<HHMMSS>Z/ with the raw chains (CSV) and
summary.json. The store is a local data directory; it is not committed.

A run measures only while the US option market trades: SPY must have an option trade in the last
MAX_TRADE_AGE_MIN minutes. On a weekend, a holiday or after the close the bid and ask are stale, so the
run writes nothing and exits 0 ("skipped"). Exit 1: a symbol had no usable chain (the partial snapshot is
still written, with "complete": false).

  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/option-chain/snapshot.py --store ~/.local/share/vertex/option-chain

calibrate.py in this directory turns the collected days into proposed model constants.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SCHEMA = 1
SYMBOLS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
PROBE = "SPY"
DTE_RANGE = (30, 75)  # the option forms buy 30- to 60-day spreads
MAX_TRADE_AGE_MIN = 45  # Yahoo delays quotes by up to 15 minutes
NEW_YORK = ZoneInfo("America/New_York")
ATTEMPTS = 3


def third_friday(day: date) -> bool:
    return day.weekday() == 4 and 15 <= day.day <= 21


def monthly_expiries(expiries, today: date) -> list[str]:
    """The standard monthly expiries (third Friday) inside DTE_RANGE."""
    return [value for value in expiries
            if DTE_RANGE[0] <= (date.fromisoformat(value) - today).days <= DTE_RANGE[1]
            and third_friday(date.fromisoformat(value))]


def usable(row) -> bool:
    return (row.bid > 0 and row.ask > row.bid and math.isfinite(row.impliedVolatility)
            and row.impliedVolatility > 0.01)


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


def measure(call_rows, put_rows, spot: float, expiry: str, today: date) -> dict | None:
    """Half-spread of four reference legs and the two wing slopes of one expiry; None without usable quotes."""
    days = (date.fromisoformat(expiry) - today).days
    calls = [row for row in call_rows if usable(row)]
    puts = [row for row in put_rows if usable(row)]
    atm_call, atm_put = nearest(calls, spot), nearest(puts, spot)
    if atm_call is None or atm_put is None or days <= 0 or not spot > 0:
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


def last_trade(frames) -> datetime | None:
    """Latest option trade time (UTC) in the chain frames; None when there is none."""
    stamps = [stamp for frame in frames for stamp in frame["lastTradeDate"].dropna().tolist()]
    if not stamps:
        return None
    latest = max(stamps)
    latest = latest.to_pydatetime() if hasattr(latest, "to_pydatetime") else latest
    return latest if latest.tzinfo else latest.replace(tzinfo=timezone.utc)


def market_trades(latest: datetime | None, now: datetime) -> bool:
    """True when the latest option trade is recent enough for live bid and ask."""
    return latest is not None and timedelta(0) <= now - latest <= timedelta(minutes=MAX_TRADE_AGE_MIN)


def retry(call):
    for attempt in range(ATTEMPTS):
        try:
            return call()
        except Exception:  # noqa: BLE001 - yfinance raises many types on a throttled or empty reply
            if attempt == ATTEMPTS - 1:
                raise
            time.sleep(5 * (attempt + 1))


def chains_of(ticker, today: date) -> list:
    """(expiry, chain) of the monthly expiries. No expiry is a failed reply, not a closed market."""
    def fetch() -> list:
        expiries = monthly_expiries(ticker.options, today)
        if not expiries:
            raise RuntimeError("Yahoo listed no monthly expiry")
        return [(expiry, ticker.option_chain(expiry)) for expiry in expiries]

    return retry(fetch)


def collect(ticker_for, now: datetime, store: Path, source: str, log=print) -> int:
    """One snapshot run. `ticker_for(symbol)` returns a yfinance-like ticker. Returns the exit code."""
    today = now.astimezone(NEW_YORK).date()
    probe = ticker_for(PROBE)
    probe_chains = chains_of(probe, today)
    latest = last_trade([frame for _, chain in probe_chains for frame in (chain.calls, chain.puts)])
    if not market_trades(latest, now):
        log(f"skipped: no {PROBE} option trade in the last {MAX_TRADE_AGE_MIN} minutes (latest {latest}); the market is closed")
        return 0
    out = store / today.isoformat() / now.strftime("%H%M%SZ")
    out.mkdir(parents=True, exist_ok=False)
    summary = {"schema": SCHEMA, "day": today.isoformat(), "fetchedAt": now.isoformat(timespec="seconds"),
               "source": source, "probeLastTrade": latest.isoformat(timespec="seconds"), "complete": True, "symbols": {}}
    for symbol in SYMBOLS:
        items = []
        try:
            ticker = probe if symbol == PROBE else ticker_for(symbol)
            chains = probe_chains if symbol == PROBE else chains_of(ticker, today)
            spot = float(retry(lambda: ticker.fast_info["last_price"]))
            for expiry, chain in chains:
                for side, frame in (("calls", chain.calls), ("puts", chain.puts)):
                    frame.to_csv(out / f"{symbol}-{expiry}-{side}.csv", index=False)
                item = measure(chain.calls.itertuples(), chain.puts.itertuples(), spot, expiry, today)
                if item:
                    items.append(item)
        except Exception as error:  # noqa: BLE001 - one failed symbol must not lose the other six
            log(f"{symbol}: failed: {type(error).__name__}: {error}")
        summary["symbols"][symbol] = items
        if not items:
            summary["complete"] = False
        log(symbol, [(item["expiry"], {k: None if v is None else round(v, 2) for k, v in item["halfSpreadPct"].items()},
                      None if item["callSlope"] is None else round(item["callSlope"], 3),
                      None if item["putSlope"] is None else round(item["putSlope"], 3)) for item in items])
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    log(f"wrote {out / 'summary.json'} (complete: {summary['complete']})")
    return 0 if summary["complete"] else 1


def main() -> int:
    import yfinance as yf

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--store", required=True, type=Path, help="snapshot store directory (local data, not committed)")
    args = parser.parse_args()
    return collect(yf.Ticker, datetime.now(timezone.utc), args.store.expanduser(),
                   f"Yahoo Finance via yfinance {yf.__version__}")


if __name__ == "__main__":
    sys.exit(main())
