"""Offline native v2 boundaries, never owner approval or DB/privacy qualification.

The actual Python handler, consumer and output adapters execute against the
existing explicit control/HTTP doubles. Five manually dispatched fixtures are
not an autonomous loop or a durable reservation/permission implementation.
"""
from base64 import b64decode, b64encode
from copy import deepcopy
from dataclasses import asdict, replace
from hashlib import sha256
import json

import pytest

from adapters.chat_consumer import ApprovedChatConsumer, decode_chat_recipe, decode_chat_recipe_v2
from adapters.chat_inputs import (
    canonical_chat_input_bytes, prepare_chat_inputs, prepare_chat_inputs_v2,
)
from adapters.chat_output import prepare_chat_output, retain_chat_advisory
from adapters.ports import AdapterUnavailable
from adapters.tests.chat_debate_bridge import consume_fixture
from adapters.tests.test_chat_consumer import build_boundary, prohibit_real_network, repin_recipe
from adapters.tests.test_chat_output import dispatch
from agents.types import AgentFault
from vertex_control.client import ControlError


def human_window(human):
    value = asdict(human)
    return {"threadId": human.thread_id, "parentMessageId": human.parent_message_id,
            "snapshotRevision": human.snapshot_revision, "contextStartSequence": human.start_sequence,
            "messages": list(value["messages"])}


def debate_boundary(monkeypatch, ordinal=1, predecessors=(), synthesizer="expert-two"):
    f = build_boundary(monkeypatch)
    participant = synthesizer if ordinal == 5 else ("expert", "expert-two")[(ordinal - 1) % 2]
    response_id, run_id = f"response-{ordinal}", f"run-{ordinal}"
    f.args["human_context"] = replace(f.args["human_context"], response_request_id=response_id,
                                      participant_id=participant)
    f.args["identity"] = replace(f.args["identity"], response_request_id=response_id, run_id=run_id)
    f.recipe.update(profile="vertex-research-chat-job-v2", response_request_id=response_id,
                    run_id=run_id, plan_id=f"plan-{ordinal}", plan_sha256=sha256(f"plan-{ordinal}".encode()).hexdigest())
    f.recipe["copies"]["advisory"]["copyId"] = f"advisory-{ordinal}"
    queued_pin = f.recipe["execution"]["queuedRun"]
    queued = json.loads(f.control.records[queued_pin["artifactId"]])
    queued["runId"] = run_id
    f.control.records[queued_pin["artifactId"]] = f.authority.encode(queued)
    queued_pin["artifactSha256"] = f.authority.digest(queued)
    f.lease.update(jobId=f"job-{ordinal}", leaseId=f"lease-{ordinal}")
    derived = {"profile": "vertex-research-chat-derived-context-v1", "debateRunId": "debate-run",
               "ordinal": ordinal, "kind": "synthesis" if ordinal == 5 else "statement",
               "predecessors": deepcopy(list(predecessors))}
    debate = {"profile": "vertex-research-chat-debate-plan-v1", "debateRunId": "debate-run", "runKey": "run-key",
              "ordinal": ordinal, "kind": derived["kind"], "participantIds": ["expert", "expert-two"],
              "synthesizerId": synthesizer,
              "configuration": {"artifactId": "debate-config", "artifactSha256": "c" * 64,
                                "contractName": "ResearchChatDebateConfiguration", "schemaVersion": "1.0.0"},
              "humanWindowSha256": f.authority.digest(human_window(f.args["human_context"])),
              "predecessors": [deepcopy(p["pin"]) for p in predecessors],
              "turnTokens": 2000, "turnCostUsd": "1", "aggregateTokens": 10000, "aggregateCostUsd": "5",
              "derivedContext": {"sha256": sha256(canonical_chat_input_bytes(derived)).hexdigest(),
                                 "byteLength": len(canonical_chat_input_bytes(derived))}}
    f.recipe["execution"]["debate"] = debate
    f.derived = derived
    f.prepared = prepare_chat_inputs_v2(**f.args, debate=debate, derived_context=derived, contracts=f.authority)
    install_inputs(f, f.prepared)
    return f


