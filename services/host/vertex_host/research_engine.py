"""Bounded reviewed research composition; no strategy eval or broker.

Production selects the explicit Nautilus v2 worker path, never the legacy
FixedQuoteResearchRunner below. Missing native review/runtime stays unavailable.
The legacy custom runner is retained only for explicitly labeled compatibility.
"""
from __future__ import annotations

import hashlib
import heapq
import io
import re
from dataclasses import asdict, dataclass
from decimal import Decimal, Inexact, Rounded, localcontext
from typing import Any, Iterable, TYPE_CHECKING

from vertex_execution.adapters.contracts import ContractAuthority, canonical_record
from vertex_execution.adapters.research import CapturedMarketEvent, ResearchEngineUnavailable

from .sandbox import (
    LinuxSandboxSupervisor, SandboxRejected, _hash, _integer, pack,
    protocol_bytes, protocol_record, wire_registry,
)

if TYPE_CHECKING:
    import threading
    from backtesting.planner import EngineDescriptor, SimulationOutput, SimulationRequest
    from .sandbox_worker import LocalEnforcedSupervisor

EVENT_FORMAT = "vertex-jsonl-events-v1"
ENGINE_ID = "vertex-quote-round-trip"
ENGINE_VERSION = "1.0.0"
MODELED_ASSUMPTIONS = ("commission", "slippage", "spread")


def _decimal(value: Any, *, positive: bool = False) -> Decimal:
    if type(value) is not str or re.fullmatch(r"(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,12})?", value) is None:
        raise ValueError("nonnegative exact fixed-point decimal required")
    result = Decimal(value)
    if positive and result <= 0:
        raise ValueError("positive decimal required")
    return result


def _text_decimal(value: Decimal) -> str:
    if not value.is_finite():
        raise ValueError("finite model result required")
    return format(value, "f")


@dataclass(frozen=True, slots=True)
class ReviewedResearchModel:
    strategy_digest: str
    strategy_code_digest: str
    assumptions_digest: str
    engine_digest: str
    review_digest: str
    instrument_id: str
    quantity: str
    initial_cash: str
    commission_per_fill: str
    slippage_per_unit: str
    enter_not_before_ns: int
    exit_not_before_ns: int
    evidence_template_bytes: bytes
    native_configuration_bytes: bytes = b""

    def __post_init__(self) -> None:
        for value in (self.strategy_digest, self.strategy_code_digest, self.assumptions_digest,
                      self.engine_digest, self.review_digest):
            _hash(value)
        if type(self.instrument_id) is not str or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", self.instrument_id) is None:
            raise ValueError("immutable instrument identity required")
        _decimal(self.quantity, positive=True)
        _decimal(self.initial_cash, positive=True)
        _decimal(self.commission_per_fill)
        _decimal(self.slippage_per_unit)
        _integer(self.enter_not_before_ns, 0, 2**127 - 1)
        _integer(self.exit_not_before_ns, self.enter_not_before_ns + 1, 2**127 - 1)
        if type(self.evidence_template_bytes) is not bytes or len(self.evidence_template_bytes) > 64_000:
            raise ValueError("bounded reviewed evidence template required")
        template = protocol_record(self.evidence_template_bytes, 64_000)
        if template.get("acceptanceStatus") != "unreviewed" or template.get("untrustedContent") is not True:
            raise ValueError("new worker evidence must remain unreviewed and untrusted")
        if type(self.native_configuration_bytes) is not bytes or len(self.native_configuration_bytes) > 1_048_576:
            raise ValueError("bounded immutable native research configuration required")

    def record(self) -> dict[str, Any]:
        import base64
        result = asdict(self)
        result["evidence_template_bytes"] = base64.b64encode(self.evidence_template_bytes).decode("ascii")
        result["native_configuration_bytes"] = base64.b64encode(self.native_configuration_bytes).decode("ascii")
        # Private v2 JSON uses exact decimal strings, never lossy JS numbers.
        result["enter_not_before_ns"] = str(self.enter_not_before_ns)
        result["exit_not_before_ns"] = str(self.exit_not_before_ns)
        return result

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> ReviewedResearchModel:
        import base64
        from dataclasses import fields
        if type(record) is not dict or set(record) != {field.name for field in fields(cls)}:
            raise SandboxRejected("fixed model fields mismatch")
        result = dict(record)
        result["evidence_template_bytes"] = base64.b64decode(result["evidence_template_bytes"], validate=True)
        result["native_configuration_bytes"] = base64.b64decode(result["native_configuration_bytes"], validate=True)
        for name in ("enter_not_before_ns", "exit_not_before_ns"):
            value = result[name]
            if type(value) is not str or re.fullmatch(r"(?:0|[1-9][0-9]{0,38})", value) is None:
                raise SandboxRejected("native model nanoseconds require canonical decimal strings")
            result[name] = int(value)
        return cls(**result)


