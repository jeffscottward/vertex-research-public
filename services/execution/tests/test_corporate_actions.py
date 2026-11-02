"""Corporate-action boundary proofs over the real reducer, with no external IO."""
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
import json
from threading import RLock
import unittest

from vertex_execution.corporate_actions import CorporateActionController, CorporateActionProof, action_lineage
from vertex_execution.journal import apply_event, initial_state
from vertex_execution.owner import PaperExecutionOwner
from vertex_execution.ports import ExecutionError

HASH = "a" * 64
OTHER_HASH = "b" * 64
NOW = 1000


class LocalAuthority:
    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()

    def digest(self, value):
        return sha256(self.encode(value)).hexdigest()


class ReducerJournal:
    def __init__(self, state):
        self.state = deepcopy(state)
        self.initial = deepcopy(state)
        self.epoch = 1
        self.mutex = RLock()
        self.sequence = 0
        self.event_hash = "0" * 64
        self.events = []
        self.fail_kind = None
        self.before_action = None
        self.latched = False

    def latch_pause(self, reason, *, now_ns):
        # Separate fixture state mirrors durable inhibit without external IO.
        self.latched = True

    def pause_latched(self):
        return self.latched

    def _db(self):
        # Healthy synthetic owner-scope sentinel, never a database connection.
        return self

    def snapshot(self):
        return deepcopy(self.state), self.sequence, self.event_hash

    def append(self, kind, data, *, now_ns, event_id):
        if kind == self.fail_kind:
            raise ExecutionError("injected-durable-boundary-failure")
        if kind == "corporate-action":
            self.before_action = deepcopy(self.state)
        candidate = deepcopy(self.state)
        event = {"kind": kind, "data": deepcopy(data), "eventId": event_id, "occurredNs": str(now_ns)}
        apply_event(candidate, event)
        self.state = candidate
        if kind == "reset":
            self.latched = False
        self.events.append(event)
        self.sequence += 1
        self.event_hash = LocalAuthority().digest(event)
        return self.sequence, self.event_hash


class Evidence:
    def __init__(self):
        self.result = True
        self.calls = []
        self.hook = None

    def verify_action(self, proof, *, ledger, now_ns):
        self.calls.append((proof, deepcopy(ledger), now_ns))
        if self.hook is not None:
            self.hook(ledger)
        return self.result


def order(*, instrument="OLD", state="released", shares=None, cash="0"):
    return {
        "legs": {instrument: {"side": "buy", "filled": "100", "maximumQuantity": "100"}},
        "shareReserve": {} if shares is None else shares,
        "cashReserve": cash,
        "reservationState": state,
        "finalityProven": state == "released",
        "strategyArtifactId": "strategy-immutable-original:1",
        "fills": {"fill:1": {"instrumentId": instrument, "quantity": "100", "payloadSha256": HASH}},
    }


def new_owner(*, quantity="100", destination="0", cash="1000"):
    state = initial_state("paper-account", "paper-simulator", "USD")
    state.update(ownerEpoch="1", cash=cash, positions={"OLD": quantity, "NEW": destination},
                 pausedNewRisk=False, reconciled=True, pauseReasons=[])
    state["orders"]["original-order"] = order()
    state["fillLineage"]["original-order:fill:1"] = {
        "instrumentId": "OLD", "signedQuantity": quantity, "cashDelta": "-500", "fee": "1",
        "sourceEventId": "source-fill:1", "strategyArtifactId": "strategy-immutable-original:1",
        "occurredNs": "100", "settled": True, "settlementEvidenceSha256": HASH,
    }
    owner = object.__new__(PaperExecutionOwner)
    owner.journal = ReducerJournal(state)
    owner.authority = LocalAuthority()
    owner.epoch = 1
    owner._disruption_held = False
    return owner


def proof_for(owner, **changes):
    snapshot, sequence, head = owner.journal.snapshot()
    old = changes.get("old_instrument_id", "OLD")
    new = changes.get("new_instrument_id", "NEW")
    proof = CorporateActionProof(
        action_id="action:1",
        action_kind="split",
        account_alias="paper-account",
        simulator_id="paper-simulator",
        owner_epoch=1,
        currency="USD",
        ledger_sequence=sequence,
        ledger_sha256=head,
        old_instrument_id=old,
        new_instrument_id=new,
        previous_quantity=snapshot["positions"].get(old, "0"),
        quantity_numerator=2,
        quantity_denominator=1,
        previous_qualification_id="qualification-old:1",
        previous_qualification_sha256=HASH,
        replacement_qualification_id="qualification-new:2",
        replacement_qualification_sha256=OTHER_HASH,
        lineage_sha256=owner.authority.digest(action_lineage(snapshot, old, new)),
        evidence_sha256=HASH,
        effective_ns=900,
        observed_ns=950,
        valid_until_ns=2000,
    )
    return replace(proof, **changes)


