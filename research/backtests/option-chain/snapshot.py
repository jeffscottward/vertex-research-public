"""Daily option-chain snapshot of the Core 7 ETF twins from Yahoo (research only, free public data).

Measures what the option model of the qc-ports runner assumes (services/research/strategies/qc_ports/
options.py): the bid/ask half-spread in percent of the mid, and the volatility skew in standardized
moneyness. One run writes one directory <store>/<New York day>/<HHMMSS>Z/ with the raw chains (CSV) and
summary.json. The store is a local data directory; it is not committed.

Implied volatility: computed here from the quote mids (Black-76 on the forward that put-call parity gives
for the expiry). The implied volatility column of Yahoo is not used: its calls and puts disagree at the
same strike, which shifts both wing slopes.

A run measures only while the US option market trades: New York time inside SESSION on a weekday, and
SPY with an option trade in the last MAX_TRADE_AGE_MIN minutes (this covers holidays and half days).
Otherwise the bid and ask are stale, so the run writes nothing and exits 0 ("skipped"). Exit 1: Yahoo
failed for SPY (nothing written), or a symbol or expiry could not be measured (the rest is written,
with "complete": false).

  uv run --no-project --python 3.12 --with yfinance==0.2.66 --exclude-newer 2026-11-11T00:00:00Z \
      python research/backtests/option-chain/snapshot.py --store ~/.local/share/vertex/option-chain

--remeasure <run directory> computes summary.json of a stored run again from its CSV files (after a
change of the method). calibrate.py in this directory turns the stored days into proposed constants.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import sys
import time as clock
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

SCHEMA = 2  # 2: implied volatility from the mids on the parity forward (1 used the Yahoo column)
SYMBOLS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
PROBE = "SPY"
DTE_RANGE = (30, 75)  # the option forms buy 30- to 60-day spreads
SESSION = (time(9, 45), time(16, 0))  # New York; Yahoo delays quotes by up to 15 minutes
MAX_TRADE_AGE_MIN = 45
NEW_YORK = ZoneInfo("America/New_York")
ATTEMPTS = 3
PARITY_WINDOW = 0.03  # strikes within 3% of spot give the forward
RATE = 0.04  # for the discount factor only: one point of rate moves a 75-day price by 0.2%
ATM_TOLERANCE = 0.02  # the nearest quoted strike must be within 2% of spot
VOL_BOUNDS = (0.005, 5.0)


def monthly_expiries(expiries, today: date) -> list[str]:
    """The standard monthly expiries inside DTE_RANGE: the third Friday, or the Thursday before it when
    the exchange is closed on that Friday (then the Friday is not listed)."""
    listed = {date.fromisoformat(value) for value in expiries}
    out = []
    for day in sorted(listed):
        friday = day if day.weekday() == 4 else day + timedelta(days=1)
        monthly = friday.weekday() == 4 and 15 <= friday.day <= 21 and (day == friday or friday not in listed)
        if monthly and DTE_RANGE[0] <= (day - today).days <= DTE_RANGE[1]:
            out.append(day.isoformat())
    return out


def usable(row) -> bool:
    return row.bid > 0 and row.ask > row.bid


def mid_of(row) -> float:
    return (row.bid + row.ask) / 2


def nearest(rows, target: float):
    return min(rows, key=lambda row: abs(row.strike - target)) if rows else None


def half_spread_pct(row) -> float:
    return 100 * (row.ask - row.bid) / 2 / mid_of(row)


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2))


def black(forward: float, strike: float, t: float, vol: float, call: bool) -> float:
    """Black-76 price without discounting."""
    deviation = vol * math.sqrt(t)
    d1 = math.log(forward / strike) / deviation + deviation / 2
    d2 = d1 - deviation
    if call:
        return forward * norm_cdf(d1) - strike * norm_cdf(d2)
    return strike * norm_cdf(-d2) - forward * norm_cdf(-d1)


def implied_vol(price: float, forward: float, strike: float, t: float, call: bool) -> float | None:
    """Black-76 volatility of a price without discounting, by bisection; None outside VOL_BOUNDS."""
    low, high = VOL_BOUNDS
    if not black(forward, strike, t, low, call) < price < black(forward, strike, t, high, call):
        return None
    for _ in range(60):
        middle = (low + high) / 2
        if black(forward, strike, t, middle, call) < price:
            low = middle
        else:
            high = middle
    return (low + high) / 2


def parity_forward(calls, puts, spot: float, discount: float) -> float | None:
    """Forward of one expiry from put-call parity, F = K + (C - P) / DF: the median over the strikes within
    PARITY_WINDOW of spot that have a call and a put quote. None without three such strikes. Near the
    money the early-exercise value of these American options is small; a fit of DF over a wider strike
    range is not used because that value bends it (it gave discount factors above 1)."""
    put_mid = {row.strike: mid_of(row) for row in puts}
    forwards = [row.strike + (mid_of(row) - put_mid[row.strike]) / discount for row in calls
                if row.strike in put_mid and abs(row.strike / spot - 1) <= PARITY_WINDOW]
    return statistics.median(forwards) if len(forwards) >= 3 else None


def slope(vols: dict[float, float], spot: float, atm_iv: float, t: float, low: float, high: float) -> float | None:
    """Least-squares slope through (0, 1) of IV / ATM IV against x = ln(K/S) / (ATM IV * sqrt(t)), for the
    strikes with low <= x <= high. `vols` is strike -> IV."""
    points = [(math.log(strike / spot) / (atm_iv * math.sqrt(t)), vol / atm_iv) for strike, vol in vols.items()]
    points = [(x, y) for x, y in points if low <= x <= high and x != 0]
    if len(points) < 3:
        return None
    return sum(x * (y - 1) for x, y in points) / sum(x * x for x, _ in points)


def measure(call_rows, put_rows, spot: float, expiry: str, today: date) -> dict | None:
    """Half-spread of four reference legs and the two wing slopes of one expiry; None without usable quotes."""
    days = (date.fromisoformat(expiry) - today).days
    calls = [row for row in call_rows if usable(row)]
    puts = [row for row in put_rows if usable(row)]
    if days <= 0 or not spot > 0:
        return None
    t = days / 365
    discount = math.exp(-RATE * t)
    forward = parity_forward(calls, puts, spot, discount)
    if forward is None:
        return None
    call_iv = {row.strike: implied_vol(mid_of(row) / discount, forward, row.strike, t, call=True) for row in calls}
    put_iv = {row.strike: implied_vol(mid_of(row) / discount, forward, row.strike, t, call=False) for row in puts}
    calls = [row for row in calls if call_iv[row.strike] is not None]
    puts = [row for row in puts if put_iv[row.strike] is not None]
    atm_call, atm_put = nearest(calls, spot), nearest(puts, spot)
    if atm_call is None or atm_put is None or max(abs(row.strike / spot - 1) for row in (atm_call, atm_put)) > ATM_TOLERANCE:
        return None
    atm_iv = (call_iv[atm_call.strike] + put_iv[atm_put.strike]) / 2
    sigma = spot * atm_iv * math.sqrt(t)
    otm_call = nearest([row for row in calls if row.strike > spot], spot + sigma)
    put_25 = nearest([row for row in puts if row.strike < spot], spot - 0.67 * sigma)  # about 25 delta
    put_far = nearest([row for row in puts if row.strike < spot], spot - 1.17 * sigma)  # half a sigma further out
    legs = {"atmCall": atm_call, "oneSigmaCall": otm_call, "put25Delta": put_25, "putFurtherOut": put_far}

    def per_leg(value) -> dict:
        return {name: (value(row) if row is not None else None) for name, row in legs.items()}

    return {
        "expiry": expiry, "dte": days, "spot": spot, "forward": forward, "atmIv": atm_iv,
        "strike": per_leg(lambda row: row.strike), "halfSpreadPct": per_leg(half_spread_pct), "mid": per_leg(mid_of),
        "ivRatioOneSigmaCall": call_iv[otm_call.strike] / atm_iv if otm_call is not None else None,
        "callSlope": slope({row.strike: call_iv[row.strike] for row in calls}, spot, atm_iv, t, 0.0, 1.5),
        "putSlope": slope({row.strike: put_iv[row.strike] for row in puts}, spot, atm_iv, t, -1.5, 0.0),
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


def in_session(now: datetime) -> bool:
    local = now.astimezone(NEW_YORK)
    return local.weekday() < 5 and SESSION[0] <= local.time() < SESSION[1]


def retry(call):
    for attempt in range(ATTEMPTS):
        try:
            return call()
        except Exception:  # noqa: BLE001 - yfinance raises many types on a throttled or empty reply
            if attempt == ATTEMPTS - 1:
                raise
            clock.sleep(5 * (attempt + 1))


def chains_of(ticker, today: date) -> list:
    """(expiry, chain) of the monthly expiries. An empty reply is a failure (and is tried again), not a
    closed market: yfinance returns no expiry or a chain without rows when Yahoo sends no option data."""
    def fetch() -> list:
        chains = [(expiry, ticker.option_chain(expiry)) for expiry in monthly_expiries(ticker.options, today)]
        if not chains:
            raise RuntimeError("Yahoo listed no monthly expiry")
        for expiry, chain in chains:
            if chain.calls is None or chain.puts is None or len(chain.calls) == 0 or len(chain.puts) == 0:
                raise RuntimeError(f"Yahoo sent an empty chain for {expiry}")
        return chains

    return retry(fetch)


def write_summary(out: Path, summary: dict) -> None:
    partial = out / "summary.json.part"  # calibrate.py reads summary.json only, so a killed run leaves no half file
    partial.write_text(json.dumps(summary, indent=1))
    partial.replace(out / "summary.json")


def collect(ticker_for, now: datetime, store: Path, source: str, log=print) -> int:
    """One snapshot run. `ticker_for(symbol)` returns a yfinance-like ticker. Returns the exit code."""
    today = now.astimezone(NEW_YORK).date()
    if not in_session(now):
        log(f"skipped: {now.astimezone(NEW_YORK):%a %H:%M} New York is outside {SESSION[0]:%H:%M} to {SESSION[1]:%H:%M} on a weekday")
        return 0
    probe = ticker_for(PROBE)
    probe_chains = chains_of(probe, today)
    latest = last_trade([frame for _, chain in probe_chains for frame in (chain.calls, chain.puts)])
    if latest is None:
        raise RuntimeError(f"The {PROBE} chain has no trade time")
    if now - latest > timedelta(minutes=MAX_TRADE_AGE_MIN):
        log(f"skipped: no {PROBE} option trade in the last {MAX_TRADE_AGE_MIN} minutes (latest {latest}); the market is closed")
        return 0
    out = store / today.isoformat() / now.strftime("%H%M%SZ")
    out.mkdir(parents=True, exist_ok=False)
    summary = {"schema": SCHEMA, "day": today.isoformat(), "fetchedAt": now.isoformat(timespec="seconds"),
               "source": source, "probeLastTrade": latest.isoformat(timespec="seconds"), "complete": True,
               "spots": {}, "errors": {}, "symbols": {}}
    for symbol in SYMBOLS:
        items, chains = [], []
        try:
            ticker = probe if symbol == PROBE else ticker_for(symbol)
            chains = probe_chains if symbol == PROBE else chains_of(ticker, today)
            for expiry, chain in chains:  # the raw quotes first: a later failure must not lose them
                for side, frame in (("calls", chain.calls), ("puts", chain.puts)):
                    frame.to_csv(out / f"{symbol}-{expiry}-{side}.csv", index=False)
            spot = retry(lambda: float(ticker.fast_info["last_price"]))
            summary["spots"][symbol] = spot
            measured = [measure(chain.calls.itertuples(), chain.puts.itertuples(), spot, expiry, today) for expiry, chain in chains]
            items = [item for item in measured if item is not None]
            if len(items) < len(chains):
                summary["errors"][symbol] = f"{len(chains) - len(items)} of {len(chains)} expiries without usable quotes"
        except Exception as error:  # noqa: BLE001 - one failed symbol must not lose the other six
            summary["errors"][symbol] = f"{type(error).__name__}: {error}"
        summary["symbols"][symbol] = items
        log(symbol, summary["errors"].get(symbol, "ok"), [
            (item["expiry"], {name: None if value is None else round(value, 2) for name, value in item["halfSpreadPct"].items()},
             None if item["callSlope"] is None else round(item["callSlope"], 3),
             None if item["putSlope"] is None else round(item["putSlope"], 3)) for item in items])
    summary["complete"] = not summary["errors"]
    write_summary(out, summary)
    log(f"wrote {out / 'summary.json'} (complete: {summary['complete']})")
    return 0 if summary["complete"] else 1


def csv_rows(path: Path) -> list:
    def number(text: str) -> float:
        return float(text) if text else math.nan

    with path.open(newline="") as handle:
        return [SimpleNamespace(strike=number(row["strike"]), bid=number(row["bid"]), ask=number(row["ask"]))
                for row in csv.DictReader(handle)]


def remeasure(run: Path, log=print) -> int:
    """Computes summary.json of a stored run again from its CSV files and the stored spot prices."""
    old = json.loads((run / "summary.json").read_text())
    today = date.fromisoformat(old.get("day") or run.parent.name)
    spots = {symbol: items[0]["spot"] for symbol, items in old["symbols"].items() if items} | old.get("spots", {})
    summary = {**old, "schema": SCHEMA, "day": today.isoformat(), "remeasured": True, "spots": spots, "errors": {}, "symbols": {}}
    for symbol in SYMBOLS:
        expiries = sorted(path.name.removeprefix(f"{symbol}-").removesuffix("-calls.csv") for path in run.glob(f"{symbol}-*-calls.csv"))
        items = []
        if symbol in spots:
            measured = [measure(csv_rows(run / f"{symbol}-{expiry}-calls.csv"), csv_rows(run / f"{symbol}-{expiry}-puts.csv"),
                                spots[symbol], expiry, today) for expiry in expiries]
            items = [item for item in measured if item is not None]
        if not expiries or len(items) < len(expiries):
            summary["errors"][symbol] = f"{len(expiries) - len(items)} of {len(expiries)} expiries without usable quotes or spot"
        summary["symbols"][symbol] = items
    summary["complete"] = not summary["errors"]
    write_summary(run, summary)
    log(f"wrote {run / 'summary.json'} (complete: {summary['complete']})")
    return 0 if summary["complete"] else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--store", type=Path, help="snapshot store directory (local data, not committed)")
    group.add_argument("--remeasure", type=Path, metavar="RUN_DIR", help="one stored run directory: write its summary.json again")
    args = parser.parse_args()
    if args.remeasure is not None:
        return remeasure(args.remeasure.expanduser())
    import yfinance as yf

    return collect(yf.Ticker, datetime.now(timezone.utc), args.store.expanduser(),
                   f"Yahoo Finance via yfinance {yf.__version__}")


if __name__ == "__main__":
    sys.exit(main())
