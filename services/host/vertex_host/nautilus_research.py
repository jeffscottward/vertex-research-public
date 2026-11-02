"""Fixed reviewed equity research on the real Rust/PyO3 Nautilus 2.0.0rc5 engine.

No native import occurs until run(), inside the already-attested worker. This is
not a StrategySpec compiler, plugin loader, paper transport, or live engine.
Official tagged API contracts (not the legacy Cython API):
https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/python/nautilus_trader/backtest/__init__.pyi
https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/python/nautilus_trader/trading/__init__.pyi
https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/python/nautilus_trader/execution/__init__.pyi
https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/python/nautilus_trader/common/__init__.pyi
https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/python/nautilus_trader/model/__init__.pyi
"""
from __future__ import annotations

import hashlib
import re
import time
from decimal import Decimal
from typing import Any

from vertex_execution.adapters.contracts import canonical_record
from vertex_execution.adapters.research import ResearchEngineUnavailable

from .nautilus import NAUTILUS_VERSION, ReviewedDistribution, ReviewedNautilusLoader
from .research_engine import EVENT_FORMAT, MODELED_ASSUMPTIONS, _decimal, _text_decimal
from .sandbox import NATIVE_RESEARCH_PROFILE, _integer, protocol_record

# Contract identity/version describe this wrapper, not the upstream distribution.
ENGINE_ID = "vertex-nautilus-quote-research"
ENGINE_VERSION = "1.0.0"
NATIVE_ROOT = "/vertex/nautilus"


def _require(condition: bool) -> None:
    if not condition:
        raise ResearchEngineUnavailable("reviewed Nautilus research subset unavailable")


def _cents(value: str, *, positive: bool = False) -> Decimal:
    amount = _decimal(value, positive=positive)
    _require(amount <= Decimal("1000000000000") and amount == amount.quantize(Decimal("0.01")))
    return amount


def configuration(model: Any) -> tuple[dict[str, Any], ReviewedDistribution]:
    """Metadata only; original recipe bytes explicitly bind all native inputs."""
    value = protocol_record(model.native_configuration_bytes, 1_048_576)
    _require(set(value) == {"format", "distribution", "instrument", "issuedNs", "expiresNs"}
             and value["format"] == "vertex-nautilus-research-v2")
    issued = _integer(value["issuedNs"], 0, 2**64 - 2)
    _integer(value["expiresNs"], issued + 1, 2**64 - 1)
    distribution = value["distribution"]
    _require(type(distribution) is dict and set(distribution) == {"name", "version", "buildSha256", "files"}
             and distribution["name"] == "nautilus-trader"
             and distribution["version"] == NAUTILUS_VERSION and type(distribution["files"]) is dict)
    reviewed = ReviewedDistribution(distribution["version"], distribution["buildSha256"],
                                    tuple(sorted(distribution["files"].items())))
    instrument = value["instrument"]
    _require(type(instrument) is dict and set(instrument) == {
        "id", "rawSymbol", "currency", "pricePrecision", "priceIncrement", "lotSize"})
    _require(instrument["id"] == model.instrument_id and "." in model.instrument_id
             and type(instrument["rawSymbol"]) is str
             and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", instrument["rawSymbol"]) is not None
             and instrument["currency"] == "USD" and type(instrument["pricePrecision"]) is int
             and instrument["pricePrecision"] == 2 and instrument["priceIncrement"] == "0.01"
             and instrument["lotSize"] == "1")
    quantity = _decimal(model.quantity, positive=True)
    _require(quantity == quantity.to_integral_value() and quantity <= 1_000_000)
    _cents(model.initial_cash, positive=True)
    _cents(model.commission_per_fill)
    # Do not turn a requested absolute-price slippage model into a probability.
    _require(_decimal(model.slippage_per_unit) == 0)
    return value, reviewed


def validate_descriptor(descriptor: Any, model: Any) -> None:
    _require((descriptor.pin.identity, descriptor.pin.version, descriptor.pin.digest)
             == (ENGINE_ID, ENGINE_VERSION, model.engine_digest)
             and descriptor.supported_formats == (EVENT_FORMAT,)
             and descriptor.modeled_assumptions == MODELED_ASSUMPTIONS
             and descriptor.simulation_only is True)


class _WallClock:
    @staticmethod
    def now_ns() -> int:
        return time.time_ns()


