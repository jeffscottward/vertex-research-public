"""Options forms of the order flow / AMT study on the house option model (research only; modelled prices).

Primary form "0DTE": a same-day-expiry debit vertical on the traded ETF (call vertical for a long signal, put
vertical for a short one), long strike at the money (nearest grid strike to the entry spot), short strike at the
grid strike nearest the trade's target, at least one grid step beyond the long strike. Only sessions from
ZERO_DTE_FIRST (every weekday has an SPY and QQQ expiry from that week; Cboe circular C2022111000).
Report-only form "weekly" (from WEEKLY_FIRST): the intraday-momentum debit vertical (strategies.imom.options.price_at: nearest Friday
weekly with at least one trading day left, long leg near 0.50 delta, short leg one sigma further out).
Both: entry at the open of the entry bar, exit at the end of the exit bar at the trade's exit price;
Black-Scholes with the qc_ports smile on the PREVIOUS close of VIX (SPY) or VXN (QQQ) and the T-bill rate,
$0.65 per contract and half the modelled spread per leg, exit cost capped at the worst case, maximum loss
(debit plus costs) sized to 2% of the account, booked by NautilusTrader (strategies.flow_control.options).
"""
from __future__ import annotations

from collections.abc import Sequence
from datetime import date

from strategies.imom.data import ms_at
from strategies.imom.options import (MAX_IV_AGE_DAYS, OptionEvent, Spread, previous_index, price_at,
                                     years_to_close)
from strategies.qc_ports import options as om
from strategies.qc_ports.book import instrument_value, worst_exit_cost
from strategies.qc_ports.data import IV_INDEX, Market

from .rules import BAR_MINUTES, Trade

OPEN_MINUTE_OF_DAY = 570
ZERO_DTE_FIRST = "2022-11-28"
WEEKLY_FIRST = "2010-06-04"  # Cboe listed SPY and QQQ Weeklys from Friday 2010-06-04 (Cboe press release 2010-06-03)
FORMS = ("0DTE", "weekly")
FIRST_DAY = {"0DTE": ZERO_DTE_FIRST, "weekly": WEEKLY_FIRST}


def entry_ms(trade: Trade) -> float:
    return ms_at(trade.day, OPEN_MINUTE_OF_DAY + BAR_MINUTES * trade.entry_bar)


def exit_ms(trade: Trade) -> float:
    return ms_at(trade.day, OPEN_MINUTE_OF_DAY + BAR_MINUTES * (trade.exit_bar + 1))


def event_of(trade: Trade) -> OptionEvent:
    return OptionEvent(market=trade.symbol, twin=trade.symbol, side="long" if trade.side > 0 else "short",
                       entry_ms=entry_ms(trade))


def _grid(value: float, step: float) -> float:
    return round(round(value / step) * step, 6)


def zero_dte_strikes(right: str, spot: float, target: float) -> tuple[float, float, float]:
    """(long strike, short strike, width): ATM long, short at the target, at least one step apart."""
    step = om.strike_step(spot)
    long_strike = _grid(spot, step)
    if right == "call":
        short_strike = max(round(long_strike + step, 6), _grid(target, step))
    else:
        short_strike = min(round(long_strike - step, 6), _grid(target, step))
    return long_strike, short_strike, round(abs(short_strike - long_strike), 6)


def _fee(symbol: str, long_mid: float, short_mid: float) -> float:
    return round(om.leg_cost(symbol, long_mid) + om.leg_cost(symbol, short_mid), 2)


def zero_dte(trade: Trade, market: Market) -> Spread | str:
    """Price the same-day debit vertical of one trade; a string names why there is none."""
    if trade.day < ZERO_DTE_FIRST:
        return "before daily expiries"
    event = event_of(trade)
    prev = previous_index(market, trade.day)
    if prev is None:
        return "no previous close"
    if (date.fromisoformat(trade.day) - date.fromisoformat(market.dates[prev])).days > MAX_IV_AGE_DAYS:
        return "stale IV"
    level, rate = market.iv_index[prev], market.rate[prev]
    if level is None:
        return "no IV"
    if rate is None:
        return "no rate"
    symbol = trade.symbol
    right = "call" if trade.side > 0 else "put"
    expiry = date.fromisoformat(trade.day)
    q = om.DIVIDEND_YIELD.get(symbol, 0.0)
    slope = om.SKEW[symbol]
    atm = om.atm_iv(IV_INDEX[symbol], level)
    long_strike, short_strike, width = zero_dte_strikes(right, trade.entry_price, trade.target)

    def legs(spot: float, t: float) -> tuple[float, float]:
        if t <= 0:
            return om.intrinsic(right, spot, long_strike), om.intrinsic(right, spot, short_strike)
        return (om.bs_price(right, spot, long_strike, t, rate, q, om.smile_iv(atm, spot, long_strike, t, slope)),
                om.bs_price(right, spot, short_strike, t, rate, q, om.smile_iv(atm, spot, short_strike, t, slope)))

    t_entry = years_to_close(event.entry_ms, expiry)
    long_mid, short_mid = legs(trade.entry_price, t_entry)
    entry_price = instrument_value("debit", long_mid, short_mid, width)
    if entry_price <= 0:
        return "no premium"
    out_ms = exit_ms(trade)
    x_long, x_short = legs(trade.exit_price, years_to_close(out_ms, expiry))
    exit_price = instrument_value("debit", x_long, x_short, width)
    entry_fee = _fee(symbol, long_mid, short_mid)
    worst_exit = worst_exit_cost(symbol, width)
    return Spread(event=event, day=trade.day, expiry=expiry.isoformat(), right=right, long_strike=long_strike,
                  short_strike=short_strike, width=width, entry_spot=trade.entry_price, exit_spot=trade.exit_price,
                  exit_ms=out_ms, entry_price=entry_price, exit_price=exit_price, entry_fee=entry_fee,
                  exit_fee=min(_fee(symbol, x_long, x_short), worst_exit),
                  max_loss=round(entry_price + entry_fee + worst_exit, 2), premium=abs(long_mid - short_mid),
                  iv=atm, rate=rate)


def weekly(trade: Trade, market: Market) -> Spread | str:
    if trade.day < WEEKLY_FIRST:
        return "before weekly expiries"
    return price_at(event_of(trade), trade.entry_price, exit_ms(trade), trade.exit_price, market)


PRICERS = {"0DTE": zero_dte, "weekly": weekly}


def price_trades(form: str, trades: Sequence[Trade], market: Market) -> tuple[list[Spread], list[dict]]:
    spreads, skipped = [], []
    for trade in trades:
        result = PRICERS[form](trade, market)
        if isinstance(result, str):
            skipped.append({"day": trade.day, "symbol": trade.symbol, "rule": trade.rule, "reason": result})
        else:
            spreads.append(result)
    return spreads, skipped
