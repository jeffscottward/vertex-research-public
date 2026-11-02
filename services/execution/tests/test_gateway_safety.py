"""Source-only paper gateway fence regressions; execution/acceptance pending.

Uses actual FencedExecutionSafetyPort/Journal/owner plus test-only stdlib
NON-CONFORMANCE authority from test_failure_matrix. No gateway executor, broker,
network session, native bundle generation, or production authority fallback.
A SafetyLease is not human recovery authorization and cannot authorize live IO.
"""
from __future__ import annotations

from dataclasses import replace
from unittest.mock import patch

from vertex_execution.gateway_safety import FencedExecutionSafetyPort
from vertex_execution.ports import ExecutionError
from vertex_gateway.models import (
    Environment,
    EvidenceState,
    GatewayProtocol,
    GatewayTarget,
    RecoveryBinding,
    RecoveryOperation,
)

from test_failure_matrix import EVIDENCE, INSTRUMENT, LATER, NOW, FixtureRisk, OwnerFixture


class BindingVerifier:
    """Local scripted attestation, NOT an authentication implementation."""

    def __init__(self):
        self.answer = True
        self.expected_status = "status-current"
        self.calls = []

    def verify_binding(self, binding, **scope):
        self.calls.append((binding, dict(scope)))
        if (binding.expected_status_id != self.expected_status
                or binding.target.gateway_id != "paper-gateway"
                or binding.target.account_ref != "acctref-" + "b" * 64
                or binding.target.protocol is not GatewayProtocol.TWS_SOCKET
                or scope["account_alias"] != "paper-account"
                or scope["environment"] != "paper"):
            return False
        return self.answer


class DirectionalFixtureRisk(FixtureRisk):
    """Allows a local buy/sell round trip to expose unsettled obligations."""

    def __init__(self, authority):
        super().__init__(authority)
        self.side = "buy"
        self.cash_reserve = "10"

    def assess(self, **request):
        plan = super().assess(**request)
        return replace(plan, legs=tuple((instrument, self.side, quantity)
                                       for instrument, _, quantity in plan.legs))


