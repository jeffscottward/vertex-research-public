"""Volume spike breakout: the rule on 1-minute mid bars (pure numpy, research only, no orders).

Pre-registered: docs/specs/strategies/volume-spike-breakout.md. Everything here is a function of the bars
and the parameters: no files, no clock, no engine. The Nautilus booking (runner.py) replays the trade list
this module returns and must agree with it.

Readings fixed before the first run (spec section 'Deviations'):
- Candles are built from the 1-minute bars on the New York clock: 15-minute candles on the quarter hours,
  4-hour candles at 00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 New York. A candle exists when it has at
  least one 1-minute bar; "the N candles before it" are the N existing candles before it.
- Volume test: candle volume >= vol_mult x the mean volume of the vol_n candles before it.
- Breakout: close > the highest high (long) or < the lowest low (short) of the k candles before it.
- Session: the signal candle closes at or after 08:30 and at or before 12:00 New York (variant `open`:
  the candle opens at or after 08:30 and before 12:00).
- Entry: the open of the first 1-minute bar of the next candle. No entry when the New York weekday of that
  bar is skipped (Wednesday), when the trend disagrees, or when the New York day already has max_entries.
- Trend: the last 4-hour candle that ended at or before the signal candle's close, against its 20-EMA
  (seeded with the simple average of the first 20 closes, as the DSL `ema`): above = long, below = short.
- Stop: a fixed distance in points, or a fraction of the entry price, from the entry open, resolved on the
  1-minute bars from the entry bar on. A bar that opens beyond the stop fills at its open. Prices are read
  at the engine's precision (9 decimals), so a touch is a touch in rules.py and in Nautilus alike.
- Opposite signal: the volume and breakout tests in the other direction on any candle (no session, weekday,
  trend or count filter). The position closes at the next open; the reverse entry is taken there when the
  entry rules allow it.
- Time stop: the open of the candle `time_stop` candles after the entry candle.
- One position at a time: a signal on a candle that closes while a position is open is ignored, also when
  that position leaves at the next open by the time stop.
- Stop first: the stop is searched on every bar before a scheduled exit bar; a scheduled exit whose bar
  opens beyond the stop is recorded as a stop (same price).
- Costs do not move the stop: R gross = side x (exit - entry) / stop distance; R net = R gross - round-trip
  cost / stop distance.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta

import numpy as np

MINUTE_MS = 60_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
LONG, SHORT = 1, -1
SIDE_NAME = {LONG: "long", SHORT: "short"}
SIGNAL_MINUTES = 15
TREND_MINUTES = 240
SOURCE_COST_R = 0.084  # the source's round-trip cost as a fraction of the stop
PRICE_DECIMALS = 9  # the price precision of the Nautilus engine (nautilus_backtest.engine.PRECISION)


def prices(values: np.ndarray) -> np.ndarray:
    """Bar prices as the Nautilus engine sees them: float64 rounded to 9 decimals. Every fill and every stop
    comparison uses these, so rules.py and the engine decide on the same numbers."""
    return np.round(np.asarray(values, dtype=np.float64), PRICE_DECIMALS)


def price(value: float) -> float:
    return float(np.round(np.float64(value), PRICE_DECIMALS))


# ------------------------------------------------------------------------------------------------
# New York clock


def _first_sunday(year: int, month: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(6 - first.weekday()) % 7)


def dst_bounds(year: int) -> tuple[int, int]:
    """UTC ms of the start and end of US daylight time (rule since 2007): the second Sunday of March at
    02:00 EST and the first Sunday of November at 02:00 EDT."""
    start = _first_sunday(year, 3) + timedelta(days=7)
    end = _first_sunday(year, 11)
    start_ms = int(datetime(start.year, start.month, start.day, 7, tzinfo=UTC).timestamp() * 1000)
    end_ms = int(datetime(end.year, end.month, end.day, 6, tzinfo=UTC).timestamp() * 1000)
    return start_ms, end_ms


def ny_offset_ms(t: np.ndarray) -> np.ndarray:
    """New York UTC offset (ms, negative) of each UTC ms timestamp."""
    t = np.asarray(t, dtype=np.int64)
    if t.size == 0:
        return np.zeros(0, dtype=np.int64)
    first = datetime.fromtimestamp(int(t.min()) / 1000, UTC).year
    last = datetime.fromtimestamp(int(t.max()) / 1000, UTC).year
    edges = np.array([edge for year in range(first, last + 1) for edge in dst_bounds(year)], dtype=np.int64)
    summer = np.searchsorted(edges, t, side="right") % 2 == 1
    return np.where(summer, -4 * HOUR_MS, -5 * HOUR_MS).astype(np.int64)


def ny_local_ms(t: np.ndarray) -> np.ndarray:
    """New York wall-clock time as ms since 1970-01-01 00:00 local."""
    t = np.asarray(t, dtype=np.int64)
    return t + ny_offset_ms(t)


def ny_ms(day: str, minute: int = 0) -> int:
    """UTC ms of a New York date and minute of day."""
    y, m, d = (int(x) for x in day.split("-"))
    naive = int(datetime(y, m, d, tzinfo=UTC).timestamp() * 1000) + minute * MINUTE_MS
    # The offset at the local time: try both and keep the one that maps back.
    for offset in (-4 * HOUR_MS, -5 * HOUR_MS):
        utc = naive - offset
        if int(ny_offset_ms(np.array([utc]))[0]) == offset:
            return utc
    return naive + 5 * HOUR_MS


def day_text(day_number: int) -> str:
    return (date(1970, 1, 1) + timedelta(days=int(day_number))).isoformat()


def session_day(t: np.ndarray) -> np.ndarray:
    """Session day number (days since 1970) of each bar: the New York date of the bar time + 7 hours, so a
    day starts at 17:00 New York (the DSL `1d` rule). Used for the daily equity points only."""
    return (ny_local_ms(t) + 7 * HOUR_MS) // DAY_MS


# ------------------------------------------------------------------------------------------------
# Bars and candles


@dataclass(frozen=True)
class Minutes:
    """1-minute mid bars in time order. `t` is the UTC ms of the bar open; volume = bid + ask volume."""

    t: np.ndarray
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray  # noqa: E741 - the usual column name
    c: np.ndarray
    v: np.ndarray

    def __len__(self) -> int:
        return int(self.t.shape[0])


@dataclass(frozen=True)
class Candles:
    """Candles built from 1-minute bars. `first`/`last` are the 1-minute indexes of a candle's bars, `start`
    the UTC ms of its open on the grid and `local` the New York wall-clock ms of that open."""

    minutes: int
    first: np.ndarray
    last: np.ndarray
    start: np.ndarray
    local: np.ndarray
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray  # noqa: E741
    c: np.ndarray
    v: np.ndarray

    def __len__(self) -> int:
        return int(self.first.shape[0])

    @property
    def open_minute(self) -> np.ndarray:
        return (self.local // MINUTE_MS) % 1440

    @property
    def close_minute(self) -> np.ndarray:
        return self.open_minute + self.minutes

    @property
    def day(self) -> np.ndarray:
        return self.local // DAY_MS

    @property
    def weekday(self) -> np.ndarray:
        """Monday = 0 (1970-01-01 was a Thursday)."""
        return (self.day + 3) % 7


def build_candles(m: Minutes, minutes: int) -> Candles:
    size = len(m)
    width = minutes * MINUTE_MS
    if size == 0:
        empty_i = np.zeros(0, dtype=np.int64)
        empty_f = np.zeros(0, dtype=np.float64)
        return Candles(minutes, empty_i, empty_i, empty_i, empty_i, empty_f, empty_f, empty_f, empty_f, empty_f)
    offset = ny_offset_ms(m.t)
    bucket = (m.t + offset) // width
    first = np.flatnonzero(np.concatenate(([True], bucket[1:] != bucket[:-1])))
    last = np.concatenate((first[1:] - 1, [size - 1]))
    local = bucket[first] * width
    return Candles(
        minutes=minutes, first=first, last=last, start=local - offset[first], local=local,
        o=m.o[first].astype(np.float64), h=np.maximum.reduceat(m.h, first).astype(np.float64),
        l=np.minimum.reduceat(m.l, first).astype(np.float64), c=m.c[last].astype(np.float64),
        v=np.add.reduceat(m.v.astype(np.float64), first),
    )


def mean_before(values: np.ndarray, length: int) -> np.ndarray:
    """Mean of the `length` values before each index (NaN until `length` values exist)."""
    out = np.full(values.shape[0], np.nan)
    if values.shape[0] > length:
        total = np.concatenate(([0.0], np.cumsum(values, dtype=np.float64)))
        out[length:] = (total[length:-1] - total[:-length - 1]) / length
    return out


def extreme_before(values: np.ndarray, length: int, highest: bool) -> np.ndarray:
    """Highest (or lowest) of the `length` values before each index (NaN until `length` values exist)."""
    out = np.full(values.shape[0], np.nan)
    if values.shape[0] > length:
        windows = np.lib.stride_tricks.sliding_window_view(values, length)
        reduced = windows.max(axis=1) if highest else windows.min(axis=1)
        out[length:] = reduced[:-1]
    return out


def volume_spike(volume: np.ndarray, vol_mult: float, vol_n: int) -> np.ndarray:
    base = mean_before(volume, vol_n)
    with np.errstate(invalid="ignore"):
        return (base > 0) & (volume >= vol_mult * base)


def breakout(cd: Candles, k: int) -> tuple[np.ndarray, np.ndarray]:
    with np.errstate(invalid="ignore"):
        return cd.c > extreme_before(cd.h, k, True), cd.c < extreme_before(cd.l, k, False)


def ema(values: np.ndarray, length: int) -> np.ndarray:
    """Exponential average seeded with the simple average of the first `length` values (the DSL `ema`)."""
    out = np.full(values.shape[0], np.nan)
    if values.shape[0] < length:
        return out
    alpha = 2 / (length + 1)
    value = float(values[:length].mean())
    out[length - 1] = value
    for index in range(length, values.shape[0]):
        value += alpha * (float(values[index]) - value)
        out[index] = value
    return out


def trend_of(cd: Candles, slow: Candles, length: int) -> np.ndarray:
    """+1 / -1 per signal candle: the last slow candle that ended at or before the signal candle's close is
    above / below its EMA; 0 when there is none yet or the close equals the EMA."""
    out = np.zeros(len(cd), dtype=np.int8)
    if len(slow) == 0 or len(cd) == 0:
        return out
    average = ema(slow.c, length)
    with np.errstate(invalid="ignore"):
        state = np.where(slow.c > average, 1, np.where(slow.c < average, -1, 0)).astype(np.int8)
    width = slow.minutes * MINUTE_MS
    slow_id = slow.local // width
    closed = (cd.local + cd.minutes * MINUTE_MS) // width - 1
    position = np.searchsorted(slow_id, closed, side="right") - 1
    valid = position >= 0
    out[valid] = state[position[valid]]
    return out


# ------------------------------------------------------------------------------------------------
# Parameters, costs, trades


@dataclass(frozen=True)
class Params:
    vol_mult: float = 3.0
    vol_n: int = 50
    k: int = 5
    stop_kind: str = "points"  # points | pct | none
    stop: float = 15.0  # points, or a fraction of the entry price (pct)
    time_stop: int = 80
    session_from: int = 8 * 60 + 30
    session_to: int = 12 * 60
    session_on: str = "close"  # close | open
    skip_weekdays: tuple[int, ...] = (2,)
    trend: bool = True
    trend_length: int = 20
    max_entries: int | None = 2
    sides: tuple[str, ...] = ("long", "short")

    def __post_init__(self) -> None:
        if self.stop_kind not in ("points", "pct", "none"):
            raise ValueError(f"Unknown stop kind {self.stop_kind}")
        if self.session_on not in ("close", "open"):
            raise ValueError(f"Unknown session test {self.session_on}")
        if self.stop_kind != "none" and not self.stop > 0:
            raise ValueError("The stop must be above 0")
        if self.vol_n < 1 or self.k < 1 or self.time_stop < 1:
            raise ValueError("vol_n, k and time_stop must be at least 1")

    def stop_distance(self, entry: float) -> float:
        if self.stop_kind == "points":
            return self.stop
        if self.stop_kind == "pct":
            return self.stop * entry
        return math.nan


@dataclass(frozen=True)
class Costs:
    """Costs of one side of a trade per unit, in price units: `per_unit` + price x `rate`, on a sell price x
    `sale_rate` more, and `stop_fraction` x the stop distance of the trade. They are charged next to the fill;
    they do not move the entry or the stop."""

    per_unit: float = 0.0
    rate: float = 0.0
    sale_rate: float = 0.0
    stop_fraction: float = 0.0

    def side(self, price: float, sell: bool, stop: float = 0.0) -> float:
        fixed = self.stop_fraction * stop if self.stop_fraction else 0.0
        return self.per_unit + price * (self.rate + (self.sale_rate if sell else 0.0)) + fixed

    def round_trip(self, side: int, entry: float, exit_: float, stop: float = 0.0) -> float:
        return self.side(entry, side == SHORT, stop) + self.side(exit_, side == LONG, stop)

    def times(self, multiple: float) -> Costs:
        return Costs(self.per_unit * multiple, self.rate * multiple, self.sale_rate * multiple,
                     self.stop_fraction * multiple)


def source_costs(params: Params, fraction: float = SOURCE_COST_R) -> Costs:
    """The source's costs: `fraction` of the stop per round trip (0.084 x 15 points = 1.26 NAS100 points),
    half per side. With a percent stop it is the same fraction of the trade's own stop distance at entry, so
    every trade pays exactly 0.084R."""
    if params.stop_kind == "points":
        return Costs(per_unit=fraction * params.stop / 2)
    if params.stop_kind == "pct":
        return Costs(stop_fraction=fraction / 2)
    raise ValueError("Source costs need a stop")


@dataclass(frozen=True)
class Trade:
    side: int
    signal: int  # index of the signal candle
    entry_index: int  # 1-minute bar indexes
    exit_index: int
    entry_ms: int
    exit_ms: int
    entry: float
    exit: float
    stop: float  # distance in price units (NaN without a stop)
    reason: str  # stop | opposite | time | end
    r_gross: float
    r_net: float
    # True when the exit filled at the open of its bar (opposite signal, time stop, a stop gapped through): it is
    # known at `exit_ms`. False for a stop touched inside its bar and for the end of the data: known when that
    # bar ends.
    exit_at_open: bool = True

    @property
    def side_name(self) -> str:
        return SIDE_NAME[self.side]


def r_multiples(side: int, entry: float, exit_: float, stop: float, costs: Costs) -> tuple[float, float]:
    """(R gross, R net) of one trade; NaN without a stop distance."""
    if not (stop > 0 and math.isfinite(stop)):
        return math.nan, math.nan
    gross = side * (exit_ - entry) / stop
    return gross, gross - costs.round_trip(side, entry, exit_, stop) / stop


def reprice(trades: Sequence[Trade], costs: Costs) -> list[Trade]:
    """The same trades with the net R of another cost set (costs never move a fill or a stop)."""
    return [replace(t, r_net=r_multiples(t.side, t.entry, t.exit, t.stop, costs)[1]) for t in trades]


def worse_stop_fills(m: Minutes, trades: Sequence[Trade], fraction: float, costs: Costs = Costs()) -> list[Trade]:
    """Information only: the same trades with every stop exit filled `fraction` of the way from the modelled
    fill (the stop level, or the open of a bar that gapped through it) to the extreme of the bar it filled in
    (the low for a long, the high for a short). 0 is the model; 0.5 is half-way. Entries, exit bars and the other
    exits do not change, so the trade list is the same."""
    out = []
    for t in trades:
        if t.reason != "stop":
            out.append(replace(t, r_net=r_multiples(t.side, t.entry, t.exit, t.stop, costs)[1]))
            continue
        extreme = price(m.l[t.exit_index]) if t.side == LONG else price(m.h[t.exit_index])
        worse = t.exit + fraction * (extreme - t.exit)
        filled = min(t.exit, worse) if t.side == LONG else max(t.exit, worse)
        gross, net = r_multiples(t.side, t.entry, filled, t.stop, costs)
        out.append(replace(t, exit=filled, r_gross=gross, r_net=net))
    return out


# ------------------------------------------------------------------------------------------------
# Signals


@dataclass(frozen=True)
class Frame:
    """One market: its 1-minute bars with the signal (15-minute) and trend (4-hour) candles."""

    m: Minutes
    cd: Candles
    slow: Candles


def frame(m: Minutes) -> Frame:
    return Frame(m, build_candles(m, SIGNAL_MINUTES), build_candles(m, TREND_MINUTES))


def raw_signals(cd: Candles, params: Params) -> tuple[np.ndarray, np.ndarray]:
    """(long, short) per candle: the volume test and the breakout test, nothing else."""
    spike = volume_spike(cd.v, params.vol_mult, params.vol_n)
    up, down = breakout(cd, params.k)
    return spike & up, spike & down


def session_mask(cd: Candles, params: Params) -> np.ndarray:
    if params.session_on == "close":
        minute = cd.close_minute
        return (minute >= params.session_from) & (minute <= params.session_to)
    minute = cd.open_minute
    return (minute >= params.session_from) & (minute < params.session_to)


def entry_mask(cd: Candles, params: Params, start_ms: int, end_ms: int) -> np.ndarray:
    """Signal candles whose entry is allowed by the session, the weekday of the entry and the trading window
    [start_ms, end_ms). The entry candle is the next EXISTING candle (index + 1), also after a gap in the data
    or a closed market: the "next 15-minute open" is the open of the next candle that has a bar. The weekday
    and the window are those of that candle. The trend and the per-day count are applied elsewhere."""
    size = len(cd)
    out = np.zeros(size, dtype=bool)
    if size < 2:
        return out
    weekday = cd.weekday[1:]
    allowed = ~np.isin(weekday, np.array(params.skip_weekdays, dtype=np.int64))
    entry_time = cd.start[1:]
    out[:-1] = session_mask(cd, params)[:-1] & allowed & (entry_time >= start_ms) & (entry_time < end_ms)
    return out


def entry_signals(fr: Frame, params: Params, start_ms: int, end_ms: int
                  ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(enter long, enter short, raw long, raw short) per signal candle."""
    raw_long, raw_short = raw_signals(fr.cd, params)
    allowed = entry_mask(fr.cd, params, start_ms, end_ms)
    enter_long, enter_short = raw_long & allowed, raw_short & allowed
    if params.trend:
        trend = trend_of(fr.cd, fr.slow, params.trend_length)
        enter_long = enter_long & (trend > 0)
        enter_short = enter_short & (trend < 0)
    if "long" not in params.sides:
        enter_long = np.zeros_like(enter_long)
    if "short" not in params.sides:
        enter_short = np.zeros_like(enter_short)
    return enter_long, enter_short, raw_long, raw_short


