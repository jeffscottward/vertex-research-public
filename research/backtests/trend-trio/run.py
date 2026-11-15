"""Trend Trio study: runs the jobs of services/research/strategies/trend_trio/study.py (research only).

Places no orders and writes nothing to Postgres. Reads the rig data (every path is an option, defaults below)
and writes to --out (a report work directory outside the repository): one JSON file per job (a restarted run
skips finished jobs), `data.json` (datasets and the SHA-256 manifest of every input file), `results.json`,
`study.json` (the research_studies document, kind "strategy-backtest") and `index.html` (the dark report).

The run starts with a one-year pilot (2024, in <out>/pilot) and stops before a tier whose projected time
(pilot seconds x full sessions / pilot sessions) exceeds 8 core-hours; such a stop is a blocked job. It refuses
to run when docs/specs/strategies/trend-trio.md (above "## Results") differs from rules.SPEC_SHA256.

Run (rig, in the Nautilus venv):
  ~/.cache/vertex-academy-nautilus-venv/bin/python research/backtests/trend-trio/run.py \
      --out ~/Documents/reports/web/vertex-trend-trio/run --workers 8
  ... --pilot             2024 only (writes <out>/pilot)
  ... --pilot --dry-run   load the data, list the jobs and the data manifest; run nothing
Store the study document (after review):
  DATABASE_URL=postgres://... bun run vertex:research-studies:import < <out>/study.json
"""
from __future__ import annotations

import argparse
import json
import multiprocessing
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))

from strategies.trend_trio import document, report, rules, study

TIER_BUDGET_CORE_HOURS = 8.0
WATCHED = ("services/research", "research/backtests/trend-trio", "docs/specs/strategies/trend-trio.md")


def log(text: str) -> None:
    print(f"{datetime.now(UTC):%H:%M:%SZ} {text}", file=sys.stderr, flush=True)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    defaults = study.DataPaths()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, help="output directory (outside the repository); required to run")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--pilot", action="store_true", help="2024 only (timing pilot)")
    parser.add_argument("--dry-run", action="store_true",
                        help="load the data, print the job list and the data manifest, run no job")
    parser.add_argument("--allow-dirty", action="store_true",
                        help="diagnostic: run with uncommitted study code (the study document is then not written)")
    parser.add_argument("--render-only", action="store_true",
                        help="rebuild study.json and index.html from <out>/results.json without running")
    for name, default, text in (
            ("m1", defaults.m1, "imom m1 directory (usatechidxusd-{bid,ask}.csv.gz), dataset (a)"),
            ("m1-full", defaults.m1_full, "full-session monthly CFD files (V8)"),
            ("qqq", defaults.qqq, "IBKR QQQ 5-minute bars, dataset (b)"),
            ("yahoo-ndx", defaults.yahoo_ndx, "Yahoo daily NDX (scale of dataset (b))"),
            ("yahoo-qqq", defaults.yahoo_qqq, "Yahoo daily QQQ (scale of dataset (b))"),
            ("nq", defaults.nq, "directory of NQ_*.csv 5-minute files, dataset (c)")):
        parser.add_argument(f"--{name}", type=Path, default=default, help=f"{text} (default {default})")
    return parser.parse_args(argv)


def data_paths(args: argparse.Namespace) -> study.DataPaths:
    return study.DataPaths(m1=args.m1.expanduser(), m1_full=args.m1_full.expanduser(), qqq=args.qqq.expanduser(),
                           yahoo_ndx=args.yahoo_ndx.expanduser(), yahoo_qqq=args.yahoo_qqq.expanduser(),
                           nq=args.nq.expanduser())


def spec_status() -> tuple[bool, str]:
    """(frozen spec matches rules.SPEC_SHA256, explanation)."""
    try:
        actual = rules.spec_sha256()
    except FileNotFoundError:
        return False, f"spec {rules.SPEC} missing"
    if actual != rules.SPEC_SHA256:
        return False, f"spec SHA-256 {actual[:16]} differs from rules.SPEC_SHA256 {rules.SPEC_SHA256[:16]}"
    return True, f"spec SHA-256 {actual[:16]} matches"


def git_state() -> tuple[str, list[str]]:
    commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True,
                            check=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", *WATCHED], capture_output=True,
                           text=True, check=True).stdout.strip()
    return commit, dirty.splitlines()


def load(paths: study.DataPaths, years: study.Years | None) -> tuple[study.Datasets, dict]:
    started = time.time()
    data = study.load_datasets(paths, years)
    manifest = study.data_manifest(data.files)
    log(f"loaded data in {time.time() - started:.0f}s ({len(manifest)} files)")
    info = {"datasets": dict(data.info), "files": manifest,
            "paths": {key: str(value) for key, value in vars(paths).items()}}
    return data, info


def print_plan(info: dict, jobs: Sequence[study.Job]) -> None:
    graded = [job for job in jobs if job.graded]
    extra = [job for job in jobs if not job.graded]
    ok, text = spec_status()
    print(f"spec: {text}{'' if ok else ' (a real run would refuse)'}")
    print(f"jobs: {len(jobs)} = {len(graded)} graded rows + {len(extra)} diagnostics")
    for tier in (1, 2, 3, 4):
        names = [job.name for job in jobs if job.tier == tier]
        print(f"  tier {tier} ({len(names)}): {' '.join(names)}")
    print("datasets:")
    for name, item in info["datasets"].items():
        if isinstance(item, dict):
            shown = {k: v for k, v in item.items() if not isinstance(v, list)}
            print(f"  {name}: {json.dumps(shown, sort_keys=True)}")
    print(f"data manifest ({len(info['files'])} files):")
    for entry in info["files"]:
        print(f"  {entry['sha256']}  {entry['bytes']:>11,}  {entry['path']}")


