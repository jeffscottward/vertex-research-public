"""Full standalone replay parsing, rooted in vertex-worker-epoch.civet.

This adapter is never applied implicitly to a worker transport DTO. It verifies
retained original bytes and source-bound identities, not cryptographic approval,
authenticated grants, truth of journal evidence or permission to allocate capital.
"""

from .binary import (MAX_REPLAY_BLOB_BYTES, MAX_REPLAY_DECODED_BYTES,
                     decode_canonical_base64)
from .codec import ContractError, parse_canonical, rawSHA256

_CONTRACT_BY_KIND = {
    "portfolio-genesis": "PortfolioGenesis",
    "portfolio-snapshot": "PortfolioSnapshot",
    "order": "ExecutionProjection",
    "native-fact": "NativeFactProjection",
}


def validate_replay_artifacts(authority, replay, schema_version: str) -> None:
    # The outer schema and source-derived NativeOutboxReplaySemantics have
    # already validated shape, <=64 rows, identities, order and aggregate sizes.
    grant = replay["grant"]
    approval = decode_canonical_base64(grant["approvalBase64"])
    decoded_bytes = len(approval)
    del approval
    retained = replay["retainedEpochTransitionBase64"]
    if (retained is None) != (grant["retainedEpochTransitionSha256"] is None):
        raise ContractError("Retained epoch transition presence mismatch")
    if retained is not None:
        transition_bytes = decode_canonical_base64(retained)
        decoded_bytes += len(transition_bytes)
        if decoded_bytes > MAX_REPLAY_DECODED_BYTES:
            raise ContractError("Native replay decoded aggregate byte limit exceeded")
        if rawSHA256(transition_bytes) != grant["retainedEpochTransitionSha256"]:
            raise ContractError("Retained epoch transition original SHA256 mismatch")
        transition = parse_canonical(transition_bytes, max_bytes=MAX_REPLAY_BLOB_BYTES)
        authority.validate("PortfolioEpochTransition", transition_bytes, schema_version)
        authority._programs.validate("NativeReplayRetainedTransitionBinding", {
            "grant": grant, "transition": transition,
        })
        first = replay["rows"][0]
        if first["kind"] != "portfolio-genesis":
            raise ContractError("Retained epoch transition requires first genesis row")
        snapshot_bytes = decode_canonical_base64(first["projectionBase64"])
        if authority.encode(transition["snapshot"]) != snapshot_bytes:
            raise ContractError("Retained epoch transition genesis bytes mismatch")
        # Historical provenance only: signatures, current nonrevocation and the
        # fresh replay grant's explicit ratification remain external admission.
        del transition_bytes, transition, snapshot_bytes
    prior_hash = grant["startingEventHash"]
    for index, row in enumerate(replay["rows"]):
        identity = grant["rows"][index]
        kind = row["kind"]
        contract = _CONTRACT_BY_KIND.get(kind)
        if contract is None:
            raise ContractError("Unsupported native replay artifact kind")
        projection_bytes = decode_canonical_base64(row["projectionBase64"])
        decoded_bytes += len(projection_bytes)
        if decoded_bytes > MAX_REPLAY_DECODED_BYTES:
            raise ContractError("Native replay decoded aggregate byte limit exceeded")
        if rawSHA256(projection_bytes) != identity["projectionRawSha256"]:
            raise ContractError("Native replay original projection SHA256 mismatch")
        # Decode/canonical checks reject duplicate keys, BOM, invalid UTF-8 and
        # JSON aliases before the fixed source validator receives the artifact.
        projection = parse_canonical(projection_bytes, max_bytes=MAX_REPLAY_BLOB_BYTES)
        authority.validate(contract, projection_bytes, schema_version)
        authority._programs.validate("NativeReplayRowBinding", {
            "grant": grant, "identity": identity, "value": projection,
            "priorHash": prior_hash,
        })
        if kind == "native-fact":
            proof_bytes = decode_canonical_base64(row["proofBase64"])
            decoded_bytes += len(proof_bytes)
            if decoded_bytes > MAX_REPLAY_DECODED_BYTES:
                raise ContractError("Native replay decoded aggregate byte limit exceeded")
            if rawSHA256(proof_bytes) != identity["proofSha256"]:
                raise ContractError("Native replay original journal proof SHA256 mismatch")
            authority.validate_native_journal_proof(projection_bytes, proof_bytes, schema_version)
        if kind != "portfolio-snapshot":
            prior_hash = identity["eventHash"]
