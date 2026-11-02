"""Injected offline adapter boundaries; importing this package starts nothing."""

from .callbacks import AsyncTickDrain, BoundedTickBuffer, TickBufferState, TickContinuityLost, TickEvent
from .contracts import AdapterContractError, ContractAuthority
from .kernel import (
    KERNEL_REQUEST_VERSION,
    KernelCommandTransport,
    KernelEvaluation,
    KernelTransportUnavailable,
    PreparedKernelCommand,
    RustKernelCommandAdapter,
)
from .nautilus_200rc5 import (
    NAUTILUS_VERSION,
    EngineUnavailable,
    EngineVersionMismatch,
    Nautilus200rc5Adapter,
    OfflineEngine,
    OfflineEngineFactory,
    OfflineEngineScope,
)
from .research import (
    AttestedResearchSimulationEngine,
    BoundedEventLoader,
    CapturedMarketEvent,
    ResearchEngineRunner,
    ResearchEngineUnavailable,
    ResearchRunBinding,
    SandboxAttestationRejected,
    SandboxAttestationVerifier,
    SandboxSession,
    SandboxSupervisor,
    SupervisedResult,
)

__all__ = [
    "AdapterContractError", "AsyncTickDrain", "AttestedResearchSimulationEngine",
    "BoundedEventLoader", "BoundedTickBuffer", "CapturedMarketEvent", "ContractAuthority",
    "EngineUnavailable", "EngineVersionMismatch", "KERNEL_REQUEST_VERSION",
    "KernelCommandTransport", "KernelEvaluation", "KernelTransportUnavailable", "NAUTILUS_VERSION",
    "Nautilus200rc5Adapter", "OfflineEngine", "OfflineEngineFactory", "OfflineEngineScope",
    "PreparedKernelCommand", "ResearchEngineRunner", "ResearchEngineUnavailable", "ResearchRunBinding",
    "RustKernelCommandAdapter", "SandboxAttestationRejected", "SandboxAttestationVerifier",
    "SandboxSession", "SandboxSupervisor", "SupervisedResult", "TickBufferState",
    "TickContinuityLost", "TickEvent",
]
