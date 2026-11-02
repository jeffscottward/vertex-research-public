"""Source-authored host regressions. Intentionally not executed during buildout."""
from __future__ import annotations

import asyncio
import hashlib
import json
import unittest
from unittest.mock import AsyncMock, Mock

from vertex_execution.ports import Artifact
from vertex_host.cache import HostUnavailable, SealedArtifactCache, canonical_object, freeze, thaw
from vertex_host.dispatcher import LeaseDispatcher
from vertex_host.guards import LeaseBoundPaperTransport, LeaseBoundRisk
from vertex_host.native_admin import typed_subject
from vertex_host.publication import ControlProjectionPort


class CanonicalTestAuthority:
    """Test double for byte-boundary tests only; never used for public admission."""
    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, value):
        return hashlib.sha256(self.encode(value)).hexdigest()

    def validate(self, name, value):
        if name == "Rejected":
            raise ValueError("rejected")
        return True

    def epoch_ns(self, value):
        return int(value)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.authority = CanonicalTestAuthority()
        self.cache = SealedArtifactCache(self.authority, maximum_bytes=1024, maximum_artifacts=2)

    def test_private_exact_bytes_round_trip(self):
        raw = self.authority.encode({"v": "original"})
        digest = hashlib.sha256(raw).hexdigest()
        self.cache.seal_private("p", digest, raw)
        self.assertIs(self.cache.private_bytes("p", digest), raw)
        copy = self.cache.private("p", digest)
        copy["v"] = "changed"
        self.assertEqual(self.cache.private("p", digest), {"v": "original"})

    def test_private_cannot_replace_identity(self):
        for text in ("first", "second"):
            raw = self.authority.encode({"v": text})
            if text == "first":
                self.cache.seal_private("p", hashlib.sha256(raw).hexdigest(), raw)
            else:
                with self.assertRaises(HostUnavailable):
                    self.cache.seal_private("p", hashlib.sha256(raw).hexdigest(), raw)

    def test_public_private_identity_collision_rejected(self):
        raw = self.authority.encode({"x": "y"})
        digest = self.authority.digest({"x": "y"})
        self.cache.seal(Artifact("same", "Test", digest, raw))
        with self.assertRaises(HostUnavailable):
            self.cache.seal_private("same", digest, raw)

    def test_digest_mismatch_rejected(self):
        with self.assertRaises(HostUnavailable):
            self.cache.seal_private("p", "0" * 64, b'{"v":"x"}')

    def test_noncanonical_duplicate_keys_rejected(self):
        with self.assertRaises(HostUnavailable):
            canonical_object(self.authority, b'{"x":"first","x":"last"}')

    def test_exact_case_digest_required(self):
        with self.assertRaises(HostUnavailable):
            self.cache.seal_private("p", "A" * 64, b'{"x":"y"}')

    def test_cache_count_exhaustion_never_evicts_old_inputs(self):
        raw = b'{"x":"y"}'
        digest = hashlib.sha256(raw).hexdigest()
        self.cache.seal_private("one", digest, raw)
        self.cache.seal_private("two", digest, raw)
        with self.assertRaises(HostUnavailable):
            self.cache.seal_private("three", digest, raw)
        self.assertEqual(self.cache.private_bytes("one", digest), raw)

    def test_freeze_does_not_share_nested_mutable_values(self):
        source = {"x": [{"y": "first"}]}
        snapshot = freeze(source)
        source["x"][0]["y"] = "mutated"
        self.assertEqual(thaw(snapshot), {"x": [{"y": "first"}]})
        with self.assertRaises(TypeError):
            snapshot["x"][0]["y"] = "changed"