class JsonlEventLoader:
    """Heap-merge bounded immutable JSONL captures by causal availability.

    Each exact private row has eventId, eventNs, availableNs and payload. No paths,
    URLs, compressed streams, parsers selected by input, or network are accepted.
    Every declared row must be present; duplicate identity/order and excess rows
    fail rather than silently truncate. Payloads remain private captured records.
    """
    def __init__(self, authority: ContractAuthority) -> None:
        self.authority = authority

    def load(self, request: SimulationRequest, *, maximum_events: int,
             maximum_bytes: int) -> Iterable[CapturedMarketEvent]:
        _integer(maximum_events, 1, 2_000_000)
        _integer(maximum_bytes, 1, 64_000_000)
        sources = request.plan.request.datasets
        if len(sources) != len(request.plan.datasets) or not 1 <= len(sources) <= 512:
            raise ValueError("bounded matched dataset captures required")
        if sum(source.declared_events for source in sources) > maximum_events:
            raise ValueError("declared event count exceeds limit")
        if sum(len(source.content_bytes or b"") for source in sources) > maximum_bytes:
            raise ValueError("dataset bytes exceed limit")
        streams = []
        seen_digests: set[str] = set()
        for source, artifact in zip(sources, request.plan.datasets, strict=True):
            if source.content_format != EVENT_FORMAT or type(source.content_bytes) is not bytes:
                raise ResearchEngineUnavailable("only immutable vertex JSONL captures are supported")
            manifest = artifact.decode()
            digest = hashlib.sha256(source.content_bytes).hexdigest()
            if digest != manifest["contentHash"] or digest in seen_digests:
                raise ValueError("dataset identity mismatch or duplicate capture")
            seen_digests.add(digest)
            start = self.authority.epoch_ns(manifest["startAtInclusive"])
            end = self.authority.epoch_ns(manifest["endAtExclusive"])
            cutoff = self.authority.epoch_ns(manifest["captureTime"])
            if any(type(value) is not int for value in (start, end, cutoff)) or not 0 <= start < end <= cutoff:
                raise ValueError("invalid native dataset clock bounds")
            streams.append(iter(self._rows(source.content_bytes, digest, source.declared_events, start, end, cutoff)))
        heap: list[tuple[int, int, int, CapturedMarketEvent]] = []
        for index, stream in enumerate(streams):
            event = next(stream, None)
            if event is None:
                raise ValueError("empty declared dataset")
            heapq.heappush(heap, (event.available_ns, event.event_ns, index, event))
        count = size = 0
        while heap:
            _, _, index, event = heapq.heappop(heap)
            count += 1
            size += len(event.payload_bytes)
            if count > maximum_events or size > maximum_bytes:
                raise ValueError("loaded event limit exceeded")
            yield event
            following = next(streams[index], None)
            if following is not None:
                heapq.heappush(heap, (following.available_ns, following.event_ns, index, following))

    @staticmethod
    def _rows(content: bytes, digest: str, declared: int, start: int, end: int,
              cutoff: int) -> Iterable[CapturedMarketEvent]:
        stream = io.BytesIO(content)
        count = 0
        previous = (-1, -1)
        identities: set[str] = set()
        while True:
            line = stream.readline(1_100_001)
            if not line:
                break
            if len(line) > 1_100_000 or not line.endswith(b"\n"):
                raise ValueError("bounded newline-terminated event record required")
            row = protocol_record(line[:-1], 1_100_000)
            if set(row) != {"eventId", "eventNs", "availableNs", "payload"} or type(row["payload"]) is not dict:
                raise ValueError("fixed captured event envelope required")
            event_ns = _integer(row["eventNs"], start, end - 1)
            available_ns = _integer(row["availableNs"], event_ns, cutoff)
            payload = protocol_bytes(row["payload"], 1_000_000)
            event = CapturedMarketEvent(digest, row["eventId"], event_ns, available_ns, payload)
            key = (available_ns, event_ns)
            if event.event_id in identities or key < previous:
                raise ValueError("duplicate or noncausal dataset event")
            identities.add(event.event_id)
            previous = key
            count += 1
            if count > declared:
                raise ValueError("extra undeclared dataset event")
            yield event
        if count != declared:
            raise ValueError("declared dataset events missing")


