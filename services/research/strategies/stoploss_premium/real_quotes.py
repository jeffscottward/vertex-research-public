"""Real historical option quote store and trade builder (pure Python CSV core; lazy DuckDB/Parquet support).

Supports:
  * Standard CSV quote files (zero extra dependencies, used by unit tests and exported snapshots).
  * `options-dataset-hist` yearly Parquet archives (SPY 2008-2025, QQQ 2011-2025, IWM 2008-2025, MIT mirror
    of Philipp D. Dubach's EOD option-chain dataset; loaded lazily via duckdb/pyarrow only when Parquet files
    are read).

Every quote is validated before use (finite non-negative bid/ask, ask >= bid, positive strike). Crossed or
invalid quotes are rejected and counted in `QuoteBook.stats`. Unlike `options.py` (Black-Scholes model prices),
entry debits use real ask/bid quotes, daily marks use real mids, and exits use real executable bids net of
per-leg commission (with OTM contracts expiring at $0 with $0 closing commission).
"""
from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from collections.abc import Iterable, Sequence
import csv
from dataclasses import dataclass, field
from datetime import date, timedelta
import math
from pathlib import Path

from .bars import Series
from .options import LEG_COMMISSION, Leg, expiration as monthly_expiration, intrinsic

MAX_DELTA_ERR = 0.15
MIN_ENTRY_BID = 0.05
MIN_ENTRY_MID = 0.10
MAX_SPREAD_RATIO = 0.50  # reject obviously broken entry quotes where (ask - bid) / mid > 50%


@dataclass(frozen=True)
class OptionQuote:
    """One validated end-of-day option quote."""

    day: str
    expiration: str
    strike: float
    right: str   # "call" or "put"
    bid: float
    ask: float
    mark: float
    iv: float | None = None
    delta: float | None = None
    volume: int = 0
    open_interest: int = 0

    @property
    def mid(self) -> float:
        if self.bid > 0 and self.ask >= self.bid:
            return 0.5 * (self.bid + self.ask)
        if self.mark > 0:
            return self.mark
        return 0.5 * (self.bid + self.ask)

    @property
    def half_spread(self) -> float:
        return max(0.0, 0.5 * (self.ask - self.bid))

    @property
    def spread_pct(self) -> float | None:
        m = self.mid
        return None if m <= 0 else (self.ask - self.bid) / m


def _finite(x: float | None) -> bool:
    return x is not None and math.isfinite(x)


def validate_quote(
    day: str,
    expiration: str,
    strike: float,
    right: str,
    bid: float,
    ask: float,
    mark: float | None = None,
    iv: float | None = None,
    delta: float | None = None,
    volume: int = 0,
    open_interest: int = 0,
) -> tuple[OptionQuote | None, str | None]:
    """Validate one quote row. Returns `(quote, None)` or `(None, reason)`."""
    r = right.strip().lower()
    if r in ("c", "call"):
        r = "call"
    elif r in ("p", "put"):
        r = "put"
    else:
        return None, "bad_right"
    d_str = day.strip()[:10]
    e_str = expiration.strip()[:10]
    if not d_str or not e_str or e_str < d_str:
        return None, "bad_dates"
    if not (_finite(strike) and strike > 0 and _finite(bid) and _finite(ask)):
        return None, "non_finite"
    if bid < 0 or ask < 0:
        return None, "negative"
    if bid > ask + 1e-9:
        return None, "crossed"
    raw_m = mark if (_finite(mark) and mark is not None and mark >= 0) else 0.5 * (bid + ask)
    m = min(ask, max(bid, raw_m)) if ask > 0 else raw_m
    clean_iv = iv if (_finite(iv) and iv is not None and iv > 0) else None
    clean_delta = delta if (_finite(delta) and delta is not None and -1.05 <= delta <= 1.05) else None
    return OptionQuote(
        day=d_str,
        expiration=e_str,
        strike=round(float(strike), 4),
        right=r,
        bid=float(bid),
        ask=float(ask),
        mark=float(m),
        iv=clean_iv,
        delta=clean_delta,
        volume=max(0, int(volume or 0)),
        open_interest=max(0, int(open_interest or 0)),
    ), None


