"""Authored-only synthetic tests; never a claim of installed Nautilus acceptance.

All native objects are recorders. Real v1.231.0 import/ABI/instrument replay
validation remains deferred until the user's final verification phase.
"""
import asyncio
from copy import deepcopy
from dataclasses import replace
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, get_ident
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from vertex_execution.adapters.callbacks import AsyncTickDrain, BoundedTickBuffer, TickEvent
from vertex_execution.adapters.nautilus_1231 import EngineUnavailable, OfflineEngineScope
from vertex_host.nautilus import (
    CapturedQuote, CapturedQuoteResolver, NativeOfflineEngineFactory, NativeOfflineQuoteEngine,
    NautilusHostUnavailable, ReviewedDistribution, ReviewedNautilusAdapter,
    ReviewedNautilusLoader, compose_nautilus,
)


NOW = 1_000_000
INSTRUMENT = "FIXTURE.SIM"


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


class Authority:
    def __init__(self):
        self.calls = []
        self.accept = True
        self.times = {"fixture-issued": NOW - 10, "fixture-expires": NOW + 100}

    def validate(self, name, payload, schema_version="1.0.0"):
        self.calls.append((name, schema_version))
        return self.accept

    def epoch_ns(self, value):
        return self.times[value]

    def digest(self, value):
        return sha256(encode(value)).hexdigest()


class Clock:
    def __init__(self):
        self.now = NOW

    def now_ns(self):
        return self.now


class Cache:
    def __init__(self):
        self.values, self.calls = {}, []

    def pin(self, identity, name, value):
        raw = encode(value)
        digest = sha256(raw).hexdigest()
        self.values[identity] = (digest, raw)
        return {"artifactId": identity, "artifactSha256": digest, "contractName": name, "schemaVersion": "1.0.0"}

    def private_bytes(self, identity, digest):
        self.calls.append((identity, digest))
        expected, raw = self.values[identity]
        if expected != digest:
            raise ValueError("fixture-pin-mismatch")
        return raw


def equity():
    return {"type": "Equity", "id": INSTRUMENT, "raw_symbol": "FIXTURE", "currency": "USD",
            "price_precision": 2, "price_increment": "0.01", "lot_size": "1", "isin": None,
            "margin_init": "0", "margin_maint": "0", "maker_fee": "0", "taker_fee": "0",
            "min_price": None, "max_price": None, "max_quantity": None, "min_quantity": None,
            "ts_event": 1, "ts_init": 2, "tick_scheme_name": None, "info": {}}


def quotes():
    return (CapturedQuote("event-1", INSTRUMENT, "10.00", "10.01", "7", "9", 10, 11),
            CapturedQuote("event-2", INSTRUMENT, "10.02", "10.03", "8", "6", 12, 13))


def tick(quote):
    return TickEvent(quote.instrument_id, quote.event_id, quote.event_ns,
                     bid=Decimal(quote.bid), ask=Decimal(quote.ask))


