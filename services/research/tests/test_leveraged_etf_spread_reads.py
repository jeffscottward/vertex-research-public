"""research/backtests/leveraged-etf/spread_reads.py: the collector of the option gate version 2 (fakes only, no
network, no real sleep)."""
from __future__ import annotations

import gzip
import importlib.util
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "research" / "backtests" / "leveraged-etf" / "spread_reads.py"
_spec = importlib.util.spec_from_file_location("leveraged_etf_spread_reads", SCRIPT)
reads = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reads)

NOW = datetime(2026, 11, 16, 15, 45, 1, tzinfo=UTC)  # Monday 10:45:01 New York
DAY, RUN, EXPIRY = "2026-11-16", "154501Z", "2026-11-20"
FUNDS = ("AAA", "BBB", "CCC", "DDD", "EEE", "FFF")  # with listed options; AAA and BBB are the candidates
# The text of yfinance 0.2.66 for an expiry that Yahoo does not list.
NOT_LISTED = "Expiration `2026-11-20` cannot be found. Available expirations are: [2026-11-27, 2026-12-18]"


def cboe_body(symbol: str, open_interest: int = 600, expiry: str = "261120") -> bytes:
    """A Cboe chain at spot 50 with a call and a put at 4 strikes; each contract has `open_interest`."""
    options = [{"option": f"{symbol}{expiry}{side}{strike * 1000:08d}", "bid": 1.9, "ask": 2.1,
                "open_interest": open_interest} for strike in (48, 49, 50, 51) for side in "CP"]
    return json.dumps({"timestamp": "2026-11-16 15:40:12", "symbol": symbol,
                       "data": {"symbol": symbol, "current_price": 50.0, "options": options}}).encode()


class Cboe:
    """fetch_cboe: the chain of each symbol, or the exception that `special` holds for it."""

    def __init__(self, special: dict | None = None) -> None:
        self.special = special or {}
        self.symbols: list[str] = []

    def __call__(self, url: str) -> bytes:
        symbol = url.rsplit("/", 1)[1].removesuffix(".json")
        assert url == f"https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json"
        self.symbols.append(symbol)
        answer = self.special.get(symbol, cboe_body(symbol))
        if isinstance(answer, BaseException):
            raise answer
        return answer


CBOE = {"CCC": cboe_body("CCC", open_interest=100),  # 800 contracts in the band
        "DDD": cboe_body("DDD", expiry="261127"),  # another expiry
        "EEE": reads.universe.NoFile("EEE"),
        "FFF": cboe_body("FFF", expiry="261113")}  # expired contracts only


class Frame:
    """The DataFrame calls of the collector and of last_trade of the option-chain collector, over row dicts."""

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, column: str):
        values = [row[column] for row in self.rows if row[column] is not None]
        return SimpleNamespace(dropna=lambda: SimpleNamespace(tolist=lambda: values))

    def to_dict(self, orient: str) -> list[dict]:
        assert orient == "records"
        return [dict(row) for row in self.rows]


def yahoo_chain(bid: float = 1.9, traded: datetime | None = NOW - timedelta(minutes=5), underlying="own"):
    def side() -> Frame:
        return Frame([{"strike": float(strike), "bid": bid, "ask": 2.1 if bid else 0.0, "lastTradeDate": traded}
                      for strike in (49, 50, 51)])
    price = {"regularMarketPrice": 50.0, "regularMarketTime": int((NOW - timedelta(minutes=1)).timestamp())}
    return SimpleNamespace(calls=side(), puts=side(), underlying=price if underlying == "own" else underlying)


class Yahoo:
    """ticker_for: the chain of each symbol, or the exception that `special` holds for it (a list: one answer
    per attempt)."""

    def __init__(self, special: dict | None = None) -> None:
        self.special = special or {}
        self.symbols: list[str] = []
        self.expiries: set[str] = set()

    def __call__(self, symbol: str):
        self.symbols.append(symbol)

        def option_chain(expiry: str):
            self.expiries.add(expiry)
            answer = self.special.get(symbol, yahoo_chain())
            answer = answer.pop(0) if isinstance(answer, list) else answer
            if isinstance(answer, BaseException):
                raise answer
            return answer

        return SimpleNamespace(option_chain=option_chain)


