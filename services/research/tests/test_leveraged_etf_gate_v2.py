"""research/backtests/leveraged-etf/gate_v2.py: the build of the option gate version 2. The store is made in a
temporary folder; no network."""
from __future__ import annotations

import gzip
import importlib.util
import json
import socket
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "research" / "backtests" / "leveraged-etf" / "gate_v2.py"
_spec = importlib.util.spec_from_file_location("leveraged_etf_gate_v2", SCRIPT)
gate_v2 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate_v2)

MONDAY, TUESDAY, EXPIRY = "2026-11-16", "2026-11-17", "2026-11-20"
BUILD_DAY = date(2026, 11, 17)
BUILT_AT = datetime(2026, 11, 17, 20, 10, tzinfo=UTC)
OLD_FILE = "2026-11-16 14:00:00"  # 09:00 New York: its quotes are before the entry hours, so it never counts
# Fund -> the quotes of each of the 4 runs (Monday 10:45 and 12:45, Tuesday 10:45 and 12:45 New York):
# (Cboe bid, ask, a new Cboe file in this run, Yahoo bid, ask). None: Cboe had no chain file in that run.
QUOTES = {
    "AAA": [(1.95, 2.05, True, 1.96, 2.04), (1.94, 2.06, True, 1.98, 2.02)] * 2,  # Cboe 2.5% and 3%, Yahoo 2% and 1%
    "BBB": [(0.4, 0.6, False, 0.47, 0.53), (0.4, 0.6, False, 0.48, 0.52),  # Monday: Yahoo 6% and 4% at 0.50 USD
            (0.4, 0.6, False, 0.49, 0.51), (0.4, 0.6, False, 0.48, 0.52)],  # Tuesday: 2% and 4%
    "CCC": [(1.5, 2.5, False, 1.9, 2.1), (1.5, 2.5, False, 1.88, 2.12)] * 2,  # Yahoo 5% and 6% at 2 USD
    "DDD": [(1.9, 2.1, True, None, None)] * 4,  # 800 contracts in the band: no candidate
    "EEE": [None, None, (1.5, 2.5, False, 1.96, 2.04), (1.5, 2.5, False, 1.98, 2.02)],
}
RUNS = [(MONDAY, "154501Z"), (MONDAY, "174501Z"), (TUESDAY, "154501Z"), (TUESDAY, "174501Z")]


def stamp(day: str, name: str, minutes: int = 0) -> datetime:
    return datetime.strptime(f"{day} {name}", "%Y-%m-%d %H%M%SZ").replace(tzinfo=UTC) + timedelta(minutes=minutes)


def text(when: datetime) -> str:
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def cboe_body(symbol: str, bid: float, ask: float, open_interest: int, file_timestamp: str) -> bytes:
    options = [{"option": f"{symbol}261120{side}{strike * 1000:08d}", "bid": bid, "ask": ask,
                "open_interest": open_interest} for strike in (48, 49, 50, 51) for side in "CP"]
    return json.dumps({"timestamp": file_timestamp, "symbol": symbol,
                       "data": {"symbol": symbol, "current_price": 50.0, "options": options}}).encode()


