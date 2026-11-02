"""Offline regression specifications; no broker, network, or wall-clock fixtures."""
from dataclasses import replace
from decimal import Decimal, localcontext
import unittest

from vertex_execution.simulator import (
    AcceptanceResolution,
    AdmittedLimits,
    BookLevel,
    CancelAuthorization,
    DepthSnapshot,
    PaperSimulator,
    QualifiedInstrument,
    QualifiedLeg,
    SessionModel,
    SimulationBounds,
    SubmitCommand,
)

D = Decimal
PAYLOAD = "a" * 64


def instrument(identity="ABC"):
    return QualifiedInstrument(identity, identity, "2026-09-22:regular", "USD", "equity", D("0.01"), D("1"), D("1"), "qualification:" + identity)


def model(identity="ABC", **changes):
    value = SessionModel(
        model_id="model:" + identity,
        instrument_id=identity,
        symbol=identity,
        session_id="2026-09-22:regular",
        session_open_ns=100,
        session_close_ns=10000,
        submit_latency_ns=10,
        cancel_latency_ns=20,
        quote_ttl_ns=1000,
        participation_rate=D("0.25"),
        depth_fraction=D("0.5"),
        maximum_fill_quantity=D("20"),
        fee_per_unit=D("0.1"),
        fee_rate=D("0.001"),
        minimum_fee=D("0.25"),
        slippage_bps=D("0"),
        slippage_ticks=1,
    )
    return replace(value, **changes)


def command(key="order-1", identity="ABC", **changes):
    leg = QualifiedLeg("leg:" + identity, instrument(identity), "buy", D("1"), D("10.10"), "model:" + identity)
    value = SubmitCommand(key, PAYLOAD, (leg,), D("10"), AdmittedLimits(D("10"), D("1000"), D("100"), D("10"), 100, 9500), "immutable-strategy-artifact:1", "risk-policy:1", 100, 9000)
    return replace(value, **changes)


def depth(identity="ABC", at=110, sequence=1, quantity="20", volume="40", ask="10.00", bid="9.90"):
    return DepthSnapshot(identity, identity, "2026-09-22:regular", at, sequence, (BookLevel(D(bid), D(quantity)),), (BookLevel(D(ask), D(quantity)),), D(volume))


def cancel_authorization(value):
    return CancelAuthorization(value.submission_key, value.payload_hash, value.policy_id, 9500, True)


def engine(*models, **kwargs):
    return PaperSimulator(models or (model(),), provenance_id="journal-stream:epoch-1", **kwargs)


