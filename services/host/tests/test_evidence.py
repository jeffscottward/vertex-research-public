"""Source-only host regressions. Intentionally NOT native schema conformance.

The authority/cache/current-control objects here are explicit in-memory wiring
doubles. These tests neither load native code nor create cash/broker authority.
They are authored for the deferred final verification phase, not executed here.
"""
from copy import deepcopy
from dataclasses import replace
from datetime import date
from decimal import Decimal
import hashlib
import json
from types import SimpleNamespace
import unittest

from vertex_execution.exact import timestamp
from vertex_execution.ports import Artifact, ExecutionError
from vertex_host.commands import QualifiedCommandDecoder, command_recipe, record_payload
from vertex_host.evidence import QualifiedEvidencePort


class NonConformanceAuthority:
    """Call-wiring only: a native ContractAuthority remains mandatory in use."""
    def __init__(self):
        self.rejected = None
        self.validated = []

    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, value):
        return hashlib.sha256(self.encode(value)).hexdigest()

    def validate(self, name, value, schema_version="1.0.0"):
        self.validated.append(name)
        return name != self.rejected

    def epoch_ns(self, value):
        day, clock = value.removesuffix("Z").split("T")
        hours, minutes, seconds = clock.split(":")
        seconds, _, nanos = seconds.partition(".")
        days = (date.fromisoformat(day) - date(1970, 1, 1)).days
        return (days * 86400 + int(hours) * 3600 + int(minutes) * 60 + int(seconds)) * 10**9 + int(nanos.ljust(9, "0"))


class MemoryInputs:
    """Immutable test bytes, not a substitute for production SealedArtifactCache."""
    def __init__(self, authority):
        self.authority = authority
        self.public = {}
        self.private_bytes = {}

    def pin(self, identity, contract, value, *, public=False):
        encoded = self.authority.encode(value)
        digest = hashlib.sha256(encoded).hexdigest()
        if public:
            self.public[identity] = Artifact(identity, contract, digest, encoded)
        else:
            self.private_bytes[(identity, digest)] = encoded
        return {"artifactId": identity, "artifactSha256": digest, "contractName": contract, "schemaVersion": "1.0.0"}

    def get(self, identity):
        return self.public[identity]

    def private(self, identity, digest):
        return json.loads(self.private_bytes[(identity, digest)])

    def snapshot(self):
        return dict(self.public)


class AuthenticatedRightsDouble:
    """Only fixture installation grants; quote entitlement flags cannot grant."""
    def __init__(self, authority, now):
        self.authority = authority
        self.account_alias, self.environment = "account-fixture", "paper"
        self.value = {"policyId": "rights-fixture", "version": "1.0.0", "status": "granted",
                      "allowedUses": ["read", "derive"], "checked_ns": now - 60 * 10**9,
                      "expires_ns": now + 60 * 10**9}

    def record(self, policy_id, version, now_ns):
        if not (policy_id == self.value["policyId"] and version == self.value["version"]
                and self.value["status"] == "granted" and self.value["checked_ns"] <= now_ns < self.value["expires_ns"]):
            raise ExecutionError("fixture-current-rights-denied")
        return deepcopy(self.value)

    def permits(self, policy_id, version, use, now_ns):
        try:
            return use in self.record(policy_id, version, now_ns)["allowedUses"]
        except ExecutionError:
            return False

    def current(self):
        return self.authority.digest(self.value)


class AuthenticatedAdmissionDouble:
    def __init__(self, authority):
        self.authority = authority
        self.current = {}

    def install(self, admission, review):
        self.current[self.authority.digest(admission)] = self.authority.encode(review)

    def permits(self, *, admission, review, now_ns):
        return self.current.get(self.authority.digest(admission)) == self.authority.encode(review)


