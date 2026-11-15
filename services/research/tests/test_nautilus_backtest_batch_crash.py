"""Batch case isolation: an unexpected exception in one case is that case's `crash` entry.

The other cases keep their results, the document is complete, and the batch ends with exit status 4.
The in-process tests stand in for the engine (no nautilus-trader needed); the subprocess test runs
the real faults on the golden bars when nautilus-trader is installed. Synthetic and committed
fixture data only: no network, model or broker.
"""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import pytest

import nautilus_backtest.__main__ as cli
from nautilus_backtest import engine
from nautilus_backtest.bars import InputError
from nautilus_backtest.engine import NautilusUnavailable

RESEARCH = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.filterwarnings("ignore:The 'generic' unit for NumPy timedelta:DeprecationWarning")
BARS = {"t": [86_400_000.0 * day for day in range(1, 5)], "o": [1.0] * 4, "h": [1.0] * 4, "l": [1.0] * 4,
        "c": [1.0] * 4}


def _installed() -> bool:
    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        engine.require()
        return True
    try:
        engine.require()
    except NautilusUnavailable:
        return False
    return True


needs_nautilus = pytest.mark.skipif(not _installed(), reason="nautilus-trader is not installed")


# Exceptions a fake case raises, by name: the request goes through a JSON file.
FAULTS: dict[str, BaseException] = {}


def _raising(case_id, fault):
    FAULTS[case_id] = fault
    return {"id": case_id, "spec": {"raise": case_id}}


@pytest.fixture
def fake_cases(monkeypatch):
    """`_run_case` stands in for the engine: the spec says what the case does."""
    FAULTS.clear()

    def run_case(bars, spec, rows):
        if "raise" in spec:
            raise FAULTS[spec["raise"]]
        if spec.get("nan"):
            return {"value": math.nan}
        return {"bars": len(bars.c), "name": spec["name"]}

    monkeypatch.setattr(cli, "_run_case", run_case)


def _batch(tmp_path, cases, out="out.json"):
    request = tmp_path / "in.json"
    request.write_text(json.dumps({"bars": BARS, "cases": cases}))
    target = "-" if out == "-" else str(tmp_path / out)
    return cli.main(["batch", str(request), target])


def _entries(tmp_path):
    return {entry["id"]: entry for entry in json.loads((tmp_path / "out.json").read_text())["results"]}


def _good(name):
    return {"id": name, "spec": {"name": name}}


def test_a_crashed_case_keeps_the_other_results_and_exits_4(tmp_path, capsys, fake_cases, monkeypatch):
    real = cli._run_case

    def run_case(bars, spec, rows):
        if spec.get("divide"):
            return {"x": 1 / 0}
        return real(bars, spec, rows)

    monkeypatch.setattr(cli, "_run_case", run_case)
    status = _batch(tmp_path, [_good("a"), {"id": "b", "spec": {"divide": True}}, _good("c")])
    assert status == cli.CRASH_STATUS == 4
    entries = _entries(tmp_path)
    assert entries["a"]["result"] == {"bars": 4, "name": "a"}
    assert entries["c"]["result"] == {"bars": 4, "name": "c"}
    assert entries["b"]["crash"] == "ZeroDivisionError: division by zero"
    assert set(entries["b"]) == {"id", "wallMs", "crash"}
    err = capsys.readouterr().err
    assert "Traceback (most recent call last)" in err and ", in run_case" in err
    assert err.strip().splitlines()[-1] == 'case "b" crashed: ZeroDivisionError: division by zero'


def test_good_results_next_to_a_crash_equal_a_clean_batch(tmp_path, fake_cases):
    assert _batch(tmp_path, [_good("a"), _good("c")]) == 0
    clean = _entries(tmp_path)
    assert _batch(tmp_path, [_good("a"), _raising("b", KeyError("spec")), _good("c")]) == 4
    mixed = _entries(tmp_path)
    for name in ("a", "c"):
        assert {k: v for k, v in mixed[name].items() if k != "wallMs"} == \
            {k: v for k, v in clean[name].items() if k != "wallMs"}
    assert mixed["b"]["crash"] == "KeyError: 'spec'"


def test_real_faults_of_a_case_are_crashes(tmp_path, capsys):
    """The faults the card names, raised before any engine code runs (no nautilus-trader needed)."""
    cases = [
        {"id": "spec-missing"},
        {"id": "spec-not-object", "spec": [1, 2]},
        {"id": "rule-not-object", "spec": {"rule": "smaCross"}},
        {"id": "slice-not-list", "spec": {"rule": {"kind": "smaCross"}}, "slice": 5},
    ]
    assert _batch(tmp_path, cases) == 4
    entries = _entries(tmp_path)
    assert entries["spec-missing"]["crash"] == "KeyError: 'spec'"
    assert entries["spec-not-object"]["crash"] == "AttributeError: 'list' object has no attribute 'get'"
    assert entries["rule-not-object"]["crash"] == "AttributeError: 'str' object has no attribute 'get'"
    assert entries["slice-not-list"]["crash"] == "TypeError: 'int' object is not subscriptable"
    assert all(set(entry) == {"id", "wallMs", "crash"} for entry in entries.values())
    assert all(entry["wallMs"] >= 0 for entry in entries.values())
    capsys.readouterr()


