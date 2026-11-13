"""Transcribe one reel audio file on the GPU with the external ``transcribe.py`` tool.

The tool (faster-whisper large-v3 on CUDA) is not part of this repository. It takes its work
directory from its own file location, transcribes ``media/*/*.m4a`` into
``transcripts/<platform>/<id>.json`` and exits when ``state/download.log`` contains ``DONE``.
So each note gets its own temporary work directory with one audio file, a finished download
log and an unmodified copy of the script, and the copy is run with the tool's own interpreter.

GPU rules:

- The script waits until the GPU has ``MIN_FREE_MIB`` of free memory before it loads the model.
  This module refuses to run a script whose gate is under 4,096 MiB or that does not load the
  model on CUDA. It passes no argument and sets no variable, so nothing lowers or skips the gate.
- There is no CPU path. A run that passes the time limit is killed and the command fails.
- The transcript must name ``cuda`` as its device.
"""
from __future__ import annotations

import ast
import json
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from .errors import NoteError
from .process import child_env, run_group
from .sources import clean_line

SCRIPT_ENV = "VERTEX_MARKET_NOTE_TRANSCRIBE"
PYTHON_ENV = "VERTEX_MARKET_NOTE_TRANSCRIBE_PYTHON"
DEFAULT_SCRIPT = "~/Github/tools/ig-kb-systemcracker/transcribe.py"
MIN_GATE_MIB = 4096
DEFAULT_TIMEOUT_S = 1800.0
MAX_TIMEOUT_S = 86_400.0
PLATFORM = "note"
GATE_NAME = "MIN_FREE_MIB"
MODEL_CLASS = "WhisperModel"
# Names that can change a module variable or run text as code without a plain assignment.
_INDIRECT_NAMES = frozenset({"exec", "eval", "compile", "globals", "locals", "vars", "setattr", "delattr",
                             "__import__", "__builtins__"})
_INDIRECT_ATTRIBUTES = frozenset({"__dict__", "__setattr__", "__builtins__"})
# Device values that are, or can become, the CPU.
_CPU_DEVICES = frozenset({"cpu", "auto"})

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


def _refuse(reason: str) -> NoteError:
    return NoteError(f"refused: the transcribe script {reason}")


def _is_text(node: ast.AST, value: str) -> bool:
    return isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value == value


def _gate(tree: ast.Module) -> int:
    """The GPU gate in MiB: one plain module-level assignment, no other store, compared at least once."""
    names = [node for node in ast.walk(tree) if isinstance(node, ast.Name) and node.id == GATE_NAME]
    stores = [node for node in names if not isinstance(node.ctx, ast.Load)]
    plain = [statement for statement in tree.body
             if isinstance(statement, ast.Assign) and len(statement.targets) == 1
             and isinstance(statement.targets[0], ast.Name) and statement.targets[0].id == GATE_NAME
             and isinstance(statement.value, ast.Constant) and type(statement.value.value) is int]
    if not stores:
        raise _refuse(f"has no `{GATE_NAME} = <n>` line at module level (the GPU gate)")
    if len(plain) != 1 or len(stores) != 1:
        raise _refuse(f"must set {GATE_NAME} once, at module level, to a plain whole number; "
                      "it sets the gate more than once or in another way")
    # Any other way to reach the name: a string, an attribute, a parameter, an import, `global`.
    unused_texts = {id(statement.value) for statement in ast.walk(tree) if isinstance(statement, ast.Expr)}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in _INDIRECT_NAMES:
            raise _refuse(f"uses {node.id}, which can change the GPU gate without an assignment")
        if isinstance(node, ast.Attribute) and node.attr in _INDIRECT_ATTRIBUTES:
            raise _refuse(f"uses {node.attr}, which can change the GPU gate without an assignment")
        if isinstance(node, ast.ImportFrom) and any(alias.name == "*" for alias in node.names):
            raise _refuse("has a star import, which can replace the GPU gate")
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) or id(node) in unused_texts:  # a bare text (a docstring) has no effect
            continue
        for _field, value in ast.iter_fields(node):
            for item in value if isinstance(value, list) else [value]:
                text = item.decode("latin-1") if isinstance(item, bytes) else item
                if isinstance(text, str) and GATE_NAME in text:
                    raise _refuse(f"names {GATE_NAME} outside a plain read (in a text, an attribute, a "
                                  "parameter, an import or a global statement)")
    compared = {id(name) for node in ast.walk(tree) if isinstance(node, ast.Compare)
                for name in ast.walk(node) if isinstance(name, ast.Name) and name.id == GATE_NAME}
    if not compared:
        raise _refuse(f"never compares the free GPU memory with {GATE_NAME} (the gate is not used)")
    gate = plain[0].value.value
    if gate < MIN_GATE_MIB:
        raise _refuse(f"has a GPU gate of {gate} MiB; at least {MIN_GATE_MIB} MiB is required")
    return gate


