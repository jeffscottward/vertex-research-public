"""Pinned rc5 Bar/add_data/on_bar historical simulation, never L1 repackaging.

Tagged source: backtest/engine.rs:884-902 routes each external Bar to the
exchange BEFORE on_bar, then drains commands. matching_engine/mod.rs:1778-2023
models LAST bars with its own internal O/H/L/C trade path; those ticks/sizes and
all resulting fills are model output, NEVER original source observations.
"""
from __future__ import annotations

import hashlib
import re
from decimal import Decimal
from typing import Any

from backtesting.historical import (
    ASSUMPTIONS, CLASS, CONTENT, ENGINE_ID, ENGINE_VERSION, MODELED, RESTRICTIONS,
    HistoricalBarInput, HistoricalBarLineage, canonical, interpretation, need, ns,
    qualify, scientific_core, sha,
)
from vertex_execution.adapters.contracts import canonical_record
from vertex_execution.adapters.research import CapturedMarketEvent, ResearchEngineUnavailable

from .nautilus import NAUTILUS_VERSION, ReviewedDistribution, ReviewedNautilusLoader
from .nautilus_research import NATIVE_ROOT, _WallClock, _cents
from .research_engine import _decimal, _text_decimal
from .sandbox import NATIVE_RESEARCH_PROFILE, _integer, protocol_record

RUNNER_PATH = "/vertex/host/vertex_host/nautilus_bars.py"


def configuration(model: Any) -> tuple[dict, ReviewedDistribution]:
    value = protocol_record(model.native_configuration_bytes, 1048576)
    need(set(value) == {"format", "distribution", "instrument", "issuedNs", "expiresNs", "interpretation"}
         and value["format"] == "vertex-nautilus-historical-bars-v1", "historical-native-configuration-version")
    need(ns(value["issuedNs"]) < ns(value["expiresNs"]), "historical-native-validity-clock-range")
    distribution = value["distribution"]
    need(type(distribution) is dict and set(distribution) == {"name", "version", "buildSha256", "files"}
         and distribution["name"] == "nautilus-trader" and distribution["version"] == NAUTILUS_VERSION
         and type(distribution["files"]) is dict, "historical-exact-rc5-distribution-required")
    reviewed = ReviewedDistribution(distribution["version"], distribution["buildSha256"], tuple(sorted(distribution["files"].items())))
    instrument = value["instrument"]
    need(type(instrument) is dict and set(instrument) == {"id", "rawSymbol", "currency", "pricePrecision", "priceIncrement", "lotSize"}
         and instrument["id"] == model.instrument_id and re.fullmatch(r"ibkr-conid-[1-9][0-9]*\.RESEARCH", model.instrument_id) is not None
         and type(instrument["rawSymbol"]) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", instrument["rawSymbol"]) is not None
         and instrument["currency"] == "USD" and type(instrument["pricePrecision"]) is int
         and instrument["pricePrecision"] == 2 and instrument["priceIncrement"] == "0.01" and instrument["lotSize"] == "1",
         "historical-reviewed-native-equity-required")
    quantum = Decimal(1).scaleb(-instrument["pricePrecision"])
    need(_decimal(instrument["priceIncrement"], positive=True) == quantum, "historical-instrument-price-increment")
    quantity = _decimal(model.quantity, positive=True)
    need(quantity == quantity.to_integral_value() and quantity <= 1000000 and _decimal(model.slippage_per_unit) == 0,
         "historical-whole-adjusted-units-zero-additional-slippage-required")
    _cents(model.initial_cash, positive=True)
    _cents(model.commission_per_fill)
    return value, reviewed


def validate_descriptor(descriptor: Any, model: Any) -> None:
    need((descriptor.pin.identity, descriptor.pin.version, descriptor.pin.digest) == (ENGINE_ID, ENGINE_VERSION, model.engine_digest)
         and descriptor.supported_formats == (CONTENT,) and descriptor.modeled_assumptions == MODELED
         and descriptor.simulation_only is True, "historical-closed-engine-descriptor-required")


