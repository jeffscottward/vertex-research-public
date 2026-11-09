"""Record the test fixtures from real upstream runs (developer tool; needs network, never run in CI).

    cd services/openbb
    set -a; . ~/.config/vertex/openbb.env; set +a      # SEC contact for the sec-* jobs
    python tests/record.py [job ...]                    # default: every job
    python tests/record.py --replay [job ...]           # offline: rebuild the documents only

For each job it runs the fetcher live with a RecordingUpstream, trims the recorded upstream payloads
(TRIM rules below; the trimmed payloads are still real upstream data), then replays the trimmed
recording through the same job code and writes:

- tests/fixtures/upstream/<job>.json: today, argv and the trimmed upstream calls (test input);
- tests/fixtures/<job>.json: the openbb-batch.v1 document of the replay (shared fixture: the
  expected output of the Python tests and a valid sample document for the TypeScript side).

The contact address is replaced in every recorded value and the files are checked to not hold it.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from vertex_openbb import cli  # noqa: E402
from vertex_openbb.context import CORE7, STOCKS  # noqa: E402
from vertex_openbb.jobs.sec import CUSIPS  # noqa: E402
from vertex_openbb.sec_guard import CONTACT_ENV  # noqa: E402
from vertex_openbb.upstream import RecordingUpstream, ReplayUpstream  # noqa: E402

FIXTURES = HERE / "fixtures"
TEST_CONTACT = "fixtures@example.invalid"

# argv per job: small symbol sets keep the fixtures small; everything else is the job default.
ARGV: dict[str, list[str]] = {
    "cboe-vol-indices": ["cboe-vol-indices"],
    "cboe-vx-curve": ["cboe-vx-curve"],
    "cboe-option-iv": ["cboe-option-iv", "--symbols", "SPY,GLD"],
    "cftc-cot": ["cftc-cot", "--symbols", "ES,VX,GC,CL"],
    "fed-rates": ["fed-rates"],
    "fed-regime": ["fed-regime"],
    "fed-events": ["fed-events"],
    "treasury-tga": ["treasury-tga"],
    "oecd-cli": ["oecd-cli"],
    "fred-keyless": ["fred-keyless"],
    "finra-otc": ["finra-otc", "--symbols", "SPY,AAPL,GLD"],
    "finra-short-interest": ["finra-short-interest", "--symbols", "SPY,AAPL"],
    "finra-short-volume": ["finra-short-volume"],
    "sec-filings": ["sec-filings", "--symbols", "AAPL,NVDA"],
    "sec-insider": ["sec-insider", "--symbols", "AAPL"],
    "sec-ftd": ["sec-ftd"],
    "sec-13f": ["sec-13f", "--filers", "1067983,1423053"],
    "famafrench": ["famafrench"],
}
DATE_KEYS = ("date", "week_start_date", "settlement_date", "filing_date", "auction_date", "period_ending", "month")
MAX_LIST = 60
UNIVERSE_CUSIPS = set(CUSIPS.values())
UNIVERSE_SYMBOLS = set(CORE7) | set(STOCKS)


def _date_of(row: Any) -> str:
    if isinstance(row, dict):
        for key in DATE_KEYS:
            if row.get(key):
                return str(row[key])
    return ""


def _drop_nulls(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _drop_nulls(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_drop_nulls(v) for v in value]
    return value


def _newest(rows: list[Any], limit: int) -> list[Any]:
    """Keep the `limit` newest rows (by their date field), in their original order."""
    if len(rows) <= limit:
        return rows
    keep = set(sorted(range(len(rows)), key=lambda i: _date_of(rows[i]), reverse=True)[:limit])
    return [row for i, row in enumerate(rows) if i in keep]


CHAIN_FIELDS = ("option", "iv", "delta", "gamma", "open_interest", "volume")


def _trim_chain(payload: dict[str, Any]) -> dict[str, Any]:
    """Keep the two nearest expirations, the two around 30 days and one near 60 days, strikes within
    4% of spot, the fields the job reads, and a few non-OCC rows (B1SPY...) for the skip path."""
    data = payload.get("data") or {}
    spot = float(data.get("current_price") or data.get("close") or 0)
    parsed, odd = [], []
    for option in data.get("options") or []:
        symbol = str(option.get("option") or "")
        head, tail = symbol[:-15], symbol[-15:]
        slim = {k: option.get(k) for k in CHAIN_FIELDS}
        if not head.isalpha():
            odd.append(slim)
            continue
        try:
            expiry = date(2000 + int(tail[0:2]), int(tail[2:4]), int(tail[4:6]))
            strike = int(tail[7:15]) / 1000
        except ValueError:
            continue
        parsed.append((expiry, strike, slim))
    expiries = sorted({e for e, _, _ in parsed if e >= TODAY})
    days = {e: (e - TODAY).days for e in expiries}
    keep = set(expiries[:2])
    keep |= {max((e for e in expiries if days[e] <= 30), default=None), min((e for e in expiries if days[e] >= 30), default=None)}
    keep.add(min(expiries, key=lambda e: abs(days[e] - 60), default=None))
    kept = [slim for e, k, slim in parsed if e in keep and abs(k - spot) <= 0.04 * spot]
    return {**payload, "data": {**{k: v for k, v in data.items() if k != "options"}, "options": odd[:4] + kept}}


def _trim_text_tail(text: str, lines: int) -> str:
    rows = text.splitlines()
    return "\n".join(rows[:1] + rows[1:][-lines:]) + "\n"


def _trim_regsho(text: str) -> str:
    rows = text.splitlines()
    kept = rows[:1]
    others = 0
    for line in rows[1:]:
        parts = line.split("|")
        if len(parts) > 1 and parts[1] in UNIVERSE_SYMBOLS:
            kept.append(line)
        elif others < 3:
            kept.append(line)
            others += 1
    return "\n".join(kept) + "\n"


def _trim_13f(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = sorted(rows, key=lambda r: -float(r.get("value") or 0))
    top = {id(r) for r in ranked[:60]}
    tail = {id(r) for r in ranked[60:80]}
    return [r for r in rows if r.get("cusip") in UNIVERSE_CUSIPS or id(r) in top or id(r) in tail]


def trim(key: str, result: Any) -> Any:
    if key.startswith("helper:cboe:options_chain:"):
        return _trim_chain(result)
    if key.startswith("http:https://cdn.finra.org/"):
        return None if result is None else _trim_regsho(result)
    if key.startswith("http:https://www.sec.gov/data-research/"):
        links = [line.strip() for line in (result or "").splitlines() if "cnsfails" in line]
        return "\n".join(links[:8]) + "\n"
    if key.startswith("http:https://www.treasurydirect.gov/"):
        fields = ("cusip", "securityType", "securityTerm", "auctionDate", "competitiveAuctionCloseDate",
                  "announcementDate", "issueDate", "offeringAmount", "reopening", "closingTimeCompetitive",
                  "highYield", "highRate", "highInvestmentRate", "interestRate", "bidToCoverRatio", "totalAccepted")
        return json.dumps([{k: r[k] for k in fields if k in r} for r in json.loads(result or "[]")])
    if key.startswith("http:https://fred.stlouisfed.org/"):
        return None if result is None else _trim_text_tail(result, 25)
    if key == "helper:federal_reserve:release_schedule":
        low, high = (TODAY - timedelta(days=35)).isoformat(), (TODAY + timedelta(days=30)).isoformat()
        return [r for r in result if low <= str(r.get("date")) <= high]
    if key == "helper:federal_reserve:events_calendar":
        low = (TODAY - timedelta(days=62)).isoformat()[:7]
        return [e for e in result if str(e.get("month") or "") >= low]
    if key.startswith("helper:famafrench:"):
        return result[-90:] if ":daily" in key else result[-6:]
    if key.startswith("helper:sec:13f:"):
        return _drop_nulls(_trim_13f(result))
    if key.startswith("fetcher:sec:CompanyFilings:"):
        return _drop_nulls(result[:12])
    if key.startswith("fetcher:finra:"):
        return _drop_nulls(_newest(result, 12))
    if key.startswith("helper:sec:ftd:"):
        return _newest(result, 150)
    if isinstance(result, list):
        return _drop_nulls(_newest(result, MAX_LIST))
    return result


def scrub(value: Any, secret: str) -> Any:
    text = json.dumps(value)
    if secret:
        text = text.replace(secret, TEST_CONTACT)
    return json.loads(text)


TODAY = date.today()


def record(job: str, env: dict[str, str]) -> None:
    global TODAY  # noqa: PLW0603 - one recording day per run
    TODAY = cli.new_york_today()
    argv = ARGV[job]
    secret = env.get(CONTACT_ENV, "")
    live = RecordingUpstream(scrub=(secret,))
    if job.startswith("sec-"):  # cli.run installs the guard only for its own live Upstream
        from vertex_openbb import sec_guard

        sec_guard.install(sec_guard.user_agent(env))
    out, err = io.StringIO(), io.StringIO()
    code = cli.run(argv, env=env, up=live, today=TODAY, stdout=out, stderr=err)
    if code not in (0, 3):
        raise SystemExit(f"{job}: live run exited {code}: {err.getvalue()[-2000:]}")
    calls = []
    for item in live.records:
        entry = dict(item)
        if "result" in entry:
            entry["result"] = trim(entry["key"], entry["result"])
        calls.append(scrub(entry, secret))
    replay_env = {CONTACT_ENV: TEST_CONTACT} if job.startswith("sec-") else {}
    replay_out, replay_err = io.StringIO(), io.StringIO()
    replay_code = cli.run(argv, env=replay_env, up=ReplayUpstream(calls), today=TODAY, stdout=replay_out, stderr=replay_err)
    if replay_code != 0:
        raise SystemExit(f"{job}: replay exited {replay_code}: {replay_err.getvalue()[-2000:]}")
    document = json.loads(replay_out.getvalue())
    upstream = {"job": job, "today": TODAY.isoformat(), "argv": argv, "env": replay_env, "exitCode": replay_code, "calls": calls}
    (FIXTURES / "upstream").mkdir(parents=True, exist_ok=True)
    for path, value in ((FIXTURES / "upstream" / f"{job}.json", upstream), (FIXTURES / f"{job}.json", document)):
        text = json.dumps(value, indent=1, ensure_ascii=False, allow_nan=False) + "\n"
        if secret and secret in text:
            raise SystemExit(f"{job}: contact address would be written to {path}")
        path.write_text(text, encoding="utf-8")
    counts = ", ".join(f"{t['table']}={len(t['rows'])}" for t in document["tables"])
    print(f"{job}: live exit {code}, {len(calls)} calls; fixture {counts}; warnings {len(document['warnings'])}")


def replay(job: str) -> None:
    """Rebuild tests/fixtures/<job>.json from the recorded upstream calls (no network)."""
    upstream = json.loads((FIXTURES / "upstream" / f"{job}.json").read_text(encoding="utf-8"))
    out, err = io.StringIO(), io.StringIO()
    code = cli.run(
        upstream["argv"], env=upstream["env"], up=ReplayUpstream(upstream["calls"]),
        today=date.fromisoformat(upstream["today"]), stdout=out, stderr=err,
    )
    if code != 0:
        raise SystemExit(f"{job}: replay exited {code}: {err.getvalue()[-2000:]}")
    document = json.loads(out.getvalue())
    (FIXTURES / f"{job}.json").write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{job}: replayed")


def main(jobs: list[str]) -> None:
    env = dict(os.environ)
    if jobs[:1] == ["--replay"]:  # code change only: re-derive the expected documents offline
        for job in jobs[1:] or list(ARGV):
            replay(job)
    else:
        for job in jobs or list(ARGV):
            record(job, env)
    # The repository formats every JSON file with Biome; write the fixtures in that format.
    biome = HERE.parents[2] / "node_modules" / ".bin" / "biome"
    if biome.exists():
        subprocess.run([str(biome), "format", "--write", str(FIXTURES)], check=True, capture_output=True)
    else:
        print("biome not found: run `biome format --write services/openbb/tests/fixtures`")


if __name__ == "__main__":
    main(sys.argv[1:])
