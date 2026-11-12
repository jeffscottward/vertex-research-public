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

Policy v3 adds defined-risk vertical option spreads (one BAG order, never two
single legs) behind the switch ``NAUTILUS_ORDER_POLICY_ALLOW_DEFINED_RISK_SPREADS``.
The switch is off by default; off is exactly the v2 behaviour. See "order
policy v3" below.
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
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from types import SimpleNamespace
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
# v3 (owner decision 2026-11-11, card vertex-golive-spread-gate): defined-risk
# vertical spreads, behind a switch that is off by default.
ORDER_POLICY = "options_only_defined_risk_v3"
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
# ibapi UNSET_INTEGER, the default of the scale order sizes.
_UNSET_INTEGER = Decimal(2**31 - 1)
# A close placed (or reported final) less than this long before the snapshot
# was captured may be missing from it, so that snapshot cannot end its
# reservation. The snapshot copies positions at positionEnd and stamps
# captured_at after waiting for market values (up to 10 s), so the margin is
# this minus that wait.
CLOSE_RESERVATION_SETTLE_SECONDS = 30.0

ALLOW_LONG_OPTION = "long_option_open"
ALLOW_POSITION_CLOSE = "position_close"
ALLOW_SPREAD_OPEN = "vertical_spread_open"
ALLOW_SPREAD_CLOSE = "vertical_spread_close"


class DisarmedError(RuntimeError):
    """A broker mutation was refused because the node is not armed."""

    # The named reason of this refusal; ``OrderPolicyError`` sets its own.
    code = "engine_disarmed"


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