def install_inputs(f, prepared):
    f.http.prepared = prepared
    for purpose, body in (("context", prepared.context), ("tokenizeInput", prepared.tokenize_input),
                          ("completionInput", prepared.completion_input)):
        pin = f.recipe["copies"][purpose]
        f.control.copies[pin["copyId"]] = body
        pin.update(sha256=sha256(body).hexdigest(), byteLength=len(body))
    repin_recipe(f)


def published_predecessor(f):
    # Only an observed successful fixture publication is projected. These are
    # synthetic external-owner receipts, not Python-created source authority.
    assert f.control.durable_outputs == [f.recipe["run_id"]]
    copy = f.recipe["copies"]["advisory"]
    body = f.control.governed[copy["copyId"]]
    debate = f.recipe["execution"]["debate"]
    return {"pin": {"ordinal": debate["ordinal"], "participantId": f.args["human_context"].participant_id,
                    "responseRequestId": f.recipe["response_request_id"], "planId": f.recipe["plan_id"],
                    "planSha256": f.recipe["plan_sha256"], "runId": f.recipe["run_id"],
                    "copyId": copy["copyId"], "reservationSha256": copy["reservationSha256"],
                    "contentSha256": sha256(body).hexdigest(), "byteLength": len(body),
                    "publishedAt": "2027-01-15T08:00:09Z"},
            "advisory": json.loads(body)}


def earlier_turns(monkeypatch, count):
    predecessors = []
    for ordinal in range(1, count + 1):
        f = debate_boundary(monkeypatch, ordinal, predecessors)
        assert dispatch(f)["status"] == "completed"
        predecessors.append(published_predecessor(f))
    return predecessors


def mutate_approved_envelope(f, change, *, repin_derived=False):
    # Deliberately bypass pure preparation to exercise consumer refusal even
    # when the outer governed input and payload hashes have been recomputed.
    bodies = {}
    for purpose in ("tokenizeInput", "completionInput"):
        body = json.loads(f.control.copies[f.recipe["copies"][purpose]["copyId"]])
        envelope = json.loads(body["messages"][1]["content"])
        change(envelope["data"])
        derived = envelope["data"].get("derived_context")
        if repin_derived and derived is not None:
            encoded = canonical_chat_input_bytes(derived)
            f.recipe["execution"]["debate"]["derivedContext"] = {
                "sha256": sha256(encoded).hexdigest(), "byteLength": len(encoded)}
        body["messages"][1]["content"] = canonical_chat_input_bytes(envelope).decode()
        bodies[purpose] = canonical_chat_input_bytes(body)
    install_inputs(f, replace(f.prepared, tokenize_input=bodies["tokenizeInput"], completion_input=bodies["completionInput"]))


def test_actual_handler_five_explicit_turns_and_selected_synthesis_preserve_exact_buffers(monkeypatch):
    predecessors, steps = [], []
    for ordinal in range(1, 6):
        f = debate_boundary(monkeypatch, ordinal, predecessors)
        assert decode_chat_recipe_v2(f.recipe, contracts=f.authority) == f.recipe
        result = dispatch(f)
        assert result == {"status": "completed", "outputArtifactIds": [f"run-{ordinal}"], "executionAuthorized": False}
        assert [path for _, path, _ in f.http.sent] == ["/tokenize", "/v1/chat/completions"]
        assert [body for _, _, body in f.http.sent] == [f.prepared.tokenize_input, f.prepared.completion_input]
        retained = json.loads(f.control.governed[f"advisory-{ordinal}"])
        assert retained["profile"] == "vertex-research-chat-advisory-v2"
        assert retained["debate"] == f.recipe["execution"]["debate"]
        assert set(retained) == {"profile", "responseRequestId", "planId", "planSha256", "runId", "traceId", "taskContract",
                                 "modelVersion", "modelUseRequestSha256", "responseSha256", "usage", "output", "executionAuthorized", "debate"}
        data = json.loads(json.loads(f.prepared.completion_input)["messages"][1]["content"])["data"]
        assert data["derived_context"] == f.derived and data["prior_analyses"] == data["tool_results"] == []
        assert data["human_context"] == json.loads(f.prepared.context)
        assert len(data["derived_context"]["predecessors"]) == ordinal - 1
        for entry in data["derived_context"]["predecessors"]:
            encoded = f.authority.encode(entry["advisory"])
            assert sha256(encoded).hexdigest() == entry["pin"]["contentSha256"]
            assert len(encoded) == entry["pin"]["byteLength"]
        public = f.control.ordinary[f"run-{ordinal}"]
        assert b"Synthetic bounded finding" not in public and b"derived_context" not in public and b'"debate"' not in public
        assert "Synthetic bounded finding" not in json.dumps(result)
        steps.append((f.args["human_context"].participant_id, f.recipe["execution"]["debate"]["kind"]))
        if ordinal < 5:
            predecessors.append(published_predecessor(f))
    assert steps == [("expert", "statement"), ("expert-two", "statement"), ("expert", "statement"),
                     ("expert-two", "statement"), ("expert-two", "synthesis")]