class EvidenceFixture:
    def __init__(self, instruments=1):
        self.authority = NonConformanceAuthority()
        self.cache = MemoryInputs(self.authority)
        self.day = (date(2026, 9, 22) - date(1970, 1, 1)).days * 86400 * 10**9
        self.now = self.day + 10 * 3600 * 10**9
        self.rights = AuthenticatedRightsDouble(self.authority, self.now)
        self.admission_authority = AuthenticatedAdmissionDouble(self.authority)
        self.ledger = SimpleNamespace(sequence=7, event_hash="a" * 64, state={
            "accountAlias": "account-fixture", "environment": "paper", "simulatorId": "sim-fixture",
            "currency": "USD", "ownerEpoch": "2", "observation": {"observedNs": str(self.now), "receivedNs": str(self.now)},
            "cash": "1000", "positions": {}, "orders": {}, "unsettledCredits": {}, "unsettledPositions": {},
            "fillLineage": {}, "corporateActions": {}, "optionObligations": {}, "settlements": {}, "invalidQualifications": [],
            "reconciled": True, "pausedNewRisk": False,
        })
        self.strategy = {"nonConformanceFixture": True, "strategyId": "strategy-fixture", "sleeve": "quant"}
        strategy_pin = self.cache.pin("strategy-artifact", "StrategySpec", self.strategy, public=True)
        self.calendar = {"calendar_id": "calendar-fixture", "version": "2026a", "timezone": "Etc/UTC", "tzdb_version": "2026a",
                         "intervals": [{"start_ns": str(self.day), "end_ns": str(self.day + 86400 * 10**9), "offset_seconds": 0}],
                         "sessions": [{"date": "2026-09-22", "tradable": True, "open_minute": 570,
                                       "close_minute": 960, "entry_cutoff_minute": 955}]}
        self.cost = {"model_id": "cost-fixture", "fee_per_unit": "0.01", "fee_per_leg": "0.01", "slippage_bps": "1",
                     "currency_quantum": "0.01", "latency_model_id": "latency-fixture", "submission_latency_ns": "1000000",
                     "maximum_receive_delay_ns": "5000000000"}
        limit = {"gross_notional": "100000", "maximum_loss": "100000", "reserved_cash": "100000",
                 "absolute_greeks": {k: "100000" for k in ("delta", "gamma", "vega", "theta", "rho")},
                 "per_instrument_notional": "100000", "per_expiry_notional": "100000", "maximum_positions": 20}
        self.policy = {"policy_id": "risk-fixture", "version": "1.0.0", "account_alias": "account-fixture", "environment": "paper",
                       "currency": "USD", "valid_from_ns": str(self.day), "valid_until_ns": str(self.day + 86400 * 10**9),
                       "strategy_artifact": {"id": strategy_pin["artifactId"], "sha256": strategy_pin["artifactSha256"]},
                       "approved_instruments": [], "approved_calendars": [{"id": self.calendar["calendar_id"], "sha256": self.authority.digest(self.calendar)}],
                       "approved_entitlement_policy_ids": ["rights-fixture"], "approved_greek_model_ids": ["greek-fixture"],
                       "quote_max_age_ns": "120000000000", "greek_max_age_ns": "120000000000", "journal_max_age_ns": "120000000000",
                       "entitlement_max_age_ns": "300000000000", "maximum_spread_bps": "500", "minimum_displayed_quantity": "1",
                       "maximum_participation_bps": "5000", "costs": self.cost, "portfolio_limits": limit,
                       "sleeve_limits": {"quant": deepcopy(limit)}, "zero_dte": None}
        self.artifacts = []
        self.add("calendar", "calendar-config", "HostExchangeCalendar", self.calendar)
        self.intents, self.admissions, self.reviews, self.models, self.instrument_configs = [], [], [], [], []
        for index in range(instruments):
            self.add_instrument(index)
        self.simulation = {"simulatorId": "sim-fixture", "costModelId": "cost-fixture", "latencyModelId": "latency-fixture",
                           "models": self.models, "maximumTotalFees": "1", "maximumLeggingQuantity": "1", "maximumLeggingNs": "1000000000",
                           "bounds": {"max_legs": 8, "max_book_levels": 32, "max_market_events": 256, "max_orders": 256,
                                      "max_books": 256, "max_models": 256, "max_events": 65536, "max_order_events": 4096}}
        self.add("simulation-engine", "sim-config", "HostSimulationConfiguration", self.simulation)
        self.position_evidence = {"ledgerSequence": str(self.ledger.sequence), "ledgerSha256": self.ledger.event_hash,
                                  "ledgerStateSha256": self.authority.digest(self.ledger.state), "positions": []}
        self.add("broker-observation", "position-config", "HostPositionEvidence", self.position_evidence)
        self.rights_policy = {"policyId": "rights-fixture", "version": "1.0.0", "accountAlias": "account-fixture", "environment": "paper",
                              "allowedUses": ["paper-simulation"], "providers": ["provider-fixture"],
                              "instrumentIds": [f"equity-{n}" for n in range(instruments)]}
        policies = [("risk", "risk-fixture", "HostKernelPolicy", self.policy),
                    ("cost", "cost-fixture", "HostCostPolicy", self.cost),
                    ("calendar", "calendar-policy", "HostCalendarPolicy", {"approved_calendars": self.policy["approved_calendars"]}),
                    ("licensing-rights", "rights-fixture", "HostMarketRightsPolicy", self.rights_policy)]
        review_config = {"policyId": "review-policy", "version": "1.0.0", "reviewVersion": "1.0.0", "ttlMilliseconds": 60000}
        policies.append(("review", "review-policy", "HostReviewPolicyFixture", review_config))
        self.selection = {"nonConformanceFixture": True, "selectionId": "selection-fixture", "accountAlias": "account-fixture",
                          "environment": "paper", "issuedAt": timestamp(self.day), "expiresAt": timestamp(self.day + 86400 * 10**9),
                          "simulation": {"simulatorId": "sim-fixture", "maximumLoss": "500", "maximumNotional": "500", "ttlMilliseconds": 60000},
                          "review": review_config, "artifacts": self.artifacts,
                          "policies": [{"role": role, "policyId": identity, "version": "1.0.0",
                                        "artifact": self.cache.pin(identity + "-config", contract, value)}
                                       for role, identity, contract, value in policies]}
        self.rehash()

    def add(self, role, identity, contract, value):
        pin = self.cache.pin(identity, contract, value)
        self.artifacts.append({"bindingId": identity, "role": role, "artifact": pin})
        return pin

    def rehash(self):
        self.selection["selectionSha256"] = self.authority.digest({k: v for k, v in self.selection.items() if k != "selectionSha256"})

    def repin(self, identity, value):
        for row in (*self.selection["artifacts"], *self.selection["policies"]):
            pin = row["artifact"]
            if pin["artifactId"] == identity:
                row["artifact"] = self.cache.pin(identity, pin["contractName"], value)
        self.rehash()

    def add_instrument(self, index):
        identity = f"equity-{index}"
        native = {"instrument_id": identity, "qualification_id": f"qualification-{index}", "metadata_version": "2026a",
                  "corporate_action_version": "2026a", "exchange": "EXCH", "currency": "USD", "underlying_id": identity,
                  "kind": "equity", "multiplier": "1", "tick_size": "0.01", "quantity_step": "1", "calendar_id": "calendar-fixture",
                  "valid_from_ns": str(self.day), "valid_until_ns": str(self.day + 86400 * 10**9), "option": None}
        config = {"kernel": native, "symbol": f"EQ{index}", "sessionId": "2026-09-22", "schedule": None}
        self.instrument_configs.append(config)
        self.add("instrument", identity + "-instrument", "HostInstrumentEvidence", config)
        self.policy["approved_instruments"].append({"id": identity, "sha256": self.authority.digest(native)})
        source = {"kind": "quote", "provider": "provider-fixture", "instrumentId": identity, "quoteId": identity + "-quote",
                  "currency": "USD", "snapshotId": "snapshot-fixture", "dataVintageId": "vintage-fixture",
                  "sourceAtNs": str(self.now - 2 * 10**9), "receivedAtNs": str(self.now - 10**9),
                  "bid": "99", "ask": "100", "bidSize": "100", "askSize": "100"}
        source_pin = self.cache.pin(identity + "-quote-source", "HostProviderObservation", source)
        quote = {"schemaVersion": "1.0.0", "instrumentId": identity, "currency": "USD", "quoteId": identity + "-quote",
                 "bid": "99", "ask": "100", "bidSize": "100", "askSize": "100", "lastPrice": "100",
                 "sourceTimestamp": timestamp(self.now - 2 * 10**9), "receivedAt": timestamp(self.now - 10**9),
                 "source": {"identity": {"provider": "provider-fixture", "sourceId": "source-fixture", "snapshotId": "snapshot-fixture",
                                          "contentHash": source_pin["artifactSha256"]}, "dataKind": "real", "syntheticReason": None,
                            "providerTimezone": "Etc/UTC", "entitlement": {"policyId": "rights-fixture", "status": "granted",
                            "checkedAt": timestamp(self.now - 60 * 10**9), "expiresAt": timestamp(self.now + 60 * 10**9)},
                            "freshness": {"status": "fresh", "observedAt": timestamp(self.now - 2 * 10**9),
                                          "evaluatedAt": timestamp(self.now), "maxAgeMs": 120000}}}
        quote_pin = self.cache.pin(identity + "-quote-artifact", "Quote", quote, public=True)
        self.add("quote", identity + "-quote-config", "HostQuoteEvidence", {
            "quote": quote_pin, "sourceArtifact": source_pin, "dataVintageId": "vintage-fixture", "sessionId": "2026-09-22"})
        greek = {"values": {"delta": "1", "gamma": "0", "vega": "0", "theta": "0", "rho": "0"}, "instrument_id": identity,
                 "provider": "provider-fixture", "model_id": "greek-fixture", "model_version": "1.0.0", "quote_id": identity + "-quote",
                 "underlying_quote_id": identity + "-quote", "data_vintage_id": "vintage-fixture", "observed_at_ns": str(self.now - 10**9),
                 "received_at_ns": str(self.now), "unit": "per-underlying-unit"}
        greek_source = self.cache.pin(identity + "-greek-source", "HostProviderObservation", {"kind": "greeks", **greek})
        greek["source_hash"] = greek_source["artifactSha256"]
        self.add("greeks", identity + "-greek-config", "HostGreekEvidence", {"observation": greek, "sourceArtifact": greek_source})
        self.models.append({"model_id": identity + "-session-model", "instrument_id": identity, "symbol": f"EQ{index}", "session_id": "2026-09-22",
                            "session_open_ns": str(self.day + 570 * 60 * 10**9), "session_close_ns": str(self.day + 960 * 60 * 10**9),
                            "submit_latency_ns": "1000000", "cancel_latency_ns": "1000000", "quote_ttl_ns": "60000000000",
                            "participation_rate": "0.5", "depth_fraction": "0.5", "maximum_fill_quantity": "10", "fee_per_unit": "0.01",
                            "fee_rate": "0", "minimum_fee": "0", "slippage_bps": "1", "slippage_ticks": 0, "acceptance": "accepted"})
        intent = {"schemaVersion": "1.0.0", "intentId": identity + "-intent", "idempotencyKey": identity + "-intent-key", "correlationId": "correlation-fixture",
                  "proposalOnly": True, "executionAuthorized": False, "strategyVersion": "strategy-artifact", "accountAlias": "account-fixture",
                  "environment": "paper", "instrumentId": identity, "side": "buy", "quantity": str(index + 1), "orderType": "limit", "limitPrice": "100",
                  "stopPrice": None, "tickSize": "0.01", "timeInForce": "DAY", "quoteAsOf": quote["sourceTimestamp"], "referenceQuote": quote,
                  "proposedAt": timestamp(self.now), "reasonEvidenceIds": ["reason-fixture"], "maxLossBudget": "500", "expiresAt": timestamp(self.now + 45 * 10**9)}
        intent_pin = self.cache.pin(identity + "-intent-artifact", "TradeIntent", intent, public=True)
        review = {"schemaVersion": "1.0.0", "reviewId": identity + "-review", "accountAlias": "account-fixture", "environment": "paper",
                  "collectionId": None, "artifactId": intent_pin["artifactId"], "artifactSha256": intent_pin["artifactSha256"], "reviewVersion": "1.0.0",
                  "decision": "accepted", "purpose": "paper-simulation", "actorId": "actor-fixture", "reviewedAt": timestamp(self.now),
                  "expiresAt": timestamp(self.now + 45 * 10**9), "policyVersion": "1.0.0", "strategyVersion": "strategy-artifact",
                  "supersedesReviewId": None, "executionAuthorized": False}
        self.cache.pin(review["reviewId"], "AcceptedReview", review, public=True)
        admission = {"schemaVersion": "1.0.0", "admissionId": identity + "-admission", "admissionKind": "PAPER-SIMULATION",
                     "accountAlias": "account-fixture", "environment": "paper", "simulatorId": "sim-fixture", "streamId": "stream-fixture", "ownerEpoch": "2",
                     "intentId": intent["intentId"], "intentSha256": intent_pin["artifactSha256"], "reviewedArtifactSha256": intent_pin["artifactSha256"],
                     "reviewId": review["reviewId"], "reviewVersion": "1.0.0", "actorId": "actor-fixture", "policyVersion": "1.0.0",
                     "strategyVersion": "strategy-artifact", "portfolioSnapshotId": "portfolio-fixture", "portfolioSequence": "1", "maximumLoss": "500",
                     "maximumNotional": "500", "admittedAt": timestamp(self.now), "expiresAt": timestamp(self.now + 45 * 10**9),
                     "idempotencyKey": intent["idempotencyKey"], "simulationOnly": True, "brokerSubmissionAllowed": False,
                     "liveAuthorization": False, "executionAuthorized": False}
        self.admission_authority.install(admission, review)
        self.intents.append(intent)
        self.admissions.append(admission)
        self.reviews.append(review)

    def build(self):
        self.evidence = QualifiedEvidencePort(authority=self.authority, cache=self.cache, selection=self.selection,
                                             rights=self.rights, ledger_head=self.ledger, admission_authority=self.admission_authority)
        self.decoder = QualifiedCommandDecoder(authority=self.authority, evidence=self.evidence)
        return self.evidence

    def resolve(self, *, now=None, ledger=None):
        return self.evidence.resolve_batch(intents=tuple(self.intents), admissions=tuple(self.admissions), strategy=self.strategy,
                                          ledger=deepcopy(self.ledger.state) if ledger is None else ledger, now_ns=self.now if now is None else now)

    def plan(self, inputs):
        legs = [{"instrument_id": i["instrumentId"], "intent_hash": self.authority.digest(i), "quantity": i["quantity"],
                 "limit_price": i["limitPrice"], "maximum_loss": "200", "gross_notional": "200", "cost_reservation": "2"} for i in self.intents]
        return {"request_id": "submission-fixture", "account_alias": "account-fixture", "mode": "PAPER-SIMULATION",
                "journal_revision": str(self.ledger.sequence), "journal_head_hash": self.ledger.event_hash, "owner_epoch": "2",
                "evaluated_at_ns": str(self.now), "expires_at_ns": str(self.now + 40 * 10**9), "policy_hash": self.authority.digest(inputs.policy),
                "policy_id": "risk-fixture", "strategy_artifact_id": "strategy-artifact", "strategy_hash": self.authority.digest(self.strategy),
                "cost_model_id": "cost-fixture", "latency_model_id": "latency-fixture", "live_authorization": False,
                "broker_submission_allowed": False, "legs": legs, "reservation": {"gross_notional": str(200 * len(legs))}}

    def recipe(self, inputs, plan=None):
        return self.evidence.command_batch(inputs=inputs, native_plan=self.plan(inputs) if plan is None else plan,
                                          intents=tuple(self.intents), admissions=tuple(self.admissions))


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.f = EvidenceFixture()
        self.f.build()

    def test_exact_in_memory_evidence_and_inverse_without_mutating_original(self):
        original = self.f.authority.encode(self.f.intents[0])
        inputs = self.f.resolve()
        self.assertTrue(self.f.evidence.verify(inputs, ledger_sha256=self.f.ledger.event_hash, now_ns=self.f.now))
        self.assertEqual(inputs.policy["policy_id"], "risk-fixture")
        self.assertTrue(inputs.legs[0]["quote"]["entitlement"]["granted"])
        raw = self.f.recipe(inputs)
        command = self.f.decoder.decode(command_bytes=raw, submission_key="actual-dispatch", payload_sha256="b" * 64, now_ns=self.f.now)
        self.assertEqual(command.submission_key, "actual-dispatch")
        self.assertEqual(command.payload_hash, "b" * 64)
        self.assertEqual(command.legs[0].instrument.qualification_id, "qualification-0")
        self.assertEqual(command.legs[0].ratio * command.maximum_quantity, Decimal("1"))
        self.assertEqual(self.f.decoder.encode(command), raw)
        self.assertEqual(self.f.authority.encode(self.f.intents[0]), original)
        self.assertFalse(self.f.intents[0]["executionAuthorized"])
        self.assertNotIn("submission_key", json.loads(raw))
        self.assertEqual(self.f.evidence.session_models(), self.f.evidence.models)
        self.assertEqual(self.f.evidence.simulation_bounds().max_legs, 8)
        self.assertTrue(self.f.evidence.provenance_id.startswith("host-simulation-"))
        self.assertTrue({"RuntimePolicySelection", "Quote", "TradeIntent", "AcceptedReview", "StrategySpec"}.issubset(self.f.authority.validated))

    def test_proof_binds_exact_head_revision_state_time_and_resolved_object(self):
        for field in ("hash", "revision", "state", "time", "inputs", "proof"):
            with self.subTest(field=field):
                f = EvidenceFixture()
                f.build()
                inputs = f.resolve()
                now = f.now
                if field == "hash":
                    f.ledger.event_hash = "b" * 64
                elif field == "revision":
                    f.ledger.sequence += 1
                elif field == "state":
                    f.ledger.state["cash"] = "999"
                elif field == "time":
                    now += 1
                elif field == "inputs":
                    inputs.legs[0]["quote"]["ask"] = "1"
                else:
                    inputs = replace(inputs, evidence_sha256="c" * 64)
                self.assertFalse(f.evidence.verify(inputs, ledger_sha256=f.ledger.event_hash, now_ns=now))

    def test_current_rights_required_even_when_original_quote_claims_granted(self):
        self.f.rights.value["status"] = "denied"
        with self.assertRaisesRegex(ExecutionError, "current-rights-unavailable"):
            self.f.resolve()

    def test_rights_scope_and_each_server_use_required(self):
        for change in ("account", "derive", "version"):
            with self.subTest(change=change):
                f = EvidenceFixture()
                f.build()
                if change == "account":
                    f.rights.account_alias = "other-account"
                elif change == "derive":
                    f.rights.value["allowedUses"] = ["read"]
                else:
                    f.rights.value["version"] = "2.0.0"
                with self.assertRaises(ExecutionError):
                    f.resolve()

    def test_revocation_after_resolution_cannot_prepare_command(self):
        inputs = self.f.resolve()
        self.f.rights.value["status"] = "denied"
        with self.assertRaisesRegex(ExecutionError, "command-proof-invalid"):
            self.f.recipe(inputs)

    def test_cached_old_accepted_review_not_current_authority(self):
        inputs = self.f.resolve()
        self.f.admission_authority.current.clear()
        self.assertFalse(self.f.evidence.verify(inputs, ledger_sha256=self.f.ledger.event_hash, now_ns=self.f.now))
        with self.assertRaisesRegex(ExecutionError, "current-review-unavailable"):
            self.f.resolve()
        self.assertFalse(self.f.evidence.verify(inputs, ledger_sha256=self.f.ledger.event_hash, now_ns=self.f.now))

    def test_exact_original_intent_no_acceptance_mutation(self):
        self.f.intents[0]["executionAuthorized"] = True
        with self.assertRaisesRegex(ExecutionError, "original-review-binding-mismatch"):
            self.f.resolve()

    def test_immutable_constructor_snapshot_ignores_caller_mapping_mutation(self):
        self.f.selection["accountAlias"] = "other-account"
        self.f.policy["version"] = "9.0.0"
        self.assertEqual(self.f.resolve().policy["version"], "1.0.0")

    def test_selection_hash_and_public_native_validation_are_required(self):
        self.f.selection["selectionSha256"] = "0" * 64
        with self.assertRaisesRegex(ExecutionError, "selection-hash-mismatch"):
            self.f.build()
        f = EvidenceFixture()
        f.authority.rejected = "RuntimePolicySelection"
        with self.assertRaisesRegex(ExecutionError, "selection-invalid"):
            f.build()

    def test_missing_fee_bounds_and_caller_qualification_booleans_fail_closed(self):
        for name in ("fee", "bounds", "boolean", "zero-dte"):
            with self.subTest(name=name):
                f = EvidenceFixture()
                if name == "fee":
                    del f.simulation["models"][0]["fee_per_unit"]
                    f.repin("sim-config", f.simulation)
                elif name == "bounds":
                    del f.simulation["bounds"]["max_orders"]
                    f.repin("sim-config", f.simulation)
                elif name == "boolean":
                    f.instrument_configs[0]["kernel"]["qualified"] = True
                    f.repin("equity-0-instrument", f.instrument_configs[0])
                else:
                    f.policy["zero_dte"] = {"owner_review_verified": True}
                    f.repin("risk-fixture-config", f.policy)
                with self.assertRaises(ExecutionError):
                    f.build()

    def test_original_source_hash_requires_exact_source_values(self):
        pin = next(a["artifact"] for a in self.f.selection["artifacts"] if a["bindingId"] == "equity-0-quote-config")
        config = self.f.cache.private(pin["artifactId"], pin["artifactSha256"])
        source_pin = config["sourceArtifact"]
        source = self.f.cache.private(source_pin["artifactId"], source_pin["artifactSha256"])
        source["ask"] = "0.01"
        self.f.cache.private_bytes[(source_pin["artifactId"], source_pin["artifactSha256"])] = self.f.authority.encode(source)
        with self.assertRaisesRegex(ExecutionError, "private-pin-mismatch"):
            self.f.resolve()

    def test_rights_refresh_preserves_exact_original_quote_timestamps(self):
        checked = self.f.intents[0]["referenceQuote"]["source"]["entitlement"]["checkedAt"]
        self.f.rights.value["checked_ns"] = self.f.now
        inputs = self.f.resolve()
        self.assertEqual(inputs.legs[0]["quote"]["entitlement"]["checked_at_ns"], str(self.f.authority.epoch_ns(checked)))

    def test_reserved_head_advance_rebinds_proof_but_does_not_change_recipe(self):
        inputs = self.f.resolve()
        raw = self.f.recipe(inputs)
        self.f.ledger.sequence += 1
        self.f.ledger.event_hash = "b" * 64
        self.f.ledger.state["orders"]["submission-fixture"] = {"reservationState": "held"}
        dispatch = deepcopy(self.f.ledger.state)
        dispatch["dispatchReservationKey"] = "submission-fixture"
        current = self.f.resolve(ledger=dispatch)
        self.assertNotEqual(current.evidence_sha256, inputs.evidence_sha256)
        self.assertEqual(self.f.recipe(current), raw)

    def test_position_change_never_uses_prior_lot_basis_or_fake_buying_power(self):
        self.f.resolve()
        self.f.ledger.sequence += 1
        self.f.ledger.event_hash = "b" * 64
        self.f.ledger.state["positions"]["equity-0"] = "1"
        with self.assertRaisesRegex(ExecutionError, "position-lineage-changed"):
            self.f.resolve()

    def test_position_origin_revision_and_hash_required(self):
        self.f.ledger.sequence += 1
        with self.assertRaisesRegex(ExecutionError, "position-origin-unavailable"):
            self.f.resolve()

    def test_unsupported_order_kind_not_silently_converted(self):
        self.f.intents[0]["timeInForce"] = "IOC"
        intent = self.f.intents[0]
        digest = self.f.authority.digest(intent)
        review = self.f.reviews[0]
        review["artifactSha256"] = digest
        self.f.cache.pin(review["artifactId"], "TradeIntent", intent, public=True)
        self.f.cache.pin(review["reviewId"], "AcceptedReview", review, public=True)
        self.f.admissions[0].update(intentSha256=digest, reviewedArtifactSha256=digest)
        self.f.admission_authority.install(self.f.admissions[0], review)
        with self.assertRaisesRegex(ExecutionError, "order-type-unavailable"):
            self.f.resolve()

    def test_private_schema_version_does_not_fall_back(self):
        self.f.selection["policies"][0]["artifact"]["schemaVersion"] = "2.0.0"
        self.f.rehash()
        with self.assertRaisesRegex(ExecutionError, "private-contract-unavailable"):
            self.f.build()

    def test_batch_preserves_every_independently_reviewed_quantity_and_order(self):
        f = EvidenceFixture(2)
        f.build()
        inputs = f.resolve()
        raw = f.recipe(inputs)
        command = f.decoder.decode(command_bytes=raw, submission_key="batch-fixture", payload_sha256="c" * 64, now_ns=f.now)
        self.assertEqual(command.maximum_quantity, Decimal("1"))
        self.assertEqual([leg.ratio for leg in command.legs], [Decimal("1"), Decimal("2")])
        self.assertEqual([leg.instrument.instrument_id for leg in command.legs], ["equity-0", "equity-1"])
        f.admission_authority.current.pop(f.authority.digest(f.admissions[1]))
        with self.assertRaisesRegex(ExecutionError, "current-review-unavailable"):
            f.resolve()

    def test_plan_substitution_and_fee_reservation_rejected(self):
        inputs = self.f.resolve()
        for field, value in (("journal_revision", "0"), ("policy_hash", "0" * 64), ("mode", "LIVE")):
            plan = self.f.plan(inputs)
            plan[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ExecutionError, "plan-binding-mismatch"):
                self.f.recipe(inputs, plan)
        plan = self.f.plan(inputs)
        plan["legs"][0]["cost_reservation"] = "0.01"
        with self.assertRaisesRegex(ExecutionError, "fees-exceed-reservation"):
            self.f.recipe(inputs, plan)

    def test_decoder_rejects_changed_model_limits_dispatch_fields_and_noncanonical_bytes(self):
        raw = self.f.recipe(self.f.resolve())
        mutations = [lambda r: r["legs"][0].update(model_id="unselected-model"),
                     lambda r: r["admitted_limits"].update(maximum_total_fees="0"),
                     lambda r: r.update(submission_key="injected-dispatch"),
                     lambda r: r["legs"][0]["instrument"].update(multiplier="100"),
                     lambda r: r["admitted_limits"].pop("maximum_legging_ns")]
        for mutate in mutations:
            recipe = json.loads(raw)
            mutate(recipe)
            with self.assertRaises(ExecutionError):
                self.f.decoder.decode(command_bytes=self.f.authority.encode(recipe), submission_key="dispatch-fixture",
                                      payload_sha256="d" * 64, now_ns=self.f.now)
        for invalid in (b" " + raw, raw[:-1] + b',"recipe_version":"vertex.host-submit.v1"}', raw.replace(b'"maximum_quantity":"1"', b'"maximum_quantity":1.0')):
            with self.assertRaises(ExecutionError):
                self.f.decoder.decode(command_bytes=invalid, submission_key="dispatch-fixture", payload_sha256="d" * 64, now_ns=self.f.now)

    def test_historical_roundtrip_does_not_reauthorize_current_rights(self):
        raw = self.f.recipe(self.f.resolve())
        self.f.rights.value["status"] = "denied"
        self.f.admission_authority.current.clear()
        command = self.f.decoder.decode(command_bytes=raw, submission_key="historical-fixture", payload_sha256="d" * 64, now_ns=self.f.now)
        self.assertEqual(self.f.authority.encode(command_recipe(command)), raw)
        self.assertEqual(record_payload(command)["submitted_at_ns"], str(self.f.now))
        with self.assertRaises(ExecutionError):
            self.f.resolve()

    def test_exact_existing_lot_quantities_sleeve_and_market_provenance(self):
        f = EvidenceFixture()
        f.ledger.state["positions"] = {"equity-0": "2"}
        f.ledger.state["unsettledPositions"] = {"fill-fixture": {"instrumentId": "equity-0", "quantity": "1"}}
        quote = f.intents[0]["referenceQuote"]
        position = {"position_id": "lot-fixture", "sleeve": "quant", "instrument_id": "equity-0", "kind": "equity",
                    "underlying_id": "equity-0", "expiry_date": None, "quantity": "2", "unit_notional": "100",
                    "unit_greeks": {"delta": "1", "gamma": "0", "vega": "0", "theta": "0", "rho": "0"},
                    "valuation_at_ns": str(f.now - 2 * 10**9), "greek_observed_at_ns": str(f.now - 10**9),
                    "source_hash": quote["source"]["identity"]["contentHash"], "greek_model_id": "greek-fixture",
                    "greek_unit": "per-position-unit", "data_vintage_id": "vintage-fixture",
                    "cash_encumbered": "0", "maximum_loss": "200", "settled_quantity": "1",
                    "covered_shares_encumbered": {}}
        f.position_evidence.update(ledgerStateSha256=f.authority.digest(f.ledger.state), positions=[position])
        f.repin("position-config", f.position_evidence)
        f.build()
        self.assertEqual(f.resolve().positions, (position,))
        position["settled_quantity"] = "2"
        f.repin("position-config", f.position_evidence)
        f.build()
        with self.assertRaisesRegex(ExecutionError, "unsettled-shares"):
            f.resolve()
        position["settled_quantity"] = "1"
        position["unit_notional"] = "1"
        f.repin("position-config", f.position_evidence)
        f.build()
        with self.assertRaisesRegex(ExecutionError, "position-market-provenance-mismatch"):
            f.resolve()

    def test_omitted_owned_position_is_not_an_empty_portfolio_default(self):
        f = EvidenceFixture()
        f.ledger.state["positions"] = {"equity-0": "2"}
        f.position_evidence["ledgerStateSha256"] = f.authority.digest(f.ledger.state)
        f.repin("position-config", f.position_evidence)
        f.build()
        with self.assertRaisesRegex(ExecutionError, "position-quantity-mismatch"):
            f.resolve()

    def test_source_values_rechecked_even_with_a_valid_rehashed_source_pin(self):
        f = EvidenceFixture()
        item = next(a for a in f.selection["artifacts"] if a["bindingId"] == "equity-0-quote-config")
        config = f.cache.private(item["artifact"]["artifactId"], item["artifact"]["artifactSha256"])
        source = f.cache.private(config["sourceArtifact"]["artifactId"], config["sourceArtifact"]["artifactSha256"])
        source["ask"] = "1"
        config["sourceArtifact"] = f.cache.pin("different-source", "HostProviderObservation", source)
        quote = f.intents[0]["referenceQuote"]
        quote["source"]["identity"]["contentHash"] = config["sourceArtifact"]["artifactSha256"]
        config["quote"] = f.cache.pin("equity-0-quote-artifact", "Quote", quote, public=True)
        f.repin("equity-0-quote-config", config)
        intent, review, admission = f.intents[0], f.reviews[0], f.admissions[0]
        digest = f.authority.digest(intent)
        f.cache.pin(review["artifactId"], "TradeIntent", intent, public=True)
        review["artifactSha256"] = digest
        f.cache.pin(review["reviewId"], "AcceptedReview", review, public=True)
        admission.update(intentSha256=digest, reviewedArtifactSha256=digest)
        f.admission_authority.install(admission, review)
        f.build()
        with self.assertRaisesRegex(ExecutionError, "original-source-values-mismatch"):
            f.resolve()

    def test_nonzero_fee_rate_and_wrong_calendar_are_unavailable(self):
        for change in ("fee", "calendar"):
            f = EvidenceFixture()
            if change == "fee":
                f.simulation["models"][0]["fee_rate"] = "0.01"
                f.repin("sim-config", f.simulation)
            else:
                f.calendar["intervals"][0]["offset_seconds"] = 3600
                f.repin("calendar-config", f.calendar)
            with self.subTest(change=change), self.assertRaises(ExecutionError):
                f.build()

    def test_complete_option_schedule_roundtrip_and_missing_settlement_fail_closed(self):
        f = EvidenceFixture(2)
        f.intents, f.admissions, f.reviews = f.intents[:1], f.admissions[:1], f.reviews[:1]
        expiry = f.day + (86400 + 16 * 3600) * 10**9
        settlement = expiry + 86400 * 10**9
        f.calendar["intervals"][0]["end_ns"] = str(f.day + 5 * 86400 * 10**9)
        f.calendar["sessions"].append({"date": "2026-09-23", "tradable": True, "open_minute": 570,
                                      "close_minute": 960, "entry_cutoff_minute": 955})
        f.repin("calendar-config", f.calendar)
        f.policy["approved_calendars"] = [{"id": "calendar-fixture", "sha256": f.authority.digest(f.calendar)}]
        f.repin("calendar-policy-config", {"approved_calendars": f.policy["approved_calendars"]})
        instrument = f.instrument_configs[0]
        option = {"right": "call", "strike": "100", "expiry_date": "2026-09-23", "expiry_minute": 960,
                  "expiry_ns": str(expiry), "exercise_style": "american", "settlement": "physical",
                  "settlement_policy_id": "settlement-fixture", "settlement_at_ns": str(settlement),
                  "exercise_fee_per_contract": "0.01"}
        instrument["kernel"].update(kind="option", underlying_id="equity-1", multiplier="100", option=option)
        instrument["schedule"] = {"calendar_id": "calendar-fixture", "calendar_version": "2026a", "exchange_timezone": "Etc/UTC",
                                  "fixing_utc_offset_seconds": 0, "nominal_expiry_date": "2026-09-23", "effective_expiry_date": "2026-09-23",
                                  "closed_dates": [], "holiday_rule": "previous-business-day", "fixing_session": "PM",
                                  "last_trade_ns": str(expiry - 60 * 10**9), "fixing_ns": str(expiry),
                                  "exercise_cutoff_ns": str(expiry + 3600 * 10**9), "settlement_due_ns": str(settlement)}
        f.repin("equity-0-instrument", instrument)
        f.policy["approved_instruments"][0]["sha256"] = f.authority.digest(instrument["kernel"])
        f.repin("risk-fixture-config", f.policy)
        greek_pin = next(a["artifact"] for a in f.selection["artifacts"] if a["bindingId"] == "equity-0-greek-config")
        greek = f.cache.private(greek_pin["artifactId"], greek_pin["artifactSha256"])
        greek["observation"]["values"]["delta"] = "0.5"
        greek["observation"]["underlying_quote_id"] = "equity-1-quote"
        original = {"kind": "greeks", **{k: v for k, v in greek["observation"].items() if k != "source_hash"}}
        greek["sourceArtifact"] = f.cache.pin("option-greek-source", "HostProviderObservation", original)
        greek["observation"]["source_hash"] = greek["sourceArtifact"]["artifactSha256"]
        f.repin("equity-0-greek-config", greek)
        f.build()
        raw = f.recipe(f.resolve())
        command = f.decoder.decode(command_bytes=raw, submission_key="option-fixture", payload_sha256="e" * 64, now_ns=f.now)
        self.assertEqual(command.legs[0].instrument.option.schedule.settlement_due_ns, settlement)
        self.assertEqual(command.legs[0].instrument.option.deliverable_units, Decimal("100"))
        self.assertEqual(f.decoder.encode(command), raw)
        del option["settlement_at_ns"]
        f.repin("equity-0-instrument", instrument)
        f.policy["approved_instruments"][0]["sha256"] = f.authority.digest(instrument["kernel"])
        f.repin("risk-fixture-config", f.policy)
        with self.assertRaises(ExecutionError):
            f.build()