def universe_file(tmp_path: Path, symbols=FUNDS, generated_at: str = "2026-11-12T15:25:22Z") -> Path:
    funds = [{"symbol": symbol, "optionsListed": True} for symbol in symbols] + [{"symbol": "ZZZ", "optionsListed": False}]
    path = tmp_path / "universe.json"
    path.write_text(json.dumps({"schema": "leveraged-etf-universe-v1", "generatedAt": generated_at, "funds": funds}))
    return path


def run(tmp_path: Path, cboe: Cboe | None = None, yahoo: Yahoo | None = None, now: datetime = NOW, **options):
    """One run with the fakes. Returns (exit code, log lines, the waits, the Cboe fake, the Yahoo fake)."""
    cboe, yahoo = cboe or Cboe(CBOE), yahoo or Yahoo()
    log, waits = [], []
    universe_path = options.pop("universe_path", None) or universe_file(tmp_path)
    code = reads.collect(cboe, yahoo, lambda: now, waits.append, tmp_path / "store", universe_path,
                         log=log.append, **options)
    return code, log, waits, cboe, yahoo


def record_of(tmp_path: Path, day: str = DAY, run_name: str = RUN) -> dict:
    return json.loads((tmp_path / "store" / day / run_name / "run.json").read_text())


def stored(tmp_path: Path, kind: str) -> list[str]:
    return sorted(path.name for path in (tmp_path / "store" / DAY / RUN / kind).iterdir())


def test_a_run_reads_every_fund_from_cboe_and_the_candidates_from_yahoo(tmp_path):
    code, log, waits, cboe, yahoo = run(tmp_path)
    record = record_of(tmp_path)
    assert code == 0
    assert sorted(cboe.symbols) == ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "SPY"] and cboe.symbols[0] == "SPY"
    assert yahoo.symbols == ["SPY", "AAA", "BBB"] and yahoo.expiries == {EXPIRY}
    assert stored(tmp_path, "cboe") == ["AAA.json.gz", "BBB.json.gz"]
    assert stored(tmp_path, "yahoo") == ["AAA.json", "BBB.json"]
    assert gzip.decompress((tmp_path / "store" / DAY / RUN / "cboe" / "AAA.json.gz").read_bytes()) == cboe_body("AAA")
    assert waits == [1.0] * 6 + [1.0]  # one wait per Cboe request of a fund, one between the 2 Yahoo funds
    assert {key: record[key] for key in ("schema", "runId", "sessionDay", "sessionExpiry", "startedAt", "finishedAt",
                                         "outsideSession", "candidates", "complete", "incompleteReasons")} == {
        "schema": "leveraged-etf-spread-run-v1", "runId": "2026-11-16/154501Z", "sessionDay": DAY,
        "sessionExpiry": EXPIRY, "startedAt": "2026-11-16T15:45:01Z", "finishedAt": "2026-11-16T15:45:01Z",
        "outsideSession": False, "candidates": ["AAA", "BBB"], "complete": True, "incompleteReasons": []}
    assert record["universe"] == {"path": str(tmp_path / "universe.json"), "generatedAt": "2026-11-12T15:25:22Z",
                                  "ageDays": 4, "funds": 7, "fundsWithOptions": 6}
    assert record["probe"] == {"symbol": "SPY", "state": "live", "latestOptionTradeAt": "2026-11-16T15:40:01Z"}
    assert record["counts"] == {"cboeOk": 5, "cboeNoFile": 1, "cboeFailed": 0, "yahooOk": 2, "yahooNoExpiry": 0,
                                "yahooNoQuotes": 0, "yahooFailed": 0, "yahooNotRequested": 0, "yahooRateLimited": False}
    assert sorted(record["funds"]) == sorted(FUNDS)
    assert record["funds"]["AAA"] == {
        "candidate": True,
        "cboe": {"status": "ok", "fetchedAt": "2026-11-16T15:45:01Z", "fileTimestamp": "2026-11-16T15:40:12Z",
                 "hasExpiry": True, "bandOpenInterest": 4800, "spot": 50.0, "error": None},
        "yahoo": {"status": "ok", "fetchedAt": "2026-11-16T15:45:01Z", "error": None}}
    not_candidates = {symbol: (record["funds"][symbol]["candidate"], record["funds"][symbol]["cboe"]["status"],
                               record["funds"][symbol]["cboe"]["hasExpiry"],
                               record["funds"][symbol]["cboe"]["bandOpenInterest"],
                               record["funds"][symbol]["yahoo"]["status"]) for symbol in ("CCC", "DDD", "EEE", "FFF")}
    assert not_candidates == {"CCC": (False, "ok", True, 800, "not-requested"),
                              "DDD": (False, "ok", False, None, "not-requested"),
                              "EEE": (False, "no-file", None, None, "not-requested"),
                              "FFF": (False, "no-standard-contract", False, None, "not-requested")}
    assert record["funds"]["FFF"]["cboe"]["fileTimestamp"] == "2026-11-16T15:40:12Z"