@pytest.mark.parametrize("change", ["missing", "extra", "reordered", "body", "cross-run", "hash", "bytes", "plan", "response", "run", "participant", "prefix", "v1"])
def test_predecessor_mutations_reject_before_any_provider_disclosure(monkeypatch, change):
    f = debate_boundary(monkeypatch, 3, earlier_turns(monkeypatch, 2))
    def mutate(data):
        rows = data["derived_context"]["predecessors"]
        if change == "missing": rows.pop()
        elif change == "extra": rows.append(deepcopy(rows[-1]))
        elif change == "reordered": rows.reverse()
        elif change == "body": rows[0]["advisory"]["output"]["claims"][0]["text"] = "Mutated inert prose"
        elif change == "hash": rows[0]["pin"]["contentSha256"] = "0" * 64
        elif change == "bytes": rows[0]["pin"]["byteLength"] += 1
        elif change == "participant": rows[0]["pin"]["participantId"] = "expert-two"
        elif change in {"plan", "response", "run"}:
            rows[0]["advisory"][{"plan": "planId", "response": "responseRequestId", "run": "runId"}[change]] = "wrong"
        elif change == "prefix": rows[1]["advisory"]["debate"]["predecessors"][0]["planSha256"] = "0" * 64
        elif change == "v1": rows[0]["advisory"]["profile"] = "vertex-research-chat-advisory-v1"
        else: rows[0]["advisory"]["debate"]["debateRunId"] = "different-run"
    mutate_approved_envelope(f, mutate, repin_derived=True)
    result = dispatch(f)
    assert result["status"] in {"failed", "unavailable"} and f.http.sent == f.control.proofs == []
    assert f.control.publications == [] and f.control.governed == {}


@pytest.mark.parametrize("change", ["plan", "hash", "bytes", "collection", "snapshot", "participant", "human-window", "configuration", "turn-token", "turn-cost", "aggregate-token", "aggregate-cost", "derived-descriptor", "schedule", "kind", "first-mate", "missing-debate", "extra-field"])
def test_frozen_recipe_and_original_provenance_are_not_replaceable_by_repinned_inputs(monkeypatch, change):
    f = debate_boundary(monkeypatch, 2, earlier_turns(monkeypatch, 1))
    execution = f.recipe["execution"]
    debate = execution["debate"]
    if change == "plan": debate["predecessors"][0]["planId"] = "other-plan"
    elif change == "hash": debate["predecessors"][0]["contentSha256"] = "0" * 64
    elif change == "bytes": debate["predecessors"][0]["byteLength"] += 1
    elif change == "collection":
        execution["collectionId"] = execution["reviewPins"][0]["collectionId"] = "other-collection"
    elif change == "snapshot": execution["snapshotId"] = "other-snapshot"
    elif change == "participant": debate["participantIds"].reverse()
    elif change == "human-window": debate["humanWindowSha256"] = "0" * 64
    elif change == "configuration": debate["configuration"]["artifactSha256"] = "0" * 64
    elif change == "turn-token": debate["turnTokens"] = 1999
    elif change == "turn-cost": debate["turnCostUsd"] = "0.9"
    elif change == "aggregate-token": debate["aggregateTokens"] = 9999
    elif change == "aggregate-cost": debate["aggregateCostUsd"] = "4.999999999999999999"
    elif change == "derived-descriptor": debate["derivedContext"]["sha256"] = "0" * 64
    elif change == "schedule": debate["ordinal"] = 5
    elif change == "kind": debate["kind"] = "synthesis"
    elif change == "first-mate": debate["synthesizerId"] = "first-mate"
    elif change == "missing-debate": del execution["debate"]
    else: execution["retryCount"] = 1
    repin_recipe(f)
    assert dispatch(f)["status"] in {"unavailable", "failed"}
    assert f.http.sent == f.control.proofs == [] and f.control.governed == {}


