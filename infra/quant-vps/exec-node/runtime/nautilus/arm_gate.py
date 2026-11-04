"""Owner arm gate for every broker mutation made by the Nautilus node.

The node runs all the time. It may submit, modify or cancel broker orders only
while the owner has armed it. The arm state is one JSON file (default
``data/ARMED``). The rules are:

* No file, an unreadable file or an invalid file means DISARMED.
* A record written for a different image version means DISARMED. After an
  image or code upgrade the owner must arm the node again.
* An active kill switch file means DISARMED. The gate also deletes the arm
  record when it sees the kill switch, so removing the kill switch never
  re-arms the node; the owner must arm again.
* Environment flags such as ``CHARAN_LIVE_TRANSMIT_ENABLED`` never arm the node.

``place_order`` and ``cancel_order`` in this module are the only functions in
the node that call the IBKR API ``placeOrder`` and ``cancelOrder`` methods. A
test scans the package to keep it that way. Each call reads the arm state from
disk again, so a disarm takes effect on the next call.

Before ``configure`` runs, the module gate refuses every mutation.

``place_order`` also applies the owner's order policy (``ORDER_POLICY``):
options only, risk always defined. An armed node may place only a BUY of an
option (the most it can lose is the premium) or an order that closes or
reduces a held position of the exact contract. Everything else, whatIf
preflights included, is refused with ``OrderPolicyError``. See
``check_order_policy``.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import os
import re
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
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

# Owner rule (2026-11-04): options only, risk always defined; closes and
# reductions are always allowed.
ORDER_POLICY = "options_only_defined_risk_v1"
DEFAULT_ACCOUNT_SNAPSHOT_DIR = "/app/data/nautilus/reports"
DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 180.0
SNAPSHOT_NAME_RE = re.compile(r"ibkr-account-snapshot-\d{8}T\d{6}Z\.json")
SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024
# A snapshot stamped further in the future than this is invalid (clock fault).
SNAPSHOT_FUTURE_TOLERANCE_SECONDS = 60.0
# ibapi leaves totalQuantity at UNSET_DECIMAL (2**127 - 1) when it is not set;
# any quantity at or above this bound counts as unset.
_UNSET_QUANTITY = Decimal(2**63 - 1)
# A close placed less than this long before the snapshot was captured may be
# missing from it, so it still counts against the held quantity.
CLOSE_RESERVATION_SETTLE_SECONDS = 15.0

ALLOW_LONG_OPTION = "long_option_open"
ALLOW_POSITION_CLOSE = "position_close"


class DisarmedError(RuntimeError):
    """A broker mutation was refused because the node is not armed."""


class OrderPolicyError(DisarmedError):
    """placeOrder was refused by the options-only, defined-risk order policy."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"order policy {ORDER_POLICY} refused the order ({code}): {detail}")
        self.code = code
        self.detail = detail


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
            "order_policy": ORDER_POLICY,
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

    def _clear_record_for_kill_switch(self) -> None:
        with self._lock:
            try:
                self.armed_path.unlink()
            except FileNotFoundError:
                return
            except OSError:
                return  # still DISARMED below; the watchdog retries the delete
            try:
                self._audit(
                    {
                        "event": "disarmed",
                        "audit_id": str(uuid.uuid4()),
                        "actor": "system",
                        "reason": "kill switch active; the owner must arm again",
                        "image_version": self.image_version,
                    }
                )
            except OSError:
                pass  # the record is gone; the audit line is best effort here

    def status(self) -> ArmStatus:
        kill_switch = self._kill_switch_active()
        if kill_switch and self.armed_path.exists():
            self._clear_record_for_kill_switch()
        record, detail = self._read_record()
        armed = record is not None
        if armed and record is not None and record["image_version"] != self.image_version:
            armed, detail = False, DETAIL_VERSION_CHANGED
        if kill_switch:
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

    def audit_order_refusal(self, event: dict[str, Any]) -> None:
        """Append an ``order_refused`` line. Best effort: the refusal stands if the write fails."""

        try:
            with self._lock:
                self._audit(
                    {
                        "event": "order_refused",
                        "audit_id": str(uuid.uuid4()),
                        "actor": "system",
                        "policy": ORDER_POLICY,
                        "image_version": self.image_version,
                        **event,
                    }
                )
        except OSError:
            pass

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
            if self._kill_switch_active():
                # The kill switch appeared while arming: the record must not survive it.
                self.armed_path.unlink(missing_ok=True)
                raise ArmRequestError("kill_switch_active", "remove the kill switch first")
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


