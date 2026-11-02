"""Pairs (statistical arbitrage) research lens. Research only: no orders, no broker access.

Engle-Granger cointegration test (OLS hedge ratio, then an augmented Dickey-Fuller test on
the residual spread with MacKinnon p-values), the half-life of mean reversion, and a z-score
spread backtest with transaction costs. The output is a backtest record in the
agent-ops record shape, so the portal derives the same analytics as for any backtest.

Conventions:
- The hedge ratio, the intercept and the cointegration test use only the formation window.
  Trading starts after it, so the test and the ratio have no look-ahead.
- A signal at the close of bar t fills at the close of bar t + 1.
- One unit of spread is long 1 share of Y and short `hedge_ratio` shares of X.
  The gross notional at entry is `leverage` times the equity.
- Costs: `cost_bps` of the traded notional of both legs at each entry and exit.

MacKinnon (1994, 2010) response-surface coefficients for N = 2 with a constant are the
values published in those papers, as also tabulated in statsmodels (BSD-3-Clause).
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import dataclass
from statistics import NormalDist

_NORMAL = NormalDist()

# MacKinnon (1994) p-value response surface, N = 2 series, constant in the cointegrating regression.
_TAU_MAX = 0.92
_TAU_MIN = -18.86
_TAU_STAR = -2.62
_SMALL_P = (2.92, 1.5012, 0.039796)
_LARGE_P = (2.1945, 0.64695, -0.29198, -0.042377)
# MacKinnon (2010) critical values (1%, 5%, 10%): c0 + c1 / T + c2 / T^2.
_CRITICAL = ((-3.89644, -10.9519, -33.527), (-3.33613, -6.1101, -6.823), (-3.04445, -4.2412, -2.72))


def _solve_inverse(matrix: list[list[float]]) -> list[list[float]]:
    """Inverse of a small symmetric positive-definite matrix (Gauss-Jordan, partial pivoting)."""
    size = len(matrix)
    work = [row[:] + [1.0 if i == j else 0.0 for j in range(size)] for i, row in enumerate(matrix)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(work[row][column]))
        if abs(work[pivot][column]) < 1e-300:
            raise ValueError("singular regression matrix")
        work[column], work[pivot] = work[pivot], work[column]
        scale = work[column][column]
        work[column] = [value / scale for value in work[column]]
        for row in range(size):
            if row != column and work[row][column] != 0.0:
                factor = work[row][column]
                work[row] = [value - factor * other for value, other in zip(work[row], work[column])]
    return [row[size:] for row in work]


@dataclass(frozen=True)
class Regression:
    coefficients: tuple[float, ...]
    t_values: tuple[float, ...]
    ssr: float
    nobs: int

    @property
    def aic(self) -> float:
        """statsmodels OLS AIC: -2 log-likelihood + 2 k (Gaussian, no constant counted separately)."""
        n = self.nobs
        log_likelihood = -n / 2 * (math.log(2 * math.pi) + math.log(self.ssr / n) + 1)
        return -2 * log_likelihood + 2 * len(self.coefficients)


def ols(y: list[float], columns: list[list[float]]) -> Regression:
    """Least squares of y on the given regressor columns (no implicit constant)."""
    k, n = len(columns), len(y)
    if n <= k:
        raise ValueError("needs more observations than regressors")
    xtx = [[math.fsum(a * b for a, b in zip(columns[i], columns[j])) for j in range(k)] for i in range(k)]
    xty = [math.fsum(a * b for a, b in zip(columns[i], y)) for i in range(k)]
    inverse = _solve_inverse(xtx)
    beta = [math.fsum(inverse[i][j] * xty[j] for j in range(k)) for i in range(k)]
    residuals = [y[t] - math.fsum(beta[i] * columns[i][t] for i in range(k)) for t in range(n)]
    ssr = math.fsum(value * value for value in residuals)
    variance = ssr / (n - k)
    t_values = tuple(beta[i] / math.sqrt(variance * inverse[i][i]) if variance > 0 else math.inf for i in range(k))
    return Regression(tuple(beta), t_values, ssr, n)


@dataclass(frozen=True)
class AdfResult:
    statistic: float
    lags: int
    nobs: int


def adf_no_constant(series: list[float], max_lag: int | None = None, autolag: bool = True) -> AdfResult:
    """Augmented Dickey-Fuller t-statistic without constant (for cointegration residuals).

    Matches statsmodels adfuller(regression="n", autolag="AIC"): lags 0..max_lag are compared
    on a common sample by AIC, then the chosen lag is refitted on all available rows.
    """
    n = len(series)
    if max_lag is None:
        max_lag = min(n // 2 - 1, int(math.ceil(12 * (n / 100) ** 0.25)))
    if max_lag < 0 or n < 4:
        raise ValueError("series too short for the ADF test")
    diff = [series[t] - series[t - 1] for t in range(1, n)]

    def design(lags: int, rows: int) -> tuple[list[float], list[list[float]]]:
        # Rows are the last `rows` differences; regressors: lagged level, then lagged differences.
        start = len(diff) - rows
        level = [series[start + t] for t in range(rows)]
        lagged = [[diff[start + t - lag] for t in range(rows)] for lag in range(1, lags + 1)]
        return diff[start:], [level, *lagged]

    lags = max_lag
    if autolag:
        rows = len(diff) - max_lag
        target, columns = design(max_lag, rows)
        scores = [(ols(target, columns[:lag + 1]).aic, lag) for lag in range(max_lag + 1)]
        lags = min(scores)[1]
    target, columns = design(lags, len(diff) - lags)
    fit = ols(target, columns)
    return AdfResult(fit.t_values[0], lags, fit.nobs)


def mackinnon_p_value(statistic: float) -> float:
    """MacKinnon (1994) approximate p-value of an Engle-Granger statistic, N = 2, constant."""
    if statistic > _TAU_MAX:
        return 1.0
    if statistic < _TAU_MIN:
        return 0.0
    coefficients = _SMALL_P if statistic <= _TAU_STAR else _LARGE_P
    return _NORMAL.cdf(math.fsum(c * statistic ** power for power, c in enumerate(coefficients)))


def mackinnon_critical_values(nobs: int) -> tuple[float, float, float]:
    """MacKinnon (2010) critical values at 1%, 5% and 10% for N = 2 with constant; T = nobs - 1."""
    t = nobs - 1
    return tuple(c0 + c1 / t + c2 / t ** 2 for c0, c1, c2 in _CRITICAL)  # type: ignore[return-value]


@dataclass(frozen=True)
class Cointegration:
    hedge_ratio: float
    intercept: float
    statistic: float
    p_value: float
    lags: int
    critical_values: tuple[float, float, float]
    half_life: float | None


def half_life(spread: list[float]) -> float | None:
    """Bars for a deviation to halve under an AR(1) fit ds_t = a + b s_{t-1}; None without reversion."""
    lagged = spread[:-1]
    change = [spread[t] - spread[t - 1] for t in range(1, len(spread))]
    fit = ols(change, [[1.0] * len(lagged), lagged])
    phi = 1 + fit.coefficients[1]
    return math.log(0.5) / math.log(phi) if 0 < phi < 1 else None


def engle_granger(y: list[float], x: list[float], max_lag: int | None = None) -> Cointegration:
    """Engle and Granger (1987) two-step test. H0: no cointegration."""
    if len(y) != len(x):
        raise ValueError("legs differ in length")
    fit = ols(y, [[1.0] * len(x), list(x)])
    intercept, slope = fit.coefficients
    spread = [a - intercept - slope * b for a, b in zip(y, x)]
    adf = adf_no_constant(spread, max_lag)
    return Cointegration(slope, intercept, adf.statistic, mackinnon_p_value(adf.statistic), adf.lags,
                         mackinnon_critical_values(len(y)), half_life(spread))


@dataclass(frozen=True)
class SpreadTrade:
    entry_t: str
    exit_t: str
    side: str
    qty_y: float
    entry_y: float
    exit_y: float
    pnl: float
    commission: float
    exit_reason: str


@dataclass(frozen=True)
class SpreadBacktest:
    equity: list[tuple[str, float]]
    trades: list[SpreadTrade]


def zscore_backtest(dates: list[str], y: list[float], x: list[float], hedge_ratio: float, intercept: float,
                    start: int, *, lookback: int = 60, entry_z: float = 2.0, exit_z: float = 0.5,
                    stop_z: float = 4.0, cost_bps: float = 5.0, capital: float = 100_000.0,
                    leverage: float = 1.0) -> SpreadBacktest:
    """Z-score spread strategy from bar `start` to the end, with next-bar fills and costs.

    z_t uses the `lookback` spreads up to and including bar t. Enter long spread when
    z <= -entry_z, short spread when z >= entry_z; exit when |z| <= exit_z or |z| >= stop_z,
    and at the last bar.
    """
    if not 0 <= exit_z < entry_z < stop_z:
        raise ValueError("needs 0 <= exit_z < entry_z < stop_z")
    if start < lookback or start >= len(dates) - 1:
        raise ValueError("start must leave a full lookback before it and bars after it")
    spread = [a - intercept - hedge_ratio * b for a, b in zip(y, x)]
    cost = cost_bps / 10_000
    equity = capital
    position = 0  # +1 long spread, -1 short spread
    qty_y = qty_x = 0.0
    entry: dict | None = None
    pending: tuple[int, str] | None = None  # (target position, reason) filled at the next close
    points: list[tuple[str, float]] = []
    trades: list[SpreadTrade] = []
    for t in range(start, len(dates)):
        if t > start and position != 0:
            equity += position * (qty_y * (y[t] - y[t - 1]) - qty_x * (x[t] - x[t - 1]))
        if pending is not None:
            target, reason = pending
            pending = None
            if position != 0 and target != position:
                fee = cost * (qty_y * y[t] + abs(qty_x) * x[t])
                equity -= fee
                gross = position * (qty_y * (y[t] - entry["y"]) - qty_x * (x[t] - entry["x"]))
                trades.append(SpreadTrade(entry["t"], dates[t], "long" if position > 0 else "short", qty_y,
                                          entry["y"], y[t], gross - entry["fee"] - fee, entry["fee"] + fee, reason))
                position = 0
            # No new entry on the last bar: it could only close again at the same price.
            if target != 0 and position == 0 and t < len(dates) - 1:
                qty_y = equity * leverage / (y[t] + abs(hedge_ratio) * x[t])
                qty_x = qty_y * hedge_ratio
                fee = cost * (qty_y * y[t] + abs(qty_x) * x[t])
                equity -= fee
                position = target
                entry = {"t": dates[t], "y": y[t], "x": x[t], "fee": fee}
        points.append((dates[t], equity))
        if t == len(dates) - 1:
            continue
        window = spread[t - lookback + 1:t + 1]
        mean = math.fsum(window) / lookback
        deviation = math.sqrt(math.fsum((value - mean) ** 2 for value in window) / (lookback - 1))
        z = 0.0 if deviation == 0 else (spread[t] - mean) / deviation
        if position == 0:
            if z <= -entry_z:
                pending = (1, "entry")
            elif z >= entry_z:
                pending = (-1, "entry")
        elif abs(z) >= stop_z:
            pending = (0, "stop")
        elif abs(z) <= exit_z:
            pending = (0, "exit")
    if position != 0:
        t = len(dates) - 1
        fee = cost * (qty_y * y[t] + abs(qty_x) * x[t])
        equity -= fee
        gross = position * (qty_y * (y[t] - entry["y"]) - qty_x * (x[t] - entry["x"]))
        trades.append(SpreadTrade(entry["t"], dates[t], "long" if position > 0 else "short", qty_y,
                                  entry["y"], y[t], gross - entry["fee"] - fee, entry["fee"] + fee, "end"))
        points[-1] = (dates[t], equity)
    return SpreadBacktest(points, trades)


def pairs_lens(dates: list[str], y: list[float], x: list[float], *, y_label: str, x_label: str,
               task_id: str, data_source: str, formation: int, lookback: int = 60, entry_z: float = 2.0,
               exit_z: float = 0.5, stop_z: float = 4.0, cost_bps: float = 5.0,
               capital: float = 100_000.0) -> dict:
    """Run the lens and return an agent-ops backtest record (research only)."""
    if not (len(dates) == len(y) == len(x)):
        raise ValueError("dates and legs differ in length")
    coint = engle_granger(y[:formation], x[:formation])
    run = zscore_backtest(dates, y, x, coint.hedge_ratio, coint.intercept, formation, lookback=lookback,
                          entry_z=entry_z, exit_z=exit_z, stop_z=stop_z, cost_bps=cost_bps, capital=capital)
    metrics: dict[str, float | str] = {
        "pair.legs": f"{y_label}/{x_label}",
        "pair.hedge_ratio": round(coint.hedge_ratio, 6),
        "pair.intercept": round(coint.intercept, 6),
        "pair.adf_t": round(coint.statistic, 4),
        "pair.adf_p": round(coint.p_value, 6),
        "pair.adf_lags": coint.lags,
        "pair.crit_5pct": round(coint.critical_values[1], 4),
        "pair.formation_bars": formation,
        "pair.lookback": lookback,
        "pair.entry_z": entry_z,
        "pair.exit_z": exit_z,
        "pair.stop_z": stop_z,
        "pair.cost_bps": cost_bps,
        "pair.round_trips": len(run.trades),
        "total_return": round(run.equity[-1][1] / capital - 1, 6),
    }
    if coint.half_life is not None:
        metrics["pair.half_life_bars"] = round(coint.half_life, 2)
    return {
        "taskId": task_id,
        "strategy": f"Pairs z-score spread {y_label}/{x_label}",
        "instruments": f"{y_label},{x_label}",
        "periodStart": dates[formation][:10],
        "periodEnd": dates[-1][:10],
        "dataSource": data_source,
        "metrics": metrics,
        "equity": [{"t": t, "equity": round(value, 6)} for t, value in run.equity],
        "trades": [{
            "entry_t": trade.entry_t, "exit_t": trade.exit_t, "side": trade.side,
            "qty": round(trade.qty_y, 6), "entry_px": trade.entry_y, "exit_px": trade.exit_y,
            "pnl": round(trade.pnl, 6), "commission": round(trade.commission, 6),
            "symbol": f"{y_label}/{x_label}"[:40],
        } for trade in run.trades],
        "runConfig": {"initialCapital": capital, "commissionPercent": cost_bps / 100, "timeframe": "1d"},
        "notes": ("Research only. Pairs lens: Engle-Granger test and hedge ratio on the formation window "
                  f"({formation} bars), z-score trading after it with next-bar fills. Trade prices are the "
                  f"{y_label} leg; P&L is the net pair P&L after {cost_bps} bps per leg per side. "
                  f"Exits: {_count_reasons(run.trades)}."),
    }


def _count_reasons(trades: list[SpreadTrade]) -> str:
    counts: dict[str, int] = {}
    for trade in trades:
        counts[trade.exit_reason] = counts.get(trade.exit_reason, 0) + 1
    return ", ".join(f"{reason} {count}" for reason, count in sorted(counts.items())) or "none"


def _read_closes(path: str) -> dict[str, float]:
    with open(path, newline="") as handle:
        return {row["date"]: float(row["close"]) for row in csv.DictReader(handle)}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Pairs research lens (research only; no orders).")
    parser.add_argument("--y", required=True, help="CSV with date,close for leg Y")
    parser.add_argument("--x", required=True, help="CSV with date,close for leg X")
    parser.add_argument("--y-label", required=True)
    parser.add_argument("--x-label", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--data-source", required=True)
    parser.add_argument("--formation-fraction", type=float, default=0.5)
    parser.add_argument("--lookback", type=int, default=60)
    parser.add_argument("--entry-z", type=float, default=2.0)
    parser.add_argument("--exit-z", type=float, default=0.5)
    parser.add_argument("--stop-z", type=float, default=4.0)
    parser.add_argument("--cost-bps", type=float, default=5.0)
    args = parser.parse_args(argv)
    left, right = _read_closes(args.y), _read_closes(args.x)
    dates = sorted(set(left) & set(right))
    record = pairs_lens(dates, [left[d] for d in dates], [right[d] for d in dates], y_label=args.y_label,
                        x_label=args.x_label, task_id=args.task_id, data_source=args.data_source,
                        formation=int(len(dates) * args.formation_fraction), lookback=args.lookback,
                        entry_z=args.entry_z, exit_z=args.exit_z, stop_z=args.stop_z, cost_bps=args.cost_bps)
    print(json.dumps(record, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
