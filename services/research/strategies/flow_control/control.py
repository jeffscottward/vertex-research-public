"""Options and futures flow control rules + agreement: Python port of packages/api/src/flow-control-rules.ts.

Pure module (no file or network access). The golden vectors committed with the TypeScript module are the
acceptance test of the port: the Python test replays every options, group, futures and agreement case and must
give the exact same ratio, state, no-data reason, start minute, hold, trades and agreement as TypeScript.
In the study every minute is closed, so the live reader's reason `stale` and its rule "leave out the minute in
progress" have no effect here and are not ported.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

BUYERS = "buyers"
SELLERS = "sellers"
BALANCED = "balanced"
NO_DATA = "no_data"
MIXED = "mixed"
SESSION_START = "session_start"
GAP = "gap"
HOLD_FEW_TRADES = "few_trades"
HOLD_DELTA_AGAINST = "delta_against"
HOLD_PRICE_AGAINST = "price_against"
FUTURES_HOLDS = (HOLD_FEW_TRADES, HOLD_DELTA_AGAINST, HOLD_PRICE_AGAINST)
AGREE = "agree"
DIVERGE = "diverge"
ONE_SIDED = "one_sided"
BOTH_BALANCED = "both_balanced"
NOT_COMPARABLE = "not_comparable"
AGREEMENT_STATES = (AGREE, DIVERGE, ONE_SIDED, BOTH_BALANCED, NOT_COMPARABLE)
BULLISH = "bullish"
BEARISH = "bearish"
NEUTRAL = "neutral"

@dataclass(frozen=True)
class ControlRules:
    version: str
    window_minutes: int
    enter_ratio: float
    exit_ratio: float
    min_minutes: int
    min_buckets: int

    def to_json(self) -> dict:
        return {"version": self.version, "windowMinutes": self.window_minutes, "enterRatio": self.enter_ratio,
                "exitRatio": self.exit_ratio, "minMinutes": self.min_minutes, "minBuckets": self.min_buckets}


RULES = ControlRules("flow-control-rules.v1", 30, 0.30, 0.10, 5, 10)


@dataclass(frozen=True)
class DriftMinute:
    """One closed minute of the expiry part `total`; `minute` counts from 09:30 New York."""

    minute: int
    net_call_premium: float
    net_put_premium: float


@dataclass(frozen=True)
class ControlStep:
    minute: int
    ratio: float | None
    state: str
    no_data_reason: str | None
    since_minute: int | None


def options_ratio(window: Sequence[DriftMinute]) -> float:
    """Sum of (call minus put) over the sum of (absolute call plus absolute put); 0.0 for a zero divisor."""
    num = sum(m.net_call_premium - m.net_put_premium for m in window)
    den = sum(abs(m.net_call_premium) + abs(m.net_put_premium) for m in window)
    return num / den if den != 0 else 0.0


def fold_control_state(minutes: Sequence[DriftMinute], rules: ControlRules) -> list[ControlStep]:
    """One step per minute from 0 to the last minute of `minutes`, gaps included (Pseudocode A of the plan)."""
    rows = sorted(minutes, key=lambda m: m.minute)
    if not rows:
        return []
    last = rows[-1].minute
    state, since = BALANCED, None
    buy_run = sell_run = 0
    buy_start: int | None = None
    sell_start: int | None = None
    out: list[ControlStep] = []
    lo = 0
    for m in range(0, last + 1):
        hi = lo
        while lo < len(rows) and rows[lo].minute <= m - rules.window_minutes:
            lo += 1
        hi = lo
        while hi < len(rows) and rows[hi].minute <= m:
            hi += 1
        window = rows[lo:hi]
        if len(window) < rules.min_buckets:
            reason = SESSION_START if m + 1 < rules.min_buckets else GAP
            out.append(ControlStep(m, None, NO_DATA, reason, None))
            buy_run = sell_run = 0
            continue
        ratio = options_ratio(window)
        if (state == BUYERS and ratio < rules.exit_ratio) or (state == SELLERS and ratio > -rules.exit_ratio):
            state, since = BALANCED, None
        if state == BALANCED:
            if ratio >= rules.enter_ratio:
                sell_run = 0
                buy_run += 1
                if buy_run == 1:
                    buy_start = m
            elif ratio <= -rules.enter_ratio:
                buy_run = 0
                sell_run += 1
                if sell_run == 1:
                    sell_start = m
            else:
                buy_run = sell_run = 0
            if buy_run == rules.min_minutes:
                state, since, buy_run = BUYERS, buy_start, 0
            elif sell_run == rules.min_minutes:
                state, since, sell_run = SELLERS, sell_start, 0
        out.append(ControlStep(m, ratio, state, None, since))
    return out


def group_options_state(primary: str, check: str) -> str:
    """`no_data` without primary data; `mixed` when the two tickers control opposite sides; else the primary."""
    if primary == NO_DATA:
        return NO_DATA
    if (primary, check) in ((BUYERS, SELLERS), (SELLERS, BUYERS)):
        return MIXED
    return primary


@dataclass(frozen=True)
class FuturesRules:
    """Parameters of flow-futures-rules.v1 (plan flow-streaming-tape, section 5)."""

    version: str
    window_minutes: int
    enter_ratio: float
    exit_ratio: float
    min_minutes: int
    min_buckets: int
    max_missing_minutes: int
    min_covered_seconds: int
    min_trades: int

    def to_json(self) -> dict:
        return {
            "version": self.version,
            "windowMinutes": self.window_minutes,
            "enterRatio": self.enter_ratio,
            "exitRatio": self.exit_ratio,
            "minMinutes": self.min_minutes,
            "minBuckets": self.min_buckets,
            "maxMissingMinutes": self.max_missing_minutes,
            "minCoveredSeconds": self.min_covered_seconds,
            "minTrades": self.min_trades,
        }


FUTURES_RULES = FuturesRules("flow-futures-rules.v1", 30, 0.30, 0.10, 5, 10, 5, 55, 10)


@dataclass(frozen=True)
class TapeMinute:
    """One covered minute of a future's streamed tape; `minute` counts from 09:30 New York."""

    minute: int
    deep_buy: float
    deep_sell: float
    deep_trades: int
    delta: float
    volume: float
    vwap: float
    close: float


