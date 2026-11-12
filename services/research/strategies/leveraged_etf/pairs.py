"""Pair table of the leveraged-ETF short-window study (research only; it never places orders).

One pair = an unleveraged ETF U with intraday data, the fund that targets +L x the daily move of U's
benchmark (long fund), the fund that targets -L x (inverse fund), the multiple L and the Cboe IV index
of U. The table is pre-registered (research/backtests/leveraged-etf/README.md): it is not chosen from
results. A pair is dropped only when its data cannot be loaded.

Pure constants and lookups. No file, no network, no numpy.
"""
from __future__ import annotations

from dataclasses import dataclass

__all__ = ["BY_UNDERLYING", "PAIRS", "Pair", "fund_symbols", "pair_of_fund", "signed_leverage", "underlyings"]


@dataclass(frozen=True)
class Pair:
    underlying: str
    long_fund: str
    inverse_fund: str
    leverage: int
    iv_index: str

    def __post_init__(self) -> None:
        if isinstance(self.leverage, bool) or not isinstance(self.leverage, int) or self.leverage < 2:
            raise ValueError("leverage must be an integer multiple of at least 2")
        if len({self.underlying, self.long_fund, self.inverse_fund}) != 3:
            raise ValueError("underlying, long fund and inverse fund must be three symbols")

    @property
    def funds(self) -> tuple[str, str]:
        return self.long_fund, self.inverse_fund


PAIRS: tuple[Pair, ...] = (
    Pair("QQQ", "TQQQ", "SQQQ", 3, "VXN"),
    Pair("SPY", "UPRO", "SPXU", 3, "VIX"),
    Pair("IWM", "TNA", "TZA", 3, "RVX"),
    Pair("DIA", "UDOW", "SDOW", 3, "VXD"),
    Pair("GLD", "UGL", "GLL", 2, "GVZ"),
    Pair("SLV", "AGQ", "ZSL", 2, "VXSLV"),
    Pair("USO", "UCO", "SCO", 2, "OVX"),
)
BY_UNDERLYING: dict[str, Pair] = {pair.underlying: pair for pair in PAIRS}
_BY_FUND: dict[str, Pair] = {fund: pair for pair in PAIRS for fund in pair.funds}


def underlyings() -> tuple[str, ...]:
    return tuple(pair.underlying for pair in PAIRS)


def fund_symbols() -> tuple[str, ...]:
    """Every fund of the table: the long fund, then the inverse fund, pair by pair."""
    return tuple(fund for pair in PAIRS for fund in pair.funds)


def pair_of_fund(fund: str) -> Pair:
    if fund not in _BY_FUND:
        raise ValueError(f"{fund} is not a fund of the pair table")
    return _BY_FUND[fund]


def signed_leverage(fund: str) -> int:
    """+L for a long fund, -L for an inverse fund."""
    pair = pair_of_fund(fund)
    return pair.leverage if fund == pair.long_fund else -pair.leverage