# ------------------------------------------------------------------------------------------------
# Trades


@dataclass
class _Position:
    side: int
    signal: int
    entry_index: int
    entry: float
    stop: float
    exit_index: int
    exit: float
    reason: str
    flip: int  # the candle whose opposite signal closes it at the next open, or -1
    at_open: bool = True  # the exit filled at the open of its bar


def _beyond(side: int, price: float, level: float) -> bool:
    return price <= level if side == LONG else price >= level


def _open_position(m: Minutes, cd: Candles, side: int, signal: int, opposite: np.ndarray, params: Params
                   ) -> _Position:
    """Enters at the open of candle `signal + 1` and resolves the exit: the first of stop, opposite signal,
    time stop and the end of the data."""
    candle = signal + 1
    e = int(cd.first[candle])
    entry = price(m.o[e])
    distance = params.stop_distance(entry)
    has_stop = math.isfinite(distance)
    level = round(entry - side * distance, PRICE_DECIMALS) if has_stop else math.nan
    size = len(m)
    timed = candle + params.time_stop
    time_bar = int(cd.first[timed]) if timed < len(cd) else size
    at = int(np.searchsorted(opposite, candle, side="left"))
    flip = int(opposite[at]) if at < opposite.shape[0] else -1
    flip_bar = int(cd.first[flip + 1]) if flip >= 0 and flip + 1 < len(cd) else size
    if flip_bar >= size:
        flip = -1
    scheduled = min(time_bar, flip_bar)
    if has_stop:
        if side == LONG:
            hit = prices(m.l[e:scheduled]) <= level
        else:
            hit = prices(m.h[e:scheduled]) >= level
        if hit.any():
            i = e + int(np.argmax(hit))
            opened = price(m.o[i])
            gapped = i > e and _beyond(side, opened, level)
            return _Position(side, signal, e, entry, distance, i, opened if gapped else level, "stop", -1, gapped)
    if scheduled >= size:
        return _Position(side, signal, e, entry, distance, size - 1, price(m.c[size - 1]), "end", -1, False)
    exit_price = price(m.o[scheduled])
    by_flip = flip_bar <= time_bar
    reason = "opposite" if by_flip else "time"
    if has_stop and _beyond(side, exit_price, level):
        reason = "stop"
    return _Position(side, signal, e, entry, distance, scheduled, exit_price, reason, flip if by_flip else -1)


