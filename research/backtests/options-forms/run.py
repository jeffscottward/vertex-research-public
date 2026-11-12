"""Options forms study: runs the options form of every library strategy that had none (research only).

Places no orders and writes nothing to Postgres. Reads the public daily data of the qc-ports fetch
and of research/backtests/options-forms/fetch_data.py (one flat directory) and writes one JSON
document to --out and a results table next to it (a report work directory outside the repository;
the app never reads it).

Run (rig, in the venv with services/research/requirements-nautilus-linux-py312.lock):
  python research/backtests/options-forms/run.py --data <data dir> --capital <account value, rounded> \
      --out <report work dir>/results.json
Diagnostics (not the study model): `--cost-scale 0` (commissions only) and `--chain <chain summary>` (the
option model the allocation study measured for the Core 7 in a chain snapshot).

Method: research/backtests/options-forms/README.md.
"""
from __future__ import annotations

import argparse
import csv
import dataclasses
import hashlib
import json
import sys
from pathlib import Path
from statistics import mean, median, variance

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))
sys.path.insert(0, str(ROOT / "research" / "backtests" / "freestockalerts"))
sys.path.insert(0, str(ROOT / "research" / "backtests" / "allocation"))

import funded_pie  # noqa: E402  (research/backtests/allocation/funded_pie.py: the owner's lower bar)
import sensitivity  # noqa: E402  (research/backtests/allocation/sensitivity.py: the measured option model)
import universe  # noqa: E402  (research/backtests/freestockalerts/universe.py)
from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports import forms as fm  # noqa: E402
from strategies.qc_ports import forms_library as fl  # noqa: E402
from strategies.qc_ports import ideas as qi  # noqa: E402
from strategies.qc_ports import options as om  # noqa: E402
from strategies.qc_ports import portfolio as pf  # noqa: E402
from strategies.qc_ports import study  # noqa: E402
from strategies.qc_ports.book import CALENDARS  # noqa: E402
from strategies.qc_ports.data import IV_INDEX, IV_TERM, load_bars, load_series  # noqa: E402
from strategies.qc_ports.ledger import run_ledger  # noqa: E402

START = "1993-01-29"
FORMS_SUMS = "FORMS_SHA256SUMS"
# Start delays in bars of the always-on baseline. Its spreads follow each other on the monthly expiries, so
# the first entry day sets every later one and there are two chains, about a month apart. The baseline Sharpe
# of check G7 is the mean over the two (the later one in the ledger only).
BASELINE_DELAYS = (0, 21)
# research/backtests/allocation/run.py as the allocation scripts import it: its statistics and its parity run.
base = sensitivity.base


def prior_trials(data: study.StudyData, capital: float, library: Path, log) -> dict[str, float]:
    """Per-day Sharpe of the options-form runs the allocation study counted (its steps 1 and 2).

    The reference ledger only: the allocation study checked these runs against NautilusTrader.
    """
    outcomes, _metrics, _variance = study.run_family(data, nautilus=False, progress=lambda key: log(f"prior family {key}"))
    trials = {f"family:{key}": study.daily_sharpe(outcome.result) for key, outcome in outcomes.items() if outcome.run.counted}
    runs = qi.family(data.facts)
    candidates = al.qc_candidates(runs) + base.qj_candidates(library)
    todo = {item["key"]: (item["definition"], item["start"]) for item in candidates}
    for item in candidates:
        if item["baseline"] and item["baseline"] not in todo:
            todo[item["baseline"]] = (runs[item["baseline"]].definition, runs[item["baseline"]].start)
    for key, (made, first) in todo.items():
        priced = al.owner_rule_trades(made, data.dataset, start=first)
        result = run_ledger(priced, capital, dates=[day for day in data.dataset.calendar if day >= first])
        trials[f"owner:{key}"] = study.daily_sharpe(result)
        log(f"prior owner-rule {key}")
    return trials


def proxy_check(dataset: pf.Dataset) -> dict[str, dict]:
    """The proxy IV index against the Cboe index of the Core 7 symbols that have one (SPY is the reference)."""
    out = {}
    for symbol in qi.CORE7:
        if symbol == pf.CALENDAR_SYMBOL:
            continue
        proxy = fm.proxy_iv_index(dataset.bars[symbol], dataset.bars[pf.CALENDAR_SYMBOL], dataset.series["VIX"])
        actual = dataset.series[IV_INDEX[symbol]]
        ratios = [proxy[day] / actual[day] for day in proxy if actual.get(day)]
        out[symbol] = {"index": IV_INDEX[symbol], "days": len(ratios), "medianRatio": median(ratios),
                       "meanAbsError": sum(abs(ratio - 1) for ratio in ratios) / len(ratios)}
    return out


