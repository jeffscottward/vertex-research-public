"""Paper request, paper strategy and order-policy adapter. Offline: no broker, no network."""
from datetime import date
from decimal import Decimal, localcontext
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

from vertex_execution.paper_deploy.exit_rule import REASON_LOSER, REASON_ROLL, REASON_WINNER
from vertex_execution.paper_deploy.policy import (
    ArmGatePolicy,
    PolicyDecision,
    allow_all,
    ibkr_shapes,
    refuse_all,
    synthetic_con_id,
)
from vertex_execution.paper_deploy.request import (
    OptionGroup,
    OptionLeg,
    OptionsBlock,
    PaperRequest,
    RequestError,
    RequestLimits,
)
from vertex_execution.paper_deploy.strategy import (
    ComboOrder,
    OrderLeg,
    PaperSpreadStrategy,
    SpreadIntent,
    StrategyRefusal,
)

D = Decimal
NLV = D("100000")
SIGNAL = date(2026, 11, 11)
EXPIRY = date(2026, 12, 18)  # 37 days after SIGNAL
# structure -> (long strike, short strike) in the strike order of the structure.
STRIKES = {
    "callDebitVertical": ("680", "690"),
    "putDebitVertical": ("690", "680"),
    "putCreditVertical": ("680", "690"),
    "callCreditVertical": ("690", "680"),
}
# The engine order policy of this repository. Set the variable to check another version of the file.
ARM_GATE = Path(
    os.environ.get("VERTEX_PAPER_DEPLOY_ARM_GATE")
    or Path(__file__).resolve().parents[3] / "infra/quant-vps/exec-node/runtime/nautilus/arm_gate.py"
)


def record(**changes):
    """A deployment request record in the new format (with an options block)."""

    value = {
        "id": "request-1",
        "strategyId": "strategy-1",
        "strategySlug": "spy-call-debit",
        "strategyName": "SPY call debit",
        "presetId": None,
        "presetName": None,
        "params": {},
        "symbol": "SPY",
        "timeframe": "1d",
        "mode": "paper",
        "limits": {"maxOrderSize": 5, "maxPosition": 10, "maxOrdersPerMinute": 2, "dailyLossLimit": 500},
        "options": {
            "structure": "callDebitVertical",
            "dte": {"target": 45, "min": 21},
            "width": {"unit": "sigma", "value": 1},
            "anchorDelta": 0.5,
            "legs": [
                {"role": "anchor", "action": "buy", "right": "call"},
                {"role": "wing", "action": "sell", "right": "call"},
            ],
            "budgetPctOfAccount": 1.5,
            "maxLossPctOfAccount": 2,
            "group": None,
        },
        "status": "approved",
        "requestedBy": "owner",
        "executionAuthorized": False,
        "brokerSubmissionAllowed": False,
    }
    value.update(changes)
    return value


def with_options(**changes):
    """The base record with a changed options block. Legs follow a changed structure unless given."""

    value = record()
    options = {**value["options"], **changes}
    if "structure" in changes and "legs" not in changes:
        del options["legs"]
    value["options"] = options
    return value


def request(**option_changes):
    return PaperRequest.from_record(with_options(**option_changes))


def intent(structure="callDebitVertical", **changes):
    long_strike, short_strike = STRIKES[structure]
    value = dict(
        intent_id="intent-1",
        request_id="request-1",
        kind="open",
        strategy_id="strategy-1",
        symbol="SPY",
        structure=structure,
        expiry=EXPIRY,
        long_strike=D(long_strike),
        short_strike=D(short_strike),
        net_limit=D("4.00"),
        signal_date=SIGNAL,
    )
    value.update(changes)
    return SpreadIntent(**value)


def build(the_request=None, the_intent=None, nlv=NLV, **kwargs):
    return PaperSpreadStrategy().build(the_request or request(), the_intent or intent(), nlv, **kwargs)


