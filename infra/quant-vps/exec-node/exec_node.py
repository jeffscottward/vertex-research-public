#!/usr/bin/env python3
"""Vertex exec node on QuantVPS: stage, gate, switch, verify and rollback.

The exec node is the Docker Compose project `ibkr-nautilus-exec-node` (ib-gateway, nautilus-trader, watchdog,
postgres, redis, portfolio-ui, caddy, uptime-kuma, netdata). Until 2026-10-31 it ran from the vertex-quant
checkout /opt/vertex-quant. This tool moves the runtime root to /opt/vertex-exec-node, owned by Vertex Research
(infra/quant-vps/exec-node).

Rules (Vertex constitution and owner decisions):
- The project name stays `ibkr-nautilus-exec-node`. Container, network and named-volume names must be identical
  before and after the move. `gate` proves it and the switch refuses to run without a passing gate.
- State is reused, never copied or reset: `switch` renames /opt/vertex-quant/data (and portfolio-ui/data when it
  exists) into /opt/vertex-exec-node with os.rename, which fails instead of copying across filesystems.
- ib-gateway is never stopped, recreated or converged: every compose command names the eight other services.
  The gate also proves the running gateway's config hash equals the new root's hash. The network keeps its ID,
  so the gateway keeps its bridge IP.
- The Nautilus node stays DISARMED. This tool never arms, never sends orders and never prints secrets
  (.env values, tokens, compose config values). It prints JSON paths and names only.

Subcommands (run as root on QuantVPS; `--dry-run` prints the commands of switch/rollback without running them):
  stage     build /opt/vertex-exec-node from the frozen /opt/vertex-quant tree, without the REMOVED files, plus
            the Vertex-owned overlay
  gate      compare `docker compose config` old vs new; exit 1 unless only file paths and retired env keys differ
  switch    preflight + gate, stop the old services (not ib-gateway), move state, rewire consumers, start from
            the new root; a failed step rolls back automatically
  verify    post-switch checks (containers, gateway login, portfolio, ibkr-monitor, Nautilus DISARMED, watchdog,
            REMOVED files absent)
  rollback  reverse the switch from its backup directory (safe after a partial switch)
"""

from __future__ import annotations

import argparse
import copy
import datetime as _dt
import fnmatch
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

PROJECT = "ibkr-nautilus-exec-node"
OLD_ROOT = "/opt/vertex-quant"
NEW_ROOT = "/opt/vertex-exec-node"
STATE_DIR = "/var/lib/vertex-exec-node"
PROFILES = ("ibkr", "portfolio")
SERVICES = (
    "caddy",
    "ib-gateway",
    "nautilus-trader",
    "netdata",
    "portfolio-ui",
    "postgres",
    "redis",
    "uptime-kuma",
    "watchdog",
)
KEEP_RUNNING = ("ib-gateway",)
# Stop order: dependents first. ib-gateway is never named, so compose never touches it.
STOP_ORDER = ("caddy", "portfolio-ui", "watchdog", "nautilus-trader", "uptime-kuma", "netdata", "redis", "postgres")
EXPECTED_NETWORKS = {"prototype": PROJECT + "_prototype"}
EXPECTED_VOLUMES = {"caddy_config": PROJECT + "_caddy_config", "caddy_data": PROJECT + "_caddy_data"}
HOST_ROOT_KEY = "VERTEX_QUANT_HOST_ROOT"
# Runtime state under the root: (relative path, required). portfolio-ui resolves ./data/KILL_SWITCH and its 2FA
# rescan request against its working dir /app/portfolio-ui, so that directory is state too when it exists.
STATE_PATHS = (("data", True), ("portfolio-ui/data", False))

# Top-level entries of /opt/vertex-quant that are not runtime code. State moves at switch time; .env is
# rewritten (one key); backups, caches and secret backups (.env.bak-*) never enter the new root.
COPY_EXCLUDES = (
    "data",
    ".git",
    "backups",
    "tmp",
    ".pytest_cache",
    ".coverage",
    ".codex",
    ".maestro",
    ".DS_Store",
    ".env",
    ".env.bak-*",
    ".deployed-sha",
    ".disabled-candidate-*",
    ".omp-status.md",
)
# Copied but not pinned by the manifest (installed dependencies and caches).
UNPINNED_PARTS = ("node_modules", "__pycache__", ".pnpm-store")
RELEASE_FILE = ".vertex-exec-node-release.json"
# Frozen-manifest files that never enter the new root (owner 2026-11-04, card remove-charan-signals): the retired
# signal intake, its draft approval tool, tests, ADR, dashboard charts and logo. `stage` skips them; verify_staged,
# `gate` and `verify` require them absent. Three signal-named frozen files stay because live non-signal features run
# them: portfolio-ui's manual position close (/api/position-close) runs scripts/transmit_charan_approved_drafts.py,
# which imports scripts/charan_draft_review.py, which imports nautilus/charan.py; portfolio-ui's market refresh runs
# src/update-market-data.ts, which imports src/signal-event-parser.ts.
REMOVED = (
    "dist/charan-server-logo.png",
    "docs/adr/0001-charan-discord-ingestion.md",
    "public/charan-server-logo.png",
    "scripts/approve_charan_drafts.py",
    "src/SignalPriceChart.tsx",
    "src/alert-signal-quality.test.ts",
    "src/alert-signal-quality.ts",
    "src/signal-chart-view.test.ts",
    "src/signal-chart-view.ts",
    "src/signal-event-parser.test.ts",
    "src/signal-quality-alerts.test.ts",
    "src/signal-quality-alerts.ts",
    "tests/test_charan_review_scripts.py",
    "tests/test_charan_trade_intents.py",
)
# Compose environment keys of the retired signal intake. The gate ignores them in the old root's config and
# refuses them in the new root's config. nautilus-trader received the portfolio-ui login only for the retired
# intake's 2FA trigger; portfolio-ui keeps it.
REMOVED_ENV_PREFIX = "CHARAN_"
REMOVED_SERVICE_ENV = {"nautilus-trader": ("PORTFOLIO_AUTH_USERNAME", "PORTFOLIO_AUTH_PASSWORD")}