class HistoricalBarLoader:
    def __init__(self, authority: Any, model: Any) -> None:
        self.authority, self.model = authority, model

    def load(self, request: Any, *, maximum_events: int, maximum_bytes: int) -> Any:
        need(type(request.plan.request.lineage) is HistoricalBarLineage and len(request.plan.request.datasets) == 1,
             "historical-one-series-loader-required")
        source = request.plan.request.datasets[0]
        need(type(source) is HistoricalBarInput and source.declared_events <= maximum_events,
             "historical-loader-count-or-format")
        rows, _ = qualify(source, self.authority, self.model, maximum_bytes)
        used = 0
        for row in rows:
            raw = self.authority.encode(row)
            used += len(raw)
            need(used <= maximum_bytes, "historical-modeled-row-byte-bound")
            # CapturedMarketEvent is a private sealed transport envelope. Its
            # timestamps are EXPLICITLY modeled here; source stamp/acquisition
            # remain independently recorded inside the typed historical payload.
            yield CapturedMarketEvent(sha(source.content_bytes), "bar-" + str(row["ordinal"]) + "-" + row["sourceRowSha256"],
                                      ns(row["qualifiedEndNs"]), ns(row["modeledAvailableNs"]), raw)


class NautilusHistoricalBarRunner:
    def __init__(self, descriptor: Any, authority: Any, model: Any, supervisor: Any) -> None:
        validate_descriptor(descriptor, model)
        self.descriptor, self.authority, self.model, self.supervisor = descriptor, authority, model, supervisor
        self._attempted = False

    def describe(self) -> Any:
        validate_descriptor(self.descriptor, self.model)
        return self.descriptor

    def run(self, request: Any, events: tuple[Any, ...]) -> Any:
        from backtesting.planner import SimulationOutput
        need(not self._attempted, "historical-native-repeat-forbidden")
        self._attempted = True
        plan, reviewed = request.plan, self.model
        need(self.supervisor.active_binding is not None and self.supervisor.observation["thread_profile"] == NATIVE_RESEARCH_PROFILE
             and type(plan.request.lineage) is HistoricalBarLineage and plan.strategy is not None and plan.lineage is not None
             and plan.strategy.digest == reviewed.strategy_digest and plan.request.lineage.code_pin.digest == reviewed.strategy_code_digest
             and plan.request.lineage.model_digest == self.authority.digest(reviewed.record()) and plan.engine == self.descriptor,
             "historical-native-sealed-plan-mismatch")
        config, distribution = configuration(reviewed)
        rules, _, rule_bytes, _ = interpretation(self.authority, reviewed, plan.request.budget.maximum_input_bytes)
        need(plan.request.lineage.interpretation_digest == sha(rule_bytes)
             and reviewed.assumptions_digest == self.authority.digest(ASSUMPTIONS)
             and config["instrument"]["pricePrecision"] == rules["numericTransform"]["pricePrecision"],
             "historical-native-interpretation-mismatch")
        rows, provenance = qualify(plan.request.datasets[0], self.authority, reviewed, plan.request.budget.maximum_input_bytes)
        need(len(rows) == len(events) > 0 and all(event.payload_bytes == self.authority.encode(row)
             and event.event_ns == ns(row["qualifiedEndNs"]) and event.available_ns == ns(row["modeledAvailableNs"])
             for event, row in zip(events, rows, strict=True)), "historical-native-loader-original-mismatch")
        # HistoricalCapture.bind checks the original qualification bytes. Do not
        # silently turn a different currency/symbol into our closed USD equity.
        from providers.ibkr_history import _object, MAX_CAPTURE_BYTES
        contract = _object(plan.request.datasets[0].capture_bytes, MAX_CAPTURE_BYTES)["qualified_contract"]["decoded_contract"]
        need(contract["symbol"] == config["instrument"]["rawSymbol"] and contract["currency"] == "USD",
             "historical-native-qualified-symbol-currency-mismatch")
        run = plan.run.decode()
        start, end = (self.authority.epoch_ns(run["testWindow"][key]) for key in ("startAtInclusive", "endAtExclusive"))
        need(start <= reviewed.enter_not_before_ns < reviewed.exit_not_before_ns < end
             and all(start <= event.event_ns <= event.available_ns < end for event in events),
             "historical-native-study-window-mismatch")
        loader = ReviewedNautilusLoader(distribution=distribution, root=NATIVE_ROOT, contracts=self.authority,
                                       clock=_WallClock(), issued_ns=ns(config["issuedNs"]), expires_ns=ns(config["expiresNs"]))
        engine = None
        try:
            module = loader()
            api = loader.api(module)
            model, common, execution, trading, backtest = (api[name] for name in ("model", "common", "execution", "trading", "backtest"))
            currency = model.Currency.from_str("USD", strict=True)
            instrument_id = model.InstrumentId.from_str(reviewed.instrument_id)
            venue = instrument_id.venue
            quantity = model.Quantity.from_str(format(_decimal(reviewed.quantity), ".0f"))
            cash = model.Money.from_str(reviewed.initial_cash + " USD")
            commission = model.Money.from_str(reviewed.commission_per_fill + " USD")
            need(quantity.as_decimal() == _decimal(reviewed.quantity) and cash.as_decimal() == _cents(reviewed.initial_cash)
                 and commission.as_decimal() == _cents(reviewed.commission_per_fill), "historical-native-money-quantity-conversion")
            instrument = model.Equity(instrument_id=instrument_id, raw_symbol=model.Symbol(config["instrument"]["rawSymbol"]), currency=currency,
                price_precision=config["instrument"]["pricePrecision"], price_increment=model.Price.from_str(config["instrument"]["priceIncrement"]),
                lot_size=model.Quantity.from_str("1"), isin=None, ts_event=0, ts_init=0,
                margin_init=Decimal(0), margin_maint=Decimal(0), maker_fee=Decimal(0), taker_fee=Decimal(0),
                min_quantity=None, max_quantity=None, min_price=None, max_price=None, tick_scheme=None, info={})
            aggregation = model.BarAggregation.MINUTE if rules["interval"] == "1m" else model.BarAggregation.DAY
            bar_type = model.BarType(instrument_id, model.BarSpecification(1, aggregation, model.PriceType.LAST), model.AggregationSource.EXTERNAL)
            native_bars, originals = [], {}
            for event, row in zip(events, rows, strict=True):
                need(event.available_ns not in originals, "historical-native-tied-revision-unavailable")
                prices = {field: model.Price.from_str(row["values"][field]["modeledDecimal"]) for field in ("open", "high", "low", "close")}
                volume = model.Quantity.from_str(row["values"]["volume"]["modeledDecimal"])
                need(all(value.as_decimal() == Decimal(row["values"][field]["modeledDecimal"]) for field, value in prices.items())
                     and volume.as_decimal() == Decimal(row["values"]["volume"]["modeledDecimal"]), "historical-native-fixed-conversion-changed")
                native_bars.append(model.Bar(bar_type=bar_type, **prices, volume=volume, ts_event=event.event_ns, ts_init=event.available_ns))
                originals[event.available_ns] = (event, row)
            fills, decisions, outcomes = [], [], []

            class ReviewedBarRoundTrip(trading.Strategy):
                def __init__(self) -> None:
                    super().__init__(trading.StrategyConfig(strategy_id=model.StrategyId("VERTEX-001"), order_id_tag="001",
                        oms_type=model.OmsType.NETTING, manage_stop=False, use_uuid_client_order_ids=False, log_events=False, log_commands=False))
                    self.failed = False
                    self.entry_sent = False
                    self.exit_sent = False
                    self.bars_seen = 0

                def on_start(self) -> None:
                    try:
                        self.subscribe_bars(bar_type)
                    except Exception:
                        self.failed = True

                def on_bar(self, bar: Any) -> None:
                    try:
                        need(self.bars_seen < len(events) and bar.bar_type == bar_type
                             and bar.ts_init == events[self.bars_seen].available_ns
                             and bar.ts_event == events[self.bars_seen].event_ns, "historical-native-callback-order-mismatch")
                        self.bars_seen += 1
                        if self.failed:
                            return
                        # Reviewed source-volume participation cap is a signal
                        # admission bound, not proof of native path liquidity.
                        cap = Decimal(plan.strategy.decode()["costModel"]["maximumParticipationBps"])
                        if quantity.as_decimal() * 10000 > bar.volume.as_decimal() * cap:
                            return
                        side = None
                        if not self.entry_sent and reviewed.enter_not_before_ns <= bar.ts_init < reviewed.exit_not_before_ns:
                            self.entry_sent, side = True, "buy"
                        elif len(fills) == 1 and not self.exit_sent and bar.ts_init >= reviewed.exit_not_before_ns:
                            self.exit_sent, side = True, "sell"
                        if side is None:
                            return
                        order_id = "VERTEX-ENTRY" if side == "buy" else "VERTEX-EXIT"
                        event, row = originals[bar.ts_init]
                        decisions.append({"clientOrderId": order_id, "barEventId": event.event_id, "sourceRowSha256": row["sourceRowSha256"],
                            "ordinal": row["ordinal"], "modeledDecisionNs": str(bar.ts_init), "timing": ASSUMPTIONS["decisionTiming"],
                            "side": side, "quantity": reviewed.quantity, "shareBasis": ASSUMPTIONS["shareBasis"]})
                        order = self.order_factory.market(instrument_id=instrument_id,
                            order_side=model.OrderSide.BUY if side == "buy" else model.OrderSide.SELL,
                            quantity=quantity, time_in_force=model.TimeInForce.FOK, reduce_only=side == "sell",
                            client_order_id=model.ClientOrderId(order_id))
                        self.submit_order(order)
                    except Exception:
                        self.failed = True

                def on_order_filled(self, event: Any) -> None:
                    try:
                        order_id = "VERTEX-ENTRY" if not fills else "VERTEX-EXIT"
                        decision = next((d for d in decisions if d["clientOrderId"] == order_id), None)
                        need(len(fills) < 2 and event.instrument_id == instrument_id and event.ts_event in originals
                             and event.last_qty.as_decimal() == quantity.as_decimal() and event.currency == currency
                             and event.commission is not None and event.commission.currency == currency
                             and event.commission.as_decimal() == commission.as_decimal() and str(event.client_order_id) == order_id
                             and event.order_side == (model.OrderSide.BUY if not fills else model.OrderSide.SELL)
                             and decision is not None and ns(decision["modeledDecisionNs"]) <= event.ts_event
                             and not any(str(prior.trade_id) == str(event.trade_id) for prior in fills),
                             "historical-native-original-fill-binding")
                        fills.append(event)
                    except Exception:
                        self.failed = True

                def terminal(self, event: Any, state: str) -> None:
                    try:
                        need(str(event.client_order_id) in {d["clientOrderId"] for d in decisions}, "historical-native-unknown-order-outcome")
                        outcomes.append({"clientOrderId": str(event.client_order_id), "state": state, "modeledNs": str(event.ts_event)})
                    except Exception:
                        self.failed = True

                def on_order_denied(self, event: Any) -> None:
                    self.terminal(event, "denied")

                def on_order_rejected(self, event: Any) -> None:
                    self.terminal(event, "rejected")

                def on_order_expired(self, event: Any) -> None:
                    self.terminal(event, "expired")

                def on_order_canceled(self, event: Any) -> None:
                    self.terminal(event, "canceled")

                def on_order_fill_voided(self, event: Any) -> None:
                    self.failed = True

            strategy = ReviewedBarRoundTrip()
            engine = backtest.BacktestEngine(config=backtest.BacktestEngineConfig(trader_id=model.TraderId("VERTEX-001"),
                logging=common.LoggerConfig(stdout_level=common.LogLevel.OFF, fileout_level=common.LogLevel.OFF, bypass_logging=True, print_config=False),
                bypass_logging=True, streaming=None, catalogs=[], controller=None, load_state=False, save_state=False, run_analysis=False,
                cache=common.CacheConfig(tick_capacity=1, bar_capacity=1, save_market_data=False)))
            engine.add_venue(venue=venue, oms_type=model.OmsType.NETTING, account_type=model.AccountType.CASH,
                starting_balances=[cash], base_currency=currency, default_leverage=Decimal(1), book_type=model.BookType.L1_MBP,
                routing=False, allow_cash_borrowing=False, frozen_account=False, bar_execution=True, bar_adaptive_high_low_ordering=False,
                trade_execution=False, use_random_ids=False, liquidity_consumption=True, queue_position=False, modules=[],
                latency_model=execution.StaticLatencyModel(base_latency_nanos=0, insert_latency_nanos=0, update_latency_nanos=0, cancel_latency_nanos=0),
                fill_model=execution.DefaultFillModel(prob_fill_on_limit=1.0, prob_slippage=0.0, random_seed=0),
                fee_model=execution.FixedFeeModel(commission=commission, charge_commission_once=False))
            engine.add_instrument(instrument)
            engine.add_strategy(strategy)
            # Original receive order has already been qualified; sorting here
            # could conceal revisions, gaps, ties or a chronology error.
            engine.add_data(native_bars, validate=True, sort=False)
            loader.current()
            engine.run(start=native_bars[0].ts_init, end=native_bars[-1].ts_init, run_config_id=plan.lineage.digest, streaming=False)
            loader.current()
            result = engine.get_result()
            need(not strategy.failed and strategy.bars_seen == len(native_bars) and result.iterations == len(native_bars)
                 and result.total_orders == len(decisions) and not engine.cache.orders_open(), "historical-native-callback-or-order-accounting")
            account = engine.cache.account_for_venue(venue)
            need(account is not None and account.is_cash_account() and account.calculate_account_state, "historical-native-ledger-unavailable")
            ending = account.balance_total(currency)
            need(ending is not None and ending.currency == currency, "historical-native-ledger-currency")
            closed, opened = engine.cache.positions_closed(instrument_id=instrument_id), engine.cache.positions_open(instrument_id=instrument_id)
            completed = len(fills) == 2
            need(len(closed) == (1 if completed else 0) and len(opened) == (1 if len(fills) == 1 else 0)
                 and result.total_positions == len(closed) + len(opened), "historical-native-position-accounting")
            metrics = {}
            if completed:
                pnl = closed[0].realized_pnl
                need(closed[0].is_closed and pnl is not None and pnl.currency == currency, "historical-native-realized-model-ledger")
                fees = sum((fill.commission.as_decimal() for fill in fills), Decimal(0))
                need(cash.as_decimal() + pnl.as_decimal() == ending.as_decimal()
                     and sum((amount.as_decimal() for amount in closed[0].commissions()), Decimal(0)) == fees,
                     "historical-native-modeled-ledger-reconciliation")
                metrics = {"modeled-adjusted-unit-gross-pnl": _text_decimal(pnl.as_decimal() + fees),
                           "modeled-adjusted-unit-net-pnl": _text_decimal(pnl.as_decimal()),
                           "modeled-total-commission": _text_decimal(fees)}
            projected = []
            for fill in fills:
                event, row = originals[fill.ts_event]
                projected.append({"barEventId": event.event_id, "sourceRowSha256": row["sourceRowSha256"], "ordinal": row["ordinal"],
                    "modeledFillEventNs": str(fill.ts_event), "nativeFillInitNs": str(fill.ts_init), "sourceAcquiredNs": row["acquiredNs"],
                    "sourceProviderTimestamp": row["providerTimestamp"], "side": "buy" if fill.is_buy else "sell",
                    "price": _text_decimal(fill.last_px.as_decimal()), "quantity": _text_decimal(fill.last_qty.as_decimal()),
                    "commission": _text_decimal(fill.commission.as_decimal()), "currency": "USD", "clientOrderId": str(fill.client_order_id),
                    "tradeId": str(fill.trade_id), "sourceObservation": False, "shareBasis": ASSUMPTIONS["shareBasis"]})
            economics, _ = canonical_record(self.authority, {
                "format": "vertex-nautilus-historical-bar-economics-v1", "researchClass": CLASS,
                "model": ENGINE_ID, "modelVersion": ENGINE_VERSION, "reviewDigest": reviewed.review_digest,
                "scientificCoreSha256": self.authority.digest(scientific_core(reviewed)), "nativeConfigurationSha256": sha(reviewed.native_configuration_bytes),
                "distributionBuildSha256": distribution.build_sha256, "runnerSha256": reviewed.engine_digest,
                "strategyModel": "reviewed-single-adjusted-equity-bar-time-gated-round-trip-v1",
                "metricScope": "limited-retrospective", "metrics": metrics, "simulatedFills": projected,
                "decisions": decisions, "orderOutcomes": outcomes, "modeledBars": rows, "sourceQualification": provenance,
                "assumptions": ASSUMPTIONS, "nativeResult": {"iterations": str(result.iterations), "totalOrders": str(result.total_orders),
                    "totalPositions": str(result.total_positions), "modeledLedgerEndingBalance": _text_decimal(ending.as_decimal()), "currency": "USD"},
                "closedRoundTrip": completed, "pointInTime": False, "promotionEligible": False, "executionAuthorized": False,
                "limitations": [*RESTRICTIONS,
                    "Native internal simulated LAST trade path/sizes/timestamps are not source trade ticks or BBO.",
                    "on_bar submits after current bar path; native fills are retained, never assigned to an earlier path point.",
                    "Zero extra slippage and implicit same-price synthetic sides are reviewed optimistic approximations, not calibrated spread/liquidity.",
                    "Fixed quantity and ledger use retrospective retrieval-adjusted share units; no dividend cash, split-event old-share ledger, total return or executable PnL.",
                    "Source Date is mapped only by the reviewed dated session calendar; DAY aggregation does not define a 24-hour session.",
                    "Gaps remain non-observed; reordered/overlapping revisions require a separately authored interpretation and are not sorted/deduplicated."]},
                plan.request.budget.maximum_input_bytes)
        except Exception:
            raise ResearchEngineUnavailable("historical-native-runtime-input-or-modeled-execution-unavailable") from None
        finally:
            if engine is not None:
                try:
                    engine.dispose()
                finally:
                    engine = None
        evidence = self.supervisor.isolation_evidence(self.authority, reviewed.evidence_template_bytes)
        receipt = self.supervisor.receipt(len(events))
        incidents = (*RESTRICTIONS, *(("historical-native-round-trip-unfilled",) if not completed else ()))
        return SimulationOutput(plan.lineage.digest, plan.strategy.digest, self.descriptor.pin,
            tuple(item.decode()["contentHash"] for item in plan.datasets), reviewed.assumptions_digest, economics,
            (evidence,), MODELED, receipt, False, False, completed, "inconclusive", incidents)