class PaperRequestTests(unittest.TestCase):
    def test_new_format_loads(self):
        loaded = PaperRequest.from_record(record())
        self.assertEqual((loaded.request_id, loaded.symbol, loaded.mode, loaded.status), ("request-1", "SPY", "paper", "approved"))
        self.assertEqual(loaded.limits, RequestLimits(D("5"), D("10"), 2, D("500")))
        self.assertEqual(loaded.strategy_id, "strategy-1")
        options = loaded.options
        self.assertEqual((options.structure, options.dte_target, options.dte_min), ("callDebitVertical", 45, 21))
        self.assertEqual((options.width_unit, options.width_value, options.anchor_delta), ("sigma", D("1"), D("0.5")))
        self.assertEqual(options.legs, (OptionLeg("anchor", "buy", "call"), OptionLeg("wing", "sell", "call")))
        self.assertEqual((options.budget_pct_of_account, options.max_loss_pct_of_account), (D("1.5"), D("2")))
        self.assertIsNone(options.group)
        self.assertEqual((options.right, options.kind), ("call", "debit"))

    def test_legs_and_group_may_be_left_out_and_legs_follow_the_structure(self):
        expected = {
            "callDebitVertical": (("buy", "call"), ("sell", "call")),
            "putDebitVertical": (("buy", "put"), ("sell", "put")),
            "putCreditVertical": (("sell", "put"), ("buy", "put")),
            "callCreditVertical": (("sell", "call"), ("buy", "call")),
        }
        for structure, (anchor, wing) in expected.items():
            with self.subTest(structure=structure):
                bare = with_options(structure=structure)
                del bare["options"]["group"]
                self.assertNotIn("legs", bare["options"])
                options = PaperRequest.from_record(bare).options
                self.assertEqual(options.legs, (OptionLeg("anchor", *anchor), OptionLeg("wing", *wing)))
                self.assertIsNone(options.group)
                stored = with_options(
                    structure=structure,
                    legs=[
                        {"role": "anchor", "action": anchor[0], "right": anchor[1]},
                        {"role": "wing", "action": wing[0], "right": wing[1]},
                    ],
                )
                self.assertEqual(PaperRequest.from_record(stored).options, options)

    def test_group_must_contain_the_request_symbol(self):
        group = {"key": "index-etfs_1", "symbols": ["SPY", "qqq ", "IWM"]}
        loaded = PaperRequest.from_record(with_options(group=group))
        self.assertEqual(loaded.options.group, OptionGroup("index-etfs_1", ("SPY", "QQQ", "IWM")))
        bad_groups = (
            {"key": "g", "symbols": ["QQQ", "IWM"]},  # without the request symbol
            {"key": "g", "symbols": ["SPY"]},
            {"key": "g", "symbols": ["SPY", "SPY"]},
            {"key": "g", "symbols": ["SPY", "spy"]},
            {"key": "g", "symbols": ["SPY"] + [f"S{index}" for index in range(16)]},
            {"key": "g", "symbols": ["SPY", 5]},
            {"key": "g", "symbols": ["SPY", "Q Q"]},
            {"key": "g", "symbols": "SPY,QQQ"},
            {"key": "", "symbols": ["SPY", "QQQ"]},
            {"key": "-g", "symbols": ["SPY", "QQQ"]},
            {"key": "g", "symbols": ["SPY", "QQQ"], "weight": 1},
            {"symbols": ["SPY", "QQQ"]},
            ["SPY", "QQQ"],
            "SPY",
        )
        for index, bad in enumerate(bad_groups):
            with self.subTest(index=index), self.assertRaises(RequestError) as caught:
                PaperRequest.from_record(with_options(group=bad))
            self.assertEqual(caught.exception.code, "options_invalid")

    def test_old_format_loads_with_no_options(self):
        old = record()
        del old["options"]
        self.assertIsNone(PaperRequest.from_record(old).options)
        self.assertIsNone(PaperRequest.from_record(record(options=None)).options)

    def test_unknown_mode_is_refused_and_live_loads_as_live(self):
        for mode in ("sandbox", "PAPER", "", None, 5):
            with self.subTest(mode=mode), self.assertRaises(RequestError) as caught:
                PaperRequest.from_record(record(mode=mode))
            self.assertEqual(caught.exception.code, "unknown_mode")
        missing = record()
        del missing["mode"]
        with self.assertRaises(RequestError) as caught:
            PaperRequest.from_record(missing)
        self.assertEqual(caught.exception.code, "unknown_mode")
        # A record that claims live loads as what it claims; the strategy refuses it.
        self.assertEqual(PaperRequest.from_record(record(mode="live")).mode, "live")

    def test_max_loss_above_the_ceiling_is_refused(self):
        for value in (2.5, 2.01, 100):
            with self.subTest(value=value), self.assertRaises(RequestError) as caught:
                PaperRequest.from_record(with_options(maxLossPctOfAccount=value))
            self.assertEqual(caught.exception.code, "max_loss_pct_above_ceiling")
            self.assertIn("ceiling", caught.exception.detail)
        self.assertEqual(request(maxLossPctOfAccount=2).options.max_loss_pct_of_account, D("2"))
        self.assertEqual(request(maxLossPctOfAccount=0.5, budgetPctOfAccount=0.5).options.max_loss_pct_of_account, D("0.5"))
        legs = (OptionLeg("anchor", "buy", "call"), OptionLeg("wing", "sell", "call"))
        with self.assertRaises(RequestError) as caught:
            OptionsBlock("callDebitVertical", 45, 21, "sigma", D("1"), D("0.5"), legs, D("1"), D("2.5"))
        self.assertEqual(caught.exception.code, "max_loss_pct_above_ceiling")

    def test_malformed_options_are_refused(self):
        bad_blocks = {
            "not an object": ["callDebitVertical"],
            "text": "callDebitVertical",
            "empty": {},
        }
        for name, block in bad_blocks.items():
            with self.subTest(block=name), self.assertRaises(RequestError) as caught:
                PaperRequest.from_record(record(options=block))
            self.assertEqual(caught.exception.code, "options_invalid")
        for key in ("structure", "dte", "width", "anchorDelta", "budgetPctOfAccount", "maxLossPctOfAccount"):
            missing = record()
            del missing["options"][key]
            with self.subTest(missing=key), self.assertRaises(RequestError) as caught:
                PaperRequest.from_record(missing)
            self.assertEqual(caught.exception.code, "options_invalid")
        # Keys of the first drafts of the block and other unknown keys are refused, nested ones too.
        for change in (
            {"sleeveKey": "core-spy"},
            {"expiry": {"cycle": "monthly"}},
            {"exitDte": 3},
            {"dte": {"target": 45, "min": 21, "cycle": "monthly"}},
            {"width": {"unit": "sigma", "value": 1, "note": "x"}},
            {"legs": [{"role": "anchor", "action": "buy", "right": "call", "strike": 680}, {"role": "wing", "action": "sell", "right": "call"}]},
        ):
            with self.subTest(unknown=sorted(change)), self.assertRaises(RequestError) as caught:
                PaperRequest.from_record(with_options(**change))
            self.assertEqual(caught.exception.code, "options_invalid")
            self.assertIn("not a recognized field", caught.exception.detail)
        bad_values = (
            {"structure": "ironCondor"},
            {"structure": None},
            {"dte": 45},
            {"dte": {"target": 45}},
            {"dte": {"target": 0, "min": 0}},
            {"dte": {"target": 731, "min": 21}},
            {"dte": {"target": 45, "min": -1}},
            {"dte": {"target": 45, "min": 46}},
            {"dte": {"target": 45.5, "min": 21}},
            {"dte": {"target": "45", "min": 21}},
            {"dte": {"target": True, "min": 0}},
            {"width": 1},  # a bare number does not say which unit it is in
            {"width": {"unit": "points", "value": 1}},
            {"width": {"unit": "sigma", "value": 0}},
            {"width": {"unit": "price", "value": 10000.5}},
            {"width": {"unit": "price", "value": "5"}},
            {"width": {"unit": "price"}},
            {"anchorDelta": 0},
            {"anchorDelta": 1},
            {"anchorDelta": -0.3},
            {"anchorDelta": "0.5"},
            {"legs": []},
            {"legs": [{"role": "anchor", "action": "buy", "right": "call"}]},
            {"legs": [{"role": "wing", "action": "sell", "right": "call"}, {"role": "anchor", "action": "buy", "right": "call"}]},
            {"legs": [{"role": "anchor", "action": "sell", "right": "call"}, {"role": "wing", "action": "buy", "right": "call"}]},
            {"legs": [{"role": "anchor", "action": "buy", "right": "put"}, {"role": "wing", "action": "sell", "right": "put"}]},
            {"legs": [{"role": "anchor", "action": "BUY", "right": "call"}, {"role": "wing", "action": "SELL", "right": "call"}]},
            {"legs": ["anchor", "wing"]},
            {"maxLossPctOfAccount": 0},
            {"maxLossPctOfAccount": -1},
            {"maxLossPctOfAccount": "2"},
            {"maxLossPctOfAccount": float("nan")},
            {"maxLossPctOfAccount": True},
            {"budgetPctOfAccount": 0},
            {"budgetPctOfAccount": 2.01},  # above maxLossPctOfAccount
            {"budgetPctOfAccount": float("inf")},
            {"budgetPctOfAccount": None},
        )
        for change in bad_values:
            with self.subTest(change=change), self.assertRaises(RequestError) as caught:
                PaperRequest.from_record(with_options(**change))
            self.assertEqual(caught.exception.code, "options_invalid")

    def test_malformed_request_is_refused(self):
        bad = (
            record(id=""),
            record(id=None),
            record(strategyId=None),
            record(strategyId=""),
            record(symbol=5),
            record(status="live"),
            record(limits=None),
            record(limits={"maxOrderSize": 0, "maxPosition": 10, "maxOrdersPerMinute": 2, "dailyLossLimit": 500}),
            record(limits={"maxOrderSize": 5, "maxPosition": 10, "maxOrdersPerMinute": 2.5, "dailyLossLimit": 500}),
            record(limits={"maxOrderSize": 5, "maxPosition": 10, "maxOrdersPerMinute": 2}),
        )
        for index, value in enumerate(bad):
            with self.subTest(index=index), self.assertRaises(RequestError) as caught:
                PaperRequest.from_record(value)
            self.assertEqual(caught.exception.code, "malformed_request")
        with self.assertRaises(RequestError):
            PaperRequest.from_record(["not", "a", "record"])


