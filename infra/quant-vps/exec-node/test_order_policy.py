"""Options-only, defined-risk order policy in ``arm_gate.place_order``.

Owner rule (2026-11-04): options only, risk always defined, max loss per
order <= 2% of NetLiquidation; closes and reductions are always allowed. The
tests use a real armed ``ArmGate`` in a temporary directory, synthetic account
snapshots, a temporary reservation file and a fake client that only records
``placeOrder`` calls. Nothing reaches a broker.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
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
MAX_LOSS_ENV = "NAUTILUS_ORDER_POLICY_MAX_LOSS_PCT"
RESERVATIONS_ENV = "NAUTILUS_ORDER_POLICY_RESERVATIONS_PATH"
# 2% of 100,000 = 2,000 USD: 4 contracts at 5.00 (x100) is exactly the cap.
NLV = 100_000


class FakeClient:
    """Records calls. ``orderStatus`` stands in for the ibapi callback IBKR drives."""

    def __init__(self, client_id: int = 21) -> None:
        self.clientId = client_id  # noqa: N815 - ibapi EClient attribute
        self.connected = True
        self.statuses: list[tuple] = []
        self.placed: list[tuple[int, object, object]] = []
        self.cancelled: list[int] = []

    def isConnected(self) -> bool:  # noqa: N802 - ibapi name
        return self.connected

    def orderStatus(self, orderId, status, filled, remaining, *_rest) -> None:  # noqa: N802,N803
        self.statuses.append((orderId, status, filled, remaining))

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
    currency: str = "USD",
    tradingClass: str = "AAPL",  # noqa: N803 - ibapi field name
    **extra,
) -> SimpleNamespace:
    return SimpleNamespace(
        symbol=symbol,
        secType="OPT",
        currency=currency,
        tradingClass=tradingClass,
        exchange="SMART",
        lastTradeDateOrContractMonth=expiry,
        right=right,
        strike=strike,
        multiplier=multiplier,
        **extra,
    )


def order(action: str, quantity, **extra) -> SimpleNamespace:
    fields = {
        "action": action,
        "totalQuantity": quantity,
        "orderType": "LMT",
        "lmtPrice": 1.0,
        "whatIf": False,
    }
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


def held_option(
    quantity: float, strike: float = 200.0, right: str = "C", trading_class: str = "AAPL", con_id: int = 0
) -> dict:
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
            "tradingClass": trading_class,
            "conId": con_id,
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
        self.reservations = self.tmp / "nautilus" / "order-policy-reservations.json"
        patcher = mock.patch.dict(
            os.environ, {SNAPSHOT_ENV: str(self.reports), RESERVATIONS_ENV: str(self.reservations)}
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop(MAX_AGE_ENV, None)
        os.environ.pop(MAX_LOSS_ENV, None)
        arm_gate._order_outcomes.clear()
        self.addCleanup(arm_gate._order_outcomes.clear)
        self.client = FakeClient()

    def write_snapshot(
        self,
        positions: list[dict],
        *,
        age: float = 5.0,
        stamp: str = "20261104T120000Z",
        summary: dict | None = None,
        classes: bool = True,
    ) -> Path:
        """Write a v1 snapshot; conId/tradingClass of test positions go to the class sidecar."""
        path = self.reports / f"ibkr-account-snapshot-{stamp}.json"
        v1_positions, sidecar = [], []
        for position in positions:
            row = json.loads(json.dumps(position))
            contract = row.get("contract") if isinstance(row.get("contract"), dict) else {}
            sidecar.append(
                {
                    "symbol": row.get("symbol"),
                    "sec_type": row.get("sec_type"),
                    "quantity": row.get("quantity"),
                    "conId": contract.pop("conId", 0),
                    "tradingClass": contract.pop("tradingClass", ""),
                }
            )
            v1_positions.append(row)
        captured = time.time() - age
        payload = {
            "schemaVersion": "ibkr-account-snapshot/v1",
            "captured_at_epoch": captured,
            "positions": v1_positions,
            "summary": {"NetLiquidation": {"USD": str(NLV)}} if summary is None else summary,
        }
        path.write_text(json.dumps(payload), encoding="utf-8")
        if classes:
            (self.reports / arm_gate.CLASS_SIDECAR_NAME).write_text(
                json.dumps(
                    {
                        "schemaVersion": arm_gate.CLASS_SIDECAR_SCHEMA,
                        "snapshot": path.name,
                        "captured_at_epoch": captured,
                        "positions": sidecar,
                    }
                ),
                encoding="utf-8",
            )
        return path

    def stored_reservations(self) -> list[dict]:
        return json.loads(self.reservations.read_text())["reservations"]

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
        self.write_snapshot([])
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

    def test_option_close_may_be_a_market_order(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(3), orderType="MKT", lmtPrice=None))
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

    def test_option_buy_beyond_a_held_short_is_blocked(self) -> None:
        # Every buy of a held-short option is a close: no flip in one order.
        self.write_snapshot([held_option(-2)])
        self.assert_refused(option(), order("BUY", Decimal(5)), "exceeds_held_quantity")
        self.assert_refused(option(), order("BUY", Decimal(3), lmtPrice=0.5), "exceeds_held_quantity")
        self.assertFalse(self.reservations.exists())

    def test_buy_covering_a_held_short_option_is_a_close(self) -> None:
        self.write_snapshot([held_option(-2)])
        self.place(option(), order("BUY", Decimal(2), orderType="MKT", lmtPrice=None), order_id=1)
        self.assertEqual(self.stored_reservations()[0]["action"], "BUY")
        # No second buy of that option while the cover works, capped LMT or not.
        self.assert_refused(
            option(), order("BUY", Decimal(2), orderType="MKT"), "close_already_working", order_id=2
        )
        self.assert_refused(
            option(), order("BUY", Decimal(2), lmtPrice=5.0), "close_already_working", order_id=3
        )
        self.assertEqual(len(self.client.placed), 1)

    def test_working_cover_then_capped_buy_is_blocked(self) -> None:
        # Review round 4, sequence A: a STP cover works, then a LMT buy of the
        # same option would flatten the short and leave the stop to open a long.
        self.write_snapshot([held_option(-10)])
        self.place(option(), order("BUY", Decimal(10), orderType="STP", lmtPrice=None, auxPrice=30.0), order_id=1)
        self.assert_refused(option(), order("BUY", Decimal(10), lmtPrice=2.0), "close_already_working", order_id=2)

    def test_oversized_buy_then_cover_is_blocked(self) -> None:
        # Review round 4, sequence B: BUY 11 against -10 is not a capped buy.
        self.write_snapshot([held_option(-10)])
        self.assert_refused(option(), order("BUY", Decimal(11), lmtPrice=1.8), "exceeds_held_quantity", order_id=1)
        self.place(option(), order("BUY", Decimal(10), orderType="STP", lmtPrice=None, auxPrice=30.0), order_id=2)
        self.assertEqual([placed[0] for placed in self.client.placed], [2])

    def test_option_buy_must_name_the_exact_contract(self) -> None:
        self.write_snapshot([held_option(-2)])
        incomplete = (
            SimpleNamespace(symbol="AAPL", secType="OPT", currency="USD", multiplier="100", conId=12345),
            option(expiry=""),
            option(right=""),
            option(strike=0.0),
        )
        for contract in incomplete:
            with self.subTest(contract=vars(contract)):
                self.assert_refused(contract, order("BUY", Decimal(1)), "contract_incomplete")

    def test_option_of_another_trading_class_never_matches_a_held_one(self) -> None:
        # Review round 5: SPX/SPXW or an adjusted class (AAPL1) share symbol,
        # expiry, right and strike. A sale of the standard class against a held
        # adjusted class would open a naked short.
        self.write_snapshot([held_option(2, trading_class="AAPL1")])
        self.assert_refused(option(), order("SELL", Decimal(2)), "short_option_open")
        self.write_snapshot([held_option(-2, trading_class="AAPL1")])
        # Not a cover of the other class: an ordinary capped LMT buy.
        self.assert_refused(option(), order("BUY", Decimal(2), lmtPrice=50.0), "max_loss_exceeded")
        self.assert_refused(option(), order("BUY", Decimal(2), orderType="MKT"), "order_type_refused")
        self.place(option(), order("BUY", Decimal(2), lmtPrice=5.0))
        self.assertFalse(self.reservations.exists())

    def test_option_class_must_be_provable_on_both_sides(self) -> None:
        # A snapshot from the old reader has no tradingClass or conId.
        self.write_snapshot([held_option(2, trading_class="")])
        self.assert_refused(option(), order("SELL", Decimal(1)), "trading_class_unverifiable")
        self.assert_refused(option(), order("BUY", Decimal(1)), "trading_class_unverifiable")
        self.write_snapshot([held_option(2)])
        self.assert_refused(option(tradingClass=""), order("SELL", Decimal(1)), "trading_class_unverifiable")
        self.assert_refused(option(tradingClass=""), order("BUY", Decimal(1)), "trading_class_unverifiable")
        self.assertEqual(self.client.placed, [])

    def test_snapshot_reader_keeps_the_v1_shape_and_writes_classes_beside_it(self) -> None:
        import ibkr_account  # the owned reader that builds the snapshot

        position = ibkr_account._snapshot_position(option(conId=777), "U1", 2, 1.5)
        # Staged protection checks the v1 contract keys exactly: no class keys there.
        self.assertEqual(
            set(position.contract),
            {"symbol", "secType", "exchange", "currency", "lastTradeDateOrContractMonth",
             "strike", "right", "multiplier"},
        )
        snapshot = ibkr_account.IbkrAccountSnapshot("U1", {}, [position], time.time())
        sidecar = snapshot.class_sidecar("ibkr-account-snapshot-20261104T120000Z.json")
        self.assertEqual(sidecar["schemaVersion"], arm_gate.CLASS_SIDECAR_SCHEMA)
        self.assertEqual(ibkr_account.CLASS_SIDECAR_NAME, arm_gate.CLASS_SIDECAR_NAME)
        self.assertEqual(
            sidecar["positions"],
            [{"symbol": "AAPL", "sec_type": "OPT", "quantity": 2.0, "conId": 777, "tradingClass": "AAPL"}],
        )
        # The gate pairs them and proves the class.
        path = self.reports / sidecar["snapshot"]
        payload = snapshot.to_dict()
        self.assertEqual(payload["captured_at_epoch"], sidecar["captured_at_epoch"])
        path.write_text(json.dumps(payload))
        (self.reports / arm_gate.CLASS_SIDECAR_NAME).write_text(json.dumps(sidecar))
        self.place(option(tradingClass="", conId=777), order("SELL", Decimal(2)), order_id=1)
        self.assertEqual(len(self.client.placed), 1)

    def test_snapshot_script_writes_the_class_sidecar(self) -> None:
        import importlib.util

        import ibkr_account

        script = HERE / "runtime" / "scripts" / "ibkr_account_snapshot.py"
        spec = importlib.util.spec_from_file_location("snapshot_script_under_test", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        position = ibkr_account._snapshot_position(option(conId=777), "U1", 2, 1.5)
        snapshot = ibkr_account.IbkrAccountSnapshot("U1", {"NetLiquidation": {"USD": "1"}}, [position], 5.0)

        class FakeSnapshotClient:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            def snapshot(self):
                return snapshot

        env_file = self.tmp / "snapshot.env"
        env_file.write_text("IBKR_ACCOUNT_ID=U1\nSYNTHETIC_STOP_ACCOUNT_FINGERPRINT_KEY=k\n")
        out_dir = self.tmp / "out"
        argv = ["ibkr_account_snapshot.py", "--env-file", str(env_file), "--output-dir", str(out_dir)]
        with mock.patch.object(module, "IbkrAccountSnapshotClient", FakeSnapshotClient), mock.patch.object(
            sys, "argv", argv
        ), redirect_stdout(io.StringIO()):
            self.assertEqual(module.main(), 0)
        [written] = sorted(out_dir.glob("ibkr-account-snapshot-*.json"))
        sidecar = json.loads((out_dir / arm_gate.CLASS_SIDECAR_NAME).read_text())
        self.assertEqual(sidecar["snapshot"], written.name)
        self.assertEqual(sidecar["positions"][0]["tradingClass"], "AAPL")
        self.assertNotIn("tradingClass", json.loads(written.read_text())["positions"][0]["contract"])
        self.assertEqual(sorted(p.name for p in out_dir.iterdir()), sorted([written.name, arm_gate.CLASS_SIDECAR_NAME]))
        # Review round 7: a root writer (portfolio-ui) must leave a sidecar the gate (uid 10001) can read.
        self.assertEqual(stat.S_IMODE((out_dir / arm_gate.CLASS_SIDECAR_NAME).stat().st_mode), 0o644)

    def test_unpaired_class_sidecar_proves_nothing(self) -> None:
        cases = {
            "missing": None,
            "not json": "{bad",
            "other snapshot": {"snapshot": "ibkr-account-snapshot-20261104T115900Z.json"},
            # Review round 7: two writers in the same second share a file name.
            "other capture time": {"captured_at_epoch": 1.0},
            "no capture time": {"captured_at_epoch": None},
            "other schema": {"schemaVersion": "other"},
            "fewer positions": {"positions": []},
            "other symbol": {"positions": [{"symbol": "MSFT", "sec_type": "OPT", "quantity": 2, "conId": 0, "tradingClass": "AAPL"}]},
            "other quantity": {"positions": [{"symbol": "AAPL", "sec_type": "OPT", "quantity": 3, "conId": 0, "tradingClass": "AAPL"}]},
        }
        for name, change in cases.items():
            with self.subTest(name):
                path = self.write_snapshot([held_option(2)])
                sidecar_path = self.reports / arm_gate.CLASS_SIDECAR_NAME
                if change is None:
                    sidecar_path.unlink()
                elif isinstance(change, str):
                    sidecar_path.write_text(change)
                else:
                    data = json.loads(sidecar_path.read_text())
                    data.update(change)
                    sidecar_path.write_text(json.dumps(data))
                self.assertTrue(path.exists())
                self.assert_refused(option(), order("SELL", Decimal(1)), "trading_class_unverifiable")
        # Stocks need no class.
        self.write_snapshot([held_stock(100)], classes=False)
        self.place(stock(), order("SELL", Decimal(1)))

    def test_reservations_of_unproven_classes_block_each_other(self) -> None:
        # Review round 6: a conId-only close and a tradingClass-only close.
        spx = dict(held_option(2, trading_class="SPX", con_id=1), symbol="SPX")
        spxw = dict(held_option(2, trading_class="SPXW", con_id=2), symbol="SPXW")
        spx["contract"] = dict(spx["contract"], symbol="SPX")
        spxw["symbol"] = "SPX"
        spxw["contract"] = dict(spxw["contract"], symbol="SPX")
        self.write_snapshot([spx, spxw])
        by_id = option(symbol="SPX", tradingClass="", conId=1)
        self.place(by_id, order("SELL", Decimal(2)), order_id=10)
        # Sequence A: the same id re-sent as the other class is not a modify.
        self.assert_refused(
            option(symbol="SPX", tradingClass="SPXW"), order("SELL", Decimal(2)), "order_id_reused", order_id=10
        )
        # Sequence B: a final conId-only close does not fold into another class.
        self.ibkr_status(10, "Cancelled", 1)
        self.assert_refused(
            option(symbol="SPX", tradingClass="SPXW"), order("SELL", Decimal(1)), "close_already_working", order_id=11
        )
        self.assert_refused(
            option(symbol="SPX", tradingClass="SPX"), order("SELL", Decimal(2)), "close_already_working", order_id=12
        )
        # The same class, proven by conId, folds: 2 held - 1 filled.
        self.assert_refused(by_id, order("SELL", Decimal(2)), "exceeds_held_quantity", order_id=13)
        self.place(by_id, order("SELL", Decimal(1)), order_id=13)

    def test_matching_con_id_proves_the_class(self) -> None:
        self.write_snapshot([held_option(2, trading_class="", con_id=555)])
        self.place(option(tradingClass="", conId=555), order("SELL", Decimal(2)), order_id=1)
        self.assertEqual(self.stored_reservations()[0]["contract"]["con_id"], 555)
        self.write_snapshot([held_option(2, con_id=555)], stamp="20261104T120100Z")
        self.assert_refused(option(conId=556), order("SELL", Decimal(2)), "short_option_open", order_id=2)

    def test_option_buy_at_the_cap_is_allowed(self) -> None:
        self.write_snapshot([])
        self.place(option(), order("BUY", Decimal(4), lmtPrice=5.0))
        self.assertEqual(len(self.client.placed), 1)

    def test_option_buy_above_the_cap_is_blocked(self) -> None:
        self.write_snapshot([])
        self.assert_refused(option(), order("BUY", Decimal(5), lmtPrice=5.0), "max_loss_exceeded")
        self.assert_refused(option(), order("BUY", Decimal(4), lmtPrice=5.01), "max_loss_exceeded")
        self.assert_refused(
            option(), order("BUY", Decimal(5), lmtPrice=5.0, whatIf=True), "max_loss_exceeded"
        )

    def test_refusal_detail_names_the_premium_but_not_the_net_liquidation(self) -> None:
        self.write_snapshot([])
        refusal = self.assert_refused(option(), order("BUY", Decimal(5), lmtPrice=5.0), "max_loss_exceeded")
        self.assertIn("2500", refusal.detail)
        self.assertNotIn(str(NLV), refusal.detail)
        self.assertNotIn("2000", refusal.detail)

    def test_option_buy_without_a_multiplier_is_blocked(self) -> None:
        # An adjusted option may not be 100; IBKR's qualified contract names it.
        self.write_snapshot([])
        for multiplier in ("", None, "0", "abc"):
            with self.subTest(multiplier=multiplier):
                self.assert_refused(
                    option(multiplier=multiplier), order("BUY", Decimal(1)), "multiplier_missing"
                )

    def test_contract_multiplier_is_used(self) -> None:
        self.write_snapshot([])
        self.place(option(multiplier="10"), order("BUY", Decimal(40), lmtPrice=5.0))
        self.assert_refused(option(multiplier="10"), order("BUY", Decimal(41), lmtPrice=5.0), "max_loss_exceeded")
        self.assert_refused(option(multiplier="1000"), order("BUY", Decimal(1), lmtPrice=2.01), "max_loss_exceeded")

    def test_option_buy_must_be_a_limit_order(self) -> None:
        self.write_snapshot([])
        for order_type in ("MKT", "STP", "STP LMT", "MOC", "REL", "PEG MID", "", None):
            with self.subTest(order_type=order_type):
                self.assert_refused(
                    option(), order("BUY", Decimal(1), orderType=order_type), "order_type_refused"
                )
        self.assert_refused(option(), SimpleNamespace(action="BUY", totalQuantity=1, lmtPrice=1.0), "order_type_refused")

    def test_option_buy_needs_a_positive_limit_price(self) -> None:
        self.write_snapshot([])
        for price in (None, 0, -1.0, "nan", sys.float_info.max):
            with self.subTest(price=price):
                self.assert_refused(
                    option(), order("BUY", Decimal(1), lmtPrice=price), "limit_price_missing"
                )

    def test_option_buy_refuses_fields_that_can_pay_more_than_the_limit(self) -> None:
        self.write_snapshot([])
        self.assert_refused(
            option(), order("BUY", Decimal(1), discretionaryAmt=0.5), "discretionary_refused"
        )
        self.assert_refused(option(), order("BUY", Decimal(1), cashQty=1500.0), "cash_quantity_refused")
        self.place(option(), order("BUY", Decimal(1), discretionaryAmt=0.0, cashQty=sys.float_info.max))
        self.assertEqual(len(self.client.placed), 1)

    def test_option_buy_must_be_in_usd(self) -> None:
        self.write_snapshot([])
        for currency in ("EUR", "CAD", ""):
            with self.subTest(currency=currency):
                self.assert_refused(option(currency=currency), order("BUY", Decimal(1)), "currency_refused")

    def test_option_buy_needs_net_liquidation(self) -> None:
        for summary in (
            {},
            {"NetLiquidation": {"EUR": "100000"}},
            {"NetLiquidation": {"USD": "0"}},
            {"NetLiquidation": {"USD": "-5"}},
            {"NetLiquidation": {"USD": "n/a"}},
            {"NetLiquidation": "100000"},
            {"AvailableFunds": {"USD": "100000"}},
        ):
            with self.subTest(summary=summary):
                self.write_snapshot([], summary=summary)
                self.assert_refused(option(), order("BUY", Decimal(1)), "net_liquidation_unavailable")

    def test_option_buy_needs_a_fresh_snapshot(self) -> None:
        self.assert_refused(option(), order("BUY", Decimal(1)), "snapshot_unavailable")
        self.write_snapshot([], age=600.0)
        self.assert_refused(option(), order("BUY", Decimal(1)), "snapshot_stale")

    def test_max_loss_percent_override_may_only_lower_the_cap(self) -> None:
        self.write_snapshot([])
        with mock.patch.dict(os.environ, {MAX_LOSS_ENV: "1.0"}):
            self.assert_refused(option(), order("BUY", Decimal(4), lmtPrice=5.0), "max_loss_exceeded")
            self.place(option(), order("BUY", Decimal(2), lmtPrice=5.0))
        with mock.patch.dict(os.environ, {MAX_LOSS_ENV: " "}):
            self.place(option(), order("BUY", Decimal(4), lmtPrice=5.0))
        self.assertEqual(len(self.client.placed), 2)
        for value in ("2.01", "5", "100", "0", "-1", "abc", "nan", "inf", "1e400"):
            with self.subTest(value=value), mock.patch.dict(os.environ, {MAX_LOSS_ENV: value}):
                self.assert_refused(option(), order("BUY", Decimal(1)), "max_loss_config_invalid")

    def test_invalid_max_loss_override_does_not_block_a_close(self) -> None:
        self.write_snapshot([held_option(3)])
        with mock.patch.dict(os.environ, {MAX_LOSS_ENV: "9"}):
            self.place(option(), order("SELL", Decimal(3)))
        self.assertEqual(len(self.client.placed), 1)

    def test_cap_is_per_order(self) -> None:
        # Documented limit: premium already held or working is not added.
        self.write_snapshot([held_option(4)])
        self.place(option(), order("BUY", Decimal(4), lmtPrice=5.0), order_id=1)
        self.place(option(), order("BUY", Decimal(4), lmtPrice=5.0), order_id=2)
        self.assertEqual(len(self.client.placed), 2)

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

    def test_stale_snapshot_blocks_every_order(self) -> None:
        self.write_snapshot([held_stock(100), held_option(3)], age=600.0)
        self.assert_refused(stock(), order("SELL", Decimal(10)), "snapshot_stale")
        self.assert_refused(option(), order("SELL", Decimal(1)), "snapshot_stale")
        self.assert_refused(option(), order("BUY", Decimal(1)), "snapshot_stale")

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

    # -- working closes (persisted reservations) --------------------------------

    def later_snapshot(
        self, positions: list[dict], stamp: str = "20261104T120100Z", classes: bool = True
    ) -> None:
        settle = arm_gate.CLOSE_RESERVATION_SETTLE_SECONDS
        self.write_snapshot(positions, age=-(settle + 5), stamp=stamp, classes=classes)

    def test_second_close_of_a_contract_is_blocked_while_the_first_works(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(1)), order_id=1)
        self.assert_refused(option(), order("SELL", Decimal(1)), "close_already_working", order_id=2)
        self.assert_refused(
            option(), order("SELL", Decimal(1), whatIf=True), "close_already_working", order_id=3
        )
        self.assertEqual(len(self.client.placed), 1)

    def test_working_closes_never_exceed_the_held_quantity(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(60)), order_id=1)
        for quantity in (1, 40, 100):
            with self.subTest(quantity=quantity):
                self.assert_refused(
                    stock(), order("SELL", Decimal(quantity)), "close_already_working", order_id=2
                )
        self.assertEqual(len(self.client.placed), 1)

    def test_closes_of_other_contracts_are_independent(self) -> None:
        self.write_snapshot([held_option(3), held_option(2, strike=210.0), held_stock(100)])
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        self.place(option(strike=210.0), order("SELL", Decimal(2)), order_id=2)
        self.place(stock(), order("SELL", Decimal(100)), order_id=3)
        self.assertEqual(len(self.client.placed), 3)
        self.assertEqual(len(self.stored_reservations()), 3)

    def test_replacing_a_close_under_the_same_order_id_is_allowed(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        self.place(option(), order("SELL", Decimal(3), lmtPrice=0.9), order_id=1)
        self.place(option(), order("SELL", Decimal(2)), order_id=1)
        self.assert_refused(option(), order("SELL", Decimal(4)), "exceeds_held_quantity", order_id=1)
        self.assert_refused(option(), order("SELL", Decimal(1)), "close_already_working", order_id=2)
        self.assertEqual(len(self.client.placed), 3)
        [stored] = self.stored_reservations()
        self.assertEqual(stored["quantity"], "3")

    def test_order_id_reused_for_another_contract_is_blocked(self) -> None:
        self.write_snapshot([held_option(3), held_stock(100)])
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        self.assert_refused(stock(), order("SELL", Decimal(10)), "order_id_reused", order_id=1)

    def test_same_order_id_from_another_client_is_another_close(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(1)), order_id=1)
        self.client = FakeClient(client_id=22)
        self.assert_refused(option(), order("SELL", Decimal(1)), "close_already_working", order_id=1)

    def ibkr_status(
        self, order_id: int, status: str, filled, client: FakeClient | None = None, placed_by: int = 21
    ) -> None:
        """IBKR's orderStatus callback, as the ibapi decoder calls it (wrapper.orderStatus)."""
        (client or self.client).orderStatus(
            order_id, status, Decimal(filled), Decimal(0), 0.0, 0, 0, 0.0, placed_by, "", 0.0
        )

    def test_cancel_request_alone_keeps_the_reservation(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        arm_gate.cancel_order(self.client, 1, source="test-order-policy")
        self.assertEqual(self.client.cancelled, [1])
        for status in ("PendingCancel", "Inactive", "Submitted", "PreSubmitted"):
            self.ibkr_status(1, status, 0)
        self.assert_refused(stock(), order("SELL", Decimal(100)), "close_already_working", order_id=2)

    def test_cancel_with_nothing_filled_ends_the_reservation(self) -> None:
        for status in ("Cancelled", "ApiCancelled", "Api Cancelled"):
            with self.subTest(status=status):
                self.reservations.unlink(missing_ok=True)
                self.client = FakeClient()
                self.write_snapshot([held_stock(100)])
                self.place(stock(), order("SELL", Decimal(100)), order_id=1)
                arm_gate.cancel_order(self.client, 1, source="test-order-policy")
                self.ibkr_status(1, status, 0)
                self.place(stock(), order("SELL", Decimal(100)), order_id=2)
                self.assertEqual([placed[0] for placed in self.client.placed], [1, 2])
                self.assertEqual([item["order_id"] for item in self.stored_reservations()], ["2"])
                # The client's own callback still ran.
                self.assertEqual(self.client.statuses[-1][:2], (1, status))

    def test_filled_status_waits_for_a_snapshot_that_shows_the_fill(self) -> None:
        # Review finding: the newest snapshot can predate the fill (up to 180 s).
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        self.ibkr_status(1, "Filled", 3)
        # The fill counts at once: 3 held - 3 filled leaves nothing to close.
        self.assert_refused(option(), order("SELL", Decimal(3)), "exceeds_held_quantity", order_id=2)
        self.assert_refused(option(), order("SELL", Decimal(1)), "exceeds_held_quantity", order_id=2)
        self.later_snapshot([])
        self.assert_refused(option(), order("SELL", Decimal(3)), "short_option_open", order_id=2)
        self.assertEqual(len(self.client.placed), 1)

    def test_cancel_after_a_partial_fill_allows_the_rest_at_once(self) -> None:
        # Synthetic-stop reprice: 60 of 100 filled, cancelled, resubmit 40.
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        self.ibkr_status(1, "Cancelled", 60)
        self.assert_refused(stock(), order("SELL", Decimal(41)), "exceeds_held_quantity", order_id=2)
        self.place(stock(), order("SELL", Decimal(40)), order_id=2)
        [stored] = self.stored_reservations()
        self.assertEqual((stored["order_id"], stored["held_before"], stored["quantity"]), ("2", "40", "40"))
        # The new close is working: nothing more until it is final or shows.
        self.assert_refused(stock(), order("SELL", Decimal(1)), "close_already_working", order_id=3)
        self.later_snapshot([held_stock(40)])  # shows the 60, not yet the 40
        self.assert_refused(stock(), order("SELL", Decimal(1)), "close_already_working", order_id=3)
        self.assertEqual([placed[0] for placed in self.client.placed], [1, 2])

    def test_filled_close_counts_its_fill_before_the_snapshot_shows_it(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(1)), order_id=1)
        self.ibkr_status(1, "Filled", 1)
        self.assert_refused(option(), order("SELL", Decimal(3)), "exceeds_held_quantity", order_id=2)
        self.place(option(), order("SELL", Decimal(2)), order_id=2)
        self.assertEqual([item["order_id"] for item in self.stored_reservations()], ["2"])

    def test_final_status_and_a_later_snapshot_end_the_reservation(self) -> None:
        # Position grew after the close: held 2, SELL 2 filled, BUY 3 filled -> 3.
        self.write_snapshot([held_option(2)])
        self.place(option(), order("SELL", Decimal(2)), order_id=1)
        self.ibkr_status(1, "Filled", 2)
        self.later_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(3)), order_id=2)
        self.assertEqual([item["order_id"] for item in self.stored_reservations()], ["2"])

    def test_final_status_with_a_snapshot_inside_the_settle_window_keeps_it(self) -> None:
        self.write_snapshot([held_option(2)])
        self.place(option(), order("SELL", Decimal(2)), order_id=1)
        self.ibkr_status(1, "Filled", 2)
        self.write_snapshot([held_option(3)], age=-5.0, stamp="20261104T120100Z")
        self.assert_refused(option(), order("SELL", Decimal(1)), "exceeds_held_quantity", order_id=2)

    def test_inactive_status_keeps_the_reservation(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        self.ibkr_status(1, "Inactive", 0)
        self.later_snapshot([held_stock(100)])
        self.assert_refused(stock(), order("SELL", Decimal(100)), "close_already_working", order_id=2)

    def test_unfilled_cancel_of_a_replacement_keeps_the_inherited_fills(self) -> None:
        # Review finding: 6 of 10 filled and cancelled, the replacement SELL 4 is
        # cancelled unfilled, and the snapshot still shows 10.
        self.write_snapshot([held_option(10)])
        self.place(option(), order("SELL", Decimal(10)), order_id=1)
        self.ibkr_status(1, "Cancelled", 6)
        self.place(option(), order("SELL", Decimal(4)), order_id=2)
        self.ibkr_status(2, "Cancelled", 0)
        self.assert_refused(option(), order("SELL", Decimal(10)), "exceeds_held_quantity", order_id=3)
        self.assert_refused(option(), order("SELL", Decimal(5)), "exceeds_held_quantity", order_id=3)
        self.place(option(), order("SELL", Decimal(4)), order_id=3)
        [stored] = self.stored_reservations()
        self.assertEqual((stored["order_id"], stored["held_before"]), ("3", "4"))

    def test_unfilled_cancel_of_a_replacement_cover_keeps_the_inherited_fills(self) -> None:
        self.write_snapshot([held_option(-5)])
        self.place(option(), order("BUY", Decimal(5), orderType="MKT", lmtPrice=None), order_id=1)
        self.ibkr_status(1, "Cancelled", 3)
        self.place(option(), order("BUY", Decimal(2), orderType="MKT", lmtPrice=None), order_id=2)
        self.ibkr_status(2, "Cancelled", 0)
        # Only the 2 still short may be covered.
        self.assert_refused(
            option(), order("BUY", Decimal(5), orderType="MKT", lmtPrice=None), "exceeds_held_quantity", order_id=3
        )
        self.assert_refused(option(), order("BUY", Decimal(3), lmtPrice=0.5), "exceeds_held_quantity", order_id=3)

    def test_modify_under_the_same_id_may_not_exceed_its_baseline(self) -> None:
        self.write_snapshot([held_option(10)])
        self.place(option(), order("SELL", Decimal(10)), order_id=1)
        self.ibkr_status(1, "Cancelled", 6)
        self.place(option(), order("SELL", Decimal(4)), order_id=2)
        self.assert_refused(option(), order("SELL", Decimal(10)), "exceeds_held_quantity", order_id=2)
        self.assert_refused(option(), order("SELL", Decimal(5)), "exceeds_held_quantity", order_id=2)
        self.place(option(), order("SELL", Decimal(4), lmtPrice=0.8), order_id=2)
        self.assertEqual([placed[0] for placed in self.client.placed], [1, 2, 2])

    def test_final_reservation_ends_once_a_settled_snapshot_follows_it(self) -> None:
        self.write_snapshot([held_option(10)])
        self.place(option(), order("SELL", Decimal(10)), order_id=1)
        self.ibkr_status(1, "Cancelled", 0)
        self.later_snapshot([held_option(10)])
        self.place(option(), order("SELL", Decimal(10)), order_id=2)
        self.assertEqual([item["order_id"] for item in self.stored_reservations()], ["2"])

    def test_cover_filled_then_second_market_cover_is_blocked(self) -> None:
        self.write_snapshot([held_option(-2)])
        self.place(option(), order("BUY", Decimal(2), orderType="MKT", lmtPrice=None), order_id=1)
        self.ibkr_status(1, "Filled", 2)
        # The stale snapshot still shows -2, but the fill counts: nothing left to cover.
        self.assert_refused(
            option(), order("BUY", Decimal(2), orderType="MKT", lmtPrice=None), "exceeds_held_quantity", order_id=2
        )
        self.assert_refused(option(), order("BUY", Decimal(1)), "exceeds_held_quantity", order_id=2)
        self.later_snapshot([])  # flat: an option buy is an ordinary capped buy again
        self.place(option(), order("BUY", Decimal(1)), order_id=2)

    def test_reprice_loop_after_the_client_drops_terminal_rows(self) -> None:
        # Synthetic stops: LMT sell, cancel, the client's refresh drops terminal
        # rows, then a new sell under a new id. The gate keeps its own record.
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        arm_gate.cancel_order(self.client, 1, source="synthetic-stops")
        self.ibkr_status(1, "Cancelled", 0)
        self.client.statuses.clear()  # the client's bookkeeping forgets the row
        self.place(stock(), order("SELL", Decimal(100), orderType="MKT"), order_id=2)
        self.assertEqual([placed[0] for placed in self.client.placed], [1, 2])

    def test_status_of_another_clients_order_does_not_count(self) -> None:
        # Review finding: client 21 receives a status IBKR files under client 99.
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        self.ibkr_status(1, "Cancelled", 0, placed_by=99)
        self.assert_refused(stock(), order("SELL", Decimal(100)), "close_already_working", order_id=2)
        other = FakeClient(client_id=99)
        arm_gate.cancel_order(other, 1, source="test")
        self.ibkr_status(1, "Cancelled", 0, client=other, placed_by=99)
        self.assert_refused(stock(), order("SELL", Decimal(100)), "close_already_working", order_id=2)

    def test_status_names_the_placing_client_even_after_disconnect(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        self.client.clientId = None  # ibapi disconnect() clears it; the reader still runs
        self.ibkr_status(1, "Cancelled", 0, placed_by=21)
        self.client = FakeClient()
        self.place(stock(), order("SELL", Decimal(100)), order_id=2)
        self.assertEqual([item["order_id"] for item in self.stored_reservations()], ["2"])

    def test_status_before_the_placement_does_not_count(self) -> None:
        self.write_snapshot([held_stock(100)])
        arm_gate.cancel_order(self.client, 1, source="test")
        self.ibkr_status(1, "Cancelled", 0)  # an earlier order under the same id
        self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        self.assert_refused(stock(), order("SELL", Decimal(100)), "close_already_working", order_id=2)

    def test_observer_wraps_once_and_survives_a_failing_recorder(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(50)), order_id=1)
        self.place(stock(), order("SELL", Decimal(50)), order_id=1)
        arm_gate.cancel_order(self.client, 1, source="test")
        observer = self.client.orderStatus
        self.assertTrue(observer._arm_gate_observer)
        self.assertFalse(getattr(observer.__closure__[1].cell_contents, "_arm_gate_observer", False))
        with mock.patch.object(arm_gate, "_record_outcome", side_effect=RuntimeError("boom")):
            self.ibkr_status(1, "Cancelled", 0)
        self.assertEqual(self.client.statuses[-1][:2], (1, "Cancelled"))

    def test_disconnected_client_is_refused_and_reserves_nothing(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.client.connected = False
        self.assert_refused(stock(), order("SELL", Decimal(100)), "client_not_connected", order_id=1)
        self.assertFalse(self.reservations.exists())

    def test_a_close_whose_place_call_raises_still_counts(self) -> None:
        self.write_snapshot([held_stock(100)])
        with mock.patch.object(self.client, "placeOrder", side_effect=OSError("socket")):
            with self.assertRaises(OSError):
                self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        self.assert_refused(stock(), order("SELL", Decimal(100)), "close_already_working", order_id=2)

    def test_whatif_close_reserves_nothing(self) -> None:
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100), whatIf=True), order_id=1)
        self.assertFalse(self.reservations.exists())
        self.place(stock(), order("SELL", Decimal(100)), order_id=2)
        self.assert_refused(
            stock(), order("SELL", Decimal(1), whatIf=True), "close_already_working", order_id=3
        )

    def test_reduced_position_in_a_settled_snapshot_ends_the_reservation(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(1)), order_id=1)
        self.later_snapshot([held_option(2)])
        self.place(option(), order("SELL", Decimal(2)), order_id=2)
        self.assertEqual(len(self.client.placed), 2)
        self.assertEqual([item["order_id"] for item in self.stored_reservations()], ["2"])

    def test_unreduced_or_partly_reduced_position_keeps_the_reservation(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        self.later_snapshot([held_option(3)])
        self.assert_refused(option(), order("SELL", Decimal(1)), "close_already_working", order_id=2)
        self.later_snapshot([held_option(1)], stamp="20261104T120200Z")
        self.assert_refused(option(), order("SELL", Decimal(1)), "close_already_working", order_id=2)

    def test_unclassed_snapshot_never_ends_an_option_reservation(self) -> None:
        # Review round 7 (P2): without the class sidecar, SPX +2 and SPXW -2 net to 0,
        # which looked like a filled SELL 2. Another close then rewrote the file
        # without the reservation, and a duplicate close passed once classes came back.
        spx = dict(held_option(2, trading_class="SPX", con_id=1), symbol="SPX")
        spx["contract"] = dict(spx["contract"], symbol="SPX")
        spxw = dict(held_option(-2, trading_class="SPXW", con_id=2), symbol="SPX")
        spxw["contract"] = dict(spxw["contract"], symbol="SPX")
        positions = [spx, spxw, held_stock(100)]
        self.write_snapshot(positions)
        by_id = option(symbol="SPX", tradingClass="", conId=1)
        self.place(by_id, order("SELL", Decimal(2)), order_id=1)
        self.later_snapshot(positions, classes=False)
        self.place(stock(), order("SELL", Decimal(1)), order_id=2)  # prunes and rewrites the file
        self.assertEqual(sorted(item["order_id"] for item in self.stored_reservations()), ["1", "2"])
        self.later_snapshot(positions, stamp="20261104T120200Z")
        self.assert_refused(by_id, order("SELL", Decimal(2)), "close_already_working", order_id=3)
        self.assertEqual([placed[0] for placed in self.client.placed], [1, 2])

    def test_snapshot_within_the_settle_window_keeps_the_reservation(self) -> None:
        self.write_snapshot([held_option(3)], stamp="20261104T120000Z")
        self.place(option(), order("SELL", Decimal(1)), order_id=1)
        self.write_snapshot([held_option(2)], age=0.0, stamp="20261104T120100Z")
        self.assert_refused(option(), order("SELL", Decimal(1)), "close_already_working", order_id=2)

    def test_replacement_keeps_the_baseline_so_a_completed_close_ends(self) -> None:
        # IBKR counts the filled part in a modified order's totalQuantity.
        self.write_snapshot([held_stock(10)])
        self.place(stock(), order("SELL", Decimal(4)), order_id=1)
        self.later_snapshot([held_stock(8)])  # 2 filled
        self.place(stock(), order("SELL", Decimal(4), lmtPrice=0.9), order_id=1)  # 2 more
        [stored] = self.stored_reservations()
        self.assertEqual((stored["held_before"], stored["quantity"]), ("10", "4"))
        self.later_snapshot([held_stock(7)], stamp="20261104T120200Z")
        self.assert_refused(stock(), order("SELL", Decimal(1)), "close_already_working", order_id=2)
        self.later_snapshot([held_stock(6)], stamp="20261104T120300Z")
        self.place(stock(), order("SELL", Decimal(6)), order_id=2)
        self.assertEqual([placed[0] for placed in self.client.placed], [1, 1, 2])

    def test_replacement_with_a_smaller_quantity_keeps_the_larger(self) -> None:
        # IBKR may refuse the modify and leave the old order working.
        self.write_snapshot([held_stock(10)])
        self.place(stock(), order("SELL", Decimal(4)), order_id=1)
        self.place(stock(), order("SELL", Decimal(1)), order_id=1)
        [stored] = self.stored_reservations()
        self.assertEqual(stored["quantity"], "4")
        self.later_snapshot([held_stock(9)])
        self.assert_refused(stock(), order("SELL", Decimal(1)), "close_already_working", order_id=2)

    def test_reservations_survive_a_restart(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        [stored] = self.stored_reservations()
        self.assertEqual(stored["key"], "21:1")
        self.assertEqual(stored["client_id"], "21")
        self.assertEqual(stored["quantity"], "3")
        self.assertEqual(stored["held_before"], "3")
        self.assertEqual(stored["contract"]["strike"], "200.0")
        self.assertEqual(stored["source"], "test-order-policy")
        # The module keeps no reservation in memory: a new process and client
        # (same clientId, empty callbacks) read the same file.
        self.assertFalse(hasattr(arm_gate, "_close_reservations"))
        self.client = FakeClient()
        self.assert_refused(option(), order("SELL", Decimal(3)), "close_already_working", order_id=2)

    def test_invalid_or_unreadable_reservation_file_blocks_closes_only(self) -> None:
        self.write_snapshot([held_stock(100), held_option(3)])
        bad_files = (
            "{not json",
            json.dumps({"schema": "other", "reservations": []}),
            json.dumps({"schema": arm_gate.RESERVATIONS_SCHEMA, "reservations": [{"key": "x"}]}),
            json.dumps({"schema": arm_gate.RESERVATIONS_SCHEMA}),
        )
        for text in bad_files:
            with self.subTest(text=text[:40]):
                self.reservations.write_text(text)
                self.assert_refused(stock(), order("SELL", Decimal(1)), "reservations_invalid")
        self.reservations.unlink()
        self.reservations.mkdir()
        self.assert_refused(option(), order("SELL", Decimal(1)), "reservations_unreadable")
        self.place(option(strike=250.0), order("BUY", Decimal(1)))
        self.assertEqual(len(self.client.placed), 1)

    def test_duplicate_reservation_keys_are_invalid(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(1)), order_id=1)
        data = json.loads(self.reservations.read_text())
        data["reservations"].append(dict(data["reservations"][0]))
        self.reservations.write_text(json.dumps(data))
        self.assert_refused(option(), order("SELL", Decimal(1)), "reservations_invalid", order_id=1)

    def test_reservation_write_failure_refuses_the_close(self) -> None:
        self.write_snapshot([held_stock(100)])
        with mock.patch.object(arm_gate.os, "replace", side_effect=OSError("disk full")):
            self.assert_refused(stock(), order("SELL", Decimal(1)), "reservations_write_failed")
        self.assertFalse(self.reservations.exists())
        self.assertEqual(list(self.reservations.parent.glob(".order-policy-reservations*")), [])

    def test_check_order_policy_writes_nothing(self) -> None:
        self.write_snapshot([held_option(3)])
        self.assertEqual(
            arm_gate.check_order_policy(option(), order("SELL", Decimal(3))),
            arm_gate.ALLOW_POSITION_CLOSE,
        )
        self.assertEqual(
            arm_gate.check_order_policy(option(), order("BUY", Decimal(1))),
            arm_gate.ALLOW_LONG_OPTION,
        )
        self.assertFalse(self.reservations.exists())

    def test_a_held_reservation_lock_refuses_the_order(self) -> None:
        import fcntl

        self.write_snapshot([held_stock(100)])
        self.reservations.parent.mkdir(parents=True, exist_ok=True)
        with open(f"{self.reservations}.lock", "w") as other:
            fcntl.flock(other, fcntl.LOCK_EX)  # another process, e.g. the owner tool
            with mock.patch.object(arm_gate, "RESERVATIONS_LOCK_TIMEOUT_SECONDS", 0.2):
                self.assert_refused(stock(), order("SELL", Decimal(1)), "reservations_locked")
        self.place(stock(), order("SELL", Decimal(1)))
        self.assertEqual(len(self.client.placed), 1)

    def test_disarm_during_the_lock_wait_refuses(self) -> None:
        self.write_snapshot([held_stock(100)])
        real_lock = arm_gate._reservations_lock

        @contextlib.contextmanager
        def lock_then_disarm(path):
            with real_lock(path):
                self.gate.disarm(actor="owner", reason="disarm while waiting")
                yield

        with mock.patch.object(arm_gate, "_reservations_lock", lock_then_disarm):
            refusal = self.assert_refused(stock(), order("SELL", Decimal(1)), "disarmed")
        self.assertIn("no_arm_record", refusal.detail)
        self.assertFalse(self.reservations.exists())

    def test_ibapi_shaped_client_is_observed_through_its_wrapper(self) -> None:
        class IbapiLike(FakeClient):
            def __init__(self) -> None:
                super().__init__()
                self.wrapper = self  # EClient.__init__(self, wrapper=self)
                self.rows: dict[int, str] = {}

                def staged_order_status(order_id, status, *_rest):  # instance override
                    self.rows[order_id] = status

                self.orderStatus = staged_order_status

        self.client = IbapiLike()
        self.write_snapshot([held_stock(100)])
        self.place(stock(), order("SELL", Decimal(100)), order_id=1)
        # The decoder calls self.wrapper.orderStatus(...) with ibapi's 11 arguments.
        self.client.wrapper.orderStatus(1, "Cancelled", Decimal(0), Decimal(100), 0.0, 5, 0, 0.0, 21, "", 0.0)
        self.assertEqual(self.client.rows, {1: "Cancelled"})
        self.place(stock(), order("SELL", Decimal(100)), order_id=2)
        self.assertEqual([placed[0] for placed in self.client.placed], [1, 2])

    # -- owner release tool ------------------------------------------------------

    def run_tool(self, *argv: str) -> tuple[int, dict]:
        env = {
            RESERVATIONS_ENV: str(self.reservations),
            "NAUTILUS_ARM_AUDIT_PATH": str(self.audit),
            "NAUTILUS_ARMED_PATH": str(self.tmp / "nautilus" / "ARMED"),
        }
        out = io.StringIO()
        with redirect_stdout(out):
            code = arm_gate.main(list(argv), env=env)
        return code, json.loads(out.getvalue())

    def test_owner_tool_lists_and_releases_a_reservation(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        code, listed = self.run_tool("reservations", "--json")
        self.assertEqual(code, 0)
        self.assertEqual([item["key"] for item in listed["reservations"]], ["21:1"])
        reason = "checked TWS: order 1 is cancelled"
        code, released = self.run_tool("release-close", "--key", "21:1", "--by", "owner", "--reason", reason)
        self.assertEqual((code, released["released"], released["remaining"]), (0, True, 0))
        [event] = [e for e in self.audit_events() if e["event"] == arm_gate.RESERVATION_AUDIT_EVENT]
        self.assertEqual((event["actor"], event["reason"], event["key"]), ("owner", reason, "21:1"))
        self.assertEqual(self.stored_reservations(), [])
        self.place(option(), order("SELL", Decimal(3)), order_id=2)
        self.assertEqual(len(self.client.placed), 2)

    def test_owner_tool_refusals(self) -> None:
        self.write_snapshot([held_option(3)])
        self.place(option(), order("SELL", Decimal(3)), order_id=1)
        cases = (
            (("--key", "21:9", "--by", "owner", "--reason", "checked TWS first"), "unknown_reservation"),
            (("--key", "21:1", "--by", "bad actor!", "--reason", "checked TWS first"), "invalid_actor"),
            (("--key", "21:1", "--by", "owner", "--reason", "short"), "invalid_reason"),
        )
        for args, error in cases:
            with self.subTest(error=error):
                code, payload = self.run_tool("release-close", *args)
                self.assertEqual((code, payload["error"]), (2, error))
        self.assertEqual(len(self.stored_reservations()), 1)
        self.reservations.write_text("{bad")
        code, payload = self.run_tool("reservations")
        self.assertEqual((code, payload["error"]), (2, "reservations_invalid"))

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
        self.assertEqual(self.gate.status().as_dict()["order_policy"], "options_only_defined_risk_v2")
        self.assertEqual(arm_gate.current_status().as_dict()["order_policy"], arm_gate.ORDER_POLICY)
        status = arm_gate.order_policy_status({MAX_AGE_ENV: "bad"})
        self.assertEqual(status["order_policy"], arm_gate.ORDER_POLICY)
        self.assertEqual(status["account_snapshot_dir"], arm_gate.DEFAULT_ACCOUNT_SNAPSHOT_DIR)
        self.assertEqual(status["max_snapshot_age_seconds"], 180.0)
        self.assertEqual(status["max_loss_pct_of_net_liquidation"], "2.0")
        self.assertEqual(status["close_reservations_path"], arm_gate.DEFAULT_RESERVATIONS_PATH)
        self.assertEqual(
            arm_gate.DEFAULT_RESERVATIONS_PATH, "/app/data/nautilus/order-policy-reservations.json"
        )
        self.assertIsNone(arm_gate.order_policy_status({MAX_LOSS_ENV: "3"})["max_loss_pct_of_net_liquidation"])
        self.assertEqual(arm_gate.order_policy_status({MAX_LOSS_ENV: "1.5"})["max_loss_pct_of_net_liquidation"], "1.5")


if __name__ == "__main__":
    unittest.main()
