"""Explicit exact-2.0.0rc5 Rust/PyO3 offline replay; no LiveNode or broker paths.

Source API grounding (tag v2.0.0rc5, not installed-runtime verification):
https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/python/nautilus_trader/backtest/__init__.pyi
https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/python/nautilus_trader/model/__init__.pyi
https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/crates/backtest/src/python/engine.rs
https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/crates/pyo3/src/lib.rs

This implementation deliberately supports explicit Equity/CASH/NETTING research
quote replay only. It never synthesizes sizes, clocks, balances, instruments or
strategies. A paper scope remains BACKTEST, never PaperExecutionOwner cash state.
All native imports and distribution file reads occur only during activate().
No currently installed release or reviewed distribution digest is assumed.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from email.parser import BytesParser
import asyncio
from concurrent.futures import Future, ThreadPoolExecutor
from hashlib import sha256
import importlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
from threading import Lock
from types import MappingProxyType, ModuleType
from typing import Any, Mapping

from vertex_execution.adapters.callbacks import BoundedTickBuffer, TickEvent
from vertex_execution.adapters.nautilus_200rc5 import (
    EngineUnavailable, NAUTILUS_VERSION, Nautilus200rc5Adapter, OfflineEngineScope,
)

from .cache import thaw
from .config import read_regular


class NautilusHostUnavailable(EngineUnavailable):
    def __init__(self) -> None:
        super().__init__("reviewed-nautilus-offline-engine-unavailable")
        # Safe machine-readable diagnostics only; never retain exception values.
        self.diagnostic_phase = "unspecified"
        self.diagnostic_exception_class = "NautilusHostUnavailable"
        self.diagnostic_code = "unspecified:NautilusHostUnavailable"


def _require(condition: bool) -> None:
    if not condition:
        raise NautilusHostUnavailable()


def _object(value: Any, keys: str) -> dict[str, Any]:
    _require(type(value) is dict and set(value) == set(keys.split()))
    return value


def _digest(value: Any) -> str:
    _require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None)
    return value


def _identifier(value: Any) -> str:
    _require(type(value) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value) is not None)
    return value


def _uint(value: Any) -> int:
    _require(type(value) is int and 0 <= value < 2**64)
    return value


def _decimal(value: Any, *, positive: bool = True) -> Decimal:
    _require(type(value) is str and len(value) <= 40
             and re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value) is not None)
    result = Decimal(value)
    _require(result.is_finite() and (result > 0 if positive else True))
    return result


def _decode(raw: bytes, digest: str, maximum: int = 1_048_576) -> dict[str, Any]:
    _require(type(raw) is bytes and 0 < len(raw) <= maximum and sha256(raw).hexdigest() == digest)
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = dict(pairs)
        _require(len(result) == len(pairs))
        return result
    def invalid(value: str) -> None:
        raise NautilusHostUnavailable()
    value = json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)
    _require(type(value) is dict)
    return value


_NATIVE_IMPORT_LOCK = Lock()
_API_MODULES = ("backtest", "common", "model", "execution", "trading")
_DIST_INFO = f"nautilus_trader-{NAUTILUS_VERSION}.dist-info"
# rc5's single measured extension explicitly registers these PyO3 submodules.
# They have no separate __file__; require identity with the extension's export.
_NATIVE_SUBMODULES = frozenset((
    "analysis", "core", "common", "cryptography", "data", "execution", "indicators",
    "infrastructure", "live", "model", "network", "persistence", "portfolio", "risk",
    "serialization", "testkit", "trading", "backtest", "architect_ax", "betfair",
    "binance", "bitmex", "bybit", "coinbase", "databento", "deribit", "derive",
    "dydx", "hyperliquid", "kraken", "lighter", "interactive_brokers", "okx",
    "polymarket", "sandbox", "tardis", "blockchain",
))


@dataclass(frozen=True)
class ReviewedDistribution:
    """Externally reviewed ORIGINAL distribution inventory, never inferred version trust."""

    version: str
    build_sha256: str
    files: tuple[tuple[str, str], ...]

    def __post_init__(self) -> None:
        _require(self.version == NAUTILUS_VERSION)
        _digest(self.build_sha256)
        _require(type(self.files) is tuple and 1 <= len(self.files) <= 16_384)
        names = set()
        for name, digest in self.files:
            _require(type(name) is str and len(name) <= 1024)
            relative = PurePosixPath(name)
            _require(not relative.is_absolute() and str(relative) == name and ".." not in relative.parts
                     and "__pycache__" not in relative.parts and relative.suffix != ".pyc")
            _digest(digest)
            _require(name not in names)
            names.add(name)
        _require("nautilus_trader/__init__.py" in names and f"{_DIST_INFO}/METADATA" in names)
        _require(all(name.startswith(("nautilus_trader/", "nautilus_trader.libs/",
                                     f"{_DIST_INFO}/")) for name in names))


class ReviewedNautilusLoader:
    """Explicit activation in the host's already trusted isolated Python runtime.

    Runtime dependencies are NOT installed/discovered by this loader. Root is an
    explicitly mounted reviewed release directory, not arbitrary site-packages.
    Its complete regular-file inventory must match, including compiled modules
    and dist-info metadata. A source tag alone never qualifies as a build digest.
    Preloaded Nautilus, symlinks, extra files, mutable-by-others paths and another
    version all fail closed. No fallback to ambient installed Nautilus occurs.
    """

    def __init__(self, *, distribution: ReviewedDistribution, root: str | Path | None,
                 contracts: Any, clock: Any, issued_ns: int, expires_ns: int) -> None:
        self._distribution, self._root, self._contracts = distribution, root, contracts
        self._clock, self._issued_ns, self._expires_ns = clock, issued_ns, expires_ns
        self._attempted = False
        self._module: ModuleType | None = None
        self._apis: Mapping[str, ModuleType] | None = None

    def current(self) -> None:
        now = self._clock.now_ns()
        _require(type(now) is int and self._issued_ns <= now < self._expires_ns)

    def _measure(self, root: Path) -> None:
        _require(root.is_absolute() and root.resolve(strict=True) == root)
        root_info = root.stat()
        _require(stat.S_ISDIR(root_info.st_mode) and root_info.st_uid in (0, os.getuid())
                 and not stat.S_IMODE(root_info.st_mode) & 0o022)
        expected = dict(self._distribution.files)
        expected_directories = {str(parent) for name in expected for parent in PurePosixPath(name).parents
                                if str(parent) != "."}
        actual: set[str] = set()
        total_bytes = 0
        for directory, directories, files in os.walk(root, followlinks=False):
            for name in directories:
                entry = Path(directory) / name
                _require(entry.relative_to(root).as_posix() in expected_directories)
                metadata = entry.lstat()
                _require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid in (0, os.getuid())
                         and not stat.S_IMODE(metadata.st_mode) & 0o022)
            for name in files:
                entry = Path(directory) / name
                relative = entry.relative_to(root).as_posix()
                _require(relative in expected and relative not in actual)
                # Official rc5's PEP 561 marker is empty, but still inventory-
                # pinned and hashed. No config, metadata or code exception.
                raw = read_regular(entry, 536_870_912,
                                   allow_empty=relative == "nautilus_trader/py.typed")
                total_bytes += len(raw)
                _require(total_bytes <= 2_147_483_648 and sha256(raw).hexdigest() == expected[relative])
                actual.add(relative)
        _require(actual == set(expected))
        metadata = BytesParser().parsebytes(read_regular(root / _DIST_INFO / "METADATA", 1_048_576))
        _require(metadata.get_all("Name") == ["nautilus-trader"]
                 and metadata.get_all("Version") == [NAUTILUS_VERSION])

    def __call__(self) -> ModuleType:
        with _NATIVE_IMPORT_LOCK:
            phase = "attempt-latch"
            try:
                _require(not self._attempted)
                self._attempted = True
                phase = "freshness-before"
                self.current()
                phase = "runtime-root-and-python"
                _require(self._root is not None)
                _require((3, 12) <= sys.version_info[:2] < (3, 15))
                root = Path(self._root)
                body = {"name": "nautilus-trader", "version": self._distribution.version,
                        "files": dict(self._distribution.files)}
                phase = "distribution-digest"
                _require(self._contracts.digest(body) == self._distribution.build_sha256)
                phase = "inventory-before"
                self._measure(root)
                phase = "preloaded-module-check"
                _require(not any(name == "nautilus_trader" or name.startswith("nautilus_trader.") for name in sys.modules))
                previous_no_bytecode = sys.dont_write_bytecode
                previous_path = sys.path[:]
                try:
                    sys.dont_write_bytecode = True
                    # rc5 __init__ resolves __version__ through importlib.metadata.
                    # Only this measured distribution may supply that metadata.
                    sys.path.insert(0, str(root))
                    # The top-level package is loaded from this measured path,
                    # never sys.path's possibly shadowed package of the same name.
                    phase = "package-spec"
                    spec = importlib.util.spec_from_file_location(
                        "nautilus_trader", root / "nautilus_trader/__init__.py",
                        submodule_search_locations=[str(root / "nautilus_trader")],
                    )
                    _require(spec is not None and spec.loader is not None)
                    module = importlib.util.module_from_spec(spec)
                    sys.modules["nautilus_trader"] = module
                    phase = "package-import"
                    spec.loader.exec_module(module)
                    phase = "package-version"
                    _require(getattr(module, "__version__", None) == NAUTILUS_VERSION)
                    apis = {}
                    for api_name in _API_MODULES:
                        phase = "api-import-" + api_name  # fixed source-owned names
                        apis[api_name] = importlib.import_module("nautilus_trader." + api_name)
                    phase = "native-extension-loader"
                    native = sys.modules["nautilus_trader._libnautilus"]
                    _require(isinstance(native.__loader__, importlib.machinery.ExtensionFileLoader))
                    for name, loaded in tuple(sys.modules.items()):
                        if name == "nautilus_trader" or name.startswith("nautilus_trader."):
                            phase = "module-origin-read"
                            origin = getattr(loaded, "__file__", None)
                            if name.startswith("nautilus_trader._libnautilus."):
                                short_name = name.removeprefix("nautilus_trader._libnautilus.")
                                phase = "registered-submodule-identity"
                                _require(short_name in _NATIVE_SUBMODULES
                                         and native.__dict__.get(short_name) is loaded)
                            else:
                                phase = "python-module-origin"
                                _require(type(origin) is str and Path(origin).resolve().is_relative_to(root))
                                _require(Path(origin).resolve().relative_to(root).as_posix()
                                         in dict(self._distribution.files))
                    phase = "inventory-after"
                    self._measure(root)
                    phase = "freshness-after"
                    self.current()
                finally:
                    sys.dont_write_bytecode = previous_no_bytecode
                    sys.path[:] = previous_path
                self._module, self._apis = module, MappingProxyType(apis)
                return module
            except Exception as exc:
                # Partial native import remains latched; unsafe module unloading
                # or automatic replacement/retry is deliberately not attempted.
                failure = NautilusHostUnavailable()
                failure.diagnostic_phase = phase
                name = type(exc).__name__
                failure.diagnostic_exception_class = name if name in {
                    "NautilusHostUnavailable", "HostUnavailable", "ImportError",
                    "ModuleNotFoundError", "AttributeError", "KeyError", "TypeError",
                    "ValueError", "RuntimeError", "OSError", "PermissionError",
                    "FileNotFoundError", "MemoryError", "OverflowError", "SystemError",
                    "UnicodeDecodeError", "RecursionError",
                } else "OtherException"
                failure.diagnostic_code = phase + ":" + failure.diagnostic_exception_class
                raise failure from None

    def api(self, module: object) -> Mapping[str, ModuleType]:
        self.current()
        _require(module is self._module and self._apis is not None)
        return self._apis


@dataclass(frozen=True)
class CapturedQuote:
    event_id: str
    instrument_id: str
    bid: str
    ask: str
    bid_size: str
    ask_size: str
    event_ns: int
    init_ns: int

    def matches(self, tick: TickEvent) -> bool:
        return (type(tick) is TickEvent and tick.event_id == self.event_id
                and tick.instrument_id == self.instrument_id and tick.event_ns == self.event_ns
                and tick.bid == Decimal(self.bid) and tick.ask == Decimal(self.ask) and tick.last is None)


class CapturedQuoteResolver:
    """Immutable exact-event lookup; no prices/sizes inferred from TickEvent."""

    def __init__(self, quotes: tuple[CapturedQuote, ...]) -> None:
        _require(type(quotes) is tuple and 2 <= len(quotes) <= 16_384)
        _require(len({quote.event_id for quote in quotes}) == len(quotes))
        for quote in quotes:
            _identifier(quote.event_id)
            _identifier(quote.instrument_id)
            _require(_decimal(quote.bid) <= _decimal(quote.ask))
            _decimal(quote.bid_size)
            _decimal(quote.ask_size)
            _require(_uint(quote.event_ns) <= _uint(quote.init_ns))
        _require(all(left.init_ns <= right.init_ns for left, right in zip(quotes, quotes[1:])))
        _require(quotes[0].init_ns < quotes[-1].init_ns)
        self.quotes = quotes
        self._by_id = MappingProxyType({quote.event_id: quote for quote in quotes})

    def resolve(self, tick: TickEvent) -> CapturedQuote:
        quote = self._by_id.get(tick.event_id)
        _require(quote is not None and quote.matches(tick))
        return quote


class ReviewedNautilusAdapter(Nautilus200rc5Adapter):
    __slots__ = ("_captured",)

    def __init__(self, *, captured: tuple[TickEvent, ...], **options: Any) -> None:
        super().__init__(**options)
        self._captured = captured

    def captured_ticks(self) -> tuple[TickEvent, ...]:
        """Finite normalized ORIGINAL capture, for explicit backpressured drain."""
        return self._captured


async def _joined_future(future: Any) -> Any:
    """Never propagate cancellation until the native work has actually settled."""
    wrapped = asyncio.wrap_future(future) if isinstance(future, Future) else future
    cancelled = False
    while not wrapped.done():
        try:
            await asyncio.shield(wrapped)
        except asyncio.CancelledError:
            cancelled = True
        except Exception:
            break
    # Retrieve native failure even after cancellation: it is not a stopped receipt.
    result = wrapped.result()
    if cancelled:
        raise asyncio.CancelledError()
    return result


class _NativeLane:
    """One owner thread, at most one outstanding operation, no hidden work queue."""

    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vertex-nautilus-offline")
        self._lock, self._pending, self._closing = Lock(), None, False

    def submit(self, operation: Any, *, disposal: bool = False) -> Future:
        with self._lock:
            _require((not self._closing or disposal)
                     and (self._pending is None or self._pending.done()))
            self._pending = self._executor.submit(operation)
            return self._pending

    def begin_close(self) -> Future | None:
        with self._lock:
            self._closing = True
            return self._pending

    def shutdown(self) -> None:
        # Called only AFTER the last native future has settled. No native work
        # is abandoned or cancellation-killed; hung native calls never get here.
        self._executor.shutdown(wait=True, cancel_futures=False)


class NativeOfflineQuoteEngine:
    """Genuine BacktestEngine ingestion; a complete finite capture triggers replay.

    No strategies, controllers, plugins, data clients or live engine are loaded.
    Partial captures are disposed without a run. Failure after native ingress is
    latched UNKNOWN locally and never retried by AsyncTickDrain. Exact duplicate
    committed ticks are idempotent; changed-content IDs fail closed.
    """

    def __init__(self, *, engine: Any, api: Mapping[str, ModuleType], resolver: CapturedQuoteResolver,
                 instruments: Mapping[str, Any], current: Any, lane: _NativeLane) -> None:
        self._engine, self._api, self._resolver = engine, api, resolver
        self._instruments, self._current = MappingProxyType(dict(instruments)), current
        self._count, self._failed, self._closed = 0, False, False
        self._accepted: set[str] = set()
        self._lane = lane
        self._close_task: asyncio.Task | None = None

    async def process_tick(self, tick: TickEvent) -> None:
        await _joined_future(self._lane.submit(lambda: self._process_tick(tick)))

    def _process_tick(self, tick: TickEvent) -> None:
        try:
            _require(not self._closed and not self._failed)
            self._current()
            quote = self._resolver.resolve(tick)
            if tick.event_id in self._accepted:
                return
            _require(self._count < len(self._resolver.quotes) and quote == self._resolver.quotes[self._count])
            instrument = self._instruments[quote.instrument_id]
            model = self._api["model"]
            bid, ask = model.Price.from_str(quote.bid), model.Price.from_str(quote.ask)
            bid_size, ask_size = model.Quantity.from_str(quote.bid_size), model.Quantity.from_str(quote.ask_size)
            _require(bid.as_decimal() == Decimal(quote.bid) and ask.as_decimal() == Decimal(quote.ask)
                     and bid_size.as_decimal() == Decimal(quote.bid_size)
                     and ask_size.as_decimal() == Decimal(quote.ask_size))
            _require(bid.precision == ask.precision == instrument.price_precision
                     and bid_size.precision == ask_size.precision == instrument.size_precision)
            native = model.QuoteTick(instrument_id=instrument.id, bid_price=bid, ask_price=ask,
                                    bid_size=bid_size, ask_size=ask_size,
                                    ts_event=quote.event_ns, ts_init=quote.init_ns)
            self._current()
            # Latch BEFORE first native mutation; even acknowledgement loss must
            # not lead to a second add_data/run attempt with the same capture.
            self._failed = True
            self._engine.add_data([native], validate=True, sort=True)
            self._count += 1
            if self._count == len(self._resolver.quotes):
                self._engine.run(start=self._resolver.quotes[0].init_ns,
                                 end=self._resolver.quotes[-1].init_ns, streaming=False)
                self._engine.clear_data()
            self._accepted.add(tick.event_id)
            self._failed = False
        except Exception:
            self._failed = True
            raise NautilusHostUnavailable() from None

    async def close(self) -> None:
        if self._close_task is None:
            # Fence new submissions before yielding to the loop. Multiple close
            # callers join the same cleanup; cancelled close never means stopped.
            pending = self._lane.begin_close()
            self._close_task = asyncio.create_task(self._close_joined(pending))
        await _joined_future(self._close_task)

    async def _close_joined(self, pending: Future | None) -> None:
        cancelled = False
        if pending is not None:
            try:
                await _joined_future(pending)
            except asyncio.CancelledError:
                cancelled = True
            except Exception:
                # A prior replay failure does not prevent same-lane disposal.
                pass
        try:
            await _joined_future(self._lane.submit(self._dispose, disposal=True))
        except asyncio.CancelledError:
            cancelled = True
        finally:
            self._lane.shutdown()
        if cancelled:
            raise asyncio.CancelledError()

    def _dispose(self) -> None:
        self._closed = True
        try:
            self._engine.dispose()
        except Exception:
            raise NautilusHostUnavailable() from None
        finally:
            # BacktestEngine is PyO3 unsendable: drop its last reference on the
            # constructing lane, not later during host/event-loop GC.
            self._engine = None
            self._instruments = MappingProxyType({})


_EQUITY_KEYS = ("type id raw_symbol currency price_precision price_increment lot_size isin margin_init "
                "margin_maint maker_fee taker_fee min_price max_price max_quantity min_quantity ts_event "
                "ts_init tick_scheme info")


class NativeOfflineEngineFactory:
    def __init__(self, *, loader: ReviewedNautilusLoader, config: dict[str, Any], resolver: CapturedQuoteResolver) -> None:
        self._loader, self._config, self._resolver = loader, json.dumps(config), resolver
        self._attempted = False

    def __call__(self, module: object, scope: OfflineEngineScope) -> NativeOfflineQuoteEngine:
        _require(not self._attempted)
        self._attempted = True
        lane = _NativeLane()
        try:
            # activate() is synchronous and parent invokes it in its joined host
            # activation thread. Native construction itself owns this same lane.
            return lane.submit(lambda: self._construct(module, scope, lane)).result()
        except BaseException:
            lane.shutdown()
            raise

    def _construct(self, module: object, scope: OfflineEngineScope,
                   lane: _NativeLane) -> NativeOfflineQuoteEngine:
        engine = None
        try:
            _require(type(scope) is OfflineEngineScope
                     and scope.version == NAUTILUS_VERSION and scope.simulation_only
                     and not scope.live_authorization and not scope.broker_submission_allowed)
            api = self._loader.api(module)
            config = json.loads(self._config)
            _require(scope.mode == config["mode"])
            model = api["model"]
            engine_config = api["backtest"].BacktestEngineConfig(
                trader_id=model.TraderId(config["traderId"]),
                logging=api["common"].LoggerConfig(bypass_logging=True),
                bypass_logging=True, streaming=None, catalogs=[], controller=None,
                load_state=False, save_state=False, run_analysis=False,
            )
            # rc5 has no actors/strategies/exec_algorithms config keywords.
            # We intentionally register none through its explicit add_* API.
            engine = api["backtest"].BacktestEngine(config=engine_config)
            venue = config["venue"]
            currency = model.Currency.from_str(venue["currency"], strict=True)
            balance = model.Money.from_str(venue["startingBalance"] + " " + venue["currency"])
            _require(balance.as_decimal() == Decimal(venue["startingBalance"]))
            engine.add_venue(
                venue=model.Venue(venue["id"]), oms_type=model.OmsType.NETTING,
                account_type=model.AccountType.CASH, base_currency=currency,
                starting_balances=[balance], default_leverage=Decimal(venue["defaultLeverage"]),
                book_type=model.BookType.L1_MBP, routing=False, allow_cash_borrowing=False,
                bar_execution=False, trade_execution=False, frozen_account=True,
            )
            instruments = {}
            for value in config["instruments"]:
                # Use rc5's typed constructor, not the legacy Cython dict schema.
                instrument = model.Equity(
                    instrument_id=model.InstrumentId.from_str(value["id"]),
                    raw_symbol=model.Symbol(value["raw_symbol"]), currency=currency,
                    price_precision=value["price_precision"],
                    price_increment=model.Price.from_str(value["price_increment"]),
                    lot_size=model.Quantity.from_str(value["lot_size"]),
                    isin=value["isin"], ts_event=value["ts_event"], ts_init=value["ts_init"],
                    margin_init=Decimal(value["margin_init"]), margin_maint=Decimal(value["margin_maint"]),
                    maker_fee=Decimal(value["maker_fee"]), taker_fee=Decimal(value["taker_fee"]),
                    min_quantity=(model.Quantity.from_str(value["min_quantity"])
                                  if value["min_quantity"] is not None else None),
                    max_quantity=(model.Quantity.from_str(value["max_quantity"])
                                  if value["max_quantity"] is not None else None),
                    min_price=None, max_price=None, tick_scheme=None, info={},
                )
                _require(str(instrument.id) == value["id"] and str(instrument.id.venue) == venue["id"]
                         and instrument.price_increment.as_decimal() == Decimal(value["price_increment"])
                         and instrument.lot_size.as_decimal() == Decimal(value["lot_size"]))
                engine.add_instrument(instrument)
                instruments[value["id"]] = instrument
            self._loader.current()
            return NativeOfflineQuoteEngine(engine=engine, api=api, resolver=self._resolver,
                                            instruments=instruments, current=self._loader.current, lane=lane)
        except Exception:
            if engine is not None:
                try:
                    engine.dispose()
                except Exception:
                    pass
                finally:
                    engine = None
            raise NautilusHostUnavailable() from None


def compose_nautilus(selection: Mapping[str, Any], cache: Any, contracts: Any,
                     buffer: BoundedTickBuffer, scope: OfflineEngineScope, *, clock: Any,
                     distribution_root: str | Path | None = None) -> ReviewedNautilusAdapter:
    """Compose lazily from private HostNautilusConfiguration, never activate here.

    Both config and HostNautilusQuoteCapture pins must be exact explicitly selected
    simulation-engine artifacts. Config is not a public schema. Distribution root
    comes from local reviewed host config, never cloud JSON. Missing config/root
    stays unavailable; no generated installer, fallback or import is attempted.
    Quote capture records are full sanitized original provider observations with
    eventId/instrumentId/bid/ask/bidSize/askSize/eventNs/initNs (ns decimal strings).
    """
    try:
        _require(type(scope) is OfflineEngineScope and type(buffer) is BoundedTickBuffer)
        selected = thaw(selection)
        _require(contracts.validate("RuntimePolicySelection", selected, schema_version="1.0.0") is True)
        _require(contracts.digest({key: value for key, value in selected.items() if key != "selectionSha256"})
                 == _digest(selected["selectionSha256"]))
        issued, expiry = contracts.epoch_ns(selected["issuedAt"]), contracts.epoch_ns(selected["expiresAt"])
        _require(type(issued) is int and type(expiry) is int and type(clock.now_ns()) is int
                 and issued <= clock.now_ns() < expiry and selected["environment"] == scope.mode)
        pins = [item["artifact"] for item in selected["artifacts"] if item["role"] == "simulation-engine"]
        configs = [pin for pin in pins if pin["contractName"] == "HostNautilusConfiguration"]
        if not configs:
            return ReviewedNautilusAdapter(mode=scope.mode, buffer=buffer, captured=())
        _require(len(configs) == 1)
        def original(pin: Any, contract: str) -> dict[str, Any]:
            _object(pin, "artifactId artifactSha256 contractName schemaVersion")
            _require(pin["contractName"] == contract and pin["schemaVersion"] == "1.0.0"
                     and sum(candidate == pin for candidate in pins) == 1)
            return _decode(cache.private_bytes(pin["artifactId"], _digest(pin["artifactSha256"])), pin["artifactSha256"])
        config = original(configs[0], "HostNautilusConfiguration")
        _object(config, "format accountAlias mode traderId distribution venue instruments capture")
        _require(config["format"] == "vertex-host-nautilus-v2" and config["mode"] == scope.mode
                 and config["accountAlias"] == selected["accountAlias"])
        _identifier(config["traderId"])
        distribution = _object(config["distribution"], "name version buildSha256 files")
        _require(distribution["name"] == "nautilus-trader" and type(distribution["files"]) is dict)
        reviewed = ReviewedDistribution(distribution["version"], distribution["buildSha256"],
                                         tuple(sorted(distribution["files"].items())))
        build_body = {key: value for key, value in distribution.items() if key != "buildSha256"}
        _require(contracts.digest(build_body) == reviewed.build_sha256)
        venue = _object(config["venue"], "id currency startingBalance defaultLeverage accountType omsType bookType")
        _identifier(venue["id"])
        _identifier(venue["currency"])
        _decimal(venue["startingBalance"])
        _require(venue["accountType"] == "CASH" and venue["omsType"] == "NETTING" and venue["bookType"] == "L1_MBP"
                 and _decimal(venue["defaultLeverage"]) == Decimal(1))
        instruments = config["instruments"]
        _require(type(instruments) is list and 1 <= len(instruments) <= 256)
        by_id = {}
        for instrument in instruments:
            _object(instrument, _EQUITY_KEYS)
            _require(instrument["type"] == "Equity" and instrument["currency"] == venue["currency"]
                     and instrument["id"].endswith("." + venue["id"]))
            _identifier(instrument["id"])
            _identifier(instrument["raw_symbol"])
            _require(instrument["id"] not in by_id and type(instrument["price_precision"]) is int
                     and 0 <= instrument["price_precision"] <= 9)
            _decimal(instrument["price_increment"])
            _decimal(instrument["lot_size"])
            for field in ("margin_init", "margin_maint", "maker_fee", "taker_fee"):
                _decimal(instrument[field], positive=False)
            _require(Decimal(instrument["margin_init"]) >= 0 and Decimal(instrument["margin_maint"]) >= 0)
            for field in ("max_quantity", "min_quantity"):
                if instrument[field] is not None:
                    _decimal(instrument[field])
            _require(instrument["min_price"] is None and instrument["max_price"] is None
                     and instrument["tick_scheme"] is None and instrument["info"] == {}
                     and (instrument["isin"] is None or type(instrument["isin"]) is str))
            _require(_uint(instrument["ts_event"]) <= _uint(instrument["ts_init"]))
            by_id[instrument["id"]] = instrument
        capture = original(config["capture"], "HostNautilusQuoteCapture")
        _object(capture, "format accountAlias events")
        _require(capture["format"] == "vertex-host-nautilus-quotes-v1"
                 and capture["accountAlias"] == selected["accountAlias"]
                 and type(capture["events"]) is list and 2 <= len(capture["events"]) <= 16_384)
        quotes = []
        for row in capture["events"]:
            _object(row, "eventId instrumentId bid ask bidSize askSize eventNs initNs")
            for field in ("eventNs", "initNs"):
                _require(type(row[field]) is str and re.fullmatch(r"0|[1-9][0-9]{0,19}", row[field]) is not None)
            quote = CapturedQuote(row["eventId"], row["instrumentId"], row["bid"], row["ask"],
                                  row["bidSize"], row["askSize"], int(row["eventNs"]), int(row["initNs"]))
            _require(quote.instrument_id in by_id and by_id[quote.instrument_id]["ts_init"] <= quote.init_ns)
            quotes.append(quote)
        resolver = CapturedQuoteResolver(tuple(quotes))
        loader = ReviewedNautilusLoader(distribution=reviewed, root=distribution_root, contracts=contracts,
                                        clock=clock, issued_ns=issued, expires_ns=expiry)
        captured = tuple(TickEvent(quote.instrument_id, quote.event_id, quote.event_ns,
                                   bid=Decimal(quote.bid), ask=Decimal(quote.ask)) for quote in resolver.quotes)
        return ReviewedNautilusAdapter(mode=scope.mode, buffer=buffer, load_module=loader, captured=captured,
                                       factory=NativeOfflineEngineFactory(loader=loader, config=config, resolver=resolver))
    except Exception:
        raise NautilusHostUnavailable() from None
