"""Native gateway observation/recovery boundary; imports perform no I/O.

Public contracts remain @darkfactory/api/vertex; this package exposes only
private native service values and injected ports. No transport is installed.
"""
from .adapters import GatewayObservationService
from .models import (
    Dimension, Environment, EvidenceState, GatewayProtocol, GatewayTarget,
    HostTrust, Observation, ObservationSnapshot, ReadinessAssessment,
    RecoveryOperation, RecoveryPhase, RecoveryPlan, RecoveryResult,
)
from .readiness import ObservationPolicy, assess_readiness, project_public_status
from .recovery import RecoveryCoordinator, RecoveryPolicy

__all__ = [
    "Dimension", "Environment", "EvidenceState", "GatewayObservationService",
    "GatewayProtocol", "GatewayTarget", "HostTrust", "Observation",
    "ObservationPolicy", "ObservationSnapshot", "ReadinessAssessment",
    "RecoveryCoordinator", "RecoveryOperation", "RecoveryPhase", "RecoveryPlan",
    "RecoveryPolicy", "RecoveryResult", "assess_readiness", "project_public_status",
]