def test_a_result_that_json_cannot_hold_is_a_crash(tmp_path, capsys, fake_cases):
    assert _batch(tmp_path, [_good("a"), {"id": "nan", "spec": {"nan": True}}]) == 4
    entries = _entries(tmp_path)
    assert entries["a"]["result"]["name"] == "a"
    assert entries["nan"]["crash"] == "ValueError: Out of range float values are not JSON compliant: nan"
    assert entries["nan"]["wallMs"] >= 0
    assert capsys.readouterr().err.strip().splitlines()[-1].startswith('case "nan" crashed: ValueError: ')


@pytest.mark.parametrize("fault", [ImportError("no module"), ModuleNotFoundError("no module named x"),
                                   MemoryError(), KeyboardInterrupt(), SystemExit(9)])
def test_environment_and_process_faults_still_end_the_batch(tmp_path, fake_cases, fault):
    with pytest.raises(type(fault)):
        _batch(tmp_path, [_good("a"), _raising("b", fault)])
    assert not (tmp_path / "out.json").exists()


def test_nautilus_unavailable_still_exits_3_without_output(tmp_path, capsys, fake_cases):
    status = _batch(tmp_path, [_raising("b", NautilusUnavailable("nautilus-trader missing"))])
    assert status == 3
    assert not (tmp_path / "out.json").exists()
    assert capsys.readouterr().err.strip() == "nautilus-trader missing"


def test_input_error_is_unchanged_and_the_batch_is_clean(tmp_path, capsys, fake_cases):
    status = _batch(tmp_path, [_good("a"), _raising("b", InputError("costBps must be from 0 to 500"))])
    assert status == 0
    entries = _entries(tmp_path)
    assert entries["b"] == {"id": "b", "wallMs": entries["b"]["wallMs"], "error": "costBps must be from 0 to 500"}
    assert "crash" not in (tmp_path / "out.json").read_text()
    assert capsys.readouterr().err == ""


def test_a_clean_batch_document_is_one_dump_of_the_whole_document(tmp_path, monkeypatch, fake_cases):
    monkeypatch.setattr(cli, "_usage", lambda started: {"cpuMs": 1.5, "wallMs": 2.5})
    monkeypatch.setattr(cli.time, "perf_counter", lambda: 10.0)
    assert _batch(tmp_path, [_good("a"), _raising("b", InputError("bad"))]) == 0
    expected = cli._dump({"engine": engine.ENGINE_ID, "results": [
        {"id": "a", "wallMs": 0.0, "result": {"bars": 4, "name": "a"}},
        {"id": "b", "wallMs": 0.0, "error": "bad"},
    ], "usage": {"cpuMs": 1.5, "wallMs": 2.5}})
    assert (tmp_path / "out.json").read_text() == expected


def test_only_the_first_three_crashes_print_a_traceback(tmp_path, capsys, fake_cases):
    cases = [_raising(f"c{n}", RuntimeError(f"fault {n}")) for n in range(5)]
    assert _batch(tmp_path, cases) == 4
    err = capsys.readouterr().err
    assert err.count("Traceback (most recent call last)") == 3
    lines = [line for line in err.splitlines() if line.startswith("case ")]
    assert lines == [f'case "c{n}" crashed: RuntimeError: fault {n}' for n in range(5)]
    assert err.strip().splitlines()[-1] == 'case "c4" crashed: RuntimeError: fault 4'


def test_crash_text_is_one_line_cut_to_300_characters():
    assert cli._crash_text(ValueError("a\n  b\tc ")) == "ValueError: a b c"
    assert cli._crash_text(ValueError()) == "ValueError"
    assert cli._crash_text(ValueError("x" * 400)) == "ValueError: " + "x" * 288
    assert len(cli._crash_text(ValueError("x" * 400))) == cli.CRASH_TEXT_MAX == 300

    class Unreadable(Exception):
        def __str__(self):
            raise RuntimeError("no text")

    assert cli._crash_text(Unreadable()) == "Unreadable"


def test_stdout_mode_prints_the_document_and_exits_4(tmp_path, capsys, fake_cases):
    status = _batch(tmp_path, [_good("a"), _raising("b", RuntimeError("boom"))], out="-")
    assert status == 4
    payload = json.loads(capsys.readouterr().out)
    assert [sorted(k for k in e if k not in ("id", "wallMs")) for e in payload["results"]] == [["result"], ["crash"]]