def test_the_stored_yahoo_file(tmp_path):
    special = {"AAA": SimpleNamespace(
        calls=Frame([{"strike": 50, "bid": 1.1, "ask": float("nan"), "lastTradeDate": datetime(2026, 11, 16, 15, 40, 3)}]),
        puts=Frame([{"strike": 50.5, "bid": 0.9, "ask": 0.96, "lastTradeDate": float("nan")}]), underlying={})}
    run(tmp_path, yahoo=Yahoo(special))
    assert json.loads((tmp_path / "store" / DAY / RUN / "yahoo" / "AAA.json").read_text()) == {
        "fetchedAt": "2026-11-16T15:45:01Z", "expiry": EXPIRY, "fundPrice": None, "fundPriceTime": None,
        "rows": [{"strike": 50.0, "call": True, "bid": 1.1, "ask": None, "lastTradeAt": "2026-11-16T15:40:03Z"},
                 {"strike": 50.5, "call": False, "bid": 0.9, "ask": 0.96, "lastTradeAt": None}]}
    whole = json.loads((tmp_path / "store" / DAY / RUN / "yahoo" / "BBB.json").read_text())
    assert (whole["fundPrice"], whole["fundPriceTime"], len(whole["rows"])) == (50.0, "2026-11-16T15:44:01Z", 6)


def test_a_second_run_of_the_day_requests_every_fund_again(tmp_path):
    run(tmp_path)
    later = NOW + timedelta(hours=2)
    live = Yahoo({"SPY": yahoo_chain(traded=later - timedelta(minutes=5))})
    code, _, _, cboe, yahoo = run(tmp_path, yahoo=live, now=later)
    assert code == 0 and len(cboe.symbols) == 7 and yahoo.symbols == ["SPY", "AAA", "BBB"]
    assert sorted(path.name for path in (tmp_path / "store" / DAY).iterdir()) == ["154501Z", "174501Z"]
    assert record_of(tmp_path, run_name="174501Z")["candidates"] == ["AAA", "BBB"]


def test_one_failed_cboe_read_of_6_keeps_the_run_complete(tmp_path):
    code, *_ = run(tmp_path, cboe=Cboe({**CBOE, "CCC": OSError("connection reset")}))
    record = record_of(tmp_path)
    assert code == 0 and record["complete"] is True and record["counts"]["cboeFailed"] == 1
    assert record["funds"]["CCC"]["cboe"]["status"] == "failed"
    assert record["funds"]["CCC"]["cboe"]["error"] == "OSError: connection reset"
    assert record["candidates"] == ["AAA", "BBB"]  # the run went on


