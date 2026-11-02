"""Authored only: no key, signature, DB or runtime operation has been executed.

Future tests use deterministic PUBLICLY KNOWN synthetic seeds, never enroll or
read a real user's keys. Production package contains no signer/private-key API.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from vertex_contracts.codec import canonical_encode, epoch_ns
from vertex_execution.capital import SimulationCapitalPolicy
from vertex_execution.ports import MutationGrant, PortfolioObservation
from vertex_host.native_approval import (
    DisabledNativeApprovalAuthority, EnrolledApproverKey, NativeApprovalAuthority,
    NativeApprovalPolicy, NativeApprovalScope, NativeApprovalUnavailable, NativeEpochTransition, NativeOutboxReplay, approval_subject,
)


class CodecAuthority:
    encode = staticmethod(canonical_encode)
    epoch_ns = staticmethod(epoch_ns)

    def validate(self, name, value) -> bool:
        # Signature/audit fixture only, not acceptance of the real public schema.
        return name == "NativeOutboxReplayGrant" and value.get("environment") == "paper"


class NativeApprovalRegression(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "approvals.sqlite"
        self.codec = CodecAuthority()
        # Public fixture seeds only. This code is not run during source authoring.
        self.approver = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
        self.status_signer = Ed25519PrivateKey.from_private_bytes(bytes(range(32, 64)))
        self.keys = (
            EnrolledApproverKey("approver", "human-fixture", self.approver.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw), ("approval",), 0, 10000),
            EnrolledApproverKey("status-root", "status-fixture", self.status_signer.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw), ("status",), 0, 10000),
        )
        self.policy = NativeApprovalPolicy("independent-policy", "1" * 64, "1.0.0", "paper-fixture", "sim-fixture", "USD", 1000, 1000)
        self.epoch = 1
        self.authority = self.new_authority()
        self.authority.open(initialize=True)
        self.addCleanup(self.authority.close)
        self.authority.install_status(self.status(), now_ns=100)

    def new_authority(self) -> NativeApprovalAuthority:
        return NativeApprovalAuthority(authority=self.codec, policy=self.policy, keys=self.keys,
            status_key_id="status-root", owner_scope=lambda: NativeApprovalScope(self.epoch), audit_path=self.path)

    def common(self) -> dict:
        return {"policyId": self.policy.policy_id, "policySha256": self.policy.policy_sha256,
                "policyVersion": "1.0.0", "accountAlias": "paper-fixture", "environment": "paper",
                "simulatorId": "sim-fixture", "currency": "USD"}

    def signed(self, payload: dict, *, key_id: str = "approver") -> bytes:
        key = self.approver if key_id == "approver" else self.status_signer
        message = b"vertex-native-approval-signature-v1\0" + self.codec.encode({"keyId": key_id, "payload": payload})
        return self.codec.encode({"keyId": key_id, "payload": payload, "signatureHex": key.sign(message).hex()})

    def status(self, *, revision: str = "1", **changes) -> bytes:
        payload = {**self.common(), "format": "vertex-native-approval-status-v1", "revision": revision,
                   "checkedNs": "80", "expiresNs": "800", "revokedKeyIds": [],
                   "revokedApprovalIds": [], "revokedNonces": [], **changes}
        return self.signed(payload, key_id="status-root")

    def grant(self, **changes) -> MutationGrant:
        values = dict(grant_id="reset-fixture", action="reset-new-risk", account_alias="paper-fixture",
                      environment="paper", owner_epoch=1, submission_key=None, actor_id="human-fixture",
                      issued_ns=90, expires_ns=900, evidence_sha256="2" * 64)
        return MutationGrant(**{**values, **changes})

    def approval(self, value, *, seed_observation=None, nonce="a" * 64, **changes) -> bytes:
        if type(value) is SimulationCapitalPolicy:
            action, identifier = "seed-simulation", value.approval_id
        elif type(value) is PortfolioObservation:
            action, identifier = "observe-portfolio", "observation-approval-fixture"
        elif type(value) is NativeEpochTransition:
            action, identifier = "owner-epoch-transition", "transition-approval-fixture"
        elif type(value) is NativeOutboxReplay:
            action, identifier = "native-outbox-replay", value.binding()["grantId"]
        else:
            action, identifier = value.action, value.grant_id
        payload = {**self.common(), "format": "vertex-native-approval-v1", "approvalId": identifier,
                   "nonce": nonce, "actorId": "human-fixture", "ownerEpoch": "1", "action": action,
                   "issuedNs": "90", "expiresNs": "900",
                   "subject": approval_subject(value, authority=self.codec, seed_observation=seed_observation), **changes}
        return self.signed(payload)

    def seed(self) -> tuple[SimulationCapitalPolicy, PortfolioObservation]:
        policy = SimulationCapitalPolicy("capital-fixture", "3" * 64, "paper-fixture", "sim-fixture", "USD",
            "100.00", "human-fixture", "seed-fixture", 90, 900, 100)
        observation = PortfolioObservation("seed-observation", "paper-fixture", "paper", "sim-fixture", 1,
            100, 100, 190, "USD", "100.00", (), "4" * 64, 1, "5" * 64, "capital-fixture", "3" * 64)
        return policy, observation

    def test_default_and_unopened_authority_deny(self) -> None:
        self.assertFalse(DisabledNativeApprovalAuthority().verify(self.grant(), now_ns=100))
        self.assertFalse(self.new_authority().verify(self.grant(), now_ns=100))

    def test_mutation_consumption_survives_restart(self) -> None:
        grant = self.grant()
        signed = self.approval(grant)
        self.authority.install_approval(signed, now_ns=100)
        self.assertTrue(self.authority.verify(grant, now_ns=100))
        self.assertFalse(self.authority.verify(grant, now_ns=100))
        self.authority.close()
        restored = self.new_authority()
        self.addCleanup(restored.close)
        restored.open(initialize=False)
        restored.install_approval(signed, now_ns=101)  # Exact install replay does not reset consumed state.
        self.assertFalse(restored.verify(grant, now_ns=101))

    def test_capital_preparation_is_idempotent_but_observation_consumes_once(self) -> None:
        policy, observation = self.seed()
        self.authority.install_approval(self.approval(policy, seed_observation=observation), now_ns=100)
        self.assertFalse(self.authority.verify(observation, now_ns=100))
        self.assertTrue(self.authority.verify(policy, now_ns=100))
        self.assertTrue(self.authority.verify(policy, now_ns=101))
        self.assertFalse(self.authority.verify(replace(observation, cash="101.00"), now_ns=101))
        self.assertTrue(self.authority.verify(observation, now_ns=101))
        self.assertFalse(self.authority.verify(observation, now_ns=101))
        self.assertFalse(self.authority.verify(policy, now_ns=101))
        stages = self.authority._db().execute("SELECT stage FROM audit ORDER BY ordinal").fetchall()
        self.assertEqual(stages, [("installed",), ("prepared",), ("consumed",)])

    def test_signed_seed_cannot_exceed_bound_policy_observation_age(self) -> None:
        policy, observation = self.seed()
        observation = replace(observation, valid_until_ns=300)
        self.authority.install_approval(self.approval(policy, seed_observation=observation), now_ns=100)
        self.assertTrue(self.authority.verify(policy, now_ns=100))
        self.assertFalse(self.authority.verify(observation, now_ns=100))

    def test_revocation_between_prepare_and_observe_is_current(self) -> None:
        policy, observation = self.seed()
        self.authority.install_approval(self.approval(policy, seed_observation=observation), now_ns=100)
        self.assertTrue(self.authority.verify(policy, now_ns=100))
        self.authority.install_status(self.status(revision="2", revokedApprovalIds=["seed-fixture"]), now_ns=101)
        self.assertFalse(self.authority.verify(observation, now_ns=101))
        with self.assertRaises(NativeApprovalUnavailable):
            self.authority.install_status(self.status(), now_ns=101)

    def test_current_status_expiry_key_revocation_and_epoch_change_deny(self) -> None:
        grant = self.grant()
        self.authority.install_approval(self.approval(grant), now_ns=100)
        self.assertFalse(self.authority.verify(grant, now_ns=800))
        self.epoch = 2
        self.assertFalse(self.authority.verify(grant, now_ns=100))
        self.epoch = 1
        self.authority.install_status(self.status(revision="2", revokedKeyIds=["approver"]), now_ns=100)
        self.assertFalse(self.authority.verify(grant, now_ns=100))

    def test_tamper_and_worker_token_do_not_authorize(self) -> None:
        grant = self.grant()
        signed = self.approval(grant)
        document = json.loads(signed)
        document["payload"]["subject"]["grantSha256"] = "f" * 64
        with self.assertRaises(NativeApprovalUnavailable):
            self.authority.install_approval(self.codec.encode(document), now_ns=100)
        for raw in (b"worker-token-fixture", b"{}", signed + b" "):
            with self.assertRaises(NativeApprovalUnavailable):
                self.authority.install_approval(raw, now_ns=100)
        self.assertFalse(self.authority.verify(grant, now_ns=100))

    def test_wrong_amount_account_policy_action_and_version_deny(self) -> None:
        policy, observation = self.seed()
        signed = self.approval(policy, seed_observation=observation)
        self.authority.install_approval(signed, now_ns=100)
        self.assertFalse(self.authority.verify(replace(policy, settled_cash="999.00"), now_ns=100))
        for changes in ({"accountAlias": "other"}, {"policyVersion": "2.0.0"}, {"policySha256": "f" * 64}, {"environment": "live"}):
            with self.assertRaises(NativeApprovalUnavailable):
                self.authority.install_approval(self.approval(policy, seed_observation=observation, **changes), now_ns=100)
        self.assertFalse(self.authority.verify(self.grant(), now_ns=100))

    def test_concurrent_connections_have_exactly_one_consumption(self) -> None:
        grant = self.grant()
        self.authority.install_approval(self.approval(grant), now_ns=100)
        other = self.new_authority()
        other.open(initialize=False)
        self.addCleanup(other.close)
        with ThreadPoolExecutor(max_workers=2) as workers:
            attempts = [workers.submit(selected.verify, grant, now_ns=100) for selected in (self.authority, other)]
            self.assertEqual(sorted(result.result() for result in attempts), [False, True])

    def test_nonce_cannot_be_reused_for_another_approval(self) -> None:
        first, second = self.grant(), self.grant(grant_id="second-reset-fixture")
        self.authority.install_approval(self.approval(first), now_ns=100)
        with self.assertRaises(Exception):
            self.authority.install_approval(self.approval(second), now_ns=100)
        self.assertTrue(self.authority.verify(first, now_ns=100))
        self.assertFalse(self.authority.verify(second, now_ns=100))

    def test_nonseed_observation_is_exact_and_cannot_reset_seed_capital(self) -> None:
        _, seed = self.seed()
        observation = replace(seed, observation_id="later-observation", source_sequence=2,
                              seed_policy_artifact_id=None, seed_policy_sha256=None)
        self.authority.install_approval(self.approval(observation), now_ns=100)
        self.assertFalse(self.authority.verify(replace(observation, journal_sha256="f" * 64), now_ns=100))
        self.assertTrue(self.authority.verify(observation, now_ns=100))
        self.assertFalse(self.authority.verify(observation, now_ns=100))

    def test_initialization_never_overwrites_existing_audit(self) -> None:
        existing = self.new_authority()
        with self.assertRaises(NativeApprovalUnavailable):
            existing.open(initialize=True)
        self.assertFalse(existing.verify(self.grant(), now_ns=100))

    def test_constructor_never_opens_files_or_crypto(self) -> None:
        with patch("vertex_host.native_approval.os.open") as opener, patch("vertex_host.native_approval.sqlite3.connect") as connect:
            selected = self.new_authority()
            opener.assert_not_called()
            connect.assert_not_called()
            self.assertFalse(selected.verify(self.grant(), now_ns=100))

    def test_factory_only_parses_explicit_public_enrollment(self) -> None:
        configuration = {
            "format": "vertex-native-approval-config-v1", "auditPath": str(self.path), "startupMode": "restore",
            "statusFile": {"path": str(self.path.parent / "status.json"), "sha256": "a" * 64},
            "statusKeyId": "status-root",
            "keys": [{"keyId": key.key_id, "actorId": key.actor_id,
                      "publicKeyBase64": base64.b64encode(key.public_key).decode("ascii"),
                      "roles": list(key.roles), "notBeforeNs": str(key.not_before_ns), "expiresNs": str(key.expires_ns)}
                     for key in self.keys],
            "policy": {"policyId": self.policy.policy_id, "policySha256": self.policy.policy_sha256,
                       "policyVersion": self.policy.policy_version, "accountAlias": self.policy.account_alias,
                       "simulatorId": self.policy.simulator_id, "currency": self.policy.currency,
                       "maximumApprovalTtlNs": "1000", "maximumStatusAgeNs": "1000"},
        }
        with patch("vertex_host.native_approval.os.open") as opener, patch("vertex_host.native_approval.sqlite3.connect") as connect:
            selected = NativeApprovalAuthority.from_config(configuration, authority=self.codec,
                owner_scope=lambda: NativeApprovalScope(1))
            opener.assert_not_called()
            connect.assert_not_called()
            self.assertFalse(selected.verify(self.grant(), now_ns=100))
        configuration["keys"][0]["publicKeyBase64"] = "not-a-key"
        with self.assertRaises(NativeApprovalUnavailable):
            NativeApprovalAuthority.from_config(configuration, authority=self.codec,
                owner_scope=lambda: NativeApprovalScope(1))

    def test_changed_policy_enrollment_cannot_restore_prior_audit(self) -> None:
        self.authority.close()
        changed = NativeApprovalAuthority(authority=self.codec,
            policy=replace(self.policy, policy_version="2.0.0"), keys=self.keys, status_key_id="status-root",
            owner_scope=lambda: NativeApprovalScope(1), audit_path=self.path)
        with self.assertRaises(NativeApprovalUnavailable):
            changed.open(initialize=False)

    def test_equal_status_revision_conflict_never_replaces_snapshot(self) -> None:
        with self.assertRaisesRegex(NativeApprovalUnavailable, "rollback-or-conflict"):
            self.authority.install_status(self.status(revokedKeyIds=["approver"]), now_ns=100)
        grant = self.grant()
        self.authority.install_approval(self.approval(grant), now_ns=100)
        self.assertTrue(self.authority.verify(grant, now_ns=100))

    def transition(self) -> NativeEpochTransition:
        return NativeEpochTransition("paper-fixture", "paper", "sim-fixture", "stream-fixture", "journal-fixture",
                                     1, 2, 17, "3" * 64, 21, "4" * 64, "5" * 64, "6" * 64, "7" * 64)

    def test_owner_epoch_transition_is_once_only_without_capital_seed(self) -> None:
        self.epoch = 2
        transition = self.transition()
        signed = self.approval(transition, ownerEpoch="2")
        self.authority.install_approval(signed, now_ns=100)
        self.assertEqual(self.authority.installed_approval_bytes("transition-approval-fixture"), signed)
        self.assertTrue(self.authority.verify(transition, now_ns=100))
        self.assertFalse(self.authority.verify(transition, now_ns=100))
        self.assertEqual(self.authority.installed_approval_bytes("transition-approval-fixture"), signed)
        audit = self.authority._db().execute("SELECT stage FROM audit ORDER BY ordinal").fetchall()
        self.assertEqual(audit, [("installed",), ("consumed",)])

    def test_transition_binds_every_snapshot_journal_and_fence_field(self) -> None:
        self.epoch = 2
        transition = self.transition()
        self.authority.install_approval(self.approval(transition, ownerEpoch="2"), now_ns=100)
        for change in (
            {"account_alias": "different-account"}, {"simulator_id": "different-simulator"},
            {"stream_id": "different-stream"}, {"journal_identity": "different-journal"},
            {"prior_projection_sequence": 18}, {"journal_sequence": 22},
            {"prior_projection_hash": "8" * 64}, {"journal_head_sha256": "8" * 64},
            {"new_snapshot_sha256": "8" * 64}, {"native_outbox_evidence_sha256": "8" * 64},
            {"native_owner_fence_sha256": "8" * 64}, {"current_owner_epoch": 3},
        ):
            self.assertFalse(self.authority.verify(replace(transition, **change), now_ns=100))
        self.assertTrue(self.authority.verify(transition, now_ns=100))

    def test_transition_rejects_same_epoch_live_scope_and_boolean_counter(self) -> None:
        for change in (
            {"current_owner_epoch": 1}, {"prior_owner_epoch": 0}, {"environment": "live"},
            {"prior_projection_sequence": True}, {"journal_sequence": 0},
            {"native_owner_fence_sha256": "not-a-digest"},
        ):
            with self.assertRaises(NativeApprovalUnavailable):
                replace(self.transition(), **change)

    def test_transition_current_revocation_and_restore_preserve_consumption(self) -> None:
        self.epoch = 2
        transition = self.transition()
        self.authority.install_approval(self.approval(transition, ownerEpoch="2"), now_ns=100)
        self.assertTrue(self.authority.verify(transition, now_ns=100))
        self.authority.close()
        restored = self.new_authority()
        restored.open(initialize=False)
        self.addCleanup(restored.close)
        self.assertFalse(restored.verify(transition, now_ns=100))
        with self.assertRaises(NativeApprovalUnavailable):
            restored.installed_approval_bytes("unknown-approval")

    def replay(self) -> NativeOutboxReplay:
        binding = {
            "schemaVersion": "1.0.0", "grantId": "replay-fixture", "accountAlias": "paper-fixture",
            "environment": "paper", "streamId": "stream-fixture", "priorOwnerEpoch": "1", "currentOwnerEpoch": "2",
            "serviceActorId": "native-emitter-fixture", "startingSequence": "0", "startingEventHash": None,
            "journalIdentity": "journal-fixture", "journalSequence": "17", "journalHeadSha256": "3" * 64,
            "nativeJournalEvidenceSha256": "4" * 64, "nativeOwnerFenceSha256": "5" * 64,
            "retainedEpochTransitionSha256": None,
            "issuedAt": "1970-01-01T00:00:00.000000090Z", "expiresAt": "1970-01-01T00:00:00.000000900Z",
            "rows": [{"projectionId": "retained-genesis", "sequence": "1", "eventHash": "6" * 64,
                      "projectionRawSha256": "7" * 64, "kind": "portfolio-genesis", "proofSha256": None}],
        }
        return NativeOutboxReplay(self.codec.encode(binding))

    def test_replay_exact_batch_retries_reuse_receipt_not_a_new_consumption(self) -> None:
        self.epoch = 2
        replay = self.replay()
        signed = self.approval(replay, ownerEpoch="2")
        self.authority.install_approval(signed, now_ns=100)
        self.assertTrue(self.authority.verify(replay, now_ns=100))
        self.assertTrue(self.authority.verify(replay, now_ns=101))
        self.authority.close()
        restored = self.new_authority()
        restored.open(initialize=False)
        self.addCleanup(restored.close)
        self.assertTrue(restored.verify(replay, now_ns=102))
        self.assertEqual(restored.installed_approval_bytes("replay-fixture"), signed)
        stages = restored._db().execute("SELECT stage FROM audit ORDER BY ordinal").fetchall()
        self.assertEqual(stages, [("installed",), ("consumed",)])

    def test_replay_retries_still_require_current_rights_epoch_and_expiry(self) -> None:
        self.epoch = 2
        replay = self.replay()
        self.authority.install_approval(self.approval(replay, ownerEpoch="2"), now_ns=100)
        self.assertTrue(self.authority.verify(replay, now_ns=100))
        self.assertFalse(self.authority.verify(replay, now_ns=900))
        self.epoch = 3
        self.assertFalse(self.authority.verify(replay, now_ns=100))
        self.epoch = 2
        self.authority.install_status(self.status(revision="2", revokedApprovalIds=["replay-fixture"]), now_ns=100)
        self.assertFalse(self.authority.verify(replay, now_ns=100))

    def test_replay_recipient_rows_hashes_and_start_head_cannot_change(self) -> None:
        self.epoch = 2
        replay = self.replay()
        self.authority.install_approval(self.approval(replay, ownerEpoch="2"), now_ns=100)
        self.assertTrue(self.authority.verify(replay, now_ns=100))
        for change in (
            {"serviceActorId": "other-service"}, {"startingSequence": "1", "startingEventHash": "f" * 64},
            {"nativeJournalEvidenceSha256": "f" * 64}, {"nativeOwnerFenceSha256": "f" * 64},
            {"journalHeadSha256": "f" * 64}, {"rows": []}, {"accountAlias": "other-account"},
            {"retainedEpochTransitionSha256": "f" * 64},
        ):
            changed = NativeOutboxReplay(self.codec.encode({**replay.binding(), **change}))
            self.assertFalse(self.authority.verify(changed, now_ns=100))
        altered = replay.binding()
        altered["rows"][0]["projectionRawSha256"] = "f" * 64
        self.assertFalse(self.authority.verify(NativeOutboxReplay(self.codec.encode(altered)), now_ns=100))

    def test_replay_canonical_public_binding_and_native_validation_required(self) -> None:
        replay = self.replay()
        with self.assertRaises(NativeApprovalUnavailable):
            approval_subject(NativeOutboxReplay(replay.grant_binding_bytes + b" "), authority=self.codec)
        self.epoch = 2
        signed = self.approval(replay, ownerEpoch="2")
        grant = {**replay.binding(), "approvalBase64": base64.b64encode(signed).decode("ascii")}
        self.assertEqual(NativeOutboxReplay.from_grant(grant, authority=self.codec), replay)
        self.authority.install_approval(signed, now_ns=100)
        with patch.object(self.codec, "validate", return_value=False):
            self.assertFalse(self.authority.verify(replay, now_ns=100))

    def test_replay_consumed_flag_without_exact_audit_receipt_does_not_authorize(self) -> None:
        self.epoch = 2
        replay = self.replay()
        self.authority.install_approval(self.approval(replay, ownerEpoch="2"), now_ns=100)
        self.authority._db().execute("UPDATE approvals SET state='consumed' WHERE approval_id='replay-fixture'")
        self.assertFalse(self.authority.verify(replay, now_ns=100))

    def test_cancel_consumed_transport_handoff_does_not_consume_twice(self) -> None:
        grant = self.grant(grant_id="cancel-fixture", action="cancel-simulation", submission_key="submission-fixture")
        self.authority.install_approval(self.approval(grant), now_ns=100)
        self.assertFalse(self.authority.verify_consumed(grant, now_ns=100))
        self.assertTrue(self.authority.verify(grant, now_ns=100))
        before = self.authority._db().execute("SELECT * FROM audit ORDER BY ordinal").fetchall()
        self.assertTrue(self.authority.verify_consumed(grant, now_ns=100))
        self.assertTrue(self.authority.verify_consumed(grant, now_ns=101))
        self.assertFalse(self.authority.verify(grant, now_ns=101))
        self.assertEqual(self.authority._db().execute("SELECT * FROM audit ORDER BY ordinal").fetchall(), before)

    def test_consumed_cancel_handoff_requires_current_signature_exact_grant_and_receipt(self) -> None:
        grant = self.grant(grant_id="cancel-fixture", action="cancel-simulation", submission_key="submission-fixture")
        self.authority.install_approval(self.approval(grant), now_ns=100)
        self.assertTrue(self.authority.verify(grant, now_ns=100))
        for changed in (replace(grant, evidence_sha256="f" * 64), replace(grant, submission_key="other"),
                        replace(grant, actor_id="other"), replace(grant, owner_epoch=2)):
            self.assertFalse(self.authority.verify_consumed(changed, now_ns=100))
        self.assertFalse(self.authority.verify_consumed(grant, now_ns=900))
        self.authority.install_status(self.status(revision="2", revokedApprovalIds=["cancel-fixture"]), now_ns=100)
        self.assertFalse(self.authority.verify_consumed(grant, now_ns=100))

    def test_consumed_transport_handoff_never_allows_reset_or_missing_consumption_audit(self) -> None:
        reset = self.grant()
        self.authority.install_approval(self.approval(reset), now_ns=100)
        self.assertTrue(self.authority.verify(reset, now_ns=100))
        self.assertFalse(self.authority.verify_consumed(reset, now_ns=100))
        cancel = self.grant(grant_id="cancel-fixture", action="cancel-simulation", submission_key="submission-fixture")
        self.authority.install_approval(self.approval(cancel, nonce="b" * 64), now_ns=100)
        self.authority._db().execute("UPDATE approvals SET state='consumed' WHERE approval_id='cancel-fixture'")
        self.assertFalse(self.authority.verify_consumed(cancel, now_ns=100))

    def test_replay_sidecar_hash_is_required_nullable_signed_public_field(self) -> None:
        replay = self.replay()
        self.assertIsNone(replay.binding()["retainedEpochTransitionSha256"])
        omitted = replay.binding()
        del omitted["retainedEpochTransitionSha256"]
        with self.assertRaisesRegex(NativeApprovalUnavailable, "exact-public-binding"):
            approval_subject(NativeOutboxReplay(self.codec.encode(omitted)), authority=self.codec)
        for invalid in ("not-a-digest", "A" * 64, False, 1):
            with self.assertRaises(NativeApprovalUnavailable):
                approval_subject(NativeOutboxReplay(self.codec.encode({
                    **replay.binding(), "retainedEpochTransitionSha256": invalid,
                })), authority=self.codec)
        retained = NativeOutboxReplay(self.codec.encode({
            **replay.binding(), "retainedEpochTransitionSha256": "8" * 64,
        }))
        self.assertNotEqual(approval_subject(replay, authority=self.codec),
                            approval_subject(retained, authority=self.codec))

    def test_retained_sidecar_hash_needs_fresh_exact_replay_approval_not_historical_epoch_approval(self) -> None:
        self.epoch = 2
        retained = NativeOutboxReplay(self.codec.encode({
            **self.replay().binding(), "retainedEpochTransitionSha256": "8" * 64,
        }))
        # An unrelated installed historical transition is not replay authority.
        transition = self.transition()
        self.authority.install_approval(self.approval(transition, ownerEpoch="2"), now_ns=100)
        self.assertFalse(self.authority.verify(retained, now_ns=100))
        self.authority.install_approval(self.approval(retained, ownerEpoch="2", nonce="b" * 64), now_ns=100)
        self.assertTrue(self.authority.verify(retained, now_ns=100))
        self.assertFalse(self.authority.verify(self.replay(), now_ns=100))
        altered = NativeOutboxReplay(self.codec.encode({
            **retained.binding(), "retainedEpochTransitionSha256": "9" * 64,
        }))
        self.assertFalse(self.authority.verify(altered, now_ns=100))
        self.assertFalse(self.authority.verify(retained, now_ns=900))
        self.authority.install_status(self.status(revision="2", revokedNonces=["b" * 64]), now_ns=100)
        self.assertFalse(self.authority.verify(retained, now_ns=100))