def _trade(m: Minutes, position: _Position, costs: Costs) -> Trade:
    gross, net = r_multiples(position.side, position.entry, position.exit, position.stop, costs)
    return Trade(position.side, position.signal, position.entry_index, position.exit_index,
                 int(m.t[position.entry_index]), int(m.t[position.exit_index]), position.entry, position.exit,
                 position.stop, position.reason, gross, net, position.at_open)


def simulate(m: Minutes, cd: Candles, enter_long: np.ndarray, enter_short: np.ndarray, exit_long: np.ndarray,
             exit_short: np.ndarray, params: Params, costs: Costs = Costs()) -> list[Trade]:
    """The trade list. `enter_*` mark signal candles whose entry is allowed (all filters but the per-day
    count); `exit_long` / `exit_short` mark candles whose close ends a long / short at the next open."""
    size = len(cd)
    ends_long = np.flatnonzero(exit_long)
    ends_short = np.flatnonzero(exit_short)
    day = cd.day
    taken: dict[int, int] = {}
    trades: list[Trade] = []
    position: _Position | None = None
    for j in np.flatnonzero(enter_long | enter_short):
        j = int(j)
        if j + 1 >= size:
            break
        if position is not None:
            closed = position.exit_index <= int(cd.last[j])
            reversing = position.flip == j
            if not (closed or reversing):
                continue
            trades.append(_trade(m, position, costs))
            position = None
        side = LONG if enter_long[j] else SHORT
        entry_day = int(day[j + 1])
        if params.max_entries is not None and taken.get(entry_day, 0) >= params.max_entries:
            continue
        taken[entry_day] = taken.get(entry_day, 0) + 1
        position = _open_position(m, cd, side, j, ends_long if side == LONG else ends_short, params)
    if position is not None:
        trades.append(_trade(m, position, costs))
    return trades


