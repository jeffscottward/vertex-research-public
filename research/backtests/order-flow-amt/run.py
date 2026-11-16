"""Order flow / AMT auction study runner (research only): services/research/strategies/order_flow_amt/study.py.

Places no orders and writes nothing to Postgres. Reads 5-minute bars (--ib, --spy-minutes, --yahoo), ex-dividend
dates (--dividends), the daily SPY, QQQ, VIX, VXN and T-bill rows of the option model (--market-data) and, for the
forward description only, a `flow_minutes` export (--flow-minutes). Writes results.json and summary.md to --out (outside the repository). It refuses
to run when docs/specs/strategies/order-flow-amt-auction.md (above "## Results") differs from rules.SPEC_SHA256, or
when the study code or spec has uncommitted changes (unless --allow-dirty), when the IBKR bars do not end on
2026-11-06 or an ex-dividend file is missing. NautilusTrader (1.227.0) is required.

  ~/.cache/vertex-academy-nautilus-venv/bin/python research/backtests/order-flow-amt/run.py \
      --out ~/Documents/reports/web/vertex-orderflow-amt/run
  ... --dry-run   load the data; print the sessions, data checks and the data hash; write nothing (spec and
                  clean-tree checks only log)
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))

from strategies.flow_control.download import outside_repository  # noqa: E402
from strategies.order_flow_amt import data, rules, study  # noqa: E402
from strategies.qc_ports import data as qc_data  # noqa: E402

WATCHED = ("services/research/strategies/order_flow_amt", "research/backtests/order-flow-amt",
           "docs/specs/strategies/order-flow-amt-auction.md")
HOME = Path.home()
SHARE = HOME / ".local" / "share" / "vertex-research-data" / "order-flow-amt"
DEFAULTS = {
    "ib": HOME / "Documents" / "reports" / "vertex-noiseband-retest" / "data" / "ib",
    "spy_minutes": HOME / "Documents" / "reports" / "vertex-noiseband" / "data" / "spy_1min_2008_2021_cleaned.csv",
    "yahoo": SHARE / "yahoo-5m",
    "dividends": SHARE / "dividends",
    "out": HOME / "Documents" / "reports" / "web" / "vertex-orderflow-amt" / "run",
}
MARKET_FILES = ("SPY.csv", "QQQ.csv", "VIX.csv", "VXN.csv", "IRX.csv")


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def spec_status() -> tuple[bool, str]:
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


def data_problems(info: dict, ex_dates: dict) -> list[str]:
    """The history must end on study.HISTORY_LAST for both symbols, and both must have ex-dividend dates."""
    out = []
    for symbol in data.SYMBOLS:
        last = info[symbol]["ib"].get("last_session")
        if last != study.HISTORY_LAST:
            out.append(f"{symbol}: last IBKR session {last}, the study needs {study.HISTORY_LAST}")
        if not ex_dates.get(symbol):
            out.append(f"{symbol}: no ex-dividend dates")
    return out


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    for key in ("ib", "spy_minutes", "yahoo", "dividends", "out"):
        parser.add_argument(f"--{key.replace('_', '-')}", type=Path, default=DEFAULTS[key])
    parser.add_argument("--flow-minutes", type=Path, default=None,
                        help="flow_minutes export for the forward description (not a verdict input)")
    parser.add_argument("--market-data", type=Path, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--allow-dirty", action="store_true")
    return parser.parse_args(argv)


def summary(results: dict) -> str:
    lines = [f"# Order flow / AMT auction study: {results['verdict']}", "",
             f"Commit {results['run']['commit'][:12]}, spec {results['spec']['sha256'][:16]}, data "
             f"{results['run']['dataHash'][:16]}. Sessions {results['days']['first']} to {results['days']['last']} "
             f"({results['days']['count']}). Research only; no trading authority.", ""]
    for rule, item in results["verdicts"].items():
        lines.append(f"- Rule {rule}: {item['text']}")
    lines += ["", "| Row | Part | Trades | Net USD | Sharpe | Win rate | Max DD USD |", "|---|---|---|---|---|---|---|"]
    for row in study.ROWS:
        stats = results["rows"][row]["base"]
        for part in ("train", "outOfSample"):
            s = stats.get(part) if stats else None
            if s:
                lines.append(f"| {row} | {part} | {s['trades']} | {s['netUsd']:,.0f} | {s['sharpe']:.2f} | "
                             f"{s['winRate']:.2f} | {s['maxDrawdownUsd']:,.0f} |")
    naut = results.get("nautilus") or {}
    lines += ["", f"NautilusTrader replay: {naut.get('status')}, same = {naut.get('same')}, "
                  f"{naut.get('booked')} of {naut.get('trades')} trades."]
    forward = results["forward"]
    if forward is not None:
        lines.append(f"Forward order-flow description ({forward['window']}): {forward['signals']} signals, "
                     f"delta agreement {forward['agreement']}.")
    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    ok, message = spec_status()
    log(message)
    if not ok and not args.dry_run:
        return 2
    commit, dirty = git_state()
    if dirty and not (args.allow_dirty or args.dry_run):
        log("uncommitted changes in the study files:\n" + "\n".join(dirty))
        return 2
    out = outside_repository(args.out, ROOT)
    sources = data.Sources(ib=args.ib.expanduser(), spy_minutes=args.spy_minutes.expanduser(),
                           yahoo=args.yahoo.expanduser(), dividends=args.dividends.expanduser())
    started = time.monotonic()
    sessions, info = data.load_all(sources)
    ex_dates = data.ex_dates_of(sources)
    market_root = qc_data.data_root(args.market_data)
    market_files = [market_root / name for name in MARKET_FILES]
    files = [*data.input_files(sources), *market_files]
    problems = data_problems(info, ex_dates)
    for problem in problems:
        log(problem)
    if problems and not args.dry_run:
        return 2
    data_hash = data.data_hash(files)
    log(f"loaded {json.dumps({s: {k: v for k, v in i.items() if k != 'ib'} for s, i in info.items()})}")
    log(f"data hash sha256:{data_hash}")
    if args.dry_run:
        return 0
    markets = {symbol: qc_data.load_market(symbol, market_root) for symbol in data.SYMBOLS}
    flow_path = None if args.flow_minutes is None else args.flow_minutes.expanduser()
    flow = None if flow_path is None else data.by_symbol(data.read_flow_minutes(flow_path))
    results = study.run(sessions, markets, flow, nautilus=True, ex_dates=ex_dates)
    results["run"] = {"commit": commit, "dirty": dirty, "dataHash": data_hash, "data": info,
                      "flowMinutes": None if flow_path is None else {"file": str(flow_path),
                                                                     "sha256": data.data_hash([flow_path])},
                      "files": [str(f) for f in files], "seconds": round(time.monotonic() - started),
                      "at": datetime.now(UTC).isoformat(timespec="seconds")}
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps(results, indent=1, default=str))
    (out / "summary.md").write_text(summary(results))
    log(f"wrote {out}/results.json and summary.md in {results['run']['seconds']} s: {results['verdict']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