def fixture(change=None, capture_change=None, mode="research"):
    authority, cache, clock = Authority(), Cache(), Clock()
    events = [{"eventId": row.event_id, "instrumentId": row.instrument_id,
               "bid": row.bid, "ask": row.ask, "bidSize": row.bid_size, "askSize": row.ask_size,
               "eventNs": str(row.event_ns), "initNs": str(row.init_ns)} for row in quotes()]
    capture = {"format": "vertex-host-nautilus-quotes-v1", "accountAlias": "fixture-alias", "events": events}
    if capture_change:
        capture_change(capture)
    capture_pin = cache.pin("fixture-capture", "HostNautilusQuoteCapture", capture)
    distribution = {"name": "nautilus_trader", "version": "1.231.0", "files": {
        "nautilus_trader/__init__.py": "a" * 64,
        "nautilus_trader-1.231.0.dist-info/METADATA": "b" * 64,
    }}
    distribution["buildSha256"] = authority.digest(distribution)
    config = {"format": "vertex-host-nautilus-v1", "accountAlias": "fixture-alias", "mode": mode,
              "traderId": "FIXTURE-001", "distribution": distribution,
              "venue": {"id": "SIM", "currency": "USD", "startingBalance": "100.00", "defaultLeverage": "1",
                        "accountType": "CASH", "omsType": "NETTING", "bookType": "L1_MBP"},
              "instruments": [equity()], "capture": capture_pin}
    if change:
        change(config)
    config_pin = cache.pin("fixture-config", "HostNautilusConfiguration", config)
    selection = {"selectionId": "fixture-selection", "accountAlias": "fixture-alias", "environment": mode,
                 "issuedAt": "fixture-issued", "expiresAt": "fixture-expires",
                 "artifacts": [{"role": "simulation-engine", "artifact": pin} for pin in (config_pin, capture_pin)]}
    selection["selectionSha256"] = authority.digest(selection)
    return selection, cache, authority, clock, config


def compose(values, *, mode="research", root=None):
    selection, cache, authority, clock, _ = values
    return compose_nautilus(selection, cache, authority, BoundedTickBuffer(8), OfflineEngineScope(mode),
                             clock=clock, distribution_root=root)


class NativeNumber:
    def __init__(self, value):
        self.value = Decimal(value)
        self.precision = max(0, -self.value.as_tuple().exponent)

    @classmethod
    def from_str(cls, value):
        return cls(value)

    def as_decimal(self):
        return self.value


class MoneyRecorder(NativeNumber):
    @classmethod
    def from_str(cls, value):
        return cls(value.split()[0])


class Identifier:
    def __init__(self, value):
        self.value = value
        self.venue = value.rsplit(".", 1)[-1]

    def __str__(self):
        return self.value


class NativeEngineRecorder:
    def __init__(self, config=None):
        self.config = config
        self.events, self.fail = [], None

    def add_venue(self, **values):
        self.events.append(("venue", values))

    def add_instrument(self, value):
        self.events.append(("instrument", value))

    def add_data(self, rows, **values):
        self.events.append(("data", rows, values))
        if self.fail == "add":
            raise RuntimeError("private-native-failure-after-ingress")

    def run(self, **values):
        self.events.append(("run", values))
        if self.fail == "run":
            raise RuntimeError("private-native-failure-after-run")

    def clear_data(self):
        self.events.append(("clear",))

    def dispose(self):
        self.events.append(("dispose",))


def native_api():
    engines = []
    def new_engine(config):
        value = NativeEngineRecorder(config)
        engines.append(value)
        return value
    def instrument(values):
        return SimpleNamespace(id=Identifier(values["id"]), price_precision=values["price_precision"],
                               size_precision=0, price_increment=NativeNumber(values["price_increment"]),
                               lot_size=NativeNumber(values["lot_size"]))
    api = {
        "model.objects": SimpleNamespace(Price=NativeNumber, Quantity=NativeNumber, Money=MoneyRecorder,
                                          Currency=SimpleNamespace(from_str=lambda value: value)),
        "model.data": SimpleNamespace(QuoteTick=lambda **values: SimpleNamespace(**values)),
        "model.identifiers": SimpleNamespace(TraderId=Identifier, Venue=Identifier),
        "model.enums": SimpleNamespace(OmsType=SimpleNamespace(NETTING="NETTING"),
                                        AccountType=SimpleNamespace(CASH="CASH"), BookType=SimpleNamespace(L1_MBP="L1_MBP")),
        "common.config": SimpleNamespace(LoggingConfig=lambda **values: values),
        "backtest.config": SimpleNamespace(BacktestEngineConfig=lambda **values: values),
        "backtest.engine": SimpleNamespace(BacktestEngine=new_engine),
        "model.instruments.equity": SimpleNamespace(Equity=SimpleNamespace(from_dict=instrument)),
    }
    return api, engines


