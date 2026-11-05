"""IBKR account cash and position snapshot helpers."""

from __future__ import annotations

import hashlib
import hmac
import threading
import time
import re
from dataclasses import dataclass, field, replace
from typing import Any, Callable


ACCOUNT_SUMMARY_TAGS = (
    "AvailableFunds,BuyingPower,CashBalance,NetLiquidation,TotalCashValue"
)
# Written beside each snapshot as ibkr-account-classes.json (newest snapshot only).
CLASS_SIDECAR_SCHEMA = "ibkr-account-classes/v1"
CLASS_SIDECAR_NAME = "ibkr-account-classes.json"
# 2172 = "application version will be desupported" warning; informational, not a request failure.
IBKR_IGNORED_STATUS_CODES = {399, 2104, 2106, 2107, 2108, 2119, 2158, 2172}


def _opt_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _api_float(value: Any) -> float | None:
    parsed = _opt_float(value)
    if parsed is None or abs(parsed) > 1e100:
        return None
    return parsed


def _api_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class IbkrPosition:
    account: str
    symbol: str
    sec_type: str
    currency: str
    quantity: float
    average_cost: float
    contract: dict[str, Any] = field(default_factory=dict)
    market_price: float | None = None
    market_value: float | None = None
    unrealized_pnl: float | None = None
    realized_pnl: float | None = None
    # IBKR contract id; used only to join reqPositions rows with
    # updatePortfolio market values. Not part of the snapshot JSON shape.
    con_id: int = 0
    # IBKR tradingClass (SPX vs SPXW, adjusted classes). Not part of the
    # snapshot JSON shape; see IbkrAccountSnapshot.class_sidecar.
    trading_class: str = ""


@dataclass(frozen=True)
class IbkrAccountSnapshot:
    account: str
    summary: dict[str, dict[str, str]]
    positions: list[IbkrPosition]
    captured_at: float
    # "complete": every position has IBKR market values, or there are no
    #   positions and accountDownloadEnd arrived.
    # "partial": some positions have market values.
    # "unavailable": no position has market values (the account-updates stream
    #   did not deliver them in time). Quantities still come from reqPositions.
    market_values_status: str = "complete"

    @property
    def available_funds_usd(self) -> float | None:
        value = self.summary.get("AvailableFunds", {}).get("USD")
        if value is None:
            return None
        try:
            return float(value)
        except ValueError:
            return None

    def class_sidecar(self, snapshot_name: str) -> dict[str, Any]:
        """conId and tradingClass per position, in to_dict() position order.

        The v1 position shape is checked key for key (staged protection), so
        the order policy in arm_gate.py reads these from a file beside it.
        """
        return {
            "schemaVersion": CLASS_SIDECAR_SCHEMA,
            "snapshot": snapshot_name,
            "captured_at_epoch": self.captured_at,
            "positions": [
                {
                    "symbol": position.symbol,
                    "sec_type": position.sec_type,
                    "quantity": position.quantity,
                    "conId": position.con_id,
                    "tradingClass": position.trading_class,
                }
                for position in self.positions
            ],
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "account_masked": mask_account(self.account),
            "summary": self.summary,
            "positions": [
                {
                    "account_masked": mask_account(position.account),
                    "symbol": position.symbol,
                    "sec_type": position.sec_type,
                    "currency": position.currency,
                    "quantity": position.quantity,
                    "average_cost": position.average_cost,
                    "contract": position.contract,
                    "market_price": position.market_price,
                    "market_value": position.market_value,
                    "unrealized_pnl": position.unrealized_pnl,
                    "realized_pnl": position.realized_pnl,
                }
                for position in self.positions
            ],
            "available_funds_usd": self.available_funds_usd,
            "captured_at_epoch": self.captured_at,
            "market_values_status": self.market_values_status,
        }