class PaperSimulatorTests(unittest.TestCase):
    def test_latency_depth_participation_adverse_price_and_exact_fees(self):
        simulator = engine()
        accepted = simulator.submit(command())
        self.assertEqual(accepted[0].status, "accepted")
        self.assertFalse(accepted[0].final)
        self.assertEqual(simulator.advance((depth(at=105),), 105), ())
        events = simulator.advance((), 110)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].quantity, D("10"))
        self.assertEqual(events[0].price, D("10.01"))
        self.assertEqual(events[0].fee, D("1.10010"))
        self.assertEqual(events[0].status, "filled")
        self.assertTrue(events[0].final)
        self.assertEqual(events[0].payload_hash, PAYLOAD)
        self.assertIsNotNone(events[0].fill_id)

    def test_depth_is_shared_across_orders_not_regenerated(self):
        simulator = engine()
        simulator.submit(command("first"))
        simulator.submit(command("second"))
        simulator.advance((depth(),), 110)
        self.assertEqual(simulator.reconcile("first").cumulative_fills[0].quantity, D("10"))
        self.assertEqual(simulator.reconcile("second").cumulative_fills[0].quantity, D("0"))
        self.assertEqual(simulator.advance((depth(),), 120), ())
        self.assertEqual(simulator.advance((), 121), ())

    def test_snapshot_depth_fraction_is_a_real_cap(self):
        simulator = engine()
        simulator.submit(command())
        events = simulator.advance((depth(quantity="4", volume="100"),), 110)
        self.assertEqual(events[0].quantity, D("2"))
        self.assertEqual(events[0].status, "partial-fill")
        self.assertFalse(events[0].final)
        self.assertEqual(simulator.advance((), 111), ())

    def test_incremental_volume_and_maximum_snapshot_fill_are_both_caps(self):
        for volume, cap, expected in (("4", "20", "1"), ("100", "3", "3"), ("0", "20", "0")):
            with self.subTest(volume=volume):
                simulator = engine(model(maximum_fill_quantity=D(cap)))
                simulator.submit(command())
                simulator.advance((depth(quantity="100", volume=volume),), 110)
                self.assertEqual(simulator.reconcile("order-1").cumulative_fills[0].quantity, D(expected))

    def test_sweeps_bounded_levels_at_different_nonperfect_prices(self):
        simulator = engine(model(participation_rate=D("1"), depth_fraction=D("1")))
        simulator.submit(command())
        book = replace(depth(volume="20"), asks=(BookLevel(D("10"), D("2")), BookLevel(D("10.05"), D("3")), BookLevel(D("10.11"), D("50"))))
        fills = simulator.advance((book,), 110)
        self.assertEqual(tuple((e.quantity, e.price) for e in fills), ((D("2"), D("10.01")), (D("3"), D("10.06"))))
        self.assertEqual(len({event.event_id for event in fills}), 2)
        self.assertEqual(len({event.fill_id for event in fills}), 2)

    def test_adverse_slippage_must_remain_marketable(self):
        simulator = engine()
        value = command()
        value = replace(value, legs=(replace(value.legs[0], limit_price=D("10.00")),))
        simulator.submit(value)
        self.assertEqual(simulator.advance((depth(),), 110), ())
        self.assertEqual(simulator.reconcile(value.submission_key).status, "accepted")

    def test_sell_uses_bids_and_rounds_adversely(self):
        simulator = engine(model(slippage_bps=D("1")))
        value = command()
        value = replace(value, legs=(replace(value.legs[0], side="sell", limit_price=D("9.80")),))
        simulator.submit(value)
        event = simulator.advance((depth(),), 110)[0]
        self.assertEqual(event.price, D("9.88"))
        self.assertLess(event.price, D("9.90"))

    def test_gross_notional_admission_caps_quantity(self):
        simulator = engine()
        value = command()
        simulator.submit(replace(value, admitted_limits=replace(value.admitted_limits, maximum_gross_notional=D("30.03"))))
        events = simulator.advance((depth(),), 110)
        self.assertEqual(events[0].quantity, D("3"))
        self.assertEqual(events[0].cumulative_fills[0].gross_notional, D("30.03"))

    def test_fee_budget_caps_fills_including_minimum_fee(self):
        for budget, expected in (("0.24", "0"), ("0.25", "2"), ("0.33003", "3")):
            with self.subTest(budget=budget):
                simulator = engine()
                value = command()
                simulator.submit(replace(value, admitted_limits=replace(value.admitted_limits, maximum_total_fees=D(budget))))
                simulator.advance((depth(),), 110)
                total = simulator.reconcile(value.submission_key).cumulative_fills[0]
                self.assertEqual(total.quantity, D(expected))
                self.assertLessEqual(total.fees, D(budget))

    def test_stale_book_cannot_fill_after_latency(self):
        simulator = engine(model(submit_latency_ns=100, quote_ttl_ns=5))
        simulator.submit(command())
        simulator.advance((depth(),), 110)
        self.assertEqual(simulator.advance((), 200), ())
        self.assertEqual(simulator.reconcile("order-1").cumulative_fills[0].quantity, D("0"))

    def test_cancel_pending_keeps_reservation_and_racing_fills(self):
        simulator = engine()
        value = command()
        simulator.submit(value)
        simulator.advance((depth(quantity="4"),), 110)
        pending = simulator.cancel(value.submission_key, cancel_authorization(value), 120)
        self.assertEqual(pending[0].reason, "cancel-pending")
        self.assertFalse(pending[0].final)
        simulator.advance((depth(at=130, sequence=2, quantity="4"),), 130)
        events = simulator.advance((depth(at=140, sequence=3),), 140)
        self.assertEqual(events[0].status, "cancelled")
        self.assertTrue(events[0].final)
        result = simulator.reconcile(value.submission_key)
        self.assertTrue(result.authoritative)
        self.assertTrue(result.final)
        self.assertEqual(result.cumulative_fills[0].quantity, D("4"))
        self.assertEqual(result.events[-1].cumulative_fills, result.cumulative_fills)
        self.assertEqual(simulator.advance((depth(at=150, sequence=4),), 150), ())

    def test_zero_latency_cancel_is_not_final_until_causal_advance(self):
        simulator = engine(model(cancel_latency_ns=0))
        value = command()
        simulator.submit(value)
        self.assertFalse(simulator.cancel(value.submission_key, cancel_authorization(value), 105)[0].final)
        self.assertTrue(simulator.advance((), 105)[0].final)
        self.assertEqual(simulator.reconcile(value.submission_key).status, "cancelled")

    def test_cancel_requires_exact_nonexpired_authorization(self):
        simulator = engine()
        value = command()
        simulator.submit(value)
        authority = cancel_authorization(value)
        for bad in (replace(authority, allowed=False), replace(authority, payload_hash="b" * 64), replace(authority, policy_id="other"), replace(authority, valid_until_ns=110)):
            with self.subTest(authority=bad), self.assertRaises(ValueError):
                simulator.cancel(value.submission_key, bad, 110)
        self.assertEqual(len(simulator.reconcile(value.submission_key).events), 1)

    def test_unknown_acceptance_never_fills_expires_or_resubmits_itself(self):
        simulator = engine(model(acceptance="unknown"))
        value = command()
        initial = simulator.submit(value)
        self.assertEqual(initial[0].status, "unknown")
        simulator.advance((depth(),), 110)
        simulator.cancel(value.submission_key, cancel_authorization(value), 120)
        simulator.advance((), 9010)
        result = simulator.reconcile(value.submission_key)
        self.assertEqual(result.status, "unknown")
        self.assertFalse(result.final)
        self.assertFalse(result.authoritative)
        self.assertEqual(result.cumulative_fills[0].quantity, D("0"))
        self.assertEqual(simulator.submit(value), result.events)
        resolved = simulator.advance((AcceptanceResolution(value.submission_key, PAYLOAD, 9010, "accepted", "resolution:1"),), 9010)
        self.assertEqual(tuple(e.status for e in resolved), ("accepted", "cancelled"))
        self.assertTrue(simulator.reconcile(value.submission_key).final)

    def test_unknown_rejection_and_conflicting_resolution(self):
        simulator = engine(model(acceptance="unknown"))
        value = command()
        simulator.submit(value)
        resolution = AcceptanceResolution(value.submission_key, PAYLOAD, 110, "rejected", "resolution:1")
        self.assertEqual(simulator.advance((resolution,), 110)[0].status, "rejected")
        self.assertEqual(simulator.advance((resolution,), 120), ())
        before = simulator.snapshot()
        with self.assertRaises(ValueError):
            simulator.advance((replace(resolution, outcome="accepted", observed_at_ns=120),), 120)
        self.assertEqual(simulator.snapshot(), before)

    def test_fresh_empty_engine_does_not_claim_safe_absence(self):
        result = engine().reconcile("dispatched-before-crash")
        self.assertEqual(result.status, "unknown")
        self.assertFalse(result.final)
        self.assertFalse(result.authoritative)
        self.assertIsNone(result.payload_hash)
        self.assertIn("retain-reservation", result.reason)

    def test_multileg_imbalance_caps_and_timeout_preserve_unhedged_fill(self):
        simulator = engine(model("ABC"), model("XYZ"))
        value = command()
        second = QualifiedLeg("leg:XYZ", instrument("XYZ"), "sell", D("2"), D("9.80"), "model:XYZ")
        value = replace(value, legs=value.legs + (second,), admitted_limits=replace(value.admitted_limits, maximum_legging_quantity=D("1"), maximum_legging_ns=50))
        simulator.submit(value)
        events = simulator.advance((depth(),), 110)
        self.assertEqual(events[0].quantity, D("1"))
        self.assertTrue(events[0].legging_risk)
        self.assertEqual(simulator.advance((), 159), ())
        events = simulator.advance((), 160)
        self.assertEqual(events[0].reason, "legging-timeout")
        self.assertTrue(events[0].final)
        self.assertTrue(events[0].legging_risk)
        self.assertEqual(tuple(t.quantity for t in events[0].cumulative_fills), (D("1"), D("0")))

    def test_multileg_matching_hedge_clears_legging_risk(self):
        simulator = engine(model("ABC"), model("XYZ"))
        value = command(maximum_quantity=D("1"))
        second = QualifiedLeg("leg:XYZ", instrument("XYZ"), "sell", D("2"), D("9.80"), "model:XYZ")
        value = replace(value, legs=value.legs + (second,))
        simulator.submit(value)
        simulator.advance((depth(), depth("XYZ", at=111)), 111)
        result = simulator.reconcile(value.submission_key)
        self.assertEqual(tuple(t.quantity for t in result.cumulative_fills), (D("1"), D("2")))
        self.assertEqual(result.status, "filled")
        self.assertFalse(result.events[-1].legging_risk)

    def test_same_clock_empty_or_replayed_advance_cannot_ratchet_multileg_fills(self):
        simulator = engine(model("ABC"), model("XYZ"))
        value = command()
        second = QualifiedLeg("leg:XYZ", instrument("XYZ"), "sell", D("1"), D("9.80"), "model:XYZ")
        value = replace(value, legs=value.legs + (second,), admitted_limits=replace(value.admitted_limits, maximum_legging_quantity=D("1")))
        simulator.submit(value)
        books = (depth(), depth("XYZ"))
        simulator.advance(books, 110)
        before = simulator.snapshot()
        self.assertEqual(simulator.advance((), 110), ())
        self.assertEqual(simulator.advance(books, 110), ())
        self.assertEqual(simulator.snapshot(), before)

    def test_immutable_idempotency_and_conflict(self):
        simulator = engine()
        value = command()
        first = simulator.submit(value)
        self.assertEqual(simulator.submit(value), first)
        before = simulator.snapshot()
        for altered in (replace(value, payload_hash="b" * 64), replace(value, strategy_artifact_id="new-artifact"), replace(value, maximum_quantity=D("9"))):
            with self.assertRaises(ValueError):
                simulator.submit(altered)
        self.assertEqual(simulator.snapshot(), before)

    def test_exact_symbol_session_model_is_mandatory(self):
        simulator = engine()
        value = command()
        bad = replace(value.legs[0], instrument=replace(value.legs[0].instrument, session_id="after-hours"))
        event = simulator.submit(replace(value, legs=(bad,)))[0]
        self.assertEqual(event.status, "rejected")
        self.assertEqual(event.reason, "missing-exact-symbol-session-model")
        self.assertTrue(event.final)

    def test_model_rejection_and_admission_bounds_are_explicit(self):
        self.assertEqual(engine(model(acceptance="rejected")).submit(command())[0].status, "rejected")
        value = command()
        event = engine().submit(replace(value, maximum_quantity=D("11")))[0]
        self.assertEqual(event.reason, "admission-bound")
        expired = replace(value, expires_at_ns=9600)
        self.assertEqual(engine().submit(expired)[0].status, "rejected")

    def test_expiry_is_authoritative_final_without_fabricated_fill(self):
        simulator = engine()
        simulator.submit(command())
        event = simulator.advance((), 9000)[0]
        self.assertEqual(event.status, "cancelled")
        self.assertEqual(event.reason, "order-expired")
        self.assertIsNone(event.fill_id)
        self.assertEqual(event.quantity, D("0"))
        self.assertTrue(event.final)

    def test_future_noncausal_conflicting_and_off_tick_market_batches_are_atomic(self):
        for bad in (depth(at=121), depth(at=99), replace(depth(), asks=(BookLevel(D("10.001"), D("20")),))):
            simulator = engine()
            simulator.submit(command())
            before = simulator.snapshot()
            with self.assertRaises(ValueError):
                simulator.advance((bad,), 120)
            self.assertEqual(simulator.snapshot(), before)
        simulator = engine()
        simulator.submit(command())
        simulator.advance((depth(quantity="4"),), 110)
        before = simulator.snapshot()
        with self.assertRaises(ValueError):
            simulator.advance((depth(at=120, sequence=1, quantity="100"),), 120)
        self.assertEqual(simulator.snapshot(), before)

    def test_event_exhaustion_rolls_back_entire_batch(self):
        simulator = engine(bounds=SimulationBounds(max_events=3))
        simulator.submit(command("first"))
        simulator.submit(command("second"))
        before = simulator.snapshot()
        with self.assertRaises(ValueError):
            simulator.advance((depth(quantity="100", volume="100"),), 110)
        self.assertEqual(simulator.snapshot(), before)

    def test_bounds_on_orders_legs_levels_and_event_batch(self):
        simulator = engine(bounds=SimulationBounds(max_orders=1, max_book_levels=1, max_market_events=1))
        simulator.submit(command())
        with self.assertRaises(ValueError):
            simulator.submit(command("second"))
        with self.assertRaises(ValueError):
            simulator.advance((depth(), depth(at=111, sequence=2)), 111)
        with self.assertRaises(ValueError):
            simulator.advance((replace(depth(), asks=(BookLevel(D("10"), D("1")), BookLevel(D("10.01"), D("1")))),), 110)
        second = replace(command("other", "XYZ").legs[0], leg_id="leg:XYZ")
        too_many = replace(command(), legs=command().legs + (second,))
        self.assertEqual(engine(bounds=SimulationBounds(max_legs=1)).submit(too_many)[0].reason, "leg-bound")

    def test_decimal_and_clock_metadata_fail_closed(self):
        with self.assertRaises(ValueError):
            model(participation_rate=0.5)
        with self.assertRaises(ValueError):
            model(fee_rate=D("NaN"))
        with self.assertRaises(ValueError):
            model(slippage_ticks=True)
        with self.assertRaises(ValueError):
            command(submitted_at_ns=100.0)
        with self.assertRaises(ValueError):
            replace(instrument(), tick_size=D("1e-13"))
        with self.assertRaises(ValueError):
            replace(command().legs[0], limit_price=D("10.001"))
        with self.assertRaises(ValueError):
            replace(instrument(), kind="option")
        with self.assertRaises(ValueError):
            replace(depth(), bids=(BookLevel(D("10"), D("1")),))

    def test_ambient_decimal_context_cannot_change_results(self):
        one, two = engine(), engine()
        one.submit(command())
        two.submit(command())
        expected = one.advance((depth(),), 110)
        with localcontext() as context:
            context.prec = 2
            actual = two.advance((depth(),), 110)
        self.assertEqual(actual, expected)

    def test_checkpoint_restores_consumed_depth_event_ids_and_cancel_race(self):
        simulator = engine()
        value = command()
        simulator.submit(value)
        simulator.advance((depth(quantity="4"),), 110)
        simulator.cancel(value.submission_key, cancel_authorization(value), 120)
        checkpoint = simulator.snapshot()
        restored = PaperSimulator.restore(checkpoint, (model(),), expected_provenance_id="journal-stream:epoch-1")
        self.assertEqual(restored.snapshot(), checkpoint)
        next_book = depth(at=130, sequence=2, quantity="4")
        self.assertEqual(simulator.advance((next_book,), 140), restored.advance((next_book,), 140))
        self.assertEqual(simulator.reconcile(value.submission_key), restored.reconcile(value.submission_key))

    def test_checkpoint_rejects_mutation_wrong_provenance_and_model_drift(self):
        simulator = engine()
        simulator.submit(command())
        checkpoint = simulator.snapshot()
        with self.assertRaises(ValueError):
            PaperSimulator.restore(replace(checkpoint, now_ns=101), (model(),), expected_provenance_id="journal-stream:epoch-1")
        with self.assertRaises(ValueError):
            PaperSimulator.restore(checkpoint, (model(),), expected_provenance_id="different-stream")
        with self.assertRaises(ValueError):
            PaperSimulator.restore(checkpoint, (model(slippage_ticks=2),), expected_provenance_id="journal-stream:epoch-1")
        with self.assertRaises(ValueError):
            PaperSimulator.restore(checkpoint, (model(),), expected_provenance_id="journal-stream:epoch-1", bounds=SimulationBounds(max_orders=1))

    def test_unknown_checkpoint_remains_unknown_after_restore(self):
        uncertain = model(acceptance="unknown")
        simulator = engine(uncertain)
        simulator.submit(command())
        restored = PaperSimulator.restore(simulator.snapshot(), (uncertain,), expected_provenance_id="journal-stream:epoch-1")
        result = restored.reconcile("order-1")
        self.assertEqual(result.status, "unknown")
        self.assertFalse(result.final)
        self.assertFalse(result.authoritative)


if __name__ == "__main__":
    unittest.main()
