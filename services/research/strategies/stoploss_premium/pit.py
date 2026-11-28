"""Point-in-time (PIT) survivorship-free equity universe and delisting accounting (pure Python, no network).

Loads historical index constituent snapshots (`date,tickers`, e.g. S&P 500 historical components) and restricts
share holding windows and option entry signals to intervals when each ticker was actually in the index.
Explicitly tracks removed-still-trading constituents, delisted constituents, missing constituents and optional
distress-delisting terminal haircuts so survivorship bias is measured rather than hidden.
"""
from __future__ import annotations

from bisect import bisect_right
from collections.abc import Callable, Sequence
import csv
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from . import entries
from .bars import Series
from .portfolio import PathReturns

DISTRESS_PRICE = 5.0
DISTRESS_DRAWDOWN = 0.50
DELIST_GAP_SESSIONS = 10


def normalize_symbol(symbol: str) -> str:
    """Normalize Yahoo/index ticker spelling (`BRK.B` -> `BRK-B`, uppercase, trimmed)."""
    return symbol.strip().upper().replace(".", "-")


@dataclass(frozen=True)
class PitMembership:
    """Point-in-time index constituent snapshots sorted ascending by ISO date."""

    dates: tuple[str, ...]
    members: tuple[frozenset[str], ...]

    def active_on(self, day: str) -> frozenset[str]:
        """Index members on or immediately before `day` (empty before the first snapshot)."""
        idx = bisect_right(self.dates, day) - 1
        return self.members[idx] if idx >= 0 else frozenset()

    def is_member(self, symbol: str, day: str) -> bool:
        return normalize_symbol(symbol) in self.active_on(day)

    def ever_members(self, start: str, end: str) -> frozenset[str]:
        """Every ticker that appeared in any snapshot active during `[start, end]`."""
        out: set[str] = set()
        first = bisect_right(self.dates, start) - 1
        lo = max(0, first)
        for d, m in zip(self.dates[lo:], self.members[lo:]):
            if d > end:
                break
            out.update(m)
        return frozenset(out)

    def membership_spans(self, symbol: str, series_dates: Sequence[str], start: str, *,
                         warmup: int = 0) -> list[tuple[int, int]]:
        """Contiguous `[lo, hi)` bar-index spans where `symbol` is an active constituent on/after `start`.

        `lo` is the entry/layout day index (requires `lo >= warmup`); `hi` is one past the last day held
        (inclusive of the removal/delisting day so the exit return is captured). Spans with fewer than 2 bars
        (no return day) are omitted.
        """
        sym = normalize_symbol(symbol)
        spans: list[tuple[int, int]] = []
        n = len(series_dates)
        in_span = False
        lo = 0
        for i, day in enumerate(series_dates):
            if day < start:
                continue
            member = sym in self.active_on(day)
            if member and not in_span:
                if i >= warmup:
                    lo = i
                    in_span = True
            elif not member and in_span:
                # Include day `i` as the exit day (removed on snapshot date `day`, sold at that close).
                hi = i + 1
                if hi - lo >= 2:
                    spans.append((lo, hi))
                in_span = False
        if in_span and n - lo >= 2:
            spans.append((lo, n))
        return spans


