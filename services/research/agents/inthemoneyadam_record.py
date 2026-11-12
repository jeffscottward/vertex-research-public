"""Record one In The Money Adam desk run in Vertex (``agentModelRuns``), research only.

Runs the desk on one ticker, then calls only ``agentModelRuns.record``,
``agentModelRuns.appendEvents`` and ``agentModelRuns.update`` on the Vertex app. The run
has no rating and no levels: the desk verdict is a research label in a ``decision`` event
and can never authorize, create or size a trade. The write key is read from a file and
never printed.

Usage::

    python -m agents.inthemoneyadam_record --kb PATH --kb-commit SHA --ticker AMD \
        --origin https://vertex.example --key-file ~/.config/vertex/autopilot-agent-key
"""
from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agents.inthemoneyadam_desk import DESK_ID, DeskOutput, load_corpus, run_desk

ALLOWED_PROCEDURES = ("record", "appendEvents", "update")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuses every redirect: urllib would resend the x-api-key header to the new location."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any,
                         newurl: str) -> None:
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def build_events(output: DeskOutput) -> list[dict[str, object]]:
    """Plain-text events: one decision, one tool_result per citation, one research-only flag."""
    decision = {
        "verdict": output.verdict,
        "method": output.verdict_method,
        "research_only": output.research_only,
        "can_authorize_trade": output.can_authorize_trade,
        "notice": output.notice,
        "ticker_findings": [f.model_dump() for f in output.ticker_findings],
        "risks": [f.model_dump() for f in output.risks],
        "criteria_checked": [f.model_dump() for f in output.criteria_checked],
        "kb_commit": output.kb_commit,
    }
    events: list[dict[str, object]] = [
        {"agent": DESK_ID, "kind": "decision", "seq": 0, "title": f"Verdict: {output.verdict} (research only)",
         "body": json.dumps(decision, ensure_ascii=False)[:16_000]},
    ]
    for index, citation in enumerate(output.citations, start=1):
        events.append({
            "agent": DESK_ID, "kind": "tool_result", "seq": index, "toolName": "kb_citation",
            "title": f"{citation.title[:200]} @ {citation.timestamp}",
            "body": json.dumps(citation.model_dump(), ensure_ascii=False),
        })
    events.append({"agent": DESK_ID, "kind": "flag", "seq": len(events), "title": "research_only"})
    return events


def _call(origin: str, key: str, procedure: str, payload: dict[str, object]) -> dict[str, object]:
    if procedure not in ALLOWED_PROCEDURES:
        raise ValueError(f"procedure {procedure} is not allowed")
    request = urllib.request.Request(
        f"{origin.rstrip('/')}/api/orpc/agentModelRuns/{procedure}",
        data=json.dumps({"json": payload}).encode(),
        headers={"x-api-key": key, "origin": origin.rstrip("/"), "content-type": "application/json",
                 "user-agent": "vertex-inthemoneyadam-desk/1.0"},
        method="POST",
    )
    try:
        with _NO_REDIRECT_OPENER.open(request, timeout=30) as response:  # noqa: S310 - operator-supplied https origin
            body = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read()[:500].decode("utf-8", "replace").replace(key, "<key>")
        raise RuntimeError(f"{procedure} failed with HTTP {error.code}: {detail}") from None
    result = body.get("json", body)
    if not isinstance(result, dict):
        raise RuntimeError(f"unexpected {procedure} response")
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Record one In The Money Adam desk run (research only)")
    parser.add_argument("--kb", required=True, type=Path)
    parser.add_argument("--kb-commit", required=True)
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--thesis")
    parser.add_argument("--origin", required=True)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args(argv)
    if not args.origin.startswith("https://"):
        raise SystemExit("--origin must be https")
    started = datetime.now(UTC)
    output = run_desk(load_corpus(args.kb, args.kb_commit), args.ticker, args.thesis)
    key = args.key_file.expanduser().read_text(encoding="utf-8").strip()
    day = started.date().isoformat()
    run = _call(args.origin, key, "record", {
        "runKey": f"itma-{output.ticker}-{day}-{started.strftime('%H%M%S')}",
        "framework": "inthemoneyadam_desk", "frameworkVersion": "1.0.0+kb." + args.kb_commit[:12],
        "provider": "local", "model": "extractive-kb", "ticker": output.ticker, "decisionDate": day,
        "analysts": [DESK_ID], "status": "running", "flags": ["research_only"], "purpose": "live",
    })
    run_id = str(run["id"])
    _call(args.origin, key, "appendEvents", {"runId": run_id, "events": build_events(output)})
    finished = datetime.now(UTC)
    _call(args.origin, key, "update", {
        "id": run_id, "status": "succeeded", "llmCalls": 0, "toolCalls": len(output.citations),
        "costUsd": 0, "durationMs": int((finished - started).total_seconds() * 1000),
    })
    print(json.dumps({"runId": run_id, "verdict": output.verdict, "citations": len(output.citations)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
