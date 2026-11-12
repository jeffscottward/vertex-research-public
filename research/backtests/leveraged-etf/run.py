"""Leveraged ETF short-window study: options on a leveraged ETF against options on the unleveraged ETF.

Research only. Places no orders and writes nothing to Postgres. Reads the fund files of
research/backtests/leveraged-etf/fetch_data.py (--data), the qc-ports daily files, the IBKR 5-minute
bars of the Core 7 ETFs and the Dukascopy 1-minute index bars (their default folders or the env names
VERTEX_QC_PORTS_DATA, VERTEX_IMOM_IBKR_DATA, VERTEX_VOLSPIKE_DATA_ROOT). Writes one JSON document to
--out and the results tables next to it (`results.md`), in a report work directory outside the
repository; the app never reads them.

Run (rig, in the venv with services/research/requirements-nautilus-linux-py312.lock):
  systemd-run --user --scope -p MemoryMax=14G \
    ~/.local/share/vertex/nautilus-venv/bin/python research/backtests/leveraged-etf/run.py \
      --data ~/Documents/reports/vertex-leveraged-etf/data \
      --out ~/Documents/reports/vertex-leveraged-etf/results.json [--workers N] [--iv-ratio <chain file>]
Diagnostics (a partial run is marked as partial and is not the study result):
  --no-nautilus          ledger only, no NautilusTrader booking
  --pairs QQQ,SPY        only these pairs
  --only '<pattern>,..'  only the form rows whose key matches (fnmatch on signal/regime/window/form);
                         the rows a verdict compares with are added

Method: research/backtests/leveraged-etf/README.md.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import multiprocessing
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))

from strategies.imom import data as idata  # noqa: E402
from strategies.leveraged_etf import forms, metrics, report, runner, signals  # noqa: E402
from strategies.leveraged_etf.pairs import BY_UNDERLYING, PAIRS  # noqa: E402
from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports import data as qd  # noqa: E402

FUND_SUMS = "LEVERAGED_ETF_SHA256SUMS"
_STATE: dict = {}


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- worker side

def _init(fund_root: str, qc_root: str | None, underlyings: tuple[str, ...]) -> None:
    """Loads the daily inputs of the pairs once per process and registers the fund cost model for the
    life of the process."""
    _STATE["data"] = {name: forms.load_pair(BY_UNDERLYING[name], fund_root, qc_root) for name in underlyings}
    _STATE["models"] = forms.fund_models()
    _STATE["models"].__enter__()
    _STATE["vix"] = qd.load_series("VIX", qc_root)
    _STATE["vix3m"] = qd.load_series("VIX3M", qc_root)


def _signals_job(underlying: str):
    try:
        return underlying, runner.load_pair_signals(BY_UNDERLYING[underlying], _STATE["data"][underlying],
                                                    _STATE["vix"], _STATE["vix3m"]), None
    except (OSError, ValueError, KeyError) as error:  # a pair whose intraday data cannot be loaded is dropped
        return underlying, None, f"{type(error).__name__}: {error}"


def _row_job(key: str, taken, starts: dict, capital: float, nautilus: bool) -> dict:
    data = {name: item for name, item in _STATE["data"].items() if name in starts}
    return runner.run_row(key, taken, data, starts, capital, nautilus=nautilus)


def _stats_job(tag, daily, returns, variance: float | None):
    return tag, metrics.row_stats(daily, returns, runner.N_TRIALS, variance), metrics.monthly_points(daily)


# --------------------------------------------------------------------------- parent side

def wanted_rows(patterns: list[str] | None) -> list[str]:
    """The form rows of the run: all 40, or the rows matching a pattern plus the rows their verdicts read."""
    keys = runner.row_keys()
    if not patterns:
        return keys
    picked = {key for key in keys if any(fnmatch.fnmatch(key, pattern) for pattern in patterns)}
    if not picked:
        raise SystemExit(f"--only matches no form row; rows look like {keys[0]}")
    for key in list(picked):
        signal, regime, window, form = metrics.split_key(key)
        picked.add(metrics.row_key(signal, regime, window, metrics.BASELINE_FORM))
        if form in metrics.TWIN_FORM:
            picked.add(metrics.row_key(signal, regime, window, metrics.TWIN_FORM[form]))
    return [key for key in keys if key in picked]


def provenance(fund_root: Path, qc_root: Path, underlyings: list[str]) -> dict:
    """Code revision and a hash of the inputs: the checksum files of the fund fetch and of the qc-ports
    fetch, and name, size and modification time of every intraday file (they are too large to hash each run)."""
    def git(*args: str) -> str:
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=False).stdout.strip()

    digest = hashlib.sha256()
    for path in (fund_root / FUND_SUMS, qc_root / "SHA256SUMS"):
        digest.update(path.read_bytes() if path.exists() else b"missing")
    intraday = []
    for name in underlyings:
        files = [idata.ibkr_files(name)[0]]
        from strategies.volspike import data as vdata

        files += list(vdata.files_of(signals.source_market(name)))
        for path in files:
            stat = path.stat()
            intraday.append(f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}")
    digest.update("\n".join(sorted(intraday)).encode())
    return {"commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain", "--", "services/research/strategies",
                                                                  "research/backtests/leveraged-etf")),
            "dataHash": f"sha256:{digest.hexdigest()}", "fundData": str(fund_root), "qcData": str(qc_root)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", required=True, type=Path, help="fund data directory of fetch_data.py")
    parser.add_argument("--out", required=True, type=Path, help="results JSON to write (results.md goes next to it)")
    parser.add_argument("--qc-data", type=Path, default=None, help="qc-ports data directory (default: its env or folder)")
    parser.add_argument("--capital", type=float, default=runner.CAPITAL)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--only", default=None, help="comma list of fnmatch patterns on the form row keys")
    parser.add_argument("--pairs", default=None, help="comma list of underlyings (default: every pair)")
    parser.add_argument("--no-nautilus", action="store_true", help="ledger only (diagnostic)")
    parser.add_argument("--iv-ratio", type=Path, default=None, help="measured IV ratio file to copy into the report")
    args = parser.parse_args()
    began = time.monotonic()
    fund_root, qc_root = args.data.expanduser(), qd.data_root(args.qc_data)
    out_path: Path = args.out.expanduser()
    keys = wanted_rows(args.only.split(",") if args.only else None)
    names = [pair.underlying for pair in PAIRS]
    if args.pairs:
        asked = [name.strip().upper() for name in args.pairs.split(",") if name.strip()]
        unknown = [name for name in asked if name not in BY_UNDERLYING]
        if unknown:
            raise SystemExit(f"Unknown pair: {', '.join(unknown)}")
        names = [name for name in names if name in asked]
    nautilus = not args.no_nautilus

    # Pairs whose daily files cannot be loaded are dropped and named.
    dropped: list[dict] = []
    data: dict[str, forms.PairData] = {}
    for name in names:
        try:
            data[name] = forms.load_pair(BY_UNDERLYING[name], fund_root, qc_root)
        except (OSError, ValueError, KeyError) as error:
            dropped.append({"underlying": name, "reason": f"{type(error).__name__}: {error}"})
            log(f"pair {name} dropped: {dropped[-1]['reason']}")
    if not data:
        raise SystemExit("No pair could be loaded")
    context = multiprocessing.get_context("spawn")
    workers = max(1, args.workers)

    def pool(names_: tuple[str, ...]) -> ProcessPoolExecutor:
        return ProcessPoolExecutor(max_workers=workers, mp_context=context, initializer=_init,
                                   initargs=(str(fund_root), None if args.qc_data is None else str(args.qc_data), names_))

    found: dict[str, runner.PairSignals] = {}
    with pool(tuple(data)) as executor:
        for name, item, error in executor.map(_signals_job, list(data)):
            if item is None:
                dropped.append({"underlying": name, "reason": error})
                data.pop(name)
                log(f"pair {name} dropped: {error}")
                continue
            found[name] = item
            counts = {key: {regime: len(values) for regime, values in regimes.items()} for key, regimes in item.signals.items()}
            log(f"pair {name}: inputs from {item.inputs_from}, signals {counts}, S2 without a session {item.dropped}")
    if not found:
        raise SystemExit("No pair has signals")

    dates = {name: item.market.dates for name, item in data.items()}
    plan: dict[str, dict] = {}
    for key in keys:
        signal, regime, window, form = metrics.split_key(key)
        taken, counts = runner.taken_signals(found, signal, regime, window, dates)
        plan[key] = {"key": key, "signal": signal, "regime": regime, "window": window, "form": form,
                     "signals": sum(len(item.signals[signal][regime]) for item in found.values()),
                     "taken": len(taken), "skipped": counts, "_taken": taken,
                     "_starts": {name: item.start[signal] for name, item in found.items()}}
    log(f"{len(keys)} form rows, {len(found)} pairs, {workers} workers, "
        f"{'NautilusTrader with ledger parity' if nautilus else 'ledger only'}")

    done: dict[str, dict] = {}
    with pool(tuple(found)) as executor:
        # Largest rows first, so the long NautilusTrader runs start at once.
        order = sorted(keys, key=lambda key: -plan[key]["taken"])
        futures = {executor.submit(_row_job, key, plan[key]["_taken"], plan[key]["_starts"], args.capital, nautilus): key
                   for key in order}
        for count, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            done[result["key"]] = result
            gap = "ledger only" if result["gap"] is None else f"gap {result['gap']:.2g}"
            log(f"[{count}/{len(keys)}] {result['key']}: {result['priced']} priced, "
                f"{len(result['daily'].trades)} booked, {gap}, {result['seconds']:.0f} s")
        variance = metrics.trial_variance([metrics.daily_sharpe(done[key]["daily"]) for key in keys])
        log(f"statistics: n_trials {runner.N_TRIALS}, variance of the per-day Sharpes {variance}")
        jobs = [executor.submit(_stats_job, (key, None), done[key]["daily"], done[key]["returns"], variance) for key in keys]
        jobs += [executor.submit(_stats_job, (key, name), item["daily"], item["returns"], variance)
                 for key in keys for name, item in done[key]["perPair"].items()]
        stats: dict[tuple, tuple] = {}
        for future in as_completed(jobs):
            tag, row_stats, monthly = future.result()
            stats[tag] = (row_stats, monthly)

    sys.path.insert(0, str(ROOT / "research" / "backtests" / "allocation"))
    import funded_pie  # noqa: E402  (research/backtests/allocation/funded_pie.py: the owner's lower bar)

    verdicts = metrics.verdicts({key: stats[(key, None)][0] for key in keys}, al.gate_checks, funded_pie.lower_bar)
    rows = []
    for key in keys:
        row = {name: value for name, value in plan[key].items() if not name.startswith("_")}
        result = done[key]
        row.update(priced=result["priced"], notPriced=result["notPriced"], staleDays=result["staleDays"],
                   nautilusGap=result["gap"], seconds=result["seconds"], stats=stats[(key, None)][0],
                   monthly=stats[(key, None)][1], verdict=verdicts[key],
                   perPair=[{"underlying": name, "priced": item["priced"], "start": plan[key]["_starts"][name],
                             "stats": stats[(key, name)][0]} for name, item in result["perPair"].items()])
        rows.append(row)
    engines = sorted({done[key]["engine"] for key in keys})
    iv_ratio = json.loads(args.iv_ratio.expanduser().read_text()) if args.iv_ratio else None
    document = runner.document(
        rows=rows, found=found, data=data, dropped_pairs=dropped, variance=variance, engine=" / ".join(engines),
        nautilus=nautilus, capital=args.capital, gate=al.GATE, lower_bar=funded_pie.LOWER_BAR, iv_ratio=iv_ratio,
        provenance=provenance(fund_root, qc_root, list(found)), wall_seconds=time.monotonic() - began)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(document, indent=1))
    out_path.with_suffix(".md").write_text(report.results_markdown(document) + "\n")
    print(f"{len(rows)} form rows on {len(found)} pairs to {document['generatedFor']}; "
          f"pass the gate: {len(document['passGate'])}; pass the lower bar: {len(document['passLowerBar'])}; "
          f"leverage helps: {len(document['leverageHelps'])}; wall time {document['wallSeconds']:.0f} s")
    print(report.compact_table(rows))
    print(f"wrote {out_path} and {out_path.with_suffix('.md')}")


if __name__ == "__main__":
    main()
