"""Source-only native adapter regressions; deliberately NOT native conformance.

All artifacts, policies, quotes, positions and returns below are synthetic,
intentionally incomplete call-wiring records. NonConformanceAuthority is NOT a
replacement for vertex_contracts or public validation. No Rust bundle, engine,
broker, clock, files, network, subprocess or live account is used by this suite.
The compiled kernel/public-schema integration gate remains separately pending.
"""
from copy import deepcopy
from dataclasses import replace
import hashlib
import json
import unittest

from vertex_execution.exact import decimal, timestamp, units
from vertex_execution.native_risk import NativeRiskPort, QualifiedRiskInputs
from vertex_execution.ports import ExecutionError


class NonConformanceAuthority:
    """Explicit injection double: exercises Python defenses, never public parity."""

    def __init__(self):
        self.validation_result = True
        self.reject_name = None
        self.validations = []
        self.times = {timestamp(n): n for n in (50, 100, 150, 800, 900, 1000)}

    def validate(self, contract_name, value, schema_version="1.0.0"):
        self.validations.append((contract_name, deepcopy(value), schema_version))
        if contract_name == self.reject_name:
            return False
        return self.validation_result

    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, value):
        return hashlib.sha256(self.encode(value)).hexdigest()

    def epoch_ns(self, value):
        return self.times[value]


def total(values):
    return decimal(sum(units(value) for value in values))


def zero_greeks():
    return {name: "0" for name in ("delta", "gamma", "vega", "theta", "rho")}


class NonConformanceEvidence:
    """Trusted-resolver wiring double, not qualification/rights evidence."""

    def __init__(self, authority, policy, legs):
        self.authority = authority
        self.inputs = QualifiedRiskInputs(policy, tuple(legs), (), "e" * 64)
        self.verified = True
        self.calls = []
        self.command_result = None

    def resolve(self, **kwargs):
        self.calls.append(("resolve", deepcopy(kwargs)))
        return self.inputs

    def resolve_batch(self, **kwargs):
        self.calls.append(("resolve_batch", deepcopy(kwargs)))
        return self.inputs

    def verify(self, inputs, **kwargs):
        self.calls.append(("verify", deepcopy(kwargs)))
        return self.verified

    def _command(self, kind, **kwargs):
        self.calls.append((kind, deepcopy(kwargs)))
        if self.command_result is not None:
            return self.command_result
        return self.authority.encode({"nonConformanceFixture": True,
                                      "orderedIntents": kwargs["native_plan"]["reservation"]["proposal_hashes"]})

    def command(self, **kwargs):
        return self._command("command", **kwargs)

    def command_batch(self, **kwargs):
        return self._command("command_batch", **kwargs)


class NonConformanceEvaluator:
    """Pure bytes callable. Does not load, emulate, or establish Rust correctness."""

    def __init__(self, authority):
        self.authority = authority
        self.calls = []
        self.mutate = lambda value: None
        self.raw_override = None

    def __call__(self, raw):
        if not isinstance(raw, bytes):
            raise AssertionError("expected-bytes-not-runtime-handle")
        request = json.loads(raw)
        if self.authority.encode(request) != raw:
            raise AssertionError("request-not-canonical")
        self.calls.append(deepcopy(request))
        if self.raw_override is not None:
            return self.raw_override
        legs = [{"instrument_id": intent["instrumentId"], "intent_hash": self.authority.digest(intent),
                 "quantity": intent["quantity"], "limit_price": intent["limitPrice"],
                 "cash_reservation": "10", "cost_reservation": "1", "settlement_cash": "2",
                 "settlement_at_ns": None, "maximum_loss": "12", "gross_notional": "20",
                 "covered_shares": {}, "expiry_ns": None} for intent in request["intents"]]
        reservation = {"reservation_id": request["request_id"], "sleeve": request["strategy"]["sleeve"],
                       "strategy_artifact_id": request["strategy_artifact_id"],
                       "proposal_hashes": [leg["intent_hash"] for leg in legs],
                       "cash": total(leg["cash_reservation"] for leg in legs),
                       "maximum_loss": total(leg["maximum_loss"] for leg in legs),
                       "gross_notional": total(leg["gross_notional"] for leg in legs),
                       "covered_shares": {}, "greeks": {"low": zero_greeks(), "high": zero_greeks()},
                       "instrument_notionals": {leg["instrument_id"]: leg["gross_notional"] for leg in legs},
                       "expiry_notionals": {}, "position_slots": len(legs)}
        journal, policy = request["journal"], request["policy"]
        plan = {"request_id": request["request_id"], "account_alias": request["account_alias"],
                "mode": "PAPER-SIMULATION", "strategy_artifact_id": request["strategy_artifact_id"],
                "strategy_hash": self.authority.digest(request["strategy"]),
                "policy_id": policy["policy_id"], "policy_hash": self.authority.digest(policy),
                "cost_model_id": policy["costs"]["model_id"], "latency_model_id": policy["costs"]["latency_model_id"],
                "journal_id": journal["journal_id"], "journal_revision": journal["revision"],
                "journal_head_hash": journal["head_hash"], "owner_epoch": journal["owner_epoch"],
                "evaluated_at_ns": request["now_ns"], "expires_at_ns": "900", "reservation": reservation,
                "legs": legs, "live_authorization": False, "broker_submission_allowed": False}
        response = {"request_version": "vertex.execution-kernel.v1", "status": "admitted", "plan": plan,
                    "reasons": ["paper-reservation-plan-only"], "live_authorization": False,
                    "broker_submission_allowed": False}
        self.mutate(response)
        return self.authority.encode(response)


