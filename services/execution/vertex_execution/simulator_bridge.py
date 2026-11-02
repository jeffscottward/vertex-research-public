"""Explicit, durable paper transport; no broker, implicit startup, or model defaults.

The decoder is a trusted, pure qualification adapter, not a public schema codec.
Its inverse must reproduce the native-canonical admitted command exactly. The
journal remains the only reservation/settlement owner. Call initialize or restore
explicitly after claiming the journal; deliver advance results to owner.ingest,
then reconcile_order. A missing checkpoint/order never proves non-submission.
"""
from __future__ import annotations

from dataclasses import fields
from decimal import Decimal
from fractions import Fraction
import json
import re
from types import UnionType
from typing import Any, Callable, Literal, Protocol, Union, get_args, get_origin, get_type_hints

from .exact import decimal as journal_decimal, units
from .journal import Journal
from .ports import ExecutionError, MutationAuthorityPort, MutationGrant, PaperEvent, Reconciliation
from .simulator import (
    AcceptanceResolution, AdmittedLimits, BookCheckpoint, BookLevel,
    CancelAuthorization, DepthSnapshot, ExpirySchedule, LegFillTotal, OptionTerms,
    OrderCheckpoint, PaperSimulator, QualifiedInstrument, QualifiedLeg,
    SessionModel, SimulationBounds, SimulationEvent, SimulatorCheckpoint,
    SubmitCommand,
)


class QualifiedCommandDecoder(Protocol):
    """Pure, explicitly supplied qualified evidence; never resolves latest/IO.

    encode excludes only injected submission_key, payload_hash, submitted_at_ns.
    All qualifications, exact admitted limits, model IDs and immutable strategy
    identity must participate in the round trip through native ContractAuthority.
    """

    def decode(self, *, command_bytes: bytes, submission_key: str,
               payload_sha256: str, now_ns: int) -> SubmitCommand: ...
    def encode(self, command: SubmitCommand) -> bytes: ...


_RECORDS = {kind.__name__: kind for kind in (
    ExpirySchedule, OptionTerms, QualifiedInstrument, QualifiedLeg, AdmittedLimits,
    SubmitCommand, BookLevel, DepthSnapshot, AcceptanceResolution, LegFillTotal,
    SimulationEvent, OrderCheckpoint, BookCheckpoint, SimulatorCheckpoint,
)}
_MAX_BYTES = 16 * 1024 * 1024
_MAX_NODES = 500_000
_MAX_DEPTH = 32
_MAX_NS = (1 << 63) - 1
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_INTEGER = re.compile(r"(?:0|-?[1-9][0-9]{0,18})\Z")
_DECIMAL = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:E[+-]?[0-9]+)?\Z")
_STATUS = {"accepted": "submitted", "partial-fill": "partially-filled",
           "filled": "filled", "cancelled": "cancelled", "rejected": "rejected",
           "unknown": "unknown"}
_ENVELOPE_FIELDS = {"format", "scope", "provenanceId", "ownerEpoch",
                    "journalSequence", "journalHash", "generation", "simulator"}


def _require(condition: bool, reason: str) -> None:
    if condition is not True:
        raise ExecutionError(reason)


def _ns(value: int) -> None:
    _require(type(value) is int and 0 <= value <= _MAX_NS, "invalid-simulator-time")


def _hash(value: str) -> None:
    _require(type(value) is str and _HASH.fullmatch(value) is not None, "invalid-simulator-digest")


def _integer(value: str) -> int:
    _require(type(value) is str and _INTEGER.fullmatch(value) is not None,
             "invalid-checkpoint-integer")
    result = int(value)
    _require(-_MAX_NS <= result <= _MAX_NS, "checkpoint-integer-overflow")
    return result


def _number(value: Decimal) -> None:
    _require(type(value) is Decimal and value.is_finite(), "invalid-checkpoint-decimal")
    _, digits, exponent = value.as_tuple()
    _require(len(digits) <= 128 and -128 <= exponent <= 128 and abs(value.adjusted()) <= 128,
             "checkpoint-decimal-overflow")


def _fixed(value: Decimal | Fraction) -> str:
    """Journal decimal, exact or rejected; never context rounding or floats."""
    rational = Fraction(value)
    scaled, remainder = divmod(rational.numerator * 10 ** 18, rational.denominator)
    _require(remainder == 0, "fill-not-representable-at-journal-scale")
    return journal_decimal(scaled)


def _typed(value: Any, annotation: Any) -> bool:
    origin, arguments = get_origin(annotation), get_args(annotation)
    if origin in (Union, UnionType):
        return any(_typed(value, member) for member in arguments)
    if origin is Literal:
        return any(type(value) is type(member) and value == member for member in arguments)
    if origin is tuple:
        if type(value) is not tuple:
            return False
        if len(arguments) == 2 and arguments[1] is Ellipsis:
            return all(_typed(item, arguments[0]) for item in value)
        return len(value) == len(arguments) and all(_typed(v, t) for v, t in zip(value, arguments))
    return type(value) is annotation


