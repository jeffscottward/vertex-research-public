"""Market note transcription guard: the GPU gate, the CUDA rule, the time limit. No GPU in tests."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from market_notes import process
from market_notes import transcribe as asr
from market_notes.errors import NoteError

# A stand-in with the structure of the external tool: gate line, gate loop, model call, record.
SCRIPT = '''#!/usr/bin/env python3
"""Stand-in for the external tool. The model loads only when free VRAM >= MIN_FREE_MIB.

A line such as MIN_FREE_MIB = 1 or device="cpu" in this text is not code.
"""
import time
from pathlib import Path

W = Path(__file__).resolve().parent
MIN_FREE_MIB = 4096
MODEL = "large-v3"


def free_mib():
    return 0


def wait_gate():
    while free_mib() < MIN_FREE_MIB:
        print(f"GPU gate: free {free_mib()} MiB < {MIN_FREE_MIB}; waiting", flush=True)
        time.sleep(60)


def load():
    wait_gate()
    return WhisperModel(MODEL, device="cuda", compute_type="int8_float16")


rec = {"model": {"id": MODEL, "device": "cuda", "compute_type": "int8_float16"}}
'''
GATE_LINE = "MIN_FREE_MIB = 4096\n"
GATE_LOOP = "    while free_mib() < MIN_FREE_MIB:\n"
MODEL_CALL = 'WhisperModel(MODEL, device="cuda", compute_type="int8_float16")'
GOOD = {"text": " Capex is near a peak. ", "segments": [], "language": "en", "duration": 61.5,
        "model": {"id": "Systran/faster-whisper-large-v3", "device": "cuda", "compute_type": "int8_float16"}}


def test_a_script_with_the_gate_and_the_cuda_model_call_passes():
    assert asr.check_script(SCRIPT) == 4096
    assert asr.check_script(SCRIPT.encode()) == 4096  # the bytes that run are the bytes that are checked
    assert asr.check_script(SCRIPT.replace(GATE_LINE, "MIN_FREE_MIB = 8192  # more headroom\n")) == 8192
    assert asr.check_script(SCRIPT.replace("WhisperModel(MODEL,", "faster_whisper.WhisperModel(MODEL,")) == 4096
    assert asr.check_script(SCRIPT.replace(GATE_LOOP, "    while MIN_FREE_MIB > free_mib():\n")) == 4096
    assert asr.MIN_GATE_MIB == 4096 and asr.DEFAULT_TIMEOUT_S == 1800


def changed(old: str, new: str) -> str:
    assert SCRIPT.count(old) == 1, old
    return SCRIPT.replace(old, new)


GATE_BYPASSES = {
    "below the minimum": (changed(GATE_LINE, "MIN_FREE_MIB = 4095\n"), "GPU gate of 4095 MiB"),
    "zero": (changed(GATE_LINE, "MIN_FREE_MIB = 0\n"), "GPU gate of 0 MiB"),
    "set again later": (SCRIPT + "MIN_FREE_MIB = 1\n", "more than once or in another way"),
    "set again before": (changed(GATE_LINE, "MIN_FREE_MIB = 1\n" + GATE_LINE), "more than once or in another way"),
    "lowered in place": (SCRIPT + "MIN_FREE_MIB -= 4096\n", "more than once or in another way"),
    "tuple store": (SCRIPT + "MIN_FREE_MIB, other = 0, 1\n", "more than once or in another way"),
    "tuple store only": (changed(GATE_LINE, "MIN_FREE_MIB, other = 4096, 1\n"), "more than once or in another way"),
    "chained store": (changed(GATE_LINE, "other = MIN_FREE_MIB = 4096\n"), "more than once or in another way"),
    "walrus": (SCRIPT + "if (MIN_FREE_MIB := 0):\n    pass\n", "more than once or in another way"),
    "annotated": (changed(GATE_LINE, "MIN_FREE_MIB: int = 4096\n"), "more than once or in another way"),
    "local shadow": (changed(GATE_LOOP, "    MIN_FREE_MIB = 0\n" + GATE_LOOP), "more than once or in another way"),
    "loop target": (SCRIPT + "for MIN_FREE_MIB in (0,):\n    pass\n", "more than once or in another way"),
    "deleted": (SCRIPT + "del MIN_FREE_MIB\n", "more than once or in another way"),
    "inside a block": (changed(GATE_LINE, "if True:\n    MIN_FREE_MIB = 4096\n"), "more than once or in another way"),
    "from the environment": (changed(GATE_LINE, "MIN_FREE_MIB = int(os.environ.get('GATE', 0))\n"), "more than once or in another way"),
    "conditional value": (changed(GATE_LINE, "MIN_FREE_MIB = 4096 if STRICT else 0\n"), "more than once or in another way"),
    "negative": (changed(GATE_LINE, "MIN_FREE_MIB = -4096\n"), "more than once or in another way"),
    "a float": (changed(GATE_LINE, "MIN_FREE_MIB = 4096.0\n"), "more than once or in another way"),
    "a text": (changed(GATE_LINE, 'MIN_FREE_MIB = "4096"\n'), "more than once or in another way"),
    "a boolean": (changed(GATE_LINE, "MIN_FREE_MIB = True\n"), "more than once or in another way"),
    "globals store": (SCRIPT + 'globals()["MIN_FREE_MIB"] = 0\n', "uses globals"),
    "globals update": (SCRIPT + 'globals().update(MIN_FREE_MIB=0)\n', "uses globals"),
    "vars store": (SCRIPT + 'vars()["MIN_FREE_" + "MIB"] = 0\n', "uses vars"),
    "setattr": (SCRIPT + 'import sys\nsetattr(sys.modules[__name__], "MIN_FREE_" + "MIB", 0)\n', "uses setattr"),
    "exec": (SCRIPT + 'exec("MIN_FREE_" + "MIB = 0")\n', "uses exec"),
    "module dict": (SCRIPT + 'import sys\nsys.modules[__name__].__dict__["x"] = 0\n', "uses __dict__"),
    "attribute store": (SCRIPT + "import sys\nsys.modules[__name__].MIN_FREE_MIB = 0\n", "outside a plain read"),
    "name in a text": (SCRIPT + 'KEY = "MIN_FREE_MIB"\n', "outside a plain read"),
    "name in bytes": (SCRIPT + 'KEY = b"MIN_FREE_MIB"\n', "outside a plain read"),
    "global statement": (changed(GATE_LOOP, "    global MIN_FREE_MIB\n" + GATE_LOOP), "outside a plain read"),
    "parameter": (changed("def wait_gate():", "def wait_gate(MIN_FREE_MIB=0):"), "outside a plain read"),
    "import alias": (SCRIPT + "import settings as MIN_FREE_MIB\n", "outside a plain read"),
    "except name": (SCRIPT + "try:\n    pass\nexcept Exception as MIN_FREE_MIB:\n    pass\n", "outside a plain read"),
    "function name": (SCRIPT + "def MIN_FREE_MIB():\n    return 0\n", "outside a plain read"),
    "star import": (SCRIPT + "from settings import *\n", "star import"),
    "only in a docstring": (changed(GATE_LINE, '"""MIN_FREE_MIB = 4096"""\n'), "has no `MIN_FREE_MIB = <n>` line"),
    "only in a comment": (changed(GATE_LINE, "# MIN_FREE_MIB = 4096\n"), "has no `MIN_FREE_MIB = <n>` line"),
    "another name": (changed(GATE_LINE, "GATE = 4096\n"), "has no `MIN_FREE_MIB = <n>` line"),
    "never compared": (changed(GATE_LOOP, "    while free_mib() < 1:\n"), "never compares"),
    "only printed": (changed(GATE_LOOP, "    print(MIN_FREE_MIB)\n    while False:\n"), "never compares"),
}
DEVICE_BYPASSES = {
    "cpu": (changed('device="cuda", compute_type', 'device="cpu", compute_type'), "names the device 'cpu'"),
    "cpu with a cuda comment": (changed('device="cuda", compute_type="int8_float16")',
                                        'device="cpu", compute_type="int8_float16")  # device="cuda"'), "names the device 'cpu'"),
    "cpu in upper case": (SCRIPT + 'FALLBACK = " CPU "\n', "names the device 'CPU'"),
    "auto": (changed('device="cuda", compute_type', 'device="auto", compute_type'), "names the device 'auto'"),
    "conditional": (changed('device="cuda", compute_type', 'device="cuda" if ok() else "cpu", compute_type'), "names the device 'cpu'"),
    "conditional without cpu text": (changed('device="cuda", compute_type', 'device="cuda" if ok() else other(), compute_type'),
                                     'passes a device that is not the text "cuda"'),
    "a variable": (changed('device="cuda", compute_type', "device=DEVICE, compute_type"), 'passes a device that is not the text "cuda"'),
    "a built text": (changed('device="cuda", compute_type', 'device="cu" + "da", compute_type'), 'passes a device that is not the text "cuda"'),
    "cuda only in a comment": (changed(MODEL_CALL, 'WhisperModel(MODEL)  # device="cuda"'), 'does not load the model with device="cuda"'),
    "no device keyword on the model": (changed(MODEL_CALL, 'WhisperModel(MODEL)') + 'other(device="cuda")\n', 'call without device="cuda"'),
    "device by position": (changed(MODEL_CALL, 'WhisperModel(MODEL, DEVICE, device="cuda")'), "more than the model name by position"),
    "star arguments": (changed(MODEL_CALL, 'WhisperModel(*ARGS, device="cuda")'), "more than the model name by position"),
    "double star arguments": (changed(MODEL_CALL, 'WhisperModel(MODEL, device="cuda", **MORE)'), "passes ** arguments"),
    "class under another name": (SCRIPT + "Model = WhisperModel\nModel(MODEL, OTHER)\n", "under another name"),
    "import under another name": (SCRIPT + "from faster_whisper import WhisperModel as Model\n", "under another name"),
    "no model call": (changed(MODEL_CALL, 'other(MODEL, device="cuda")'), "does not load the model with WhisperModel"),
    "record names another device": (changed('"device": "cuda", "compute_type"', '"device": DEVICE, "compute_type"'),
                                    'has a "device" entry that is not the text "cuda"'),
    "record names the cpu": (changed('"device": "cuda", "compute_type"', '"device": "cpu", "compute_type"'),
                             'has a "device" entry that is not the text "cuda"'),
}
NOT_PYTHON = {
    "syntax error": ("def (:\n", "is not valid Python"),
    "a NUL byte": (SCRIPT.encode() + b"\x00", "is not valid Python"),
    "bytes of another encoding": (b"# -*- coding: no-such-codec -*-\n" + SCRIPT.encode(), "is not valid Python"),
    "empty": ("", "has no `MIN_FREE_MIB = <n>` line"),
}
REFUSALS = {**GATE_BYPASSES, **DEVICE_BYPASSES, **NOT_PYTHON}


@pytest.mark.parametrize("case", sorted(REFUSALS))
def test_a_script_that_can_lower_the_gate_or_leave_the_gpu_is_refused(case: str):
    text, message = REFUSALS[case]
    with pytest.raises(NoteError) as caught:
        asr.check_script(text)
    assert message in str(caught.value), str(caught.value)
    assert str(caught.value).startswith("refused: the transcribe script ")


# Read as UTF-8 the last line is a comment. Read as UTF-7 (the file's own encoding line) "+AAo-" is a
# line break, so the interpreter would run a second store that sets the gate to 0.
HIDDEN_STORE = b"# -*- coding: utf-7 -*-\n" + SCRIPT.encode("ascii") + b"# note +AAo-MIN_FREE_MIB = 0\n"


def test_an_encoding_line_is_read_the_way_the_interpreter_reads_it():
    assert asr.check_script(HIDDEN_STORE.decode("utf-8")) == 4096  # as text, the store cannot be seen
    assert "\nMIN_FREE_MIB = 0\n" in HIDDEN_STORE.decode("utf-7")
    with pytest.raises(NoteError, match="more than once or in another way"):
        asr.check_script(HIDDEN_STORE)


class FakeRun:
    """Stands in for the GPU run: records the call and writes the transcript the test asks for."""

    def __init__(self, record: Any = GOOD, *, returncode: int = 0, stdout: str = "DONE transcribed 1\n",
                 raises: BaseException | None = None) -> None:
        self.record, self.returncode, self.stdout, self.raises = record, returncode, stdout, raises
        self.calls: list[dict[str, Any]] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        work = Path(kwargs["cwd"])
        audio = sorted(path.relative_to(work).as_posix() for path in (work / "media").glob("*/*.m4a"))
        self.calls.append({"argv": argv, **kwargs, "audio": audio, "work": work,
                           "script": (work / "transcribe.py").read_bytes(),
                           "log": (work / "state" / "download.log").read_text(),
                           "audio_bytes": (work / audio[0]).read_bytes()})
        if self.raises is not None:
            raise self.raises
        if self.record is not None:
            target = work / "transcripts" / "note" / (Path(audio[0]).stem + ".json")
            target.parent.mkdir(parents=True)
            target.write_text(self.record if isinstance(self.record, str) else json.dumps(self.record), encoding="utf-8")
        return subprocess.CompletedProcess(argv, self.returncode, self.stdout, "")


@pytest.fixture()
def tool(tmp_path: Path) -> dict[str, str]:
    folder = tmp_path / "tool"
    (folder / ".venv" / "bin").mkdir(parents=True)
    (folder / "transcribe.py").write_text(SCRIPT, encoding="utf-8")
    (folder / ".venv" / "bin" / "python").write_text("", encoding="utf-8")
    (tmp_path / "note.m4a").write_bytes(b"audio-bytes")
    return {"VERTEX_MARKET_NOTE_TRANSCRIBE": str(folder / "transcribe.py"), "VERTEX_AGENT_API_KEY": "vx_secret",
            "SC_CUDA_PATH_SET": "1", "MIN_FREE_MIB": "0", "PATH": "/usr/bin", "HF_HOME": "/models"}


def test_runs_an_unmodified_copy_in_a_work_directory_of_its_own(tool: dict[str, str], tmp_path: Path):
    run = FakeRun()
    result = asr.transcribe(tmp_path / "note.m4a", "DfmxTYzBO1s", environ=tool, run=run)
    assert result == asr.Transcript("Capex is near a peak.", "en", 61.5, "Systran/faster-whisper-large-v3")
    call = run.calls[0]
    work = call["work"]
    # The interpreter is the tool's own venv; the only argument is the copied script. Nothing else is passed.
    assert call["argv"] == [str(tmp_path / "tool" / ".venv" / "bin" / "python"), str(work / "transcribe.py")]
    assert call["cwd"] == str(work) and call["timeout"] == 1800
    assert work != tmp_path / "tool" and work.name.startswith("vertex-market-note-asr-")
    assert call["script"] == SCRIPT.encode() and call["log"].strip() == "DONE"
    assert call["audio"] == ["media/note/DfmxTYzBO1s.m4a"] and call["audio_bytes"] == b"audio-bytes"
    # Only allow-listed variables reach the tool: no key, and nothing that the script could read as a setting.
    assert call["env"] == {"PATH": "/usr/bin", "HF_HOME": "/models"}
    assert set(call) == {"argv", "cwd", "env", "timeout", "audio", "work", "script", "log", "audio_bytes"}
    assert not work.exists()  # the work directory is removed
    assert (tmp_path / "tool" / "transcribe.py").read_text() == SCRIPT  # the tool itself is untouched
    assert asr.transcribe.__kwdefaults__["run"] is process.run_group  # the real run uses the process-group runner


def test_the_interpreter_can_be_set(tool: dict[str, str], tmp_path: Path):
    run = FakeRun()
    asr.transcribe(tmp_path / "note.m4a", "note", environ={**tool, "VERTEX_MARKET_NOTE_TRANSCRIBE_PYTHON": "/opt/asr/bin/python"},
                   run=run, timeout_s=90)
    assert run.calls[0]["argv"][0] == "/opt/asr/bin/python" and run.calls[0]["timeout"] == 90
    script, python = asr.tool_paths({})
    assert script == Path("~/Github/tools/ig-kb-systemcracker/transcribe.py").expanduser()
    assert python == script.parent / ".venv" / "bin" / "python"


def test_preflight_checks_the_script_and_the_interpreter(tool: dict[str, str], tmp_path: Path):
    assert asr.preflight(tool) == 4096
    with pytest.raises(NoteError, match="interpreter is missing"):
        asr.preflight({**tool, "VERTEX_MARKET_NOTE_TRANSCRIBE_PYTHON": str(tmp_path / "absent")})
    Path(tool["VERTEX_MARKET_NOTE_TRANSCRIBE"]).write_text(SCRIPT + "MIN_FREE_MIB -= 4096\n", encoding="utf-8")
    with pytest.raises(NoteError, match="more than once or in another way"):
        asr.preflight(tool)


def test_a_refused_script_is_never_run(tool: dict[str, str], tmp_path: Path):
    script = Path(tool["VERTEX_MARKET_NOTE_TRANSCRIBE"])
    for case in ("below the minimum", "lowered in place", "globals store", "cpu with a cuda comment", "conditional"):
        text, message = REFUSALS[case]
        script.write_text(text, encoding="utf-8")
        run = FakeRun()
        with pytest.raises(NoteError) as caught:
            asr.transcribe(tmp_path / "note.m4a", "note", environ=tool, run=run)
        assert message in str(caught.value) and run.calls == []
    # The file's bytes are checked, not a decoded text of them.
    script.write_bytes(HIDDEN_STORE)
    run = FakeRun()
    with pytest.raises(NoteError, match="more than once or in another way"):
        asr.transcribe(tmp_path / "note.m4a", "note", environ=tool, run=run)
    with pytest.raises(NoteError, match="more than once or in another way"):
        asr.preflight(tool)
    assert run.calls == []
    script.unlink()
    with pytest.raises(NoteError, match="VERTEX_MARKET_NOTE_TRANSCRIBE"):
        asr.transcribe(tmp_path / "note.m4a", "note", environ=tool, run=FakeRun())


def test_a_timeout_fails_and_names_the_gpu_gate(tool: dict[str, str], tmp_path: Path):
    expired = subprocess.TimeoutExpired(["python"], 1800, output="GPU gate: free 1200 MiB < 4096; waiting\n")
    run = FakeRun(raises=expired)
    with pytest.raises(NoteError) as caught:
        asr.transcribe(tmp_path / "note.m4a", "note", environ=tool, run=run)
    message = str(caught.value)
    assert "stopped after 1800 s" in message
    assert "the GPU gate (4096 MiB free) did not open or the run did not finish" in message
    assert "killed" in message and "GPU gate: free 1200 MiB < 4096; waiting" in message
    assert not run.calls[0]["work"].exists()


def test_a_stop_signal_during_the_run_removes_the_work_directory(tool: dict[str, str], tmp_path: Path):
    run = FakeRun(raises=process.Terminated(15))
    with pytest.raises(process.Terminated):
        asr.transcribe(tmp_path / "note.m4a", "note", environ=tool, run=run)
    assert not run.calls[0]["work"].exists()


@pytest.mark.parametrize(("record", "returncode", "text"), [
    ({"error": "RuntimeError: decode failed"}, 0, "transcription failed: RuntimeError: decode failed"),
    ({**GOOD, "error": "partial"}, 0, "transcription failed: partial"),
    ({**GOOD, "model": {**GOOD["model"], "device": "cpu"}}, 0, "made on 'cpu', not on cuda"),
    ({**GOOD, "model": {"id": "x"}}, 0, "not on cuda"),
    ({"text": "words"}, 0, "not on cuda"),
    ({**GOOD, "text": "   "}, 0, "no text"),
    ({**GOOD, "text": None}, 0, "no text"),
    (None, 0, "wrote no transcript"),
    ("{not json", 0, "not JSON"),
    ("[1, 2]", 0, "not a JSON object"),
    (GOOD, 1, r"failed \(exit 1\): RuntimeError: CUDA failed"),
])
def test_a_bad_run_or_a_bad_transcript_is_refused(tool: dict[str, str], tmp_path: Path, record: Any,
                                                    returncode: int, text: str):
    run = FakeRun(record, returncode=returncode, stdout="Traceback ...\nRuntimeError: CUDA failed\n" if returncode else "DONE\n")
    with pytest.raises(NoteError, match=text):
        asr.transcribe(tmp_path / "note.m4a", "note", environ=tool, run=run)
    assert not run.calls[0]["work"].exists()


def test_bad_arguments_stop_before_any_run(tool: dict[str, str], tmp_path: Path):
    run = FakeRun()
    for media_id, timeout in (("../x", 10), ("a b", 10), ("", 10), ("note", 0), ("note", -1), ("note", 90_000)):
        with pytest.raises(NoteError):
            asr.transcribe(tmp_path / "note.m4a", media_id, environ=tool, run=run, timeout_s=timeout)
    with pytest.raises(NoteError, match="interpreter"):
        asr.transcribe(tmp_path / "note.m4a", "note", environ=tool,
                       run=FakeRun(raises=FileNotFoundError(2, "No such file or directory")))
    assert run.calls == []