# -- order policy: options only, risk always defined -------------------------
#
# Allowed (whatIf preflights are checked the same way):
# * BUY of an option (secType OPT). The most it can lose is the premium. It
#   needs no position data, so it does not depend on the account snapshot.
# * A close or reduction of a held position (STK or OPT): the side is opposite
#   to the held quantity of the exact contract in the newest account snapshot,
#   and the order quantity plus the same-side closes this process placed since
#   that snapshot (close reservations) is at most the absolute held quantity.
#   A cancel or a replacement under the same order id releases a reservation.
# Everything else is refused: new shares (long or short), an option sale that
# opens or adds to a short, BAG/combos, delta-neutral orders, futures, other or
# missing secType, missing action or quantity. A missing, unreadable, invalid or
# stale snapshot refuses every close (fail closed).
#
# Known limit: the snapshot carries no working orders, so a close that is still
# working when a newer snapshot is captured (or when the process restarts) no
# longer counts against the held quantity. Closing that gap needs IBKR open
# orders in the snapshot.

_RIGHTS = {"C": "C", "CALL": "C", "P": "P", "PUT": "P"}
# Snapshot position fields used when the position's contract dict lacks them.
_POSITION_FALLBACK = {"secType": "sec_type", "symbol": "symbol", "currency": "currency"}


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(_text(value))
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() else None


def _positive(value: Any) -> Decimal | None:
    number = _decimal(value)
    return number if number is not None and number > 0 else None


def _short(value: Any, limit: int = 64) -> str:
    return _text(value)[:limit]


def _identity(get: Callable[[str], Any]) -> dict[str, Any]:
    right = _text(get("right")).upper()
    expiry = _text(get("lastTradeDateOrContractMonth")).split()
    return {
        "sec_type": _text(get("secType")).upper(),
        "symbol": _text(get("symbol")).upper(),
        "currency": _text(get("currency")).upper(),
        "expiry": expiry[0] if expiry else "",
        "right": _RIGHTS.get(right, right),
        "strike": _positive(get("strike")),
        "multiplier": _positive(get("multiplier")),
    }


def _order_contract_identity(contract: Any) -> dict[str, Any]:
    return _identity(lambda name: getattr(contract, name, None))


def _position_identity(position: Mapping[str, Any]) -> dict[str, Any]:
    raw = position.get("contract")
    contract: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}

    def get(name: str) -> Any:
        value = contract.get(name)
        if _text(value) == "" and name in _POSITION_FALLBACK:
            value = position.get(_POSITION_FALLBACK[name])
        return value

    return _identity(get)


def _identity_complete(identity: dict[str, Any]) -> bool:
    if not identity["symbol"]:
        return False
    if identity["sec_type"] == "STK":
        return bool(identity["currency"])
    return (
        bool(identity["expiry"])
        and identity["right"] in ("C", "P")
        and identity["strike"] is not None
    )


def _same_contract(order: dict[str, Any], held: dict[str, Any]) -> bool:
    """STK: symbol+currency. OPT: symbol+expiry+right+strike, multiplier/currency if both set."""

    if order["sec_type"] != held["sec_type"] or order["symbol"] != held["symbol"]:
        return False
    if order["sec_type"] == "STK":
        return order["currency"] == held["currency"]
    if (order["expiry"], order["right"], order["strike"]) != (
        held["expiry"],
        held["right"],
        held["strike"],
    ):
        return False
    for key in ("multiplier", "currency"):
        if order[key] and held[key] and order[key] != held[key]:
            return False
    return True


def _policy_config(env: Mapping[str, str] | None = None) -> tuple[Path, float]:
    source = os.environ if env is None else env
    directory = Path(source.get("NAUTILUS_ACCOUNT_SNAPSHOT_DIR") or DEFAULT_ACCOUNT_SNAPSHOT_DIR)
    try:
        max_age = float(source.get("NAUTILUS_ORDER_POLICY_MAX_SNAPSHOT_AGE_SECONDS") or "")
    except ValueError:
        max_age = DEFAULT_MAX_SNAPSHOT_AGE_SECONDS
    if not math.isfinite(max_age) or max_age <= 0:
        max_age = DEFAULT_MAX_SNAPSHOT_AGE_SECONDS
    return directory, max_age


def order_policy_status(env: Mapping[str, str] | None = None) -> dict[str, Any]:
    """The loaded order policy and its snapshot settings (no account data)."""

    directory, max_age = _policy_config(env)
    return {
        "order_policy": ORDER_POLICY,
        "account_snapshot_dir": str(directory),
        "max_snapshot_age_seconds": max_age,
    }


def _newest_snapshot(directory: Path) -> Path | None:
    # The name carries a UTC stamp (%Y%m%dT%H%M%SZ), so the largest name is the newest.
    try:
        with os.scandir(directory) as entries:
            names = [
                entry.name
                for entry in entries
                if SNAPSHOT_NAME_RE.fullmatch(entry.name) and entry.is_file()
            ]
    except OSError:
        return None
    return directory / max(names) if names else None