class NativeGuardTests(unittest.TestCase):
    def test_risk_guard_rechecks_after_native_computation(self):
        state = [True]
        delegate = Mock()
        def assess(**kwargs):
            state[0] = False
            return "plan"
        delegate.assess = assess
        guarded = LeaseBoundRisk(delegate, lambda: state[0])
        with self.assertRaises(HostUnavailable):
            guarded.assess(intent={})

    def test_fenced_dispatch_never_invokes_simulator(self):
        delegate = Mock(simulation_only=True, broker_submission_allowed=False)
        guarded = LeaseBoundPaperTransport(delegate, lambda: False)
        with self.assertRaises(HostUnavailable):
            guarded.submit("key", "hash", b"command", now_ns=1)
        delegate.submit.assert_not_called()

    def test_reconciliation_allowed_after_lease_loss(self):
        delegate = Mock(simulation_only=True, broker_submission_allowed=False)
        guarded = LeaseBoundPaperTransport(delegate, lambda: False)
        guarded.reconcile("key", "hash", now_ns=1)
        delegate.reconcile.assert_called_once()

    def test_live_transport_cannot_be_wrapped(self):
        with self.assertRaises(HostUnavailable):
            LeaseBoundPaperTransport(Mock(simulation_only=False, broker_submission_allowed=True), lambda: True)

    def test_subject_rejects_unknown_record_type(self):
        with self.assertRaises(HostUnavailable):
            typed_subject("caller-chosen-python-class", {})

    def test_subject_rejects_missing_dataclass_fields(self):
        with self.assertRaises(HostUnavailable):
            typed_subject("observation", {"cash": "1000000"})


class PublicationTests(unittest.IsolatedAsyncioTestCase):
    async def test_snapshot_uses_distinct_checkpoint_endpoint(self):
        authority = CanonicalTestAuthority()
        client = Mock()
        digest = "a" * 64
        client.publish_portfolio_snapshot = AsyncMock(return_value={"status": "applied", "highWaterEventHash": digest, "highWaterSequence": "7"})
        client.publish_genesis = AsyncMock()
        port = ControlProjectionPort(control=client, authority=authority,
            lease=lambda: {"accountAlias": "a", "environment": "paper", "jobId": "j", "leaseId": "l", "leaseEpoch": "1"})
        result = await port.publish_portfolio_snapshot(authority.encode({"sourceEventHash": digest, "sequence": "7"}), source_hash=digest)
        self.assertEqual(result, digest)
        client.publish_genesis.assert_not_called()

    async def test_ack_hash_mismatch_does_not_advance(self):
        authority = CanonicalTestAuthority()
        client = Mock(publish_order_projection=AsyncMock(return_value={"status": "duplicate", "highWaterEventHash": "b" * 64, "highWaterSequence": "7"}))
        port = ControlProjectionPort(control=client, authority=authority,
            lease=lambda: {"accountAlias": "a", "environment": "paper", "jobId": "j", "leaseId": "l", "leaseEpoch": "1"})
        digest = "a" * 64
        with self.assertRaises(HostUnavailable):
            await port.publish(authority.encode({"eventHash": digest, "sequence": "7"}), event_hash=digest)

    async def test_ack_matching_hash_with_wrong_sequence_does_not_advance(self):
        authority = CanonicalTestAuthority()
        digest = "a" * 64
        client = Mock(publish_order_projection=AsyncMock(return_value={
            "status": "applied", "highWaterEventHash": digest, "highWaterSequence": "8"}))
        port = ControlProjectionPort(control=client, authority=authority,
            lease=lambda: {"accountAlias": "a", "environment": "paper", "jobId": "j", "leaseId": "l", "leaseEpoch": "1"})
        with self.assertRaises(HostUnavailable):
            await port.publish(authority.encode({"eventHash": digest, "sequence": "7"}), event_hash=digest)

    async def test_first_genesis_after_empty_claim_epochs_uses_initial_endpoint(self):
        authority = CanonicalTestAuthority()
        digest = "a" * 64
        client = Mock(publish_genesis=AsyncMock(return_value={
            "status": "applied", "highWaterEventHash": digest, "highWaterSequence": "1"}),
            publish_epoch_transition=AsyncMock())
        port = ControlProjectionPort(control=client, authority=authority,
            lease=lambda: {"accountAlias": "a", "environment": "paper", "jobId": "j", "leaseId": "l", "leaseEpoch": "1"},
            requires_epoch_transition=lambda snapshot: False)
        snapshot = {"sourceEventHash": digest, "sequence": "1", "ownerEpoch": "3"}
        self.assertEqual(await port.publish_portfolio_genesis(authority.encode(snapshot), source_hash=digest), digest)
        client.publish_genesis.assert_awaited_once()
        client.publish_epoch_transition.assert_not_called()

    async def test_missing_rollover_context_never_sends_unsigned_genesis(self):
        authority = CanonicalTestAuthority()
        client = Mock(publish_genesis=AsyncMock())
        port = ControlProjectionPort(control=client, authority=authority,
            lease=lambda: {"accountAlias": "a", "environment": "paper", "jobId": "j", "leaseId": "l", "leaseEpoch": "1"})
        digest = "a" * 64
        with self.assertRaises(HostUnavailable):
            await port.publish_portfolio_genesis(authority.encode({
                "sourceEventHash": digest, "sequence": "1", "ownerEpoch": "3"}), source_hash=digest)
        client.publish_genesis.assert_not_called()

    async def test_no_lease_never_calls_control(self):
        client = Mock(publish_order_projection=AsyncMock())
        authority = CanonicalTestAuthority()
        port = ControlProjectionPort(control=client, authority=authority, lease=lambda: None)
        with self.assertRaises(HostUnavailable):
            await port.publish(authority.encode({"eventHash": "a" * 64}), event_hash="a" * 64)
        client.publish_order_projection.assert_not_called()