def write_run(store: Path, day: str, name: str, index: int, **changes) -> Path:
    """One run folder with the quotes of run `index` of QUOTES."""
    folder = store / day / name
    (folder / "cboe").mkdir(parents=True)
    (folder / "yahoo").mkdir()
    started, funds = stamp(day, name), {}
    for symbol, quotes in QUOTES.items():
        if quotes[index] is None:
            funds[symbol] = {"candidate": False,
                             "cboe": {"status": "no-file", "fetchedAt": text(started), "fileTimestamp": None,
                                      "hasExpiry": None, "bandOpenInterest": None, "spot": None, "error": None},
                             "yahoo": {"status": "not-requested", "fetchedAt": None, "error": None}}
            continue
        bid, ask, new_file, yahoo_bid, yahoo_ask = quotes[index]
        candidate = symbol != "DDD"
        file_time = stamp(day, name, -5) if new_file else datetime(2026, 11, 16, 14, 0, tzinfo=UTC)
        funds[symbol] = {
            "candidate": candidate,
            "cboe": {"status": "ok", "fetchedAt": text(started), "fileTimestamp": text(file_time), "hasExpiry": True,
                     "bandOpenInterest": 4800 if candidate else 800, "spot": 50.0, "error": None},
            "yahoo": {"status": "ok" if candidate else "not-requested",
                      "fetchedAt": text(stamp(day, name, 2)) if candidate else None, "error": None}}
        if not candidate:
            continue
        body = cboe_body(symbol, bid, ask, 600, file_time.strftime("%Y-%m-%d %H:%M:%S"))
        (folder / "cboe" / f"{symbol}.json.gz").write_bytes(gzip.compress(body, mtime=0))
        rows = [{"strike": float(strike), "call": call, "bid": yahoo_bid, "ask": yahoo_ask, "lastTradeAt": None}
                for strike in (49, 50, 51) for call in (True, False)]
        (folder / "yahoo" / f"{symbol}.json").write_text(json.dumps({
            "fetchedAt": text(stamp(day, name, 2)), "expiry": EXPIRY, "fundPrice": 50.0,
            "fundPriceTime": text(stamp(day, name, 1)), "rows": rows}))
    record = {"schema": "leveraged-etf-spread-run-v1", "runId": f"{day}/{name}", "sessionDay": day,
              "sessionExpiry": EXPIRY, "startedAt": text(started), "finishedAt": text(stamp(day, name, 4)),
              "outsideSession": False, "cboeScope": "all", "candidatesFrom": None,
              "candidates": sorted(symbol for symbol in funds if funds[symbol]["candidate"]),
              "funds": funds, "complete": True, "incompleteReasons": [], **changes}
    (folder / "run.json").write_text(json.dumps(record))
    return folder


@pytest.fixture
def store(tmp_path: Path) -> Path:
    for index, (day, name) in enumerate(RUNS):
        write_run(tmp_path / "store", day, name, index)
    return tmp_path / "store"


@pytest.fixture
def universe_path(tmp_path: Path) -> Path:
    funds = [{"symbol": symbol, "optionsListed": True, "optionGateReasons": ["market-closed-at-quote"]}
             for symbol in QUOTES]
    funds.append({"symbol": "FFF", "optionsListed": False, "optionGateReasons": ["no-listed-options"]})
    funds.append({"symbol": "GGG", "optionsListed": False, "optionGateReasons": ["no-standard-contract"]})
    path = tmp_path / "universe.json"
    path.write_text(json.dumps({"schema": "leveraged-etf-universe-v1", "generatedAt": "2026-11-12T15:25:22Z",
                                "funds": list(reversed(funds))}))
    return path


def labels(document: dict) -> dict:
    return {fund["symbol"]: (fund["optionGate"], fund["optionGateReasons"], fund["inCheapBand"])
            for fund in document["funds"]}


def fund(document: dict, symbol: str) -> dict:
    return next(item for item in document["funds"] if item["symbol"] == symbol)


def test_the_labels_of_a_store_of_2_sessions(store, universe_path):
    document = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    assert [item["symbol"] for item in document["funds"]] == ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"]
    assert labels(document) == {
        "AAA": ("pass", [], False),
        "BBB": ("fail", ["spread-above-maximum"], True),  # cheap options, 5% on Monday and 3% on Tuesday
        "CCC": ("fail", ["spread-above-maximum"], False),  # 5.5% at 2 USD
        "DDD": ("fail", ["open-interest-below-minimum"], False),
        "EEE": ("spread-not-measured", ["fewer-than-2-judged-sessions"], False),
        "FFF": ("fail", ["no-listed-options"], False),
        "GGG": ("fail", ["no-standard-contract"], False)}
    assert document["counts"] == {
        "byLabel": {"pass": 1, "fail": 5, "spread-not-measured": 1},
        "byReason": {"no-listed-options": 1, "no-standard-contract": 1, "open-interest-below-minimum": 1,
                     "spread-above-maximum": 2, "fewer-than-2-judged-sessions": 1},
        "cheapBand": 1,
        "judgedSessionsBySource": {"cboe": 2, "yahoo": 5},
        "countedReadsBySource": {"cboe": 4, "yahoo": 14}}
    assert {key: document[key] for key in ("schema", "builtAt", "buildDay", "universe")} == {
        "schema": "leveraged-etf-option-gate-v2", "builtAt": "2026-11-17T20:10:00Z", "buildDay": "2026-11-17",
        "universe": {"path": str(universe_path), "generatedAt": "2026-11-12T15:25:22Z"}}
    assert document["gate"] == gate_v2.spread_gate.GATE_V2
    assert document["runs"] == [{"runId": f"{day}/{name}", "used": True, "skipReason": None, "complete": True}
                                for day, name in RUNS]


