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
import re
import sys
import zlib
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))

from strategies.leveraged_etf import liquidity, spread_gate  # noqa: E402

SCHEMA = "leveraged-etf-option-gate-v2"
# Stage 2: one label per expiry type and the session diagnostics. Stage 1 documents have
# no `schemaRevision`.
SCHEMA_REVISION = 2
RUN_SCHEMA = "leveraged-etf-spread-run-v1"
LABELS = ("pass", "fail", "spread-not-measured")
UNIVERSE_REASONS = ("no-listed-options", "no-standard-contract")  # of a fund without listed options
# A stored file of a run that cannot be read: not there, cut, no gzip, no JSON, or not the expected shape.
_SYMBOL = re.compile(r"[A-Z][A-Z0-9.]{0,9}")  # with fullmatch, as spread_reads.py: a symbol is a file name
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
        if day_folder.name == day.isoformat() and first <= day <= last and day_folder.is_dir():
            out.extend((day, folder) for folder in sorted(day_folder.iterdir()) if folder.is_dir())
    return out


def read_run(folder: Path, day: date, record: dict) -> Run:
    """The facts and the observations of one run. The session expiry is the one of the rule for the day of the
    run, so a changed expiry rule measures the stored chains again. Raises one of UNREADABLE."""
    if record["cboeScope"] not in ("all", "candidates"):  # the fund list of the run: every fund, or candidates
        raise ValueError(f"run.json has the Cboe scope {record['cboeScope']!r}")
    run = Run(run_id=f"{folder.parent.name}/{folder.name}", day=day)
    expiry = spread_gate.session_expiry(day)
    for symbol, fund in record["funds"].items():
        if not _SYMBOL.fullmatch(symbol):  # the key becomes a file name below
            raise ValueError(f"run.json has the fund key {symbol!r}, which is no symbol")
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
            spot, band = cboe["spot"], cboe["bandOpenInterest"]
            if band is not None and (isinstance(band, bool) or not isinstance(band, int)):
                raise ValueError(f"{symbol}: bandOpenInterest {band!r} is no whole number")
            run.facts[symbol] = spread_gate.FundFacts(
                file_timestamp=utc(cboe["fileTimestamp"]), fetched_at=utc(cboe["fetchedAt"]),
                session_expiry=date.fromisoformat(record["sessionExpiry"]), has_expiry=cboe["hasExpiry"] is True,
                band_open_interest=band, spot=float(spot) if spot is not None else 0.0,
                no_standard_contract=cboe["status"] == "no-standard-contract")
            run.spots[symbol] = spot
        if fund["candidate"] and yahoo["status"] in ("ok", "no-quotes"):
            stored = json.loads((folder / "yahoo" / f"{symbol}.json").read_text(encoding="utf-8"))
            utc(stored["fetchedAt"])  # null or another shape: the file cannot be read
            seen = spread_gate.yahoo_observation(stored, run.run_id)
            if seen is not None and stored["expiry"] == expiry.isoformat():
                run.yahoo[symbol] = seen
    return run


def read_store(store: Path, build_day: date) -> tuple[list[dict], list[Run]]:
    """(the `runs` list of the result, the used runs in time order) of the run folders of the lookback."""
    # One session more than the lookback: the oldest judged session then has the Cboe files of the session before
    # it (fund_sessions counts a Cboe file only once). Stage 1 loaded exactly the lookback.
    lookback = spread_gate.sessions_back(build_day, spread_gate.GATE_V2["sessionLookback"] + 1)
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
            "halfSpreadPct": read.half_spread_pct, "medianMidUsd": read.median_mid,
            "medianWidthUsd": read.median_width}