class ComposeTests(unittest.TestCase):
    def test_compose_captures_original_exact_ticks_without_native_import_file_read_or_activation(self):
        values = fixture()
        with patch("vertex_host.nautilus.importlib.import_module", side_effect=AssertionError("no-import")), \
                patch("vertex_host.nautilus.read_regular", side_effect=AssertionError("no-file-probe")):
            adapter = compose(values)
            self.assertIsInstance(adapter, ReviewedNautilusAdapter)
            self.assertFalse(adapter.active)
            self.assertEqual(adapter.captured_ticks(), tuple(tick(row) for row in quotes()))
        self.assertEqual(values[1].calls[0][0], "fixture-config")
        self.assertEqual(values[1].calls[1][0], "fixture-capture")

    def test_missing_config_has_no_activation_fallback_or_ticks(self):
        values = fixture()
        selection, _, authority, _, _ = values
        selection["artifacts"] = []
        selection["selectionSha256"] = authority.digest({key: value for key, value in selection.items() if key != "selectionSha256"})
        adapter = compose(values)
        self.assertEqual(adapter.captured_ticks(), ())
        with self.assertRaises(EngineUnavailable):
            adapter.activate()

    def test_missing_local_root_stays_unavailable_and_failed_activation_is_not_retried(self):
        adapter = compose(fixture())
        with patch("vertex_host.nautilus.read_regular", side_effect=AssertionError("no-root-no-io")):
            with self.assertRaises(NautilusHostUnavailable):
                adapter.activate()
        with self.assertRaisesRegex(EngineUnavailable, "automatic retry is forbidden"):
            adapter.activate()

    def test_version_inventory_and_build_digest_must_be_explicit_exact_not_source_tag_inference(self):
        changes = (
            lambda value: value["distribution"].update(version="2.0.0rc5"),
            lambda value: value["distribution"].update(buildSha256="f" * 64),
            lambda value: value["distribution"].update(files={}),
            lambda value: value["distribution"]["files"].update({"../elsewhere.py": "c" * 64}),
            lambda value: value["distribution"]["files"].update({"ambient.py": "c" * 64}),
        )
        for index, change in enumerate(changes):
            with self.subTest(index=index), self.assertRaises(NautilusHostUnavailable):
                compose(fixture(change))

    def test_no_size_timestamp_price_or_instrument_economics_are_invented(self):
        captures = (
            lambda value: value["events"][0].pop("bidSize"),
            lambda value: value["events"][0].pop("initNs"),
            lambda value: value["events"][0].update(eventNs=10),
            lambda value: value["events"][0].update(instrumentId="OTHER.SIM"),
            lambda value: value["events"].pop(),
            lambda value: value["events"][1].update(initNs="11"),
        )
        for index, change in enumerate(captures):
            with self.subTest(index=index), self.assertRaises(NautilusHostUnavailable):
                compose(fixture(capture_change=change))
        for field in ("price_increment", "maker_fee", "margin_init", "ts_init"):
            with self.subTest(field=field), self.assertRaises(NautilusHostUnavailable):
                compose(fixture(lambda value, key=field: value["instruments"][0].pop(key)))

    def test_unsupported_scope_schema_truthiness_or_changed_selected_originals_are_unavailable(self):
        values = fixture()
        values[2].accept = 1
        with self.assertRaises(NautilusHostUnavailable):
            compose(values)
        values = fixture()
        digest, raw = values[1].values["fixture-capture"]
        values[1].values["fixture-capture"] = (digest, raw + b" ")
        with self.assertRaises(NautilusHostUnavailable):
            compose(values)
        with self.assertRaises(NautilusHostUnavailable):
            compose(fixture(), mode="paper")

    def test_capture_pin_must_be_explicitly_selected_and_duplicate_config_is_not_fallback(self):
        for duplicate in (False, True):
            values = fixture()
            selection, _, authority, _, _ = values
            if duplicate:
                selection["artifacts"].append(deepcopy(selection["artifacts"][0]))
            else:
                selection["artifacts"].pop()
            selection["selectionSha256"] = authority.digest({key: value for key, value in selection.items() if key != "selectionSha256"})
            with self.assertRaises(NautilusHostUnavailable):
                compose(values)


