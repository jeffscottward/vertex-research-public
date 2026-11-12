"""Run plan of the Triple RSI study (research only; it never places orders).

Design and pass/fail rule: docs/specs/strategies/triple-rsi.md (fixed 2026-11-12 before the first full run).

Every run uses the same warm-up: the run days of a symbol start at its bar FIRST (250 bars, the longest trend
average of the sensitivity grid), so all variants of one symbol cover the same days.

Jobs (pure functions of the data directory and their arguments; research/backtests/triple-rsi/run.py runs them
in a process pool):
- `share_job`: one share run (symbol, parameters, execution, cost, price basis), booked by the ledger and by
  NautilusTrader; returns the daily equity and the trade records.
- `options_job`: one options form run (symbol, variant) or its always-on baseline, booked by the qc-ports ledger
  and NautilusTrader.
- `dsl_job`: the DSL definition in the NautilusTrader DSL engine (`nautilus_backtest.engine.run_spec`, next-open
  fills, price basis) next to the share ledger of the same fills.
`assemble` turns the job outputs into the results document: measures with N = every strategy run of the study,
the gate rows, the sensitivity grid, the walk-forward and the decision.
"""
from __future__ import annotations

import functools
import hashlib
from collections.abc import Mapping, Sequence
from statistics import mean, stdev, variance

from strategies.qc_ports import allocation as al
from strategies.qc_ports import portfolio as pf
from strategies.qc_ports.data import IV_INDEX, data_root
from strategies.qc_ports.ledger import LedgerResult

from . import dsl, metrics, options_form, rules, shares
from .rules import Params

__all__ = ["CAPITAL", "COSTS", "DECIDING_OPTIONS", "FIRST", "GRID", "SCHEMA", "SYMBOLS", "assemble", "data_files",
           "dsl_job", "grid_params", "options_job", "share_job"]

SCHEMA = "triple-rsi-study-v1"
CAPITAL = shares.CAPITAL
FIRST = 249
SYMBOLS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
# Cost per side as a fraction of the traded value: as stated (none), the Vertex base, the 2x stress.
COSTS = {"none": 0.0, "base": 0.0005, "stress": 0.001}
GRID = {"length": (3, 4, 5, 6, 7), "entry_below": (25.0, 30.0, 35.0), "exit_above": (45.0, 50.0, 55.0),
        "trend_length": (150, 200, 250), "rsi_kind": ("wilder", "cutler")}
DECIDING_OPTIONS = ("SPY", "call30")
BASELINE_DELAYS = (0, 21)
NEIGHBOUR_SHARE_MIN = 0.75


def grid_params() -> list[Params]:
    return [Params(length=length, entry_below=entry, exit_above=exit_, trend_length=trend, rsi_kind=kind)
            for kind in GRID["rsi_kind"] for length in GRID["length"] for entry in GRID["entry_below"]
            for exit_ in GRID["exit_above"] for trend in GRID["trend_length"]]


@functools.lru_cache(maxsize=4)
def _dataset(root: str) -> pf.Dataset:
    return pf.dataset_from_dir(root)


def data_files(root: str | None = None) -> dict[str, str]:
    """SHA-256 of every data file the study reads."""
    base = data_root(root)
    names = [*SYMBOLS, *(IV_INDEX[symbol] for symbol in SYMBOLS), "IRX"]
    return {f"{name}.csv": hashlib.sha256((base / f"{name}.csv").read_bytes()).hexdigest() for name in names}


def _result_json(result: LedgerResult) -> dict:
    return {"dates": list(result.dates), "equity": list(result.equity), "positions": list(result.open_positions),
            "trades": list(result.trades), "capital": result.capital, "engine": result.engine}


def _result_of(data: Mapping) -> LedgerResult:
    return LedgerResult(tuple(data["dates"]), tuple(data["equity"]), tuple(data["positions"]), tuple(data["trades"]),
                        (), capital=data["capital"], engine=data["engine"])


