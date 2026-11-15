"""IBD-style distribution-day counts and a market-posture risk level for index ETFs.

Port of tradermonty/claude-trading-skills ``skills/ibd-distribution-day-monitor``
(MIT, commit c9b84196a44a56a553293114fdae1f30bdd08c58), rule ``ibd_dd_v1.0``:
``scripts/distribution_day_tracker.py`` (detection, 5% invalidation, 25-session
expiration, window counts), ``scripts/risk_classifier.py`` (per-index and combined
QQQ/SPY risk) and the 21 EMA / 50 SMA filter in ``scripts/ibd_monitor.py``.

Copyright (c) 2026 TraderMonty. MIT; see TRADERMONTY_LICENSE.txt.
Changes from the original: bars are chronological (oldest first) typed rows
instead of most-recent-first dictionaries; moving averages reuse
``indicators.ema``/``indicators.sma`` (same SMA-seeded EMA) over the trailing
run of valid closes; a close, volume or high that is not finite is a bad value
(upstream rejects only a missing or non-positive value); a symbol may appear
only once in the combined level; ``insufficient_lookback`` (upstream
``scripts/history_utils.py``) does not use the upstream fetch window of 80
sessions; the FMP client, caching, Japanese report text and the TQQQ exposure
recommendation are not ported.
``DistributionDayRule`` and ``RiskThresholds`` keep the upstream configuration
fields and defaults (upstream ``models.py``); the defaults are rule ``ibd_dd_v1.0``.

Research only. The caller supplies daily bars (for example from IBKR history):
one bar for each session, oldest first, with ISO 8601 dates (``YYYY-MM-DD``). A
session without a bar cannot be detected. The module reads no file, account or
network resource. The result describes market posture; it is not an order, an
exposure change or a trading authorization. ``audit_flags`` (the upstream flag
names) tells when the history is too short for the full rule; read the level
together with it.

Test status: synthetic bars. The same bars gave the same distribution days,
counts, moving-average filter and levels as the upstream code at the commit
above (differential run, 2026-11-15).
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from indicators import ema, sma

RiskLevel = Literal["NORMAL", "CAUTION", "HIGH", "SEVERE"]
Status = Literal["active", "expired", "invalidated"]
RULE_VERSION = "ibd_dd_v1.0"
EPSILON = 1e-12
_RISK_ORDER: dict[str, int] = {"NORMAL": 0, "CAUTION": 1, "HIGH": 2, "SEVERE": 3}


class DistributionDayError(ValueError):
    """An input is outside the distribution-day contract."""


@dataclass(frozen=True)
class DailyBar:
    date: str
    high: float | None
    close: float | None
    volume: float | None


@dataclass(frozen=True)
class DistributionDayRule:
    min_decline_pct: float = -0.002
    expiration_sessions: int = 25
    invalidation_gain_pct: float = 0.05
    invalidation_price_source: Literal["high", "close"] = "high"


@dataclass(frozen=True)
class RiskThresholds:
    caution_d25: int = 3
    high_d25: int = 5
    high_d15: int = 3
    high_d5: int = 2
    severe_d25: int = 6
    severe_d15: int = 4
    severe_ma_d25: int = 5


DEFAULT_RULE = DistributionDayRule()
DEFAULT_THRESHOLDS = RiskThresholds()


@dataclass(frozen=True)
class DistributionDay:
    date: str
    age_sessions: int
    close: float
    pct_change: float
    volume_change_pct: float
    high_since: float
    invalidation_price: float
    invalidation_date: str | None
    status: Status
    expires_in_sessions: int


@dataclass(frozen=True)
class IndexPosture:
    symbol: str
    as_of: str
    is_distribution_day_today: bool
    d5_count: int
    d15_count: int
    d25_count: int
    close_above_ema: bool | None
    close_above_sma: bool | None
    market_below_ma: bool | None
    risk_level: RiskLevel
    distribution_days: tuple[DistributionDay, ...]
    skipped_dates: tuple[str, ...]
    audit_flags: tuple[str, ...] = ()
    rule_version: str = RULE_VERSION


def _positive(value: float | None) -> bool:
    return value is not None and math.isfinite(value) and value > 0


def _invalidation_date(recent: Sequence[DailyBar], k: int, close: float, rule: DistributionDayRule) -> str | None:
    """First chronological post-DD session within the expiry window at or above +5%."""
    if k <= 0:
        return None
    threshold = close * (1 + rule.invalidation_gain_pct)
    for index in range(k - 1, max(k - rule.expiration_sessions, 0) - 1, -1):
        bar = recent[index]
        value = bar.high if rule.invalidation_price_source == "high" else bar.close
        if _positive(value) and value >= threshold:
            return bar.date
    return None


def distribution_days(bars: Sequence[DailyBar], rule: DistributionDayRule = DEFAULT_RULE
                      ) -> tuple[tuple[DistributionDay, ...], tuple[str, ...]]:
    """Detect and enrich distribution days; returns (days newest first, skipped dates).

    A distribution day closes at least 0.2% lower than the prior close on higher
    volume. It is removed when a later high (or close) reaches +5% of its close
    (the day itself excluded), or when it is older than 25 sessions.
    """
    if rule.invalidation_price_source not in ("high", "close"):
        raise DistributionDayError("invalidation_price_source must be 'high' or 'close'")
    dates = [bar.date for bar in bars]
    if dates != sorted(dates) or len(set(dates)) != len(dates):
        raise DistributionDayError("bars must be in strictly increasing date order")
    recent = list(reversed(bars))  # Upstream indexing: recent[0] is the evaluation session.
    found: list[DistributionDay] = []
    skipped: list[str] = []
    for k in range(len(recent) - 1):
        today, yesterday = recent[k], recent[k + 1]
        if not all(_positive(v) for v in (today.close, today.volume, yesterday.close, yesterday.volume)):
            skipped.append(today.date)
            continue
        pct_change = today.close / yesterday.close - 1
        if not (pct_change <= rule.min_decline_pct + EPSILON and today.volume > yesterday.volume):
            continue
        highs = [bar.high for bar in recent[: k + 1] if _positive(bar.high)]
        invalidated_on = _invalidation_date(recent, k, today.close, rule)
        status: Status = ("invalidated" if invalidated_on is not None
                          else "expired" if k > rule.expiration_sessions else "active")
        found.append(DistributionDay(
            date=today.date, age_sessions=k, close=today.close, pct_change=pct_change,
            volume_change_pct=today.volume / yesterday.volume - 1, high_since=max(highs) if highs else today.close,
            invalidation_price=today.close * (1 + rule.invalidation_gain_pct), invalidation_date=invalidated_on,
            status=status, expires_in_sessions=max(rule.expiration_sessions - k, 0)))
    return tuple(found), tuple(skipped)


def count_active(days: Sequence[DistributionDay], max_age_sessions: int) -> int:
    """Active days with age 0..N inclusive ("within N elapsed sessions")."""
    return sum(1 for day in days if day.status == "active" and day.age_sessions <= max_age_sessions)


def classify_risk(d5: int, d15: int, d25: int, market_below_ma: bool | None,
                  thresholds: RiskThresholds = DEFAULT_THRESHOLDS) -> RiskLevel:
    if d25 >= thresholds.severe_d25 or d15 >= thresholds.severe_d15:
        return "SEVERE"
    if market_below_ma is True and d25 >= thresholds.severe_ma_d25:
        return "SEVERE"
    if d25 >= thresholds.high_d25 or d15 >= thresholds.high_d15 or d5 >= thresholds.high_d5:
        return "HIGH"
    if d25 >= thresholds.caution_d25:
        return "CAUTION"
    return "NORMAL"


def _last(series: Sequence[float | None]) -> float | None:
    return series[-1] if series else None


def index_posture(symbol: str, bars: Sequence[DailyBar], *, rule: DistributionDayRule = DEFAULT_RULE,
                  thresholds: RiskThresholds = DEFAULT_THRESHOLDS, ema_period: int = 21,
                  sma_period: int = 50) -> IndexPosture:
    """Distribution-day counts, MA filter and risk level at the last bar.

    ``audit_flags`` uses the upstream names: ``insufficient_lookback`` when there
    are fewer bars than the longest window needs (the larger of the two average
    periods and ``expiration_sessions + 2``; upstream also compares with its
    fetch window of 80 sessions), and ``insufficient_data_for_moving_average``
    when an average is unknown, which switches the moving-average SEVERE rule off.
    """
    if len(bars) < 2:
        raise DistributionDayError("at least two daily bars are required")
    days, skipped = distribution_days(bars, rule)  # Also checks the date order.
    d5, d15, d25 = count_active(days, 5), count_active(days, 15), count_active(days, 25)
    # Averages use the trailing run of valid closes, so an old bad bar does not switch the filter off.
    closes: list[float] = []
    for bar in reversed(bars):
        if not _positive(bar.close):
            break
        closes.append(bar.close)
    closes.reverse()
    above_ema = above_sma = below = None
    if closes:
        today = closes[-1]
        ema_value = _last(ema(closes, ema_period)) if len(closes) >= ema_period else None
        sma_value = _last(sma(closes, sma_period)) if len(closes) >= sma_period else None
        above_ema = today > ema_value if ema_value is not None else None
        above_sma = today > sma_value if sma_value is not None else None
        if above_ema is not None and above_sma is not None:
            below = not above_ema and not above_sma  # True only when below BOTH averages.
    flags: list[str] = []
    if len(bars) < max(ema_period, sma_period, rule.expiration_sessions + 2):
        flags.append("insufficient_lookback")
    if above_ema is None or above_sma is None:
        flags.append("insufficient_data_for_moving_average")
    return IndexPosture(
        symbol=symbol, as_of=bars[-1].date,
        is_distribution_day_today=any(day.age_sessions == 0 and day.status == "active" for day in days),
        d5_count=d5, d15_count=d15, d25_count=d25, close_above_ema=above_ema, close_above_sma=above_sma,
        market_below_ma=below, risk_level=classify_risk(d5, d15, d25, below, thresholds),
        distribution_days=days, skipped_dates=skipped, audit_flags=tuple(flags))


def combine_index_risks(postures: Sequence[IndexPosture]) -> RiskLevel:
    """Combined level, QQQ-weighted as upstream.

    Any SEVERE gives SEVERE; QQQ HIGH gives HIGH; QQQ NORMAL with SPY HIGH gives
    HIGH; QQQ CAUTION with SPY CAUTION or HIGH gives HIGH; else the maximum.
    """
    if not postures:
        raise DistributionDayError("at least one index posture is required")
    symbols = [posture.symbol for posture in postures]
    if len(set(symbols)) != len(symbols):
        raise DistributionDayError("each index symbol may appear only once")
    levels = {posture.symbol: posture.risk_level for posture in postures}
    if any(level not in _RISK_ORDER for level in levels.values()):
        raise DistributionDayError("risk_level must be NORMAL, CAUTION, HIGH or SEVERE")
    if "SEVERE" in levels.values():
        return "SEVERE"
    qqq, spy = levels.get("QQQ"), levels.get("SPY")
    if qqq == "HIGH":
        return "HIGH"
    if qqq is not None and spy is not None:
        if qqq == "NORMAL" and spy == "HIGH":
            return "HIGH"
        if qqq == "CAUTION" and spy in ("CAUTION", "HIGH"):
            return "HIGH"
    return max(levels.values(), key=lambda level: _RISK_ORDER[level])  # type: ignore[return-value]