class DistributionTests(unittest.TestCase):
    def files(self, root, authority):
        originals = {
            "nautilus_trader/__init__.py": b"# fixture only; not genuine Nautilus\n",
            "nautilus_trader-1.231.0.dist-info/METADATA": b"Name: nautilus_trader\nVersion: 1.231.0\n",
        }
        inventory = {}
        for name, raw in originals.items():
            path = root / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(raw)
            path.chmod(0o600)
            inventory[name] = sha256(raw).hexdigest()
        digest = authority.digest({"name": "nautilus_trader", "version": "1.231.0", "files": inventory})
        return ReviewedDistribution("1.231.0", digest, tuple(sorted(inventory.items())))

    def test_file_measurement_checks_all_original_bytes_and_rejects_extra_paths_and_symlinks(self):
        for failure in ("changed", "extra-file", "extra-directory", "symlink"):
            with TemporaryDirectory() as directory:
                root, authority = Path(directory), Authority()
                distribution = self.files(root, authority)
                loader = ReviewedNautilusLoader(distribution=distribution, root=root, contracts=authority,
                                                clock=Clock(), issued_ns=NOW - 10, expires_ns=NOW + 100)
                loader._measure(root)
                if failure == "changed":
                    (root / "nautilus_trader/__init__.py").write_bytes(b"changed")
                elif failure == "extra-file":
                    (root / "extra.py").write_bytes(b"unreviewed")
                elif failure == "extra-directory":
                    (root / "extra").mkdir()
                else:
                    (root / "nautilus_trader/__init__.py").unlink()
                    (root / "nautilus_trader/__init__.py").symlink_to(root / "nautilus_trader-1.231.0.dist-info/METADATA")
                with self.subTest(failure=failure), self.assertRaises(Exception):
                    loader._measure(root)

    def test_version_metadata_is_checked_even_if_modified_bytes_are_reapproved(self):
        with TemporaryDirectory() as directory:
            root, authority = Path(directory), Authority()
            reviewed = self.files(root, authority)
            path = root / "nautilus_trader-1.231.0.dist-info/METADATA"
            path.write_bytes(b"Name: nautilus_trader\nVersion: 1.232.0\n")
            files = dict(reviewed.files)
            files[path.relative_to(root).as_posix()] = sha256(path.read_bytes()).hexdigest()
            reviewed = replace(reviewed, files=tuple(files.items()))
            loader = ReviewedNautilusLoader(distribution=reviewed, root=root, contracts=authority,
                                            clock=Clock(), issued_ns=NOW - 10, expires_ns=NOW + 100)
            with self.assertRaises(NautilusHostUnavailable):
                loader._measure(root)

    def test_ambient_preloaded_module_is_never_accepted_as_reviewed_distribution(self):
        with TemporaryDirectory() as directory:
            root, authority = Path(directory), Authority()
            reviewed = self.files(root, authority)
            loader = ReviewedNautilusLoader(distribution=reviewed, root=root, contracts=authority,
                                            clock=Clock(), issued_ns=NOW - 10, expires_ns=NOW + 100)
            with patch.dict("sys.modules", {"nautilus_trader": SimpleNamespace(__version__="1.231.0")}), \
                    patch("vertex_host.nautilus.importlib.util.spec_from_file_location") as spec:
                with self.assertRaises(NautilusHostUnavailable):
                    loader()
                spec.assert_not_called()