def share_job(root: str, symbol: str, params: Params, execution: str, cost: float, basis: str = "total",
              nautilus: bool = True) -> dict:
    bars = _dataset(root).bars[symbol]
    entries, exits = rules.signal_bars(bars.close, params)
    trades = rules.signal_trades(entries, exits, FIRST)
    prices = shares.traded_prices(bars, FIRST, basis)
    plan = shares.fills(trades, execution, len(prices.dates), FIRST)
    result, gap = shares.book(prices, plan, cost, CAPITAL, nautilus=nautilus)
    return {"symbol": symbol, "params": params.key(), "execution": execution, "cost": cost, "basis": basis,
            "nautilusGap": gap, "engine": shares.engine_id() if nautilus else result.engine,
            "result": _result_json(result)}


def buy_hold_job(root: str, symbol: str) -> dict:
    bars = _dataset(root).bars[symbol]
    prices = shares.traded_prices(bars, FIRST, "total")
    last = len(prices.dates) - 1
    result = shares.run_ledger(prices, [shares.Fill(0, shares.CLOSE, last, shares.CLOSE, "end")], 0.0, CAPITAL)
    return {"symbol": symbol, "result": _result_json(result)}


def options_job(root: str, symbol: str, variant_key: str, baseline_delay: int | None = None) -> dict:
    """One options run; `baseline_delay` not None runs the always-on form of the variant's structure instead."""
    dataset = _dataset(root)
    variant = next(item for item in options_form.FORMS if item.key == variant_key)
    start = dataset.bars[symbol].dates[FIRST]
    if baseline_delay is None:
        form = options_form.form_of(symbol, variant, rules.STATED, FIRST)
    else:
        form = options_form.baseline_form(symbol, variant, baseline_delay)
    book = options_form.priced(form, dataset, symbol, start)
    days = options_form.run_days(dataset, symbol, start)
    if not book.trades:
        return {"symbol": symbol, "variant": variant_key, "baselineDelay": baseline_delay, "refused": book.refused,
                "nautilusGap": None, "result": None}
    result, gap, engine = options_form.book_options(book.trades, CAPITAL, days)
    return {"symbol": symbol, "variant": variant_key, "baselineDelay": baseline_delay, "refused": dict(book.refused),
            "nautilusGap": gap, "engine": engine, "result": _result_json(result),
            "tradeRows": options_form.trade_rows(result)}


def dsl_job(root: str, symbol: str = "SPY") -> dict:
    """The DSL definition in the NautilusTrader DSL engine on split-adjusted bars (price basis, no cost), next to
    the share ledger of the rule with next-open fills on the same basis. Both start at bar 0 (no common warm-up:
    the DSL engine runs the whole series)."""
    from nautilus_backtest.engine import run_spec

    bars = _dataset(root).bars[symbol]
    dsl_bars = pf.dsl_bars(bars.dates, bars.open, bars.high, bars.low, bars.close)
    definition = dsl.definition(rules.STATED)
    run = run_spec(dsl_bars, {"rule": {"kind": "dsl", "definition": definition}, "costBps": 0,
                              "initialCapital": CAPITAL, "timeframe": "1d"})
    entries, exits = rules.signal_bars(bars.close, rules.STATED)
    trades = rules.signal_trades(entries, exits, 0)
    prices = shares.traded_prices(bars, 0, "price")
    ledger = shares.run_ledger(prices, shares.fills(trades, "nextOpen", len(prices.dates), 0), 0.0, CAPITAL)
    # The DSL engine reports unit equity (equity / capital).
    dsl_equity = [value * CAPITAL for value in run.equity]
    gap = max(abs(a - b) / max(abs(a), abs(b)) for a, b in zip(ledger.equity, dsl_equity, strict=True))
    dsl_spans = [(bars.dates[trade["entryIndex"]], bars.dates[trade["exitIndex"]]) for trade in run.trades]
    ledger_spans = [(trade["entryDate"], trade["exitDate"]) for trade in ledger.trades]
    return {"symbol": symbol, "definition": definition, "engine": run.engine, "trades": len(run.trades),
            "ledgerTrades": len(ledger.trades), "sameTrades": dsl_spans == ledger_spans, "equityGap": gap,
            "dslFinal": dsl_equity[-1], "ledgerFinal": ledger.equity[-1], "from": bars.dates[0],
            "to": bars.dates[-1]}


