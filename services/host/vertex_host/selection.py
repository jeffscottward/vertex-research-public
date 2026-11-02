"""Exact immutable policy resolution, never a latest alias or a readiness flag."""
from __future__ import annotations

import base64
import hashlib
from typing import Any

from vertex_execution.ports import Artifact
from .cache import HostUnavailable, SealedArtifactCache, canonical_object, freeze
from .config import read_pinned
from .dispatcher import fence


PUBLIC_CONTRACTS = frozenset({"TradeIntent", "PaperSimulationAdmission", "AcceptedReview", "StrategySpec",
    "Quote", "ResearchEvidence", "DatasetManifest", "BacktestRun", "KnowledgeImport", "AgentRun",
    "PortfolioSnapshot", "GatewayStatus"})


async def read_artifact(control: Any, authority: Any, lease: dict[str, Any], artifact_id: str,
                        sha256: str, collection_id: str | None = None) -> bytes:
    response = await control.read_artifact(**fence(lease), collectionId=collection_id, artifactId=artifact_id)
    authority.validate("WorkerReadArtifactOutput", response)
    if response["artifact"] != {"artifactId": artifact_id, "artifactSha256": sha256}:
        raise HostUnavailable("control-artifact-pin-mismatch")
    try:
        raw = base64.b64decode(response["contentBase64"], validate=True)
    except (ValueError, TypeError) as exc:
        raise HostUnavailable("control-artifact-encoding-mismatch") from exc
    if not 0 < len(raw) <= 1_048_576 or hashlib.sha256(raw).hexdigest() != sha256 or response["contentSha256"] != sha256:
        raise HostUnavailable("control-artifact-content-mismatch")
    # Selected inputs are canonical private/public records; raw dataset blobs
    # stay in provider/backtest content ports and are not treated as records.
    canonical_object(authority, raw, 1_048_576)
    if response["canonicalSha256"] != sha256:
        raise HostUnavailable("control-canonical-pin-mismatch")
    return raw


async def load_selection(*, control: Any, authority: Any, lease: dict[str, Any], config: dict[str, Any],
                         cache: SealedArtifactCache, now_ns: int) -> tuple[dict[str, Any], dict[str, bytes]]:
    selection = await control.policy_selection(**fence(lease), selectionId=lease["policySelectionId"],
                                               selectionSha256=lease["policySelectionSha256"])
    authority.validate("RuntimePolicySelection", selection)
    body = {key: value for key, value in selection.items() if key != "selectionSha256"}
    if (selection["selectionId"] != lease["policySelectionId"] or selection["selectionSha256"] != lease["policySelectionSha256"]
            or authority.digest(body) != lease["policySelectionSha256"]
            or selection["accountAlias"] != lease["accountAlias"] or selection["environment"] != lease["environment"]
            or not authority.epoch_ns(selection["issuedAt"]) <= now_ns < authority.epoch_ns(selection["expiresAt"])):
        raise HostUnavailable("current-exact-policy-selection-required")
    for module in selection["modules"]:
        if not module["enabled"]:
            continue
        reviewed = config["reviewedModules"].get(module["moduleId"])
        if type(reviewed) is not dict or set(reviewed) != {"version", "codeSha256", "contractSha256", "files", "contractFile"}:
            raise HostUnavailable("selected-module-release-identity-unavailable")
        if any(reviewed[key] != module[key] for key in ("version", "codeSha256", "contractSha256")):
            raise HostUnavailable("selected-module-release-mismatch")
        files = reviewed["files"]
        if type(files) is not dict or not 1 <= len(files) <= 4096:
            raise HostUnavailable("bounded-module-source-inventory-required")
        measured = {}
        for logical_name, pin in files.items():
            if type(logical_name) is not str or logical_name.startswith("/") or ".." in logical_name.split("/"):
                raise HostUnavailable("module-source-identity-invalid")
            measured[logical_name] = hashlib.sha256(read_pinned(pin, 8_388_608)).hexdigest()
        if authority.digest(measured) != module["codeSha256"]:
            raise HostUnavailable("selected-module-measured-source-mismatch")
        if hashlib.sha256(read_pinned(reviewed["contractFile"], 16_777_216)).hexdigest() != module["contractSha256"]:
            raise HostUnavailable("selected-module-contract-mismatch")
    pins = [item["artifact"] for item in selection["modules"]]
    pins += [item["artifact"] for item in selection["policies"]]
    pins += [item["artifact"] for item in selection["artifacts"]]
    pins += [item["provenanceArtifact"] for item in selection["sourcePins"]]
    pins += [item["evidenceArtifact"] for item in selection["providerCapabilities"]]
    identities: dict[str, tuple[str, str]] = {}
    inputs: dict[str, bytes] = {}
    for pin in pins:
        identity, digest, name = pin["artifactId"], pin["artifactSha256"], pin["contractName"]
        if pin["schemaVersion"] != "1.0.0":
            raise HostUnavailable("unsupported-selected-artifact-schema")
        previous = identities.get(identity)
        if previous is not None:
            if previous != (digest, name):
                raise HostUnavailable("selected-artifact-identity-conflict")
            continue
        identities[identity] = (digest, name)
        collection_id = None
        history = config.get("ibkrHistory")
        if history is not None and identity in (history["profileArtifactId"], history["profileEvidenceArtifactId"]):
            # Explicit scope selects an intended collection; current server grants
            # and the selected original artifact still authorize this exact read.
            collection_id = history["profileCollectionId"]
        raw = await read_artifact(control, authority, lease, identity, digest, collection_id)
        if name in PUBLIC_CONTRACTS:
            cache.seal(Artifact(identity, name, digest, raw))
        else:
            # Host/provider private config has its own strict private decoder;
            # do not invent public ContractAuthority clones for these records.
            cache.seal_private(identity, digest, raw)
        inputs[identity] = raw
    return selection, inputs