class GatewaySafetyTests(OwnerFixture):
    def observation(self, **changes):
        if self.journal.state["observation"] is None and "positions" not in changes:
            changes["positions"] = ()
        return super().observation(**changes)

    def setUp(self):
        super().setUp()
        self.clock = NOW
        self.verifier = BindingVerifier()
        self.risk = DirectionalFixtureRisk(self.authority)
        self.owner.risk = self.risk
        self.guard = FencedExecutionSafetyPort(
            self.owner, clock_ns=lambda: self.clock, verifier=self.verifier,
            maximum_lease_ns=1_000_000,
        )

    def binding(self, **changes):
        target = GatewayTarget("paper-gateway", "acctref-" + "b" * 64,
                               Environment.PAPER, GatewayProtocol.TWS_SOCKET)
        binding = RecoveryBinding(
            target=target, operation=RecoveryOperation.RESTART_GATEWAY,
            request_id="recovery-request", idempotency_key="recovery-once",
            expected_status_id="status-current", actor_id="operator-1",
            challenge_id="human-approved-challenge", requested_ns=NOW,
            confirmed_ns=NOW, expires_ns=NOW + 2_000_000,
            request_digest="c" * 64,
        )
        return replace(binding, **changes)

    def assert_hold_denied_without_transport(self, reason, binding=None):
        before = (list(self.transport.submit_calls), list(self.transport.cancel_calls),
                  list(self.transport.reconcile_calls))
        with self.assertRaisesRegex(ExecutionError, reason):
            with self.guard.hold(binding or self.binding()):
                self.fail("denied disruption unexpectedly yielded a lease")
        self.assertEqual((self.transport.submit_calls, self.transport.cancel_calls,
                          self.transport.reconcile_calls), before)
        self.assertIsNone(self.guard._active)
        self.assertFalse(self.owner._disruption_held)

    def completed_round_trip(self):
        buy = self.admit("buy", intent_changes={"quantity": "1"})
        self.owner.dispatch_once(buy, now_ns=NOW)
        self.owner.ingest(self.fill(buy, "buy-fill", cash_delta="-10", fee="0"), received_ns=NOW)
        self.transport.reconciliation = self.reconciliation(buy, terminal=True, finality=True)
        self.assertTrue(self.owner.reconcile_order(buy, now_ns=NOW))
        self.owner.observe(self.observation(), now_ns=NOW)
        self.refresh_review_checkpoint()
        self.risk.side = "sell"
        sell = self.admit("sell", intent_changes={"quantity": "1"})
        self.owner.dispatch_once(sell, now_ns=NOW)
        self.owner.ingest(self.fill(sell, "sell-fill", cash_delta="10", fee="0"), received_ns=NOW)
        self.transport.reconciliation = self.reconciliation(sell, terminal=True, finality=True)
        self.assertTrue(self.owner.reconcile_order(sell, now_ns=NOW))
        self.owner.observe(self.observation(), now_ns=NOW)
        self.assertEqual(self.journal.state["positions"][INSTRUMENT], "0")
        self.assertTrue(all(order["finalityProven"] and order["reservationState"] == "released"
                            for order in self.journal.state["orders"].values()))
        return buy + ":buy-fill", sell + ":sell-fill"

    def settle_fixture_trade(self, fill_key, identifier):
        # Trusted journal input only, not a public authorization or settlement
        # policy test. The guard must inspect remaining unsettled maps exactly.
        self.journal.append("trade-settled", {"fillKeys": [fill_key], "evidenceSha256": EVIDENCE,
                                            "cashDelta": self.journal.state["unsettledCredits"].get(fill_key, "0")},
                            now_ns=NOW, event_id=identifier)
        self.owner.observe(self.observation(), now_ns=NOW)

    def test_explicit_positive_lease_policy_required(self):
        for value in (0, -1, True, 1.0, None):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ExecutionError, "explicit-disruption-lease-policy-required"):
                    FencedExecutionSafetyPort(self.owner, clock_ns=lambda: NOW,
                                              verifier=self.verifier, maximum_lease_ns=value)

    def test_live_target_and_unsupported_operation_reject_before_durable_pause(self):
        valid = self.binding()
        for binding in (
            replace(valid, target=replace(valid.target, environment=Environment.LIVE)),
            replace(valid, operation=RecoveryOperation.HUMAN_HANDOFF),
        ):
            with self.subTest(binding=binding.operation):
                before = self.state_and_counts()
                self.assert_hold_denied_without_transport("disruption-scope-or-expiry-invalid", binding)
                self.assertEqual(self.state_and_counts(), before)
        self.assertEqual(self.verifier.calls, [])

    def test_expired_or_not_yet_confirmed_binding_rejects_before_pause(self):
        for binding in (self.binding(expires_ns=NOW), self.binding(confirmed_ns=NOW + 1)):
            before = self.state_and_counts()
            self.assert_hold_denied_without_transport("disruption-scope-or-expiry-invalid", binding)
            self.assertEqual(self.state_and_counts(), before)
        self.assertEqual(self.verifier.calls, [])

    def test_open_reserved_order_denies_even_when_positions_are_empty(self):
        self.admit()
        self.assertEqual(self.journal.state["positions"], {})
        self.assert_hold_denied_without_transport("disruption-has-unresolved-protection-obligations")
        self.assertEqual(self.verifier.calls, [])

    def test_unknown_acceptance_denies_even_when_positions_are_empty(self):
        key = self.admit()
        self.transport.timeout_after_acceptance = True
        with self.assertRaisesRegex(ExecutionError, "simulation-outcome-unknown-no-resubmit"):
            self.owner.dispatch_once(key, now_ns=NOW)
        self.assertEqual(self.journal.state["positions"], {})
        self.assertEqual(self.order(key)["status"], "unknown")
        self.assert_hold_denied_without_transport("disruption-has-unresolved-protection-obligations")
        self.assertEqual(len(self.transport.submit_calls), 1)

    def test_position_exposure_is_not_vacuous_protection(self):
        key = self.admit(intent_changes={"quantity": "1"})
        self.owner.dispatch_once(key, now_ns=NOW)
        self.owner.ingest(self.fill(key, "position-fill", fee="0"), received_ns=NOW)
        self.transport.reconciliation = self.reconciliation(key, terminal=True, finality=True)
        self.owner.reconcile_order(key, now_ns=NOW)
        self.settle_fixture_trade(key + ":position-fill", "settle-position")
        self.assertEqual(self.journal.state["positions"][INSTRUMENT], "1")
        self.assertEqual(self.journal.state["unsettledPositions"], {})
        self.assertEqual(self.order(key)["reservationState"], "released")
        self.assert_hold_denied_without_transport("disruption-has-unresolved-protection-obligations")

    def test_zero_position_unsettled_cash_credit_denies_disruption(self):
        buy_fill, _ = self.completed_round_trip()
        self.settle_fixture_trade(buy_fill, "settle-buy-only")
        self.assertEqual(self.journal.state["positions"][INSTRUMENT], "0")
        self.assertEqual(self.journal.state["unsettledPositions"], {})
        self.assertTrue(self.journal.state["unsettledCredits"])
        self.assert_hold_denied_without_transport("disruption-has-unresolved-protection-obligations")

    def test_zero_position_unsettled_share_delivery_denies_disruption(self):
        _, sell_fill = self.completed_round_trip()
        self.settle_fixture_trade(sell_fill, "settle-sell-only")
        self.assertEqual(self.journal.state["positions"][INSTRUMENT], "0")
        self.assertEqual(self.journal.state["unsettledCredits"], {})
        self.assertTrue(self.journal.state["unsettledPositions"])
        self.assert_hold_denied_without_transport("disruption-has-unresolved-protection-obligations")

    def test_cancel_receipt_without_finality_is_not_protection_continuity(self):
        key = self.admit()
        self.owner.dispatch_once(key, now_ns=NOW)
        self.owner.cancel_simulation(key, self.grant("cancel-simulation", key), now_ns=NOW)
        self.assertEqual(self.order(key)["status"], "cancelled")
        self.assertFalse(self.order(key)["finalityProven"])
        self.assert_hold_denied_without_transport("disruption-has-unresolved-protection-obligations")

    def test_unreconciled_restart_and_invalid_qualification_deny_disruption(self):
        self.restart()
        self.guard = FencedExecutionSafetyPort(self.owner, clock_ns=lambda: NOW,
                                               verifier=self.verifier, maximum_lease_ns=1_000_000)
        self.owner.observe(self.observation(), now_ns=NOW)
        self.assert_hold_denied_without_transport("disruption-has-unresolved-protection-obligations")
        self.owner.finish_reconciliation(now_ns=NOW)
        self.owner.invalidate_qualification(INSTRUMENT, "d" * 64, now_ns=NOW)
        self.assert_hold_denied_without_transport("disruption-has-unresolved-protection-obligations")
        self.assertEqual(self.verifier.calls, [])

    def test_stale_observation_denies_even_with_no_positions_or_orders(self):
        self.clock = LATER
        before = self.state_and_counts()
        binding = self.binding(confirmed_ns=LATER, expires_ns=LATER + 1_000_000)
        self.assert_hold_denied_without_transport("qualified-observation-not-current", binding)
        self.assertEqual(self.state_and_counts(), before)

    def test_expected_status_and_opaque_account_mapping_are_verified_under_pause(self):
        valid = self.binding()
        for binding in (
            replace(valid, expected_status_id="stale-status"),
            replace(valid, target=replace(valid.target, account_ref="acctref-" + "e" * 64)),
            replace(valid, target=replace(valid.target, gateway_id="other-gateway")),
            replace(valid, target=replace(valid.target, protocol=GatewayProtocol.CLIENT_PORTAL_HTTP)),
        ):
            with self.subTest(expected_status=binding.expected_status_id, target=binding.target.gateway_id):
                self.assert_hold_denied_without_transport("gateway-binding-not-current-under-fence", binding)
                self.assertTrue(self.journal.state["pausedNewRisk"])
                observed, scope = self.verifier.calls[-1]
                self.assertEqual(observed, binding)
                self.assertEqual(scope["owner_epoch"], self.owner.epoch)
                self.assertEqual(scope["journal_sequence"], self.journal.sequence)
                self.assertEqual(scope["account_alias"], "paper-account")
                self.assertEqual(scope["environment"], "paper")
                self.assertEqual(scope["now_ns"], NOW)

    def test_binding_verifier_must_return_true_not_truthy_or_unknown(self):
        for answer in (False, None, 1, "yes", EvidenceState.YES):
            with self.subTest(answer=answer):
                self.verifier.answer = answer
                self.assert_hold_denied_without_transport("gateway-binding-not-current-under-fence")
                self.assertTrue(self.journal.state["pausedNewRisk"])
        self.verifier.answer = True
        with self.guard.hold(self.binding()) as lease:
            self.assertTrue(self.guard.lease_valid(self.binding(), lease))

    def test_successful_lease_fences_mutations_and_never_resets_or_calls_transport(self):
        binding = self.binding()
        with patch.object(self.transport, "submit", side_effect=AssertionError("no broker/transport")), \
             patch.object(self.transport, "cancel", side_effect=AssertionError("no broker/transport")), \
             patch.object(self.transport, "reconcile", side_effect=AssertionError("no broker/transport")), \
             patch.object(self.owner, "reset_new_risk", side_effect=AssertionError("guard cannot reset")):
            with self.guard.hold(binding) as lease:
                self.assertTrue(self.owner._disruption_held)
                self.assertTrue(self.journal._db().in_transaction)
                self.assertTrue(self.journal.state["pausedNewRisk"])
                self.assertTrue(self.guard.lease_valid(binding, lease))
                with self.assertRaisesRegex(ExecutionError, "owner-fenced-for-disruption"):
                    self.owner.observe(self.observation(), now_ns=NOW)
                with self.assertRaisesRegex(ExecutionError, "disruption-lease-already-held"):
                    with self.guard.hold(binding):
                        self.fail("nested disruption hold unexpectedly succeeded")
                with self.assertRaisesRegex(ExecutionError, "owner-fenced-for-disruption"):
                    self.owner.request_liquidation(self.grant("request-liquidation"), now_ns=NOW)
            self.assertFalse(self.owner._disruption_held)
            self.assertFalse(self.journal._db().in_transaction)
            self.assertFalse(self.guard.lease_valid(binding, lease))
            self.assertTrue(self.journal.state["pausedNewRisk"])
            self.assertEqual(self.journal.state["liquidationRequests"], [])
        self.assertEqual(self.transport.submit_calls, [])
        self.assertEqual(self.transport.cancel_calls, [])
        self.assertEqual(self.transport.reconcile_calls, [])

    def test_context_failure_releases_lease_but_preserves_durable_pause(self):
        binding = self.binding()
        with self.assertRaisesRegex(RuntimeError, "simulated recovery failure"):
            with self.guard.hold(binding) as lease:
                self.assertTrue(self.guard.lease_valid(binding, lease))
                raise RuntimeError("simulated recovery failure")
        self.assertFalse(self.guard.lease_valid(binding, lease))
        self.assertFalse(self.owner._disruption_held)
        self.assertFalse(self.journal._db().in_transaction)
        self.assertTrue(self.journal.state["pausedNewRisk"])
        reopened_pause = self.journal.snapshot()
        self.journal.close()
        replayed = self.open_journal()
        self.assertEqual(replayed.snapshot(), reopened_pause)
        self.assertIn("gateway-disruption-fence", replayed.state["pauseReasons"])

    def test_lease_expiry_is_minimum_of_binding_policy_and_observation(self):
        for binding_lifetime, policy_lifetime, observation_lifetime in (
            (900, 500, 700), (200, 500, 700), (900, 500, 100),
        ):
            with self.subTest(lifetimes=(binding_lifetime, policy_lifetime, observation_lifetime)):
                self.clock = NOW
                self.owner.observe(self.observation(valid_until_ns=NOW + observation_lifetime), now_ns=NOW)
                guard = FencedExecutionSafetyPort(self.owner, clock_ns=lambda: self.clock,
                                                  verifier=self.verifier, maximum_lease_ns=policy_lifetime)
                binding = self.binding(expires_ns=NOW + binding_lifetime)
                with guard.hold(binding) as lease:
                    self.assertEqual(lease.expires_ns, NOW + min(binding_lifetime, policy_lifetime, observation_lifetime))
                    self.clock = lease.expires_ns - 1
                    self.assertTrue(guard.lease_valid(binding, lease))
                    self.clock = lease.expires_ns
                    self.assertFalse(guard.lease_valid(binding, lease))
                    self.assertTrue(self.journal.state["pausedNewRisk"])
                self.assertFalse(guard.lease_valid(binding, lease))
                self.assertTrue(self.journal.state["pausedNewRisk"])

    def test_changed_binding_or_nonpositive_lease_evidence_denies(self):
        binding = self.binding()
        with self.guard.hold(binding) as lease:
            self.assertFalse(self.guard.lease_valid(replace(binding, expected_status_id="other-status"), lease))
            self.assertFalse(self.guard.lease_valid(binding, replace(lease, disruption_safe=EvidenceState.NO)))
            self.assertFalse(self.guard.lease_valid(binding, replace(lease, protection_continuity_proven=EvidenceState.UNKNOWN)))
            self.assertFalse(self.guard.lease_valid(binding, replace(lease, expires_ns=lease.expires_ns + 1)))

    def test_prior_context_lease_cannot_be_reused_during_later_hold(self):
        binding = self.binding()
        with self.guard.hold(binding) as first:
            self.assertTrue(self.guard.lease_valid(binding, first))
        self.assertFalse(self.guard.lease_valid(binding, first))
        with self.guard.hold(binding) as second:
            self.assertNotEqual(first.guard_ref, second.guard_ref)
            self.assertEqual(first.expires_ns, second.expires_ns)
            self.assertFalse(self.guard.lease_valid(binding, first))
            self.assertTrue(self.guard.lease_valid(binding, second))
        self.assertTrue(self.journal.state["pausedNewRisk"])

    def test_read_only_rescan_is_still_fenced_and_requires_current_binding(self):
        binding = self.binding(operation=RecoveryOperation.RESCAN_READ_ONLY)
        with self.guard.hold(binding) as lease:
            self.assertTrue(self.guard.lease_valid(binding, lease))
            self.assertTrue(self.journal.state["pausedNewRisk"])
        self.assertFalse(self.guard.lease_valid(binding, lease))
        self.assertTrue(self.journal.state["pausedNewRisk"])
        self.assertEqual(self.transport.submit_calls, [])