@dataclass
class QuoteBook:
    """In-memory real option quote book for one underlying symbol."""

    symbol: str
    by_key: dict[tuple[str, str, float, str], OptionQuote] = field(default_factory=dict)
    by_day_exp: dict[tuple[str, str, str], list[OptionQuote]] = field(default_factory=lambda: defaultdict(list))
    expiries_by_day: dict[str, list[str]] = field(default_factory=dict)
    stats: dict[str, int] = field(default_factory=lambda: {
        "loaded": 0, "skipped_crossed": 0, "skipped_invalid": 0, "duplicates": 0
    })

    def add(self, q: OptionQuote) -> None:
        key = (q.day, q.expiration, q.strike, q.right)
        if key in self.by_key:
            self.stats["duplicates"] += 1
            return
        self.by_key[key] = q
        self.by_day_exp[(q.day, q.expiration, q.right)].append(q)
        self.stats["loaded"] += 1

    def finalize(self) -> QuoteBook:
        """Sort per-day expiries and per-expiry strikes for deterministic lookup."""
        exp_map: dict[str, set[str]] = defaultdict(set)
        for (day, exp, _right), qs in self.by_day_exp.items():
            qs.sort(key=lambda q: q.strike)
            exp_map[day].add(exp)
        self.expiries_by_day = {d: sorted(es) for d, es in exp_map.items()}
        return self

    @property
    def last_date(self) -> str | None:
        return max(self.expiries_by_day) if self.expiries_by_day else None

    def get(self, day: str, expiration: str, strike: float, right: str) -> OptionQuote | None:
        return self.by_key.get((day, expiration, round(float(strike), 4), right))

    def expiries_on(self, day: str) -> list[str]:
        return self.expiries_by_day.get(day, [])

    def select_expiry(self, day: str, *, min_dte: int, max_dte: int | None = None,
                      target_dte: int | None = None, monthly_only: bool = False) -> str | None:
        """Pick an available expiry on `day` inside `[min_dte, max_dte]` (nearest `target_dte`, else nearest min)."""
        d0 = date.fromisoformat(day)
        cands: list[tuple[int, str]] = []
        for exp in self.expiries_on(day):
            e = date.fromisoformat(exp)
            dte = (e - d0).days
            if dte < min_dte:
                continue
            if max_dte is not None and dte > max_dte:
                continue
            if monthly_only:
                std = monthly_expiration(e.year, e.month)
                # Standard 3rd Friday (or Good Friday Thursday) plus pre-Feb-2015 Saturday OCC date
                if e != std and (e - timedelta(days=1)) != std:
                    continue
            cands.append((dte, exp))
        if not cands:
            return None
        if target_dte is None:
            return min(cands, key=lambda x: (x[0], x[1]))[1]
        return min(cands, key=lambda x: (abs(x[0] - target_dte), x[1]))[1]

    def select_by_delta(
        self,
        day: str,
        expiration: str,
        right: str,
        target_delta: float,
        *,
        max_delta_err: float = MAX_DELTA_ERR,
        min_bid: float = MIN_ENTRY_BID,
    ) -> OptionQuote | None:
        """Select the liquid quote nearest `target_delta` on `(day, expiration, right)`."""
        qs = self.by_day_exp.get((day, expiration, right), [])
        best: OptionQuote | None = None
        best_err = float("inf")
        for q in qs:
            if q.delta is None or q.bid < min_bid or q.mid < MIN_ENTRY_MID:
                continue
            sp = q.spread_pct
            if sp is None or sp > MAX_SPREAD_RATIO:
                continue
            err = abs(q.delta - target_delta)
            if err <= max_delta_err and (err < best_err or (err == best_err and best is not None and q.strike < best.strike)):
                best = q
                best_err = err
        return best


