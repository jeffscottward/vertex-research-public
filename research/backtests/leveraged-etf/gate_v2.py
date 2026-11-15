"""Leveraged ETF option gate version 2: the build (research only, no network). It never places orders.

Reads the run folders that spread_reads.py stored and the universe file, applies the rule of
services/research/strategies/leveraged_etf/spread_gate.py, and writes one result per fund:

  gate-v2.json   the result document (schema leveraged-etf-option-gate-v2)
  gate-v2.md     the same as tables

  python3 research/backtests/leveraged-etf/gate_v2.py --store ~/.local/share/vertex/leveraged-etf-spreads \
      --universe ~/.local/share/vertex/leveraged-etf-spreads-universe.json --out <folder>

--as-of YYYY-MM-DD is the build day; without it the New York day of the clock. The build reads the run
folders of the last 5 NYSE sessions up to the build day. Every run folder of these days is in `runs` of the
result, as used or as skipped with the reason:

  no-run-json         the folder has no run.json
  unreadable          run.json or a stored file of the run is not valid JSON or gzip
  unknown-schema      run.json is of another schema
  outside-session     the run was made with --outside-session
  not-a-session-day   the day of the run is no NYSE session

A run with `complete` false is used. The result is a function of the store, the universe file, the build
day and the rule: a changed rule measures the stored runs again. Both files are local research data; they
are not committed. Design: docs/specs/research/leveraged-etf-option-gate-v2.md.

Exit 0. Exit 1: the store or the universe file cannot be read. Exit 2: wrong arguments.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import zlib
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))

from strategies.leveraged_etf import liquidity, spread_gate  # noqa: E402

SCHEMA = "leveraged-etf-option-gate-v2"
RUN_SCHEMA = "leveraged-etf-spread-run-v1"
LABELS = ("pass", "fail", "spread-not-measured")
UNIVERSE_REASONS = ("no-listed-options", "no-standard-contract")  # of a fund without listed options
# A stored file of a run that cannot be read: not there, cut, no gzip, no JSON, or not the expected shape.
UNREADABLE = (OSError, EOFError, zlib.error, ValueError, KeyError, TypeError, AttributeError)


class Run:
    """What one used run folder says about the funds. No dataclass: a script that is loaded from its file is
    not in sys.modules, and dataclasses needs the module there."""

    def __init__(self, run_id: str, day: date) -> None:
        self.run_id = run_id
        self.day = day
        self.facts: dict = {}  # symbol -> spread_gate.FundFacts
        self.spots: dict = {}  # symbol -> the fund price of the fact; None when there is none
        self.cboe: dict = {}  # symbol -> spread_gate.CboeObservation
        self.yahoo: dict = {}  # symbol -> spread_gate.YahooObservation


def utc(text) -> datetime:
    return datetime.strptime(str(text), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def utc_text(stamp: datetime | None) -> str | None:
    return liquidity.utc_text(stamp) if stamp is not None else None


def read_universe(path: Path) -> tuple[dict, list[dict]]:
    """(the `universe` object of the result, the funds sorted by symbol) of a universe file. Raises ValueError,
    KeyError, TypeError or OSError when the file cannot be read."""
    document = json.loads(path.read_text(encoding="utf-8"))
    funds = [{"symbol": str(fund["symbol"]), "listed": fund["optionsListed"] is True,
              "reasons": [reason for reason in fund.get("optionGateReasons") or [] if reason in UNIVERSE_REASONS]}
             for fund in document["funds"]]
    if len({fund["symbol"] for fund in funds}) != len(funds):
        raise ValueError("the universe file has a symbol twice")
    return ({"path": str(path.resolve()), "generatedAt": utc_text(utc(document["generatedAt"]))},
            sorted(funds, key=lambda fund: fund["symbol"]))


def run_folders(store: Path, first: date, last: date) -> list[tuple[date, Path]]:
    """(day, folder) of the run folders of the days `first` to `last`, in time order. Raises OSError when the
    store cannot be read."""
    out = []
    for day_folder in sorted(store.iterdir()):
        try:
            day = date.fromisoformat(day_folder.name)
        except ValueError:
            continue
        if first <= day <= last and day_folder.is_dir():
            out.extend((day, folder) for folder in sorted(day_folder.iterdir()) if folder.is_dir())
    return out


def read_run(folder: Path, day: date, record: dict) -> Run:
    """The facts and the observations of one run. The session expiry is the one of the rule for the day of the
    run, so a changed expiry rule measures the stored chains again. Raises one of UNREADABLE."""
    run = Run(run_id=f"{folder.parent.name}/{folder.name}", day=day)
    expiry = spread_gate.session_expiry(day)
    for symbol, fund in record["funds"].items():
        cboe, yahoo = fund["cboe"], fund["yahoo"]
        if fund["candidate"]:
            chain = json.loads(gzip.decompress((folder / "cboe" / f"{symbol}.json.gz").read_bytes()))
            seen = spread_gate.cboe_observation(chain, symbol, expiry, run.run_id, utc(cboe["fetchedAt"]))
            if isinstance(seen, liquidity.NoOptions):
                raise ValueError(f"the stored chain of the candidate {symbol} has no standard contract")
            run.facts[symbol] = spread_gate.FundFacts(
                file_timestamp=seen.file_timestamp, fetched_at=seen.fetched_at, session_expiry=expiry,
                has_expiry=seen.has_expiry, band_open_interest=seen.measure.band_open_interest if seen.measure else None,
                spot=seen.spot, no_standard_contract=False)
            run.spots[symbol] = seen.spot
            if seen.has_expiry:
                run.cboe[symbol] = seen
        elif cboe["status"] in ("ok", "no-standard-contract"):
            spot = cboe["spot"]
            run.facts[symbol] = spread_gate.FundFacts(
                file_timestamp=utc(cboe["fileTimestamp"]), fetched_at=utc(cboe["fetchedAt"]),
                session_expiry=date.fromisoformat(record["sessionExpiry"]), has_expiry=cboe["hasExpiry"] is True,
                band_open_interest=cboe["bandOpenInterest"], spot=float(spot) if spot is not None else 0.0,
                no_standard_contract=cboe["status"] == "no-standard-contract")
            run.spots[symbol] = spot
        if fund["candidate"] and yahoo["status"] in ("ok", "no-quotes"):
            stored = json.loads((folder / "yahoo" / f"{symbol}.json").read_text(encoding="utf-8"))
            seen = spread_gate.yahoo_observation(stored, run.run_id)
            if seen is not None and stored["expiry"] == expiry.isoformat():
                run.yahoo[symbol] = seen
    return run


def read_store(store: Path, build_day: date) -> tuple[list[dict], list[Run]]:
    """(the `runs` list of the result, the used runs in time order) of the run folders of the lookback."""
    lookback = spread_gate.sessions_back(build_day, spread_gate.GATE_V2["sessionLookback"])
    listed, used = [], []
    for day, folder in run_folders(store, lookback[-1], build_day):
        entry = {"runId": f"{folder.parent.name}/{folder.name}", "used": False, "skipReason": None, "complete": None}
        listed.append(entry)
        if not (folder / "run.json").is_file():
            entry["skipReason"] = "no-run-json"
            continue
        try:
            record = json.loads((folder / "run.json").read_text(encoding="utf-8"))
            schema = record.get("schema")
        except (OSError, ValueError, AttributeError):
            entry["skipReason"] = "unreadable"
            continue
        if schema != RUN_SCHEMA:
            entry["skipReason"] = "unknown-schema"
            continue
        entry["complete"] = record.get("complete") is True
        if record.get("outsideSession") is not False:
            entry["skipReason"] = "outside-session"
        elif day not in lookback:
            entry["skipReason"] = "not-a-session-day"
        else:
            try:
                if record["runId"] != entry["runId"] or record["sessionDay"] != day.isoformat():
                    raise ValueError("run.json is of another folder")
                used.append(read_run(folder, day, record))
                entry["used"] = True
            except UNREADABLE:
                entry["skipReason"] = "unreadable"
    return listed, used


def read_entry(read: spread_gate.Read) -> dict:
    return {"runId": read.run_id, "source": read.source, "fetchedAt": utc_text(read.fetched_at),
            "quoteTime": utc_text(read.quote_time), "twoSidedQuotes": read.two_sided_quotes,
            "halfSpreadPct": read.half_spread_pct, "medianMidUsd": read.median_mid}


def session_entry(session: spread_gate.SessionResult) -> dict:
    other = None
    if session.other_source is not None:
        other = {"source": session.other_source, "countedReads": session.other_counted_reads,
                 "valuePct": session.other_value_pct}
    return {"day": session.day.isoformat(), "expiry": session.expiry.isoformat(), "source": session.source,
            "result": session.result, "valuePct": session.value_pct, "limitPct": session.limit_pct,
            "cheap": session.cheap, "inCheapBand": session.in_cheap_band, "medianMidUsd": session.median_mid,
            "reads": [read_entry(read) for read in session.reads], "otherSource": other}


def fund_sessions(symbol: str, runs: list[Run]) -> list[spread_gate.SessionResult]:
    """The sessions in which the fund has an observation, newest first. A Cboe file counts for a session only
    when no run of a session before it had the same file timestamp."""
    days = sorted({run.day for run in runs if symbol in run.cboe or symbol in run.yahoo}, reverse=True)
    out = []
    for day in days:
        seen = frozenset(run.facts[symbol].file_timestamp for run in runs if run.day < day and symbol in run.facts)
        of_day = [run for run in runs if run.day == day]
        cboe_reads, yahoo_reads = spread_gate.counted_reads(
            day, [run.cboe[symbol] for run in of_day if symbol in run.cboe],
            [run.yahoo[symbol] for run in of_day if symbol in run.yahoo], seen)
        out.append(spread_gate.session_result(day, spread_gate.session_expiry(day), cboe_reads, yahoo_reads))
    return out


def in_cheap_band(label: str, reasons: list[str], judged: list[spread_gate.SessionResult]) -> bool:
    """A fund is in the cheap band when its only fail reason is the spread, and each of its 2 sessions is
    inside the limit or in the cheap band."""
    return (label == "fail" and reasons == ["spread-above-maximum"]
            and all(item.result == "inside-limit" or item.in_cheap_band is True for item in judged))


def fund_entry(fund: dict, runs: list[Run], build_day: date) -> dict:
    symbol = fund["symbol"]
    newest = next((run for run in reversed(runs) if symbol in run.facts), None) if fund["listed"] else None
    facts = newest.facts[symbol] if newest else None
    sessions = fund_sessions(symbol, runs) if fund["listed"] else []
    label, reasons = spread_gate.fund_label(fund["listed"], fund["reasons"], facts, sessions, build_day)
    return {
        "symbol": symbol, "optionGate": label, "optionGateReasons": reasons,
        "inCheapBand": in_cheap_band(label, reasons, spread_gate.judged_sessions(sessions, build_day)),
        "facts": None if facts is None else {
            "chainFileTimestamp": utc_text(facts.file_timestamp), "chainFetchedAt": utc_text(facts.fetched_at),
            "sessionExpiry": facts.session_expiry.isoformat(), "hasExpiry": facts.has_expiry,
            "bandOpenInterest": facts.band_open_interest, "spot": newest.spots[symbol]},
        "sessions": [session_entry(session) for session in sessions]}


def counts_of(funds: list[dict]) -> dict:
    labels = Counter(fund["optionGate"] for fund in funds)
    reasons = Counter(reason for fund in funds for reason in fund["optionGateReasons"])
    sessions = [session for fund in funds for session in fund["sessions"]]
    judged = Counter(session["source"] for session in sessions if session["result"] != "not-judged")
    counted = Counter()
    for session in sessions:
        if session["source"] is not None:
            counted[session["source"]] += len(session["reads"])
        if session["otherSource"] is not None:
            counted[session["otherSource"]["source"]] += session["otherSource"]["countedReads"]
    return {"byLabel": {label: labels[label] for label in LABELS},
            "byReason": {reason: reasons[reason] for reason in spread_gate.REASONS_V2 if reasons[reason]},
            "cheapBand": sum(1 for fund in funds if fund["inCheapBand"]),
            "judgedSessionsBySource": {source: judged[source] for source in ("cboe", "yahoo")},
            "countedReadsBySource": {source: counted[source] for source in ("cboe", "yahoo")}}


def build(store: Path, universe_path: Path, build_day: date, built_at: datetime) -> dict:
    """The result document. Raises ValueError, KeyError, TypeError or OSError when the store or the universe
    file cannot be read."""
    universe_fact, universe_funds = read_universe(universe_path)
    listed, runs = read_store(store, build_day)
    funds = [fund_entry(fund, runs, build_day) for fund in universe_funds]
    return {"schema": SCHEMA, "builtAt": utc_text(built_at), "buildDay": build_day.isoformat(),
            "gate": dict(spread_gate.GATE_V2), "universe": universe_fact, "runs": listed, "counts": counts_of(funds),
            "funds": funds}


def _cell(value) -> str:
    """A table cell: numbers without a trailing ".0", nothing for null."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    return f"{value:g}" if isinstance(value, float) else str(value)


