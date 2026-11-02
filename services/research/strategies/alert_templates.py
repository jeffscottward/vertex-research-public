"""Alert-template strategies (screen + trigger) on completed daily bars.

Research only. These functions find the days on which an alert would fire. They place no orders,
call no network and read no files. Rules are restated from the public FreeStockAlerts.ai template
pages (https://freestockalerts.ai/templates); each strategy's spec is
``docs/specs/strategies/<slug>.md`` with S/I/A basis codes per rule.

Daily-bar conventions (Vertex defaults, basis A in the specs):

* A "52-week" window is the last 252 sessions. ``high_prior[t]`` is the highest high of the 252
  sessions BEFORE ``t``; a fresh 52-week high is ``high[t] > high_prior[t]`` (intraday touch).
* An intraday cross above a moving average uses yesterday's average as the level:
  ``close[t-1] < ma[t-1]`` and ``high[t] > ma[t-1]``. A cross below is the mirror image.
* Screened lists are re-screened on refresh days (first session of each month or ISO week). A list
  name is armed from the session after the refresh day up to and including the next refresh day. It
  fires at most once per armed window ("fires once, then pauses until re-armed").
* Rules that need fundamentals or events (earnings, insider trades, analyst actions, dividends)
  take them as explicit inputs. When an input is missing the screen reports it in ``missing`` and
  does not pass; it never guesses.
"""
from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta

from indicators.core import rsi, sma

YEAR = 252
Refresh = str  # "monthly" | "weekly"


@dataclass(frozen=True, slots=True)
class DailyBar:
    day: date
    open: float
    high: float
    low: float
    close: float
    volume: float

    def __post_init__(self) -> None:
        values = (self.open, self.high, self.low, self.close, self.volume)
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
            raise ValueError(f"{self.day}: bar values must be finite numbers")
        if self.low > min(self.open, self.close) or self.high < max(self.open, self.close):
            raise ValueError(f"{self.day}: high/low do not contain open/close")
        if self.low <= 0 or self.volume < 0:
            raise ValueError(f"{self.day}: prices must be positive and volume non-negative")


@dataclass(frozen=True, slots=True)
class Signal:
    """One alert: ``index`` is the trigger session; ``kind`` names the trigger; ``level`` is the price
    level the alert watched (None for event or threshold alerts)."""

    index: int
    day: date
    kind: str
    level: float | None = None
    note: str = ""


@dataclass(frozen=True, slots=True)
class Series:
    """Indicator series aligned to the bars. ``None`` means not enough history."""

    bars: tuple[DailyBar, ...]
    close: tuple[float, ...]
    sma50: tuple[float | None, ...]
    sma200: tuple[float | None, ...]
    rsi14: tuple[float | None, ...]
    high_prior: tuple[float | None, ...]  # highest high of the 252 sessions before t
    year_high: tuple[float | None, ...]  # highest high of the 252 sessions up to and including t
    year_low: tuple[float | None, ...]  # lowest low of the 252 sessions up to and including t
    avg_vol30: tuple[float | None, ...]  # average volume of the 30 sessions before t
    avg_vol20: tuple[float | None, ...]  # average volume of the 20 sessions before t


def _rolling(values: Sequence[float], window: int, pick: Callable[[Sequence[float]], float],
             include_current: bool) -> tuple[float | None, ...]:
    out: list[float | None] = []
    for t in range(len(values)):
        end = t + 1 if include_current else t
        start = end - window
        out.append(pick(values[start:end]) if start >= 0 else None)
    return tuple(out)


def _mean(values: Sequence[float]) -> float:
    return math.fsum(values) / len(values)


def prepare(bars: Sequence[DailyBar]) -> Series:
    ordered = tuple(bars)
    for prev, cur in zip(ordered, ordered[1:]):
        if cur.day <= prev.day:
            raise ValueError("bars must be in strictly increasing date order")
    close = tuple(b.close for b in ordered)
    highs = [b.high for b in ordered]
    lows = [b.low for b in ordered]
    vols = [b.volume for b in ordered]
    return Series(
        bars=ordered,
        close=close,
        sma50=tuple(sma(close, 50)) if close else (),
        sma200=tuple(sma(close, 200)) if close else (),
        rsi14=tuple(rsi(close, 14)) if close else (),
        high_prior=_rolling(highs, YEAR, max, include_current=False),
        year_high=_rolling(highs, YEAR, max, include_current=True),
        year_low=_rolling(lows, YEAR, min, include_current=True),
        avg_vol30=_rolling(vols, 30, _mean, include_current=False),
        avg_vol20=_rolling(vols, 20, _mean, include_current=False),
    )


# ---------------------------------------------------------------------------------------------
# Shared trigger and scan helpers


def new_year_high(s: Series, t: int) -> bool:
    level = s.high_prior[t]
    return level is not None and s.bars[t].high > level


