"""Fund prices of the leveraged-ETF short-window study (research only; it never places orders).

- Daily fund bars are the files of research/backtests/leveraged-etf/fetch_data.py (Yahoo): `close` is
  split-adjusted. Strikes and premiums need the price that TRADED on the day, so every later split is
  undone: as-traded close = close x the product of the ratios of all splits after that day
  (qc_ports.forms.raw_factors). A split-adjusted TQQQ price of 2010 is cents and breaks the strike grid.
- A fund has no intraday history here. Its price at an intraday entry is modeled:
  fund previous close x (1 + leverage x (U entry price / U previous close - 1)), leverage signed
  (+3 TQQQ, -3 SQQQ). The fund follows U's TOTAL return, not its price return: on U's ex-dividend day
  U opens lower by the dividend and the fund does not. So on that day the dividend is added back to U's
  price: fund previous close x (1 + leverage x ((U entry price + dividend) / U previous close - 1)).
- U's dividends are read from U's daily file (`dividends`): the file has no dividend column, but
  `adj_close / close` steps on every ex-dividend date by the factor 1 - dividend / previous close.
- `tracking_error` measures this formula at the close, where the real price is known: synthetic close
  against real close, per fund, and on U's ex-dividend days with and without the dividend.
- A trade whose window holds a split of its instrument is not priced (`split_between`).

Pure Python. Files are read only by `load_splits` and `load_fund`.
"""
from __future__ import annotations

import bisect
import csv
import math
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from strategies.qc_ports.data import load_bars
from strategies.qc_ports.forms import raw_factors

__all__ = ["MIN_DIVIDEND_YIELD", "PRICE_DECIMALS", "FundBars", "as_traded", "dividends", "load_fund", "load_splits",
           "percentile", "split_between", "synthetic_price", "tracking_error"]

PRICE_DECIMALS = 4
# A step of adj_close / close below this share of the previous close is rounding of the file (6 decimals), not
# a dividend. On the rig files the rounding is at most 2.2e-6 and the smallest dividend is 1.7e-4 (DIA).
MIN_DIVIDEND_YIELD = 1e-5


@dataclass(frozen=True)
class FundBars:
    """Daily as-traded closes of one fund in date order, and its splits (effective date, ratio)."""

    symbol: str
    dates: tuple[str, ...]
    close: tuple[float, ...]
    splits: tuple[tuple[str, float], ...] = ()

    def __post_init__(self) -> None:
        if len(self.dates) != len(self.close):
            raise ValueError("FundBars columns must have the same length")
        if any(later <= earlier for earlier, later in zip(self.dates, self.dates[1:])):
            raise ValueError("FundBars dates must be strictly increasing")
        if not all(math.isfinite(value) and value > 0 for value in self.close):
            raise ValueError("FundBars closes must be finite and above 0")

    def __len__(self) -> int:
        return len(self.dates)

    def close_on(self, day: str) -> float | None:
        index = bisect.bisect_left(self.dates, day)
        return self.close[index] if index < len(self.dates) and self.dates[index] == day else None


def as_traded(dates: Sequence[str], closes: Sequence[float], splits: Mapping[str, float]) -> list[float]:
    """The close that traded on each date: split-adjusted close x the ratios of every later split."""
    if len(dates) != len(closes):
        raise ValueError("dates and closes must have the same length")
    return [round(close * factor, PRICE_DECIMALS) for close, factor in zip(closes, raw_factors(dates, splits))]


def load_splits(symbol: str, root: str | os.PathLike) -> dict[str, float]:
    """Effective date -> ratio of every split of `symbol` (`<SYMBOL>.splits.csv` of the fetch)."""
    path = Path(root) / f"{symbol}.splits.csv"
    with path.open(newline="") as handle:
        splits = {row["date"]: float(row["ratio"]) for row in csv.DictReader(handle)}
    if not all(math.isfinite(ratio) and ratio > 0 for ratio in splits.values()):
        raise ValueError(f"{path.name}: a split ratio must be finite and above 0")
    return splits


def load_fund(symbol: str, root: str | os.PathLike) -> FundBars:
    """The fund's daily bars at as-traded prices (`<SYMBOL>.csv` and `<SYMBOL>.splits.csv` in `root`)."""
    bars = load_bars(symbol, root)
    splits = load_splits(symbol, root)
    return FundBars(symbol, bars.dates, tuple(as_traded(bars.dates, bars.close, splits)), tuple(sorted(splits.items())))


def split_between(splits: Sequence[tuple[str, float]] | Mapping[str, float], after: str, through: str) -> bool:
    """True when a split is effective after day `after` and on or before day `through`."""
    days = splits if isinstance(splits, Mapping) else [day for day, _ in splits]
    return any(after < day <= through for day in days)