@pytest.mark.parametrize("cases", [{"id": "a"}, "abc", [["a"]], [{"spec": {}}], [{"id": 5, "spec": {}}]])
def test_a_malformed_case_list_ends_the_batch_before_the_first_case(tmp_path, fake_cases, monkeypatch, cases):
    ran = []
    monkeypatch.setattr(cli, "_run_case", lambda bars, spec, rows: ran.append(spec) or {})
    with pytest.raises(ValueError, match="cases must be a list of objects with a string id"):
        _batch(tmp_path, cases)
    assert ran == []
    assert not (tmp_path / "out.json").exists()


@needs_nautilus
@pytest.mark.parametrize("bad", ["spec-not-object", "rule-not-object", "spec-missing", "slice-not-list"])
def test_cli_batch_keeps_both_good_results_around_a_real_crash(tmp_path, bad):
    golden = json.loads((RESEARCH / "tests/fixtures/nautilus_backtest/golden.json").read_text())
    case = golden["engine"][0]
    bars = golden["bars"][case["symbol"]]
    faults = {
        "spec-not-object": {"id": "spec-not-object", "spec": [1, 2]},
        "rule-not-object": {"id": "rule-not-object", "spec": {**case["spec"], "rule": "smaCross"}},
        "spec-missing": {"id": "spec-missing"},
        "slice-not-list": {"id": "slice-not-list", "spec": case["spec"], "slice": 5},
    }
    good = [{"id": "good-1", "spec": case["spec"]}, {"id": "good-2", "spec": case["spec"]}]

    def run(cases, output):
        request = tmp_path / "in.json"
        request.write_text(json.dumps({"bars": bars, "cases": cases}))
        done = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", str(request), str(output)],
                              cwd=RESEARCH, capture_output=True, text=True, check=False)
        return done, {e["id"]: {k: v for k, v in e.items() if k != "wallMs"}
                      for e in json.loads(output.read_text())["results"]}

    clean_run, clean = run(good, tmp_path / "clean.json")
    assert clean_run.returncode == 0, clean_run.stderr
    done, mixed = run([good[0], faults[bad], good[1]], tmp_path / "mixed.json")
    assert done.returncode == 4, done.stderr
    assert mixed["good-1"] == clean["good-1"] and mixed["good-2"] == clean["good-2"]
    assert set(mixed[bad]) == {"id", "crash"}
    assert done.stderr.strip().splitlines()[-1] == f'case "{bad}" crashed: {mixed[bad]["crash"]}'


@needs_nautilus
def test_a_fault_inside_the_engine_run_leaves_the_next_cases_equal_to_a_clean_batch(tmp_path, monkeypatch, capsys):
    """A fault raised inside the Nautilus run (in the strategy's on_bar, after 50 bar events) of the
    middle case: the cases before and after it, and a later clean batch in the same process, give
    the same entries as a clean batch."""
    golden = json.loads((RESEARCH / "tests/fixtures/nautilus_backtest/golden.json").read_text())
    case = golden["engine"][0]
    bars = golden["bars"][case["symbol"]]
    real_math = engine.math

    class FaultyMath:
        """Stands in for the `math` module of engine.py; isnan raises once armed and called 50 times."""
        armed = False
        calls = 0

        def __getattr__(self, name):
            return getattr(real_math, name)

        def isnan(self, value):
            if FaultyMath.armed:
                FaultyMath.calls += 1
                if FaultyMath.calls > 50:
                    raise ZeroDivisionError("probe fault inside on_bar")
            return real_math.isnan(value)

    monkeypatch.setattr(engine, "math", FaultyMath())
    inner = cli._batch_case

    def batch_case(bars_, case_, *rest):
        FaultyMath.armed = case_["id"] == "mid-engine"
        FaultyMath.calls = 0
        try:
            return inner(bars_, case_, *rest)
        finally:
            FaultyMath.armed = False

    monkeypatch.setattr(cli, "_batch_case", batch_case)

    def run(cases):
        (tmp_path / "in.json").write_text(json.dumps({"bars": bars, "cases": cases}))
        status = cli.main(["batch", str(tmp_path / "in.json"), str(tmp_path / "out.json")])
        return status, {e["id"]: {k: v for k, v in e.items() if k != "wallMs"} for e in _entries(tmp_path).values()}

    good = [{"id": "good-1", "spec": case["spec"]}, {"id": "good-2", "spec": case["spec"]}]
    clean_status, clean = run(good)
    status, mixed = run([good[0], {"id": "mid-engine", "spec": case["spec"]}, good[1]])
    again_status, again = run(good)
    assert (clean_status, status, again_status) == (0, 4, 0)
    assert mixed["mid-engine"] == {"id": "mid-engine", "crash": "ZeroDivisionError: probe fault inside on_bar"}
    assert mixed["good-1"] == clean["good-1"] and mixed["good-2"] == clean["good-2"]
    assert again == clean
    err = capsys.readouterr().err
    assert "in on_bar" in err
    assert err.strip().splitlines()[-1] == 'case "mid-engine" crashed: ZeroDivisionError: probe fault inside on_bar'
