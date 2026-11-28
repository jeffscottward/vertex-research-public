"""Noise-band signal expressed with SPY 0DTE options (variant 2 of the re-test). Research only.

The signal is the primary stock run's round trips (same day, side, entry and exit minute). Each round trip
becomes one defined-risk option trade on the same-day expiry, priced from real bid/ask quotes:

- Instrument A ("single", the verdict): buy the nearest-to-the-money call (long signal) or put (short
  signal) at the ask at the entry minute; sell it at the bid at the exit minute. An exact strike tie goes
  out of the money. Owner exit rule (2026-11-03): an option still open 15 minutes before the close on expiry
  day is closed then, never exercised (15:45; 12:45 on a 13:00 half-day), so later stock exits sell at that
  quote. A zero or missing exit bid counts as 0.
- Instrument B ("vertical"): buy the ATM strike at the ask and sell the strike `width` further out of the
  money at the bid; close with the long's bid minus the short's ask (a missing short ask counts as its
  intrinsic value + 0.05). Closing at quotes can cost slightly more than the debit; this is reported.

Size: contracts = floor(cap × equity at the start of the day / (debit × 100)), cap = 2% (owner per-name
premium cap), so the premium paid per trade is at most 2% of equity; commission is outside the cap. A trade
is skipped (and counted by reason) only when it cannot be entered: no expiry, no entry quote, no wing strike,
a non-positive vertical debit, or one contract costing more than the cap. Commission USD 0.65 per contract
per side.

The quote source is pluggable (QuoteBook); quotes are keyed by session minute (minutes from 09:30 ET).
FileQuoteBook reads the quotes that the QuantVPS collector stores each trading day since 2026-11-19
(infra/quant-vps/odte-quotes).
"""
from __future__ import annotations

import csv
import gzip
import math
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Literal, Protocol, Sequence
from zoneinfo import ZoneInfo

from strategies.noise_band import BacktestResult, DayResult, Params, Trade

Instrument = Literal["single", "vertical"]
NEW_YORK = ZoneInfo("America/New_York")
STALE_FLAT_MINUTES = 30
STALE_ASK_FLOOR = 0.10
STALE_CROSSED_CONTRACT_MINUTES = 10
STALE_DAY_FRACTION = 0.20

class QuoteBook(Protocol):
    def strikes(self, day: date) -> Sequence[float]:
        """Listed strikes of the expiry that settles on `day` (empty: no 0DTE expiry that day)."""
        ...

    def quote(self, day: date, minute: int, right: str, strike: float) -> tuple[float, float] | None:
        """(bid, ask) of the 0DTE contract at the session minute, or None when no quote exists."""
        ...


@dataclass(frozen=True)
class OptionParams:
    instrument: Instrument = "single"
    premium_cap: float = 0.02
    commission_per_contract: float = 0.65
    width: float = 5.0
    aum0: float = 100_000.0


def nearest_strike(strikes: Sequence[float], price: float, right: str = "C") -> float:
    """Nearest listed strike; an exact tie goes out of the money (higher for calls, lower for puts)."""
    if right == "C":
        return min(strikes, key=lambda k: (abs(k - price), -k))
    return min(strikes, key=lambda k: (abs(k - price), k))


def last_exit_minute(close_minute: int) -> int:
    """15 minutes before the session close: 375 (15:45) on a full day, 195 (12:45) on a 13:00 half-day."""
    return close_minute - 15


def _intrinsic(right: str, strike: float, underlying: float) -> float:
    return max(underlying - strike, 0.0) if right == "C" else max(strike - underlying, 0.0)


def _is_stale_quote(book: QuoteBook, day: date, minute: int, right: str, strike: float,
                    q: tuple[float, float] | None) -> bool:
    if q is not None and q[1] < q[0]:
        return True
    checker = getattr(book, "is_stale", None)
    return bool(checker and checker(day, minute, right, strike))


