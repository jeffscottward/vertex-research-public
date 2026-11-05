"""QuantMind research CLI. Run from services/research: python -m agents.quantmind_cli <command>.

Commands
  search  --topic TEXT [--captures DIR] [--papers DIR] [--top N]
          rank captured papers for a topic (QuantMind knowledge search); prints JSON
  mine    --topic TEXT [--captures DIR] [--papers DIR] [--out DIR] [--top N]
          [--min-confidence X] [--instrument SPY] [--in-sample-end DATE] [--preregistered-at TS]
          rank papers and write Quant Lab draft spec inputs and report.json under
          OUT/<topic-slug>-<topic-sha8>/

Defaults: captures $QUANTLAB_HOME/captures, out $QUANTLAB_HOME/mined, papers
$QUANTLAB_HOME/papers, or <captures>/../papers when --captures is given.
$QUANTLAB_HOME defaults to <repo>/private/quantlab; a relative $QUANTLAB_HOME
resolves from the current directory (as in python -m quantlab). A relative
--captures, --papers or --out path resolves against the repository root, so
output stays under the git-ignored private/ folder. Deterministic: no model,
no network.
Research only: no orders, no broker access, no credentials.

Exit codes: 0 success (also when every candidate is rejected), 2 usage error or
missing captures folder.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from .quantmind_mining import LocalCaptureClient, MineOptions, build_knowledge, mine, write_outputs

REPO = Path(__file__).resolve().parents[3]


def home() -> Path:
    return Path(os.environ.get("QUANTLAB_HOME", REPO / "private" / "quantlab"))


def _path(value: str | None, default: Path) -> Path:
    if not value:
        return default
    path = Path(value).expanduser()
    return path if path.is_absolute() else REPO / path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agents.quantmind_cli")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("search", "mine"):
        p = sub.add_parser(name)
        p.add_argument("--topic", required=True)
        p.add_argument("--captures")
        p.add_argument("--papers")
        p.add_argument("--top", type=int, default=10)
    m = sub.choices["mine"]
    m.add_argument("--out")
    m.add_argument("--min-confidence", type=float, default=0.5)
    m.add_argument("--instrument", default="SPY")
    m.add_argument("--in-sample-end", default="2009-12-31")
    m.add_argument("--preregistered-at")
    args = parser.parse_args(argv)
    root = home()
    captures = _path(args.captures, root / "captures")
    papers = _path(args.papers, captures.parent / "papers" if args.captures else root / "papers")
    try:
        client = LocalCaptureClient(captures, papers)
    except FileNotFoundError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 2
    if not re.fullmatch(r"[A-Z^][A-Z0-9.^-]{0,11}", getattr(args, "instrument", "SPY")):
        print(json.dumps({"error": "--instrument must be one ticker symbol, for example SPY"}), file=sys.stderr)
        return 2

    if args.command == "search":
        knowledge, by_source, _ = build_knowledge(client)
        rows = []
        for ref in knowledge.search(args.topic, top_k=max(args.top, 0)):
            capture = client.record(by_source[(ref.raw or {})["source_id"]]).capture
            rows.append({"capture_id": by_source[(ref.raw or {})["source_id"]], "doi": capture["doi"],
                         "title": capture["title"], "confidence": ref.confidence, "excerpt": ref.excerpt})
        print(json.dumps({"topic": args.topic, "results": rows}, indent=2, ensure_ascii=False))
        return 0

    options = MineOptions(instrument=args.instrument, in_sample_end=args.in_sample_end,
                          preregistered_at=args.preregistered_at, top=args.top,
                          min_confidence=args.min_confidence)
    out = _path(args.out, root / "mined")
    folder, report = write_outputs(mine(client, args.topic, options), out)
    print(json.dumps({"out": str(folder), "topic": args.topic, **report["counts"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
