"""Quant Lab CLI. Run from services/research: python -m quantlab <command>.

Commands
  search    --topics topics.json [--rows N] [--since YYYY-MM-DD] [--no-pdf]   scheduled topic search
  paper     --doi 10.2139/ssrn.N --topic TEXT                                 capture one paper
  prompt    --capture capture.json                                             agent drafting prompt
  spec      --capture capture.json --draft draft.json                          validate + freeze spec
  freeze    --symbol SPY --start YYYY-MM-DD --end YYYY-MM-DD                   freeze daily bars
  backtest  --spec spec.json --bars m.json [--rates m.json] [--start DATE]     run spec, write result
            [--engine nautilus|stdlib]   NautilusTrader 1.227.0 (default since 2026-11-08) or the
                                         stdlib simulator; without the Nautilus lock, pass --engine stdlib

All output goes under $QUANTLAB_HOME (default: <repo>/private/quantlab). Research only:
no orders, no broker access, no credentials.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import data, ssrn
from .backtest import ENGINES, run_spec
from .nautilus_engine import NautilusUnavailable
from .spec import SpecError, agent_prompt, build_spec

REPO = Path(__file__).resolve().parents[3]


def home() -> Path:
    return Path(os.environ.get("QUANTLAB_HOME", REPO / "private" / "quantlab"))


def write(path: Path, value) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="quantlab")
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("search"); s.add_argument("--topics", required=True); s.add_argument("--rows", type=int, default=10)
    s.add_argument("--since"); s.add_argument("--no-pdf", action="store_true")
    p = sub.add_parser("paper"); p.add_argument("--doi", required=True); p.add_argument("--topic", required=True)
    p.add_argument("--no-pdf", action="store_true")
    q = sub.add_parser("prompt"); q.add_argument("--capture", required=True)
    b = sub.add_parser("spec"); b.add_argument("--capture", required=True); b.add_argument("--draft", required=True)
    f = sub.add_parser("freeze"); f.add_argument("--symbol", required=True); f.add_argument("--start", required=True)
    f.add_argument("--end", required=True)
    t = sub.add_parser("backtest"); t.add_argument("--spec", required=True); t.add_argument("--bars", required=True)
    t.add_argument("--rates"); t.add_argument("--start")
    # Nautilus is the default engine (switch plan step 3, docs/vertex-rebuild/nautilus-backtest-engine.md).
    t.add_argument("--engine", choices=ENGINES, default="nautilus")
    args = parser.parse_args(argv)
    root = home()

    if args.command == "search":
        topics = json.loads(Path(args.topics).read_text())["topics"]
        stamp = ssrn.now_iso()
        out = []
        for topic in topics:
            try:
                captures = ssrn.run_topic(topic, rows=args.rows, since=args.since, store=root / "papers",
                                          captured_at=stamp, retain=not args.no_pdf)
            except Exception as error:  # one failing topic must not hide the others
                print(json.dumps({"topic": topic, "error": str(error)}), file=sys.stderr)
                continue
            out += [c.to_dict() for c in captures]
        path = write(root / "captures" / f"search-{stamp.replace(':', '')}.json", {"captured_at": stamp, "captures": out})
        print(json.dumps({"written": str(path), "captures": len(out),
                          "retained_pdfs": sum(1 for c in out if c["pdf_status"] == "retained")}))
    elif args.command == "paper":
        capture = ssrn.get_by_doi(args.doi, topic=args.topic, store=root / "papers", retain=not args.no_pdf)
        path = write(root / "captures" / f"ssrn-{capture.ssrn_id}.json", capture.to_dict())
        print(json.dumps({"written": str(path), "pdf_status": capture.pdf_status}))
    elif args.command == "prompt":
        print(agent_prompt(json.loads(Path(args.capture).read_text())))
    elif args.command == "spec":
        capture = json.loads(Path(args.capture).read_text())
        try:
            spec = build_spec(capture, json.loads(Path(args.draft).read_text()))
        except SpecError as error:
            print(json.dumps({"error": str(error)}), file=sys.stderr)
            return 2
        path = write(root / "specs" / f"{spec['id']}-{spec['spec_sha256'][:12]}.json", spec)
        print(json.dumps({"written": str(path), "spec_sha256": spec["spec_sha256"]}))
    elif args.command == "freeze":
        manifest = data.freeze(args.symbol, args.start, args.end, root / "data")
        print(json.dumps(manifest))
    elif args.command == "backtest":
        spec = json.loads(Path(args.spec).read_text())
        bars_manifest = json.loads(Path(args.bars).read_text())
        rates_manifest = json.loads(Path(args.rates).read_text()) if args.rates else None
        label = f"{bars_manifest['source']}; {bars_manifest['symbol']} sha256 {bars_manifest['sha256'][:16]}"
        if rates_manifest:
            label += f"; cash {rates_manifest['symbol']} sha256 {rates_manifest['sha256'][:16]}"
        try:
            result = run_spec(spec, data.load(bars_manifest), data.load(rates_manifest) if rates_manifest else None,
                              data_label=label, start=args.start, engine=args.engine)
        except NautilusUnavailable as error:  # optional engine not installed or wrong version
            print(json.dumps({"error": f"{error} (or pass --engine stdlib)"}), file=sys.stderr)
            return 2
        result["specId"], result["specSha256"] = spec["id"], spec["spec_sha256"]
        result["data"] = {"bars": bars_manifest, "rates": rates_manifest}
        suffix = "" if args.engine == "stdlib" else f"-{args.engine}"
        path = write(root / "results" / f"{spec['id']}-{spec['spec_sha256'][:12]}{suffix}.json", result)
        print(json.dumps({"written": str(path), "engine": result["engine"], "verdict": result["verdict"],
                          "metrics": result["metrics"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
