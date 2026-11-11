"""Options forms of the nine QuantJourney ORDER strategies that trade daily bars with resting orders.

Upstream (`quantjourney-bt/strategies/example_orders_NN_*.py`) each strategy submits orders to a
fill engine after the close of a bar. Here one machine (`run`) replays that per symbol on the
adjusted daily bars (`forms.adjusted`), driven by one parameter row per strategy (`SPECS`). The
form keeps the stance only: +1 while the rule holds shares, 0 while it is flat.

What the machine takes from the upstream engine (`backtester/execution/fill_engine.py`,
`simulator.py`, read on 2026-11-11):

- Order of a bar: first the resting orders are matched against the bar, then the strategy reads the
  bar and submits. An order submitted on bar t is matched from bar t+1. A market order fills at the
  open of bar t+1.
- Several resting orders of one symbol are matched in the order stop, stop-limit, trailing stop,
  trailing stop-limit, OCO, limit, market; equal kinds in the order of submission. So of the two
  OCO legs the limit leg (submitted first) wins a bar that reaches both.
- Buy limit: fills when low <= limit, at min(open, limit). Buy stop: fills when high >= stop, at
  max(open, stop). Sells mirror this.
- Stop-limit: the bar that reaches the stop arms the limit. From then on the order is a limit order
  and stays one on later bars; on the arming bar the price reference is max(open, stop) for a buy
  (min for a sell) instead of the open. A buy that gaps over its limit therefore still fills at the
  limit if the low of that bar or of a later bar comes back to the limit.
- Trailing stop: the anchor is the highest HIGH (not close) of the bars the order has been matched
  against, the current bar included, and it is raised before the stop is checked. The stop is
  anchor * (1 - percent) or anchor - amount. The trailing stop-limit arms at that stop with the
  limit `offset` below it and then behaves like an armed stop-limit.
- `expires_after_bars=n`: the order is matched against n bars, then it is gone. Without it the
  order rests until it fills or the strategy cancels it.

What the form does not keep: order sizes and the share of equity per trade, slippage and
commission (the average entry price is the fill price before slippage), and the upstream universe
(SPY, QQQ, IWM; the form runs every rule on each Core 7 symbol with that symbol's own bars and its
own bar count). RSI is Wilder's (`forms.rsi`).

The stance of bar i is the position after the fills of bar i, with a market order submitted at the
close of bar i counted as done: it fills at the next open whatever that bar does. Nothing of bar
i+1 is read.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .data import Bars
from .forms import CORE7, Form, Inputs, adjusted, rsi, sma

__all__ = ["FORMS", "SPECS", "Order", "Spec", "fill_price", "run"]

# --------------------------------------------------------------------------- orders

MARKET, LIMIT, STOP, STOP_LIMIT, TRAIL, TRAIL_LIMIT, OCO = (
    "market", "limit", "stop", "stop_limit", "trail", "trail_limit", "oco")
PRIORITY = {STOP: 0, STOP_LIMIT: 1, TRAIL: 2, TRAIL_LIMIT: 3, OCO: 4, LIMIT: 5, MARKET: 6}


@dataclass
class Order:
    """One resting order. `valid`: bars it is matched against before it expires (None: no expiry).
    `pair`: OCO group; a fill cancels the other orders of the group. `anchor` and `armed` are the
    state of trailing and stop-limit orders (the trailing extreme, the limit once the stop was reached)."""

    kind: str
    buy: bool
    limit: float | None = None
    stop: float | None = None
    trail_pct: float | None = None
    trail_amount: float | None = None
    offset: float = 0.0
    valid: int | None = None
    pair: int | None = None
    live: int = 0
    anchor: float | None = None
    armed: float | None = None
    active: bool = True


def fill_price(order: Order, open_: float, high: float, low: float) -> float | None:
    """The price at which `order` fills on this bar, None if it does not. Updates the trailing
    anchor and arms a stop-limit, as the upstream engine does while it matches."""

    def at_limit(limit: float, reference: float) -> float | None:
        if order.buy:
            return min(limit, reference) if low <= limit else None
        return max(limit, reference) if high >= limit else None

    def at_stop(stop: float) -> float | None:
        if order.buy:
            return max(stop, open_) if high >= stop else None
        return min(stop, open_) if low <= stop else None

    if order.kind == MARKET:
        return open_
    if order.kind == LIMIT:
        return at_limit(order.limit, open_)
    if order.kind == STOP:
        return at_stop(order.stop)
    if order.kind == OCO:  # a leg carries a stop or a limit
        return at_stop(order.stop) if order.stop is not None else at_limit(order.limit, open_)
    away = 1 if order.buy else -1  # a buy stop sits above the market, a sell stop below
    stop = order.stop
    if order.kind in (TRAIL, TRAIL_LIMIT):
        extreme = low if order.buy else high
        if order.anchor is None or (extreme - order.anchor) * away < 0:
            order.anchor = extreme
        distance = order.trail_amount if order.trail_amount is not None else order.anchor * order.trail_pct
        stop = order.anchor + away * distance
    if order.kind == TRAIL:
        return at_stop(stop)
    reference = open_
    if order.armed is None:
        reference = at_stop(stop)
        if reference is None:
            return None
        order.armed = order.limit if order.kind == STOP_LIMIT else stop + away * order.offset
    return at_limit(order.armed, reference)


# --------------------------------------------------------------------------- strategies

@dataclass(frozen=True)
class Spec:
    """One strategy as parameters of the machine.

    `signal`: what the rule reads. "rsi": RSI(14) of the close, entry below `level`, exit above
    `exit_level`. "sma": close against SMA(50), entry above, exit below. "cross": SMA(20) against
    SMA(50), entry on the bar it turns above, exit on the bar it turns not above. "breakout": the
    highest of the 20 closes before the bar; always ready to enter from bar 21. "clock": entry on
    every `every`-th bar.
    `entry`: the kind of the entry order. Limit at close * `limit_pct`; stop at base * `stop_pct`
    (base: the prior high for "breakout", else the close); stop-limit with the limit at stop *
    `cap_pct`; "oco": the limit and the stop as one OCO pair. `valid`: bars the entry order lives.
    `chain`: the branches of the upstream `_compute_orders` in their order; the first branch whose
    condition holds is taken and ends the bar. "enter", "target" (limit sell at entry * pct, valid
    for n bars: `target`), "protect" (one protective order per position: `protect`), "signal_exit"
    and "time_exit" (market sell on the `hold`-th bar after the bar that first saw the position).
    `protect`: (STOP_LIMIT, stop factor, limit factor) of the entry price; (TRAIL, percent, None);
    (TRAIL_LIMIT, trail, offset) as fractions of the close of the bar that submits it.
    """

    signal: str
    entry: str
    chain: tuple[str, ...]
    level: float | None = None
    exit_level: float | None = None
    limit_pct: float | None = None
    stop_pct: float | None = None
    cap_pct: float | None = None
    valid: int | None = None
    target: tuple[float, int] | None = None
    protect: tuple[str, float, float | None] | None = None
    hold: int | None = None
    every: int = 1


RSI_LENGTH, FAST, SLOW, BREAKOUT = 14, 20, 50, 20
PROTECTED = ("enter", "protect", "signal_exit")  # upstream order: a position without its stop gets the stop first

SPECS: dict[str, Spec] = {
    "qj/O03": Spec("rsi", LIMIT, ("enter", "target"), level=40, limit_pct=0.985, valid=3, target=(1.03, 3)),
    "qj/O04": Spec("sma", LIMIT, ("enter", "signal_exit", "target"), limit_pct=0.99, valid=2, target=(1.04, 5)),
    "qj/O05": Spec("breakout", STOP, ("time_exit", "enter"), stop_pct=1.002, valid=5, hold=10),
    "qj/O07": Spec("breakout", STOP_LIMIT, ("time_exit", "enter"), stop_pct=1.002, cap_pct=1.004, valid=5, hold=12),
    "qj/O08": Spec("cross", MARKET, PROTECTED, protect=(STOP_LIMIT, 0.96, 0.955)),
    "qj/O09": Spec("cross", MARKET, PROTECTED, protect=(TRAIL, 0.04, None)),
    "qj/O10": Spec("rsi", MARKET, PROTECTED, level=38, exit_level=65, protect=(TRAIL, 0.05, None)),
    "qj/O11": Spec("cross", MARKET, PROTECTED, protect=(TRAIL_LIMIT, 0.04, 0.005)),
    "qj/O14": Spec("clock", OCO, ("time_exit", "enter"), limit_pct=0.98, stop_pct=1.02, valid=5, hold=10, every=5),
}


def _entry_orders(spec: Spec, close: float, base: float, pair: int) -> list[Order]:
    limit = None if spec.limit_pct is None else round(close * spec.limit_pct, 2)
    stop = None if spec.stop_pct is None else round(base * spec.stop_pct, 2)
    if spec.entry == MARKET:
        return [Order(MARKET, True)]
    if spec.entry == LIMIT:
        return [Order(LIMIT, True, limit=limit, valid=spec.valid)]
    if spec.entry == STOP:
        return [Order(STOP, True, stop=stop, valid=spec.valid)]
    if spec.entry == STOP_LIMIT:
        return [Order(STOP_LIMIT, True, stop=stop, limit=round(stop * spec.cap_pct, 2), valid=spec.valid)]
    if spec.entry == OCO:
        return [Order(OCO, True, limit=limit, valid=spec.valid, pair=pair),
                Order(OCO, True, stop=stop, valid=spec.valid, pair=pair)]
    raise ValueError(f"Unknown entry kind {spec.entry!r}")


def _protective(spec: Spec, entry_price: float, close: float) -> Order:
    kind, first, second = spec.protect
    if kind == STOP_LIMIT:
        return Order(STOP_LIMIT, False, stop=round(entry_price * first, 2), limit=round(entry_price * second, 2))
    if kind == TRAIL:
        return Order(TRAIL, False, trail_pct=first)
    if kind == TRAIL_LIMIT:
        return Order(TRAIL_LIMIT, False, trail_amount=round(close * first, 2), offset=round(close * second, 2))
    raise ValueError(f"Unknown protective kind {kind!r}")


def run(bars: Bars, spec: Spec) -> list[int]:
    """The stance of one symbol under `spec`: 1 or 0 per bar. Bar i reads bars 0..i only."""
    data = adjusted(bars)
    closes = data.close
    value = rsi(closes, RSI_LENGTH) if spec.signal == "rsi" else None
    slow = sma(closes, SLOW) if spec.signal in ("sma", "cross") else None
    fast = sma(closes, FAST) if spec.signal == "cross" else None

    book: list[Order] = []
    long = protected = above = False
    entry_price = 0.0
    count = 0  # bars the strategy has acted on
    since: int | None = None  # `count` of the bar that first saw the position
    out: list[int] = []
    for index, close in enumerate(closes):
        # 1. the resting orders against this bar
        for order in sorted(book, key=lambda item: PRIORITY[item.kind]):
            if not order.active:
                continue
            price = fill_price(order, data.open[index], data.high[index], data.low[index])
            if price is None:
                order.live += 1
                order.active = order.valid is None or order.live < order.valid
                continue
            order.active = False
            long, entry_price = order.buy, price
            if order.pair is not None:
                for other in book:
                    other.active = other.active and other.pair != order.pair
        book = [order for order in book if order.active]

        # 2. the strategy after the close of this bar
        if spec.signal == "rsi":
            ready = value[index] is not None
        elif spec.signal == "breakout":
            ready = index > BREAKOUT
        else:
            ready = slow is None or slow[index] is not None
        if ready:
            count += 1
            if not long:
                since, protected = None, False
            elif since is None:
                since = count
            enter = leave = now = False
            base = close
            if spec.signal == "rsi":
                enter = value[index] < spec.level
                leave = spec.exit_level is not None and value[index] > spec.exit_level
            elif spec.signal == "sma":
                enter, leave = close > slow[index], close < slow[index]
            elif spec.signal == "cross":
                now = fast[index] > slow[index]
                enter, leave = now and not above, above and not now
            elif spec.signal == "breakout":
                enter, base = True, max(closes[index - BREAKOUT:index])
            elif spec.signal == "clock":
                enter = count % spec.every == 0
            else:
                raise ValueError(f"Unknown signal {spec.signal!r}")
            for branch in spec.chain:
                if branch == "enter":
                    if long or book or not enter:
                        continue
                    book = _entry_orders(spec, close, base, index)
                elif branch == "target":
                    if not long or book:
                        continue
                    book.append(Order(LIMIT, False, limit=round(entry_price * spec.target[0], 2), valid=spec.target[1]))
                elif branch == "protect":
                    if not long or protected:
                        continue
                    book.append(_protective(spec, entry_price, close))
                    protected = True
                elif branch == "signal_exit":
                    if not long or not leave:
                        continue
                    book, protected = [Order(MARKET, False)], False
                elif branch == "time_exit":
                    if not long or count - since < spec.hold:
                        continue
                    book, since = [Order(MARKET, False)], None
                else:
                    raise ValueError(f"Unknown branch {branch!r}")
                break
            above = now

        # 3. the stance: the position, with a market order of this close counted as done
        held = long
        for order in book:
            if order.kind == MARKET:
                held = order.buy
        out.append(int(held))
    return out


# --------------------------------------------------------------------------- forms

def _rule(key: str):
    def rule(inputs: Inputs) -> dict[str, list[int]]:
        return {symbol: run(inputs.bars[symbol], SPECS[key]) for symbol in CORE7 if symbol in inputs.bars}

    return rule


LONG_ONLY = "Long only: the call spread while the rule holds shares. Order size, slippage and commission are dropped."


def _form(key: str, slug: str, name: str, sleeve: str, keeps: str) -> Form:
    return Form(key, f"quantjourney-{slug}", name, sleeve, CORE7, _rule(key), "base/core7", f"{keeps} {LONG_ONLY}")


ROWS: Sequence[tuple[str, str, str, str, str]] = (
    ("qj/O03", "o03-limit-rsi-dip", "Limit RSI Dip Buyer", "mean reversion",
     ("Keeps the entry by a 3-bar buy limit 1.5% under the close when RSI(14) < 40 and the exit by 3-bar sell "
     "limits 3% over the entry price.")),
    ("qj/O04", "o04-limit-trend-pullback", "Limit Trend Pullback", "trend",
     ("Keeps the entry by a 2-bar buy limit 1% under the close while the close is above SMA(50), the 4% limit "
     "take-profit and the market exit when the close falls under SMA(50).")),
    ("qj/O05", "o05-stop-breakout-entry", "Stop Breakout Entry", "trend",
     ("Keeps the entry by a 5-bar buy stop 0.2% over the highest of the last 20 closes and the market exit "
     "after 10 bars.")),
    ("qj/O07", "o07-stop-limit-breakout", "Stop-Limit Breakout", "trend",
     ("Keeps the entry by a 5-bar buy stop-limit (stop 0.2% over the highest of the last 20 closes, limit 0.4% "
     "over the stop), with the fills it misses, and the market exit after 12 bars.")),
    ("qj/O08", "o08-stop-limit-protection", "Stop-Limit Protection", "trend",
     ("Keeps the market entry when SMA(20) crosses over SMA(50), the stop-limit sell 4% under the entry price "
     "(limit 4.5% under), with the gaps it does not fill on, and the market exit on the cross back.")),
    ("qj/O09", "o09-trailing-stop-trend", "Trailing Stop Trend", "trend",
     ("Keeps the market entry when SMA(20) crosses over SMA(50), the 4% trailing stop under the highest high "
     "and the market exit on the cross back.")),
    ("qj/O10", "o10-trailing-stop-rsi", "RSI + Trailing Stop", "mean reversion",
     ("Keeps the market entry when RSI(14) < 38, the 5% trailing stop under the highest high and the market "
     "exit when RSI(14) > 65.")),
    ("qj/O11", "o11-trailing-stop-limit", "Trailing Stop-Limit", "trend",
     ("Keeps the market entry when SMA(20) crosses over SMA(50), the trailing stop-limit (4% of the close "
     "under the highest high, limit 0.5% lower), with the gaps it does not fill on, and the market exit on "
     "the cross back.")),
    ("qj/O14", "o14-oco-dip-or-breakout", "OCO Dip or Breakout", "trend",
     ("Keeps the 5-bar OCO entry every fifth bar (buy limit 2% under the close or buy stop 2% over it, the "
     "first to fill) and the market exit after 10 bars.")),
)

FORMS: tuple[Form, ...] = tuple(_form(*row) for row in ROWS)