def test_the_entry_of_a_fund(store, universe_path):
    document = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    seen = fund(document, "AAA")
    assert seen["facts"] == {"chainFileTimestamp": "2026-11-17T17:40:01Z", "chainFetchedAt": "2026-11-17T17:45:01Z",
                             "sessionExpiry": EXPIRY, "hasExpiry": True, "bandOpenInterest": 4800, "spot": 50.0}
    assert [item["day"] for item in seen["sessions"]] == [TUESDAY, MONDAY]  # newest first
    assert seen["sessions"][1] == {
        "day": MONDAY, "expiry": EXPIRY, "source": "cboe", "result": "inside-limit", "valuePct": 2.75, "limitPct": 4,
        "cheap": False, "inCheapBand": False, "medianMidUsd": 2.0,
        "reads": [{"runId": "2026-11-16/154501Z", "source": "cboe", "fetchedAt": "2026-11-16T15:45:01Z",
                   "quoteTime": "2026-11-16T15:25:01Z", "twoSidedQuotes": 8, "halfSpreadPct": 2.5, "medianMidUsd": 2.0},
                  {"runId": "2026-11-16/174501Z", "source": "cboe", "fetchedAt": "2026-11-16T17:45:01Z",
                   "quoteTime": "2026-11-16T17:25:01Z", "twoSidedQuotes": 8, "halfSpreadPct": 3.0, "medianMidUsd": 2.0}],
        "otherSource": {"source": "yahoo", "countedReads": 2, "valuePct": 1.5}}
    cheap = fund(document, "BBB")["sessions"]
    assert [(item["source"], item["result"], item["valuePct"], item["cheap"], item["inCheapBand"], item["otherSource"])
            for item in cheap] == [("yahoo", "inside-limit", 3.0, True, False, None),
                                   ("yahoo", "spread-above-maximum", 5.0, True, True, None)]
    assert cheap[0]["reads"][0] == {"runId": "2026-11-17/154501Z", "source": "yahoo", "fetchedAt": "2026-11-17T15:47:01Z",
                                    "quoteTime": None, "twoSidedQuotes": 6, "halfSpreadPct": 2.0, "medianMidUsd": 0.5}
    assert fund(document, "DDD")["sessions"] == [] and fund(document, "DDD")["facts"]["bandOpenInterest"] == 800
    assert fund(document, "FFF")["facts"] is None and fund(document, "FFF")["sessions"] == []
    assert [item["day"] for item in fund(document, "EEE")["sessions"]] == [TUESDAY]