def _load_snapshot(
    env: Mapping[str, str] | None = None, now: float | None = None
) -> tuple[list[dict[str, Any]], float]:
    """Positions and capture time of the newest fresh account snapshot."""

    directory, max_age = _policy_config(env)
    path = _newest_snapshot(directory)
    if path is None:
        raise OrderPolicyError("snapshot_unavailable", f"no account snapshot in {directory}")
    try:
        with open(path, "rb") as handle:
            raw = handle.read(SNAPSHOT_MAX_BYTES + 1)
    except OSError as exc:
        raise OrderPolicyError("snapshot_unavailable", f"{path.name}: {type(exc).__name__}") from exc
    if len(raw) > SNAPSHOT_MAX_BYTES:
        raise OrderPolicyError("snapshot_invalid", f"{path.name} is too large")
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise OrderPolicyError("snapshot_invalid", f"{path.name} is not JSON") from exc
    captured = data.get("captured_at_epoch") if isinstance(data, dict) else None
    positions = data.get("positions") if isinstance(data, dict) else None
    captured_at = _decimal(captured)
    if captured_at is None or not isinstance(positions, list):
        raise OrderPolicyError(
            "snapshot_invalid", f"{path.name} lacks captured_at_epoch or positions"
        )
    age = (time.time() if now is None else now) - float(captured_at)
    if age < -SNAPSHOT_FUTURE_TOLERANCE_SECONDS:
        raise OrderPolicyError("snapshot_invalid", f"{path.name} is stamped in the future")
    if age > max_age:
        raise OrderPolicyError(
            "snapshot_stale", f"{path.name} is {int(age)}s old (max {int(max_age)}s)"
        )
    held: list[dict[str, Any]] = []
    for position in positions:
        if not isinstance(position, dict) or _decimal(position.get("quantity")) is None:
            raise OrderPolicyError("snapshot_invalid", f"{path.name} has an invalid position")
        held.append(position)
    return held, float(captured_at)


def load_held_positions(
    env: Mapping[str, str] | None = None, now: float | None = None
) -> list[dict[str, Any]]:
    """Positions of the newest fresh account snapshot, or raise ``OrderPolicyError``."""

    return _load_snapshot(env, now)[0]


@dataclass(frozen=True)
class _CloseReservation:
    identity: dict[str, Any]
    action: str
    quantity: Decimal
    placed_at: float


# Closes this process placed, by order id. Guarded by _policy_lock, which also
# serialises the policy check and placeOrder so two closes cannot both pass.
# Reentrant: ibapi may call the error handler on this thread inside placeOrder.
_policy_lock = threading.RLock()
_close_reservations: dict[Any, _CloseReservation] = {}


def _reserved_quantity(
    identity: dict[str, Any], action: str, order_id: Any, captured_at: float
) -> Decimal:
    settled = captured_at - CLOSE_RESERVATION_SETTLE_SECONDS
    for key in [key for key, item in _close_reservations.items() if item.placed_at <= settled]:
        del _close_reservations[key]
    return sum(
        (
            item.quantity
            for key, item in _close_reservations.items()
            if key != order_id
            and item.action == action
            and _same_contract(identity, item.identity)
        ),
        Decimal(0),
    )


def _opening_code(sec_type: str, action: str) -> tuple[str, str]:
    if sec_type == "STK" and action == "BUY":
        return "new_share_buy", "share buys may only cover a held short"
    if sec_type == "STK":
        return "new_share_short", "share sales may only reduce a held long"
    return "short_option_open", "option sales may only reduce a held long option"