def load_quotes_csv(path: Path, symbol: str) -> QuoteBook:
    """Load real option quotes from CSV (`date,expiration,strike,type,bid,ask[,mark,implied_volatility,delta,volume,open_interest]`)."""
    book = QuoteBook(symbol=symbol.upper())
    with path.open(encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            sym = (row.get("symbol") or row.get("act_symbol") or symbol).strip().upper()
            if sym != book.symbol:
                continue
            right = row.get("type") or row.get("call_put") or row.get("right") or ""
            try:
                strike = float(row["strike"])
                bid = float(row["bid"])
                ask = float(row["ask"])
                mark = float(row["mark"]) if row.get("mark") not in (None, "") else None
                iv_raw = row.get("implied_volatility") or row.get("vol") or row.get("iv")
                iv = float(iv_raw) if iv_raw not in (None, "") else None
                delta = float(row["delta"]) if row.get("delta") not in (None, "") else None
                vol = int(float(row["volume"])) if row.get("volume") not in (None, "") else 0
                oi = int(float(row["open_interest"])) if row.get("open_interest") not in (None, "") else 0
            except (KeyError, ValueError):
                book.stats["skipped_invalid"] += 1
                continue
            q, reason = validate_quote(
                day=row.get("date") or "",
                expiration=row.get("expiration") or "",
                strike=strike,
                right=right,
                bid=bid,
                ask=ask,
                mark=mark,
                iv=iv,
                delta=delta,
                volume=vol,
                open_interest=oi,
            )
            if q is None:
                if reason == "crossed":
                    book.stats["skipped_crossed"] += 1
                else:
                    book.stats["skipped_invalid"] += 1
                continue
            book.add(q)
    return book.finalize()


def load_quotes_parquet_dir(
    directory: Path,
    symbol: str,
    *,
    entry_dates: Iterable[str] | None = None,
    right: str = "call",
    min_dte_filter: int | None = None,
    max_dte_filter: int | None = None,
) -> QuoteBook:
    """Load `options-dataset-hist` Parquet files for `symbol` using lazy DuckDB (no hard CI dependency).

    When `entry_dates` is provided, we still load every daily quote of contracts whose `(expiration, strike)`
    appears on any requested entry date — keeping memory small and queries under a few seconds even over 18 years.
    """
    import duckdb  # lazy import so CI unit tests run with pure stdlib + pydantic

    files = sorted(directory.glob("options_*.parquet"))
    if not files:
        single = directory / "options.parquet"
        if single.exists():
            files = [single]
    if not files:
        raise FileNotFoundError(f"no options parquet files in {directory}")

    glob_expr = str(directory / "options_*.parquet") if (directory / "options_2024.parquet").exists() or len(files) > 1 else str(files[0])
    con = duckdb.connect()
    try:
        base_where = f"lower(type) = '{right.lower()}'"
        dte_conds: list[str] = []
        if min_dte_filter is not None:
            dte_conds.append(f"datediff('day', raw.d::DATE, raw.exp::DATE) >= {int(min_dte_filter)}")
        if max_dte_filter is not None:
            dte_conds.append(f"datediff('day', raw.d::DATE, raw.exp::DATE) <= {int(max_dte_filter)}")

        if entry_dates is not None:
            edates = sorted(set(entry_dates))
            con.execute("CREATE TEMP TABLE req_dates(d VARCHAR)")
            con.executemany("INSERT INTO req_dates VALUES (?)", [(d,) for d in edates])
            picked_extra = (" AND " + " AND ".join(dte_conds)) if dte_conds else ""
            # Apply entry DTE filter only to `picked` so every selected contract keeps its full lifecycle to DTE=0.
            sql = f"""
            WITH raw AS (
                SELECT date::DATE::VARCHAR AS d, expiration::DATE::VARCHAR AS exp, strike::DOUBLE AS strike,
                       lower(type) AS r, bid::DOUBLE AS bid, ask::DOUBLE AS ask, mark::DOUBLE AS mark,
                       implied_volatility::DOUBLE AS iv, delta::DOUBLE AS delta,
                       COALESCE(volume, 0)::BIGINT AS vol, COALESCE(open_interest, 0)::BIGINT AS oi
                FROM read_parquet('{glob_expr}')
                WHERE {base_where}
            ),
            picked AS (
                SELECT DISTINCT raw.exp, raw.strike, raw.r
                FROM raw
                JOIN req_dates ON raw.d = req_dates.d
                WHERE raw.bid >= {MIN_ENTRY_BID}
                  AND ABS(raw.delta) BETWEEN 0.15 AND 0.90{picked_extra}
            )
            SELECT raw.d, raw.exp, raw.strike, raw.r, raw.bid, raw.ask, raw.mark, raw.iv, raw.delta, raw.vol, raw.oi
            FROM raw
            JOIN picked USING (exp, strike, r)
            ORDER BY raw.d, raw.exp, raw.strike
            """
        else:
            where_all = [base_where]
            if min_dte_filter is not None:
                where_all.append(f"datediff('day', date::DATE, expiration::DATE) >= {int(min_dte_filter)}")
            if max_dte_filter is not None:
                where_all.append(f"datediff('day', date::DATE, expiration::DATE) <= {int(max_dte_filter)}")
            sql = f"""
            SELECT date::DATE::VARCHAR, expiration::DATE::VARCHAR, strike::DOUBLE, lower(type),
                   bid::DOUBLE, ask::DOUBLE, mark::DOUBLE, implied_volatility::DOUBLE, delta::DOUBLE,
                   COALESCE(volume, 0)::BIGINT, COALESCE(open_interest, 0)::BIGINT
            FROM read_parquet('{glob_expr}')
            WHERE {" AND ".join(where_all)}
            ORDER BY date, expiration, strike
            """
        book = QuoteBook(symbol=symbol.upper())
        for row in con.execute(sql).fetchall():
            q, reason = validate_quote(
                day=row[0], expiration=row[1], strike=row[2], right=row[3],
                bid=row[4], ask=row[5], mark=row[6], iv=row[7], delta=row[8],
                volume=row[9], open_interest=row[10],
            )
            if q is None:
                if reason == "crossed":
                    book.stats["skipped_crossed"] += 1
                else:
                    book.stats["skipped_invalid"] += 1
                continue
            book.add(q)
        return book.finalize()
    finally:
        con.close()


@dataclass
class RealUnderlying:
    """Raw (split-adjusted, non-dividend) spot series aligned with `Series`, matching `options.Underlying` fields."""

    s: Series
    dates: list[date] = field(init=False)
    factor: list[float] = field(init=False)
    open: list[float] = field(init=False)
    low: list[float] = field(init=False)
    close: list[float] = field(init=False)

    def __post_init__(self) -> None:
        self.dates = [date.fromisoformat(d) for d in self.s.dates]
        self.factor = [r / c for r, c in zip(self.s.raw_close, self.s.close)]
        self.open = [x * k for x, k in zip(self.s.open, self.factor)]
        self.low = [x * k for x, k in zip(self.s.low, self.factor)]
        self.close = list(self.s.raw_close)

    def session_on_or_before(self, d: date) -> int:
        return bisect_right(self.dates, d) - 1


@dataclass
class RealTrade:
    """One long option or vertical debit spread tracked on REAL historical bid/ask quotes."""

    u: RealUnderlying
    legs: tuple[Leg, ...]
    expiry: date
    expiry_i: int
    entry_i: int
    exit_i: int
    debit: float                        # exact real entry cost per share (ask for long, bid for short + comm)
    mids: list[float]                   # daily real mid on entry_i..exit_i
    bids: list[float]                   # daily real executable liquidation bid (net of commission)
    deltas: list[float | None]          # daily net delta from quotes (for intraday fill approx when needed)
    spread_pcts: list[float | None]     # daily structure (ask - bid) / mid
    entry_half_spread_pct: float        # (entry_ask - entry_mid) / entry_mid
    has_real_expiry_quote: bool         # True if expiry_i was priced from a real quote vs intrinsic fallback
    quoted_days: int                    # days priced from real quotes
    carried_days: int                   # days with a missing quote carried from prior session / intrinsic

    def mid(self, i: int) -> float:
        return self.mids[i - self.entry_i]

    def spread_pct(self, i: int) -> float | None:
        return self.spread_pcts[i - self.entry_i]

    def exit_bid(self, i: int, spot: float | None = None, *, expiry_spread_mult: float = 1.0) -> float:
        """Executable liquidation value per share on day `i`.

        * `spot is None` (close-confirmed exit or scheduled exit): exact real net bid (or scaled expiry spread
          stress on `i == expiry_i`).
        * `spot is not None` (intraday-low rung fill): first-order delta adjustment anchored strictly to the
          prior day's close, prior real bid, and prior real delta (`deltas[i - 1 - entry_i]`), floored at 0.
        """
        idx = i - self.entry_i
        b = self.bids[idx]
        if i == self.expiry_i and expiry_spread_mult != 1.0 and spot is None:
            # Stress-test widening bid-ask spread at 15:45 ET on expiry day for ITM contracts.
            m = self.mids[idx]
            if m > 0 and b > 0 and m >= b:
                half = m - b
                return max(0.0, m - half * expiry_spread_mult)
            return b
        if spot is None:
            return b
        # Intraday fill approximation anchored strictly to prior-day close (zero same-day EOD lookahead,
        # and conservative under positive gamma on selloffs).
        if idx <= 0:
            return b
        prev_idx = idx - 1
        prev_bid = self.bids[prev_idx]
        d = self.deltas[prev_idx]
        if d is None:
            return prev_bid
        adj = prev_bid + d * (spot - self.u.close[i - 1])
        return max(0.0, adj)


def _structure_quote(
    book: QuoteBook,
    day: str,
    exp_str: str,
    legs: Sequence[Leg],
    spot: float,
    *,
    is_expiry: bool,
) -> tuple[float, float, float | None, float | None, bool] | None:
    """Return `(mid, exec_bid, net_delta, spread_pct, from_real_quote)` for `legs` on `day`.

    * `exec_bid` is what you receive if you close the long structure now:
      long legs sell at real `bid - LEG_COMMISSION`; short legs buy back at real `ask + LEG_COMMISSION`.
    * On expiry day (`is_expiry=True`), if a real quote exists and the structure is ITM (`mid > 0`), we use the
      real executable bid (reflecting a 15:45 ET closeout, never exercise); if OTM (`intrinsic == 0` and
      `bid == 0`), it expires worthless at `$0` with `$0` closing commission!
    * If no real quote exists on expiry day, falls back to intrinsic value (for ITM minus `LEG_COMMISSION`,
      labelled `from_real_quote=False`).
    """
    qs = [book.get(day, exp_str, leg.strike, leg.right) for leg in legs]
    if all(q is not None for q in qs):
        mid = sum(leg.qty * q.mid for leg, q in zip(legs, qs) if q is not None)
        if is_expiry:
            intr = sum(leg.qty * intrinsic(leg.right, spot, leg.strike) for leg in legs)
            if intr <= 0.0:
                return max(0.0, mid), 0.0, 0.0, None, True
        exec_bid = 0.0
        total_spread = 0.0
        net_delta: float | None = 0.0
        for leg, q in zip(legs, qs):
            assert q is not None
            if leg.qty > 0:
                leg_intr = intrinsic(leg.right, spot, leg.strike)
                if is_expiry and leg_intr > 0.0 and q.bid <= 0.0:
                    # Pulled/stale zero-bid quote on an ITM contract at expiry: fall back to intrinsic.
                    intr = max(0.0, sum(l.qty * intrinsic(l.right, spot, l.strike) for l in legs))
                    comm = sum(abs(l.qty) * LEG_COMMISSION for l in legs)
                    return intr, max(0.0, intr - comm), 0.0, None, False
                leg_proceeds = max(0.0, q.bid - LEG_COMMISSION) if q.bid > 0 else 0.0
                exec_bid += leg.qty * leg_proceeds
            else:
                leg_intr = intrinsic(leg.right, spot, leg.strike)
                if is_expiry and leg_intr > 0.0 and q.ask <= 0.0:
                    # Pulled/stale zero-ask quote on an ITM short leg at expiry: fall back to spread intrinsic.
                    intr = max(0.0, sum(l.qty * intrinsic(l.right, spot, l.strike) for l in legs))
                    comm = sum(abs(l.qty) * LEG_COMMISSION for l in legs)
                    return intr, max(0.0, intr - comm), 0.0, None, False
                # Closing a short leg pays ask + commission (unless OTM on expiry day -> $0).
                if is_expiry and leg_intr <= 0.0 and q.bid <= 0.0:
                    leg_cost = 0.0
                else:
                    leg_cost = q.ask + LEG_COMMISSION
                exec_bid -= abs(leg.qty) * leg_cost
            total_spread += abs(leg.qty) * (q.ask - q.bid)
            if q.delta is None or net_delta is None:
                net_delta = None
            else:
                net_delta += leg.qty * q.delta
        exec_bid = max(0.0, exec_bid)
        mid = max(0.0, mid)
        sp = (total_spread / mid) if mid > 0 else None
        return mid, exec_bid, net_delta, sp, True

    if is_expiry:
        intr = max(0.0, sum(leg.qty * intrinsic(leg.right, spot, leg.strike) for leg in legs))
        if intr <= 0.0:
            return 0.0, 0.0, 0.0, None, False
        comm = sum(abs(leg.qty) * LEG_COMMISSION for leg in legs)
        return intr, max(0.0, intr - comm), 0.0, None, False
    return None


def open_real_trade(
    u: RealUnderlying,
    book: QuoteBook,
    legs: Sequence[Leg],
    entry_i: int,
    exp_str: str,
    *,
    last_chance: int = 0,
    max_missing_frac: float = 0.20,
) -> RealTrade | None:
    """Build one `RealTrade` from real quotes starting on `entry_i` through `expiry_i - last_chance`."""
    exp = date.fromisoformat(exp_str)
    if exp > u.dates[-1]:
        return None
    expiry_i = u.session_on_or_before(exp)
    exit_i = expiry_i - last_chance
    if exit_i <= entry_i:
        return None
    last_book = book.last_date
    if last_book is not None and u.s.dates[exit_i] > last_book:
        return None

    # Exact entry debit: buy long legs at real ask + comm, sell short legs at real bid - comm.
    entry_day = u.s.dates[entry_i]
    qs0 = [book.get(entry_day, exp_str, leg.strike, leg.right) for leg in legs]
    if any(q is None for q in qs0):
        return None
    entry_mid = sum(leg.qty * q.mid for leg, q in zip(legs, qs0) if q is not None)
    if entry_mid < MIN_ENTRY_MID:
        return None
    debit = 0.0
    for leg, q in zip(legs, qs0):
        assert q is not None
        if leg.qty > 0:
            debit += leg.qty * (q.ask + LEG_COMMISSION)
        else:
            debit -= abs(leg.qty) * max(0.0, q.bid - LEG_COMMISSION)
    if debit <= 0.0:
        return None
    entry_half_spread_pct = max(0.0, (debit - entry_mid) / entry_mid)

    mids: list[float] = []
    bids: list[float] = []
    deltas: list[float | None] = []
    spreads: list[float | None] = []
    quoted = 0
    carried = 0
    has_real_expiry = False
    for d_idx in range(entry_i, exit_i + 1):
        is_exp = d_idx == expiry_i
        res = _structure_quote(book, u.s.dates[d_idx], exp_str, legs, u.close[d_idx], is_expiry=is_exp)
        if res is not None:
            m, b, dl, sp, real = res
            mids.append(m)
            bids.append(b)
            deltas.append(dl)
            spreads.append(sp)
            if real:
                quoted += 1
                if is_exp:
                    has_real_expiry = True
            else:
                carried += 1
        else:
            if not mids:
                return None
            # Missing intermediate day quote: carry prior session forward and count it transparently.
            mids.append(mids[-1])
            bids.append(bids[-1])
            deltas.append(deltas[-1])
            spreads.append(spreads[-1])
            carried += 1

    total = quoted + carried
    if total == 0 or (carried / total) > max_missing_frac:
        return None
    return RealTrade(
        u=u,
        legs=tuple(legs),
        expiry=exp,
        expiry_i=expiry_i,
        entry_i=entry_i,
        exit_i=exit_i,
        debit=debit,
        mids=mids,
        bids=bids,
        deltas=deltas,
        spread_pcts=spreads,
        entry_half_spread_pct=entry_half_spread_pct,
        has_real_expiry_quote=has_real_expiry,
        quoted_days=quoted,
        carried_days=carried,
    )


def make_real_leaps(u: RealUnderlying, book: QuoteBook, entry_i: int, *,
                    min_dte: int = 365, target_delta: float = 0.75, last_chance: int = 2) -> RealTrade | None:
    day = u.s.dates[entry_i]
    exp = book.select_expiry(day, min_dte=min_dte, monthly_only=True) or book.select_expiry(day, min_dte=min_dte)
    if exp is None:
        return None
    q = book.select_by_delta(day, exp, "call", target_delta)
    if q is None:
        return None
    return open_real_trade(u, book, (Leg("call", q.strike, 1),), entry_i, exp, last_chance=last_chance)


def make_real_call45(u: RealUnderlying, book: QuoteBook, entry_i: int, *,
                     lo_dte: int = 30, hi_dte: int = 60, target_dte: int = 45,
                     target_delta: float = 0.50) -> RealTrade | None:
    day = u.s.dates[entry_i]
    exp = (book.select_expiry(day, min_dte=lo_dte, max_dte=hi_dte, target_dte=target_dte, monthly_only=True)
           or book.select_expiry(day, min_dte=lo_dte, max_dte=hi_dte, target_dte=target_dte))
    if exp is None:
        return None
    q = book.select_by_delta(day, exp, "call", target_delta)
    if q is None:
        return None
    return open_real_trade(u, book, (Leg("call", q.strike, 1),), entry_i, exp, last_chance=0)


def make_real_spread45(u: RealUnderlying, book: QuoteBook, entry_i: int, *,
                       lo_dte: int = 30, hi_dte: int = 60, target_dte: int = 45,
                       long_delta: float = 0.50, short_delta: float = 0.30) -> RealTrade | None:
    day = u.s.dates[entry_i]
    exp = (book.select_expiry(day, min_dte=lo_dte, max_dte=hi_dte, target_dte=target_dte, monthly_only=True)
           or book.select_expiry(day, min_dte=lo_dte, max_dte=hi_dte, target_dte=target_dte))
    if exp is None:
        return None
    q1 = book.select_by_delta(day, exp, "call", long_delta)
    q2 = book.select_by_delta(day, exp, "call", short_delta)
    if q1 is None or q2 is None or q2.strike <= q1.strike:
        return None
    return open_real_trade(u, book, (Leg("call", q1.strike, 1), Leg("call", q2.strike, -1)), entry_i, exp, last_chance=0)


def spread_diagnostics(trades: Sequence[RealTrade]) -> dict:
    """Summarize actual observed bid-ask spreads vs PR #489's assumed 2% ETF / 3% stock half-spread."""
    if not trades:
        return {"trades": 0}
    entry_hs = sorted(t.entry_half_spread_pct for t in trades)
    t3_sp = sorted(
        sp for t in trades
        if t.expiry_i - 3 >= t.entry_i and t.expiry_i - 3 <= t.exit_i
        for sp in (t.spread_pct(t.expiry_i - 3),) if sp is not None
    )
    exp_itm_sp = sorted(
        sp for t in trades
        if t.exit_i == t.expiry_i and t.mid(t.expiry_i) > 0
        for sp in (t.spread_pct(t.expiry_i),) if sp is not None
    )

    def pct_stats(xs: list[float]) -> dict | None:
        if not xs:
            return None
        n = len(xs)
        return {
            "n": n,
            "median": xs[n // 2],
            "mean": sum(xs) / n,
            "p90": xs[min(n - 1, int(0.9 * n))],
        }

    return {
        "trades": len(trades),
        "realExpiryQuoteShare": sum(1 for t in trades if t.has_real_expiry_quote) / len(trades),
        "quotedDayShare": sum(t.quoted_days for t in trades) / max(1, sum(t.quoted_days + t.carried_days for t in trades)),
        "entryHalfSpread": pct_stats(entry_hs),
        "t3FullSpread": pct_stats(t3_sp),
        "expiryItmFullSpread": pct_stats(exp_itm_sp),
    }