def test_folders_that_cannot_be_used_are_listed_with_the_reason(store, universe_path):
    before = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    (store / TUESDAY / "180000Z").mkdir()
    broken = write_run(store, TUESDAY, "181000Z", 3)
    (broken / "cboe" / "AAA.json.gz").write_bytes(b"no gzip")
    write_run(store, TUESDAY, "182000Z", 3, outsideSession=True)
    write_run(store, TUESDAY, "183000Z", 3, schema="leveraged-etf-spread-run-v9")
    (write_run(store, TUESDAY, "184000Z", 3) / "run.json").write_text("{")
    (write_run(store, TUESDAY, "185000Z", 3) / "yahoo" / "BBB.json").write_text("[")
    write_run(store, "2026-11-15", "154501Z", 0, sessionDay="2026-11-15")  # a Sunday
    write_run(store, "2026-11-09", "154501Z", 0)  # before the lookback: not read
    (store / "notes.txt").write_text("no run folder")
    document = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    skipped = {run["runId"]: (run["used"], run["skipReason"], run["complete"]) for run in document["runs"]
               if not run["used"]}
    assert skipped == {
        "2026-11-17/180000Z": (False, "no-run-json", None),
        "2026-11-17/181000Z": (False, "unreadable", True),
        "2026-11-17/182000Z": (False, "outside-session", True),
        "2026-11-17/183000Z": (False, "unknown-schema", None),
        "2026-11-17/184000Z": (False, "unreadable", None),
        "2026-11-17/185000Z": (False, "unreadable", True),
        "2026-11-15/154501Z": (False, "not-a-session-day", True)}
    assert [run["runId"] for run in document["runs"]] == sorted(run["runId"] for run in document["runs"])  # time order
    assert len(document["runs"]) == 11
    assert (document["funds"], document["counts"]) == (before["funds"], before["counts"])


def damage_yahoo_file(folder: Path) -> None:
    stored = json.loads((folder / "yahoo" / "AAA.json").read_text())
    (folder / "yahoo" / "AAA.json").write_text(json.dumps({**stored, "fetchedAt": None}))


def damage_fund(symbol: str = "DDD", **cboe_changes):
    """A change of run.json: the fund DDD (no candidate) under the key `symbol` with the changed Cboe values."""
    def damage(folder: Path) -> None:
        record = json.loads((folder / "run.json").read_text())
        fund = record["funds"].pop("DDD")
        record["funds"][symbol] = {**fund, "cboe": {**fund["cboe"], **cboe_changes}}
        (folder / "run.json").write_text(json.dumps(record))
    return damage


@pytest.mark.parametrize("damage", [
    damage_yahoo_file, damage_fund(bandOpenInterest="abc"), damage_fund(bandOpenInterest=True),
    damage_fund(bandOpenInterest=800.5), damage_fund(symbol="../../DDD"), damage_fund(symbol="DDD\n"),
])
def test_a_stored_file_of_the_wrong_shape_makes_the_run_unreadable(store, universe_path, damage):
    damage(store / TUESDAY / "174501Z")
    document = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    assert [(run["used"], run["skipReason"], run["complete"]) for run in document["runs"]] == [
        (True, None, True)] * 3 + [(False, "unreadable", True)]
    assert labels(document)["DDD"] == ("fail", ["open-interest-below-minimum"], False)  # from the run before


def test_a_folder_in_the_short_form_of_a_day_is_no_day_folder(store, universe_path):
    (store / "20261117" / "190000Z").mkdir(parents=True)
    document = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    assert [run["runId"] for run in document["runs"]] == [f"{day}/{name}" for day, name in RUNS]


def test_the_facts_of_a_fund_that_a_candidates_run_did_not_read_come_from_the_run_that_read_every_fund(
        store, universe_path):
    before = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    for day, name, first in ((MONDAY, "174501Z", "154501Z"), (TUESDAY, "174501Z", "154501Z")):
        record = json.loads((store / day / name / "run.json").read_text())
        del record["funds"]["DDD"]  # no candidate: the second run of a day does not read it
        record.update(cboeScope="candidates", candidatesFrom=f"{day}/{first}")
        (store / day / name / "run.json").write_text(json.dumps(record))
    document = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    assert all(run["used"] for run in document["runs"]) and len(document["runs"]) == 4
    assert labels(document) == labels(before) and document["counts"] == before["counts"]
    assert labels(document)["DDD"] == ("fail", ["open-interest-below-minimum"], False)
    assert fund(document, "DDD")["facts"] == {
        "chainFileTimestamp": "2026-11-17T15:40:01Z", "chainFetchedAt": "2026-11-17T15:45:01Z",
        "sessionExpiry": EXPIRY, "hasExpiry": True, "bandOpenInterest": 800, "spot": 50.0}
    assert fund(document, "AAA")["facts"]["chainFetchedAt"] == "2026-11-17T17:45:01Z"  # of the newest run


