"""Triple RSI study: runs every job of services/research/strategies/triple_rsi/study.py (research only).

Places no orders and writes nothing to Postgres. Reads the daily data of the options-forms fetch (one flat
directory with the Core 7 ETFs, their IV indices and IRX) and writes to --out (a report work directory outside
the repository): `results.json` (the full results document), `study.json` (the research_studies document, kind
"strategy-backtest") and `index.html` (the dark report).

Run (rig, in the venv with services/research/requirements-nautilus-linux-py312.lock):
  python research/backtests/triple-rsi/run.py --data ~/Documents/reports/vertex-options-forms/data \
      --out ~/Documents/reports/web/vertex-triple-rsi --workers 8
Store the study document (after review):
  DATABASE_URL=postgres://... bun run vertex:research-studies:import < <out>/study.json

Method and pass/fail rule: docs/specs/strategies/triple-rsi.md.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))
sys.path.insert(0, str(ROOT / "research" / "backtests" / "allocation"))

from strategies.triple_rsi import document, report, rules, study  # noqa: E402


def _lower_bar_matches() -> None:
    """The lower bar of metrics.py must be the owner's (funded_pie.LOWER_BAR)."""
    import funded_pie  # noqa: PLC0415 (research/backtests/allocation/funded_pie.py)

    from strategies.triple_rsi import metrics  # noqa: PLC0415

    if funded_pie.LOWER_BAR != metrics.LOWER_BAR:
        raise SystemExit("metrics.LOWER_BAR differs from funded_pie.LOWER_BAR")


def write_outputs(out: Path, results: dict) -> None:
    doc = document.study_document(results)
    (out / "study.json").write_text(json.dumps(doc, indent=1, allow_nan=False) + "\n")
    (out / "index.html").write_text(report.render(results, doc))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--render-only", action="store_true",
                        help="rebuild study.json and index.html from <out>/results.json without running")
    args = parser.parse_args()
    log = lambda text: print(f"{datetime.now(UTC):%H:%M:%SZ} {text}", file=sys.stderr, flush=True)  # noqa: E731
    _lower_bar_matches()
    root = str(args.data.expanduser())
    out = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    if args.render_only:
        results = json.loads((out / "results.json").read_text())
        write_outputs(out, results)
        log(f"rendered {out}")
        return
    started = time.time()
    commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True,
                            check=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "services/research/strategies",
                            "research/backtests/triple-rsi"], capture_output=True, text=True, check=True).stdout.strip()
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        share_jobs = [pool.submit(study.share_job, root, symbol, rules.STATED, execution, cost)
                      for symbol in study.SYMBOLS for execution in rules.EXECUTIONS for cost in study.COSTS.values()]
        grid_jobs = [pool.submit(study.share_job, root, "SPY", params, "close", study.COSTS["base"])
                     for params in study.grid_params()]
        hold_jobs = [pool.submit(study.buy_hold_job, root, symbol) for symbol in study.SYMBOLS]
        option_jobs = [pool.submit(study.options_job, root, symbol, variant.key)
                       for symbol in study.SYMBOLS for variant in study.options_form.FORMS]
        option_jobs += [pool.submit(study.options_job, root, symbol, variant.key, delay)
                        for symbol in study.SYMBOLS for variant in study.options_form.FORMS
                        for delay in study.BASELINE_DELAYS]
        dsl_job = pool.submit(study.dsl_job, root, "SPY")
        share_runs = [job.result() for job in share_jobs]
        log(f"share runs {len(share_runs)}")
        grid_runs = [job.result() for job in grid_jobs]
        log(f"grid runs {len(grid_runs)}")
        buy_holds = [job.result() for job in hold_jobs]
        options_runs = [job.result() for job in option_jobs]
        log(f"options runs {len(options_runs)}")
        dsl_run = dsl_job.result()
    if not dsl_run["sameTrades"]:
        raise SystemExit("The DSL engine and the rule disagree on the SPY trades")
    results = study.assemble(share_runs, grid_runs, options_runs, buy_holds, dsl_run)
    results["provenance"] = {"commit": commit, "dirtyFiles": dirty.splitlines(), "dataRoot": root,
                             "dataFiles": study.data_files(root), "ran": datetime.now(UTC).date().isoformat(),
                             "seconds": round(time.time() - started, 1), "workers": args.workers}
    (out / "results.json").write_text(json.dumps(results, indent=1, allow_nan=False) + "\n")
    write_outputs(out, results)
    decision = results["decision"]
    log(f"done in {time.time() - started:.0f}s: gate {decision['passesGate']}, lower bar {decision['passesLowerBar']}, "
        f"90% win rate reproduces {decision['winRateReproduces']}; wrote {out}")


if __name__ == "__main__":
    main()
