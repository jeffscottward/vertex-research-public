"""Compose gateway capabilities only from an exact selected private configuration.

HostGatewayConfiguration, HostGatewayObservation and HostGatewayTrustEvidence
are private host records, NOT public API schemas. RuntimePolicySelection and
BrokerRecoveryStatus remain authority-validated. No provider/network discovery,
startup observation, host action or automatic recovery is performed here.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping, Protocol

from vertex_execution.exact import timestamp
from vertex_gateway.adapters import GatewayObservationService
from vertex_gateway.models import Dimension, Environment, GatewayProtocol, GatewayTarget
from vertex_gateway.readiness import ObservationPolicy

from .cache import thaw
from .gateway import (
    ActiveRecoveryGuard, DisabledHumanRecoveryExecutor, GatewayHostClock,
    GatewayHostSelection, GatewayHostUnavailable, HostGatewayStatusAdapter,
    HostObservationAdapter, ObservationLimits, ReviewedHostTrustAdapter,
    ReviewedHostTrustRecord, SQLiteDisabledRecoveryClaims, SelectedObservationSource,
    _digest, _envelope, _monotonic, _ns,
)


class OriginalGatewayInputs(Protocol):
    def private_bytes(self, artifact_id: str, sha256: str) -> bytes: ...


_CONFIG_KEYS = frozenset({
    "format", "accountAlias", "target", "endpointRef", "generationRef", "limits", "sources", "trustRecords",
})
_PIN_KEYS = frozenset({"artifactId", "artifactSha256", "contractName", "schemaVersion"})


def _object(value: Any, keys: frozenset[str]) -> dict[str, Any]:
    if type(value) is not dict or value.keys() != keys:
        raise GatewayHostUnavailable()
    return value


def _array(value: Any, maximum: int) -> list[Any]:
    if type(value) is not list or not 1 <= len(value) <= maximum:
        raise GatewayHostUnavailable()
    return value


def _duration(value: Any) -> int:
    if (type(value) is not str or not value.isascii() or not value.isdecimal()
            or len(value) > 12 or (value != "0" and value.startswith("0"))):
        raise GatewayHostUnavailable()
    result = int(value)
    if result > 300_000_000_000:
        raise GatewayHostUnavailable()
    return result


def _pin(value: Any, contract: str) -> dict[str, Any]:
    pin = _object(value, _PIN_KEYS)
    if (pin["contractName"] != contract or pin["schemaVersion"] != "1.0.0"
            or type(pin["artifactId"]) is not str or not 1 <= len(pin["artifactId"]) <= 256):
        raise GatewayHostUnavailable()
    _digest(pin["artifactSha256"])
    return pin


class SelectedCacheObservationProvider:
    """A bounded immutable byte snapshot, not an IO/cache-refresh callback.

    Construction captures ONLY explicitly selected original cache bytes. Reading
    does no filesystem, database, network or blocking cache-lock work and cannot
    select another reference. Evidence expiry is still checked by the adapter.
    """

    def __init__(self, *, selection: GatewayHostSelection, originals: Mapping[str, bytes],
                 clock: GatewayHostClock, maximum_bytes: int, issued_ns: int, expires_ns: int) -> None:
        self._selection, self._clock = selection, clock
        self._maximum_bytes, self._issued_ns, self._expires_ns = maximum_bytes, issued_ns, expires_ns
        if (set(originals) != {source.source_ref for source in selection.sources}
                or any(type(raw) is not bytes or not 0 < len(raw) <= maximum_bytes for raw in originals.values())):
            raise GatewayHostUnavailable()
        self._originals = MappingProxyType(dict(originals))

    def read_once(self, source_ref: str, *, endpoint_ref: str, target_digest: str,
                  generation_ref: str, maximum_bytes: int, deadline_monotonic: float) -> bytes:
        try:
            before = _monotonic(self._clock.monotonic())
            if (endpoint_ref != self._selection.endpoint_ref or target_digest != self._selection.target.digest
                    or generation_ref != self._selection.generation_ref
                    or type(maximum_bytes) is not int or not 0 < maximum_bytes <= self._maximum_bytes
                    or not before < _monotonic(deadline_monotonic)
                    or not self._issued_ns <= _ns(self._clock.now_ns()) < self._expires_ns):
                raise GatewayHostUnavailable()
            raw = self._originals[source_ref]
            if len(raw) > maximum_bytes:
                raise GatewayHostUnavailable()
            after = _monotonic(self._clock.monotonic())
            if (not before <= after < deadline_monotonic
                    or not self._issued_ns <= _ns(self._clock.now_ns()) < self._expires_ns):
                raise GatewayHostUnavailable()
            return raw
        except Exception:
            raise GatewayHostUnavailable() from None


class _SelectedGuard:
    def __init__(self, guard: ActiveRecoveryGuard, target: GatewayTarget, clock: GatewayHostClock,
                 issued_ns: int, expires_ns: int) -> None:
        self._guard, self._target, self._clock = guard, target, clock
        self._issued_ns, self._expires_ns = issued_ns, expires_ns

    def lease_valid(self, binding: Any, lease: Any) -> bool:
        try:
            return (binding.target == self._target
                    and self._issued_ns <= _ns(self._clock.now_ns()) < self._expires_ns
                    and self._guard.lease_valid(binding, lease) is True
                    and self._issued_ns <= _ns(self._clock.now_ns()) < self._expires_ns)
        except Exception:
            return False


@dataclass(frozen=True)
class GatewayHostPorts:
    status: HostGatewayStatusAdapter
    recovery: DisabledHumanRecoveryExecutor
    claims: SQLiteDisabledRecoveryClaims | None
    target: GatewayTarget | None = None

    def close(self) -> None:
        if self.claims is not None:
            self.claims.close()


def create_gateway_ports(selection: Mapping[str, Any], cache: OriginalGatewayInputs,
                         contracts: Any, clock: GatewayHostClock, *,
                         disabled_claims_path: str | Path | None = None,
                         guard: ActiveRecoveryGuard | None = None) -> GatewayHostPorts:
    """Construct without collection; SQLite opens only if its local path is passed.

    The caller supplies an already authenticated immutable selection. Revalidate
    its authoritative schema, exact canonical digest and current interval here.
    Select precisely one role=broker-observation / HostGatewayConfiguration pin;
    HostPositionEvidence in the same role is unrelated and never parsed here.
    Every subordinate observation/trust pin must ALSO be explicitly selected in
    that role with the exact contract, identity and digest.

    Private config keys: format='vertex-host-gateway-v1', accountAlias, target
    {gatewayId,accountRef,environment,protocol}, endpointRef, generationRef, limits
    {maximumBytes,timeoutMilliseconds,maxAgeNs,maxDeliveryNs}, sources
    [{sourceRef,evidenceRef,dimensions,artifact}], and trustRecords
    [{artifact,evidenceRef,reviewerRef,reviewedAt,expiresAt}]. No enabled/trusted
    toggle or local path is accepted in this selected artifact. Trust flags are
    read only from separately pinned original verifier evidence by the adapter.

    disabled_claims_path is separately approved LOCAL host configuration, never
    remote artifact data. The guard is the real local owner object, never JSON.
    Missing configuration gives unavailable ports; malformed selected config is
    an error, not permission to use another/default/prior gateway.
    """
    claims = None
    try:
        selected = thaw(selection)
        if contracts.validate("RuntimePolicySelection", selected, schema_version="1.0.0") is not True:
            raise GatewayHostUnavailable()
        expected_digest = _digest(selected["selectionSha256"])
        body = {key: value for key, value in selected.items() if key != "selectionSha256"}
        if contracts.digest(body) != expected_digest:
            raise GatewayHostUnavailable()
        issued, expiry = _ns(contracts.epoch_ns(selected["issuedAt"])), _ns(contracts.epoch_ns(selected["expiresAt"]))
        if not issued <= _ns(clock.now_ns()) < expiry:
            raise GatewayHostUnavailable()
        pins = [item["artifact"] for item in selected["artifacts"] if item["role"] == "broker-observation"]
        configs = [pin for pin in pins if pin["contractName"] == "HostGatewayConfiguration"]
        if not configs:
            return GatewayHostPorts(
                HostGatewayStatusAdapter(selection=None, observations=None, contracts=contracts,
                                         clock=clock, format_timestamp=timestamp),
                DisabledHumanRecoveryExecutor(clock=clock), None,
            )
        if len(configs) != 1:
            raise GatewayHostUnavailable()

        def original(pin: Any, contract: str, maximum_bytes: int) -> tuple[dict[str, Any], bytes]:
            pinned = _pin(pin, contract)
            if sum(candidate == pinned for candidate in pins) != 1:
                raise GatewayHostUnavailable()
            raw = cache.private_bytes(pinned["artifactId"], pinned["artifactSha256"])
            if (type(raw) is not bytes or not 0 < len(raw) <= maximum_bytes
                    or sha256(raw).hexdigest() != pinned["artifactSha256"]):
                raise GatewayHostUnavailable()
            # Decode only the requested private shape downstream. Never reconstruct
            # source evidence bytes from a decoded object or use a latest alias.
            return pinned, raw

        config_pin, raw = original(configs[0], "HostGatewayConfiguration", 1_048_576)
        config = _envelope(raw, config_pin["artifactSha256"], _CONFIG_KEYS, 1_048_576)
        if config["format"] != "vertex-host-gateway-v1" or config["accountAlias"] != selected["accountAlias"]:
            raise GatewayHostUnavailable()
        target_value = _object(config["target"], frozenset({"gatewayId", "accountRef", "environment", "protocol"}))
        target = GatewayTarget(target_value["gatewayId"], target_value["accountRef"],
                               Environment(target_value["environment"]), GatewayProtocol(target_value["protocol"]))
        if target.environment.value != selected["environment"] or target.environment is not Environment.PAPER:
            raise GatewayHostUnavailable()
        bounds = _object(config["limits"], frozenset({"maximumBytes", "timeoutMilliseconds", "maxAgeNs", "maxDeliveryNs"}))
        milliseconds = bounds["timeoutMilliseconds"]
        if type(milliseconds) is not int or not 1 <= milliseconds <= 30_000:
            raise GatewayHostUnavailable()
        limits = ObservationLimits(bounds["maximumBytes"], milliseconds / 1_000,
                                   _duration(bounds["maxAgeNs"]), _duration(bounds["maxDeliveryNs"]))
        if limits.max_delivery_ns > limits.max_age_ns:
            raise GatewayHostUnavailable()
        sources, originals = [], {}
        for row in _array(config["sources"], len(Dimension)):
            row = _object(row, frozenset({"sourceRef", "evidenceRef", "dimensions", "artifact"}))
            source_pin, source_bytes = original(row["artifact"], "HostGatewayObservation", limits.maximum_bytes)
            dimensions = tuple(Dimension(value) for value in _array(row["dimensions"], len(Dimension)))
            sources.append(SelectedObservationSource(row["sourceRef"], row["evidenceRef"],
                                                      source_pin["artifactSha256"], dimensions))
            originals[row["sourceRef"]] = source_bytes
        host_selection = GatewayHostSelection(target, config["endpointRef"], config["generationRef"], tuple(sources))
        provider = SelectedCacheObservationProvider(selection=host_selection, originals=originals, clock=clock,
                                                     maximum_bytes=limits.maximum_bytes, issued_ns=issued, expires_ns=expiry)
        records = []
        # Exactly one current scoped trust review: never choose an earlier good
        # record after a later rejected or malformed review.
        for row in _array(config["trustRecords"], 1):
            row = _object(row, frozenset({"artifact", "evidenceRef", "reviewerRef", "reviewedAt", "expiresAt"}))
            trust_pin, trust_bytes = original(row["artifact"], "HostGatewayTrustEvidence", 65_536)
            reviewed = _ns(contracts.epoch_ns(row["reviewedAt"]))
            expires = min(expiry, _ns(contracts.epoch_ns(row["expiresAt"])))
            records.append(ReviewedHostTrustRecord(target.digest, host_selection.endpoint_ref,
                                                   row["evidenceRef"], trust_pin["artifactSha256"], trust_bytes,
                                                   row["reviewerRef"], reviewed, expires))
        trust = ReviewedHostTrustAdapter(selection=host_selection, records=tuple(records), clock=clock)
        observations = HostObservationAdapter(selection=host_selection, provider=provider, clock=clock, limits=limits)
        policy = ObservationPolicy(
            tuple((dimension, frozenset(source.source_ref for source in sources if dimension in source.dimensions))
                  for dimension in Dimension), limits.max_age_ns, limits.max_delivery_ns,
        )
        service = GatewayObservationService(clock=clock, policy=policy, trust=trust, observations=observations, enabled=True)
        status = HostGatewayStatusAdapter(selection=host_selection, observations=service, contracts=contracts,
                                          clock=clock, format_timestamp=timestamp)
        if disabled_claims_path is not None:
            claims = SQLiteDisabledRecoveryClaims.open(disabled_claims_path)
        selected_guard = None if guard is None else _SelectedGuard(guard, target, clock, issued, expiry)
        return GatewayHostPorts(status, DisabledHumanRecoveryExecutor(clock=clock, claims=claims, guard=selected_guard),
                                claims, target)
    except Exception:
        if claims is not None:
            try:
                claims.close()
            except Exception:
                pass
        raise GatewayHostUnavailable() from None