def test_a_run_without_a_known_scope_of_the_cboe_phase_is_unreadable(store, universe_path):
    for name, change in (("154501Z", lambda record: record.pop("cboeScope")),
                         ("174501Z", lambda record: record.update(cboeScope="some"))):
        record = json.loads((store / TUESDAY / name / "run.json").read_text())
        change(record)
        (store / TUESDAY / name / "run.json").write_text(json.dumps(record))
    document = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    assert [(run["used"], run["skipReason"]) for run in document["runs"]] == [
        (True, None), (True, None), (False, "unreadable"), (False, "unreadable")]


def test_an_incomplete_run_is_used(store, universe_path):
    record = json.loads((store / TUESDAY / "174501Z" / "run.json").read_text())
    record.update(complete=False, incompleteReasons=["yahoo-rate-limited"], finishedAt=None)
    (store / TUESDAY / "174501Z" / "run.json").write_text(json.dumps(record))
    document = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    assert document["runs"][-1] == {"runId": "2026-11-17/174501Z", "used": True, "skipReason": None, "complete": False}
    assert labels(document)["AAA"] == ("pass", [], False)


def test_a_store_of_one_session_gives_no_pass(tmp_path, universe_path):
    for index, (day, name) in enumerate(RUNS[:2]):
        write_run(tmp_path / "store", day, name, index)
    document = gate_v2.build(tmp_path / "store", universe_path, date(2026, 11, 16), BUILT_AT)
    assert document["counts"]["byLabel"] == {"pass": 0, "fail": 3, "spread-not-measured": 4}
    assert labels(document)["AAA"] == ("spread-not-measured", ["fewer-than-2-judged-sessions"], False)
    assert labels(document)["DDD"] == ("fail", ["open-interest-below-minimum"], False)
    assert labels(document)["EEE"] == ("spread-not-measured", ["no-chain-in-store"], False)


def test_a_cboe_file_of_an_earlier_session_does_not_count_again(store, universe_path):
    for index, name in ((2, "154501Z"), (3, "174501Z")):  # Wednesday: Cboe did not write a new file of AAA
        folder = write_run(store, "2026-11-18", name, index, sessionExpiry="2026-11-27")
        tuesday = stamp(TUESDAY, "174501Z", -5)
        (folder / "cboe" / "AAA.json.gz").write_bytes(gzip.compress(cboe_body(
            "AAA", 1.0, 3.0, 600, tuesday.strftime("%Y-%m-%d %H:%M:%S")).replace(b"AAA261120", b"AAA261127")))
    document = gate_v2.build(store, universe_path, date(2026, 11, 18), BUILT_AT)
    wednesday = fund(document, "AAA")["sessions"][0]
    assert (wednesday["day"], wednesday["expiry"], wednesday["source"], wednesday["result"], wednesday["reads"],
            wednesday["otherSource"]) == ("2026-11-18", "2026-11-27", None, "not-judged", [], None)
    assert labels(document)["AAA"] == ("pass", [], False)  # Monday and Tuesday still decide


def test_a_pause_of_the_collector_never_gives_a_fail(store, universe_path):
    document = gate_v2.build(store, universe_path, date(2026, 11, 24), BUILT_AT)  # Tuesday is 6 sessions back
    assert document["runs"] == []
    assert {symbol: labels(document)[symbol] for symbol in QUOTES} == {
        symbol: ("spread-not-measured", ["no-chain-in-store"], False) for symbol in QUOTES}
    assert document["counts"]["byReason"] == {"no-listed-options": 1, "no-standard-contract": 1, "no-chain-in-store": 5}
    assert all(fund["facts"] is None and fund["sessions"] == [] for fund in document["funds"])


def test_the_build_is_a_function_of_the_store_and_uses_no_network(store, universe_path, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("the build opened a socket")

    monkeypatch.setattr(socket, "socket", refuse)
    first = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    assert gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT) == first
    assert json.loads(json.dumps(first)) == first  # plain JSON values only