class FixedQuoteResearchRunner:
    """Worker-local deterministic fixed reviewed model, never a plugin registry."""
    def __init__(self, descriptor: EngineDescriptor, authority: ContractAuthority,
                 model: ReviewedResearchModel, supervisor: LocalEnforcedSupervisor) -> None:
        self.descriptor = descriptor
        self.authority = authority
        self.model = model
        self.supervisor = supervisor
        self._check_descriptor()

    def _check_descriptor(self) -> None:
        if (self.descriptor.pin.identity, self.descriptor.pin.version, self.descriptor.pin.digest) != (
            ENGINE_ID, ENGINE_VERSION, self.model.engine_digest
        ) or self.descriptor.supported_formats != (EVENT_FORMAT,) or self.descriptor.modeled_assumptions != MODELED_ASSUMPTIONS or self.descriptor.simulation_only is not True:
            raise ResearchEngineUnavailable("fixed reviewed engine descriptor mismatch")

    def describe(self) -> EngineDescriptor:
        self._check_descriptor()
        return self.descriptor

    def run(self, request: SimulationRequest, events: tuple[CapturedMarketEvent, ...]) -> SimulationOutput:
        from backtesting.planner import SimulationOutput
        plan, model = request.plan, self.model
        binding = self.supervisor.active_binding
        if binding is None or plan.strategy is None or plan.lineage is None:
            raise ResearchEngineUnavailable("worker-local active attested session required")
        if (plan.strategy.digest != model.strategy_digest
                or plan.request.lineage.code_pin.digest != model.strategy_code_digest
                or plan.engine != self.descriptor):
            raise ResearchEngineUnavailable("strategy has no reviewed fixed-model binding")
        # The planner's Assumptions.v1 artifact is the list itself, not a wrapper.
        assumption_records = [item.record() for item in plan.request.lineage.assumptions]
        assumption_bytes = self.authority.encode(assumption_records)
        assumptions_digest = self.authority.digest(assumption_records)
        if (type(assumption_bytes) is not bytes or len(assumption_bytes) > plan.request.budget.maximum_input_bytes
                or hashlib.sha256(assumption_bytes).hexdigest() != assumptions_digest
                or assumptions_digest != model.assumptions_digest):
            raise ResearchEngineUnavailable("reviewed assumption parameters changed")
        if any(item.disposition == "modeled" and item.kind not in MODELED_ASSUMPTIONS for item in plan.request.lineage.assumptions):
            raise ResearchEngineUnavailable("model does not implement a requested economic assumption")
        run = plan.run.decode()
        test_start = self.authority.epoch_ns(run["testWindow"]["startAtInclusive"])
        test_end = self.authority.epoch_ns(run["testWindow"]["endAtExclusive"])
        if not test_start <= model.enter_not_before_ns < model.exit_not_before_ns < test_end:
            raise ResearchEngineUnavailable("reviewed entry/exit must lie inside sealed test window")
        if not events:
            raise ValueError("empty economics input")
        quantity = _decimal(model.quantity, positive=True)
        cash = _decimal(model.initial_cash, positive=True)
        fee = _decimal(model.commission_per_fill)
        slippage = _decimal(model.slippage_per_unit)
        entry = exit_event = None
        entry_price = exit_price = None
        with localcontext() as context:
            context.prec = 128
            context.traps[Inexact] = True
            context.traps[Rounded] = True
            previous = -1
            for event in events:
                if event.available_ns < previous:
                    raise ValueError("noncausal simulation events")
                previous = event.available_ns
                quote = protocol_record(event.payload_bytes, 1_000_000)
                if set(quote) != {"instrumentId", "bid", "ask", "bidSize", "askSize"}:
                    raise ResearchEngineUnavailable("only captured cash-equity top-of-book quotes are modeled")
                if quote["instrumentId"] != model.instrument_id:
                    raise ResearchEngineUnavailable("model instrument differs from capture")
                bid = _decimal(quote["bid"], positive=True)
                ask = _decimal(quote["ask"], positive=True)
                bid_size = _decimal(quote["bidSize"])
                ask_size = _decimal(quote["askSize"])
                if bid > ask:
                    raise ValueError("crossed quote cannot establish executable spread")
                if not test_start <= event.event_ns <= event.available_ns < test_end:
                    continue
                if entry is None and model.enter_not_before_ns <= event.available_ns < model.exit_not_before_ns:
                    if ask_size < quantity:
                        continue
                    entry_price = ask + slippage
                    if entry_price * quantity + fee > cash:
                        raise ResearchEngineUnavailable("reviewed cash-only model cannot fund its entry")
                    entry = event
                elif entry is not None and event.available_ns >= model.exit_not_before_ns:
                    if bid_size < quantity:
                        continue
                    exit_price = bid - slippage
                    if exit_price <= 0:
                        raise ValueError("nonpositive modeled exit")
                    exit_event = event
                    break
            completed = entry is not None and exit_event is not None
            metrics: dict[str, str] = {}
            fills = []
            if completed:
                assert entry_price is not None and exit_price is not None and entry is not None and exit_event is not None
                gross = (exit_price - entry_price) * quantity
                net = gross - fee * 2
                metrics = {"gross-pnl": _text_decimal(gross), "net-pnl": _text_decimal(net),
                           "total-commission": _text_decimal(fee * 2), "ending-cash": _text_decimal(cash + net)}
                fills = [{"eventId": entry.event_id, "availableNs": str(entry.available_ns), "side": "buy", "price": _text_decimal(entry_price), "quantity": model.quantity},
                         {"eventId": exit_event.event_id, "availableNs": str(exit_event.available_ns), "side": "sell", "price": _text_decimal(exit_price), "quantity": model.quantity}]
        economics, _ = canonical_record(self.authority, {
            "model": ENGINE_ID, "modelVersion": ENGINE_VERSION, "reviewDigest": model.review_digest,
            "metricScope": "out-of-sample", "metrics": metrics, "simulatedFills": fills,
            "closedRoundTrip": completed, "executionAuthorized": False,
            "limitations": ["Fixed reviewed single-instrument cash-equity model only.",
                            "Displayed size is not queue-position or live liquidity proof.",
                            "No partial fills, corporate actions, borrow, margin, derivatives, or forward qualification.",
                            "Scientific acceptance and evidence review remain unavailable."],
        }, plan.request.budget.maximum_input_bytes)
        evidence = self.supervisor.isolation_evidence(self.authority, model.evidence_template_bytes)
        receipt = self.supervisor.receipt(len(events))
        return SimulationOutput(plan.lineage.digest, plan.strategy.digest, self.descriptor.pin,
            tuple(item.decode()["contentHash"] for item in plan.datasets), assumptions_digest,
            economics, (evidence,), MODELED_ASSUMPTIONS, receipt, True, True, completed,
            "inconclusive", ("fixed-model-realism-review-required",) if completed else ("fixed-model-round-trip-unavailable",))


