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
* Environment flags never arm the node.

``place_order`` and ``cancel_order`` in this module are the only functions in
the node that call the IBKR API ``placeOrder`` and ``cancelOrder`` methods. A
test scans the package to keep it that way. Each call reads the arm state from
disk again, so a disarm takes effect on the next call.

Before ``configure`` runs, the module gate refuses every mutation.

``place_order`` also applies the owner's order policy (``ORDER_POLICY``):
options only, risk always defined, max loss <= 2% of NetLiquidation. An armed
node may place only a LMT BUY of an option whose premium (the most it can
lose) is at most 2% of NetLiquidation, or an order that closes or reduces a
held position of the exact contract while no other close of it is working.
Everything else, whatIf preflights included, is refused with
``OrderPolicyError``. See ``check_order_policy``.
"""

from __future__ import annotations

import argparse
import fcntl
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
from collections import OrderedDict
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
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

# Owner rule (2026-11-04): options only, risk always defined, max loss per
# order <= 2% of NetLiquidation; closes and reductions are always allowed.
ORDER_POLICY = "options_only_defined_risk_v2"
DEFAULT_ACCOUNT_SNAPSHOT_DIR = "/app/data/nautilus/reports"
DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 180.0
SNAPSHOT_NAME_RE = re.compile(r"ibkr-account-snapshot-\d{8}T\d{6}Z\.json")
SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024
# Written beside the snapshot by scripts/ibkr_account_snapshot.py (see
# nautilus/ibkr_account.py IbkrAccountSnapshot.class_sidecar).
CLASS_SIDECAR_NAME = "ibkr-account-classes.json"
CLASS_SIDECAR_SCHEMA = "ibkr-account-classes/v1"
# A snapshot stamped further in the future than this is invalid (clock fault).
SNAPSHOT_FUTURE_TOLERANCE_SECONDS = 60.0
# ibapi leaves totalQuantity at UNSET_DECIMAL (2**127 - 1) when it is not set;
# any quantity at or above this bound counts as unset.
_UNSET_QUANTITY = Decimal(2**63 - 1)
# A close placed (or reported final) less than this long before the snapshot
# was captured may be missing from it, so that snapshot cannot end its
# reservation. The snapshot copies positions at positionEnd and stamps
# captured_at after waiting for market values (up to 10 s), so the margin is
# this minus that wait.
CLOSE_RESERVATION_SETTLE_SECONDS = 30.0

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


# -- order policy: options only, risk always defined, max loss <= 2% NLV ------
#
# Allowed (whatIf preflights are checked the same way):
# * BUY of an option (secType OPT) as a LMT order whose premium, totalQuantity
#   * lmtPrice * multiplier (the contract must name it), is at most
#   NAUTILUS_ORDER_POLICY_MAX_LOSS_PCT (default 2.0, never above 2.0) percent of
#   NetLiquidation (summary NetLiquidation USD) in the newest fresh account
#   snapshot. The most a long option can lose is that premium. The cap is per
#   order: premium already held or working in the same underlying is not added.
# * A close or reduction of a held position (STK or OPT): the side is opposite
#   to the held quantity of the exact contract in the newest fresh snapshot, the
#   order quantity is at most the absolute held quantity, and no other close of
#   that contract is unresolved (at most one working close per contract). Every
#   BUY of a held-short option is such a close (none beyond the short).
# Everything else is refused: new shares (long or short), an option sale that
# opens or adds to a short, an option buy that is not LMT or has no limit price
# or multiplier, an order without the exact contract (option: expiry, right,
# strike), an option order that a held option of the same symbol, expiry,
# right and strike cannot be proved to match or differ from (conId or
# tradingClass on both sides; SPX/SPXW and adjusted classes look alike
# otherwise), BAG/combos, delta-neutral orders, futures, other or
# missing secType, missing action or quantity. A missing, unreadable, invalid or stale snapshot refuses
# every order; a snapshot without NetLiquidation refuses every option buy.
#
# Working closes. The snapshot carries no IBKR working orders and the node's
# IBKR clients share no synchronous open-orders helper, so the gate records
# every close it places (not whatIf) as a reservation in a JSON file
# (NAUTILUS_ORDER_POLICY_RESERVATIONS_PATH) that survives restarts. A
# reservation ends only when
#   (a) a fresh snapshot captured at least CLOSE_RESERVATION_SETTLE_SECONDS
#       after the placement shows the position reduced by the order quantity
#       (held quantity <= held quantity at placement - order quantity), or
#   (b) IBKR reported the order final (Cancelled, ApiCancelled or Filled) to
#       an orderStatus callback the gate observes in this process (on every
#       client it places or cancels through; keyed by the clientId IBKR names
#       in the status), and a snapshot was captured at least
#       CLOSE_RESERVATION_SETTLE_SECONDS after that status (it then includes
#       every fill of the order), or
#   (c) the owner releases it (``python -m nautilus.arm_gate release-close``,
#       audited) after checking in TWS that the order no longer works.
# A final order whose fills a snapshot may not show yet no longer blocks a new
# close of the contract: the new close may be at most min(held now, its
# baseline - filled), which becomes the new baseline, and it replaces the old
# reservation in the same write. A modify under the same order id may not
# exceed its reservation's baseline either. Inactive is not final (it can be a hold).
# A cancel request alone ends nothing. A replacement under the same order id
# and client keeps the reservation's baseline and the larger quantity (IBKR
# may refuse the modify). An unreadable or invalid reservation file refuses
# every close (fail closed). Writers hold ``_policy_lock`` and an exclusive
# flock on ``<file>.lock``.
#
# Known limits: orders placed outside the gate (TWS, other API clients, host
# scripts) are invisible to it, and a close filled outside the gate can end a
# reservation whose own order is still working. Statuses seen before a restart
# are lost, so a close that was cancelled then, or that expired unseen (for
# example a DAY order from a client that has disconnected), stays reserved
# until (a) or (c). Closing those gaps needs IBKR open orders in the snapshot.

_RIGHTS = {"C": "C", "CALL": "C", "P": "P", "PUT": "P"}
# Snapshot position fields used when the position's contract dict lacks them.
_POSITION_FALLBACK = {"secType": "sec_type", "symbol": "symbol", "currency": "currency"}
MAX_LOSS_PCT_ENV = "NAUTILUS_ORDER_POLICY_MAX_LOSS_PCT"
DEFAULT_MAX_LOSS_PCT = Decimal("2.0")
MAX_LOSS_PCT_CEILING = Decimal("2.0")
# ibapi leaves lmtPrice and cashQty at UNSET_DOUBLE (sys.float_info.max) when unset.
_UNSET_PRICE = Decimal("1e100")
RESERVATIONS_ENV = "NAUTILUS_ORDER_POLICY_RESERVATIONS_PATH"
DEFAULT_RESERVATIONS_PATH = "/app/data/nautilus/order-policy-reservations.json"
RESERVATIONS_SCHEMA = "nautilus-order-policy-reservations-v1"
RESERVATIONS_MAX_BYTES = 1024 * 1024
# Statuses after which IBKR fills nothing more. "Inactive" is not here: it can
# be a hold that IBKR releases later.
_FINAL_STATUSES = frozenset({"cancelled", "apicancelled", "filled"})
RESERVATIONS_LOCK_TIMEOUT_SECONDS = 5.0
_OUTCOMES_MAX = 4096
_IDENTITY_KEYS = (
    "sec_type",
    "symbol",
    "currency",
    "expiry",
    "right",
    "strike",
    "multiplier",
    "trading_class",
    "con_id",
)


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


def _con_id(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    text = _text(value)
    return int(text) if text.isdigit() and int(text) > 0 else None


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
        "trading_class": _text(get("tradingClass")).upper(),
        "con_id": _con_id(get("conId")),
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
    """May be the same contract. STK: symbol+currency. OPT: symbol+expiry+right+strike.

    conId, and for OPT multiplier, currency and tradingClass, must agree when
    both sides set them. See ``_class_verified`` for positive proof.
    """

    if order["sec_type"] != held["sec_type"] or order["symbol"] != held["symbol"]:
        return False
    if order["con_id"] and held["con_id"] and order["con_id"] != held["con_id"]:
        return False
    if order["sec_type"] == "STK":
        return order["currency"] == held["currency"]
    if (order["expiry"], order["right"], order["strike"]) != (
        held["expiry"],
        held["right"],
        held["strike"],
    ):
        return False
    for key in ("multiplier", "currency", "trading_class"):
        if order[key] and held[key] and order[key] != held[key]:
            return False
    return True


def _class_verified(order: dict[str, Any], held: dict[str, Any]) -> bool:
    """An option matches a held one only when conId or tradingClass is set on both and equal.

    SPX and SPXW (or an adjusted class) share symbol, expiry, right and strike.
    """

    if order["sec_type"] != "OPT":
        return True
    if order["con_id"] and held["con_id"]:
        return order["con_id"] == held["con_id"]
    return bool(order["trading_class"]) and order["trading_class"] == held["trading_class"]


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


def _max_loss_pct(env: Mapping[str, str] | None = None) -> Decimal:
    """The per-order max-loss cap in percent of NLV. An invalid value refuses option buys."""

    source = os.environ if env is None else env
    raw = _text(source.get(MAX_LOSS_PCT_ENV))
    if not raw:
        return DEFAULT_MAX_LOSS_PCT
    pct = _decimal(raw)
    if pct is None or pct <= 0 or pct > MAX_LOSS_PCT_CEILING:
        raise OrderPolicyError(
            "max_loss_config_invalid",
            f"{MAX_LOSS_PCT_ENV} must be a number above 0 and at most {MAX_LOSS_PCT_CEILING}",
        )
    return pct


def _reservations_path(env: Mapping[str, str] | None = None) -> Path:
    source = os.environ if env is None else env
    return Path(source.get(RESERVATIONS_ENV) or DEFAULT_RESERVATIONS_PATH)


def order_policy_status(env: Mapping[str, str] | None = None) -> dict[str, Any]:
    """The loaded order policy and its settings (no account data)."""

    directory, max_age = _policy_config(env)
    try:
        max_loss: str | None = str(_max_loss_pct(env))
    except OrderPolicyError:
        max_loss = None
    return {
        "order_policy": ORDER_POLICY,
        "account_snapshot_dir": str(directory),
        "max_snapshot_age_seconds": max_age,
        "max_loss_pct_of_net_liquidation": max_loss,
        "close_reservations_path": str(_reservations_path(env)),
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


@dataclass(frozen=True)
class _Snapshot:
    positions: list[dict[str, Any]]
    captured_at: float
    # summary NetLiquidation USD; None when missing, unparsable or not positive.
    net_liquidation: Decimal | None


def _net_liquidation(data: dict[str, Any]) -> Decimal | None:
    summary = data.get("summary")
    tag = summary.get("NetLiquidation") if isinstance(summary, dict) else None
    return _positive(tag.get("USD")) if isinstance(tag, dict) else None


def _load_snapshot(env: Mapping[str, str] | None = None, now: float | None = None) -> _Snapshot:
    """The newest fresh account snapshot, or raise ``OrderPolicyError``."""

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
    return _Snapshot(
        _with_classes(directory, path.name, captured_at, held), float(captured_at), _net_liquidation(data)
    )


def _with_classes(
    directory: Path, snapshot_name: str, captured_at: Decimal, positions: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Add conId/tradingClass from the class sidecar written with this snapshot.

    The v1 snapshot has no option class. Without a sidecar that names this
    snapshot, carries its ``captured_at_epoch`` and lists the same positions,
    positions stay unclassed and ``_class_verified`` refuses option orders that
    may match them.
    """

    try:
        with open(directory / CLASS_SIDECAR_NAME, "rb") as handle:
            raw = handle.read(SNAPSHOT_MAX_BYTES + 1)
        data = json.loads(raw) if len(raw) <= SNAPSHOT_MAX_BYTES else None
    except (OSError, ValueError):
        return positions
    entries = data.get("positions") if isinstance(data, dict) else None
    if (
        not isinstance(data, dict)
        or data.get("schemaVersion") != CLASS_SIDECAR_SCHEMA
        or data.get("snapshot") != snapshot_name
        or _decimal(data.get("captured_at_epoch")) != captured_at
        or not isinstance(entries, list)
        or len(entries) != len(positions)
    ):
        return positions
    classed: list[dict[str, Any]] = []
    for position, entry in zip(positions, entries):
        if (
            not isinstance(entry, dict)
            or _text(entry.get("symbol")).upper() != _text(position.get("symbol")).upper()
            or _text(entry.get("sec_type")).upper() != _text(position.get("sec_type")).upper()
            or _decimal(entry.get("quantity")) != _decimal(position.get("quantity"))
            or not isinstance(entry.get("tradingClass"), str)
        ):
            return positions
        raw_contract = position.get("contract")
        contract = dict(raw_contract) if isinstance(raw_contract, Mapping) else {}
        contract["conId"] = _con_id(entry.get("conId"))
        contract["tradingClass"] = entry["tradingClass"]
        classed.append({**position, "contract": contract})
    return classed