@dataclass(frozen=True)
class FuturesWindowTotals:
    numerator: float
    denominator: float
    rows: int


@dataclass(frozen=True)
class FuturesStep:
    minute: int
    ratio: float | None
    state: str
    no_data_reason: str | None
    since_minute: int | None
    hold: str | None
    trades: int


@dataclass(frozen=True)
class AgreementResult:
    state: str
    direction: str

    def to_json(self) -> dict[str, str]:
        return {"state": self.state, "direction": self.direction}


def _deep_totals(window: Sequence[TapeMinute]) -> FuturesWindowTotals:
    numerator = sum(entry.deep_buy - entry.deep_sell for entry in window)
    denominator = sum(entry.deep_buy + entry.deep_sell for entry in window)
    return FuturesWindowTotals(numerator=numerator, denominator=denominator, rows=len(window))


def futures_window_totals(
    minutes: Sequence[TapeMinute], end: int, rules: FuturesRules | ControlRules = FUTURES_RULES
) -> FuturesWindowTotals:
    """Net and total deep-trade volume and covered minute count with end - window_minutes < minute <= end."""
    window = [entry for entry in minutes if end - rules.window_minutes < entry.minute <= end]
    return _deep_totals(window)


def _hold_of(
    window: Sequence[TapeMinute], ratio: float, trades: int, rules: FuturesRules
) -> str | None:
    """First failed entry check of a non-empty window, or None. Mirrors holdOf in flow-control-rules.ts."""
    if abs(ratio) < rules.enter_ratio:
        return None
    if trades < rules.min_trades:
        return HOLD_FEW_TRADES
    side = -1 if ratio < 0 else 1
    delta_sum = sum(entry.delta for entry in window)
    delta_sign = 1 if delta_sum > 0 else (-1 if delta_sum < 0 else 0)
    if delta_sign != side:
        return HOLD_DELTA_AGAINST
    total_volume = sum(entry.volume for entry in window)
    if total_volume <= 0:
        return HOLD_PRICE_AGAINST
    vwap = sum(entry.vwap * entry.volume for entry in window) / total_volume
    newest = max(window, key=lambda entry: entry.minute)
    return None if (newest.close - vwap) * side > 0 else HOLD_PRICE_AGAINST