def price_trade(book: QuoteBook, t: Trade, u_entry: float, u_exit: float, equity: float, p: OptionParams,
                close_minute: int = 390) -> tuple[Trade | None, str]:
    """One stock round trip -> one option round trip. Returns (trade, "ok") or (None, skip reason).

    u_entry / u_exit: raw underlying price at the entry / exit quote minute (the open of the bar that starts
    then). Quote minute m means the quote as of 09:30 + m minutes. Crossed or stale entry/exit quotes skip
    the trade as "stale_quote" (never pricing a bad quote at 0 credit). Otherwise, once entered, a missing
    exit bid counts as 0 and a missing short-leg exit ask as intrinsic value + 0.05."""
    strikes = book.strikes(t.day)
    if not strikes:
        return None, "no_expiry"
    right = "C" if t.side > 0 else "P"
    k = nearest_strike(strikes, u_entry, right)
    cap = last_exit_minute(close_minute)
    em, xm = min(t.entry_minute, cap), min(t.exit_minute, cap)
    if t.entry_minute >= cap:
        return None, "entry_after_last_exit"
    q_in = book.quote(t.day, em, right, k)
    if _is_stale_quote(book, t.day, em, right, k, q_in):
        return None, "stale_quote"
    if q_in is None or q_in[1] <= 0:
        return None, "no_entry_quote"
    missing_exit = False
    if p.instrument == "single":
        debit = q_in[1]
        q_out = book.quote(t.day, xm, right, k)
        if _is_stale_quote(book, t.day, xm, right, k, q_out):
            return None, "stale_quote"
        missing_exit = q_out is None
        credit = max(q_out[0], 0.0) if q_out else 0.0
        legs = 1
    else:
        k2 = k + p.width if right == "C" else k - p.width
        if k2 not in set(strikes):
            return None, "no_wing_strike"
        s_in = book.quote(t.day, em, right, k2)
        if _is_stale_quote(book, t.day, em, right, k2, s_in):
            return None, "stale_quote"
        if s_in is None:
            return None, "no_entry_quote"
        debit = q_in[1] - s_in[0]
        if debit <= 0:
            return None, "nonpositive_debit"
        l_out = book.quote(t.day, xm, right, k)
        s_out = book.quote(t.day, xm, right, k2)
        if _is_stale_quote(book, t.day, xm, right, k, l_out) or _is_stale_quote(book, t.day, xm, right, k2, s_out):
            return None, "stale_quote"
        missing_exit = l_out is None or s_out is None
        long_bid = max(l_out[0], 0.0) if l_out else 0.0
        short_ask = s_out[1] if s_out else _intrinsic(right, k2, u_exit) + 0.05
        credit = long_bid - short_ask
        legs = 2
    n = math.floor(p.premium_cap * equity / (debit * 100.0))
    if n < 1:
        return None, "too_expensive_for_cap"
    gross = n * 100.0 * (credit - debit)
    cost = 2 * legs * n * p.commission_per_contract
    tag = f"{t.exit_reason}:{right}{k:g}" + (":exit_quote_missing" if missing_exit else "")
    return Trade(t.day, t.side, n, t.entry_minute, debit, xm, credit, tag, gross, cost), "ok"


def run_options(stock: BacktestResult, prices: dict[tuple[date, int], float], close_minutes: dict[date, int],
                book: QuoteBook, days: Sequence[date], p: OptionParams = OptionParams()) -> tuple[BacktestResult, dict]:
    """Option equity curve over `days` (sessions with a 0DTE expiry and quotes). Days without a priced trade
    return 0. Sizing uses equity at the start of each day.

    prices[(day, minute)]: raw open of the stock bar that starts at that minute (no slippage).
    close_minutes[day]: 390 on a full day, 210 on a 13:00 half-day."""
    by_day: dict[date, list[Trade]] = {}
    for t in stock.trades:
        by_day.setdefault(t.day, []).append(t)
    day_set = set(days)
    res = BacktestResult(Params(aum0=p.aum0))
    aum = p.aum0
    counts: dict[str, int] = {"outside_option_days": sum(len(v) for d, v in by_day.items() if d not in day_set),
                              "exit_quote_missing": 0}
    for d in days:
        start = aum
        priced: list[Trade] = []
        close = close_minutes[d]  # required: a missing half-day would otherwise exit after its close
        for t in by_day.get(d, []):
            u_in = prices.get((d, t.entry_minute))
            xm = min(t.exit_minute, last_exit_minute(close))
            u_out = prices.get((d, xm), u_in)
            if u_in is None:
                counts["no_underlying_price"] = counts.get("no_underlying_price", 0) + 1
                continue
            ot, why = price_trade(book, t, u_in, u_out, start, p, close)
            if ot is None:
                counts[why] = counts.get(why, 0) + 1
                continue
            counts["exit_quote_missing"] += ot.exit_reason.endswith(":exit_quote_missing")
            priced.append(ot)
        pnl = sum(x.net for x in priced)
        res.days.append(DayResult(d, start, start + pnl, 0.0, bool(priced)))
        res.trades.extend(priced)
        aum = start + pnl
    return res, counts


