"""Tests G and H: the dry-run trend book, the sector rotation book and the drawdown brake (real ETF prices).

`atr_book` ports `trend` of market-watch-bot `market_watch/research/backtests.py` (the rules of
`market_watch/copyrot/trend.py`): on each month-end close the selector names the wanted ETFs; each gets the
weight risk / (2 x ATR / close), at most 15%, all scaled to at most 100%; names no longer wanted are sold;
the exit stop is close - `stop_atr` x ATR, checked on each close; a stopped name stays flat until the next
decision, and a held name keeps the higher of its old and new stop. Costs 0.06% per side. Unlike the source
backtest, cash earns the T-bill rate (the stopping premium compares the strategy with the safe asset).

Selectors
  * trend: month-end close above the 10-month average of month-end closes; ATR over 20 days;
  * rotation (`market_watch/copyrot/rotation.py`, momentum part only: the regime tilt, Crown view, flow and
    news inputs have no history): not eligible below a falling 200-day average (lower than 10 sessions ago);
    score = mean percentile rank of the 3- and 6-month return relative to SPY; the top 8; ATR over 14 days.

Drawdown brake (`market_watch/risk/__init__.py`): at a decision, a drawdown of the book from its peak of at
least 10% halves the risk per trade (1% -> 0.5%) and of at least 15% allows no new entries and no increases.
Held names are never cut by the brake.
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from .bars import Series, atr, month_ends, rolling_mean
from .portfolio import PathReturns

COST = 0.0006
RISK, CAP, SIZE_ATR = 0.01, 0.15, 2.0
BRAKE1_RISK_FACTOR = 0.5  # risk.LIMITS: brake1_trade_risk_pct 0.5 against trade_risk_pct 1.0
ROTATION_HOLD = 8


@dataclass
class Aligned:
    """Names aligned on one calendar; before a name's first bar its values are None."""

    calendar: list[str]
    close: dict[str, list[float | None]]
    atr20: dict[str, list[float | None]]
    atr14: dict[str, list[float | None]]


def align(names: dict[str, Series], calendar: Sequence[str]) -> Aligned:
    close, a20, a14 = {}, {}, {}
    for sym, s in names.items():
        idx = s.index()
        r20 = atr(s.high, s.low, s.close, 20)
        r14 = atr(s.high, s.low, s.close, 14)
        c, x20, x14 = [], [], []
        last: tuple[float | None, float | None, float | None] = (None, None, None)
        for d in calendar:
            i = idx.get(d)
            if i is not None:
                last = (s.close[i], r20[i], r14[i])
            c.append(last[0])
            x20.append(last[1])
            x14.append(last[2])
        close[sym], a20[sym], a14[sym] = c, x20, x14
    return Aligned(list(calendar), close, a20, a14)


Selector = Callable[[Aligned, int], dict[str, tuple[float, float]]]  # name -> (close, ATR) of wanted names


def trend_selector(months: int = 10) -> Selector:
    def select(al: Aligned, k: int) -> dict[str, tuple[float, float]]:
        ends = sorted(i for i in month_ends(al.calendar) if i <= k)
        out = {}
        for sym, c in al.close.items():
            m = [x for x in (c[i] for i in ends[-months:]) if x is not None]
            now, at = c[k], al.atr20[sym][k]
            if len(m) < months or now is None or at is None:
                continue
            if now > sum(m) / months:
                out[sym] = (now, at)
        return out
    return select


def _ret(c: list[float | None], k: int, n: int) -> float | None:
    if k - n < 0:
        return None
    a, b = c[k], c[k - n]
    return None if a is None or b is None else a / b - 1


def _rank(values: dict[str, float]) -> dict[str, float]:
    order = sorted(values, key=lambda s: values[s])
    n = len(order)
    return {s: (i / (n - 1) if n > 1 else 0.5) for i, s in enumerate(order)}


def rotation_selector(benchmark: str = "SPY", hold: int = ROTATION_HOLD) -> Selector:
    ma200: dict[str, list[float | None]] = {}

    def select(al: Aligned, k: int) -> dict[str, tuple[float, float]]:
        if not ma200:
            for sym, c in al.close.items():
                filled = [x if x is not None else 0.0 for x in c]
                m = rolling_mean(filled, 200)
                ma200[sym] = [None if c[i] is None or (i >= 199 and c[i - 199] is None) else m[i] for i in range(len(c))]
        spy = al.close[benchmark]
        b3, b6 = _ret(spy, k, 63), _ret(spy, k, 126)
        rs3: dict[str, float] = {}
        rs6: dict[str, float] = {}
        quotes: dict[str, tuple[float, float]] = {}
        for sym in al.close:
            a3, a6 = _ret(al.close[sym], k, 63), _ret(al.close[sym], k, 126)
            c, at = al.close[sym][k], al.atr14[sym][k]
            if sym == benchmark or a3 is None or a6 is None or b3 is None or b6 is None or c is None or at is None:
                continue
            m, mp = ma200[sym][k], ma200[sym][k - 10] if k >= 10 else None
            if m is not None and mp is not None and c < m and m < mp:
                continue
            rs3[sym], rs6[sym] = a3 - b3, a6 - b6
            quotes[sym] = (c, at)
        r3, r6 = _rank(rs3), _rank(rs6)
        score = {s: r3[s] + r6[s] for s in rs3}
        top = sorted(score, key=lambda s: (-score[s], s))[:hold]
        return {s: quotes[s] for s in top}
    return select