def test_two_failed_cboe_reads_of_6_make_the_run_incomplete(tmp_path):
    code, log, *_ = run(tmp_path, cboe=Cboe({**CBOE, "CCC": OSError("connection reset"), "DDD": b"<html>"}))
    record = record_of(tmp_path)
    assert code == 0 and record["complete"] is False
    assert record["incompleteReasons"] == ["cboe-failed-above-20-percent"]
    assert log[-1].endswith("not complete: cboe-failed-above-20-percent")
    assert record["funds"]["DDD"]["cboe"]["status"] == "failed"  # a body that is no chain
    assert stored(tmp_path, "yahoo") == ["AAA.json", "BBB.json"]


def test_a_universe_file_that_is_no_json_ends_the_run_before_a_folder_is_made(tmp_path):
    path = tmp_path / "universe.json"
    path.write_text("<html>")
    code, log, _, cboe, yahoo = run(tmp_path, universe_path=path)
    assert code == 1 and "cannot be read" in log[-1]
    assert not (tmp_path / "store").exists() and cboe.symbols == [] and yahoo.symbols == []
    path.write_text(json.dumps({"generatedAt": "2026-11-12T15:25:22Z", "funds": [{"symbol": "../X", "optionsListed": True}]}))
    assert run(tmp_path, universe_path=path)[0] == 1 and not (tmp_path / "store").exists()


def test_a_symbol_with_a_newline_at_the_end_is_refused(tmp_path):
    path = universe_file(tmp_path, ("AAA", "BBB\n"))
    code, log, _, cboe, _ = run(tmp_path, universe_path=path)
    assert code == 1 and "cannot be stored" in log[-1]
    assert not (tmp_path / "store").exists() and cboe.symbols == []


def test_a_universe_file_with_more_funds_than_the_limit_is_refused(tmp_path):
    symbols = [f"F{index:04d}" for index in range(2001)]
    day = datetime(2026, 11, 16).date()
    assert reads.read_universe(universe_file(tmp_path, symbols[:2000]), day)[0]["fundsWithOptions"] == 2000
    path = universe_file(tmp_path, symbols)
    with pytest.raises(ValueError, match="2001 funds with listed options"):
        reads.read_universe(path, day)
    code, log, _, cboe, yahoo = run(tmp_path, universe_path=path)
    assert code == 1 and "cannot be read" in log[-1]
    assert not (tmp_path / "store").exists() and cboe.symbols == [] and yahoo.symbols == []


@pytest.mark.parametrize("data", ["null", '{"symbol": "CCC", "current_price": 50.0, "options": [5]}'])
def test_a_malformed_cboe_body_fails_the_fund_and_the_run_goes_on(tmp_path, data):
    body = ('{"symbol": "CCC", "timestamp": "2026-11-16 15:40:12", "data": %s}' % data).encode()
    code, *_ = run(tmp_path, cboe=Cboe({**CBOE, "CCC": body}))
    record = record_of(tmp_path)
    assert code == 0 and record["complete"] is True and record["finishedAt"] == "2026-11-16T15:45:01Z"
    assert record["funds"]["CCC"]["cboe"]["status"] == "failed"
    assert record["funds"]["CCC"]["cboe"]["error"].startswith("AttributeError: ")
    assert record["candidates"] == ["AAA", "BBB"] and stored(tmp_path, "yahoo") == ["AAA.json", "BBB.json"]


def test_the_body_of_a_fund_is_dropped_when_the_fund_is_handled(tmp_path):
    dropped, at_request = [], []

    class Body(bytes):
        def __del__(self) -> None:
            dropped.append(1)

    class Counting(Yahoo):
        def __call__(self, symbol: str):
            at_request.append(len(dropped))
            return super().__call__(symbol)

    def fetch(url: str) -> bytes:
        return Body(cboe_body(url.rsplit("/", 1)[1].removesuffix(".json")))

    path = universe_file(tmp_path, ("AAA", "BBB", "CCC"))
    code, *_ = run(tmp_path, cboe=fetch, yahoo=Counting(), universe_path=path)
    assert code == 0 and stored(tmp_path, "cboe") == ["AAA.json.gz", "BBB.json.gz", "CCC.json.gz"]
    assert at_request == [0, 4, 4, 4]  # SPY and the 3 funds: no Cboe body is alive in the Yahoo phase