class IsolatedResearchSimulationEngine:
    """Frozen SimulationEngine facade; whole authoritative adapter runs in child.

    Missing review/runtime/authority does not create a permissive fallback.
    describe() checks metadata only. simulate() is the explicit OS action boundary.
    """
    def __init__(self, *, descriptor: EngineDescriptor | None = None,
                 authority: ContractAuthority | None = None,
                 sandbox: LinuxSandboxSupervisor | None = None,
                 model: ReviewedResearchModel | None = None,
                 cancellation: threading.Event | None = None) -> None:
        self.descriptor = descriptor
        self.authority = authority
        self.sandbox = sandbox
        self.model = model
        self.cancellation = cancellation

    def describe(self) -> EngineDescriptor:
        if self.descriptor is None or self.authority is None or self.sandbox is None or self.sandbox.config is None or self.model is None:
            raise ResearchEngineUnavailable("reviewed offline research composition is unavailable")
        if self.descriptor.sandbox_policy_digest != self.sandbox.config.policy_digest:
            raise ResearchEngineUnavailable("research sandbox policy differs from reviewed runtime")
        from backtesting.historical import ENGINE_ID as BAR_ENGINE_ID
        from .nautilus_research import NATIVE_ROOT
        if self.descriptor.pin.identity == BAR_ENGINE_ID:
            from .nautilus_bars import RUNNER_PATH, configuration, validate_descriptor
        else:
            from .nautilus_research import configuration, validate_descriptor
            RUNNER_PATH = "/vertex/host/vertex_host/nautilus_research.py"
        from .sandbox import NATIVE_RESEARCH_PROFILE
        self.sandbox.config.task_limit(NATIVE_RESEARCH_PROFILE)
        validate_descriptor(self.descriptor, self.model)
        _, distribution = configuration(self.model)
        pins = {pin.path: pin.sha256 for pin in self.sandbox.config.runtime_files}
        if pins.get(RUNNER_PATH) != self.descriptor.pin.digest:
            raise ResearchEngineUnavailable("engine pin is not the reviewed native runner source hash")
        if any(pins.get(NATIVE_ROOT + "/" + name) != digest for name, digest in distribution.files):
            raise ResearchEngineUnavailable("native distribution is not sealed in the reviewed sandbox runtime")
        return self.descriptor

    def simulate(self, request: SimulationRequest) -> SimulationOutput:
        descriptor = self.describe()
        assert self.sandbox is not None and self.authority is not None and self.model is not None
        return self.sandbox.run_worker(request, descriptor, self.model, self.authority, cancellation=self.cancellation)


def make_research_engine(*, descriptor: EngineDescriptor | None = None,
                         authority: ContractAuthority | None = None,
                         sandbox: LinuxSandboxSupervisor | None = None,
                         model: ReviewedResearchModel | None = None,
                         cancellation: threading.Event | None = None) -> IsolatedResearchSimulationEngine:
    return IsolatedResearchSimulationEngine(descriptor=descriptor, authority=authority,
                                            sandbox=sandbox, model=model, cancellation=cancellation)


