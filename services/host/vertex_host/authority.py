"""Ephemeral server-authenticated authorization, separate from schema validation.

Only the host control orchestration installs records after authenticated HTTPS.
These caches are not persisted across restart and are never refreshed by a risk
callback. Expiry, an unknown result or revocation invalidates current authority.
"""
from __future__ import annotations

import json
from threading import RLock
from typing import Any, Mapping

from .cache import HostUnavailable


class CurrentRights:
    def __init__(self, authority: Any, account_alias: str, environment: str,
                 max_age_ns: int) -> None:
        if type(max_age_ns) is not int or not 0 < max_age_ns <= 300_000_000_000:
            raise HostUnavailable("rights-freshness-policy-required")
        self.authority, self.account_alias, self.environment = authority, account_alias, environment
        self.max_age_ns = max_age_ns
        self._records: dict[str, bytes] = {}
        self._lock = RLock()

    def install(self, response: dict[str, Any], expected_policy_id: str) -> None:
        self.authority.validate("WorkerCurrentRightsOutput", response)
        if response["policyId"] != expected_policy_id:
            raise HostUnavailable("current-rights-policy-mismatch")
        raw = self.authority.encode(response)
        with self._lock:
            self._records[expected_policy_id] = raw

    def clear(self) -> None:
        with self._lock:
            self._records.clear()

    def record(self, policy_id: str, version: str, now_ns: int) -> dict[str, Any]:
        with self._lock:
            raw = self._records.get(policy_id)
        if raw is None:
            raise HostUnavailable("current-rights-unavailable")
        value = json.loads(raw)
        checked = self.authority.epoch_ns(value["checkedAt"])
        expires = value["expiresAt"]
        if expires is None:
            raise HostUnavailable("bounded-current-rights-expiry-required")
        expiry_ns = min(checked + self.max_age_ns, self.authority.epoch_ns(expires))
        if (value["version"] != version or value["status"] != "granted"
                or not checked <= now_ns < expiry_ns):
            raise HostUnavailable("current-rights-denied-stale-or-revoked")
        return {**value, "checked_ns": checked, "expires_ns": expiry_ns,
                "accountAlias": self.account_alias, "environment": self.environment}

    def permits(self, policy_id: str, version: str, use: str, now_ns: int) -> bool:
        try:
            return use in self.record(policy_id, version, now_ns)["allowedUses"]
        except HostUnavailable:
            return False

    def current(self) -> str:
        with self._lock:
            return self.authority.digest({key: json.loads(raw) for key, raw in self._records.items()})


class CurrentAdmissionAuthority:
    """Authorizes only exact latest-review responses obtained for this lease.

    An immutable AcceptedReview by itself is not current role/revocation proof.
    The worker service must independently authorize and validate this endpoint.
    """
    def __init__(self, authority: Any, account_alias: str, max_age_ns: int) -> None:
        if type(max_age_ns) is not int or not 0 < max_age_ns <= 300_000_000_000:
            raise HostUnavailable("admission-freshness-policy-required")
        self.authority, self.account_alias, self.max_age_ns = authority, account_alias, max_age_ns
        self._records: dict[str, bytes] = {}
        self._lock = RLock()

    def install(self, response: dict[str, Any], *, admission: Mapping[str, Any],
                review: Mapping[str, Any]) -> None:
        self.authority.validate("WorkerCurrentPaperAdmissionOutput", response)
        digest = self.authority.digest(dict(admission))
        # Replace current state even on denial; never preserve older acceptance.
        with self._lock:
            self._records.pop(digest, None)
            if response["status"] != "allowed":
                return
            if (response["admission"] != dict(admission) or response["review"] != dict(review)
                    or admission["accountAlias"] != self.account_alias
                    or admission["environment"] != "paper"):
                raise HostUnavailable("current-admission-exact-binding-mismatch")
            self._records[digest] = self.authority.encode(response)

    def clear(self) -> None:
        with self._lock:
            self._records.clear()

    def permits(self, *, admission: Mapping[str, Any], review: Mapping[str, Any], now_ns: int) -> bool:
        with self._lock:
            raw = self._records.get(self.authority.digest(dict(admission)))
        if raw is None:
            return False
        value = json.loads(raw)
        checked = self.authority.epoch_ns(value["checkedAt"])
        expiry = self.authority.epoch_ns(value["expiresAt"])
        return (value["status"] == "allowed" and value["admission"] == dict(admission)
                and value["review"] == dict(review) and review["decision"] == "accepted"
                and checked <= now_ns < min(expiry, checked + self.max_age_ns))


class DisabledMutationAuthority:
    def verify(self, grant: Any, *, now_ns: int) -> bool:
        # Human reset/liquidation/cancel integration is intentionally not enabled.
        return False


class DisabledObservationAuthority:
    def verify(self, observation: Any, *, now_ns: int) -> bool:
        # Neither cloud PortfolioSnapshot nor an arbitrary config amount is seed.
        return False