def dividends(dates: Sequence[str], closes: Sequence[float], adj_closes: Sequence[float]) -> dict[str, float]:
    """Ex-dividend date -> cash dividend per share, in the units of `closes`, from a daily file whose
    `adj_close` is the close adjusted for dividends (the qc-ports format: Yahoo). The factor
    adj_close / close of the day before an ex-dividend date is the factor of that date x
    (1 - dividend / previous close); every other day keeps the factor. So
    dividend = previous close x (1 - previous factor / factor). A step below MIN_DIVIDEND_YIELD is the
    rounding of the file and gives no dividend."""
    if not (len(dates) == len(closes) == len(adj_closes)):
        raise ValueError("dates, closes and adjusted closes must have the same length")
    if not all(math.isfinite(value) and value > 0 for column in (closes, adj_closes) for value in column):
        raise ValueError("closes and adjusted closes must be finite and above 0")
    out: dict[str, float] = {}
    for index in range(1, len(dates)):
        share = 1 - (adj_closes[index - 1] / closes[index - 1]) / (adj_closes[index] / closes[index])
        if share > MIN_DIVIDEND_YIELD:
            out[dates[index]] = closes[index - 1] * share
    return out


def synthetic_price(previous_close: float, leverage: float, u_price: float, u_previous_close: float,
                    u_dividend: float = 0.0) -> float | None:
    """Modeled fund price while U trades at `u_price`: the daily-reset formula from the previous closes.
    `u_dividend` = U's cash dividend when the day is U's ex-dividend date (else 0): it is added back to
    `u_price`, because the fund follows U's total return. None when the formula gives a price of 0 or
    less (a move that wipes the fund out)."""
    values = (previous_close, leverage, u_price, u_previous_close, u_dividend)
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in values):
        raise ValueError("synthetic_price needs finite numbers")
    if not (previous_close > 0 and u_price > 0 and u_previous_close > 0):
        raise ValueError("prices must be above 0")
    if u_dividend < 0:
        raise ValueError("a dividend cannot be negative")
    price = previous_close * (1 + leverage * ((u_price + u_dividend) / u_previous_close - 1))
    return price if price > 0 else None


def percentile(ordered: Sequence[float], q: float) -> float:
    """Linear-interpolation percentile of an ascending list (q in 0..1)."""
    if not ordered:
        raise ValueError("percentile of an empty list")
    position = (len(ordered) - 1) * q
    low = math.floor(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def tracking_error(fund: FundBars, leverage: float, u_dates: Sequence[str], u_closes: Sequence[float],
                   u_splits: Mapping[str, float] | None = None, u_dividends: Mapping[str, float] | None = None
                   ) -> dict | None:
    """Error of `synthetic_price` at the close, in percent of the real close: for every pair of
    consecutive fund sessions that U also has (no split of the fund or of U between them), the
    synthetic close from the previous closes against the real close. Median, 95th percentile and
    largest absolute error of the formula the study uses (U's dividend added back on its ex-dividend
    date). `exDividend` = the same on U's ex-dividend days alone, as the median SIGNED error (below 0 =
    the synthetic price is too low): `medianErrorPct` with the dividend, `medianErrorNoDividendPct`
    with U's price return only (the formula before the correction); None when U has no such day.
    None without a usable day."""
    u_close = dict(zip(u_dates, u_closes))
    paid = u_dividends or {}
    errors: list[float] = []
    with_dividend: list[float] = []
    without_dividend: list[float] = []
    first = last = None
    for index in range(1, len(fund)):
        before, day = fund.dates[index - 1], fund.dates[index]
        if before not in u_close or day not in u_close:
            continue
        if split_between(fund.splits, before, day) or split_between(u_splits or {}, before, day):
            continue
        dividend = paid.get(day, 0.0)
        modeled = synthetic_price(fund.close[index - 1], leverage, u_close[day], u_close[before], dividend)
        if modeled is None:
            continue
        errors.append(abs(modeled / fund.close[index] - 1) * 100)
        first = first or day
        last = day
        if day in paid:
            plain = synthetic_price(fund.close[index - 1], leverage, u_close[day], u_close[before])
            if plain is not None:
                with_dividend.append((modeled / fund.close[index] - 1) * 100)
                without_dividend.append((plain / fund.close[index] - 1) * 100)
    if not errors:
        return None
    errors.sort()
    ex_dividend = None
    if with_dividend:
        ex_dividend = {"days": len(with_dividend), "medianErrorPct": percentile(sorted(with_dividend), 0.5),
                       "medianErrorNoDividendPct": percentile(sorted(without_dividend), 0.5)}
    return {"fund": fund.symbol, "leverage": leverage, "days": len(errors), "from": first, "to": last,
            "medianAbsErrorPct": percentile(errors, 0.5), "p95AbsErrorPct": percentile(errors, 0.95),
            "maxAbsErrorPct": errors[-1], "exDividend": ex_dividend}