def crosses_above(s: Series, ma: Sequence[float | None], t: int) -> bool:
    if t < 1:
        return False
    level = ma[t - 1]
    return level is not None and s.close[t - 1] < level and s.bars[t].high > level


def crosses_below(s: Series, ma: Sequence[float | None], t: int) -> bool:
    if t < 1:
        return False
    level = ma[t - 1]
    return level is not None and s.close[t - 1] > level and s.bars[t].low < level


def refresh_days(s: Series, cadence: Refresh) -> list[int]:
    """Indexes of the first session of each calendar month ("monthly") or ISO week ("weekly")."""
    if cadence not in ("monthly", "weekly"):
        raise ValueError(f"unknown refresh cadence {cadence!r}")

    def key(d: date) -> tuple[int, int]:
        if cadence == "monthly":
            return (d.year, d.month)
        iso = d.isocalendar()
        return (iso[0], iso[1])

    out: list[int] = []
    for t, bar in enumerate(s.bars):
        if t == 0 or key(bar.day) != key(s.bars[t - 1].day):
            out.append(t)
    return out


def armed_scan(s: Series, cadence: Refresh, qualifies: Callable[[Series, int], bool],
               trigger: Callable[[Series, int, int], Signal | None]) -> list[Signal]:
    """Screen on each refresh day; a passing name is armed until the next refresh day and fires once.

    ``trigger(s, screen_index, t)`` returns a Signal when the alert fires on session ``t``."""
    refreshes = refresh_days(s, cadence)
    out: list[Signal] = []
    for k, r in enumerate(refreshes):
        if not qualifies(s, r):
            continue
        last = refreshes[k + 1] if k + 1 < len(refreshes) else len(s.bars) - 1
        for t in range(r + 1, last + 1):
            signal = trigger(s, r, t)
            if signal is not None:
                out.append(signal)
                break
    return out


def _defined(*values: float | None) -> bool:
    return all(v is not None for v in values)


def _liquid(s: Series, t: int, min_avg_volume: float) -> bool:
    avg = s.avg_vol30[t]
    return avg is not None and avg > min_avg_volume


def _year_high_signal(s: Series, t: int, note: str = "") -> Signal | None:
    if new_year_high(s, t):
        return Signal(t, s.bars[t].day, "new-52-week-high", s.high_prior[t], note)
    return None


def _reclaim_signal(s: Series, ma: Sequence[float | None], t: int, kind: str) -> Signal | None:
    if crosses_above(s, ma, t):
        return Signal(t, s.bars[t].day, kind, ma[t - 1])
    return None


# ---------------------------------------------------------------------------------------------
# Fundamentals and events (explicit inputs; None = not available)


@dataclass(frozen=True, slots=True)
class Fundamentals:
    """Point-in-time company facts at the screen date. None = not available from any source."""

    market_cap: float | None = None
    free_cash_flow_ttm: float | None = None
    net_margin_ttm: float | None = None
    revenue_growth_fy: float | None = None  # latest fiscal year vs prior, as a fraction
    net_income_growth_fy: float | None = None
    net_debt_to_ebitda: float | None = None  # negative or zero = net cash
    profitable_last_3_fy: bool | None = None
    last_eps_surprise: float | None = None  # (actual - estimate) / |estimate|
    financial_sector: bool | None = None  # bank, insurer or other financial company
    payout_ratio_earnings: float | None = None
    payout_ratio_fcf: float | None = None



@dataclass(frozen=True, slots=True)
class Screen:
    passed: bool
    missing: tuple[str, ...] = field(default_factory=tuple)
    failed: tuple[str, ...] = field(default_factory=tuple)



def _fundamental_screen(f: Fundamentals | None, rules: Sequence[tuple[str, Callable[[Fundamentals], bool | None]]]) -> Screen:
    if f is None:
        return Screen(False, ("fundamentals",))
    missing: list[str] = []
    failed: list[str] = []
    for name, rule in rules:
        result = rule(f)
        if result is None:
            missing.append(name)
        elif not result:
            failed.append(name)
    return Screen(not missing and not failed, tuple(missing), tuple(failed))


def _gt(value: float | None, limit: float) -> bool | None:
    return None if value is None else value > limit


# ---------------------------------------------------------------------------------------------
# 1. Quality Breakout Radar (idea discovery)

QUALITY_BREAKOUT_FUNDAMENTALS: tuple[tuple[str, Callable[[Fundamentals], bool | None]], ...] = (
    ("market_cap>5B", lambda f: _gt(f.market_cap, 5e9)),
    ("fcf_ttm>0", lambda f: _gt(f.free_cash_flow_ttm, 0)),
    ("revenue_or_net_income_grew", lambda f: None if f.revenue_growth_fy is None and f.net_income_growth_fy is None
     else (f.revenue_growth_fy or 0) > 0 or (f.net_income_growth_fy or 0) > 0),
    ("net_debt<3x_ebitda", lambda f: True if f.financial_sector else
     (None if f.net_debt_to_ebitda is None else f.net_debt_to_ebitda < 3)),
)


