"""Why does no candidate pass? Model and structure sensitivity of the allocation study (research only).

Runs every candidate of run.py again under changed model assumptions, on NautilusTrader with the
ledger parity check, and writes one JSON document to --out (a report work directory). Places no
orders and writes nothing to Postgres. The scenarios are diagnostics, not new evidence: a pass
here does not make a strategy eligible.

Scenarios (each changes only what its name says; the rest is the model of options.py):
- base: the study as it is.
- noCosts: no commission and no bid/ask spread.
- liquidCosts: half-spread per leg of 0.25% of the mid for SPY and QQQ, 0.5% for IWM and GLD,
  1% for DIA, 1.5% for SLV and USO (assumption for penny-wide monthly options; the study uses
  1% to 4%). Commission unchanged.
- flatCallSkew: half the skew slope for strikes above the spot where the slope is negative (the
  equity ETFs and USO; for SPY a call one standard deviation out of the money goes from 70% to
  85% of the at-the-money volatility). GLD and SLV are unchanged.
- realistic: liquidCosts and flatCallSkew together.
- realisticWideItm: realistic, and every debit vertical buys the 0.70-delta leg and is 2 standard
  deviations wide (the study buys 0.50 delta and caps the profit 1 standard deviation away).

- calibrated (with --chain): the half-spread and the skew measured in a one-day option-chain
  snapshot (fetch_chain_snapshot.py): per symbol the mean quoted half-spread of the at-the-money
  call, the one-sigma call and two out-of-the-money puts at the two monthly expiries, and one skew
  slope for strikes above the spot and one for strikes below. Quoted spreads, so a fill inside the
  spread would be cheaper. One day is not a history: spreads widen in stress.

Calibration rows: buy-and-hold SPY and QQQ (total return, no costs) through the same checks, to
see whether the gate would accept the plain index.

Run (rig, venv with the Nautilus lock):
  python research/backtests/allocation/sensitivity.py --data <qc-ports data dir> \
      --capital <account value, rounded> --trials 61 --trial-variance <dailySharpeVariance of run.py> \
      --chain <work dir>/chain/summary.json --out <report work dir>/sensitivity.json
"""
from __future__ import annotations

import argparse
import copy
import json
import multiprocessing
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "services" / "research"))

import run as base  # noqa: E402
from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports import ideas as qi  # noqa: E402
from strategies.qc_ports import options as om  # noqa: E402
from strategies.qc_ports import study  # noqa: E402
from strategies.qc_ports.ledger import LedgerResult  # noqa: E402
from strategies.qc_ports.metrics import summarize  # noqa: E402

LIQUID_HALF_SPREAD = {"SPY": 0.0025, "QQQ": 0.0025, "IWM": 0.005, "GLD": 0.005, "DIA": 0.01, "SLV": 0.015, "USO": 0.015}
CALL_WING_FACTOR = 0.5
WIDE_ITM = {"longDelta": 0.7, "widthSigma": 2.0}
SCENARIOS = {
    "base": {},
    "noCosts": {"costs": "none"},
    "liquidCosts": {"costs": "liquid"},
    "flatCallSkew": {"skew": "flatCalls"},
    "realistic": {"costs": "liquid", "skew": "flatCalls"},
    "realisticWideItm": {"costs": "liquid", "skew": "flatCalls", "structure": "wideItm"},
    "calibrated": {"costs": "measured"},
}
# Extra always-on runs per scenario: the long-only reference of the call-spread forms.
REFERENCES = ("asset-class-trend/B", "oil-predicts-equity/B")
STAT_KEYS = ("start", "end", "cagr", "sharpe", "oosSharpe", "deflatedSharpe", "maxDrawdown", "trades", "winRate", "monteCarlo")


class WingSlope(float):
    """A skew slope for strikes below the spot that also carries the slope for strikes above it."""

    call: float


def measured_model(chain_path: str) -> dict:
    """Half-spread (fraction of the mid) and wing slopes per symbol from a chain snapshot summary."""
    summary = json.loads(Path(chain_path).read_text())
    out = {"fetchedAt": summary["fetchedAt"], "source": summary["source"], "halfSpread": {}, "callSlope": {}, "putSlope": {}}
    for symbol, expiries in summary["symbols"].items():
        spreads = [value for item in expiries for value in item["halfSpreadPct"].values() if value is not None]
        calls = [item["callSlope"] for item in expiries if item["callSlope"] is not None]
        puts = [item["putSlope"] for item in expiries if item["putSlope"] is not None]
        if not (spreads and calls and puts):
            raise ValueError(f"The chain snapshot has no usable quotes for {symbol}")
        out["halfSpread"][symbol] = sum(spreads) / len(spreads) / 100
        out["callSlope"][symbol] = sum(calls) / len(calls)
        out["putSlope"][symbol] = sum(puts) / len(puts)
    return out


def apply_model(scenario: dict, chain_path: str | None = None) -> None:
    """Changes the option model of this process (options.py module state) for one scenario."""
    if scenario.get("costs") == "measured":
        model = measured_model(chain_path)
        om.HALF_SPREAD_PCT = dict(model["halfSpread"])
        skew = {}
        for symbol, put_slope in model["putSlope"].items():
            skew[symbol] = WingSlope(put_slope)
            skew[symbol].call = model["callSlope"][symbol]
        om.SKEW = skew
        original = om.smile_iv

        def wing_iv(atm: float, spot: float, strike: float, t: float, slope: float) -> float:
            return original(atm, spot, strike, t, float(getattr(slope, "call", slope) if strike > spot else slope))

        om.smile_iv = wing_iv
        return
    if scenario.get("costs") == "none":
        om.COMMISSION = 0.0
        om.MIN_HALF_SPREAD = 0.0
        om.HALF_SPREAD_PCT = dict.fromkeys(om.HALF_SPREAD_PCT, 0.0)
    elif scenario.get("costs") == "liquid":
        om.HALF_SPREAD_PCT = dict(LIQUID_HALF_SPREAD)
    if scenario.get("skew") == "flatCalls":
        original = om.smile_iv

        def smile_iv(atm: float, spot: float, strike: float, t: float, slope: float) -> float:
            flatter = slope * CALL_WING_FACTOR if strike > spot and slope < 0 else slope
            return original(atm, spot, strike, t, flatter)

        om.smile_iv = smile_iv