def test_an_old_universe_file_gives_a_warning(tmp_path):
    path = universe_file(tmp_path, generated_at="2026-10-15T15:00:00Z")
    code, log, *_ = run(tmp_path, universe_path=path)
    assert code == 0 and record_of(tmp_path)["universe"]["ageDays"] == 32
    assert any(line.startswith("warning: the universe file is 32 days old") for line in log)


def test_the_first_yahoo_rate_limit_ends_the_yahoo_phase(tmp_path):
    yahoo = Yahoo({"AAA": RuntimeError("Too Many Requests. Rate limited. Try after a while.")})
    code, _, _, _, yahoo = run(tmp_path, cboe=Cboe({"CCC": CBOE["CCC"]}), yahoo=yahoo)  # 5 candidates
    record = record_of(tmp_path)
    assert code == 0 and yahoo.symbols == ["SPY", "AAA"]  # no further ticker_for call
    assert record["funds"]["AAA"]["yahoo"]["status"] == "failed"
    assert {record["funds"][symbol]["yahoo"]["status"] for symbol in ("BBB", "DDD", "EEE", "FFF")} == {"not-requested"}
    assert record["counts"]["yahooRateLimited"] is True and record["counts"]["yahooNotRequested"] == 4
    assert record["complete"] is False and "yahoo-rate-limited" in record["incompleteReasons"]
    assert stored(tmp_path, "yahoo") == [] and len(stored(tmp_path, "cboe")) == 5


def test_yahoo_statuses_of_a_candidate(tmp_path):
    yahoo = Yahoo({"AAA": yahoo_chain(bid=0.0),
                   "BBB": ValueError(NOT_LISTED),
                   "CCC": [RuntimeError("timeout"), RuntimeError("timeout"), yahoo_chain()],
                   "DDD": [RuntimeError("timeout")] * 3})
    code, _, waits, _, yahoo = run(tmp_path, cboe=Cboe(), yahoo=yahoo)  # 6 candidates
    record = record_of(tmp_path)
    assert {symbol: record["funds"][symbol]["yahoo"]["status"] for symbol in FUNDS} == {
        "AAA": "no-quotes", "BBB": "no-expiry", "CCC": "ok", "DDD": "failed", "EEE": "ok", "FFF": "ok"}
    assert yahoo.symbols == ["SPY", "AAA", "BBB"] + ["CCC"] * 3 + ["DDD"] * 3 + ["EEE", "FFF"]
    assert waits[6:] == [1.0, 1.0, 5, 10, 1.0, 5, 10, 1.0, 1.0]
    assert stored(tmp_path, "yahoo") == ["AAA.json", "CCC.json", "EEE.json", "FFF.json"]
    assert record["funds"]["DDD"]["yahoo"]["error"] == "RuntimeError: timeout"
    assert record["counts"]["yahooNoQuotes"] == 1 and record["counts"]["yahooNoExpiry"] == 1
    assert code == 0 and record["complete"] is True  # 1 failed Yahoo read of 6 candidates


@pytest.mark.parametrize("error", [
    json.JSONDecodeError("Expecting value", "<html>", 0),  # a reply that is no JSON; a subclass of ValueError
    ValueError("No timezone found, symbol may be delisted"),
    ValueError("Expiration `2026-11-20` cannot be found. Available expirations are: []"),  # Yahoo sent no list
])
def test_a_value_error_of_yahoo_that_is_no_missing_expiry_is_a_failed_attempt(tmp_path, error):
    code, _, waits, _, yahoo = run(tmp_path, yahoo=Yahoo({"AAA": [error] * 3, "BBB": [error, yahoo_chain()]}))
    record = record_of(tmp_path)
    assert yahoo.symbols == ["SPY", "AAA", "AAA", "AAA", "BBB", "BBB"] and waits[6:] == [5, 10, 1.0, 5]
    assert record["funds"]["AAA"]["yahoo"]["status"] == "failed"
    assert record["funds"]["BBB"]["yahoo"]["status"] == "ok"
    assert (record["counts"]["yahooFailed"], record["counts"]["yahooNoExpiry"]) == (1, 0)
    assert code == 0 and record["incompleteReasons"] == ["yahoo-failed-above-20-percent"]