def test_v1_decoder_and_provider_shape_still_reject_all_v2_contamination(monkeypatch):
    f = debate_boundary(monkeypatch)
    with pytest.raises((AdapterUnavailable, AgentFault)):
        decode_chat_recipe(f.recipe, contracts=f.authority)
    f.recipe["profile"] = "vertex-research-chat-job-v1"
    repin_recipe(f)
    assert dispatch(f)["status"] == "unavailable" and f.control.calls == []
    del f.recipe["execution"]["debate"]
    repin_recipe(f)
    assert dispatch(f)["status"] == "failed" and f.http.sent == []
    with pytest.raises(TypeError):
        prepare_chat_inputs(**f.args, derived_context=f.derived)
    derived = f.derived
    v1 = build_boundary(monkeypatch)
    mutate_approved_envelope(v1, lambda data: data.update(derived_context=derived))
    assert dispatch(v1)["status"] == "failed" and v1.http.sent == v1.control.proofs == []


@pytest.mark.parametrize("contamination", ["prior_analyses", "tool_results", "derived-absent"])
def test_v2_context_never_populates_legacy_analysis_or_tool_slots(monkeypatch, contamination):
    f = debate_boundary(monkeypatch)
    def change(data):
        if contamination == "derived-absent": del data["derived_context"]
        else: data[contamination] = [{"untrusted": "not an accepted slot"}]
    mutate_approved_envelope(f, change)
    assert dispatch(f)["status"] == "failed" and f.http.sent == []


@pytest.mark.parametrize("effect", ["tokenize", "completion", "advisory", "publication"])
def test_v2_unknown_outcomes_reconcile_original_keys_never_repeat_compute(monkeypatch, effect):
    f = debate_boundary(monkeypatch)
    if effect in {"tokenize", "completion"}:
        f.http.failure = "/tokenize" if effect == "tokenize" else "/v1/chat/completions"
    else:
        def mutate(method, fields, reply):
            if (effect == "publication" and method == "publishAgent" or effect == "advisory"
                    and method == "stageArtifact" and fields["artifactId"] == "advisory-1"):
                raise ControlError("synthetic-lost-ack", effect="unknown")
        f.control.mutate = mutate
    assert dispatch(f)["status"] == "unknown"
    sent = len(f.http.sent)
    assert sent == (1 if effect == "tokenize" else 2)
    original = deepcopy(f.recipe)
    assert dispatch(f)["status"] == "unknown" and len(f.http.sent) == sent
    assert f.recipe == original


@pytest.mark.parametrize("kind", ["tool_calls", "tool_requests", "retry", "changed-proof"])
def test_v2_no_tools_retries_or_replayed_output_authority(monkeypatch, kind):
    f = debate_boundary(monkeypatch)
    if kind == "retry":
        f.recipe["execution"]["budgets"]["maxRetries"] = 1
        repin_recipe(f)
    elif kind == "changed-proof":
        def mutate(method, fields, reply):
            if method == "currentModelUse" and len(f.control.proofs) == 4:
                reply["externalDispatchAllowed"] = True
        f.control.mutate = mutate
    else:
        message = f.http.responses["/v1/chat/completions"]["choices"][0]["message"]
        if kind == "tool_calls": message["tool_calls"] = [{"name": "not-authorized"}]
        else:
            value = json.loads(message["content"])
            value["tool_requests"] = [{"name": "not-authorized"}]
            message["content"] = f.authority.encode(value).decode()
    assert dispatch(f)["status"] in {"unavailable", "failed", "unknown"}
    assert len(f.http.sent) == (0 if kind == "retry" else 2)
    assert f.control.governed == {} and f.control.publications == []


