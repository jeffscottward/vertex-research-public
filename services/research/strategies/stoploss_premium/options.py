"""Model option prices for tests B, C, D and F. Every option price here is a MODEL PRICE.

No source of historical option bid/ask exists in our data (the option-chain store starts 2026-11-11; paid
chain vendors are an owner cost decision, research/backtests/151-strategies/harness-evaluation.md). The model
reuses the repository's option model (`strategies.qc_ports.options`: Black-Scholes, linear skew in
standardized moneyness, per-ETF half-spreads, $0.65 commission per contract) with the market-watch-bot
income-sleeve conventions for names without an IV index (`market_watch/income/backtest.py` and `model.py`):
  * ATM IV: an ETF with a Cboe IV index uses that index (factor of `qc_ports.options.ATM_FACTOR`); any other
    name uses 1.15 x realized volatility, over 20 days below six months to expiry and 60 days from six
    months (a one-year option is not priced on a 20-day spike; this choice is ours);
  * skew slope: `qc_ports.options.SKEW`, else -0.20 (income model put slope);
  * half-spread: `qc_ports.options.HALF_SPREAD_PCT`, else 3% of the leg value for a single stock (income
    model) and 2% for another ETF; at least 1 cent;
  * rate = the day's 13-week T-bill yield (IRX) when the caller passes it, dividends 0; expiries are monthly (`qc_ports.calendar
    .monthly_expiration`: third Friday, the session before on an NYSE holiday). On the expiry session a
    position is valued at intrinsic value (the daily close stands in for the live 15:45 ET close).
  * an IV index level is carried forward over at most 5 sessions (`qc_ports.data.align`).

Values are per share and normalized per trade: a long structure costs 1 at entry (mid + costs).
"""
from __future__ import annotations

from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from functools import lru_cache

from strategies.qc_ports.calendar import expirations_after, monthly_expiration
from strategies.qc_ports.data import align
from strategies.qc_ports.options import (ATM_FACTOR, COMMISSION, HALF_SPREAD_PCT, MIN_HALF_SPREAD, MULTIPLIER, SKEW,
                                         bs_delta, bs_price, intrinsic, smile_iv, strike_step)

from .bars import Series, realized_vol

IV_INDEX = {"SPY": "VIX", "QQQ": "VXN", "IWM": "RVX", "DIA": "VXD", "GLD": "GVZ", "USO": "OVX", "SLV": "VXSLV"}
RV_FACTOR = 1.15
LONG_TENOR_YEARS = 0.5
MIN_IV = 0.08
STOCK_HALF_SPREAD = 0.03
ETF_HALF_SPREAD = 0.02
DEFAULT_SLOPE = -0.20
LEG_COMMISSION = COMMISSION / MULTIPLIER  # per share


@lru_cache(maxsize=None)
def expiration(year: int, month: int) -> date:
    """Standard monthly expiry of that month (qc_ports.calendar)."""
    return monthly_expiration(year, month)


@lru_cache(maxsize=None)
def monthly_expiries(start: date, months: int) -> tuple[date, ...]:
    """Monthly expiries on or after `start` (qc_ports.calendar.expirations_after)."""
    return tuple(expirations_after(start, months))


def leaps_expiry(today: date, min_days: int = 365) -> date:
    """First monthly expiry at least min_days away (live LEAPS rule: first standard expiry >= 12 months)."""
    return next(e for e in monthly_expiries(today, 16) if (e - today).days >= min_days)


def target_expiry(today: date, lo: int, hi: int, target: int) -> date | None:
    """Monthly expiry with lo <= days <= hi closest to target (ties: the nearer one)."""
    ok = [e for e in monthly_expiries(today, 4) if lo <= (e - today).days <= hi]
    return min(ok, key=lambda e: (abs((e - today).days - target), e)) if ok else None


def smile(atm: float, spot: float, strike: float, t: float, slope: float) -> float:
    return atm if t <= 0 else smile_iv(atm, spot, strike, t, slope)


@dataclass(frozen=True)
class Leg:
    right: str   # "call" or "put"
    strike: float
    qty: int     # +1 long, -1 short


