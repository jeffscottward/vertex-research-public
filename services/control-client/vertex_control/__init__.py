"""Native Worker transport and explicit research-port composition.

Imports perform no credential resolution, connection, loop creation or discovery.
"""
from .client import ClientConfig, ControlCancelled, ControlClient, ControlError, EnvelopeAdapter, SameORPCJSON
from .bridge import LoopBridge
from .adapters import (
    ArtifactAdapter, DatasetAdapter, ResearchContext, RightsAdapter, RunAdmissionAdapter,
    RunBinding, decode_content,
)
from .collections import CollectionAdapter, ResearchAdapters, RetrievalAdapter, create_research_adapters

__all__ = [
    "ClientConfig", "ControlClient", "ControlError", "ControlCancelled", "EnvelopeAdapter", "SameORPCJSON",
    "LoopBridge", "ResearchContext", "RunBinding", "ResearchAdapters", "create_research_adapters",
    "ArtifactAdapter", "DatasetAdapter", "RightsAdapter", "RunAdmissionAdapter", "CollectionAdapter",
    "RetrievalAdapter", "decode_content",
]