@pytest.mark.parametrize("change", ["cross-run", "run-key", "configuration", "window", "synthesizer", "budget",
                                  "prefix", "previous-descriptor", "ordinal", "kind", "v1", "citation", "usage"])
def test_recomputed_outer_hashes_do_not_remove_predecessor_semantic_checks(monkeypatch, change):
    f = debate_boundary(monkeypatch, 3, earlier_turns(monkeypatch, 2))
    entries = deepcopy(f.derived["predecessors"])
    advisory = entries[-1]["advisory"]
    previous = advisory["debate"]
    if change == "cross-run": previous["debateRunId"] = "foreign-run"
    elif change == "run-key": previous["runKey"] = "foreign-key"
    elif change == "configuration": previous["configuration"]["artifactSha256"] = "0" * 64
    elif change == "window": previous["humanWindowSha256"] = "0" * 64
    elif change == "synthesizer": previous["synthesizerId"] = "expert"
    elif change == "budget": previous["aggregateTokens"] += 1
    elif change == "prefix": previous["predecessors"][0]["planSha256"] = "0" * 64
    elif change == "previous-descriptor": previous["derivedContext"]["sha256"] = "0" * 64
    elif change == "ordinal": previous["ordinal"] = 1
    elif change == "kind": previous["kind"] = "synthesis"
    elif change == "v1": advisory["profile"] = "vertex-research-chat-advisory-v1"
    elif change == "citation": advisory["output"]["claims"][0]["citations"][0]["source_snapshot_id"] = "foreign-snapshot"
    else: advisory["usage"]["totalTokens"] += 1
    encoded = f.authority.encode(advisory)
    entries[-1]["pin"].update(contentSha256=sha256(encoded).hexdigest(), byteLength=len(encoded))
    f.recipe["execution"]["debate"]["predecessors"] = [deepcopy(entry["pin"]) for entry in entries]
    mutate_approved_envelope(f, lambda data: data["derived_context"].update(predecessors=entries), repin_derived=True)
    assert dispatch(f)["status"] == "failed" and f.http.sent == f.control.proofs == []
    assert f.control.governed == {} and f.control.publications == []


@pytest.mark.parametrize("field,value", [
    ("tokenizeCostUsd", "0"), ("completionCostUsd", "0"),
    ("attemptCostUsd", "0.1"), ("requestCostUsd", "0.1"),
    ("attemptTokens", 1100), ("requestTokens", 1100),
])
def test_chat_single_completion_mapping_still_checks_both_operation_ceilings(monkeypatch, field, value):
    f = debate_boundary(monkeypatch)
    f.recipe["execution"]["budgets"][field] = value
    repin_recipe(f)
    assert dispatch(f)["status"] in {"unavailable", "failed"}
    assert f.http.sent == f.control.proofs == [] and f.control.publications == []


@pytest.mark.parametrize("mutation", ["count", "outputs", "total", "input-usage"])
def test_v2_measured_count_and_actual_completion_usage_remain_independent(monkeypatch, mutation):
    f = debate_boundary(monkeypatch)
    if mutation == "count":
        f.http.responses["/tokenize"].update(count=1001, tokens=list(range(1001)))
    else:
        usage = f.http.responses["/v1/chat/completions"]["usage"]
        if mutation == "outputs": usage.update(completion_tokens=129, total_tokens=329)
        elif mutation == "total": usage["total_tokens"] += 1
        else: usage.update(prompt_tokens=201, total_tokens=221)
    assert dispatch(f)["status"] == "failed"
    assert len(f.http.sent) == (1 if mutation == "count" else 2)
    assert f.control.governed == {} and f.control.publications == []