def quality_breakout_price(s: Series, t: int) -> bool:
    c, h = s.close[t], s.year_high[t]
    if not _defined(s.sma50[t], s.sma200[t], h) or not _liquid(s, t, 1e6):
        return False
    return c > s.sma50[t] and c > s.sma200[t] and c >= 0.95 * h  # type: ignore[operator]


def quality_breakout_radar(bars: Sequence[DailyBar]) -> list[Signal]:
    s = prepare(bars)
    return armed_scan(s, "monthly", quality_breakout_price, lambda s, r, t: _year_high_signal(s, t))


# ---------------------------------------------------------------------------------------------
# 2. Under-the-Radar Breakouts (idea discovery)

UNDER_RADAR_FUNDAMENTALS: tuple[tuple[str, Callable[[Fundamentals], bool | None]], ...] = (
    ("market_cap_2B_to_20B", lambda f: None if f.market_cap is None else 2e9 <= f.market_cap <= 20e9),
    ("fcf_ttm>0", lambda f: _gt(f.free_cash_flow_ttm, 0)),
    ("net_margin_ttm>0", lambda f: _gt(f.net_margin_ttm, 0)),
    ("net_debt<3x_ebitda", lambda f: True if f.financial_sector else
     (None if f.net_debt_to_ebitda is None else f.net_debt_to_ebitda < 3)),
)


def under_radar_price(s: Series, t: int) -> bool:
    c, h, lo = s.close[t], s.year_high[t], s.year_low[t]
    if not _defined(s.sma50[t], s.sma200[t], h, lo) or not _liquid(s, t, 1.5e6):
        return False
    return (c > s.sma50[t] and c > s.sma200[t]  # type: ignore[operator]
            and c >= 0.92 * h and c >= 1.30 * lo)  # type: ignore[operator]


def under_the_radar_breakouts(bars: Sequence[DailyBar]) -> list[Signal]:
    s = prepare(bars)
    return armed_scan(s, "monthly", under_radar_price, lambda s, r, t: _year_high_signal(s, t))


# ---------------------------------------------------------------------------------------------
# 3. Quality Compounders on Pullback (entry timing)

QUALITY_COMPOUNDER_FUNDAMENTALS: tuple[tuple[str, Callable[[Fundamentals], bool | None]], ...] = (
    ("market_cap>=20B", lambda f: None if f.market_cap is None else f.market_cap >= 20e9),
    ("not_financial", lambda f: None if f.financial_sector is None else not f.financial_sector),
    ("fcf_ttm>0", lambda f: _gt(f.free_cash_flow_ttm, 0)),
    ("profitable_last_3_fy", lambda f: f.profitable_last_3_fy),
    ("revenue_grew_fy", lambda f: _gt(f.revenue_growth_fy, 0)),
    ("net_debt<3x_ebitda", lambda f: None if f.net_debt_to_ebitda is None else f.net_debt_to_ebitda < 3),
    ("eps_miss_not_over_10pct", lambda f: None if f.last_eps_surprise is None else f.last_eps_surprise >= -0.10),
)


def quality_compounder_price(s: Series, t: int) -> bool:
    c, h = s.close[t], s.year_high[t]
    if not _defined(s.sma50[t], s.sma200[t], h) or not _liquid(s, t, 1e6):
        return False
    return (0.70 * h <= c <= 0.88 * h  # type: ignore[operator]
            and c >= 0.92 * s.sma200[t]  # type: ignore[operator]
            and c < s.sma50[t])  # type: ignore[operator]


def quality_compounders_on_pullback(bars: Sequence[DailyBar]) -> list[Signal]:
    s = prepare(bars)
    return armed_scan(s, "monthly", quality_compounder_price,
                      lambda s, r, t: _reclaim_signal(s, s.sma50, t, "reclaims-50-day"))


# ---------------------------------------------------------------------------------------------
# 4. Leader Pullback and Reclaim (entry timing)


def leader_pullback_price(s: Series, t: int) -> bool:
    c, h, r = s.close[t], s.year_high[t], s.rsi14[t]
    if not _defined(s.sma50[t], s.sma200[t], h, r) or not _liquid(s, t, 2e6):
        return False
    return (c > s.sma200[t]  # type: ignore[operator]
            and 0.80 * h <= c <= 0.92 * h  # type: ignore[operator]
            and c < s.sma50[t]  # type: ignore[operator]
            and 35 <= r <= 45)  # type: ignore[operator]


