"""Deterministic option lifecycle specifications; intentionally no external IO."""
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal, localcontext
import unittest

from vertex_execution.simulator import ExpirySchedule, OptionTerms, QualifiedInstrument
from vertex_execution.settlement import (
    DividendObservation,
    ExerciseInstruction,
    OptionMark,
    OptionPosition,
    SettlementPolicy,
    SettlementRequest,
    UnderlyingObservation,
    settle_batch,
    settle_option,
)

D = Decimal
NS = 1_000_000_000


def epoch_ns(value):
    delta = datetime.fromisoformat(value) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * NS + delta.microseconds * 1000


def schedule(**changes):
    value = ExpirySchedule(
        calendar_id="XNYS",
        calendar_version="2026-reviewed:1",
        exchange_timezone="America/New_York",
        fixing_utc_offset_seconds=-4 * 3600,
        nominal_expiry_date="2026-07-03",
        effective_expiry_date="2026-07-02",
        closed_dates=("2026-07-03",),
        holiday_rule="previous-business-day",
        fixing_session="PM",
        last_trade_ns=epoch_ns("2026-07-02T16:00:00-04:00"),
        fixing_ns=epoch_ns("2026-07-02T16:00:00-04:00"),
        exercise_cutoff_ns=epoch_ns("2026-07-02T16:30:00-04:00"),
        settlement_due_ns=epoch_ns("2026-07-06T09:30:00-04:00"),
    )
    return replace(value, **changes)


def qualified(*, right="call", kind="physical", style="american", expiry=None):
    terms = OptionTerms("ABC", right, D("100"), style, kind, D("100"), expiry or schedule())
    return QualifiedInstrument("ABC:2026-07-03:" + right, "ABC-OPT-" + right, "2026-07-02:regular", "USD", "option", D("0.01"), D("1"), D("100"), "qualified-options:1", terms)


def policy(**changes):
    value = SettlementPolicy("option-policy:1", D("0.01"), D("0.05"), 86400 * NS, 60 * NS, D("0.02"), D("0.50"), D("1000"), "conservative-economic")
    return replace(value, **changes)


def request(*, signed="-2", right="call", kind="physical", style="american", price="105", expiry=None):
    option = qualified(right=right, kind=kind, style=style, expiry=expiry)
    terms = option.option
    assert terms is not None
    observation = UnderlyingObservation("ABC", D(price), terms.schedule.fixing_ns, "official-fixing:1", terms.schedule.fixing_session, True)
    return SettlementRequest("settlement:1", OptionPosition("position:1", option, D(signed)), terms.schedule.exercise_cutoff_ns, observation)


def early_request(*, signed="-2", right="call", price="105", mark="5.01", dividend="0.50"):
    value = request(signed=signed, right=right, price=price)
    now = epoch_ns("2026-07-01T15:30:00-04:00")
    return replace(
        value,
        now_ns=now,
        underlying=replace(value.underlying, observed_at_ns=now, fixing_session="intraday", official_fixing=False),
        option_mark=OptionMark(value.position.instrument.instrument_id, D(mark), now, "option-mark:1"),
        dividend=DividendObservation("ABC", D(dividend), now - 86400 * NS, epoch_ns("2026-07-02T09:30:00-04:00"), "dividend:1"),
        early_settlement_due_ns=epoch_ns("2026-07-02T09:30:00-04:00"),
    )


