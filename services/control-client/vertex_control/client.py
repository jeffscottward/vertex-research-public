"""Explicit, source-authorized Worker HTTPS boundary. No discovery or retry."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import http.client
import inspect
import json
import math
import re
import ssl
import threading
import time
from typing import Any, Mapping, Protocol
from urllib.parse import urlsplit


class ControlError(RuntimeError):
    """Only stable non-sensitive codes leave this boundary.

    unknown means a request may have committed: reconcile, never retry blindly.
    Even not-sent is not an instruction to retry.
    """
    def __init__(self, code: str, *, effect: str = "not-sent"):
        self.code, self.effect = code, effect
        self.retryable = False
        super().__init__(code)


class ControlCancelled(asyncio.CancelledError):
    effect = "unknown"
    retryable = False


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate-key")
        result[key] = value
    return result


def _nonfinite(_):
    raise ValueError("nonfinite-json")


def parse_json(data: bytes) -> Any:
    return json.loads(data.decode("utf-8", errors="strict"),
                      object_pairs_hook=_pairs, parse_constant=_nonfinite)


class EnvelopeAdapter(Protocol):
    def encode(self, payload: dict) -> bytes: ...
    def decode(self, payload: bytes) -> dict: ...


@dataclass(frozen=True)
class SameORPCJSON:
    """oRPC standard JSON serializer without unsupported meta/special values."""
    def encode(self, payload: dict) -> bytes:
        return json.dumps({"json": payload}, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")

    def decode(self, payload: bytes) -> dict:
        envelope = parse_json(payload)
        if type(envelope) is not dict or set(envelope) != {"json"}:
            raise ValueError("unsupported-orpc-envelope")
        if type(envelope["json"]) is not dict:
            raise ValueError("worker-object-required")
        return envelope["json"]


@dataclass(frozen=True, kw_only=True)
class ClientConfig:
    origin: str
    credential_ref: str = field(repr=False)
    timeout_seconds: float = 15.0
    max_request_bytes: int = 2_097_152
    max_response_bytes: int = 2_097_152
    envelope: EnvelopeAdapter = field(default_factory=SameORPCJSON)

    def __post_init__(self):
        try:
            if type(self.origin) is not str or not self.origin.isascii():
                raise ValueError()
            if any(ord(char) <= 32 or ord(char) == 127 for char in self.origin):
                raise ValueError()
            origin = urlsplit(self.origin)
            if (origin.scheme != "https" or not origin.hostname or origin.username is not None
                    or origin.password is not None or origin.path or origin.query or origin.fragment
                    or "?" in self.origin or "#" in self.origin or "\\" in self.origin
                    or origin.port == 0 or "%" in origin.netloc):
                raise ValueError()
            if type(self.credential_ref) is not str or not 1 <= len(self.credential_ref) <= 1024:
                raise ValueError()
            if any(ord(char) < 32 or ord(char) == 127 for char in self.credential_ref):
                raise ValueError()
            if (type(self.timeout_seconds) not in (int, float) or not math.isfinite(self.timeout_seconds)
                    or not 0 < self.timeout_seconds <= 120):
                raise ValueError()
            if any(type(value) is not int or not 1 <= value <= 2_097_152
                   for value in (self.max_request_bytes, self.max_response_bytes)):
                raise ValueError()
            if not callable(getattr(self.envelope, "encode", None)) or not callable(getattr(self.envelope, "decode", None)):
                raise ValueError()
        except Exception:
            raise ControlError("invalid-client-configuration") from None


# Dispatch metadata only: all value validation belongs to ContractAuthority.
# Source: packages/api/src/contracts/vertex-worker.civet.
METHODS = {
    "claim": ("WorkerClaimInput", "WorkerClaimOutput"),
    "renew": ("WorkerRenewInput", "WorkerResult"),
    "complete": ("WorkerCompleteInput", "WorkerResult"),
    "cancel": ("WorkerCancelInput", "WorkerResult"),
    "status": ("WorkerStatusInput", "WorkerResult"),
    "admitRun": ("WorkerAdmitRunInput", "WorkerResult"),
    "readArtifact": ("WorkerReadArtifactInput", "WorkerReadArtifactOutput"),
    "readExperiment": ("WorkerReadExperimentInput", "WorkerReadExperimentOutput"),
    "readBacktestRun": ("WorkerReadBacktestRunInput", "WorkerReadBacktestRunOutput"),
    "readDataset": ("WorkerReadDatasetInput", "WorkerReadDatasetOutput"),
    "stageArtifact": ("WorkerStageArtifactInput", "WorkerStageArtifactOutput"),
    "publishArtifact": ("WorkerPublishArtifactInput", "WorkerResult"),
    "publishAgent": ("WorkerPublishAgentInput", "WorkerResult"),
    "publishExperiment": ("WorkerPublishExperimentInput", "WorkerPublishExperimentOutput"),
    "publishCollection": ("WorkerPublishCollectionInput", "WorkerCollectionOutput"),
    "activateCollection": ("WorkerActivateCollectionInput", "WorkerCollectionOutput"),
    "readCollection": ("WorkerReadCollectionInput", "WorkerCollectionOutput"),
    "currentRights": ("WorkerCurrentRightsInput", "WorkerCurrentRightsOutput"),
    "acceptedEvidence": ("WorkerAcceptedEvidenceInput", "WorkerAcceptedEvidenceOutput"),
    "currentRightsObservation": ("WorkerCurrentRightsObservationInput", "WorkerCurrentRightsObservationOutput"),
    "acceptedEvidenceObservation": ("WorkerAcceptedEvidenceObservationInput", "WorkerAcceptedEvidenceObservationOutput"),
    "publishGenesis": ("WorkerPublishGenesisInput", "WorkerProjectionAck"),
    "publishPortfolioSnapshot": ("WorkerPublishPortfolioSnapshotInput", "WorkerProjectionAck"),
    "publishOrderProjection": ("WorkerPublishOrderProjectionInput", "WorkerProjectionAck"),
    "publishNativeFacts": ("WorkerPublishNativeFactsInput", "WorkerProjectionAck"),
    "readContinuity": ("WorkerReadContinuityInput", "ProjectionContinuity"),
    "readiness": ("WorkerReadinessInput", "WorkerResult"),
    "policySelection": ("WorkerPolicySelectionInput", "RuntimePolicySelection"),
    "currentPaperAdmission": ("WorkerCurrentPaperAdmissionInput", "WorkerCurrentPaperAdmissionOutput"),
    "currentModelUse": ("WorkerCurrentModelUseInput", "WorkerCurrentModelUseOutput"),
    "prepareModelPrivacyReview": ("WorkerPrepareModelPrivacyReviewInput", "WorkerModelPrivacyReviewOutput"),
    "readModelPrivacyReview": ("WorkerReadModelPrivacyReviewInput", "WorkerModelPrivacyReviewOutput"),
    "prepareNativeEvidencePhaseTwo": ("WorkerPrepareNativeEvidencePhaseTwoInput", "WorkerPrepareNativeEvidencePhaseTwoOutput"),
    "publishEpochTransition": ("WorkerPublishEpochTransitionInput", "WorkerProjectionAck"),
    "replayNativeOutbox": ("WorkerReplayNativeOutboxInput", "WorkerProjectionAck"),
}
_READ_ONLY = frozenset({"status", "readArtifact", "readExperiment", "readBacktestRun", "readDataset", "readCollection", "currentRights", "acceptedEvidence",
                        "currentRightsObservation", "acceptedEvidenceObservation",
                        "readContinuity", "policySelection", "currentPaperAdmission", "readModelPrivacyReview"})
_BEARER = re.compile(r"[A-Za-z0-9._~+/-]+={0,}", re.ASCII)
# Source: vertex-worker-epoch.civet MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES.
# Only the independently granted replay method admits this larger request.
MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES = 12_582_912


class _Exchange:
    def __init__(self):
        self.lock = threading.Lock()
        self.connection = None
        self.aborted = False
        self.sent = False

    def abort(self):
        with self.lock:
            self.aborted = True
            connection = self.connection
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass  # cleanup never exposes socket diagnostics


class ControlClient:
    """Async lifecycle; blocking stdlib TLS runs off the host event loop.

    Credential resolver receives only the explicitly configured reference. The
    client never consults environment credentials, proxy settings, or redirects.
    """
    def __init__(self, config: ClientConfig, credential_resolver, authority):
        if not isinstance(config, ClientConfig) or not callable(credential_resolver):
            raise ControlError("invalid-client-configuration")
        if any(not callable(getattr(authority, name, None)) for name in ("validate", "encode", "digest", "epoch_ns")):
            raise ControlError("contract-authority-unavailable")
        self.config, self.authority = config, authority
        self._resolver = credential_resolver
        self._closed = False
        self._active: set[_Exchange] = set()
        self._lock = threading.Lock()

    async def __aenter__(self):
        if self._closed:
            raise ControlError("client-closed")
        return self

    async def __aexit__(self, *_):
        await self.aclose()

    async def aclose(self):
        with self._lock:
            self._closed = True
            active = tuple(self._active)
        for exchange in active:
            exchange.abort()

    async def call(self, method: str, payload: Mapping[str, Any]) -> dict:
        if type(method) is not str or method not in METHODS:
            raise ControlError("unsupported-worker-method")
        request_name, response_name = METHODS[method]
        request_limit = (MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES if method == "replayNativeOutbox"
                         else self.config.max_request_bytes)
        try:
            if type(payload) is not dict:
                raise ValueError()
            # Detach once before validation to prevent caller mutation races.
            canonical = self.authority.encode(payload)
            if type(canonical) is not bytes or len(canonical) > request_limit:
                raise ValueError()
            request = parse_json(canonical)
            if self.authority.validate(request_name, request, "1.0.0") is not True:
                raise ValueError()
            body = self.config.envelope.encode(request)
            if type(body) is not bytes or not 0 < len(body) <= request_limit:
                raise ValueError()
        except Exception:
            raise ControlError("request-contract-rejected") from None
        exchange = _Exchange()
        with self._lock:
            if self._closed:
                raise ControlError("client-closed")
            self._active.add(exchange)
        deadline = time.monotonic() + self.config.timeout_seconds
        try:
            async with asyncio.timeout(self.config.timeout_seconds):
                # Sync resolvers, including secret managers, must not block the loop.
                try:
                    token = await asyncio.to_thread(self._resolver, self.config.credential_ref)
                    if inspect.isawaitable(token):
                        token = await token
                except Exception:
                    raise ControlError("credential-unavailable") from None
                if type(token) is not str or not 1 <= len(token) <= 8192 or _BEARER.fullmatch(token) is None:
                    raise ControlError("credential-unavailable")
                result = await asyncio.to_thread(self._exchange, method, body, token, exchange, deadline)
                del token
                try:
                    value = self.config.envelope.decode(result)
                    if type(value) is not dict or self.authority.validate(response_name, value, "1.0.0") is not True:
                        raise ValueError()
                    # Also snapshot the validated result rather than trust custom codecs.
                    return parse_json(self.authority.encode(value))
                except Exception:
                    raise ControlError("response-contract-rejected", effect=self._effect(method, exchange)) from None
        except TimeoutError:
            exchange.abort()
            raise ControlError("control-timeout", effect=self._effect(method, exchange)) from None
        except asyncio.CancelledError:
            exchange.abort()
            cancelled = ControlCancelled("control-cancelled")
            cancelled.effect = self._effect(method, exchange)
            raise cancelled from None
        except ControlError:
            raise
        except Exception:
            raise ControlError("control-unavailable", effect=self._effect(method, exchange)) from None
        finally:
            with self._lock:
                self._active.discard(exchange)

    @staticmethod
    def _effect(method, exchange):
        return "unknown" if exchange.sent and method not in _READ_ONLY else "not-sent" if not exchange.sent else "none"

    def _exchange(self, method, body, token, exchange, deadline):
        connection = None
        try:
            origin = urlsplit(self.config.origin)
            # No custom CA, insecure context, cert bypass or proxy injection.
            context = ssl.create_default_context(purpose=ssl.Purpose.SERVER_AUTH)
            context.check_hostname = True
            context.verify_mode = ssl.CERT_REQUIRED
            connection = http.client.HTTPSConnection(origin.hostname, origin.port or 443,
                                                    timeout=self.config.timeout_seconds, context=context)
            with exchange.lock:
                if exchange.aborted:
                    raise ControlError("control-cancelled")
                exchange.connection = connection
            connection.connect()  # TLS completes before any credential is written.
            connection.auto_open = 0  # never reconnect after a concurrent close
            with exchange.lock:
                if exchange.aborted or time.monotonic() >= deadline:
                    raise ControlError("control-timeout")
                exchange.sent = True  # even a partial request can have effects
            self._remaining(connection, deadline)
            connection.request("POST", "/api/orpc/vertexWorker/" + method, body=body,
                               headers={"Authorization": "Bearer " + token,
                                        "Origin": self.config.origin,
                                        "Content-Type": "application/json", "Accept": "application/json",
                                        "Accept-Encoding": "identity", "Connection": "close"})
            self._remaining(connection, deadline)
            response = connection.getresponse()
            effect = self._effect(method, exchange)
            if 300 <= response.status < 400:
                raise ControlError("redirect-rejected", effect=effect)
            if response.status != 200:
                # Never include response text, Location, endpoint, credential or reason.
                raise ControlError("http-response-rejected", effect=effect)
            headers = response.getheaders()
            lengths = [value for key, value in headers if key.lower() == "content-length"]
            transfers = [value.lower().strip() for key, value in headers if key.lower() == "transfer-encoding"]
            encodings = [value.lower().strip() for key, value in headers if key.lower() == "content-encoding"]
            types = [value.split(";", 1)[0].lower().strip() for key, value in headers if key.lower() == "content-type"]
            if types != ["application/json"] or encodings not in ([], ["identity"]):
                raise ControlError("response-format-rejected", effect=effect)
            if len(lengths) > 1 or transfers not in ([], ["chunked"]) or (lengths and transfers):
                raise ControlError("response-framing-rejected", effect=effect)
            if lengths and (not lengths[0].isascii() or not lengths[0].isdigit()
                            or len(lengths[0]) > 10 or int(lengths[0]) > self.config.max_response_bytes):
                raise ControlError("response-too-large", effect=effect)
            chunks, size = [], 0
            while True:
                self._remaining(connection, deadline)
                if exchange.aborted:
                    raise ControlError("control-cancelled", effect=effect)
                chunk = response.read1(min(65_536, self.config.max_response_bytes + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > self.config.max_response_bytes:
                    raise ControlError("response-too-large", effect=effect)
                chunks.append(chunk)
            if lengths and size != int(lengths[0]):
                raise ControlError("response-truncated", effect=effect)
            return b"".join(chunks)
        except ControlError:
            raise
        except Exception:
            raise ControlError("https-exchange-failed", effect=self._effect(method, exchange)) from None
        finally:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass

    @staticmethod
    def _remaining(connection, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        if connection.sock is not None:
            connection.sock.settimeout(remaining)

    async def claim(self, **wire_fields): return await self.call("claim", wire_fields)
    async def renew(self, **wire_fields): return await self.call("renew", wire_fields)
    async def complete(self, **wire_fields): return await self.call("complete", wire_fields)
    async def cancel(self, **wire_fields): return await self.call("cancel", wire_fields)
    async def status(self, **wire_fields): return await self.call("status", wire_fields)
    async def admit_run(self, **wire_fields): return await self.call("admitRun", wire_fields)
    async def read_artifact(self, **wire_fields): return await self.call("readArtifact", wire_fields)
    async def read_experiment(self, **wire_fields): return await self.call("readExperiment", wire_fields)
    async def read_backtest_run(self, **wire_fields): return await self.call("readBacktestRun", wire_fields)
    async def read_dataset(self, **wire_fields): return await self.call("readDataset", wire_fields)
    async def stage_artifact(self, **wire_fields): return await self.call("stageArtifact", wire_fields)
    async def publish_artifact(self, **wire_fields): return await self.call("publishArtifact", wire_fields)
    async def publish_agent(self, **wire_fields): return await self.call("publishAgent", wire_fields)
    async def publish_experiment_handoff(self, **wire_fields): return await self.call("publishExperiment", wire_fields)
    async def publish_collection(self, **wire_fields): return await self.call("publishCollection", wire_fields)
    async def activate_collection(self, **wire_fields): return await self.call("activateCollection", wire_fields)
    async def read_collection(self, **wire_fields): return await self.call("readCollection", wire_fields)
    async def current_rights(self, **wire_fields): return await self.call("currentRights", wire_fields)
    async def accepted_evidence(self, **wire_fields): return await self.call("acceptedEvidence", wire_fields)
    async def current_rights_observation(self, **wire_fields): return await self.call("currentRightsObservation", wire_fields)
    async def accepted_evidence_observation(self, **wire_fields): return await self.call("acceptedEvidenceObservation", wire_fields)
    async def publish_genesis(self, **wire_fields): return await self.call("publishGenesis", wire_fields)
    async def publish_order_projection(self, **wire_fields): return await self.call("publishOrderProjection", wire_fields)
    async def publish_native_facts(self, **wire_fields): return await self.call("publishNativeFacts", wire_fields)
    async def read_continuity(self, **wire_fields): return await self.call("readContinuity", wire_fields)
    async def readiness(self, **wire_fields): return await self.call("readiness", wire_fields)
    async def policy_selection(self, **wire_fields): return await self.call("policySelection", wire_fields)
    async def current_paper_admission(self, **wire_fields): return await self.call("currentPaperAdmission", wire_fields)
    async def publish_portfolio_snapshot(self, **wire_fields): return await self.call("publishPortfolioSnapshot", wire_fields)
    async def current_model_use(self, **wire_fields): return await self.call("currentModelUse", wire_fields)
    async def prepare_model_privacy_review(self, **wire_fields): return await self.call("prepareModelPrivacyReview", wire_fields)
    async def read_model_privacy_review(self, **wire_fields): return await self.call("readModelPrivacyReview", wire_fields)
    async def prepare_native_evidence_phase_two(self, **wire_fields): return await self.call("prepareNativeEvidencePhaseTwo", wire_fields)
    async def publish_epoch_transition(self, **wire_fields): return await self.call("publishEpochTransition", wire_fields)
    async def replay_native_outbox(self, **wire_fields): return await self.call("replayNativeOutbox", wire_fields)