def _table(header: list[str], rows: list[list]) -> list[str]:
    lines = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
    lines.extend("| " + " | ".join(_cell(value) for value in row) + " |" for row in rows)
    return lines + [""]


def markdown(document: dict) -> str:
    """The result as tables: the runs, the counts, the sessions by source, and one row per fund that has a
    judged session (its sessions newest first, one line per session in a cell)."""
    counts = document["counts"]
    lines = [f"# Leveraged ETF option gate version 2: {document['buildDay']}", "",
             f"Built at {document['builtAt']} from the universe file of {document['universe']['generatedAt']}. "
             "Research only.", "", "## Runs", ""]
    lines += _table(["Run", "Used", "Skip reason", "Complete"],
                    [[run["runId"], run["used"], run["skipReason"], run["complete"]] for run in document["runs"]])
    lines += ["## Counts", ""]
    lines += _table(["Label or reason", "Funds"],
                    [[label, count] for label, count in counts["byLabel"].items()]
                    + [["funds in the cheap band", counts["cheapBand"]]]
                    + [[reason, count] for reason, count in counts["byReason"].items()])
    lines += ["## Sessions by source", ""]
    lines += _table(["Source", "Judged sessions", "Counted reads"],
                    [[source, counts["judgedSessionsBySource"][source], counts["countedReadsBySource"][source]]
                     for source in ("cboe", "yahoo")])
    lines += ["## Funds", ""]
    rows = []
    for fund in document["funds"]:
        sessions = fund["sessions"]
        if not any(session["result"] != "not-judged" for session in sessions):
            continue

        def column(value_of) -> str:
            return "<br>".join(_cell(value_of(session)) for session in sessions)

        rows.append([fund["symbol"], fund["optionGate"], ", ".join(fund["optionGateReasons"]),
                     column(lambda session: session["day"]), column(lambda session: session["expiry"]),
                     column(lambda session: session["source"]), column(lambda session: len(session["reads"])),
                     column(lambda session: session["valuePct"]), column(lambda session: session["limitPct"]),
                     column(lambda session: (session["otherSource"] or {}).get("valuePct"))])
    lines += _table(["Symbol", "Label", "Reasons", "Day", "Expiry", "Source", "Counted reads", "Value %", "Limit %",
                     "Other source value %"], rows)
    return "\n".join(lines)