def leader_pullback_and_reclaim(bars: Sequence[DailyBar]) -> list[Signal]:
    s = prepare(bars)
    return armed_scan(s, "weekly", leader_pullback_price,
                      lambda s, r, t: _reclaim_signal(s, s.sma50, t, "reclaims-50-day"))


# ---------------------------------------------------------------------------------------------
# 5. 200-Day Comeback Watchlist (entry timing)


def comeback_price(s: Series, t: int) -> bool:
    c, h, lo, m200 = s.close[t], s.year_high[t], s.year_low[t], s.sma200[t]
    if not _defined(s.sma50[t], m200, h, lo) or t < 59 or not _liquid(s, t, 2e6):
        return False
    below = sum(1 for k in range(t - 59, t + 1)
                if s.sma200[k] is not None and s.close[k] < s.sma200[k])  # type: ignore[operator]
    return (0.80 * m200 <= c < m200  # type: ignore[operator]
            and below >= 40
            and c <= 0.80 * h  # type: ignore[operator]
            and c > s.sma50[t]  # type: ignore[operator]
            and c >= 1.08 * lo)  # type: ignore[operator]


def two_hundred_day_comeback(bars: Sequence[DailyBar]) -> list[Signal]:
    s = prepare(bars)
    return armed_scan(s, "weekly", comeback_price,
                      lambda s, r, t: _reclaim_signal(s, s.sma200, t, "crosses-above-200-day"))


# ---------------------------------------------------------------------------------------------
# 6. Sector Leadership Radar (monitoring). Fixed list, always armed; one alert per cross.

SECTOR_ETFS = ("XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC")


def sector_leadership(bars: Sequence[DailyBar], spy: Sequence[DailyBar]) -> list[Signal]:
    """Crosses above the 50-day average. ``note`` is "bounce-in-downtrend" when the ETF is below its
    200-day average AND its 21-session return trails SPY; otherwise "leadership"."""
    s = prepare(bars)
    spy_close = {b.day: b.close for b in spy}
    out: list[Signal] = []
    for t in range(1, len(s.bars)):
        if not crosses_above(s, s.sma50, t):
            continue
        label = "leadership"
        m200 = s.sma200[t]
        if t >= 21 and m200 is not None and s.close[t] < m200:
            day, base = s.bars[t].day, s.bars[t - 21].day
            if day in spy_close and base in spy_close:
                own = s.close[t] / s.close[t - 21] - 1
                bench = spy_close[day] / spy_close[base] - 1
                if own < bench:
                    label = "bounce-in-downtrend"
        out.append(Signal(t, s.bars[t].day, "crosses-above-50-day", s.sma50[t - 1], label))
    return out


# ---------------------------------------------------------------------------------------------
# 7. Market Stress Alerts (monitoring). Fixed list. Threshold and cross alerts re-arm when the
#    condition resets; daily-move alerts fire at most once per session.

MOVE_LIMITS = {"SPY": 0.02, "QQQ": 0.03, "TLT": 0.02, "HYG": 0.015}


def session_moves(bars: Sequence[DailyBar], limit: float) -> list[Signal]:
    """Intraday move of at least ``limit`` from the previous close, either direction (one per day)."""
    out: list[Signal] = []
    for t in range(1, len(bars)):
        prev = bars[t - 1].close
        up = bars[t].high / prev - 1
        down = bars[t].low / prev - 1
        if up >= limit or down <= -limit:
            kind = "move-up" if up >= -down else "move-down"
            out.append(Signal(t, bars[t].day, kind, None, f"{max(up, -down):.4f}"))
    return out


def vix_thresholds(vix: Sequence[DailyBar]) -> list[Signal]:
    """VIX above 25, above 35 (intraday high), below 13 (intraday low). Each re-arms after the
    close is back on the other side of its threshold."""
    out: list[Signal] = []
    armed = {"vix-above-25": True, "vix-above-35": True, "vix-below-13": True}
    for t, bar in enumerate(vix):
        tests = (("vix-above-25", bar.high > 25, bar.close <= 25),
                 ("vix-above-35", bar.high > 35, bar.close <= 35),
                 ("vix-below-13", bar.low < 13, bar.close >= 13))
        for kind, hit, reset in tests:
            if armed[kind] and hit:
                out.append(Signal(t, bar.day, kind))
                armed[kind] = False
            elif not armed[kind] and reset:
                armed[kind] = True
    return out


def trend_crosses(bars: Sequence[DailyBar], above: bool, below: bool) -> list[Signal]:
    s = prepare(bars)
    out: list[Signal] = []
    for t in range(1, len(s.bars)):
        if below and crosses_below(s, s.sma200, t):
            out.append(Signal(t, s.bars[t].day, "crosses-below-200-day", s.sma200[t - 1]))
        elif above and crosses_above(s, s.sma200, t):
            out.append(Signal(t, s.bars[t].day, "crosses-above-200-day", s.sma200[t - 1]))
    return out


