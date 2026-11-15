"""Intraday options forms study: the five QuantJourney strategies that trade intraday bars (research only).

Places no orders and writes nothing to Postgres. Reads
- the daily IV indices and the T-bill rate of the qc-ports fetch (--data: VIX.csv, VXN.csv, RVX.csv, IRX.csv),
- 5-minute bars of SPY, QQQ and IWM (--ib: the output of services/research/strategies/noise_band_ib_fetch.py),
- 1-minute bars of SPY from 2008 to 2021 (--spy-1min: the file of the noise-band study),
- the trial set of the daily study (--prior: the results.json of run.py under the same option model),
and writes one JSON document to --out and a results table next to it (a report work directory outside
the repository; the app never reads it).

Run (rig, in the venv with services/research/requirements-nautilus-linux-py312.lock):
  python research/backtests/options-forms/run_intraday.py --data <data dir> --ib <5-minute bars dir> \
      --spy-1min <1-minute csv> --prior <results.json of run.py> --capital <account value, rounded> \
      --out <report work dir>/intraday.json
Diagnostics (not the study model), as in run.py: `--cost-scale 0` and `--chain <chain summary>`, each with
the --prior of the daily run under the same model.

Method: research/backtests/options-forms/README.md, section "Intraday forms".
"""
from __future__ import annotations

import argparse
import dataclasses
import importlib.util
import json
import sys
from datetime import date
from pathlib import Path
from statistics import mean, median, variance

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))