def _evaluate_order(
    contract: Any,
    order: Any,
    *,
    order_id: Any = None,
    env: Mapping[str, str] | None = None,
    now: float | None = None,
) -> tuple[str, dict[str, Any], str, Decimal]:
    """Return (allowance, contract identity, action, quantity) or raise ``OrderPolicyError``."""

    if contract is None or order is None:
        raise OrderPolicyError("order_missing", "contract and order are required")
    identity = _order_contract_identity(contract)
    sec_type = identity["sec_type"]
    if sec_type == "BAG" or getattr(contract, "comboLegs", None):
        raise OrderPolicyError("combo_refused", "BAG/combo orders are not allowed")
    if getattr(contract, "deltaNeutralContract", None) is not None or _text(
        getattr(order, "deltaNeutralOrderType", "")
    ):
        raise OrderPolicyError("delta_neutral_refused", "delta-neutral orders are not allowed")
    if sec_type not in ("STK", "OPT"):
        raise OrderPolicyError(
            "sec_type_refused",
            f"secType {_short(sec_type, 16) or 'missing'} is not allowed (options only)",
        )
    action = _text(getattr(order, "action", "")).upper()
    if action not in ("BUY", "SELL"):
        raise OrderPolicyError("action_refused", f"action {_short(action, 16) or 'missing'}")
    quantity = _positive(getattr(order, "totalQuantity", None))
    if quantity is None or quantity >= _UNSET_QUANTITY:
        raise OrderPolicyError("quantity_missing", "totalQuantity must be a positive number")
    if sec_type == "OPT" and action == "BUY":
        return ALLOW_LONG_OPTION, identity, action, quantity
    if not _identity_complete(identity):
        raise OrderPolicyError(
            "contract_incomplete",
            "a close must name the exact contract "
            "(STK: symbol, currency; OPT: symbol, expiry, right, strike)",
        )
    positions, captured_at = _load_snapshot(env, now)
    held = sum(
        (
            _decimal(position.get("quantity")) or Decimal(0)
            for position in positions
            if _same_contract(identity, _position_identity(position))
        ),
        Decimal(0),
    )
    reduces = held > 0 if action == "SELL" else held < 0
    if not reduces:
        code, detail = _opening_code(sec_type, action)
        raise OrderPolicyError(code, detail)
    reserved = _reserved_quantity(identity, action, order_id, captured_at)
    if quantity + reserved > abs(held):
        raise OrderPolicyError(
            "exceeds_held_quantity",
            f"order quantity {quantity} plus {reserved} already closing "
            f"exceeds the held quantity {abs(held)}",
        )
    return ALLOW_POSITION_CLOSE, identity, action, quantity


def check_order_policy(
    contract: Any,
    order: Any,
    *,
    order_id: Any = None,
    env: Mapping[str, str] | None = None,
    now: float | None = None,
) -> str:
    """Return why the order is allowed, or raise ``OrderPolicyError``.

    Returns ``ALLOW_LONG_OPTION`` or ``ALLOW_POSITION_CLOSE``. Read-only: it
    records no close reservation (``place_order`` does).
    """

    with _policy_lock:
        return _evaluate_order(contract, order, order_id=order_id, env=env, now=now)[0]


def _record_placement(
    order_id: Any,
    order: Any,
    allowance: str,
    identity: dict[str, Any],
    action: str,
    quantity: Decimal,
) -> None:
    if bool(getattr(order, "whatIf", False)):
        return  # a whatIf preflight creates no order
    if allowance == ALLOW_POSITION_CLOSE:
        _close_reservations[order_id] = _CloseReservation(identity, action, quantity, time.time())
    else:
        _close_reservations.pop(order_id, None)


def _refusal_event(
    refusal: OrderPolicyError, order_id: Any, contract: Any, order: Any, source: str
) -> dict[str, Any]:
    return {
        "source": _short(source),
        "error": refusal.code,
        "detail": _short(refusal.detail, 280),
        "order_id": _short(order_id, 32),
        "sec_type": _short(getattr(contract, "secType", ""), 16),
        "symbol": _short(getattr(contract, "symbol", ""), 32),
        "action": _short(getattr(order, "action", ""), 16),
        "quantity": _short(getattr(order, "totalQuantity", ""), 48),
        "what_if": bool(getattr(order, "whatIf", False)),
    }


def place_order(client: Any, order_id: int, contract: Any, order: Any, *, source: str) -> None:
    """The one IBKR ``placeOrder`` call site of the node (includes whatIf).

    The node must be armed and the order must pass ``check_order_policy``.
    """

    require_armed("placeOrder", source)
    with _policy_lock:
        try:
            allowance, identity, action, quantity = _evaluate_order(
                contract, order, order_id=order_id
            )
        except OrderPolicyError as exc:
            refusal = exc
        except Exception as exc:  # a policy fault refuses the order; it never places it
            refusal = OrderPolicyError("policy_error", type(exc).__name__)
            refusal.__cause__ = exc
        else:
            # Reserve first: if placeOrder raises after sending, the close still counts.
            _record_placement(order_id, order, allowance, identity, action, quantity)
            client.placeOrder(order_id, contract, order)
            return
    try:
        gate = current()
        if gate is not None:
            gate.audit_order_refusal(_refusal_event(refusal, order_id, contract, order, source))
    except Exception:  # the audit line is best effort; the refusal is raised regardless
        pass
    raise refusal


def cancel_order(client: Any, order_id: int, *, source: str) -> None:
    """The one IBKR ``cancelOrder`` call site of the node."""

    require_armed("cancelOrder", source)
    try:
        client.cancelOrder(order_id, "")
    except TypeError:
        client.cancelOrder(order_id)
    with _policy_lock:
        _close_reservations.pop(order_id, None)
