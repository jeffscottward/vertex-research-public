"""Pure-Python reference ledger of the qc-ports options runner (research only).

Takes priced trades (book.py, per contract) and the capital, sizes each trade
at entry and returns the daily equity and the trade records. nautilus_runner.py
runs the same trades in a NautilusTrader BacktestEngine; the two must agree
(parity test, 1e-6 relative).

Each day, in this order:
1. exits: sell every open trade whose exit date is today at its exit value;
   cash += contracts * exit value - contracts * exit cost;
2. sizing equity = cash + sum(contracts * today's mark) of the trades still
   open, rounded to cents;
3. entries, in trade-id order: contracts = book.contracts_for(sizing equity,
   cash left, maxLossPct, max loss, entry value + entry cost);
   cash -= contracts * entry value + contracts * entry cost; a trade with 0
   contracts is skipped (reason "size");
4. equity = cash + sum(contracts * today's mark). A trade's mark on a day
   without a bar of its symbol is its last mark.
Cash and costs are booked in cents, as the Nautilus CASH account does.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .book import PricedTrade, contracts_for

__all__ = ["DEFAULT_CAPITAL", "LedgerResult", "run_ledger", "timeline", "trade_record"]

DEFAULT_CAPITAL = 100_000.0


@dataclass(frozen=True)
class LedgerResult:
    dates: tuple[str, ...]
    equity: tuple[float, ...]
    open_positions: tuple[int, ...]
    trades: tuple[dict, ...]
    skipped: tuple[dict, ...]
    capital: float = DEFAULT_CAPITAL
    engine: str = "qc-ports-ledger"


def timeline(trades: Sequence[PricedTrade], dates: Iterable[str] | None = None) -> tuple[str, ...]:
    """The run days: `dates` (or the union of the mark dates) holding every mark date."""
    marked = {day for trade in trades for day, _ in trade.marks}
    days = tuple(sorted(set(dates))) if dates is not None else tuple(sorted(marked))
    missing = marked.difference(days)
    if missing:
        raise ValueError(f"Mark dates outside the run dates: {min(missing)}")
    ids = [trade.trade_id for trade in trades]
    if len(set(ids)) != len(ids):
        raise ValueError("Trade ids must be unique")
    return days


def trade_record(trade: PricedTrade, contracts: int, entry_price: float, exit_price: float,
                 entry_fee: float, exit_fee: float) -> dict:
    """The trade record both ledgers return. Fees are the totals for all contracts."""
    pnl = round(contracts * (exit_price - entry_price) - entry_fee - exit_fee, 2)
    return {
        "id": trade.trade_id, "symbol": trade.symbol, "structure": trade.structure, "expiry": trade.expiry,
        "longStrike": trade.long_strike, "shortStrike": trade.short_strike,
        "entryDate": trade.entry_date, "exitDate": trade.exit_date, "contracts": contracts,
        "entryPrice": entry_price, "exitPrice": exit_price, "entryFee": entry_fee, "exitFee": exit_fee,
        "pnl": pnl, "returnOnRisk": pnl / (contracts * trade.max_loss), "exitReason": trade.exit_reason,
    }


def run_ledger(trades: Sequence[PricedTrade], capital: float = DEFAULT_CAPITAL,
               dates: Iterable[str] | None = None) -> LedgerResult:
    if not capital > 0:
        raise ValueError("capital must be above 0")
    days = timeline(trades, dates)
    marks = {trade.trade_id: dict(trade.marks) for trade in trades}
    entering: dict[str, list[PricedTrade]] = {}
    for trade in sorted(trades, key=lambda item: item.trade_id):
        entering.setdefault(trade.entry_date, []).append(trade)
    cash = round(float(capital), 2)
    held: dict[int, tuple[PricedTrade, int, float]] = {}  # id -> trade, contracts, entry fee total
    last_mark: dict[int, float] = {}
    equity, open_positions, records, skipped = [], [], [], []

    def value_open(day: str) -> float:
        total = 0.0
        for trade_id, (_, contracts, _) in held.items():
            last_mark[trade_id] = marks[trade_id].get(day, last_mark[trade_id])
            total += contracts * last_mark[trade_id]
        return total

    for day in days:
        for trade_id in [key for key, (trade, _, _) in held.items() if trade.exit_date == day]:
            trade, contracts, entry_fee = held.pop(trade_id)
            exit_fee = round(contracts * trade.exit_fee, 2)
            cash = round(cash + contracts * trade.exit_price - exit_fee, 2)
            records.append(trade_record(trade, contracts, trade.entry_price, trade.exit_price, entry_fee, exit_fee))
        sizing = round(cash + value_open(day), 2)
        for trade in entering.get(day, ()):
            contracts = contracts_for(sizing, cash, trade.max_loss_pct, trade.max_loss,
                                      trade.entry_price + trade.entry_fee)
            if contracts == 0:
                skipped.append({"id": trade.trade_id, "symbol": trade.symbol, "entryDate": day, "reason": "size"})
                continue
            entry_fee = round(contracts * trade.entry_fee, 2)
            cash = round(cash - contracts * trade.entry_price - entry_fee, 2)
            held[trade.trade_id] = (trade, contracts, entry_fee)
            last_mark[trade.trade_id] = trade.entry_price
        equity.append(cash + value_open(day))
        open_positions.append(len(held))
    if held:
        raise ValueError("Trades open after the last run day")
    records.sort(key=lambda record: (record["exitDate"], record["id"]))
    return LedgerResult(days, tuple(equity), tuple(open_positions), tuple(records), tuple(skipped),
                        capital=float(capital))