PM2_NAME = "vertex-ibkr-account-heartbeat"
HEALTH_ALERT_TIMER = "vertex-nautilus-health-alert.timer"
RECOVERY_UNIT = "vertex-ibkr-recovery.service"
NODE_UNIT = "vertex-nautilus-node.service"
GATE_8AM_TIMER = "vertex-quant-ibkr-gate-8am.timer"
UNITS = (
    "vertex-nautilus-node.service",
    "vertex-ibkr-snapshot-retention.service",
    "vertex-ibkr-snapshot-retention.timer",
    "vertex-nautilus-health-alert.service",
    "vertex-nautilus-health-alert.timer",
    "vertex-quant-ibkr-gate-8am.service",
    "vertex-quant-ibkr-gate-8am.timer",
)
SYSTEMD_DIR = "/etc/systemd/system"
FORCED_2FA = "/opt/ibkr-monitor/forced-2fa.sh"
FORCED_2FA_PAUSED = "exec-node/consumers/ibkr-monitor-forced-2fa.paused.sh"
# Host files outside the exec node that name the runtime root. bundle path -> installed path. Each installed
# file must equal its bundle file with the old root replaced by the new root (checked before the switch).
CONSUMERS = {
    "exec-node/consumers/ibkr-monitor-forced-2fa.sh": FORCED_2FA,
    "recovery/vertex_ibkr_recovery.py": "/opt/vertex-ibkr-recovery/vertex_ibkr_recovery.py",
    "recovery/test_vertex_ibkr_recovery.py": "/opt/vertex-ibkr-recovery/test_vertex_ibkr_recovery.py",
    "status/collect.py": "/opt/vertex-status/collect.py",
}
PM2_DUMP = "/root/.pm2/dump.pm2"
# Live host files scanned for the other root after a switch or rollback (rollback-* history dirs excluded).
REFERENCE_SCAN = (
    "/etc/systemd/system",
    "/etc/cron.d",
    "/etc/crontab",
    "/var/spool/cron",
    "/opt/vertex-ibkr-recovery/vertex_ibkr_recovery.py",
    "/opt/vertex-status/collect.py",
    "/opt/vertex-status/Caddyfile",
    "/opt/vertex-status/Caddyfile.tailnet",
    "/opt/ibkr-monitor",
    PM2_DUMP,
)
STATUS_TOKEN_FILE = "/opt/vertex-status/token.env"
RECOVERY_TOKEN_FILE = "/opt/vertex-ibkr-recovery/token.env"
PORTFOLIO_HEALTH_URL = "http://127.0.0.1:8792/vertex-portfolio/v1/health"
RECOVERY_HEALTH_URL = "http://127.0.0.1:8793/vertex-ibkr-recovery/v1/health"
RECOVERY_HEALTH_SCHEMA = "vertex-ibkr-recovery-health-v1"
IBKR_MONITOR_HEALTH_URL = "http://100.64.0.10:3461/api/health"
WATCHDOG_HEALTH = "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8081/health', timeout=3).read().decode())"
TWO_FA_SCRIPT = "request-ibkr-2fa-until-ready.sh"
MOVE = "@move-state"

Step = Tuple[List[str], Optional[str], bool]  # argv, cwd, check


class ExecNodeError(Exception):
    """A precondition or step failed. The message never contains secret values."""


# ---------------------------------------------------------------------------------------------------------------
# Command runner (tests replace it)