def run_rule(fr: Frame, params: Params, start_ms: int, end_ms: int, costs: Costs = Costs()) -> list[Trade]:
    """The rule as stated on one market: entries inside [start_ms, end_ms), earlier bars only warm up."""
    enter_long, enter_short, raw_long, raw_short = entry_signals(fr, params, start_ms, end_ms)
    return simulate(fr.m, fr.cd, enter_long, enter_short, raw_short, raw_long, params, costs)


# ------------------------------------------------------------------------------------------------
# Random-entry control


def random_control(fr: Frame, params: Params, start_ms: int, end_ms: int, count: int, rng: np.random.Generator,
                   costs: Costs = Costs(), rounds: int = 40) -> list[Trade]:
    """`count` entries at random signal candles of the same session and weekdays with a random direction;
    the same stop, time stop, per-day count and one-position rule, and the real opposite signals as exits.
    No volume, breakout or trend test decides the entry. Candidates are added until `count` entries are
    taken (a candidate that falls inside an open position is ignored, as a real signal would be)."""
    cd = fr.cd
    raw_long, raw_short = raw_signals(cd, params)
    eligible = np.flatnonzero(entry_mask(cd, params, start_ms, end_ms))
    if count <= 0 or eligible.shape[0] == 0:
        return []
    order = rng.permutation(eligible)
    longs = rng.integers(0, 2, size=order.shape[0]).astype(bool)
    take = min(count, order.shape[0])
    best: list[Trade] = []
    for _ in range(rounds):
        enter_long = np.zeros(len(cd), dtype=bool)
        enter_short = np.zeros(len(cd), dtype=bool)
        enter_long[order[:take][longs[:take]]] = True
        enter_short[order[:take][~longs[:take]]] = True
        trades = simulate(fr.m, cd, enter_long, enter_short, raw_short, raw_long, params, costs)
        if not best or abs(len(trades) - count) < abs(len(best) - count):
            best = trades
        missing = count - len(trades)
        if missing == 0 or (missing > 0 and take >= order.shape[0]):
            break
        take = max(1, min(order.shape[0], take + missing))
    return best


__all__ = [
    "LONG", "SHORT", "SIDE_NAME", "SOURCE_COST_R", "Candles", "Costs", "Frame", "Minutes", "Params", "Trade",
    "breakout", "build_candles", "day_text", "dst_bounds", "ema", "entry_mask", "entry_signals", "extreme_before",
    "frame", "mean_before", "ny_local_ms", "ny_ms", "ny_offset_ms", "price", "prices", "r_multiples",
    "random_control", "raw_signals",
    "reprice", "run_rule", "session_day", "session_mask", "simulate", "source_costs", "trend_of", "volume_spike",
    "worse_stop_fills",
]
