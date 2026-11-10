"""The Academy backtest rules (port of packages/academy/src/backtest.ts `runOptionsBacktest`).

`Simulation` holds the rules: when to open a structure, how many units, when to close (profit
target, stop, exit DTE, expiry, core roll, end) and the trade records. It does not keep the cash:
it sends every leg trade to a `Broker` and reads the cash from it. Two brokers exist:

- `ModelBroker` (this module): a float cash ledger with the modelled Black-Scholes price as the
  fill. `run_model` runs it; this is the line-by-line port and it matches TypeScript to float
  precision. It needs no NautilusTrader.
- The NautilusTrader broker in `engine.py`: market orders on OptionContract instruments, filled by
  Nautilus on the modelled quotes; the cash is the Nautilus account balance.

Research only: no orders leave the process.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..bars import InputError
from .model import (
    CONTRACT_MULTIPLIER,
    DAYS_PER_YEAR,
    Structure,
    black_scholes_price,
    js_number,
    payoff_max_loss,
    realized_vol,
    resolve_rules,
    structure_legs,
    structure_of,
)

__all__ = ["MIN_BACKTEST_BARS", "RATE", "WARMUP", "AcademyInput", "ModelBroker", "OpenLeg", "Simulation",
           "iso_date", "run_model"]

MIN_BACKTEST_BARS = 60
DAY_MS = 86_400_000
RATE = 0.04
WARMUP = 20
STOCK_LOT = 100
_ROLES = ("cycle", "core")


def iso_date(ms: float) -> str:
    """The UTC date of a time in ms, as `new Date(ms).toISOString().slice(0, 10)`: YYYY-MM-DD, and
    for a year outside 0..9999 the first 10 characters of JavaScript's signed six-digit year form
    ("+010233-10"; a rule with a huge dte gives such a label)."""
    # Days to a civil date (proleptic Gregorian), for any year: datetime stops at year 9999.
    shifted = math.floor(ms / DAY_MS) + 719_468
    era = shifted // 146_097
    day_of_era = shifted - era * 146_097
    year_of_era = (day_of_era - day_of_era // 1460 + day_of_era // 36_524 - day_of_era // 146_096) // 365
    day_of_year = day_of_era - (365 * year_of_era + year_of_era // 4 - year_of_era // 100)
    month_index = (5 * day_of_year + 2) // 153
    day = day_of_year - (153 * month_index + 2) // 5 + 1
    month = month_index + 3 if month_index < 10 else month_index - 9
    year = year_of_era + era * 400 + (1 if month <= 2 else 0)
    if 0 <= year <= 9999:
        return f"{year:04d}-{month:02d}-{day:02d}"
    return f"{'+' if year > 0 else '-'}{abs(year):06d}-{month:02d}-{day:02d}"[:10]


def _total(values) -> float:
    """Left-to-right float sum, as a JavaScript `reduce` (Python's sum() compensates since 3.12)."""
    total = 0.0
    for value in values:
        total += value
    return total


def _number_list(name: str, values) -> list[float]:
    if not isinstance(values, (list, tuple)):
        raise InputError(f"bars.{name} must be a list of numbers")
    out = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise InputError(f"bars.{name} must hold finite numbers")
        out.append(float(value))
    return out


@dataclass(frozen=True)
class AcademyInput:
    """`BacktestInput`: daily closes, optional implied volatility per bar, structure, rules, capital."""

    t: tuple[float, ...]
    c: tuple[float, ...]
    iv: tuple[float | None, ...] | None
    structure: str
    rules: dict
    capital: float

    @staticmethod
    def from_json(value: dict) -> AcademyInput:
        """{"bars": {"t", "c", "iv"?}, "structure", "rules"?, "capital"}; iv null = missing value."""
        bars = value.get("bars") or {}
        times = _number_list("t", bars.get("t"))
        closes = _number_list("c", bars.get("c"))
        size = min(len(times), len(closes))
        iv = bars.get("iv")
        if iv is not None:
            if not isinstance(iv, (list, tuple)):
                raise InputError("bars.iv must be a list")
            iv = tuple(float(item) if isinstance(item, (int, float)) and not isinstance(item, bool)
                       and math.isfinite(item) else None for item in iv)
        capital = value.get("capital")
        if isinstance(capital, bool) or not isinstance(capital, (int, float)) or not math.isfinite(capital) \
                or capital <= 0:
            raise InputError("capital must be a positive number")
        return AcademyInput(tuple(times[:size]), tuple(closes[:size]), iv, value.get("structure"),
                            dict(value.get("rules") or {}), float(capital))


@dataclass
class OpenLeg:
    """One open leg. `entry` and `exit` are per-share prices (the broker may replace them by its fills)."""

    role: str
    kind: str
    side: str
    qty: int
    strike: float
    expiry: float
    entry: float
    label: str
    open_index: int
    close_index: int = -1
    exit: float = 0.0
    entry_fee: float = 0.0
    exit_fee: float = 0.0

    @property
    def sign(self) -> int:
        return 1 if self.side == "long" else -1

    @property
    def multiplier(self) -> int:
        return STOCK_LOT if self.kind == "stock" else CONTRACT_MULTIPLIER


@dataclass
class _Book:
    legs: list[OpenLeg]
    entry_t: float
    spot_entry: float
    units: int
    entry_net: dict = field(default_factory=lambda: {"core": 0.0, "cycle": 0.0})


@dataclass
class _Trade:
    """A closed role of the book; the numbers are computed from its legs when the run ends."""

    entry_t: float
    exit_t: float
    entry_index: int
    exit_index: int
    role: str
    legs: list[OpenLeg]
    units: int
    spot_entry: float
    spot_exit: float
    reason: str


class ModelBroker:
    """Float cash ledger; every leg fills at the modelled price (the TypeScript engine's ledger)."""

    def __init__(self, capital: float):
        self._cash = capital

    def cash(self) -> float:
        return self._cash

    def open(self, leg: OpenLeg) -> None:
        self._cash -= leg.sign * leg.qty * leg.multiplier * leg.entry + leg.entry_fee

    def close(self, leg: OpenLeg) -> None:
        self._cash += leg.sign * leg.qty * leg.multiplier * leg.exit - leg.exit_fee


class Simulation:
    """The bar loop of `runOptionsBacktest`, split in `decide` (trades of a bar) and `mark` (its equity)."""

    def __init__(self, data: AcademyInput, broker):
        size = len(data.t)
        if size < MIN_BACKTEST_BARS:
            raise InputError(f"the backtest needs at least {MIN_BACKTEST_BARS} daily bars")
        self.structure: Structure = structure_of(data.structure)
        self.rules = resolve_rules(data.structure, data.rules)
        self.data = data
        self.size = size
        self.broker = broker
        self.supplied = data.iv is not None
        self.has_core = self.structure.has_role("core")
        self.has_cycle = self.structure.has_role("cycle")
        self.first_index = WARMUP
        self.book: _Book | None = None
        self.cycle_t = 0.0
        self.cycle_spot = 0.0
        self.too_small = 0
        self.exposed = 0
        self.trades: list[_Trade] = []
        self.equity: list[float] = []
        # Every leg ever opened, in order (the Nautilus engine builds its instruments from these).
        self.opened: list[OpenLeg] = []

    # ------------------------------------------------------------ market state

    def vol_at(self, index: int) -> float:
        iv = self.data.iv
        given = iv[index] if iv is not None and index < len(iv) else None
        if given is not None and given > 0:
            return given
        rv = realized_vol(self.data.c, index, min(WARMUP, index))
        if rv is None:
            rv = 0.2
        return min(max(rv * self.rules["ivMult"], 0.08), 2)

    def expiry_for(self, now: float, nominal: float) -> float:
        """A nominal expiry snaps back to the last bar on or before it; past the last bar it stays."""
        if nominal >= self.data.t[-1]:
            return nominal
        snapped = now
        for time in self.data.t:
            if snapped < time <= nominal:
                snapped = time
        return snapped

    def leg_value(self, leg: OpenLeg, index: int) -> float:
        """Modelled per-share value of a leg at bar `index` (intrinsic value at or after its expiry)."""
        spot = self.data.c[index]
        if leg.kind == "stock":
            return spot
        days = (leg.expiry - self.data.t[index]) / DAY_MS
        return black_scholes_price(leg.kind, spot, leg.strike, max(days, 0) / DAYS_PER_YEAR, RATE,
                                   self.vol_at(index))

    def days_left(self, leg: OpenLeg, index: int) -> float:
        return (leg.expiry - self.data.t[index]) / DAY_MS

    def cost(self, leg: OpenLeg, price: float) -> float:
        if leg.kind == "stock":
            return leg.qty * STOCK_LOT * (0.005 + price * 0.0005)
        rules = self.rules
        slip = min(max((price * rules["slippagePct"]) / 100, 0.01), rules["slipCap"])
        return leg.qty * (rules["costPerContract"] + CONTRACT_MULTIPLIER * slip)

    def mark_book(self, index: int, roles: tuple[str, ...]) -> float:
        if self.book is None:
            return 0.0
        return _total((leg.sign * leg.qty * leg.multiplier * self.leg_value(leg, index)
                    for leg in self.book.legs if leg.role in roles))

    # ------------------------------------------------------------ trades

    def _open_legs(self, index: int, roles: tuple[str, ...], units: int) -> None:
        spot = self.data.c[index]
        now = self.data.t[index]
        priced = structure_legs(self.structure.id, self.rules, spot, self.vol_at(index), RATE, roles)
        if self.book is None:
            self.book = _Book([], now, spot, units)
        for leg in priced:
            qty = leg.qty * units
            if leg.kind == "stock":
                expiry = math.inf
                label = f"Long {qty * STOCK_LOT} shares"
            else:
                nominal = now + leg.dte * DAY_MS
                expiry = self.expiry_for(now, nominal)
                side = "Long" if leg.side == "long" else "Short"
                label = f"{side} {qty} {js_number(leg.strike)} {leg.kind} {iso_date(nominal)}"
            opened = OpenLeg(leg.role, leg.kind, leg.side, qty, leg.strike, expiry, leg.entry, label, index)
            opened.entry_fee = self.cost(opened, opened.entry)
            self.broker.open(opened)
            self.book.entry_net[leg.role] += opened.sign * opened.qty * opened.multiplier * opened.entry
            self.book.legs.append(opened)
            self.opened.append(opened)

    def _close_legs(self, index: int, roles: tuple[str, ...], reason: str) -> None:
        book = self.book
        spot = self.data.c[index]
        now = self.data.t[index]
        for role in roles:
            legs = [leg for leg in book.legs if leg.role == role]
            if not legs:
                continue
            for leg in legs:
                leg.exit = self.leg_value(leg, index)
                leg.close_index = index
                # An expired option settles at its intrinsic value without a fee.
                expired = self.days_left(leg, index) <= 0 and leg.kind != "stock"
                leg.exit_fee = 0.0 if expired else self.cost(leg, leg.exit)
                self.broker.close(leg)
            cycle = role == "cycle"
            entry_t = self.cycle_t if cycle and self.cycle_t > 0 else book.entry_t
            self.trades.append(_Trade(
                entry_t, now, self.data.t.index(entry_t), index, role if self.has_core else "position", legs,
                book.units, self.cycle_spot if cycle else book.spot_entry, spot, reason))
            book.legs = [leg for leg in book.legs if leg.role != role]
            book.entry_net[role] = 0.0
        if not book.legs:
            self.book = None

    def _size_units(self, index: int) -> int:
        spot = self.data.c[index]
        legs = structure_legs(self.structure.id, self.rules, spot, self.vol_at(index), RATE)
        equity_now = self.broker.cash()

        def premium() -> float:
            return _total(((1 if leg.side == "long" else -1) * leg.entry * CONTRACT_MULTIPLIER * leg.qty
                        for leg in legs if leg.kind != "stock"))

        if self.structure.uses_shares:
            return math.floor((equity_now * 0.98) / max(spot * 100 + premium(), 1))
        if self.structure.id == "cash_secured_put":
            strike = max(leg.strike for leg in legs)
            return math.floor((equity_now * 0.98) / (strike * 100))
        max_loss = payoff_max_loss(legs, spot, RATE)
        risk = (equity_now * self.rules["riskPct"]) / 100
        # Floor the unit loss at 0.5% of the notional so that a near-zero-width structure cannot size huge.
        unit_loss = max(spot * 100 * 0.2 if max_loss is None else -max_loss, spot * 100 * 0.005)
        unit_cash = max(abs(premium()), 1)
        return min(math.floor(risk / unit_loss), math.floor(equity_now / unit_cash))

    # ------------------------------------------------------------ bar loop

    def decide(self, index: int) -> None:
        """The trades of bar `index` (all at its close). Call for index = first_index .. size - 1."""
        now = self.data.t[index]
        spot = self.data.c[index]
        last = index == self.size - 1
        rules = self.rules
        if self.book is not None:
            book = self.book
            cycle_legs = [leg for leg in book.legs if leg.role == "cycle"]
            core_legs = [leg for leg in book.legs if leg.role == "core" and leg.kind != "stock"]
            if last:
                self._close_legs(index, _ROLES, "end")
            elif core_legs and min(self.days_left(leg, index) for leg in core_legs) <= rules["coreExitDte"]:
                self._close_legs(index, _ROLES, "core-roll")
            elif cycle_legs:
                entry_net = book.entry_net["cycle"]
                pnl = self.mark_book(index, ("cycle",)) - entry_net
                basis = abs(entry_net)
                remaining = min(self.days_left(leg, index) for leg in cycle_legs)
                target = (basis * rules["profitTakePct"]) / 100
                stop = (basis * rules["stopLossPct"]) / 100
                if remaining <= 0:
                    self._close_legs(index, ("cycle",), "expiry")
                elif basis > 0 and pnl >= target:
                    self._close_legs(index, ("cycle",), "profit-target")
                elif basis > 0 and pnl <= -stop:
                    self._close_legs(index, ("cycle",), "stop")
                elif rules["exitDte"] > 0 and remaining <= rules["exitDte"]:
                    self._close_legs(index, ("cycle",), "exit-dte")
        elif not last and self.broker.cash() > 0:
            units = self._size_units(index)
            if units >= 1:
                self._open_legs(index, ("core", "cycle"), units)
                self.cycle_t = now
                self.cycle_spot = spot
            else:
                self.too_small += 1
        if self.book is not None and not last:
            book = self.book
            needs_cycle = (self.has_core and self.has_cycle
                           and not any(leg.role == "cycle" for leg in book.legs))
            if needs_cycle and now != book.entry_t:
                # The cycle closed and the core is still held: reopen the cycle legs on this bar.
                self._open_legs(index, ("cycle",), book.units)
                self.cycle_t = now
                self.cycle_spot = spot
        if self.book is not None:
            self.exposed += 1

    def mark(self, value: float) -> None:
        """Records the equity of the bar just decided."""
        self.equity.append(value)

    # ------------------------------------------------------------ result

    def _trade_json(self, trade: _Trade) -> dict:
        entry_net = _total((leg.sign * leg.qty * leg.multiplier * leg.entry for leg in trade.legs))
        value = _total((leg.sign * leg.qty * leg.multiplier * leg.exit for leg in trade.legs))
        # TS order: the entry fees of the role first, then each exit fee.
        fees = _total((leg.entry_fee for leg in trade.legs))
        for leg in trade.legs:
            fees += leg.exit_fee
        return {
            "entryT": iso_date(trade.entry_t), "exitT": iso_date(trade.exit_t), "role": trade.role,
            "legs": [leg.label for leg in trade.legs], "units": trade.units, "spotEntry": trade.spot_entry,
            "spotExit": trade.spot_exit, "entryNet": entry_net, "exitValue": value, "costs": fees,
            "pnl": value - entry_net - fees, "reason": trade.reason,
            # Not in the TypeScript trade: the bar indexes and the per-share fill prices of each leg.
            "entryIndex": trade.entry_index, "exitIndex": trade.exit_index,
            "legFills": [{"entry": leg.entry, "exit": leg.exit} for leg in trade.legs],
        }

    def result(self) -> dict:
        """The `BacktestResult` JSON without the benchmark and drawdown series: `equity` holds one
        number per bar from `firstIndex`."""
        data, rules = self.data, self.rules
        capital = data.capital
        equity = self.equity
        if len(equity) != self.size - self.first_index:
            raise RuntimeError(f"academy backtest marked {len(equity)} of {self.size - self.first_index} bars")
        peak = -math.inf
        drawdown = []
        for value in equity:
            peak = max(peak, value)
            drawdown.append(value / peak - 1 if peak > 0 else 0.0)
        returns = [equity[i] / max(equity[i - 1], 1e-9) - 1 for i in range(1, len(equity))]
        mean = _total(returns) / max(len(returns), 1)
        variance = _total(((value - mean) ** 2 for value in returns)) / max(len(returns) - 1, 1)
        years = max((data.t[-1] - data.t[self.first_index]) / (DAYS_PER_YEAR * DAY_MS), 1 / DAYS_PER_YEAR)
        trades = [self._trade_json(trade) for trade in self.trades]
        closed = [t for t in trades if t["role"] == "cycle"] if self.has_core and self.has_cycle else trades
        wins = [t for t in closed if t["pnl"] > 0]
        gross_win = _total((t["pnl"] for t in wins))
        gross_loss = _total((-t["pnl"] for t in closed if t["pnl"] < 0))
        final = equity[-1]
        growth = final / capital
        benchmark_shares = capital / data.c[self.first_index]
        assumptions = [
            "Option prices are modeled with Black-Scholes on daily closes; they are not historical option quotes.",
            "Implied volatility comes from the supplied series (for example VIX for SPY), flat across strikes."
            if self.supplied else
            f"Implied volatility = trailing 20-day realized volatility x {js_number(rules['ivMult'])}, "
            "floored at 8%, flat across strikes.",
            f"Costs: ${js_number(rules['costPerContract'])} per contract plus slippage of "
            f"{js_number(rules['slippagePct'])}% of premium per leg per side (min $0.01, max "
            f"${js_number(rules['slipCap'])} per share); stock 0.5 cent per share plus 5 bp.",
            "Risk-free rate 4%. No dividends, no early assignment; short options settle at intrinsic value at "
            "expiry.",
            "Strikes are chosen by Black-Scholes delta and rounded to the listed increment.",
        ]
        if self.too_small > 0:
            assumptions.append(
                f"On {self.too_small} day(s) one unit cost more than the risk budget (riskPct "
                f"{js_number(rules['riskPct'])}% of equity), so no position was opened. Raise riskPct or capital.")
        return {
            "modeled": True,
            "ivSource": "supplied" if self.supplied else "rv-model",
            "rules": rules,
            "assumptions": assumptions,
            "firstIndex": self.first_index,
            "equity": list(equity),
            "trades": trades,
            "stats": {
                "totalReturn": growth - 1,
                # JavaScript gives NaN (JSON null) for a negative base.
                "cagr": growth ** (1 / years) - 1 if growth >= 0 else None,
                "maxDrawdown": min(0.0, *drawdown),
                "sharpe": (mean / math.sqrt(variance)) * math.sqrt(252) if variance > 0 else 0,
                "winRate": 0 if not closed else len(wins) / len(closed),
                "trades": len(closed),
                "wins": len(wins),
                "avgPnl": 0 if not closed else _total((t["pnl"] for t in closed)) / len(closed),
                "profitFactor": gross_win / gross_loss if gross_loss > 0 else None,
                "exposure": self.exposed / max(len(equity), 1),
                "finalEquity": final,
                "benchmarkReturn": (benchmark_shares * data.c[-1]) / capital - 1,
            },
        }


def run_model(data: AcademyInput) -> dict:
    """The modelled backtest with the float ledger (no NautilusTrader): the port of `runOptionsBacktest`."""
    broker = ModelBroker(data.capital)
    simulation = Simulation(data, broker)
    for index in range(simulation.first_index, simulation.size):
        simulation.decide(index)
        simulation.mark(broker.cash() + simulation.mark_book(index, ("core", "cycle")))
    return simulation.result()
