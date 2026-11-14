"""Market notes boundary: the package reaches no order, sizing or risk code, and none of it reaches the package."""
from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

RESEARCH = Path(__file__).resolve().parents[1]
REPO = RESEARCH.parents[1]
PACKAGE = RESEARCH / "market_notes"
MODULES = ["__init__", "cli", "client", "contract", "errors", "evidence", "extract", "process", "render", "sources",
           "transcribe"]
# The only repository modules the package may import: the HTTP safety rules of the run recorder,
# the Claude-through-OMP transport and the read-only Financial Datasets research reader. Every
# other import must be the standard library or a module of the package itself.
ALLOWED_REPOSITORY_MODULES = {"adapters.vertex_run_recorder", "agents.omp_claude", "providers.financialdatasets_cli"}
# Folders that hold Python packages of this repository (the import roots of the services).
IMPORT_ROOTS = [RESEARCH, *(REPO / "services" / name for name in (
    "control-client", "market-data", "execution", "contracts/python/src", "host", "gateway", "kernel-bridge/python",
    "vibe-trading/driver", "openbb"))]
# Outside the package, only these files may name it: its tests and the two allocation scripts,
# which write the notes into a document key and use them in no computation.
ALLOWED_USERS = {"research/backtests/allocation/run.py", "research/backtests/allocation/funded_pie.py"}
ALLOCATION_FILES = ALLOWED_USERS | {"research/backtests/allocation/README.md"}
NOTE_WORDS = ("market_notes", "ownerMarketNotes", "owner_market_notes", "marketNotes", "market-notes")
SKIPPED_FOLDERS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".next", ".turbo", "dist", "build", ".pytest_cache",
                   "target"}