class SettlementTests(unittest.TestCase):
    def test_short_call_assignment_delivers_shares_and_receives_strike(self):
        result = settle_option(request(), policy())
        self.assertEqual(result.status, "assigned")
        self.assertEqual(result.underlying_delta, D("-200"))
        self.assertEqual(result.cash_delta, D("19999.00"))
        self.assertEqual(result.fees, D("1.00"))
        self.assertEqual(result.contracts, D("2"))
        self.assertEqual(result.remaining_contracts, D("0"))
        self.assertTrue(result.final)
        self.assertFalse(result.spendable_authority)
        self.assertEqual(result.settlement_due_ns, schedule().settlement_due_ns)
        self.assertIn("modeled-conservative", result.reason)

    def test_short_put_assignment_purchases_shares_and_pays_strike(self):
        result = settle_option(request(right="put", price="95"), policy())
        self.assertEqual(result.status, "assigned")
        self.assertEqual(result.underlying_delta, D("200"))
        self.assertEqual(result.cash_delta, D("-20001.00"))
        self.assertEqual(result.intrinsic_per_unit, D("5"))

    def test_long_physical_call_and_put_reverse_delivery_signs(self):
        call = settle_option(request(signed="2"), policy())
        put = settle_option(request(signed="2", right="put", price="95"), policy())
        self.assertEqual((call.underlying_delta, call.cash_delta), (D("200"), D("-20001")))
        self.assertEqual((put.underlying_delta, put.cash_delta), (D("-200"), D("19999")))
        self.assertEqual(call.status, "exercised")
        self.assertEqual(put.status, "exercised")

    def test_cash_settlement_pays_exact_signed_intrinsic_without_delivery(self):
        for signed, right, price, expected in (("-2", "call", "105", "-1001"), ("-2", "put", "95", "-1001"), ("2", "call", "105", "999"), ("2", "put", "95", "999")):
            with self.subTest(signed=signed, right=right):
                result = settle_option(request(signed=signed, right=right, kind="cash", style="european", price=price), policy(short_assignment_model="explicit-only"))
                self.assertEqual(result.cash_delta, D(expected))
                self.assertEqual(result.underlying_delta, D("0"))
                self.assertTrue(result.final)
                self.assertFalse(result.spendable_authority)

    def test_cash_intrinsic_is_not_rounded_down_by_physical_exercise_threshold(self):
        result = settle_option(request(signed="2", kind="cash", price="100.001"), policy(fee_per_contract=D("0")))
        self.assertEqual(result.cash_delta, D("0.200"))
        self.assertTrue(result.final)
        self.assertFalse(result.pin_risk)

    def test_zero_cash_intrinsic_expires_without_fee_or_pin_ambiguity(self):
        result = settle_option(request(kind="cash", price="100"), policy())
        self.assertEqual(result.status, "expired")
        self.assertEqual(result.cash_delta, D("0"))
        self.assertEqual(result.fees, D("0"))
        self.assertTrue(result.final)
        self.assertFalse(result.pin_risk)

    def test_settlement_kind_is_qualified_metadata_not_inferred_from_zero_delivery(self):
        for kind in ("cash", "physical"):
            for signed, price in (("-2", "105"), ("2", "105"), ("2", "90")):
                with self.subTest(kind=kind, signed=signed, price=price):
                    value = request(kind=kind, signed=signed, price=price)
                    event = settle_option(value, policy())
                    self.assertEqual(event.settlement_kind, value.position.instrument.option.settlement_kind)
                    self.assertEqual(event.settlement_kind, kind)
                    if price == "90":
                        self.assertEqual(event.status, "expired")
                        self.assertEqual(event.cash_delta, D("0"))
                        self.assertEqual(event.underlying_delta, D("0"))
        physical_expiry = settle_option(request(signed="2", price="90"), policy())
        cash_expiry = settle_option(request(signed="2", kind="cash", price="90"), policy())
        self.assertNotEqual(physical_expiry.event_id, cash_expiry.event_id)
        self.assertEqual((physical_expiry.settlement_kind, cash_expiry.settlement_kind), ("physical", "cash"))

    def test_unknown_and_no_action_results_preserve_explicit_settlement_kind(self):
        for kind in ("cash", "physical"):
            value = request(kind=kind)
            event = settle_option(replace(value, underlying=None), policy())
            self.assertEqual(event.status, "unknown")
            self.assertEqual(event.settlement_kind, kind)
        early = early_request(mark="6")
        event = settle_option(early, policy())
        self.assertEqual(event.status, "no-action")
        self.assertEqual(event.settlement_kind, "physical")

    def test_partial_explicit_assignment_keeps_residual_short_obligation(self):
        value = request()
        decision = ExerciseInstruction("assignment:1", "assign", D("1"), value.now_ns)
        result = settle_option(replace(value, instruction=decision), policy(short_assignment_model="explicit-only"))
        self.assertEqual(result.underlying_delta, D("-100"))
        self.assertEqual(result.cash_delta, D("9999.50"))
        self.assertEqual(result.remaining_contracts, D("-1"))
        self.assertFalse(result.final)
        self.assertEqual(result.reason, "explicit-expiry-assignment")

    def test_unconfirmed_short_assignment_and_nonassignment_retain_obligation(self):
        for price, reason in (("105", "short-assignment-unconfirmed"), ("90", "short-nonassignment-unconfirmed")):
            with self.subTest(price=price):
                result = settle_option(request(price=price), policy(short_assignment_model="explicit-only"))
                self.assertEqual(result.status, "unknown")
                self.assertEqual(result.reason, reason)
                self.assertEqual(result.remaining_contracts, D("-2"))
                self.assertFalse(result.final)
                self.assertEqual(result.cash_delta, D("0"))

    def test_pin_risk_never_infers_exercise_or_assignment(self):
        for signed in ("2", "-2"):
            result = settle_option(request(signed=signed, price="100.02"), policy())
            self.assertEqual(result.status, "unknown")
            self.assertEqual(result.reason, "pin-risk-explicit-decision-required")
            self.assertTrue(result.pin_risk)
            self.assertFalse(result.final)
            self.assertEqual(result.underlying_delta, D("0"))

    def test_explicit_pin_assignment_and_nonexercise_are_distinct(self):
        value = request(price="100.02")
        decision = ExerciseInstruction("assignment:pin", "assign", D("2"), value.now_ns)
        assigned = settle_option(replace(value, instruction=decision), policy())
        declined = settle_option(replace(value, instruction=replace(decision, action="no-assignment")), policy())
        self.assertEqual(assigned.status, "assigned")
        self.assertEqual(assigned.underlying_delta, D("-200"))
        self.assertEqual(declined.status, "expired")
        self.assertEqual(declined.underlying_delta, D("0"))
        self.assertTrue(assigned.pin_risk)
        self.assertTrue(declined.pin_risk)
        self.assertNotEqual(assigned.event_id, declined.event_id)

    def test_expiry_window_keeps_nonexercise_nonfinal_until_cutoff(self):
        value = request(price="90")
        terms = value.position.instrument.option
        assert terms is not None
        value = replace(value, now_ns=terms.schedule.fixing_ns + NS)
        decision = ExerciseInstruction("no-assignment:1", "no-assignment", D("2"), value.now_ns)
        for candidate in (value, replace(value, instruction=decision)):
            result = settle_option(candidate, policy())
            self.assertEqual(result.status, "unknown")
            self.assertEqual(result.reason, "exercise-window-open")
            self.assertFalse(result.final)

    def test_below_threshold_long_expiry_closes_without_delivery(self):
        result = settle_option(request(signed="2", price="90"), policy())
        self.assertEqual(result.status, "expired")
        self.assertEqual(result.remaining_contracts, D("0"))
        self.assertEqual(result.cash_delta, D("0"))
        self.assertTrue(result.final)

    def test_holiday_and_weekend_expiry_roll_to_explicit_prior_business_day(self):
        expiry = schedule()
        self.assertEqual(expiry.nominal_expiry_date, "2026-07-03")
        self.assertEqual(expiry.effective_expiry_date, "2026-07-02")
        weekend = schedule(nominal_expiry_date="2026-07-04")
        self.assertEqual(weekend.effective_expiry_date, "2026-07-02")
        for changes in ({"effective_expiry_date": "2026-07-03"}, {"closed_dates": ()}, {"holiday_rule": "next-business-day"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                replace(expiry, **changes)

    def test_am_fixing_requires_exact_am_official_observation(self):
        expiry = schedule(
            fixing_session="AM",
            last_trade_ns=epoch_ns("2026-07-01T16:00:00-04:00"),
            fixing_ns=epoch_ns("2026-07-02T09:30:00-04:00"),
        )
        value = request(kind="cash", style="european", expiry=expiry)
        valid = settle_option(value, policy())
        self.assertTrue(valid.final)
        for observation in (
            replace(value.underlying, fixing_session="PM"),
            replace(value.underlying, official_fixing=False),
            replace(value.underlying, observed_at_ns=expiry.fixing_ns + 1),
        ):
            result = settle_option(replace(value, underlying=observation), policy())
            self.assertEqual(result.status, "unknown")
            self.assertEqual(result.reason, "missing-exact-official-expiry-fixing")
        with self.assertRaises(ValueError):
            replace(expiry, fixing_session="PM")

    def test_dst_offsets_are_explicit_not_a_fixed_utc_close(self):
        winter = schedule(
            nominal_expiry_date="2026-03-06",
            effective_expiry_date="2026-03-06",
            closed_dates=(),
            fixing_utc_offset_seconds=-5 * 3600,
            last_trade_ns=epoch_ns("2026-03-06T16:00:00-05:00"),
            fixing_ns=epoch_ns("2026-03-06T16:00:00-05:00"),
            exercise_cutoff_ns=epoch_ns("2026-03-06T16:30:00-05:00"),
            settlement_due_ns=epoch_ns("2026-03-09T09:30:00-04:00"),
        )
        summer = schedule(
            nominal_expiry_date="2026-03-13",
            effective_expiry_date="2026-03-13",
            closed_dates=(),
            last_trade_ns=epoch_ns("2026-03-13T16:00:00-04:00"),
            fixing_ns=epoch_ns("2026-03-13T16:00:00-04:00"),
            exercise_cutoff_ns=epoch_ns("2026-03-13T16:30:00-04:00"),
            settlement_due_ns=epoch_ns("2026-03-16T09:30:00-04:00"),
        )
        self.assertEqual(winter.fixing_ns // NS % 86400, 21 * 3600)
        self.assertEqual(summer.fixing_ns // NS % 86400, 20 * 3600)
        self.assertEqual(summer.fixing_ns - winter.fixing_ns, (7 * 86400 - 3600) * NS)
        with self.assertRaises(ValueError):
            replace(winter, exchange_timezone="")

    def test_fixing_must_match_exchange_local_date_not_utc_date(self):
        with self.assertRaises(ValueError):
            schedule(fixing_ns=epoch_ns("2026-07-03T16:00:00-04:00"), exercise_cutoff_ns=epoch_ns("2026-07-03T16:30:00-04:00"))
        with self.assertRaises(ValueError):
            schedule(fixing_ns=epoch_ns("2026-07-02T09:30:00-04:00"), last_trade_ns=epoch_ns("2026-07-02T09:00:00-04:00"))

    def test_ex_dividend_conservative_model_delivers_short_call_early(self):
        value = early_request()
        result = settle_option(value, policy())
        self.assertEqual(result.status, "assigned")
        self.assertTrue(result.early_exercise)
        self.assertIn("modeled-conservative-ex-dividend", result.reason)
        self.assertEqual(result.underlying_delta, D("-200"))
        self.assertEqual(result.cash_delta, D("19999"))
        self.assertEqual(result.settlement_due_ns, value.early_settlement_due_ns)

    def test_ex_dividend_risk_is_not_automatic_long_exercise_or_observed_assignment(self):
        long_result = settle_option(early_request(signed="2"), policy())
        short_result = settle_option(early_request(), policy(short_assignment_model="explicit-only"))
        for result in (long_result, short_result):
            self.assertEqual(result.status, "unknown")
            self.assertIn("explicit-decision-required", result.reason)
            self.assertFalse(result.final)
            self.assertEqual(result.underlying_delta, D("0"))

    def test_dividend_must_exceed_time_value_and_financing_before_ex_date(self):
        for value in (early_request(mark="6"), early_request(dividend="0.01")):
            result = settle_option(value, policy())
            self.assertEqual(result.status, "no-action")
            self.assertFalse(result.final)
        value = early_request()
        value = replace(value, dividend=replace(value.dividend, ex_at_ns=value.now_ns))
        result = settle_option(value, policy())
        self.assertEqual(result.status, "no-action")

    def test_short_put_early_assignment_uses_financing_not_call_dividend_rule(self):
        value = early_request(right="put", price="95", mark="5.01")
        result = settle_option(value, policy(financing_cost_per_unit=D("0.05")))
        self.assertEqual(result.status, "assigned")
        self.assertIn("short-put-early-exercise-risk", result.reason)
        self.assertEqual(result.underlying_delta, D("200"))
        self.assertEqual(result.cash_delta, D("-20001"))
        self.assertTrue(result.early_exercise)

    def test_explicit_american_early_exercise_requires_exact_settlement_due(self):
        value = early_request(signed="2")
        instruction = ExerciseInstruction("holder-decision:1", "exercise", D("2"), value.now_ns)
        value = replace(value, instruction=instruction, option_mark=None, dividend=None)
        result = settle_option(value, policy())
        self.assertEqual(result.status, "exercised")
        self.assertEqual(result.underlying_delta, D("200"))
        self.assertTrue(result.early_exercise)
        with self.assertRaises(ValueError):
            settle_option(replace(value, early_settlement_due_ns=None), policy())

    def test_european_and_unsupported_early_cash_conventions_fail_closed(self):
        value = early_request(signed="2")
        terms = value.position.instrument.option
        assert terms is not None
        instruction = ExerciseInstruction("exercise:1", "exercise", D("2"), value.now_ns)
        for altered in (replace(terms, exercise_style="european"), replace(terms, settlement_kind="cash")):
            option = replace(value.position.instrument, option=altered)
            candidate = replace(value, position=replace(value.position, instrument=option), instruction=instruction)
            with self.assertRaises(ValueError):
                settle_option(candidate, policy())

    def test_missing_stale_noncausal_or_impossible_evidence_is_not_a_fill(self):
        value = early_request()
        cases = (
            (replace(value, underlying=None), "missing-underlying-evidence"),
            (replace(value, underlying=replace(value.underlying, observed_at_ns=value.now_ns - 61 * NS)), "stale-early-exercise-reference"),
            (replace(value, option_mark=None), "missing-fresh-option-time-value"),
            (replace(value, option_mark=replace(value.option_mark, price=D("1"))), "option-mark-below-intrinsic"),
            (replace(value, dividend=None), "missing-dividend-metadata"),
        )
        for candidate, reason in cases:
            with self.subTest(reason=reason):
                result = settle_option(candidate, policy())
                self.assertEqual(result.status, "unknown")
                self.assertEqual(result.reason, reason)
                self.assertFalse(result.final)
        with self.assertRaises(ValueError):
            settle_option(replace(value, dividend=replace(value.dividend, announced_at_ns=value.now_ns + NS)), policy())
        with self.assertRaises(ValueError):
            settle_option(replace(value, underlying=replace(value.underlying, underlying_id="OTHER")), policy())

    def test_adjusted_contract_multiplier_must_match_deliverable(self):
        option = qualified()
        terms = option.option
        assert terms is not None
        with self.assertRaises(ValueError):
            replace(option, option=replace(terms, deliverable_units=D("150")))
        with self.assertRaises(ValueError):
            replace(option, multiplier=D("10"))
        # A fully qualified non-100 mini contract is not silently reset to 100.
        mini = replace(option, multiplier=D("10"), option=replace(terms, deliverable_units=D("10")))
        value = request()
        result = settle_option(replace(value, position=replace(value.position, instrument=mini)), policy())
        self.assertEqual(result.underlying_delta, D("-20"))
        self.assertEqual(result.cash_delta, D("1999"))

    def test_incomplete_metadata_fractional_clocks_and_float_amounts_reject(self):
        with self.assertRaises(ValueError):
            replace(qualified(), option=None)
        with self.assertRaises(ValueError):
            replace(qualified().option, underlying_id="")
        with self.assertRaises(ValueError):
            replace(schedule(), calendar_version="")
        with self.assertRaises(ValueError):
            replace(schedule(), exercise_cutoff_ns=1.0)
        with self.assertRaises(ValueError):
            replace(policy(), fee_per_contract=0.5)
        with self.assertRaises(ValueError):
            replace(request().position, signed_contracts=D("NaN"))
        with self.assertRaises(ValueError):
            replace(request().position, signed_contracts=D("-0.5"))

    def test_exercise_instruction_side_quantity_phase_and_deadline_guards(self):
        value = request()
        for instruction in (
            ExerciseInstruction("wrong-side", "exercise", D("2"), value.now_ns),
            ExerciseInstruction("too-much", "assign", D("3"), value.now_ns),
            ExerciseInstruction("late", "assign", D("2"), value.now_ns + 1),
            ExerciseInstruction("wrong-phase", "assign", D("2"), value.position.instrument.option.schedule.fixing_ns - 1),
        ):
            with self.subTest(instruction=instruction), self.assertRaises(ValueError):
                settle_option(replace(value, instruction=instruction), policy())

    def test_batch_bounds_duplicate_positions_and_contract_caps(self):
        value = request()
        with self.assertRaises(ValueError):
            settle_batch((value, value), policy())
        with self.assertRaises(ValueError):
            settle_batch((value, replace(value, request_id="other")), policy())
        other = replace(value, request_id="other", position=replace(value.position, position_id="other-position"))
        with self.assertRaises(ValueError):
            settle_batch((value, other), policy(maximum_events=1))
        with self.assertRaises(ValueError):
            settle_option(value, policy(maximum_contracts=D("1")))
        self.assertEqual(len(settle_batch((value, other), policy())), 2)

    def test_identity_and_decimal_arithmetic_ignore_ambient_context(self):
        value = request(price="105.123456789")
        immutable_policy = policy()
        first = settle_option(value, immutable_policy)
        with localcontext() as context:
            context.prec = 2
            second = settle_option(value, immutable_policy)
        self.assertEqual(first, second)
        self.assertNotEqual(first.event_id, settle_option(value, replace(immutable_policy, policy_id="new-policy")).event_id)
        self.assertFalse(first.spendable_authority)
        self.assertEqual(first.currency, "USD")


if __name__ == "__main__":
    unittest.main()