@pytest.mark.parametrize("empty", [
    SimpleNamespace(calls=None, puts=None, underlying=None),  # yfinance 0.2.66 when Yahoo sends no options
    SimpleNamespace(calls=Frame([]), puts=yahoo_chain().puts, underlying={}),
    SimpleNamespace(calls=yahoo_chain().calls, puts=Frame([]), underlying={}),
])
def test_an_empty_yahoo_chain_is_a_failed_attempt(tmp_path, empty):
    code, _, _, _, yahoo = run(tmp_path, yahoo=Yahoo({"AAA": [empty] * 3, "BBB": [empty, yahoo_chain()]}))
    record = record_of(tmp_path)
    assert yahoo.symbols == ["SPY", "AAA", "AAA", "AAA", "BBB", "BBB"]
    assert record["funds"]["AAA"]["yahoo"]["status"] == "failed"
    assert record["funds"]["AAA"]["yahoo"]["error"] == "RuntimeError: Yahoo sent an empty chain for 2026-11-20"
    assert record["funds"]["BBB"]["yahoo"]["status"] == "ok" and stored(tmp_path, "yahoo") == ["BBB.json"]
    assert record["counts"]["yahooNoQuotes"] == 0 and record["incompleteReasons"] == ["yahoo-failed-above-20-percent"]


def test_the_marks_of_a_yahoo_rate_limit():
    class YFRateLimitError(Exception):
        """The name of the yfinance class."""

    assert reads.rate_limited(RuntimeError("Too Many Requests. Rate limited. Try after a while."))
    assert reads.rate_limited(RuntimeError("HTTP Error 429: "))
    assert reads.rate_limited(YFRateLimitError("limited"))
    assert not reads.rate_limited(RuntimeError("timed out after 30429 milliseconds"))  # 429 inside a number
    assert not reads.rate_limited(RuntimeError("no data"))


def test_more_than_20_percent_failed_yahoo_reads_make_the_run_incomplete(tmp_path):
    code, *_ = run(tmp_path, yahoo=Yahoo({"BBB": [RuntimeError("timeout")] * 3}))  # 1 of 2 candidates
    record = record_of(tmp_path)
    assert code == 0 and record["complete"] is False
    assert record["incompleteReasons"] == ["yahoo-failed-above-20-percent"]


@pytest.mark.parametrize("now, words", [
    (datetime(2026, 11, 14, 15, 45, tzinfo=UTC), "outside 09:45"),  # Saturday
    (datetime(2026, 11, 16, 13, 0, tzinfo=UTC), "outside 09:45"),  # Monday 08:00 New York
    (datetime(2026, 11, 16, 21, 0, tzinfo=UTC), "outside 09:45"),  # Monday 16:00 New York
    (datetime(2026, 11, 26, 15, 45, tzinfo=UTC), "outside 09:45"),  # Thanksgiving
    (datetime(2026, 11, 27, 18, 0, tzinfo=UTC), "outside 09:45"),  # half day, 13:00 New York
])
def test_a_clock_outside_the_session_writes_nothing(tmp_path, now, words):
    code, log, _, cboe, yahoo = run(tmp_path, now=now)
    assert code == 0 and words in log[-1] and log[-1].startswith("skipped: ")
    assert not (tmp_path / "store").exists() and cboe.symbols == [] and yahoo.symbols == []


@pytest.mark.parametrize("traded", [NOW - timedelta(minutes=46), None])
def test_a_spy_chain_without_a_trade_in_45_minutes_writes_nothing(tmp_path, traded):
    code, log, _, cboe, yahoo = run(tmp_path, yahoo=Yahoo({"SPY": yahoo_chain(traded=traded)}))
    assert code == 0 and "the market is closed" in log[-1]
    assert not (tmp_path / "store").exists() and cboe.symbols == [] and yahoo.symbols == ["SPY"]


