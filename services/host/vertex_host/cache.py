"""Exact immutable local inputs; this module never resolves latest or performs IO."""
from __future__ import annotations

import hashlib
import json
import re
from threading import RLock
from types import MappingProxyType
from typing import Any, Mapping

from vertex_execution.ports import Artifact, ExecutionError


class HostUnavailable(ExecutionError):
    pass


def exact_digest(value: str) -> str:
    if type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise HostUnavailable("exact-lowercase-sha256-required")
    return value


def canonical_object(authority: Any, raw: bytes, maximum_bytes: int = 4_194_304) -> dict[str, Any]:
    if type(raw) is not bytes or not 0 < len(raw) <= maximum_bytes:
        raise HostUnavailable("bounded-canonical-object-required")
    try:
        value = json.loads(raw)
        if type(value) is not dict or authority.encode(value) != raw:
            raise HostUnavailable("canonical-object-required")
        return value
    except (ValueError, RecursionError, UnicodeError) as exc:
        raise HostUnavailable("canonical-object-required") from exc


class SealedArtifactCache:
    def __init__(self, authority: Any, maximum_bytes: int = 64 * 1024 * 1024,
                 maximum_artifacts: int = 2048) -> None:
        if type(maximum_bytes) is not int or not 1024 <= maximum_bytes <= 256 * 1024 * 1024:
            raise HostUnavailable("cache-byte-bound")
        if type(maximum_artifacts) is not int or not 1 <= maximum_artifacts <= 8192:
            raise HostUnavailable("cache-count-bound")
        self.authority = authority
        self._maximum_bytes, self._maximum_artifacts = maximum_bytes, maximum_artifacts
        self._used = 0
        self._artifacts: dict[str, Artifact] = {}
        self._private: dict[str, tuple[str, bytes]] = {}
        self._lock = RLock()

    def _reserve(self, identity: str, raw: bytes) -> None:
        if type(identity) is not str or not 1 <= len(identity) <= 256:
            raise HostUnavailable("artifact-identity-required")
        if len(self._artifacts) + len(self._private) >= self._maximum_artifacts or self._used + len(raw) > self._maximum_bytes:
            raise HostUnavailable("immutable-cache-exhausted")
        self._used += len(raw)

    def seal(self, artifact: Artifact) -> None:
        if type(artifact) is not Artifact:
            raise HostUnavailable("typed-artifact-required")
        value = canonical_object(self.authority, artifact.canonical_bytes)
        if self.authority.validate(artifact.contract_name, value) is not True:
            raise HostUnavailable("native-artifact-validation-required")
        if hashlib.sha256(artifact.canonical_bytes).hexdigest() != exact_digest(artifact.sha256):
            raise HostUnavailable("artifact-digest-mismatch")
        with self._lock:
            previous = self._artifacts.get(artifact.artifact_id)
            if previous is not None:
                if previous != artifact:
                    raise HostUnavailable("immutable-artifact-conflict")
                return
            if artifact.artifact_id in self._private:
                raise HostUnavailable("immutable-artifact-kind-conflict")
            self._reserve(artifact.artifact_id, artifact.canonical_bytes)
            self._artifacts[artifact.artifact_id] = artifact

    def seal_private(self, artifact_id: str, sha256: str, canonical_bytes: bytes) -> None:
        canonical_object(self.authority, canonical_bytes)
        if hashlib.sha256(canonical_bytes).hexdigest() != exact_digest(sha256):
            raise HostUnavailable("private-artifact-digest-mismatch")
        with self._lock:
            candidate = (sha256, canonical_bytes)
            previous = self._private.get(artifact_id)
            if previous is not None:
                if previous != candidate:
                    raise HostUnavailable("immutable-private-artifact-conflict")
                return
            if artifact_id in self._artifacts:
                raise HostUnavailable("immutable-artifact-kind-conflict")
            self._reserve(artifact_id, canonical_bytes)
            self._private[artifact_id] = candidate

    def get(self, artifact_id: str) -> Artifact:
        with self._lock:
            try:
                return self._artifacts[artifact_id]
            except KeyError as exc:
                raise HostUnavailable("exact-public-artifact-unavailable") from exc

    def private(self, artifact_id: str, sha256: str) -> dict[str, Any]:
        with self._lock:
            try:
                digest, raw = self._private[artifact_id]
            except KeyError as exc:
                raise HostUnavailable("exact-private-artifact-unavailable") from exc
            if digest != sha256:
                raise HostUnavailable("private-artifact-pin-mismatch")
            return canonical_object(self.authority, raw)

    def private_bytes(self, artifact_id: str, sha256: str) -> bytes:
        with self._lock:
            try:
                digest, raw = self._private[artifact_id]
            except KeyError as exc:
                raise HostUnavailable("exact-private-artifact-unavailable") from exc
            if digest != sha256:
                raise HostUnavailable("private-artifact-pin-mismatch")
            return raw

    def snapshot(self) -> Mapping[str, Artifact]:
        with self._lock:
            return MappingProxyType(dict(self._artifacts))


def freeze(value: Any) -> Any:
    if type(value) is dict:
        return MappingProxyType({key: freeze(child) for key, child in value.items()})
    if type(value) is list:
        return tuple(freeze(child) for child in value)
    return value


def thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: thaw(child) for key, child in value.items()}
    if type(value) is tuple:
        return [thaw(child) for child in value]
    return value