def _number_set(value: Any, *, unset_double: bool = False, unset_integer: bool = False) -> bool:
    """Whether an order number that the v3 policy refuses when set is set.

    Unset: None, False, "", 0, and the ibapi marker the field uses when the
    caller names it (``unset_double``: UNSET_DOUBLE; ``unset_integer``:
    UNSET_INTEGER). A value this module cannot read as a finite number (True,
    text, NaN, infinity) counts as set: ibapi would still send it.
    """

    if value is None or value is False or _text(value) == "":
        return False
    number = _decimal(value)
    if number is None:
        return True
    if number == 0:
        return False
    if unset_double and abs(number) >= _UNSET_PRICE:
        return False
    return not (unset_integer and number == _UNSET_INTEGER)


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
    spreads, spreads_detail = _spreads_flag(env)
    try:
        caps: dict[str, Any] | None = {
            name: {"pct_of_net_liquidation": str(pct), "source": recorded}
            for name, (pct, recorded) in _risk_caps(env).items()
        }
        caps_error: str | None = None
    except OrderPolicyError as exc:
        caps, caps_error = None, exc.code
    return {
        "order_policy": ORDER_POLICY,
        "account_snapshot_dir": str(directory),
        "max_snapshot_age_seconds": max_age,
        "max_loss_pct_of_net_liquidation": max_loss,
        "close_reservations_path": str(_reservations_path(env)),
        # v3. The switch is on only with the owner decision link as its value.
        "allow_defined_risk_spreads": spreads,
        "allow_defined_risk_spreads_detail": spreads_detail,
        # Applied to opening orders while the switch is on.
        "spread_risk_caps": caps,
        "spread_risk_caps_error": caps_error,
        "leaps_min_days": LEAPS_MIN_DAYS,
        "open_risk_ledger_path": str(_reservations_path(env)),
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
    document: dict[str, Any] = {
        "schema": RESERVATIONS_SCHEMA,
        "updated_at": utc_now(),
        "reservations": entries,
    }
    # v3: the working opening orders live in the same file. Keep them as stored
    # (an invalid value too: it keeps refusing opening orders until it is repaired).
    stored = _stored_document(path)
    if OPEN_RISK_KEY in stored and stored[OPEN_RISK_KEY] != []:
        document[OPEN_RISK_KEY] = stored[OPEN_RISK_KEY]
    _write_document(path, document)


def _stored_document(path: Path) -> dict[str, Any]:
    """The JSON object stored in the reservation file; {} when missing, unreadable or not an object."""

    try:
        with open(path, "rb") as handle:
            raw = handle.read(RESERVATIONS_MAX_BYTES + 1)
        data = json.loads(raw) if len(raw) <= RESERVATIONS_MAX_BYTES else None
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_document(path: Path, document: dict[str, Any]) -> None:
    text = json.dumps(document, sort_keys=True, indent=2) + "\n"
    if len(text.encode("utf-8")) > RESERVATIONS_MAX_BYTES:
        # The readers refuse a larger file: writing it would block every order until a hand edit.
        raise OSError(f"{path.name} would exceed {RESERVATIONS_MAX_BYTES} bytes")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
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
    # v3 (spreads switch on). Opening orders: the max loss in USD, the ledger
    # entry to write and the unresolved ledger after pruning.
    max_loss: Decimal | None = None
    open_entry: dict[str, Any] | None = None
    open_ledger: dict[str, dict[str, Any]] | None = None
    # A closing combo: (reservation key, close decision) per leg.
    leg_closes: tuple[tuple[str, _Decision], ...] = ()
    notes: tuple[str, ...] = ()


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


# -- order policy v3: defined-risk vertical spreads ---------------------------
#
# Off unless NAUTILUS_ORDER_POLICY_ALLOW_DEFINED_RISK_SPREADS is
# "owner-decision:<Discord message link>": the value itself records the owner
# decision, so the switch cannot be on without its source. Any other value is
# off, and off is exactly the v2 behaviour above (every BAG is combo_refused).
#
# On, the gate also allows (LMT only; whatIf is checked the same way):
# * An opening vertical spread: a BAG with exactly two comboLegs, ratio 1:1,
#   one BUY and one SELL, both options of one underlying, one expiry, one
#   right (calls or puts), one multiplier and one trading class, in USD. The
#   caller passes the two IBKR-qualified leg contracts (``legs=``); each must
#   carry the conId of one comboLeg. A BAG names its legs by conId only, so
#   ``place_order`` asks IBKR for the contract of each leg (see "leg
#   qualification") and reads strikes, expiry and multiplier from the answer;
#   a supplied leg that differs from it refuses the order. The dry checks
#   (``check_order_policy``, ``preview_order``) have no client and read the
#   caller's legs.
#   Max loss, from the limit price (net price per share: + debit, - credit; a
#   SELL of the BAG reverses both legs and the sign):
#     debit spread  (the bought leg is worth more):
#         net debit * multiplier * quantity
#     credit spread (the sold leg is worth more):
#         (strike width - net credit) * multiplier * quantity
#   The net debit or credit must be above 0 and below the strike width.
#   Not yet supported, each refused by name: ratio and back spreads, calendars
#   and diagonals, three or more legs, legs on different underlyings, per-leg
#   prices, non-guaranteed combos (they can fill one leg alone), market
#   orders, hedge, algo, scale, attached, one-cancels-all and adjustable
#   orders, limit prices with more than 4 decimal places.
# * A closing vertical: the same BAG shape where the bought leg is held short
#   and the sold leg is held long, quantity at most both held quantities. Each
#   leg gets a close reservation (key "<clientId>:<orderId>/<conId>").
# Limits on every opening order (a single long option included), in percent
# of NetLiquidation, each reported with its source by ``order_policy_status``:
#   per order  max loss <= NAUTILUS_ORDER_POLICY_MAX_LOSS_PCT (2)
#   per name   open + working risk <= ..._NAME_CAP_SHORT_PCT (2) for expiries
#              under 365 days, and <= ..._NAME_CAP_LEAPS_PCT (6) over all expiries
#   total      open + working risk <= ..._MAX_TOTAL_RISK_PCT (10)
# A value set in the environment needs <NAME>_SOURCE (who decided it).
# Open risk is the largest loss at expiry of the held options of one
# underlying, one expiry and one trading class (cost from average_cost; payoff
# checked at 0 and at every strike), summed over those groups. Shares are not counted. A short call
# without a long call of the same expiry has no bound: opening orders in that
# name, and every opening order under the total cap, are refused while it is
# held. Working opening orders are kept in a ledger (the ``open_risk`` key of
# the close-reservation file) and count with their full max loss
# until IBKR reports them final and a later snapshot carries the fills, their
# expiry is more than one day in the past, or the owner releases them
# (``release-open-risk``). Option buys placed while the switch was off are not
# in the ledger: turn the switch on only while no order is working.
# No legging out. While options of one underlying, expiry and trading class
# include a short option, a close that sells a held long option (a single-leg
# sale, or a closing BAG) is refused when the options left could lose more at
# expiry than before the close, or without bound; only one such close may be
# unresolved at a time. Calls and puts are compared apart (a loss on one side
# may not hide an option left short on the other), and short shares of the
# underlying (an assigned short call) count as short calls of strike 0.
# A single-leg sale of a long option is also refused while an opening spread
# of that underlying and expiry is unresolved in the ledger: its sold option
# is not in the snapshot yet (``open_spread_working``). Close the spread as
# one BAG, or buy the short leg back first (a buy that closes a short is
# always allowed). A ledger that cannot be read refuses opening orders and the
# single-leg sale of a long option; a closing BAG and a buy that closes a
# short stay allowed.
# Do not turn the switch off while spreads are held: off is the v2 behaviour,
# which refuses every BAG and lets a single-leg sale of the long leg through.
# Close the spreads or buy the short options back first.
#
# Early assignment: the short leg of an American option can be assigned before
# expiry. The long leg still bounds the loss (exercise it, or close both), but
# the account holds shares until then. After the close on expiry day a short
# leg in the money beside a long leg out of the money is no longer bounded;
# the owner exit rule closes spreads before that.
#
# Known limits: as for closes, orders placed outside the gate are invisible to
# the ledger. Statuses seen before a restart are lost, so an opening order
# that ended then stays in the ledger (its risk may count twice) until its
# expiry passes or the owner releases it. An order IBKR sets Inactive (for
# example a rejected one) also stays counted until it is replaced under the
# same order id or released.

SPREADS_FLAG_ENV = "NAUTILUS_ORDER_POLICY_ALLOW_DEFINED_RISK_SPREADS"
SPREADS_FLAG_PREFIX = "owner-decision:"
SPREADS_FLAG_OFF = "off"
SPREADS_FLAG_INVALID = "off_invalid_value"
_DECISION_LINK_RE = re.compile(r"https://discord\.com/channels/[0-9]{5,25}/[0-9]{5,25}/[0-9]{5,25}")
NAME_CAP_SHORT_PCT_ENV = "NAUTILUS_ORDER_POLICY_NAME_CAP_SHORT_PCT"
NAME_CAP_LEAPS_PCT_ENV = "NAUTILUS_ORDER_POLICY_NAME_CAP_LEAPS_PCT"
TOTAL_RISK_PCT_ENV = "NAUTILUS_ORDER_POLICY_MAX_TOTAL_RISK_PCT"
# An expiry at least this many days away is a LEAPS (docs/vertex-orders.md).
LEAPS_MIN_DAYS = 365
# The working opening orders are one more key of the close-reservation file
# (AGENTS.md rule 13: no new JSON data file). The key is absent while there is
# none, so the file keeps its v2 shape; the v2 reader ignores the key.
OPEN_RISK_KEY = "open_risk"
OPEN_RISK_AUDIT_EVENT = "open_risk_released"
LEGS_NOT_QUALIFIED_NOTE = (
    "dry check: the leg contracts are the caller's; place_order asks IBKR for them before it sends"
)
EARLY_ASSIGNMENT_NOTE = (
    "the short leg can be assigned early: the long leg still bounds the loss, but the "
    "account holds shares until the long leg is exercised or the spread is closed"
)
RISK_UNBOUNDED = "unbounded"
RISK_UNKNOWN = "unknown"


@dataclass(frozen=True)
class _Cap:
    env: str
    default: Decimal
    ceiling: Decimal
    default_source: str


# The ceilings of the first three are the owner's standing rules: a higher
# value is a rule change and needs a code change, not an environment value.
_CAPS: dict[str, _Cap] = {
    "per_order": _Cap(
        MAX_LOSS_PCT_ENV,
        DEFAULT_MAX_LOSS_PCT,
        MAX_LOSS_PCT_CEILING,
        "owner rule 2026-11-04: max loss per order <= 2% of NetLiquidation",
    ),
    "name_short_dated": _Cap(
        NAME_CAP_SHORT_PCT_ENV,
        Decimal("2.0"),
        Decimal("2.0"),
        "owner standing rule (docs/vertex-orders.md): option risk per name <= 2% of "
        "NetLiquidation for expiries under 365 days",
    ),
    "name_all_expiries": _Cap(
        NAME_CAP_LEAPS_PCT_ENV,
        Decimal("6.0"),
        Decimal("6.0"),
        "owner standing rule (docs/vertex-orders.md): option risk per name <= 6% of "
        "NetLiquidation over all expiries (LEAPS cap)",
    ),
    "total_open_risk": _Cap(
        TOTAL_RISK_PCT_ENV,
        Decimal("10.0"),
        Decimal("100.0"),
        "default of card vertex-golive-spread-gate (2026-11-11): the allocation report's "
        "10% pause level; no owner standing rule sets a total",
    ),
}


def _spreads_flag(env: Mapping[str, str] | None = None) -> tuple[bool, str]:
    """(on, detail). On only for ``owner-decision:<Discord message link>``; detail is then the link."""

    source = os.environ if env is None else env
    raw = _text(source.get(SPREADS_FLAG_ENV))
    if not raw or raw.lower() in ("off", "false", "0", "no"):
        return False, SPREADS_FLAG_OFF
    link = raw[len(SPREADS_FLAG_PREFIX) :] if raw.startswith(SPREADS_FLAG_PREFIX) else ""
    if _DECISION_LINK_RE.fullmatch(link):
        return True, link
    return False, SPREADS_FLAG_INVALID


def _risk_caps(env: Mapping[str, str] | None = None) -> dict[str, tuple[Decimal, str]]:
    """Each cap as (percent of NLV, recorded source). An invalid setting refuses opening orders."""

    source = os.environ if env is None else env
    caps: dict[str, tuple[Decimal, str]] = {}
    for name, cap in _CAPS.items():
        raw = _text(source.get(cap.env))
        if not raw:
            caps[name] = (cap.default, cap.default_source)
            continue
        pct = _decimal(raw)
        if pct is None or pct <= 0 or pct > cap.ceiling:
            raise OrderPolicyError(
                "risk_config_invalid",
                f"{cap.env} must be a number above 0 and at most {cap.ceiling}",
            )
        recorded = " ".join(_text(source.get(f"{cap.env}_SOURCE")).split())[:200]
        if not recorded:
            raise OrderPolicyError(
                "risk_config_source_missing",
                f"{cap.env} is set without {cap.env}_SOURCE (who decided the value)",
            )
        caps[name] = (pct, recorded)
    return caps


def _expiry_date(text: Any) -> date | None:
    value = _text(text)
    if len(value) != 8 or not value.isdigit():
        return None
    try:
        return date(int(value[:4]), int(value[4:6]), int(value[6:]))
    except ValueError:
        return None


def _today(now: float | None = None) -> date:
    return datetime.fromtimestamp(time.time() if now is None else now, UTC).date()


def _usd(amount: Decimal) -> str:
    return f"{amount.normalize():f}"


# -- open risk: held options and working opening orders -----------------------


@dataclass(frozen=True)
class _Lot:
    """One held option contract line: signed size and what it cost."""

    right: str
    strike: Decimal
    units: Decimal  # contracts * multiplier; negative when short
    cost: Decimal  # USD paid; negative when received


def _worst_loss(lots: list[_Lot]) -> Decimal | None:
    """Largest loss at expiry of options of one underlying and one expiry; None when unbounded.

    The value at expiry is piecewise linear in the underlying price with a
    kink at each strike, so its minimum is at 0, at a strike, or does not
    exist (more calls sold than bought: the value falls without bound).
    """

    if sum((lot.units for lot in lots if lot.right == "C"), Decimal(0)) < 0:
        return None
    worst: Decimal | None = None
    for price in {Decimal(0)} | {lot.strike for lot in lots}:
        value = Decimal(0)
        for lot in lots:
            intrinsic = price - lot.strike if lot.right == "C" else lot.strike - price
            value += lot.units * max(intrinsic, Decimal(0))
        worst = value if worst is None else min(worst, value)
    paid = sum((lot.cost for lot in lots), Decimal(0))
    return max(paid - (worst or Decimal(0)), Decimal(0))


def _open_risk_groups(
    positions: list[dict[str, Any]],
) -> dict[tuple[str, str, str], Decimal | str]:
    """(symbol, expiry, trading class) -> worst loss in USD of the held options, or a RISK_ marker.

    The trading class is part of the group: an SPXW option does not cover an
    SPX option of the same date (they settle differently).

    RISK_UNKNOWN: a held option lacks its strike, right, expiry date, trading
    class, multiplier or a non-negative average_cost (per contract, as IBKR
    reports it). Without the trading class (no class sidecar for the snapshot)
    an SPXW option would be netted against an SPX option.
    """

    lots: dict[tuple[str, str, str], list[_Lot] | None] = {}
    for position in positions:
        held = _position_identity(position)
        quantity = _decimal(position.get("quantity")) or Decimal(0)
        if held["sec_type"] != "OPT" or quantity == 0:
            continue
        group = (held["symbol"], held["expiry"], held["trading_class"])
        cost_each = _decimal(position.get("average_cost"))
        if (
            not _identity_complete(held)
            or not held["trading_class"]
            or held["multiplier"] is None
            or _expiry_date(held["expiry"]) is None
            or cost_each is None
            or cost_each < 0
        ):
            lots[group] = None
            continue
        known = lots.setdefault(group, [])
        if known is not None:
            known.append(
                _Lot(held["right"], held["strike"], quantity * held["multiplier"], quantity * cost_each)
            )
    risks: dict[tuple[str, str, str], Decimal | str] = {}
    for group, known in lots.items():
        if known is None:
            risks[group] = RISK_UNKNOWN
            continue
        worst = _worst_loss(known)
        risks[group] = RISK_UNBOUNDED if worst is None else worst
    return risks


def _sum_risk(parts: list[Decimal | str]) -> Decimal | str:
    if RISK_UNKNOWN in parts:
        return RISK_UNKNOWN
    if RISK_UNBOUNDED in parts:
        return RISK_UNBOUNDED
    return sum((part for part in parts if isinstance(part, Decimal)), Decimal(0))


_OPEN_RISK_TEXT_FIELDS = (
    "key",
    "order_id",
    "client_id",
    "source",
    "symbol",
    "expiry",
    "signature",
    "description",
)


def _parse_open_risk(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    max_loss = _positive(raw.get("max_loss"))
    placed_at = raw.get("placed_at")
    if (
        max_loss is None
        or isinstance(placed_at, bool)
        or not isinstance(placed_at, (int, float))
        or not math.isfinite(placed_at)
        or not all(isinstance(raw.get(field), str) for field in _OPEN_RISK_TEXT_FIELDS)
        or not raw["key"]
        or not raw["symbol"]
        or not raw["signature"]
        or _expiry_date(raw["expiry"]) is None
    ):
        return None
    entry: dict[str, Any] = {field: raw[field] for field in _OPEN_RISK_TEXT_FIELDS}
    entry["max_loss"] = max_loss
    entry["placed_at"] = float(placed_at)
    return entry


def _read_open_risk(path: Path) -> dict[str, dict[str, Any]]:
    """Working opening orders by key, or raise ``OrderPolicyError`` (every opening order is refused)."""

    try:
        with open(path, "rb") as handle:
            raw = handle.read(RESERVATIONS_MAX_BYTES + 1)
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise OrderPolicyError(
            "open_risk_ledger_unreadable", f"{path.name}: {type(exc).__name__}"
        ) from exc
    invalid = OrderPolicyError(
        "open_risk_ledger_invalid", f"{path.name} holds no valid list of working opening orders"
    )
    if len(raw) > RESERVATIONS_MAX_BYTES:
        raise invalid
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise invalid from exc
    entries = data.get(OPEN_RISK_KEY, []) if isinstance(data, dict) else None
    if not isinstance(data, dict) or data.get("schema") != RESERVATIONS_SCHEMA or not isinstance(
        entries, list
    ):
        raise invalid
    ledger: dict[str, dict[str, Any]] = {}
    for raw_entry in entries:
        entry = _parse_open_risk(raw_entry)
        if entry is None or entry["key"] in ledger:
            raise invalid
        ledger[entry["key"]] = entry
    return ledger


def _open_risk_to_json(entry: dict[str, Any]) -> dict[str, Any]:
    return {**entry, "max_loss": str(entry["max_loss"])}


def _write_open_risk(path: Path, ledger: dict[str, dict[str, Any]]) -> None:
    entries = [_open_risk_to_json(entry) for _, entry in sorted(ledger.items())]
    # The close reservations in the same file stay exactly as stored.
    document = _stored_document(path) or {"schema": RESERVATIONS_SCHEMA, "reservations": []}
    document["updated_at"] = utc_now()
    document.pop(OPEN_RISK_KEY, None)
    if entries:
        document[OPEN_RISK_KEY] = entries
    _write_document(path, document)


def _open_risk_resolved(entry: dict[str, Any], snapshot: _Snapshot, today: date) -> bool:
    final = _final_outcome(entry)
    if final is not None and snapshot.captured_at - CLOSE_RESERVATION_SETTLE_SECONDS >= final[1]:
        return True  # this snapshot's positions carry every fill of the order
    expiry = _expiry_date(entry["expiry"])
    return expiry is not None and (today - expiry).days > 1


def _check_risk_caps(
    symbol: str,
    expiry: date,
    counted: Decimal,
    snapshot: _Snapshot,
    working: list[dict[str, Any]],
    caps: dict[str, tuple[Decimal, str]],
    today: date,
) -> None:
    """Refuse when the order's max loss plus open and working risk exceeds a name or total cap."""

    assert snapshot.net_liquidation is not None  # the caller refuses without it
    groups = _open_risk_groups(snapshot.positions)

    def short_dated(text: str) -> bool:
        when = _expiry_date(text)
        return when is None or (when - today).days < LEAPS_MIN_DAYS

    def in_scope(scope: str, name: str, text: str) -> bool:
        if scope == "total_open_risk":
            return True
        return name == symbol and (scope == "name_all_expiries" or short_dated(text))

    scopes = [
        ("name_all_expiries", "name", "name_risk_cap_exceeded"),
        ("total_open_risk", "total", "total_risk_cap_exceeded"),
    ]
    if (expiry - today).days < LEAPS_MIN_DAYS:
        scopes.insert(0, ("name_short_dated", "name", "name_short_dated_cap_exceeded"))
    for scope, label, code in scopes:
        parts: list[Decimal | str] = [
            risk for (name, text, _), risk in groups.items() if in_scope(scope, name, text)
        ]
        parts += [item["max_loss"] for item in working if in_scope(scope, item["symbol"], item["expiry"])]
        exposure = _sum_risk([*parts, counted])
        subject = symbol if label == "name" else "the account"
        if exposure == RISK_UNKNOWN:
            raise OrderPolicyError(
                f"{label}_open_risk_unavailable",
                f"a held option of {subject} lacks strike, right, expiry, trading class, multiplier "
                "or average_cost in the snapshot, so its open risk cannot be measured",
            )
        if exposure == RISK_UNBOUNDED:
            raise OrderPolicyError(
                f"{label}_open_risk_undefined",
                f"{subject} holds a short call without a long call of the same expiry: "
                "its open risk has no bound",
            )
        assert isinstance(exposure, Decimal)
        pct = caps[scope][0]
        if exposure > snapshot.net_liquidation * pct / 100:
            raise OrderPolicyError(
                code,
                f"open + working + this order's risk of {subject} would be {_usd(exposure)} USD, "
                f"above {pct}% of NetLiquidation ({scope})",
            )


def _checked_open(
    allowance: str,
    identity: dict[str, Any],
    action: str,
    quantity: Decimal,
    *,
    symbol: str,
    expiry_text: str,
    max_loss: Decimal,
    signature: str,
    description: str,
    key: str,
    snapshot: _Snapshot,
    env: Mapping[str, str] | None,
    now: float | None,
    notes: tuple[str, ...] = (),
) -> _Decision:
    """The decision for an opening order with a known max loss, after every cap (spreads flag on)."""

    caps = _risk_caps(env)
    if identity["currency"] != "USD":
        raise OrderPolicyError("currency_refused", "the max-loss cap is measured in USD NetLiquidation")
    if snapshot.net_liquidation is None:
        raise OrderPolicyError(
            "net_liquidation_unavailable", "the account snapshot has no NetLiquidation USD"
        )
    today = _today(now)
    expiry = _expiry_date(expiry_text)
    if expiry is None:
        raise OrderPolicyError("contract_incomplete", "the option expiry must be a YYYYMMDD date")
    if expiry < today:
        raise OrderPolicyError("expiry_passed", f"the option expiry {expiry_text} has passed")
    per_order = caps["per_order"][0]
    if max_loss > snapshot.net_liquidation * per_order / 100:
        raise OrderPolicyError(
            "max_loss_exceeded",
            f"max loss {_usd(max_loss)} USD exceeds {per_order}% of NetLiquidation",
        )
    stored = _read_open_risk(_reservations_path(env))
    live = {name: item for name, item in stored.items() if not _open_risk_resolved(item, snapshot, today)}
    previous = live.get(key)
    if previous is not None and previous["signature"] != signature:
        raise OrderPolicyError(
            "order_id_reused", "this order id holds a working opening order of other contracts"
        )
    closes = _read_reservations(_reservations_path(env))
    if any(
        (name == key or name.startswith(f"{key}/")) and not _reservation_resolved(item, snapshot)
        for name, item in closes.items()
    ):
        raise OrderPolicyError("order_id_reused", "this order id holds an unresolved close")
    # A modify keeps the larger max loss: IBKR may refuse it and leave the old order working.
    counted = max_loss if previous is None else max(max_loss, previous["max_loss"])
    working = [item for name, item in live.items() if name != key]
    _check_risk_caps(symbol, expiry, counted, snapshot, working, caps, today)
    entry = {
        "symbol": symbol,
        "expiry": expiry_text,
        "signature": signature,
        "description": _short(description, 120),
        "max_loss": counted,
    }
    return _Decision(
        allowance,
        identity,
        action,
        quantity,
        max_loss=max_loss,
        open_entry=entry,
        open_ledger=live,
        notes=notes,
    )


def _evaluate_long_option_open(
    order: Any,
    identity: dict[str, Any],
    quantity: Decimal,
    key: str,
    snapshot: _Snapshot,
    env: Mapping[str, str] | None,
    now: float | None,
) -> _Decision:
    """A single long option that passed ``_check_option_premium``, with the name and total caps."""

    limit = _positive(getattr(order, "lmtPrice", None))
    assert limit is not None and identity["multiplier"] is not None  # _check_option_premium
    # _check_option_premium (v2) reads an unreadable value as unset; ibapi would still send it.
    if _number_set(getattr(order, "discretionaryAmt", None)):
        raise OrderPolicyError("discretionary_refused", "discretionary amounts can fill above lmtPrice")
    if _number_set(getattr(order, "cashQty", None), unset_double=True):
        raise OrderPolicyError("cash_quantity_refused", "an option buy must size by totalQuantity")
    leg = identity["con_id"] or "/".join(
        str(identity[name]) for name in ("symbol", "expiry", "right", "strike", "trading_class")
    )
    return _checked_open(
        ALLOW_LONG_OPTION,
        identity,
        "BUY",
        quantity,
        symbol=identity["symbol"],
        expiry_text=identity["expiry"],
        max_loss=quantity * limit * identity["multiplier"],
        signature=f"BUY:{leg}",
        description=(
            f"{identity['symbol']} {identity['expiry']} {identity['right']} "
            f"{identity['strike']} long x{quantity}"
        ),
        key=key,
        snapshot=snapshot,
        env=env,
        now=now,
    )


def _check_single_close(
    identity: dict[str, Any],
    action: str,
    decision: _Decision,
    key: str,
    snapshot: _Snapshot,
    env: Mapping[str, str] | None,
    now: float | None,
) -> None:
    """Spreads switch on: a single-leg close may not reuse another order's id or raise the risk left."""

    live = decision.reservations or {}
    if any(name.startswith(f"{key}/") for name in live):
        raise OrderPolicyError("order_id_reused", "this order id holds an unresolved combo close")
    sale = identity["sec_type"] == "OPT" and action == "SELL"
    try:
        ledger = _read_open_risk(_reservations_path(env))
    except OrderPolicyError:
        if sale:
            # The sale of a long option needs the working opening spreads (see _check_close_risk).
            raise OrderPolicyError(
                "close_risk_unavailable",
                "the list of working opening orders is unreadable, so a working opening spread "
                "cannot be ruled out: repair it, or buy the short option back first",
            ) from None
        ledger = {}  # a ledger fault never blocks a close that buys a short back or closes shares
    today = _today(now)
    unresolved = {
        name: item for name, item in ledger.items() if not _open_risk_resolved(item, snapshot, today)
    }
    if key in unresolved:
        raise OrderPolicyError("order_id_reused", "this order id holds a working opening order")
    if identity["sec_type"] == "STK" and action == "SELL":
        _check_share_sale(identity, decision, snapshot)
    if sale:
        spreads = [item for item in unresolved.values() if "|SELL:" in item["signature"]]
        _check_close_risk([(identity, action, decision)], {key}, live, snapshot, spreads)


def _check_share_sale(identity: dict[str, Any], decision: _Decision, snapshot: _Snapshot) -> None:
    """Spreads switch on: shares that cover a short call are not sold.

    After an early exercise of the long call of a spread the account holds
    shares beside the short call. Per expiry and trading class, the short calls
    that no long call covers need that many shares; a sale may not leave fewer.
    """

    net: dict[tuple[str, str], Decimal] = {}
    for position in snapshot.positions:
        held = _position_identity(position)
        quantity = _decimal(position.get("quantity")) or Decimal(0)
        if (
            held["sec_type"] != "OPT"
            or held["symbol"] != identity["symbol"]
            or held["right"] == "P"
            or quantity == 0
        ):
            continue
        if held["multiplier"] is None:
            if quantity < 0:
                raise OrderPolicyError(
                    "close_risk_unavailable",
                    "a held short call of this underlying lacks its multiplier in the snapshot, so "
                    "the shares that cover it cannot be counted: buy the short call back first",
                )
            continue
        group = (held["expiry"], held["trading_class"])
        net[group] = net.get(group, Decimal(0)) + quantity * held["multiplier"]
    needed = sum((-size for size in net.values() if size < 0), Decimal(0))
    left = (decision.held_before or Decimal(0)) - decision.quantity
    if needed > 0 and left < needed:
        raise OrderPolicyError(
            "close_would_uncover_short",
            f"{needed} of the held shares cover short calls of this underlying and this sale would "
            f"leave {left} (no bound on the loss): buy the short calls back first",
        )


def _check_close_risk(
    closes: list[tuple[dict[str, Any], str, _Decision]],
    own_keys: set[str],
    live: dict[str, dict[str, Any]],
    snapshot: _Snapshot,
    working_spreads: list[dict[str, Any]] | None = None,
) -> None:
    """A close that sells a held long option may not raise the worst loss of what stays held.

    ``closes``: (order identity, action, close decision) per closed contract; the
    first one is the sale of the long. The group is every held option of that
    underlying, expiry and trading class, plus short shares of the underlying
    (an assigned short call), which count as short calls of strike 0.

    ``working_spreads`` (single-leg sales only): the unresolved opening spreads
    of the ledger. One of this underlying and expiry refuses the sale: its sold
    option is not in the snapshot yet, and the long sold here could be the
    option that covers it, or the option its fill nets against. A closing BAG
    needs no such check: it sells the long and buys the short back in one fill.

    Nothing more is checked while the group holds no short option and no short
    shares (nothing can be uncovered). Otherwise another unresolved close in
    the group refuses this one (the two could fill in any order), and the worst
    value at expiry may not be lower after this close than before it. Calls
    and puts are compared apart: a loss on the call side may not hide a put
    that this sale leaves short without its long put. A buy that closes a short
    never needs this check: it only raises the value at every price.
    """

    sold = closes[0][0]
    group: tuple[str, str, str] | None = None
    for position in snapshot.positions:
        held = _position_identity(position)
        if _same_contract(sold, held) and (_decimal(position.get("quantity")) or 0) > 0:
            group = (held["symbol"], held["expiry"], held["trading_class"])
            break
    if group is None:
        return  # no held long of this contract: _evaluate_close already refused the order
    group_expiry = _expiry_date(group[1])
    for item in working_spreads or []:
        if item["symbol"] == group[0] and (
            group_expiry is None or _expiry_date(item["expiry"]) in (None, group_expiry)
        ):
            raise OrderPolicyError(
                "open_spread_working",
                "an opening spread of this underlying and expiry is unresolved: this sale could "
                "leave its sold option uncovered. Wait for its final status and a later snapshot. "
                "If it ended before a node restart, release it: release-open-risk --key "
                f"{_short(item['key'], 48)}",
            )
    units: dict[tuple[str, Decimal, Decimal], Decimal] = {}
    readable, short_held = True, False
    for position in snapshot.positions:
        held = _position_identity(position)
        quantity = _decimal(position.get("quantity")) or Decimal(0)
        if held["sec_type"] == "STK" and held["symbol"] == group[0] and quantity < 0:
            # Short shares lose like short calls of strike 0, at every expiry.
            shares = ("C", Decimal(0), Decimal(1))
            units[shares] = units.get(shares, Decimal(0)) + quantity
            short_held = True
            continue
        if (
            held["sec_type"] != "OPT"
            or (held["symbol"], held["expiry"], held["trading_class"]) != group
            or quantity == 0
        ):
            continue
        short_held = short_held or quantity < 0
        if not _identity_complete(held) or held["multiplier"] is None:
            readable = False
            continue
        contract = (held["right"], held["strike"], held["multiplier"])
        units[contract] = units.get(contract, Decimal(0)) + quantity * held["multiplier"]
    if not short_held:
        return
    refusal = (
        "close the spread as one BAG combo, or buy the short option (or the short shares) back first"
    )
    if not readable:
        raise OrderPolicyError(
            "close_risk_unavailable",
            "a held option of this underlying and expiry lacks strike, right or multiplier in the "
            f"snapshot, so the risk left after this sale cannot be measured: {refusal}",
        )
    for name, item in live.items():
        other = item["identity"]
        if (
            name not in own_keys
            and other["sec_type"] == "OPT"
            and (other["symbol"], other["expiry"]) == group[:2]
        ):
            raise OrderPolicyError(
                "close_group_busy",
                "another close of this underlying and expiry is unresolved while a short option "
                f"is held (order id {_short(item['order_id'], 32)}): closes go one at a time",
            )
    before, after = dict(units), dict(units)
    for identity, action, decision in closes:
        matches = [
            contract
            for contract in units
            if contract[:2] == (identity["right"], identity["strike"])
            and identity["multiplier"] in (None, contract[2])
        ]
        if len(matches) != 1 or decision.held_before is None:
            raise OrderPolicyError(
                "close_risk_unavailable",
                f"the closed contract cannot be matched to one held option line: {refusal}",
            )
        sign = Decimal(1) if action == "SELL" else Decimal(-1)
        # held_before is the held size the close is measured from (fills the
        # snapshot does not show yet are already taken off it).
        before[matches[0]] = sign * decision.held_before * matches[0][2]
        after[matches[0]] = sign * (decision.held_before - decision.quantity) * matches[0][2]

    def worst(book: dict[tuple[str, Decimal, Decimal], Decimal], side: str) -> Decimal | None:
        return _worst_loss(
            [
                _Lot(right, strike, size, Decimal(0))
                for (right, strike, _), size in book.items()
                if size and right == side
            ]
        )

    for side in sorted({identity["right"] for identity, _, _ in closes}):
        worst_before, worst_after = worst(before, side), worst(after, side)
        if worst_after is None:
            raise OrderPolicyError(
                "close_would_uncover_short",
                "this sale would leave a held short call, or short shares, without a long call of "
                f"the same expiry (no bound on the loss): {refusal}",
            )
        if worst_before is not None and worst_after > worst_before:
            raise OrderPolicyError(
                "close_would_increase_risk",
                f"after this sale the {'calls' if side == 'C' else 'puts'} left could lose "
                f"{_usd(worst_after)} USD more than their value now, instead of "
                f"{_usd(worst_before)} USD: {refusal}",
            )
        net_before, net_after = (
            sum((size for (right, _, _), size in book.items() if right == side), Decimal(0))
            for book in (before, after)
        )
        if net_after < 0 and net_after < net_before:
            # Puts: one long put of a higher strike can be worth as much as two short puts, so
            # the worst value alone would let a long go (the 1:2 shape is refused as an opening order).
            raise OrderPolicyError(
                "close_would_uncover_short",
                f"this sale would leave more short {'calls' if side == 'C' else 'puts'} than long "
                f"ones of this expiry: {refusal}",
            )


# -- leg qualification: IBKR names the contract behind each conId -------------
#
# A BAG order names its legs by conId only. ``place_order`` asks IBKR for the
# contract of each supplied leg (reqContractDetails on the placing client) and
# the policy then reads strike, expiry, right, multiplier and trading class
# from IBKR's answer. A supplied leg that differs from IBKR's contract refuses
# the order. The request ids are high numbers that the gate's own wrappers
# take out of the client's callbacks, so the caller never sees them.

LEG_QUALIFY_TIMEOUT_ENV = "NAUTILUS_ORDER_POLICY_LEG_QUALIFY_TIMEOUT_SECONDS"
DEFAULT_LEG_QUALIFY_TIMEOUT_SECONDS = 10.0
_QUALIFY_REQUEST_BASE = 1_900_000_000
_QUALIFY_FIELDS = (
    "con_id",
    "sec_type",
    "symbol",
    "currency",
    "expiry",
    "right",
    "strike",
    "multiplier",
    "trading_class",
)
_qualify_lock = threading.Lock()
_qualify_requests: dict[int, dict[str, Any]] = {}
_qualify_count = 0  # guarded by _qualify_lock


def _qualify_state(request_id: Any) -> dict[str, Any] | None:
    with _qualify_lock:
        return _qualify_requests.get(request_id) if isinstance(request_id, int) else None


def _observe_contract_details(client: Any) -> bool:
    """Route the gate's own contract-details answers away from the client's callbacks."""

    target = getattr(client, "wrapper", None) or client

    def wrap(name: str, original: Callable[..., Any]) -> Callable[..., Any]:
        def callback(request_id: Any = None, *args: Any, **kwargs: Any) -> Any:
            state = _qualify_state(request_id)
            if state is None:
                return original(request_id, *args, **kwargs)
            if name == "contractDetails":
                state["contracts"].append(getattr(args[0], "contract", None) if args else None)
            else:
                if name == "error":
                    state["error"] = True
                state["done"].set()
            return None

        callback._arm_gate_qualifier = True  # type: ignore[attr-defined]
        return callback

    for name in ("contractDetails", "contractDetailsEnd", "error"):
        original = getattr(target, name, None)
        if not callable(original):
            return False
        if getattr(original, "_arm_gate_qualifier", False):
            continue
        try:
            setattr(target, name, wrap(name, original))
        except Exception:
            return False
    return True


def _leg_qualify_timeout(env: Mapping[str, str] | None = None) -> float:
    source = os.environ if env is None else env
    try:
        timeout = float(source.get(LEG_QUALIFY_TIMEOUT_ENV) or "")
    except ValueError:
        timeout = DEFAULT_LEG_QUALIFY_TIMEOUT_SECONDS
    if not math.isfinite(timeout) or timeout <= 0 or timeout > 60:
        timeout = DEFAULT_LEG_QUALIFY_TIMEOUT_SECONDS
    return timeout


def _qualify_combo_legs(client: Any, legs: Any, env: Mapping[str, str] | None = None) -> list[Any]:
    """IBKR's contract for each supplied leg, or raise ``OrderPolicyError``."""

    global _qualify_count
    if legs is None:
        raise OrderPolicyError(
            "combo_legs_unverified",
            "a combo order needs legs=[the IBKR-qualified option contract of each comboLeg]",
        )
    supplied = list(legs) if isinstance(legs, (list, tuple)) else []
    if len(supplied) != 2:
        raise OrderPolicyError(
            "combo_leg_mismatch", "exactly one leg contract per comboLeg is required"
        )
    request = getattr(client, "reqContractDetails", None)
    if not callable(request) or not _observe_contract_details(client):
        raise OrderPolicyError(
            "combo_legs_unqualified", "this IBKR client cannot answer reqContractDetails"
        )
    states: list[tuple[int, dict[str, Any]]] = []
    try:
        for leg in supplied:
            with _qualify_lock:
                _qualify_count = (_qualify_count + 1) % 50_000_000
                request_id = _QUALIFY_REQUEST_BASE + _qualify_count
                state: dict[str, Any] = {"contracts": [], "done": threading.Event(), "error": False}
                _qualify_requests[request_id] = state
            states.append((request_id, state))
            try:
                request(request_id, leg)
            except Exception as exc:
                raise OrderPolicyError(
                    "combo_legs_unqualified", f"reqContractDetails failed: {type(exc).__name__}"
                ) from exc
        deadline = time.monotonic() + _leg_qualify_timeout(env)
        for _, state in states:
            if not state["done"].wait(max(0.0, deadline - time.monotonic())):
                raise OrderPolicyError(
                    "combo_legs_unqualified", "IBKR did not answer reqContractDetails in time"
                )
    finally:
        with _qualify_lock:
            for request_id, _ in states:
                _qualify_requests.pop(request_id, None)
    answered: list[Any] = []
    for leg, (_, state) in zip(supplied, states):
        named = [_order_contract_identity(contract) for contract in state["contracts"] if contract is not None]
        # IBKR may list one contract once per exchange; every line must be the same contract.
        if (
            state["error"]
            or not named
            or len(named) != len(state["contracts"])
            or any(other[field] != named[0][field] for other in named for field in _QUALIFY_FIELDS)
        ):
            raise OrderPolicyError(
                "combo_legs_unqualified",
                "IBKR did not name exactly one contract for a supplied leg",
            )
        mine = _order_contract_identity(leg)
        theirs = named[0]
        for field in _QUALIFY_FIELDS:
            if mine[field] is None or mine[field] == "" or mine[field] != theirs[field]:
                raise OrderPolicyError(
                    "combo_leg_mismatch",
                    f"the supplied leg conId {_short(mine['con_id'], 16) or 'missing'} differs from "
                    f"IBKR's contract in {field}",
                )
        answered.append(state["contracts"][0])
    return answered


# -- vertical spreads ---------------------------------------------------------


@dataclass(frozen=True)
class _Vertical:
    """A two-leg vertical after the order action is applied to the comboLeg actions."""

    bag: dict[str, Any]
    buy: dict[str, Any]  # identity of the leg the order buys
    sell: dict[str, Any]  # identity of the leg the order sells
    action: str
    quantity: Decimal
    net_debit: Decimal  # limit per share the order may pay; negative: credit it must receive

    @property
    def width(self) -> Decimal:
        return abs(self.buy["strike"] - self.sell["strike"])

    @property
    def debit_type(self) -> bool:
        """The bought leg is worth more: lower-strike call or higher-strike put."""

        if self.buy["right"] == "C":
            return self.buy["strike"] < self.sell["strike"]
        return self.buy["strike"] > self.sell["strike"]


_LEGS_MUST_MATCH = (
    ("symbol", "combo_underlyings_differ", "both legs must be options of one underlying"),
    (
        "expiry",
        "combo_expiries_differ",
        "both legs must have one expiry (calendar and diagonal spreads are not yet supported)",
    ),
    ("right", "combo_rights_differ", "both legs must be calls or both puts"),
    ("multiplier", "combo_multipliers_differ", "both legs must have one multiplier"),
    ("trading_class", "combo_classes_differ", "both legs must have one trading class"),
    ("currency", "currency_refused", "both legs must trade in one currency"),
)


def _combo_leg_details(legs: Any) -> dict[int, dict[str, Any]]:
    if legs is None:
        raise OrderPolicyError(
            "combo_legs_unverified",
            "a combo order needs legs=[the IBKR-qualified option contract of each comboLeg]",
        )
    try:
        supplied = list(legs)
    except TypeError:
        supplied = []
    details: dict[int, dict[str, Any]] = {}
    for leg in supplied:
        leg_identity = _order_contract_identity(leg)
        con_id = leg_identity["con_id"]
        if con_id is None or con_id in details:
            raise OrderPolicyError(
                "combo_leg_mismatch", "every leg contract needs its own positive conId"
            )
        details[con_id] = leg_identity
    return details


def _check_combo_order_fields(order: Any) -> tuple[str, Decimal, Decimal]:
    """(action, quantity, limit) of a combo order, or raise ``OrderPolicyError``."""

    action = _text(getattr(order, "action", "")).upper()
    if action not in ("BUY", "SELL"):
        raise OrderPolicyError("action_refused", f"action {_short(action, 16) or 'missing'}")
    quantity = _positive(getattr(order, "totalQuantity", None))
    if quantity is None or quantity >= _UNSET_QUANTITY:
        raise OrderPolicyError("quantity_missing", "totalQuantity must be a positive number")
    if quantity != quantity.to_integral_value():
        raise OrderPolicyError("combo_quantity_not_whole", "a combo order needs a whole quantity")
    order_type = _text(getattr(order, "orderType", "")).upper()
    if order_type != "LMT":
        raise OrderPolicyError(
            "order_type_refused",
            f"a combo order must be a LMT order (got {_short(order_type, 16) or 'missing'})",
        )
    limit = _decimal(getattr(order, "lmtPrice", None))
    if limit is None or abs(limit) >= _UNSET_PRICE:
        raise OrderPolicyError("limit_price_missing", "a combo order needs a net lmtPrice")
    exponent = limit.as_tuple().exponent
    if not isinstance(exponent, int) or exponent < -4:
        raise OrderPolicyError(
            "limit_price_precision_refused", "lmtPrice may have at most 4 decimal places"
        )
    if _number_set(getattr(order, "discretionaryAmt", None)):
        raise OrderPolicyError("discretionary_refused", "discretionary amounts can fill above lmtPrice")
    if _number_set(getattr(order, "cashQty", None), unset_double=True):
        raise OrderPolicyError("cash_quantity_refused", "a combo order must size by totalQuantity")
    if getattr(order, "orderComboLegs", None):
        raise OrderPolicyError(
            "combo_leg_prices_refused", "per-leg prices are not supported: use one net lmtPrice"
        )
    routing = getattr(order, "smartComboRoutingParams", None) or []
    if not isinstance(routing, (list, tuple)):
        raise OrderPolicyError("combo_routing_params_refused", "smartComboRoutingParams must be a list")
    for param in routing:
        tag = _text(getattr(param, "tag", ""))
        if tag != "NonGuaranteed":
            raise OrderPolicyError(
                "combo_routing_params_refused", f"combo routing parameter {_short(tag, 32) or 'missing'}"
            )
        if _text(getattr(param, "value", "")) != "0":
            raise OrderPolicyError(
                "combo_non_guaranteed_refused",
                "a non-guaranteed combo can fill one leg alone and leave a naked short",
            )
    if _text(getattr(order, "hedgeType", "")):
        raise OrderPolicyError("hedge_order_refused", "hedge orders are not allowed")
    if _text(getattr(order, "algoStrategy", "")):
        raise OrderPolicyError("algo_order_refused", "algo orders are not supported for combos")
    # Order features that add orders or change the working price. ibapi leaves
    # the scale sizes at UNSET_INTEGER and the increment at UNSET_DOUBLE.
    for name in ("scaleInitLevelSize", "scaleSubsLevelSize", "scalePriceIncrement"):
        if _number_set(getattr(order, name, None), unset_double=True, unset_integer=True):
            raise OrderPolicyError("scale_order_refused", "scale orders are not supported for combos")
    if _number_set(getattr(order, "parentId", None)) or _text(getattr(order, "ocaGroup", "")):
        raise OrderPolicyError(
            "attached_order_refused", "attached (parentId) and one-cancels-all orders are not supported"
        )
    if _text(getattr(order, "adjustedOrderType", "")):
        raise OrderPolicyError("adjusted_order_refused", "adjustable orders are not supported")
    return action, quantity, limit


def _parse_vertical(contract: Any, order: Any, legs: Any) -> _Vertical:
    """The vertical a BAG order describes, or raise ``OrderPolicyError`` with the named reason."""

    bag = _order_contract_identity(contract)
    raw_combo = getattr(contract, "comboLegs", None)
    combo = list(raw_combo) if isinstance(raw_combo, (list, tuple)) else []
    if len(combo) != 2:
        raise OrderPolicyError(
            "combo_leg_count_refused",
            f"a combo must have exactly two legs (got {len(combo)}): only vertical spreads are supported",
        )
    details = _combo_leg_details(legs)
    sides: dict[int, str] = {}
    for combo_leg in combo:
        con_id = _con_id(getattr(combo_leg, "conId", None))
        if con_id is None or con_id not in details or con_id in sides:
            raise OrderPolicyError(
                "combo_leg_mismatch", "each comboLeg conId must match one supplied leg contract"
            )
        if _decimal(getattr(combo_leg, "ratio", None)) != 1:
            raise OrderPolicyError(
                "combo_ratio_refused", "every leg ratio must be 1 (ratio and back spreads are not supported)"
            )
        side = _text(getattr(combo_leg, "action", "")).upper()
        if side not in ("BUY", "SELL"):
            raise OrderPolicyError("combo_leg_action_refused", f"leg action {_short(side, 16) or 'missing'}")
        sides[con_id] = side
    if len(details) != 2:
        raise OrderPolicyError(
            "combo_leg_mismatch", "exactly one leg contract per comboLeg is required"
        )
    if sorted(sides.values()) != ["BUY", "SELL"]:
        raise OrderPolicyError(
            "combo_not_one_long_one_short",
            "a vertical spread buys one leg and sells the other (two sold legs are naked short)",
        )
    first, second = details.values()
    for leg in (first, second):
        if leg["sec_type"] != "OPT":
            raise OrderPolicyError("combo_leg_not_option", "both legs must be options (secType OPT)")
        if not _identity_complete(leg) or _expiry_date(leg["expiry"]) is None:
            raise OrderPolicyError(
                "contract_incomplete",
                "each leg must name symbol, a YYYYMMDD expiry, right and strike",
            )
        if leg["multiplier"] is None:
            raise OrderPolicyError("multiplier_missing", "each leg must name the contract multiplier")
        if not leg["trading_class"]:
            raise OrderPolicyError("combo_class_missing", "each leg must name its tradingClass")
    for field, code, detail in _LEGS_MUST_MATCH:
        if first[field] != second[field]:
            raise OrderPolicyError(code, detail)
    if bag["symbol"] != first["symbol"]:
        raise OrderPolicyError("combo_underlyings_differ", "the BAG symbol must be the legs' underlying")
    if bag["currency"] != "USD" or first["currency"] != "USD":
        raise OrderPolicyError("currency_refused", "the max-loss cap is measured in USD NetLiquidation")
    if first["strike"] == second["strike"]:
        raise OrderPolicyError("combo_strikes_equal", "the two legs must have different strikes")
    action, quantity, limit = _check_combo_order_fields(order)
    # A SELL of the BAG reverses each leg and the sign of the net price.
    if action == "SELL":
        sides = {con_id: "SELL" if side == "BUY" else "BUY" for con_id, side in sides.items()}
    bought = next(details[con_id] for con_id, side in sides.items() if side == "BUY")
    sold = next(details[con_id] for con_id, side in sides.items() if side == "SELL")
    return _Vertical(bag, bought, sold, action, quantity, limit if action == "BUY" else -limit)


def _vertical_max_loss(vertical: _Vertical) -> tuple[Decimal, str]:
    """(max loss in USD, "debit" or "credit") of an opening vertical at its limit price."""

    width = vertical.width
    if vertical.debit_type:
        kind, paid = "debit", vertical.net_debit
        per_share = paid
    else:
        kind, paid = "credit", -vertical.net_debit
        per_share = width - paid
    if not 0 < paid < width:
        raise OrderPolicyError(
            "spread_limit_implausible",
            f"this is a {kind} spread: its net {kind} must be above 0 and below the strike width "
            f"{_usd(width)} (BUY of a BAG: positive lmtPrice is a debit, negative a credit; "
            "SELL reverses the legs and the sign)",
        )
    return per_share * vertical.buy["multiplier"] * vertical.quantity, kind


def _evaluate_combo_close(
    vertical: _Vertical,
    key: str,
    snapshot: _Snapshot,
    env: Mapping[str, str] | None,
    now: float | None,
    legs_qualified: bool = False,
) -> _Decision:
    """Both legs reverse held positions: one close reservation per leg."""

    stored = _read_reservations(_reservations_path(env))
    plain = stored.get(key)
    if plain is not None and not _reservation_resolved(plain, snapshot):
        raise OrderPolicyError(
            "order_id_reused", "this order id holds an unresolved single-leg close"
        )
    try:
        working = _read_open_risk(_reservations_path(env)).get(key)
    except OrderPolicyError:
        working = None  # a ledger fault refuses opening orders; it never blocks a closing BAG
    if working is not None and not _open_risk_resolved(working, snapshot, _today(now)):
        raise OrderPolicyError("order_id_reused", "this order id holds a working opening order")
    closes = tuple(
        (
            f"{key}/{identity['con_id']}",
            _evaluate_close(identity, action, vertical.quantity, f"{key}/{identity['con_id']}", snapshot, env),
        )
        for identity, action in ((vertical.sell, "SELL"), (vertical.buy, "BUY"))
    )
    # Each leg pruned its own contract's final reservations; keep what both kept.
    live = {
        name: item
        for name, item in (closes[0][1].reservations or {}).items()
        if name in (closes[1][1].reservations or {})
    }
    _check_close_risk(
        [(vertical.sell, "SELL", closes[0][1]), (vertical.buy, "BUY", closes[1][1])],
        {name for name, _ in closes},
        live,
        snapshot,
    )
    return _Decision(
        ALLOW_SPREAD_CLOSE,
        vertical.bag,
        vertical.action,
        vertical.quantity,
        reservations=live,
        leg_closes=closes,
        notes=() if legs_qualified else (LEGS_NOT_QUALIFIED_NOTE,),
    )


def _evaluate_combo(
    contract: Any,
    order: Any,
    legs: Any,
    key: str,
    env: Mapping[str, str] | None,
    now: float | None,
    legs_qualified: bool = False,
) -> _Decision:
    """A BAG order with the spreads flag on: an opening or a closing vertical, or a named refusal."""

    vertical = _parse_vertical(contract, order, legs)
    snapshot = _load_snapshot(env, now)
    held_bought = _held_quantity(vertical.buy, snapshot.positions, verify=True)
    held_sold = _held_quantity(vertical.sell, snapshot.positions, verify=True)
    if held_bought < 0 and held_sold > 0:
        return _evaluate_combo_close(vertical, key, snapshot, env, now, legs_qualified)
    if held_bought < 0 or held_sold > 0:
        raise OrderPolicyError(
            "combo_mixed_open_close",
            "one leg would close a held position and the other open one (rolls are not yet supported)",
        )
    max_loss, kind = _vertical_max_loss(vertical)
    buy, sell = vertical.buy, vertical.sell
    return _checked_open(
        ALLOW_SPREAD_OPEN,
        vertical.bag,
        vertical.action,
        vertical.quantity,
        symbol=buy["symbol"],
        expiry_text=buy["expiry"],
        max_loss=max_loss,
        signature=f"BUY:{buy['con_id']}|SELL:{sell['con_id']}",
        description=(
            f"{buy['symbol']} {buy['expiry']} {buy['right']} {kind} vertical "
            f"buy {buy['strike']} sell {sell['strike']} x{vertical.quantity}"
        ),
        key=key,
        snapshot=snapshot,
        env=env,
        now=now,
        notes=(EARLY_ASSIGNMENT_NOTE,) if legs_qualified else (EARLY_ASSIGNMENT_NOTE, LEGS_NOT_QUALIFIED_NOTE),
    )


def _evaluate_order(
    contract: Any,
    order: Any,
    *,
    order_id: Any = None,
    client: Any = None,
    env: Mapping[str, str] | None = None,
    now: float | None = None,
    legs: Any = None,
    legs_qualified: bool = False,
) -> _Decision:
    """Return the decision for an order, or raise ``OrderPolicyError``.

    ``legs_qualified``: the legs are the contracts IBKR returned to this gate
    (``place_order``); otherwise they are the caller's (dry checks).
    """

    if contract is None or order is None:
        raise OrderPolicyError("order_missing", "contract and order are required")
    identity = _order_contract_identity(contract)
    sec_type = identity["sec_type"]
    spreads = _spreads_flag(env)[0]
    if spreads and not isinstance(getattr(order, "whatIf", False), bool):
        # ibapi sends a truthy text such as "0" as a live order; read as a preflight it would
        # skip the ledger entry or the close reservation. (Switch off: the v2 reading stays.)
        raise OrderPolicyError("what_if_not_boolean", "whatIf must be True or False")
    if (sec_type == "BAG" or getattr(contract, "comboLegs", None)) and not (
        spreads and sec_type == "BAG"
    ):
        raise OrderPolicyError("combo_refused", "BAG/combo orders are not allowed")
    if getattr(contract, "deltaNeutralContract", None) is not None or _text(
        getattr(order, "deltaNeutralOrderType", "")
    ):
        raise OrderPolicyError("delta_neutral_refused", "delta-neutral orders are not allowed")
    if sec_type == "BAG":
        return _evaluate_combo(
            contract, order, legs, _reservation_key(client, order_id), env, now, legs_qualified
        )
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
            decision = _evaluate_close(identity, action, quantity, key, snapshot, env)
            if spreads:
                _check_single_close(identity, action, decision, key, snapshot, env, now)
            return decision
        _check_option_premium(order, identity, quantity, snapshot, env)
        if spreads:
            return _evaluate_long_option_open(order, identity, quantity, key, snapshot, env, now)
        return _Decision(ALLOW_LONG_OPTION, identity, action, quantity)
    snapshot = _load_snapshot(env, now)
    decision = _evaluate_close(identity, action, quantity, key, snapshot, env)
    if spreads:
        _check_single_close(identity, action, decision, key, snapshot, env, now)
    return decision


def check_order_policy(
    contract: Any,
    order: Any,
    *,
    order_id: Any = None,
    client: Any = None,
    env: Mapping[str, str] | None = None,
    now: float | None = None,
    legs: Any = None,
) -> str:
    """Return why the order is allowed, or raise ``OrderPolicyError``.

    Returns ``ALLOW_LONG_OPTION`` or ``ALLOW_POSITION_CLOSE``; with the spreads
    switch on also ``ALLOW_SPREAD_OPEN`` or ``ALLOW_SPREAD_CLOSE`` (``legs``:
    the qualified option contract of each comboLeg). Read-only: it writes no
    reservation and no ledger entry (``place_order`` does).
    """

    with _policy_lock:
        return _evaluate_order(
            contract, order, order_id=order_id, client=client, env=env, now=now, legs=legs
        ).allowance


def preview_order(
    contract: Any,
    order: Any,
    *,
    legs: Any = None,
    order_id: Any = None,
    client: Any = None,
    env: Mapping[str, str] | None = None,
    now: float | None = None,
    status: ArmStatus | None = None,
) -> dict[str, Any]:
    """Dry transmit path: what ``place_order`` would decide for this order.

    Calls no IBKR API and writes no reservation or ledger entry.
    ``transmit_refusal`` is the named reason the order would not be sent: the
    policy refusal code, or ``engine_disarmed`` when the policy accepts and
    the node is not armed. Reading the arm state is the same read as
    ``arm_cli status``: with an active kill switch it clears the arm record.
    """

    arm = current_status() if status is None else status
    spreads, spreads_detail = _spreads_flag(env)
    result: dict[str, Any] = {
        "order_policy": ORDER_POLICY,
        "allow_defined_risk_spreads": spreads,
        "allow_defined_risk_spreads_detail": spreads_detail,
        "engine_state": arm.state,
        "engine_detail": arm.detail,
    }
    try:
        with _policy_lock:
            decision = _evaluate_order(
                contract, order, order_id=order_id, client=client, env=env, now=now, legs=legs
            )
    except Exception as raised:  # as in place_order: a policy fault refuses the order
        exc = (
            raised
            if isinstance(raised, OrderPolicyError)
            else OrderPolicyError("policy_error", type(raised).__name__)
        )
        return {
            **result,
            "policy_decision": "refused",
            "policy_refusal": exc.code,
            "policy_refusal_detail": _short(exc.detail, 280),
            "would_transmit": False,
            "transmit_refusal": exc.code,
        }
    return {
        **result,
        "policy_decision": "accepted",
        "allowance": decision.allowance,
        "max_loss_usd": None if decision.max_loss is None else _usd(decision.max_loss),
        "notes": list(decision.notes),
        "would_transmit": arm.armed,
        "transmit_refusal": None if arm.armed else DisarmedError.code,
    }


def _record_placement(
    decision: _Decision, key: str, order_id: Any, client: Any, order: Any, source: str
) -> None:
    """Persist the close reservation before placeOrder; an OSError refuses the order."""

    if decision.open_entry is not None and not bool(getattr(order, "whatIf", False)):
        # v3: a working opening order counts against the name and total caps.
        ledger = dict(decision.open_ledger or {})
        ledger[key] = {
            **decision.open_entry,
            "key": key,
            "order_id": _short(order_id, 32),
            "client_id": _client_key(client),
            "source": _short(source),
            "placed_at": time.time(),
        }
        _write_open_risk(_reservations_path(), ledger)
        _forget_outcome(client, order_id)
        return
    if decision.reservations is None:
        return  # an option buy reserves nothing
    if bool(getattr(order, "whatIf", False)):
        return  # a whatIf preflight creates no order
    reservations = dict(decision.reservations)
    # One reservation per close: the order itself, or each leg of a closing combo.
    for name, close in decision.leg_closes or ((key, decision),):
        reservations[name] = {
            "key": name,
            "order_id": _short(order_id, 32),
            "client_id": _client_key(client),
            "source": _short(source),
            "identity": close.identity,
            "action": close.action,
            "quantity": close.quantity,
            "held_before": close.held_before,
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


def place_order(
    client: Any, order_id: int, contract: Any, order: Any, *, source: str, legs: Any = None
) -> None:
    """The one IBKR ``placeOrder`` call site of the node (includes whatIf).

    The node must be armed and the order must pass ``check_order_policy``. A
    close is reserved in the reservation file before ``placeOrder`` is called.
    ``legs``: for a BAG order, the IBKR-qualified option contract of each
    comboLeg (see "order policy v3"). A spread is always one BAG order.
    """

    require_armed("placeOrder", source)
    with _policy_lock:
        try:
            _require_connected(client)
            _observe_order_status(client)
            qualified = False
            if _spreads_flag()[0] and _text(getattr(contract, "secType", "")).upper() == "BAG":
                # v3: the strikes, expiry and multiplier of a BAG come from IBKR, not from the
                # caller. The caller's legs are read first so a wrong shape gets its own reason.
                _parse_vertical(contract, order, legs)
                legs, qualified = _qualify_combo_legs(client, legs), True
            with _reservations_lock(_reservations_path()):
                # The lock wait can take seconds: a disarm or kill switch in it wins.
                status = current_status()
                if not status.armed:
                    raise OrderPolicyError("disarmed", f"node is disarmed ({status.detail})")
                decision = _evaluate_order(
                    contract,
                    order,
                    order_id=order_id,
                    client=client,
                    legs=legs,
                    legs_qualified=qualified,
                )
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


# -- owner tools for order policy v3 ------------------------------------------
#
# Run inside the nautilus-trader container:
#   python -m nautilus.arm_gate policy --json          the policy, the switch and the caps
#   python -m nautilus.arm_gate open-risk --json       working opening orders and open risk in % of NLV
#   python -m nautilus.arm_gate release-open-risk --key <clientId:orderId> \
#       --by <actor> --reason <text> --json
#   python -m nautilus.arm_gate preview --json < order.json
# ``preview`` is the dry transmit path: it reads {"contract", "order", "legs"}
# (IBKR field names; comboLegs inside the contract) from stdin, sends nothing
# and writes no reservation or ledger entry (it reads the arm state as
# ``arm_cli status`` does). Release a ledger entry only after checking in TWS that
# the order no longer works.


def open_risk_report(
    env: Mapping[str, str] | None = None, now: float | None = None
) -> dict[str, Any]:
    """Working opening orders (with their max loss in USD) and open option risk per name in percent of NLV.

    No account id and no balance is in the reply.
    """

    snapshot = _load_snapshot(env, now)
    today = _today(now)
    ledger = _read_open_risk(_reservations_path(env))
    working = [
        {**_open_risk_to_json(entry), "resolved": _open_risk_resolved(entry, snapshot, today)}
        for _, entry in sorted(ledger.items())
    ]
    nlv = snapshot.net_liquidation

    def share(risk: Decimal | str) -> str:
        if isinstance(risk, str) or nlv is None:
            return risk if isinstance(risk, str) else RISK_UNKNOWN
        return str((risk * 100 / nlv).quantize(Decimal("0.01")))

    groups = _open_risk_groups(snapshot.positions)
    live = [entry for entry in ledger.values() if not _open_risk_resolved(entry, snapshot, today)]
    names = sorted({name for name, _, _ in groups} | {entry["symbol"] for entry in live})
    per_name = {
        name: share(
            _sum_risk(
                [risk for (held, _, _), risk in groups.items() if held == name]
                + [entry["max_loss"] for entry in live if entry["symbol"] == name]
            )
        )
        for name in names
    }
    total = _sum_risk([*groups.values(), *(entry["max_loss"] for entry in live)])
    return {
        "net_liquidation_available": nlv is not None,
        "working_opening_orders": working,
        "open_plus_working_risk_pct_by_name": per_name,
        "open_plus_working_risk_pct_total": share(total),
    }


def release_open_risk(
    key: str, *, actor: str, reason: str, env: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Owner action: remove one working opening order from the ledger and audit it."""

    if not isinstance(actor, str) or not ACTOR_RE.fullmatch(actor):
        raise ArmRequestError("invalid_actor", "actor must match ^[A-Za-z0-9_.@-]{1,64}$")
    reason = " ".join((reason or "").split())
    if not REASON_MIN <= len(reason) <= REASON_MAX:
        raise ArmRequestError(
            "invalid_reason", f"reason must be {REASON_MIN}-{REASON_MAX} characters"
        )
    path = _reservations_path(env)
    with _policy_lock, _reservations_lock(_reservations_path(env)):
        ledger = _read_open_risk(path)
        entry = ledger.pop(key, None)
        if entry is None:
            raise ArmRequestError("unknown_open_risk", "no working opening order has this key")
        source = os.environ if env is None else env
        gate = ArmGate(
            source.get("NAUTILUS_ARMED_PATH") or DEFAULT_ARMED_PATH,
            "owner-tool",
            audit_path=source.get("NAUTILUS_ARM_AUDIT_PATH") or DEFAULT_AUDIT_PATH,
        )
        gate._audit(
            {
                "event": OPEN_RISK_AUDIT_EVENT,
                "audit_id": str(uuid.uuid4()),
                "actor": actor,
                "reason": reason,
                "policy": ORDER_POLICY,
                "key": entry["key"],
                "symbol": entry["symbol"],
                "description": entry["description"],
                "max_loss": str(entry["max_loss"]),
            }
        )
        _write_open_risk(path, ledger)
    return {"released": True, "key": entry["key"], "remaining": len(ledger)}


def _preview_object(raw: Any, nested: tuple[str, ...] = ()) -> SimpleNamespace:
    if not isinstance(raw, dict):
        raise ArmRequestError("invalid_preview", "contract, order and each leg must be JSON objects")
    fields = dict(raw)
    for name in nested:
        items = fields.get(name)
        if items is not None:
            if not isinstance(items, list):
                raise ArmRequestError("invalid_preview", f"{name} must be a list")
            fields[name] = [_preview_object(item) for item in items]
    return SimpleNamespace(**fields)


def preview_from_json(
    spec: Any, env: Mapping[str, str] | None = None, now: float | None = None
) -> dict[str, Any]:
    """``preview_order`` for a JSON order description, with the arm state read from disk."""

    if not isinstance(spec, dict):
        raise ArmRequestError("invalid_preview", "expected {contract, order, legs?}")
    legs = spec.get("legs")
    if legs is not None and not isinstance(legs, list):
        raise ArmRequestError("invalid_preview", "legs must be a list")
    source = dict(os.environ if env is None else env)
    return preview_order(
        _preview_object(spec.get("contract"), ("comboLegs",)),
        _preview_object(spec.get("order"), ("smartComboRoutingParams", "orderComboLegs")),
        legs=None if legs is None else [_preview_object(leg) for leg in legs],
        env=env,
        now=now,
        status=gate_from_env(source).status(),
    )


def main(argv: list[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m nautilus.arm_gate")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("reservations", help="list unresolved close reservations")
    release = sub.add_parser("release-close", help="release one close reservation (owner action)")
    sub.add_parser("policy", help="the order policy, the spreads switch and the caps")
    sub.add_parser("open-risk", help="working opening orders and open risk in percent of NLV")
    release_open = sub.add_parser(
        "release-open-risk", help="release one working opening order (owner action)"
    )
    sub.add_parser("preview", help="dry transmit path for a JSON order on stdin (sends nothing)")
    for command in (release, release_open):
        command.add_argument("--key", required=True)
        command.add_argument("--by", required=True)
        command.add_argument("--reason", required=True)
    for command in sub.choices.values():
        command.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "reservations":
            payload: dict[str, Any] = {"reservations": list_close_reservations(env)}
        elif args.command == "release-close":
            payload = release_close_reservation(args.key, actor=args.by, reason=args.reason, env=env)
        elif args.command == "policy":
            payload = order_policy_status(env)
        elif args.command == "open-risk":
            payload = open_risk_report(env)
        elif args.command == "release-open-risk":
            payload = release_open_risk(args.key, actor=args.by, reason=args.reason, env=env)
        else:
            try:
                spec = json.loads(sys.stdin.read(RESERVATIONS_MAX_BYTES))
            except ValueError as exc:
                raise ArmRequestError("invalid_preview", "stdin is not JSON") from exc
            payload = preview_from_json(spec, env)
        code = 0
    except (ArmRequestError, OrderPolicyError) as exc:
        payload, code = {"error": exc.code, "detail": exc.detail}, 2
    except Exception as exc:  # pragma: no cover - defensive
        payload, code = {"error": "unexpected", "detail": type(exc).__name__}, 3
    print(json.dumps(payload, sort_keys=True))
    return code


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