def run_jobs(jobs: Sequence[study.Job], out: Path, workers: int, data: study.Datasets) -> dict[str, dict]:
    """Runs `jobs` in a forked pool (workers share the loaded data copy-on-write); returns job summaries."""
    study.use(data)
    done: dict[str, dict] = {}
    context = multiprocessing.get_context("fork")
    with ProcessPoolExecutor(max_workers=workers, mp_context=context) as pool:
        futures = {pool.submit(study.run_job, job, out): job for job in jobs}
        for future in as_completed(futures):
            summary = future.result()
            done[summary["job"]] = summary
            log(f"{summary['job']}: {summary['status']} {'(skipped)' if summary['skipped'] else ''}"
                f"{summary['seconds']}s")
    return done


def run_tiers(jobs: Sequence[study.Job], out: Path, workers: int, data: study.Datasets,
              projection: Callable[[Sequence[study.Job]], float] | None) -> dict | None:
    """Tier by tier (random control and the Nautilus check read P1-P3 files of tier 1); returns the blocked
    tier, or None when every tier ran."""
    for tier in (1, 2, 3, 4):
        tier_jobs = [job for job in jobs if job.tier == tier]
        hours = projection(tier_jobs) if projection is not None else 0.0
        if hours > TIER_BUDGET_CORE_HOURS:
            log(f"tier {tier} blocked: projected {hours:.1f} core-hours > {TIER_BUDGET_CORE_HOURS:g}")
            return {"tier": tier, "projectedCoreHours": hours, "jobs": [job.name for job in tier_jobs]}
        log(f"tier {tier}: {len(tier_jobs)} jobs (projected {hours:.2f} core-hours)")
        run_jobs(tier_jobs, out, workers, data)
    return None


def pilot_projection(pilot_dir: Path, pilot_sessions: int,
                     full_sessions: int) -> Callable[[Sequence[study.Job]], float]:
    scale = full_sessions / max(1, pilot_sessions)

    def project(jobs: Sequence[study.Job]) -> float:
        seconds = 0.0
        for job in jobs:
            path = pilot_dir / f"{job.name}.json"
            stored = json.loads(path.read_text()) if path.exists() else {}
            seconds += float(stored.get("seconds") or 0.0)
        return seconds * scale / 3600

    return project


def write_outputs(out: Path, results: dict) -> None:
    (out / "results.json").write_text(json.dumps(results, indent=1, allow_nan=False) + "\n")
    if results["provenance"].get("dirtyFiles"):
        log("uncommitted study code: study.json not written (the document would name a commit without the code)")
    else:
        doc = document.study_document(results)
        (out / "study.json").write_text(json.dumps(doc, indent=1, allow_nan=False) + "\n")
    (out / "index.html").write_text(report.render(results))


def finish(out: Path, info: dict, provenance: dict, pilot: bool, blocked: dict | None) -> dict:
    results = study.assemble(out, info, pilot=pilot)
    results["provenance"] = provenance
    results["blocked"] = blocked
    write_outputs(out, results)
    return results


def run_study(args: argparse.Namespace, paths: study.DataPaths) -> None:
    ok, text = spec_status()
    if not ok:
        raise SystemExit(f"Refusing to run: {text}. Freeze the spec first (docs/specs/strategies/trend-trio.md).")
    commit, dirty = git_state()
    if dirty and not args.allow_dirty:
        raise SystemExit("Uncommitted study code (commit it first, or --allow-dirty for a diagnostic run):\n"
                         + "\n".join(dirty))
    started = time.time()
    out = args.out.expanduser()
    pilot_dir = out / "pilot"
    pilot_dir.mkdir(parents=True, exist_ok=True)
    jobs = study.jobs()

    def provenance(pilot: bool) -> dict:
        return {"commit": commit, "dirtyFiles": dirty, "ran": datetime.now(UTC).date().isoformat(),
                "specSha256": rules.SPEC_SHA256, "workers": args.workers, "pilot": pilot,
                "seconds": round(time.time() - started)}

    pilot_data, pilot_info = load(paths, study.PILOT_YEARS)
    (pilot_dir / "data.json").write_text(json.dumps(pilot_info, indent=1, allow_nan=False) + "\n")
    run_tiers(jobs, pilot_dir, args.workers, pilot_data, None)
    pilot_results = finish(pilot_dir, pilot_info, provenance(True), True, None)
    log(f"pilot: {pilot_results['outcome']}; wrote {pilot_dir}")
    if args.pilot:
        return
    pilot_sessions = pilot_info["datasets"]["a"]["sessions"]
    del pilot_data
    data, info = load(paths, None)
    (out / "data.json").write_text(json.dumps(info, indent=1, allow_nan=False) + "\n")
    projection = pilot_projection(pilot_dir, pilot_sessions, info["datasets"]["a"]["sessions"])
    blocked = run_tiers(jobs, out, args.workers, data, projection)
    results = finish(out, info, provenance(False), False, blocked)
    log(f"{results['outcome']} (deciding {results['decidingTest']}); blocked {blocked}; wrote {out}")


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    paths = data_paths(args)
    if args.dry_run:
        _, info = load(paths, study.PILOT_YEARS if args.pilot else None)
        print_plan(info, study.jobs())
        return
    if args.out is None:
        raise SystemExit("--out is required (a directory outside the repository)")
    if args.render_only:
        out = args.out.expanduser()
        write_outputs(out, json.loads((out / "results.json").read_text()))
        log(f"rendered {out}")
        return
    run_study(args, paths)


if __name__ == "__main__":
    main()