class CorporateActionTests(unittest.TestCase):
    def test_split_invalidates_both_instruments_before_exact_transformation(self):
        owner = new_owner(destination="5")
        proof = proof_for(owner)
        evidence = Evidence()
        CorporateActionController(owner, evidence).apply(proof, now_ns=NOW)
        state = owner.journal.state
        self.assertEqual(state["positions"], {"OLD": "0", "NEW": "205"})
        self.assertEqual(state["cash"], "1000")
        self.assertEqual(state["invalidQualifications"], ["NEW", "OLD"])
        self.assertTrue(state["pausedNewRisk"])
        self.assertFalse(state["reconciled"])
        self.assertTrue(owner.journal.before_action["pausedNewRisk"])
        self.assertIn("OLD", owner.journal.before_action["invalidQualifications"])
        self.assertEqual(len(evidence.calls), 1)
        self.assertEqual(tuple(e["kind"] for e in owner.journal.events),
                         ("qualification-invalidated", "qualification-invalidated", "corporate-action"))
        recorded = state["corporateActions"][proof.action_id]
        self.assertEqual(recorded["newQuantity"], "200")
        self.assertEqual(recorded["quantityNumerator"], "2")
        self.assertEqual(recorded["ledgerSha256"], proof.ledger_sha256)
        self.assertEqual(recorded["lineageSha256"], proof.lineage_sha256)

    def test_same_identity_split_and_signed_short_reverse_split_remain_exact(self):
        owner = new_owner(quantity="-100")
        proof = proof_for(owner, action_kind="reverse-split", new_instrument_id="OLD",
                          quantity_numerator=1, quantity_denominator=4)
        CorporateActionController(owner, Evidence()).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.state["positions"]["OLD"], "-25")
        self.assertEqual(owner.journal.state["corporateActions"][proof.action_id]["newQuantity"], "-25")
        self.assertEqual(len(owner.journal.events), 2)

    def test_one_to_one_instrument_remap_preserves_existing_destination(self):
        owner = new_owner(destination="7")
        proof = proof_for(owner, action_kind="instrument-remap", quantity_numerator=1)
        CorporateActionController(owner, Evidence()).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.state["positions"], {"OLD": "0", "NEW": "107"})

    def test_exact_fractional_delivery_is_allowed_but_recurring_fraction_never_rounds(self):
        owner = new_owner(quantity="1")
        proof = proof_for(owner, action_kind="reverse-split", quantity_numerator=1, quantity_denominator=2)
        CorporateActionController(owner, Evidence()).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.state["positions"]["NEW"], "0.5")
        owner = new_owner(quantity="1")
        proof = proof_for(owner, action_kind="reverse-split", quantity_numerator=1, quantity_denominator=3)
        before = owner.journal.snapshot()
        with self.assertRaisesRegex(ExecutionError, "inexact-quantity"):
            CorporateActionController(owner, Evidence()).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.snapshot(), before)

    def test_fill_history_and_original_strategy_are_never_rewritten(self):
        owner = new_owner()
        original_lineage = deepcopy(owner.journal.state["fillLineage"])
        original_order = deepcopy(owner.journal.state["orders"]["original-order"])
        CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=NOW)
        self.assertEqual(owner.journal.state["fillLineage"], original_lineage)
        self.assertEqual(owner.journal.state["orders"]["original-order"], original_order)
        self.assertEqual(owner.journal.state["orders"]["original-order"]["strategyArtifactId"], "strategy-immutable-original:1")
        self.assertIn("OLD", owner.journal.state["orders"]["original-order"]["legs"])

    def test_reducer_replay_reconstructs_action_without_losing_lineage(self):
        owner = new_owner()
        CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=NOW)
        replayed = deepcopy(owner.journal.initial)
        for event in owner.journal.events:
            apply_event(replayed, deepcopy(event))
        self.assertEqual(replayed, owner.journal.state)
        self.assertEqual(replayed["fillLineage"], owner.journal.initial["fillLineage"])

    def test_exact_duplicate_action_noops_even_after_expiry_but_conflict_rejects(self):
        owner = new_owner()
        proof = proof_for(owner)
        evidence = Evidence()
        controller = CorporateActionController(owner, evidence)
        controller.apply(proof, now_ns=NOW)
        before = owner.journal.snapshot()
        controller.apply(proof, now_ns=3000)
        self.assertEqual(owner.journal.snapshot(), before)
        self.assertEqual(len(evidence.calls), 1)
        with self.assertRaisesRegex(ExecutionError, "idempotency-conflict"):
            controller.apply(replace(proof, evidence_sha256=OTHER_HASH), now_ns=NOW)
        self.assertEqual(owner.journal.snapshot(), before)

    def test_scope_epoch_environment_currency_and_owner_fence_fail_closed(self):
        for changes in ({"account_alias": "other"}, {"simulator_id": "other"}, {"owner_epoch": 2}, {"currency": "EUR"}):
            owner = new_owner()
            before = owner.journal.snapshot()
            with self.assertRaises(ExecutionError):
                CorporateActionController(owner, Evidence()).apply(proof_for(owner, **changes), now_ns=NOW)
            self.assertEqual(owner.journal.snapshot(), before)
        for field, value in (("environment", "live"), ("ownerEpoch", "2")):
            owner = new_owner()
            owner.journal.state[field] = value
            with self.assertRaises(ExecutionError):
                CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=NOW)
        owner = new_owner()
        owner._disruption_held = True
        with self.assertRaises(ExecutionError):
            CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=NOW)

    def test_stale_ledger_quantity_and_lineage_proofs_fail_before_any_mutation(self):
        for changes in ({"ledger_sequence": 1}, {"ledger_sha256": OTHER_HASH}, {"previous_quantity": "99"},
                        {"lineage_sha256": OTHER_HASH}):
            owner = new_owner()
            before = owner.journal.snapshot()
            with self.assertRaises(ExecutionError):
                CorporateActionController(owner, Evidence()).apply(proof_for(owner, **changes), now_ns=NOW)
            self.assertEqual(owner.journal.snapshot(), before)

    def test_changed_historical_strategy_pin_invalidates_lineage_digest(self):
        owner = new_owner()
        proof = proof_for(owner)
        owner.journal.state["orders"]["original-order"]["strategyArtifactId"] = "wrong-artifact"
        before = owner.journal.snapshot()
        with self.assertRaisesRegex(ExecutionError, "lineage-mismatch"):
            CorporateActionController(owner, Evidence()).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.snapshot(), before)

    def test_evidence_requires_literal_true_and_receives_copy_of_owned_ledger(self):
        for result in (False, None, 1, "verified"):
            owner = new_owner()
            evidence = Evidence()
            evidence.result = result
            before = owner.journal.snapshot()
            with self.assertRaisesRegex(ExecutionError, "evidence-unverified"):
                CorporateActionController(owner, evidence).apply(proof_for(owner), now_ns=NOW)
            self.assertEqual(owner.journal.snapshot(), before)
        owner = new_owner()
        evidence = Evidence()
        evidence.hook = lambda snapshot: snapshot["positions"].update(OLD="999")
        CorporateActionController(owner, evidence).apply(proof_for(owner), now_ns=NOW)
        self.assertEqual(owner.journal.state["positions"]["NEW"], "200")

    def test_missing_or_rejected_current_qualification_cannot_transform(self):
        owner = new_owner()
        for changes in ({"previous_qualification_id": ""}, {"replacement_qualification_sha256": "unknown"}):
            with self.assertRaises(ExecutionError):
                proof_for(owner, **changes)
        evidence = Evidence()
        evidence.result = False
        with self.assertRaisesRegex(ExecutionError, "evidence-unverified"):
            CorporateActionController(owner, evidence).apply(proof_for(owner), now_ns=NOW)

    def test_active_old_or_destination_order_and_covered_share_collateral_block(self):
        for instrument in ("OLD", "NEW"):
            for share_hold in (False, True):
                for state in ("held", "settlement-held"):
                    with self.subTest(instrument=instrument, share_hold=share_hold, state=state):
                        owner = new_owner()
                        owner.journal.state["orders"]["active"] = order(
                            instrument="OPTION" if share_hold else instrument,
                            state=state, shares={instrument: "1"} if share_hold else {})
                        before = owner.journal.snapshot()
                        with self.assertRaisesRegex(ExecutionError, "open-order-or-collateral"):
                            CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=NOW)
                        self.assertEqual(owner.journal.snapshot(), before)

    def test_released_label_without_proven_order_finality_is_not_safe_to_remap(self):
        owner = new_owner()
        owner.journal.state["orders"]["original-order"]["finalityProven"] = False
        before = owner.journal.snapshot()
        with self.assertRaisesRegex(ExecutionError, "open-order-or-collateral"):
            CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=NOW)
        self.assertEqual(owner.journal.snapshot(), before)

    def test_unsettled_old_or_destination_shares_and_related_cash_block(self):
        for instrument in ("OLD", "NEW"):
            owner = new_owner()
            owner.journal.state["unsettledPositions"]["pending"] = {"instrumentId": instrument, "quantity": "1"}
            before = owner.journal.snapshot()
            with self.assertRaisesRegex(ExecutionError, "unsettled-position"):
                CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=NOW)
            self.assertEqual(owner.journal.snapshot(), before)
        owner = new_owner()
        owner.journal.state["unsettledCredits"]["original-order:fill:1"] = "5"
        before = owner.journal.snapshot()
        with self.assertRaisesRegex(ExecutionError, "unsettled-cash-lineage"):
            CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=NOW)
        self.assertEqual(owner.journal.snapshot(), before)

    def test_cash_in_lieu_requires_explicit_amount_evidence_and_maturity(self):
        owner = new_owner()
        for changes in ({"cash_delta": "2.5"}, {"cash_delta": "2.5", "cash_evidence_sha256": HASH},
                        {"cash_delta": "2.5", "cash_settlement_due_ns": 950}):
            with self.assertRaisesRegex(ExecutionError, "explicit-settlement-proof"):
                proof_for(owner, **changes)
        proof = proof_for(owner, cash_delta="2.5", cash_evidence_sha256=OTHER_HASH, cash_settlement_due_ns=1001)
        before = owner.journal.snapshot()
        with self.assertRaisesRegex(ExecutionError, "not-mature"):
            CorporateActionController(owner, Evidence()).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.snapshot(), before)
        proof = proof_for(owner, cash_delta="2.5", cash_evidence_sha256=OTHER_HASH, cash_settlement_due_ns=950)
        CorporateActionController(owner, Evidence()).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.state["cash"], "1002.5")
        self.assertEqual(owner.journal.state["corporateActions"][proof.action_id]["cashEvidenceSha256"], OTHER_HASH)

    def test_cash_in_lieu_never_authorizes_rounding_unrepresentable_ratio(self):
        owner = new_owner(quantity="1")
        proof = proof_for(owner, action_kind="reverse-split", quantity_numerator=1, quantity_denominator=3,
                          cash_delta="25", cash_evidence_sha256=HASH, cash_settlement_due_ns=950)
        before = owner.journal.snapshot()
        with self.assertRaisesRegex(ExecutionError, "inexact-quantity"):
            CorporateActionController(owner, Evidence()).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.snapshot(), before)

    def test_cash_debit_cannot_consume_other_reserved_cash(self):
        owner = new_owner()
        owner.journal.state["orders"]["unrelated"] = order(instrument="UNRELATED", state="held", cash="999")
        proof = proof_for(owner, cash_delta="-2", cash_evidence_sha256=HASH, cash_settlement_due_ns=950)
        before = owner.journal.snapshot()
        with self.assertRaisesRegex(ExecutionError, "cash-deficit"):
            CorporateActionController(owner, Evidence()).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.snapshot(), before)

    def test_integer_ratio_clock_and_canonical_decimal_bounds_reject_coercion(self):
        owner = new_owner()
        for changes in ({"quantity_numerator": True}, {"quantity_denominator": 1.0}, {"quantity_denominator": 0},
                        {"quantity_numerator": 10**18 + 1}, {"owner_epoch": True}, {"observed_ns": 950.0},
                        {"ledger_sequence": False}, {"cash_delta": "0.0"}, {"previous_quantity": 100.0},
                        {"previous_quantity": "0"}, {"action_kind": "guessed-split"}):
            with self.subTest(changes=changes), self.assertRaises(ExecutionError):
                proof_for(owner, **changes)
        with self.assertRaises(ExecutionError):
            CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=1000.0)

    def test_ratio_direction_and_remap_identity_must_be_explicit(self):
        owner = new_owner()
        for changes in ({"quantity_numerator": 1}, {"action_kind": "reverse-split", "quantity_numerator": 2},
                        {"action_kind": "instrument-remap", "new_instrument_id": "OLD"}):
            with self.assertRaises(ExecutionError):
                proof_for(owner, **changes)

    def test_future_and_expired_action_proofs_do_not_mutate_positions(self):
        for now in (949, 2000):
            owner = new_owner()
            before = owner.journal.snapshot()
            with self.assertRaisesRegex(ExecutionError, "not-current"):
                CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=now)
            self.assertEqual(owner.journal.snapshot(), before)

    def test_preflight_overflow_does_not_leave_partial_invalidations(self):
        owner = new_owner(quantity="999999999999999999999999999999")
        before = owner.journal.snapshot()
        with self.assertRaisesRegex(ExecutionError, "decimal-overflow"):
            CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=NOW)
        self.assertEqual(owner.journal.snapshot(), before)

    def test_crash_after_invalidation_leaves_pause_and_requires_fresh_scoped_proof(self):
        owner = new_owner()
        proof = proof_for(owner)
        controller = CorporateActionController(owner, Evidence())
        owner.journal.fail_kind = "corporate-action"
        with self.assertRaisesRegex(ExecutionError, "durable-boundary-failure"):
            controller.apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.state["positions"]["OLD"], "100")
        self.assertTrue(owner.journal.state["pausedNewRisk"])
        self.assertFalse(owner.journal.state["reconciled"])
        self.assertIn("OLD", owner.journal.state["invalidQualifications"])
        self.assertEqual(owner.journal.state["corporateActions"], {})
        owner.journal.fail_kind = None
        with self.assertRaisesRegex(ExecutionError, "ledger-conflict"):
            controller.apply(proof, now_ns=NOW)
        controller.apply(proof_for(owner), now_ns=NOW)
        self.assertEqual(owner.journal.state["positions"]["NEW"], "200")
        self.assertTrue(owner.journal.state["pausedNewRisk"])

    def test_first_invalidation_failure_keeps_out_of_band_pause_latched(self):
        owner = new_owner()
        proof = proof_for(owner)
        before = owner.journal.snapshot()
        owner.journal.fail_kind = "qualification-invalidated"
        with self.assertRaisesRegex(ExecutionError, "durable-boundary-failure"):
            CorporateActionController(owner, Evidence()).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.snapshot(), before)
        self.assertTrue(owner.journal.pause_latched())
        self.assertEqual(owner.journal.state["positions"]["OLD"], "100")
        self.assertEqual(owner.journal.state["corporateActions"], {})

    def test_fixture_pause_latch_clears_only_after_successful_reset_transition(self):
        owner = new_owner()
        owner.journal.latch_pause("corporate-action", now_ns=NOW)
        owner.journal.state["reconciled"] = False
        with self.assertRaises(ExecutionError):
            owner.journal.append("reset", {}, now_ns=NOW, event_id="blocked-reset")
        self.assertTrue(owner.journal.pause_latched())
        owner.journal.state["reconciled"] = True
        owner.journal.append("reset", {}, now_ns=NOW, event_id="accepted-reset")
        self.assertFalse(owner.journal.pause_latched())

    def test_reentrant_evidence_cannot_apply_against_changed_journal_head(self):
        owner = new_owner()
        evidence = Evidence()
        evidence.hook = lambda snapshot: owner.journal.append("pause", {"reason": "concurrent-risk-event"},
                                                             now_ns=NOW, event_id="reentrant:1")
        proof = proof_for(owner)
        with self.assertRaisesRegex(ExecutionError, "changed-during-verification"):
            CorporateActionController(owner, evidence).apply(proof, now_ns=NOW)
        self.assertEqual(owner.journal.state["positions"]["OLD"], "100")
        self.assertEqual(owner.journal.state["corporateActions"], {})
        self.assertEqual(owner.journal.state["invalidQualifications"], [])

    def test_action_does_not_reset_qualification_or_new_risk_automatically(self):
        owner = new_owner()
        CorporateActionController(owner, Evidence()).apply(proof_for(owner), now_ns=NOW)
        with self.assertRaisesRegex(ExecutionError, "reset-before-reconciliation"):
            owner.journal.append("reset", {}, now_ns=NOW + 1, event_id="forbidden-reset")
        self.assertTrue(owner.journal.state["pausedNewRisk"])
        self.assertEqual(owner.journal.state["invalidQualifications"], ["NEW", "OLD"])


if __name__ == "__main__":
    unittest.main()