def load_extra(root: Path, symbols, *, required: bool, log) -> dict:
    bars = {}
    for symbol in symbols:
        if (root / f"{symbol}.csv").exists():
            bars[symbol] = load_bars(symbol, root)
        elif required:
            raise SystemExit(f"{symbol}.csv is missing in {root}: run research/backtests/options-forms/fetch_data.py")
        else:
            log(f"no data for {symbol}: left out")
    return bars


def load_splits(root: Path, symbol: str) -> dict[str, float]:
    """Effective date -> ratio of every split of `symbol` (`<SYMBOL>.splits.csv` of the options-forms fetch)."""
    path = root / f"{symbol}.splits.csv"
    if not path.exists():
        raise SystemExit(f"{path.name} is missing in {root}: run research/backtests/options-forms/fetch_data.py")
    with path.open(newline="") as handle:
        return {row["date"]: float(row["ratio"]) for row in csv.DictReader(handle)}


def scale_spread_costs(scale: float) -> None:
    """A cost scenario (diagnostic, not the study model): every Core 7 half spread times `scale`.

    At 0 the one-cent floor of the half spread goes too, so only the commission is left.
    """
    for symbol in om.HALF_SPREAD_PCT:
        om.HALF_SPREAD_PCT[symbol] *= scale
    if scale == 0:
        om.MIN_HALF_SPREAD = 0.0


def first_iv_day(market, blocks) -> str:
    """The first date the book can price `blocks` on (forms.first_priced: the IV index, and the IV term for a
    calendar), a date after every bar when there is none."""
    first = fm.first_priced(market, blocks)
    return market.dates[first] if first < len(market.dates) else "9999-12-31"


def lower_bar(stats: dict) -> bool:
    """The lower bar the owner picked on 2026-11-11 (funded_pie.LOWER_BAR); a run without a contract fails it."""
    return stats["sharpe"] is not None and funded_pie.lower_bar(stats)


def percent(value, digits=1) -> str:
    return "n/a" if value is None else f"{value * 100:+.{digits}f}%"


def signed(value) -> str:
    return "n/a" if value is None else f"{value:+.2f}"