def load_held_positions(
    env: Mapping[str, str] | None = None, now: float | None = None
) -> list[dict[str, Any]]:
    """Positions of the newest fresh account snapshot, or raise ``OrderPolicyError``."""

    return _load_snapshot(env, now).positions


def _held_quantity(
    identity: dict[str, Any], positions: list[dict[str, Any]], *, verify: bool = False
) -> Decimal:
    """Signed quantity of the positions that may be this contract.

    ``verify``: refuse when one of them cannot be proved the same option class.
    """

    total = Decimal(0)
    for position in positions:
        held = _position_identity(position)
        if not _same_contract(identity, held):
            continue
        if verify and not _class_verified(identity, held):
            raise OrderPolicyError(
                "trading_class_unverifiable",
                "a held option with this symbol, expiry, right and strike cannot be proved "
                "the same class (conId or tradingClass missing on the order or the snapshot)",
            )
        total += _decimal(position.get("quantity")) or Decimal(0)
    return total


# -- close reservations (persisted) -------------------------------------------

# Serialises the policy check, the reservation file and placeOrder so two
# closes cannot both pass. Reentrant: ibapi may call the error handler on this
# thread inside placeOrder.
_policy_lock = threading.RLock()
_reservations_lock_depth = 0  # guarded by _policy_lock