@dataclass(frozen=True)
class IbkrOpenOrder:
    order_id: int
    account: str
    symbol: str
    sec_type: str
    exchange: str
    currency: str
    action: str
    order_type: str
    total_quantity: float | None
    limit_price: float | None
    aux_price: float | None
    tif: str
    status: str
    filled: float | None = None
    remaining: float | None = None
    avg_fill_price: float | None = None
    client_id: int | None = None
    warning_text: str = ""
    contract: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "order_id": self.order_id,
            "client_id": self.client_id,
            "account_masked": mask_account(self.account),
            "symbol": self.symbol,
            "sec_type": self.sec_type,
            "exchange": self.exchange,
            "currency": self.currency,
            "action": self.action,
            "order_type": self.order_type,
            "total_quantity": self.total_quantity,
            "limit_price": self.limit_price,
            "aux_price": self.aux_price,
            "tif": self.tif,
            "status": self.status,
            "filled": self.filled,
            "remaining": self.remaining,
            "avg_fill_price": self.avg_fill_price,
            "warning_text": sanitize_account_references(
                self.warning_text, self.account
            ),
            "contract": self.contract,
        }


@dataclass(frozen=True)
class IbkrOpenOrdersSnapshot:
    account: str
    orders: list[IbkrOpenOrder]
    captured_at: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "account_masked": mask_account(self.account),
            "orders": [order.to_dict() for order in self.orders],
            "open_orders": len(self.orders),
            "captured_at_epoch": self.captured_at,
        }