def markdown(rows: list[dict]) -> str:
    lines = [("| Form | Universe | Sharpe | Out-of-sample | Deflated Sharpe | MC P(profit) | Max drawdown | CAGR | Trades "
              "| Baseline Sharpe | Gate checks failed | Lower bar |"),
             "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"]
    def rank(row: dict) -> float:
        value = (row["stats"] or {}).get("sharpe")
        return -9.0 if value is None else value

    for row in sorted(rows, key=rank, reverse=True):
        stats = row["stats"]
        name = f"`{row['key']}`" + (f" (= `{row['duplicateOf']}`)" if row["duplicateOf"] else "")
        where = f"{len(row['symbols'])} symbols, {row['iv']} IV"
        if stats is None or stats["sharpe"] is None:
            lines.append(f"| {name} | {where} | no trade | | | | | | 0 | | | |")
            continue
        carlo = stats["monteCarlo"] or {}
        failed = sum(1 for check in row["checks"] if not check["pass"])
        baseline = "none" if row["baselineSharpe"] is None else signed(row["baselineSharpe"])
        lines.append(
            f"| {name} | {where} | {signed(stats['sharpe'])} | {signed(stats['oosSharpe'])} "
            f"| {signed(stats['deflatedSharpe']).lstrip('+')} "
            f"| {percent(carlo.get('probabilityOfProfit'), 0).lstrip('+')} | {percent(stats['maxDrawdown'])} "
            f"| {percent(stats['cagr'])} | {stats['trades']} | {baseline} | {failed} of {len(row['checks'])} "
            f"| {'pass' if row['passesLowerBar'] else 'fail'} |")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--capital", type=float, required=True, help="account value for sizing (rounded)")
    parser.add_argument("--library", type=Path, default=ROOT / "research/backtests/quantjourney/library.json")
    parser.add_argument("--cost-scale", type=float, default=1.0,
                        help="diagnostic: multiply every half spread (1 = the study model, 0 = commissions only)")
    parser.add_argument("--chain", type=Path, default=None,
                        help="diagnostic: the chain snapshot summary of the allocation study; the Core 7 then use "
                             "its measured half spreads and skew, the other underlyings keep their class model")
    parser.add_argument("--only", default=None, help="comma-separated form keys (a partial run; trial counts differ)")
    args = parser.parse_args()
    log = lambda text: print(text, file=sys.stderr, flush=True)  # noqa: E731
    if args.chain is not None:
        sensitivity.apply_model(sensitivity.SCENARIOS["calibrated"], str(args.chain))
    if args.cost_scale != 1.0:
        scale_spread_costs(args.cost_scale)

    data = study.load_study_data(args.data)
    dataset = data.dataset
    stocks = load_extra(args.data, universe.SP100, required=False, log=log)
    if not stocks:
        raise SystemExit(f"No stock file in {args.data}: run research/backtests/options-forms/fetch_data.py")
    forms = fl.study_forms(tuple(stocks))
    if args.only:
        wanted = set(args.only.split(","))
        unknown = sorted(wanted - {form.key for form in forms})
        if unknown:
            raise SystemExit(f"Unknown form keys: {unknown}")
        wanted |= {form.baseline for form in forms if form.key in wanted and form.baseline}
        forms = tuple(form for form in forms if form.key in wanted)
    # Baselines first: a form with the trades of its baseline is then marked as a copy of the baseline.
    forms = (*(form for form in forms if form.rule is fm.always_on), *(form for form in forms if form.rule is not fm.always_on))
    # The IV term indices the qc-ports data set does not hold (VIX6M) come from fetch_data.py of this study. Only a
    # run with a calendar form needs them; a run of verticals alone reads the directory as before.
    if any(block["structure"] in CALENDARS for form in forms for side in form.structures.values() for block in side):
        term_ids = sorted({index_id for term in IV_TERM.values() for index_id in term} - set(dataset.series))
        missing = [index_id for index_id in term_ids if not (args.data / f"{index_id}.csv").is_file()]
        if missing:
            raise SystemExit(f"No {', '.join(missing)} in {args.data}: run research/backtests/options-forms/fetch_data.py")
        dataset = dataclasses.replace(dataset, series={**dataset.series, **{
            index_id: load_series(index_id, args.data) for index_id in term_ids}})
    traded = {symbol for form in forms for symbol in form.symbols}
    loaded = {**load_extra(args.data, sorted(traded - set(qi.CORE7) - set(stocks)), required=True, log=log),
              **{symbol: bars for symbol, bars in stocks.items() if symbol in traded}}
    # The Core 7 stay on split-adjusted closes, as in the qc study; every other underlying is priced at raw prices.
    extra, factors, events = {}, {}, {}
    for symbol, bars in loaded.items():
        extra[symbol], factors[symbol], events[symbol] = fm.raw_priced(bars, load_splits(args.data, symbol))
    models = {**dict.fromkeys(stocks, fm.LIQUID_EQUITY), **fm.PROXY_MODELS}
    models = {symbol: dataclasses.replace(models[symbol], half_spread_pct=models[symbol].half_spread_pct * args.cost_scale)
              for symbol in extra}
    yields = {symbol: fm.dividend_yield(bars) for symbol, bars in extra.items()}
    reference = dataset.bars[pf.CALENDAR_SYMBOL]

    trials = prior_trials(data, args.capital, args.library, log)
    done: dict[str, dict] = {}
    with fm.proxy_symbols(models, yields):
        markets = {symbol: pf.market_of(dataset, symbol) for symbol in qi.CORE7}
        for symbol, bars in extra.items():
            index = fm.proxy_iv_index(bars, reference, dataset.series["VIX"])
            markets[symbol] = fm.proxy_market(bars, index, dataset.series["IRX"])
        bars_of = {**{symbol: dataset.bars[symbol] for symbol in qi.CORE7}, **extra}
        for form in forms:
            inputs = fm.Inputs({symbol: bars_of[symbol] for symbol in form.symbols},
                               {symbol: markets[symbol].iv_index for symbol in form.symbols})
            book = fm.form_book(form, inputs, markets, start=START, factors=factors)
            blocks = [block for side in form.structures.values() for block in side]
            first = min(first_iv_day(markets[symbol], blocks) for symbol in form.symbols)
            dates = [day for day in dataset.calendar if day >= max(first, START)]
            run = {"priced": book.trades, "refused": book.refused, "result": None, "gap": None, "dates": dates,
                   "alwaysOn": fm.is_always_on(fm.stance_of(form, inputs), form.symbols), "phases": None}
            done[form.key] = run
            if not book.trades:
                log(f"form {form.key}: no trade")
                continue
            run["result"], run["gap"], run["engine"] = base.nautilus_run(book.trades, args.capital, dates)
            trials[f"form:{form.key}"] = study.daily_sharpe(run["result"])
            if form.rule is fm.always_on:
                # The same basket started later: the baseline Sharpe of check G7 is the mean over the phases.
                run["phases"] = [al.sharpe(al.daily_returns(run["result"].equity))]
                for delay in BASELINE_DELAYS[1:]:
                    later = fm.form_trades(dataclasses.replace(form, rule=fm.always_on_after(delay)), inputs, markets,
                                           start=START, factors=factors)
                    shifted = run_ledger(later, args.capital, dates=dates)
                    run["phases"].append(al.sharpe(al.daily_returns(shifted.equity)))
            log(f"form {form.key} trades {len(run['result'].trades)} gap {run['gap']:.2g}")

    traded_runs = [run for run in done.values() if run["result"] is not None]
    if not traded_runs:
        raise SystemExit("No form traded")
    n_trials = len(trials)
    trial_variance = variance(trials.values())
    baseline_sharpe = {key: mean(run["phases"]) for key, run in done.items() if run["phases"]}
    rows, seen = [], {}
    for form in forms:
        run = done[form.key]
        proxies = sorted(symbol for symbol in form.symbols if symbol in extra)
        row = {"key": form.key, "slug": form.slug, "name": form.name, "sleeve": form.sleeve, "symbols": list(form.symbols),
               "keeps": form.keeps, "baselineKey": form.baseline, "proxySymbols": proxies,
               "iv": "index" if not proxies else ("proxy" if len(proxies) == len(form.symbols) else "index and proxy"),
               "start": run["dates"][0] if run["dates"] else None, "nautilusGap": run["gap"], "stats": None, "checks": [],
               "baselineSharpe": None, "baselinePhaseSharpes": run["phases"], "passesGate": False, "passesLowerBar": False,
               "duplicateOf": None, "refusedBars": run["refused"]}
        if run["result"] is not None:
            stats = base.run_stats(run["result"], run["priced"], args.capital, n_trials, trial_variance)
            if form.baseline and form.baseline not in baseline_sharpe:
                raise SystemExit(f"{form.key}: its baseline {form.baseline} did not trade")
            baseline = baseline_sharpe[form.baseline] if form.baseline else None
            checks = al.gate_checks(stats, baseline)
            mark = (run["dates"][0], tuple(run["result"].equity))
            copy_of = seen.get(mark) or (form.baseline if run["alwaysOn"] and form.baseline else None)
            row.update(stats=stats, checks=checks, baselineSharpe=baseline, duplicateOf=copy_of,
                       passesGate=all(check["pass"] for check in checks), passesLowerBar=lower_bar(stats))
            seen.setdefault(mark, form.key)
        rows.append(row)

    strategies = [row for row in rows if not row["key"].startswith("base/")]
    sums = args.data / FORMS_SUMS
    document = {
        "generatedFor": dataset.calendar[-1], "engine": traded_runs[0]["engine"],
        "nautilusTrader": study.provenance("", data, True, "")["engine"], "dataSha256": data.manifest,
        "formsDataSha256": hashlib.sha256(sums.read_bytes()).hexdigest() if sums.exists() else None,
        "gate": al.GATE, "lowerBar": funded_pie.LOWER_BAR, "start": START, "costScale": args.cost_scale,
        "measuredCore7": sensitivity.measured_model(str(args.chain)) if args.chain is not None else None,
        "baselineDelays": list(BASELINE_DELAYS),
        "trials": {"count": n_trials, "prior": sum(1 for key in trials if not key.startswith("form:")),
                   "forms": sum(1 for key in trials if key.startswith("form:")), "dailySharpeVariance": trial_variance},
        "proxy": {"window": fm.RV_WINDOW, "premium": fm.RV_PREMIUM, "ratioRange": fm.RATIO_RANGE,
                  "atmFactor": fm.PROXY_ATM_FACTOR, "check": proxy_check(dataset),
                  "models": {symbol: {"halfSpreadPct": model.half_spread_pct, "skew": model.skew,
                                      "dividendYield": yields[symbol]} for symbol, model in sorted(models.items())}},
        "splitSymbols": sorted(symbol for symbol, values in factors.items() if values and values[0] != 1.0),
        "distributions": {symbol: found for symbol, found in sorted(events.items()) if found},
        "leaders": sorted(stocks), "leadersMissing": sorted(set(universe.SP100) - set(stocks)),
        "forms": strategies, "baselines": [row for row in rows if row["key"].startswith("base/")],
        "notRun": [{"slug": item.slug, "reason": item.reason} for item in fl.NOT_RUN],
        "passGate": [row["key"] for row in strategies if row["passesGate"] and not row["duplicateOf"]],
        "passLowerBar": [row["key"] for row in strategies if row["passesLowerBar"] and not row["duplicateOf"]],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=1))
    args.out.with_suffix(".md").write_text(markdown(rows))
    log(f"wrote {args.out}: {len(document['passGate'])} pass the gate, {len(document['passLowerBar'])} pass the "
        f"lower bar, {n_trials} trials")


if __name__ == "__main__":
    main()
