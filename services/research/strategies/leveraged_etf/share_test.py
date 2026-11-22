"""Share-test table of the leveraged-ETF short-window study (research only; it never places orders).

A separate table, not the pre-registered 7-pair table of pairs.py: signal S1 on SOXX, TSLA and NVDA, traded
as shares (docs/specs/research/leveraged-etf-share-test.md). Method decisions: the trading knowledge bases,
2026-11-22 (decision record in the card's report folder). The 7-pair study, its 40 rows and N_TRIALS stay as
they are.

One book = one pair from its primary start (the first session at which both funds have their current
multiple). The primary books trade `etf-shares` and `lev-shares`; the supporting books trade only
`lev-shares` with the inverse fund that has the longest history at the target multiple.

Pure constants and lookups. No file, no network, no numpy.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import metrics, signals
from .pairs import Pair

__all__ = ["BOOKS", "BY_NAME", "CONTROL_FORM", "ETF_SHARES", "LEV_SHARES", "PRIOR_TRIALS", "SCHEMA", "ShareBook",
           "N_TRIALS", "baseline_key", "book_key", "fund_symbols", "row_keys", "signed_leverage", "split_book_key",
           "twin_key", "underlyings"]

SCHEMA = "leveraged-etf-share-test-v1"
ETF_SHARES = "etf-shares"
LEV_SHARES = "lev-shares"
CONTROL_FORM = "always-long"
PRIOR_TRIALS = 40  # the rows of the 7-pair study (runner.N_TRIALS), tested on the same signal family
BOOK_SEPARATOR = ":"


@dataclass(frozen=True)
class ShareBook:
    name: str
    pair: Pair
    start: str  # first signal day of the book (ISO date)
    forms: tuple[str, ...]
    primary: bool

    def __post_init__(self) -> None:
        if BOOK_SEPARATOR in self.name or metrics.KEY_SEPARATOR in self.name:
            raise ValueError(f"book name {self.name!r} must not hold {BOOK_SEPARATOR!r} or {metrics.KEY_SEPARATOR!r}")
        if not self.forms or any(form not in (ETF_SHARES, LEV_SHARES) for form in self.forms):
            raise ValueError("a book trades etf-shares and/or lev-shares only")


_BOTH = (ETF_SHARES, LEV_SHARES)
BOOKS: tuple[ShareBook, ...] = (
    ShareBook("SOXX", Pair("SOXX", "SOXL", "SOXS", 3, ""), "2010-03-12", _BOTH, True),
    ShareBook("TSLA", Pair("TSLA", "TSLL", "TSDD", 2, ""), "2024-04-02", _BOTH, True),
    ShareBook("NVDA", Pair("NVDA", "NVDL", "NVD", 2, ""), "2024-01-24", _BOTH, True),
    ShareBook("TSLA-TSLZ", Pair("TSLA", "TSLL", "TSLZ", 2, ""), "2024-04-02", (LEV_SHARES,), False),
    ShareBook("NVDA-NVDQ", Pair("NVDA", "NVDL", "NVDQ", 2, ""), "2024-01-24", (LEV_SHARES,), False),
)
BY_NAME: dict[str, ShareBook] = {book.name: book for book in BOOKS}
WINDOWS = tuple(signals.WINDOWS)  # 24h, 48h


def book_key(book: str, row: str) -> str:
    return f"{book}{BOOK_SEPARATOR}{row}"


def split_book_key(key: str) -> tuple[str, str]:
    book, sep, row = key.partition(BOOK_SEPARATOR)
    if not sep or book not in BY_NAME:
        raise ValueError(f"Not a share-test row key: {key}")
    return book, row


def row_keys(book: ShareBook) -> list[str]:
    """The tested rows of one book (without the control rows): S1 x regime x window x form."""
    return [book_key(book.name, metrics.row_key(signals.S1, regime, window, form))
            for regime in signals.REGIMES for window in WINDOWS for form in book.forms]


N_TRIALS = PRIOR_TRIALS + sum(len(row_keys(book)) for book in BOOKS)


def baseline_key(key: str) -> str | None:
    """The row whose Sharpe a row must beat: `etf-shares` of the same primary book for `lev-shares`, the
    always-long control for `etf-shares`, None for the control itself."""
    name, row = split_book_key(key)
    signal, regime, window, form = metrics.split_key(row)
    if form == CONTROL_FORM:
        return None
    if form == LEV_SHARES:
        primary = next(book.name for book in BOOKS if book.primary and book.pair.underlying == BY_NAME[name].pair.underlying)
        return book_key(primary, metrics.row_key(signal, regime, window, ETF_SHARES))
    return book_key(name, metrics.row_key(signal, regime, window, CONTROL_FORM))


def twin_key(key: str) -> str | None:
    """The unleveraged twin of a `lev-shares` row (its `etf-shares` row), None for other rows."""
    _, row = split_book_key(key)
    return baseline_key(key) if metrics.split_key(row)[3] == LEV_SHARES else None


def fund_symbols() -> tuple[str, ...]:
    """Every fund of the table once, in table order."""
    return tuple(dict.fromkeys(fund for book in BOOKS for fund in book.pair.funds))


def underlyings() -> tuple[str, ...]:
    return tuple(dict.fromkeys(book.pair.underlying for book in BOOKS))


def signed_leverage(fund: str) -> int:
    for book in BOOKS:
        if fund == book.pair.long_fund:
            return book.pair.leverage
        if fund == book.pair.inverse_fund:
            return -book.pair.leverage
    raise ValueError(f"{fund} is not a fund of the share-test table")