def test_an_unreadable_spy_chain_of_yahoo_gives_a_cboe_only_run(tmp_path):
    empty = SimpleNamespace(calls=Frame([]), puts=Frame([]), underlying={})
    code, _, waits, _, yahoo = run(tmp_path, yahoo=Yahoo({"SPY": [RuntimeError("no data"), empty, RuntimeError("no data")]}))
    record = record_of(tmp_path)
    assert code == 0 and yahoo.symbols == ["SPY"] * 3 and waits[:2] == [5, 10]
    assert record["probe"] == {"symbol": "SPY", "state": "unreadable", "latestOptionTradeAt": None}
    assert stored(tmp_path, "cboe") == ["AAA.json.gz", "BBB.json.gz"] and stored(tmp_path, "yahoo") == []
    assert {fund["yahoo"]["status"] for fund in record["funds"].values()} == {"not-requested"}
    assert record["complete"] is False and record["incompleteReasons"] == ["market-check-unreadable"]
    assert record["counts"]["yahooNotRequested"] == 2 and record["counts"]["yahooRateLimited"] is False


def test_a_rate_limit_at_the_market_check_ends_yahoo_for_the_run(tmp_path):
    code, _, _, _, yahoo = run(tmp_path, yahoo=Yahoo({"SPY": RuntimeError("HTTP Error 429")}))
    record = record_of(tmp_path)
    assert code == 0 and yahoo.symbols == ["SPY"] and record["probe"]["state"] == "unreadable"
    assert record["incompleteReasons"] == ["market-check-unreadable", "yahoo-rate-limited"]


@pytest.mark.parametrize("answer", [OSError("refused"), reads.universe.NoFile("SPY"), b'{"data": {"options": []}}'])
def test_a_failed_cboe_control_reads_no_fund(tmp_path, answer):
    code, _, _, cboe, yahoo = run(tmp_path, cboe=Cboe({"SPY": answer}))
    record = record_of(tmp_path)
    assert code == 0 and cboe.symbols == ["SPY"] and yahoo.symbols == ["SPY"]
    assert record["complete"] is False and record["funds"] == {} and record["candidates"] == []
    assert len(record["incompleteReasons"]) == 1 and record["incompleteReasons"][0].startswith("cboe-control-failed: ")
    assert record["finishedAt"] == "2026-11-16T15:45:01Z"


def test_a_killed_run_leaves_its_record(tmp_path):
    with pytest.raises(KeyboardInterrupt):
        run(tmp_path, cboe=Cboe({**CBOE, "BBB": KeyboardInterrupt()}), workers=1)
    record = record_of(tmp_path)
    assert record["finishedAt"] is None and record["complete"] is False and record["runId"] == "2026-11-16/154501Z"
    assert not list((tmp_path / "store" / DAY / RUN).glob("**/*.part"))


def test_a_run_deletes_the_day_folders_of_more_than_45_days_before(tmp_path):
    for name in ("2026-10-01", "2026-10-02", "notes"):  # 46 days before, 45 days before, no day folder
        (tmp_path / "store" / name / "120000Z").mkdir(parents=True)
    code, log, *_ = run(tmp_path)
    assert code == 0 and sorted(path.name for path in (tmp_path / "store").iterdir()) == ["2026-10-02", DAY, "notes"]
    assert "deleted the runs of 2026-10-01: more than 45 days old" in log


def test_only_a_folder_with_the_name_of_a_day_is_deleted(tmp_path):
    (tmp_path / "store" / "20261001" / "120000Z").mkdir(parents=True)  # Python reads this as a date too
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "120000Z").mkdir(parents=True)
    (tmp_path / "store" / "2026-09-01").symlink_to(elsewhere, target_is_directory=True)  # a link is not followed
    code, *_ = run(tmp_path)
    assert code == 0 and sorted(path.name for path in (tmp_path / "store").iterdir()) == ["2026-09-01", DAY, "20261001"]
    assert (tmp_path / "store" / "20261001" / "120000Z").is_dir() and (elsewhere / "120000Z").is_dir()