def actual_retained(f):
    job = f.job()
    consumer = ApprovedChatConsumer(job, f.recipe)
    context = prepare_chat_output(job=job, consumer=consumer)
    result = consumer.consume()
    retained = retain_chat_advisory(job=job, recipe=consumer.recipe, result=result,
                                    queued_run=context.queued_run, maximum_bytes=context.maximum_bytes)
    return job, consumer, context, result, retained


@pytest.mark.parametrize("change", ["v1-with-debate", "native-with-debate", "missing-debate", "unknown-profile", "extra-field",
                                  "missing-field", "extra-plan-field", "wrong-plan-profile",
                                  "noncanonical", "response-hash", "request-hash", "dispatch-proof", "execution"])
def test_real_control_stage_rejects_version_contamination_and_keeps_provenance_guards(monkeypatch, change):
    f = debate_boundary(monkeypatch)
    job, consumer, context, result, retained = actual_retained(f)
    value = json.loads(retained.content)
    proof = deepcopy(result.completion_proof)
    if change == "v1-with-debate": value["profile"] = "vertex-research-chat-advisory-v1"
    elif change == "native-with-debate": value["profile"] = "vertex-research-chat-native-evidence-advisory-v1"
    elif change == "missing-debate": del value["debate"]
    elif change == "unknown-profile": value["profile"] = "unrecognized-profile"
    elif change == "extra-field": value["derived_context"] = f.derived
    elif change == "missing-field": del value["planId"]
    elif change == "extra-plan-field": value["debate"]["approval"] = True
    elif change == "wrong-plan-profile": value["debate"]["profile"] = "not-a-plan"
    elif change == "response-hash": value["responseSha256"] = "0" * 64
    elif change == "request-hash": value["modelUseRequestSha256"] = "0" * 64
    elif change == "dispatch-proof": proof["externalDispatchAllowed"] = True
    elif change == "execution": value["executionAuthorized"] = True
    content = f.authority.encode(value)
    if change == "noncanonical": content = b"\n" + content
    with pytest.raises(ControlError):
        job.control.artifacts.stage_chat_advisory(collection_id="collection", artifact_id="advisory-1",
            content=content, maximum_content_bytes=context.maximum_bytes,
            rights_policy_id=context.rights_policy_id, rights_version=context.rights_version,
            lineage_artifact_ids=("evidence-artifact",), completion_request=result.completion_request,
            completion_response=result.completion_response, completion_proof=proof,
            deadline_ns=job.deadline, cancellation=job.cancel)
    assert not any(method == "stageArtifact" for method, _ in f.control.calls)
    assert f.control.governed == {} and f.control.publications == []


@pytest.mark.parametrize("profile", ["vertex-research-chat-advisory-v1", "vertex-research-chat-native-evidence-advisory-v1"])
def test_real_control_stage_admits_exact_v1_keys_under_each_v1_discriminator(monkeypatch, profile):
    # chat_output.retain_chat_advisory writes the native-evidence advisory with
    # exactly the v1 keys under its own discriminator; the stage must admit it.
    f = debate_boundary(monkeypatch)
    job, consumer, context, result, retained = actual_retained(f)
    value = json.loads(retained.content)
    del value["debate"]
    value["profile"] = profile
    content = f.authority.encode(value)
    job.control.artifacts.stage_chat_advisory(collection_id="collection", artifact_id="advisory-1",
        content=content, maximum_content_bytes=context.maximum_bytes,
        rights_policy_id=context.rights_policy_id, rights_version=context.rights_version,
        lineage_artifact_ids=("evidence-artifact",), completion_request=result.completion_request,
        completion_response=result.completion_response, completion_proof=result.completion_proof,
        deadline_ns=job.deadline, cancellation=job.cancel)
    stages = [fields for method, fields in f.control.calls if method == "stageArtifact"]
    assert [b64decode(fields["contentBase64"]) for fields in stages] == [content]