def imports_of(path: Path) -> set[str]:
    """Every imported name of one file. ``from a import b`` is ``a.b``, so a submodule import is seen as one."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            base = "." * node.level + (node.module or "")
            found.update(f"{base}{'' if base.endswith('.') or not base else '.'}{alias.name}" for alias in node.names)
        elif isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
    return found


def repository_module(name: str) -> str | None:
    """The longest prefix of a dotted name that is a module or a package of this repository, or None."""
    parts = name.split(".")
    for length in range(len(parts), 0, -1):
        relative = Path(*parts[:length])
        for root in IMPORT_ROOTS:
            if (root / relative).with_suffix(".py").is_file() or (root / relative / "__init__.py").is_file() \
                    or (length == 1 and (root / relative).is_dir() and relative.name != "tests"):
                return ".".join(parts[:length])
    return None


def violations(path: Path) -> list[str]:
    """The imports of one package file that are outside the allow-list."""
    own = {module for module in MODULES if module != "__init__"}
    bad = []
    for name in sorted(imports_of(path)):
        if name.startswith("."):
            # Only this package: one dot, then a module of the package or a name of its __init__.
            head = name[1:].split(".")[0]
            if name.startswith("..") or head not in own:
                bad.append(name)
            continue
        module = repository_module(name)
        if module is not None:
            if module not in ALLOWED_REPOSITORY_MODULES:
                bad.append(name)
        elif name.split(".")[0] not in sys.stdlib_module_names:
            bad.append(name)
    return bad


def test_the_package_imports_only_the_allowed_modules():
    files = sorted(PACKAGE.glob("*.py"))
    assert [path.stem for path in files] == MODULES
    assert not [path for path in PACKAGE.rglob("*") if path.is_dir() and path.name != "__pycache__"]
    used = set()
    for path in files:
        assert violations(path) == [], (path.name, violations(path))
        used |= {repository_module(name) for name in imports_of(path) if not name.startswith(".")} - {None}
    assert used == ALLOWED_REPOSITORY_MODULES  # the list holds nothing that is not needed


@pytest.mark.parametrize(("line", "bad"), [
    ("from providers import ibkr_history", ["providers.ibkr_history"]),
    ("from providers import quantdata", ["providers.quantdata"]),
    ("from providers import financialdatasets_cli, quantpad", ["providers.quantpad"]),
    ("import providers", ["providers"]),
    ("import ibkr_history", ["ibkr_history"]),
    ("from strategies.qc_ports import allocation as al", ["strategies.qc_ports.allocation"]),
    ("import strategies.qc_ports.allocation", ["strategies.qc_ports.allocation"]),
    ("from strategies import qc_ports", ["strategies.qc_ports"]),
    ("from adapters import handlers", ["adapters.handlers"]),
    ("from agents import orchestrator", ["agents.orchestrator"]),
    ("from agents.external_research import ExternalResearchError", ["agents.external_research.ExternalResearchError"]),
    ("import vertex_execution", ["vertex_execution"]),
    ("from vertex_execution import orders", ["vertex_execution.orders"]),
    ("from vertex_control.client import ControlClient", ["vertex_control.client.ControlClient"]),
    ("import requests", ["requests"]),
    ("from pydantic import BaseModel", ["pydantic.BaseModel"]),
    ("from .. import agents", ["..agents"]),
    ("from ..strategies import qc_ports", ["..strategies.qc_ports"]),
    ("from . import orders", [".orders"]),
    ("from .orders import submit", [".orders.submit"]),
])
def test_the_import_check_sees_a_forbidden_import(tmp_path: Path, line: str, bad: list[str]):
    source = tmp_path / "probe.py"
    source.write_text(f"import json\nfrom . import contract\nfrom .client import MarketNotesClient\n{line}\n", encoding="utf-8")
    assert violations(source) == bad


@pytest.mark.parametrize("line", [
    "from agents.omp_claude import OmpClaudeGenerator", "from agents import omp_claude", "import agents.omp_claude",
    "from providers import financialdatasets_cli as fd", "from adapters.vertex_run_recorder import _origin",
    "from urllib.parse import urlsplit", "import urllib.request", "from . import contract, process", "from .errors import NoteError",
])
def test_the_import_check_accepts_the_allowed_imports(tmp_path: Path, line: str):
    source = tmp_path / "probe.py"
    source.write_text(line + "\n", encoding="utf-8")
    assert violations(source) == []


def test_the_package_holds_no_order_or_sizing_call():
    """No dynamic import and no name of an order procedure in the package code."""
    for path in sorted(PACKAGE.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
        names |= {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
        assert not names & {"__import__", "import_module", "importlib", "exec", "eval"}, path.name
        strings = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
        procedures = [text for text in strings if "/api/orpc/" in text]
        assert all("/api/orpc/marketNotes/" in text for text in procedures), (path.name, procedures)
    from market_notes.client import PROCEDURES

    assert PROCEDURES == ("add", "get", "list", "recordChecks", "review")


def test_loading_the_tool_loads_no_order_sizing_or_engine_module():
    """A fresh interpreter that loads every module of the package (and the model transport) stays clear."""
    code = (
        "import sys\n"
        "import market_notes.cli, market_notes.extract\n"
        "market_notes.extract.default_generator()\n"
        "print('\\n'.join(sorted(sys.modules)))\n"
    )
    done = subprocess.run([sys.executable, "-c", code], cwd=RESEARCH, capture_output=True, text=True, timeout=120,
                          env={**os.environ, "PYTHONPATH": str(RESEARCH), "PYTHONDONTWRITEBYTECODE": "1"}, check=True)
    loaded = set(done.stdout.split())
    assert {"market_notes.cli", "market_notes.client", "market_notes.process", "agents.omp_claude"} <= loaded
    # What the three allowed modules pull in with their packages. Nothing else of the repository may load.
    allowed_prefixes = ("market_notes", "adapters", "agents", "providers", "gamma.schemas")
    allowed_exact = {"gamma", "adapters", "adapters.vertex_run_recorder"}
    ours = {name for name in loaded if repository_module(name) is not None}
    outside = {name for name in ours
               if name not in allowed_exact and not any(name == prefix or name.startswith(prefix + ".") for prefix in allowed_prefixes)}
    assert outside == set(), sorted(outside)
    assert {name for name in ours if name.startswith("adapters")} == allowed_exact - {"gamma"}
    banned_roots = {"strategies", "backtesting", "nautilus_backtest", "nautilus_trader", "quantlab", "vertex_execution",
                    "vertex_control", "ibkr_history", "ib_insync", "ibapi", "indicators", "analytics", "knowledge"}
    assert not {name.split(".")[0] for name in loaded} & banned_roots
    assert not [name for name in ours if any(word in name.split(".") for word in ("orders", "execution", "sizing", "broker", "ibkr"))]


def files_under(*roots: str) -> list[Path]:
    found = []
    for root in roots:
        for folder, folders, files in os.walk(REPO / root):
            folders[:] = [name for name in folders if name not in SKIPPED_FOLDERS and not name.endswith(".egg-info")]
            found.extend(Path(folder, name) for name in files)
    return sorted(found)


def names_the_notes(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return any(word in text for word in NOTE_WORDS)


def test_no_strategy_execution_or_backtest_file_names_the_notes():
    """Every file (any type) under the strategy, execution and backtest trees, except the two allocation scripts and their README."""
    scanned = files_under("services/research/strategies", "services/execution", "research/backtests")
    assert len(scanned) > 100, "the scan found too few files; the repository root is wrong"
    assert {path.relative_to(REPO).parts[0] for path in scanned} == {"services", "research"}
    for tree in ("services/research/strategies", "services/execution", "research/backtests"):
        assert any(path.relative_to(REPO).as_posix().startswith(tree + "/") for path in scanned), tree
    users = sorted(path.relative_to(REPO).as_posix() for path in scanned if names_the_notes(path))
    assert set(users) <= ALLOCATION_FILES, [path for path in users if path not in ALLOCATION_FILES]
    assert ALLOWED_USERS <= set(users)  # the scan sees the files that are known to name the notes


def test_nothing_in_an_order_or_sizing_path_imports_the_package():
    users = sorted(path.relative_to(REPO).as_posix() for path in files_under("services", "research", "infra", "scripts", "packages", "apps")
                   if path.suffix == ".py" and "market_notes" in path.read_text(encoding="utf-8", errors="replace"))
    outside = [path for path in users
               if not path.startswith("services/research/market_notes/")
               and not path.startswith("services/research/tests/test_market_notes_")]
    assert set(outside) == ALLOWED_USERS, outside
    # run.py imports two readers inside one function, and that function builds no trade.
    # funded_pie.py imports nothing of the package: it calls that function of run.py.
    pie = (REPO / "research/backtests/allocation/funded_pie.py").read_text(encoding="utf-8")
    assert "import market_notes" not in pie and "from market_notes" not in pie
    tree = ast.parse((REPO / "research/backtests/allocation/run.py").read_text(encoding="utf-8"))
    importers = [node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
                 and any(isinstance(inner, ast.ImportFrom) and (inner.module or "").startswith("market_notes")
                         for inner in ast.walk(node))]
    assert importers == ["owner_market_notes"]
    top_level = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom))
                 and "market_notes" in ast.unparse(node)]
    assert top_level == []
    assert not [path for path in users if path.startswith(("services/execution", "services/execution-kernel",
                                                           "services/gateway", "services/kernel-bridge", "services/host",
                                                           "services/control-client", "infra/quant-vps"))]