def fold_futures_state(
    minutes: Sequence[TapeMinute], rules: FuturesRules = FUTURES_RULES, through: int = -1
) -> list[FuturesStep]:
    """One step per minute from 0 to max(through, newest input minute); mirrors foldFuturesState in TS."""
    rows = sorted(minutes, key=lambda entry: entry.minute)
    last = max(through, rows[-1].minute) if rows else through
    if last < 0:
        return []
    covered = {entry.minute for entry in rows}
    carried = BALANCED
    since: int | None = None
    buy_run = sell_run = 0
    out: list[FuturesStep] = []
    lo = 0
    for minute in range(0, last + 1):
        while lo < len(rows) and rows[lo].minute <= minute - rules.window_minutes:
            lo += 1
        hi = lo
        while hi < len(rows) and rows[hi].minute <= minute:
            hi += 1
        window = rows[lo:hi]
        trades = sum(entry.deep_trades for entry in window)
        expected = min(rules.window_minutes, minute + 1)
        if len(window) < rules.min_buckets or expected - len(window) > rules.max_missing_minutes:
            buy_run = sell_run = 0
            carried = BALANCED
            since = None
            reason = SESSION_START if minute + 1 < rules.min_buckets else GAP
            out.append(FuturesStep(minute, None, NO_DATA, reason, None, None, trades))
            continue
        totals = _deep_totals(window)
        ratio = 0.0 if totals.denominator == 0 else totals.numerator / totals.denominator
        hold = _hold_of(window, ratio, trades, rules)
        held = hold is not None or minute not in covered
        ended = (carried == BUYERS and ratio < rules.exit_ratio) or (
            carried == SELLERS and ratio > -rules.exit_ratio
        )
        if ended:
            carried = BALANCED
            since = None
            buy_run = sell_run = 0
        if carried == BALANCED:
            if not held and ratio >= rules.enter_ratio:
                buy_run += 1
                sell_run = 0
            elif not held and ratio <= -rules.enter_ratio:
                sell_run += 1
                buy_run = 0
            else:
                buy_run = sell_run = 0
            if buy_run >= rules.min_minutes:
                carried = BUYERS
                since = minute - buy_run + 1
                buy_run = sell_run = 0
            elif sell_run >= rules.min_minutes:
                carried = SELLERS
                since = minute - sell_run + 1
                buy_run = sell_run = 0
        out.append(
            FuturesStep(
                minute=minute,
                ratio=ratio,
                state=carried,
                no_data_reason=None,
                since_minute=since,
                hold=hold if carried == BALANCED else None,
                trades=trades,
            )
        )
    return out


def agreement_of(futures: str, options: str) -> AgreementResult:
    """Agreement of the futures state with the options state. Mirrors agreementOf in flow-control-rules.ts."""
    comparable = (BUYERS, SELLERS, BALANCED)
    in_control = (BUYERS, SELLERS)
    if futures not in comparable or options not in comparable:
        return AgreementResult(NOT_COMPARABLE, NEUTRAL)
    if futures not in in_control and options not in in_control:
        return AgreementResult(BOTH_BALANCED, NEUTRAL)
    if not (futures in in_control and options in in_control):
        return AgreementResult(ONE_SIDED, NEUTRAL)
    if futures != options:
        return AgreementResult(DIVERGE, NEUTRAL)
    return AgreementResult(AGREE, BULLISH if futures == BUYERS else BEARISH)