def load_pit_csv(path: Path) -> PitMembership:
    """Load `date,tickers` CSV (e.g. fja05680/sp500 or leandroloi/historical_sp500_constituents)."""
    by_date: dict[str, frozenset[str]] = {}
    with path.open(encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            day = (row.get("date") or "").strip()
            raw = row.get("tickers") or ""
            if not day or not raw:
                continue
            syms = frozenset(normalize_symbol(t) for t in raw.split(",") if t.strip())
            if syms:
                by_date[day] = syms
    ordered = sorted(by_date)
    if not ordered:
        raise ValueError(f"no PIT constituent rows found in {path}")
    return PitMembership(tuple(ordered), tuple(by_date[d] for d in ordered))


def is_delisted(s: Series, calendar: Sequence[str], gap_sessions: int = DELIST_GAP_SESSIONS) -> bool:
    """True when a stock's last bar ends at least `gap_sessions` before the end of the market calendar."""
    if not s.dates or not calendar:
        return False
    cutoff_idx = max(0, len(calendar) - 1 - gap_sessions)
    return s.dates[-1] < calendar[cutoff_idx]


def is_distress_delisted(s: Series, calendar: Sequence[str]) -> bool:
    """Heuristic for distress/bankruptcy delisting vs cash/stock acquisition.

    A delisted ticker whose last raw close is under $5 or down >= 50% from its trailing 200-session high is
    flagged as a distress delisting (e.g. SIVB, FRC, DISH-like failures vs acquisitions at a premium).
    """
    if not is_delisted(s, calendar) or not s.raw_close:
        return False
    last_px = s.raw_close[-1]
    if last_px < DISTRESS_PRICE:
        return True
    window = s.raw_close[max(0, len(s.raw_close) - 200):]
    peak = max(window) if window else last_px
    return peak > 0 and (last_px / peak) <= (1.0 - DISTRESS_DRAWDOWN)


def apply_terminal_haircut(path: PathReturns, haircut: float) -> PathReturns:
    """Apply an additional terminal delisting loss (`haircut` in `[0, 1]`, e.g. 0.5 = -50% on final day)
    to the final bar of a path's equity legs (cash already stopped out is unaffected).

    Used strictly for distress-delisting sensitivity analysis on top of the observed last trading close.
    """
    if haircut <= 0 or len(path) == 0:
        return path
    haircut = min(1.0, haircut)
    w = list(path.with_rule)
    o = list(path.without)
    out = list(path.out)
    # Without-rule leg is 100% invested in the stock on the final day; with-rule leg is (1 - out[-1]) invested.
    invested_w = max(0.0, 1.0 - out[-1])
    w[-1] = (1.0 + w[-1]) * (1.0 - invested_w * haircut) - 1.0
    o[-1] = (1.0 + o[-1]) * (1.0 - haircut) - 1.0
    return PathReturns(
        start=path.start,
        with_rule=w,
        without=o,
        out=out,
        stop_events=path.stop_events,
        days_to_stop=path.days_to_stop,
        stop_offsets=list(path.stop_offsets),
    )


def coverage_summary(pit: PitMembership, names: dict[str, Series], calendar: Sequence[str],
                     start: str, end: str) -> dict:
    """Measure exact PIT universe coverage: current, removed-still-trading, delisted, distress-delisted, missing."""
    norm_names = {normalize_symbol(k): v for k, v in names.items()}
    ever = pit.ever_members(start, end)
    latest = pit.active_on(end)
    covered = sorted(s for s in ever if s in norm_names)
    missing = sorted(s for s in ever if s not in norm_names)
    delisted = sorted(s for s in covered if is_delisted(norm_names[s], calendar))
    distress = sorted(s for s in delisted if is_distress_delisted(norm_names[s], calendar))
    removed_trading = sorted(s for s in covered if s not in latest and s not in set(delisted))
    current_covered = sorted(s for s in covered if s in latest)

    by_year: dict[str, dict[str, float | int]] = {}
    y0, y1 = int(start[:4]), int(end[:4])
    for yr in range(y0, y1 + 1):
        probe = f"{yr}-06-30" if f"{yr}-06-30" <= end else end
        if probe < start:
            probe = start
        m = pit.active_on(probe)
        if not m:
            continue
        have = sum(1 for sym in m if sym in norm_names and norm_names[sym].dates[0] <= probe
                   and norm_names[sym].dates[-1] >= probe)
        by_year[str(yr)] = {"constituents": len(m), "covered": have,
                            "pct": round(100.0 * have / len(m), 1) if m else 0.0}

    return {
        "start": start,
        "end": end,
        "totalEverConstituents": len(ever),
        "covered": len(covered),
        "coveragePct": round(100.0 * len(covered) / len(ever), 1) if ever else 0.0,
        "coveredCurrent": len(current_covered),
        "coveredRemovedStillTrading": len(removed_trading),
        "coveredDelisted": len(delisted),
        "coveredDistressDelisted": len(distress),
        "missingCount": len(missing),
        "delistedSample": delisted[:25],
        "distressSample": distress[:25],
        "removedStillTradingSample": removed_trading[:25],
        "byYear": by_year,
    }


def pit_share_paths(
    names: dict[str, Series],
    calendar: Sequence[str],
    name_rf: Callable[[Series], list[float]],
    first_k: Callable[[Series, int], int | None],
    pit: PitMembership,
    start: str,
    run_span: Callable[[Series, int, int, list[float], int], PathReturns],
    *,
    warmup: int = 260,
    distress_haircut: float = 0.0,
) -> list[PathReturns]:
    """Run a share path simulator strictly across each stock's active PIT membership span(s)."""
    out: list[PathReturns] = []
    for sym in sorted(names):
        s = names[sym]
        spans = pit.membership_spans(sym, s.dates, start, warmup=warmup)
        if not spans:
            continue
        rf = name_rf(s)
        distress = distress_haircut > 0 and is_distress_delisted(s, calendar)
        for idx, (lo, hi) in enumerate(spans):
            if lo + 1 >= hi:
                continue
            k = first_k(s, lo + 1)
            if k is None:
                continue
            p = run_span(s, lo, hi, rf, k)
            # Apply distress haircut only on the final span if the stock delisted at the end of its bars.
            if distress and idx == len(spans) - 1 and hi == len(s.dates):
                p = apply_terminal_haircut(p, distress_haircut)
            out.append(p)
    return out


def pit_entries(
    names: dict[str, Series],
    calendar: Sequence[str],
    pit: PitMembership,
    start: str,
    end_buffer_days: int,
    *,
    warmup: int = 260,
) -> dict[str, list[entries.Entry]]:
    """Generate daily proxy entries per stock, keeping ONLY entries where the stock was an active PIT member."""
    out: dict[str, list[entries.Entry]] = {}
    last = date.fromisoformat(calendar[-1])
    for sym in sorted(names):
        s = names[sym]
        lo = next((i for i, d in enumerate(s.dates) if d >= start and i >= warmup), None)
        if lo is None:
            continue
        hi = next((i for i, d in enumerate(s.dates) if (last - date.fromisoformat(d)).days < end_buffer_days),
                  len(s.dates))
        raw = entries.signals(s, lo=lo, hi=hi)
        kept = [e for e in raw if pit.is_member(sym, s.dates[e.i])]
        if kept:
            out[sym] = kept
    return out