def market_stress(data: dict[str, Sequence[DailyBar]]) -> dict[str, list[Signal]]:
    """``data`` keys: ^VIX, SPY, QQQ, IWM, TLT, HYG. Returns signals per symbol."""
    out: dict[str, list[Signal]] = {"^VIX": vix_thresholds(data["^VIX"])}
    for symbol, limit in MOVE_LIMITS.items():
        out[symbol] = session_moves(data[symbol], limit)
    out["SPY"] = sorted(out["SPY"] + trend_crosses(data["SPY"], above=True, below=True),
                        key=lambda sig: (sig.index, sig.kind))
    out["IWM"] = trend_crosses(data["IWM"], above=False, below=True)
    return out


# ---------------------------------------------------------------------------------------------
# 8. Earnings Calendar Alerts (monitoring). Fixed list.

EARNINGS_CALENDAR_SYMBOLS = ("AAPL", "NVDA", "TSLA", "META", "AMZN", "MSFT", "GOOGL")
LARGE_MOVE_LIMITS = {"AAPL": 0.05, "NVDA": 0.07, "TSLA": 0.07}


def earnings_reminders(sessions: Sequence[date], report_days: Iterable[date], lead_days: int = 3) -> list[Signal]:
    """One reminder per scheduled report: the first session on or after ``report - lead_days``
    calendar days and before the report day."""
    out: list[Signal] = []
    for report in sorted(set(report_days)):
        start = report - timedelta(days=lead_days)
        for t, day in enumerate(sessions):
            if start <= day < report:
                out.append(Signal(t, day, "earnings-in-3-days", None, report.isoformat()))
                break
    return out


def large_moves(symbol: str, bars: Sequence[DailyBar]) -> list[Signal]:
    return session_moves(bars, LARGE_MOVE_LIMITS[symbol])


# ---------------------------------------------------------------------------------------------
# 9. Post-Earnings Strength Radar (idea discovery). Needs earnings events.


@dataclass(frozen=True, slots=True)
class EarningsReport:
    report_day: date  # first session the report can move the price (after-close reports: next day)
    eps_actual: float | None
    eps_estimate: float | None
    revenue: float | None
    revenue_year_ago: float | None


def _index_on_or_after(s: Series, day: date) -> int | None:
    for t, bar in enumerate(s.bars):
        if bar.day >= day:
            return t
    return None


def post_earnings_reaction(s: Series, report: EarningsReport) -> int | None:
    """Reaction day = the report day or the next session, whichever traded more shares."""
    t = _index_on_or_after(s, report.report_day)
    if t is None or t < 1:
        return None
    if t + 1 < len(s.bars) and s.bars[t + 1].volume > s.bars[t].volume:
        return t + 1
    return t


def post_earnings_qualifies(s: Series, report: EarningsReport, t: int) -> Screen:
    values = (report.eps_actual, report.eps_estimate, report.revenue, report.revenue_year_ago)
    if any(v is None for v in values):
        return Screen(False, ("eps_or_revenue",))
    first = _index_on_or_after(s, report.report_day)
    reaction = post_earnings_reaction(s, report)
    if first is None or reaction is None or reaction > t:
        return Screen(False, failed=("no_reaction_yet",))
    failed: list[str] = []
    if (s.bars[t].day - report.report_day).days > 45:
        failed.append("report_older_than_45_days")
    if not report.eps_actual > report.eps_estimate:  # type: ignore[operator]
        failed.append("eps_beat")
    if not report.revenue > report.revenue_year_ago:  # type: ignore[operator]
        failed.append("revenue_up_yoy")
    pre_close = s.close[first - 1]
    if s.close[reaction] / s.close[reaction - 1] - 1 < 0.03:
        failed.append("reaction_gain>=3pct")
    avg = s.avg_vol30[reaction]
    if avg is None or s.bars[reaction].volume < 1.5 * avg:
        failed.append("reaction_volume>=1.5x")
    if not s.close[t] > pre_close:
        failed.append("above_pre_report_close")
    if not (_defined(s.sma50[t], s.sma200[t]) and s.close[t] > s.sma50[t] and s.close[t] > s.sma200[t]):  # type: ignore[operator]
        failed.append("above_50_and_200_day")
    if not _liquid(s, t, 1e6):
        failed.append("avg_volume>1M")
    return Screen(not failed, failed=tuple(failed))


