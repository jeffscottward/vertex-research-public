"""Modelled debit vertical form of the continuation study on SPY and QQQ (research only).

Reuses the intraday-momentum option model (strategies.imom.options.price_at and book): nearest Friday weekly
with at least one trading day left, strikes by qc_ports.book.choose_strikes, Black-Scholes with the smile on the
previous close of VIX or VXN, $0.65 per contract and half the modelled spread per leg, maximum loss (debit plus
costs) at most 2% of the account. No new pricing code.
"""
from __future__ import annotations

import dataclasses
from collections.abc import Sequence

from strategies.imom.data import ms_at
from strategies.imom.options import MAX_LOSS_PCT, OptionEvent, Spread, book, price_at, weekly_expiry
from strategies.qc_ports.data import Market
from strategies.qc_ports.options import COMMISSION

from .rules import OPEN_MINUTE_OF_DAY, Trade

__all__ = ["ACCOUNT", "LEG_COMMISSIONS", "MAX_LOSS_PCT", "SPREAD_STRESS", "book_form", "price_trades",
           "session_pnl_from_equity", "stress_costs", "trade_nets", "weekly_expiry"]

ACCOUNT = 100_000.0
SPREAD_STRESS = 2.0
LEG_COMMISSIONS = 2 * COMMISSION
BOOK_MINUTE_OF_DAY = 960  # 16:00 New York: one session close per day on the synthetic clock


def price_trades(symbol: str, trades: Sequence[Trade], market: Market) -> tuple[list[Spread], list[dict]]:
    spreads, skipped = [], []
    for trade in trades:
        event = OptionEvent(market=symbol, twin=symbol, side="long" if trade.side > 0 else "short",
                            entry_ms=ms_at(trade.day, OPEN_MINUTE_OF_DAY + trade.entry_bar))
        result = price_at(event, trade.entry_price, ms_at(trade.day, OPEN_MINUTE_OF_DAY + trade.exit_bar),
                          trade.exit_price, market)
        if isinstance(result, str):
            skipped.append({"day": trade.day, "symbol": symbol, "reason": result})
        else:
            spreads.append(result)
    return spreads, skipped


def stress_costs(spread: Spread, multiple: float = SPREAD_STRESS) -> Spread:
    """Multiplies the spread part of every cost; commissions stay."""
    entry_fee = round(LEG_COMMISSIONS + multiple * (spread.entry_fee - LEG_COMMISSIONS), 2)
    exit_fee = round(LEG_COMMISSIONS + multiple * (spread.exit_fee - LEG_COMMISSIONS), 2)
    max_loss = round(spread.entry_price + entry_fee + LEG_COMMISSIONS
                     + multiple * (spread.max_loss - spread.entry_price - spread.entry_fee - LEG_COMMISSIONS), 2)
    return dataclasses.replace(spread, entry_fee=entry_fee, exit_fee=exit_fee, max_loss=max_loss)


def book_form(spreads: Sequence[Spread], days: Sequence[str], *, nautilus: bool) -> dict:
    out = book(spreads, [ms_at(day, BOOK_MINUTE_OF_DAY) for day in days], ACCOUNT, nautilus=nautilus)
    out["result"] = out["nautilus"] if nautilus else out["ledger"]
    return out


def session_pnl_from_equity(points: Sequence[tuple[str, float]], days: Sequence[str],
                            capital: float = ACCOUNT) -> list[float]:
    """Per day: equity of its point minus the equity before it (start: capital); 0 for a day without a point."""
    by_day = dict(points)
    out, before = [], capital
    for day in days:
        if day in by_day:
            out.append(by_day[day] - before)
            before = by_day[day]
        else:
            out.append(0.0)
    return out


def trade_nets(result) -> list[float]:
    return [float(record["pnl"]) for record in result.trades]