# Last orderStatus per (clientId, order id), recorded on the IBKR reader thread.
_outcomes_lock = threading.Lock()
_order_outcomes: OrderedDict[tuple[str, str], tuple[str, Decimal | None, float]] = OrderedDict()


@contextmanager
def _reservations_lock(path: Path) -> Iterator[None]:
    """Exclusive flock on ``<path>.lock`` (caller holds ``_policy_lock``); reentrant per thread."""

    global _reservations_lock_depth
    if _reservations_lock_depth:
        _reservations_lock_depth += 1
        try:
            yield
        finally:
            _reservations_lock_depth -= 1
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(f"{path}.lock", os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as exc:
        raise OrderPolicyError("reservations_lock_failed", type(exc).__name__) from exc
    try:
        deadline = time.monotonic() + RESERVATIONS_LOCK_TIMEOUT_SECONDS
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise OrderPolicyError(
                        "reservations_locked", f"{path.name}.lock is held by another process"
                    ) from None
                time.sleep(0.05)
            except OSError as exc:
                raise OrderPolicyError("reservations_lock_failed", type(exc).__name__) from exc
        _reservations_lock_depth = 1
        try:
            yield
        finally:
            _reservations_lock_depth = 0
    finally:
        os.close(fd)  # closing the descriptor releases the flock


def _record_outcome(client: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> None:
    order_id = args[0] if args else kwargs.get("orderId")
    status = args[1] if len(args) > 1 else kwargs.get("status")
    filled = args[2] if len(args) > 2 else kwargs.get("filled")
    # IBKR names the client that placed the order (ibapi orderStatus arg 9);
    # the receiving client may be another one, or already disconnected.
    placed_by = args[8] if len(args) > 8 else kwargs.get("clientId")
    if isinstance(placed_by, int) and not isinstance(placed_by, bool):
        owner = str(placed_by)
    else:
        owner = _client_key(client)
    key = (owner, _short(order_id, 32))
    outcome = (_text(status).lower().replace(" ", ""), _decimal(filled), time.time())
    with _outcomes_lock:
        _order_outcomes[key] = outcome
        _order_outcomes.move_to_end(key)
        while len(_order_outcomes) > _OUTCOMES_MAX:
            _order_outcomes.popitem(last=False)


def _observe_order_status(client: Any) -> None:
    """Record every orderStatus callback IBKR sends this client (ibapi calls ``wrapper.orderStatus``)."""

    target = getattr(client, "wrapper", None) or client
    original = getattr(target, "orderStatus", None)
    if not callable(original) or getattr(original, "_arm_gate_observer", False):
        return

    def orderStatus(*args: Any, **kwargs: Any) -> Any:  # noqa: N802 - ibapi callback name
        try:
            _record_outcome(client, args, kwargs)
        except Exception:  # never break the client's own callback
            pass
        return original(*args, **kwargs)

    orderStatus._arm_gate_observer = True  # type: ignore[attr-defined]
    try:
        target.orderStatus = orderStatus
    except Exception:  # no observer: cancels are never seen, closes stay reserved
        pass


def _forget_outcome(client: Any, order_id: Any) -> None:
    with _outcomes_lock:
        _order_outcomes.pop((_client_key(client), _short(order_id, 32)), None)


def _final_outcome(item: dict[str, Any]) -> tuple[Decimal, float] | None:
    """(filled, seen at) when IBKR reported the order final with a known fill."""

    with _outcomes_lock:
        outcome = _order_outcomes.get((item["client_id"], item["order_id"]))
    if outcome is None or outcome[0] not in _FINAL_STATUSES or outcome[1] is None:
        return None
    return max(outcome[1], Decimal(0)), outcome[2]


def _client_key(client: Any) -> str:
    return _short(getattr(client, "clientId", None), 16)


def _reservation_key(client: Any, order_id: Any) -> str:
    return f"{_client_key(client)}:{_short(order_id, 32)}"


def _identity_to_json(identity: dict[str, Any]) -> dict[str, Any]:
    return {
        key: (str(identity[key]) if isinstance(identity[key], Decimal) else identity[key])
        for key in _IDENTITY_KEYS
    }


def _identity_from_json(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    identity: dict[str, Any] = {}
    for key in _IDENTITY_KEYS:
        value = raw.get(key)
        if key in ("strike", "multiplier"):
            if value is not None and _positive(value) is None:
                return None
            identity[key] = _positive(value)
        elif key == "con_id":
            if value is not None and _con_id(value) is None:
                return None
            identity[key] = _con_id(value)
        elif isinstance(value, str):
            identity[key] = value
        else:
            return None
    if identity["sec_type"] not in ("STK", "OPT") or not _identity_complete(identity):
        return None
    return identity


def _parse_reservation(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    identity = _identity_from_json(raw.get("contract"))
    quantity = _positive(raw.get("quantity"))
    held_before = _positive(raw.get("held_before"))
    placed_at = raw.get("placed_at")
    fields = [raw.get(key) for key in ("key", "order_id", "client_id", "source")]
    if (
        identity is None
        or quantity is None
        or held_before is None
        or raw.get("action") not in ("BUY", "SELL")
        or isinstance(placed_at, bool)
        or not isinstance(placed_at, (int, float))
        or not math.isfinite(placed_at)
        or not all(isinstance(value, str) for value in fields)
        or not raw["key"]
    ):
        return None
    return {
        "key": raw["key"],
        "order_id": raw["order_id"],
        "client_id": raw["client_id"],
        "source": raw["source"],
        "identity": identity,
        "action": raw["action"],
        "quantity": quantity,
        "held_before": held_before,
        "placed_at": float(placed_at),
    }


def _read_reservations(path: Path) -> dict[str, dict[str, Any]]:
    """Unresolved closes by key, or raise ``OrderPolicyError`` (every close is refused)."""

    try:
        with open(path, "rb") as handle:
            raw = handle.read(RESERVATIONS_MAX_BYTES + 1)
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise OrderPolicyError(
            "reservations_unreadable", f"{path.name}: {type(exc).__name__}"
        ) from exc
    invalid = OrderPolicyError("reservations_invalid", f"{path.name} is not a valid reservation file")
    if len(raw) > RESERVATIONS_MAX_BYTES:
        raise invalid
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise invalid from exc
    entries = data.get("reservations") if isinstance(data, dict) else None
    if not isinstance(data, dict) or data.get("schema") != RESERVATIONS_SCHEMA or not isinstance(
        entries, list
    ):
        raise invalid
    reservations: dict[str, dict[str, Any]] = {}
    for entry in entries:
        item = _parse_reservation(entry)
        if item is None or item["key"] in reservations:
            raise invalid
        reservations[item["key"]] = item
    return reservations


def _write_reservations(path: Path, reservations: dict[str, dict[str, Any]]) -> None:
    entries = [
        {
            "key": item["key"],
            "order_id": item["order_id"],
            "client_id": item["client_id"],
            "source": item["source"],
            "contract": _identity_to_json(item["identity"]),
            "action": item["action"],
            "quantity": str(item["quantity"]),
            "held_before": str(item["held_before"]),
            "placed_at": item["placed_at"],
        }
        for _, item in sorted(reservations.items())
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(
                {"schema": RESERVATIONS_SCHEMA, "updated_at": utc_now(), "reservations": entries},
                handle,
                sort_keys=True,
                indent=2,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def _reservation_resolved(item: dict[str, Any], snapshot: _Snapshot) -> bool:
    settled = snapshot.captured_at - CLOSE_RESERVATION_SETTLE_SECONDS
    quantity = item["quantity"]
    final = _final_outcome(item)
    if final is not None:
        filled, seen_at = final
        if settled >= seen_at:
            return True  # this snapshot includes every fill of the order
        # Until then the reservation stays: its baseline may carry fills of an
        # order it replaced that the snapshot does not show yet (see
        # _evaluate_close, which caps a new close by it).
        quantity = min(quantity, filled)  # only the filled part must show
    if settled >= item["placed_at"]:
        try:
            # Unproven classes (no usable sidecar) could net SPX +2 against
            # SPXW -2 and fake the reduction: keep the reservation instead.
            held = _held_quantity(item["identity"], snapshot.positions, verify=True)
        except OrderPolicyError:
            return False
        directional = held if item["action"] == "SELL" else -held
        if directional <= item["held_before"] - quantity:
            return True
    return False


# -- order evaluation ---------------------------------------------------------


@dataclass(frozen=True)
class _Decision:
    allowance: str
    identity: dict[str, Any]
    action: str
    quantity: Decimal
    # Closes only: the absolute held quantity the reservation is measured from,
    # and the unresolved reservations after pruning (None for option buys).
    held_before: Decimal | None = None
    reservations: dict[str, dict[str, Any]] | None = None


def _opening_code(sec_type: str, action: str) -> tuple[str, str]:
    if sec_type == "STK" and action == "BUY":
        return "new_share_buy", "share buys may only cover a held short"
    if sec_type == "STK":
        return "new_share_short", "share sales may only reduce a held long"
    return "short_option_open", "option sales may only reduce a held long option"


def _check_option_premium(
    order: Any,
    identity: dict[str, Any],
    quantity: Decimal,
    snapshot: _Snapshot,
    env: Mapping[str, str] | None,
) -> None:
    pct = _max_loss_pct(env)
    order_type = _text(getattr(order, "orderType", "")).upper()
    if order_type != "LMT":
        raise OrderPolicyError(
            "order_type_refused",
            f"an option buy must be a LMT order (got {_short(order_type, 16) or 'missing'})",
        )
    limit = _positive(getattr(order, "lmtPrice", None))
    if limit is None or limit >= _UNSET_PRICE:
        raise OrderPolicyError("limit_price_missing", "an option buy needs a positive lmtPrice")
    discretionary = _decimal(getattr(order, "discretionaryAmt", None))
    if discretionary is not None and discretionary != 0:
        raise OrderPolicyError("discretionary_refused", "discretionary amounts can fill above lmtPrice")
    cash_quantity = _positive(getattr(order, "cashQty", None))
    if cash_quantity is not None and cash_quantity < _UNSET_PRICE:
        raise OrderPolicyError("cash_quantity_refused", "an option buy must size by totalQuantity")
    if identity["currency"] != "USD":
        raise OrderPolicyError(
            "currency_refused", "the max-loss cap is measured in USD NetLiquidation"
        )
    if snapshot.net_liquidation is None:
        raise OrderPolicyError(
            "net_liquidation_unavailable", "the account snapshot has no NetLiquidation USD"
        )
    if identity["multiplier"] is None:
        # IBKR's qualified contract names it; an adjusted option may not be 100.
        raise OrderPolicyError("multiplier_missing", "an option buy must name the contract multiplier")
    premium = quantity * limit * identity["multiplier"]
    if premium > snapshot.net_liquidation * pct / 100:
        raise OrderPolicyError(
            "max_loss_exceeded",
            f"premium {premium.normalize():f} USD exceeds {pct}% of NetLiquidation",
        )


def _evaluate_close(
    identity: dict[str, Any],
    action: str,
    quantity: Decimal,
    key: str,
    snapshot: _Snapshot,
    env: Mapping[str, str] | None,
) -> _Decision:
    held = _held_quantity(identity, snapshot.positions, verify=True)
    directional = held if action == "SELL" else -held
    if directional <= 0:
        code, detail = _opening_code(identity["sec_type"], action)
        raise OrderPolicyError(code, detail)
    if quantity > directional:
        raise OrderPolicyError(
            "exceeds_held_quantity",
            f"order quantity {quantity} exceeds the held quantity {directional}",
        )
    stored = _read_reservations(_reservations_path(env))
    live = {
        name: item
        for name, item in stored.items()
        if not _reservation_resolved(item, snapshot)
    }
    previous = live.get(key)
    if previous is not None and (
        previous["action"] != action
        or not _same_contract(identity, previous["identity"])
        or not _class_verified(identity, previous["identity"])
    ):
        raise OrderPolicyError(
            "order_id_reused", "this order id holds an unresolved close of another contract or side"
        )
    final_limit: Decimal | None = None
    working: list[str] = []
    for name, item in list(live.items()):
        if name == key or not _same_contract(identity, item["identity"]):
            continue
        final = _final_outcome(item)
        if final is None or not _class_verified(identity, item["identity"]):
            # Working, or final but maybe another option class: it blocks.
            working.append(item["order_id"])
            continue
        # Final, but a snapshot may not show its fills yet: count them here and
        # let the new reservation replace it.
        cap = item["held_before"] - final[0]
        final_limit = cap if final_limit is None else min(final_limit, cap)
        del live[name]
    if working:
        raise OrderPolicyError(
            "close_already_working",
            f"an unresolved close of this contract (order id {', '.join(sorted(working))[:64]}) "
            "is not yet reduced in a snapshot or final",
        )
    limit = directional if final_limit is None else min(directional, final_limit)
    if previous is not None:
        # A modify's totalQuantity counts its own fills from its baseline; the
        # baseline may also carry fills the snapshot does not show yet.
        limit = min(limit, previous["held_before"])
    if quantity > limit:
        raise OrderPolicyError(
            "exceeds_held_quantity",
            f"order quantity {quantity} exceeds the held quantity {max(limit, Decimal(0))}",
        )
    # A replacement keeps the baseline: IBKR counts filled shares in the new
    # totalQuantity. It also keeps the larger quantity: IBKR may refuse the
    # modify and leave the old order working.
    if previous is None:
        held_before = limit
    elif final_limit is None:
        held_before = previous["held_before"]
    else:
        held_before = min(previous["held_before"], final_limit)
    reserved = quantity if previous is None else max(quantity, previous["quantity"])
    return _Decision(ALLOW_POSITION_CLOSE, identity, action, reserved, held_before, live)


def _evaluate_order(
    contract: Any,
    order: Any,
    *,
    order_id: Any = None,
    client: Any = None,
    env: Mapping[str, str] | None = None,
    now: float | None = None,
) -> _Decision:
    """Return the decision for an order, or raise ``OrderPolicyError``."""

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
    key = _reservation_key(client, order_id)
    if not _identity_complete(identity):
        raise OrderPolicyError(
            "contract_incomplete",
            "an order must name the exact contract "
            "(STK: symbol, currency; OPT: symbol, expiry, right, strike)",
        )
    if sec_type == "OPT" and action == "BUY":
        snapshot = _load_snapshot(env, now)
        if _held_quantity(identity, snapshot.positions, verify=True) < 0:
            # Every buy of a held-short option is a close. No capped-buy
            # fallback: it could fill beside a working cover and open a long.
            return _evaluate_close(identity, action, quantity, key, snapshot, env)
        _check_option_premium(order, identity, quantity, snapshot, env)
        return _Decision(ALLOW_LONG_OPTION, identity, action, quantity)
    snapshot = _load_snapshot(env, now)
    return _evaluate_close(identity, action, quantity, key, snapshot, env)


def check_order_policy(
    contract: Any,
    order: Any,
    *,
    order_id: Any = None,
    client: Any = None,
    env: Mapping[str, str] | None = None,
    now: float | None = None,
) -> str:
    """Return why the order is allowed, or raise ``OrderPolicyError``.

    Returns ``ALLOW_LONG_OPTION`` or ``ALLOW_POSITION_CLOSE``. Read-only: it
    writes no close reservation (``place_order`` does).
    """

    with _policy_lock:
        return _evaluate_order(
            contract, order, order_id=order_id, client=client, env=env, now=now
        ).allowance


def _record_placement(
    decision: _Decision, key: str, order_id: Any, client: Any, order: Any, source: str
) -> None:
    """Persist the close reservation before placeOrder; an OSError refuses the order."""

    if decision.reservations is None:
        return  # an option buy reserves nothing
    if bool(getattr(order, "whatIf", False)):
        return  # a whatIf preflight creates no order
    reservations = dict(decision.reservations)
    reservations[key] = {
        "key": key,
        "order_id": _short(order_id, 32),
        "client_id": _client_key(client),
        "source": _short(source),
        "identity": decision.identity,
        "action": decision.action,
        "quantity": decision.quantity,
        "held_before": decision.held_before,
        "placed_at": time.time(),
    }
    _write_reservations(_reservations_path(), reservations)
    # Only statuses IBKR sends after this placement may end the reservation.
    _forget_outcome(client, order_id)


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


def _require_connected(client: Any) -> None:
    # ibapi's placeOrder only reports NOT_CONNECTED to the error callback and
    # returns, so a reservation written for it would never end.
    connected = getattr(client, "isConnected", None)
    if callable(connected) and not connected():
        raise OrderPolicyError("client_not_connected", "the IBKR client is not connected")


def place_order(client: Any, order_id: int, contract: Any, order: Any, *, source: str) -> None:
    """The one IBKR ``placeOrder`` call site of the node (includes whatIf).

    The node must be armed and the order must pass ``check_order_policy``. A
    close is reserved in the reservation file before ``placeOrder`` is called.
    """

    require_armed("placeOrder", source)
    with _policy_lock:
        try:
            _require_connected(client)
            _observe_order_status(client)
            with _reservations_lock(_reservations_path()):
                # The lock wait can take seconds: a disarm or kill switch in it wins.
                status = current_status()
                if not status.armed:
                    raise OrderPolicyError("disarmed", f"node is disarmed ({status.detail})")
                decision = _evaluate_order(contract, order, order_id=order_id, client=client)
                # Reserve first: if placeOrder raises after sending, the close still counts.
                try:
                    _record_placement(
                        decision, _reservation_key(client, order_id), order_id, client, order, source
                    )
                except OSError as exc:
                    raise OrderPolicyError(
                        "reservations_write_failed", type(exc).__name__
                    ) from exc
        except OrderPolicyError as exc:
            refusal = exc
        except Exception as exc:  # a policy fault refuses the order; it never places it
            refusal = OrderPolicyError("policy_error", type(exc).__name__)
            refusal.__cause__ = exc
        else:
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
    """The one IBKR ``cancelOrder`` call site of the node.

    A cancel request does not end a close reservation: the order may fill
    before IBKR cancels it. The gate observes the client's orderStatus
    callbacks; a final status lets a new close replace the reservation.
    """

    require_armed("cancelOrder", source)
    with _policy_lock:
        _observe_order_status(client)
    try:
        client.cancelOrder(order_id, "")
    except TypeError:
        client.cancelOrder(order_id)


# -- owner tools for close reservations ---------------------------------------
#
# Run inside the nautilus-trader container:
#   python -m nautilus.arm_gate reservations --json
#   python -m nautilus.arm_gate release-close --key <clientId:orderId> \
#       --by <actor> --reason <text> --json
# Release a reservation only after checking in TWS that the order no longer
# works. Exit codes: 0 success, 2 refused, 3 unexpected error.

RESERVATION_AUDIT_EVENT = "close_reservation_released"


def list_close_reservations(env: Mapping[str, str] | None = None) -> list[dict[str, Any]]:
    """The unresolved closes in the reservation file (raises ``OrderPolicyError``)."""

    reservations = _read_reservations(_reservations_path(env))
    return [
        {
            "key": item["key"],
            "order_id": item["order_id"],
            "client_id": item["client_id"],
            "source": item["source"],
            "contract": _identity_to_json(item["identity"]),
            "action": item["action"],
            "quantity": str(item["quantity"]),
            "held_before": str(item["held_before"]),
            "placed_at": item["placed_at"],
        }
        for _, item in sorted(reservations.items())
    ]


def release_close_reservation(
    key: str, *, actor: str, reason: str, env: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Owner action: remove one reservation and audit it. Returns the removed entry."""

    if not isinstance(actor, str) or not ACTOR_RE.fullmatch(actor):
        raise ArmRequestError("invalid_actor", "actor must match ^[A-Za-z0-9_.@-]{1,64}$")
    reason = " ".join((reason or "").split())
    if not REASON_MIN <= len(reason) <= REASON_MAX:
        raise ArmRequestError(
            "invalid_reason", f"reason must be {REASON_MIN}-{REASON_MAX} characters"
        )
    path = _reservations_path(env)
    with _policy_lock, _reservations_lock(path):
        reservations = _read_reservations(path)
        item = reservations.pop(key, None)
        if item is None:
            raise ArmRequestError("unknown_reservation", "no unresolved close has this key")
        source = os.environ if env is None else env
        audit_path = source.get("NAUTILUS_ARM_AUDIT_PATH") or DEFAULT_AUDIT_PATH
        gate = ArmGate(
            source.get("NAUTILUS_ARMED_PATH") or DEFAULT_ARMED_PATH,
            "owner-tool",
            audit_path=audit_path,
        )
        gate._audit(
            {
                "event": RESERVATION_AUDIT_EVENT,
                "audit_id": str(uuid.uuid4()),
                "actor": actor,
                "reason": reason,
                "policy": ORDER_POLICY,
                "key": item["key"],
                "sec_type": item["identity"]["sec_type"],
                "symbol": item["identity"]["symbol"],
                "action": item["action"],
                "quantity": str(item["quantity"]),
            }
        )
        _write_reservations(path, reservations)
    return {"released": True, "key": item["key"], "remaining": len(reservations)}


def main(argv: list[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m nautilus.arm_gate")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("reservations", help="list unresolved close reservations")
    release = sub.add_parser("release-close", help="release one close reservation (owner action)")
    release.add_argument("--key", required=True)
    release.add_argument("--by", required=True)
    release.add_argument("--reason", required=True)
    for command in sub.choices.values():
        command.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "reservations":
            payload: dict[str, Any] = {"reservations": list_close_reservations(env)}
        else:
            payload = release_close_reservation(args.key, actor=args.by, reason=args.reason, env=env)
        code = 0
    except (ArmRequestError, OrderPolicyError) as exc:
        payload, code = {"error": exc.code, "detail": exc.detail}, 2
    except Exception as exc:  # pragma: no cover - defensive
        payload, code = {"error": "unexpected", "detail": type(exc).__name__}, 3
    print(json.dumps(payload, sort_keys=True))
    return code


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