def _daily_study():
    """run.py of this directory as a module: the daily study, whose model switches and statistics this one uses."""
    spec = importlib.util.spec_from_file_location("options_forms_daily", Path(__file__).with_name("run.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


daily = _daily_study()

from strategies import noise_band_retest as five_minute  # noqa: E402
from strategies import noise_band_run as one_minute  # noqa: E402
from strategies.qc_ports import forms as fm  # noqa: E402
from strategies.qc_ports import forms_intraday as fi  # noqa: E402
from strategies.qc_ports import intraday as it  # noqa: E402
from strategies.qc_ports.data import IV_INDEX, load_series  # noqa: E402
from strategies.qc_ports.ledger import run_ledger  # noqa: E402

al, base, study = daily.al, daily.base, daily.study
# Start delay of the second phase of a baseline, in trading days (run.py: BASELINE_DELAYS, there in daily bars).
PHASE_DAYS = daily.BASELINE_DELAYS


def load_sessions(ib: Path, spy_1min: Path, last_day: date, log) -> tuple[dict, dict]:
    """(source -> symbol -> sessions up to `last_day`, the same keys -> what the files cover).

    SPY 5-minute bars: the 1-minute file in 5-minute bars before the first day of the 5-minute files, then
    those files (noise_band_retest.splice, as the noise-band re-test reads SPY).
    """
    minutes, minute_facts = one_minute.load_sessions(str(spy_1min), "ibkr-mt", {})
    log(f"SPY 1-minute bars: {minute_facts['sessions_used']} sessions")
    fives, facts = {}, {fi.ONE_MINUTE: {"SPY": minute_facts}, fi.FIVE_MINUTE: {}}
    for symbol in fi.ETF3:
        fives[symbol], facts[fi.FIVE_MINUTE][symbol] = five_minute.load_ib_sessions(str(ib / symbol))
        log(f"{symbol} 5-minute bars: {facts[fi.FIVE_MINUTE][symbol]['sessions_used']} sessions")
    fives["SPY"] = five_minute.splice(five_minute.to_five_minute(minutes), fives["SPY"])
    sessions = {fi.ONE_MINUTE: {"SPY": minutes}, fi.FIVE_MINUTE: fives}
    cut = {source: {symbol: [session for session in found if session.day <= last_day]
                    for symbol, found in by_symbol.items()} for source, by_symbol in sessions.items()}
    cover = {}
    for source, by_symbol in cut.items():
        for symbol, found in by_symbol.items():
            loaded = facts[source][symbol]
            missing = it.missing_expiries(session.day for session in found)
            if missing:
                raise SystemExit(f"{source} {symbol}: no session on the expiry days "
                                 f"{', '.join(day.isoformat() for day in missing)}")
            cover.setdefault(source, {})[symbol] = {
                "first": found[0].day.isoformat(), "last": found[-1].day.isoformat(), "sessions": len(found),
                "sessionsDroppedIncomplete": len(loaded["sessions_dropped_incomplete"]),
                "barsForwardFilled": loaded.get("forward_filled_bars", 0)}
    return cut, cover


def prior_trials(path: Path, cost_scale: float, chain: Path | None) -> dict:
    """The trials of the daily study under the same option model: {count, variance, sharpes}.

    `sharpes` (per-day Sharpe by trial key) is None for a daily result written before run.py stored them
    (the three results of 2026-11-11). The across-trial variance is then the daily study's. Those results do
    not record `only` either: an older --only run passes this check, so pass whole runs only.
    """
    document = json.loads(path.read_text())
    if "ivRule" in document:
        raise SystemExit(f"{path} is an intraday result: --prior takes the result of run.py")
    if document.get("only"):
        raise SystemExit(f"{path} is a run of some forms only (--only): its trial count is not the study's")
    if document["costScale"] != cost_scale or (document["measuredCore7"] is None) != (chain is None):
        raise SystemExit(f"{path} is a daily run under another option model (cost scale, measured chain)")
    trials = document["trials"]
    sharpes = trials.get("dailySharpes")
    if sharpes is not None and len(sharpes) != trials["count"]:
        raise SystemExit(f"{path}: {len(sharpes)} trial values for {trials['count']} trials")
    return {"count": trials["count"], "variance": trials["dailySharpeVariance"], "sharpes": sharpes}


def cost_facts(result, priced, capital: float) -> dict:
    """What the option costs take, as shares of the capital: the costs of all trades (commissions and half
    spreads) and their P&L before costs. And the bars a spread is held (median over the priced trades)."""
    fees = sum(trade["entryFee"] + trade["exitFee"] for trade in result.trades)
    net = sum(trade["pnl"] for trade in result.trades)
    return {"feesOverCapital": fees / capital, "pnlBeforeFeesOverCapital": (net + fees) / capital,
            "medianHoldBars": median(trade.exit_index - trade.entry_index for trade in priced)}


def markdown(rows: list[dict]) -> str:
    lines = [("| Form | Bars | Underlyings | Sharpe | Out-of-sample | Deflated Sharpe | MC P(profit) | Max drawdown | CAGR "
              "| Trades | Median hold | P&L before costs | Costs | Baseline Sharpe | Gate checks failed | Lower bar |"),
             "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"]

    def rank(row: dict) -> float:
        value = (row["stats"] or {}).get("sharpe")
        return -9.0 if value is None else value

    for row in sorted(rows, key=rank, reverse=True):
        stats = row["stats"]
        head = f"| `{row['key']}` | {row['minutes']} min | {' '.join(row['symbols'])} "
        if stats is None or stats["sharpe"] is None:
            lines.append(f"{head}| no trade | | | | | | 0 | | | | | | |")
            continue
        carlo = stats["monteCarlo"] or {}
        failed = sum(1 for check in row["checks"] if not check["pass"])
        baseline = "none" if row["baselineSharpe"] is None else daily.signed(row["baselineSharpe"])
        lines.append(
            f"{head}| {daily.signed(stats['sharpe'])} | {daily.signed(stats['oosSharpe'])} "
            f"| {daily.signed(stats['deflatedSharpe']).lstrip('+')} "
            f"| {daily.percent(carlo.get('probabilityOfProfit'), 0).lstrip('+')} | {daily.percent(stats['maxDrawdown'])} "
            f"| {daily.percent(stats['cagr'])} | {stats['trades']} | {stats['medianHoldBars']:g} bars "
            f"| {daily.percent(stats['pnlBeforeFeesOverCapital'], 0)} | {daily.percent(stats['feesOverCapital'], 0)} "
            f"| {baseline} | {failed} of {len(row['checks'])} | {'pass' if row['passesLowerBar'] else 'fail'} |")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path, help="daily data directory (IV indices, IRX)")
    parser.add_argument("--ib", required=True, type=Path, help="directory with <SYMBOL>/*.csv 5-minute bars")
    parser.add_argument("--spy-1min", required=True, type=Path, help="SPY 1-minute bars (2008 to 2021)")
    parser.add_argument("--prior", required=True, type=Path, help="results.json of run.py under the same option model")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--capital", type=float, required=True, help="account value for sizing (rounded)")
    parser.add_argument("--cost-scale", type=float, default=1.0,
                        help="diagnostic: multiply every half spread (1 = the study model, 0 = commissions only)")
    parser.add_argument("--chain", type=Path, default=None,
                        help="diagnostic: the chain snapshot summary of the allocation study (measured Core 7 model)")
    parser.add_argument("--only", default=None, help="comma-separated form keys (a partial run; trial counts differ)")
    args = parser.parse_args()
    log = lambda text: print(text, file=sys.stderr, flush=True)  # noqa: E731

    if args.chain is not None:
        daily.sensitivity.apply_model(daily.sensitivity.SCENARIOS["calibrated"], str(args.chain))
    if args.cost_scale != 1.0:
        daily.scale_spread_costs(args.cost_scale)
    prior = prior_trials(args.prior, args.cost_scale, args.chain)
    trials: dict[str, float] = {}

    forms = fi.study_forms()
    if args.only:
        wanted = set(args.only.split(","))
        unknown = sorted(wanted - {item.form.key for item in forms})
        if unknown:
            raise SystemExit(f"Unknown form keys: {unknown}")
        wanted |= {item.form.baseline for item in forms if item.form.key in wanted and item.form.baseline}
        forms = tuple(item for item in forms if item.form.key in wanted)

    series = {name: load_series(name, args.data) for name in sorted({IV_INDEX[symbol] for symbol in fi.ETF3} | {"IRX"})}
    last_day = min(max(values) for values in series.values())
    sessions, cover = load_sessions(args.ib, args.spy_1min, date.fromisoformat(last_day), log)
    bars_cache: dict[tuple, object] = {}
    market_cache: dict[tuple, object] = {}

    def bars_of(source: str, symbol: str, minutes: int):
        key = (source, symbol, minutes)
        if key not in bars_cache:
            bars_cache[key] = it.session_bars(symbol, sessions[source][symbol], fi.SOURCE_MINUTES[source], minutes)
        return bars_cache[key]

    def market_of(source: str, symbol: str, minutes: int):
        key = (source, symbol, minutes)
        if key not in market_cache:
            market_cache[key] = it.intraday_market(bars_of(*key), series[IV_INDEX[symbol]], series["IRX"])
        return market_cache[key]

    done: dict[str, dict] = {}
    for item in forms:
        form = item.form
        bars = {symbol: bars_of(item.source, symbol, item.minutes) for symbol in form.symbols}
        markets = {symbol: market_of(item.source, symbol, item.minutes) for symbol in form.symbols}
        inputs = fm.Inputs(bars, {symbol: markets[symbol].iv_index for symbol in form.symbols})
        window = fm.WINDOW_BARS * it.bars_per_day(item.minutes)
        book = fm.form_book(form, inputs, markets, start=daily.START, window_bars=window, trim=True)
        first = min(daily.first_iv_day(markets[symbol]) for symbol in form.symbols)
        keys = sorted({key for symbol in form.symbols for key in bars[symbol].dates if key >= first})
        run = {"priced": book.trades, "refused": book.refused, "result": None, "daily": None, "gap": None,
               "keys": keys, "phases": None, "engine": None}
        done[form.key] = run
        if not book.trades:
            log(f"form {form.key}: no trade")
            continue
        run["result"], run["gap"], run["engine"] = base.nautilus_run(book.trades, args.capital, keys)
        run["daily"] = it.daily_result(run["result"])
        trials[f"form:{form.key}"] = study.daily_sharpe(run["daily"])
        if form.rule is fm.always_on:
            # The same basket started later: the baseline Sharpe of check G7 is the mean over the phases.
            run["phases"] = [al.sharpe(al.daily_returns(run["daily"].equity))]
            for days in PHASE_DAYS[1:]:
                delayed = dataclasses.replace(form, rule=fm.always_on_after(days * it.bars_per_day(item.minutes)))
                later = fm.form_trades(delayed, inputs, markets, start=daily.START, window_bars=window, trim=True)
                shifted = it.daily_result(run_ledger(later, args.capital, dates=keys))
                run["phases"].append(al.sharpe(al.daily_returns(shifted.equity)))
        log(f"form {form.key} trades {len(run['result'].trades)} of {len(book.trades)} priced, gap {run['gap']:.2g}")

    traded = [run for run in done.values() if run["result"] is not None]
    if not traded:
        raise SystemExit("No form traded")
    n_trials = prior["count"] + len(trials)
    # Exact when the daily result holds its trial values. Else the variance of the daily trials alone:
    # runs far from them (a form that loses on every trade) would raise it and lower every deflated Sharpe.
    exact = prior["sharpes"] is not None
    trial_variance = variance([*prior["sharpes"].values(), *trials.values()]) if exact else prior["variance"]
    baseline_sharpe = {key: mean(run["phases"]) for key, run in done.items() if run["phases"]}
    rows = []
    for item in forms:
        form, run = item.form, done[item.form.key]
        row = {"key": form.key, "slug": form.slug, "name": form.name, "sleeve": form.sleeve,
               "symbols": list(form.symbols), "minutes": item.minutes, "source": item.source, "keeps": form.keeps,
               "baselineKey": form.baseline, "start": it.day_of(run["keys"][0]) if run["keys"] else None,
               "bars": len(run["keys"]), "pricedTrades": len(run["priced"]), "nautilusGap": run["gap"], "stats": None,
               "checks": [], "baselineSharpe": None, "baselinePhaseSharpes": run["phases"], "passesGate": False,
               "passesLowerBar": False, "refusedBars": run["refused"]}
        if run["result"] is not None:
            stats = base.run_stats(run["daily"], run["priced"], args.capital, n_trials, trial_variance)
            # At the close of a bar, not of a day: a spread that opens and closes inside one day counts.
            stats["maxOpenRisk"] = it.max_open_risk(run["result"], run["priced"])
            stats.update(cost_facts(run["result"], run["priced"], args.capital))
            if form.baseline and form.baseline not in baseline_sharpe:
                raise SystemExit(f"{form.key}: its baseline {form.baseline} did not trade")
            baseline = baseline_sharpe[form.baseline] if form.baseline else None
            checks = al.gate_checks(stats, baseline)
            row.update(stats=stats, checks=checks, baselineSharpe=baseline,
                       passesGate=all(check["pass"] for check in checks), passesLowerBar=daily.lower_bar(stats))
        rows.append(row)

    strategies = [row for row in rows if not row["key"].startswith("base/")]
    document = {
        "generatedFor": last_day, "engine": traded[0]["engine"], "gate": al.GATE,
        "lowerBar": daily.funded_pie.LOWER_BAR, "start": daily.START, "costScale": args.cost_scale,
        "measuredCore7": daily.sensitivity.measured_model(str(args.chain)) if args.chain is not None else None,
        "baselinePhaseDays": list(PHASE_DAYS),
        "trials": {"count": n_trials, "prior": prior["count"], "forms": len(trials),
                   "dailySharpeVariance": trial_variance, "varianceIncludesIntradayRuns": exact,
                   "dailySharpes": dict(sorted(trials.items()))},
        "ivRule": "last bar of a day: the index value of that day; earlier bars: the last value before that day",
        "bars": cover,
        "forms": strategies, "baselines": [row for row in rows if row["key"].startswith("base/")],
        "passGate": [row["key"] for row in strategies if row["passesGate"]],
        "passLowerBar": [row["key"] for row in strategies if row["passesLowerBar"]],
    }
    table = markdown(rows)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=1))
    args.out.with_suffix(".md").write_text(table)
    log(f"wrote {args.out}: {len(document['passGate'])} pass the gate, {len(document['passLowerBar'])} pass the "
        f"lower bar, {n_trials} trials")


if __name__ == "__main__":
    main()