def post_earnings_strength(bars: Sequence[DailyBar], reports: Sequence[EarningsReport]) -> list[Signal]:
    """Weekly screen. If the close is below the reaction-day high the alert is that high (traded
    through); otherwise it is a fresh 52-week high."""
    s = prepare(bars)

    def latest_report(t: int) -> EarningsReport | None:
        day = s.bars[t].day
        past = [r for r in reports if r.report_day <= day]
        return max(past, key=lambda r: r.report_day) if past else None

    def qualifies(s: Series, t: int) -> bool:
        report = latest_report(t)
        return report is not None and post_earnings_qualifies(s, report, t).passed

    def trigger(s: Series, r: int, t: int) -> Signal | None:
        report = latest_report(r)
        reaction = post_earnings_reaction(s, report)  # type: ignore[arg-type]
        level = s.bars[reaction].high  # type: ignore[index]
        if s.close[r] < level:
            if s.bars[t].high > level:
                return Signal(t, s.bars[t].day, "above-earnings-day-high", level)
            return None
        return _year_high_signal(s, t)

    return armed_scan(s, "weekly", qualifies, trigger)


# ---------------------------------------------------------------------------------------------
# 10. Insider Purchase Confirmation (idea discovery). Needs Form 4 transactions.

SENIOR_ROLES = ("director", "ceo", "cfo", "coo", "president", "chair", "founder", "chief")
TOP_ROLES = ("ceo", "cfo", "founder", "president", "chair")


@dataclass(frozen=True, slots=True)
class InsiderTrade:
    trade_day: date
    insider: str
    role: str  # free text from the filing, for example "Director" or "Chief Executive Officer"
    code: str  # Form 4 transaction code; only "P" counts
    security: str  # "common" or "ordinary" count
    shares: float | None
    price: float | None
    holding_before: float | None = None
    filing_id: str = ""


def _role_key(role: str) -> str:
    text = role.lower().replace("chief executive officer", "ceo").replace("chief financial officer", "cfo")
    return text.replace("chief operating officer", "coo")


def insider_purchase_counts(trade: InsiderTrade) -> bool:
    if trade.code != "P" or trade.security.lower() not in ("common", "ordinary"):
        return False
    if not trade.shares or not trade.price or trade.shares <= 0 or trade.price <= 0:
        return False
    role = _role_key(trade.role)
    if not any(r in role for r in SENIOR_ROLES):
        return False  # a 10% owner with no officer or director role does not count
    return trade.shares * trade.price >= 100_000


def insider_score(trade: InsiderTrade, window: Sequence[InsiderTrade]) -> int:
    """0-8 ranking score: 2 points per stated factor (point weights are a Vertex default)."""
    score = 0
    if len({t.insider for t in window if insider_purchase_counts(t)}) >= 2:
        score += 2
    if any(r in _role_key(trade.role) for r in TOP_ROLES):
        score += 2
    if (trade.shares or 0) * (trade.price or 0) >= 500_000:
        score += 2
    if trade.holding_before and trade.shares and trade.shares >= 0.10 * trade.holding_before:
        score += 2
    return score


def insider_purchase_confirmation(bars: Sequence[DailyBar], trades: Sequence[InsiderTrade]) -> list[Signal]:
    """Daily after the close: a qualifying purchase in the last 30 days, at least one completed
    session since it, close above the 50-day average, then close above the highest close since the
    purchase, or within 3% of it on 1.5x the 20-day average volume. One alert per company per 14
    days; one alert per filing."""
    s = prepare(bars)
    valid = sorted((t for t in trades if insider_purchase_counts(t)), key=lambda t: t.trade_day)
    out: list[Signal] = []
    used: set[str] = set()
    last_alert: date | None = None
    for t in range(1, len(s.bars)):
        day = s.bars[t].day
        if last_alert is not None and (day - last_alert).days < 14:
            continue
        m50, avg20 = s.sma50[t], s.avg_vol20[t]
        if m50 is None or s.close[t] <= m50 or not _liquid(s, t, 1e6):
            continue
        for trade in valid:
            key = trade.filing_id or f"{trade.insider}:{trade.trade_day}"
            if key in used or not (0 <= (day - trade.trade_day).days <= 30):
                continue
            start = _index_on_or_after(s, trade.trade_day)
            if start is None or start >= t:
                continue  # needs at least one completed session after the purchase day
            prior_high = max(s.close[start:t])
            breakout = s.close[t] > prior_high
            near = (s.close[t] >= 0.97 * prior_high and avg20 is not None
                    and s.bars[t].volume >= 1.5 * avg20)
            if breakout or near:
                window = [x for x in valid if 0 <= (day - x.trade_day).days <= 30]
                kind = "close-above-post-purchase-high" if breakout else "near-high-on-volume"
                out.append(Signal(t, day, kind, prior_high, f"score={insider_score(trade, window)}"))
                used.add(key)
                last_alert = day
                break
    return out


# ---------------------------------------------------------------------------------------------
# 11. Analyst Upgrade Clusters (idea discovery). Needs analyst rating actions.