@dataclass
class Underlying:
    """Raw (split-adjusted, no dividend) prices and the IV model of one name."""

    s: Series
    index_levels: dict[str, float] | None = None
    etf: bool = False
    spread_scale: float = 1.0  # sensitivity runs: half-spread x this factor
    rates: Sequence[float] | None = None  # annual risk-free rate per session (IRX); None = 0

    def __post_init__(self) -> None:
        f = [r / c for r, c in zip(self.s.raw_close, self.s.close)]
        self.open = [o * k for o, k in zip(self.s.open, f)]
        self.low = [lo * k for lo, k in zip(self.s.low, f)]
        self.high = [h * k for h, k in zip(self.s.high, f)]
        self.close = list(self.s.raw_close)
        self.factor = f
        self.dates = [date.fromisoformat(d) for d in self.s.dates]
        self.rv20 = realized_vol(self.close, 20)
        self.rv60 = realized_vol(self.close, 60)
        sym = self.s.symbol
        self.slope = SKEW.get(sym, DEFAULT_SLOPE)
        self.half = HALF_SPREAD_PCT.get(sym, ETF_HALF_SPREAD if self.etf else STOCK_HALF_SPREAD) * self.spread_scale
        self.index_id = IV_INDEX.get(sym) if self.index_levels else None
        self.index_by_session: list[float | None] = (
            align(self.index_levels, self.s.dates) if self.index_id and self.index_levels else [])

    def session_on_or_before(self, d: date) -> int:
        """Index of the last session on or before d."""
        return bisect_right(self.dates, d) - 1

    def atm(self, i: int, t: float) -> float | None:
        if self.index_id:
            level = self.index_by_session[i]
            return None if level is None else max(MIN_IV, ATM_FACTOR[self.index_id] * level / 100)
        rv = self.rv60[i] if t >= LONG_TENOR_YEARS else self.rv20[i]
        return None if rv is None else max(MIN_IV, RV_FACTOR * rv)

    def years(self, i: int, expiry: date) -> float:
        return max(0, (expiry - self.dates[i]).days) / 365

    def rate(self, i: int) -> float:
        # Floor at 0.0: Yahoo ^IRX dipped slightly negative in March 2020, and bs_price requires r >= 0.
        return max(0.0, self.rates[i]) if self.rates is not None else 0.0

    def leg_mid(self, leg: Leg, spot: float, t: float, atm: float, r: float = 0.0) -> float:
        if t <= 0:
            return intrinsic(leg.right, spot, leg.strike)
        iv = smile(atm, spot, leg.strike, t, self.slope)
        return bs_price(leg.right, spot, leg.strike, t, r, 0.0, iv)

    def quote(self, legs: Sequence[Leg], i: int, expiry: date, spot: float | None = None,
              atm: float | None = None, expiry_i: int | None = None) -> tuple[float, float] | None:
        """(mid, one-way cost) per share of the structure on day i (spot default: the close). The cost is the
        half-spread of every leg plus its commission. On the expiry session t = 0 (intrinsic)."""
        spot = self.close[i] if spot is None else spot
        t = 0.0 if expiry_i is not None and i >= expiry_i else self.years(i, expiry)
        if atm is None:
            atm = self.atm(i, t) if t > 0 else 0.0  # intrinsic value needs no volatility
        if atm is None:
            return None
        r = self.rate(i)
        mids = [self.leg_mid(leg, spot, t, atm, r) for leg in legs]
        value = sum(leg.qty * m for leg, m in zip(legs, mids))
        cost = sum(abs(leg.qty) * (max(MIN_HALF_SPREAD, self.half * m) + LEG_COMMISSION) for leg, m in zip(legs, mids))
        return value, cost


def delta_at(u: Underlying, i: int, expiry: date, right: str, strike: float) -> float | None:
    """Model delta (with skew and the day's rate) of one strike on day i."""
    t = u.years(i, expiry)
    atm = u.atm(i, t)
    if atm is None or t <= 0:
        return None
    spot = u.close[i]
    return bs_delta(right, spot, strike, t, u.rate(i), 0.0, smile(atm, spot, strike, t, u.slope))


def strike_for_delta(u: Underlying, i: int, expiry: date, right: str, target: float) -> float | None:
    """Strike whose model delta (with skew) is nearest `target` (call > 0, put < 0), on the qc-ports strike grid."""
    spot = u.close[i]
    t = u.years(i, expiry)
    atm = u.atm(i, t)
    if atm is None or t <= 0:
        return None

    r = u.rate(i)

    def delta(k: float) -> float:
        return bs_delta(right, spot, k, t, r, 0.0, smile(atm, spot, k, t, u.slope))

    lo, hi = spot * 0.2, spot * 3.0
    for _ in range(60):  # delta falls as the strike rises, for calls and puts alike
        mid = (lo + hi) / 2
        if delta(mid) > target:
            lo = mid
        else:
            hi = mid
    k = (lo + hi) / 2
    step = strike_step(spot)
    near = [k // step * step, -(-k // step) * step]
    return min((x for x in near if x > 0), key=lambda x: abs(delta(x) - target), default=None)


@dataclass
class Trade:
    """One long structure: its legs, entry, planned exit (the leg without the rule) and daily model mids."""

    u: Underlying
    legs: tuple[Leg, ...]
    expiry: date
    expiry_i: int
    entry_i: int
    exit_i: int
    debit: float              # mid + cost at entry, per share
    mids: list[float]         # mid per share on entry_i..exit_i

    def mid(self, i: int) -> float:
        return self.mids[i - self.entry_i]


def open_trade(u: Underlying, legs: Sequence[Leg], i: int, expiry: date, *, last_chance: int = 0) -> Trade | None:
    """Price a long structure bought at the close of day i, held without a rule until `last_chance` sessions
    before the expiry session (0 = the expiry session itself)."""
    if expiry > u.dates[-1]:
        return None  # the data ends before the expiry session
    expiry_i = u.session_on_or_before(expiry)
    exit_i = expiry_i - last_chance
    if exit_i <= i:
        return None
    mids = []
    for d in range(i, exit_i + 1):
        q = u.quote(legs, d, expiry, expiry_i=expiry_i)
        if q is None:
            return None
        mids.append(q[0])
    q0 = u.quote(legs, i, expiry, expiry_i=expiry_i)
    if q0 is None or q0[0] <= 0:
        return None
    return Trade(u, tuple(legs), expiry, expiry_i, i, exit_i, q0[0] + q0[1], mids)


def bid(trade: Trade, i: int, spot: float | None = None) -> float:
    """Sale price per share on day i: mid - cost, never below 0. With `spot` (an intraday fill at that
    underlying price) the volatility is the one known at the previous close, so the fill uses no later data."""
    atm = None
    if spot is not None and i > 0:
        atm = trade.u.atm(i - 1, trade.u.years(i, trade.expiry))
    q = trade.u.quote(trade.legs, i, trade.expiry, spot=spot, atm=atm, expiry_i=trade.expiry_i)
    return max(0.0, q[0] - q[1]) if q else 0.0
