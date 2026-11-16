"""Options-side continuation study runner (research only): services/research/strategies/flow_control/study.py.

Places no orders and writes nothing to Postgres. Reads the downloaded net drift history (--data) and the daily
SPY, QQQ, VIX, VXN and T-bill rows of the option model (--market-data), and writes to --out (outside the
repository): data.json, results.json, study.json (the research_studies document) and index.html. It refuses to run
when docs/specs/strategies/flow-control-continuation.md (above "## Results") differs from rules.SPEC_SHA256.

  ~/.cache/vertex-academy-nautilus-venv/bin/python research/backtests/flow-control-continuation/run.py \
      --data ~/Documents/reports/vertex-flow-control-data --out ~/Documents/reports/web/vertex-flow-control-continuation/run
  ... --dry-run       load the data; print sessions, split, skipped counts and the data hash; write nothing
  ... --render-only   rebuild study.json and index.html from results.json in --out
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import time
from collections import Counter
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))

from strategies.flow_control import data, document, report, rules, study  # noqa: E402
from strategies.flow_control.download import outside_repository  # noqa: E402
from strategies.qc_ports import data as qc_data  # noqa: E402

WATCHED = ("services/research", "research/backtests/flow-control-continuation",
           "docs/specs/strategies/flow-control-continuation.md")
DEFAULT_OUT = Path.home() / "Documents" / "reports" / "web" / "vertex-flow-control-continuation" / "run"
MARKET_SYMBOLS = ("SPY", "QQQ")
MARKET_FILES = ("SPY.csv", "QQQ.csv", "VIX.csv", "VXN.csv", "IRX.csv")
DEEP_COLUMNS = ("symbol", "second_s", "side", "size", "price")
LIVE_COLUMNS = ("ticker", "part", "minute_ms", "net_call_premium", "net_put_premium", "net_call_volume",
                "net_put_volume", "underlying_price")
INTEGER_COLUMNS = {"second_s", "minute_ms"}
TEXT_COLUMNS = {"symbol", "side", "ticker", "part"}


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


def read_csv(path: Path, columns: Sequence[str]) -> list[dict]:
    with Path(path).expanduser().open(newline="") as handle:
        reader = csv.DictReader(handle)
        missing = [c for c in columns if c not in (reader.fieldnames or [])]
        if missing:
            raise SystemExit(f"{path}: missing column(s) {', '.join(missing)}")
        out = []
        for row in reader:
            item = {}
            for column in columns:
                value = row[column]
                item[column] = value if column in TEXT_COLUMNS else int(value) if column in INTEGER_COLUMNS \
                    else float(value)
            out.append(item)
    return out


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--data", type=Path, default=None)
    parser.add_argument("--market-data", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--deep-trades", type=Path, default=None)
    parser.add_argument("--live-rows", type=Path, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--render-only", action="store_true")
    return parser.parse_args(argv)


def write_outputs(out: Path, results: dict) -> bool:
    """Writes results.json, study.json (when the document builds) and index.html; True when study.json was written."""
    (out / "results.json").write_text(json.dumps(results, indent=1, allow_nan=False) + "\n")
    written = False
    try:
        doc = document.study_document(results)
    except ValueError as error:
        log(f"study.json not written: {error}")
        (out / "study.json").unlink(missing_ok=True)
    else:
        (out / "study.json").write_text(json.dumps(doc, indent=1, allow_nan=False) + "\n")
        written = True
    (out / "index.html").write_text(report.render(results))
    return written


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        out = outside_repository(args.out, ROOT)
        if args.render_only:
            results = json.loads((out / "results.json").read_text())
            return 0 if write_outputs(out, results) else 1
        ok, message = spec_status()
        log(message)
        if not ok:
            raise SystemExit(f"refusing to run: {message}")
        commit, dirty = git_state()
        if dirty and not args.allow_dirty:
            raise SystemExit("refusing to run: uncommitted study code (" + "; ".join(dirty[:5]) + "); use --allow-dirty")
        root = outside_repository(data.data_root(args.data), ROOT)
        market_root = qc_data.data_root(args.market_data)
    except SystemExit as error:
        log(str(error))
        return 1
    started = time.time()
    loaded = data.load_all(root)
    split = study.split_sessions(loaded.days)
    market_files = [market_root / name for name in MARKET_FILES]
    manifest = data.data_manifest(loaded.files)
    market_manifest = data.data_manifest(market_files)
    info = {"root": str(root), "marketRoot": str(market_root), "days": len(loaded.days),
            "first": loaded.days[0], "last": loaded.days[-1], "skipped": list(loaded.skipped),
            "earlyCloseDays": loaded.early_close_days, "derivedTotalDays": loaded.derived_total_days,
            "files": manifest, "marketFiles": market_manifest, "dataHash": data.data_hash([*manifest, *market_manifest])}
    if args.dry_run:
        reasons = Counter(item["reason"] for item in loaded.skipped)
        print(f"sessions {len(loaded.days)} ({info['first']} to {info['last']}); skipped {dict(reasons)}; early close "
              f"{loaded.early_close_days}; derived total {loaded.derived_total_days}")
        for name in ("train", "validation", "test", "window_choice"):
            part = getattr(split, name)
            print(f"{name}: {len(part)} sessions ({part[0] if part else '-'} to {part[-1] if part else '-'})")
        print(f"data hash sha256:{info['dataHash']}")
        return 0
    out.mkdir(parents=True, exist_ok=True)
    (out / "data.json").write_text(json.dumps(info, indent=1) + "\n")
    markets = {symbol: qc_data.load_market(symbol, market_root) for symbol in MARKET_SYMBOLS}
    deep = read_csv(args.deep_trades, DEEP_COLUMNS) if args.deep_trades else []
    live = read_csv(args.live_rows, LIVE_COLUMNS) if args.live_rows else []
    results = study.run(loaded, root, markets=markets, market_files=market_files, deep_trades=deep, live_rows=live)
    results["provenance"] = {"commit": commit, "dirtyFiles": dirty, "ran": datetime.now(UTC).date().isoformat(),
                             "specSha256": rules.SPEC_SHA256, "seconds": int(time.time() - started)}
    if dirty:
        log("uncommitted study code: study.json will not be written")
    written = write_outputs(out, results)
    log(f"{results['verdict']}: {results['verdictReason']}")
    log(f"wrote {out}")
    return 0 if written else 1


if __name__ == "__main__":
    raise SystemExit(main())