RATING_LEVELS = {
    "strong buy": 5, "buy": 4, "outperform": 4, "overweight": 4, "accumulate": 4, "positive": 4,
    "hold": 3, "neutral": 3, "market perform": 3, "equal weight": 3, "equal-weight": 3, "sector perform": 3,
    "peer perform": 3, "in-line": 3,
    "sell": 2, "underperform": 2, "underweight": 2, "reduce": 2, "negative": 2, "strong sell": 1,
}


@dataclass(frozen=True, slots=True)
class AnalystAction:
    day: date
    firm: str
    from_grade: str | None  # None for an initiation
    to_grade: str
    target_only: bool = False


def rating_level(grade: str | None) -> int | None:
    return None if grade is None else RATING_LEVELS.get(grade.strip().lower())


def analyst_action_direction(action: AnalystAction) -> str:
    """"positive" (upgrade, or initiation at Buy or better), "negative" (a cut out of buy territory or
    by two or more levels), "lowered-positive" (a cut that stays at Buy or better) or "neutral"."""
    to = rating_level(action.to_grade)
    if action.target_only or to is None:
        return "neutral"
    if action.from_grade is None:
        return "positive" if to >= 4 else "neutral"
    frm = rating_level(action.from_grade)
    if frm is None or frm == to:
        return "neutral"
    if to > frm:
        return "positive"
    if (frm >= 4 > to) or frm - to >= 2:
        return "negative"
    return "lowered-positive"


def analyst_cluster(actions: Sequence[AnalystAction], day: date) -> tuple[list[str], bool]:
    """Firms with a positive action in the 14 days up to ``day`` (one per firm), and whether a
    negative action in the same window vetoes the cluster."""
    window = [a for a in actions if 0 <= (day - a.day).days < 14]
    firms = sorted({a.firm for a in window if analyst_action_direction(a) == "positive"})
    veto = any(analyst_action_direction(a) == "negative" for a in window)
    return firms, veto


def analyst_upgrade_clusters(bars: Sequence[DailyBar], actions: Sequence[AnalystAction]) -> list[Signal]:
    """Daily after the close: 2+ firms with positive actions in 14 days, no veto, close above the
    50-day average, then a close above the prior 20-session high or 1.5x 20-day volume on an up
    day. One alert per company per 14 days and per set of actions."""
    s = prepare(bars)
    highs = [b.high for b in s.bars]
    out: list[Signal] = []
    last_alert: date | None = None
    alerted_sets: set[tuple[str, ...]] = set()
    for t in range(20, len(s.bars)):
        day = s.bars[t].day
        if last_alert is not None and (day - last_alert).days < 14:
            continue
        firms, veto = analyst_cluster(actions, day)
        if len(firms) < 2 or veto or tuple(firms) in alerted_sets:
            continue
        m50, avg20 = s.sma50[t], s.avg_vol20[t]
        if m50 is None or s.close[t] <= m50 or not _liquid(s, t, 1e6):
            continue
        high20 = max(highs[t - 20:t])
        breakout = s.close[t] > high20
        surge = (avg20 is not None and s.bars[t].volume >= 1.5 * avg20 and s.close[t] > s.close[t - 1])
        if breakout or surge:
            kind = "close-above-20-day-high" if breakout else "volume-surge-up-day"
            out.append(Signal(t, day, kind, high20, f"firms={len(firms)}"))
            alerted_sets.add(tuple(firms))
            last_alert = day
    return out


# ---------------------------------------------------------------------------------------------
# 12. Dividend Growth Buy Zones (entry timing). Needs the dividend history (ex-date, cash).


@dataclass(frozen=True, slots=True)
class Dividend:
    ex_day: date
    amount: float


def _forward_dividend(divs: Sequence[Dividend], day: date) -> float | None:
    """Latest payment annualized by the number of payments in the 365 days up to ``day``."""
    past = [d for d in divs if d.ex_day <= day]
    if not past:
        return None
    year = [d for d in past if (day - d.ex_day).days < 365]
    return past[-1].amount * max(len(year), 1)


def dividend_growth_years(divs: Sequence[Dividend], day: date) -> int:
    """Consecutive completed calendar years (before ``day``'s year) whose dividend total rose."""
    totals: dict[int, float] = {}
    for d in divs:
        if d.ex_day.year < day.year:
            totals[d.ex_day.year] = totals.get(d.ex_day.year, 0.0) + d.amount
    years = 0
    y = day.year - 1
    while y in totals and y - 1 in totals and totals[y] > totals[y - 1]:
        years += 1
        y -= 1
    return years


def buy_zone_yield(s: Series, divs: Sequence[Dividend], day: date) -> float | None:
    """80th percentile (nearest rank) of the forward yields on each ex-date in the last 5 years."""
    closes = {b.day: b.close for b in s.bars}
    yields: list[float] = []
    for d in divs:
        if 0 <= (day - d.ex_day).days <= 5 * 365 and d.ex_day in closes:
            fwd = _forward_dividend(divs, d.ex_day)
            if fwd:
                yields.append(fwd / closes[d.ex_day])
    if len(yields) < 8:
        return None
    yields.sort()
    rank = math.ceil(0.8 * len(yields)) - 1
    return yields[rank]


