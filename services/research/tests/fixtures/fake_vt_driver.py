"""Stand-in for services/vibe-trading/driver/vt_driver.py in tests (no Vibe-Trading install).

The scenario is the --model value (runs) or the last part of --vt-dir (--describe). It prints the
same JSON-line protocol as the real driver.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

ALLOWED = ["get_market_data", "quantlib_call", "options_payoff", "get_stock_news"]


def line(**fields: object) -> None:
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def event(agent: str, kind: str, title: str, **fields: object) -> None:
    line(type="event", agent=agent, kind=kind, title=title, **fields)


def describe(scenario: str) -> int:
    if scenario == "broken":
        line(type="failed", error="ModuleNotFoundError: No module named 'src'")
        return 1
    if scenario == "hang":
        time.sleep(30)
    if scenario == "badjson":
        sys.stdout.write("{not json\n")
        return 0
    # The raw registry (unfiltered) and the driver's own allowlist.
    tools = {"good": [*ALLOWED, "bash", "backtest", "trading_place_order"], "leaky": ALLOWED,
             "empty": ["bash", "write_file"], "notools": None}[scenario]
    allowlist = [*ALLOWED, "bash"] if scenario == "leaky" else ALLOWED
    line(type="describe", package="0.1.18", commit="66eb576" if scenario != "empty" else "",
         tools=tools, allowlist=allowlist)
    return 0


BLOCK = """Earlier draft:
```json
{"rating": "Sell"}
```
Final call:
```json
{"rating": "Overweight", "action": "long", "entry": "$190.50", "stop": (omitted※), "target": 212,
 "horizon": "3 months", "confidence": 70, "thesis": "Demand holds at (omitted※) units."}
```"""


def run(args: argparse.Namespace) -> int:
    scenario = args.model
    line(type="version", package="0.1.18", commit="66eb576")
    line(type="started", mode=args.mode, agents={"bull_advocate": ALLOWED, "portfolio_manager": []})
    if scenario == "grant-leak":
        line(type="tools", agent="risk_officer", tools=["get_market_data", "bash"])
        time.sleep(30)
        return 0
    line(type="tools", agent="bull_advocate", tools=ALLOWED[:2])
    if scenario == "env":
        event("vibe", "status", "environment", body=",".join(sorted(os.environ)))
        line(type="result", status="completed",
             content='```json\n{"rating": "hold", "argv": "%s"}\n```' % " ".join(sys.argv[1:]))
        return 0
    if scenario == "slow":
        event("vibe", "status", "started")
        time.sleep(30)
        return 0
    if scenario == "exit":
        sys.stderr.write("Traceback: boom\n")
        return 3
    if scenario == "crash":
        sys.stdout.write("not json\n[1, 2]\n")
        line(type="failed", error="RuntimeError: swarm stopped")
        return 1
    event("bull_advocate", "status", "started")
    event("bull_advocate", "llm_call", "model call", model=args.model, servedModel="served-a",
          inputTokens=1200, outputTokens=300, durationMs=900)
    event("bull_advocate", "llm_call", "model call", model=args.model, servedModel="served-a",
          inputTokens=800, outputTokens=100, durationMs=-5)
    event("bear_advocate", "tool_call", "get_market_data", toolName="get_market_data",
          body=json.dumps({"symbol": "AAPL"}))
    event("bear_advocate", "tool_result", "get_market_data: 10 characters", toolName="get_market_data",
          body="x" * 5000)
    event("risk_officer", "flag", "Iteration Limit!", body="10 steps")
    event("risk_officer", "unknown_kind", "ignored")
    event(None, "message", "Report", body="no agent")
    content = {
        "stated": BLOCK,
        "mapped": 'Answer\n```\n{"rating": "strong buy", "action": "SHORT", "entry": 0, '
                  '"stop": "n/a", "target": true, "horizon": ""}\n```',
        "none": "I cannot decide. ```json\n{not json}\n```",
        "failed-status": "partial",
    }[scenario]
    status = "failed" if scenario == "failed-status" else "completed"
    tokens = [5000, 900] if scenario == "mapped" else [2000, 400]  # the swarm saw more than the tap
    line(type="result", status=status, content=content, tokens=tokens)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    for name in ("--ticker", "--date", "--model", "--provider", "--base-url", "--api-key-env",
                 "--run-dir", "--vt-dir", "--mode", "--max-iter", "--timeout"):
        parser.add_argument(name)
    parser.add_argument("--describe", action="store_true")
    args = parser.parse_args()
    if args.describe:
        return describe(os.path.basename(args.vt_dir.rstrip("/")))
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
