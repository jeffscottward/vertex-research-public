"""Deferred conformance entry point; nothing executes merely on import.

Generate bundle and fixture bytes from the authoritative Civet source first.
Supply independently pinned SHA256 values for both files. This runner never
searches a checkout, generates artifacts, imports source modules or contacts I/O
other than the two explicitly requested local inputs and its result stream.
"""

import argparse
import json
from pathlib import Path

from .authority import ContractAuthority
from .codec import ContractError, MAX_BUNDLE_BYTES, MAX_PAYLOAD_BYTES, canonical_encode, parse_canonical, rawSHA256

_FIXTURE_FIELDS = {"fixtureFormat", "schemaVersion", "cases", "rawByteReject", "codec", "timestamps"}


def run_conformance(bundle: bytes, bundle_sha256: str, fixtures: bytes, fixtures_sha256: str) -> dict:
    authority = ContractAuthority(bundle, bundle_sha256)
    if rawSHA256(fixtures) != fixtures_sha256:
        raise ContractError("Fixture digest mismatch")
    document = parse_canonical(fixtures, max_bytes=MAX_PAYLOAD_BYTES)
    if type(document) is not dict or set(document) != _FIXTURE_FIELDS:
        raise ContractError("Unsupported fixture document")
    if document["fixtureFormat"] != "vertex-native-contract-fixtures-v1" or document["schemaVersion"] != "1.0.0":
        raise ContractError("Unsupported fixture profile/version")
    for key in ("cases", "rawByteReject", "codec", "timestamps"):
        if type(document[key]) is not list or not document[key] or len(document[key]) > 10_000:
            raise ContractError("Missing or unbounded conformance section")
    failures = []
    attempted = 0
    seen = set()

    def check(name, condition):
        nonlocal attempted
        if type(name) is not str or not name or name in seen:
            raise ContractError("Fixture names must be unique")
        seen.add(name)
        attempted += 1
        if not condition:
            failures.append(name)

    for case in document["cases"]:
        if type(case) is not dict or set(case) != {"name", "contract", "payload", "valid"} or type(case["valid"]) is not bool:
            raise ContractError("Invalid contract fixture")
        accepted = False
        try:
            accepted = authority.validate(case["contract"], case["payload"]) is True
            if accepted:
                accepted = authority.validate(case["contract"], authority.encode(case["payload"])) is True
        except ContractError:
            pass
        check("contract:" + case["name"], accepted == case["valid"])
    for case in document["rawByteReject"]:
        if type(case) is not dict or set(case) != {"name", "hex"} or type(case["hex"]) is not str:
            raise ContractError("Invalid raw-byte fixture")
        try:
            raw = bytes.fromhex(case["hex"])
        except ValueError as exc:
            raise ContractError("Invalid fixture hexadecimal bytes") from exc
        rejected = False
        try:
            parse_canonical(raw)
        except ContractError:
            rejected = True
        check("wire:" + case["name"], rejected)
    for case in document["codec"]:
        if type(case) is not dict or set(case) != {"name", "value", "canonicalUtf8", "sha256"}:
            raise ContractError("Invalid codec fixture")
        matches = authority.encode(case["value"]) == case["canonicalUtf8"].encode("utf-8")
        matches = matches and authority.digest(case["value"]) == case["sha256"]
        check("codec:" + case["name"], matches)
    for index, case in enumerate(document["timestamps"]):
        if type(case) is not dict or set(case) != {"timestamp", "epochNanoseconds"}:
            raise ContractError("Invalid timestamp fixture")
        matches = False
        try:
            actual = str(authority.epoch_ns(case["timestamp"]))
            matches = actual == case["epochNanoseconds"]
        except ContractError:
            matches = case["epochNanoseconds"] is None
        check("timestamp:" + str(index), matches)
    return {"profile": "vertex-native-contract-fixtures-v1", "attempted": attempted,
            "passed": attempted - len(failures), "failed": failures,
            "bundleSHA256": bundle_sha256, "fixturesSHA256": fixtures_sha256,
            "executionAuthorized": False}


def _bounded_read(path: str, limit: int) -> bytes:
    with Path(path).open("rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise ContractError("Conformance input byte budget exceeded")
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description="Run deferred source-generated native contract conformance")
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--bundle-sha256", required=True)
    parser.add_argument("--fixtures", required=True)
    parser.add_argument("--fixtures-sha256", required=True)
    args = parser.parse_args()
    try:
        report = run_conformance(_bounded_read(args.bundle, MAX_BUNDLE_BYTES), args.bundle_sha256,
                                 _bounded_read(args.fixtures, MAX_PAYLOAD_BYTES), args.fixtures_sha256)
        print(canonical_encode(report).decode("utf-8"))
        return 1 if report["failed"] else 0
    except (ContractError, OSError) as exc:
        print(json.dumps({"status": "unavailable", "reason": type(exc).__name__}, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