def restructure(definition: dict, scenario: dict) -> dict:
    """The definition with wider, in-the-money debit verticals when the scenario asks for them."""
    if scenario.get("structure") != "wideItm":
        return definition
    made = copy.deepcopy(dict(definition))
    blocks = [made, *((made.get("portfolio") or {}).get("legs") or ())]
    for block in blocks:
        options = block.get("options")
        if options and options["structure"].endswith("DebitVertical"):
            block["options"] = {**options, **WIDE_ITM}
    return made


def scenario_rows(name: str, data_dir: str, library: str, capital: float, trials: int, trial_variance: float,
                  chain_path: str | None) -> dict:
    scenario = SCENARIOS[name]
    apply_model(scenario, chain_path)
    data = study.load_study_data(data_dir)
    dataset = data.dataset
    runs = qi.family(data.facts)
    candidates = al.qc_candidates(runs) + base.qj_candidates(Path(library))
    items = [{"key": c["key"], "role": c["role"], "sleeve": c["sleeve"], "definition": c["definition"], "start": c["start"]}
             for c in candidates]
    items += [{"key": key, "role": "reference", "sleeve": "always on", "definition": runs[key].definition,
               "start": runs[key].start} for key in REFERENCES]
    rows = {}
    seen: dict[tuple, str] = {}
    for item in items:
        made = restructure(item["definition"], scenario)
        priced = al.owner_rule_trades(made, dataset, start=item["start"])
        dates = [day for day in dataset.calendar if day >= item["start"]]
        result, gap, _engine = base.nautilus_run(priced, capital, dates)
        stats = base.run_stats(result, priced, capital, trials, trial_variance)
        first = seen.setdefault(result.equity, item["key"])
        rows[item["key"]] = {"role": item["role"], "sleeve": item["sleeve"], "duplicateOf": None if first == item["key"] else first,
                             "nautilusGap": gap, **{key: stats[key] for key in STAT_KEYS},
                             "checks": al.gate_checks(stats, None)}
    return rows


def buy_and_hold(data: study.StudyData, symbol: str, trials: int, trial_variance: float) -> dict:
    """The plain index (adjusted close, no costs) through the checks that do not need trades."""
    bars = data.dataset.bars[symbol]
    equity = tuple(100_000.0 * value / bars.adj_close[0] for value in bars.adj_close)
    result = LedgerResult(tuple(bars.dates), equity, tuple([1] * len(equity)), (), (), capital=100_000.0)
    stats = summarize(result, n_trials=trials, sharpe_variance=trial_variance)
    out = {key: stats[key] for key in ("start", "end", "cagr", "sharpe", "deflatedSharpe", "maxDrawdown")}
    out["oosSharpe"] = al.out_of_sample_sharpe(result)[1]
    out["checks"] = [check for check in al.gate_checks({**out, "trades": None, "monteCarlo": None}, None)
                     if not check["check"].startswith(("G3", "G6"))]
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--capital", type=float, required=True)
    parser.add_argument("--trials", type=int, required=True, help="trial count of run.py (trials.count)")
    parser.add_argument("--trial-variance", type=float, required=True, help="trials.dailySharpeVariance of run.py")
    parser.add_argument("--library", type=Path, default=base.ROOT / "research/backtests/quantjourney/library.json")
    parser.add_argument("--workers", type=int, default=len(SCENARIOS))
    parser.add_argument("--chain", type=Path, default=None, help="summary.json of fetch_chain_snapshot.py (adds `calibrated`)")
    args = parser.parse_args()
    names = [name for name in SCENARIOS if name != "calibrated" or args.chain is not None]

    document = {"trials": args.trials, "trialVariance": args.trial_variance, "scenarios": {}, "assumptions": {
        "liquidHalfSpread": LIQUID_HALF_SPREAD, "studyHalfSpread": dict(om.HALF_SPREAD_PCT), "callWingFactor": CALL_WING_FACTOR,
        "wideItm": WIDE_ITM, "studySkew": dict(om.SKEW),
        "measured": measured_model(str(args.chain)) if args.chain is not None else None}}
    # One fresh process per scenario: each changes the option model of its own process only.
    with ProcessPoolExecutor(max_workers=args.workers, mp_context=multiprocessing.get_context("spawn"),
                             max_tasks_per_child=1) as pool:
        jobs = {name: pool.submit(scenario_rows, name, str(args.data), str(args.library), args.capital, args.trials,
                                  args.trial_variance, None if args.chain is None else str(args.chain)) for name in names}
        for name, job in jobs.items():
            document["scenarios"][name] = job.result()
            print(f"scenario {name} done", file=sys.stderr, flush=True)
    data = study.load_study_data(args.data)
    document["buyAndHold"] = {symbol: buy_and_hold(data, symbol, args.trials, args.trial_variance) for symbol in ("SPY", "QQQ")}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=1))
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
