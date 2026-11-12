"""Simulated paper venue and the paper path end to end. Offline: no broker, no network, no clock."""
from datetime import date, datetime, timedelta
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

from vertex_execution.paper_deploy.calendar import NEW_YORK
from vertex_execution.paper_deploy.exit_rule import REASON_LOSER, REASON_ROLL, REASON_WINNER, SpreadMark
from vertex_execution.paper_deploy.policy import ArmGatePolicy, PolicyDecision, allow_all, refuse_all
from vertex_execution.paper_deploy.request import PaperRequest, RequestError
from vertex_execution.paper_deploy.runner import PaperPath
from vertex_execution.paper_deploy.strategy import PaperSpreadStrategy, SpreadIntent
from vertex_execution.paper_deploy.venue import (
    LegQuote,
    PaperFill,
    PaperVenueModel,
    SimulatedPaperVenue,
    SpreadQuote,
    VenueRefusal,
    epoch_ns,
)

D = Decimal
NLV = D("100000")
SIGNAL = date(2026, 11, 11)
EXPIRY = date(2026, 12, 18)  # a Friday; the loser cut day is Tuesday 2026-12-15
CUT_DAY = date(2026, 12, 15)
STRIKES = {
    "callDebitVertical": ("680", "690"),
    "putDebitVertical": ("690", "680"),
    "putCreditVertical": ("680", "690"),
    "callCreditVertical": ("690", "680"),
}
ARM_GATE = Path(__file__).resolve().parents[3] / "infra/quant-vps/exec-node/runtime/nautilus/arm_gate.py"


def at(year, month, day, hour, minute, second=0):
    return datetime(year, month, day, hour, minute, second, tzinfo=NEW_YORK)


OPENED = at(2026, 11, 12, 10, 0)


def model(**changes):
    value = dict(
        tick_size=D("0.01"),
        fee_per_contract=D("0.65"),
        fee_rate=D("0"),
        minimum_fee=D("0"),
        slippage_bps=D("0"),
        slippage_ticks=1,
        quote_ttl_ns=5_000_000_000,
        submit_latency_ns=0,
        depth_fraction=D("1"),
        participation_rate=D("1"),
        max_fill_contracts=1000,
    )
    value.update(changes)
    return PaperVenueModel(**value)


def record(structure="callDebitVertical", **changes):
    value = {
        "id": "request-1",
        "strategyId": "strategy-1",
        "symbol": "SPY",
        "timeframe": "1d",
        "mode": "paper",
        "limits": {"maxOrderSize": 5, "maxPosition": 10, "maxOrdersPerMinute": 2, "dailyLossLimit": 500},
        "options": {
            "structure": structure,
            "dte": {"target": 45, "min": 21},
            "width": {"unit": "sigma", "value": 1},
            "anchorDelta": 0.5,
            "budgetPctOfAccount": 1.5,
            "maxLossPctOfAccount": 2,
            "group": None,
        },
        "status": "approved",
        "executionAuthorized": False,
        "brokerSubmissionAllowed": False,
    }
    value.update(changes)
    return value


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


def quote(now, long=("7.90", "8.00"), short=("4.30", "4.40"), size=50, age=timedelta(seconds=1)):
    """Bid and ask of the leg at the long strike and of the leg at the short strike."""

    return SpreadQuote(
        epoch_ns(now - age),
        LegQuote(D(long[0]), D(long[1]), size, size),
        LegQuote(D(short[0]), D(short[1]), size, size),
    )


def order_for(structure="callDebitVertical", net_limit="4.00", **intent_changes):
    request = PaperRequest.from_record(record(structure))
    return PaperSpreadStrategy().build(request, intent(structure, net_limit=D(net_limit), **intent_changes), NLV)


def mark(now, spot=None, close_value=None):
    return SpreadMark(now - timedelta(seconds=30), None if spot is None else D(spot), None if close_value is None else D(close_value))