class NautilusResearchRunner:
    """One fixed reviewed time-gated round trip, one engine on the worker thread."""
    def __init__(self, descriptor: Any, authority: Any, model: Any, supervisor: Any) -> None:
        validate_descriptor(descriptor, model)
        self.descriptor, self.authority, self.model, self.supervisor = descriptor, authority, model, supervisor
        self._attempted = False

    def describe(self) -> Any:
        validate_descriptor(self.descriptor, self.model)
        return self.descriptor

    def run(self, request: Any, events: tuple[Any, ...]) -> Any:
        from backtesting.planner import SimulationOutput
        _require(not self._attempted)
        self._attempted = True
        plan, reviewed = request.plan, self.model
        _require(self.supervisor.active_binding is not None and plan.strategy is not None and plan.lineage is not None
                 and self.supervisor.observation["thread_profile"] == NATIVE_RESEARCH_PROFILE
                 and plan.strategy.digest == reviewed.strategy_digest
                 and plan.request.lineage.code_pin.digest == reviewed.strategy_code_digest
                 and plan.engine == self.descriptor)
        config, distribution = configuration(reviewed)
        assumptions = [item.record() for item in plan.request.lineage.assumptions]
        assumption_bytes = self.authority.encode(assumptions)
        assumptions_digest = self.authority.digest(assumptions)
        _require(type(assumption_bytes) is bytes
                 and len(assumption_bytes) + len(reviewed.native_configuration_bytes) <= plan.request.budget.maximum_input_bytes
                 and hashlib.sha256(assumption_bytes).hexdigest() == assumptions_digest == reviewed.assumptions_digest
                 and not any(item.disposition == "modeled" and item.kind not in MODELED_ASSUMPTIONS
                             for item in plan.request.lineage.assumptions))
        run = plan.run.decode()
        start = self.authority.epoch_ns(run["testWindow"]["startAtInclusive"])
        end = self.authority.epoch_ns(run["testWindow"]["endAtExclusive"])
        _require(0 <= start <= reviewed.enter_not_before_ns < reviewed.exit_not_before_ns < end <= 2**64 - 1)
        _require(bool(events))
        loader = ReviewedNautilusLoader(distribution=distribution, root=NATIVE_ROOT,
            contracts=self.authority, clock=_WallClock(), issued_ns=config["issuedNs"], expires_ns=config["expiresNs"])
        engine = None
        try:
            module = loader()
            api = loader.api(module)
            model, common, execution, trading, backtest = (api[name] for name in
                ("model", "common", "execution", "trading", "backtest"))
            currency = model.Currency.from_str("USD", strict=True)
            instrument_id = model.InstrumentId.from_str(reviewed.instrument_id)
            venue = instrument_id.venue
            quantity = model.Quantity.from_str(format(_decimal(reviewed.quantity), ".0f"))
            cash = model.Money.from_str(reviewed.initial_cash + " USD")
            commission = model.Money.from_str(reviewed.commission_per_fill + " USD")
            _require(quantity.as_decimal() == _decimal(reviewed.quantity)
                     and cash.as_decimal() == _cents(reviewed.initial_cash)
                     and commission.as_decimal() == _cents(reviewed.commission_per_fill))
            instrument = model.Equity(instrument_id=instrument_id,
                raw_symbol=model.Symbol(config["instrument"]["rawSymbol"]), currency=currency,
                price_precision=2, price_increment=model.Price.from_str("0.01"),
                lot_size=model.Quantity.from_str("1"), isin=None, ts_event=0, ts_init=0,
                margin_init=Decimal(0), margin_maint=Decimal(0), maker_fee=Decimal(0), taker_fee=Decimal(0),
                min_quantity=None, max_quantity=None, min_price=None, max_price=None, tick_scheme=None, info={})
            native_quotes, originals = [], {}
            previous = -1
            for event in events:
                _require(previous < event.available_ns <= 2**64 - 1)
                previous = event.available_ns
                quote = protocol_record(event.payload_bytes, 1_000_000)
                _require(set(quote) == {"instrumentId", "bid", "ask", "bidSize", "askSize"}
                         and quote["instrumentId"] == reviewed.instrument_id)
                bid, ask = _cents(quote["bid"], positive=True), _cents(quote["ask"], positive=True)
                bid_size, ask_size = _decimal(quote["bidSize"]), _decimal(quote["askSize"])
                _require(bid <= ask and bid_size == bid_size.to_integral_value()
                         and ask_size == ask_size.to_integral_value())
                if not start <= event.event_ns <= event.available_ns < end:
                    continue
                native = model.QuoteTick(instrument_id=instrument_id,
                    bid_price=model.Price.from_str(format(bid, ".2f")), ask_price=model.Price.from_str(format(ask, ".2f")),
                    bid_size=model.Quantity.from_str(format(bid_size, ".0f")),
                    ask_size=model.Quantity.from_str(format(ask_size, ".0f")),
                    ts_event=event.event_ns, ts_init=event.available_ns)
                _require(native.bid_price.as_decimal() == bid and native.ask_price.as_decimal() == ask
                         and native.bid_size.as_decimal() == bid_size and native.ask_size.as_decimal() == ask_size)
                native_quotes.append(native)
                originals[event.available_ns] = event
            _require(bool(native_quotes))
            fills: list[Any] = []

            class ReviewedRoundTrip(trading.Strategy):
                def __init__(self) -> None:
                    super().__init__(trading.StrategyConfig(strategy_id=model.StrategyId("VERTEX-001"),
                        order_id_tag="001", oms_type=model.OmsType.NETTING, manage_stop=False,
                        use_uuid_client_order_ids=False, log_events=False, log_commands=False))
                    self.failed = False
                    self.entry_sent = False
                    self.exit_sent = False
                    self.quotes_seen = 0

                def on_start(self) -> None:
                    try:
                        self.subscribe_quotes(instrument_id)
                    except Exception:
                        self.failed = True

                def on_quote(self, quote: Any) -> None:
                    try:
                        self.quotes_seen += 1
                        _require(quote.instrument_id == instrument_id and quote.ts_init in originals)
                        if self.failed:
                            return
                        if (not self.entry_sent and reviewed.enter_not_before_ns <= quote.ts_init < reviewed.exit_not_before_ns
                                and quote.ask_size.as_decimal() >= quantity.as_decimal()):
                            self.entry_sent = True
                            order = self.order_factory.market(instrument_id=instrument_id, order_side=model.OrderSide.BUY,
                                quantity=quantity, time_in_force=model.TimeInForce.FOK,
                                client_order_id=model.ClientOrderId("VERTEX-ENTRY"))
                            self.submit_order(order)
                        elif (len(fills) == 1 and not self.exit_sent and quote.ts_init >= reviewed.exit_not_before_ns
                              and quote.bid_size.as_decimal() >= quantity.as_decimal()):
                            self.exit_sent = True
                            order = self.order_factory.market(instrument_id=instrument_id, order_side=model.OrderSide.SELL,
                                quantity=quantity, time_in_force=model.TimeInForce.FOK, reduce_only=True,
                                client_order_id=model.ClientOrderId("VERTEX-EXIT"))
                            self.submit_order(order)
                    except Exception:
                        # rc5 logs Python callback failures; preserve a fail-closed
                        # flag checked after run rather than treating logging as proof.
                        self.failed = True

                def on_order_filled(self, event: Any) -> None:
                    try:
                        _require(len(fills) < 2 and event.instrument_id == instrument_id
                                 and event.ts_event in originals and event.last_qty.as_decimal() == quantity.as_decimal()
                                 and event.currency == currency and event.commission is not None
                                 and event.commission.currency == currency
                                 and event.commission.as_decimal() == commission.as_decimal()
                                 and str(event.client_order_id) == ("VERTEX-ENTRY" if not fills else "VERTEX-EXIT")
                                 and event.order_side == (model.OrderSide.BUY if not fills else model.OrderSide.SELL))
                        fills.append(event)
                    except Exception:
                        self.failed = True

                def on_order_denied(self, event: Any) -> None:
                    self.failed = True

                def on_order_rejected(self, event: Any) -> None:
                    self.failed = True

                def on_order_expired(self, event: Any) -> None:
                    self.failed = True

                def on_order_canceled(self, event: Any) -> None:
                    self.failed = True

                def on_order_fill_voided(self, event: Any) -> None:
                    self.failed = True

            strategy = ReviewedRoundTrip()
            engine = backtest.BacktestEngine(config=backtest.BacktestEngineConfig(
                trader_id=model.TraderId("VERTEX-001"),
                logging=common.LoggerConfig(stdout_level=common.LogLevel.OFF, fileout_level=common.LogLevel.OFF,
                    bypass_logging=True, print_config=False),
                bypass_logging=True, streaming=None, catalogs=[], controller=None,
                load_state=False, save_state=False, run_analysis=False,
                cache=common.CacheConfig(tick_capacity=1, bar_capacity=1, save_market_data=False)))
            engine.add_venue(venue=venue, oms_type=model.OmsType.NETTING, account_type=model.AccountType.CASH,
                starting_balances=[cash], base_currency=currency, default_leverage=Decimal(1),
                book_type=model.BookType.L1_MBP, routing=False, allow_cash_borrowing=False, frozen_account=False,
                bar_execution=False, trade_execution=False, use_random_ids=False, liquidity_consumption=True,
                queue_position=False, modules=[],
                fill_model=execution.DefaultFillModel(prob_fill_on_limit=1.0, prob_slippage=0.0, random_seed=0),
                fee_model=execution.FixedFeeModel(commission=commission, charge_commission_once=False))
            engine.add_instrument(instrument)
            engine.add_strategy(strategy)
            engine.add_data(native_quotes, validate=True, sort=True)
            loader.current()
            engine.run(start=native_quotes[0].ts_init, end=native_quotes[-1].ts_init,
                       run_config_id=plan.lineage.digest, streaming=False)
            loader.current()
            result = engine.get_result()
            _require(not strategy.failed and strategy.quotes_seen == len(native_quotes)
                     and result.iterations == len(native_quotes) and result.total_orders == len(fills)
                     and not engine.cache.orders_open())
            account = engine.cache.account_for_venue(venue)
            _require(account is not None and account.is_cash_account() and account.calculate_account_state)
            ending_cash = account.balance_total(currency)
            _require(ending_cash is not None and ending_cash.currency == currency)
            closed = engine.cache.positions_closed(instrument_id=instrument_id)
            opened = engine.cache.positions_open(instrument_id=instrument_id)
            completed = len(fills) == 2
            _require(len(closed) == (1 if completed else 0) and len(opened) == (1 if len(fills) == 1 else 0)
                     and result.total_positions == len(closed) + len(opened))
            metrics = {}
            if completed:
                # Native position/account amounts are authoritative. Only sum and
                # presentation of their monetary fields occurs in this projection.
                pnl = closed[0].realized_pnl
                _require(closed[0].is_closed and pnl is not None and pnl.currency == currency)
                fees = sum((fill.commission.as_decimal() for fill in fills), Decimal(0))
                _require(cash.as_decimal() + pnl.as_decimal() == ending_cash.as_decimal()
                         and sum((amount.as_decimal() for amount in closed[0].commissions()), Decimal(0)) == fees)
                metrics = {"gross-pnl": _text_decimal(pnl.as_decimal() + fees),
                           "net-pnl": _text_decimal(pnl.as_decimal()),
                           "total-commission": _text_decimal(fees),
                           "ending-cash": _text_decimal(ending_cash.as_decimal())}
            projected_fills = [{"eventId": originals[fill.ts_event].event_id,
                "availableNs": str(fill.ts_event), "side": "buy" if fill.is_buy else "sell",
                "price": _text_decimal(fill.last_px.as_decimal()), "quantity": _text_decimal(fill.last_qty.as_decimal()),
                "commission": _text_decimal(fill.commission.as_decimal()), "currency": "USD",
                "clientOrderId": str(fill.client_order_id), "tradeId": str(fill.trade_id)} for fill in fills]
            economics, _ = canonical_record(self.authority, {
                "model": ENGINE_ID, "modelVersion": ENGINE_VERSION, "reviewDigest": reviewed.review_digest,
                "nativeConfigurationSha256": hashlib.sha256(reviewed.native_configuration_bytes).hexdigest(),
                "distributionBuildSha256": distribution.build_sha256, "runnerSha256": reviewed.engine_digest,
                "strategyModel": "reviewed-single-equity-time-gated-round-trip-v1",
                "metricScope": "out-of-sample", "metrics": metrics, "simulatedFills": projected_fills,
                "nativeResult": {"iterations": str(result.iterations), "totalOrders": str(result.total_orders),
                                 "totalPositions": str(result.total_positions),
                                 "endingCash": _text_decimal(ending_cash.as_decimal()), "currency": "USD"},
                "closedRoundTrip": completed, "executionAuthorized": False,
                "limitations": ["Fixed reviewed whole-share USD equity round trip; not arbitrary strategy code.",
                    "Native FOK market orders, captured L1 spread, fixed cent commission; zero additional slippage only.",
                    "No fractional shares, partial fills, borrow, margin, derivatives, corporate actions or live-liquidity claim.",
                    "Two-task native ABI profile is a hard bound, not runtime or scientific qualification."]},
                plan.request.budget.maximum_input_bytes)
        except Exception:
            raise ResearchEngineUnavailable("native research runtime, input or supported semantics unavailable") from None
        finally:
            if engine is not None:
                try:
                    engine.dispose()
                finally:
                    # PyO3 engine stays on its constructing worker thread through disposal.
                    engine = None
        evidence = self.supervisor.isolation_evidence(self.authority, reviewed.evidence_template_bytes)
        receipt = self.supervisor.receipt(len(events))
        return SimulationOutput(plan.lineage.digest, plan.strategy.digest, self.descriptor.pin,
            tuple(item.decode()["contentHash"] for item in plan.datasets), assumptions_digest,
            economics, (evidence,), MODELED_ASSUMPTIONS, receipt, True, True, completed,
            "inconclusive", ("native-model-realism-review-required",) if completed else ("native-round-trip-unavailable",))
