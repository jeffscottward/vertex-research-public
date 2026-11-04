"""Options-only, defined-risk order policy in ``arm_gate.place_order``.

Owner rule (2026-11-04): options only, risk always defined; closes and
reductions are always allowed. The tests use a real armed ``ArmGate`` in a
temporary directory, synthetic account snapshots and a fake client that only
records ``placeOrder`` calls. Nothing reaches a broker.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "runtime" / "nautilus"))
import arm_gate  # noqa: E402

REASON = "owner test arm for the order policy"
SNAPSHOT_ENV = "NAUTILUS_ACCOUNT_SNAPSHOT_DIR"
MAX_AGE_ENV = "NAUTILUS_ORDER_POLICY_MAX_SNAPSHOT_AGE_SECONDS"


class FakeClient:
    def __init__(self) -> None:
        self.placed: list[tuple[int, object, object]] = []
        self.cancelled: list[int] = []

    def placeOrder(self, order_id, contract, order) -> None:  # noqa: N802 - IBKR API name
        self.placed.append((order_id, contract, order))

    def cancelOrder(self, order_id, manual_cancel_time="") -> None:  # noqa: N802 - IBKR API name
        self.cancelled.append(order_id)


def stock(symbol: str = "AAPL", currency: str = "USD", **extra) -> SimpleNamespace:
    return SimpleNamespace(symbol=symbol, secType="STK", currency=currency, exchange="SMART", **extra)


def option(
    symbol: str = "AAPL",
    expiry: str = "20261120",
    right: str = "C",
    strike: float = 200.0,
    multiplier: str = "100",
    **extra,
) -> SimpleNamespace:
    return SimpleNamespace(
        symbol=symbol,
        secType="OPT",
        currency="USD",
        exchange="SMART",
        lastTradeDateOrContractMonth=expiry,
        right=right,
        strike=strike,
        multiplier=multiplier,
        **extra,
    )


def order(action: str, quantity, **extra) -> SimpleNamespace:
    fields = {"action": action, "totalQuantity": quantity, "orderType": "LMT", "whatIf": False}
    fields.update(extra)
    return SimpleNamespace(**fields)


def held_stock(quantity: float, symbol: str = "AAPL") -> dict:
    return {
        "symbol": symbol,
        "sec_type": "STK",
        "currency": "USD",
        "quantity": quantity,
        "contract": {
            "symbol": symbol,
            "secType": "STK",
            "exchange": "",
            "currency": "USD",
            "lastTradeDateOrContractMonth": "",
            "strike": 0.0,
            "right": "",
            "multiplier": "",
        },
    }


def held_option(quantity: float, strike: float = 200.0, right: str = "C") -> dict:
    return {
        "symbol": "AAPL",
        "sec_type": "OPT",
        "currency": "USD",
        "quantity": quantity,
        "contract": {
            "symbol": "AAPL",
            "secType": "OPT",
            "exchange": "",
            "currency": "USD",
            "lastTradeDateOrContractMonth": "20261120",
            "strike": strike,
            "right": right,
            "multiplier": "100",
        },
    }


class OrderPolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.reports = self.tmp / "nautilus" / "reports"
        self.reports.mkdir(parents=True)
        self.audit = self.tmp / "nautilus" / "arm-audit.jsonl"
        self.gate = arm_gate.ArmGate(
            self.tmp / "nautilus" / "ARMED",
            "img-1",
            kill_switch_path=self.tmp / "KILL_SWITCH",
            audit_path=self.audit,
        )
        self.gate.arm(actor="owner", reason=REASON, confirm_image_version="img-1")
        previous = arm_gate.current()
        arm_gate.configure(self.gate)
        self.addCleanup(arm_gate.configure, previous)
        patcher = mock.patch.dict(os.environ, {SNAPSHOT_ENV: str(self.reports)})
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop(MAX_AGE_ENV, None)
        arm_gate._close_reservations.clear()
        self.addCleanup(arm_gate._close_reservations.clear)
        self.client = FakeClient()

    def write_snapshot(
        self, positions: list[dict], *, age: float = 5.0, stamp: str = "20261104T120000Z"
    ) -> Path:
        path = self.reports / f"ibkr-account-snapshot-{stamp}.json"
        payload = {
            "schemaVersion": "ibkr-account-snapshot/v1",
            "captured_at_epoch": time.time() - age,
            "positions": positions,
        }
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def place(self, contract, order_, order_id: int = 7) -> None:
        arm_gate.place_order(self.client, order_id, contract, order_, source="test-order-policy")

    def assert_refused(self, contract, order_, code: str, order_id: int = 7) -> arm_gate.OrderPolicyError:
        before = list(self.client.placed)
        with self.assertRaises(arm_gate.OrderPolicyError) as caught:
            self.place(contract, order_, order_id)
        self.assertEqual(caught.exception.code, code, str(caught.exception))
        self.assertEqual(self.client.placed, before)
        return caught.exception

    def audit_events(self) -> list[dict]:
        if not self.audit.exists():
            return []
        return [json.loads(line) for line in self.audit.read_text().splitlines()]

    # -- shares --------------------------------------------------------------

    def test_new_share_buy_is_blocked(self) -> None:
        self.write_snapshot([])
        self.assert_refused(stock(), order("BUY", Decimal(10)), "new_share_buy")

    def test_share_buy_adding_to_a_long_is_blocked(self) -> None:
        self.write_snapshot([held_stock(50)])
        self.assert_refused(stock(), order("BUY", Decimal(10)), "new_share_buy")

    def test_new_share_short_is_blocked(self) -> None:
        self.write_snapshot([])
        self.assert_refused(stock(), order("SELL", Decimal(10)), "new_share_short")

    def test_share_close_sell_within_held_long_is_allowed(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100)))
        self.assertEqual(len(self.client.placed), 1)

    def test_share_close_in_another_currency_is_blocked(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.assert_refused(stock(currency="CAD"), order("SELL", Decimal(10)), "new_share_short")

    def test_share_buy_to_cover_within_held_short_is_allowed(self) -> None:
        self.write_snapshot([held_stock(-30)])
        self.place(stock(), order("BUY", Decimal(30)))
        self.assertEqual(len(self.client.placed), 1)

    def test_share_oversell_is_blocked(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.assert_refused(stock(), order("SELL", Decimal(101)), "exceeds_held_quantity")

    def test_share_buy_to_cover_beyond_held_short_is_blocked(self) -> None:
        self.write_snapshot([held_stock(-30)])
        self.assert_refused(stock(), order("BUY", Decimal(31)), "exceeds_held_quantity")

    def test_share_close_of_another_symbol_is_blocked(self) -> None:
        self.write_snapshot([held_stock(100, symbol="MSFT")])
        self.assert_refused(stock("AAPL"), order("SELL", Decimal(10)), "new_share_short")

    def test_share_buy_whatif_preflight_is_blocked_too(self) -> None:
        self.write_snapshot([])
        self.assert_refused(stock(), order("BUY", Decimal(10), whatIf=True), "new_share_buy")

    # -- options -------------------------------------------------------------

    def test_long_option_buy_is_allowed(self) -> None:
        self.place(option(), order("BUY", Decimal(1)))
        self.place(option(right="PUT"), order("BUY", Decimal(2), whatIf=True))
        self.assertEqual(len(self.client.placed), 2)

    def test_short_option_open_is_blocked(self) -> None:
        self.write_snapshot([])
        self.assert_refused(option(), order("SELL", Decimal(1)), "short_option_open")

    def test_short_option_adding_to_a_short_is_blocked(self) -> None:
        self.write_snapshot([held_option(-2)])
        self.assert_refused(option(), order("SELL", Decimal(1)), "short_option_open")

    def test_option_close_is_allowed(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(right="CALL"), order("SELL", Decimal(3)))
        self.assertEqual(len(self.client.placed), 1)

    def test_option_oversell_is_blocked(self) -> None:
        self.write_snapshot([held_option(3)])
        self.assert_refused(option(), order("SELL", Decimal(4)), "exceeds_held_quantity")

    def test_option_close_of_another_strike_or_right_is_blocked(self) -> None:
        self.write_snapshot([held_option(3, strike=210.0), held_option(3, right="P")])
        self.assert_refused(option(), order("SELL", Decimal(1)), "short_option_open")

    def test_option_close_without_expiry_right_strike_is_blocked(self) -> None:
        self.write_snapshot([held_option(3)])
        contract = SimpleNamespace(symbol="AAPL", secType="OPT", currency="USD", conId=12345)
        self.assert_refused(contract, order("SELL", Decimal(1)), "contract_incomplete")

    def test_option_close_with_another_multiplier_is_blocked(self) -> None:
        self.write_snapshot([held_option(3)])
        self.assert_refused(option(multiplier="10"), order("SELL", Decimal(1)), "short_option_open")

    def test_option_close_of_another_expiry_is_blocked(self) -> None:
        self.write_snapshot([held_option(3)])
        self.assert_refused(option(expiry="20261218"), order("SELL", Decimal(1)), "short_option_open")

    def test_option_close_with_an_expiry_time_suffix_is_allowed(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(expiry="20261120 16:00 US/Eastern"), order("SELL", Decimal(1)))
        self.assertEqual(len(self.client.placed), 1)

    def test_long_option_buy_beyond_a_held_short_is_allowed(self) -> None:
        self.write_snapshot([held_option(-2)])
        self.place(option(), order("BUY", Decimal(5)))
        self.assertEqual(len(self.client.placed), 1)

    # -- other instruments and malformed orders -------------------------------

    def test_bag_is_blocked(self) -> None:
        self.write_snapshot([held_option(3)])
        bag = SimpleNamespace(symbol="AAPL", secType="BAG", currency="USD", comboLegs=[object(), object()])
        self.assert_refused(bag, order("BUY", Decimal(1)), "combo_refused")

    def test_combo_legs_on_an_option_contract_are_blocked(self) -> None:
        self.assert_refused(option(comboLegs=[object()]), order("BUY", Decimal(1)), "combo_refused")

    def test_delta_neutral_option_buy_is_blocked(self) -> None:
        self.assert_refused(
            option(), order("BUY", Decimal(1), deltaNeutralOrderType="MKT"), "delta_neutral_refused"
        )

    def test_futures_and_unknown_sec_types_are_blocked(self) -> None:
        self.write_snapshot([])
        for sec_type in ("FUT", "FOP", "CASH", "CFD", "WAR", "", "opt-ish"):
            contract = SimpleNamespace(symbol="ES", secType=sec_type, currency="USD")
            with self.subTest(sec_type=sec_type):
                self.assert_refused(contract, order("BUY", Decimal(1)), "sec_type_refused")

    def test_missing_action_or_quantity_is_blocked(self) -> None:
        self.assert_refused(option(), order("", Decimal(1)), "action_refused")
        self.assert_refused(option(), order("SSHORT", Decimal(1)), "action_refused")
        self.assert_refused(option(), order("BUY", None), "quantity_missing")
        self.assert_refused(option(), order("BUY", Decimal(0)), "quantity_missing")
        self.assert_refused(option(), order("BUY", Decimal(-1)), "quantity_missing")
        self.assert_refused(option(), order("BUY", Decimal(2**127 - 1)), "quantity_missing")
        self.assert_refused(option(), SimpleNamespace(action="BUY"), "quantity_missing")

    # -- snapshot freshness ----------------------------------------------------

    def test_stale_snapshot_blocks_close_but_allows_long_option_buy(self) -> None:
        self.write_snapshot([held_stock(100), held_option(3)], age=600.0)
        self.assert_refused(stock(), order("SELL", Decimal(10)), "snapshot_stale")
        self.assert_refused(option(), order("SELL", Decimal(1)), "snapshot_stale")
        self.place(option(), order("BUY", Decimal(1)))
        self.assertEqual(len(self.client.placed), 1)

    def test_max_age_comes_from_the_environment(self) -> None:
        self.write_snapshot([held_stock(100)], age=600.0)
        with mock.patch.dict(os.environ, {MAX_AGE_ENV: "900"}):
            self.place(stock(), order("SELL", Decimal(10)))
        self.assertEqual(len(self.client.placed), 1)

    def test_missing_or_unreadable_snapshot_blocks_close(self) -> None:
        self.assert_refused(stock(), order("SELL", Decimal(1)), "snapshot_unavailable")
        (self.reports / "ibkr-account-snapshot-20261104T120000Z.json").write_text("{not json")
        self.assert_refused(stock(), order("SELL", Decimal(1)), "snapshot_invalid")

    def test_snapshot_with_an_invalid_position_blocks_close(self) -> None:
        self.write_snapshot([held_stock(100), {"symbol": "AAPL", "quantity": "lots"}])
        self.assert_refused(stock(), order("SELL", Decimal(1)), "snapshot_invalid")

    def test_newest_snapshot_wins(self) -> None:
        self.write_snapshot([held_stock(100)], stamp="20261104T120000Z")
        self.write_snapshot([], stamp="20261104T120100Z")
        self.assert_refused(stock(), order("SELL", Decimal(1)), "new_share_short")

    def test_snapshot_stamped_in_the_future_blocks_close(self) -> None:
        self.write_snapshot([held_stock(100)], age=-600.0)
        self.assert_refused(stock(), order("SELL", Decimal(1)), "snapshot_invalid")

    # -- close reservations (repeated or concurrent closes) ---------------------

    def test_second_close_beyond_held_is_blocked(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        self.assert_refused(option(), order("SELL", Decimal(3)), "exceeds_held_quantity", order_id=2)
        self.assert_refused(option(), order("SELL", Decimal(1)), "exceeds_held_quantity", order_id=3)
        self.assertEqual(len(self.client.placed), 1)

    def test_partial_closes_may_add_up_to_the_held_quantity(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(60)), order_id=1)
        self.place(stock(), order("SELL", Decimal(40)), order_id=2)
        self.assert_refused(stock(), order("SELL", Decimal(1)), "exceeds_held_quantity", order_id=3)
        self.assertEqual(len(self.client.placed), 2)

    def test_replacing_a_close_under_the_same_order_id_is_allowed(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        self.place(option(), order("SELL", Decimal(2)), order_id=1)
        self.place(option(), order("SELL", Decimal(1)), order_id=2)
        self.assertEqual(len(self.client.placed), 4)

    def test_cancel_releases_the_close_reservation(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        arm_gate.cancel_order(self.client, 1, source="test-order-policy")
        self.place(stock(), order("SELL", Decimal(100)), order_id=2)
        self.assertEqual(self.client.cancelled, [1])
        self.assertEqual(len(self.client.placed), 2)

    def test_a_close_whose_place_call_raises_still_counts(self) -> None:
        self.write_snapshot([held_stock(100)])
        with mock.patch.object(self.client, "placeOrder", side_effect=OSError("socket")):
            with self.assertRaises(OSError):
                self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        self.assert_refused(stock(), order("SELL", Decimal(100)), "exceeds_held_quantity", order_id=2)

    def test_whatif_close_reserves_nothing(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100), whatIf=True), order_id=1)
        self.place(stock(), order("SELL", Decimal(100)), order_id=2)
        self.assert_refused(
            stock(), order("SELL", Decimal(1), whatIf=True), "exceeds_held_quantity", order_id=3
        )

    def test_snapshot_captured_after_the_settle_window_releases_reservations(self) -> None:
        self.write_snapshot([held_option(3)], stamp="20261104T120000Z")
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        settle = arm_gate.CLOSE_RESERVATION_SETTLE_SECONDS
        self.write_snapshot([held_option(3)], age=-(settle + 5), stamp="20261104T120100Z")
        self.place(option(), order("SELL", Decimal(3)), order_id=2)
        self.assertEqual(len(self.client.placed), 2)

    def test_snapshot_within_the_settle_window_keeps_reservations(self) -> None:
        self.write_snapshot([held_option(3)], stamp="20261104T120000Z")
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        self.write_snapshot([held_option(3)], age=0.0, stamp="20261104T120100Z")
        self.assert_refused(option(), order("SELL", Decimal(3)), "exceeds_held_quantity", order_id=2)

    # -- arm gate, audit, status ----------------------------------------------

    def test_disarmed_still_refuses_everything(self) -> None:
        self.write_snapshot([held_stock(100), held_option(3)])
        self.gate.disarm(actor="owner", reason="test disarm")
        for contract, order_ in (
            (option(), order("BUY", Decimal(1))),
            (option(), order("SELL", Decimal(1))),
            (stock(), order("SELL", Decimal(10))),
            (stock(), order("BUY", Decimal(10))),
        ):
            with self.subTest(contract=contract.secType, action=order_.action):
                with self.assertRaises(arm_gate.DisarmedError) as caught:
                    self.place(contract, order_)
                self.assertNotIsInstance(caught.exception, arm_gate.OrderPolicyError)
        self.assertEqual(self.client.placed, [])

    def test_unconfigured_gate_refuses_a_long_option_buy(self) -> None:
        arm_gate.configure(None)
        with self.assertRaises(arm_gate.DisarmedError):
            self.place(option(), order("BUY", Decimal(1)))
        self.assertEqual(self.client.placed, [])

    def test_refusal_is_audited_and_is_a_disarmed_error(self) -> None:
        self.write_snapshot([])
        with self.assertRaises(arm_gate.DisarmedError):
            self.place(stock("MSFT"), order("BUY", Decimal(5), whatIf=True))
        refused = [event for event in self.audit_events() if event["event"] == "order_refused"]
        self.assertEqual(len(refused), 1)
        event = refused[0]
        self.assertEqual(event["error"], "new_share_buy")
        self.assertEqual(event["policy"], arm_gate.ORDER_POLICY)
        self.assertEqual(event["symbol"], "MSFT")
        self.assertEqual(event["source"], "test-order-policy")
        self.assertTrue(event["what_if"])

    def test_policy_fault_refuses_and_never_places(self) -> None:
        with mock.patch.object(arm_gate, "_order_contract_identity", side_effect=KeyError("boom")):
            self.assert_refused(option(), order("BUY", Decimal(1)), "policy_error")

    def test_status_reports_the_order_policy(self) -> None:
        self.assertEqual(self.gate.status().as_dict()["order_policy"], "options_only_defined_risk_v1")
        self.assertEqual(arm_gate.current_status().as_dict()["order_policy"], arm_gate.ORDER_POLICY)
        status = arm_gate.order_policy_status({MAX_AGE_ENV: "bad"})
        self.assertEqual(status["order_policy"], arm_gate.ORDER_POLICY)
        self.assertEqual(status["account_snapshot_dir"], arm_gate.DEFAULT_ACCOUNT_SNAPSHOT_DIR)
        self.assertEqual(status["max_snapshot_age_seconds"], 180.0)


if __name__ == "__main__":
    unittest.main()
