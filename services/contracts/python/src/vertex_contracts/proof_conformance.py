"""Deferred paired native-proof conformance; explicit pinned local inputs only."""

import argparse
import json

from .authority import ContractAuthority
from .codec import ContractError, MAX_BUNDLE_BYTES, MAX_PAYLOAD_BYTES, canonical_encode, parse_canonical, rawSHA256
from .conformance import _bounded_read


def run_proof_conformance(bundle: bytes, bundle_sha256: str, fixtures: bytes,
                          fixtures_sha256: str) -> dict:
    authority = ContractAuthority(bundle, bundle_sha256)
    if type(fixtures) is not bytes or len(fixtures) > MAX_PAYLOAD_BYTES or rawSHA256(fixtures) != fixtures_sha256:
        raise ContractError("Proof fixture digest or byte bound mismatch")
    document = parse_canonical(fixtures, max_bytes=MAX_PAYLOAD_BYTES)
    if type(document) is not dict or set(document) != {"proofFixtureFormat", "schemaVersion", "cases"}:
        raise ContractError("Unsupported proof fixture document")
    if document["proofFixtureFormat"] != "vertex-native-journal-proof-fixtures-v1" or document["schemaVersion"] != "1.0.0":
        raise ContractError("Unsupported proof fixture profile")
    cases = document["cases"]
    if type(cases) is not list or not 1 <= len(cases) <= 10_000:
        raise ContractError("Missing or unbounded proof cases")
    seen = set()
    failed = []
    for case in cases:
        if type(case) is not dict or set(case) != {"name", "projection", "proofHex", "valid"}:
            raise ContractError("Malformed proof case")
        name, text = case["name"], case["proofHex"]
        if type(name) is not str or not name or name in seen or type(case["valid"]) is not bool:
            raise ContractError("Malformed proof case identity")
        seen.add(name)
        if type(text) is not str or len(text) > 2 * MAX_PAYLOAD_BYTES:
            raise ContractError("Malformed proof case bytes")
        try:
            proof = bytes.fromhex(text)
        except ValueError as exc:
            raise ContractError("Malformed proof case hex") from exc
        accepted = False
        try:
            accepted = authority.validate_native_journal_proof(case["projection"], proof) is True
        except ContractError:
            pass
        if accepted != case["valid"]:
            failed.append(name)
    return {"profile": "vertex-native-journal-proof-fixtures-v1", "attempted": len(cases),
            "passed": len(cases) - len(failed), "failed": failed,
            "bundleSHA256": bundle_sha256, "fixturesSHA256": fixtures_sha256,
            "publisherAuthenticated": False, "executionAuthorized": False}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run deferred source-generated paired journal proof conformance")
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--bundle-sha256", required=True)
    parser.add_argument("--fixtures", required=True)
    parser.add_argument("--fixtures-sha256", required=True)
    args = parser.parse_args()
    try:
        result = run_proof_conformance(_bounded_read(args.bundle, MAX_BUNDLE_BYTES), args.bundle_sha256,
                                      _bounded_read(args.fixtures, MAX_PAYLOAD_BYTES), args.fixtures_sha256)
        print(canonical_encode(result).decode("utf-8"))
        return 1 if result["failed"] else 0
    except (ContractError, OSError) as exc:
        print(json.dumps({"status": "unavailable", "reason": type(exc).__name__}, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