def weights(picks: dict[str, tuple[float, float]], risk: float) -> dict[str, float]:
    """Book weight per wanted name: risk / (2 x ATR / close), at most CAP, all scaled to at most 100%."""
    w = {s: min(risk / (SIZE_ATR * at / c), CAP) for s, (c, at) in picks.items()}
    tot = sum(w.values())
    scale = min(1.0, 1.0 / tot) if tot else 1.0
    return {s: x * scale for s, x in w.items()}


def brake_level(equity: float, peak: float, brake: tuple[float, float]) -> int:
    """0 = no brake, 1 = half risk per trade, 2 = no new entries. Port of risk.trade_risk_pct: the drawdown in
    percent rounded to 6 decimals, compared with <=."""
    dd = min(0.0, round((equity / peak - 1) * 100, 6)) if peak > 0 else 0.0
    if dd <= -brake[1] * 100:
        return 2
    return 1 if dd <= -brake[0] * 100 else 0


@dataclass
class BookResult:
    returns: list[float] = field(default_factory=list)
    out: list[float] = field(default_factory=list)
    stop_events: int = 0
    days_to_stop: list[int] = field(default_factory=list)
    brake_events: int = 0
    brake_days: int = 0
    brake_flags: list[float] = field(default_factory=list)  # 1 on days the brake is active
    stop_dates: set[int] = field(default_factory=set)        # calendar index of each day with a stop exit


def atr_book(al: Aligned, rf: Sequence[float], select: Selector, *, start: int, end: int,
             stop_atr: float | None = 2.0, brake: tuple[float, float] | None = None) -> BookResult:
    """Daily returns of the book on calendar days start+1..end-1 (decisions from `start`)."""
    ends = month_ends(al.calendar)
    cash = 1.0
    pos: dict[str, dict] = {}
    stopped: dict[str, float] = {}  # name -> value sold by its stop since the last decision
    res = BookResult()
    peak, level = 1.0, 0

    def value(k: int) -> float:
        return cash + sum(p["val"] for p in pos.values())

    def sell(sym: str) -> None:
        nonlocal cash
        cash += pos.pop(sym)["val"] * (1 - COST)

    prev = 1.0
    for k in range(start, end):
        if k > start:
            cash *= 1 + rf[k]
            for sym, p in pos.items():
                c0, c1 = al.close[sym][k - 1], al.close[sym][k]
                if c0 and c1:
                    p["val"] *= c1 / c0
            if stop_atr is not None:
                for sym in list(pos):
                    c = al.close[sym][k]
                    if c is not None and c <= pos[sym]["stop"]:
                        res.stop_events += 1
                        res.stop_dates.add(k)
                        res.days_to_stop.append(k - pos[sym]["k"])
                        stopped[sym] = pos[sym]["val"]
                        sell(sym)
        if k in ends:
            eq = value(k)
            peak = max(peak, eq)
            new_level = 0
            if brake is not None:
                new_level = brake_level(eq, peak, brake)
                if new_level and not level:
                    res.brake_events += 1
            level = new_level
            picks = select(al, k)
            normal_w = weights(picks, RISK)
            braked_w = weights(picks, RISK * BRAKE1_RISK_FACTOR) if level == 1 else normal_w
            for sym in list(pos):
                if sym not in picks:
                    sell(sym)
            eq = value(k)
            stopped = {}
            for sym, (c, at) in picks.items():
                stop = c - (stop_atr if stop_atr is not None else SIZE_ATR) * at
                normal = normal_w[sym] * eq
                cur = pos[sym]["val"] if sym in pos else 0.0
                if level == 2:    # no new entries and no increases
                    target = min(cur, normal)
                elif level == 1:  # new risk per trade halved: at most the half-risk size, held names not cut
                    target = min(normal, max(cur, braked_w[sym] * eq))
                else:
                    target = normal
                if sym in pos:
                    pos[sym]["stop"] = max(pos[sym]["stop"], stop)
                diff = target - cur
                if abs(diff) < 0.01 * eq:
                    continue
                if diff > 0:
                    amt = min(diff, cash)
                    if amt <= 0:
                        continue
                    cash -= amt
                    if sym in pos:
                        pos[sym]["val"] += amt * (1 - COST)
                    else:
                        pos[sym] = {"val": amt * (1 - COST), "stop": stop, "k": k}
                else:
                    cash += -diff * (1 - COST)
                    pos[sym]["val"] += diff
        if level:
            res.brake_days += 1
        if k > start:
            v = value(k)
            res.returns.append(v / prev - 1)
            res.out.append(min(1.0, sum(stopped.values()) / v) if v > 0 else 0.0)
            res.brake_flags.append(1.0 if level else 0.0)
            prev = v
        else:
            prev = value(k)
    return res


def ma_rule_path(s: Series, lo: int, hi: int, rf: Sequence[float], start: int, months: int = 10) -> PathReturns:
    """One ETF: in when its month-end close is above the `months`-month average of month-end closes, else in
    T-bills (decided at each month-end close, cost per switch COST), against buy and hold."""
    ends = sorted(month_ends(s.dates))
    end_set = set(ends)
    path = PathReturns(start=start)
    inside = True
    past: list[float] = [s.close[j] for j in ends if j <= lo]
    for i in range(lo + 1, hi):
        r = s.close[i] / s.close[i - 1] - 1
        rw = r if inside else rf[i]
        if i in end_set:
            past.append(s.close[i])
            if len(past) >= months:
                want = s.close[i] > sum(past[-months:]) / months
                if want != inside:
                    rw = (1 + rw) * (1 - COST) - 1
                    if not want:
                        path.stop(i - lo)
                    inside = want
        path.add(rw, r, 0.0 if inside else 1.0)
    return path
