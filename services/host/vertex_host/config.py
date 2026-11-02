"""Private release configuration, not public contracts or permission grants."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Any, Mapping

from .cache import HostUnavailable, exact_digest


def read_regular(path: str | Path, maximum_bytes: int, *, secret: bool = False,
                 allow_empty: bool = False) -> bytes:
    selected = Path(path)
    if not selected.is_absolute() or selected.parent.resolve() != selected.parent:
        raise HostUnavailable("absolute-nonsymlink-runtime-path-required")
    fd = os.open(selected, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        forbidden = 0o077 if secret else 0o022
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid not in (0, os.getuid()) or stat.S_IMODE(info.st_mode) & forbidden
                or not (0 if allow_empty is True else 1) <= info.st_size <= maximum_bytes):
            raise HostUnavailable("unsafe-or-unbounded-runtime-file")
        chunks = bytearray()
        while len(chunks) <= maximum_bytes:
            block = os.read(fd, min(65536, maximum_bytes + 1 - len(chunks)))
            if not block:
                break
            chunks.extend(block)
        after = os.fstat(fd)
        if len(chunks) > maximum_bytes or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
            raise HostUnavailable("runtime-file-changed-or-unbounded")
        return bytes(chunks)
    finally:
        os.close(fd)


def read_pinned(pin: Mapping[str, Any], maximum_bytes: int) -> bytes:
    if set(pin) != {"path", "sha256"}:
        raise HostUnavailable("exact-file-pin-required")
    raw = read_regular(pin["path"], maximum_bytes)
    if hashlib.sha256(raw).hexdigest() != exact_digest(pin["sha256"]):
        raise HostUnavailable("reviewed-file-digest-mismatch")
    return raw


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    if len(dict(pairs)) != len(pairs):
        raise HostUnavailable("duplicate-configuration-key")
    return dict(pairs)


def load_config(path: str | Path) -> dict[str, Any]:
    try:
        value = json.loads(read_regular(path, 1_048_576), object_pairs_hook=_object,
                           parse_constant=lambda _: (_ for _ in ()).throw(HostUnavailable("nonfinite-config")))
    except (ValueError, RecursionError, UnicodeError) as exc:
        raise HostUnavailable("invalid-host-configuration") from exc
    required = {"format", "releaseId", "instanceId", "accountAlias", "environment", "liveExecution",
                "startupMode", "journalIdentity", "journalPath", "drainRequestPath", "drainReceiptPath",
                "contractBundle", "control", "kernel", "paper", "worker", "credentials", "reviewedModules",
                "sandbox", "ownerLockPath", "readinessReceiptPath", "nativeApproval", "nativeAdmin", "nautilus"}
    if (type(value) is not dict or set(value) not in (required, required | {"ibkrHistory"})
            or value["format"] != "vertex-host-v1"):
        raise HostUnavailable("unsupported-host-configuration")
    if value["liveExecution"] is not False or value["environment"] not in ("research", "paper"):
        raise HostUnavailable("live-execution-forbidden")
    if value["startupMode"] not in ("initialize", "restore"):
        raise HostUnavailable("explicit-startup-mode-required")
    for name in ("releaseId", "instanceId", "accountAlias"):
        if type(value[name]) is not str or not 1 <= len(value[name]) <= 128:
            raise HostUnavailable("explicit-runtime-identity-required")
    for name in ("drainRequestPath", "drainReceiptPath", "ownerLockPath", "readinessReceiptPath"):
        if type(value[name]) is not str or not Path(value[name]).is_absolute():
            raise HostUnavailable("explicit-private-drain-path-required")
    if value["environment"] == "paper":
        if not isinstance(value["paper"], dict) or value["kernel"] is None:
            raise HostUnavailable("paper-native-configuration-unavailable")
        if type(value["journalIdentity"]) is not str or not value["journalIdentity"] or type(value["journalPath"]) is not str or not Path(value["journalPath"]).is_absolute():
            raise HostUnavailable("explicit-native-journal-required")
    elif any(value[key] is not None for key in ("paper", "kernel", "journalPath", "journalIdentity")):
        raise HostUnavailable("research-host-cannot-own-paper-journal")
    worker = value["worker"]
    if type(worker) is not dict or set(worker) != {"kinds", "leaseDurationMs", "pollMilliseconds", "drainMilliseconds", "rightsMaxAgeNs", "selectionId", "selectionSha256"}:
        raise HostUnavailable("explicit-worker-policy-required")
    if type(worker["kinds"]) is not list or not 1 <= len(worker["kinds"]) <= 6 or len(set(worker["kinds"])) != len(worker["kinds"]):
        raise HostUnavailable("bounded-worker-kinds-required")
    if not set(worker["kinds"]) <= {"research-run", "dataset-ingest", "knowledge-import", "backtest", "paper-simulation", "native-bootstrap"}:
        raise HostUnavailable("unsupported-worker-kind")
    if value["environment"] == "research" and (set(worker["kinds"]) & {"paper-simulation", "native-bootstrap"}):
        raise HostUnavailable("paper-worker-environment-mismatch")
    for name, minimum, maximum in (("leaseDurationMs", 1000, 300000), ("pollMilliseconds", 100, 60000), ("drainMilliseconds", 1000, 300000)):
        if type(worker[name]) is not int or not minimum <= worker[name] <= maximum:
            raise HostUnavailable("bounded-worker-timing-required")
    if type(worker["rightsMaxAgeNs"]) is not str or not worker["rightsMaxAgeNs"].isascii() or not worker["rightsMaxAgeNs"].isdecimal() or not 0 < int(worker["rightsMaxAgeNs"]) <= 300_000_000_000:
        raise HostUnavailable("bounded-exact-rights-age-required")
    exact_digest(worker["selectionSha256"])
    if type(value["reviewedModules"]) is not dict or len(value["reviewedModules"]) > 128:
        raise HostUnavailable("reviewed-local-code-pins-required")
    history = value.get("ibkrHistory")
    if history is not None:
        if (type(history) is not dict or set(history) != {"distributionRoot", "endpoint", "profileArtifactId", "profileEvidenceArtifactId", "profileCollectionId"}
                or type(history["distributionRoot"]) is not str or not Path(history["distributionRoot"]).is_absolute()
                or type(history["profileArtifactId"]) is not str or not history["profileArtifactId"]
                or type(history["profileEvidenceArtifactId"]) is not str or not history["profileEvidenceArtifactId"]
                or type(history["profileCollectionId"]) is not str or not history["profileCollectionId"]
                or value["environment"] != "research" or worker["kinds"] != ["dataset-ingest"]
                or any(value[key] is not None for key in ("paper", "kernel", "nautilus", "nativeApproval", "nativeAdmin"))):
            raise HostUnavailable("exclusive-ibkr-history-research-profile-required")
    return value


class FileCredentialResolver:
    """Only explicit supervisor-mounted credential files; no env/vault discovery."""
    def __init__(self, references: Mapping[str, Any]) -> None:
        if not isinstance(references, Mapping) or len(references) > 128:
            raise HostUnavailable("credential-reference-map-required")
        self._references = dict(references)

    def resolve(self, reference_id: str, *, endpoint_id: str | None = None) -> str:
        ref = self._references.get(reference_id)
        if type(ref) is not dict or set(ref) != {"path", "endpointIds", "purpose"}:
            raise HostUnavailable("configured-credential-reference-unavailable")
        if ref["purpose"] not in ("control-service", "provider", "model"):
            raise HostUnavailable("unsupported-credential-purpose")
        if endpoint_id is not None and endpoint_id not in ref["endpointIds"]:
            raise HostUnavailable("credential-endpoint-scope-denied")
        if endpoint_id is None and ref["purpose"] != "control-service":
            raise HostUnavailable("explicit-credential-endpoint-required")
        raw = read_regular(ref["path"], 8192, secret=True)
        try:
            value = raw.decode("utf-8").strip()
        except UnicodeError as exc:
            raise HostUnavailable("credential-encoding-unavailable") from exc
        if not value or any(ord(c) < 33 or ord(c) > 126 for c in value):
            raise HostUnavailable("credential-shape-unavailable")
        return value

    def __call__(self, reference_id: str) -> str:
        return self.resolve(reference_id)