class NativeRiskPortTests(unittest.TestCase):
    def setUp(self):
        self.authority = NonConformanceAuthority()
        self.strategy = {"nonConformanceFixture": True, "sleeve": "quant", "strategyId": "fixture-strategy", "version": "1.0.0"}
        self.intents = tuple({"nonConformanceFixture": True, "intentId": f"intent-{n}", "idempotencyKey": f"intent-key-{n}",
                              "strategyVersion": "sealed-strategy-1", "accountAlias": "paper-fixture", "environment": "paper",
                              "instrumentId": f"stock-{n}", "side": "buy", "quantity": "1", "limitPrice": "7",
                              "proposalOnly": True, "executionAuthorized": False} for n in range(2))
        self.admissions = tuple({"nonConformanceFixture": True, "admissionId": f"admission-{n}",
                                 "idempotencyKey": f"admission-key-{n}", "intentSha256": self.authority.digest(intent),
                                 "strategyVersion": "sealed-strategy-1", "accountAlias": "paper-fixture",
                                 "environment": "paper", "mode": "PAPER-SIMULATION", "policyVersion": "1.0.0",
                                 "maximumLoss": "12", "maximumNotional": "20", "expiresAt": timestamp(1000),
                                 "liveAuthorization": False, "brokerSubmissionAllowed": False}
                                for n, intent in enumerate(self.intents))
        self.policy = {"policy_id": "policy-fixture", "version": "1.0.0", "strategy_artifact": {
                       "id": "sealed-strategy-1", "sha256": self.authority.digest(self.strategy)},
                       "costs": {"model_id": "cost-fixture", "latency_model_id": "latency-fixture"}}
        legs = [{"intent_hash": self.authority.digest(intent), "instrument": {"kind": "equity", "instrument_id": intent["instrumentId"]}}
                for intent in self.intents]
        self.evidence = NonConformanceEvidence(self.authority, self.policy, legs)
        self.evaluator = NonConformanceEvaluator(self.authority)
        self.port = NativeRiskPort(authority=self.authority, evaluate=self.evaluator, evidence=self.evidence, journal_id="local-journal-fixture")
        self.ledger = {"accountAlias": "paper-fixture", "environment": "paper", "currency": "USD", "ownerEpoch": "3",
                       "observation": {"observedNs": "150", "receivedNs": "150"}, "cash": "1000", "positions": {},
                       "unsettledPositions": {}, "orders": {}, "reconciled": True, "pausedNewRisk": False}
        self.sequence, self.head, self.now, self.key = 9, "a" * 64, 150, "batch-fixture"

    def assess(self):
        return self.port.assess_batch(batch_submission_key=self.key, intents=self.intents, admissions=self.admissions,
                                     strategy=self.strategy, ledger=self.ledger, ledger_sequence=self.sequence,
                                     ledger_sha256=self.head, now_ns=self.now)

    def assert_blocked_before_native(self, code):
        with self.assertRaisesRegex(ExecutionError, code):
            self.assess()
        self.assertEqual(self.evaluator.calls, [])

    def position(self, quantity="10", settled="10", instrument="stock-held", sleeve="fundamental"):
        return {"position_id": f"position-{sleeve}", "instrument_id": instrument, "kind": "equity",
                "underlying_id": instrument, "expiry_date": None, "sleeve": sleeve, "quantity": quantity,
                "settled_quantity": settled, "unit_notional": "20", "unit_greeks": {**zero_greeks(), "delta": "1"},
                "valuation_at_ns": "150", "greek_observed_at_ns": "150", "source_hash": "f" * 64,
                "greek_model_id": "equity-model", "greek_unit": "per-position-unit", "data_vintage_id": "fixture-vintage",
                "cash_encumbered": "0", "maximum_loss": "200", "covered_shares_encumbered": {}}

    def order(self, key, sleeve="wheel", *, status="accepted", state="held"):
        reservation = {"reservation_id": "untrusted-inner-alias", "sleeve": sleeve, "strategy_artifact_id": "other-sealed-strategy",
                       "proposal_hashes": ["b" * 64], "cash": "25", "maximum_loss": "40", "gross_notional": "100",
                       "covered_shares": {"stock-held": "2"}, "greeks": {"low": {**zero_greeks(), "delta": "-2"},
                       "high": zero_greeks()}, "instrument_notionals": {"other-option": "100"},
                       "expiry_notionals": {"2026-09-22": "100"}, "position_slots": 1}
        result = {"reservationState": state, "status": status, "cashReserve": "25", "shareReserve": {"stock-held": "2"},
                  "kernelReservation": reservation}
        self.ledger["orders"][key] = result
        return result

    def test_injected_pure_bytes_and_ordered_batch_evidence(self):
        plan = self.assess()
        self.assertEqual(len(self.evaluator.calls), 1)
        request = self.evaluator.calls[0]
        self.assertEqual(request["intents"], list(self.intents))
        self.assertEqual(request["now_ns"], "150")
        self.assertEqual(request["journal"]["source"], "local-execution-journal")
        self.assertEqual(request["journal"]["revision"], "9")
        self.assertEqual(request["journal"]["owner_epoch"], "3")
        self.assertEqual(plan.cash_reserve, "20")
        self.assertEqual(plan.maximum_loss, "24")
        self.assertEqual(plan.maximum_notional, "40")
        self.assertEqual(plan.legs, (("stock-0", "buy", "1"), ("stock-1", "buy", "1")))
        self.assertEqual([call[0] for call in self.evidence.calls], ["resolve_batch", "verify", "command_batch"])
        evidence = json.loads(plan.batch_evidence_bytes)
        self.assertEqual([leg["intentSha256"] for leg in evidence["orderedLegs"]], [self.authority.digest(i) for i in self.intents])
        self.assertEqual([leg["admissionSha256"] for leg in evidence["orderedLegs"]], [self.authority.digest(a) for a in self.admissions])
        self.assertEqual(evidence["commandSha256"], self.authority.digest(json.loads(plan.command_bytes)))
        self.assertEqual(json.loads(plan.kernel_reservation_bytes)["cash"], "20")

    def test_single_assess_selects_single_resolver_and_account_qualified_key(self):
        self.evidence.inputs = replace(self.evidence.inputs, legs=self.evidence.inputs.legs[:1])
        plan = self.port.assess(intent=self.intents[0], admission=self.admissions[0], strategy=self.strategy,
                                ledger=self.ledger, ledger_sequence=self.sequence, ledger_sha256=self.head, now_ns=self.now)
        expected = "submission-" + self.authority.digest({"accountAlias": "paper-fixture", "environment": "paper", "idempotencyKey": "admission-key-0"})
        self.assertEqual(self.evaluator.calls[0]["request_id"], expected)
        self.assertEqual([call[0] for call in self.evidence.calls], ["resolve", "verify", "command"])
        self.assertEqual(plan.legs, (("stock-0", "buy", "1"),))

    def test_native_evaluator_and_evidence_have_no_implicit_defaults(self):
        with self.assertRaises(TypeError):
            NativeRiskPort(authority=self.authority, evidence=self.evidence, journal_id="j")
        with self.assertRaises(TypeError):
            NativeRiskPort(authority=self.authority, evaluate=self.evaluator, journal_id="j")
        self.assertEqual(self.evaluator.calls, [])

    def test_entire_owned_position_set_not_only_current_sleeve_is_required(self):
        self.ledger["positions"] = {"stock-held": "10", "other-sleeve-stock": "3"}
        self.evidence.inputs = replace(self.evidence.inputs, positions=(self.position(),))
        self.assert_blocked_before_native("native-evidence-omits-owned-position")

    def test_positions_may_be_split_across_sleeves_but_not_omitted_or_duplicated(self):
        self.ledger["positions"] = {"stock-held": "10", "zero-position": "0"}
        rows = (self.position("4", "4", sleeve="fundamental"), self.position("6", "6", sleeve="swing"))
        self.evidence.inputs = replace(self.evidence.inputs, positions=rows)
        self.assess()
        self.assertEqual(self.evaluator.calls[0]["journal"]["positions"], list(rows))
        self.evaluator.calls.clear()
        self.evidence.inputs = replace(self.evidence.inputs, positions=(*rows, rows[0]))
        self.assert_blocked_before_native("native-evidence-omits-owned-position")

    def test_pending_equity_cannot_be_presented_as_settled_cover(self):
        self.ledger["positions"] = {"stock-held": "10"}
        self.ledger["unsettledPositions"] = {"fill-1": {"instrumentId": "stock-held", "quantity": "3"}}
        self.evidence.inputs = replace(self.evidence.inputs, positions=(self.position("10", "8"),))
        self.assert_blocked_before_native("native-evidence-spends-unsettled-shares")
        self.evidence.inputs = replace(self.evidence.inputs, positions=(self.position("10", "7"),))
        self.assess()
        self.assertEqual(self.evaluator.calls[0]["journal"]["positions"][0]["settled_quantity"], "7")

    def test_public_portfolio_snapshot_never_supplies_cash_or_missing_observation(self):
        self.ledger["PortfolioSnapshot"] = {"cash": "99999999", "positions": {}, "ready": True}
        self.assess()
        self.assertEqual(self.evaluator.calls[0]["journal"]["settled_cash"], "1000")
        self.evaluator.calls.clear()
        self.ledger["observation"] = None
        self.assert_blocked_before_native("owned-observation-required")

    def test_no_unsettled_credit_or_sleeve_allocation_is_added_to_cash(self):
        self.ledger["unsettledCash"] = {"sale-1": {"amount": "50000"}}
        self.ledger["sleeveAllocations"] = {"quant": "80000", "wheel": "80000"}
        self.assess()
        self.assertEqual(self.evaluator.calls[0]["journal"]["settled_cash"], "1000")

    def test_other_sleeve_reservation_greeks_and_exposure_survive_conversion(self):
        existing = self.order("other-reservation")
        self.order("released-reservation", state="released")
        before = deepcopy(existing)
        self.assess()
        reserved = self.evaluator.calls[0]["journal"]["reservations"]
        self.assertEqual(len(reserved), 1)
        self.assertEqual(reserved[0], {**before["kernelReservation"], "reservation_id": "other-reservation"})
        self.assertEqual(existing, before)

    def test_missing_or_drifting_native_reservation_is_not_reconstructed(self):
        for change in ("missing", "cash", "shares"):
            with self.subTest(change=change):
                self.ledger["orders"].clear()
                order = self.order("held")
                if change == "missing":
                    del order["kernelReservation"]
                    code = "owned-reservation-native-lineage-missing"
                else:
                    order["kernelReservation"]["cash" if change == "cash" else "covered_shares"] = "24" if change == "cash" else {}
                    code = "native-reservation-collateral-drift"
                self.assert_blocked_before_native(code)

    def test_dispatch_key_keeps_full_positions_and_all_reserves_for_native_exclusion(self):
        self.ledger["positions"] = {"stock-held": "10"}
        self.evidence.inputs = replace(self.evidence.inputs, positions=(self.position(),))
        self.order(self.key, sleeve="quant")
        self.order("other-reservation", status="unknown")
        self.ledger["dispatchReservationKey"] = self.key
        self.ledger["pausedNewRisk"] = True
        self.assess()
        request = self.evaluator.calls[0]
        self.assertEqual(request["dispatch_reservation_key"], self.key)
        self.assertEqual(len(request["journal"]["reservations"]), 2)
        self.assertEqual(len(request["journal"]["positions"]), 1)
        self.assertIs(request["journal"]["unknown_acceptance"], True)
        self.assertIs(request["journal"]["kill_new_risk"], True)

    def test_each_separately_reviewed_leg_limit_is_checked_without_package_netting(self):
        for field in ("maximumLoss", "maximumNotional"):
            with self.subTest(field=field):
                admissions = deepcopy(self.admissions)
                admissions[0][field] = "1000"
                admissions[1][field] = "11" if field == "maximumLoss" else "19"
                original = self.admissions
                self.admissions = admissions
                with self.assertRaisesRegex(ExecutionError, "native-leg-exceeds-separate-admission"):
                    self.assess()
                self.admissions = original
        self.assertFalse(any(call[0] == "command_batch" for call in self.evidence.calls))

    def test_ordered_intent_hashes_cannot_be_swapped_in_input_or_output(self):
        self.evidence.inputs = replace(self.evidence.inputs, legs=tuple(reversed(self.evidence.inputs.legs)))
        self.assert_blocked_before_native("every-package-leg-requires-exact-reviewed-admission")
        self.evidence.inputs = replace(self.evidence.inputs, legs=tuple(reversed(self.evidence.inputs.legs)))
        self.evaluator.mutate = lambda response: response["plan"]["legs"].reverse()
        with self.assertRaisesRegex(ExecutionError, "native-leg-exceeds-separate-admission"):
            self.assess()

    def test_review_strategy_policy_and_exact_public_validation_are_required(self):
        self.authority.validation_result = 1
        self.assert_blocked_before_native("native-artifact-validation-required")
        self.authority.validation_result = True
        for field, value in (("intentSha256", "b" * 64), ("strategyVersion", "latest"), ("policyVersion", "2.0.0")):
            original = self.admissions
            self.admissions = deepcopy(original)
            self.admissions[1][field] = value
            self.assert_blocked_before_native("batch-native-review-binding-mismatch")
            self.admissions = original
        self.evidence.verified = 1
        self.assert_blocked_before_native("qualified-native-input-evidence-unverified")

    def test_response_context_binds_every_account_strategy_policy_journal_and_clock_value(self):
        mismatches = {"request_id": "other", "account_alias": "other", "mode": "LIVE", "strategy_artifact_id": "latest",
                      "strategy_hash": "b" * 64, "policy_hash": "b" * 64, "journal_id": "other", "journal_revision": "8",
                      "journal_head_hash": "b" * 64, "owner_epoch": "2", "evaluated_at_ns": "149",
                      "live_authorization": True, "broker_submission_allowed": True}
        for field, value in mismatches.items():
            with self.subTest(field=field):
                self.evaluator.mutate = lambda response, field=field, value=value: response["plan"].__setitem__(field, value)
                with self.assertRaisesRegex(ExecutionError, "native-plan-context-mismatch"):
                    self.assess()
        self.assertFalse(any(call[0] == "command_batch" for call in self.evidence.calls))

    def test_wrong_native_policy_or_model_identity_is_rejected_not_relabelled(self):
        for field in ("policy_id", "cost_model_id", "latency_model_id"):
            with self.subTest(field=field):
                self.evaluator.mutate = lambda response, field=field: response["plan"].__setitem__(field, "wrong-model")
                with self.assertRaises(ExecutionError):
                    self.assess()

    def test_reservation_lineage_cannot_be_from_another_strategy_sleeve_or_order(self):
        for field, value in (("reservation_id", "other"), ("strategy_artifact_id", "other"), ("sleeve", "wheel"),
                             ("proposal_hashes", ["b" * 64]), ("cash", "1"), ("maximum_loss", "1"), ("gross_notional", "1")):
            with self.subTest(field=field):
                self.evaluator.mutate = lambda response, field=field, value=value: response["plan"]["reservation"].__setitem__(field, value)
                with self.assertRaises(ExecutionError):
                    self.assess()

    def test_limit_price_and_expired_plan_cannot_escape_kernel_response_binding(self):
        self.evaluator.mutate = lambda response: response["plan"]["legs"][0].__setitem__("limit_price", "8")
        with self.assertRaises(ExecutionError):
            self.assess()
        for expiry in ("149", "150"):
            self.evaluator.mutate = lambda response, expiry=expiry: response["plan"].__setitem__("expires_at_ns", expiry)
            with self.assertRaises(ExecutionError):
                self.assess()

    def test_plan_expiry_is_bounded_by_every_independent_admission(self):
        self.admissions[1]["expiresAt"] = timestamp(800)
        self.assertEqual(self.assess().valid_until_ns, 800)

    def test_noncanonical_or_authorizing_response_and_noncanonical_command_reject(self):
        for raw in (b"{} ", "not-bytes", b"x" * 2_000_001):
            self.evaluator.raw_override = raw
            with self.assertRaises(ExecutionError):
                self.assess()
        self.evaluator.raw_override = None
        for field in ("live_authorization", "broker_submission_allowed"):
            self.evaluator.mutate = lambda response, field=field: response.__setitem__(field, True)
            with self.assertRaisesRegex(ExecutionError, "native-risk-rejected"):
                self.assess()
        self.evaluator.mutate = lambda response: None
        self.evidence.command_result = b"{} "
        with self.assertRaisesRegex(ExecutionError, "qualified-simulator-command-not-canonical"):
            self.assess()

    def test_observation_receipt_is_not_mapped_before_its_source_timestamp(self):
        # Preserve actual source observation <= locally received/reconciled
        # ingestion <= now. Do not invert chronology to work around a kernel
        # readiness guard; both sides use the same declared meanings.
        self.ledger["observation"] = {"observedNs": "100", "receivedNs": "150"}
        self.assess()
        journal = self.evaluator.calls[0]["journal"]
        self.assertEqual(journal["observed_at_ns"], "100")
        self.assertEqual(journal["reconciled_at_ns"], "150")

    def test_each_leg_evidence_retains_exact_qualification_hash_and_native_metrics(self):
        plan = self.assess()
        for index, record in enumerate(json.loads(plan.batch_evidence_bytes)["orderedLegs"]):
            self.assertEqual(record["qualifiedLegSha256"], self.authority.digest(self.evidence.inputs.legs[index]))
            self.assertEqual(record["nativeLegPlan"]["instrument_id"], self.intents[index]["instrumentId"])
            self.assertEqual(record["nativeLegPlan"]["maximum_loss"], record["maximumLoss"])
            self.assertEqual(record["nativeLegPlan"]["cash_reservation"], record["cashReservation"])
            self.assertEqual(record["nativeLegPlan"]["settlement_cash"], record["settlementCash"])

    def test_invalid_native_leg_costs_and_nonpositive_risk_cannot_reduce_reserves(self):
        changes = (("maximum_loss", "0"), ("gross_notional", "-1"), ("cash_reservation", "-1"),
                   ("cost_reservation", "-1"), ("settlement_cash", "-1"),
                   ("cash_reservation", "2"))
        for field, value in changes:
            with self.subTest(field=field, value=value):
                self.evaluator.mutate = lambda response, field=field, value=value: response["plan"]["legs"][0].__setitem__(field, value)
                with self.assertRaisesRegex(ExecutionError, "native-leg-exceeds-separate-admission"):
                    self.assess()

    def test_separately_reviewed_batch_size_is_bounded_before_resolution(self):
        for intents, admissions in (((), ()), (self.intents, self.admissions[:1]),
                                    (self.intents * 5, self.admissions * 5)):
            with self.subTest(count=len(intents)):
                with self.assertRaisesRegex(ExecutionError, "bounded-reviewed-leg-set-required"):
                    self.port.assess_batch(batch_submission_key=self.key, intents=intents, admissions=admissions,
                                           strategy=self.strategy, ledger=self.ledger, ledger_sequence=self.sequence,
                                           ledger_sha256=self.head, now_ns=self.now)
        self.assertEqual(self.evidence.calls, [])
        self.assertEqual(self.evaluator.calls, [])
