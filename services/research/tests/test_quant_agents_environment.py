"""Research scope admission cases, authored but deliberately unexecuted."""

import pytest

from agents import ALLOWED_TOOLS, ExistingChatAdapter
from tests.test_quant_agents_safety import Rights, request, setup


@pytest.mark.parametrize("environment", ["research", "paper", "live"])
def test_exact_advisory_environment_is_preserved_through_current_review(environment):
    runner, ports = setup()
    result = runner.run(request(environment=environment, account_alias="account-1"))
    assert result.status == "completed"
    assert result.execution_authorized is False
    proof_request = ports["rights"].review_calls[0]
    assert proof_request["environment"] == environment
    assert proof_request["account_alias"] == "account-1"
    assert proof_request["purpose"] == "research"
    assert proof_request["original_bytes"] == ports["retrieval"].result.citations[0].original_bytes
    assert result.output.execution_authorized is False
    assert all(proposal.execution_authorized is False for proposal in result.output.proposals)
    assert all(event.execution_authorized is False for event in
               ExistingChatAdapter().events(thread_id="thread-1", result=result))
    assert set(ports["model"].calls[0].allowed_tools) == ALLOWED_TOOLS
    assert "broker.submit_order" not in ALLOWED_TOOLS
    assert "reserve-cash" not in ALLOWED_TOOLS


@pytest.mark.parametrize("review_environment", ["paper", "live"])
def test_research_is_not_an_alias_for_paper_or_live_current_review(review_environment):
    rights = Rights()
    rights.review_changes = {"environment": review_environment}
    runner, ports = setup(rights=rights)
    result = runner.run(request(environment="research"))
    assert result.errors == ("rights-denied",)
    assert rights.review_calls[0]["environment"] == "research"
    assert not ports["model"].calls
    assert result.execution_authorized is False


@pytest.mark.parametrize("environment", ["paper", "live"])
def test_research_review_cannot_authorize_another_advisory_environment(environment):
    rights = Rights()
    rights.review_changes = {"environment": "research"}
    runner, ports = setup(rights=rights)
    result = runner.run(request(environment=environment))
    assert result.errors == ("rights-denied",)
    assert not ports["model"].calls


@pytest.mark.parametrize("changes,error", [
    ({"environment": "unknown"}, "rights-denied"),
    ({"environment": "Research"}, "rights-denied"),
    ({"environment": "research "}, "rights-denied"),
    ({"environment": ""}, "rights-denied"),
    ({"environment": None}, "rights-denied"),
    ({"account_alias": ""}, "invalid-identity"),
    ({"account_alias": "unscoped account"}, "invalid-identity"),
])
def test_invalid_scope_is_denied_before_run_admission_or_retrieval(changes, error):
    runner, ports = setup()
    result = runner.run(request(**changes))
    assert result.errors == (error,)
    assert not ports["admission"].seen
    assert not ports["retrieval"].calls
    assert not ports["rights"].review_calls
    assert not ports["model"].calls


def test_research_requires_same_immutable_overlay_and_rights_as_paper():
    rights = Rights()
    rights.review_missing = True
    runner, ports = setup(rights=rights)
    result = runner.run(request(environment="research"))
    assert result.errors == ("rights-denied",)
    assert not ports["model"].calls
    assert result.execution_authorized is False