class FileQuoteBook:
    """QuoteBook over the files of the QuantVPS SPY 0DTE collector (infra/quant-vps/odte-quotes/odte_quotes.py).

    Layout: <root>/<YYYY-MM-DD>/status.txt (state=complete|no_expiry|partial), manifest.csv (file, right,
    strike, ...) and one SPY-<YYYYMMDD>-<C|P>-<strike>.csv.gz per contract with the columns epoch, bid_open,
    bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close (1-min bars, epoch = bar start).
    Only days with state=complete and healthy in-range quotes count (`days()`); a partial, missing, or
    stale-session day has no strikes (excluded sessions are listed in `excluded_days()`). The quote at
    session minute m is the open of the BID and ASK bars that start at 09:30 ET + m minutes; a bar with a
    blank side gives None. Crossed minutes (ask < bid) and sustained flat non-penny runs (>=30 consecutive
    flat minutes with ask > $0.10) are flagged via `is_stale()`. Files load on first use and stay cached."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self._strikes: dict[date, list[float]] = {}
        self._files: dict[date, dict[tuple[str, float], str]] = {}
        self._excluded: dict[date, str | None] = {}
        self._quotes: dict[tuple[date, str, float], dict[int, tuple[float, float]]] = {}
        self._stale: dict[tuple[date, str, float], set[int]] = {}

    def _complete_dates(self) -> list[date]:
        out = []
        for p in sorted(self.root.glob("????-??-??")):
            if _status(p).get("state") == "complete":
                out.append(date.fromisoformat(p.name))
        return out

    def days(self) -> list[date]:
        """Complete, non-excluded days, oldest first."""
        return [d for d in self._complete_dates() if self._inspect_day(d) is None]

    def excluded_days(self) -> dict[date, str]:
        """Complete days excluded by the stale-session rule, oldest first."""
        out: dict[date, str] = {}
        for d in self._complete_dates():
            reason = self._inspect_day(d)
            if reason is not None:
                out[d] = reason
        return out

    def _inspect_day(self, day: date) -> str | None:
        if day in self._excluded:
            return self._excluded[day]
        folder = self.root / day.isoformat()
        status = _status(folder)
        files: dict[tuple[str, float], str] = {}
        if status.get("state") == "complete" and (folder / "manifest.csv").exists():
            with (folder / "manifest.csv").open(newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    files[(row["right"], float(row["strike"]))] = row["file"]
        reason: str | None = None
        loaded_quotes: dict[tuple[date, str, float], dict[int, tuple[float, float]]] = {}
        loaded_stale: dict[tuple[date, str, float], set[int]] = {}
        if files:
            low_s, high_s = status.get("low"), status.get("high")
            if low_s is not None and high_s is not None:
                lo, hi = math.floor(float(low_s)), math.ceil(float(high_s))
                core = [k for k in files if lo <= k[1] <= hi]
            else:
                core = list(files)
            bad_core = 0
            for right, strike in core:
                key = (day, right, strike)
                quotes, crossed, flat = _load_contract(folder / files[(right, strike)], day)
                loaded_quotes[key] = quotes
                loaded_stale[key] = crossed | flat
                if flat or len(crossed) >= STALE_CROSSED_CONTRACT_MINUTES:
                    bad_core += 1
            if core and (bad_core / len(core)) >= STALE_DAY_FRACTION:
                reason = f"stale_session ({bad_core}/{len(core)} in-range contracts frozen/crossed)"
        self._excluded[day] = reason
        if reason is not None:
            self._files[day] = {}
            self._strikes[day] = []
        else:
            self._quotes.update(loaded_quotes)
            self._stale.update(loaded_stale)
            self._files[day] = files
            self._strikes[day] = sorted({k for _, k in files})
        return reason

    def _manifest(self, day: date) -> dict[tuple[str, float], str]:
        if day not in self._files:
            self._inspect_day(day)
        return self._files[day]

    def _ensure_loaded(self, day: date, right: str, strike: float) -> tuple[date, str, float]:
        key = (day, right, float(strike))
        if key not in self._quotes:
            name = self._manifest(day).get((right, float(strike)))
            if name:
                quotes, crossed, flat = _load_contract(self.root / day.isoformat() / name, day)
                self._quotes[key] = quotes
                self._stale[key] = crossed | flat
            else:
                self._quotes[key] = {}
                self._stale[key] = set()
        return key

    def strikes(self, day: date) -> Sequence[float]:
        self._manifest(day)
        return self._strikes[day]

    def quote(self, day: date, minute: int, right: str, strike: float) -> tuple[float, float] | None:
        key = self._ensure_loaded(day, right, strike)
        return self._quotes[key].get(minute)

    def is_stale(self, day: date, minute: int, right: str, strike: float) -> bool:
        key = self._ensure_loaded(day, right, strike)
        return minute in self._stale[key]


def _status(folder: Path) -> dict[str, str]:
    path = folder / "status.txt"
    if not path.exists():
        return {}
    return dict(line.split("=", 1) for line in path.read_text(encoding="utf-8").splitlines() if "=" in line)


def _load_contract(path: Path, day: date) -> tuple[dict[int, tuple[float, float]], set[int], set[int]]:
    """Session minute -> (bid open, ask open), plus crossed minutes (ask < bid) and sustained-flat minutes
    (>= STALE_FLAT_MINUTES consecutive flat session minutes with ask > STALE_ASK_FLOOR)."""
    open_ts = int(datetime(day.year, day.month, day.day, 9, 30, tzinfo=NEW_YORK).timestamp())
    out: dict[int, tuple[float, float]] = {}
    crossed: set[int] = set()
    flat: set[int] = set()
    run_mins: list[int] = []
    prev_m: int | None = None
    prev_pair: tuple[float, float] | None = None
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if not row["bid_open"] or not row["ask_open"]:
                continue
            minute, rest = divmod(int(row["epoch"]) - open_ts, 60)
            if minute < 0 or rest != 0:
                continue
            bid, ask = float(row["bid_open"]), float(row["ask_open"])
            out[minute] = (bid, ask)
            if ask < bid:
                crossed.add(minute)
            bc_s, ac_s = row.get("bid_close", ""), row.get("ask_close", "")
            is_flat_bar = (
                ask > STALE_ASK_FLOOR
                and (not bc_s or float(bc_s) == bid)
                and (not ac_s or float(ac_s) == ask)
            )
            if is_flat_bar and prev_m is not None and minute == prev_m + 1 and (bid, ask) == prev_pair:
                run_mins.append(minute)
            else:
                if len(run_mins) >= STALE_FLAT_MINUTES:
                    flat.update(run_mins)
                run_mins = [minute] if is_flat_bar else []
            prev_m = minute
            prev_pair = (bid, ask)
    if len(run_mins) >= STALE_FLAT_MINUTES:
        flat.update(run_mins)
    return out, crossed, flat


def _load_quotes(path: Path, day: date) -> dict[int, tuple[float, float]]:
    """Session minute -> (bid open, ask open) for bars from 09:30 ET; rows with a blank side are dropped."""
    return _load_contract(path, day)[0]
