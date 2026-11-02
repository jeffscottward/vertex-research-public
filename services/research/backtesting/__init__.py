"""Immutable research replay, lineage planning and optional event diagnostics.

Importing the package does not create a simulator, contact a provider, open a
store, authorize orders or import numpy/scipy. Those backends remain optional.
"""
from .manifest import (
    ReplayExecutionBinding,
    ReplayHorizon,
    ReplayManifestQualification,
    ReplayOutcomeArtifact,
    ReplayOutcomeObservation,
    ReplaySourceManifest,
    ReplaySourceSnapshot,
)
from .planner import (
    BacktestCompletion,
    BacktestPlan,
    BacktestPlanner,
    BacktestRequest,
    DatasetInput,
    EngineDescriptor,
    SandboxReceipt,
    SimulationEngine,
    SimulationOutput,
    SimulationRequest,
)
from .ports import Artifact, CanonicalCodec, ContractValidator, PublicBoundary, ResourceBudget
from .replay import (
    CandidateRevision,
    CapturedReplayExecution,
    CapturedSource,
    ReplayRequest,
    ReplayResult,
    ReplayRunner,
    SUPPLIED_OUTCOME_REPLAY_LABEL,
)

__all__ = [
    "Artifact", "BacktestCompletion", "BacktestPlan", "BacktestPlanner", "BacktestRequest",
    "CandidateRevision", "CanonicalCodec", "CapturedReplayExecution", "CapturedSource",
    "ContractValidator", "DatasetInput", "EngineDescriptor", "PublicBoundary", "ResourceBudget",
    "ReplayExecutionBinding", "ReplayHorizon", "ReplayManifestQualification", "ReplayOutcomeArtifact",
    "ReplayOutcomeObservation", "ReplayRequest", "ReplayResult", "ReplayRunner", "ReplaySourceManifest",
    "ReplaySourceSnapshot", "SUPPLIED_OUTCOME_REPLAY_LABEL", "SandboxReceipt", "SimulationEngine",
    "SimulationOutput", "SimulationRequest",
]