class _CheckpointCodec:
    """Private allowlist, not a public contract replica; no pickle/import hooks."""

    def __init__(self) -> None:
        self.remaining = _MAX_NODES

    def _visit(self, depth: int) -> None:
        self.remaining -= 1
        _require(depth <= _MAX_DEPTH and self.remaining >= 0, "checkpoint-resource-bound")

    def pack(self, value: Any, depth: int = 0) -> Any:
        self._visit(depth)
        if value is None or type(value) is bool:
            return value
        if type(value) is str:
            _require(len(value) <= 4096, "checkpoint-string-bound")
            return value
        if type(value) is int:
            _require(-_MAX_NS <= value <= _MAX_NS, "checkpoint-integer-overflow")
            return {"integer": str(value)}
        if type(value) is Decimal:
            _number(value)
            return {"decimal": str(value)}
        if type(value) is tuple:
            _require(len(value) <= 65_536, "checkpoint-tuple-bound")
            return {"tuple": [self.pack(item, depth + 1) for item in value]}
        kind = type(value)
        _require(_RECORDS.get(kind.__name__) is kind, "checkpoint-record-not-allowlisted")
        hints = get_type_hints(kind)
        _require(all(_typed(getattr(value, field.name), hints[field.name]) for field in fields(kind)),
                 "checkpoint-field-type-mismatch")
        return {"record": kind.__name__, "fields": {
            field.name: self.pack(getattr(value, field.name), depth + 1) for field in fields(kind)
        }}

    def unpack(self, value: Any, depth: int = 0) -> Any:
        self._visit(depth)
        if value is None or type(value) is bool:
            return value
        if type(value) is str:
            _require(len(value) <= 4096, "checkpoint-string-bound")
            return value
        _require(type(value) is dict, "invalid-checkpoint-node")
        if set(value) == {"integer"}:
            return _integer(value["integer"])
        if set(value) == {"decimal"}:
            text = value["decimal"]
            _require(type(text) is str and len(text) <= 150 and _DECIMAL.fullmatch(text) is not None,
                     "invalid-checkpoint-decimal")
            result = Decimal(text)
            _number(result)
            _require(str(result) == text, "noncanonical-checkpoint-decimal")
            return result
        if set(value) == {"tuple"}:
            items = value["tuple"]
            _require(type(items) is list and len(items) <= 65_536, "checkpoint-tuple-bound")
            return tuple(self.unpack(item, depth + 1) for item in items)
        _require(set(value) == {"record", "fields"} and type(value["record"]) is str,
                 "invalid-checkpoint-record")
        kind = _RECORDS.get(value["record"])
        _require(kind is not None, "checkpoint-record-not-allowlisted")
        raw = value["fields"]
        _require(type(raw) is dict and set(raw) == {field.name for field in fields(kind)},
                 "checkpoint-field-set-mismatch")
        decoded = {name: self.unpack(item, depth + 1) for name, item in raw.items()}
        hints = get_type_hints(kind)
        _require(all(_typed(item, hints[name]) for name, item in decoded.items()),
                 "checkpoint-field-type-mismatch")
        return kind(**decoded)


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    _require(len(pairs) <= 64 and len(dict(pairs)) == len(pairs), "duplicate-or-unbounded-checkpoint-keys")
    return dict(pairs)


def _no_number(_: str) -> None:
    raise ExecutionError("untagged-checkpoint-number")


def _read_json(payload: bytes) -> dict[str, Any]:
    _require(type(payload) is bytes and 0 < len(payload) <= _MAX_BYTES, "checkpoint-byte-bound")
    # Bound nesting before json.loads, including malformed adversarial input.
    depth, quoted, escaped = 0, False, False
    for byte in payload:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            _require(depth <= _MAX_DEPTH * 3, "checkpoint-json-depth-bound")
        elif byte in (93, 125):
            depth -= 1
            _require(depth >= 0, "malformed-checkpoint-json")
    _require(not quoted and depth == 0, "malformed-checkpoint-json")
    value = json.loads(payload, object_pairs_hook=_object, parse_int=_no_number,
                       parse_float=_no_number, parse_constant=_no_number)
    _require(type(value) is dict, "invalid-checkpoint-envelope")
    return value