class NativeOfflineTests(unittest.IsolatedAsyncioTestCase):
    def engine(self):
        api, _ = native_api()
        native = NativeEngineRecorder()
        instrument = api["model.instruments.equity"].Equity.from_dict(equity())
        engine = NativeOfflineQuoteEngine(engine=native, api=api, resolver=CapturedQuoteResolver(quotes()),
                                          instruments={INSTRUMENT: instrument}, current=lambda: None)
        self.addAsyncCleanup(engine.close)
        return engine, native

    async def test_real_ingress_shape_uses_captured_sizes_and_initialization_clocks(self):
        engine, native = self.engine()
        await engine.process_tick(tick(quotes()[0]))
        self.assertEqual([row[0] for row in native.events], ["data"])
        first = native.events[0][1][0]
        self.assertEqual(first.bid_size.as_decimal(), Decimal("7"))
        self.assertEqual(first.ask_size.as_decimal(), Decimal("9"))
        self.assertEqual((first.ts_event, first.ts_init), (10, 11))
        await engine.process_tick(tick(quotes()[1]))
        self.assertEqual([row[0] for row in native.events], ["data", "data", "run", "clear"])
        self.assertEqual(native.events[2][1], {"start": 11, "end": 13, "streaming": False})
        await engine.close()
        await engine.close()
        self.assertEqual([row[0] for row in native.events].count("dispose"), 1)

    async def test_partial_capture_close_never_fabricates_final_tick_or_runs(self):
        engine, native = self.engine()
        await engine.process_tick(tick(quotes()[0]))
        await engine.close()
        self.assertEqual([row[0] for row in native.events], ["data", "dispose"])

    async def test_duplicate_exact_event_is_idempotent_but_changed_content_latches_failure(self):
        engine, native = self.engine()
        first = tick(quotes()[0])
        await engine.process_tick(first)
        await engine.process_tick(first)
        self.assertEqual(len(native.events), 1)
        with self.assertRaises(NautilusHostUnavailable):
            await engine.process_tick(replace(first, bid=Decimal("9.00")))
        with self.assertRaises(NautilusHostUnavailable):
            await engine.process_tick(tick(quotes()[1]))
        self.assertEqual(len(native.events), 1)

    async def test_unknown_missing_quote_last_price_and_out_of_order_tick_never_enter_engine(self):
        for candidate in (replace(tick(quotes()[0]), event_id="unknown"),
                          replace(tick(quotes()[0]), bid=None),
                          replace(tick(quotes()[0]), last=Decimal("10.00")), tick(quotes()[1])):
            engine, native = self.engine()
            with self.assertRaises(NautilusHostUnavailable):
                await engine.process_tick(candidate)
            self.assertEqual(native.events, [])

    async def test_uncertain_native_ingress_is_not_retried_by_drain(self):
        engine, native = self.engine()
        native.fail = "add"
        buffer = BoundedTickBuffer(2)
        buffer.on_tick(tick(quotes()[0]))
        drain = AsyncTickDrain(buffer, engine.process_tick)
        with self.assertRaises(NautilusHostUnavailable):
            await drain.drain()
        self.assertEqual(buffer.state().pending, 1)
        with self.assertRaises(NautilusHostUnavailable):
            await drain.drain()
        self.assertEqual(len(native.events), 1)

    async def test_factory_constructs_backtest_only_with_explicit_economics_and_no_plugins(self):
        _, _, _, _, config = fixture()
        api, engines = native_api()
        module = SimpleNamespace(__version__="1.231.0")
        loader = SimpleNamespace(api=lambda candidate: api if candidate is module else None, current=lambda: None)
        factory = NativeOfflineEngineFactory(loader=loader, config=config, resolver=CapturedQuoteResolver(quotes()))
        engine = factory(module, OfflineEngineScope("research"))
        self.addAsyncCleanup(engine.close)
        native = engines[0]
        self.assertEqual(native.config["strategies"], [])
        self.assertEqual(native.config["actors"], [])
        self.assertIsNone(native.config["controller"])
        self.assertFalse(native.config["load_state"])
        venue = native.events[0][1]
        self.assertEqual(venue["starting_balances"][0].as_decimal(), Decimal("100.00"))
        self.assertEqual(venue["default_leverage"], Decimal("1"))
        self.assertTrue(venue["frozen_account"])
        self.assertFalse(venue["routing"])
        self.assertFalse(venue["allow_cash_borrowing"])
        self.assertFalse(hasattr(engine, "submit"))
        with self.assertRaises(NautilusHostUnavailable):
            factory(module, OfflineEngineScope("research"))
        await engine.close()

    async def test_native_construction_processing_and_disposal_share_one_nonloop_owner_thread(self):
        _, _, _, _, config = fixture()
        api, _ = native_api()
        thread_ids = []
        class AffinityEngine(NativeEngineRecorder):
            def __init__(self, config):
                thread_ids.append(("construct", get_ident()))
                super().__init__(config)

            def add_venue(self, **values):
                thread_ids.append(("venue", get_ident()))
                super().add_venue(**values)

            def add_instrument(self, value):
                thread_ids.append(("instrument", get_ident()))
                super().add_instrument(value)

            def add_data(self, rows, **values):
                thread_ids.append(("data", get_ident()))
                super().add_data(rows, **values)

            def run(self, **values):
                thread_ids.append(("run", get_ident()))
                super().run(**values)

            def dispose(self):
                thread_ids.append(("dispose", get_ident()))
                super().dispose()
        api["backtest.engine"] = SimpleNamespace(BacktestEngine=AffinityEngine)
        loader = SimpleNamespace(api=lambda module: api, current=lambda: None)
        factory = NativeOfflineEngineFactory(loader=loader, config=config, resolver=CapturedQuoteResolver(quotes()))
        engine = factory(object(), OfflineEngineScope("research"))
        self.addAsyncCleanup(engine.close)
        await engine.process_tick(tick(quotes()[0]))
        await engine.process_tick(tick(quotes()[1]))
        await engine.close()
        self.assertEqual(len({identity for _, identity in thread_ids}), 1)
        self.assertNotEqual(thread_ids[0][1], get_ident())
        self.assertEqual([kind for kind, _ in thread_ids],
                         ["construct", "venue", "instrument", "data", "data", "run", "dispose"])

    async def test_native_work_does_not_block_loop_and_repeated_cancel_joins_before_close(self):
        engine, native = self.engine()
        entered, release = asyncio.Event(), Event()
        loop = asyncio.get_running_loop()
        original = native.add_data
        def blocking(rows, **values):
            loop.call_soon_threadsafe(entered.set)
            if not release.wait(timeout=5):
                raise RuntimeError("fixture-native-release-timeout")
            original(rows, **values)
        native.add_data = blocking
        processing = asyncio.create_task(engine.process_tick(tick(quotes()[0])))
        try:
            await asyncio.wait_for(entered.wait(), timeout=1)
            processing.cancel()
            await asyncio.sleep(0)
            processing.cancel()
            await asyncio.sleep(0)
            self.assertFalse(processing.done())
            # Bounded lane refuses a second queued replay, rather than letting
            # an unbounded executor queue hide lease-lifecycle races.
            with self.assertRaises(NautilusHostUnavailable):
                await engine.process_tick(tick(quotes()[1]))
            closing = asyncio.create_task(engine.close())
            await asyncio.sleep(0)
            closing.cancel()
            await asyncio.sleep(0)
            closing.cancel()
            await asyncio.sleep(0)
            self.assertFalse(closing.done())
            self.assertEqual(native.events, [])
        finally:
            release.set()
        with self.assertRaises(asyncio.CancelledError):
            await processing
        with self.assertRaises(asyncio.CancelledError):
            await closing
        self.assertEqual([event[0] for event in native.events], ["data", "dispose"])
        await engine.close()