def test_an_outside_session_run_skips_both_checks(tmp_path):
    saturday = datetime(2026, 11, 14, 15, 0, tzinfo=UTC)
    code, _, _, cboe, yahoo = run(tmp_path, now=saturday, outside_session=True)
    record = record_of(tmp_path, "2026-11-14", "150000Z")
    assert code == 0 and yahoo.symbols == ["AAA", "BBB"] and len(cboe.symbols) == 7
    assert record["outsideSession"] is True and record["sessionExpiry"] == EXPIRY
    assert record["probe"] == {"symbol": "SPY", "state": "skipped", "latestOptionTradeAt": None}


def test_main_with_a_missing_argument_exits_2(tmp_path, capsys):
    assert reads.main(["--store", str(tmp_path / "store")], fetch_cboe=Cboe(), ticker_for=Yahoo()) == 2
    assert reads.main(["--store", str(tmp_path), "--universe", "u.json", "--funds", "TQQQ"], Cboe(), Yahoo()) == 2
    assert "--universe" in capsys.readouterr().err and not (tmp_path / "store").exists()


def test_a_store_that_cannot_be_written_is_a_fault(tmp_path):
    """No handling in the collector: the OSError ends the process with a traceback and exit 1."""
    (tmp_path / "store").write_text("a file, no folder")
    arguments = ["--store", str(tmp_path / "store"), "--universe", str(universe_file(tmp_path)), "--outside-session"]
    cboe, yahoo = Cboe(CBOE), Yahoo()
    with pytest.raises(OSError):
        reads.main(arguments, fetch_cboe=cboe, ticker_for=yahoo)
    assert cboe.symbols == [] and yahoo.symbols == []  # before any request


def test_main_with_fakes_makes_one_run(tmp_path, monkeypatch, capsys):
    waits = []
    monkeypatch.setattr(reads.clock, "sleep", waits.append)
    cboe, yahoo = Cboe(CBOE), Yahoo()
    arguments = ["--store", str(tmp_path / "store"), "--universe", str(universe_file(tmp_path)), "--outside-session"]
    assert reads.main(arguments, fetch_cboe=cboe, ticker_for=yahoo) == 0
    (day,) = (tmp_path / "store").iterdir()
    (folder,) = day.iterdir()
    record = json.loads((folder / "run.json").read_text())
    assert record["outsideSession"] is True and record["complete"] is True and record["candidates"] == ["AAA", "BBB"]
    assert len(cboe.symbols) == 7 and yahoo.symbols == ["AAA", "BBB"] and waits == [1.0] * 7
    assert "2 candidates of 6 funds" in capsys.readouterr().out


def test_the_cboe_requests_of_main_carry_the_user_agent_of_the_collector(tmp_path, monkeypatch):
    seen = []

    class Reply:
        headers = {}

        def __init__(self, request) -> None:
            self.symbol = request.full_url.rsplit("/", 1)[1].removesuffix(".json")

        def __enter__(self):
            return self

        def __exit__(self, *error) -> None:
            return None

        def read(self) -> bytes:
            return cboe_body(self.symbol)

    def urlopen(request, timeout):
        seen.append(request.get_header("User-agent"))
        return Reply(request)

    monkeypatch.setattr(reads.universe, "urlopen", urlopen)
    monkeypatch.setattr(reads.universe.Pace, "wait", lambda self, seconds=0.0: True)
    arguments = ["--store", str(tmp_path / "store"), "--universe", str(universe_file(tmp_path, ("AAA",))),
                 "--outside-session"]
    assert reads.main(arguments, ticker_for=Yahoo()) == 0
    assert reads.USER_AGENT == ("Mozilla/5.0 (compatible; vertex-research-leveraged-etf-spreads/1; research, "
                                "3 runs per session)")
    assert seen == [reads.USER_AGENT] * 2  # SPY and AAA
    assert "one run per day" in reads.universe.USER_AGENT  # the fetcher keeps its own text


def test_the_module_does_not_import_yfinance():
    assert "import yfinance" not in SCRIPT.read_text().split("def main(")[0]