# --------------------------------------------------------------------------- assembly

def _daily_sharpe(result: LedgerResult) -> float:
    returns = metrics.daily_returns(result.equity)
    if len(returns) < 2:
        return 0.0
    spread = stdev(returns)
    return mean(returns) / spread if spread > 0 else 0.0


def _share_key(job: Mapping) -> str:
    return f"share:{job['symbol']}:{job['params']}:{job['execution']}:{job['cost']:g}:{job['basis']}"


def _window_hold(hold: LedgerResult, start: str, end: str) -> dict:
    """Buy-and-hold measures over the run days [start, end] of another run (bought at the close of `start`)."""
    first, last = hold.dates.index(start), hold.dates.index(end)
    scale = CAPITAL / hold.equity[first]
    window = LedgerResult(hold.dates[first:last + 1], tuple(value * scale for value in hold.equity[first:last + 1]),
                          hold.open_positions[first:last + 1], (), (), capital=CAPITAL, engine=hold.engine)
    return metrics.equity_stats(window, n_trials=1, sharpe_variance=None, carlo=None)


def _monthly(result: LedgerResult) -> list[dict]:
    """Month-end points: return since the start and drawdown (fractions)."""
    drawdowns = metrics.drawdown_curve([result.capital, *result.equity])[1:]
    points = []
    for index, day in enumerate(result.dates):
        if index + 1 < len(result.dates) and result.dates[index + 1][:7] == day[:7]:
            continue
        points.append({"month": day[:7], "value": result.equity[index] / result.capital - 1,
                       "drawdown": min(0.0, drawdowns[index])})
    return points


