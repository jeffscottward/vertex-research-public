"""Owner arm gate for every broker mutation made by the Nautilus node.

The node runs all the time. It may submit, modify or cancel broker orders only
while the owner has armed it. The arm state is one JSON file (default
``data/ARMED``). The rules are:

* No file, an unreadable file or an invalid file means DISARMED.
* A record written for a different image version means DISARMED. After an
  image or code upgrade the owner must arm the node again.
* An active kill switch file means DISARMED.
* Environment flags such as ``CHARAN_LIVE_TRANSMIT_ENABLED`` never arm the node.

``place_order`` and ``cancel_order`` in this module are the only functions in
the node that call the IBKR API ``placeOrder`` and ``cancelOrder`` methods. A
test scans the package to keep it that way. Each call reads the arm state from
disk again, so a disarm takes effect on the next call.

Before ``configure`` runs, the module gate refuses every mutation.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import re
import sys
import tempfile
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ARM_RECORD_SCHEMA = "nautilus-arm-record-v1"
ARM_STATUS_SCHEMA = "nautilus-arm-status-v1"
ARM_AUDIT_SCHEMA = "nautilus-arm-audit-v1"

DEFAULT_ARMED_PATH = "./data/nautilus/ARMED"
DEFAULT_AUDIT_PATH = "./data/nautilus/arm-audit.jsonl"
DEFAULT_KILL_SWITCH_PATH = "./data/KILL_SWITCH"

ACTOR_RE = re.compile(r"[A-Za-z0-9_.@-]{1,64}")
REASON_MIN = 10
REASON_MAX = 280

DETAIL_ARMED = "armed"
DETAIL_NO_RECORD = "no_arm_record"
DETAIL_INVALID_RECORD = "invalid_arm_record"
DETAIL_VERSION_CHANGED = "image_version_changed"
DETAIL_KILL_SWITCH = "kill_switch_active"
DETAIL_NOT_CONFIGURED = "gate_not_configured"

_CODE_SUFFIXES = (".py", ".lock", ".txt", ".yaml", ".whl")


class DisarmedError(RuntimeError):
    """A broker mutation was refused because the node is not armed."""


class ArmRequestError(ValueError):
    """An arm or disarm request was refused."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def code_fingerprint(root: str | Path | None = None) -> str:
    """Hash the node code and dependency pins.

    The hash changes when any Python file, lock file, vendored wheel or config
    in the ``nautilus`` package changes, so a rebuilt image with other code
    gets a new version even when the build label is the same.
    """

    package_root = Path(root) if root is not None else Path(__file__).resolve().parent
    digest = hashlib.sha256()
    files = sorted(
        path
        for path in package_root.rglob("*")
        if path.is_file()
        and path.suffix in _CODE_SUFFIXES
        and "__pycache__" not in path.parts
    )
    for path in files:
        digest.update(path.relative_to(package_root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:12]


def runtime_fingerprint() -> str:
    """Hash the Python version and the installed distributions."""

    digest = hashlib.sha256(sys.version.encode("utf-8"))
    installed = sorted(
        f"{dist.metadata['Name']}=={dist.version}"
        for dist in importlib.metadata.distributions()
        if dist.metadata["Name"]
    )
    digest.update("\n".join(installed).encode("utf-8"))
    return digest.hexdigest()[:12]


def resolve_image_version(env: dict[str, str] | None = None) -> str:
    """Return ``<build label>+<code hash><runtime hash>`` for this process."""

    source = os.environ if env is None else env
    label = str(source.get("NAUTILUS_IMAGE_VERSION") or "unlabelled").strip()
    label = re.sub(r"[^A-Za-z0-9_.:-]", "-", label)[:64] or "unlabelled"
    return f"{label}+{code_fingerprint()}{runtime_fingerprint()}"


@dataclass(frozen=True)
class ArmStatus:
    armed: bool
    detail: str
    image_version: str
    kill_switch_active: bool
    record: dict[str, Any] | None

    @property
    def state(self) -> str:
        return "armed" if self.armed else "disarmed"

    def as_dict(self) -> dict[str, Any]:
        record = self.record or {}
        return {
            "schema": ARM_STATUS_SCHEMA,
            "armed": self.armed,
            "state": self.state,
            "detail": self.detail,
            "image_version": self.image_version,
            "kill_switch_active": self.kill_switch_active,
            "armed_at": record.get("armed_at") if self.armed else None,
            "armed_by": record.get("armed_by") if self.armed else None,
            "record": dict(record) if self.record is not None else None,
        }


def _valid_record(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    if data.get("schema") != ARM_RECORD_SCHEMA or data.get("armed") is not True:
        return False
    for key in ("armed_at", "armed_by", "reason", "image_version", "audit_id"):
        if not isinstance(data.get(key), str) or not data[key]:
            return False
    return bool(ACTOR_RE.fullmatch(data["armed_by"]))


class ArmGate:
    """Read the owner arm state from disk on every check."""

    def __init__(
        self,
        armed_path: str | Path,
        image_version: str,
        *,
        kill_switch_path: str | Path | None = None,
        audit_path: str | Path | None = None,
    ) -> None:
        if not image_version:
            raise ValueError("image_version is required")
        self.armed_path = Path(armed_path)
        self.image_version = image_version
        self.kill_switch_path = Path(kill_switch_path) if kill_switch_path else None
        self.audit_path = Path(audit_path) if audit_path else None
        self._lock = threading.Lock()

    def _kill_switch_active(self) -> bool:
        return bool(self.kill_switch_path and self.kill_switch_path.exists())

    def _read_record(self) -> tuple[dict[str, Any] | None, str]:
        try:
            with open(self.armed_path, encoding="utf-8") as handle:
                raw = handle.read(65536)
        except FileNotFoundError:
            return None, DETAIL_NO_RECORD
        except OSError:
            return None, DETAIL_INVALID_RECORD
        try:
            data = json.loads(raw)
        except ValueError:
            return None, DETAIL_INVALID_RECORD
        if not _valid_record(data):
            return None, DETAIL_INVALID_RECORD
        return data, DETAIL_ARMED

    def status(self) -> ArmStatus:
        kill_switch = self._kill_switch_active()
        record, detail = self._read_record()
        armed = record is not None
        if armed and record is not None and record["image_version"] != self.image_version:
            armed, detail = False, DETAIL_VERSION_CHANGED
        if armed and kill_switch:
            armed, detail = False, DETAIL_KILL_SWITCH
        return ArmStatus(
            armed=armed,
            detail=detail,
            image_version=self.image_version,
            kill_switch_active=kill_switch,
            record=record,
        )

    def require_armed(self, action: str, source: str) -> ArmStatus:
        status = self.status()
        if not status.armed:
            raise DisarmedError(
                f"node is disarmed ({status.detail}); refused {action} from {source}"
            )
        return status

    # -- owner actions -------------------------------------------------------

    def _audit(self, event: dict[str, Any]) -> None:
        if self.audit_path is None:
            return
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(
            {"schema": ARM_AUDIT_SCHEMA, "at": utc_now(), **event},
            sort_keys=True,
            separators=(",", ":"),
        )
        with self.audit_path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def _write_record(self, record: dict[str, Any]) -> None:
        self.armed_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(
            prefix=f".{self.armed_path.name}.", dir=self.armed_path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(record, handle, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.armed_path)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise

    def arm(self, *, actor: str, reason: str, confirm_image_version: str) -> tuple[ArmStatus, str]:
        audit_id = str(uuid.uuid4())
        reason = (reason or "").strip()
        with self._lock:
            refusal: ArmRequestError | None = None
            if not isinstance(actor, str) or not ACTOR_RE.fullmatch(actor):
                refusal = ArmRequestError("invalid_actor", "actor must match ^[A-Za-z0-9_.@-]{1,64}$")
            elif (
                len(reason) < REASON_MIN
                or len(reason) > REASON_MAX
                or any(ord(char) < 32 for char in reason)
            ):
                refusal = ArmRequestError(
                    "invalid_reason",
                    f"reason must be one line of {REASON_MIN}..{REASON_MAX} characters",
                )
            elif confirm_image_version != self.image_version:
                refusal = ArmRequestError(
                    "version_mismatch",
                    "confirmed image version does not match the running image version",
                )
            elif self._kill_switch_active():
                refusal = ArmRequestError("kill_switch_active", "remove the kill switch first")
            if refusal is not None:
                self._audit(
                    {
                        "event": "arm_refused",
                        "audit_id": audit_id,
                        "actor": actor if isinstance(actor, str) else "",
                        "error": refusal.code,
                        "image_version": self.image_version,
                    }
                )
                raise refusal
            record = {
                "schema": ARM_RECORD_SCHEMA,
                "armed": True,
                "armed_at": utc_now(),
                "armed_by": actor,
                "reason": reason,
                "image_version": self.image_version,
                "audit_id": audit_id,
            }
            self._audit(
                {
                    "event": "armed",
                    "audit_id": audit_id,
                    "actor": actor,
                    "reason": reason,
                    "image_version": self.image_version,
                }
            )
            try:
                self._write_record(record)
            except OSError as exc:
                raise ArmRequestError("write_failed", type(exc).__name__) from exc
        return self.status(), audit_id

    def disarm(self, *, actor: str, reason: str = "") -> tuple[ArmStatus, str]:
        audit_id = str(uuid.uuid4())
        if not isinstance(actor, str) or not ACTOR_RE.fullmatch(actor):
            raise ArmRequestError("invalid_actor", "actor must match ^[A-Za-z0-9_.@-]{1,64}$")
        reason = " ".join((reason or "").split())[:REASON_MAX]
        with self._lock:
            try:
                self.armed_path.unlink(missing_ok=True)
            except OSError as exc:
                raise ArmRequestError("write_failed", type(exc).__name__) from exc
            self._audit(
                {
                    "event": "disarmed",
                    "audit_id": audit_id,
                    "actor": actor,
                    "reason": reason,
                    "image_version": self.image_version,
                }
            )
        return self.status(), audit_id


# -- module gate and broker chokepoint ---------------------------------------

_gate_lock = threading.Lock()
_gate: ArmGate | None = None


def configure(gate: ArmGate | None) -> None:
    global _gate
    with _gate_lock:
        _gate = gate


def current() -> ArmGate | None:
    with _gate_lock:
        return _gate


def gate_from_env(env: dict[str, str] | None = None) -> ArmGate:
    source = os.environ if env is None else env
    return ArmGate(
        source.get("NAUTILUS_ARMED_PATH") or DEFAULT_ARMED_PATH,
        resolve_image_version(dict(source)),
        kill_switch_path=source.get("KILL_SWITCH_PATH") or DEFAULT_KILL_SWITCH_PATH,
        audit_path=source.get("NAUTILUS_ARM_AUDIT_PATH") or DEFAULT_AUDIT_PATH,
    )


def invalidate_stale_record(gate: ArmGate) -> bool:
    """Delete an arm record written for another image version.

    Run once at node start. Without it, a rollback to the earlier image would
    find its old record valid again and start ARMED without the owner.
    """

    if gate.status().detail != DETAIL_VERSION_CHANGED:
        return False
    gate.disarm(actor="system", reason="image version changed; the owner must arm again")
    return True


def current_status() -> ArmStatus:
    gate = current()
    if gate is None:
        return ArmStatus(
            armed=False,
            detail=DETAIL_NOT_CONFIGURED,
            image_version="",
            kill_switch_active=False,
            record=None,
        )
    return gate.status()


def require_armed(action: str, source: str) -> ArmStatus:
    gate = current()
    if gate is None:
        raise DisarmedError(
            f"node is disarmed ({DETAIL_NOT_CONFIGURED}); refused {action} from {source}"
        )
    return gate.require_armed(action, source)


def place_order(client: Any, order_id: int, contract: Any, order: Any, *, source: str) -> None:
    """The one IBKR ``placeOrder`` call site of the node (includes whatIf)."""

    require_armed("placeOrder", source)
    client.placeOrder(order_id, contract, order)


def cancel_order(client: Any, order_id: int, *, source: str) -> None:
    """The one IBKR ``cancelOrder`` call site of the node."""

    require_armed("cancelOrder", source)
    try:
        client.cancelOrder(order_id, "")
    except TypeError:
        client.cancelOrder(order_id)