class SimulatedPaperVenueTests(unittest.TestCase):
    def fill(self, order, the_quote=None, now=OPENED, **model_changes):
        venue = SimulatedPaperVenue(model(**model_changes))
        result = venue.fill(order, the_quote or quote(now), epoch_ns(now))
        # A refusal keeps nothing; a fill is kept once.
        self.assertEqual(venue.fills, (result,) if isinstance(result, PaperFill) else ())
        return result

    def assert_refused(self, code, *args, **kwargs):
        result = self.fill(*args, **kwargs)
        self.assertIsInstance(result, VenueRefusal)
        self.assertEqual(result.code, code, result.detail)
        return result

    def test_buy_leg_fills_at_ask_and_sell_leg_at_bid_with_slippage_and_fees(self):
        fill = self.fill(order_for())  # 3 contracts, net debit limit 4.00
        self.assertEqual((fill.venue, fill.kind, fill.quantity, fill.net_side), ("simulated-paper", "open", 3, "debit"))
        self.assertEqual((fill.order.intent_id, fill.order.legs[0].strike), ("intent-1", D("680")))
        bought, sold = fill.legs
        self.assertEqual((bought.action, bought.strike, bought.price), ("BUY", D("680"), D("8.01")))  # ask + 1 tick
        self.assertEqual((sold.action, sold.strike, sold.price), ("SELL", D("690"), D("4.29")))  # bid - 1 tick
        self.assertEqual(fill.net_price, D("3.72"))
        self.assertEqual((bought.fee, sold.fee, fill.fees), (D("1.95"), D("1.95"), D("3.90")))  # 0.65 a contract a leg
        self.assertEqual((fill.gross_cash, fill.net_cash), (D("-1116"), D("-1119.90")))
        self.assertEqual(fill.filled_at_ns, epoch_ns(OPENED) + 1)
        self.assertEqual(len(fill.simulator_state_hash), 64)
        json.dumps(fill.to_json())

    def test_no_fill_when_the_net_is_beyond_the_limit(self):
        refusal = self.assert_refused("limit_not_reached", order_for(net_limit="3.71"))
        self.assertIn("3.72", refusal.detail)
        self.assertEqual(self.fill(order_for(net_limit="3.72")).net_price, D("3.72"))

    def test_credit_order_sells_the_short_leg_at_its_bid(self):
        # Put credit spread: buy the 680 put, sell the 690 put. Quotes: long leg first.
        the_quote = quote(OPENED, long=("3.00", "3.10"), short=("7.20", "7.30"))
        fill = self.fill(order_for("putCreditVertical", net_limit="4.00"), the_quote)
        bought, sold = fill.legs
        self.assertEqual((bought.action, bought.price, sold.action, sold.price), ("BUY", D("3.11"), "SELL", D("7.19")))
        self.assertEqual((fill.net_side, fill.net_price), ("credit", D("4.08")))
        self.assertEqual(fill.gross_cash, D("4.08") * 100 * fill.quantity)
        self.assertEqual(fill.net_cash, fill.gross_cash - fill.fees)
        self.assert_refused("limit_not_reached", order_for("putCreditVertical", net_limit="4.09"), the_quote)

    def test_slippage_in_basis_points_rounds_against_the_order(self):
        fill = self.fill(order_for(), slippage_bps=D("100"), slippage_ticks=0)
        # Buy 8.00 + 1% = 8.08; sell 4.30 - 1% = 4.257, rounded down to the tick.
        self.assertEqual([leg.price for leg in fill.legs], [D("8.08"), D("4.25")])

    def test_fee_model(self):
        fill = self.fill(order_for(), fee_per_contract=D("0"), fee_rate=D("0.001"), minimum_fee=D("1"))
        # 0.1% of 8.01 x 100 x 3 = 2.403; 0.1% of 4.29 x 100 x 3 = 1.287.
        self.assertEqual([leg.fee for leg in fill.legs], [D("2.403"), D("1.287")])
        floor = self.fill(order_for(), fee_per_contract=D("0"), fee_rate=D("0"), minimum_fee=D("1"))
        self.assertEqual(floor.fees, D("2"))

    def test_size_and_market_refusals(self):
        self.assert_refused("insufficient_size", order_for(), quote(OPENED, size=2))
        self.assert_refused("no_market", order_for(), quote(OPENED, short=("0", "0.05")))  # nothing bids for the sold leg
        self.assert_refused("no_market", order_for(), quote(OPENED, size=0))
        self.assert_refused("quote_off_tick", order_for(), quote(OPENED, long=("7.905", "8.00")))
        # The whole size is displayed but the model lets one order take half: one-leg and partial fills are dropped.
        refusal = self.assert_refused("not_filled", order_for(), quote(OPENED, size=3), depth_fraction=D("0.5"))
        self.assertIn("nothing is kept", refusal.detail)
        # Slippage pushes the sold leg to zero: the leg does not fill and the bought leg is dropped with it.
        self.assert_refused("not_filled", order_for(net_limit="0.50"), quote(OPENED, long=("0.30", "0.31"), short=("0.01", "0.02")))

    def test_quote_time_refusals(self):
        self.assert_refused("quote_stale", order_for(), quote(OPENED, age=timedelta(seconds=6)))
        self.assert_refused("quote_from_future", order_for(), quote(OPENED, age=timedelta(seconds=-1)))
        just_open = at(2026, 11, 12, 9, 30, 2)
        self.assert_refused("quote_stale", order_for(), quote(just_open, age=timedelta(seconds=3)), now=just_open)
        self.assertIsInstance(self.fill(order_for(), quote(OPENED, age=timedelta(seconds=4))), PaperFill)

    def test_session_refusals(self):
        closed = (
            at(2026, 11, 14, 11, 0),  # Saturday
            at(2026, 11, 26, 11, 0),  # Thanksgiving
            at(2026, 11, 12, 9, 29, 59),
            at(2026, 11, 12, 16, 0),
            at(2026, 11, 27, 13, 0),  # early close
        )
        for now in closed:
            with self.subTest(now=now):
                self.assert_refused("session_closed", order_for(), now=now)
        for now in (at(2026, 11, 12, 9, 30, 1), at(2026, 11, 12, 15, 59, 59), at(2026, 11, 27, 12, 59)):
            with self.subTest(now=now):
                self.assertIsInstance(self.fill(order_for(), now=now), PaperFill)

    def test_option_does_not_trade_after_its_last_session(self):
        after = at(2026, 12, 21, 10, 0)
        self.assert_refused("option_expired", order_for(), now=after)
        # Good Friday expiry: the last trade is on the Thursday.
        good_friday = order_for(expiry=date(2027, 3, 26), signal_date=date(2027, 2, 22))
        self.assertIsInstance(self.fill(good_friday, now=at(2027, 3, 25, 15, 50)), PaperFill)
        self.assert_refused("session_closed", good_friday, now=at(2027, 3, 26, 10, 0))
        self.assert_refused("option_expired", good_friday, now=at(2027, 3, 29, 10, 0))

    def test_latency_moves_the_fill_time(self):
        fill = self.fill(order_for(), submit_latency_ns=250_000_000)
        self.assertEqual(fill.filled_at_ns, epoch_ns(OPENED) + 250_000_000)
        late = at(2026, 11, 12, 15, 59, 59)
        self.assert_refused("session_closed", order_for(), now=late, submit_latency_ns=1_000_000_000)

    def test_it_cannot_be_given_a_broker_client(self):
        broker = object()
        with self.assertRaises(TypeError):
            SimulatedPaperVenue(broker)
        with self.assertRaises(TypeError):
            SimulatedPaperVenue(model(), client=broker)
        with self.assertRaises(TypeError):
            SimulatedPaperVenue(model(), broker)
        with self.assertRaises(TypeError):
            SimulatedPaperVenue(model(), calendar=broker)
        with self.assertRaises(TypeError):
            SimulatedPaperVenue(model(), provenance_id=broker)
        with self.assertRaises(ValueError):
            SimulatedPaperVenue(model(), provenance_id="")
        venue = SimulatedPaperVenue(model())
        with self.assertRaises(AttributeError):
            venue.client = broker
        with self.assertRaises(TypeError):
            venue.fill(order_for(), quote(OPENED), epoch_ns(OPENED), broker)
        with self.assertRaises(TypeError):
            venue.fill(order_for(), quote(OPENED), epoch_ns(OPENED), client=broker)
        with self.assertRaises(TypeError):
            venue.fill(broker, quote(OPENED), epoch_ns(OPENED))
        with self.assertRaises(TypeError):
            venue.fill(order_for(), broker, epoch_ns(OPENED))
        with self.assertRaises(TypeError):
            venue.fill(order_for(), quote(OPENED), OPENED)
        self.assertEqual({name for name in dir(venue) if not name.startswith("_")}, {"fill", "fills", "provenance_id"})
        self.assertEqual(SimulatedPaperVenue(model(), provenance_id="rehearsal:window-1").provenance_id, "rehearsal:window-1")
        with self.assertRaises(TypeError):
            PaperPath(allow_all(), broker)

    def test_model_and_quote_are_validated(self):
        for change in ({"tick_size": D("0")}, {"fee_rate": D("1.5")}, {"depth_fraction": D("0")}, {"quote_ttl_ns": 0}, {"slippage_ticks": -1}, {"fee_per_contract": 0.65}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                model(**change)
        for bid, ask in (("8.00", "8.00"), ("8.10", "8.00"), ("-1", "8.00"), ("0", "0")):
            with self.subTest(bid=bid, ask=ask), self.assertRaises(ValueError):
                LegQuote(D(bid), D(ask), 1, 1)
        with self.assertRaises(ValueError):
            LegQuote(D("1"), D("2"), 1.5, 1)


class SwitchPolicy:
    """Allows until ``refuse`` is set to a code."""

    def __init__(self):
        self.refuse = None
        self.seen = []

    def __call__(self, order):
        self.seen.append(order)
        if self.refuse:
            return PolicyDecision(False, self.refuse, "switched off")
        return PolicyDecision(True, "test_allow", "switched on")


class PaperPathTests(unittest.TestCase):
    def setUp(self):
        self.venue = SimulatedPaperVenue(model())
        self.policy = SwitchPolicy()
        self.path = PaperPath(self.policy, self.venue)

    def open(self, structure="callDebitVertical", the_quote=None, **intent_changes):
        the_quote = the_quote or quote(OPENED)
        result = self.path.open(record(structure), intent(structure, **intent_changes), NLV, the_quote, OPENED)
        self.assertEqual((result.outcome, result.reached, result.refusal_stage), ("opened", "fill", None), result.refusal_detail)
        return result.position

    def assert_nothing_filled(self, path=None, venue=None):
        self.assertEqual((venue or self.venue).fills, ())
        self.assertEqual((path or self.path).positions, ())

    def test_open_reaches_the_fill_and_books_the_position(self):
        result = self.path.open(record(), intent(), NLV, quote(OPENED), OPENED)
        self.assertEqual((result.operation, result.outcome, result.reached, result.refused), ("open", "opened", "fill", False))
        self.assertEqual((result.order.quantity, result.policy.code, result.fill.net_price), (3, "test_allow", D("3.72")))
        position = result.position
        self.assertEqual(self.path.positions, (position,))
        self.assertEqual(self.path.position("intent-1"), position)
        held = position.held
        self.assertEqual((held.symbol, held.right, held.expiry, held.quantity), ("SPY", "call", EXPIRY, 3))
        self.assertEqual((held.long_strike, held.short_strike), (D("680"), D("690")))
        self.assertEqual((held.entry_cost, held.entered_on), (D("1119.90"), date(2026, 11, 12)))
        self.assertEqual(position.strategy_id, "strategy-1")
        report = json.loads(json.dumps(result.to_json()))
        self.assertEqual((report["reached"], report["refusal"], report["fill"]["netCash"]), ("fill", None, "-1119.90"))
        self.assertEqual(report["position"]["entryCost"], "1119.90")

    def test_non_paper_request_is_refused(self):
        live = self.path.open(record(mode="live"), intent(), NLV, quote(OPENED), OPENED)
        self.assertEqual((live.outcome, live.reached, live.refusal_stage, live.refusal_code), ("refused", "strategy", "strategy", "mode_not_paper"))
        self.assertIsNone(live.order)
        unknown = self.path.open(record(mode="sandbox"), intent(), NLV, quote(OPENED), OPENED)
        self.assertEqual((unknown.reached, unknown.refusal_stage, unknown.refusal_code), ("request", "request", "unknown_mode"))
        self.assertEqual(self.policy.seen, [])
        self.assert_nothing_filled()

    def test_request_above_the_max_loss_ceiling_is_refused_by_from_record(self):
        above = record()
        above["options"]["maxLossPctOfAccount"] = 2.5
        above["options"]["budgetPctOfAccount"] = 2.5
        with self.assertRaises(RequestError) as caught:
            PaperRequest.from_record(above)
        self.assertEqual(caught.exception.code, "max_loss_pct_above_ceiling")
        result = self.path.open(above, intent(), NLV, quote(OPENED), OPENED)
        self.assertEqual((result.reached, result.refusal_stage, result.refusal_code), ("request", "request", "max_loss_pct_above_ceiling"))
        self.assert_nothing_filled()

    def test_old_format_request_loads_and_is_refused(self):
        old = record()
        del old["options"]
        self.assertIsNone(PaperRequest.from_record(old).options)
        result = self.path.open(old, intent(), NLV, quote(OPENED), OPENED)
        self.assertEqual((result.reached, result.refusal_stage, result.refusal_code), ("strategy", "strategy", "no_option_structure"))
        self.assert_nothing_filled()

    def test_refusing_policy_stops_every_combo_at_the_policy_stage(self):
        venue = SimulatedPaperVenue(model())
        path = PaperPath(refuse_all("combo_refused"), venue)
        quotes = {"Debit": quote(OPENED), "Credit": quote(OPENED, long=("3.00", "3.10"), short=("7.20", "7.30"))}
        for structure in STRIKES:
            with self.subTest(structure=structure):
                the_quote = quotes["Debit" if "Debit" in structure else "Credit"]
                result = path.open(record(structure), intent(structure, intent_id=structure), NLV, the_quote, OPENED)
                self.assertEqual((result.outcome, result.reached), ("refused", "policy"))
                self.assertEqual((result.refusal_stage, result.refusal_code), ("policy", "combo_refused"))
                self.assertEqual((result.order.structure, result.policy.allowed, result.fill, result.position), (structure, False, None, None))
        self.assert_nothing_filled(path, venue)

    def test_engine_order_policy_of_this_repository_stops_or_checks_every_combo(self):
        spec = importlib.util.spec_from_file_location("paper_deploy_runner_test_arm_gate", ARM_GATE)
        arm_gate = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = arm_gate
        spec.loader.exec_module(arm_gate)
        with tempfile.TemporaryDirectory(prefix="paper-deploy-runner-") as folder:
            env = {"NAUTILUS_ACCOUNT_SNAPSHOT_DIR": folder}
            for name in ("RESERVATIONS_ENV", "OPEN_RISK_ENV"):
                if getattr(arm_gate, name, None):
                    env[getattr(arm_gate, name)] = str(Path(folder) / f"{name.lower()}.json")
            venue = SimulatedPaperVenue(model())
            path = PaperPath(ArmGatePolicy(arm_gate, env), venue)
            # The spreads switch is not set: the engine policy refuses every combo.
            result = path.open(record(), intent(), NLV, quote(OPENED), OPENED)
            self.assertEqual((result.reached, result.refusal_stage, result.refusal_code), ("policy", "policy", "combo_refused"))
            self.assert_nothing_filled(path, venue)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_policy_that_returns_no_decision_fails_closed(self):
        venue = SimulatedPaperVenue(model())
        path = PaperPath(lambda order: True, venue)
        result = path.open(record(), intent(), NLV, quote(OPENED), OPENED)
        self.assertEqual((result.refusal_stage, result.refusal_code), ("policy", "policy_result_invalid"))
        self.assert_nothing_filled(path, venue)

    def test_strategy_and_fill_refusals_book_nothing(self):
        zero = record()
        zero["options"]["budgetPctOfAccount"] = 0.1
        result = self.path.open(zero, intent(), NLV, quote(OPENED), OPENED)
        self.assertEqual((result.reached, result.refusal_code), ("strategy", "sized_to_zero"))
        closing = intent(kind="close", close_reason=REASON_ROLL)
        self.assertEqual(self.path.open(record(), closing, NLV, quote(OPENED), OPENED).refusal_code, "intent_not_open")
        result = self.path.open(record(), intent(net_limit=D("3.00")), NLV, quote(OPENED), OPENED)
        self.assertEqual((result.reached, result.refusal_stage, result.refusal_code), ("fill", "fill", "limit_not_reached"))
        self.assertEqual((result.order.quantity, result.policy.allowed, result.fill), (5, True, None))
        self.assert_nothing_filled()

    def test_same_intent_cannot_open_twice(self):
        self.open()
        again = self.path.open(record(), intent(), NLV, quote(OPENED), OPENED)
        self.assertEqual((again.reached, again.refusal_stage, again.refusal_code), ("request", "request", "duplicate_intent"))
        self.assertEqual(len(self.path.positions), 1)

    def test_hold_before_any_trigger(self):
        position = self.open()
        now = at(2026, 12, 1, 11, 0)
        result = self.path.evaluate_exit(position, now, mark(now, spot="700", close_value="1500"), None, roll_due=False)
        self.assertEqual((result.operation, result.outcome, result.reached, result.refused), ("exit", "held", "exit", False))
        self.assertEqual((result.exit.action, result.order, result.fill), ("hold", None, None))
        self.assertEqual(self.path.positions, (position,))

    def test_exit_by_loser_cut(self):
        position = self.open()
        now = at(2026, 12, 15, 15, 45)
        closing_quote = quote(now, long=("2.00", "2.10"), short=("0.90", "1.00"))
        result = self.path.evaluate_exit(position, now, mark(now, spot="675", close_value="290"), closing_quote, roll_due=False)
        self.assertEqual((result.outcome, result.reached, result.refusal_stage), ("closed", "fill", None))
        self.assertEqual((result.exit.reason, result.exit.late), (REASON_LOSER, False))
        order = result.order
        self.assertEqual((order.kind, order.quantity, order.close_reason, order.net_side), ("close", 3, REASON_LOSER, "credit"))
        self.assertEqual([(leg.action, leg.strike) for leg in order.legs], [("SELL", D("680")), ("BUY", D("690"))])
        # Sell 680 at 2.00 - 0.01, buy 690 at 1.00 + 0.01: credit 0.98 x 300 = 294, fees 3.90.
        self.assertEqual((result.fill.net_price, result.fill.net_cash), (D("0.98"), D("290.10")))
        self.assertEqual(result.realized_pnl, D("290.10") - D("1119.90"))
        self.assertEqual(self.path.positions, ())
        self.assertEqual(self.path.closed, (result,))
        self.assertEqual(len(self.venue.fills), 2)
        self.assertEqual(json.loads(json.dumps(result.to_json()))["exit"]["reason"], REASON_LOSER)

    def test_exit_by_expiry_day_winner(self):
        position = self.open()
        now = at(2026, 12, 18, 15, 45)
        closing_quote = quote(now, long=("14.90", "15.10"), short=("4.90", "5.10"))
        result = self.path.evaluate_exit(position, now, mark(now, spot="695"), closing_quote, roll_due=False)
        self.assertEqual((result.outcome, result.reached, result.exit.reason), ("closed", "fill", REASON_WINNER))
        # Sell 680 at 14.89, buy 690 at 5.11: credit 9.78 x 300 = 2934, fees 3.90.
        self.assertEqual(result.realized_pnl, D("2934") - D("3.90") - D("1119.90"))
        self.assertEqual(self.path.positions, ())

    def test_exit_by_monthly_roll(self):
        position = self.open()
        now = at(2026, 12, 1, 10, 0)
        closing_quote = quote(now, long=("9.00", "9.10"), short=("5.00", "5.10"))
        result = self.path.evaluate_exit(position.position_id, now, None, closing_quote, roll_due=True)
        self.assertEqual((result.outcome, result.reached, result.exit.reason), ("closed", "fill", REASON_ROLL))
        self.assertEqual(result.order.close_reason, REASON_ROLL)
        self.assertEqual(self.path.positions, ())

    def test_expiry_out_of_the_money_leaves_without_an_order(self):
        position = self.open()
        now = at(2026, 12, 18, 15, 45)
        result = self.path.evaluate_exit(position, now, mark(now, spot="679.99"), None, roll_due=False)
        self.assertEqual((result.outcome, result.reached, result.refused), ("expired", "exit", False))
        self.assertEqual((result.exit.action, result.order, result.policy, result.fill), ("expire", None, None, None))
        self.assertEqual(result.realized_pnl, D("-1119.90"))
        self.assertEqual(self.path.positions, ())
        self.assertEqual(len(self.venue.fills), 1)
        self.assertEqual(len(self.policy.seen), 1)

    def test_not_a_loser_is_stored_and_not_cut_later(self):
        position = self.open()
        now = at(2026, 12, 15, 15, 45)
        result = self.path.evaluate_exit(position, now, mark(now, close_value="1500"), None, roll_due=False)
        self.assertEqual((result.outcome, result.position.loser_checked_on), ("held", CUT_DAY))
        self.assertEqual(self.path.position("intent-1").loser_checked_on, CUT_DAY)
        later = at(2026, 12, 16, 15, 45)
        # The caller still holds the old position object; the book decides.
        result = self.path.evaluate_exit(position, later, mark(later, close_value="5"), quote(later), roll_due=False)
        self.assertEqual((result.outcome, result.exit.late), ("held", False))

    def test_unfilled_close_keeps_the_position_and_is_decided_again(self):
        position = self.open()
        now = at(2026, 12, 15, 15, 45)
        losing = mark(now, close_value="290")
        missing = self.path.evaluate_exit(position, now, losing, None, roll_due=False)
        self.assertEqual((missing.outcome, missing.reached, missing.refusal_stage, missing.refusal_code), ("refused", "fill", "fill", "no_quote"))
        self.assertEqual((missing.exit.reason, missing.order.kind, missing.policy.allowed), (REASON_LOSER, "close", True))
        self.assertEqual(len(self.path.positions), 1)
        self.assertIsNone(self.path.position("intent-1").loser_checked_on)
        closing_quote = quote(now, long=("2.00", "2.10"), short=("0.90", "1.00"))
        priced = self.path.evaluate_exit(position, now, losing, closing_quote, roll_due=False, net_limit=D("1.50"))
        self.assertEqual((priced.refusal_stage, priced.refusal_code), ("fill", "limit_not_reached"))
        self.assertEqual(len(self.path.positions), 1)
        next_day = at(2026, 12, 16, 15, 45)
        closing_quote = quote(next_day, long=("2.00", "2.10"), short=("0.90", "1.00"))
        closed = self.path.evaluate_exit(position, next_day, mark(next_day, close_value="290"), closing_quote, roll_due=False)
        self.assertEqual((closed.outcome, closed.exit.reason, closed.exit.late), ("closed", REASON_LOSER, True))
        self.assertEqual(closed.order.intent_id, "intent-1:close:3")
        self.assertEqual(self.path.positions, ())

    def test_refusing_policy_stops_the_close_and_keeps_the_position(self):
        position = self.open()
        self.policy.refuse = "combo_refused"
        now = at(2026, 12, 1, 10, 0)
        result = self.path.evaluate_exit(position, now, None, quote(now), roll_due=True)
        self.assertEqual((result.outcome, result.reached, result.refusal_stage, result.refusal_code), ("refused", "policy", "policy", "combo_refused"))
        self.assertEqual((result.exit.reason, result.order.kind, result.fill), (REASON_ROLL, "close", None))
        self.assertEqual(len(self.path.positions), 1)
        self.assertEqual(len(self.venue.fills), 1)

    def test_past_expiry_is_an_alert_and_keeps_the_position(self):
        position = self.open()
        now = at(2026, 12, 21, 10, 0)
        result = self.path.evaluate_exit(position, now, None, None, roll_due=True)
        self.assertEqual((result.outcome, result.reached, result.refusal_stage, result.refusal_code), ("alert", "exit", "exit", "past_expiry"))
        self.assertEqual((result.exit.action, result.order), ("expired", None))
        self.assertEqual(len(self.path.positions), 1)
        self.assertEqual(json.loads(json.dumps(result.to_json()))["refusal"]["code"], "past_expiry")

    def test_credit_spread_opens_and_closes_on_expiry_day(self):
        opening_quote = quote(OPENED, long=("3.00", "3.10"), short=("7.20", "7.30"))
        position = self.open("putCreditVertical", opening_quote)
        # One contract can lose 600 and the budget is 1500: 2 contracts. Credit 4.08 x 100 x 2 = 816, fees 2.60.
        self.assertEqual(position.held.quantity, 2)
        self.assertEqual(position.held.entry_cost, -(D("816") - D("2.60")))
        now = at(2026, 12, 18, 15, 45)
        # Spot 685: the short 690 put is in the money. Buy it back at 5.11, sell the 680 put at 0.01.
        closing_quote = quote(now, long=("0.02", "0.05"), short=("5.00", "5.10"))
        result = self.path.evaluate_exit(position, now, mark(now, spot="685"), closing_quote, roll_due=False)
        self.assertEqual((result.outcome, result.exit.reason, result.order.net_side), ("closed", REASON_WINNER, "debit"))
        self.assertEqual([(leg.action, leg.strike) for leg in result.order.legs], [("SELL", D("680")), ("BUY", D("690"))])
        self.assertEqual(result.order.net_limit, D("10"))  # never pays more than the strike width
        self.assertEqual(result.fill.net_price, D("5.10"))
        self.assertEqual(result.realized_pnl, (D("816") - D("2.60")) - (D("1020") + D("2.60")))

    def test_unknown_position_and_bad_inputs(self):
        position = self.open()
        now = at(2026, 12, 1, 10, 0)
        with self.assertRaises(ValueError):
            self.path.evaluate_exit("no-such-position", now, None, None, roll_due=False)
        with self.assertRaises(TypeError):
            self.path.evaluate_exit(position, datetime(2026, 12, 1, 10, 0), None, None, roll_due=False)
        with self.assertRaises(TypeError):
            self.path.open(record(), intent(intent_id="intent-2"), NLV, quote(OPENED), datetime(2026, 11, 12, 10, 0))
        with self.assertRaises(TypeError):
            self.path.open(record(), {"intent": 1}, NLV, quote(OPENED), OPENED)
        with self.assertRaises(TypeError):
            PaperPath("not callable", self.venue)


if __name__ == "__main__":
    unittest.main()