def _require_cuda(tree: ast.Module) -> None:
    """Every device in the script is the constant "cuda", and the model is loaded with it."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.strip().lower() in _CPU_DEVICES:
            raise _refuse(f"names the device {node.value.strip()!r}; the only device is cuda")
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values, strict=True):
                if key is not None and _is_text(key, "device") and not _is_text(value, "cuda"):
                    raise _refuse('has a "device" entry that is not the text "cuda"')
    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)]
    devices = [keyword for call in calls for keyword in call.keywords if keyword.arg == "device"]
    if not devices:
        raise _refuse('does not load the model with device="cuda"')
    if any(not _is_text(keyword.value, "cuda") for keyword in devices):
        raise _refuse('passes a device that is not the text "cuda"')
    model_calls = [call for call in calls
                   if (isinstance(call.func, ast.Name) and call.func.id == MODEL_CLASS)
                   or (isinstance(call.func, ast.Attribute) and call.func.attr == MODEL_CLASS)]
    if not model_calls:
        raise _refuse(f'does not load the model with {MODEL_CLASS}(..., device="cuda")')
    for call in model_calls:
        if len(call.args) > 1 or any(isinstance(arg, ast.Starred) for arg in call.args):
            raise _refuse(f"passes more than the model name by position to {MODEL_CLASS}; "
                          "the device must be the keyword device=\"cuda\"")
        if any(keyword.arg is None for keyword in call.keywords):
            raise _refuse(f"passes ** arguments to {MODEL_CLASS}; the device must be the keyword device=\"cuda\"")
        if not any(keyword.arg == "device" for keyword in call.keywords):
            raise _refuse(f'has a {MODEL_CLASS} call without device="cuda"')
    # The class under another name could take the device by position without this check seeing it.
    called = {id(call.func) for call in model_calls}
    for node in ast.walk(tree):
        other_name = isinstance(node, ast.Name) and node.id == MODEL_CLASS and id(node) not in called
        other_attribute = isinstance(node, ast.Attribute) and node.attr == MODEL_CLASS and id(node) not in called
        renamed = isinstance(node, ast.alias) and node.name.split(".")[-1] == MODEL_CLASS and node.asname not in (None, MODEL_CLASS)
        if other_name or other_attribute or renamed:
            raise _refuse(f"uses {MODEL_CLASS} under another name or without a call")


def check_script(source: str | bytes) -> int:
    """The GPU gate of the script in MiB. Refuses a script with a low gate or without CUDA.

    The check reads the syntax tree, so a comment or a docstring cannot satisfy it:

    - exactly one module-level ``MIN_FREE_MIB = <whole number>`` of at least 4,096, no other
      plain store to that name, and the value is compared at least once;
    - every ``device=`` keyword and every ``"device"`` dictionary entry is the text ``"cuda"``,
      the model class is called with that keyword, and no text names the CPU.

    Bytes are parsed as the interpreter reads the file (its encoding line counts). The check
    guards against an edited or outdated script. It is not a sandbox: a script written to
    deceive it can still pass, so the script path must point to a trusted file.
    """
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        raise _refuse("is not valid Python") from None
    gate = _gate(tree)
    _require_cuda(tree)
    return gate


def tool_paths(environ: Mapping[str, str]) -> tuple[Path, Path]:
    """The script file and the interpreter that runs it."""
    script = Path(environ.get(SCRIPT_ENV) or DEFAULT_SCRIPT).expanduser()
    python = environ.get(PYTHON_ENV)
    # Not resolved: a venv interpreter is a link, and the link is what selects the venv.
    return script, Path(python).expanduser() if python else script.parent / ".venv" / "bin" / "python"


def preflight(environ: Mapping[str, str]) -> int:
    """Check the tool before any download: the script passes ``check_script`` and its interpreter exists."""
    script, python = tool_paths(environ)
    try:
        gate = check_script(script.read_bytes())
    except OSError:
        raise NoteError(f"the transcribe script is missing ({script}); set {SCRIPT_ENV}") from None
    if not python.is_file():
        raise NoteError(f"the transcribe interpreter is missing ({python}); set {PYTHON_ENV}")
    return gate


@dataclass(frozen=True)
class Transcript:
    text: str
    language: str | None
    duration_s: float | None
    model_id: str | None


def _tail(output: object) -> str:
    text = output.decode("utf-8", "replace") if isinstance(output, bytes) else str(output or "")
    lines = [line for line in text.splitlines() if line.strip()]
    return clean_line(lines[-1], 200) or "" if lines else ""


def read_transcript(path: Path) -> Transcript:
    """The transcript of the run. Refuses a missing, failed, empty or non-GPU transcript."""
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        raise NoteError("the transcribe run wrote no transcript") from None
    except ValueError:
        raise NoteError("the transcript file is not JSON") from None
    if not isinstance(record, dict):
        raise NoteError("the transcript file is not a JSON object")
    if "error" in record:
        raise NoteError(f"transcription failed: {clean_line(str(record['error']), 300) or 'no message'}")
    model = record.get("model")
    device = model.get("device") if isinstance(model, dict) else None
    if device != "cuda":
        raise NoteError(f"refused: the transcript was made on {clean_line(str(device), 40)!r}, not on cuda")
    text = record.get("text")
    if not isinstance(text, str) or not text.strip():
        raise NoteError("the transcript has no text (no speech was found in the audio)")
    language, duration = record.get("language"), record.get("duration")
    model_id = model.get("id")
    return Transcript(
        text=text.strip(), language=language if isinstance(language, str) else None,
        duration_s=float(duration) if isinstance(duration, (int, float)) and not isinstance(duration, bool) else None,
        model_id=model_id if isinstance(model_id, str) else None)


def transcribe(audio: Path, media_id: str, *, environ: Mapping[str, str] | None = None,
               run: Runner = run_group, timeout_s: float = DEFAULT_TIMEOUT_S) -> Transcript:
    """Transcribe ``audio`` (m4a) on the GPU and return its text."""
    source = os.environ if environ is None else environ
    if not 0 < timeout_s <= MAX_TIMEOUT_S:
        raise NoteError(f"the transcribe timeout must be in (0, {MAX_TIMEOUT_S:g}] seconds")
    if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", media_id) is None:
        raise NoteError("the media id is not a plain file name")
    script, python = tool_paths(source)
    try:
        original = script.read_bytes()
    except OSError:
        raise NoteError(f"the transcribe script is missing ({script}); set {SCRIPT_ENV}") from None
    # The bytes that were checked are the bytes that run: the copy is written from this buffer.
    gate = check_script(original)
    work = Path(tempfile.mkdtemp(prefix="vertex-market-note-asr-"))
    try:
        (work / "media" / PLATFORM).mkdir(parents=True)
        (work / "state").mkdir()
        shutil.copyfile(audio, work / "media" / PLATFORM / f"{media_id}.m4a")
        (work / "state" / "download.log").write_text("DONE\n", encoding="utf-8")
        copy = work / "transcribe.py"
        copy.write_bytes(original)
        try:  # the script sets its own CUDA library path; the allow-list passes nothing that it reads
            done = run([str(python), str(copy)], cwd=str(work), env=child_env(source), timeout=timeout_s)
        except subprocess.TimeoutExpired as expired:
            last = _tail(expired.output)
            raise NoteError(
                f"transcription stopped after {timeout_s:g} s: the GPU gate ({gate} MiB free) did not "
                "open or the run did not finish. The process was killed; nothing was stored"
                + (f" (last output: {last})" if last else "")) from None
        except OSError as error:
            raise NoteError(f"could not start the transcribe interpreter {python} "
                            f"({error.strerror or type(error).__name__}); set {PYTHON_ENV}") from None
        if done.returncode != 0:
            raise NoteError(f"the transcribe run failed (exit {done.returncode}): "
                            f"{_tail(done.stdout) or 'no output'}")
        return read_transcript(work / "transcripts" / PLATFORM / f"{media_id}.json")  # json-data-ignore: output file of the external transcribe tool in a temporary work directory; not stored data
    finally:
        shutil.rmtree(work, ignore_errors=True)