class DurablePaperTransport:
    simulation_only = True
    broker_submission_allowed = False

    def __init__(self, *, journal: Journal, models: tuple[SessionModel, ...],
                 provenance_id: str, decoder: QualifiedCommandDecoder,
                 mutation_authority: MutationAuthorityPort,
                 bounds: SimulationBounds = SimulationBounds()) -> None:
        # No table access or engine construction here, including on import.
        _require(type(models) is tuple and len(models) > 0 and all(type(m) is SessionModel for m in models),
                 "explicit-qualified-models-required")
        _require(type(provenance_id) is str and 0 < len(provenance_id) <= 256,
                 "explicit-simulator-provenance-required")
        _require(type(bounds) is SimulationBounds, "explicit-simulator-bounds-required")
        self.journal, self.models, self.provenance_id = journal, models, provenance_id
        self.decoder, self.mutation_authority, self.bounds = decoder, mutation_authority, bounds
        self._engine: PaperSimulator | None = None
        self._epoch: int | None = None
        self._generation = 0
        self._checkpoint_hash: str | None = None
        self._activation_sequence = -1
        self._failed = False
        self._attempted: set[str] = set()
        self._missing_dispatches: set[str] = set()

    def _scope(self) -> dict[str, str]:
        state = self.journal.state
        _require(state["environment"] == "paper", "paper-journal-required")
        return {name: state[name] for name in ("accountAlias", "environment", "simulatorId", "currency")}

    def _active(self) -> PaperSimulator:
        _require(not self._failed and self._engine is not None, "simulator-unavailable-retain-reservations")
        _require(self._epoch == self.journal.epoch, "stale-simulator-owner-epoch")
        return self._engine

    def initialize(self) -> None:
        """Explicit empty genesis, only before any dispatch; never overwrites."""
        with self.journal.mutex:
            _require(self._engine is None and not self._failed, "simulator-already-activated")
            _require(not any(order["dispatchMarked"] for order in self.journal.state["orders"].values()),
                     "existing-dispatch-requires-checkpoint-restore")
            try:
                with self.journal.transaction():
                    self._scope()
                    engine = PaperSimulator(self.models, provenance_id=self.provenance_id, bounds=self.bounds)
                    self.journal._db().execute("""CREATE TABLE IF NOT EXISTS paper_simulator_checkpoint (
                        slot INTEGER PRIMARY KEY CHECK(slot=1), generation INTEGER NOT NULL,
                        owner_epoch INTEGER NOT NULL, sha256 TEXT NOT NULL, payload BLOB NOT NULL)""")
                    _require(self.journal._db().execute("SELECT slot FROM paper_simulator_checkpoint").fetchone() is None,
                             "existing-simulator-checkpoint-requires-restore")
                    digest = self._persist(engine.snapshot(), first=True)
                self._engine, self._checkpoint_hash, self._generation = engine, digest, 1
                self._epoch, self._activation_sequence = self.journal.epoch, self.journal.sequence
            except BaseException:
                self._failed = True
                raise

    def restore(self) -> None:
        """Explicit existing-state recovery. Unseen dispatches remain UNKNOWN."""
        with self.journal.mutex:
            _require(self._engine is None and not self._failed, "simulator-already-activated")
            try:
                with self.journal.transaction():
                    row = self.journal._db().execute(
                        "SELECT generation,owner_epoch,sha256,payload FROM paper_simulator_checkpoint WHERE slot=1"
                    ).fetchone()
                    _require(row is not None, "missing-simulator-checkpoint-retain-reservations")
                    generation, epoch, digest, payload = row
                    value = _read_json(payload)
                    _hash(digest)
                    _require(self.journal.authority.encode(value) == payload and self.journal.authority.digest(value) == digest,
                             "simulator-checkpoint-integrity-mismatch")
                    _require(set(value) == _ENVELOPE_FIELDS and value["format"] == "vertex-paper-checkpoint-v1"
                             and value["scope"] == self._scope() and value["provenanceId"] == self.provenance_id,
                             "simulator-checkpoint-scope-mismatch")
                    _require(type(generation) is int and generation >= 1 and generation == _integer(value["generation"])
                             and type(epoch) is int and 0 <= epoch <= self.journal.epoch
                             and epoch == _integer(value["ownerEpoch"]), "simulator-checkpoint-epoch-mismatch")
                    sequence = _integer(value["journalSequence"])
                    _require(0 <= sequence <= self.journal.sequence, "simulator-checkpoint-ahead-of-journal")
                    _hash(value["journalHash"])
                    if sequence == 0:
                        _require(value["journalHash"] == "0" * 64 and epoch == 0, "invalid-simulator-genesis-anchor")
                    else:
                        anchor = self.journal._db().execute(
                            "SELECT event_hash,payload FROM events WHERE sequence=?", (sequence,)
                        ).fetchone()
                        _require(anchor is not None and anchor[0] == value["journalHash"],
                                 "simulator-checkpoint-journal-anchor-mismatch")
                        anchor_event = json.loads(anchor[1])
                        anchor_epoch = (anchor_event["data"]["epoch"] if anchor_event["kind"] == "epoch-claimed"
                                        else anchor_event["ownerEpoch"])
                        _require(anchor_epoch == str(epoch), "simulator-checkpoint-anchor-epoch-mismatch")
                    checkpoint = _CheckpointCodec().unpack(value["simulator"])
                    _require(type(checkpoint) is SimulatorCheckpoint, "invalid-simulator-checkpoint-type")
                    engine = PaperSimulator.restore(checkpoint, self.models,
                                                     expected_provenance_id=self.provenance_id, bounds=self.bounds)
                    self._audit(checkpoint)
                self._engine, self._checkpoint_hash, self._generation = engine, digest, generation
                self._epoch, self._activation_sequence = self.journal.epoch, self.journal.sequence
                present = {order.command.submission_key for order in checkpoint.orders}
                self._missing_dispatches = {key for key, order in self.journal.state["orders"].items()
                                            if order["dispatchMarked"] and key not in present}
            except BaseException:
                self._failed = True
                raise

    def _current_row(self) -> None:
        row = self.journal._db().execute(
            "SELECT generation,sha256 FROM paper_simulator_checkpoint WHERE slot=1"
        ).fetchone()
        _require(row == (self._generation, self._checkpoint_hash), "simulator-checkpoint-writer-conflict")

    def _persist(self, checkpoint: SimulatorCheckpoint, *, first: bool = False) -> str:
        generation = self._generation + 1
        _require(generation <= _MAX_NS, "simulator-checkpoint-generation-overflow")
        value = {"format": "vertex-paper-checkpoint-v1", "scope": self._scope(),
                 "provenanceId": self.provenance_id, "ownerEpoch": str(self.journal.epoch),
                 "journalSequence": str(self.journal.sequence), "journalHash": self.journal.event_hash,
                 "generation": str(generation), "simulator": _CheckpointCodec().pack(checkpoint)}
        payload = self.journal.authority.encode(value)
        _require(type(payload) is bytes and len(payload) <= _MAX_BYTES, "checkpoint-byte-bound")
        digest = self.journal.authority.digest(value)
        _hash(digest)
        if first:
            self.journal._db().execute("INSERT INTO paper_simulator_checkpoint VALUES (1,?,?,?,?)",
                                       (generation, self.journal.epoch, digest, payload))
        else:
            changed = self.journal._db().execute(
                "UPDATE paper_simulator_checkpoint SET generation=?,owner_epoch=?,sha256=?,payload=? "
                "WHERE slot=1 AND generation=? AND sha256=?",
                (generation, self.journal.epoch, digest, payload, self._generation, self._checkpoint_hash),
            ).rowcount
            _require(changed == 1, "simulator-checkpoint-writer-conflict")
        return digest

    def _batch_binding(self, order: dict[str, Any], command: SubmitCommand,
                       *, dispatch_epoch: str) -> None:
        """Bind every ordered, independently admitted leg; never net its caps."""
        authority = self.journal.authority
        records, evidence, batch = order["batchLegs"], order["batchEvidence"], order["batch"]
        _require(type(records) is list and 1 <= len(records) == len(command.legs) <= 8
                 and type(evidence) is dict and type(batch) is dict, "invalid-simulator-batch-evidence")
        legs = evidence.get("orderedLegs")
        _require(type(legs) is list and len(legs) == len(records)
                 and evidence.get("commandSha256") == authority.digest(order["command"])
                 and evidence.get("batchDigest", command.payload_hash) == command.payload_hash,
                 "simulator-batch-command-mismatch")
        names = ("intentArtifactId", "intentSha256", "admissionArtifactId", "admissionSha256",
                 "reviewArtifactId", "reviewSha256", "strategyArtifactId", "strategySha256")
        expected_batch = {"accountAlias": self._scope()["accountAlias"], "environment": "paper",
                          "idempotencyKey": batch["idempotencyKey"],
                          "legs": [{name: record[name] for name in names} for record in records]}
        _require(batch == expected_batch and authority.digest(batch) == order["batchDigest"] == command.payload_hash
                 and order["intent"] == records[0]["intent"] and order["admission"] == records[0]["admission"],
                 "simulator-batch-ordered-identity-mismatch")
        _require(len({record["intentSha256"] for record in records}) == len(records)
                 and len({record["admissionSha256"] for record in records}) == len(records),
                 "simulator-batch-duplicate-admission")
        totals = {"maximumLoss": 0, "maximumNotional": 0, "cashReservation": 0, "costReservation": 0}
        settlement_required = False
        common = ("accountAlias", "environment", "simulatorId", "streamId", "ownerEpoch", "actorId",
                  "strategyVersion", "policyVersion", "portfolioSnapshotId", "portfolioSequence", "reviewVersion")
        for record, bound, leg in zip(records, legs, command.legs, strict=True):
            intent, admission, review = record["intent"], record["admission"], record["review"]
            _require(authority.validate("TradeIntent", intent) is True
                     and authority.validate("PaperSimulationAdmission", admission) is True
                     and authority.validate("AcceptedReview", review) is True, "invalid-batch-admitted-artifact")
            _require(authority.digest(intent) == record["intentSha256"]
                     and authority.digest(admission) == record["admissionSha256"]
                     and authority.digest(review) == record["reviewSha256"],
                     "simulator-batch-artifact-digest-mismatch")
            _require(all(admission[name] == records[0]["admission"][name] for name in common)
                     and record["strategyArtifactId"] == order["strategyArtifactId"] == command.strategy_artifact_id
                     and record["strategySha256"] == order["strategySha256"]
                     and admission["policyVersion"] == command.policy_id
                     and admission["strategyVersion"] == intent["strategyVersion"] == command.strategy_artifact_id
                     and admission["accountAlias"] == intent["accountAlias"] == self._scope()["accountAlias"]
                     and admission["environment"] == intent["environment"] == "paper"
                     and admission["simulatorId"] == self._scope()["simulatorId"]
                     and admission["ownerEpoch"] == dispatch_epoch
                     and admission["intentId"] == intent["intentId"]
                     and admission["idempotencyKey"] == intent["idempotencyKey"],
                     "simulator-batch-admission-context-mismatch")
            _require(admission["intentSha256"] == admission["reviewedArtifactSha256"] == record["intentSha256"]
                     and review["artifactId"] == record["intentArtifactId"]
                     and review["artifactSha256"] == record["intentSha256"]
                     and review["reviewId"] == admission["reviewId"]
                     and review["reviewVersion"] == admission["reviewVersion"]
                     and review["actorId"] == admission["actorId"]
                     and review["accountAlias"] == admission["accountAlias"] and review["environment"] == "paper"
                     and review["strategyVersion"] == command.strategy_artifact_id
                     and review["policyVersion"] == command.policy_id
                     and review["decision"] == "accepted" and review["purpose"] == "paper-simulation",
                     "simulator-batch-review-binding-mismatch")
            for artifact, start in ((intent, "proposedAt"), (admission, "admittedAt"), (review, "reviewedAt")):
                _require(authority.epoch_ns(artifact[start]) <= command.submitted_at_ns
                         < authority.epoch_ns(artifact["expiresAt"])
                         and command.admitted_limits.valid_until_ns <= authority.epoch_ns(artifact["expiresAt"]),
                         "simulator-batch-artifact-expired")
            expected = {"intentSha256": record["intentSha256"], "admissionSha256": record["admissionSha256"],
                        "instrumentId": leg.instrument.instrument_id, "side": leg.side,
                        "quantity": _fixed(Fraction(command.maximum_quantity) * Fraction(leg.ratio))}
            _require(type(bound) is dict and all(bound.get(name) == value for name, value in expected.items())
                     and intent["instrumentId"] == expected["instrumentId"] and intent["side"] == expected["side"]
                     and intent["quantity"] == expected["quantity"], "simulator-batch-leg-order-or-quantity-mismatch")
            loss, notional = units(bound["maximumLoss"]), units(bound["maximumNotional"])
            cash, cost, settlement = (units(bound[name]) for name in
                                      ("cashReservation", "costReservation", "settlementCash"))
            _require(0 < loss <= min(units(admission["maximumLoss"]), units(intent["maxLossBudget"]))
                     and 0 < notional <= units(admission["maximumNotional"])
                     and 0 <= cost and 0 <= settlement and cost + settlement <= cash <= loss
                     and type(bound.get("settlementRequired")) is bool
                     and (settlement == 0 or bound["settlementRequired"]), "simulator-batch-leg-cap-mismatch")
            for name in totals:
                totals[name] += units(bound[name])
            settlement_required = settlement_required or bound["settlementRequired"]
        _require(totals["maximumLoss"] == units(order["maximumLoss"])
                 and totals["maximumNotional"] == units(order["maximumNotional"])
                 and totals["cashReservation"] == units(order["cashReserve"])
                 and Fraction(command.admitted_limits.maximum_total_fees) <= Fraction(totals["costReservation"], 10 ** 18)
                 and settlement_required == order["settlementRequired"], "simulator-batch-aggregate-cap-mismatch")

    def _binding(self, command: SubmitCommand, submission_key: str, payload_sha256: str,
                 command_bytes: bytes, now_ns: int) -> None:
        _require(type(command) is SubmitCommand and command.submission_key == submission_key
                 and command.payload_hash == payload_sha256 and command.submitted_at_ns == now_ns,
                 "decoded-command-identity-mismatch")
        order = self.journal.state["orders"].get(submission_key)
        _require(order is not None and order["dispatchMarked"] and order["payloadSha256"] == payload_sha256,
                 "simulator-requires-durable-dispatch")
        _require(type(command_bytes) is bytes and 0 < len(command_bytes) <= 2_000_000
                 and command_bytes == self.journal.authority.encode(order["command"])
                 and self.decoder.encode(command) == command_bytes, "decoded-command-roundtrip-mismatch")
        authority, admission = self.journal.authority, order["admission"]
        _require(authority.validate("PaperSimulationAdmission", admission) is True
                 and authority.validate("TradeIntent", order["intent"]) is True, "invalid-admitted-artifact")
        has_batch = any(name in order for name in ("batch", "batchDigest", "batchLegs", "batchEvidence"))
        _require(not has_batch or all(name in order for name in ("batch", "batchDigest", "batchLegs", "batchEvidence")),
                 "incomplete-simulator-batch-evidence")
        _require(has_batch or len(command.legs) == 1, "unreviewed-extra-simulator-legs")
        limits = command.admitted_limits
        _require(command.strategy_artifact_id == order["strategyArtifactId"] == admission["strategyVersion"]
                 and command.policy_id == admission["policyVersion"], "decoded-command-strategy-policy-mismatch")
        _require(command.maximum_quantity <= limits.maximum_quantity
                 and limits.maximum_gross_notional <= Decimal(order["maximumNotional"])
                 and (has_batch or limits.maximum_gross_notional <= Decimal(admission["maximumNotional"]))
                 and command.expires_at_ns <= limits.valid_until_ns <= int(order["riskValidUntilNs"])
                 and limits.valid_until_ns <= authority.epoch_ns(admission["expiresAt"])
                 and authority.epoch_ns(admission["admittedAt"]) <= now_ns < command.expires_at_ns,
                 "decoded-command-admitted-bound-mismatch")
        expected = {leg.instrument.instrument_id: {"side": leg.side,
                    "maximumQuantity": _fixed(Fraction(command.maximum_quantity) * Fraction(leg.ratio))}
                    for leg in command.legs}
        recorded = {key: {"side": leg["side"], "maximumQuantity": leg["maximumQuantity"]}
                    for key, leg in order["legs"].items()}
        _require(expected == recorded and all(leg.instrument.currency == self._scope()["currency"] for leg in command.legs),
                 "decoded-command-qualified-legs-mismatch")
        models = {model.model_id: model for model in self.models}
        for leg in command.legs:
            model = models.get(leg.model_id)
            _require(model is not None and (model.instrument_id, model.symbol, model.session_id) ==
                     (leg.instrument.instrument_id, leg.instrument.symbol, leg.instrument.session_id),
                     "decoded-command-model-mismatch")
        dispatch = self.journal._db().execute(
            "SELECT payload FROM events WHERE event_id=?", ("dispatch-" + submission_key,)
        ).fetchone()
        _require(dispatch is not None, "decoded-command-dispatch-time-mismatch")
        marker = json.loads(dispatch[0])
        _require(marker["kind"] == "dispatch" and marker["occurredNs"] == str(now_ns)
                 and marker["data"]["submissionKey"] == submission_key
                 and marker["data"]["payloadSha256"] == payload_sha256,
                 "decoded-command-dispatch-binding-mismatch")
        if has_batch:
            self._batch_binding(order, command, dispatch_epoch=marker["ownerEpoch"])

    def _translate(self, event: SimulationEvent, command: SubmitCommand) -> PaperEvent:
        _hash(event.event_id)
        _require(event.submission_key == command.submission_key and event.payload_hash == command.payload_hash
                 and event.status in _STATUS, "simulator-event-binding-mismatch")
        _ns(event.occurred_at_ns)
        instrument_id = quantity = cash_delta = fee = None
        _number(event.quantity)
        _number(event.fee)
        if event.quantity > 0:
            leg = next((leg for leg in command.legs if leg.leg_id == event.leg_id), None)
            _require(leg is not None and event.fill_id == "fill-" + event.event_id and event.price is not None
                     and event.price > 0 and event.fee >= 0 and event.status in {"partial-fill", "filled"},
                     "invalid-qualified-simulator-fill")
            _number(event.price)
            _require((leg.side == "buy" and event.price <= leg.limit_price)
                     or (leg.side == "sell" and event.price >= leg.limit_price), "simulator-fill-exceeds-limit")
            _require((Fraction(event.quantity) / Fraction(leg.instrument.lot_size)).denominator == 1,
                     "simulator-fill-off-lot")
            _require((Fraction(event.price) / Fraction(leg.instrument.tick_size)).denominator == 1
                     and event.settlement == leg.instrument.option, "simulator-fill-qualification-mismatch")
            gross = Fraction(event.quantity) * Fraction(event.price) * Fraction(leg.instrument.multiplier)
            model = next(model for model in self.models if model.model_id == leg.model_id)
            expected_fee = max(Fraction(model.minimum_fee), Fraction(event.quantity) * Fraction(model.fee_per_unit)
                               + gross * Fraction(model.fee_rate))
            _require(Fraction(event.fee) == expected_fee, "simulator-fill-fee-model-mismatch")
            instrument_id, quantity = leg.instrument.instrument_id, _fixed(event.quantity)
            cash_delta, fee = _fixed(-gross if leg.side == "buy" else gross), _fixed(event.fee)
            kind = "fill"
        else:
            _require(event.quantity == 0 and event.fee == 0 and event.fill_id is None
                     and event.leg_id is None and event.price is None and event.settlement is None,
                     "invalid-nonfill-simulator-event")
            kind = event.status if event.status in {"cancelled", "rejected", "unknown"} else "accepted"
        evidence = self.journal.authority.digest({"kind": "paper-simulator-event-v1",
            "provenanceId": self.provenance_id, "command": _CheckpointCodec().pack(command),
            "event": _CheckpointCodec().pack(event)})
        order_ref = "paper-" + self.journal.authority.digest({"provenanceId": self.provenance_id,
            "submissionKey": command.submission_key, "payloadSha256": command.payload_hash})
        return PaperEvent(event.event_id, event.submission_key, event.payload_hash, kind,
                          event.occurred_at_ns, order_ref, event.fill_id, instrument_id,
                          quantity, cash_delta, fee, evidence)

    def _audit(self, checkpoint: SimulatorCheckpoint) -> None:
        """Rebind restored commands and cumulative effects to the sealed journal."""
        for order in checkpoint.orders:
            command = order.command
            reserved = self.journal.state["orders"].get(command.submission_key)
            _require(reserved is not None, "checkpoint-order-not-in-journal")
            encoded = self.journal.authority.encode(reserved["command"])
            decoded = self.decoder.decode(command_bytes=encoded, submission_key=command.submission_key,
                                          payload_sha256=command.payload_hash, now_ns=command.submitted_at_ns)
            _require(decoded == command, "restored-qualified-command-changed")
            self._binding(command, command.submission_key, command.payload_hash, encoded, command.submitted_at_ns)
            totals = {leg.leg_id: [Fraction(0), Fraction(0), Fraction(0)] for leg in command.legs}
            seen: dict[str, dict[str, Any]] = {}
            previous_ns = command.submitted_at_ns
            final_seen = False
            for event in order.events:
                _require(not final_seen, "checkpoint-event-after-finality")
                _require(event.final is (event.status in {"filled", "cancelled", "rejected"}),
                         "checkpoint-event-finality-mismatch")
                final_seen = event.final
                _require(previous_ns <= event.occurred_at_ns <= checkpoint.now_ns, "checkpoint-event-clock-regression")
                previous_ns = event.occurred_at_ns
                translated = self._translate(event, command)
                _require(translated.event_id not in seen, "duplicate-checkpoint-event")
                seen[translated.event_id] = self._event_data(translated)
                if translated.kind == "fill":
                    leg = next(leg for leg in command.legs if leg.leg_id == event.leg_id)
                    total = totals[leg.leg_id]
                    total[0] += Fraction(event.quantity)
                    total[1] += Fraction(event.quantity) * Fraction(event.price) * Fraction(leg.instrument.multiplier)
                    total[2] += Fraction(event.fee)
                    _require(total[0] <= Fraction(command.maximum_quantity) * Fraction(leg.ratio),
                             "checkpoint-fill-over-qualified-quantity")
                _require(tuple(total.leg_id for total in event.cumulative_fills) == tuple(totals),
                         "checkpoint-cumulative-leg-mismatch")
                _require(all(tuple(Fraction(v) for v in (total.quantity, total.gross_notional, total.fees)) ==
                             tuple(totals[total.leg_id]) for total in event.cumulative_fills),
                         "checkpoint-cumulative-effects-mismatch")
                complete = all(totals[leg.leg_id][0] == Fraction(command.maximum_quantity) * Fraction(leg.ratio)
                               for leg in command.legs)
                _require((event.status == "filled") == complete, "checkpoint-filled-status-mismatch")
                _require(event.status != "rejected" or all(total[0] == 0 for total in totals.values()),
                         "checkpoint-rejection-after-fill")
            _require(sum(total[1] for total in totals.values()) <= Fraction(command.admitted_limits.maximum_gross_notional)
                     and sum(total[2] for total in totals.values()) <= Fraction(command.admitted_limits.maximum_total_fees),
                     "checkpoint-effects-over-admitted-caps")
            if "batchEvidence" in reserved:
                bounds = {bound["instrumentId"]: bound for bound in reserved["batchEvidence"]["orderedLegs"]}
                for leg in command.legs:
                    total, bound = totals[leg.leg_id], bounds[leg.instrument.instrument_id]
                    _require(total[1] <= Fraction(units(bound["maximumNotional"]), 10 ** 18)
                             and total[2] <= Fraction(units(bound["costReservation"]), 10 ** 18),
                             "checkpoint-effects-over-independent-leg-cap")
            _require(all(seen.get(identifier) == data for identifier, data in reserved["events"].items()),
                     "checkpoint-behind-journal-effects")

    @staticmethod
    def _event_data(event: PaperEvent) -> dict[str, Any]:
        return {"submissionKey": event.submission_key, "payloadSha256": event.payload_sha256,
                "eventId": event.event_id, "eventKind": event.kind, "occurredNs": str(event.occurred_ns),
                "orderRef": event.order_ref, "fillId": event.fill_id, "instrumentId": event.instrument_id,
                "quantity": event.quantity, "cashDelta": event.cash_delta, "fee": event.fee,
                "evidenceSha256": event.evidence_sha256}

    def _mutate(self, operation: Callable[[PaperSimulator], tuple[SimulationEvent, ...]]) -> tuple[PaperEvent, ...]:
        try:
            engine = self._active()
            with self.journal.transaction():
                self._current_row()
                _require(not self._missing_dispatches, "unseen-dispatch-blocks-simulation-retain-reservations")
                staged = PaperSimulator.restore(engine.snapshot(), self.models,
                                                expected_provenance_id=self.provenance_id, bounds=self.bounds)
                emitted = operation(staged)
                checkpoint = staged.snapshot()
                self._audit(checkpoint)
                commands = {order.command.submission_key: order.command for order in checkpoint.orders}
                events = tuple(self._translate(event, commands[event.submission_key]) for event in emitted)
                digest = self._persist(checkpoint)
            self._engine, self._checkpoint_hash = staged, digest
            self._generation += 1
            return events
        except BaseException:
            # Even uncertain COMMIT success cannot license a retry or release.
            self._failed = True
            raise

    def submit(self, submission_key: str, payload_sha256: str, command_bytes: bytes,
               *, now_ns: int) -> tuple[PaperEvent, ...]:
        with self.journal.mutex:
            _ns(now_ns)
            _hash(payload_sha256)
            engine = self._active()
            _require(submission_key not in self._attempted and engine.reconcile(submission_key).payload_hash is None,
                     "simulator-resubmit-forbidden")
            self._attempted.add(submission_key)

            def dispatch(staged: PaperSimulator) -> tuple[SimulationEvent, ...]:
                record = self.journal._db().execute(
                    "SELECT sequence,payload FROM events WHERE event_id=?", ("dispatch-" + submission_key,)
                ).fetchone()
                _require(record is not None and record[0] > self._activation_sequence
                         and json.loads(record[1])["ownerEpoch"] == str(self._epoch),
                         "preexisting-or-unproven-dispatch-no-resubmit")
                command = self.decoder.decode(command_bytes=command_bytes, submission_key=submission_key,
                                              payload_sha256=payload_sha256, now_ns=now_ns)
                self._binding(command, submission_key, payload_sha256, command_bytes, now_ns)
                return staged.submit(command)

            return self._mutate(dispatch)

    def cancel(self, submission_key: str, grant: MutationGrant,
               *, now_ns: int) -> tuple[PaperEvent, ...]:
        with self.journal.mutex:
            _ns(now_ns)
            engine = self._active()
            scope = self._scope()
            _require(type(grant) is MutationGrant and grant.action == "cancel-simulation"
                     and grant.submission_key == submission_key and grant.owner_epoch == self._epoch
                     and grant.account_alias == scope["accountAlias"] and grant.environment == "paper"
                     and grant.issued_ns <= now_ns < grant.expires_ns
                     and self.mutation_authority.verify(grant, now_ns=now_ns) is True,
                     "simulator-cancel-grant-invalid")
            _hash(grant.evidence_sha256)
            command = next((order.command for order in engine.snapshot().orders
                            if order.command.submission_key == submission_key), None)
            _require(command is not None, "unknown-simulator-order-retain-reservations")

            def request(staged: PaperSimulator) -> tuple[SimulationEvent, ...]:
                marker = self.journal._db().execute(
                    "SELECT payload FROM events WHERE event_id=?", ("cancel-" + grant.grant_id,)
                ).fetchone()
                _require(marker is not None, "simulator-cancel-requires-durable-marker")
                data = json.loads(marker[0])
                _require(data["kind"] == "cancel-request" and data["ownerEpoch"] == str(self._epoch)
                         and data["data"]["submissionKey"] == submission_key
                         and data["data"]["payloadSha256"] == command.payload_hash
                         and data["data"]["grantId"] == grant.grant_id,
                         "simulator-cancel-marker-mismatch")
                return staged.cancel(submission_key, CancelAuthorization(submission_key, command.payload_hash,
                                     command.policy_id, grant.expires_ns, True), now_ns)

            return self._mutate(request)

    def advance(self, market_events: tuple[DepthSnapshot | AcceptanceResolution, ...],
                now_ns: int) -> tuple[PaperEvent, ...]:
        """Off-tick worker entry point. Persist before returning any effects."""
        with self.journal.mutex:
            _ns(now_ns)
            _require(type(market_events) is tuple and len(market_events) <= self.bounds.max_market_events
                     and all(type(event) in (DepthSnapshot, AcceptanceResolution) for event in market_events),
                     "bounded-qualified-market-events-required")
            return self._mutate(lambda staged: staged.advance(market_events, now_ns))

    def reconcile(self, submission_key: str, payload_sha256: str,
                  *, now_ns: int) -> Reconciliation:
        with self.journal.mutex:
            _ns(now_ns)
            _hash(payload_sha256)
            if self._failed or self._engine is None:
                return self._unknown(submission_key, payload_sha256, "unavailable-checkpoint")
            try:
                engine = self._active()
                with self.journal.transaction():
                    self._current_row()
                    result = engine.reconcile(submission_key)
                    if result.payload_hash is None:
                        return self._unknown(submission_key, payload_sha256, "unseen-dispatch")
                    _require(result.payload_hash == payload_sha256, "reconciliation-payload-mismatch")
                    checkpoint = engine.snapshot()
                    self._audit(checkpoint)
                    order = next(order for order in checkpoint.orders if order.command.submission_key == submission_key)
                    events = tuple(self._translate(event, order.command) for event in result.events)
                    _require(all(event.occurred_ns <= now_ns for event in events), "future-reconciliation-evidence")
                    legs = {leg.leg_id: leg for leg in order.command.legs}
                    totals = tuple((legs[total.leg_id].instrument.instrument_id, _fixed(total.quantity))
                                   for total in result.cumulative_fills)
                    finality = result.final and result.authoritative and result.status in {"filled", "cancelled", "rejected"}
                    evidence = self.journal.authority.digest({"kind": "paper-simulator-reconciliation-v1",
                        "checkpointSha256": self._checkpoint_hash, "submissionKey": submission_key,
                        "payloadSha256": payload_sha256, "stateHash": result.state_hash})
                    return Reconciliation(submission_key, payload_sha256, events, _STATUS[result.status], totals,
                                          result.final, finality, tuple(event.event_id for event in events) if finality else (),
                                          evidence, True)
            except BaseException:
                self._failed = True
                raise

    def _unknown(self, submission_key: str, payload_sha256: str, reason: str) -> Reconciliation:
        evidence = self.journal.authority.digest({"kind": "paper-simulator-unknown-v1", "scope": self._scope(),
            "provenanceId": self.provenance_id, "submissionKey": submission_key,
            "payloadSha256": payload_sha256, "reason": reason})
        return Reconciliation(submission_key, payload_sha256, (), "unknown", (), False, False, (), evidence, False)