def account_fingerprint(account: str, key: str) -> str:
    normalized = str(account or "").strip().upper()
    secret = str(key or "")
    if not normalized or not secret:
        return ""
    return hmac.new(
        secret.encode("utf-8"),
        f"vertex-quant/ibkr-account/v1:{normalized}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def mask_account(account: str) -> str:
    account = str(account or "")
    if len(account) <= 4:
        return "****" if account else ""
    return f"{account[:1]}***{account[-4:]}"


def sanitize_account_references(detail: str, account_id: str = "") -> str:
    sanitized = str(detail or "")
    if account_id:
        sanitized = sanitized.replace(account_id, mask_account(account_id))
    return re.sub(r"\bU\d{4,}\b", lambda match: mask_account(match.group(0)), sanitized)


def _timeout_error(client: Any, message: str, account_id: str) -> TimeoutError:
    errors = _client_error_details(client, account_id)
    if errors:
        return TimeoutError(
            f"{message}; latest IBKR API errors: {'; '.join(errors[-5:])}"
        )
    return TimeoutError(message)


def _contract_to_dict(contract: Any) -> dict[str, Any]:
    return {
        "symbol": str(getattr(contract, "symbol", "") or ""),
        "sec_type": str(getattr(contract, "secType", "") or ""),
        "exchange": str(getattr(contract, "exchange", "") or ""),
        "currency": str(getattr(contract, "currency", "") or ""),
        "last_trade_date_or_contract_month": str(
            getattr(contract, "lastTradeDateOrContractMonth", "") or ""
        ),
        "strike": _api_float(getattr(contract, "strike", None)),
        "right": str(getattr(contract, "right", "") or ""),
        "multiplier": str(getattr(contract, "multiplier", "") or ""),
    }


def _client_error_details(client: Any, account_id: str) -> list[str]:
    return [
        sanitize_account_references(str(error), account_id)
        for error in getattr(client, "errors", [])
        if str(error)
    ]


def _raise_client_errors(client: Any, account_id: str, prefix: str) -> None:
    errors = _client_error_details(client, account_id)
    if errors:
        raise RuntimeError(f"{prefix}: {'; '.join(errors[-5:])}")


def _snapshot_contract_dict(contract: Any) -> dict[str, Any]:
    # Exact key set is part of the ibkr-account-snapshot/v1 position shape.
    return {
        "symbol": getattr(contract, "symbol", ""),
        "secType": getattr(contract, "secType", ""),
        "exchange": getattr(contract, "exchange", ""),
        "currency": getattr(contract, "currency", ""),
        "lastTradeDateOrContractMonth": getattr(
            contract, "lastTradeDateOrContractMonth", ""
        ),
        "strike": getattr(contract, "strike", 0),
        "right": getattr(contract, "right", ""),
        "multiplier": getattr(contract, "multiplier", ""),
    }


def _snapshot_position(
    contract: Any,
    account: str,
    quantity: Any,
    average_cost: Any,
    *,
    market_price: Any = None,
    market_value: Any = None,
    unrealized_pnl: Any = None,
    realized_pnl: Any = None,
) -> IbkrPosition:
    return IbkrPosition(
        account=account,
        symbol=str(getattr(contract, "symbol", "")),
        sec_type=str(getattr(contract, "secType", "")),
        currency=str(getattr(contract, "currency", "")),
        quantity=float(quantity),
        average_cost=float(average_cost),
        contract=_snapshot_contract_dict(contract),
        market_price=_opt_float(market_price),
        market_value=_opt_float(market_value),
        unrealized_pnl=_opt_float(unrealized_pnl),
        realized_pnl=_opt_float(realized_pnl),
        con_id=_api_int(getattr(contract, "conId", 0)) or 0,
        trading_class=str(getattr(contract, "tradingClass", "") or ""),
    )


def _account_matches(account: str, target_account: str) -> bool:
    if not target_account:
        return True
    return str(account or "").strip().upper() == str(target_account).strip().upper()


def _position_key(position: IbkrPosition) -> tuple[Any, ...]:
    if position.con_id:
        return ("conId", position.con_id)
    contract = position.contract
    return (
        "contract",
        position.symbol,
        position.sec_type,
        position.currency,
        str(contract.get("lastTradeDateOrContractMonth") or ""),
        _opt_float(contract.get("strike")) or 0.0,
        str(contract.get("right") or ""),
    )


def _merge_market_values(
    positions: list[IbkrPosition],
    portfolio: list[IbkrPosition],
    download_complete: bool,
) -> tuple[list[IbkrPosition], str]:
    """Add updatePortfolio market values to reqPositions rows.

    reqPositions is the source for quantity and average cost. Market values are
    optional: the account-updates stream can stall on some Gateway logins.
    """
    values = {_position_key(row): row for row in portfolio}
    merged: list[IbkrPosition] = []
    enriched = 0
    for position in positions:
        row = values.get(_position_key(position))
        if row is None:
            merged.append(position)
            continue
        enriched += 1
        merged.append(
            replace(
                position,
                market_price=row.market_price,
                market_value=row.market_value,
                unrealized_pnl=row.unrealized_pnl,
                realized_pnl=row.realized_pnl,
            )
        )
    if enriched == len(positions) and (positions or download_complete):
        status = "complete"
    elif enriched:
        status = "partial"
    else:
        status = "unavailable"
    return merged, status


def _open_order_from_payload(order_id: int, payload: dict[str, Any]) -> IbkrOpenOrder:
    return IbkrOpenOrder(
        order_id=order_id,
        client_id=_api_int(payload.get("client_id")),
        account=str(payload.get("account") or ""),
        symbol=str(payload.get("symbol") or ""),
        sec_type=str(payload.get("sec_type") or ""),
        exchange=str(payload.get("exchange") or ""),
        currency=str(payload.get("currency") or ""),
        action=str(payload.get("action") or ""),
        order_type=str(payload.get("order_type") or ""),
        total_quantity=_api_float(payload.get("total_quantity")),
        limit_price=_api_float(payload.get("limit_price")),
        aux_price=_api_float(payload.get("aux_price")),
        tif=str(payload.get("tif") or ""),
        status=str(payload.get("status") or ""),
        filled=_api_float(payload.get("filled")),
        remaining=_api_float(payload.get("remaining")),
        avg_fill_price=_api_float(payload.get("avg_fill_price")),
        warning_text=str(payload.get("warning_text") or ""),
        contract=dict(payload.get("contract") or {}),
    )


def _expected_contract_value(expected: dict[str, Any], *keys: str) -> Any:
    contract = expected.get("contract")
    if not isinstance(contract, dict):
        return None
    for key in keys:
        value = contract.get(key)
        if value not in (None, ""):
            return value
    return None


def _values_match(actual: Any, expected: Any) -> bool:
    if expected in (None, ""):
        return True
    if isinstance(expected, (int, float)):
        actual_number = _api_float(actual)
        return actual_number is not None and abs(actual_number - float(expected)) < 1e-9
    return str(actual or "") == str(expected)


def _assert_cancel_expected_order(
    order_id: int, payload: dict[str, Any], expected: dict[str, Any], account_id: str
) -> None:
    status = re.sub(r"[^a-z0-9]", "", str(payload.get("status") or "").lower())
    if status in {
        "cancelled",
        "canceled",
        "apicancelled",
        "apicanceled",
        "filled",
        "inactive",
    }:
        raise RuntimeError(f"IBKR order {int(order_id)} is no longer cancelable")
    remaining = _api_float(payload.get("remaining"))
    if remaining is not None and remaining <= 0:
        raise RuntimeError(f"IBKR order {int(order_id)} has no remaining quantity")
    checks = [
        ("client_id", payload.get("client_id"), expected.get("client_id")),
        ("symbol", payload.get("symbol"), expected.get("symbol")),
        ("sec_type", payload.get("sec_type"), expected.get("sec_type")),
        ("action", payload.get("action"), expected.get("action")),
        ("order_type", payload.get("order_type"), expected.get("order_type")),
        (
            "total_quantity",
            payload.get("total_quantity"),
            expected.get("total_quantity"),
        ),
        (
            "contract.last_trade_date_or_contract_month",
            _expected_contract_value(
                payload,
                "last_trade_date_or_contract_month",
                "lastTradeDateOrContractMonth",
            ),
            _expected_contract_value(
                expected,
                "last_trade_date_or_contract_month",
                "lastTradeDateOrContractMonth",
            ),
        ),
        (
            "contract.strike",
            _expected_contract_value(payload, "strike"),
            _expected_contract_value(expected, "strike"),
        ),
        (
            "contract.right",
            _expected_contract_value(payload, "right"),
            _expected_contract_value(expected, "right"),
        ),
    ]
    if expected.get("account_masked"):
        checks.append(
            (
                "account_masked",
                mask_account(str(payload.get("account") or "")),
                expected.get("account_masked"),
            )
        )
    if account_id:
        checks.append(("account", payload.get("account"), account_id))
    for field_name, actual, expected_value in checks:
        if not _values_match(actual, expected_value):
            raise RuntimeError(
                f"IBKR order {int(order_id)} no longer matches cached {field_name}"
            )


class IbkrAccountSnapshotClient:
    def __init__(
        self,
        host: str,
        port: int,
        client_id: int,
        account_id: str,
        *,
        timeout_seconds: float = 10.0,
        market_values_timeout_seconds: float | None = None,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.client_id = client_id
        self.account_id = account_id
        self.timeout_seconds = timeout_seconds
        self.market_values_timeout_seconds = (
            timeout_seconds
            if market_values_timeout_seconds is None
            else market_values_timeout_seconds
        )
        self.client_factory = client_factory or self._default_client

    def _default_client(self) -> Any:
        from ibapi.client import EClient
        from ibapi.wrapper import EWrapper

        target_account = self.account_id

        def is_target(account: str) -> bool:
            return _account_matches(account, target_account)

        class SnapshotClient(EWrapper, EClient):
            def __init__(self) -> None:
                EWrapper.__init__(self)
                EClient.__init__(self, wrapper=self)
                self.ready = threading.Event()
                self.summary_done = threading.Event()
                # reqPositions -> position()/positionEnd(): quantities.
                self.positions_done = threading.Event()
                self.positions: list[IbkrPosition] = []
                # reqAccountUpdates -> updatePortfolio()/accountDownloadEnd():
                # optional market values.
                self.portfolio_done = threading.Event()
                self.portfolio: list[IbkrPosition] = []
                self.summary: dict[str, dict[str, str]] = {}
                self.errors: list[str] = []

            def nextValidId(self, _order_id: int) -> None:
                self.ready.set()

            def accountSummary(
                self, _req_id: int, _account: str, tag: str, value: str, currency: str
            ) -> None:
                if not is_target(_account):
                    return
                self.summary.setdefault(tag, {})[currency or "BASE"] = value

            def accountSummaryEnd(self, _req_id: int) -> None:
                self.summary_done.set()

            def position(
                self, account: str, contract: Any, position: float, avg_cost: float
            ) -> None:
                if not is_target(account):
                    return
                self.positions.append(
                    _snapshot_position(contract, account, position, avg_cost)
                )

            def positionEnd(self) -> None:
                self.positions_done.set()

            def updatePortfolio(
                self,
                contract: Any,
                position: float,
                market_price: float,
                market_value: float,
                average_cost: float,
                unrealized_pnl: float,
                realized_pnl: float,
                account: str,
            ) -> None:
                if not is_target(account):
                    return
                self.portfolio.append(
                    _snapshot_position(
                        contract,
                        account,
                        position,
                        average_cost,
                        market_price=market_price,
                        market_value=market_value,
                        unrealized_pnl=unrealized_pnl,
                        realized_pnl=realized_pnl,
                    )
                )

            def accountDownloadEnd(self, account: str) -> None:
                if is_target(account):
                    self.portfolio_done.set()

            def error(
                self, _req_id: int, error_code: int, error_string: str, *_args: Any
            ) -> None:
                self.errors.append(f"{error_code}: {error_string}")

        return SnapshotClient()

    def snapshot(self) -> IbkrAccountSnapshot:
        client = self.client_factory()
        connected = client.connect(self.host, self.port, self.client_id)
        if connected is False:
            raise RuntimeError("ibapi connect returned false")
        thread = threading.Thread(
            target=client.run, name="ibkr-account-snapshot", daemon=True
        )
        thread.start()
        positions_requested = False
        updates_requested = False
        try:
            ready = getattr(client, "ready", None)
            if ready is not None and not ready.wait(self.timeout_seconds):
                raise _timeout_error(
                    client, "timed out waiting for IBKR nextValidId", self.account_id
                )
            client.reqAccountSummary(9001, "All", ACCOUNT_SUMMARY_TAGS)
            if not client.summary_done.wait(self.timeout_seconds):
                raise _timeout_error(
                    client,
                    "timed out waiting for IBKR account summary",
                    self.account_id,
                )
            client.cancelAccountSummary(9001)
            if self.account_id and not client.summary:
                raise RuntimeError(
                    "IBKR returned no account summary for the target account"
                )
            # Quantities come from reqPositions (position/positionEnd). On the
            # 2026-10-31 Gateway login this stream ended in under 1 s, while
            # reqAccountUpdates never sent accountDownloadEnd.
            client.reqPositions()
            positions_requested = True
            if not client.positions_done.wait(self.timeout_seconds):
                raise _timeout_error(
                    client,
                    "timed out waiting for IBKR positions (reqPositions positionEnd)",
                    self.account_id,
                )
            positions = [
                position
                for position in list(client.positions)
                if _account_matches(position.account, self.account_id)
            ]
            # Market values come from reqAccountUpdates. On some Gateway logins
            # this stream never sends accountDownloadEnd, so the values are
            # optional and the snapshot records how complete they are.
            client.reqAccountUpdates(True, self.account_id)
            updates_requested = True
            download_complete = client.portfolio_done.wait(
                self.market_values_timeout_seconds
            )
            portfolio = [
                row
                for row in list(client.portfolio)
                if _account_matches(row.account, self.account_id)
            ]
            positions, market_values_status = _merge_market_values(
                positions, portfolio, download_complete
            )
            return IbkrAccountSnapshot(
                account=self.account_id,
                summary=dict(client.summary),
                positions=positions,
                captured_at=time.time(),
                market_values_status=market_values_status,
            )
        finally:
            if positions_requested:
                try:
                    client.cancelPositions()
                except Exception:
                    pass
            if updates_requested:
                try:
                    client.reqAccountUpdates(False, self.account_id)
                except Exception:
                    pass
            client.disconnect()


class OpenOrdersClient:
    def __init__(self, EWrapper: Any, EClient: Any) -> None:
        EWrapper.__init__(self)
        EClient.__init__(self, self)
        self.ready = threading.Event()
        self.open_orders_done = threading.Event()
        self.cancel_done = threading.Event()
        self.open_orders: dict[int, dict[str, Any]] = {}
        self.errors: list[str] = []
        self.cancel_order_id: int | None = None

    def nextValidId(self, _order_id: int) -> None:
        self.ready.set()

    def error(
        self, req_id: int, error_code: int, error_string: str, *_args: Any
    ) -> None:
        code = int(error_code)
        if code in IBKR_IGNORED_STATUS_CODES:
            return
        cancel_order_id = getattr(self, "cancel_order_id", None)
        if (
            code == 202
            and "cancel" in str(error_string).lower()
            and cancel_order_id is not None
            and int(req_id) == int(cancel_order_id)
        ):
            payload = self.open_orders.setdefault(
                int(req_id), {"order_id": int(req_id)}
            )
            payload.update(
                {"status": "Cancelled", "warning_text": str(error_string or "")}
            )
            self.cancel_done.set()
            return
        self.errors.append(f"{error_code}: {error_string}")

    def openOrder(
        self, orderId: int, contract: Any, order: Any, orderState: Any
    ) -> None:
        contract_payload = _contract_to_dict(contract)
        self.open_orders[int(orderId)] = {
            "order_id": int(orderId),
            "client_id": _api_int(getattr(order, "clientId", None)),
            "account": str(getattr(order, "account", "") or ""),
            "symbol": contract_payload["symbol"],
            "sec_type": contract_payload["sec_type"],
            "exchange": contract_payload["exchange"],
            "currency": contract_payload["currency"],
            "action": str(getattr(order, "action", "") or ""),
            "order_type": str(getattr(order, "orderType", "") or ""),
            "total_quantity": _api_float(getattr(order, "totalQuantity", None)),
            "limit_price": _api_float(getattr(order, "lmtPrice", None)),
            "aux_price": _api_float(getattr(order, "auxPrice", None)),
            "tif": str(getattr(order, "tif", "") or ""),
            "status": str(getattr(orderState, "status", "") or ""),
            "warning_text": str(getattr(orderState, "warningText", "") or ""),
            "contract": contract_payload,
        }

    def orderStatus(
        self,
        orderId: int,
        status: str,
        filled: float,
        remaining: float,
        avgFillPrice: float,
        *_args: Any,
    ) -> None:
        payload = self.open_orders.setdefault(int(orderId), {"order_id": int(orderId)})
        payload.update(
            {
                "status": str(status or ""),
                "filled": _api_float(filled),
                "remaining": _api_float(remaining),
                "avg_fill_price": _api_float(avgFillPrice),
            }
        )
        cancel_order_id = getattr(self, "cancel_order_id", None)
        if (
            cancel_order_id is not None
            and int(orderId) == int(cancel_order_id)
            and str(status or "").lower() in {"cancelled", "apicancelled", "inactive"}
        ):
            self.cancel_done.set()

    def openOrderEnd(self) -> None:
        self.open_orders_done.set()


class IbkrOpenOrdersClient:
    def __init__(
        self,
        host: str,
        port: int,
        client_id: int,
        account_id: str,
        *,
        timeout_seconds: float = 10.0,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.client_id = client_id
        self.account_id = str(account_id or "").strip()
        self.timeout_seconds = timeout_seconds
        self.client_factory = client_factory or self._default_client
        if not self.account_id:
            raise ValueError("IBKR_ACCOUNT_ID is required for open-order access")

    def _default_client(self) -> Any:
        from ibapi.client import EClient
        from ibapi.wrapper import EWrapper

        class DefaultOpenOrdersClient(OpenOrdersClient, EWrapper, EClient):
            def __init__(self) -> None:
                OpenOrdersClient.__init__(self, EWrapper, EClient)

        return DefaultOpenOrdersClient()

    def open_orders(self) -> IbkrOpenOrdersSnapshot:
        client = self.client_factory()
        connected = client.connect(self.host, self.port, self.client_id)
        if connected is False:
            raise RuntimeError("ibapi connect returned false")
        try:
            threading.Thread(target=client.run, daemon=True).start()
            if not client.ready.wait(self.timeout_seconds):
                raise _timeout_error(
                    client, "timed out waiting for IBKR API readiness", self.account_id
                )
            client.reqAllOpenOrders()
            if not client.open_orders_done.wait(self.timeout_seconds):
                raise _timeout_error(
                    client, "timed out waiting for IBKR open orders", self.account_id
                )
            _raise_client_errors(client, self.account_id, "IBKR open orders failed")
            orders = []
            for order_id, payload in sorted(client.open_orders.items()):
                account = str(payload.get("account") or "")
                if self.account_id and account != self.account_id:
                    continue
                orders.append(_open_order_from_payload(order_id, payload))
            return IbkrOpenOrdersSnapshot(
                account=self.account_id, orders=orders, captured_at=time.time()
            )
        finally:
            client.disconnect()


class IbkrOrderCancelClient(IbkrOpenOrdersClient):
    def cancel(
        self, order_id: int, expected: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        client = self.client_factory()
        connected = client.connect(self.host, self.port, self.client_id)
        if connected is False:
            raise RuntimeError("ibapi connect returned false")
        try:
            threading.Thread(target=client.run, daemon=True).start()
            if not client.ready.wait(self.timeout_seconds):
                raise _timeout_error(
                    client, "timed out waiting for IBKR API readiness", self.account_id
                )
            client.reqAllOpenOrders()
            if not client.open_orders_done.wait(self.timeout_seconds):
                raise _timeout_error(
                    client, "timed out waiting for IBKR open orders", self.account_id
                )
            _raise_client_errors(client, self.account_id, "IBKR open orders failed")
            payload = client.open_orders.get(int(order_id))
            if payload is None:
                raise RuntimeError(f"IBKR order {int(order_id)} is not open")
            account = str(payload.get("account") or "")
            if account != self.account_id:
                raise RuntimeError(
                    f"IBKR order {int(order_id)} is not open for {mask_account(self.account_id)}"
                )
            _assert_cancel_expected_order(
                int(order_id), payload, expected or {}, self.account_id
            )
            client.cancel_done.clear()
            client.cancel_order_id = int(order_id)
            try:
                client.cancelOrder(int(order_id), "")
            except TypeError:
                client.cancelOrder(int(order_id))
            if not client.cancel_done.wait(self.timeout_seconds):
                raise _timeout_error(
                    client,
                    "timed out waiting for IBKR cancellation status",
                    self.account_id,
                )
            _raise_client_errors(client, self.account_id, "IBKR cancel order failed")
            latest = client.open_orders.get(int(order_id), payload)
            return {
                "order_id": int(order_id),
                "account_masked": mask_account(account),
                "status": str(latest.get("status") or "cancel_requested"),
                "symbol": str(latest.get("symbol") or ""),
                "action": str(latest.get("action") or ""),
            }
        finally:
            client.disconnect()