def test_retention_independently_rechecks_exact_approved_debate_recipe(monkeypatch):
    f = debate_boundary(monkeypatch)
    job, consumer, context, result, retained = actual_retained(f)
    assert json.loads(retained.content)["debate"] == consumer.recipe["execution"]["debate"]
    for change in ("human-window", "v1-profile"):
        recipe = deepcopy(consumer.recipe)
        if change == "human-window": recipe["execution"]["debate"]["humanWindowSha256"] = "0" * 64
        else: recipe["profile"] = "vertex-research-chat-job-v1"
        with pytest.raises((AdapterUnavailable, AgentFault)):
            retain_chat_advisory(job=job, recipe=recipe, result=result,
                queued_run=context.queued_run, maximum_bytes=context.maximum_bytes)
    assert f.control.governed == {} and f.control.publications == []


def bridge_payload(f):
    return {"action": "consume", "recipe": deepcopy(f.recipe), "lease": deepcopy(f.lease),
            "selection": deepcopy(f.selection), "artifacts": {key: b64encode(value).decode() for key, value in f.artifacts.items()},
            "copies": {purpose: b64encode(f.control.copies[f.recipe["copies"][purpose]["copyId"]]).decode()
                       for purpose in ("context", "tokenizeInput", "completionInput")},
            "queuedRunBase64": b64encode(f.control.records[f.recipe["execution"]["queuedRun"]["artifactId"]]).decode(),
            "originalEvidenceBase64": b64encode(f.control.original).decode(), "acceptedReview": deepcopy(f.control.review),
            "nowNs": str(f.context.clock.now_ns())}


def test_source_bridge_consumes_exact_foreign_approved_buffers_through_real_stage(monkeypatch):
    f = debate_boundary(monkeypatch)
    receipt = consume_fixture(bridge_payload(f))
    assert receipt["outcome"] == {"status": "completed", "outputArtifactIds": ["run-1"], "executionAuthorized": False}
    assert [b64decode(row["bodyBase64"]) for row in receipt["sentBodies"]] == [
        f.prepared.tokenize_input, f.prepared.completion_input]
    retained = b64decode(receipt["retainedBase64"])
    assert f.authority.encode(json.loads(retained)) == retained
    assert json.loads(retained)["debate"] == f.recipe["execution"]["debate"]
    assert json.loads(retained)["usage"]["totalTokens"] == 44
    assert b64decode(receipt["stageRequests"][0]["contentBase64"]) == retained
    assert receipt["completionRequest"]["inputTokens"] == 37
    assert receipt["proof"]["externalDispatchAllowed"] is False
    assert len(receipt["publicationRequests"]) == 1


@pytest.mark.parametrize("change", ["missing", "extra", "copy", "lease", "original", "queued", "base64"])
def test_source_bridge_rejects_invalid_bytes_without_repairing_external_pins(monkeypatch, change):
    f = debate_boundary(monkeypatch)
    payload = bridge_payload(f)
    if change == "missing": del payload["acceptedReview"]
    elif change == "extra": payload["authority"] = True
    elif change == "copy": payload["copies"]["completionInput"] = b64encode(b"{}").decode()
    elif change == "lease": payload["lease"]["payloadSha256"] = "0" * 64
    elif change == "original": payload["originalEvidenceBase64"] = b64encode(b"{}").decode()
    elif change == "queued": payload["queuedRunBase64"] = b64encode(b"{}").decode()
    else: payload["copies"]["context"] = "not-base64"
    with pytest.raises(ValueError):
        consume_fixture(payload)


def test_bridge_keeps_source_and_queued_publication_rights_distinct(monkeypatch):
    f = debate_boundary(monkeypatch)
    f.recipe["execution"]["queuedRun"].update(rightsPolicyId="publication-policy", rightsVersion="2.0.0")
    repin_recipe(f)
    receipt = consume_fixture(bridge_payload(f))
    assert receipt["outcome"]["status"] == "completed"
    assert all(stage["rightsPolicyId"] == "publication-policy" and stage["rightsVersion"] == "2.0.0"
               for stage in receipt["stageRequests"])
    assert receipt["completionRequest"]["evidence"][0]["rightsPolicyId"] == "rights"
    assert receipt["completionRequest"]["evidence"][0]["rightsVersion"] == "1.0.0"
    assert receipt["publicationRequests"][0]["reviewPins"] == f.recipe["execution"]["reviewPins"]
