"""Order policy v3 in ``arm_gate``: defined-risk vertical spreads behind their switch.

Owner decision 2026-11-11 (card vertex-golive-spread-gate). The switch
``NAUTILUS_ORDER_POLICY_ALLOW_DEFINED_RISK_SPREADS`` is off unless its value is
``owner-decision:<Discord message link>``; off is exactly the v2 behaviour that
``test_order_policy.py`` pins. These tests cover the switch, the accept and
refuse tables for BAG orders with hand-computed max loss, the per-order, per-name
and total caps with the open-risk ledger, closing verticals and the rule that a
close may not raise the risk of what stays held, the leg contracts ``place_order``
asks IBKR for, the dry transmit path, the owner tools and a seeded property test
with its own max-loss and exposure arithmetic.

Like the v2 suite they use a real armed ``ArmGate`` in a temporary directory,
synthetic account snapshots, temporary reservation and ledger files and a fake
client that only records ``placeOrder`` calls. Nothing reaches a broker.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import random
import shutil
import sys
import tempfile
import time
import unittest
from collections import Counter
from collections.abc import Iterator
from contextlib import redirect_stdout
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "runtime" / "nautilus"))
import arm_gate  # noqa: E402
import test_order_policy as v2  # noqa: E402 - FakeClient, option(), order(), held_stock() and env names

FLAG_ENV = "NAUTILUS_ORDER_POLICY_ALLOW_DEFINED_RISK_SPREADS"
NAME_SHORT_ENV = "NAUTILUS_ORDER_POLICY_NAME_CAP_SHORT_PCT"
NAME_LEAPS_ENV = "NAUTILUS_ORDER_POLICY_NAME_CAP_LEAPS_PCT"
TOTAL_ENV = "NAUTILUS_ORDER_POLICY_MAX_TOTAL_RISK_PCT"
LEG_TIMEOUT_ENV = "NAUTILUS_ORDER_POLICY_LEG_QUALIFY_TIMEOUT_SECONDS"
# place_order's own reqContractDetails ids start here; the client's callbacks never see them.
QUALIFY_REQUEST_BASE = 1_900_000_000
CAP_ENVS = (v2.MAX_LOSS_ENV, NAME_SHORT_ENV, NAME_LEAPS_ENV, TOTAL_ENV)
RESERVATIONS_SCHEMA = "nautilus-order-policy-reservations-v1"
OPEN_RISK_KEY = "open_risk"  # the working opening orders: one more key of the reservation file

LINK = "https://discord.com/channels/1000000000000000001/1000000000000000002/1000000000000000003"
FLAG_ON = f"owner-decision:{LINK}"
SOURCE = "test-order-policy-v3"
# Default caps on 100,000 USD: 2,000 per order, 2,000 per name under 365 days,
# 6,000 per name over all expiries, 10,000 in total.
NLV = 100_000
# A fixed clock for the tests that sit on a date boundary (passed as ``now=``).
FIXED_NOW = datetime(2027, 3, 15, 15, 0, tzinfo=UTC).timestamp()
FIXED_TODAY = date(2027, 3, 15)

# (value of the switch, detail order_policy_status reports). None: not set.
OFF_VALUES: tuple[tuple[str | None, str], ...] = (
    (None, "off"),
    ("", "off"),
    ("   ", "off"),
    ("off", "off"),
    ("OFF", "off"),
    ("false", "off"),
    ("0", "off"),
    ("no", "off"),
    ("true", "off_invalid_value"),
    ("True", "off_invalid_value"),
    ("1", "off_invalid_value"),
    ("on", "off_invalid_value"),
    ("yes", "off_invalid_value"),
    ("enabled", "off_invalid_value"),
    (LINK, "off_invalid_value"),  # a bare link: the prefix is missing
    ("owner-decision", "off_invalid_value"),
    ("owner-decision:", "off_invalid_value"),
    ("owner-decision:yes", "off_invalid_value"),
    ("owner-decision:https://discord.com/channels/abc/def/ghi", "off_invalid_value"),
    ("owner-decision:https://discord.com/channels/1234/1234/1234", "off_invalid_value"),  # ids too short
    (f"owner-decision:{LINK.rsplit('/', 1)[0]}", "off_invalid_value"),  # a channel, not a message
    (f"owner-decision:{LINK.replace('https://', 'http://')}", "off_invalid_value"),
    (f"owner-decision:{LINK.replace('discord.com', 'discord.gg')}", "off_invalid_value"),
    (f"owner-decision:{LINK.upper()}", "off_invalid_value"),
    (f"owner-decision:{LINK}/1", "off_invalid_value"),
    (f"owner-decision:{LINK}?x=1", "off_invalid_value"),
    (f"owner-decision:{LINK} {LINK}", "off_invalid_value"),
    (f"owner-decision: {LINK}", "off_invalid_value"),
    (f"owner-decision:owner-decision:{LINK}", "off_invalid_value"),
    (f"Owner-Decision:{LINK}", "off_invalid_value"),
    (f"x owner-decision:{LINK}", "off_invalid_value"),
)

_CON_IDS: dict[tuple, int] = {}


def con_id(
    symbol: str,
    expiry: str,
    right: str,
    strike,
    multiplier: str = "100",
    trading_class: str | None = None,
    currency: str = "USD",
) -> int:
    """One stable conId per option contract, shared by leg contracts and held positions."""

    trading_class = symbol if trading_class is None else trading_class
    key = (symbol, expiry, right, Decimal(str(strike)), str(multiplier), trading_class, currency)
    return _CON_IDS.setdefault(key, 700_001 + len(_CON_IDS))


def leg(
    strike, right: str = "C", *, expiry: str, symbol: str = "AAPL", multiplier: str = "100", **extra
) -> SimpleNamespace:
    """An IBKR-qualified option contract: conId, tradingClass and multiplier are set."""

    trading_class, currency = extra.get("tradingClass", symbol), extra.get("currency", "USD")
    fields = {
        "tradingClass": trading_class,
        "conId": con_id(symbol, expiry, right, strike, multiplier, trading_class, currency),
    }
    fields.update(extra)
    return v2.option(
        symbol=symbol, expiry=expiry, right=right, strike=strike, multiplier=multiplier, **fields
    )


def combo_leg(contract, action: str, ratio=1) -> SimpleNamespace:
    return SimpleNamespace(
        conId=getattr(contract, "conId", contract), ratio=ratio, action=action, exchange="SMART"
    )


def bag(*combo_legs: SimpleNamespace, symbol: str = "AAPL", currency: str = "USD", **extra) -> SimpleNamespace:
    return SimpleNamespace(
        symbol=symbol, secType="BAG", currency=currency, exchange="SMART", comboLegs=list(combo_legs), **extra
    )


def vertical(buy: SimpleNamespace, sell: SimpleNamespace) -> tuple[SimpleNamespace, list[SimpleNamespace]]:
    """The BAG that buys ``buy`` and sells ``sell``, and its leg contracts."""

    return bag(combo_leg(buy, "BUY"), combo_leg(sell, "SELL"), symbol=buy.symbol), [buy, sell]


def held(
    quantity,
    strike,
    right: str = "C",
    *,
    expiry: str,
    symbol: str = "AAPL",
    cost=None,
    multiplier: str = "100",
    trading_class: str | None = None,
) -> dict:
    """A held option. ``cost``: ``average_cost`` per contract as IBKR reports it (always positive)."""

    trading_class = symbol if trading_class is None else trading_class
    row = {
        "symbol": symbol,
        "sec_type": "OPT",
        "currency": "USD",
        "quantity": quantity,
        "contract": {
            "symbol": symbol,
            "secType": "OPT",
            "exchange": "",
            "currency": "USD",
            "lastTradeDateOrContractMonth": expiry,
            "strike": strike,
            "right": right,
            "multiplier": multiplier,
            "tradingClass": trading_class,
            "conId": con_id(symbol, expiry, right, strike, multiplier, trading_class),
        },
    }
    if cost is not None:
        row["average_cost"] = cost
    return row


def ledger_entry(number: int, symbol: str, expiry: str, max_loss) -> dict:
    """One working opening order as the ledger file stores it (client 21, order id ``number``)."""

    return {
        "key": f"21:{number}",
        "order_id": str(number),
        "client_id": "21",
        "source": SOURCE,
        "symbol": symbol,
        "expiry": expiry,
        "signature": "BUY:1|SELL:2",
        "description": f"{symbol} {expiry} test entry",
        "max_loss": str(max_loss),
        "placed_at": time.time() - 3600,
    }


def spec_of(contract, order_, legs) -> str:
    """The JSON the ``preview`` tool reads from stdin (IBKR field names)."""

    def plain(value):
        if isinstance(value, SimpleNamespace):
            return {name: plain(item) for name, item in vars(value).items()}
        if isinstance(value, (list, tuple)):
            return [plain(item) for item in value]
        return str(value) if isinstance(value, Decimal) else value

    spec = {"contract": plain(contract), "order": plain(order_)}
    if legs is not None:
        spec["legs"] = plain(legs)
    return json.dumps(spec)


def dry_spread_notes() -> list[str]:
    """The notes of an accepted opening spread in a dry check (no client asks IBKR for the legs)."""

    return [arm_gate.EARLY_ASSIGNMENT_NOTE, arm_gate.LEGS_NOT_QUALIFIED_NOTE]


class QualifyingClient(v2.FakeClient):
    """The v2 fake client plus IBKR's contract-details answers for ``place_order``'s leg check.

    ``reqContractDetails`` answers at once from ``known`` (conId -> IBKR's contract)
    by calling the client's callbacks, as the ibapi reader would. ``answer`` picks
    another reply. The client's own callbacks record whatever reaches them.
    """

    def __init__(self, client_id: int = 21) -> None:
        super().__init__(client_id)
        self.known: dict[object, SimpleNamespace] = {}
        self.answer = "known"
        self.detail_requests: list[tuple[int, object]] = []
        self.own_callbacks: list[tuple] = []

    def reqContractDetails(self, reqId, contract) -> None:  # noqa: N802,N803 - ibapi names
        self.detail_requests.append((reqId, contract))
        known = self.known.get(getattr(contract, "conId", None))
        if self.answer == "silence":
            return
        if self.answer == "raise":
            raise ConnectionError("socket closed")
        if self.answer == "error" or known is None:
            self.error(reqId, 200, "No security definition has been found for the request")
            return
        lines = {
            "known": [known],
            "nothing listed": [],
            # IBKR lists one contract once per exchange.
            "once per exchange": [known, SimpleNamespace(**{**vars(known), "exchange": "CBOE"})],
            "two contracts": [known, SimpleNamespace(**{**vars(known), "strike": 995.0})],
        }[self.answer]
        for line in lines:
            self.contractDetails(reqId, SimpleNamespace(contract=line))
        self.contractDetailsEnd(reqId)

    def contractDetails(self, reqId, details) -> None:  # noqa: N802,N803
        self.own_callbacks.append(("contractDetails", reqId))

    def contractDetailsEnd(self, reqId) -> None:  # noqa: N802,N803
        self.own_callbacks.append(("contractDetailsEnd", reqId))

    def error(self, reqId, *rest) -> None:  # noqa: N803
        self.own_callbacks.append(("error", reqId))


class V3TestCase(unittest.TestCase):
    """An armed gate, a temporary snapshot directory, reservation file and ledger; switch per ``FLAG``."""

    FLAG: str | None = FLAG_ON

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.reports = self.tmp / "nautilus" / "reports"
        self.reports.mkdir(parents=True)
        self.audit = self.tmp / "nautilus" / "arm-audit.jsonl"
        self.armed_path = self.tmp / "nautilus" / "ARMED"
        self.kill_switch = self.tmp / "KILL_SWITCH"
        self.gate = arm_gate.ArmGate(
            self.armed_path, "img-1", kill_switch_path=self.kill_switch, audit_path=self.audit
        )
        self.gate.arm(actor="owner", reason=v2.REASON, confirm_image_version="img-1")
        previous = arm_gate.current()
        arm_gate.configure(self.gate)
        self.addCleanup(arm_gate.configure, previous)
        self.reservations = self.tmp / "nautilus" / "order-policy-reservations.json"
        self.paths = {
            v2.SNAPSHOT_ENV: str(self.reports),
            v2.RESERVATIONS_ENV: str(self.reservations),
        }
        patcher = mock.patch.dict(os.environ, self.paths)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in (FLAG_ENV, v2.MAX_AGE_ENV, *CAP_ENVS, *(f"{cap}_SOURCE" for cap in CAP_ENVS)):
            os.environ.pop(name, None)
        if self.FLAG is not None:
            os.environ[FLAG_ENV] = self.FLAG
        os.environ[LEG_TIMEOUT_ENV] = "2"  # the fake IBKR answers at once; a fault may not stall the suite
        arm_gate._order_outcomes.clear()
        self.addCleanup(arm_gate._order_outcomes.clear)
        self.client = QualifyingClient()
        self.addCleanup(self.assert_own_callbacks_never_saw_the_gates_requests)
        self.today = datetime.now(UTC).date()
        self.near = self.exp(45)
        self.leaps = self.exp(500)

    def assert_own_callbacks_never_saw_the_gates_requests(self) -> None:
        seen = [item for item in self.client.own_callbacks if item[1] >= QUALIFY_REQUEST_BASE]
        self.assertEqual(seen, [])
        for request_id, _ in self.client.detail_requests:
            self.assertGreaterEqual(request_id, QUALIFY_REQUEST_BASE)

    # -- fixtures --------------------------------------------------------------

    def exp(self, days: int, today: date | None = None) -> str:
        return ((today or self.today) + timedelta(days=days)).strftime("%Y%m%d")

    @contextlib.contextmanager
    def environ(self, **values: str | None) -> Iterator[None]:
        """Set (or with None remove) environment values for one block."""

        with mock.patch.dict(os.environ):
            for name, value in values.items():
                os.environ.pop(name, None)
                if value is not None:
                    os.environ[name] = value
            yield

    def flag(self, value: str | None):
        return self.environ(**{FLAG_ENV: value})

    def write_snapshot(
        self,
        positions: list[dict],
        *,
        age: float = 5.0,
        stamp: str = "20261104T120000Z",
        nlv=NLV,
        summary: dict | None = None,
        classes: bool = True,
        now: float | None = None,
    ) -> Path:
        """The v2 suite's snapshot shape (v1 file + class sidecar), with NLV and the clock as options."""

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
        captured = (time.time() if now is None else now) - age
        payload = {
            "schemaVersion": "ibkr-account-snapshot/v1",
            "captured_at_epoch": captured,
            "positions": v1_positions,
            "summary": {"NetLiquidation": {"USD": str(nlv)}} if summary is None else summary,
        }
        path.write_text(json.dumps(payload), encoding="utf-8")
        sidecar_path = self.reports / arm_gate.CLASS_SIDECAR_NAME
        if classes:
            sidecar_path.write_text(
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
        else:
            sidecar_path.unlink(missing_ok=True)
        return path

    def later_snapshot(self, positions: list[dict], stamp: str = "20261104T120300Z") -> None:
        """A snapshot captured after the settle window of every status seen so far."""

        self.write_snapshot(positions, age=-(arm_gate.CLOSE_RESERVATION_SETTLE_SECONDS + 5), stamp=stamp)

    def write_ledger(self, *entries: dict) -> None:
        """Store the working opening orders; the close reservations in the file stay."""

        self.write_file(**{OPEN_RISK_KEY: list(entries)})

    def write_file(self, **changes) -> None:
        document = {
            "schema": RESERVATIONS_SCHEMA,
            "updated_at": "2026-11-11T00:00:00Z",
            "reservations": self.stored_reservations(),
            **changes,
        }
        self.reservations.write_text(json.dumps(document), encoding="utf-8")

    def leg(self, strike, right: str = "C", **fields) -> SimpleNamespace:
        fields.setdefault("expiry", self.near)
        return leg(strike, right, **fields)

    def held(self, quantity, strike, right: str = "C", **fields) -> dict:
        fields.setdefault("expiry", self.near)
        return held(quantity, strike, right, **fields)

    def debit_call(
        self, loss, *, symbol: str = "AAPL", expiry: str | None = None, low: int = 100, quantity: int = 1, **extra
    ):
        """(BAG, order, legs) of a bull call debit spread ``low``/``low + 50`` whose max loss is ``loss`` USD.

        Max loss of a debit spread = net debit x 100 x quantity, so the limit is loss / 100 / quantity.
        """

        fields = {"symbol": symbol, "expiry": expiry or self.near}
        contract, legs = vertical(leg(low, "C", **fields), leg(low + 50, "C", **fields))
        limit = Decimal(str(loss)) / 100 / quantity
        return contract, v2.order("BUY", quantity, lmtPrice=limit, **extra), legs

    def long_call(
        self, loss, *, symbol: str = "AAPL", expiry: str | None = None, strike: int = 400, quantity: int = 1, **extra
    ):
        """(option, order, None) of a long call whose premium is ``loss`` USD."""

        contract = leg(strike, "C", symbol=symbol, expiry=expiry or self.near)
        limit = Decimal(str(loss)) / 100 / quantity
        return contract, v2.order("BUY", quantity, lmtPrice=limit, **extra), None

    # -- calls and assertions -----------------------------------------------------

    def check(self, contract, order_, legs=None, order_id: int = 7, **options) -> str:
        return arm_gate.check_order_policy(
            contract, order_, order_id=order_id, client=self.client, legs=legs, **options
        )

    def preview(self, contract, order_, legs=None, order_id: int = 7, **options) -> dict:
        return arm_gate.preview_order(
            contract, order_, legs=legs, order_id=order_id, client=self.client, **options
        )

    def place(self, contract, order_, legs=None, order_id: int = 7, client=None) -> None:
        """``place_order`` on the armed gate. The fake IBKR knows the caller's legs unless a test said otherwise."""

        client = client or self.client
        if isinstance(legs, (list, tuple)) and hasattr(client, "known"):
            for item in legs:
                client.known.setdefault(getattr(item, "conId", None), item)
        arm_gate.place_order(client, order_id, contract, order_, source=SOURCE, legs=legs)

    def assert_accepted(
        self,
        contract,
        order_,
        legs,
        max_loss,
        allowance: str = "vertical_spread_open",
        order_id: int = 7,
        **options,
    ) -> dict:
        """The policy accepts the order; ``max_loss`` (USD, None for closes) is what it reports."""

        result = self.preview(contract, order_, legs, order_id, **options)
        self.assertEqual(result["policy_decision"], "accepted", result)
        self.assertEqual(result["allowance"], allowance)
        if max_loss is None:
            self.assertIsNone(result["max_loss_usd"])
        else:
            self.assertEqual(Decimal(result["max_loss_usd"]), Decimal(str(max_loss)), result)
        self.assertEqual(self.check(contract, order_, legs, order_id, **options), allowance)
        return result

    def assert_refused(self, contract, order_, legs, code: str, order_id: int = 7, **options) -> dict:
        """``check_order_policy`` raises ``code`` and the dry path names the same reason."""

        with self.assertRaises(arm_gate.OrderPolicyError) as caught:
            self.check(contract, order_, legs, order_id, **options)
        self.assertEqual(caught.exception.code, code, str(caught.exception))
        result = self.preview(contract, order_, legs, order_id, **options)
        self.assertEqual(
            (result["policy_decision"], result["policy_refusal"], result["transmit_refusal"]),
            ("refused", code, code),
        )
        self.assertFalse(result["would_transmit"])
        return result

    def assert_place_refused(self, contract, order_, legs, code: str, order_id: int = 7) -> None:
        """``place_order`` on the armed gate raises ``code`` and calls no ``placeOrder``."""

        before = list(self.client.placed)
        with self.assertRaises(arm_gate.OrderPolicyError) as caught:
            self.place(contract, order_, legs, order_id)
        self.assertEqual(caught.exception.code, code, str(caught.exception))
        self.assertEqual(self.client.placed, before)

    def ledger(self) -> list[dict] | None:
        """The stored working opening orders; None when there is no file, [] when it has none."""

        if not self.reservations.exists():
            return None
        data = json.loads(self.reservations.read_text())
        self.assertEqual(data["schema"], RESERVATIONS_SCHEMA)
        self.assertNotEqual(data.get(OPEN_RISK_KEY), [])  # never an empty list: the v2 shape is kept
        return data.get(OPEN_RISK_KEY, [])

    def stored_reservations(self) -> list[dict]:
        if not self.reservations.exists():
            return []
        return json.loads(self.reservations.read_text())["reservations"]

    def audit_events(self, event: str | None = None) -> list[dict]:
        if not self.audit.exists():
            return []
        events = [json.loads(line) for line in self.audit.read_text().splitlines()]
        return [item for item in events if event is None or item["event"] == event]

    def run_tool(self, *argv: str, stdin: str = "", env: dict[str, str] | None = None) -> tuple[int, dict]:
        """``arm_gate.main`` with an explicit environment (the paths, the audit file, the switch)."""

        tool_env = {
            **self.paths,
            "NAUTILUS_ARM_AUDIT_PATH": str(self.audit),
            "NAUTILUS_ARMED_PATH": str(self.armed_path),
            "KILL_SWITCH_PATH": str(self.kill_switch),
        }
        if FLAG_ENV in os.environ:
            tool_env[FLAG_ENV] = os.environ[FLAG_ENV]
        tool_env.update(env or {})
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.object(sys, "stdin", io.StringIO(stdin)):
            code = arm_gate.main(list(argv), env=tool_env)
        return code, json.loads(out.getvalue())


# -- 1. the switch ---------------------------------------------------------------


class SpreadsFlagTest(unittest.TestCase):
    def test_env_names_are_the_documented_ones(self) -> None:
        self.assertEqual(arm_gate.SPREADS_FLAG_ENV, FLAG_ENV)
        self.assertEqual(arm_gate.NAME_CAP_SHORT_PCT_ENV, NAME_SHORT_ENV)
        self.assertEqual(arm_gate.NAME_CAP_LEAPS_PCT_ENV, NAME_LEAPS_ENV)
        self.assertEqual(arm_gate.TOTAL_RISK_PCT_ENV, TOTAL_ENV)
        self.assertEqual(arm_gate.OPEN_RISK_KEY, OPEN_RISK_KEY)
        self.assertEqual(arm_gate.RESERVATIONS_SCHEMA, RESERVATIONS_SCHEMA)
        self.assertEqual(arm_gate.ORDER_POLICY, "options_only_defined_risk_v3")

    def test_every_value_but_the_owner_decision_link_is_off(self) -> None:
        for value, detail in OFF_VALUES:
            with self.subTest(value=value):
                env = {} if value is None else {FLAG_ENV: value}
                self.assertEqual(arm_gate._spreads_flag(env), (False, detail))
                status = arm_gate.order_policy_status(env)
                self.assertIs(status["allow_defined_risk_spreads"], False)
                self.assertEqual(status["allow_defined_risk_spreads_detail"], detail)

    def test_the_owner_decision_link_turns_it_on_and_is_reported(self) -> None:
        for link in (LINK, "https://discord.com/channels/12345/1234567/1234567890123456789012345"):
            with self.subTest(link=link):
                env = {FLAG_ENV: f"owner-decision:{link}"}
                self.assertEqual(arm_gate._spreads_flag(env), (True, link))
                status = arm_gate.order_policy_status(env)
                self.assertIs(status["allow_defined_risk_spreads"], True)
                self.assertEqual(status["allow_defined_risk_spreads_detail"], link)

    def test_without_an_explicit_env_the_process_environment_is_read(self) -> None:
        with mock.patch.dict(os.environ, {FLAG_ENV: FLAG_ON}):
            self.assertIs(arm_gate.order_policy_status()["allow_defined_risk_spreads"], True)
        with mock.patch.dict(os.environ, {FLAG_ENV: "true"}):
            status = arm_gate.order_policy_status()
            self.assertIs(status["allow_defined_risk_spreads"], False)
            self.assertEqual(status["allow_defined_risk_spreads_detail"], "off_invalid_value")
        with mock.patch.dict(os.environ):
            os.environ.pop(FLAG_ENV, None)
            status = arm_gate.order_policy_status()
            self.assertEqual(
                (status["allow_defined_risk_spreads"], status["allow_defined_risk_spreads_detail"]),
                (False, "off"),
            )

    def test_status_reports_each_cap_with_its_source(self) -> None:
        status = arm_gate.order_policy_status({FLAG_ENV: FLAG_ON, v2.RESERVATIONS_ENV: "/tmp/ledger.json"})
        self.assertEqual(status["order_policy"], "options_only_defined_risk_v3")
        caps = status["spread_risk_caps"]
        self.assertEqual(
            {name: Decimal(cap["pct_of_net_liquidation"]) for name, cap in caps.items()},
            {
                "per_order": Decimal(2),
                "name_short_dated": Decimal(2),
                "name_all_expiries": Decimal(6),
                "total_open_risk": Decimal(10),
            },
        )
        for name, cap in caps.items():
            self.assertTrue(cap["source"], name)
        self.assertIsNone(status["spread_risk_caps_error"])
        self.assertEqual(status["leaps_min_days"], 365)
        self.assertEqual(status["open_risk_ledger_path"], "/tmp/ledger.json")

    def test_status_reports_an_environment_cap_only_with_its_source(self) -> None:
        env = {TOTAL_ENV: "5", f"{TOTAL_ENV}_SOURCE": "owner 2026-11-11: total 5%"}
        cap = arm_gate.order_policy_status(env)["spread_risk_caps"]["total_open_risk"]
        self.assertEqual((Decimal(cap["pct_of_net_liquidation"]), cap["source"]), (Decimal(5), "owner 2026-11-11: total 5%"))
        for env, error in (
            ({TOTAL_ENV: "5"}, "risk_config_source_missing"),
            ({TOTAL_ENV: "5", f"{TOTAL_ENV}_SOURCE": "   "}, "risk_config_source_missing"),
            ({TOTAL_ENV: "101", f"{TOTAL_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
            ({NAME_SHORT_ENV: "2.5", f"{NAME_SHORT_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
            ({NAME_LEAPS_ENV: "6.5", f"{NAME_LEAPS_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
            ({v2.MAX_LOSS_ENV: "2.5", f"{v2.MAX_LOSS_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
            ({TOTAL_ENV: "0", f"{TOTAL_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
            ({TOTAL_ENV: "-1", f"{TOTAL_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
            ({TOTAL_ENV: "ten", f"{TOTAL_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
        ):
            with self.subTest(env=env):
                status = arm_gate.order_policy_status(env)
                self.assertIsNone(status["spread_risk_caps"])
                self.assertEqual(status["spread_risk_caps_error"], error)


# -- 2. switch off = v2 ----------------------------------------------------------


class FlagOffIsV2Test(V3TestCase):
    FLAG = None

    def bag_samples(self) -> dict[str, tuple]:
        low, high = self.leg(200), self.leg(205)
        held_long, held_short = self.leg(120), self.leg(130)
        debit, legs = vertical(low, high)
        credit, credit_legs = vertical(high, low)
        closing, closing_legs = vertical(held_short, held_long)
        butterfly_legs = [low, high, self.leg(210)]
        butterfly = bag(combo_leg(low, "BUY"), combo_leg(high, "SELL", 2), combo_leg(butterfly_legs[2], "BUY"))
        return {
            "a valid debit vertical": (debit, v2.order("BUY", 1, lmtPrice=1.50), legs),
            "a valid credit vertical": (credit, v2.order("BUY", 1, lmtPrice=-1.50), credit_legs),
            "a valid vertical as SELL": (credit, v2.order("SELL", 2, lmtPrice=1.50), credit_legs),
            "a valid vertical whatIf": (debit, v2.order("BUY", 1, lmtPrice=1.50, whatIf=True), legs),
            "a closing vertical": (closing, v2.order("BUY", 2, lmtPrice=-9.0), closing_legs),
            "a BAG without leg contracts": (debit, v2.order("BUY", 1, lmtPrice=1.50), None),
            "a BAG without comboLegs": (bag(), v2.order("BUY", 1, lmtPrice=1.50), None),
            "a butterfly": (butterfly, v2.order("BUY", 1, lmtPrice=1.0), butterfly_legs),
            "a market BAG": (debit, v2.order("BUY", 1, orderType="MKT"), legs),
            "an option contract that carries comboLegs": (
                v2.option(expiry=self.near, comboLegs=[combo_leg(low, "BUY"), combo_leg(high, "SELL")]),
                v2.order("BUY", 1, lmtPrice=1.50),
                legs,
            ),
        }

    def test_every_bag_is_combo_refused_for_every_off_value(self) -> None:
        self.write_snapshot([self.held(2, 120, cost=900.0), self.held(-2, 130, cost=300.0)])
        placed = 0
        for value, detail in OFF_VALUES:
            with self.subTest(value=value), self.flag(value):
                for name, (contract, order_, legs) in self.bag_samples().items():
                    with self.subTest(order=name):
                        result = self.assert_refused(contract, order_, legs, "combo_refused")
                        self.assertIs(result["allow_defined_risk_spreads"], False)
                        self.assertEqual(result["allow_defined_risk_spreads_detail"], detail)
                        self.assert_place_refused(contract, order_, legs, "combo_refused")
                        placed += 1
        self.assertEqual(self.client.placed, [])
        self.assertEqual(self.client.detail_requests, [])  # off: IBKR is not asked about the legs either
        self.assertFalse(self.reservations.exists())
        refusals = self.audit_events("order_refused")
        self.assertEqual(len(refusals), placed)
        self.assertEqual({item["error"] for item in refusals}, {"combo_refused"})

    def test_the_same_vertical_is_accepted_once_the_switch_is_on(self) -> None:
        self.write_snapshot([])
        contract, order_, legs = self.bag_samples()["a valid debit vertical"]
        self.assert_refused(contract, order_, legs, "combo_refused")
        with self.flag(FLAG_ON):
            self.assert_accepted(contract, order_, legs, 150)
        self.assert_refused(contract, order_, legs, "combo_refused")

    def test_an_option_contract_with_combo_legs_is_refused_with_the_switch_on_too(self) -> None:
        self.write_snapshot([])
        contract, order_, legs = self.bag_samples()["an option contract that carries comboLegs"]
        with self.flag(FLAG_ON):
            self.assert_refused(contract, order_, legs, "combo_refused")

    def test_long_option_buys_have_no_name_cap_and_no_ledger_while_off(self) -> None:
        self.write_snapshot([])
        contract = v2.option(expiry=self.near)
        max_size = v2.order("BUY", Decimal(4), lmtPrice=5.0)  # 4 x 5.00 x 100 = 2,000 USD = 2% of NLV
        self.place(contract, max_size, order_id=1)
        self.place(contract, max_size, order_id=2)  # v2: the cap is per order, the name is not summed
        self.place(v2.option(expiry=self.leaps), max_size, order_id=3)
        self.assertEqual(len(self.client.placed), 3)
        self.assertFalse(self.reservations.exists())
        self.assert_place_refused(contract, v2.order("BUY", Decimal(5), lmtPrice=4.01), None, "max_loss_exceeded", 4)
        result = self.preview(contract, max_size)
        self.assertEqual((result["policy_decision"], result["allowance"]), ("accepted", "long_option_open"))
        self.assertIsNone(result["max_loss_usd"])  # v2 decisions carry no max loss
        self.assertEqual(result["notes"], [])

    def test_the_second_max_size_buy_in_a_name_is_refused_once_the_switch_is_on(self) -> None:
        self.write_snapshot([])
        contract = v2.option(expiry=self.near)
        max_size = v2.order("BUY", Decimal(4), lmtPrice=5.0)
        with self.flag(FLAG_ON):
            self.place(contract, max_size, order_id=1)
            self.assert_place_refused(contract, max_size, None, "name_short_dated_cap_exceeded", order_id=2)
            self.assert_place_refused(
                v2.option(expiry=self.near, right="P", strike=150.0),
                v2.order("BUY", 1, lmtPrice=0.05),
                None,
                "name_short_dated_cap_exceeded",
                order_id=3,
            )
            self.place(v2.option(symbol="MSFT", tradingClass="MSFT", expiry=self.near), max_size, order_id=4)
        self.assertEqual(len(self.client.placed), 2)
        entries = self.ledger()
        self.assertEqual([(item["key"], item["symbol"]) for item in entries], [("21:1", "AAPL"), ("21:4", "MSFT")])
        self.assertEqual([Decimal(item["max_loss"]) for item in entries], [Decimal(2000), Decimal(2000)])
        # Off again: the ledger is neither read nor written.
        self.place(contract, max_size, order_id=5)
        self.assertEqual(len(self.ledger()), 2)

    def test_off_ignores_open_risk_state_the_switch_would_refuse(self) -> None:
        # A naked short call, a held option without average_cost, a corrupt ledger and a cap
        # without its source each refuse opening orders with the switch on; off is plain v2.
        self.write_snapshot([self.held(-1, 300, cost=200.0), self.held(1, 310)])
        self.write_file(**{OPEN_RISK_KEY: "bad"})
        stored = self.reservations.read_text()
        order_ = v2.order("BUY", Decimal(1), lmtPrice=1.0)
        with self.environ(**{NAME_SHORT_ENV: "1"}):
            self.place(v2.option(expiry=self.near), order_, order_id=1)
            with self.flag(FLAG_ON):
                self.assert_place_refused(v2.option(expiry=self.near), order_, None, "risk_config_source_missing", 2)
        self.assertEqual(len(self.client.placed), 1)
        self.assertEqual(self.reservations.read_text(), stored)

    def test_off_keeps_the_v2_reading_of_order_fields(self) -> None:
        # Review round 2 made three readings stricter, behind the switch only. Off is exactly v2:
        # a whatIf that is no boolean is read by its truth value (a preflight, no reservation), and
        # a number the gate cannot read counts as unset.
        self.write_snapshot([self.held(2, 200, cost=100.0)])
        close = (self.leg(200), v2.order("SELL", 1, whatIf="0"), None)
        buy = (self.leg(300), v2.order("BUY", 1, lmtPrice=1.00, discretionaryAmt=True, cashQty="all"), None)
        self.place(*close, order_id=1)
        self.place(*buy, order_id=2)
        self.assertEqual(len(self.client.placed), 2)
        self.assertFalse(self.reservations.exists())
        with self.flag(FLAG_ON):
            self.assert_place_refused(*close, "what_if_not_boolean", order_id=3)
            self.assert_place_refused(*buy, "discretionary_refused", order_id=4)
            buy[1].discretionaryAmt = 0.0
            self.assert_place_refused(*buy, "cash_quantity_refused", order_id=4)
            # The v2 refusals of readable numbers stay (2147483647 is no unset marker of cashQty).
            buy[1].cashQty = 2147483647
            self.assert_place_refused(*buy, "cash_quantity_refused", order_id=4)
        self.assert_place_refused(*buy, "cash_quantity_refused", order_id=4)
        self.assertEqual(len(self.client.placed), 2)

    def test_off_allows_the_v2_single_leg_sale_beside_a_held_short(self) -> None:
        self.write_snapshot([self.held(2, 120, cost=900.0), self.held(-2, 200, cost=100.0)])
        sale = v2.order("SELL", Decimal(2))
        self.assertEqual(self.check(self.leg(120), sale), "position_close")
        with self.flag(FLAG_ON):
            self.assert_refused(self.leg(120), sale, None, "close_would_uncover_short")
        self.place(self.leg(120), sale)
        self.assertEqual(len(self.client.placed), 1)


# -- 3. accept table ---------------------------------------------------------------

# name, order action, right, (leg action, strike) x 2, lmtPrice, quantity, multiplier, max loss USD.
# Debit spread: net debit x multiplier x quantity. Credit spread: (width - net credit) x multiplier
# x quantity. BUY of a BAG: + is a debit, - a credit; SELL reverses both legs and the sign.
ACCEPT_ROWS: tuple[tuple, ...] = (
    ("bull call debit", "BUY", "C", ("BUY", 200), ("SELL", 205), 1.50, 1, "100", "150"),  # 1.50 x 100
    ("bear put debit", "BUY", "P", ("BUY", 200), ("SELL", 195), 1.50, 1, "100", "150"),
    ("bear call credit", "BUY", "C", ("SELL", 200), ("BUY", 205), -1.50, 1, "100", "350"),  # (5 - 1.50) x 100
    ("bull put credit", "BUY", "P", ("SELL", 200), ("BUY", 195), -1.50, 1, "100", "350"),
    # The same four as a SELL of the reversed BAG.
    ("bull call debit, SELL of the bear call BAG", "SELL", "C", ("SELL", 200), ("BUY", 205), -1.50, 1, "100", "150"),
    ("bear put debit, SELL of the bull put BAG", "SELL", "P", ("SELL", 200), ("BUY", 195), -1.50, 1, "100", "150"),
    ("bear call credit, SELL of the bull call BAG", "SELL", "C", ("BUY", 200), ("SELL", 205), 1.50, 1, "100", "350"),
    ("bull put credit, SELL of the bear put BAG", "SELL", "P", ("BUY", 200), ("SELL", 195), 1.50, 1, "100", "350"),
    # Comboleg order does not matter.
    ("bull call debit, short leg listed first", "BUY", "C", ("SELL", 205), ("BUY", 200), 1.50, 1, "100", "150"),
    ("bull put credit, long leg listed first", "BUY", "P", ("BUY", 195), ("SELL", 200), -1.50, 1, "100", "350"),
    # Several contracts.
    ("debit x 3", "BUY", "C", ("BUY", 200), ("SELL", 205), 1.50, 3, "100", "450"),  # 1.50 x 100 x 3
    ("credit x 3", "BUY", "P", ("SELL", 200), ("BUY", 195), -1.50, 3, "100", "1050"),  # 3.50 x 100 x 3
    ("put debit x 4, width 10", "BUY", "P", ("BUY", 200), ("SELL", 190), 2.25, 4, "100", "900"),  # 2.25 x 400
    ("call credit x 2, width 10", "BUY", "C", ("SELL", 200), ("BUY", 210), -2.25, 2, "100", "1550"),  # 7.75 x 200
    # Rounding.
    ("debit 1.15, width 5 x 3", "BUY", "C", ("BUY", 200), ("SELL", 205), 1.15, 3, "100", "345"),  # 1.15 x 300
    ("credit 1.15, width 5 x 3", "BUY", "C", ("SELL", 200), ("BUY", 205), -1.15, 3, "100", "1155"),  # 3.85 x 300
    ("debit 0.05", "BUY", "C", ("BUY", 200), ("SELL", 205), 0.05, 1, "100", "5"),  # 0.05 x 100
    ("credit 0.05, width 5", "BUY", "P", ("SELL", 200), ("BUY", 195), -0.05, 1, "100", "495"),  # 4.95 x 100
    ("credit 0.35, width 1", "BUY", "C", ("SELL", 200), ("BUY", 201), -0.35, 1, "100", "65"),  # 0.65 x 100
    ("put credit 0.35, width 1 x 7", "BUY", "P", ("SELL", 200), ("BUY", 199), -0.35, 7, "100", "455"),  # 0.65 x 700
    ("debit 4.99, width 5", "BUY", "C", ("BUY", 200), ("SELL", 205), 4.99, 1, "100", "499"),
    ("credit 4.99, width 5", "BUY", "C", ("SELL", 200), ("BUY", 205), -4.99, 1, "100", "1"),  # 0.01 x 100
    ("half-dollar strikes", "BUY", "C", ("BUY", 197.5), ("SELL", 202.5), 2.675, 1, "100", "267.5"),
    ("half-dollar strikes, credit", "BUY", "P", ("SELL", 202.5), ("BUY", 197.5), -2.675, 2, "100", "465"),  # 2.325 x 200
    # Float strikes are read as printed: 1.1 * 3 prints 3.3000000000000003.
    ("float strikes 1.1 * 3 and 5.3", "BUY", "C", ("SELL", 1.1 * 3), ("BUY", 5.3), -0.5, 1, "100",
     "149.99999999999997"),  # width 5.3 - 3.3000000000000003 = 1.9999999999999997; (width - 0.5) x 100
    # Exactly at the 2% cap (2,000 USD).
    ("debit at the cap", "BUY", "C", ("BUY", 200), ("SELL", 205), 4.00, 5, "100", "2000"),  # 4.00 x 500
    ("credit at the cap", "BUY", "C", ("SELL", 200), ("BUY", 225), -5.00, 1, "100", "2000"),  # (25 - 5) x 100
    ("put credit at the cap", "BUY", "P", ("SELL", 200), ("BUY", 190), -6.00, 5, "100", "2000"),  # (10 - 6) x 500
    ("multiplier 1 at the cap", "BUY", "C", ("BUY", 500), ("SELL", 3500), 2000.00, 1, "1", "2000"),
    # Other multipliers.
    ("multiplier 10 debit", "BUY", "C", ("BUY", 200), ("SELL", 205), 1.50, 2, "10", "30"),  # 1.50 x 10 x 2
    ("multiplier 10 credit", "BUY", "C", ("SELL", 200), ("BUY", 205), -1.50, 2, "10", "70"),  # 3.50 x 10 x 2
    ("multiplier 1 debit", "BUY", "P", ("BUY", 200), ("SELL", 195), 0.50, 1, "1", "0.5"),
    ("multiplier 1000 credit", "BUY", "P", ("SELL", 20), ("BUY", 19), -0.25, 2, "1000", "1500"),  # 0.75 x 2000
)

# One cent beyond the cap: refused max_loss_exceeded.
OVER_CAP_ROWS: tuple[tuple, ...] = (
    ("debit one cent over", "BUY", "C", ("BUY", 200), ("SELL", 205), 4.01, 5, "100", "2005"),
    ("credit one cent short", "BUY", "C", ("SELL", 200), ("BUY", 225), -4.99, 1, "100", "2001"),
    ("put credit one cent short", "BUY", "P", ("SELL", 200), ("BUY", 190), -5.99, 5, "100", "2005"),
    ("multiplier 1, one cent of max loss over", "BUY", "C", ("BUY", 500), ("SELL", 3500), 2000.01, 1, "1", "2000.01"),
)


def mirrored(row: tuple) -> tuple:
    """The same position as the opposite order action on the reversed BAG at the opposite price."""

    name, action, right, first, second, limit, quantity, multiplier, expected = row
    flip = {"BUY": "SELL", "SELL": "BUY"}
    return (
        f"{name} (mirrored)",
        flip[action],
        right,
        (flip[first[0]], first[1]),
        (flip[second[0]], second[1]),
        -limit,
        quantity,
        multiplier,
        expected,
    )


class AcceptTableTest(V3TestCase):
    def build(self, row: tuple, **order_extra):
        _, action, right, first, second, limit, quantity, multiplier, _ = row
        legs = [self.leg(strike, right, multiplier=multiplier) for _, strike in (first, second)]
        contract = bag(*(combo_leg(item, side) for item, (side, _) in zip(legs, (first, second))))
        return contract, v2.order(action, quantity, lmtPrice=limit, **order_extra), legs

    def test_accept_table_reports_the_hand_computed_max_loss(self) -> None:
        self.write_snapshot([])
        for base in ACCEPT_ROWS:
            for row in (base, mirrored(base)):
                with self.subTest(row=row[0]):
                    result = self.assert_accepted(*self.build(row), row[-1])
                    self.assertCountEqual(result["notes"], dry_spread_notes())
                    self.assertEqual(result["order_policy"], "options_only_defined_risk_v3")
                    self.assertTrue(result["would_transmit"])
                    self.assertIsNone(result["transmit_refusal"])
        self.assertFalse(self.reservations.exists())  # checks and previews write nothing

    def test_float_limits_give_the_exact_decimal_of_the_printed_float(self) -> None:
        self.write_snapshot([])
        # 2.675 is 2.67499999999999982236431605997495353221893310546875 in binary; it prints 2.675.
        for limit in (2.675, 0.57, 1.005, 4.35, 0.1, 0.3, 1.0001, 4.9999, round(0.1 + 0.2, 2), round(1.1 * 3, 4)):
            with self.subTest(limit=limit):
                printed_limit = Decimal(repr(limit))
                row = ("debit", "BUY", "C", ("BUY", 200), ("SELL", 205), limit, 3, "100", None)
                self.assert_accepted(*self.build(row), printed_limit * 100 * 3)
                row = ("credit", "BUY", "C", ("SELL", 200), ("BUY", 205), -limit, 3, "100", None)
                self.assert_accepted(*self.build(row), (5 - printed_limit) * 100 * 3)
        result = self.preview(*self.build(ACCEPT_ROWS[0][:5] + (1.005, 1, "100", None)))
        self.assertEqual(result["max_loss_usd"], "100.5")
        result = self.preview(*self.build(ACCEPT_ROWS[0][:5] + (1.0001, 3, "100", None)))
        self.assertEqual(result["max_loss_usd"], "300.03")

    def test_a_limit_with_more_than_four_decimals_is_refused(self) -> None:
        self.write_snapshot([])
        # A raw 0.1 + 0.2 prints 0.30000000000000004: no price IBKR would take.
        for limit in (0.1 + 0.2, 1.1 * 3, 0.7 + 0.1, 1.00001, 4.99999, Decimal("1e-9"), "1.23456"):
            with self.subTest(limit=limit):
                row = ("debit", "BUY", "C", ("BUY", 200), ("SELL", 205), limit, 1, "100", None)
                self.assert_refused(*self.build(row), "limit_price_precision_refused")
                credit = -limit if not isinstance(limit, str) else f"-{limit}"
                row = ("credit", "BUY", "C", ("SELL", 200), ("BUY", 205), credit, 1, "100", None)
                self.assert_refused(*self.build(row), "limit_price_precision_refused")

    def test_max_loss_is_printed_as_a_plain_number(self) -> None:
        self.write_snapshot([])
        by_name = {row[0]: row for row in ACCEPT_ROWS}
        for name, text in (
            ("bull call debit", "150"),
            ("debit at the cap", "2000"),  # not 2E+3
            ("credit 1.15, width 5 x 3", "1155"),
            ("multiplier 1 debit", "0.5"),
            ("half-dollar strikes", "267.5"),
        ):
            with self.subTest(row=name):
                self.assertEqual(self.preview(*self.build(by_name[name]))["max_loss_usd"], text)

    def test_one_cent_beyond_the_cap_is_refused(self) -> None:
        self.write_snapshot([])
        for base in OVER_CAP_ROWS:
            for row in (base, mirrored(base)):
                with self.subTest(row=row[0]):
                    result = self.assert_refused(*self.build(row), "max_loss_exceeded")
                    self.assertIn(row[-1], result["policy_refusal_detail"])

    def test_the_cap_follows_net_liquidation(self) -> None:
        row = ("bull call debit x 2", "BUY", "C", ("BUY", 200), ("SELL", 205), 1.50, 2, "100", "300")
        self.write_snapshot([], nlv=15_000)  # 2% = 300 USD
        self.assert_accepted(*self.build(row), 300)
        self.write_snapshot([], nlv="14999.99")
        self.assert_refused(*self.build(row), "max_loss_exceeded")
        self.write_snapshot([], summary={})
        self.assert_refused(*self.build(row), "net_liquidation_unavailable")
        self.write_snapshot([], summary={"NetLiquidation": {"EUR": "100000"}})
        self.assert_refused(*self.build(row), "net_liquidation_unavailable")

    def test_quantity_and_right_spellings(self) -> None:
        self.write_snapshot([])
        base = ("credit x 3", "BUY", "P", ("SELL", 200), ("BUY", 195), -1.50, 3, "100", "1050")
        for quantity in (3, 3.0, Decimal(3), Decimal("3.00"), "3"):
            with self.subTest(quantity=quantity):
                self.assert_accepted(*self.build(base[:6] + (quantity,) + base[7:]), 1050)
        for right in ("CALL", "call", "C"):
            with self.subTest(right=right):
                legs = [self.leg(200, right), self.leg(205, right)]
                self.assert_accepted(*vertical(*legs)[:1], v2.order("BUY", 1, lmtPrice=1.50), legs, 150)
        legs = [self.leg(200, "PUT"), self.leg(195, "P")]
        self.assert_accepted(vertical(*legs)[0], v2.order("BUY", 1, lmtPrice=1.50), legs, 150)

    def test_guaranteed_routing_and_unset_ibapi_fields_are_accepted(self) -> None:
        self.write_snapshot([])
        unset = sys.float_info.max  # ibapi UNSET_DOUBLE
        extras = (
            {"smartComboRoutingParams": [SimpleNamespace(tag="NonGuaranteed", value="0")]},
            {"smartComboRoutingParams": []},
            {"orderComboLegs": []},
            {"discretionaryAmt": 0.0, "cashQty": unset, "hedgeType": "", "algoStrategy": ""},
            {"deltaNeutralOrderType": "", "whatIf": True},
            {"scaleInitLevelSize": 2147483647, "scaleSubsLevelSize": 2147483647, "scalePriceIncrement": unset},
            {"parentId": 0, "ocaGroup": "", "adjustedOrderType": ""},
            {"tif": "DAY", "orderType": "lmt"},
        )
        for extra in extras:
            with self.subTest(extra=sorted(extra)):
                self.assert_accepted(*self.build(ACCEPT_ROWS[0], **extra), 150)

    def test_expiry_today_is_still_open_and_yesterday_has_passed(self) -> None:
        self.write_snapshot([], now=FIXED_NOW)
        for days, code in ((0, None), (1, None), (-1, "expiry_passed"), (-30, "expiry_passed")):
            with self.subTest(days=days):
                expiry = self.exp(days, FIXED_TODAY)
                contract, legs = vertical(leg(200, expiry=expiry), leg(205, expiry=expiry))
                order_ = v2.order("BUY", 1, lmtPrice=1.50)
                if code is None:
                    self.assert_accepted(contract, order_, legs, 150, now=FIXED_NOW)
                else:
                    self.assert_refused(contract, order_, legs, code, now=FIXED_NOW)

    def test_an_accepted_vertical_is_placed_as_one_bag_order(self) -> None:
        self.write_snapshot([])
        contract, order_, legs = self.build(ACCEPT_ROWS[2])  # bear call credit, max loss 350
        self.place(contract, order_, legs, order_id=11)
        self.assertEqual(self.client.placed, [(11, contract, order_)])
        [entry] = self.ledger()
        self.assertEqual(
            {name: entry[name] for name in ("key", "order_id", "client_id", "source", "symbol", "expiry")},
            {"key": "21:11", "order_id": "11", "client_id": "21", "source": SOURCE, "symbol": "AAPL", "expiry": self.near},
        )
        self.assertEqual(Decimal(entry["max_loss"]), Decimal(350))
        # The order buys the 205 call and sells the 200 call.
        self.assertEqual(entry["signature"], f"BUY:{legs[1].conId}|SELL:{legs[0].conId}")
        self.assertIn("credit vertical", entry["description"])
        self.assertEqual(self.stored_reservations(), [])
        self.assertCountEqual([item for _, item in self.client.detail_requests], legs)  # IBKR named both legs


# -- 4. refuse table ---------------------------------------------------------------

# Every refusal code a BAG order's own shape can earn with the switch on (the
# caps, the ledger and the snapshot have their own tests below).
BAG_REFUSAL_CODES = frozenset(
    {
        "action_refused",
        "adjusted_order_refused",
        "algo_order_refused",
        "attached_order_refused",
        "cash_quantity_refused",
        "combo_class_missing",
        "combo_classes_differ",
        "combo_expiries_differ",
        "combo_leg_action_refused",
        "combo_leg_count_refused",
        "combo_leg_mismatch",
        "combo_leg_not_option",
        "combo_leg_prices_refused",
        "combo_legs_unverified",
        "combo_multipliers_differ",
        "combo_non_guaranteed_refused",
        "combo_not_one_long_one_short",
        "combo_quantity_not_whole",
        "combo_ratio_refused",
        "combo_refused",
        "combo_rights_differ",
        "combo_routing_params_refused",
        "combo_strikes_equal",
        "combo_underlyings_differ",
        "contract_incomplete",
        "currency_refused",
        "delta_neutral_refused",
        "discretionary_refused",
        "expiry_passed",
        "hedge_order_refused",
        "limit_price_missing",
        "limit_price_precision_refused",
        "max_loss_exceeded",
        "multiplier_missing",
        "order_type_refused",
        "quantity_missing",
        "scale_order_refused",
        "spread_limit_implausible",
    }
)


# ``place_order`` reads the caller's legs for the shape of the order before it asks IBKR
# for them, so the live path names the same reason as the dry check. Cases where the
# two paths differ go here (case name -> the code of the live path); none today.
LEGS_REFUSED_FIRST: dict[str, str] = {}


class RefuseTableTest(V3TestCase):
    def make(
        self,
        first=("BUY", 200, "C"),
        second=("SELL", 205, "C"),
        *,
        action: str = "BUY",
        limit=1.50,
        quantity=1,
        ratios=(1, 1),
        first_kw: dict | None = None,
        second_kw: dict | None = None,
        bag_kw: dict | None = None,
        **order_extra,
    ):
        """(BAG, order, legs). The defaults are the bull call debit spread the accept table opens with."""

        legs = [
            self.leg(strike, right, **(fields or {}))
            for (_, strike, right), fields in ((first, first_kw), (second, second_kw))
        ]
        combo = [
            combo_leg(item, side, ratio) for item, (side, _, _), ratio in zip(legs, (first, second), ratios)
        ]
        return bag(*combo, **(bag_kw or {})), v2.order(action, quantity, lmtPrice=limit, **order_extra), legs

    def cases(self) -> list[tuple[str, str, tuple]]:
        make = self.make
        later = {"expiry": self.exp(80)}
        yesterday = {"expiry": self.exp(-1)}
        month = {"expiry": self.near[:6]}
        credit = (("SELL", 200, "C"), ("BUY", 205, "C"))
        contract, order_, legs = make()
        third, fourth = self.leg(210), self.leg(215)
        shares = v2.stock(conId=con_id("AAPL", "", "", 0))
        routing = lambda tag, value: [SimpleNamespace(tag=tag, value=value)]  # noqa: E731
        return [
            # The limit does not fit the structure.
            ("spread_limit_implausible", "credit legs with a positive limit", make(*credit, limit=1.50)),
            ("spread_limit_implausible", "debit legs with a negative limit", make(limit=-1.50)),
            (
                "spread_limit_implausible",
                "put credit legs with a positive limit",
                make(("SELL", 200, "P"), ("BUY", 195, "P"), limit=1.50),
            ),
            (
                "spread_limit_implausible",
                "put debit legs with a negative limit",
                make(("BUY", 200, "P"), ("SELL", 195, "P"), limit=-1.50),
            ),
            ("spread_limit_implausible", "SELL of the debit BAG at a negative limit", make(action="SELL", limit=-1.50)),
            (
                "spread_limit_implausible",
                "SELL of the credit BAG at a positive limit",
                make(*credit, action="SELL", limit=1.50),
            ),
            ("spread_limit_implausible", "debit equal to the width", make(limit=5.00)),
            ("spread_limit_implausible", "debit above the width", make(limit=5.01)),
            ("spread_limit_implausible", "credit equal to the width", make(*credit, limit=-5.00)),
            ("spread_limit_implausible", "credit above the width", make(*credit, limit=-7.25)),
            ("spread_limit_implausible", "limit 0", make(limit=0)),
            ("spread_limit_implausible", "limit 0.0 on credit legs", make(*credit, limit=0.0)),
            ("spread_limit_implausible", "limit -0.0", make(*credit, limit=-0.0)),
            # Not a 1:1 vertical.
            ("combo_ratio_refused", "1:2 back spread", make(ratios=(1, 2))),
            ("combo_ratio_refused", "2:1 ratio spread", make(ratios=(2, 1))),
            ("combo_ratio_refused", "2:2", make(ratios=(2, 2))),
            ("combo_ratio_refused", "ratio missing", make(ratios=(1, None))),
            ("combo_ratio_refused", "ratio 0.5", make(ratios=(0.5, 1))),
            (
                "combo_expiries_differ",
                "calendar",
                make(("BUY", 200, "C"), ("SELL", 200, "C"), first_kw=later),
            ),
            ("combo_expiries_differ", "diagonal", make(second_kw=later)),
            ("combo_underlyings_differ", "legs of two underlyings", make(second_kw={"symbol": "MSFT"})),
            ("combo_underlyings_differ", "BAG of another symbol", make(bag_kw={"symbol": "MSFT"})),
            ("combo_rights_differ", "call + put (risk reversal)", make(("BUY", 205, "C"), ("SELL", 195, "P"))),
            ("combo_rights_differ", "call + put (synthetic)", make(("BUY", 200, "C"), ("SELL", 200, "P"))),
            (
                "combo_leg_count_refused",
                "three legs (butterfly)",
                (
                    bag(combo_leg(legs[0], "BUY"), combo_leg(legs[1], "SELL", 2), combo_leg(third, "BUY")),
                    order_,
                    [*legs, third],
                ),
            ),
            (
                "combo_leg_count_refused",
                "four legs (condor)",
                (
                    bag(
                        combo_leg(legs[0], "BUY"),
                        combo_leg(legs[1], "SELL"),
                        combo_leg(third, "SELL"),
                        combo_leg(fourth, "BUY"),
                    ),
                    order_,
                    [*legs, third, fourth],
                ),
            ),
            ("combo_leg_count_refused", "one leg", (bag(combo_leg(legs[0], "BUY")), order_, legs[:1])),
            ("combo_leg_count_refused", "no comboLegs", (bag(), order_, legs)),
            (
                "combo_leg_count_refused",
                "comboLegs is text",
                (SimpleNamespace(**{**vars(contract), "comboLegs": "700001,700002"}), order_, legs),
            ),
            (
                "combo_leg_count_refused",
                "comboLegs is an object",
                (SimpleNamespace(**{**vars(contract), "comboLegs": {"BUY": 700001, "SELL": 700002}}), order_, legs),
            ),
            (
                "combo_not_one_long_one_short",
                "both legs SELL (short strangle)",
                make(("SELL", 205, "C"), ("SELL", 195, "P"), limit=-3.00),
            ),
            (
                "combo_not_one_long_one_short",
                "both legs SELL (two calls)",
                make(("SELL", 200, "C"), ("SELL", 205, "C"), limit=-3.00),
            ),
            (
                "combo_not_one_long_one_short",
                "both legs BUY (long strangle)",
                make(("BUY", 205, "C"), ("BUY", 195, "P"), limit=3.00),
            ),
            ("combo_leg_action_refused", "leg action SSHORT", make(("BUY", 200, "C"), ("SSHORT", 205, "C"))),
            ("combo_leg_action_refused", "leg action missing", make(("", 200, "C"), ("SELL", 205, "C"))),
            # The order.
            ("order_type_refused", "MKT", make(orderType="MKT")),
            ("order_type_refused", "MKT closing-style credit", make(*credit, orderType="MKT", limit=-1.50)),
            ("order_type_refused", "STP LMT", make(orderType="STP LMT")),
            ("order_type_refused", "REL + MKT", make(orderType="REL + MKT")),
            ("order_type_refused", "order type missing", make(orderType="")),
            ("combo_non_guaranteed_refused", "NonGuaranteed=1", make(smartComboRoutingParams=routing("NonGuaranteed", "1"))),
            ("combo_non_guaranteed_refused", "NonGuaranteed empty", make(smartComboRoutingParams=routing("NonGuaranteed", ""))),
            ("combo_routing_params_refused", "LeginPrio", make(smartComboRoutingParams=routing("LeginPrio", "0"))),
            ("combo_routing_params_refused", "routing params that are no list", make(smartComboRoutingParams=5)),
            (
                "combo_leg_prices_refused",
                "per-leg prices",
                make(orderComboLegs=[SimpleNamespace(price=2.00), SimpleNamespace(price=0.50)]),
            ),
            ("limit_price_missing", "no limit", make(limit=None)),
            ("limit_price_missing", "ibapi UNSET_DOUBLE", make(limit=sys.float_info.max)),
            ("limit_price_missing", "text", make(limit="market")),
            ("limit_price_missing", "nan", make(limit=float("nan"))),
            ("limit_price_missing", "infinite", make(limit=float("-inf"))),
            ("limit_price_precision_refused", "a raw 0.1 + 0.2", make(limit=0.1 + 0.2)),
            ("limit_price_precision_refused", "five decimals", make(limit=1.00001)),
            ("limit_price_precision_refused", "1e-9", make(limit=Decimal("1e-9"))),
            ("limit_price_precision_refused", "credit with five decimals", make(*credit, limit=-1.23456)),
            ("combo_quantity_not_whole", "1.5 contracts", make(quantity=1.5)),
            ("combo_quantity_not_whole", "0.5 contracts", make(quantity=Decimal("0.5"))),
            ("quantity_missing", "quantity 0", make(quantity=0)),
            ("quantity_missing", "quantity negative", make(quantity=-1)),
            ("quantity_missing", "quantity missing", make(quantity=None)),
            ("quantity_missing", "ibapi UNSET_DECIMAL", make(quantity=Decimal(2**127 - 1))),
            ("action_refused", "SSHORT", make(action="SSHORT")),
            ("action_refused", "action missing", make(action="")),
            ("discretionary_refused", "discretionary amount", make(discretionaryAmt=0.05)),
            ("cash_quantity_refused", "cashQty", make(cashQty=500.0)),
            # A value the gate cannot read as a number counts as set: ibapi would still send it.
            ("discretionary_refused", "discretionary amount True", make(discretionaryAmt=True)),
            ("discretionary_refused", "discretionary amount NaN", make(discretionaryAmt="NaN")),
            ("discretionary_refused", "discretionary amount infinite", make(discretionaryAmt=float("inf"))),
            ("discretionary_refused", "discretionary amount ibapi UNSET_DOUBLE", make(discretionaryAmt=sys.float_info.max)),
            ("cash_quantity_refused", "cashQty True", make(cashQty=True)),
            ("cash_quantity_refused", "cashQty text", make(cashQty="all")),
            ("cash_quantity_refused", "cashQty negative", make(cashQty=-500.0)),
            ("scale_order_refused", "scaleInitLevelSize True", make(scaleInitLevelSize=True)),
            ("scale_order_refused", "scalePriceIncrement text", make(scalePriceIncrement="Infinity")),
            ("attached_order_refused", "parentId True", make(parentId=True)),
            ("attached_order_refused", "parentId text", make(parentId="twelve")),
            ("hedge_order_refused", "hedge order", make(hedgeType="D")),
            ("algo_order_refused", "algo order", make(algoStrategy="Adaptive")),
            ("scale_order_refused", "scaleInitLevelSize", make(scaleInitLevelSize=5)),
            ("scale_order_refused", "scaleSubsLevelSize", make(scaleSubsLevelSize=1)),
            ("scale_order_refused", "scalePriceIncrement", make(scalePriceIncrement=0.05)),
            ("attached_order_refused", "parentId", make(parentId=12)),
            ("attached_order_refused", "ocaGroup", make(ocaGroup="exit-1")),
            ("adjusted_order_refused", "adjustedOrderType", make(adjustedOrderType="STP")),
            ("delta_neutral_refused", "deltaNeutralOrderType", make(deltaNeutralOrderType="MKT")),
            (
                "delta_neutral_refused",
                "deltaNeutralContract",
                make(bag_kw={"deltaNeutralContract": SimpleNamespace(conId=265598, delta=0.5, price=200.0)}),
            ),
            ("max_loss_exceeded", "2,005 USD", make(limit=4.01, quantity=5)),
            # The leg contracts.
            ("combo_legs_unverified", "no leg contracts", (contract, order_, None)),
            ("combo_leg_mismatch", "empty leg list", (contract, order_, [])),
            ("combo_leg_mismatch", "legs is not a list", (contract, order_, 5)),
            ("combo_leg_mismatch", "one leg contract for two comboLegs", (contract, order_, legs[:1])),
            ("combo_leg_mismatch", "a leg contract of another conId", (contract, order_, [legs[0], third])),
            ("combo_leg_mismatch", "a third leg contract", (contract, order_, [*legs, third])),
            ("combo_leg_mismatch", "the same leg contract twice", (contract, order_, [legs[0], legs[0]])),
            ("combo_leg_mismatch", "a leg contract without conId", (contract, order_, [legs[0], self.leg(205, conId=0)])),
            (
                "combo_leg_mismatch",
                "both comboLegs name one conId",
                (bag(combo_leg(legs[0], "BUY"), combo_leg(legs[0], "SELL")), order_, legs),
            ),
            (
                "combo_leg_mismatch",
                "a comboLeg without conId",
                (bag(combo_leg(legs[0], "BUY"), combo_leg(0, "SELL")), order_, legs),
            ),
            (
                "combo_leg_not_option",
                "a leg is a stock (buy-write)",
                (bag(combo_leg(shares, "BUY"), combo_leg(legs[1], "SELL")), order_, [shares, legs[1]]),
            ),
            ("contract_incomplete", "contract-month expiry", make(first_kw=month, second_kw=month)),
            ("contract_incomplete", "a leg without strike", make(second=("SELL", 0, "C"))),
            ("contract_incomplete", "a leg without right", make(second=("SELL", 205, ""))),
            ("contract_incomplete", "a leg without expiry", make(second_kw={"expiry": ""})),
            ("multiplier_missing", "a leg without multiplier", make(second_kw={"multiplier": ""})),
            ("combo_multipliers_differ", "100 and 10", make(second_kw={"multiplier": "10"})),
            ("combo_class_missing", "a leg without tradingClass", make(second_kw={"tradingClass": ""})),
            ("combo_classes_differ", "an adjusted class", make(second_kw={"tradingClass": "AAPL1"})),
            ("currency_refused", "legs in two currencies", make(second_kw={"currency": "EUR"})),
            ("currency_refused", "BAG in EUR", make(bag_kw={"currency": "EUR"})),
            (
                "currency_refused",
                "everything in EUR",
                make(first_kw={"currency": "EUR"}, second_kw={"currency": "EUR"}, bag_kw={"currency": "EUR"}),
            ),
            (
                "combo_strikes_equal",
                "one strike under two conIds",
                make(second=("SELL", 200, "C"), second_kw={"conId": 999_001}),
            ),
            ("expiry_passed", "expired yesterday", make(first_kw=yesterday, second_kw=yesterday)),
            (
                "combo_refused",
                "an option contract that carries comboLegs",
                (v2.option(expiry=self.near, comboLegs=list(contract.comboLegs)), order_, legs),
            ),
        ]

    def test_refuse_table_names_every_reason(self) -> None:
        self.write_snapshot([])
        cases = self.cases()
        for code, name, (contract, order_, legs) in cases:
            with self.subTest(code=code, case=name):
                self.assert_refused(contract, order_, legs, code)
                self.assert_place_refused(contract, order_, legs, LEGS_REFUSED_FIRST.get(name, code))
        self.assertEqual({code for code, _, _ in cases}, BAG_REFUSAL_CODES)
        self.assertLessEqual(set(LEGS_REFUSED_FIRST), {name for _, name, _ in cases})
        self.assertEqual(self.client.placed, [])
        self.assertFalse(self.reservations.exists())
        refusals = self.audit_events("order_refused")
        self.assertEqual(
            [item["error"] for item in refusals], [LEGS_REFUSED_FIRST.get(name, code) for code, name, _ in cases]
        )
        self.assertEqual({item["source"] for item in refusals}, {SOURCE})

    def test_a_whatif_value_that_is_no_boolean_is_refused(self) -> None:
        # ibapi sends a truthy text such as "0" as a live order. Read as a preflight, it would be placed
        # without its ledger entry (opening order) or its reservation (close).
        self.write_snapshot([self.held(2, 200, cost=100.0)])
        for value in ("0", "false", " ", 1, 0, None):
            with self.subTest(value=value):
                contract, order_, legs = self.make(whatIf=value)
                self.assert_refused(contract, order_, legs, "what_if_not_boolean")
                self.assert_place_refused(contract, order_, legs, "what_if_not_boolean")
                close = v2.order("SELL", 1, lmtPrice=1.00, whatIf=value)
                self.assert_place_refused(self.leg(200), close, None, "what_if_not_boolean")
        self.assertEqual(self.client.placed, [])
        self.assertFalse(self.reservations.exists())

    def test_a_whatif_preflight_is_refused_for_the_same_reason(self) -> None:
        self.write_snapshot([])
        for code, name, (contract, order_, legs) in self.cases():
            if not hasattr(order_, "whatIf"):
                continue
            with self.subTest(code=code, case=name):
                order_.whatIf = True
                self.assert_place_refused(contract, order_, legs, LEGS_REFUSED_FIRST.get(name, code))
        self.assertEqual({item["what_if"] for item in self.audit_events("order_refused")}, {True})

    def test_missing_order_and_contract(self) -> None:
        self.write_snapshot([])
        contract, order_, legs = self.make()
        self.assert_refused(None, order_, legs, "order_missing")
        self.assert_refused(contract, None, legs, "order_missing")

    def test_snapshot_refusals(self) -> None:
        contract, order_, legs = self.make()
        self.assert_refused(contract, order_, legs, "snapshot_unavailable")
        self.write_snapshot([], age=10_000.0)
        self.assert_refused(contract, order_, legs, "snapshot_stale")
        self.write_snapshot([], age=-600.0)
        self.assert_refused(contract, order_, legs, "snapshot_invalid")
        self.write_snapshot([], summary={})
        self.assert_refused(contract, order_, legs, "net_liquidation_unavailable")
        self.write_snapshot([])
        self.assert_accepted(contract, order_, legs, 150)

    def test_a_held_leg_of_an_unproven_class_refuses_the_combo(self) -> None:
        contract, order_, legs = self.make()
        # No class sidecar: the held 200 call cannot be proved to be (or not to be) the order's leg.
        self.write_snapshot([self.held(1, 200, cost=100.0)], classes=False)
        self.assert_refused(contract, order_, legs, "trading_class_unverifiable")
        self.write_snapshot([self.held(1, 205, cost=100.0)], classes=False)
        self.assert_refused(contract, order_, legs, "trading_class_unverifiable")
        # A held option that is no leg of the order: without its class its open risk cannot be measured
        # (an SPXW option would be netted against an SPX option).
        self.write_snapshot([self.held(1, 210, cost=100.0)], classes=False)
        self.assert_refused(contract, order_, legs, "name_open_risk_unavailable")
        self.write_snapshot([self.held(1, 210, symbol="MSFT", cost=100.0)], classes=False)
        self.assert_refused(contract, order_, legs, "total_open_risk_unavailable")
        self.write_snapshot([v2.held_stock(100)], classes=False)  # shares have no open option risk
        self.assert_accepted(contract, order_, legs, 150)


# -- 5. caps and the open-risk ledger -----------------------------------------------


class RiskCapsTest(V3TestCase):
    def test_name_short_dated_cap_counts_a_held_debit_spread(self) -> None:
        # Held: 5 x 200/205 call debit spreads bought at 3.00 - 1.00 = 2.00 -> 5 x 200 = 1,000 USD at risk.
        self.write_snapshot([self.held(5, 200, cost=300.0), self.held(-5, 205, cost=100.0)])
        self.assert_accepted(*self.debit_call(1000), 1000)  # 1,000 + 1,000 = 2,000 = 2% of NLV
        self.assert_refused(*self.debit_call("1000.01"), "name_short_dated_cap_exceeded")
        self.assert_accepted(*self.long_call(1000), 1000, allowance="long_option_open")
        self.assert_refused(*self.long_call("1000.01"), "name_short_dated_cap_exceeded")
        self.assert_accepted(*self.debit_call(2000, symbol="MSFT"), 2000)  # another name
        # Adding to the held spread itself is an opening order under the same cap.
        contract, legs = vertical(self.leg(200), self.leg(205))
        self.assert_accepted(contract, v2.order("BUY", 5, lmtPrice=2.00), legs, 1000)
        self.assert_refused(contract, v2.order("BUY", 5, lmtPrice=2.01), legs, "name_short_dated_cap_exceeded")

    def test_name_short_dated_cap_counts_a_held_credit_spread(self) -> None:
        # Held: 2 x 195/200 bull put credit spreads sold at 1.50 - 0.50 = 1.00 -> (5 - 1) x 100 x 2 = 800 USD.
        self.write_snapshot([self.held(-2, 200, "P", cost=150.0), self.held(2, 195, "P", cost=50.0)])
        self.assert_accepted(*self.debit_call(1200), 1200)
        result = self.assert_refused(*self.debit_call("1200.01"), "name_short_dated_cap_exceeded")
        self.assertIn("2000.01", result["policy_refusal_detail"])
        self.assertIn("name_short_dated", result["policy_refusal_detail"])

    def test_held_options_of_each_expiry_are_summed(self) -> None:
        other = self.exp(80)
        # 45 days: long 300 call for 400. 80 days: 310/320 call debit spread for 2 x (350 - 150) = 400.
        self.write_snapshot(
            [
                self.held(1, 300, cost=400.0),
                self.held(2, 310, expiry=other, cost=350.0),
                self.held(-2, 320, expiry=other, cost=150.0),
                v2.held_stock(5000),  # shares are not counted
            ]
        )
        self.assert_accepted(*self.debit_call(1200), 1200)
        self.assert_refused(*self.debit_call("1200.01"), "name_short_dated_cap_exceeded")

    def test_a_held_short_put_counts_strike_minus_credit(self) -> None:
        # Held: 1 short 20 put sold for 1.50 -> 20 x 100 - 150 = 1,850 USD.
        self.write_snapshot([self.held(-1, 20, "P", cost=150.0)])
        self.assert_accepted(*self.debit_call(150), 150)
        self.assert_refused(*self.debit_call("150.01"), "name_short_dated_cap_exceeded")

    def test_leaps_orders_fill_a_name_to_six_percent_two_percent_at_a_time(self) -> None:
        leaps = self.leaps
        self.write_snapshot([])
        self.assert_accepted(*self.debit_call(2000, expiry=leaps), 2000)
        self.assert_refused(*self.debit_call("2000.01", expiry=leaps), "max_loss_exceeded")
        # Held: 4 LEAPS calls at 10.00 -> 4,000 USD = 4% of NLV, twice the short-dated cap.
        self.write_snapshot([self.held(4, 300, expiry=leaps, cost=1000.0)])
        self.assert_accepted(*self.debit_call(2000, expiry=leaps), 2000)  # 6,000 = 6%
        self.assert_accepted(*self.long_call(2000, expiry=leaps), 2000, allowance="long_option_open")
        self.assert_refused(*self.debit_call("2000.01", expiry=leaps), "max_loss_exceeded")
        self.write_snapshot([self.held(4, 300, expiry=leaps, cost=1000.25)])  # 4,001 USD
        self.assert_refused(*self.debit_call(2000, expiry=leaps), "name_risk_cap_exceeded")
        self.assert_accepted(*self.debit_call(1999, expiry=leaps), 1999)

    def test_three_working_leaps_orders_fill_the_name(self) -> None:
        self.write_snapshot([])
        for order_id in (1, 2, 3):
            self.place(*self.debit_call(2000, expiry=self.leaps, low=100 + 10 * order_id), order_id=order_id)
        self.assertEqual(len(self.ledger()), 3)
        self.assert_place_refused(*self.debit_call(5, expiry=self.leaps), "name_risk_cap_exceeded", order_id=4)
        self.assert_place_refused(*self.debit_call(5), "name_risk_cap_exceeded", order_id=4)
        self.assert_place_refused(*self.long_call(5), "name_risk_cap_exceeded", order_id=4)
        self.place(*self.debit_call(2000, symbol="MSFT"), order_id=4)  # 8,000 of the 10,000 total
        self.assertEqual(len(self.client.placed), 4)

    def test_a_short_dated_order_is_refused_when_the_name_holds_six_percent_in_leaps(self) -> None:
        self.write_snapshot([self.held(6, 300, expiry=self.leaps, cost=1000.0)])  # 6,000 USD
        self.assert_refused(*self.debit_call(5), "name_risk_cap_exceeded")
        self.assert_refused(*self.long_call(5), "name_risk_cap_exceeded")
        self.assert_accepted(*self.debit_call(2000, symbol="MSFT"), 2000)
        self.write_snapshot([self.held(4, 300, expiry=self.leaps, cost=1000.0)])  # 4,000 USD
        self.assert_accepted(*self.debit_call(2000), 2000)  # short-dated 2% and all expiries 6%
        self.write_snapshot([self.held(4, 300, expiry=self.leaps, cost=1000.0), self.held(1, 310, cost=500.0)])
        self.assert_accepted(*self.debit_call(1500), 1500)
        self.assert_refused(*self.debit_call("1500.01"), "name_short_dated_cap_exceeded")
        self.write_snapshot([self.held(5, 300, expiry=self.leaps, cost=1000.0), self.held(1, 310, cost=500.0)])
        self.assert_accepted(*self.debit_call(500), 500)  # 5,000 + 500 + 500 = 6,000
        self.assert_refused(*self.debit_call("500.01"), "name_risk_cap_exceeded")

    def test_a_leaps_order_counts_the_short_dated_risk_of_the_name(self) -> None:
        # Held: 2,000 USD short-dated and 2,000 USD LEAPS.
        self.write_snapshot([self.held(4, 300, cost=500.0), self.held(2, 300, expiry=self.leaps, cost=1000.0)])
        self.assert_refused(*self.debit_call(5), "name_short_dated_cap_exceeded")
        self.assert_accepted(*self.debit_call(2000, expiry=self.leaps), 2000)  # 6,000 over all expiries
        self.write_snapshot([self.held(4, 300, cost=500.0), self.held(2, 300, expiry=self.leaps, cost=1000.5)])
        self.assert_refused(*self.debit_call(2000, expiry=self.leaps), "name_risk_cap_exceeded")

    def test_an_expiry_365_days_out_is_a_leaps(self) -> None:
        now, today = FIXED_NOW, FIXED_TODAY
        month, day_364, day_365 = self.exp(30, today), self.exp(364, today), self.exp(365, today)
        self.write_snapshot([self.held(4, 300, expiry=month, cost=500.0)], now=now)  # 2,000 USD short-dated
        self.assert_refused(*self.debit_call(5, expiry=day_364), "name_short_dated_cap_exceeded", now=now)
        self.assert_accepted(*self.debit_call(5, expiry=day_365), 5, now=now)
        # The same boundary for what is held.
        self.write_snapshot([self.held(2, 300, expiry=day_365, cost=1000.0)], now=now)
        self.assert_accepted(*self.debit_call(2000, expiry=month), 2000, now=now)
        self.write_snapshot([self.held(2, 300, expiry=day_364, cost=1000.0)], now=now)
        self.assert_refused(*self.debit_call(5, expiry=month), "name_short_dated_cap_exceeded", now=now)
        # And for a working order in the ledger.
        self.write_snapshot([], now=now)
        self.write_ledger(ledger_entry(900, "AAPL", day_365, 2000))
        self.assert_accepted(*self.debit_call(2000, expiry=month), 2000, now=now)
        self.write_ledger(ledger_entry(900, "AAPL", day_364, 2000))
        self.assert_refused(*self.debit_call(5, expiry=month), "name_short_dated_cap_exceeded", now=now)

    def test_total_cap_counts_every_name(self) -> None:
        book = [self.held(4, 50, symbol=name, cost=500.0) for name in ("AMD", "IBM", "KO", "PEP", "XOM")]
        self.write_snapshot([*book[:4], v2.held_stock(5000)])  # 4 x 2,000 USD in options
        self.assert_accepted(*self.debit_call(2000), 2000)  # 10,000 = 10% of NLV
        self.assert_accepted(*self.long_call(2000, expiry=self.leaps), 2000, allowance="long_option_open")
        self.write_snapshot(book)  # 10,000 USD
        result = self.assert_refused(*self.debit_call(5), "total_risk_cap_exceeded")
        self.assertIn("10005", result["policy_refusal_detail"])
        self.assert_refused(*self.long_call(5, symbol="MSFT", expiry=self.leaps), "total_risk_cap_exceeded")
        self.write_snapshot([*book[:4], self.held(1, 50, symbol="XOM", cost=0.01)])  # 8,000.01 USD
        self.assert_refused(*self.debit_call(2000), "total_risk_cap_exceeded")
        self.assert_accepted(*self.debit_call("1999.99"), "1999.99")

    def test_no_cap_comparison_rounds_the_risk_or_the_cap(self) -> None:
        # A loss a fraction of a cent over a cap is over the cap: nothing is rounded before the comparison.
        self.write_snapshot([])  # NLV 100,000: 2,000 USD per order
        # A limit has at most 4 decimals, so only a multiplier of 1 can put an order under a cent over its cap.
        small = {"expiry": self.near, "multiplier": "1"}
        contract, legs = vertical(leg(1000, "C", **small), leg(4000, "C", **small))
        self.assert_accepted(contract, v2.order("BUY", 1, lmtPrice=2000.0), legs, 2000)
        self.assert_refused(contract, v2.order("BUY", 1, lmtPrice=2000.0049), legs, "max_loss_exceeded")
        self.write_snapshot([self.held(5, 200, cost=200.0)])  # 1,000 USD held in AAPL
        self.assert_accepted(contract, v2.order("BUY", 1, lmtPrice=1000.0), legs, 1000)
        self.assert_refused(contract, v2.order("BUY", 1, lmtPrice=1000.0049), legs, "name_short_dated_cap_exceeded")
        book = [self.held(4, 50, symbol=name, cost=500.0) for name in ("AMD", "IBM", "KO", "PEP")]
        self.write_snapshot(book)  # 8,000 USD in four other names: 2,000 USD left under the 10% total cap
        self.assert_accepted(*self.debit_call(2000), 2000)
        self.write_snapshot([*book, self.held(1, 50, symbol="XOM", cost=0.004)])
        self.assert_refused(*self.debit_call(2000), "total_risk_cap_exceeded")
        # A cap that is not a whole dollar stays exact: NLV 100,000.40 -> 2,000.008 per name, 10,000.04 in total.
        self.write_snapshot([self.held(5, 200, cost=200.0)], nlv="100000.40")
        self.assert_accepted(contract, v2.order("BUY", 1, lmtPrice=1000.008), legs, "1000.008")
        self.assert_refused(contract, v2.order("BUY", 1, lmtPrice=1000.0081), legs, "name_short_dated_cap_exceeded")
        self.write_snapshot([*book, self.held(1, 50, symbol="XOM", cost=0.04)], nlv="100000.40")
        self.assert_accepted(contract, v2.order("BUY", 1, lmtPrice=2000.0), legs, 2000)  # 8,000.04 + 2,000
        self.assert_refused(contract, v2.order("BUY", 1, lmtPrice=2000.0001), legs, "total_risk_cap_exceeded")

    def test_total_cap_counts_working_orders_of_other_names(self) -> None:
        self.write_snapshot([])
        self.write_ledger(*(ledger_entry(900 + n, name, self.near, 2000) for n, name in enumerate(("AMD", "IBM", "KO", "PEP"))))
        self.assert_accepted(*self.debit_call(2000), 2000)
        self.write_ledger(
            *(ledger_entry(900 + n, name, self.near, 2000) for n, name in enumerate(("AMD", "IBM", "KO", "PEP"))),
            ledger_entry(950, "XOM", self.leaps, "0.01"),
        )
        self.assert_refused(*self.debit_call(2000), "total_risk_cap_exceeded")

    def test_caps_from_the_environment_need_a_source_and_stay_under_their_ceiling(self) -> None:
        self.write_snapshot([])
        order_ = self.debit_call(1000)
        for env, code in (
            ({NAME_SHORT_ENV: "1"}, "risk_config_source_missing"),
            ({TOTAL_ENV: "5"}, "risk_config_source_missing"),
            ({v2.MAX_LOSS_ENV: "1"}, "risk_config_source_missing"),
            ({NAME_SHORT_ENV: "2.01", f"{NAME_SHORT_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
            ({NAME_LEAPS_ENV: "7", f"{NAME_LEAPS_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
            ({TOTAL_ENV: "100.5", f"{TOTAL_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
            ({v2.MAX_LOSS_ENV: "3", f"{v2.MAX_LOSS_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
            ({TOTAL_ENV: "zero", f"{TOTAL_ENV}_SOURCE": "owner"}, "risk_config_invalid"),
        ):
            with self.subTest(env=env), self.environ(**env):
                self.assert_refused(*order_, code)
                self.assert_place_refused(*order_, code)
        self.assertEqual(self.client.placed, [])

    def test_lower_caps_from_the_environment_apply(self) -> None:
        source = "owner 2026-11-11: tighter caps"
        self.write_snapshot([])
        with self.environ(**{v2.MAX_LOSS_ENV: "1", f"{v2.MAX_LOSS_ENV}_SOURCE": source}):
            self.assert_accepted(*self.debit_call(1000), 1000)
            self.assert_refused(*self.debit_call("1000.01"), "max_loss_exceeded")
        self.write_snapshot([self.held(1, 300, cost=600.0)])
        with self.environ(**{NAME_SHORT_ENV: "1.5", f"{NAME_SHORT_ENV}_SOURCE": source}):
            self.assert_accepted(*self.debit_call(900), 900)
            self.assert_refused(*self.debit_call("900.01"), "name_short_dated_cap_exceeded")
        self.write_snapshot([self.held(2, 300, expiry=self.leaps, cost=1000.0)])
        with self.environ(**{NAME_LEAPS_ENV: "3", f"{NAME_LEAPS_ENV}_SOURCE": source}):
            self.assert_accepted(*self.debit_call(1000), 1000)
            self.assert_refused(*self.debit_call("1000.01"), "name_risk_cap_exceeded")
        self.write_snapshot([self.held(4, 50, symbol="KO", cost=500.0)])
        with self.environ(**{TOTAL_ENV: "3", f"{TOTAL_ENV}_SOURCE": source}):
            self.assert_accepted(*self.debit_call(1000), 1000)
            self.assert_refused(*self.debit_call("1000.01"), "total_risk_cap_exceeded")
        # The total default has no owner rule behind it, so it may be raised (to at most 100%).
        book = [self.held(4, 50, symbol=name, cost=500.0) for name in ("AMD", "IBM", "KO", "PEP", "XOM")]
        self.write_snapshot(book)
        self.assert_refused(*self.debit_call(2000), "total_risk_cap_exceeded")
        with self.environ(**{TOTAL_ENV: "12", f"{TOTAL_ENV}_SOURCE": source}):
            self.assert_accepted(*self.debit_call(2000), 2000)

    # -- working opening orders -------------------------------------------------

    def test_working_opening_orders_count_against_the_name(self) -> None:
        self.write_snapshot([])
        first = self.debit_call(1200)
        self.place(*first, order_id=1)
        [entry] = self.ledger()
        self.assertEqual(
            {name: entry[name] for name in ("key", "order_id", "client_id", "source", "symbol", "expiry")},
            {"key": "21:1", "order_id": "1", "client_id": "21", "source": SOURCE, "symbol": "AAPL", "expiry": self.near},
        )
        self.assertEqual(Decimal(entry["max_loss"]), Decimal(1200))
        self.assertEqual(entry["signature"], f"BUY:{first[2][0].conId}|SELL:{first[2][1].conId}")
        self.assertIn("debit vertical", entry["description"])
        self.assertAlmostEqual(entry["placed_at"], time.time(), delta=30)
        self.assert_accepted(*self.debit_call(800, low=110), 800, order_id=2)  # 1,200 + 800 = 2,000
        self.assert_refused(*self.debit_call("800.01", low=110), "name_short_dated_cap_exceeded", order_id=2)
        self.assert_refused(*self.long_call("800.01"), "name_short_dated_cap_exceeded", order_id=2)
        self.assert_accepted(*self.debit_call(2000, symbol="MSFT"), 2000, order_id=2)
        self.place(*self.debit_call(800, low=110), order_id=2)
        self.assertEqual([item["key"] for item in self.ledger()], ["21:1", "21:2"])
        self.assert_place_refused(*self.debit_call(5, low=120), "name_short_dated_cap_exceeded", order_id=3)
        self.assert_place_refused(
            *self.debit_call(5, low=120, whatIf=True), "name_short_dated_cap_exceeded", order_id=3
        )
        self.assertEqual(len(self.client.placed), 2)
        self.assertEqual(
            [item["error"] for item in self.audit_events("order_refused")],
            ["name_short_dated_cap_exceeded", "name_short_dated_cap_exceeded"],
        )

    def test_working_orders_and_held_options_add_up(self) -> None:
        self.write_snapshot([self.held(1, 300, cost=700.0)])
        self.place(*self.debit_call(600), order_id=1)
        self.assert_accepted(*self.debit_call(700, low=110), 700, order_id=2)
        self.assert_refused(*self.debit_call("700.01", low=110), "name_short_dated_cap_exceeded", order_id=2)

    def test_orders_of_another_client_count_too(self) -> None:
        self.write_snapshot([])
        other = QualifyingClient(client_id=22)
        self.place(*self.debit_call(1500), order_id=7, client=other)
        self.assertEqual([item["key"] for item in self.ledger()], ["22:7"])
        self.assert_accepted(*self.debit_call(500, low=110), 500, order_id=7)  # 21:7 is another order
        self.assert_refused(*self.debit_call("500.01", low=110), "name_short_dated_cap_exceeded", order_id=7)

    def test_whatif_is_checked_the_same_way_and_writes_no_ledger_entry(self) -> None:
        self.write_snapshot([])
        self.place(*self.debit_call(2000, whatIf=True), order_id=1)
        self.place(*self.long_call(2000, whatIf=True), order_id=2)  # the first reserved nothing
        self.assertEqual(len(self.client.placed), 2)
        self.assertIsNone(self.ledger())
        self.assert_place_refused(*self.debit_call("2000.01", whatIf=True), "max_loss_exceeded", order_id=3)
        self.place(*self.debit_call(2000), order_id=4)
        self.assert_place_refused(*self.debit_call(5, low=110, whatIf=True), "name_short_dated_cap_exceeded", order_id=5)
        self.place(*self.debit_call(5, symbol="MSFT", whatIf=True), order_id=5)
        self.assertEqual([item["key"] for item in self.ledger()], ["21:4"])
        self.assertEqual(self.stored_reservations(), [])

    def test_final_status_and_a_later_snapshot_end_the_ledger_entry(self) -> None:
        self.write_snapshot([])
        self.place(*self.debit_call(2000), order_id=1)
        second = self.debit_call(700, low=110)
        self.assert_place_refused(*second, "name_short_dated_cap_exceeded", order_id=2)
        self.client.orderStatus(1, "Cancelled", Decimal(0), Decimal(1))
        # The snapshot on disk is older than the status: it may miss fills.
        self.assert_place_refused(*second, "name_short_dated_cap_exceeded", order_id=2)
        self.write_snapshot([], age=-5.0, stamp="20261104T120100Z")  # inside the settle window
        self.assert_place_refused(*second, "name_short_dated_cap_exceeded", order_id=2)
        self.later_snapshot([])
        self.place(*second, order_id=2)
        self.assertEqual([item["key"] for item in self.ledger()], ["21:2"])
        self.assertEqual(len(self.client.placed), 2)

    def test_a_status_that_is_not_final_keeps_the_ledger_entry(self) -> None:
        for status, filled in (
            ("Submitted", Decimal(0)),
            ("PreSubmitted", Decimal(0)),
            ("Inactive", Decimal(0)),
            ("PendingCancel", Decimal(0)),
            ("Cancelled", None),  # final, but the fill is unknown
        ):
            with self.subTest(status=status):
                arm_gate._order_outcomes.clear()
                self.reservations.unlink(missing_ok=True)
                self.write_snapshot([])
                self.place(*self.debit_call(2000), order_id=1)
                self.client.orderStatus(1, status, filled, Decimal(1))
                self.later_snapshot([])
                self.assert_refused(*self.debit_call(5, low=110), "name_short_dated_cap_exceeded", order_id=2)
                (self.reports / "ibkr-account-snapshot-20261104T120300Z.json").unlink()

    def test_a_filled_order_moves_from_the_ledger_to_the_held_book(self) -> None:
        self.write_snapshot([])
        contract, order_, _ = self.long_call(1000, strike=300, quantity=4)  # 4 x 2.50 x 100
        self.place(contract, order_, order_id=1)
        self.client.orderStatus(1, "Filled", Decimal(4), Decimal(0))
        self.later_snapshot([self.held(4, 300, cost=250.0)])
        # Counted once (held), not twice (held + ledger): 1,000 + 1,000 = 2,000.
        self.assert_accepted(*self.debit_call(1000), 1000, order_id=2)
        self.assert_refused(*self.debit_call("1000.01"), "name_short_dated_cap_exceeded", order_id=2)
        self.place(*self.debit_call(1000), order_id=2)
        self.assertEqual([item["key"] for item in self.ledger()], ["21:2"])

    def test_a_status_of_another_clients_order_ends_nothing(self) -> None:
        self.write_snapshot([])
        self.place(*self.debit_call(2000), order_id=1)
        # IBKR names client 22 as the one that placed this order 1 (orderStatus argument 9).
        self.client.orderStatus(1, "Cancelled", Decimal(0), Decimal(1), 0.0, 5, 0, 0.0, 22, "", 0.0)
        self.later_snapshot([])
        self.assert_refused(*self.debit_call(5, low=110), "name_short_dated_cap_exceeded", order_id=2)

    def test_a_ledger_entry_ends_once_its_expiry_has_passed(self) -> None:
        self.write_snapshot([])
        for days, counted in ((45, True), (0, True), (-2, False), (-30, False)):
            with self.subTest(days=days):
                self.write_ledger(ledger_entry(900, "AAPL", self.exp(days), 2000))
                if counted:
                    self.assert_refused(*self.debit_call(5), "name_short_dated_cap_exceeded")
                else:
                    self.assert_accepted(*self.debit_call(2000), 2000)
        # The next placement drops the ended entry from the file and keeps the others.
        self.write_ledger(ledger_entry(900, "AAPL", self.exp(-30), 2000), ledger_entry(901, "MSFT", self.near, 700))
        self.place(*self.debit_call(2000), order_id=1)
        self.assertEqual(sorted(item["key"] for item in self.ledger()), ["21:1", "21:901"])

    def test_a_modify_under_the_same_order_id_keeps_the_larger_max_loss(self) -> None:
        self.write_snapshot([])
        other = lambda loss: self.debit_call(loss, low=110)  # noqa: E731
        self.place(*self.debit_call(1200), order_id=7)
        # Modify down: the decision reports the new max loss, the ledger keeps the old one
        # (IBKR may refuse the modify and leave the old order working).
        self.assert_accepted(*self.debit_call(800), 800, order_id=7)
        self.place(*self.debit_call(800), order_id=7)
        [entry] = self.ledger()
        self.assertEqual((entry["key"], Decimal(entry["max_loss"])), ("21:7", Decimal(1200)))
        self.assert_accepted(*other(800), 800, order_id=8)
        self.assert_refused(*other("800.01"), "name_short_dated_cap_exceeded", order_id=8)
        # Modify up.
        self.place(*self.debit_call(1500), order_id=7)
        [entry] = self.ledger()
        self.assertEqual(Decimal(entry["max_loss"]), Decimal(1500))
        self.assert_accepted(*other(500), 500, order_id=8)
        self.assert_refused(*other("500.01"), "name_short_dated_cap_exceeded", order_id=8)
        self.assert_place_refused(*self.debit_call("2000.01"), "max_loss_exceeded", order_id=7)
        # Its own entry is not counted beside it: 2,000 fits although 1,500 is in the ledger.
        self.place(*self.debit_call(2000), order_id=7)
        [entry] = self.ledger()
        self.assertEqual(Decimal(entry["max_loss"]), Decimal(2000))
        self.assertEqual(len(self.client.placed), 4)
        self.assert_refused(*other(5), "name_short_dated_cap_exceeded", order_id=8)

    def test_a_modify_is_checked_against_the_other_working_orders(self) -> None:
        self.write_snapshot([])
        self.place(*self.debit_call(1200), order_id=7)
        self.place(*self.debit_call(800, low=110), order_id=8)
        self.assert_place_refused(*self.debit_call("1200.01"), "name_short_dated_cap_exceeded", order_id=7)
        self.place(*self.debit_call(900), order_id=7)
        self.assertEqual(
            {item["key"]: Decimal(item["max_loss"]) for item in self.ledger()},
            {"21:7": Decimal(1200), "21:8": Decimal(800)},
        )

    def test_an_order_id_cannot_move_to_other_contracts(self) -> None:
        self.write_snapshot([self.held(3, 300, cost=100.0)])
        contract, order_, legs = self.debit_call(500)
        self.place(contract, order_, legs, order_id=7)
        self.assert_place_refused(*self.debit_call(500, low=110), "order_id_reused", order_id=7)
        # The same two contracts the other way round: buy the 150 call, sell the 100 call for 45.00.
        turned = bag(combo_leg(legs[0], "SELL"), combo_leg(legs[1], "BUY"))
        self.assert_place_refused(turned, v2.order("BUY", 1, lmtPrice=-45.0), legs, "order_id_reused", order_id=7)
        self.assert_place_refused(*self.long_call(100), "order_id_reused", order_id=7)
        self.assert_place_refused(legs[0], v2.order("BUY", 1, lmtPrice=1.0), None, "order_id_reused", order_id=7)
        # Order 7 of another client is another order.
        self.place(*self.debit_call(500, low=110), order_id=7, client=QualifyingClient(client_id=22))
        self.assertEqual([item["key"] for item in self.ledger()], ["21:7", "22:7"])

    def test_an_opening_order_cannot_take_the_id_of_an_unresolved_close(self) -> None:
        self.write_snapshot([self.held(3, 300, cost=100.0)])
        self.place(self.leg(300), v2.order("SELL", 1), order_id=9)
        self.assertEqual([item["key"] for item in self.stored_reservations()], ["21:9"])
        self.assert_place_refused(*self.debit_call(5, symbol="MSFT"), "order_id_reused", order_id=9)
        self.assert_place_refused(*self.long_call(5, symbol="MSFT"), "order_id_reused", order_id=9)
        self.place(*self.debit_call(5, symbol="MSFT"), order_id=10)

    def test_a_single_leg_close_cannot_take_the_id_of_a_working_opening_order(self) -> None:
        # Held: 3 long AAPL calls and a short KO put (bounded: 20 x 100 - 150 = 1,850 USD).
        self.write_snapshot([self.held(3, 300, cost=100.0), self.held(-1, 20, "P", symbol="KO", cost=150.0)])
        sale = (self.leg(300), v2.order("SELL", 1), None)
        cover = (self.leg(20, "P", symbol="KO"), v2.order("BUY", 1), None)
        self.place(*self.debit_call(5, symbol="MSFT"), order_id=9)
        self.assert_place_refused(*sale, "order_id_reused", order_id=9)
        self.assert_place_refused(*cover, "order_id_reused", order_id=9)
        self.assertEqual(self.stored_reservations(), [])
        # A ledger fault never blocks a close that buys a short back. The sale of a long option needs
        # the working opening spreads: it is refused until the ledger is repaired.
        text = self.reservations.read_text()
        self.write_file(**{OPEN_RISK_KEY: "bad"})
        self.assert_accepted(*cover, None, allowance="position_close", order_id=9)
        self.assert_refused(*sale, "close_risk_unavailable", order_id=9)
        self.reservations.write_text(text)
        self.place(*sale, order_id=10)
        self.place(*cover, order_id=11)
        self.assertEqual(len(self.client.placed), 3)

    def test_release_open_risk_is_audited_and_frees_the_capacity(self) -> None:
        self.write_snapshot([])
        self.place(*self.debit_call(2000), order_id=1)
        second = self.debit_call(700, low=110)
        self.assert_place_refused(*second, "name_short_dated_cap_exceeded", order_id=2)
        reason = "checked TWS: order 1 no longer works"
        code, payload = self.run_tool(
            "release-open-risk", "--key", "21:1", "--by", "owner", "--reason", reason, "--json"
        )
        self.assertEqual((code, payload), (0, {"released": True, "key": "21:1", "remaining": 0}))
        [event] = self.audit_events("open_risk_released")
        self.assertEqual(
            (event["actor"], event["reason"], event["key"], event["symbol"], event["policy"]),
            ("owner", reason, "21:1", "AAPL", "options_only_defined_risk_v3"),
        )
        self.assertEqual(Decimal(event["max_loss"]), Decimal(2000))
        self.assertTrue(event["audit_id"])
        self.assertEqual(self.ledger(), [])
        self.place(*second, order_id=2)
        self.assertEqual(len(self.client.placed), 2)

    def test_release_open_risk_refusals_change_nothing(self) -> None:
        self.write_snapshot([])
        self.place(*self.debit_call(2000), order_id=1)
        self.place(*self.debit_call(300, symbol="MSFT"), order_id=2)
        before = self.reservations.read_text()
        for args, error in (
            (("--key", "21:9", "--by", "owner", "--reason", "checked TWS first"), "unknown_open_risk"),
            (("--key", "22:1", "--by", "owner", "--reason", "checked TWS first"), "unknown_open_risk"),
            (("--key", "21:1", "--by", "bad actor!", "--reason", "checked TWS first"), "invalid_actor"),
            (("--key", "21:1", "--by", "owner", "--reason", "short"), "invalid_reason"),
            (("--key", "21:1", "--by", "owner", "--reason", "x" * 281), "invalid_reason"),
        ):
            with self.subTest(error=error, args=args[:4]):
                code, payload = self.run_tool("release-open-risk", *args)
                self.assertEqual((code, payload["error"]), (2, error))
        self.assertEqual(self.reservations.read_text(), before)
        self.assertEqual(self.audit_events("open_risk_released"), [])
        code, payload = self.run_tool(
            "release-open-risk", "--key", "21:1", "--by", "owner", "--reason", "checked TWS first"
        )
        self.assertEqual((code, payload["remaining"]), (0, 1))
        self.assertEqual([item["key"] for item in self.ledger()], ["21:2"])
        self.reservations.write_text("{bad")
        code, payload = self.run_tool(
            "release-open-risk", "--key", "21:2", "--by", "owner", "--reason", "checked TWS first"
        )
        self.assertEqual((code, payload["error"]), (2, "open_risk_ledger_invalid"))
        self.assertEqual(len(self.audit_events("open_risk_released")), 1)

    # -- open risk that cannot be bounded or measured -----------------------------

    def test_a_naked_short_call_refuses_opening_orders(self) -> None:
        self.write_snapshot([self.held(-1, 300, cost=200.0)])
        self.assert_refused(*self.debit_call(5), "name_open_risk_undefined")
        self.assert_refused(*self.long_call(5), "name_open_risk_undefined")
        self.assert_refused(*self.debit_call(5, expiry=self.leaps), "name_open_risk_undefined")
        self.assert_refused(*self.debit_call(5, symbol="MSFT"), "total_open_risk_undefined")
        self.assert_refused(*self.long_call(5, symbol="MSFT"), "total_open_risk_undefined")
        self.assert_place_refused(*self.debit_call(5), "name_open_risk_undefined")
        # Buying it back is a close and stays allowed.
        self.assertEqual(self.check(self.leg(300), v2.order("BUY", 1)), "position_close")

    def test_only_a_long_call_of_the_same_expiry_bounds_a_short_call(self) -> None:
        self.write_snapshot([self.held(-1, 300, cost=200.0), self.held(1, 290, expiry=self.leaps, cost=900.0)])
        self.assert_refused(*self.debit_call(5), "name_open_risk_undefined")
        self.write_snapshot([self.held(-1, 300, cost=200.0), self.held(5, 290, "P", cost=10.0)])
        self.assert_refused(*self.debit_call(5), "name_open_risk_undefined")
        self.write_snapshot([self.held(-2, 300, cost=200.0), self.held(1, 310, cost=120.0)])
        self.assert_refused(*self.debit_call(5), "name_open_risk_undefined")
        # 300/310 bear call credit spread: (10 x 100) - (200 - 120) = 920 USD.
        self.write_snapshot([self.held(-1, 300, cost=200.0), self.held(1, 310, cost=120.0)])
        self.assert_accepted(*self.debit_call(1080), 1080)
        self.assert_refused(*self.debit_call("1080.01"), "name_short_dated_cap_exceeded")

    def test_another_trading_class_does_not_cover_a_short_call(self) -> None:
        # A long SPXW call beside a short SPX call of the same expiry: they settle differently.
        short = self.held(-1, 300, symbol="SPX", cost=200.0)
        self.write_snapshot([short, self.held(1, 310, symbol="SPX", trading_class="SPXW", cost=120.0)])
        self.assert_refused(*self.debit_call(5, symbol="SPX"), "name_open_risk_undefined")
        self.assert_refused(*self.long_call(5, symbol="SPX"), "name_open_risk_undefined")
        self.assert_refused(*self.debit_call(5, symbol="MSFT"), "total_open_risk_undefined")
        # The same class covers it: a 300/310 bear call credit spread, (10 x 100) - (200 - 120) = 920 USD.
        self.write_snapshot([short, self.held(1, 310, symbol="SPX", cost=120.0)])
        self.assert_accepted(*self.debit_call(1080, symbol="SPX"), 1080)
        self.assert_refused(*self.debit_call("1080.01", symbol="SPX"), "name_short_dated_cap_exceeded")

    def test_a_naked_short_leaps_call_refuses_short_dated_orders_in_the_name(self) -> None:
        self.write_snapshot([self.held(-1, 300, expiry=self.leaps, cost=2000.0)])
        self.assert_refused(*self.debit_call(5), "name_open_risk_undefined")
        self.assert_refused(*self.debit_call(5, symbol="MSFT"), "total_open_risk_undefined")

    def test_a_held_option_that_cannot_be_measured_refuses_opening_orders(self) -> None:
        for label, position in (
            ("no average_cost", self.held(1, 300)),
            ("negative average_cost", self.held(1, 300, cost=-5.0)),
            ("average_cost is text", self.held(1, 300, cost="n/a")),
            ("no multiplier", self.held(1, 300, cost=100.0, multiplier="")),
            ("no strike", self.held(1, 0, cost=100.0)),
            ("contract-month expiry", self.held(1, 300, cost=100.0, expiry=self.near[:6])),
            ("short without average_cost", self.held(-1, 300)),
        ):
            with self.subTest(position=label):
                self.write_snapshot([position])
                self.assert_refused(*self.debit_call(5), "name_open_risk_unavailable")
                self.assert_refused(*self.long_call(5), "name_open_risk_unavailable")
                self.assert_refused(*self.debit_call(5, symbol="MSFT"), "total_open_risk_unavailable")
        self.write_snapshot([self.held(0, 300), self.held(1, 310, cost=0), v2.held_stock(100)])
        self.assert_accepted(*self.debit_call(2000), 2000)  # a flat row and a free option carry no risk

    # -- the ledger file -----------------------------------------------------------

    def closes_beside_a_broken_ledger(self) -> tuple[list[dict], tuple, tuple]:
        """A book, a closing BAG of its AAPL 120/200 call spread and a sale of its KO call."""

        book = [self.held(1, 120, cost=900.0), self.held(-1, 200, cost=300.0), self.held(2, 50, symbol="KO", cost=100.0)]
        closing, legs = vertical(self.leg(200), self.leg(120))
        return (
            book,
            (closing, v2.order("BUY", 1, lmtPrice=-6.0), legs),
            (self.leg(50, symbol="KO"), v2.order("SELL", 2), None),
        )

    def ledger_document(self, good: dict, **changes) -> str:
        return json.dumps(
            {
                "schema": RESERVATIONS_SCHEMA,
                "updated_at": "2026-11-11T00:00:00Z",
                "reservations": [],
                OPEN_RISK_KEY: [good],
                **changes,
            }
        )

    def test_an_invalid_ledger_refuses_every_opening_order_and_no_way_out(self) -> None:
        book, closing, sale = self.closes_beside_a_broken_ledger()
        cover = (self.leg(200), v2.order("BUY", 1), None)  # buys the short AAPL call back
        self.write_snapshot(book)
        good = ledger_entry(900, "MSFT", self.near, 100)
        entries = lambda *items: self.ledger_document(good, **{OPEN_RISK_KEY: list(items)})  # noqa: E731
        contents = {
            "the list is an object": self.ledger_document(good, **{OPEN_RISK_KEY: {"21:900": good}}),
            "the list is text": self.ledger_document(good, **{OPEN_RISK_KEY: "none"}),
            "the list is null": self.ledger_document(good, **{OPEN_RISK_KEY: None}),
            "an entry twice": entries(good, good),
            "an entry that is not an object": entries("21:900"),
            "max_loss 0": entries({**good, "max_loss": "0"}),
            "max_loss negative": entries({**good, "max_loss": "-5"}),
            "max_loss is text": entries({**good, "max_loss": "a lot"}),
            "max_loss missing": entries({k: v for k, v in good.items() if k != "max_loss"}),
            "expiry is not a date": entries({**good, "expiry": "2026-11-20"}),
            "symbol empty": entries({**good, "symbol": ""}),
            "key empty": entries({**good, "key": ""}),
            "signature missing": entries({k: v for k, v in good.items() if k != "signature"}),
            "placed_at is text": entries({**good, "placed_at": "yesterday"}),
            "placed_at is a bool": entries({**good, "placed_at": True}),
        }
        for label, text in contents.items():
            with self.subTest(ledger=label):
                self.reservations.write_text(text)
                self.assert_refused(*self.debit_call(5), "open_risk_ledger_invalid")
                self.assert_refused(*self.long_call(5), "open_risk_ledger_invalid")
                self.assert_place_refused(*self.debit_call(5), "open_risk_ledger_invalid")
                self.assertEqual(self.reservations.read_text(), text)
                code, payload = self.run_tool("open-risk")
                self.assertEqual((code, payload["error"]), (2, "open_risk_ledger_invalid"))
                # The way out stays open: the closing BAG, and a buy that covers a short.
                self.assert_accepted(*closing, None, allowance="vertical_spread_close")
                self.assert_accepted(*cover, None, allowance="position_close")
                # The sale of a long option needs the working opening spreads: refused until repaired.
                self.assert_refused(*sale, "close_risk_unavailable")
        self.assertEqual(self.client.placed, [])
        self.place(*closing, order_id=1)
        self.assertEqual(len(self.client.placed), 1)
        self.assertEqual(len(self.stored_reservations()), 2)
        # The close reservations were written beside the invalid list, which stays as stored.
        stored = json.loads(self.reservations.read_text())
        self.assertEqual(stored[OPEN_RISK_KEY], json.loads(text)[OPEN_RISK_KEY])
        self.assert_refused(*self.debit_call(5, symbol="KO"), "open_risk_ledger_invalid")
        self.write_ledger(good)
        self.assertEqual(len(self.stored_reservations()), 2)
        self.assert_accepted(*self.debit_call(5, symbol="KO"), 5)

    def test_a_write_of_one_list_never_repairs_or_empties_the_other(self) -> None:
        # Review round 3: an invalid value must stay invalid until a person repairs the file.
        book, closing, sale = self.closes_beside_a_broken_ledger()
        self.write_snapshot(book)
        good = ledger_entry(900, "MSFT", self.near, 100)
        # 1. open_risk null beside valid reservations: a close write keeps the null.
        self.reservations.write_text(self.ledger_document(good, **{OPEN_RISK_KEY: None}))
        self.assert_refused(*self.debit_call(5, symbol="KO"), "open_risk_ledger_invalid")
        self.place(*closing, order_id=1)
        stored = json.loads(self.reservations.read_text())
        self.assertIn(OPEN_RISK_KEY, stored)
        self.assertIsNone(stored[OPEN_RISK_KEY])
        self.assertEqual(len(stored["reservations"]), 2)
        self.assert_refused(*self.debit_call(5, symbol="KO"), "open_risk_ledger_invalid")
        # 2. No reservations key beside a valid list of working opening orders: a release keeps it missing.
        document = json.loads(self.ledger_document(good))
        del document["reservations"]
        self.reservations.write_text(json.dumps(document))
        self.assert_refused(*sale, "reservations_invalid")
        code, payload = self.run_tool(
            "release-open-risk", "--key", "21:900", "--by", "owner", "--reason", "checked TWS first"
        )
        self.assertEqual((code, payload["remaining"]), (0, 0))
        stored = json.loads(self.reservations.read_text())
        self.assertNotIn("reservations", stored)
        self.assertNotIn(OPEN_RISK_KEY, stored)
        self.assert_refused(*sale, "reservations_invalid")
        # 3. A reservations value that is no list beside a valid list of working opening orders.
        self.reservations.write_text(self.ledger_document(good, reservations="bad"))
        code, _ = self.run_tool("release-open-risk", "--key", "21:900", "--by", "owner", "--reason", "checked TWS first")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(self.reservations.read_text())["reservations"], "bad")
        self.assert_refused(*sale, "reservations_invalid")
        # 4. open_risk as an object beside valid reservations: a close write keeps it.
        self.reservations.write_text(self.ledger_document(good, **{OPEN_RISK_KEY: {"21:900": good}}))
        self.place(*closing, order_id=2)
        self.assertEqual(json.loads(self.reservations.read_text())[OPEN_RISK_KEY], {"21:900": good})
        self.assertEqual(len(self.client.placed), 2)

    def test_a_read_fault_at_the_write_refuses_the_order_and_keeps_the_other_list(self) -> None:
        # Review round 3: a write reads the file once more to keep the other list. A fault of that read
        # may not pass for "no file": the close would be written without the working opening orders.
        book, closing, sale = self.closes_beside_a_broken_ledger()
        self.write_snapshot(book)
        self.place(*self.debit_call(5, symbol="MSFT"), order_id=1)
        before = self.reservations.read_text()
        for fault in (OSError(24, "Too many open files"), PermissionError("read-only")):
            with self.subTest(fault=type(fault).__name__):
                with mock.patch.object(arm_gate, "_stored_document", side_effect=fault):
                    self.assert_place_refused(*sale, "reservations_write_failed", order_id=2)
                    self.assert_place_refused(*self.debit_call(5, symbol="IBM"), "reservations_write_failed", order_id=3)
                self.assertEqual(self.reservations.read_text(), before)
        # The helper itself: only a missing file is an empty document.
        self.assertEqual(arm_gate._stored_document(self.tmp / "none.json"), {})
        for text in ("{bad", "[]", ""):
            self.reservations.write_text(text)
            with self.assertRaises(OSError):
                arm_gate._stored_document(self.reservations)
        self.reservations.unlink()
        self.reservations.mkdir()
        with self.assertRaises(OSError):
            arm_gate._stored_document(self.reservations)
        self.assertEqual(len(self.client.placed), 1)

    def test_a_write_that_would_pass_the_size_limit_is_refused(self) -> None:
        # Review round 3: the readers refuse a file above the limit, so such a file would block
        # every order (closes too) until a hand edit. The write is refused instead.
        book, closing, sale = self.closes_beside_a_broken_ledger()
        self.write_snapshot(book)
        self.place(*self.debit_call(5, symbol="MSFT"), order_id=1)
        before = self.reservations.read_text()
        with mock.patch.object(arm_gate, "RESERVATIONS_MAX_BYTES", len(before.encode()) + 50):
            self.assert_place_refused(*self.debit_call(5, symbol="IBM"), "reservations_write_failed", order_id=2)
            self.assert_place_refused(*sale, "reservations_write_failed", order_id=3)
            self.assertEqual(self.reservations.read_text(), before)
            self.assertEqual([item["key"] for item in self.ledger()], ["21:1"])  # still readable
        self.place(*sale, order_id=3)
        self.assertEqual(len(self.client.placed), 2)

    def test_a_file_that_is_no_reservation_file_refuses_opening_orders_and_closes(self) -> None:
        # The working opening orders and the close reservations are one file: a file the v2 reader
        # refuses (every close is refused, as in v2) refuses every opening order too.
        book, closing, sale = self.closes_beside_a_broken_ledger()
        self.write_snapshot(book)
        good = ledger_entry(900, "MSFT", self.near, 100)
        contents = {
            "not JSON": "{bad",
            "empty file": "",
            "a list": "[]",
            "another schema": self.ledger_document(good, schema="nautilus-order-policy-open-risk-v1"),
            "too large": self.ledger_document(good, padding="x" * (1024 * 1024)),
        }
        for label, text in contents.items():
            with self.subTest(file=label):
                self.reservations.write_text(text)
                self.assert_refused(*self.debit_call(5), "open_risk_ledger_invalid")
                self.assert_place_refused(*self.long_call(5), "open_risk_ledger_invalid")
                self.assert_refused(*closing, "reservations_invalid")
                self.assert_place_refused(*sale, "reservations_invalid")
                self.assertEqual(self.reservations.read_text(), text)
        self.assertEqual(self.client.placed, [])

    def test_an_unreadable_file_refuses_opening_orders_and_closes(self) -> None:
        book, closing, sale = self.closes_beside_a_broken_ledger()
        self.write_snapshot(book)
        self.reservations.mkdir()
        self.assert_refused(*self.debit_call(5), "open_risk_ledger_unreadable")
        self.assert_place_refused(*self.long_call(5), "open_risk_ledger_unreadable")
        self.assert_refused(*closing, "reservations_unreadable")
        self.assert_place_refused(*sale, "reservations_unreadable")
        self.assertEqual(self.client.placed, [])

    def test_the_reservation_file_keeps_its_v2_shape_until_an_opening_order_works(self) -> None:
        book, closing, sale = self.closes_beside_a_broken_ledger()
        self.write_snapshot(book)
        self.place(*sale, order_id=1)
        document = json.loads(self.reservations.read_text())
        self.assertEqual(sorted(document), ["reservations", "schema", "updated_at"])
        self.place(*self.debit_call(5, symbol="MSFT"), order_id=2)
        document = json.loads(self.reservations.read_text())
        self.assertEqual(sorted(document), [OPEN_RISK_KEY, "reservations", "schema", "updated_at"])
        self.assertEqual([item["key"] for item in document["reservations"]], ["21:1"])
        self.assertEqual([item["key"] for item in document[OPEN_RISK_KEY]], ["21:2"])
        # A close written after it keeps the working opening order, and the other way round.
        self.place(*closing, order_id=3)
        document = json.loads(self.reservations.read_text())
        self.assertEqual(len(document["reservations"]), 3)
        self.assertEqual([item["key"] for item in document[OPEN_RISK_KEY]], ["21:2"])
        self.place(*self.debit_call(5, symbol="IBM"), order_id=4)
        document = json.loads(self.reservations.read_text())
        self.assertEqual(len(document["reservations"]), 3)
        self.assertEqual([item["key"] for item in document[OPEN_RISK_KEY]], ["21:2", "21:4"])
        # The owner releases both: the key leaves the file with the last entry.
        for key in ("21:2", "21:4"):
            code, _ = self.run_tool("release-open-risk", "--key", key, "--by", "owner", "--reason", "checked TWS first")
            self.assertEqual(code, 0)
        document = json.loads(self.reservations.read_text())
        self.assertEqual(sorted(document), ["reservations", "schema", "updated_at"])
        self.assertEqual(len(document["reservations"]), 3)

    def test_a_ledger_write_failure_refuses_the_order(self) -> None:
        self.write_snapshot([])
        with mock.patch.object(arm_gate, "_write_open_risk", side_effect=PermissionError("read-only")):
            self.assert_place_refused(*self.debit_call(5), "reservations_write_failed")
            self.place(*self.debit_call(5, whatIf=True))  # a preflight writes nothing
        self.assertEqual(len(self.client.placed), 1)
        self.assertIsNone(self.ledger())

    def test_a_disconnected_client_writes_no_ledger_entry(self) -> None:
        self.write_snapshot([])
        self.client.connected = False
        self.assert_place_refused(*self.debit_call(5), "client_not_connected")
        self.assertIsNone(self.ledger())


# -- 6. _worst_loss -------------------------------------------------------------------


class WorstLossTest(unittest.TestCase):
    """Largest loss at expiry of the options of one underlying and one expiry (None: no bound)."""

    @staticmethod
    def lot(right: str, strike, contracts: int, price) -> arm_gate._Lot:
        """``contracts`` (negative: short) x 100 at ``price`` per share paid (or received when short)."""

        return arm_gate._Lot(
            right, Decimal(str(strike)), Decimal(contracts) * 100, Decimal(contracts) * 100 * Decimal(str(price))
        )

    def test_worst_loss_table(self) -> None:
        lot = self.lot
        table = (
            ("no options", [], Decimal(0)),
            ("long call: the premium", [lot("C", 200, 1, "3.50")], Decimal(350)),
            ("long put x 2: the premium", [lot("P", 200, 2, "1.25")], Decimal(250)),
            # 200/205 for 5.00 - 2.00: the net debit.
            ("debit call spread", [lot("C", 200, 1, "5.00"), lot("C", 205, -1, "2.00")], Decimal(300)),
            ("debit put spread", [lot("P", 200, 3, "4.00"), lot("P", 190, -3, "1.50")], Decimal(750)),
            # short 200 put for 3.00, long 195 put for 1.00: (5 - 2.00) x 100.
            ("credit put spread: width - credit", [lot("P", 200, -1, "3.00"), lot("P", 195, 1, "1.00")], Decimal(300)),
            ("credit call spread: width - credit", [lot("C", 100, -2, "4.00"), lot("C", 110, 2, "1.50")], Decimal(1500)),
            # Calls 100/105 for a 1.00 credit, puts 90/80 for a 2.00 credit: max(500, 1000) - 300.
            (
                "iron condor: the wider wing - credit",
                [lot("C", 100, -1, "1.50"), lot("C", 105, 1, "0.50"), lot("P", 90, -1, "3.00"), lot("P", 80, 1, "1.00")],
                Decimal(700),
            ),
            (
                "iron condor, call wing wider",
                [lot("C", 100, -1, "2.50"), lot("C", 120, 1, "0.50"), lot("P", 90, -1, "1.50"), lot("P", 85, 1, "0.50")],
                Decimal(1700),  # 2000 - (200 + 100)
            ),
            ("naked short call", [lot("C", 200, -1, "3.00")], None),
            ("short call beside a long put", [lot("C", 200, -1, "3.00"), lot("P", 200, 1, "3.00")], None),
            ("long call + more short calls", [lot("C", 100, 1, "9.00"), lot("C", 110, -2, "4.00")], None),
            # short 50 put for 2.00: 50 x 100 - 200.
            ("short put alone: strike x units - credit", [lot("P", 50, -1, "2.00")], Decimal(4800)),
            ("short strangle", [lot("P", 50, -1, "2.00"), lot("C", 70, -1, "2.00")], None),
            # long 2 x 110 calls for 2.00, short 1 x 100 call for 6.00: worst at 110, -1000, credit 200.
            ("call back spread", [lot("C", 110, 2, "2.00"), lot("C", 100, -1, "6.00")], Decimal(800)),
            # long straddle: both premiums.
            ("long straddle", [lot("C", 100, 1, "4.00"), lot("P", 100, 1, "3.50")], Decimal(750)),
            # 100/110 call spread opened for a 1.00 net credit after legging: nothing can be lost.
            ("a spread held for a net credit", [lot("C", 100, 1, "2.00"), lot("C", 110, -1, "3.00")], Decimal(0)),
            # long 100 call, short 110 call, long 120 call (butterfly without one short): the debit.
            (
                "long butterfly: the debit",
                [lot("C", 100, 1, "12.00"), lot("C", 110, -2, "5.00"), lot("C", 120, 1, "1.00")],
                Decimal(300),
            ),
            # box-like: bull call 100/110 for 6.00 + bear put 110/100 for 5.00, worth 10 everywhere.
            (
                "box: debit - width",
                [lot("C", 100, 1, "8.00"), lot("C", 110, -1, "2.00"), lot("P", 110, 1, "7.00"), lot("P", 100, -1, "2.00")],
                Decimal(100),
            ),
        )
        for name, lots, expected in table:
            with self.subTest(position=name):
                self.assertEqual(arm_gate._worst_loss(lots), expected)
                self.assertEqual(arm_gate._worst_loss(list(reversed(lots))), expected)

    def test_other_multipliers(self) -> None:
        mini = [
            arm_gate._Lot("P", Decimal(200), Decimal(-10), Decimal(-30)),  # short 1 x 10 for 3.00
            arm_gate._Lot("P", Decimal(195), Decimal(10), Decimal(10)),  # long 1 x 10 for 1.00
        ]
        self.assertEqual(arm_gate._worst_loss(mini), Decimal(30))  # (5 - 2.00) x 10

    def test_open_risk_groups_by_name_expiry_and_trading_class(self) -> None:
        near, far = "20270115", "20290119"
        positions = [
            held(5, 200, expiry=near, cost=300.0),
            held(-5, 205, expiry=near, cost=100.0),
            held(1, 300, expiry=far, cost=2500.0),
            held(-1, 50, "C", expiry=near, symbol="KO", cost=40.0),
            held(1, 60, "P", expiry=near, symbol="PEP"),
            held(0, 60, "P", expiry=far, symbol="PEP"),
            held(-1, 5000, expiry=near, symbol="SPX", cost=3000.0),
            held(1, 5100, expiry=near, symbol="SPX", trading_class="SPXW", cost=1000.0),
            v2.held_stock(100),
        ]
        self.assertEqual(
            arm_gate._open_risk_groups(positions),
            {
                ("AAPL", near, "AAPL"): Decimal(1000),
                ("AAPL", far, "AAPL"): Decimal(2500),
                ("KO", near, "KO"): "unbounded",
                ("PEP", near, "PEP"): "unknown",
                ("SPX", near, "SPX"): "unbounded",
                ("SPX", near, "SPXW"): Decimal(1000),
            },
        )


# -- 7. closing verticals and partial fills ---------------------------------------------


class ClosingVerticalTest(V3TestCase):
    """After a partial fill of a 120/200 call debit spread: held +2 x 120 call, -2 x 200 call."""

    def setUp(self) -> None:
        super().setUp()
        self.long_leg, self.short_leg = self.leg(120), self.leg(200)

    def book(self, long: int = 2, short: int = -2) -> list[dict]:
        rows = []
        if long:
            rows.append(self.held(long, 120, cost=8200.0))
        if short:
            rows.append(self.held(short, 200, cost=1500.0))
        return rows

    def closing(self, quantity=2, limit=-70.0, **extra):
        """BUY of the BAG that buys back the short 200 call and sells the long 120 call."""

        contract, legs = vertical(self.short_leg, self.long_leg)
        return contract, v2.order("BUY", quantity, lmtPrice=limit, **extra), legs

    def test_a_closing_bag_within_both_held_legs_reserves_each_leg(self) -> None:
        self.write_snapshot(self.book())
        self.assert_accepted(*self.closing(), None, allowance="vertical_spread_close")
        contract, order_, legs = self.closing()
        self.place(contract, order_, legs)
        self.assertEqual(self.client.placed, [(7, contract, order_)])
        stored = {item["key"]: item for item in self.stored_reservations()}
        long_key, short_key = f"21:7/{self.long_leg.conId}", f"21:7/{self.short_leg.conId}"
        self.assertEqual(set(stored), {long_key, short_key})
        for key, action, strike in ((long_key, "SELL", 120), (short_key, "BUY", 200)):
            item = stored[key]
            self.assertEqual((item["action"], item["order_id"], item["client_id"]), (action, "7", "21"))
            self.assertEqual((Decimal(item["quantity"]), Decimal(item["held_before"])), (Decimal(2), Decimal(2)))
            self.assertEqual(Decimal(item["contract"]["strike"]), Decimal(strike))
            self.assertEqual(item["contract"]["sec_type"], "OPT")
        self.assertEqual(self.ledger(), [])  # a close is no opening order
        self.assertCountEqual([item for _, item in self.client.detail_requests], legs)  # IBKR named both legs

    def test_the_sell_of_the_reversed_bag_closes_too(self) -> None:
        self.write_snapshot(self.book())
        contract, legs = vertical(self.long_leg, self.short_leg)  # the BAG the spread was opened with
        self.assert_accepted(contract, v2.order("SELL", 2, lmtPrice=70.0), legs, None, allowance="vertical_spread_close")
        self.assert_accepted(contract, v2.order("SELL", 1, lmtPrice=70.0), legs, None, allowance="vertical_spread_close")
        self.place(contract, v2.order("SELL", 2, lmtPrice=70.0), legs)
        self.assertEqual(
            {(item["key"], item["action"]) for item in self.stored_reservations()},
            {(f"21:7/{self.long_leg.conId}", "SELL"), (f"21:7/{self.short_leg.conId}", "BUY")},
        )

    def test_a_closing_bag_beyond_a_held_leg_is_refused(self) -> None:
        self.write_snapshot(self.book())
        self.assert_refused(*self.closing(quantity=3), "exceeds_held_quantity")
        self.assert_place_refused(*self.closing(quantity=3), "exceeds_held_quantity")
        self.write_snapshot(self.book(long=3, short=-2))
        self.assert_refused(*self.closing(quantity=3), "exceeds_held_quantity")
        self.assert_accepted(*self.closing(quantity=2), None, allowance="vertical_spread_close")
        self.write_snapshot(self.book(long=2, short=-5))
        self.assert_refused(*self.closing(quantity=3), "exceeds_held_quantity")
        # Three of the five short calls are naked already; what a closing BAG leaves has no bound
        # either, so only buying short calls back is allowed from this book.
        self.assert_refused(*self.closing(quantity=1), "close_would_uncover_short")
        self.assert_accepted(self.short_leg, v2.order("BUY", 5), None, None, allowance="position_close")
        self.assertFalse(self.reservations.exists())

    def test_a_closing_bag_needs_the_combo_order_shape_but_no_caps(self) -> None:
        # The held spread is 2 x (8200 - 1500) = 13,400 USD, far over every cap: closes stay allowed.
        self.write_snapshot(self.book(), summary={})  # and need no NetLiquidation
        for limit in (-70.0, -0.05, 0, 1.25):
            with self.subTest(limit=limit):
                self.assert_accepted(*self.closing(limit=limit), None, allowance="vertical_spread_close")
        with self.environ(**{TOTAL_ENV: "5"}):  # a cap without its source refuses opening orders only
            self.assert_accepted(*self.closing(), None, allowance="vertical_spread_close")
        self.assert_refused(*self.closing(orderType="MKT"), "order_type_refused")
        self.assert_refused(*self.closing(limit=None), "limit_price_missing")
        self.assert_refused(*self.closing(quantity=1.5), "combo_quantity_not_whole")
        routing = [SimpleNamespace(tag="NonGuaranteed", value="1")]
        self.assert_refused(*self.closing(smartComboRoutingParams=routing), "combo_non_guaranteed_refused")
        contract, order_, _ = self.closing()
        self.assert_refused(contract, order_, None, "combo_legs_unverified")

    def test_a_single_leg_sale_of_the_long_would_uncover_the_short(self) -> None:
        self.write_snapshot(self.book())
        for quantity in (1, 2):
            with self.subTest(quantity=quantity):
                self.assert_refused(self.long_leg, v2.order("SELL", quantity), None, "close_would_uncover_short")
                self.assert_place_refused(self.long_leg, v2.order("SELL", quantity), None, "close_would_uncover_short")
        self.assert_refused(
            v2.option(expiry=self.near, strike=120.0), v2.order("SELL", 1), None, "close_would_uncover_short"
        )
        self.assertFalse(self.reservations.exists())
        [event, *_] = self.audit_events("order_refused")
        self.assertEqual((event["error"], event["sec_type"], event["action"]), ("close_would_uncover_short", "OPT", "SELL"))

    def test_buying_the_short_back_first_then_selling_the_long(self) -> None:
        self.write_snapshot(self.book())
        cover = v2.order("BUY", 2, lmtPrice=3.0)
        self.assert_accepted(self.short_leg, cover, None, None, allowance="position_close")
        self.assert_accepted(self.short_leg, v2.order("BUY", 1), None, None, allowance="position_close")
        self.assert_refused(self.short_leg, v2.order("BUY", 3), None, "exceeds_held_quantity")
        self.place(self.short_leg, cover, order_id=1)
        self.assertEqual([item["key"] for item in self.stored_reservations()], ["21:1"])
        # The cover is unresolved and the snapshot still shows the short: the long stays.
        self.assert_place_refused(self.long_leg, v2.order("SELL", 2), None, "close_group_busy", order_id=2)
        self.client.orderStatus(1, "Filled", Decimal(2), Decimal(0))
        self.later_snapshot(self.book(short=0))  # only the long is left
        self.assert_accepted(self.long_leg, v2.order("SELL", 2), None, None, allowance="position_close", order_id=2)
        self.place(self.long_leg, v2.order("SELL", 2), order_id=2)
        self.assertEqual(len(self.client.placed), 2)

    def test_a_sale_may_leave_as_many_longs_as_shorts(self) -> None:
        self.write_snapshot(self.book(long=3, short=-2))
        self.assert_accepted(self.long_leg, v2.order("SELL", 1), None, None, allowance="position_close")
        self.assert_refused(self.long_leg, v2.order("SELL", 2), None, "close_would_uncover_short")
        self.assert_refused(self.long_leg, v2.order("SELL", 3), None, "close_would_uncover_short")

    def test_closes_of_a_group_with_a_short_go_one_at_a_time(self) -> None:
        # +1 x 120 call, +1 x 130 call, -1 x 200 call: one of the longs must stay.
        book = [self.held(1, 120, cost=8200.0), self.held(1, 130, cost=7300.0), self.held(-1, 200, cost=1500.0)]
        self.write_snapshot(book)
        self.place(self.long_leg, v2.order("SELL", 1), order_id=1)
        # The two sales could fill in any order: the second waits for the first.
        self.assert_place_refused(self.leg(130), v2.order("SELL", 1), None, "close_group_busy", order_id=2)
        self.assert_place_refused(self.leg(130), v2.order("SELL", 1, whatIf=True), None, "close_group_busy", order_id=2)
        # A buy that closes the short only lowers the risk: it is never held back.
        self.place(self.short_leg, v2.order("BUY", 1), order_id=3)
        self.assertEqual(len(self.client.placed), 2)
        self.assertEqual([item["key"] for item in self.stored_reservations()], ["21:1", "21:3"])

    def test_a_closing_bag_waits_for_a_working_single_close_of_the_group(self) -> None:
        self.write_snapshot([*self.book(), self.held(1, 130, cost=7300.0)])
        self.place(self.leg(130), v2.order("SELL", 1), order_id=1)
        self.assert_place_refused(*self.closing(), "close_group_busy", order_id=2)
        self.client.orderStatus(1, "Filled", Decimal(1), Decimal(0))
        self.later_snapshot(self.book())
        self.place(*self.closing(), order_id=2)
        self.assertEqual(len(self.client.placed), 2)

    def test_closes_are_not_held_back_without_a_short_or_in_another_group(self) -> None:
        other = self.exp(80)
        # No short option in the group: two sales may work side by side.
        self.write_snapshot([self.held(1, 120, cost=8200.0), self.held(1, 130, cost=7300.0)])
        self.place(self.long_leg, v2.order("SELL", 1), order_id=1)
        self.place(self.leg(130), v2.order("SELL", 1), order_id=2)
        # A working close of another expiry or another name does not make this group busy.
        arm_gate._order_outcomes.clear()
        self.reservations.unlink()
        self.write_snapshot(
            [
                *self.book(long=3, short=-2),
                self.held(1, 120, expiry=other, cost=9000.0),
                self.held(1, 50, symbol="KO", cost=100.0),
            ]
        )
        self.place(self.leg(120, expiry=other), v2.order("SELL", 1), order_id=3)
        self.place(self.leg(50, symbol="KO"), v2.order("SELL", 1), order_id=4)
        self.place(self.long_leg, v2.order("SELL", 1), order_id=5)
        self.assertEqual(len(self.client.placed), 5)

    def test_a_sale_that_lowers_the_worst_value_of_what_stays_is_refused(self) -> None:
        # -1 x 100 call, +1 x 105 call, +1 x 150 call: at expiry the three are worth at least -500.
        self.write_snapshot([self.held(-1, 100, cost=900.0), self.held(1, 105, cost=600.0), self.held(1, 150, cost=50.0)])
        # Without the 105 call the 100/150 pair can be worth -5,000.
        result = self.assert_refused(self.leg(105), v2.order("SELL", 1), None, "close_would_increase_risk")
        self.assertIn("5000", result["policy_refusal_detail"])
        self.assert_place_refused(self.leg(105), v2.order("SELL", 1), None, "close_would_increase_risk")
        # Without the 150 call the 100/105 spread is still worth at least -500.
        self.assert_accepted(self.leg(150), v2.order("SELL", 1), None, None, allowance="position_close")
        self.place(self.leg(150), v2.order("SELL", 1))
        self.assertEqual(len(self.client.placed), 1)

    def test_the_same_rule_for_puts(self) -> None:
        # -1 x 100 put, +1 x 95 put, +1 x 50 put: worth at least -500; without the 95 put, -5,000.
        self.write_snapshot(
            [self.held(-1, 100, "P", cost=900.0), self.held(1, 95, "P", cost=600.0), self.held(1, 50, "P", cost=50.0)]
        )
        self.assert_refused(self.leg(95, "P"), v2.order("SELL", 1), None, "close_would_increase_risk")
        self.assert_accepted(self.leg(50, "P"), v2.order("SELL", 1), None, None, allowance="position_close")
        # The long put of a plain put spread: the short put stays bounded by its strike, but loses more.
        self.write_snapshot([self.held(-2, 100, "P", cost=900.0), self.held(2, 95, "P", cost=600.0)])
        self.assert_refused(self.leg(95, "P"), v2.order("SELL", 1), None, "close_would_increase_risk")
        self.assert_accepted(self.leg(100, "P"), v2.order("BUY", 2), None, None, allowance="position_close")

    def test_calls_at_risk_do_not_hide_a_put_left_short(self) -> None:
        # Review round 2. Held: 5 x 200/230 call credit spreads (worth at least -15,000) and
        # 1 x 150/140 put credit spread (worth at least -1,000). Calls and puts lose at different
        # prices, so one worst value for both would let the long put go: the 150 put alone can be
        # worth -15,000, which is not below the calls' -15,000.
        calls = [self.held(-5, 200, cost=400.0), self.held(5, 230, cost=120.0)]
        puts = [self.held(-1, 150, "P", cost=300.0), self.held(1, 140, "P", cost=100.0)]
        self.write_snapshot([*calls, *puts])
        sale = (self.leg(140, "P"), v2.order("SELL", 1), None)
        result = self.assert_refused(*sale, "close_would_increase_risk")
        self.assertIn("the puts left could lose 15000 USD", result["policy_refusal_detail"])
        self.assert_place_refused(*sale, "close_would_increase_risk")
        # The same with the sides swapped: puts at risk do not hide a call left short.
        self.write_snapshot(
            [
                self.held(-5, 200, "P", cost=400.0),
                self.held(5, 170, "P", cost=120.0),
                self.held(-1, 300, cost=300.0),
                self.held(1, 310, cost=100.0),
            ]
        )
        self.assert_refused(self.leg(310), v2.order("SELL", 1), None, "close_would_uncover_short")
        # Each spread still closes as one BAG, and the short of each side can be bought back.
        self.write_snapshot([*calls, *puts])
        contract, legs = vertical(self.leg(150, "P"), self.leg(140, "P"))
        self.assert_accepted(contract, v2.order("BUY", 1, lmtPrice=2.00), legs, None, allowance="vertical_spread_close")
        self.assert_accepted(self.leg(150, "P"), v2.order("BUY", 1), None, None, allowance="position_close")
        self.assertEqual(self.client.placed, [])

    def test_a_long_call_is_not_sold_alone_beside_short_shares(self) -> None:
        # Review round 2. The short call of a call spread was assigned: the account is short 200
        # shares and still holds the 2 long calls that bound the loss.
        shares = {**v2.held_stock(-200), "average_cost": 200.0}
        self.write_snapshot([shares, self.held(2, 230, cost=120.0)])
        for quantity in (1, 2):
            with self.subTest(quantity=quantity):
                sale = (self.leg(230), v2.order("SELL", quantity), None)
                result = self.assert_refused(*sale, "close_would_uncover_short")
                self.assertIn("short shares", result["policy_refusal_detail"])
                self.assert_place_refused(*sale, "close_would_uncover_short")
        # A third long call is not needed to cover 200 shares: one may go.
        self.write_snapshot([shares, self.held(3, 230, cost=120.0)])
        self.assert_accepted(self.leg(230), v2.order("SELL", 1), None, None, allowance="position_close")
        self.assert_refused(self.leg(230), v2.order("SELL", 2), None, "close_would_uncover_short")
        # Long puts, long shares and the shares of another name change nothing for a call.
        self.write_snapshot([shares, self.held(2, 230, cost=120.0), self.held(1, 150, "P", cost=90.0)])
        self.assert_accepted(self.leg(150, "P"), v2.order("SELL", 1), None, None, allowance="position_close")
        self.write_snapshot([v2.held_stock(200), self.held(2, 230, cost=120.0)])
        self.assert_accepted(self.leg(230), v2.order("SELL", 2), None, None, allowance="position_close")
        self.write_snapshot([v2.held_stock(-200, "MSFT"), self.held(2, 230, cost=120.0)])
        self.assert_accepted(self.leg(230), v2.order("SELL", 2), None, None, allowance="position_close")
        # The way out: buy the shares back first.
        self.write_snapshot([shares, self.held(2, 230, cost=120.0)])
        self.assert_accepted(v2.stock(), v2.order("BUY", 200), None, None, allowance="position_close")
        self.assertEqual(self.client.placed, [])

    def test_a_long_put_is_not_sold_when_fewer_long_puts_than_short_puts_would_stay(self) -> None:
        # Review round 3. One long 200 put is worth as much at 0 as two short 100 puts cost, so the
        # worst value at expiry does not fall when one of two long puts goes. The 1:2 shape left is
        # refused as an opening order (combo_ratio_refused) and is refused here too.
        self.write_snapshot([self.held(2, 200, "P", cost=900.0), self.held(-2, 100, "P", cost=300.0)])
        sale = (self.leg(200, "P"), v2.order("SELL", 1), None)
        result = self.assert_refused(*sale, "close_would_uncover_short")
        self.assertIn("more short puts than long ones", result["policy_refusal_detail"])
        self.assert_place_refused(*sale, "close_would_uncover_short")
        self.write_snapshot([self.held(5, 130, "P", cost=900.0), self.held(-5, 100, "P", cost=300.0)])
        self.assert_refused(self.leg(130, "P"), v2.order("SELL", 1), None, "close_would_uncover_short")
        # A third long put is not needed for two short puts: it may go.
        self.write_snapshot([self.held(3, 200, "P", cost=900.0), self.held(-2, 100, "P", cost=300.0)])
        self.assert_accepted(self.leg(200, "P"), v2.order("SELL", 1), None, None, allowance="position_close")
        self.assert_refused(self.leg(200, "P"), v2.order("SELL", 2), None, "close_would_uncover_short")
        self.assertEqual(self.client.placed, [])

    def test_shares_that_cover_a_short_call_are_not_sold(self) -> None:
        # Review round 3. The long call of a spread was exercised early: 200 shares beside 2 short calls.
        shares = v2.held_stock(200)
        self.write_snapshot([shares, self.held(-2, 130, cost=300.0)])
        for quantity in (1, 200):
            with self.subTest(quantity=quantity):
                sale = (v2.stock(), v2.order("SELL", quantity), None)
                result = self.assert_refused(*sale, "close_would_uncover_short")
                self.assertIn("200 of the held shares cover short calls", result["policy_refusal_detail"])
                self.assert_place_refused(*sale, "close_would_uncover_short")
        # Shares beyond the cover may go; a short call that a long call covers needs no shares.
        self.write_snapshot([v2.held_stock(300), self.held(-2, 130, cost=300.0)])
        self.assert_accepted(v2.stock(), v2.order("SELL", 100), None, None, allowance="position_close")
        self.assert_refused(v2.stock(), v2.order("SELL", 101), None, "close_would_uncover_short")
        self.write_snapshot([shares, self.held(-2, 130, cost=300.0), self.held(2, 150, cost=100.0)])
        self.assert_accepted(v2.stock(), v2.order("SELL", 200), None, None, allowance="position_close")
        # A long call of another expiry covers nothing here; short puts and other names need no shares.
        self.write_snapshot([shares, self.held(-2, 130, cost=300.0), self.held(2, 150, expiry=self.exp(80), cost=100.0)])
        self.assert_refused(v2.stock(), v2.order("SELL", 1), None, "close_would_uncover_short")
        self.write_snapshot([shares, self.held(-2, 130, "P", cost=300.0), self.held(-2, 130, symbol="MSFT", cost=300.0)])
        self.assert_accepted(v2.stock(), v2.order("SELL", 200), None, None, allowance="position_close")
        # The way out: buy the short calls back first.
        self.write_snapshot([shares, self.held(-2, 130, cost=300.0)])
        self.assert_accepted(self.leg(130), v2.order("BUY", 2), None, None, allowance="position_close")
        # Switch off: the v2 behaviour.
        with self.flag(None):
            self.assert_accepted(v2.stock(), v2.order("SELL", 200), None, None, allowance="position_close")
        self.assertEqual(self.client.placed, [])

    def test_the_sale_is_measured_from_the_size_left_after_fills_the_snapshot_does_not_show(self) -> None:
        # Review round 3 (test gap). +2 x 100 call, -1 x 110 call: one long may go. Its sale fills, the
        # snapshot still shows 2: a second sale would leave the short 110 call alone.
        self.write_snapshot([self.held(2, 100, cost=900.0), self.held(-1, 110, cost=300.0)])
        self.place(self.leg(100), v2.order("SELL", 1), order_id=1)
        self.client.orderStatus(1, "Filled", Decimal(1), Decimal(0))
        self.assert_place_refused(self.leg(100), v2.order("SELL", 1), None, "close_would_uncover_short", order_id=2)
        self.assertEqual(len(self.client.placed), 1)

    def test_what_does_not_cover_a_short_call(self) -> None:
        # Review round 3 (test gaps). Long shares are no long call of the expiry.
        self.write_snapshot([v2.held_stock(100), self.held(1, 230, cost=120.0), self.held(-1, 250, cost=60.0)])
        self.assert_refused(self.leg(230), v2.order("SELL", 1), None, "close_would_uncover_short")
        # An SPXW call does not cover an SPX call of the same date.
        index = {"symbol": "SPX", "cost": 100.0}
        self.write_snapshot(
            [
                self.held(1, 5000, trading_class="SPX", **index),
                self.held(-1, 5100, trading_class="SPX", **index),
                self.held(1, 5050, trading_class="SPXW", **index),
            ]
        )
        sale = (self.leg(5000, symbol="SPX", tradingClass="SPX"), v2.order("SELL", 1), None)
        self.assert_refused(*sale, "close_would_uncover_short")
        self.assert_accepted(
            self.leg(5050, symbol="SPX", tradingClass="SPXW"), v2.order("SELL", 1), None, None, allowance="position_close"
        )
        # A held option of the expiry without a trading class may or may not cover the short call.
        self.write_snapshot(
            [self.held(1, 100, cost=900.0), self.held(1, 105, cost=600.0, trading_class=""), self.held(-1, 110, cost=300.0, trading_class="")]
        )
        self.assert_refused(self.leg(100), v2.order("SELL", 1), None, "close_risk_unavailable")
        self.write_snapshot([self.held(1, 100, cost=900.0), self.held(1, 105, cost=600.0), self.held(-1, 110, cost=300.0)])
        self.assert_accepted(self.leg(100), v2.order("SELL", 1), None, None, allowance="position_close")
        # Short shares with no call at all: a long put changes nothing for them and may be sold.
        self.write_snapshot([{**v2.held_stock(-200), "average_cost": 200.0}, self.held(1, 150, "P", cost=90.0)])
        self.assert_accepted(self.leg(150, "P"), v2.order("SELL", 1), None, None, allowance="position_close")
        self.assertEqual(self.client.placed, [])

    def test_a_long_is_not_sold_alone_while_an_opening_spread_of_its_expiry_works(self) -> None:
        # Review round 2 (blocker). A resting opening spread is not in the snapshot. Its sold 130
        # call would net against a 130 call bought after it; with that long sold too, the fills
        # could end in a short 130 call and nothing else.
        self.write_snapshot([])
        contract, legs = vertical(self.leg(110), self.leg(130))
        self.place(contract, v2.order("BUY", 2, lmtPrice=5.00), legs, order_id=1)  # rests at IBKR
        other = self.exp(80)
        book = [
            self.held(2, 130, cost=100.0),
            self.held(1, 90, "P", cost=100.0),
            self.held(1, 130, expiry=other, cost=100.0),
            self.held(1, 50, symbol="KO", cost=100.0),
        ]
        self.write_snapshot(book)
        for name, option in (("the sold strike", self.leg(130)), ("a put of the expiry", self.leg(90, "P"))):
            with self.subTest(sale=name):
                result = self.assert_refused(option, v2.order("SELL", 1), None, "open_spread_working", order_id=2)
                self.assertTrue(result["policy_refusal_detail"].endswith("release-open-risk --key 21:1"))
                self.assert_place_refused(option, v2.order("SELL", 1), None, "open_spread_working", order_id=2)
        # Another expiry and another name are other groups.
        self.assert_accepted(self.leg(130, expiry=other), v2.order("SELL", 1), None, None, allowance="position_close", order_id=2)
        self.assert_accepted(self.leg(50, symbol="KO"), v2.order("SELL", 1), None, None, allowance="position_close", order_id=2)
        self.assertEqual(len(self.client.placed), 1)
        # A final status alone is not enough: the snapshot must be later than the fill.
        self.client.orderStatus(1, "Filled", Decimal(2), Decimal(0))
        self.assert_place_refused(self.leg(130), v2.order("SELL", 1), None, "open_spread_working", order_id=2)
        # The fill netted the sold 130 calls against the long ones: +2 x 110 call, no 130 call.
        self.later_snapshot([self.held(2, 110, cost=500.0), *book[1:]])
        self.assert_place_refused(self.leg(130), v2.order("SELL", 1), None, "short_option_open", order_id=2)
        self.place(self.leg(90, "P"), v2.order("SELL", 1), order_id=2)
        self.place(self.leg(110), v2.order("SELL", 2), order_id=3)
        self.assertEqual(len(self.client.placed), 3)

    def test_a_working_long_option_buy_does_not_block_a_sale(self) -> None:
        # Only an opening spread adds a short option. A working long buy of the expiry blocks nothing.
        self.write_snapshot([self.held(1, 130, cost=100.0)])
        self.place(*self.long_call(500, strike=110), order_id=1)
        self.place(self.leg(130), v2.order("SELL", 1), order_id=2)
        self.assertEqual(len(self.client.placed), 2)

    def test_a_closing_bag_is_not_blocked_by_a_working_opening_spread(self) -> None:
        # It sells the long and buys the short back in one fill: nothing is left uncovered.
        self.write_snapshot(self.book(), nlv=10_000_000)  # room under the name cap beside the held spread
        contract, legs = vertical(self.leg(210), self.leg(250))
        self.place(contract, v2.order("BUY", 1, lmtPrice=5.00), legs, order_id=1)
        self.assert_place_refused(self.long_leg, v2.order("SELL", 1), None, "open_spread_working", order_id=2)
        self.place(*self.closing(), order_id=2)
        self.assertEqual(len(self.client.placed), 2)

    def test_a_closing_bag_across_two_held_spreads_is_refused(self) -> None:
        # Two bear call credit spreads: -1 x 100 call / +1 x 105 call and -1 x 200 call / +1 x 205 call.
        self.write_snapshot(
            [
                self.held(-1, 100, cost=900.0),
                self.held(1, 105, cost=600.0),
                self.held(-1, 200, cost=90.0),
                self.held(1, 205, cost=60.0),
            ]
        )
        # Buy back the 200 call and sell the 105 call: the 100 call would be left with the 205 call.
        contract, legs = vertical(self.leg(200), self.leg(105))
        crossed = v2.order("BUY", 1, lmtPrice=-60.0)
        self.assert_refused(contract, crossed, legs, "close_would_increase_risk")
        self.assert_place_refused(contract, crossed, legs, "close_would_increase_risk")
        self.assertFalse(self.reservations.exists())
        # Each whole spread closes as one BAG.
        for short, long in ((100, 105), (200, 205)):
            with self.subTest(spread=(short, long)):
                contract, legs = vertical(self.leg(short), self.leg(long))
                self.assert_accepted(
                    contract, v2.order("BUY", 1, lmtPrice=4.0), legs, None, allowance="vertical_spread_close"
                )
        contract, legs = vertical(self.leg(100), self.leg(105))
        self.place(contract, v2.order("BUY", 1, lmtPrice=4.0), legs)
        self.assertEqual(len(self.stored_reservations()), 2)

    def test_a_group_that_cannot_be_measured_refuses_the_sale(self) -> None:
        # The 130 call has no multiplier in the snapshot: what stays after a sale cannot be valued.
        self.write_snapshot([*self.book(long=2, short=-1), self.held(1, 130, cost=7300.0, multiplier="")])
        self.assert_refused(self.long_leg, v2.order("SELL", 1), None, "close_risk_unavailable")
        self.assert_refused(*self.closing(quantity=1), "close_risk_unavailable")
        self.assert_place_refused(*self.closing(quantity=1), "close_risk_unavailable")
        # Buying the short back needs no measure.
        self.assert_accepted(self.short_leg, v2.order("BUY", 1), None, None, allowance="position_close")
        self.assertFalse(self.reservations.exists())

    def test_other_rights_expiries_and_names_do_not_cover_or_block(self) -> None:
        other = self.exp(80)
        self.write_snapshot(
            [
                self.held(2, 120, cost=8200.0),
                self.held(-2, 200, "P", cost=900.0),  # short puts: bounded, another right
                self.held(-2, 200, expiry=other, cost=1500.0),  # another expiry
                self.held(-2, 200, symbol="MSFT", cost=1500.0),  # another name
            ]
        )
        self.assert_accepted(self.long_leg, v2.order("SELL", 2), None, None, allowance="position_close")
        # A long put does not cover a short call.
        self.write_snapshot([self.held(2, 120, "P", cost=100.0), self.held(2, 120, cost=8200.0), self.held(-2, 200, cost=1500.0)])
        self.assert_accepted(self.leg(120, "P"), v2.order("SELL", 2), None, None, allowance="position_close")
        self.assert_refused(self.long_leg, v2.order("SELL", 1), None, "close_would_uncover_short")

    def test_one_leg_closing_and_the_other_opening_is_refused(self) -> None:
        self.write_snapshot(self.book())
        new_low, new_high = self.leg(130), self.leg(210)
        cases = {
            "buy back the short, sell a new call (roll down)": vertical(self.short_leg, new_low),
            "sell the long, buy a new call (roll up)": vertical(new_low, self.long_leg),
            "buy back the short, sell a higher call (roll out)": vertical(self.short_leg, new_high),
            "sell the long against a new higher long": vertical(new_high, self.long_leg),
        }
        for name, (contract, legs) in cases.items():
            for limit in (1.0, -1.0):
                with self.subTest(case=name, limit=limit):
                    self.assert_refused(contract, v2.order("BUY", 1, lmtPrice=limit), legs, "combo_mixed_open_close")
                    self.assert_place_refused(contract, v2.order("BUY", 1, lmtPrice=limit), legs, "combo_mixed_open_close")
        self.assertFalse(self.reservations.exists())
        self.assertIsNone(self.ledger())
        # Adding to the held spread (buy more of the long, sell more of the short) is an opening order.
        contract, legs = vertical(self.long_leg, self.short_leg)
        self.write_snapshot([self.held(2, 120, cost=300.0), self.held(-2, 200, cost=100.0)])  # 400 USD held
        self.assert_accepted(contract, v2.order("BUY", 1, lmtPrice=16.0), legs, 1600)
        self.assert_refused(contract, v2.order("BUY", 1, lmtPrice=16.01), legs, "name_short_dated_cap_exceeded")

    def test_a_second_close_waits_for_the_first(self) -> None:
        self.write_snapshot(self.book(long=3, short=-3))
        self.place(*self.closing(quantity=2), order_id=7)
        self.assert_place_refused(*self.closing(quantity=1), "close_already_working", order_id=8)
        self.assert_place_refused(self.short_leg, v2.order("BUY", 1), None, "close_already_working", order_id=8)
        self.assert_place_refused(self.long_leg, v2.order("SELL", 1), None, "close_already_working", order_id=8)
        self.client.orderStatus(7, "Filled", Decimal(2), Decimal(0))
        self.later_snapshot(self.book(long=1, short=-1))
        self.assert_place_refused(*self.closing(quantity=2), "exceeds_held_quantity", order_id=8)
        self.place(*self.closing(quantity=1), order_id=8)
        self.assertEqual(
            {item["key"] for item in self.stored_reservations()},
            {f"21:8/{self.long_leg.conId}", f"21:8/{self.short_leg.conId}"},
        )
        self.assertEqual(len(self.client.placed), 2)

    def test_a_closing_whatif_reserves_nothing(self) -> None:
        self.write_snapshot(self.book())
        self.place(*self.closing(whatIf=True), order_id=1)
        self.assertFalse(self.reservations.exists())
        self.assert_place_refused(*self.closing(quantity=3, whatIf=True), "exceeds_held_quantity", order_id=2)
        self.place(*self.closing(), order_id=3)
        self.assert_place_refused(*self.closing(whatIf=True), "close_already_working", order_id=4)
        self.assertEqual(len(self.client.placed), 2)

    def test_a_modify_of_the_closing_bag_keeps_its_reservations(self) -> None:
        self.write_snapshot(self.book())
        self.place(*self.closing(quantity=2, limit=-70.0), order_id=7)
        self.place(*self.closing(quantity=1, limit=-69.5), order_id=7)
        stored = self.stored_reservations()
        self.assertEqual(len(stored), 2)
        self.assertEqual({Decimal(item["quantity"]) for item in stored}, {Decimal(2)})  # the larger quantity stays
        self.assertEqual(len(self.client.placed), 2)

    def test_order_ids_are_not_shared_between_combo_closes_single_closes_and_openings(self) -> None:
        book = [
            self.held(2, 120, cost=900.0),
            self.held(-2, 200, cost=300.0),
            self.held(1, 50, symbol="KO", cost=100.0),
            self.held(1, 60, symbol="PEP", cost=100.0),
        ]
        self.write_snapshot(book)
        ko, pep = self.leg(50, symbol="KO"), self.leg(60, symbol="PEP")
        self.place(*self.closing(), order_id=7)
        # A single-leg close of another contract under the combo's id.
        self.assert_place_refused(ko, v2.order("SELL", 1), None, "order_id_reused", order_id=7)
        # An opening order under the combo's id.
        self.assert_place_refused(*self.debit_call(5, symbol="MSFT"), "order_id_reused", order_id=7)
        self.assert_place_refused(*self.long_call(5, symbol="MSFT"), "order_id_reused", order_id=7)
        self.assertEqual(len(self.stored_reservations()), 2)
        # A closing combo under the id of a single-leg close, or of a working opening order.
        arm_gate._order_outcomes.clear()
        self.reservations.unlink()
        self.place(pep, v2.order("SELL", 1), order_id=8)
        self.assert_place_refused(*self.closing(), "order_id_reused", order_id=8)
        self.place(*self.debit_call(5, symbol="MSFT"), order_id=9)
        self.assert_place_refused(*self.closing(), "order_id_reused", order_id=9)
        # A single-leg close under the id of a working opening order.
        self.assert_place_refused(ko, v2.order("SELL", 1), None, "order_id_reused", order_id=9)
        self.assert_place_refused(self.short_leg, v2.order("BUY", 1), None, "order_id_reused", order_id=9)
        self.place(*self.closing(), order_id=10)
        self.place(ko, v2.order("SELL", 1), order_id=11)
        self.assertEqual(len(self.client.placed), 5)

    def test_a_held_leg_of_an_unproven_class_refuses_the_close(self) -> None:
        self.write_snapshot(self.book(), classes=False)
        self.assert_refused(*self.closing(), "trading_class_unverifiable")


# -- 7b. place_order asks IBKR for the legs ---------------------------------------------


class LegQualificationTest(V3TestCase):
    def credit_spread(self, **order_extra):
        """BUY the 105 call, SELL the 100 call for a 1.50 credit: max loss (5 - 1.50) x 100 = 350 USD."""

        contract, legs = vertical(self.leg(105), self.leg(100))
        return contract, v2.order("BUY", 1, lmtPrice=-1.50, **order_extra), legs

    def refused(self, client, code: str, legs_known: bool = True) -> None:
        contract, order_, legs = self.credit_spread()
        with self.assertRaises(arm_gate.OrderPolicyError) as caught:
            if legs_known:
                self.place(contract, order_, legs, client=client)
            else:
                arm_gate.place_order(client, 7, contract, order_, source=SOURCE, legs=legs)
        self.assertEqual(caught.exception.code, code, str(caught.exception))
        self.assertEqual(client.placed, [])
        self.assertIsNone(self.ledger())
        self.assertFalse(self.reservations.exists())

    def test_place_order_asks_ibkr_for_each_leg_before_it_sends(self) -> None:
        self.write_snapshot([])
        contract, order_, legs = self.credit_spread()
        self.place(contract, order_, legs)
        self.assertEqual(self.client.placed, [(7, contract, order_)])
        self.assertCountEqual([item for _, item in self.client.detail_requests], legs)
        # A whatIf preflight asks too; every request has its own id.
        self.place(contract, v2.order("BUY", 1, lmtPrice=-1.50, whatIf=True), legs, order_id=8)
        ids = [request_id for request_id, _ in self.client.detail_requests]
        self.assertEqual((len(ids), len(set(ids))), (4, 4))
        self.assertTrue(all(request_id >= QUALIFY_REQUEST_BASE for request_id in ids))
        self.assertEqual(self.client.own_callbacks, [])  # the gate's answers never reach the client's callbacks
        self.assertEqual(Decimal(self.ledger()[0]["max_loss"]), Decimal(350))

    def test_the_clients_own_contract_details_still_reach_it(self) -> None:
        self.write_snapshot([])
        contract, order_, legs = self.credit_spread()
        self.place(contract, order_, legs)
        self.client.contractDetails(42, SimpleNamespace(contract=legs[0]))
        self.client.contractDetailsEnd(42)
        self.client.error(43, 200, "No security definition has been found for the request")
        self.client.error(-1, 2104, "Market data farm connection is OK")
        self.assertEqual(
            self.client.own_callbacks,
            [("contractDetails", 42), ("contractDetailsEnd", 42), ("error", 43), ("error", -1)],
        )
        self.place(contract, order_, legs)  # a modify: wrapped once, asked again
        self.assertEqual(len(self.client.own_callbacks), 4)
        self.assertEqual(len(self.client.detail_requests), 4)

    def test_ibkrs_contract_decides_not_the_callers(self) -> None:
        self.write_snapshot([])
        contract, order_, legs = self.credit_spread()
        # The caller says the bought call is the 105 strike. IBKR knows this conId as the 150 strike:
        # the spread could lose (50 - 1.50) x 100 = 4,850 USD, not 350.
        self.client.known[legs[0].conId] = SimpleNamespace(**{**vars(legs[0]), "strike": 150.0})
        self.assert_place_refused(contract, order_, legs, "combo_leg_mismatch")
        self.assertEqual(self.client.placed, [])
        self.assertIsNone(self.ledger())
        [event] = self.audit_events("order_refused")
        self.assertEqual((event["error"], event["sec_type"]), ("combo_leg_mismatch", "BAG"))
        self.assertIn("strike", event["detail"])
        # A dry check has no client: it reads the caller's legs and says so.
        result = self.assert_accepted(contract, order_, legs, 350)
        self.assertIn(arm_gate.LEGS_NOT_QUALIFIED_NOTE, result["notes"])

    def test_any_field_that_differs_from_ibkrs_contract_refuses_the_order(self) -> None:
        self.write_snapshot([])
        for field, value in (
            ("strike", 150.0),
            ("lastTradeDateOrContractMonth", self.exp(80)),
            ("right", "P"),
            ("multiplier", "10"),
            ("tradingClass", "AAPL1"),
            ("currency", "EUR"),
            ("symbol", "MSFT"),
            ("secType", "FOP"),
            ("conId", 999_999),
        ):
            for index in (0, 1):
                with self.subTest(field=field, leg=index):
                    client = QualifyingClient()
                    legs = self.credit_spread()[2]
                    client.known[legs[index].conId] = SimpleNamespace(**{**vars(legs[index]), field: value})
                    self.refused(client, "combo_leg_mismatch")
                    self.assertEqual(len(client.detail_requests), 2)

    def test_the_same_contract_in_ibkrs_spelling_is_no_mismatch(self) -> None:
        self.write_snapshot([])
        contract, legs = vertical(self.leg(105, "CALL"), self.leg(100, "CALL"))
        for item in legs:
            self.client.known[item.conId] = SimpleNamespace(
                **{
                    **vars(item),
                    "right": "C",
                    "strike": float(item.strike),
                    "multiplier": 100,
                    "exchange": "CBOE",
                    "lastTradeDateOrContractMonth": f"{self.near} 15:00:00",
                }
            )
        order_ = v2.order("BUY", 1, lmtPrice=-1.50)
        self.place(contract, order_, legs)
        self.assertEqual(self.client.placed, [(7, contract, order_)])  # the caller's BAG goes out
        [entry] = self.ledger()
        self.assertEqual((entry["expiry"], Decimal(entry["max_loss"])), (self.near, Decimal(350)))

    def test_answers_that_do_not_name_one_contract_refuse_the_order(self) -> None:
        self.write_snapshot([])
        for answer in ("error", "nothing listed", "two contracts", "raise"):
            with self.subTest(answer=answer):
                client = QualifyingClient()
                client.answer = answer
                self.refused(client, "combo_legs_unqualified")
                self.assertEqual([item for item in client.own_callbacks if item[1] >= QUALIFY_REQUEST_BASE], [])
        with self.subTest(answer="IBKR does not know the conId"):
            self.refused(QualifyingClient(), "combo_legs_unqualified", legs_known=False)
        with self.subTest(answer="the client cannot ask"):
            self.refused(v2.FakeClient(), "combo_legs_unqualified")
        self.assertEqual({item["error"] for item in self.audit_events("order_refused")}, {"combo_legs_unqualified"})

    def test_one_contract_listed_once_per_exchange_is_accepted(self) -> None:
        self.write_snapshot([])
        self.client.answer = "once per exchange"
        self.place(*self.credit_spread())
        self.assertEqual(len(self.client.placed), 1)

    def test_no_answer_before_the_timeout_refuses_the_order(self) -> None:
        self.write_snapshot([])
        self.client.answer = "silence"
        with self.environ(**{LEG_TIMEOUT_ENV: "0.2"}):
            started = time.monotonic()
            self.refused(self.client, "combo_legs_unqualified")
            waited = time.monotonic() - started
        self.assertGreaterEqual(waited, 0.15)
        self.assertLess(waited, 1.5)
        # The next order is asked afresh.
        self.client.answer = "known"
        self.place(*self.credit_spread())
        self.assertEqual(len(self.client.placed), 1)

    def test_only_bag_orders_of_an_armed_gate_with_the_switch_on_ask_ibkr(self) -> None:
        self.write_snapshot([self.held(2, 300, cost=100.0)])
        self.place(*self.long_call(5), order_id=1)
        self.place(self.leg(300), v2.order("SELL", 1), order_id=2)
        with self.flag(None):
            self.assert_place_refused(*self.credit_spread(), "combo_refused", order_id=3)
        self.client.connected = False
        self.assert_place_refused(*self.credit_spread(), "client_not_connected", order_id=3)
        self.client.connected = True
        self.gate.disarm(actor="owner", reason="leg qualification test")
        with self.assertRaises(arm_gate.DisarmedError):
            self.place(*self.credit_spread(), order_id=3)
        self.assertEqual(self.client.detail_requests, [])
        self.assertEqual(len(self.client.placed), 2)

    def test_a_closing_bag_is_qualified_too(self) -> None:
        self.write_snapshot([self.held(2, 120, cost=900.0), self.held(-2, 200, cost=300.0)])
        long_leg, short_leg = self.leg(120), self.leg(200)
        contract, legs = vertical(short_leg, long_leg)
        order_ = v2.order("BUY", 2, lmtPrice=-6.0)
        self.client.known[long_leg.conId] = SimpleNamespace(**{**vars(long_leg), "strike": 125.0})
        self.assert_place_refused(contract, order_, legs, "combo_leg_mismatch")
        self.assertFalse(self.reservations.exists())
        del self.client.known[long_leg.conId]
        self.place(contract, order_, legs)
        self.assertEqual(len(self.stored_reservations()), 2)


# -- 8. dry transmit path ------------------------------------------------------------


class DryTransmitTest(V3TestCase):
    def samples(self) -> dict[str, tuple]:
        """Three sample spreads: (BAG, order, legs, max loss USD)."""

        bull_call = vertical(self.leg(200), self.leg(205))
        bear_call = vertical(self.leg(205), self.leg(200))
        bull_put = vertical(self.leg(195, "P"), self.leg(200, "P"))
        return {
            "bull call debit": (bull_call[0], v2.order("BUY", 1, lmtPrice=1.50), bull_call[1], "150"),
            "bear call credit": (bear_call[0], v2.order("BUY", 2, lmtPrice=-1.50), bear_call[1], "700"),
            "bull put credit": (bull_put[0], v2.order("BUY", 3, lmtPrice=-0.35), bull_put[1], "1395"),  # 4.65 x 300
        }

    def assert_nothing_happened(self) -> None:
        self.assertEqual(self.client.placed, [])
        self.assertEqual(self.client.cancelled, [])
        self.assertEqual(self.client.detail_requests, [])  # a disarmed gate and a dry check ask IBKR nothing
        self.assertIsNone(self.ledger())
        self.assertFalse(self.reservations.exists())

    def test_a_fault_inside_the_policy_is_a_named_refusal_and_never_an_accept(self) -> None:
        self.write_snapshot([])
        contract, order_, legs, _ = self.samples()["bull call debit"]
        with mock.patch.object(arm_gate, "_evaluate_order", side_effect=RuntimeError("fault")):
            result = self.preview(contract, order_, legs)
        self.assertEqual(result["policy_decision"], "refused")
        self.assertEqual(result["policy_refusal"], "policy_error")
        self.assertEqual(result["policy_refusal_detail"], "RuntimeError")
        self.assertEqual(result["transmit_refusal"], "policy_error")
        self.assertIs(result["would_transmit"], False)
        self.assertNotIn("allowance", result)
        self.assert_nothing_happened()

    def test_accepted_by_the_policy_and_refused_by_the_disarmed_engine(self) -> None:
        self.write_snapshot([])
        self.gate.disarm(actor="owner", reason="dry transmit test")
        events_before = len(self.audit_events())
        for name, (contract, order_, legs, max_loss) in self.samples().items():
            with self.subTest(spread=name):
                self.assertEqual(self.check(contract, order_, legs), "vertical_spread_open")
                result = self.preview(contract, order_, legs)
                self.assertCountEqual(result.pop("notes"), dry_spread_notes())
                self.assertEqual(
                    result,
                    {
                        "order_policy": "options_only_defined_risk_v3",
                        "allow_defined_risk_spreads": True,
                        "allow_defined_risk_spreads_detail": LINK,
                        "engine_state": "disarmed",
                        "engine_detail": "no_arm_record",
                        "policy_decision": "accepted",
                        "allowance": "vertical_spread_open",
                        "max_loss_usd": max_loss,
                        "would_transmit": False,
                        "transmit_refusal": "engine_disarmed",
                    },
                )
                with self.assertRaises(arm_gate.DisarmedError) as caught:
                    self.place(contract, order_, legs)
                self.assertNotIsInstance(caught.exception, arm_gate.OrderPolicyError)
                self.assertEqual(caught.exception.code, "engine_disarmed")
                self.assertIn("disarmed", str(caught.exception))
        self.assert_nothing_happened()
        self.assertEqual(len(self.audit_events()), events_before)  # a preview leaves no audit line

    def test_the_policy_refusal_is_the_named_reason_while_disarmed(self) -> None:
        self.write_snapshot([])
        self.gate.disarm(actor="owner", reason="dry transmit test")
        contract, order_, legs, _ = self.samples()["bull call debit"]
        for change, code in (
            ({"orderType": "MKT"}, "order_type_refused"),
            ({"lmtPrice": -1.50}, "spread_limit_implausible"),
            ({"lmtPrice": 4.01, "totalQuantity": 5}, "max_loss_exceeded"),
            ({"smartComboRoutingParams": [SimpleNamespace(tag="NonGuaranteed", value="1")]}, "combo_non_guaranteed_refused"),
        ):
            with self.subTest(code=code):
                changed = SimpleNamespace(**{**vars(order_), **change})
                result = self.preview(contract, changed, legs)
                self.assertEqual(
                    (result["policy_decision"], result["policy_refusal"], result["transmit_refusal"]),
                    ("refused", code, code),
                )
                self.assertEqual(result["engine_state"], "disarmed")
                self.assertFalse(result["would_transmit"])
                self.assertTrue(result["policy_refusal_detail"])
                self.assertNotIn("max_loss_usd", result)
        with self.flag(None):
            result = self.preview(contract, order_, legs)
            self.assertEqual((result["policy_refusal"], result["transmit_refusal"]), ("combo_refused", "combo_refused"))
            self.assertIs(result["allow_defined_risk_spreads"], False)
        self.assert_nothing_happened()

    def test_every_disarmed_state_names_engine_disarmed(self) -> None:
        self.write_snapshot([])
        contract, order_, legs, _ = self.samples()["bull call debit"]
        self.kill_switch.write_text("stop")
        result = self.preview(contract, order_, legs)
        self.assertEqual(
            (result["engine_state"], result["engine_detail"], result["transmit_refusal"]),
            ("disarmed", "kill_switch_active", "engine_disarmed"),
        )
        self.kill_switch.unlink()
        result = self.preview(contract, order_, legs)  # removing the kill switch does not re-arm
        self.assertEqual((result["engine_detail"], result["transmit_refusal"]), ("no_arm_record", "engine_disarmed"))
        arm_gate.configure(None)
        result = self.preview(contract, order_, legs)
        self.assertEqual(
            (result["engine_state"], result["engine_detail"], result["policy_decision"], result["transmit_refusal"]),
            ("disarmed", "gate_not_configured", "accepted", "engine_disarmed"),
        )
        with self.assertRaises(arm_gate.DisarmedError):
            self.place(contract, order_, legs)
        other = arm_gate.ArmGate(self.armed_path, "img-2", kill_switch_path=self.kill_switch, audit_path=self.audit)
        self.gate.arm(actor="owner", reason=v2.REASON, confirm_image_version="img-1")
        result = self.preview(contract, order_, legs, status=other.status())
        self.assertEqual(
            (result["engine_detail"], result["would_transmit"], result["transmit_refusal"]),
            ("image_version_changed", False, "engine_disarmed"),
        )
        self.assert_nothing_happened()

    def test_armed_the_preview_would_transmit_and_still_writes_nothing(self) -> None:
        self.write_snapshot([])
        for name, (contract, order_, legs, max_loss) in self.samples().items():
            with self.subTest(spread=name):
                result = self.preview(contract, order_, legs)
                self.assertEqual(
                    (result["engine_state"], result["engine_detail"], result["would_transmit"], result["transmit_refusal"]),
                    ("armed", "armed", True, None),
                )
                self.assertEqual(result["max_loss_usd"], max_loss)
        self.assert_nothing_happened()

    def test_a_dry_check_of_an_accepted_bag_says_the_legs_are_the_callers(self) -> None:
        # No client, so nobody asked IBKR for the legs: every accepted BAG dry check says so.
        self.write_snapshot([self.held(2, 120, cost=300.0), self.held(-2, 130, cost=100.0)])
        note = arm_gate.LEGS_NOT_QUALIFIED_NOTE
        self.assertIn("place_order asks IBKR", note)
        for name, (contract, order_, legs, _) in self.samples().items():
            with self.subTest(spread=name):
                self.assertIn(note, self.preview(contract, order_, legs)["notes"])
        closing, legs = vertical(self.leg(130), self.leg(120))
        result = self.preview(closing, v2.order("BUY", 2, lmtPrice=-9.0), legs)
        self.assertEqual(result["allowance"], "vertical_spread_close")
        self.assertIn(note, result["notes"])

    def test_the_early_assignment_note_is_on_opening_spreads_only(self) -> None:
        note = arm_gate.EARLY_ASSIGNMENT_NOTE
        for phrase in ("short leg", "assigned early", "long leg", "bounds the loss", "shares"):
            self.assertIn(phrase, note)
        self.write_snapshot([self.held(2, 120, cost=300.0), self.held(-2, 130, cost=100.0)])
        for name, (contract, order_, legs, _) in self.samples().items():
            with self.subTest(spread=name):
                self.assertCountEqual(self.preview(contract, order_, legs)["notes"], dry_spread_notes())
        contract, order_, _ = self.long_call(500)
        result = self.preview(contract, order_)
        self.assertEqual((result["allowance"], result["max_loss_usd"], result["notes"]), ("long_option_open", "500", []))
        closing, legs = vertical(self.leg(130), self.leg(120))
        result = self.preview(closing, v2.order("BUY", 2, lmtPrice=-9.0), legs)
        self.assertEqual((result["allowance"], result["max_loss_usd"]), ("vertical_spread_close", None))
        self.assertNotIn(note, result["notes"])
        result = self.preview(self.leg(130), v2.order("BUY", 2))
        self.assertEqual((result["allowance"], result["max_loss_usd"], result["notes"]), ("position_close", None, []))


# -- 9. property test ------------------------------------------------------------------

PROPERTY_SEED = 20261111
PROPERTY_CASES = 4000
PROPERTY_NAMES = ("AAA", "BBB", "CCC")
# Order strikes are multiples of 2.5; held strikes never are, so an order never
# touches a held contract and every accepted order is an opening order.
ORDER_STRIKES = tuple(50 + 2.5 * step for step in range(41))
HELD_STRIKES = tuple(51 + 5 * step for step in range(20))
HELD_DAYS = (30, 200, 364, 365, 600)
PER_ORDER_PCT, NAME_SHORT_PCT, NAME_ALL_PCT, TOTAL_PCT = 2, 2, 6, 10
CAP_CODES = (
    "expiry_passed",
    "max_loss_exceeded",
    "name_short_dated_cap_exceeded",
    "name_risk_cap_exceeded",
    "total_risk_cap_exceeded",
)


def printed(value) -> Decimal:
    """The number as it prints (a float's repr): what the policy must compute with."""

    return Decimal(repr(value)) if isinstance(value, float) else Decimal(str(value))


def generate_case(rng: random.Random, today: date) -> dict:
    """One random account (NLV, simple held book, ledger) and one random order.

    The book holds, per (name, expiry), either one long option position or one
    well-formed vertical, so its risk has a closed form the test computes itself.
    """

    day = lambda days: today + timedelta(days=days)  # noqa: E731
    text = lambda when: when.strftime("%Y%m%d")  # noqa: E731
    nlv = rng.choice((50_000, 100_000, 250_000, 1_000_000))

    positions: list[dict] = []
    book: list[tuple[str, date, Decimal]] = []
    groups = [(name, days) for name in PROPERTY_NAMES for days in HELD_DAYS]
    for name, days in rng.sample(groups, rng.choice((0, 0, 0, 1, 1, 2, 3, 5, 7))):
        expiry = day(days)
        multiplier = rng.choice((1, 10, 100, 100))
        quantity = rng.randint(1, 4)
        fields = {"symbol": name, "expiry": text(expiry), "multiplier": str(multiplier)}
        if rng.random() < 0.5:
            # A long option: it can lose what it cost.
            cost = round(rng.uniform(0.0005, 0.035) * nlv / quantity, 2)
            positions.append(held(quantity, rng.choice(HELD_STRIKES), rng.choice("CP"), cost=cost, **fields))
            book.append((name, expiry, quantity * printed(cost)))
            continue
        right = rng.choice("CP")
        index = rng.randrange(len(HELD_STRIKES) - 3)
        low, high = HELD_STRIKES[index], HELD_STRIKES[index + rng.randint(1, 3)]
        width = high - low
        cheap = rng.randint(1, 300)  # cents per share
        net = rng.randint(1, width * 100 - 1)  # 0 < net < width
        cost_cheap, cost_dear = cheap * multiplier / 100, (cheap + net) * multiplier / 100
        dear, other = (low, high) if right == "C" else (high, low)  # the option worth more
        paid = printed(cost_dear) - printed(cost_cheap)
        if rng.random() < 0.5:
            # Debit vertical (long the dearer option): it can lose the net debit.
            positions += [
                held(quantity, dear, right, cost=cost_dear, **fields),
                held(-quantity, other, right, cost=cost_cheap, **fields),
            ]
            book.append((name, expiry, quantity * paid))
        else:
            # Credit vertical (short the dearer option): it can lose the width less the net credit.
            positions += [
                held(-quantity, dear, right, cost=cost_dear, **fields),
                held(quantity, other, right, cost=cost_cheap, **fields),
            ]
            book.append((name, expiry, quantity * (width * multiplier - paid)))
    rng.shuffle(positions)

    ledger: list[dict] = []
    working: list[tuple[str, date, Decimal]] = []
    for slot in range(rng.choice((0, 0, 0, 1, 1, 2, 3))):
        name = rng.choice(PROPERTY_NAMES)
        days = rng.choice((30, 200, 364, 365, 600, 0, -5))
        amount = Decimal(rng.randint(1, nlv * 2)) / 100  # up to 2% of NLV
        ledger.append(ledger_entry(900 + slot, name, text(day(days)), amount))
        if days >= 0:  # an entry whose expiry passed days ago no longer counts
            working.append((name, day(days), amount))

    name = rng.choice(PROPERTY_NAMES)
    days = rng.choices((30, 200, 364, 365, 600, 0, -3), weights=(30, 10, 8, 10, 30, 3, 4))[0]
    multiplier = rng.choice((1, 10, 100, 100))
    quantity: float | int | Decimal = rng.randint(1, 10)
    order_type = "LMT" if rng.random() < 0.97 else "MKT"
    case = {
        "nlv": nlv,
        "positions": positions,
        "book": book,
        "ledger": ledger,
        "working": working,
        "name": name,
        "expiry": day(days),
        "multiplier": multiplier,
        "order_type": order_type,
    }
    if rng.random() < 0.2:
        action = "BUY" if rng.random() < 0.93 else "SELL"
        limit = round(rng.uniform(0.01, 0.03 * nlv / (quantity * multiplier)), 2)
        contract = leg(
            rng.choice(ORDER_STRIKES), rng.choice("CP"), symbol=name, expiry=text(day(days)), multiplier=str(multiplier), conId=1
        )
        order_ = v2.order(action, rng.choice((quantity, Decimal(quantity))), lmtPrice=limit, orderType=order_type)
        return {**case, "kind": "long", "contract": contract, "order": order_, "legs": None, "action": action,
                "quantity": quantity, "limit": limit}

    index = rng.randrange(len(ORDER_STRIKES))
    step = rng.choice((1, 1, 2, 2, 4, 8)) * rng.choice((1, -1))
    other_index = index if rng.random() < 0.03 else min(max(index + step, 0), len(ORDER_STRIKES) - 1)
    strikes = (ORDER_STRIKES[index], ORDER_STRIKES[other_index])
    right = rng.choice("CP")
    rights = (right, right if rng.random() >= 0.03 else "CP".replace(right, ""))
    multipliers = (
        multiplier,
        multiplier if rng.random() >= 0.03 else rng.choice([item for item in (1, 10, 100) if item != multiplier]),
    )
    expiries = (day(days), day(days) if rng.random() >= 0.03 else day(days + 28))
    names = (name, name if rng.random() >= 0.02 else rng.choice([item for item in PROPERTY_NAMES if item != name]))
    if rng.random() < 0.9:
        sides = rng.choice((("BUY", "SELL"), ("SELL", "BUY")))
    else:
        sides = rng.choice((("BUY", "BUY"), ("SELL", "SELL")))
    ratios = (1, 1) if rng.random() < 0.95 else rng.choice(((1, 2), (2, 1), (2, 2)))
    action = rng.choice(("BUY", "SELL"))
    if rng.random() < 0.02:
        quantity += 0.5
    elif rng.random() < 0.5:
        quantity = Decimal(quantity)
    width = abs(strikes[0] - strikes[1]) or 5.0
    limit = 0.0 if rng.random() < 0.03 else round(rng.uniform(0.01, width * 1.15), 2) * rng.choice((1, -1))
    legs = [
        leg(strikes[n], rights[n], symbol=names[n], expiry=text(expiries[n]), multiplier=str(multipliers[n]), conId=n + 1)
        for n in (0, 1)
    ]
    contract = bag(*(combo_leg(legs[n], sides[n], ratios[n]) for n in (0, 1)), symbol=name)
    order_ = v2.order(action, quantity, lmtPrice=limit, orderType=order_type)
    return {**case, "kind": "vertical", "contract": contract, "order": order_, "legs": legs, "action": action,
            "quantity": quantity, "limit": limit, "strikes": strikes, "rights": rights, "multipliers": multipliers,
            "expiries": expiries, "names": names, "sides": sides, "ratios": ratios}


def expected_outcome(case: dict, today: date) -> dict:
    """The rules applied by hand: is it a supported opening order, its max loss, and the exposure."""

    quantity, limit = printed(case["quantity"]), printed(case["limit"])
    if case["kind"] == "long":
        if case["action"] != "BUY" or case["order_type"] != "LMT" or limit <= 0:
            return {"supported": False}
        kind, loss = "long", limit * case["multiplier"] * quantity  # the premium
    else:
        same = lambda field: case[field][0] == case[field][1]  # noqa: E731
        if (
            case["ratios"] != (1, 1)
            or sorted(case["sides"]) != ["BUY", "SELL"]
            or not (same("names") and same("expiries") and same("rights") and same("multipliers"))
            or same("strikes")
            or quantity != int(quantity)
            or case["order_type"] != "LMT"
        ):
            return {"supported": False}
        # A SELL of the BAG reverses both legs and the sign of the net price.
        buys_first = (case["sides"][0] == "BUY") == (case["action"] == "BUY")
        bought, sold = case["strikes"] if buys_first else case["strikes"][::-1]
        net_debit = limit if case["action"] == "BUY" else -limit
        width = abs(printed(bought) - printed(sold))
        if (bought < sold) == (case["rights"][0] == "C"):  # the bought leg is worth more
            if not 0 < net_debit < width:
                return {"supported": False}
            kind, loss = "debit", net_debit * case["multiplier"] * quantity
        else:
            if not 0 < -net_debit < width:
                return {"supported": False}
            kind, loss = "credit", (width + net_debit) * case["multiplier"] * quantity

    nlv, name, expiry = Decimal(case["nlv"]), case["name"], case["expiry"]
    short_dated = lambda when: (when - today).days < 365  # noqa: E731
    counted = [*case["book"], *case["working"]]
    exposure = {
        "name_short_dated": loss + sum(risk for held_name, when, risk in counted if held_name == name and short_dated(when)),
        "name_all_expiries": loss + sum(risk for held_name, _, risk in counted if held_name == name),
        "total": loss + sum(risk for _, _, risk in counted),
    }
    caps = {
        "per_order": nlv * PER_ORDER_PCT / 100,
        "name_short_dated": nlv * NAME_SHORT_PCT / 100,
        "name_all_expiries": nlv * NAME_ALL_PCT / 100,
        "total": nlv * TOTAL_PCT / 100,
    }
    broken = set()
    if expiry < today:
        broken.add("expiry_passed")
    if loss > caps["per_order"]:
        broken.add("max_loss_exceeded")
    if short_dated(expiry) and exposure["name_short_dated"] > caps["name_short_dated"]:
        broken.add("name_short_dated_cap_exceeded")
    if exposure["name_all_expiries"] > caps["name_all_expiries"]:
        broken.add("name_risk_cap_exceeded")
    if exposure["total"] > caps["total"]:
        broken.add("total_risk_cap_exceeded")
    return {
        "supported": True,
        "kind": kind,
        "loss": loss,
        "exposure": exposure,
        "caps": caps,
        "broken": broken,
        "short_dated": short_dated(expiry),
    }


class PropertyTest(V3TestCase):
    def test_accepted_opening_orders_stay_within_every_cap(self) -> None:
        self.assertEqual((PER_ORDER_PCT, NAME_SHORT_PCT, NAME_ALL_PCT, TOTAL_PCT), (2, 2, 6, 10))
        rng = random.Random(PROPERTY_SEED)
        today, now = FIXED_TODAY, FIXED_NOW
        env = {**self.paths, FLAG_ENV: FLAG_ON}
        status = self.gate.status()
        accepted: Counter[str] = Counter()
        refused: Counter[str] = Counter()
        for number in range(PROPERTY_CASES):
            case = generate_case(rng, today)
            self.write_snapshot(case["positions"], nlv=case["nlv"], now=now)
            self.write_ledger(*case["ledger"])
            result = arm_gate.preview_order(
                case["contract"], case["order"], legs=case["legs"], order_id=7, client=self.client,
                env=env, now=now, status=status,
            )
            want = expected_outcome(case, today)
            where = f"case {number} (seed {PROPERTY_SEED}): order {vars(case['order'])} -> {result}"
            if result["policy_decision"] != "accepted":
                code = result["policy_refusal"]
                refused[code] += 1
                # Nothing the rules allow is refused, and a cap is only named when it is broken.
                self.assertTrue(not want["supported"] or want["broken"], where)
                if want["supported"]:
                    self.assertIn(code, want["broken"], where)
                else:
                    self.assertNotIn(code, CAP_CODES[1:], where)
                continue
            self.assertTrue(want["supported"], where)
            self.assertEqual(want["broken"], set(), where)
            allowance = "long_option_open" if case["kind"] == "long" else "vertical_spread_open"
            self.assertEqual(result["allowance"], allowance, where)
            reported = Decimal(result["max_loss_usd"])
            self.assertEqual(reported, want["loss"], where)
            self.assertGreater(reported, 0, where)
            self.assertLessEqual(reported, want["caps"]["per_order"], where)
            if want["short_dated"]:
                self.assertLessEqual(want["exposure"]["name_short_dated"], want["caps"]["name_short_dated"], where)
            self.assertLessEqual(want["exposure"]["name_all_expiries"], want["caps"]["name_all_expiries"], where)
            self.assertLessEqual(want["exposure"]["total"], want["caps"]["total"], where)
            self.assertGreaterEqual(case["expiry"], today, where)
            accepted[want["kind"]] += 1
            accepted["short-dated" if want["short_dated"] else "leaps"] += 1
        self.property_counts = (accepted, refused)
        # The generator is not degenerate.
        self.assertGreaterEqual(PROPERTY_CASES, 3000)
        self.assertEqual(sum(refused.values()) + accepted["short-dated"] + accepted["leaps"], PROPERTY_CASES)
        self.assertGreaterEqual(accepted["short-dated"] + accepted["leaps"], 100, accepted)
        self.assertGreaterEqual(sum(refused.values()), 100, refused)
        for kind in ("debit", "credit", "long", "short-dated", "leaps"):
            self.assertGreaterEqual(accepted[kind], 50, accepted)
        for code in (*CAP_CODES, "spread_limit_implausible", "combo_ratio_refused", "combo_not_one_long_one_short"):
            self.assertGreaterEqual(refused[code], 10, refused)
        self.assertEqual(self.client.placed, [])


# -- 10. owner tools --------------------------------------------------------------------


class OwnerToolsTest(V3TestCase):
    def sample(self, **order_extra):
        contract, legs = vertical(self.leg(200), self.leg(205))
        return contract, v2.order("BUY", 1, lmtPrice=1.50, **order_extra), legs

    def test_policy_prints_the_switch_and_the_caps(self) -> None:
        for argv in (("policy",), ("policy", "--json")):
            code, payload = self.run_tool(*argv)
            self.assertEqual(code, 0)
            self.assertEqual(payload["order_policy"], "options_only_defined_risk_v3")
            self.assertIs(payload["allow_defined_risk_spreads"], True)
            self.assertEqual(payload["allow_defined_risk_spreads_detail"], LINK)
            self.assertEqual(payload["open_risk_ledger_path"], str(self.reservations))
            self.assertEqual(payload["close_reservations_path"], str(self.reservations))
            self.assertEqual(payload["account_snapshot_dir"], str(self.reports))
            self.assertEqual(
                set(payload["spread_risk_caps"]),
                {"per_order", "name_short_dated", "name_all_expiries", "total_open_risk"},
            )
        for value, detail in (("", "off"), ("true", "off_invalid_value"), (LINK, "off_invalid_value")):
            code, payload = self.run_tool("policy", env={FLAG_ENV: value})
            self.assertEqual(
                (code, payload["allow_defined_risk_spreads"], payload["allow_defined_risk_spreads_detail"]),
                (0, False, detail),
            )
        code, payload = self.run_tool("policy", env={TOTAL_ENV: "5"})
        self.assertEqual((code, payload["spread_risk_caps"], payload["spread_risk_caps_error"]), (0, None, "risk_config_source_missing"))
        self.assertEqual(payload, arm_gate.order_policy_status({**self.paths, FLAG_ENV: FLAG_ON, TOTAL_ENV: "5"}))

    def test_open_risk_reports_percent_of_nlv_and_no_account_data(self) -> None:
        # AAPL: 1,000 USD held (5 x 200/205 debit spreads). MSFT: one LEAPS call for 2,500 USD.
        self.write_snapshot(
            [
                self.held(5, 200, cost=300.0),
                self.held(-5, 205, cost=100.0),
                self.held(1, 300, symbol="MSFT", expiry=self.leaps, cost=2500.0),
                v2.held_stock(100),
            ]
        )
        code, report = self.run_tool("open-risk", "--json")
        self.assertEqual(code, 0)
        self.assertEqual(
            report,
            {
                "net_liquidation_available": True,
                "working_opening_orders": [],
                "open_plus_working_risk_pct_by_name": {"AAPL": "1.00", "MSFT": "2.50"},
                "open_plus_working_risk_pct_total": "3.50",
            },
        )
        self.place(*self.debit_call(500), order_id=1)
        self.place(*self.debit_call(130, symbol="KO"), order_id=2)
        code, report = self.run_tool("open-risk")
        self.assertEqual(code, 0)
        self.assertEqual(report["open_plus_working_risk_pct_by_name"], {"AAPL": "1.50", "KO": "0.13", "MSFT": "2.50"})
        self.assertEqual(report["open_plus_working_risk_pct_total"], "4.13")  # 4,130 USD of 100,000
        self.assertEqual([item["key"] for item in report["working_opening_orders"]], ["21:1", "21:2"])
        first = report["working_opening_orders"][0]
        self.assertEqual((first["symbol"], first["resolved"], Decimal(first["max_loss"])), ("AAPL", False, Decimal(500)))
        self.assertNotIn(str(NLV), json.dumps(report))

    def test_open_risk_names_what_cannot_be_measured(self) -> None:
        self.write_snapshot([self.held(-1, 300, cost=200.0), self.held(1, 50, symbol="KO", cost=400.0)])
        code, report = self.run_tool("open-risk")
        self.assertEqual(
            (code, report["open_plus_working_risk_pct_by_name"], report["open_plus_working_risk_pct_total"]),
            (0, {"AAPL": "unbounded", "KO": "0.40"}, "unbounded"),
        )
        self.write_snapshot([self.held(-1, 300, cost=200.0), self.held(1, 50, symbol="KO")])
        code, report = self.run_tool("open-risk")
        self.assertEqual(
            (code, report["open_plus_working_risk_pct_by_name"], report["open_plus_working_risk_pct_total"]),
            (0, {"AAPL": "unbounded", "KO": "unknown"}, "unknown"),
        )
        self.write_snapshot([self.held(1, 50, symbol="KO", cost=400.0)], summary={})
        code, report = self.run_tool("open-risk")
        self.assertEqual(
            (code, report["net_liquidation_available"], report["open_plus_working_risk_pct_total"]),
            (0, False, "unknown"),
        )

    def test_open_risk_marks_resolved_entries_and_fails_closed(self) -> None:
        self.write_snapshot([])
        self.write_ledger(ledger_entry(900, "AAPL", self.exp(-30), 2000), ledger_entry(901, "MSFT", self.near, 700))
        code, report = self.run_tool("open-risk")
        self.assertEqual(code, 0)
        self.assertEqual(
            [(item["key"], item["resolved"]) for item in report["working_opening_orders"]],
            [("21:900", True), ("21:901", False)],
        )
        self.assertEqual(report["open_plus_working_risk_pct_by_name"], {"MSFT": "0.70"})
        self.assertEqual(report["open_plus_working_risk_pct_total"], "0.70")
        for path in self.reports.iterdir():
            path.unlink()
        code, payload = self.run_tool("open-risk")
        self.assertEqual((code, payload["error"]), (2, "snapshot_unavailable"))
        self.write_snapshot([], age=10_000.0)
        code, payload = self.run_tool("open-risk")
        self.assertEqual((code, payload["error"]), (2, "snapshot_stale"))

    def test_preview_of_an_accepted_order_names_the_disarmed_engine(self) -> None:
        self.write_snapshot([])
        # The tool reads the arm state from its environment; no arm record there.
        env = {"NAUTILUS_ARMED_PATH": str(self.tmp / "cli" / "ARMED")}
        for argv in (("preview",), ("preview", "--json")):
            code, payload = self.run_tool(*argv, stdin=spec_of(*self.sample()), env=env)
            self.assertEqual(code, 0)
            self.assertCountEqual(payload.pop("notes"), dry_spread_notes())
            self.assertEqual(
                payload,
                {
                    "order_policy": "options_only_defined_risk_v3",
                    "allow_defined_risk_spreads": True,
                    "allow_defined_risk_spreads_detail": LINK,
                    "engine_state": "disarmed",
                    "engine_detail": "no_arm_record",
                    "policy_decision": "accepted",
                    "allowance": "vertical_spread_open",
                    "max_loss_usd": "150",
                    "would_transmit": False,
                    "transmit_refusal": "engine_disarmed",
                },
            )
        # The arm record of this test's gate was written for another image version.
        code, payload = self.run_tool("preview", stdin=spec_of(*self.sample()))
        self.assertEqual(
            (code, payload["engine_detail"], payload["policy_decision"], payload["transmit_refusal"]),
            (0, "image_version_changed", "accepted", "engine_disarmed"),
        )
        self.assertEqual(self.client.placed, [])
        self.assertIsNone(self.ledger())
        self.assertTrue(self.armed_path.exists())  # the preview does not touch the arm record

    def test_preview_would_transmit_when_the_tools_gate_is_armed(self) -> None:
        self.write_snapshot([])
        env = {"NAUTILUS_IMAGE_VERSION": "img-cli", "NAUTILUS_ARMED_PATH": str(self.tmp / "cli" / "ARMED")}
        version = arm_gate.resolve_image_version(env)
        gate = arm_gate.ArmGate(env["NAUTILUS_ARMED_PATH"], version, kill_switch_path=self.kill_switch, audit_path=self.audit)
        gate.arm(actor="owner", reason=v2.REASON, confirm_image_version=version)
        code, payload = self.run_tool("preview", stdin=spec_of(*self.sample()), env=env)
        self.assertEqual(
            (code, payload["engine_state"], payload["would_transmit"], payload["transmit_refusal"]),
            (0, "armed", True, None),
        )
        self.assertEqual(self.client.placed, [])
        self.assertIsNone(self.ledger())

    def test_preview_with_the_switch_off_is_combo_refused(self) -> None:
        self.write_snapshot([])
        for value, detail in ((None, "off"), ("off", "off"), ("true", "off_invalid_value"), (LINK, "off_invalid_value")):
            with self.subTest(value=value), self.flag(value):
                code, payload = self.run_tool("preview", stdin=spec_of(*self.sample()))
                self.assertEqual(code, 0)
                self.assertEqual(
                    (payload["policy_decision"], payload["policy_refusal"], payload["transmit_refusal"]),
                    ("refused", "combo_refused", "combo_refused"),
                )
                self.assertEqual(
                    (payload["allow_defined_risk_spreads"], payload["allow_defined_risk_spreads_detail"]),
                    (False, detail),
                )
                self.assertFalse(payload["would_transmit"])

    def test_preview_names_the_policy_refusal(self) -> None:
        self.write_snapshot([self.held(2, 120, cost=300.0), self.held(-2, 130, cost=100.0)])
        contract, order_, legs = self.sample()
        routing = [SimpleNamespace(tag="NonGuaranteed", value="1")]
        ratio = bag(combo_leg(legs[0], "BUY"), combo_leg(legs[1], "SELL", 2))
        closing, closing_legs = vertical(self.leg(130), self.leg(120))
        for name, spec, expected in (
            ("non-guaranteed", spec_of(contract, SimpleNamespace(**vars(order_), smartComboRoutingParams=routing), legs),
             ("refused", "combo_non_guaranteed_refused")),
            ("ratio", spec_of(ratio, order_, legs), ("refused", "combo_ratio_refused")),
            ("no legs", spec_of(contract, order_, None), ("refused", "combo_legs_unverified")),
            ("market", spec_of(*self.sample(orderType="MKT")), ("refused", "order_type_refused")),
            ("per-leg prices", spec_of(*self.sample(orderComboLegs=[SimpleNamespace(price=1.0)])),
             ("refused", "combo_leg_prices_refused")),
            ("over the cap", spec_of(*self.debit_call("2000.01")), ("refused", "max_loss_exceeded")),
            ("closing", spec_of(closing, v2.order("BUY", 2, lmtPrice=-9.0), closing_legs), ("accepted", None)),
            ("long option", spec_of(*self.long_call(500)), ("accepted", None)),
        ):
            with self.subTest(case=name):
                code, payload = self.run_tool("preview", stdin=spec)
                self.assertEqual(code, 0)
                self.assertEqual((payload["policy_decision"], payload.get("policy_refusal")), expected)
                self.assertEqual(payload["transmit_refusal"], expected[1] or "engine_disarmed")
        self.assertFalse(self.reservations.exists())
        self.assertIsNone(self.ledger())

    def test_preview_input_that_is_no_order_exits_2(self) -> None:
        self.write_snapshot([])
        good = json.loads(spec_of(*self.sample()))
        for name, stdin in (
            ("not JSON", "{bad"),
            ("empty", ""),
            ("a list", "[]"),
            ("no contract", json.dumps({"order": good["order"]})),
            ("no order", json.dumps({"contract": good["contract"]})),
            ("contract is text", json.dumps({**good, "contract": "AAPL"})),
            ("legs is an object", json.dumps({**good, "legs": {"1": good["legs"][0]}})),
            ("a leg is text", json.dumps({**good, "legs": ["700001", "700002"]})),
            ("comboLegs is an object", json.dumps({**good, "contract": {**good["contract"], "comboLegs": {}}})),
            ("a comboLeg is a number", json.dumps({**good, "contract": {**good["contract"], "comboLegs": [1, 2]}})),
        ):
            with self.subTest(stdin=name):
                code, payload = self.run_tool("preview", stdin=stdin)
                self.assertEqual((code, payload["error"]), (2, "invalid_preview"))
                self.assertTrue(payload["detail"])


if __name__ == "__main__":
    unittest.main()