def test_markdown_has_one_row_per_fund_with_a_judged_session(store, universe_path):
    table = gate_v2.markdown(gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT))
    lines = table.splitlines()
    assert lines[0] == "# Leveraged ETF option gate version 2: 2026-11-17"
    assert [line for line in lines if line.startswith("## ")] == ["## Runs", "## Counts", "## Sessions by source",
                                                                 "## Funds"]
    funds = lines[lines.index("## Funds"):]
    assert [line.split(" | ")[0] for line in funds if line.startswith("| ") and "---" not in line][1:] == [
        "| AAA", "| BBB", "| CCC", "| EEE"]
    assert ("| BBB | fail | spread-above-maximum | 2026-11-17<br>2026-11-16 | 2026-11-20<br>2026-11-20 | yahoo<br>yahoo "
            "| 2<br>2 | 3<br>5 | 4<br>4 | <br> |") in funds
    assert "| AAA | pass |  | 2026-11-17<br>2026-11-16 | 2026-11-20<br>2026-11-20 | cboe<br>cboe | 2<br>2 " \
        "| 2.75<br>2.75 | 4<br>4 | 1.5<br>1.5 |" in funds
    assert "| 2026-11-16/154501Z | yes |  | yes |" in lines
    assert "| funds in the cheap band | 1 |" in lines and "| pass | 1 |" in lines
    assert "| spread-above-maximum | 2 |" in lines and "| yahoo | 5 | 14 |" in lines


def test_markdown_lists_the_funds_in_the_cheap_band(store, universe_path):
    document = gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    lines = gate_v2.markdown(document).splitlines()
    assert "Cheap band: BBB" in lines
    assert lines.index("## Counts") < lines.index("Cheap band: BBB") < lines.index("## Sessions by source")
    fund(document, "CCC")["inCheapBand"] = True
    fund(document, "AAA")["inCheapBand"] = True
    document["funds"].reverse()
    assert "Cheap band: AAA, BBB, CCC" in gate_v2.markdown(document).splitlines()  # in symbol order
    for item in document["funds"]:
        item["inCheapBand"] = False
    assert "Cheap band: none" in gate_v2.markdown(document).splitlines()


def test_main_writes_the_two_files(store, universe_path, tmp_path, capsys):
    out = tmp_path / "out" / "result"
    arguments = ["--store", str(store), "--universe", str(universe_path), "--out", str(out), "--as-of", "2026-11-17"]
    assert gate_v2.main(arguments, now=lambda: BUILT_AT) == 0
    document = json.loads((out / "gate-v2.json").read_text())
    assert document == gate_v2.build(store, universe_path, BUILD_DAY, BUILT_AT)
    assert (out / "gate-v2.md").read_text() == gate_v2.markdown(document)
    assert sorted(path.name for path in out.iterdir()) == ["gate-v2.json", "gate-v2.md"]
    printed = capsys.readouterr().out
    assert "pass: 1" in printed and str(out / "gate-v2.json") in printed and str(out / "gate-v2.md") in printed
    assert gate_v2.main(arguments[:6], now=lambda: datetime(2026, 11, 18, 3, 0, tzinfo=UTC)) == 0  # 22:00 New York
    assert json.loads((out / "gate-v2.json").read_text())["buildDay"] == "2026-11-17"


def test_main_exit_codes(store, universe_path, tmp_path, capsys):
    out = ["--out", str(tmp_path / "out")]
    assert gate_v2.main(["--store", str(store), *out]) == 2
    assert gate_v2.main(["--store", str(store), "--universe", str(universe_path), *out, "--as-of", "tomorrow"]) == 2
    assert gate_v2.main(["--store", str(tmp_path / "none"), "--universe", str(universe_path), *out]) == 1
    (tmp_path / "bad.json").write_text("<html>")
    assert gate_v2.main(["--store", str(store), "--universe", str(tmp_path / "bad.json"), *out]) == 1
    assert not (tmp_path / "out").exists()
    capsys.readouterr()