class PaperSpreadStrategyTests(unittest.TestCase):
    def assert_refused(self, code, *args, **kwargs):
        with self.assertRaises(StrategyRefusal) as caught:
            build(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_builds_one_combo_from_request_and_intent(self):
        order = build()
        self.assertEqual((order.request_id, order.intent_id, order.kind), ("request-1", "intent-1", "open"))
        self.assertEqual((order.symbol, order.strategy_id, order.structure), ("SPY", "strategy-1", "callDebitVertical"))
        self.assertEqual((order.action, order.net_side, order.net_limit), ("BUY", "debit", D("4.00")))
        # Budget 1.5% of 100000 = 1500; one contract can lose 4.00 x 100 = 400: 3 contracts.
        self.assertEqual(order.quantity, 3)
        self.assertEqual((order.max_loss_total, order.max_loss_pct_of_account), (D("1200"), D("1.2")))
        self.assertEqual(
            order.legs,
            (OrderLeg("BUY", "call", D("680"), EXPIRY, D("100")), OrderLeg("SELL", "call", D("690"), EXPIRY, D("100"))),
        )
        self.assertIsNone(order.close_reason)
        self.assertEqual(json.loads(json.dumps(order.to_json()))["legs"][1]["action"], "SELL")

    def test_strikes_and_expiry_come_from_the_intent_only(self):
        other = intent(long_strike=D("650"), short_strike=D("655"), expiry=date(2026, 12, 31), net_limit=D("2.50"))
        order = build(the_intent=other)
        self.assertEqual([leg.strike for leg in order.legs], [D("650"), D("655")])
        self.assertEqual({leg.expiry for leg in order.legs}, {date(2026, 12, 31)})

    def test_each_structure_gives_its_legs_and_max_loss(self):
        expected = {
            # structure: (right, net side, max loss of one contract at a 4.00 limit and a 10 wide spread)
            "callDebitVertical": ("call", "debit", D("400")),
            "putDebitVertical": ("put", "debit", D("400")),
            "putCreditVertical": ("put", "credit", D("600")),
            "callCreditVertical": ("call", "credit", D("600")),
        }
        for structure, (right, side, one) in expected.items():
            with self.subTest(structure=structure):
                order = build(request(structure=structure, budgetPctOfAccount=2), intent(structure))
                long_strike, short_strike = STRIKES[structure]
                self.assertEqual((order.long_leg.action, order.long_leg.strike), ("BUY", D(long_strike)))
                self.assertEqual((order.short_leg.action, order.short_leg.strike), ("SELL", D(short_strike)))
                self.assertEqual({leg.right for leg in order.legs}, {right})
                self.assertEqual(order.net_side, side)
                self.assertEqual(order.quantity, 2000 // one)
                self.assertEqual(order.max_loss_total, one * order.quantity)

    def test_mode_not_paper_is_checked_first(self):
        live = PaperRequest.from_record(record(mode="live"))
        self.assert_refused("mode_not_paper", live)
        # Everything else is wrong too: the mode still decides.
        old_draft_live = record(mode="live", status="draft", symbol="QQQ")
        del old_draft_live["options"]
        self.assert_refused("mode_not_paper", PaperRequest.from_record(old_draft_live))
        self.assert_refused("mode_not_paper", PaperRequest.from_record(old_draft_live), intent(kind="close", close_reason=REASON_ROLL), held_quantity=1)
        built_in_python = PaperRequest("request-1", "strategy-1", "SPY", "sandbox", "approved", RequestLimits(D("5"), D("10"), 2, D("500")))
        self.assert_refused("mode_not_paper", built_in_python)

    def test_request_not_approved(self):
        for status in ("draft", "requested", "rejected", "withdrawn"):
            with self.subTest(status=status):
                self.assert_refused("request_not_approved", PaperRequest.from_record(record(status=status)))

    def test_old_format_request_has_no_option_structure(self):
        old = record()
        del old["options"]
        self.assert_refused("no_option_structure", PaperRequest.from_record(old))

    def test_identity_mismatches(self):
        self.assert_refused("symbol_mismatch", the_intent=intent(symbol="QQQ"))
        self.assert_refused("symbol_mismatch", the_intent=intent(symbol="spy"))
        # The sleeve is the strategy of the request.
        self.assert_refused("sleeve_mismatch", the_intent=intent(strategy_id="strategy-2"))
        self.assert_refused("sleeve_mismatch", PaperRequest.from_record(record(strategyId="strategy-2")))
        self.assert_refused("request_id_mismatch", the_intent=intent(request_id="request-2"))
        self.assert_refused("intent_kind_invalid", the_intent=intent(kind="roll"))

    def test_structure_mismatch(self):
        for structure in ("putDebitVertical", "putCreditVertical", "callCreditVertical", "ironCondor"):
            with self.subTest(intent_structure=structure):
                strikes = STRIKES.get(structure, ("680", "690"))
                other = intent(structure="callDebitVertical", long_strike=D(strikes[0]), short_strike=D(strikes[1]))
                self.assert_refused("structure_mismatch", the_intent=SpreadIntent(**{**other.__dict__, "structure": structure}))
        # The right structure with the strikes the wrong way round: debit call = long the lower strike, and so on.
        for structure, (long_strike, short_strike) in STRIKES.items():
            with self.subTest(structure=structure):
                swapped = intent(structure, long_strike=D(short_strike), short_strike=D(long_strike))
                self.assert_refused("structure_mismatch", request(structure=structure), swapped)
                same = intent(structure, long_strike=D(long_strike), short_strike=D(long_strike))
                self.assert_refused("structure_mismatch", request(structure=structure), same)

    def test_expiry_outside_request(self):
        # dte.min 21, dte.target 45: allowed 21 to 90 days after the signal date.
        for days, allowed in ((20, False), (21, True), (90, True), (91, False), (0, False), (-5, False)):
            with self.subTest(days=days):
                the_intent = intent(expiry=date.fromordinal(SIGNAL.toordinal() + days))
                if allowed:
                    self.assertEqual(build(the_intent=the_intent).long_leg.expiry, the_intent.expiry)
                else:
                    self.assert_refused("expiry_outside_request", the_intent=the_intent)
        same_day = request(dte={"target": 7, "min": 0})
        self.assertEqual(build(same_day, intent(expiry=SIGNAL)).long_leg.expiry, SIGNAL)
        self.assert_refused("expiry_outside_request", same_day, intent(expiry=date.fromordinal(SIGNAL.toordinal() + 53)))

    def test_max_loss_exceeded_by_the_request_value(self):
        # One contract can lose 400 = 0.4% of the account.
        self.assert_refused("max_loss_exceeded", request(maxLossPctOfAccount=0.39, budgetPctOfAccount=0.39))
        self.assertEqual(build(request(maxLossPctOfAccount=0.4, budgetPctOfAccount=0.4)).quantity, 1)
        self.assert_refused("max_loss_exceeded", nlv=D("19999"))
        self.assertEqual(build(nlv=D("26667")).quantity, 1)

    def test_max_loss_exceeded_by_the_two_percent_ceiling_whatever_the_request_says(self):
        forged = request()
        # No loader gives such a block; write past the checks to prove the strategy has its own ceiling.
        object.__setattr__(forged.options, "max_loss_pct_of_account", D("50"))
        object.__setattr__(forged.options, "budget_pct_of_account", D("50"))
        wide = intent(long_strike=D("600"), short_strike=D("700"), net_limit=D("25.00"))  # 2500 = 2.5%
        self.assert_refused("max_loss_exceeded", forged, wide)
        at_ceiling = intent(long_strike=D("600"), short_strike=D("700"), net_limit=D("20.00"))  # 2000 = 2%
        self.assertEqual(build(forged, at_ceiling).quantity, 1)
        # A budget above the ceiling is cut down: 5 contracts of 400 = 2%, not the 50% budget.
        roomy = RequestLimits(D("500"), D("500"), 2, D("500"))
        order = build(PaperRequest(forged.request_id, forged.strategy_id, forged.symbol, "paper", "approved", roomy, forged.options))
        self.assertEqual((order.quantity, order.max_loss_pct_of_account), (5, D("2")))

    def test_sized_to_zero(self):
        self.assert_refused("sized_to_zero", request(budgetPctOfAccount=0.39))
        small_order = record()
        small_order["limits"]["maxOrderSize"] = 0.5
        self.assert_refused("sized_to_zero", PaperRequest.from_record(small_order))

    def test_size_is_floored_and_capped_by_max_order_size(self):
        self.assertEqual(build(request(budgetPctOfAccount=1.99)).quantity, 4)  # 1990 / 400
        self.assertEqual(build(request(budgetPctOfAccount=2)).quantity, 5)
        capped = record()
        capped["limits"]["maxOrderSize"] = 2.9
        order = build(PaperRequest.from_record(capped))
        self.assertEqual((order.quantity, order.max_loss_total), (2, D("800")))

    def test_implausible_limit_and_account_value(self):
        self.assert_refused("limit_implausible", the_intent=intent(net_limit=D("10.00")))
        self.assert_refused("limit_implausible", request(structure="putCreditVertical"), intent("putCreditVertical", net_limit=D("10.50")))
        for nlv in (D("0"), D("-1"), None, 100000.0, D("NaN")):
            with self.subTest(nlv=nlv):
                self.assert_refused("account_value_invalid", nlv=nlv)

    def test_ambient_decimal_context_cannot_change_the_size(self):
        with localcontext() as context:
            context.prec = 2
            order = build(request(budgetPctOfAccount=1.99), nlv=D("100000.37"))
        self.assertEqual((order.quantity, order.max_loss_total), (4, D("1600.00")))
        self.assertEqual(order.max_loss_pct_of_account, D("1.599995"))  # rounded up, never understated

    def test_close_builds_the_reverse_combo_for_the_held_quantity(self):
        for structure, (long_strike, short_strike) in STRIKES.items():
            with self.subTest(structure=structure):
                the_request = request(structure=structure, budgetPctOfAccount=0.01)
                closing = intent(structure, kind="close", close_reason=REASON_LOSER, net_limit=D("0.05"), signal_date=date(2026, 12, 15))
                # 40 contracts: above the budget, above maxOrderSize, and 3 days before the expiry.
                order = build(the_request, closing, None, held_quantity=40)
                self.assertEqual((order.kind, order.quantity, order.close_reason), ("close", 40, REASON_LOSER))
                self.assertEqual((order.long_leg.action, order.long_leg.strike), ("SELL", D(long_strike)))
                self.assertEqual((order.short_leg.action, order.short_leg.strike), ("BUY", D(short_strike)))
                self.assertEqual(order.net_side, "credit" if "Debit" in structure else "debit")
                self.assertEqual((order.max_loss_total, order.max_loss_pct_of_account), (D("0"), D("0")))

    def test_close_is_allowed_after_the_request_was_withdrawn(self):
        withdrawn = PaperRequest.from_record(record(status="withdrawn"))
        order = build(withdrawn, intent(kind="close", close_reason=REASON_WINNER), None, held_quantity=2)
        self.assertEqual((order.kind, order.quantity), ("close", 2))

    def test_close_refusals(self):
        closing = intent(kind="close", close_reason=REASON_ROLL)
        for quantity in (None, 0, -1, 2.0, True):
            with self.subTest(quantity=quantity):
                self.assert_refused("quantity_invalid", the_intent=closing, held_quantity=quantity)
        self.assert_refused("close_reason_invalid", the_intent=intent(kind="close"), held_quantity=1)
        self.assert_refused("close_reason_invalid", the_intent=intent(kind="close", close_reason="because"), held_quantity=1)
        self.assert_refused("symbol_mismatch", the_intent=intent(kind="close", close_reason=REASON_ROLL, symbol="QQQ"), held_quantity=1)
        self.assert_refused("quantity_invalid", held_quantity=1)  # an open intent with a held quantity
        self.assert_refused("close_reason_invalid", the_intent=intent(close_reason=REASON_ROLL))

    def test_malformed_intent_and_order_cannot_be_built(self):
        for change in ({"net_limit": D("0")}, {"net_limit": 4.0}, {"long_strike": D("-1")}, {"expiry": "2026-12-18"}, {"intent_id": ""}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                intent(**change)
        order = build()
        with self.assertRaises(ValueError):
            ComboOrder(**{**order.__dict__, "legs": order.legs[:1]})
        with self.assertRaises(ValueError):
            ComboOrder(**{**order.__dict__, "legs": order.legs + order.legs[:1]})
        with self.assertRaises(ValueError):
            ComboOrder(**{**order.__dict__, "legs": (order.legs[0], order.legs[0])})
        with self.assertRaises(ValueError):
            ComboOrder(**{**order.__dict__, "quantity": 0})
        with self.assertRaises(TypeError):
            PaperSpreadStrategy().build(record(), intent(), NLV)


def fake_module(check):
    return SimpleNamespace(check_order_policy=check, ORDER_POLICY="fake_policy")


class Refused(RuntimeError):
    def __init__(self, code, detail):
        super().__init__(code)
        self.code = code
        self.detail = detail


class PolicyPortTests(unittest.TestCase):
    def test_test_policies(self):
        order = build()
        self.assertEqual(allow_all()(order), PolicyDecision(True, "allow_all", "test policy: every order is allowed"))
        refused = refuse_all("combo_refused")(order)
        self.assertEqual((refused.allowed, refused.code), (False, "combo_refused"))
        with self.assertRaises(ValueError):
            refuse_all("")
        with self.assertRaises(ValueError):
            PolicyDecision("yes", "code", "detail")

    def test_shapes_are_a_bought_bag_with_a_signed_net_limit(self):
        cases = (
            ("callDebitVertical", "open", 4.0),
            ("putCreditVertical", "open", -4.0),
            ("callDebitVertical", "close", -4.0),  # sells the debit spread: a credit
            ("callCreditVertical", "close", 4.0),  # buys the credit spread back: a debit
        )
        for structure, kind, limit in cases:
            with self.subTest(structure=structure, kind=kind):
                if kind == "open":
                    order = build(request(structure=structure), intent(structure))
                else:
                    closing = intent(structure, kind="close", close_reason=REASON_ROLL)
                    order = build(request(structure=structure), closing, None, held_quantity=3)
                contract, ib_order, legs = ibkr_shapes(order)
                self.assertEqual((contract.secType, contract.symbol, contract.currency), ("BAG", "SPY", "USD"))
                self.assertEqual((ib_order.action, ib_order.orderType, ib_order.lmtPrice), ("BUY", "LMT", limit))
                self.assertEqual(ib_order.totalQuantity, D(order.quantity))
                self.assertEqual([leg.action for leg in contract.comboLegs], [leg.action for leg in order.legs])
                self.assertEqual([leg.ratio for leg in contract.comboLegs], [1, 1])
                self.assertEqual([leg.conId for leg in contract.comboLegs], [leg.conId for leg in legs])
                self.assertEqual(len({leg.conId for leg in legs}), 2)
                for leg, source in zip(legs, order.legs):
                    self.assertEqual((leg.secType, leg.symbol, leg.tradingClass, leg.multiplier), ("OPT", "SPY", "SPY", "100"))
                    self.assertEqual(leg.lastTradeDateOrContractMonth, "20261218")
                    self.assertEqual((leg.right, leg.strike), (source.right[0].upper(), float(source.strike)))
                    self.assertEqual(leg.conId, synthetic_con_id("SPY", source))

    def test_synthetic_con_id_is_stable_and_positive(self):
        leg = OrderLeg("BUY", "call", D("680"), EXPIRY, D("100"))
        same = OrderLeg("SELL", "call", D("680.0"), EXPIRY, D("100.00"))
        self.assertEqual(synthetic_con_id("SPY", leg), synthetic_con_id("SPY", same))
        self.assertNotEqual(synthetic_con_id("SPY", leg), synthetic_con_id("QQQ", leg))
        self.assertTrue(0 < synthetic_con_id("SPY", leg) < 2**31)

    def test_v2_signature_gets_no_legs_and_its_refusal_is_mapped(self):
        calls = []

        def check_order_policy(contract, order, *, order_id=None, client=None, env=None, now=None):
            calls.append((contract, order, order_id, client, env, now))
            raise Refused("combo_refused", "BAG/combo orders are not allowed")

        env = {"NAUTILUS_ACCOUNT_SNAPSHOT_DIR": "/nonexistent/paper-deploy-test"}
        policy = ArmGatePolicy(fake_module(check_order_policy), env)
        self.assertFalse(policy.passes_legs)
        self.assertEqual(policy(build()), PolicyDecision(False, "combo_refused", "BAG/combo orders are not allowed"))
        contract, order, order_id, client, seen_env, now = calls[0]
        self.assertEqual((contract.secType, order.action, order_id, client, now), ("BAG", "BUY", None, None, None))
        self.assertEqual(seen_env, env)
        self.assertEqual(env, {"NAUTILUS_ACCOUNT_SNAPSHOT_DIR": "/nonexistent/paper-deploy-test"})

    def test_v3_signature_gets_the_leg_contracts(self):
        seen = {}

        def check_order_policy(contract, order, *, order_id=None, client=None, env=None, now=None, legs=None):
            seen.update(contract=contract, legs=legs, client=client, now=now)
            return "vertical_spread_open"

        policy = ArmGatePolicy(fake_module(check_order_policy), {}, clock=lambda: 1234.5)
        self.assertTrue(policy.passes_legs)
        self.assertEqual(policy(build()), PolicyDecision(True, "vertical_spread_open", "allowed by fake_policy"))
        self.assertEqual([leg.conId for leg in seen["legs"]], [leg.conId for leg in seen["contract"].comboLegs])
        self.assertEqual([leg.secType for leg in seen["legs"]], ["OPT", "OPT"])
        self.assertEqual((seen["client"], seen["now"]), (None, 1234.5))

        def with_keywords(contract, order, **keywords):
            seen["keywords"] = sorted(keywords)
            return "vertical_spread_close"

        self.assertTrue(ArmGatePolicy(fake_module(with_keywords), {})(build()).allowed)
        self.assertEqual(seen["keywords"], ["client", "env", "legs", "now", "order_id"])

    def test_adapter_fails_closed(self):
        def broken(contract, order, **keywords):
            raise OSError("snapshot directory unreadable")

        decision = ArmGatePolicy(fake_module(broken), {})(build())
        self.assertEqual((decision.allowed, decision.code), (False, "policy_error"))
        self.assertIn("OSError", decision.detail)
        for value in (None, "", True, 1):
            with self.subTest(returned=value):
                decision = ArmGatePolicy(fake_module(lambda contract, order, **keywords: value), {})(build())
                self.assertEqual((decision.allowed, decision.code), (False, "policy_result_invalid"))

        def half_error(contract, order, **keywords):
            raise Refused(None, "no code")

        self.assertEqual(ArmGatePolicy(fake_module(half_error), {})(build()).code, "policy_error")
        with self.assertRaises(TypeError):
            ArmGatePolicy(SimpleNamespace(), {})
        with self.assertRaises(TypeError):
            ArmGatePolicy(fake_module(broken), {"KEY": 1})
        with self.assertRaises(TypeError):
            ArmGatePolicy(fake_module(broken), {})({"not": "an order"})
        with self.assertRaises(ValueError):
            ArmGatePolicy(fake_module(broken), {}, con_id_of=lambda symbol, leg: 0)(build())


def load_engine_policy():
    spec = importlib.util.spec_from_file_location("paper_deploy_test_arm_gate", ARM_GATE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class EnginePolicyTests(unittest.TestCase):
    """The adapter against the engine order policy file itself (read-only checks in a temp folder)."""

    @classmethod
    def setUpClass(cls):
        if not ARM_GATE.is_file():
            raise AssertionError(f"engine order policy not found at {ARM_GATE}")
        cls.arm_gate = load_engine_policy()

    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="paper-deploy-policy-")
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.now = time.time()
        # Every path the policy can read stays inside the temp folder.
        self.env = {"NAUTILUS_ACCOUNT_SNAPSHOT_DIR": str(self.folder)}
        for name in ("RESERVATIONS_ENV", "OPEN_RISK_ENV"):
            variable = getattr(self.arm_gate, name, None)
            if variable:
                self.env[variable] = str(self.folder / f"{name.lower()}.json")

    def snapshot(self, positions):
        """The account snapshot the policy reads. Written by the test, never by the adapter."""

        for old in self.folder.glob("ibkr-account-snapshot-*.json"):
            old.unlink()
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(self.now))
        (self.folder / f"ibkr-account-snapshot-{stamp}.json").write_text(
            json.dumps(
                {
                    "schemaVersion": "ibkr-account-snapshot/v1",
                    "captured_at_epoch": self.now - 1,
                    "positions": positions,
                    "summary": {"NetLiquidation": {"USD": "100000.00"}},
                }
            )
        )

    def orders(self):
        for structure in STRIKES:
            the_request = request(structure=structure)
            opening = build(the_request, intent(structure))
            closing = build(the_request, intent(structure, kind="close", close_reason=REASON_ROLL), None, held_quantity=opening.quantity)
            yield structure, opening, closing

    def test_without_the_spreads_switch_every_combo_is_refused(self):
        policy = ArmGatePolicy(self.arm_gate, self.env, clock=lambda: self.now)
        for structure, opening, closing in self.orders():
            for order in (opening, closing):
                with self.subTest(structure=structure, kind=order.kind):
                    decision = policy(order)
                    self.assertEqual((decision.allowed, decision.code), (False, "combo_refused"))
        self.assertEqual(list(self.folder.iterdir()), [])  # the adapter wrote nothing

    def test_with_the_spreads_switch_a_vertical_is_allowed(self):
        switch = getattr(self.arm_gate, "SPREADS_FLAG_ENV", None)
        if switch is None:
            self.skipTest(f"{self.arm_gate.ORDER_POLICY} has no spreads switch (it refuses every combo)")
        env = {**self.env, switch: "owner-decision:https://discord.com/channels/11111/22222/33333"}
        policy = ArmGatePolicy(self.arm_gate, env, clock=lambda: self.now)
        self.assertTrue(policy.passes_legs)
        for structure, opening, closing in self.orders():
            with self.subTest(structure=structure):
                self.snapshot([])
                self.assertEqual(policy(opening), PolicyDecision(True, "vertical_spread_open", f"allowed by {self.arm_gate.ORDER_POLICY}"))
                held = [
                    {
                        "symbol": "SPY",
                        "sec_type": "OPT",
                        "currency": "USD",
                        "quantity": sign * opening.quantity,
                        "contract": {
                            "symbol": "SPY",
                            "secType": "OPT",
                            "exchange": "",
                            "currency": "USD",
                            "lastTradeDateOrContractMonth": leg.expiry.strftime("%Y%m%d"),
                            "strike": float(leg.strike),
                            "right": leg.right[0].upper(),
                            "multiplier": "100",
                            "tradingClass": "SPY",
                            "conId": synthetic_con_id("SPY", leg),
                        },
                    }
                    for leg, sign in ((opening.long_leg, 1), (opening.short_leg, -1))
                ]
                self.snapshot(held)
                self.assertEqual(policy(closing).code, "vertical_spread_close")
        self.assertEqual([path.name[:22] for path in self.folder.iterdir()], ["ibkr-account-snapshot-"])


if __name__ == "__main__":
    unittest.main()