def write_text(path: Path, text: str) -> None:
    """Writes `<name>.part` and renames it, so a killed build leaves no half file."""
    partial = path.with_name(path.name + ".part")
    partial.write_text(text, encoding="utf-8")
    partial.replace(path)


def main(argv=None, now=None) -> int:
    parser = argparse.ArgumentParser(description="Build the result of the leveraged ETF option gate version 2.")
    parser.add_argument("--store", type=Path, required=True, help="folder of the run folders of spread_reads.py")
    parser.add_argument("--universe", type=Path, required=True, help="universe file (the document of universe.py)")
    parser.add_argument("--out", type=Path, required=True, help="folder for gate-v2.json and gate-v2.md")
    parser.add_argument("--as-of", type=date.fromisoformat, default=None,
                        help="build day YYYY-MM-DD; default the New York day of the clock")
    try:
        args = parser.parse_args(argv)
    except SystemExit as stop:
        return 0 if stop.code == 0 else 2
    built_at = (now or (lambda: datetime.now(timezone.utc)))()
    build_day = args.as_of or built_at.astimezone(liquidity.NEW_YORK).date()
    try:
        document = build(args.store, args.universe, build_day, built_at)
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(f"the store or the universe file cannot be read: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    args.out.mkdir(parents=True, exist_ok=True)
    write_text(args.out / "gate-v2.json", json.dumps(document, indent=1))
    write_text(args.out / "gate-v2.md", markdown(document))
    counts = document["counts"]
    print(", ".join(f"{label}: {count}" for label, count in counts["byLabel"].items())
          + f"; cheap band: {counts['cheapBand']}; runs used: {sum(1 for run in document['runs'] if run['used'])} "
          f"of {len(document['runs'])}")
    print(args.out / "gate-v2.json")
    print(args.out / "gate-v2.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