def create_backtest_handler(context: Any, cache: Any, raw_inputs: Any, sandbox: Any) -> Any:
    """Return the one lease handler; no loop, queue, runtime or publication starts.

    Private payload is exactly {format:'vertex-backtest-job-v1',recipeArtifactId,
    recipeSha256}. The selected simulation-engine/HostBacktestRecipe pin is the
    sole recipe authority. The recipe contains closed typed lineage/budget/engine
    envelopes and exact public/content references, never code or import names.
    A completed handler result means every output and updated BacktestRun was
    acknowledged by the existing control publication adapter. It does not mean
    scientific acceptance; this engine's new evidence always remains unreviewed.
    """
    import asyncio
    from collections.abc import Mapping
    from datetime import datetime
    from .cache import HostUnavailable, thaw
    import base64
    from .dispatcher import fence
    from .sandbox import unpack

    class CancellationPort:
        def cancelled(self) -> bool:
            return context.cancellation.is_set()

    def guard(lease: dict[str, Any]) -> None:
        deadline = min(context.contracts.epoch_ns(lease["leaseExpiresAt"]),
                       context.contracts.epoch_ns(lease["deadlineAt"]))
        if context.cancellation.is_set() or context.clock.now_ns() >= deadline:
            raise HostUnavailable("backtest-lease-fenced")

    def reference(value: Any) -> tuple[str, str]:
        if type(value) is not dict or set(value) != {"artifactId", "sha256"}:
            raise HostUnavailable("exact-backtest-reference-required")
        identity, digest = value["artifactId"], value["sha256"]
        if type(identity) is not str or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", identity) is None:
            raise HostUnavailable("backtest-artifact-identity-invalid")
        return identity, _hash(digest)

    def public_bytes(value: Any, name: str) -> tuple[str, bytes]:
        identity, digest = reference(value)
        artifact = cache.get(identity)
        if (artifact.artifact_id != identity or artifact.contract_name != name
                or artifact.sha256 != digest or hashlib.sha256(artifact.canonical_bytes).hexdigest() != digest):
            raise HostUnavailable("backtest-public-pin-mismatch")
        return identity, artifact.canonical_bytes

    def work(payload: dict[str, Any], lease: dict[str, Any]) -> dict[str, Any]:
        from agents.types import AcceptedReview
        from backtesting.lineage import LineageInputs
        from backtesting.planner import BacktestPlanner, BacktestRequest, DatasetInput, EngineDescriptor, SimulationRequest
        from backtesting.historical import (
            RECIPE as BAR_RECIPE, CONTENT as BAR_CONTENT, HistoricalBarInput,
            HistoricalBarLineage, HistoricalBarPlanner, canonical as bar_canonical,
        )
        from backtesting.ports import Artifact, PublicBoundary, ResourceBudget, require_id
        from vertex_control.adapters import ArtifactAdapter, ResearchContext, RightsAdapter

        guard(lease)
        if type(payload) is not dict or set(payload) != {"format", "recipeArtifactId", "recipeSha256"} or payload["format"] != "vertex-backtest-job-v1":
            raise HostUnavailable("backtest-job-envelope-required")
        recipe_id, recipe_digest = reference({"artifactId": payload["recipeArtifactId"], "sha256": payload["recipeSha256"]})
        selected = []
        for row in context.selection["artifacts"]:
            if row["role"] == "simulation-engine":
                pin = row["artifact"]
                if pin["contractName"] == "HostBacktestRecipe":
                    selected.append(pin)
        if len(selected) != 1 or selected[0]["artifactId"] != recipe_id or selected[0]["artifactSha256"] != recipe_digest:
            raise HostUnavailable("backtest-recipe-not-selected")
        recipe = cache.private(recipe_id, recipe_digest)
        expected = {"format", "strategy", "run", "datasets", "evidence", "lineage", "budget",
                    "descriptor", "model", "plannedAt", "publication"}
        historical = recipe.get("format") == BAR_RECIPE
        if historical:
            expected.add("reviewPins")
        if set(recipe) != expected or recipe["format"] not in {"vertex-host-backtest-recipe-v2", BAR_RECIPE}:
            raise HostUnavailable("closed-native-backtest-recipe-required")
        registry = wire_registry()
        lineage, budget, descriptor = (unpack(recipe[key], registry) for key in ("lineage", "budget", "descriptor"))
        if (type(lineage) is not (HistoricalBarLineage if historical else LineageInputs)
                or type(budget) is not ResourceBudget or type(descriptor) is not EngineDescriptor):
            raise HostUnavailable("typed-backtest-recipe-required")
        if historical and bar_canonical(context.contracts, lineage.review_pins_bytes, 262144) != recipe["reviewPins"]:
            raise HostUnavailable("historical-lineage-current-review-pin-set-mismatch")
        model = ReviewedResearchModel.from_record(recipe["model"])
        engine = sandbox.create_engine(descriptor, model)
        engine.describe()
        publication = recipe["publication"]
        if type(publication) is not dict or set(publication) != {"actorId", "collectionId", "snapshotId", "rightsPolicyId", "rightsVersion"}:
            raise HostUnavailable("exact-backtest-publication-scope-required")
        if any(type(value) is not str or not 1 <= len(value) <= 160 for value in publication.values()):
            raise HostUnavailable("bounded-backtest-publication-identities-required")
        research_context = ResearchContext(fence=fence(lease), actor_id=publication["actorId"],
            authorization=context.selection, clock=context.clock,
            deadline_ns=context.contracts.epoch_ns(lease["deadlineAt"]),
            rights_policy_id=publication["rightsPolicyId"], rights_version=publication["rightsVersion"],
            collection_id=publication["collectionId"], snapshot_id=publication["snapshotId"])
        rights = RightsAdapter(context.control, context.control_bridge, research_context)
        artifacts = ArtifactAdapter(context.control, context.control_bridge, research_context, rights)
        cancellation = CancellationPort()
        strategy_id, strategy_bytes = public_bytes(recipe["strategy"], "StrategySpec")
        run_id, run_bytes = public_bytes(recipe["run"], "BacktestRun")
        # Exact selected public artifact IDs, never recipe/content IDs or decoded
        # runId/datasetId aliases. stageArtifact verifies committed parents.
        input_ids = [strategy_id, run_id]
        if type(recipe["datasets"]) is not list or not 1 <= len(recipe["datasets"]) <= 64:
            raise HostUnavailable("bounded-backtest-datasets-required")
        if type(recipe["evidence"]) is not list or len(recipe["evidence"]) > 256:
            raise HostUnavailable("bounded-backtest-evidence-required")
        datasets = []
        used_bytes = len(strategy_bytes) + len(run_bytes)
        with artifacts.operation(research_context.deadline_ns, cancellation):
            rights.current(publication["rightsPolicyId"], ("read", "derive", "export", "store"),
                           collection_id=publication["collectionId"], expected_version=publication["rightsVersion"])
            for item in recipe["datasets"]:
                guard(lease)
                dataset_keys = {"manifest", "content", "contentFormat", "declaredEvents"}
                if historical:
                    dataset_keys.update(("collectionId", "reviewPins"))
                if type(item) is not dict or set(item) != dataset_keys:
                    raise HostUnavailable("closed-backtest-dataset-reference-required")
                manifest_id, manifest_bytes = public_bytes(item["manifest"], "DatasetManifest")
                content_id, content_digest = reference(item["content"])
                manifest = protocol_record(manifest_bytes, budget.maximum_input_bytes)
                if manifest["contentHash"] != content_digest or manifest["entitlementPolicyId"] != publication["rightsPolicyId"]:
                    raise HostUnavailable("backtest-content-or-rights-pin-mismatch")
                if historical:
                    if (len(recipe["datasets"]) != 1 or item["contentFormat"] != BAR_CONTENT
                            or content_id != manifest["storageRef"] or len(manifest["sources"]) != 1
                            or type(item["reviewPins"]) is not list or not item["reviewPins"]
                            or any(pin not in recipe["reviewPins"] for pin in item["reviewPins"])):
                        raise HostUnavailable("historical-exact-dataset-reader-binding-required")
                    manifest_ref = {"artifactId": manifest_id, "artifactSha256": hashlib.sha256(manifest_bytes).hexdigest()}
                    original = artifacts.read_dataset(collection_id=item["collectionId"], manifest=manifest_ref,
                        manifest_bytes=manifest_bytes, member="content", review_pins=item["reviewPins"])
                    capture = artifacts.read_dataset(collection_id=item["collectionId"], manifest=manifest_ref,
                        manifest_bytes=manifest_bytes, member="capture", source=manifest["sources"][0], review_pins=item["reviewPins"])
                    content = original["content"]
                    if capture["producer_job_id"] != original["producer_job_id"]:
                        raise HostUnavailable("historical-original-capture-producer-mismatch")
                    captured = capture["content"]
                    datasets.append(HistoricalBarInput(manifest_bytes, content, item["contentFormat"],
                        item["declaredEvents"], captured, original["producer_job_id"]))
                    used_bytes += len(captured)
                else:
                    content = raw_inputs.get(content_id) if isinstance(raw_inputs, Mapping) else None
                    if content is None:
                        content = artifacts.read(artifact_id=content_id, expected_digest=content_digest)
                    datasets.append(DatasetInput(manifest_bytes, content, item["contentFormat"], item["declaredEvents"]))
                if type(content) is not bytes or hashlib.sha256(content).hexdigest() != content_digest:
                    raise HostUnavailable("backtest-content-bytes-mismatch")
                used_bytes += len(content) + len(manifest_bytes)
                if used_bytes > budget.maximum_input_bytes:
                    raise HostUnavailable("backtest-input-byte-budget")
                input_ids.append(manifest_id)
            evidence_bytes = []
            citation_inputs: dict[str, tuple[str, bytes]] = {}
            citation_reviews: dict[str, tuple[str, int]] = {}
            for pin in recipe["evidence"]:
                guard(lease)
                identity, raw = public_bytes(pin, "ResearchEvidence")
                evidence = protocol_record(raw, budget.maximum_input_bytes)
                used_bytes += len(raw)
                if used_bytes > budget.maximum_input_bytes:
                    raise HostUnavailable("backtest-input-byte-budget")
                if (evidence["collectionId"] != publication["collectionId"]
                        or evidence["snapshotId"] != publication["snapshotId"]
                        or evidence["rightsPolicyId"] != publication["rightsPolicyId"]):
                    raise HostUnavailable("backtest-evidence-scope-mismatch")
                evidence_id = evidence["evidenceId"]
                if evidence_id in citation_inputs:
                    raise HostUnavailable("duplicate-backtest-evidence-identity")
                citation_inputs[evidence_id] = (pin["sha256"], raw)
                evidence_bytes.append(raw)
                input_ids.append(identity)

            def require_current_citation(artifact: Artifact) -> None:
                guard(lease)
                evidence_id = artifact.decode()["evidenceId"]
                original = citation_inputs.get(evidence_id)
                if (artifact.contract_name != "ResearchEvidence" or original is None
                        or (artifact.digest, artifact.payload_bytes) != original):
                    raise HostUnavailable("backtest-citation-original-pin-mismatch")
                expected_review = None
                if historical:
                    declared = [pin for pin in recipe["reviewPins"] if pin["evidenceId"] == evidence_id]
                    if len(declared) != 1:
                        raise HostUnavailable("historical-current-exact-review-pin-mismatch")
                    expected_review = declared[0]
                reference_ns = context.clock.now_ns()
                review = rights.resolve_current(
                    actor_id=publication["actorId"], account_alias=lease["accountAlias"],
                    environment=lease["environment"], collection_id=publication["collectionId"],
                    snapshot_id=publication["snapshotId"], evidence_id=evidence_id,
                    artifact_digest=artifact.digest, original_bytes=original[1],
                    purpose="research", reference_ns=reference_ns, authorization=context.selection,
                    expected_pin=expected_review,
                )
                guard(lease)
                now_ns = context.clock.now_ns()
                if (not isinstance(review, AcceptedReview)
                        or (review.actor_id, review.account_alias, review.environment,
                            review.collection_id, review.snapshot_id, review.evidence_id,
                            review.artifact_digest, review.rights_policy_id, review.purpose)
                        != (publication["actorId"], lease["accountAlias"], lease["environment"],
                            publication["collectionId"], publication["snapshotId"], evidence_id,
                            artifact.digest, publication["rightsPolicyId"], "research")
                        or review.status != "accepted" or review.current is not True
                        or review.superseded is not False or review.rights_authorized is not True
                        or type(review.revision) is not int or review.revision < 1
                        or any(type(at) is not int for at in
                               (review.effective_ns, review.expires_ns, review.resolved_ns,
                                review.rights_valid_until_ns))
                        or review.resolved_ns != reference_ns
                        or not review.effective_ns <= reference_ns <= now_ns < review.expires_ns
                        or review.rights_valid_until_ns <= now_ns):
                    raise HostUnavailable("backtest-current-evidence-review-unavailable")
                review_pin = (require_id(review.review_id), review.revision)
                previous = citation_reviews.get(evidence_id)
                if previous is not None and previous != review_pin:
                    raise HostUnavailable("backtest-current-evidence-review-changed")
                citation_reviews[evidence_id] = review_pin

            planned_at = datetime.fromisoformat(recipe["plannedAt"].replace("Z", "+00:00"))
            if context.contracts.epoch_ns(recipe["plannedAt"]) > context.clock.now_ns():
                raise HostUnavailable("backtest-plan-clock-in-future")
            request = BacktestRequest(strategy_bytes, run_bytes, tuple(datasets), tuple(evidence_bytes),
                                      lineage, budget, planned_at)
            boundary = PublicBoundary(validator=context.contracts, codec=context.contracts,
                                      maximum_bytes=budget.maximum_input_bytes)
            planner = (HistoricalBarPlanner(boundary=boundary, engine=engine, model=model, citation_review=require_current_citation)
                       if historical else BacktestPlanner(boundary=boundary, engine=engine, citation_review=require_current_citation))
            plan = planner.plan(request)
            if plan.status != "ready":
                return {"status": "failed", "outputArtifactIds": [], "reasonCodes": list(plan.reasons)}
            for artifact in plan.evidence:
                require_current_citation(artifact)
            guard(lease)
            output = engine.simulate(SimulationRequest(plan))
            guard(lease)
            completion = planner.complete(plan, output,
                as_of=datetime.fromisoformat(context.clock.now().replace("Z", "+00:00")),
                reviewed_acceptance=False)
            if completion.run is None or completion.results is None or completion.status in ("unavailable", "rejected"):
                return {"status": "failed", "outputArtifactIds": [], "reasonCodes": list(completion.reasons)}
            # Prepare the complete graph before publication. Raw captures retain
            # their exact bytes; only supported ResearchEvidence is promoted.
            lineage_ids = tuple(dict.fromkeys(input_ids))
            if len(lineage_ids) != len(input_ids) or len(lineage_ids) + 3 > 64:
                raise HostUnavailable("backtest-publication-lineage-bound-or-ambiguous")
            result_digest = hashlib.sha256(completion.results.payload_bytes).hexdigest()
            if result_digest != completion.results.digest:
                raise HostUnavailable("backtest-original-results-digest-mismatch")
            result_id = "backtest-results-" + result_digest
            receipt = sandbox.last_receipt
            if receipt is None or receipt.isolation_content_bytes is None or receipt.start_attestation is None or receipt.finish_attestation is None:
                raise HostUnavailable("backtest-parent-isolation-receipt-unavailable")
            isolation_digest = hashlib.sha256(receipt.isolation_content_bytes).hexdigest()
            isolation_id = "sandbox-isolation-" + isolation_digest
            if len(output.evidence_bytes) != 1:
                raise HostUnavailable("exact-backtest-isolation-evidence-required")
            isolation_raw = output.evidence_bytes[0]
            isolation_evidence_digest = hashlib.sha256(isolation_raw).hexdigest()
            isolation_record = artifacts.validate_record("ResearchEvidence", isolation_raw,
                isolation_evidence_digest)
            isolation_evidence_id = isolation_record["evidenceId"]
            if (isolation_evidence_id != "isolation-" + receipt.observation.session_id
                    or isolation_record["sourceIdentity"]["sourceId"] != isolation_evidence_id
                    or isolation_record["sourceType"] != "derived-analysis"
                    or isolation_record["acceptanceStatus"] != "unreviewed"
                    or isolation_record["contentHash"] != isolation_digest
                    or isolation_record["sourceIdentity"]["contentHash"] != isolation_digest
                    or isolation_record["collectionId"] != publication["collectionId"]
                    or isolation_record["snapshotId"] != publication["snapshotId"]
                    or isolation_record["sourceIdentity"]["snapshotId"] != publication["snapshotId"]
                    or isolation_record["rightsPolicyId"] != publication["rightsPolicyId"]):
                raise HostUnavailable("backtest-isolation-original-binding-mismatch")
            receipt_record = {"format": "vertex-worker-observation-v1",
                              "observation": protocol_record(protocol_bytes(asdict(receipt.observation))),
                              "outputSha256": receipt.output_sha256,
                              "peakMemoryBytes": str(receipt.peak_memory_bytes),
                              "cpuMs": str(receipt.cpu_ms), "wallMs": str(receipt.wall_ms),
                              "memoryEvents": [[key, str(value)] for key, value in receipt.memory_events],
                              "isolationArtifactId": isolation_id,
                              "startAttestationBase64": base64.b64encode(receipt.start_attestation).decode("ascii"),
                              "finishAttestationBase64": base64.b64encode(receipt.finish_attestation).decode("ascii"),
                              "processExited": receipt.process_exited, "cgroupEmpty": receipt.cgroup_empty}
            receipt_raw = context.contracts.encode(receipt_record)
            receipt_digest = hashlib.sha256(receipt_raw).hexdigest()
            receipt_id = "sandbox-receipt-" + receipt_digest

            def capture_evidence(artifact_id: str, evidence_id: str, digest: str, claim: str) -> bytes:
                # Retain the selected worker provenance without relabelling the
                # original result, receipt, or isolation evidence bytes.
                record = {**isolation_record, "evidenceId": evidence_id,
                    "sourceIdentity": {**isolation_record["sourceIdentity"],
                                       "sourceId": artifact_id, "contentHash": digest},
                    "sourceLocator": artifact_id, "contentHash": digest,
                    "publishedAt": None, "claim": claim,
                    "method": "Exact SHA-256 capture of original native backtest output bytes.",
                    "limitations": ["Capture and committed lineage only; no scientific acceptance, metric success, forward qualification, or trading authority.",
                                    "Original native lineage and stage references remain inside the captured bytes."]}
                raw = context.contracts.encode(record)
                artifacts.validate_record("ResearchEvidence", raw, hashlib.sha256(raw).hexdigest())
                return raw

            def capture_identity(prefix: str, artifact_id: str, digest: str) -> str:
                # Equal source bytes alone do not identify inherited capture
                # provenance. Bind the exact original isolation evidence too.
                binding = {"sourceArtifactId": artifact_id, "sourceContentSha256": digest,
                           "isolationEvidenceId": isolation_evidence_id,
                           "isolationEvidenceSha256": isolation_evidence_digest}
                return prefix + hashlib.sha256(context.contracts.encode(binding)).hexdigest()

            result_evidence_id = capture_identity("backtest-results-evidence-", result_id, result_digest)
            receipt_evidence_id = capture_identity("sandbox-receipt-evidence-", receipt_id, receipt_digest)
            result_evidence_raw = capture_evidence(result_id, result_evidence_id, result_digest,
                "Original native backtest results retained without changing their bytes.")
            receipt_evidence_raw = capture_evidence(receipt_id, receipt_evidence_id, receipt_digest,
                "Original parent-observed worker receipt retained without changing its bytes.")
            guard(lease)
            run_record = completion.run.decode()
            public_run_id = "backtest-run-" + completion.run.digest
            if run_record["reviewStatus"] == "accepted" or run_record["resultsRef"] != result_id:
                raise HostUnavailable("backtest-result-cannot-upgrade-acceptance")
            graph_ids = (*lineage_ids, result_id, isolation_id, receipt_id,
                         result_evidence_id, isolation_evidence_id, receipt_evidence_id, public_run_id)
            if len(set(graph_ids)) != len(graph_ids):
                raise HostUnavailable("backtest-publication-graph-identity-conflict")
            public_output_ids: list[str] = []

            def publish_evidence(identity: str, raw: bytes, parents: tuple[str, ...]) -> None:
                guard(lease)
                result = artifacts.publish_record(contract_name="ResearchEvidence", artifact_id=identity,
                    content=raw, digest=hashlib.sha256(raw).hexdigest(), lineage_artifact_ids=parents)
                if result.get("state") != "running" or identity not in result.get("outputArtifactIds", ()):
                    raise HostUnavailable("backtest-publication-ledger-unconfirmed")
                public_output_ids.append(identity)

            try:
                # Raw source promotion requires canonicalSha256:null, even for
                # original canonical JSON. No staged ID is a metadata parent.
                artifacts.stage(artifact_id=result_id, content=completion.results.payload_bytes,
                    content_type="application/json", canonical_digest=None, lineage_artifact_ids=lineage_ids)
                publish_evidence(result_evidence_id, result_evidence_raw, lineage_ids)
                artifacts.stage(artifact_id=isolation_id, content=receipt.isolation_content_bytes,
                    content_type="application/json", canonical_digest=None,
                    lineage_artifact_ids=(result_evidence_id,))
                publish_evidence(isolation_evidence_id, isolation_raw, (result_evidence_id,))
                artifacts.stage(artifact_id=receipt_id, content=receipt_raw, content_type="application/json",
                    canonical_digest=None, lineage_artifact_ids=(result_evidence_id, isolation_evidence_id))
                publish_evidence(receipt_evidence_id, receipt_evidence_raw,
                    (result_evidence_id, isolation_evidence_id))
                guard(lease)
                result = artifacts.publish_experiment(completion.run, artifact_id=public_run_id,
                    lineage_artifact_ids=(*lineage_ids, *public_output_ids))
                if result.get("state") != "running" or public_run_id not in result.get("outputArtifactIds", ()):
                    raise HostUnavailable("backtest-publication-ledger-unconfirmed")
                public_output_ids.append(public_run_id)
                guard(lease)
            except Exception:
                # A later call may have committed despite an unknown response.
                # The dispatcher reconciles the authoritative output ledger once
                # before termination; never retry publication or claim success.
                return {"status": "unknown", "outputArtifactIds": public_output_ids,
                        "reasonCodes": ["backtest-publication-incomplete-or-unknown"],
                        "executionAuthorized": False}
            return {"status": "completed", "outputArtifactIds": public_output_ids,
                    "computationStatus": output.status, "reviewStatus": run_record["reviewStatus"],
                    "executionAuthorized": False}

    async def handler(payload: dict[str, Any], lease: dict[str, Any]) -> dict[str, Any]:
        task = asyncio.create_task(asyncio.to_thread(work, thaw(payload), lease))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            context.cancellation.set()
            # Repeated cancellation must not abandon an alive sandbox thread.
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if task.done() and not task.cancelled():
                task.exception()  # consume failure only after stop/cleanup finished
            raise
    return handler
