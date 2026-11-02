"""Pure selected evidence for the native risk kernel and paper simulator.

Private configuration contracts below are exact-version local DTOs, NOT public
schemas. Public artifacts are validated exclusively by ContractAuthority. Every
private input is a digest-pinned member of an authenticated RuntimePolicySelection
(or an exact source pin inside such a member), loaded from SealedArtifactCache.
No input contains an accepted qualification/permission boolean. Entitlement is
derived from the current authenticated rights snapshot, and reviews are checked
against the current authenticated admission snapshot, never a cache fallback.

HostProviderObservation is canonical original source evidence: quote records use
kind/provider/instrumentId/quoteId/currency/snapshotId/dataVintageId/sourceAtNs/
receivedAtNs/bid/ask/bidSize/askSize; Greek records use kind plus every native
GreekObservation field except source_hash. Other provider wire formats require an
explicit adapter and are unavailable here; a matching hash alone is insufficient.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from hashlib import sha256
import json
from typing import Any, Mapping, Protocol

from vertex_execution.exact import decimal, units
from vertex_execution.native_risk import QualifiedRiskInputs
from vertex_execution.ports import AdmissionAuthorityPort, Artifact, ContractAuthority, ExecutionError
from vertex_execution.simulator import AdmittedLimits, QualifiedInstrument, QualifiedLeg, SessionModel, SimulationBounds, SubmitCommand

from .commands import (
    canonical_object, command_recipe, exact_decimal, exact_ns,
    record_from_payload, record_payload,
)


class SealedInputs(Protocol):
    def get(self, artifact_id: str) -> Artifact: ...
    def private(self, artifact_id: str, sha256: str) -> dict[str, Any]: ...
    def snapshot(self) -> Mapping[str, Artifact]: ...


class CurrentRights(Protocol):
    account_alias: str
    environment: str
    def record(self, policy_id: str, version: str, now_ns: int) -> Mapping[str, Any]: ...
    def permits(self, policy_id: str, version: str, use: str, now_ns: int) -> bool: ...
    def current(self) -> str: ...


class LedgerHead(Protocol):
    """In-memory Journal attributes, read while the owner holds its mutex."""
    state: Mapping[str, Any]
    sequence: int
    event_hash: str


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ExecutionError(reason)


def _object(value: Any, names: str) -> dict[str, Any]:
    _require(type(value) is dict and set(value) == set(names.split()), "host-evidence-private-field-set-mismatch")
    return value


def _hash(value: Any) -> str:
    _require(type(value) is str and len(value) == 64 and all(c in "0123456789abcdef" for c in value),
             "host-evidence-digest-required")
    return value


def _array(value: Any, maximum: int = 512) -> list[Any]:
    _require(type(value) is list and len(value) <= maximum, "host-evidence-array-bound")
    return value


def _multiply(left: str, right: str) -> str:
    product = units(left) * units(right)
    _require(product % 10**18 == 0, "host-evidence-inexact-position-valuation")
    return decimal(product // 10**18)


@dataclass(frozen=True)
class _Resolution:
    inputs: QualifiedRiskInputs
    input_bytes: bytes
    proof_bytes: bytes
    ledger_sha256: str
    ledger_sequence: int
    state_sha256: str
    now_ns: int
    rights_sha256: str
    admissions: tuple[bytes, ...]
    intents: tuple[bytes, ...]
    reviews: tuple[bytes, ...]
    rights_expiry_ns: int


class QualifiedEvidencePort:
    """Concrete, bounded in-memory implementation of native_risk's port.

    Supported: explicitly calibrated DAY limit equity/non-0DTE option legs,
    independently reviewed batches of 1..8 legs, exact existing sleeve lots.
    Unsupported 0DTE gates, tick/rate/minimum-fee models, unpinned provider formats
    and changed position lineage fail unavailable; nothing silently defaults.
    """

    def __init__(self, *, authority: ContractAuthority, cache: SealedInputs,
                 selection: Mapping[str, Any], rights: CurrentRights,
                 ledger_head: LedgerHead, admission_authority: AdmissionAuthorityPort) -> None:
        self._authority, self._cache = authority, cache
        self._rights, self._ledger, self._admission = rights, ledger_head, admission_authority
        self._last: _Resolution | None = None
        self._position_origin: tuple[int, str, str] | None = None
        self._position_basis: str | None = None
        try:
            self._selection = json.loads(authority.encode(selection))
            _require(authority.validate("RuntimePolicySelection", self._selection) is True,
                     "host-evidence-selection-invalid")
            body = {k: v for k, v in self._selection.items() if k != "selectionSha256"}
            _require(authority.digest(body) == self._selection["selectionSha256"], "host-evidence-selection-hash-mismatch")
            _require(self._selection["environment"] == "paper" and self._selection["simulation"] is not None,
                     "host-evidence-paper-configuration-unavailable")
            self._policy_pins = {p["role"]: p for p in self._selection["policies"]}
            _require(len(self._policy_pins) == len(self._selection["policies"]), "host-evidence-ambiguous-policy")
            _require(self._selection["review"] is not None and "review" in self._policy_pins,
                     "host-evidence-selected-review-policy-unavailable")
            review_config = self._selection["review"]
            review_pin = self._policy_pins["review"]
            _require((review_config["policyId"], review_config["version"])
                     == (review_pin["policyId"], review_pin["version"]), "host-evidence-selected-review-policy-mismatch")
            self._policy = self._policy_config("risk", "HostKernelPolicy")
            _object(self._policy, "policy_id version account_alias environment currency valid_from_ns valid_until_ns "
                    "strategy_artifact approved_instruments approved_calendars approved_entitlement_policy_ids "
                    "approved_greek_model_ids quote_max_age_ns greek_max_age_ns journal_max_age_ns entitlement_max_age_ns "
                    "maximum_spread_bps minimum_displayed_quantity maximum_participation_bps costs portfolio_limits sleeve_limits zero_dte")
            _require(self._policy["zero_dte"] is None, "host-evidence-zero-dte-unavailable")
            pin = self._policy_pins["risk"]
            _require((self._policy["policy_id"], self._policy["version"], self._policy["account_alias"], self._policy["environment"])
                     == (pin["policyId"], pin["version"], self._selection["accountAlias"], "paper"),
                     "host-evidence-policy-scope-mismatch")
            costs = self._policy_config("cost", "HostCostPolicy")
            _object(costs, "model_id fee_per_unit fee_per_leg slippage_bps currency_quantum latency_model_id submission_latency_ns maximum_receive_delay_ns")
            _require(costs == self._policy["costs"], "host-evidence-cost-policy-mismatch")
            calendar_policy = self._policy_config("calendar", "HostCalendarPolicy")
            _object(calendar_policy, "approved_calendars")
            _require(calendar_policy["approved_calendars"] == self._policy["approved_calendars"],
                     "host-evidence-calendar-policy-mismatch")
            self._rights_policy = self._policy_config("licensing-rights", "HostMarketRightsPolicy")
            _object(self._rights_policy, "policyId version accountAlias environment allowedUses providers instrumentIds")
            rights_pin = self._policy_pins["licensing-rights"]
            _require((self._rights_policy["policyId"], self._rights_policy["version"], self._rights_policy["accountAlias"], self._rights_policy["environment"])
                     == (rights_pin["policyId"], rights_pin["version"], self._selection["accountAlias"], "paper")
                     and rights_pin["policyId"] in self._policy["approved_entitlement_policy_ids"],
                     "host-evidence-rights-policy-scope-mismatch")
            for name in ("allowedUses", "providers", "instrumentIds"):
                values = _array(self._rights_policy[name])
                _require(values and all(type(v) is str for v in values) and len(set(values)) == len(values),
                         "host-evidence-rights-scope-required")
            _require("paper-simulation" in self._rights_policy["allowedUses"], "host-evidence-paper-rights-unavailable")
            self._calendars = self._indexed("calendar", "HostExchangeCalendar", lambda v: v["calendar_id"])
            self._instruments = self._indexed("instrument", "HostInstrumentEvidence", lambda v: v["kernel"]["instrument_id"])
            self._quotes = self._indexed("quote", "HostQuoteEvidence", lambda v: self._public(v["quote"], "Quote")["instrumentId"])
            self._greeks = self._indexed("greeks", "HostGreekEvidence", lambda v: v["observation"]["instrument_id"])
            self._simulation = self._one("simulation-engine", "HostSimulationConfiguration")
            _object(self._simulation, "simulatorId costModelId latencyModelId models bounds maximumTotalFees maximumLeggingQuantity maximumLeggingNs")
            bounds = _object(self._simulation["bounds"], "max_legs max_book_levels max_market_events max_orders max_books max_models max_events max_order_events")
            self._bounds = SimulationBounds(**bounds)
            simulation_pin = next(v["artifact"] for v in self._selection["artifacts"]
                                  if v["role"] == "simulation-engine" and v["artifact"]["contractName"] == "HostSimulationConfiguration")
            self._provenance_id = "host-simulation-" + simulation_pin["artifactSha256"]
            _require((self._simulation["simulatorId"], self._simulation["costModelId"], self._simulation["latencyModelId"])
                     == (self._selection["simulation"]["simulatorId"], costs["model_id"], costs["latency_model_id"]),
                     "host-evidence-simulation-model-mismatch")
            self._models = tuple(record_from_payload(SessionModel, v) for v in _array(self._simulation["models"]))
            _require(self._models and len({m.model_id for m in self._models}) == len(self._models)
                     and len({m.instrument_id for m in self._models}) == len(self._models), "host-evidence-ambiguous-session-model")
            _require(len(self._models) <= self._bounds.max_models, "host-evidence-simulator-model-bound")
            self._model_by_instrument = {m.instrument_id: m for m in self._models}
            _require(units(self._simulation["maximumTotalFees"]) >= 0
                     and units(self._simulation["maximumLeggingQuantity"]) >= 0, "host-evidence-negative-command-limits")
            exact_ns(self._simulation["maximumLeggingNs"])
            self._positions = self._one("broker-observation", "HostPositionEvidence")
            _object(self._positions, "ledgerSequence ledgerSha256 ledgerStateSha256 positions")
            exact_ns(self._positions["ledgerSequence"])
            _hash(self._positions["ledgerSha256"])
            _hash(self._positions["ledgerStateSha256"])
            _array(self._positions["positions"])
            self._check_metadata()
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise ExecutionError("host-evidence-selected-configuration-unavailable") from error

    @property
    def models(self) -> tuple[SessionModel, ...]:
        return self._models

    def session_models(self) -> tuple[SessionModel, ...]:
        return self._models

    def simulation_bounds(self) -> SimulationBounds:
        return self._bounds

    @property
    def simulator_id(self) -> str:
        return self._simulation["simulatorId"]

    @property
    def provenance_id(self) -> str:
        return self._provenance_id

    def _private(self, pin: Mapping[str, Any], contract: str) -> dict[str, Any]:
        _object(pin, "artifactId artifactSha256 contractName schemaVersion")
        _require(pin["contractName"] == contract and pin["schemaVersion"] == "1.0.0",
                 "host-evidence-private-contract-unavailable")
        value = self._cache.private(pin["artifactId"], _hash(pin["artifactSha256"]))
        encoded = self._authority.encode(value)
        _require(type(value) is dict and 0 < len(encoded) <= 2_000_000
                 and sha256(encoded).hexdigest() == pin["artifactSha256"], "host-evidence-private-pin-mismatch")
        return json.loads(encoded)

    def _public(self, pin: Mapping[str, Any], contract: str) -> dict[str, Any]:
        _object(pin, "artifactId artifactSha256 contractName schemaVersion")
        _require(pin["contractName"] == contract and pin["schemaVersion"] == "1.0.0", "host-evidence-public-contract-unavailable")
        artifact = self._cache.get(pin["artifactId"])
        _require((artifact.artifact_id, artifact.contract_name, artifact.sha256)
                 == (pin["artifactId"], contract, pin["artifactSha256"])
                 and sha256(artifact.canonical_bytes).hexdigest() == artifact.sha256, "host-evidence-public-pin-mismatch")
        value = canonical_object(self._authority, artifact.canonical_bytes)
        _require(self._authority.validate(contract, value) is True, "host-evidence-public-artifact-invalid")
        return value

    def _cached(self, artifact_id: str, contract: str) -> dict[str, Any]:
        artifact = self._cache.get(artifact_id)
        return self._public({"artifactId": artifact_id, "artifactSha256": artifact.sha256,
                             "contractName": contract, "schemaVersion": "1.0.0"}, contract)

    def _policy_config(self, role: str, contract: str) -> dict[str, Any]:
        _require(role in self._policy_pins, "host-evidence-selected-policy-unavailable")
        return self._private(self._policy_pins[role]["artifact"], contract)

    def _values(self, role: str, contract: str) -> list[dict[str, Any]]:
        pins = [v["artifact"] for v in self._selection["artifacts"] if v["role"] == role
                and v["artifact"]["contractName"] == contract]
        _require(bool(pins), "host-evidence-selected-artifact-unavailable")
        return [self._private(pin, contract) for pin in pins]

    def _one(self, role: str, contract: str) -> dict[str, Any]:
        values = self._values(role, contract)
        _require(len(values) == 1, "host-evidence-ambiguous-configuration")
        return values[0]

    def _indexed(self, role: str, contract: str, identity: Any) -> dict[str, dict[str, Any]]:
        values = self._values(role, contract)
        result = {identity(value): value for value in values}
        _require(len(result) == len(values), "host-evidence-ambiguous-instrument-evidence")
        return result

    def _instant(self, calendar: Mapping[str, Any], day: str, minute: int) -> int:
        _require(type(minute) is int and 0 <= minute < 1440, "host-evidence-calendar-minute-invalid")
        days = (date.fromisoformat(day) - date(1970, 1, 1)).days
        values = []
        for interval in calendar["intervals"]:
            candidate = (days * 86400 + minute * 60 - interval["offset_seconds"]) * 1_000_000_000
            if exact_ns(interval["start_ns"]) <= candidate < exact_ns(interval["end_ns"]):
                values.append(candidate)
        _require(len(values) == 1, "host-evidence-calendar-offset-unavailable")
        return values[0]

    def _check_metadata(self) -> None:
        for calendar in self._calendars.values():
            _object(calendar, "calendar_id version timezone tzdb_version intervals sessions")
            intervals = _array(calendar["intervals"])
            sessions = _array(calendar["sessions"])
            _require(bool(intervals) and bool(sessions), "host-evidence-calendar-unavailable")
            previous = None
            for interval in intervals:
                _object(interval, "start_ns end_ns offset_seconds")
                start, end = exact_ns(interval["start_ns"]), exact_ns(interval["end_ns"])
                offset = interval["offset_seconds"]
                _require(start < end and (previous is None or start == previous)
                         and type(offset) is int and -50400 <= offset <= 50400, "host-evidence-calendar-interval-invalid")
                previous = end
            previous_day = None
            for session in sessions:
                _object(session, "date tradable open_minute close_minute entry_cutoff_minute")
                day = date.fromisoformat(session["date"])
                _require(previous_day is None or previous_day < day, "host-evidence-calendar-session-order")
                _require(type(session["tradable"]) is bool, "host-evidence-calendar-session-invalid")
                previous_day = day
                for key in ("open_minute", "entry_cutoff_minute", "close_minute"):
                    self._instant(calendar, session["date"], session[key])
                _require(session["open_minute"] < session["entry_cutoff_minute"] <= session["close_minute"],
                         "host-evidence-calendar-session-invalid")
        for item in self._instruments.values():
            _object(item, "kernel symbol sessionId schedule")
            instrument = item["kernel"]
            _object(instrument, "instrument_id qualification_id metadata_version corporate_action_version exchange currency underlying_id kind "
                    "multiplier tick_size quantity_step calendar_id valid_from_ns valid_until_ns option")
            calendar = self._calendars[instrument["calendar_id"]]
            _require(any(b == {"id": instrument["instrument_id"], "sha256": self._authority.digest(instrument)}
                         for b in self._policy["approved_instruments"]), "host-evidence-unapproved-instrument")
            _require(any(b == {"id": calendar["calendar_id"], "sha256": self._authority.digest(calendar)}
                         for b in self._policy["approved_calendars"]), "host-evidence-unapproved-calendar")
            self._simulator_instrument(item)
            model = self._model_by_instrument[instrument["instrument_id"]]
            sessions = [s for s in calendar["sessions"] if s["date"] == item["sessionId"]]
            _require(len(sessions) == 1 and sessions[0]["tradable"] is True, "host-evidence-model-session-unavailable")
            session = sessions[0]
            costs = self._policy["costs"]
            _require((model.symbol, model.session_id, model.session_open_ns, model.session_close_ns)
                     == (item["symbol"], item["sessionId"], self._instant(calendar, session["date"], session["open_minute"]),
                         self._instant(calendar, session["date"], session["close_minute"])), "host-evidence-model-calendar-mismatch")
            _require(model.submit_latency_ns == exact_ns(costs["submission_latency_ns"])
                     and model.quote_ttl_ns <= exact_ns(self._policy["quote_max_age_ns"])
                     and model.fee_per_unit == exact_decimal(costs["fee_per_unit"])
                     and model.slippage_bps == exact_decimal(costs["slippage_bps"])
                     and units(record_payload(model)["participation_rate"]) * 10000 <= units(self._policy["maximum_participation_bps"]),
                     "host-evidence-model-cost-or-liquidity-mismatch")
            _require(model.fee_rate == 0 and model.minimum_fee == 0 and model.slippage_ticks == 0,
                     "host-evidence-fee-or-tick-model-unavailable")

    def _simulator_instrument(self, item: Mapping[str, Any]) -> QualifiedInstrument:
        native, schedule = item["kernel"], item["schedule"]
        option = native["option"]
        if native["kind"] == "equity":
            _require(option is None and schedule is None, "host-evidence-equity-terms-mismatch")
            terms = None
        else:
            _require(native["kind"] == "option" and option is not None and schedule is not None,
                     "host-evidence-instrument-kind-unavailable")
            _object(option, "right strike expiry_date expiry_minute expiry_ns exercise_style settlement settlement_policy_id settlement_at_ns exercise_fee_per_contract")
            calendar = self._calendars[native["calendar_id"]]
            _require((schedule["calendar_id"], schedule["calendar_version"], schedule["exchange_timezone"],
                      schedule["effective_expiry_date"], schedule["fixing_ns"], schedule["settlement_due_ns"])
                     == (calendar["calendar_id"], calendar["version"], calendar["timezone"],
                         option["expiry_date"], option["expiry_ns"], option["settlement_at_ns"])
                     and self._instant(calendar, option["expiry_date"], option["expiry_minute"]) == exact_ns(option["expiry_ns"]),
                     "host-evidence-option-calendar-mismatch")
            offsets = [i["offset_seconds"] for i in calendar["intervals"]
                       if exact_ns(i["start_ns"]) <= exact_ns(option["expiry_ns"]) < exact_ns(i["end_ns"])]
            _require(offsets == [schedule["fixing_utc_offset_seconds"]], "host-evidence-fixing-offset-mismatch")
            terms = {"underlying_id": native["underlying_id"], "right": option["right"], "strike": option["strike"],
                     "exercise_style": option["exercise_style"], "settlement_kind": option["settlement"],
                     "deliverable_units": native["multiplier"], "schedule": schedule}
        return record_from_payload(QualifiedInstrument, {
            "instrument_id": native["instrument_id"], "symbol": item["symbol"], "session_id": item["sessionId"],
            "currency": native["currency"], "kind": native["kind"], "tick_size": native["tick_size"],
            "lot_size": native["quantity_step"], "multiplier": native["multiplier"],
            "qualification_id": native["qualification_id"], "option": terms,
        })

    def _current_rights(self, now_ns: int) -> Mapping[str, Any]:
        policy = self._rights_policy
        _require((self._rights.account_alias, self._rights.environment) == (policy["accountAlias"], "paper"),
                 "host-evidence-current-rights-scope-mismatch")
        for use in ("read", "derive"):
            _require(self._rights.permits(policy["policyId"], policy["version"], use, now_ns) is True,
                     "host-evidence-current-rights-unavailable")
        record = self._rights.record(policy["policyId"], policy["version"], now_ns)
        _require(record["policyId"] == policy["policyId"] and record["version"] == policy["version"]
                 and record["status"] == "granted" and type(record["checked_ns"]) is int
                 and type(record["expires_ns"]) is int and record["checked_ns"] <= now_ns < record["expires_ns"],
                 "host-evidence-current-rights-unavailable")
        return record

    def _source(self, pin: Mapping[str, Any], expected: Mapping[str, Any], digest: str) -> None:
        _require(pin["artifactSha256"] == digest, "host-evidence-original-source-hash-mismatch")
        original = self._private(pin, "HostProviderObservation")
        _require(original == expected, "host-evidence-original-source-values-mismatch")

    def _quote(self, instrument_id: str, now_ns: int) -> dict[str, Any]:
        item = self._quotes[instrument_id]
        _object(item, "quote sourceArtifact dataVintageId sessionId")
        quote = self._public(item["quote"], "Quote")
        source, entitlement = quote["source"], quote["source"]["entitlement"]
        identity = source["identity"]
        policy = self._rights_policy
        _require(quote["instrumentId"] == instrument_id and identity["provider"] in policy["providers"]
                 and instrument_id in policy["instrumentIds"] and entitlement["policyId"] == policy["policyId"]
                 and source["dataKind"] == "real" and source["syntheticReason"] is None
                 and source["freshness"]["status"] == "fresh" and entitlement["status"] == "granted",
                 "host-evidence-quote-scope-or-source-unavailable")
        observed = self._authority.epoch_ns(quote["sourceTimestamp"])
        received = self._authority.epoch_ns(quote["receivedAt"])
        checked = self._authority.epoch_ns(entitlement["checkedAt"])
        expiry = self._authority.epoch_ns(entitlement["expiresAt"])
        _require(0 <= checked <= now_ns < expiry and 0 <= observed <= received <= now_ns
                 and now_ns - observed <= exact_ns(self._policy["quote_max_age_ns"])
                 and now_ns - checked <= exact_ns(self._policy["entitlement_max_age_ns"]), "host-evidence-quote-expired")
        original = {"kind": "quote", "provider": identity["provider"], "instrumentId": instrument_id,
                    "quoteId": quote["quoteId"], "currency": quote["currency"], "snapshotId": identity["snapshotId"],
                    "dataVintageId": item["dataVintageId"], "sourceAtNs": str(observed), "receivedAtNs": str(received),
                    **{k: quote[k] for k in ("bid", "ask", "bidSize", "askSize")}}
        self._source(item["sourceArtifact"], original, identity["contentHash"])
        # granted/executable are derived here, never accepted from private config.
        return {"quote_id": quote["quoteId"], "instrument_id": instrument_id, "provider": identity["provider"],
                "currency": quote["currency"], "snapshot_id": identity["snapshotId"], "data_vintage_id": item["dataVintageId"],
                "source_hash": identity["contentHash"], "source_at_ns": str(observed), "received_at_ns": str(received),
                "executable": True, "data_kind": "real", "bid": quote["bid"], "ask": quote["ask"],
                "bid_size": quote["bidSize"], "ask_size": quote["askSize"],
                "entitlement": {"policy_id": policy["policyId"], "granted": True, "checked_at_ns": str(checked),
                                "expires_at_ns": str(expiry), "provider": identity["provider"],
                                "instrument_id": instrument_id, "usage": "paper-simulation"}}

    def _market(self, instrument_id: str, now_ns: int) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        instrument = self._instruments[instrument_id]
        native = instrument["kernel"]
        quote, underlying = self._quote(instrument_id, now_ns), self._quote(native["underlying_id"], now_ns)
        _require(self._quotes[instrument_id]["sessionId"] == instrument["sessionId"]
                 and self._quotes[native["underlying_id"]]["sessionId"] == instrument["sessionId"], "host-evidence-quote-session-mismatch")
        item = self._greeks[instrument_id]
        _object(item, "observation sourceArtifact")
        greek = item["observation"]
        _object(greek, "values instrument_id provider model_id model_version source_hash quote_id underlying_quote_id data_vintage_id observed_at_ns received_at_ns unit")
        _object(greek["values"], "delta gamma vega theta rho")
        for value in greek["values"].values():
            units(value)
        self._source(item["sourceArtifact"], {"kind": "greeks", **{k: v for k, v in greek.items() if k != "source_hash"}}, greek["source_hash"])
        _require((greek["instrument_id"], greek["provider"], greek["quote_id"], greek["underlying_quote_id"], greek["data_vintage_id"], greek["unit"])
                 == (instrument_id, quote["provider"], quote["quote_id"], underlying["quote_id"], quote["data_vintage_id"], "per-underlying-unit")
                 and quote["data_vintage_id"] == underlying["data_vintage_id"]
                 and greek["model_id"] in self._policy["approved_greek_model_ids"], "host-evidence-greek-provenance-mismatch")
        observed, received = exact_ns(greek["observed_at_ns"]), exact_ns(greek["received_at_ns"])
        _require(max(exact_ns(quote["source_at_ns"]), exact_ns(underlying["source_at_ns"])) <= observed <= received <= now_ns
                 and now_ns - observed <= exact_ns(self._policy["greek_max_age_ns"]), "host-evidence-greek-expired")
        return quote, underlying, greek

    def _review(self, intent: Mapping[str, Any], admission: Mapping[str, Any], now_ns: int) -> dict[str, Any]:
        _require(self._authority.validate("TradeIntent", intent) is True
                 and self._authority.validate("PaperSimulationAdmission", admission) is True, "host-evidence-proposal-invalid")
        review = self._cached(admission["reviewId"], "AcceptedReview")
        original = self._cached(review["artifactId"], "TradeIntent")
        digest = self._authority.digest(intent)
        _require(original == intent and review["artifactSha256"] == digest
                 and admission["intentSha256"] == admission["reviewedArtifactSha256"] == digest
                 and admission["intentId"] == intent["intentId"]
                 and review["reviewId"] == admission["reviewId"] and review["reviewVersion"] == admission["reviewVersion"]
                 and review["actorId"] == admission["actorId"] and review["decision"] == "accepted"
                 and review["purpose"] == "paper-simulation"
                 and admission["simulatorId"] == self._simulation["simulatorId"], "host-evidence-original-review-binding-mismatch")
        for value in (intent, admission, review):
            _require(value["accountAlias"] == self._selection["accountAlias"] and value["environment"] == "paper"
                     and value["strategyVersion"] == self._policy["strategy_artifact"]["id"], "host-evidence-review-scope-mismatch")
        _require(admission["policyVersion"] == review["policyVersion"] == self._policy["version"]
                 and admission["ownerEpoch"] == self._ledger.state["ownerEpoch"], "host-evidence-review-policy-or-epoch-mismatch")
        review_config, simulation = self._selection["review"], self._selection["simulation"]
        _require(admission["reviewVersion"] == review_config["reviewVersion"]
                 and units(admission["maximumLoss"]) <= units(simulation["maximumLoss"])
                 and units(admission["maximumNotional"]) <= units(simulation["maximumNotional"])
                 and self._authority.epoch_ns(admission["expiresAt"]) - self._authority.epoch_ns(admission["admittedAt"])
                     <= simulation["ttlMilliseconds"] * 1_000_000
                 and self._authority.epoch_ns(review["expiresAt"]) - self._authority.epoch_ns(review["reviewedAt"])
                     <= review_config["ttlMilliseconds"] * 1_000_000,
                 "host-evidence-selected-review-or-simulation-limit-mismatch")
        for value, start in ((intent, "proposedAt"), (admission, "admittedAt"), (review, "reviewedAt")):
            _require(self._authority.epoch_ns(value[start]) <= now_ns < self._authority.epoch_ns(value["expiresAt"]),
                     "host-evidence-review-expired")
        _require(self._admission.permits(admission=admission, review=review, now_ns=now_ns) is True,
                 "host-evidence-current-review-unavailable")
        return review

    def _head(self, ledger: Mapping[str, Any]) -> tuple[int, str, str]:
        supplied = dict(ledger)
        dispatch = supplied.pop("dispatchReservationKey", None)
        _require(dispatch is None or dispatch in self._ledger.state["orders"], "host-evidence-dispatch-reservation-missing")
        digest = self._authority.digest(self._ledger.state)
        _require(self._authority.digest(supplied) == digest, "host-evidence-owned-ledger-mismatch")
        _require(type(self._ledger.sequence) is int and self._ledger.sequence >= 0, "host-evidence-journal-revision-invalid")
        return self._ledger.sequence, _hash(self._ledger.event_hash), digest

    def _owned_positions(self, ledger: Mapping[str, Any], head: tuple[int, str, str], now_ns: int) -> tuple[Mapping[str, Any], ...]:
        # Reservations/projection checkpoints may advance the head without changing
        # held lots. A fill, settlement or corporate action invalidates this exact
        # preloaded position basis; it cannot silently reuse old valuations/lots.
        economic = {name: ledger[name] for name in ("positions", "unsettledPositions", "unsettledCredits", "fillLineage",
                    "corporateActions", "optionObligations", "settlements", "invalidQualifications")}
        basis = self._authority.digest(economic)
        if self._position_origin is None:
            _require(head == (exact_ns(self._positions["ledgerSequence"]), self._positions["ledgerSha256"], self._positions["ledgerStateSha256"]),
                     "host-evidence-position-origin-unavailable")
        _require(self._position_basis is None or self._position_basis == basis, "host-evidence-position-lineage-changed")
        totals: dict[str, int] = {}
        settled: dict[str, int] = {}
        seen: set[str] = set()
        for position in self._positions["positions"]:
            _object(position, "position_id sleeve instrument_id kind underlying_id expiry_date quantity unit_notional unit_greeks valuation_at_ns "
                    "greek_observed_at_ns source_hash greek_model_id greek_unit data_vintage_id cash_encumbered maximum_loss settled_quantity covered_shares_encumbered")
            instrument = self._instruments[position["instrument_id"]]["kernel"]
            quote, underlying, greek = self._market(position["instrument_id"], now_ns)
            _require(position["position_id"] not in seen and position["sleeve"] in self._policy["sleeve_limits"], "host-evidence-position-lot-mismatch")
            seen.add(position["position_id"])
            _require(position["kind"] == instrument["kind"] and position["underlying_id"] == instrument["underlying_id"]
                     and position["expiry_date"] == (None if instrument["option"] is None else instrument["option"]["expiry_date"])
                     and position["unit_notional"] == _multiply(underlying["ask"], instrument["multiplier"])
                     and position["unit_greeks"] == {k: _multiply(v, instrument["multiplier"]) for k, v in greek["values"].items()}
                     and position["valuation_at_ns"] == underlying["source_at_ns"]
                     and position["greek_observed_at_ns"] == greek["observed_at_ns"]
                     and position["source_hash"] == underlying["source_hash"] and position["greek_model_id"] == greek["model_id"]
                     and position["greek_unit"] == "per-position-unit" and position["data_vintage_id"] == greek["data_vintage_id"],
                     "host-evidence-position-market-provenance-mismatch")
            instrument_id = position["instrument_id"]
            totals[instrument_id] = totals.get(instrument_id, 0) + units(position["quantity"])
            settled[instrument_id] = settled.get(instrument_id, 0) + units(position["settled_quantity"])
        actual = {k: units(v) for k, v in ledger["positions"].items() if units(v) != 0}
        _require({k: v for k, v in totals.items() if v != 0} == actual, "host-evidence-position-quantity-mismatch")
        for instrument_id, quantity in settled.items():
            pending = sum(units(p["quantity"]) for p in ledger["unsettledPositions"].values() if p["instrumentId"] == instrument_id)
            _require(quantity <= max(0, actual.get(instrument_id, 0) - pending), "host-evidence-unsettled-shares")
        if self._position_origin is None:
            self._position_origin, self._position_basis = head, basis
        return tuple(json.loads(self._authority.encode(self._positions["positions"])))

    def resolve(self, *, intent: Mapping[str, Any], admission: Mapping[str, Any], strategy: Mapping[str, Any],
                ledger: Mapping[str, Any], now_ns: int) -> QualifiedRiskInputs:
        return self.resolve_batch(intents=(intent,), admissions=(admission,), strategy=strategy, ledger=ledger, now_ns=now_ns)

    def resolve_batch(self, *, intents: tuple[Mapping[str, Any], ...], admissions: tuple[Mapping[str, Any], ...],
                      strategy: Mapping[str, Any], ledger: Mapping[str, Any], now_ns: int) -> QualifiedRiskInputs:
        self._last = None  # Never fall back to a previous accepted resolution.
        try:
            _require(type(now_ns) is int and 1 <= len(intents) == len(admissions) <= min(8, self._bounds.max_legs),
                     "host-evidence-batch-bound")
            _require(self._authority.epoch_ns(self._selection["issuedAt"]) <= now_ns < self._authority.epoch_ns(self._selection["expiresAt"])
                     and exact_ns(self._policy["valid_from_ns"]) <= now_ns < exact_ns(self._policy["valid_until_ns"]),
                     "host-evidence-selection-expired")
            rights = self._current_rights(now_ns)
            rights_hash = _hash(self._rights.current())
            head = self._head(ledger)
            _require((ledger["accountAlias"], ledger["environment"], ledger["currency"], ledger["simulatorId"])
                     == (self._selection["accountAlias"], "paper", self._policy["currency"], self._simulation["simulatorId"]),
                     "host-evidence-ledger-scope-mismatch")
            pinned_strategy = self._cached(self._policy["strategy_artifact"]["id"], "StrategySpec")
            _require(pinned_strategy == strategy and self._authority.digest(strategy) == self._policy["strategy_artifact"]["sha256"],
                     "host-evidence-strategy-pin-mismatch")
            reviews, legs = [], []
            seen = set()
            for intent, admission in zip(intents, admissions, strict=True):
                reviews.append(self._review(intent, admission, now_ns))
                instrument_id = intent["instrumentId"]
                _require(instrument_id not in seen, "host-evidence-duplicate-instrument")
                seen.add(instrument_id)
                item = self._instruments[instrument_id]
                native = item["kernel"]
                _require(intent["orderType"] == "limit" and intent["timeInForce"] == "DAY" and intent["stopPrice"] is None,
                         "host-evidence-order-type-unavailable")
                _require(intent["tickSize"] == native["tick_size"] and instrument_id not in ledger["invalidQualifications"],
                         "host-evidence-instrument-qualification-invalidated")
                _require(exact_ns(native["valid_from_ns"]) <= now_ns < exact_ns(native["valid_until_ns"]),
                         "host-evidence-instrument-expired")
                model = self._model_by_instrument[instrument_id]
                _require(model.session_open_ns <= now_ns < model.session_close_ns, "host-evidence-model-session-expired")
                quote, underlying, greek = self._market(instrument_id, now_ns)
                _require(self._public(self._quotes[instrument_id]["quote"], "Quote") == intent["referenceQuote"],
                         "host-evidence-original-reference-quote-mismatch")
                calendar = self._calendars[native["calendar_id"]]
                if native["option"] is not None:
                    _require(native["option"]["expiry_date"] != item["sessionId"], "host-evidence-zero-dte-unavailable")
                legs.append({"intent_hash": self._authority.digest(intent), "instrument": native, "calendar": calendar,
                             "side": intent["side"], "quantity": intent["quantity"], "limit_price": intent["limitPrice"],
                             "quote": quote, "underlying_quote": underlying, "greeks": greek})
            positions = self._owned_positions(ledger, head, now_ns)
            input_bytes = self._authority.encode({"policy": self._policy, "legs": legs, "positions": list(positions)})
            proof = {"selectionId": self._selection["selectionId"], "selectionSha256": self._selection["selectionSha256"],
                     "ledgerSequence": str(head[0]), "ledgerSha256": head[1], "ledgerStateSha256": head[2],
                     "assessedAtNs": str(now_ns), "rightsSha256": rights_hash,
                     "intents": [self._authority.digest(i) for i in intents], "admissions": [self._authority.digest(a) for a in admissions],
                     "reviews": [self._authority.digest(r) for r in reviews], "qualifiedSha256": sha256(input_bytes).hexdigest(),
                     "dispatchReservationKey": ledger.get("dispatchReservationKey")}
            proof_bytes = self._authority.encode(proof)
            decoded = json.loads(input_bytes)
            inputs = QualifiedRiskInputs(decoded["policy"], tuple(decoded["legs"]), tuple(decoded["positions"]), sha256(proof_bytes).hexdigest())
            self._last = _Resolution(inputs, input_bytes, proof_bytes, head[1], head[0], head[2], now_ns, rights_hash,
                                     tuple(self._authority.encode(a) for a in admissions), tuple(self._authority.encode(i) for i in intents),
                                     tuple(self._authority.encode(r) for r in reviews), rights["expires_ns"])
            _require(self.verify(inputs, ledger_sha256=head[1], now_ns=now_ns), "host-evidence-resolution-changed")
            return inputs
        except ExecutionError:
            self._last = None
            raise
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            self._last = None
            raise ExecutionError("host-evidence-required-provenance-unavailable") from error

    def verify(self, inputs: QualifiedRiskInputs, *, ledger_sha256: str, now_ns: int) -> bool:
        proof = self._last
        try:
            if proof is None or inputs is not proof.inputs or now_ns != proof.now_ns:
                return False
            if (ledger_sha256 != proof.ledger_sha256 or self._ledger.event_hash != proof.ledger_sha256
                    or self._ledger.sequence != proof.ledger_sequence or self._authority.digest(self._ledger.state) != proof.state_sha256
                    or self._rights.current() != proof.rights_sha256 or inputs.evidence_sha256 != sha256(proof.proof_bytes).hexdigest()):
                return False
            if self._authority.encode({"policy": dict(inputs.policy), "legs": list(inputs.legs), "positions": list(inputs.positions)}) != proof.input_bytes:
                return False
            self._current_rights(now_ns)
            return all(self._admission.permits(admission=json.loads(a), review=json.loads(r), now_ns=now_ns) is True
                       for a, r in zip(proof.admissions, proof.reviews, strict=True))
        except (ExecutionError, KeyError, TypeError, ValueError, AttributeError):
            return False

    def command(self, *, inputs: QualifiedRiskInputs, native_plan: Mapping[str, Any],
                intent: Mapping[str, Any], admission: Mapping[str, Any]) -> bytes:
        return self.command_batch(inputs=inputs, native_plan=native_plan, intents=(intent,), admissions=(admission,))

    def command_batch(self, *, inputs: QualifiedRiskInputs, native_plan: Mapping[str, Any],
                      intents: tuple[Mapping[str, Any], ...], admissions: tuple[Mapping[str, Any], ...]) -> bytes:
        try:
            proof = self._last
            _require(proof is not None and self.verify(inputs, ledger_sha256=native_plan["journal_head_hash"],
                     now_ns=exact_ns(native_plan["evaluated_at_ns"])), "host-evidence-command-proof-invalid")
            _require(tuple(self._authority.encode(i) for i in intents) == proof.intents
                     and tuple(self._authority.encode(a) for a in admissions) == proof.admissions,
                     "host-evidence-command-review-substitution")
            _require(native_plan["journal_revision"] == str(proof.ledger_sequence)
                     and native_plan["owner_epoch"] == self._ledger.state["ownerEpoch"]
                     and native_plan["account_alias"] == self._selection["accountAlias"]
                     and native_plan["mode"] == "PAPER-SIMULATION"
                     and native_plan["policy_hash"] == self._authority.digest(inputs.policy)
                     and native_plan["policy_id"] == self._policy["policy_id"]
                     and native_plan["strategy_artifact_id"] == self._policy["strategy_artifact"]["id"]
                     and native_plan["strategy_hash"] == self._policy["strategy_artifact"]["sha256"]
                     and native_plan["cost_model_id"] == self._simulation["costModelId"]
                     and native_plan["latency_model_id"] == self._simulation["latencyModelId"]
                     and native_plan["live_authorization"] is False and native_plan["broker_submission_allowed"] is False,
                     "host-evidence-command-plan-binding-mismatch")
            _require(len(native_plan["legs"]) == len(intents), "host-evidence-command-native-leg-count")
            # A batch is one package; ratios are EXACT reviewed quantities. One
            # package is a representation, not a newly calculated trade size.
            maximum_quantity = intents[0]["quantity"] if len(intents) == 1 else "1"
            legs = []
            total_cost = 0
            for intent, admission, native in zip(intents, admissions, native_plan["legs"], strict=True):
                _require((native["instrument_id"], native["intent_hash"], native["quantity"], native["limit_price"])
                         == (intent["instrumentId"], self._authority.digest(intent), intent["quantity"], intent["limitPrice"]),
                         "host-evidence-command-native-leg-mismatch")
                _require(0 < units(native["maximum_loss"]) <= units(admission["maximumLoss"])
                         and 0 < units(native["gross_notional"]) <= units(admission["maximumNotional"]),
                         "host-evidence-command-admission-limit-mismatch")
                total_cost += units(native["cost_reservation"])
                instrument = self._simulator_instrument(self._instruments[intent["instrumentId"]])
                legs.append(QualifiedLeg(intent["intentId"], instrument, intent["side"],
                            exact_decimal("1" if len(intents) == 1 else intent["quantity"]), exact_decimal(intent["limitPrice"]),
                            self._model_by_instrument[intent["instrumentId"]].model_id))
            _require(0 <= units(self._simulation["maximumTotalFees"]) <= total_cost, "host-evidence-command-fees-exceed-reservation")
            expiry = min(exact_ns(native_plan["expires_at_ns"]), proof.rights_expiry_ns,
                         self._authority.epoch_ns(self._selection["expiresAt"]),
                         *(self._authority.epoch_ns(v["expiresAt"]) for v in (*intents, *admissions)),
                         *(self._authority.epoch_ns(json.loads(r)["expiresAt"]) for r in proof.reviews),
                         *(m.session_close_ns for m in self._models if m.instrument_id in {i["instrumentId"] for i in intents}),
                         *(leg.instrument.option.schedule.last_trade_ns for leg in legs if leg.instrument.option is not None))
            limits = AdmittedLimits(exact_decimal(maximum_quantity), exact_decimal(native_plan["reservation"]["gross_notional"]),
                                    exact_decimal(self._simulation["maximumTotalFees"]), exact_decimal(self._simulation["maximumLeggingQuantity"]),
                                    exact_ns(self._simulation["maximumLeggingNs"]), expiry)
            command = SubmitCommand(native_plan["request_id"], inputs.legs[0]["intent_hash"], tuple(legs), exact_decimal(maximum_quantity),
                                    limits, self._policy["strategy_artifact"]["id"], self._policy["version"], proof.now_ns, expiry)
            recipe = command_recipe(command)
            self.check_recipe(recipe, now_ns=proof.now_ns)
            _require(self.verify(inputs, ledger_sha256=proof.ledger_sha256, now_ns=proof.now_ns),
                     "host-evidence-command-proof-changed")
            return self._authority.encode(recipe)
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise ExecutionError("host-evidence-command-configuration-unavailable") from error

    def check_recipe(self, recipe: Mapping[str, Any], *, now_ns: int) -> None:
        """Static inverse check, also valid for historical checkpoint replay.

        Current rights/reviews are checked at fresh risk admission/dispatch, not
        retroactively applied to original historical simulator checkpoint bytes.
        The durable bridge separately binds every quantity, cap and dispatch ID.
        """
        try:
            _require(recipe["strategy_artifact_id"] == self._policy["strategy_artifact"]["id"]
                     and recipe["policy_id"] == self._policy["version"], "host-evidence-command-selected-policy-mismatch")
            limits = recipe["admitted_limits"]
            _require(limits["maximum_total_fees"] == self._simulation["maximumTotalFees"]
                     and limits["maximum_legging_quantity"] == self._simulation["maximumLeggingQuantity"]
                     and limits["maximum_legging_ns"] == self._simulation["maximumLeggingNs"]
                     and limits["maximum_quantity"] == recipe["maximum_quantity"], "host-evidence-command-configured-limit-mismatch")
            expiry = exact_ns(recipe["expires_at_ns"])
            _require(now_ns < expiry == exact_ns(limits["valid_until_ns"])
                     <= min(exact_ns(self._policy["valid_until_ns"]), self._authority.epoch_ns(self._selection["expiresAt"])),
                     "host-evidence-command-expiry-mismatch")
            for leg in recipe["legs"]:
                instrument_id = leg["instrument"]["instrument_id"]
                expected = record_payload(self._simulator_instrument(self._instruments[instrument_id]))
                model = self._model_by_instrument[instrument_id]
                _require(leg["instrument"] == expected and leg["model_id"] == model.model_id,
                         "host-evidence-command-qualification-substitution")
                _require(model.session_open_ns <= now_ns < expiry <= model.session_close_ns
                         and now_ns + model.submit_latency_ns < expiry, "host-evidence-command-model-expired")
                if expected["option"] is not None:
                    _require(expiry <= exact_ns(expected["option"]["schedule"]["last_trade_ns"]),
                             "host-evidence-command-option-trading-ended")
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise ExecutionError("host-evidence-command-provenance-unavailable") from error