def dividend_buy_zone_state(s: Series, divs: Sequence[Dividend], t: int) -> tuple[str, float | None]:
    """("price-level", level) when the yield is below the zone, ("reclaim-200-day", None) when the
    yield is in the zone and the close is below the 200-day average, otherwise ("none", None)."""
    day = s.bars[t].day
    past = [d for d in divs if d.ex_day <= day]
    if dividend_growth_years(divs, day) < 5 or len(past) < 2 or not _liquid(s, t, 1e6):
        return ("none", None)
    year_ago = [d for d in past if (day - d.ex_day).days >= 330]
    if year_ago and past[-1].amount < year_ago[-1].amount:
        return ("none", None)
    fwd, zone = _forward_dividend(divs, day), buy_zone_yield(s, divs, day)
    if fwd is None or zone is None:
        return ("none", None)
    current = fwd / s.close[t]
    if current < 0.015:
        return ("none", None)
    if current < zone:
        return ("price-level", fwd / zone)
    m200 = s.sma200[t]
    if m200 is not None and s.close[t] < m200:
        return ("reclaim-200-day", None)
    return ("none", None)


def dividend_growth_buy_zones(bars: Sequence[DailyBar], divs: Sequence[Dividend]) -> list[Signal]:
    """Monthly screen. Price-level alert: the low reaches forward dividend / buy-zone yield.
    In-zone alert: a cross back above the 200-day average. Payout coverage and leverage need
    fundamentals and are checked by ``Fundamentals`` when available."""
    s = prepare(bars)
    ordered = sorted(divs, key=lambda d: d.ex_day)

    def qualifies(s: Series, t: int) -> bool:
        return dividend_buy_zone_state(s, ordered, t)[0] != "none"

    def trigger(s: Series, r: int, t: int) -> Signal | None:
        state, level = dividend_buy_zone_state(s, ordered, r)
        if state == "price-level" and level is not None and s.bars[t].low <= level:
            return Signal(t, s.bars[t].day, "reaches-buy-zone-yield", level)
        if state == "reclaim-200-day":
            return _reclaim_signal(s, s.sma200, t, "reclaims-200-day")
        return None

    return armed_scan(s, "monthly", qualifies, trigger)


DIVIDEND_FUNDAMENTALS: tuple[tuple[str, Callable[[Fundamentals], bool | None]], ...] = (
    ("market_cap>10B", lambda f: _gt(f.market_cap, 10e9)),
    ("payout_covered", lambda f: None if f.payout_ratio_earnings is None and f.payout_ratio_fcf is None
     else (f.payout_ratio_earnings is not None and f.payout_ratio_earnings < 0.75)
     or (f.payout_ratio_fcf is not None and f.payout_ratio_fcf < 0.90)),
    ("net_debt<3.5x_ebitda", lambda f: True if f.financial_sector else
     (None if f.net_debt_to_ebitda is None else f.net_debt_to_ebitda < 3.5)),
)

COMEBACK_FUNDAMENTALS: tuple[tuple[str, Callable[[Fundamentals], bool | None]], ...] = (
    ("market_cap>10B", lambda f: _gt(f.market_cap, 10e9)),
    ("net_debt<4x_ebitda", lambda f: True if f.financial_sector else
     (None if f.net_debt_to_ebitda is None else f.net_debt_to_ebitda < 4)),
)

LEADER_FUNDAMENTALS: tuple[tuple[str, Callable[[Fundamentals], bool | None]], ...] = (
    ("market_cap>50B", lambda f: _gt(f.market_cap, 50e9)),
    ("eps_miss_not_over_10pct", lambda f: None if f.last_eps_surprise is None else f.last_eps_surprise >= -0.10),
)


def fundamental_screen(slug: str, facts: Fundamentals | None) -> Screen:
    """The non-price part of a screened list. Price rules are in the ``*_price`` functions."""
    rules = {
        "quality-breakout-radar": QUALITY_BREAKOUT_FUNDAMENTALS,
        "under-the-radar-breakouts": UNDER_RADAR_FUNDAMENTALS,
        "quality-compounders-on-pullback": QUALITY_COMPOUNDER_FUNDAMENTALS,
        "leader-pullback-and-reclaim": LEADER_FUNDAMENTALS,
        "200-day-comeback-watchlist": COMEBACK_FUNDAMENTALS,
        "dividend-growth-buy-zones": DIVIDEND_FUNDAMENTALS,
    }
    if slug not in rules:
        raise KeyError(f"{slug} has no fundamental screen")
    return _fundamental_screen(facts, rules[slug])