def session_entry(session: spread_gate.SessionResult) -> dict:
    other = None
    if session.other_source is not None:
        other = {"source": session.other_source, "countedReads": session.other_counted_reads,
                 "valuePct": session.other_value_pct}
    return {"day": session.day.isoformat(), "expiry": session.expiry.isoformat(), "source": session.source,
            "result": session.result, "valuePct": session.value_pct, "limitPct": session.limit_pct,
            "cheap": session.cheap, "inCheapBand": session.in_cheap_band, "medianMidUsd": session.median_mid,
            "expiryType": session.expiry_type, "worstReadPct": session.worst_read_pct,
            "readRangePct": session.read_range_pct, "medianWidthUsd": session.median_width,
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


def newest_run(symbol: str, runs: list[Run], kind: str | None = None) -> Run | None:
    """The newest run with a Cboe fact of the fund, of any expiry type (`kind` None) or among the runs whose
    session expiry has expiry type `kind`. A run reads the chain at the session expiry of its day, so a fact of a
    type says whether the fund lists an expiry of that type and how much open interest it has. A run that read
    only the candidates of an earlier run does not hide the fact of a fund that it did not read."""
    return next((run for run in reversed(runs) if symbol in run.facts
                 and (kind is None or spread_gate.expiry_type(run.facts[symbol].session_expiry) == kind)), None)


def facts_entry(symbol: str, run: Run | None) -> dict | None:
    if run is None:
        return None
    facts = run.facts[symbol]
    return {"chainFileTimestamp": utc_text(facts.file_timestamp), "chainFetchedAt": utc_text(facts.fetched_at),
            "sessionExpiry": facts.session_expiry.isoformat(), "hasExpiry": facts.has_expiry,
            "bandOpenInterest": facts.band_open_interest, "spot": run.spots[symbol]}


def type_label(fund: dict, runs: list[Run], sessions: list[spread_gate.SessionResult], build_day: date,
               kind: str) -> dict:
    """The type label `kind` of a fund: label, reasons, cheap band, the days of its judged sessions (at most 2),
    and the Cboe fact of the type."""
    symbol = fund["symbol"]
    newest = newest_run(symbol, runs) if fund["listed"] else None
    of_type = newest_run(symbol, runs, kind) if fund["listed"] else None
    label, reasons = spread_gate.fund_label(
        fund["listed"], fund["reasons"], newest.facts[symbol] if newest else None,
        of_type.facts[symbol] if of_type else None, sessions, build_day, kind)
    judged = spread_gate.judged_sessions(sessions, build_day, kind)
    return {"label": label, "reasons": reasons, "inCheapBand": in_cheap_band(label, reasons, judged),
            "judgedSessions": [item.day.isoformat() for item in judged], "facts": facts_entry(symbol, of_type)}


def fund_entry(fund: dict, runs: list[Run], build_day: date) -> dict:
    """One fund of the result: the newest Cboe fact of any type (the fund-wide facts and the freshness come from
    it) and one type label per expiry type. A reader picks the type label of the expiry type of its own trade day
    (expiry_type(session_expiry(day)))."""
    sessions = fund_sessions(fund["symbol"], runs) if fund["listed"] else []
    labels = {kind: type_label(fund, runs, sessions, build_day, kind) for kind in spread_gate.EXPIRY_TYPES}
    newest = newest_run(fund["symbol"], runs) if fund["listed"] else None
    return {"symbol": fund["symbol"], "facts": facts_entry(fund["symbol"], newest), "typeLabels": labels,
            "sessions": [session_entry(session) for session in sessions]}


def counts_of(funds: list[dict]) -> dict:
    """Per expiry type: the funds per label, the funds per reason and the funds in the cheap band; and the judged
    sessions and the counted reads per source."""
    by_type = {}
    for kind in spread_gate.EXPIRY_TYPES:
        labels = Counter(fund["typeLabels"][kind]["label"] for fund in funds)
        reasons = Counter(reason for fund in funds for reason in fund["typeLabels"][kind]["reasons"])
        by_type[kind] = {
            "byLabel": {label: labels[label] for label in LABELS},
            "byReason": {reason: reasons[reason] for reason in spread_gate.REASONS_V2 if reasons[reason]},
            "cheapBand": sum(1 for fund in funds if fund["typeLabels"][kind]["inCheapBand"])}
    sessions = [session for fund in funds for session in fund["sessions"]]
    judged = Counter(session["source"] for session in sessions if session["result"] != "not-judged")
    counted = Counter()
    for session in sessions:
        if session["source"] is not None:
            counted[session["source"]] += len(session["reads"])
        if session["otherSource"] is not None:
            counted[session["otherSource"]["source"]] += session["otherSource"]["countedReads"]
    return {"byType": by_type,
            "judgedSessionsBySource": {source: judged[source] for source in ("cboe", "yahoo")},
            "countedReadsBySource": {source: counted[source] for source in ("cboe", "yahoo")}}


def build(store: Path, universe_path: Path, build_day: date, built_at: datetime) -> dict:
    """The result document. Raises ValueError, KeyError, TypeError or OSError when the store or the universe
    file cannot be read."""
    universe_fact, universe_funds = read_universe(universe_path)
    listed, runs = read_store(store, build_day)
    funds = [fund_entry(fund, runs, build_day) for fund in universe_funds]
    return {"schema": SCHEMA, "schemaRevision": SCHEMA_REVISION, "builtAt": utc_text(built_at),
            "buildDay": build_day.isoformat(), "gate": dict(spread_gate.GATE_V2), "universe": universe_fact,
            "runs": listed, "counts": counts_of(funds), "funds": funds}


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
    """The result as tables: the runs, the counts with the list of the funds in the cheap band, the sessions
    by source, and one row per fund that has a judged session (its sessions newest first, one line per session in a cell)."""
    counts = document["counts"]
    lines = [f"# Leveraged ETF option gate version 2: {document['buildDay']}", "",
             f"Built at {document['builtAt']} from the universe file of {document['universe']['generatedAt']}. "
             "Research only. Each fund has one label per expiry type (monthly, weekly); a reader takes the label of "
             "the expiry type of its own trade day.", "", "## Runs", ""]
    lines += _table(["Run", "Used", "Skip reason", "Complete"],
                    [[run["runId"], run["used"], run["skipReason"], run["complete"]] for run in document["runs"]])
    lines += ["## Counts", ""]
    kinds = list(counts["byType"])

    def count_row(name: str, count_of) -> list:
        return [name] + [count_of(counts["byType"][kind]) for kind in kinds]

    lines += _table(["Label or reason"] + [f"Funds, {kind} type label" for kind in kinds],
                    [count_row(label, lambda of_type, label=label: of_type["byLabel"][label]) for label in LABELS]
                    + [count_row("funds in the cheap band", lambda of_type: of_type["cheapBand"])]
                    + [count_row(reason, lambda of_type, reason=reason: of_type["byReason"].get(reason, 0))
                       for reason in spread_gate.REASONS_V2])
    for kind in kinds:
        cheap = sorted(fund["symbol"] for fund in document["funds"] if fund["typeLabels"][kind]["inCheapBand"])
        lines += [f"Cheap band of the {kind} type label: {', '.join(cheap) or 'none'}", ""]
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

        def type_cell(kind: str) -> str:
            item = fund["typeLabels"][kind]
            parts = [item["label"], ", ".join(item["reasons"]), ", ".join(item["judgedSessions"])]
            return " ".join(part for part in parts if part)

        rows.append([fund["symbol"], type_cell("monthly"), type_cell("weekly"),
                     column(lambda session: session["day"]), column(lambda session: session["expiry"]),
                     column(lambda session: session["expiryType"]), column(lambda session: session["source"]),
                     column(lambda session: len(session["reads"])),
                     column(lambda session: session["valuePct"]), column(lambda session: session["worstReadPct"]),
                     column(lambda session: session["readRangePct"]),
                     column(lambda session: session["medianWidthUsd"]),
                     column(lambda session: (session["otherSource"] or {}).get("valuePct"))])
    lines += _table(["Symbol", "Monthly type label", "Weekly type label", "Day", "Expiry",
                     "Expiry type", "Source", "Counted reads", "Value %", "Worst read %", "Read range %",
                     "Width USD", "Other source value %"], rows)
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
    for kind, of_type in counts["byType"].items():
        print(f"{kind}: " + ", ".join(f"{label}: {count}" for label, count in of_type["byLabel"].items())
              + f"; cheap band: {of_type['cheapBand']}")
    print(f"runs used: {sum(1 for run in document['runs'] if run['used'])} of {len(document['runs'])}")
    print(args.out / "gate-v2.json")
    print(args.out / "gate-v2.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