def assemble(share_runs: Sequence[Mapping], grid_runs: Sequence[Mapping], options_runs: Sequence[Mapping],
             buy_holds: Sequence[Mapping], dsl_run: Mapping) -> dict:
    """The results document (JSON-ready) from the job outputs."""
    shares_by_key = {_share_key(job): job for job in [*share_runs, *grid_runs]}
    strategy_options = [job for job in options_runs if job["baselineDelay"] is None and job["result"] is not None]
    trials: dict[str, float] = {key: _daily_sharpe(_result_of(job["result"])) for key, job in shares_by_key.items()}
    for job in strategy_options:
        trials[f"options:{job['symbol']}:{job['variant']}"] = _daily_sharpe(_result_of(job["result"]))
    n_trials = len(trials)
    trial_variance = variance(trials.values()) if n_trials > 1 else None

    hold_stats, holds = {}, {}
    for job in buy_holds:
        result = _result_of(job["result"])
        holds[job["symbol"]] = result
        hold_stats[job["symbol"]] = metrics.equity_stats(result, n_trials=1, sharpe_variance=None, carlo=None)

    def share_row(job: Mapping) -> dict:
        result = _result_of(job["result"])
        carlo = metrics.monte_carlo_returns([trade["return"] for trade in result.trades])
        stats = metrics.equity_stats(result, n_trials=n_trials, sharpe_variance=trial_variance, carlo=carlo)
        baseline = hold_stats[job["symbol"]]["sharpe"]
        return {"symbol": job["symbol"], "params": job["params"], "execution": job["execution"],
                "costPerSide": job["cost"], "basis": job["basis"], "nautilusGap": job["nautilusGap"],
                "engine": job["engine"], "stats": stats, "checks": metrics.gate(stats, baseline),
                "lowerBar": metrics.lower_bar(stats), "buyHold": hold_stats[job["symbol"]]}

    share_rows = [share_row(job) for job in share_runs]
    grid_rows = []
    for job in grid_runs:
        result = _result_of(job["result"])
        stats = metrics.equity_stats(result, n_trials=n_trials, sharpe_variance=trial_variance, carlo=None)
        grid_rows.append({"params": job["params"], **{key: stats[key] for key in (
            "sharpe", "oosSharpe", "cagr", "maxDrawdown", "trades", "winRate", "profitFactor", "exposure")}})
    positive = sum(1 for row in grid_rows if (row["sharpe"] or 0) > 0)
    neighbour_share = positive / len(grid_rows) if grid_rows else None
    walk = metrics.walk_forward({job["params"]: job["result"]["equity"] for job in grid_runs},
                                rules.STATED.key()) if grid_runs else None

    baseline_phases: dict[tuple[str, str], list[float]] = {}
    for job in options_runs:
        if job["baselineDelay"] is not None and job["result"] is not None:
            equity = job["result"]["equity"]
            baseline_phases.setdefault((job["symbol"], job["variant"]), []).append(
                metrics.sharpe(metrics.daily_returns(equity)))
    options_rows = []
    for job in options_runs:
        if job["baselineDelay"] is not None:
            continue
        row = {"symbol": job["symbol"], "variant": job["variant"], "refused": job["refused"],
               "nautilusGap": job["nautilusGap"], "engine": job.get("engine"), "stats": None, "checks": [],
               "lowerBar": False, "baselineSharpe": None, "buyHold": None}
        if job["result"] is not None:
            result = _result_of(job["result"])
            row["buyHold"] = _window_hold(holds[job["symbol"]], result.dates[0], result.dates[-1])
            carlo = al.monte_carlo([trade["pnl"] for trade in result.trades], result.capital,
                                   paths=metrics.MONTE_CARLO_PATHS)
            stats = metrics.equity_stats(result, n_trials=n_trials, sharpe_variance=trial_variance, carlo=carlo,
                                         trades=job["tradeRows"])
            phases = baseline_phases.get((job["symbol"], job["variant"]))
            row["baselineSharpe"] = mean(phases) if phases else None
            row.update(stats=stats, checks=metrics.gate(stats, row["baselineSharpe"]),
                       lowerBar=metrics.lower_bar(stats))
        options_rows.append(row)

    def find_share(symbol: str, execution: str, cost_name: str) -> dict:
        return next(row for row in share_rows if row["symbol"] == symbol and row["execution"] == execution
                    and row["costPerSide"] == COSTS[cost_name] and row["params"] == rules.STATED.key()
                    and row["basis"] == "total")

    deciding = next(row for row in options_rows if (row["symbol"], row["variant"]) == DECIDING_OPTIONS)
    stress = find_share("SPY", "close", "stress")
    extras = [
        {"check": "SPY shares at 2x the base cost: Sharpe > 0", "pass": (stress["stats"]["sharpe"] or 0) > 0,
         "value": stress["stats"]["sharpe"]},
        {"check": f"Share of the {len(grid_rows)} variants with Sharpe > 0 >= 75%",
         "pass": neighbour_share is not None and neighbour_share >= NEIGHBOUR_SHARE_MIN, "value": neighbour_share},
    ]
    passes_gate = bool(deciding["checks"]) and all(check["pass"] for check in [*deciding["checks"], *extras])
    stated = find_share("SPY", "close", "none")
    claim = stated["stats"]
    return {
        "schema": SCHEMA,
        "trials": {"n": n_trials, "variance": trial_variance},
        "shares": share_rows,
        "grid": grid_rows,
        "neighbourShare": neighbour_share,
        "walkForward": walk,
        "dsl": dict(dsl_run),
        "options": options_rows,
        "buyHold": hold_stats,
        "decision": {
            "row": {"symbol": DECIDING_OPTIONS[0], "variant": DECIDING_OPTIONS[1]},
            "checks": deciding["checks"], "extras": extras, "passesGate": passes_gate,
            "passesLowerBar": deciding["lowerBar"],
            "winRateReproduces": (claim["winRate"] or 0) >= 0.85 and claim["trades"] >= 80,
        },
        "curves": {
            "statedSpy": _monthly(_result_of(next(job for job in share_runs if _share_key(job) == _share_key(
                {"symbol": "SPY", "params": rules.STATED.key(), "execution": "close", "cost": 0.0,
                 "basis": "total"}))["result"])),
            "buyHoldSpy": _monthly(_result_of(next(job for job in buy_holds if job["symbol"] == "SPY")["result"])),
            "optionsSpy": _monthly(_result_of(next(job for job in strategy_options
                                                   if (job["symbol"], job["variant"]) == DECIDING_OPTIONS)["result"])),
        },
    }