class DispatcherTests(unittest.IsolatedAsyncioTestCase):
    async def test_transport_acceptance_is_not_completed_work(self):
        authority = CanonicalTestAuthority()
        cancelled = asyncio.Event()
        clock = Mock(now_ns=lambda: 1)
        lease = {"accountAlias": "a", "environment": "research", "kind": "research-run", "jobId": "j",
                 "leaseId": "l", "leaseEpoch": "1", "payloadSha256": "b" * 64, "policySelectionId": "p",
                 "policySelectionSha256": "c" * 64, "leaseExpiresAt": "100000000000", "deadlineAt": "100000000000"}
        client = Mock(complete=AsyncMock(return_value={"status": "completed"}))
        async def prepare(received, event):
            async def handler(payload, current):
                return {"status": "accepted", "outputArtifactIds": []}
            return handler, {}
        dispatcher = LeaseDispatcher(config={"accountAlias": "a", "environment": "research", "worker": {
            "kinds": ["research-run"], "selectionId": "p", "selectionSha256": "c" * 64, "leaseDurationMs": 30000}},
            control=client, authority=authority, clock=clock, prepare=prepare, cancelled=cancelled,
            on_unavailable=AsyncMock())
        await dispatcher._execute(lease)
        self.assertEqual(client.complete.call_args.kwargs["outcome"], "unknown")
        self.assertIsNone(dispatcher.active_task)

    async def test_invalid_scope_cancelled_before_prepare(self):
        authority = CanonicalTestAuthority()
        prepare = AsyncMock()
        client = Mock(cancel=AsyncMock())
        dispatcher = LeaseDispatcher(config={"accountAlias": "a", "environment": "research", "worker": {
            "kinds": ["research-run"], "selectionId": "p", "selectionSha256": "c" * 64}},
            control=client, authority=authority, clock=Mock(), prepare=prepare, cancelled=asyncio.Event(),
            on_unavailable=AsyncMock())
        lease = {"accountAlias": "other", "environment": "research", "jobId": "j", "leaseId": "l", "leaseEpoch": "1"}
        with self.assertRaises(HostUnavailable):
            await dispatcher._execute(lease)
        prepare.assert_not_called()
        client.cancel.assert_awaited_once()