class Runner:
    def __init__(
        self,
        dry_run: bool = False,
        log: Optional[Callable[[str], None]] = None,
        stderr_log: Optional[Path] = None,
    ) -> None:
        self.dry_run = dry_run
        self.log = log or (lambda line: print(line, flush=True))
        self.stderr_log = stderr_log

    def run(
        self,
        argv: Sequence[str],
        cwd: Optional[str] = None,
        check: bool = True,
        mutating: bool = True,
        env: Optional[Dict[str, str]] = None,
        timeout: float = 900,
    ) -> Tuple[int, str]:
        """Runs argv without a shell. Returns (exit code, stdout). Mutating commands only print in dry-run.
        stderr goes to the 0600 switch log when set; it is never printed."""
        shown = " ".join(argv) + (f"  (cwd {cwd})" if cwd else "")
        if self.dry_run and mutating:
            self.log("DRY-RUN " + shown)
            return 0, ""
        proc = subprocess.run(
            list(argv), cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout
        )
        if self.stderr_log is not None and mutating:
            fd = os.open(self.stderr_log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as handle:
                handle.write(f"$ {shown}\nexit {proc.returncode}\n{proc.stderr}\n")
        if check and proc.returncode != 0:
            raise ExecNodeError(f"command failed ({proc.returncode}): {' '.join(argv[:6])}")
        return proc.returncode, proc.stdout


def compose_env() -> Dict[str, str]:
    """Minimal environment for compose: nothing from the operator's shell can override a root's .env."""
    keep = ("PATH", "HOME", "LANG", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT")
    return {k: os.environ[k] for k in keep if k in os.environ}


def compose_argv(*args: str, project: bool = True) -> List[str]:
    argv = ["docker", "compose"] + (["-p", PROJECT] if project else [])
    for profile in PROFILES:
        argv += ["--profile", profile]
    return argv + list(args)


# ---------------------------------------------------------------------------------------------------------------
# Manifest and staging


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load_manifest(text: str) -> Dict[str, str]:
    """sha256sum format: '<64 hex>  <relative path>' per line."""
    manifest: Dict[str, str] = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        digest, sep, rel = line.partition("  ")
        if not sep or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ExecNodeError(f"manifest line {number} is not '<sha256>  <path>'")
        if rel.startswith("/") or ".." in Path(rel).parts or rel in manifest:
            raise ExecNodeError(f"manifest line {number} has an unsafe or duplicate path")
        manifest[rel] = digest
    return manifest


def verify_tree(root: Path, expected: Dict[str, str]) -> List[str]:
    """Returns problems as '<path>: missing|changed'. Names only, never content."""
    problems = []
    for rel, digest in sorted(expected.items()):
        path = root / rel
        if not path.is_file():
            problems.append(f"{rel}: missing")
        elif sha256_file(path) != digest:
            problems.append(f"{rel}: changed")
    return problems


def excluded(name: str) -> bool:
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in COPY_EXCLUDES)


def is_state(rel: str) -> bool:
    return any(rel == path or rel.startswith(path + "/") for path, _ in STATE_PATHS)


def pinned(rel: str) -> bool:
    """True when the manifest pins this copied file (not excluded, not state, not installed deps or caches)."""
    parts = rel.split("/")
    return not excluded(parts[0]) and not is_state(rel) and not any(p in UNPINNED_PARTS for p in parts)


def build_manifest(root: Path) -> str:
    lines = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if path.is_file() and not path.is_symlink() and pinned(rel):
            lines.append(f"{sha256_file(path)}  {rel}")
    return "\n".join(lines) + "\n"


def owned_files(runtime: Path) -> Dict[str, str]:
    """Vertex-owned runtime overlay: relative path -> sha256."""
    files = {}
    for path in sorted(runtime.rglob("*")):
        if path.is_file():
            files[path.relative_to(runtime).as_posix()] = sha256_file(path)
    return files


def rewrite_env(text: str, old_root: str, new_root: str) -> str:
    """Points VERTEX_QUANT_HOST_ROOT at the new root. Exactly one such line must exist and no other line may name
    the old root. Errors name line numbers only, never values."""
    lines = text.split("\n")
    hits = [i for i, line in enumerate(lines) if line.startswith(HOST_ROOT_KEY + "=")]
    if len(hits) != 1:
        raise ExecNodeError(f".env must define {HOST_ROOT_KEY} exactly once (found {len(hits)})")
    lines[hits[0]] = f"{HOST_ROOT_KEY}={new_root}"
    others = [str(i + 1) for i, line in enumerate(lines) if old_root in line]
    if others:
        raise ExecNodeError(".env names the old root on line(s) " + ",".join(others))
    return "\n".join(lines)


def is_removed(rel: str) -> bool:
    return rel in REMOVED


def removed_present(root: Path) -> List[str]:
    """REMOVED files that exist under root, as '<path>: present (removed)'. Names only."""
    return [f"{rel}: present (removed)" for rel in REMOVED if (root / rel).exists() or (root / rel).is_symlink()]


def copy_ignore(source: Path) -> Callable[[str, List[str]], List[str]]:
    """shutil.copytree ignore: nested state directories and REMOVED files stay out of the new root."""

    def ignore(directory: str, names: List[str]) -> List[str]:
        rel_dir = Path(directory).relative_to(source).as_posix()
        rels = {n: n if rel_dir == "." else f"{rel_dir}/{n}" for n in names}
        return [n for n, rel in rels.items() if is_state(rel) or is_removed(rel)]

    return ignore


def stage(source: Path, target: Path, bundle: Path, manifest: Dict[str, str], vr_commit: str) -> Dict[str, Any]:
    """Builds `target` from the frozen source tree plus the owned overlay. Idempotent before the switch. Refuses
    once target/data exists (the switch already ran) and when the source drifted from the manifest."""
    if (target / "data").exists():
        raise ExecNodeError(f"{target}/data exists: the switch already ran; stage refuses to replace a live root")
    drift = verify_tree(source, manifest)
    if drift:
        raise ExecNodeError("source drifted from frozen-manifest.sha256: " + "; ".join(drift[:20]))
    runtime = bundle / "exec-node" / "runtime"
    overlay = owned_files(runtime)
    staging = target.parent / (target.name + ".stage-" + str(os.getpid()))
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(mode=0o755)
    try:
        for entry in sorted(source.iterdir()):
            if excluded(entry.name) or is_removed(entry.name):
                continue
            dest = staging / entry.name
            if entry.is_dir() and not entry.is_symlink():
                shutil.copytree(entry, dest, symlinks=True, ignore=copy_ignore(source))
            else:
                shutil.copy2(entry, dest, follow_symlinks=False)
        for rel in overlay:
            dest = staging / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(runtime / rel, dest)
        write_env(staging / ".env", expected_env(source, target))
        release = {
            "schema": "vertex-exec-node-release-v1",
            "vertexResearchCommit": vr_commit,
            "frozenSource": str(source),
            "frozenManifestSha256": hashlib.sha256(
                "".join(f"{d}  {r}\n" for r, d in sorted(manifest.items())).encode()
            ).hexdigest(),
            "ownedFiles": overlay,
            "stagedAt": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        (staging / RELEASE_FILE).write_text(json.dumps(release, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        problems = verify_staged(staging, manifest, overlay)
        if problems:
            raise ExecNodeError("staged tree failed verification: " + "; ".join(problems[:20]))
        if target.exists():
            previous = target.parent / (target.name + ".prev-" + str(os.getpid()))
            os.rename(target, previous)
            os.rename(staging, target)
            shutil.rmtree(previous)
        else:
            os.rename(staging, target)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    return {"target": str(target), "frozenFiles": len(manifest), "ownedFiles": len(overlay)}


def expected_env(source: Path, target: Path) -> str:
    return rewrite_env((source / ".env").read_text(encoding="utf-8"), str(source), str(target))


def write_env(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(path, 0o600)


def verify_staged(root: Path, manifest: Dict[str, str], overlay: Dict[str, str]) -> List[str]:
    """Owned files must equal the overlay; every other manifest file must equal the frozen bytes, except REMOVED
    files, which must be absent; no state yet."""
    frozen = {rel: digest for rel, digest in manifest.items() if rel not in overlay and not is_removed(rel)}
    problems = verify_tree(root, frozen) + verify_tree(root, overlay) + removed_present(root)
    for rel, _ in STATE_PATHS:
        if (root / rel).exists():
            problems.append(f"{rel}: present before the switch")
    if not (root / ".env").is_file():
        problems.append(".env: missing")
    return problems


# ---------------------------------------------------------------------------------------------------------------
# Compose gate (pure functions take parsed `docker compose config --format json` output)


def replace_strings(value: Any, old: str, new: str) -> Any:
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [replace_strings(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: replace_strings(item, old, new) for key, item in value.items()}
    return value


def diff_paths(a: Any, b: Any, prefix: str = "") -> List[str]:
    """JSON paths where a and b differ. Paths only; values are never returned (they may be secrets)."""
    if isinstance(a, dict) and isinstance(b, dict):
        out: List[str] = []
        for key in sorted(set(a) | set(b)):
            path = f"{prefix}.{key}" if prefix else str(key)
            if key not in a or key not in b:
                out.append(path)
            else:
                out += diff_paths(a[key], b[key], path)
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        out = []
        for index, (left, right) in enumerate(zip(a, b)):
            out += diff_paths(left, right, f"{prefix}[{index}]")
        return out
    return [] if a == b else [prefix or "$"]


def object_names(config: Dict[str, Any], kind: str) -> Dict[str, Optional[str]]:
    return {key: (value or {}).get("name") for key, value in (config.get(kind) or {}).items()}


def retired_env(svc: str, key: str) -> bool:
    return key.startswith(REMOVED_ENV_PREFIX) or key in REMOVED_SERVICE_ENV.get(svc, ())


def retired_env_paths(config: Dict[str, Any]) -> List[str]:
    """JSON paths of retired environment keys in a compose config. Paths only, never values."""
    paths = []
    for svc, spec in sorted((config.get("services") or {}).items()):
        env = (spec or {}).get("environment")
        if isinstance(env, dict):
            paths += [f"services.{svc}.environment.{key}" for key in sorted(env) if retired_env(svc, key)]
    return paths


def strip_retired_env(config: Dict[str, Any]) -> Dict[str, Any]:
    out = copy.deepcopy(config)
    for svc, spec in (out.get("services") or {}).items():
        env = (spec or {}).get("environment")
        if isinstance(env, dict):
            spec["environment"] = {key: value for key, value in env.items() if not retired_env(svc, key)}
    return out


def container_names(config: Dict[str, Any]) -> Dict[str, str]:
    """Compose names a container `<project>-<service>-1` unless the service sets container_name."""
    project = config.get("name")
    return {
        svc: (spec or {}).get("container_name") or f"{project}-{svc}-1"
        for svc, spec in (config.get("services") or {}).items()
    }


def gate(
    old_cfg: Dict[str, Any],
    new_cfg: Dict[str, Any],
    old_hashes: Dict[str, str],
    new_hashes: Dict[str, str],
    old_root: str,
    new_root: str,
    unpinned_names: Optional[Dict[str, Optional[str]]] = None,
    running_hashes: Optional[Dict[str, Optional[str]]] = None,
    new_removed_present: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """unpinned_names: project name each root resolves without `-p` (what lib.sh compose() uses).
    running_hashes: com.docker.compose.config-hash label of each running container that must be kept.
    new_removed_present: REMOVED files found in the new root (removed_present). Retired environment keys are
    ignored in the old config and refused in the new one."""
    problems: List[str] = []
    for label, cfg in (("old", old_cfg), ("new", new_cfg)):
        if cfg.get("name") != PROJECT:
            problems.append(f"{label} project name is not {PROJECT}")
        if tuple(sorted(cfg.get("services") or {})) != SERVICES:
            problems.append(f"{label} services differ from the expected nine")
        if object_names(cfg, "networks") != EXPECTED_NETWORKS:
            problems.append(f"{label} network names differ from {EXPECTED_NETWORKS}")
        if object_names(cfg, "volumes") != EXPECTED_VOLUMES:
            problems.append(f"{label} volume names differ from {EXPECTED_VOLUMES}")
    for label, name in sorted((unpinned_names or {}).items()):
        if name != PROJECT:
            problems.append(f"{label} root resolves project name {name!r} without -p")
    if container_names(old_cfg) != container_names(new_cfg):
        problems.append("container names differ")
    if object_names(old_cfg, "networks") != object_names(new_cfg, "networks"):
        problems.append("network names differ")
    if object_names(old_cfg, "volumes") != object_names(new_cfg, "volumes"):
        problems.append("volume names differ")
    images_old = {s: (v or {}).get("image") for s, v in (old_cfg.get("services") or {}).items()}
    images_new = {s: (v or {}).get("image") for s, v in (new_cfg.get("services") or {}).items()}
    if images_old != images_new:
        problems.append("images differ")
    retired = retired_env_paths(new_cfg)
    if retired:
        # caddy reads the whole .env (env_file), so a retired key left in .env shows up here too.
        problems.append("new root sets retired environment (compose file or .env): " + ", ".join(retired))
    problems += ["new root " + p for p in (new_removed_present or [])]
    old_swapped = replace_strings(strip_retired_env(old_cfg), old_root, new_root)
    remaining = diff_paths(old_swapped, strip_retired_env(new_cfg))
    if remaining:
        problems.append("non-path differences at: " + ", ".join(remaining))
    for svc in KEEP_RUNNING:
        if not old_hashes.get(svc) or old_hashes.get(svc) != new_hashes.get(svc):
            problems.append(f"{svc} config hash differs between roots")
        if running_hashes is not None and running_hashes.get(svc) != new_hashes.get(svc):
            problems.append(f"running {svc} config hash differs from the new root")
    recreate = sorted(s for s in SERVICES if old_hashes.get(s) != new_hashes.get(s))
    return {
        "ok": not problems,
        "problems": problems,
        "project": new_cfg.get("name"),
        "containers": container_names(new_cfg),
        "networks": object_names(new_cfg, "networks"),
        "volumes": object_names(new_cfg, "volumes"),
        "pathChanges": diff_paths(old_cfg, new_cfg),
        "recreate": recreate,
        "kept": sorted(s for s in SERVICES if s not in recreate),
    }


def parse_hashes(text: str) -> Dict[str, str]:
    hashes = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2:
            hashes[parts[0]] = parts[1]
    return hashes


def read_compose(runner: Runner, root: str) -> Tuple[Dict[str, Any], Dict[str, str], Optional[str]]:
    env = compose_env()
    _, cfg = runner.run(compose_argv("config", "--format", "json"), cwd=root, mutating=False, env=env)
    _, hashes = runner.run(compose_argv("config", "--hash", "*"), cwd=root, mutating=False, env=env)
    _, bare = runner.run(compose_argv("config", "--format", "json", project=False), cwd=root, mutating=False, env=env)
    return json.loads(cfg), parse_hashes(hashes), json.loads(bare).get("name")


def running_label(runner: Runner, svc: str) -> Optional[str]:
    code, out = runner.run(
        ["docker", "inspect", "-f", '{{index .Config.Labels "com.docker.compose.config-hash"}}', f"{PROJECT}-{svc}-1"],
        check=False,
        mutating=False,
    )
    return out.strip() if code == 0 and out.strip() else None


def run_gate(runner: Runner, old_root: str, new_root: str, check_running: bool = True) -> Dict[str, Any]:
    old_cfg, old_hashes, old_name = read_compose(runner, old_root)
    new_cfg, new_hashes, new_name = read_compose(runner, new_root)
    running = {svc: running_label(runner, svc) for svc in KEEP_RUNNING} if check_running else None
    return gate(
        old_cfg, new_cfg, old_hashes, new_hashes, old_root, new_root, {"old": old_name, "new": new_name}, running,
        removed_present(Path(new_root)),
    )


# ---------------------------------------------------------------------------------------------------------------
# Switch and rollback plans (lists of steps; `execute` runs them in order)


def move_step(src_root: str, dst_root: str, rel: str, required: bool, resume: bool) -> Step:
    return ([MOVE, f"{src_root}/{rel}", f"{dst_root}/{rel}", "required" if required else "optional",
             "resume" if resume else "strict"], None, True)


def move_state(src: str, dst: str, required: bool, resume: bool) -> str:
    """Renames one state directory. os.rename never copies: it fails with EXDEV across filesystems.
    resume (rollback): a directory already back at dst is fine."""
    src_exists, dst_exists = os.path.lexists(src), os.path.lexists(dst)
    if src_exists and dst_exists:
        raise ExecNodeError(f"both {src} and {dst} exist; refusing to merge state")
    if src_exists:
        os.rename(src, dst)
        return "moved"
    if dst_exists and resume:
        return "already in place"
    if dst_exists or required:
        raise ExecNodeError(f"{src} missing")
    return "absent"


def compose_stop_steps(root: str, check: bool) -> List[Step]:
    return [
        (compose_argv("stop", *STOP_ORDER), root, check),
        (compose_argv("rm", "-f", *STOP_ORDER), root, check),
    ]


def install_step(src: str, dest: str, mode: int) -> Step:
    return (["install", "-m", format(mode, "o"), src, dest], None, True)


def switch_plan(old_root: str, new_root: str, bundle: str, modes: Dict[str, int]) -> List[Step]:
    """modes: installed path -> current file mode (kept on replacement)."""
    steps: List[Step] = [
        # No 2FA run may start during the switch: it would restart the gateway or recreate data/.
        (["systemctl", "stop", RECOVERY_UNIT], None, True),
        install_step(f"{bundle}/{FORCED_2FA_PAUSED}", FORCED_2FA, modes.get(FORCED_2FA, 0o755)),
        (["systemctl", "stop", HEALTH_ALERT_TIMER], None, True),
        (["pm2", "stop", PM2_NAME], None, True),
    ]
    steps += compose_stop_steps(old_root, True)
    for rel, required in STATE_PATHS:
        steps.append(move_step(old_root, new_root, rel, required, False))
    for unit in UNITS:
        dest = f"{SYSTEMD_DIR}/{unit}"
        steps.append(install_step(f"{bundle}/exec-node/systemd/{unit}", dest, modes.get(dest, 0o644)))
    for src, dest in CONSUMERS.items():
        steps.append(install_step(f"{bundle}/{src}", dest, modes.get(dest, 0o644)))
    steps += [
        (["systemctl", "daemon-reload"], None, True),
        (compose_argv("up", "-d", "--no-build", *STOP_ORDER), new_root, True),
        (["systemctl", "restart", NODE_UNIT], None, True),
        (["systemctl", "start", RECOVERY_UNIT], None, True),
        (["pm2", "delete", PM2_NAME], None, True),
        (["bash", "scripts/ibkr-account-heartbeat-pm2.sh"], new_root, True),
        (["pm2", "save"], None, True),
        (["systemctl", "start", HEALTH_ALERT_TIMER], None, True),
    ]
    return steps


def rollback_plan(old_root: str, new_root: str, backup: str, bundle: str) -> List[Step]:
    """Safe after a partial switch: stop-type steps tolerate absent units/processes and state moves resume.
    The paused forced command blocks 2FA runs until the backup copy replaces it."""
    steps: List[Step] = [
        (["systemctl", "stop", RECOVERY_UNIT], None, False),
        install_step(f"{bundle}/{FORCED_2FA_PAUSED}", FORCED_2FA, 0o755),
        (["systemctl", "stop", HEALTH_ALERT_TIMER], None, False),
        (["pm2", "stop", PM2_NAME], None, False),
    ]
    steps += compose_stop_steps(new_root, False)
    for rel, required in STATE_PATHS:
        steps.append(move_step(new_root, old_root, rel, required, True))
    for unit in UNITS:
        steps.append((["cp", "-p", f"{backup}/units/{unit}", f"{SYSTEMD_DIR}/{unit}"], None, True))
    for dest in CONSUMERS.values():
        steps.append((["cp", "-p", f"{backup}/consumers/{Path(dest).name}", dest], None, True))
    steps += [
        (["systemctl", "daemon-reload"], None, True),
        (compose_argv("up", "-d", "--no-build", *STOP_ORDER), old_root, True),
        (["systemctl", "restart", NODE_UNIT], None, True),
        (["systemctl", "start", RECOVERY_UNIT], None, True),
        (["pm2", "delete", PM2_NAME], None, False),
        (["bash", "scripts/ibkr-account-heartbeat-pm2.sh"], old_root, True),
        (["pm2", "save"], None, True),
        (["systemctl", "start", HEALTH_ALERT_TIMER], None, True),
    ]
    return steps


def backup_host_files(backup: Path) -> None:
    (backup / "units").mkdir(parents=True, exist_ok=True)
    (backup / "consumers").mkdir(parents=True, exist_ok=True)
    os.chmod(backup, 0o700)
    for unit in UNITS:
        shutil.copy2(f"{SYSTEMD_DIR}/{unit}", backup / "units" / unit)
    for dest in CONSUMERS.values():
        shutil.copy2(dest, backup / "consumers" / Path(dest).name)
    if os.path.exists(PM2_DUMP):
        shutil.copy2(PM2_DUMP, backup / "dump.pm2")


def host_modes() -> Dict[str, int]:
    paths = [f"{SYSTEMD_DIR}/{unit}" for unit in UNITS] + list(CONSUMERS.values())
    return {path: os.stat(path).st_mode & 0o7777 for path in paths}


def consumer_drift(bundle: Path, old_root: str, new_root: str) -> List[str]:
    """Each installed consumer must be its bundle file with the root path swapped; anything else is drift."""
    problems = []
    for src, dest in CONSUMERS.items():
        try:
            installed = Path(dest).read_text(encoding="utf-8")
        except OSError:
            problems.append(f"{dest}: missing")
            continue
        if installed.replace(old_root, new_root) != (bundle / src).read_text(encoding="utf-8"):
            problems.append(f"{dest}: differs from {src} beyond the root path")
    return problems


def two_fa_running(proc_root: str = "/proc") -> bool:
    me = str(os.getpid())
    for entry in os.listdir(proc_root):
        if not entry.isdigit() or entry == me:
            continue
        try:
            with open(f"{proc_root}/{entry}/cmdline", "rb") as handle:
                cmdline = handle.read().decode("utf-8", "replace")
        except OSError:
            continue
        if TWO_FA_SCRIPT in cmdline:
            return True
    return False


def same_filesystem(a: str, b: str) -> bool:
    return os.stat(a).st_dev == os.stat(b).st_dev


def execute(runner: Runner, steps: Iterable[Step], journal: List[Dict[str, Any]]) -> None:
    for argv, cwd, check in steps:
        started = time.time()
        if argv[0] == MOVE:
            _, src, dst, required, mode = argv
            if runner.dry_run:
                runner.log(f"DRY-RUN rename {src} -> {dst} ({required}, {mode})")
                outcome = "dry-run"
            else:
                outcome = move_state(src, dst, required == "required", mode == "resume")
            journal.append({"argv": argv, "outcome": outcome})
            runner.log(f"ok rename {src} -> {dst}: {outcome}")
            continue
        env = compose_env() if argv[:2] == ["docker", "compose"] else None
        code, _ = runner.run(argv, cwd=cwd, env=env, check=check)
        journal.append({"argv": argv, "cwd": cwd, "exit": code, "seconds": round(time.time() - started, 1)})
        runner.log(("ok " if code == 0 else f"exit {code} (tolerated) ") + " ".join(argv[:6]))


# ---------------------------------------------------------------------------------------------------------------
# Verification


def token_header(path: str, key: str) -> Dict[str, str]:
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        name, _, value = line.partition("=")
        if name.strip() == key and value.strip():
            return {"Authorization": "Bearer " + value.strip()}
    raise ExecNodeError(f"{key} not found in {path}")


def http_json(url: str, headers: Optional[Dict[str, str]] = None, timeout: float = 8) -> Any:
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # nosec - fixed loopback/tailnet URLs
        return json.loads(response.read().decode("utf-8"))


# `{{.State.Health.Status}}` fails with "map has no entry" for containers without a healthcheck (caddy), so the
# template prints the whole State object as JSON and Python reads Health from it.
INSPECT_TEMPLATE = '{"state":{{json .State}},"id":"{{.Id}}","configFiles":"{{index .Config.Labels "com.docker.compose.project.config_files"}}"}'


def parse_inspect(out: str) -> Dict[str, Any]:
    data = json.loads(out)
    state = data.get("state") or {}
    return {
        "status": state.get("Status"),
        "health": (state.get("Health") or {}).get("Status", ""),
        "started": state.get("StartedAt"),
        "id": data.get("id"),
        "configFiles": data.get("configFiles"),
    }


def container_state(runner: Runner, name: str) -> Dict[str, Any]:
    code, out = runner.run(["docker", "inspect", "-f", INSPECT_TEMPLATE, name], check=False, mutating=False)
    if code != 0:
        return {"status": "missing"}
    return parse_inspect(out)


def evaluate_containers(states: Dict[str, Dict[str, Any]], root: str) -> Tuple[bool, str]:
    bad = []
    for svc in SERVICES:
        state = states.get(svc) or {}
        if state.get("status") != "running" or state.get("health") not in ("", "healthy"):
            bad.append(f"{svc}={state.get('status')}/{state.get('health') or '-'}")
        elif svc not in KEEP_RUNNING and state.get("configFiles") != f"{root}/docker-compose.yml":
            bad.append(f"{svc}=wrong-root")
    return (not bad, "all 9 running and healthy" if not bad else ", ".join(bad))


def evaluate_arm(status: Dict[str, Any]) -> Tuple[bool, str]:
    armed = status.get("armed")
    detail = status.get("detail")
    return (armed is False, f"armed={armed} detail={detail}")


def evaluate_removed(root: str) -> Tuple[bool, str]:
    """REMOVED files must be absent from the runtime root. The old root is the frozen tree and keeps them."""
    if root == OLD_ROOT:
        return (True, "skipped for the old root (frozen tree)")
    present = removed_present(Path(root))
    return (not present, "none present" if not present else ", ".join(present[:10]))


def evaluate_pm2(processes: List[Dict[str, Any]], root: str) -> Tuple[bool, str]:
    for proc in processes:
        if proc.get("name") == PM2_NAME:
            env = proc.get("pm2_env") or {}
            ok = env.get("status") == "online" and env.get("pm_cwd") == root
            return (ok, f"status={env.get('status')} cwd={env.get('pm_cwd')}")
    return (False, "heartbeat process missing")


def unit_state(runner: Runner, unit: str) -> str:
    _, active = runner.run(["systemctl", "is-active", unit], check=False, mutating=False)
    _, enabled = runner.run(["systemctl", "is-enabled", unit], check=False, mutating=False)
    return f"{active.strip()}/{enabled.strip()}"


def references(paths: Iterable[str], needle: str) -> List[str]:
    """Live files under `paths` that contain needle + '/' or '"needle"'. Skips rollback-* history and backups."""
    hits = []
    for base in paths:
        candidates = [Path(base)] if os.path.isfile(base) else sorted(Path(base).rglob("*")) if os.path.isdir(base) else []
        for path in candidates:
            if not path.is_file() or any(p.startswith("rollback-") or ".bak" in p for p in path.parts):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if needle + "/" in text or f'"{needle}"' in text or f"={needle}\n" in text:
                hits.append(str(path))
    return hits


def verify(runner: Runner, root: str, before: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    checks: Dict[str, Tuple[bool, str]] = {}
    states = {svc: container_state(runner, f"{PROJECT}-{svc}-1") for svc in SERVICES}
    checks["containers"] = evaluate_containers(states, root)
    if before:
        gw = states.get("ib-gateway") or {}
        same = gw.get("id") == before.get("gatewayId") and gw.get("started") == before.get("gatewayStarted")
        checks["gateway_not_restarted"] = (same, "same container and start time" if same else "gateway changed")
        _, net = runner.run(["docker", "network", "inspect", "-f", "{{.Id}}", PROJECT + "_prototype"], mutating=False)
        checks["network_kept"] = (net.strip() == before.get("networkId"), "same network id")
    if root == OLD_ROOT:
        # The frozen tree pairs the new snapshot script with the old reader; its check-only always fails.
        checks["gateway_account_snapshot"] = (True, "skipped for the old root (known reader mismatch)")
    else:
        code, _ = runner.run(
            ["bash", f"scripts/{TWO_FA_SCRIPT}", "--check-only"], cwd=root, check=False, mutating=False,
            env=dict(compose_env(), IBKR_2FA_NOTIFY_ENABLED="0"), timeout=240,
        )
        checks["gateway_account_snapshot"] = (code == 0, f"check-only exit {code}")
    checks["nautilus_disarmed"] = evaluate_arm(arm_status(runner))
    if before:
        checks["arm_audit_unchanged"] = (audit_digest(root) == before.get("armAudit"), "arm-audit.jsonl digest")
    checks["no_arm_record"] = (not os.path.exists(f"{root}/data/nautilus/ARMED"), "data/nautilus/ARMED absent")
    checks["removed_files_absent"] = evaluate_removed(root)
    code, _ = runner.run(
        ["docker", "exec", f"{PROJECT}-watchdog-1", "python", "-c", WATCHDOG_HEALTH], check=False, mutating=False
    )
    checks["watchdog_health"] = (code == 0, "health endpoint answered" if code == 0 else f"exit {code}")
    try:
        portfolio = http_json(PORTFOLIO_HEALTH_URL, token_header(STATUS_TOKEN_FILE, "VERTEX_STATUS_TOKEN"))
        checks["vertex_portfolio_live"] = (portfolio.get("state") == "live", f"state={portfolio.get('state')}")
    except Exception as exc:  # noqa: BLE001 - reported as a failed check
        checks["vertex_portfolio_live"] = (False, type(exc).__name__)
    try:
        monitor = http_json(IBKR_MONITOR_HEALTH_URL)
        checks["ibkr_monitor_live"] = (
            monitor.get("bridge") == "live" and monitor.get("stale") is False,
            f"bridge={monitor.get('bridge')} stale={monitor.get('stale')}",
        )
    except Exception as exc:  # noqa: BLE001
        checks["ibkr_monitor_live"] = (False, type(exc).__name__)
    try:
        recovery = http_json(RECOVERY_HEALTH_URL, token_header(RECOVERY_TOKEN_FILE, "VERTEX_RECOVERY_TOKEN"))
        checks["recovery_health"] = (
            recovery.get("schema") == RECOVERY_HEALTH_SCHEMA, f"schema={recovery.get('schema')}")
    except Exception as exc:  # noqa: BLE001
        checks["recovery_health"] = (False, type(exc).__name__)
    checks["recovery_script_path"] = recovery_points_at(root)
    for unit in (NODE_UNIT, HEALTH_ALERT_TIMER, RECOVERY_UNIT):
        state = unit_state(runner, unit)
        checks[f"unit {unit}"] = (state.startswith("active/"), state)
    if before:
        state = unit_state(runner, GATE_8AM_TIMER)
        checks[f"unit {GATE_8AM_TIMER}"] = (state == before.get("gate8am"), f"{state} (before {before.get('gate8am')})")
    _, pm2 = runner.run(["pm2", "jlist"], check=False, mutating=False)
    try:
        checks["pm2_heartbeat"] = evaluate_pm2(json.loads(pm2 or "[]"), root)
    except ValueError:
        checks["pm2_heartbeat"] = (False, "pm2 jlist not JSON")
    other = OLD_ROOT if root == NEW_ROOT else NEW_ROOT
    hits = references(REFERENCE_SCAN, other)
    checks["no_other_root_references"] = (not hits, "none" if not hits else ", ".join(hits[:10]))
    return {
        "ok": all(ok for ok, _ in checks.values()),
        "checks": {name: {"ok": ok, "detail": detail} for name, (ok, detail) in checks.items()},
    }


def recovery_points_at(root: str) -> Tuple[bool, str]:
    text = Path(CONSUMERS["recovery/vertex_ibkr_recovery.py"]).read_text(encoding="utf-8")
    wanted = f'SCRIPT = "{root}/scripts/{TWO_FA_SCRIPT}"'
    return (wanted in text, "recovery SCRIPT points at " + root if wanted in text else "recovery SCRIPT not updated")


def arm_status(runner: Runner) -> Dict[str, Any]:
    code, out = runner.run(
        ["docker", "exec", f"{PROJECT}-nautilus-trader-1", "python", "-m", "nautilus.arm_cli", "status", "--json"],
        check=False,
        mutating=False,
    )
    if code != 0:
        return {"armed": None, "detail": f"arm_cli exit {code}"}
    try:
        return json.loads(out)
    except ValueError:
        return {"armed": None, "detail": "arm_cli output not JSON"}


def audit_digest(root: str) -> Optional[str]:
    path = Path(root) / "data" / "nautilus" / "arm-audit.jsonl"
    return sha256_file(path) if path.is_file() else None


def snapshot_before(runner: Runner, root: str) -> Dict[str, Any]:
    gw = container_state(runner, f"{PROJECT}-ib-gateway-1")
    _, net = runner.run(["docker", "network", "inspect", "-f", "{{.Id}}", PROJECT + "_prototype"], mutating=False)
    arm = arm_status(runner)
    return {
        "gatewayId": gw.get("id"),
        "gatewayStarted": gw.get("started"),
        "networkId": net.strip(),
        "arm": {"armed": arm.get("armed"), "detail": arm.get("detail")},
        "armAudit": audit_digest(root),
        "gate8am": unit_state(runner, GATE_8AM_TIMER),
    }


# ---------------------------------------------------------------------------------------------------------------
# CLI


def bundle_dir() -> Path:
    """infra/quant-vps (this file lives in infra/quant-vps/exec-node/)."""
    return Path(__file__).resolve().parent.parent


def load_bundle_manifest() -> Dict[str, str]:
    return load_manifest((bundle_dir() / "exec-node" / "frozen-manifest.sha256").read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def switch_preflight(old_root: str, new_root: str) -> List[str]:
    """Everything that must hold before any service stops. Names only in the result."""
    problems: List[str] = []
    old, new = Path(old_root), Path(new_root)
    manifest = load_bundle_manifest()
    overlay = owned_files(bundle_dir() / "exec-node" / "runtime")
    problems += ["old root " + p for p in verify_tree(old, manifest)[:10]]
    problems += ["new root " + p for p in verify_staged(new, manifest, overlay)[:10]]
    if (new / ".env").is_file() and (old / ".env").is_file():
        if (new / ".env").read_text(encoding="utf-8") != expected_env(old, new):
            problems.append("new .env differs from the old .env beyond VERTEX_QUANT_HOST_ROOT (restage)")
    if not (old / "data").is_dir():
        problems.append(f"{old_root}/data missing")
    elif os.path.ismount(old / "data") or not same_filesystem(str(old / "data"), new_root):
        problems.append("data/ is a mount or on another filesystem: rename would fail")
    problems += consumer_drift(bundle_dir(), old_root, new_root)
    if two_fa_running():
        problems.append("a 2FA script run is in progress")
    return problems


def cmd_switch(args: argparse.Namespace, runner: Runner) -> int:
    old_root, new_root, bundle = args.old_root, args.new_root, str(bundle_dir())
    problems = switch_preflight(old_root, new_root)  # read-only; dry-run shows the same blockers
    result = run_gate(runner, old_root, new_root)
    print(json.dumps({"gate": {k: result[k] for k in ("ok", "problems", "recreate", "kept")}}, sort_keys=True))
    problems += result["problems"]
    if problems:
        raise ExecNodeError("switch blocked: " + "; ".join(problems))
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    workdir = Path(STATE_DIR) / f"switch-{stamp}"
    if args.dry_run:
        modes = {}
        execute(runner, switch_plan(old_root, new_root, bundle, modes), [])
        return 0
    modes = host_modes()
    before = snapshot_before(runner, old_root)
    if before["arm"]["armed"] is not False:
        raise ExecNodeError("Nautilus is not DISARMED before the switch; refusing")
    workdir.mkdir(parents=True, mode=0o700)
    write_json(workdir / "before.json", before)
    write_json(workdir / "modes.json", {k: format(v, "o") for k, v in modes.items()})
    backup_host_files(workdir / "backup")
    runner.stderr_log = workdir / "stderr.log"
    journal: List[Dict[str, Any]] = []
    try:
        execute(runner, switch_plan(old_root, new_root, bundle, modes), journal)
    except BaseException as exc:
        write_json(workdir / "journal.json", journal)
        runner.log(f"switch step failed ({type(exc).__name__}: {exc}); rolling back from {workdir}")
        rollback_journal: List[Dict[str, Any]] = []
        try:
            execute(runner, rollback_plan(old_root, new_root, str(workdir / "backup"), bundle), rollback_journal)
        except BaseException as rollback_exc:
            # Keep the node and its alerting up whatever state the rollback stopped in.
            for unit in (NODE_UNIT, HEALTH_ALERT_TIMER):
                runner.run(["systemctl", "start", unit], check=False)
            raise ExecNodeError(f"switch failed AND rollback failed; see {workdir}") from rollback_exc
        finally:
            write_json(workdir / "rollback-journal.json", rollback_journal)
        raise ExecNodeError(f"switch failed and was rolled back; see {workdir}") from exc
    write_json(workdir / "journal.json", journal)
    print(json.dumps({"switchDir": str(workdir), "steps": len(journal)}))
    return 0


def cmd_rollback(args: argparse.Namespace, runner: Runner) -> int:
    backup = Path(args.switch_dir) / "backup"
    if not args.dry_run:
        if not (backup / "units").is_dir():
            raise ExecNodeError(f"no backup at {backup}")
        runner.stderr_log = Path(args.switch_dir) / "stderr.log"
    journal: List[Dict[str, Any]] = []
    try:
        execute(runner, rollback_plan(args.old_root, args.new_root, str(backup), str(bundle_dir())), journal)
    finally:
        if not args.dry_run:
            write_json(Path(args.switch_dir) / "rollback-journal.json", journal)
    return 0


def cmd_verify(args: argparse.Namespace, runner: Runner) -> int:
    before = None
    if args.switch_dir:
        before = json.loads((Path(args.switch_dir) / "before.json").read_text(encoding="utf-8"))
    deadline = time.time() + args.wait
    while True:
        result = verify(runner, args.root, before)
        if result["ok"] or time.time() >= deadline:
            break
        time.sleep(15)
    if args.switch_dir:
        write_json(Path(args.switch_dir) / f"verify-{int(time.time())}.json", result)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--old-root", default=OLD_ROOT)
    parser.add_argument("--new-root", default=NEW_ROOT)
    parser.add_argument("--dry-run", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    p_stage = sub.add_parser("stage")
    p_stage.add_argument("--commit", default="unknown", help="Vertex Research commit of this bundle")
    sub.add_parser("gate")
    sub.add_parser("manifest", help="print the manifest of the old root (to refresh frozen-manifest.sha256)")
    sub.add_parser("switch")
    p_verify = sub.add_parser("verify")
    p_verify.add_argument("--root", default=NEW_ROOT)
    p_verify.add_argument("--switch-dir")
    p_verify.add_argument("--wait", type=int, default=0, help="retry for up to N seconds until all checks pass")
    p_roll = sub.add_parser("rollback")
    p_roll.add_argument("--switch-dir", required=True)
    args = parser.parse_args(argv)
    runner = Runner(dry_run=args.dry_run)
    try:
        if args.command == "stage":
            result = stage(Path(args.old_root), Path(args.new_root), bundle_dir(), load_bundle_manifest(), args.commit)
            print(json.dumps(result))
            return 0
        if args.command == "manifest":
            sys.stdout.write(build_manifest(Path(args.old_root)))
            return 0
        if args.command == "gate":
            result = run_gate(runner, args.old_root, args.new_root)
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0 if result["ok"] else 1
        if args.command == "switch":
            return cmd_switch(args, runner)
        if args.command == "verify":
            return cmd_verify(args, runner)
        return cmd_rollback(args, runner)
    except ExecNodeError as exc:
        print(f"exec-node: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
