"""Agno 1.7.12 SDK bridge, restricted to a pinned text-only vLLM 0.9.2 host.

No universal token estimate. The SAME final role/content array is metered by
/tokenize and submitted by Agno to /v1/chat/completions. Runtime configuration
must attest deterministic templates, immutable replicas and no prompt adapters.
Unknown model/backend/meter/pricing/dependency remains model-unavailable.
"""
from __future__ import annotations

import json
import threading
from importlib.metadata import version
from typing import Any, Callable, Mapping

from agents.adapters import AgnoAdvisoryAdapter, AgnoCall
from agents.budget import usd_text, usd_units
from agents.types import AgentFault, Evidence, SYSTEM_INSTRUCTION
from providers.boundary import parse_json
from providers.ports import HttpRequest
from .http import HttpsTransport, SharedRateGate
from .model_policy import ModelPolicy
from .model_use import ModelUseRequests
from .ports import AdapterUnavailable, Cancellation, Clock, EndpointPolicy, ResearchClock, SharedAdmission


DEPENDENCIES = {"agno": "1.7.12", "openai": "1.93.0", "httpx": "0.28.1"}
CHAT_OPTIONS = {"add_generation_prompt": True, "continue_final_message": False,
                "add_special_tokens": False, "chat_template_kwargs": {}}


def _object(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def _schema(tools: tuple[str, ...]) -> dict[str, Any]:
    text = {"type": "string"}
    citation = _object({key: text for key in ("evidence_id", "source_id", "source_snapshot_id", "content_hash", "excerpt_digest", "quote")})
    claim = _object({"text": text, "kind": {"type": "string", "enum": ["fact", "hypothesis", "limitation"]},
                     "citations": {"type": "array", "items": citation, "maxItems": 8}})
    proposal = _object({"proposal_id": text, "kind": {"type": "string", "enum": ["strategy-hypothesis", "backtest-request"]},
                        "title": text, "rationale": claim, "execution_authorized": {"const": False}})
    output = _object({"claims": {"type": "array", "items": claim, "maxItems": 12},
                      "proposals": {"type": "array", "items": proposal, "maxItems": 8}, "execution_authorized": {"const": False}})
    argument_schemas = {
        "read-evidence": _object({"evidence_id": text}),
        "search-authorized-corpus": _object({"collection_id": text, "snapshot_id": text, "query": text,
                                            "limit": {"type": "integer", "minimum": 1, "maximum": 32}}),
        "propose-strategy": _object({"proposal": proposal}),
        "request-backtest": _object({"proposal": proposal}),
        "write-research-artifact": _object({"output": output}),
    }
    calls = [_object({"call_id": text, "name": {"const": name}, "arguments": argument_schemas[name]}) for name in tools]
    return _object({"output": {"anyOf": [output, {"type": "null"}]},
                    "tool_requests": {"type": "array", "items": {"anyOf": calls} if calls else False, "maxItems": 4}})


def _messages(call: AgnoCall) -> list[dict[str, str]]:
    if call.execute_tools or call.memory_enabled or call.external_retrieval_enabled or call.system_instruction != SYSTEM_INSTRUCTION:
        raise AgentFault("tool-denied")
    # All source/model prose stays in this one untrusted user data envelope.
    payload = {"data": call.untrusted_user_data, "inert_tool_names": list(call.tool_names),
               "response_contract": _schema(call.tool_names), "execution_authorized": False}
    text = json.dumps(payload, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
    if len(text.encode("utf-8")) > 500_000:
        raise AgentFault("budget-exhausted")
    return [{"role": "system", "content": call.system_instruction}, {"role": "user", "content": text}]


class ExactAgnoTransport:
    """Implements both existing TokenMeter and AgnoTransport ports."""
    def __init__(self, *, policy: ModelPolicy, endpoints: tuple[EndpointPolicy, ...], http: HttpsTransport,
                 gate: SharedRateGate, admission: SharedAdmission, clock: Clock,
                 timestamps: ResearchClock, rights: Any, cancellation: Cancellation,
                 before_disclosure: Callable[[AgnoCall], None], model_use_requests: ModelUseRequests):
        policy.require()
        if model_use_requests is None:
            raise AdapterUnavailable("model-use-policy-unavailable")
        self.model_use_requests = model_use_requests
        selected = {e.endpoint_id: e for e in endpoints}
        self.tokenize, self.complete = selected[policy.tokenize_endpoint_id], selected[policy.completion_endpoint_id]
        if (self.tokenize.path != "/tokenize" or self.complete.path != "/v1/chat/completions"
                or self.tokenize.method != "POST" or self.complete.method != "POST"
                or self.tokenize.operation != "model-tokenize" or self.complete.operation != "model-completion"
                or self.tokenize.origin != self.complete.origin
                or self.tokenize.allowed_ip_addresses != self.complete.allowed_ip_addresses):
            raise AdapterUnavailable("model-endpoint-binding-unavailable")
        self.policy, self.http, self.gate = policy, http, gate
        self.admission, self.clock, self.timestamps, self.rights = admission, clock, timestamps, rights
        self.cancellation = cancellation
        self.before_disclosure = before_disclosure
        self._lock = threading.Lock()
        self._metered: dict[tuple[str, str, str], tuple[list[dict[str, str]], int]] = {}

    def _request(self, endpoint: EndpointPolicy, body: dict[str, Any], call: AgnoCall) -> bytes:
        with self.rights.operation(call.deadline_ns, self.cancellation):
            return self._request_scoped(endpoint, body, call)

    def _request_scoped(self, endpoint: EndpointPolicy, body: dict[str, Any], call: AgnoCall) -> bytes:
        deadline_ns = call.deadline_ns
        self.before_disclosure(call)
        if self.cancellation.cancelled() or self.clock.now_ns() >= deadline_ns:
            raise AgentFault("cancelled")
        if not self.gate.acquire(endpoint.provider, endpoint.policy_id, self.clock.now_ns(), 1):
            raise AgentFault("budget-exhausted")
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        admitted_request: dict[str, Any] | None = None
        dispatched = False

        def authorize_disclosure() -> None:
            nonlocal admitted_request, dispatched
            # This executes immediately before every actual network disclosure
            # and again on return. Original bytes/current review are rejoined.
            with self.rights.operation(deadline_ns, self.cancellation):
                self.before_disclosure(call)
                evidence = tuple(Evidence(**row) for row in call.untrusted_user_data["evidence"])
                refs = self.rights.model_evidence_refs(evidence)
                tokenize = endpoint.operation == "model-tokenize"
                candidate = self.model_use_requests.request(
                    operation=endpoint.operation, input_bytes=encoded, evidence_refs=refs,
                    deadline_ns=deadline_ns,
                    input_tokens=None if tokenize else call.max_total_tokens - call.max_output_tokens,
                    maximum_output_tokens=0 if tokenize else call.max_output_tokens,
                    maximum_cost_usd="0" if tokenize else call.max_cost_usd, tools=call.tool_names)
                if admitted_request is None:
                    admitted_request = candidate
                elif candidate != admitted_request:
                    raise AgentFault("rights-denied")
                proof = self.rights.authorize_model_use(request=admitted_request, input_bytes=encoded, deadline_ns=deadline_ns)
                if (proof.get("decision") != "allowed"
                        or proof.get("requestSha256") != admitted_request["requestSha256"]
                        or not dispatched and proof.get("externalDispatchAllowed") is not True):
                    raise AgentFault("rights-denied")
                dispatched = True

        response = self.http.request_until(HttpRequest(endpoint.provider, endpoint.operation, "POST", endpoint.origin, endpoint.path,
                                                       body=encoded, maximum_response_bytes=endpoint.maximum_response_bytes,
                                                       timeout_ms=endpoint.timeout_ms), deadline_ns=deadline_ns,
                                           authorize_disclosure=authorize_disclosure)
        if response.status_code != 200:
            if response.status_code in (429, 503):
                self.gate.cool_down(endpoint.provider, endpoint.policy_id,
                                    self.clock.now_ns() + min(response.retry_after_seconds or 60, 86400) * 1_000_000_000)
            raise AgentFault("model-unavailable")
        self.before_disclosure(call)
        if self.cancellation.cancelled() or self.clock.now_ns() >= deadline_ns:
            raise AgentFault("cancelled")
        return response.body

    def input_tokens(self, call: AgnoCall) -> int:
        if call.model_version != self.policy.model_version:
            raise AgentFault("model-unavailable")
        try:
            if any(version(package) != expected for package, expected in DEPENDENCIES.items()):
                raise AgentFault("model-unavailable")
        except Exception:
            raise AgentFault("model-unavailable") from None
        messages = _messages(call)
        body = {"model": self.policy.served_model, "messages": messages, **CHAT_OPTIONS,
                "tools": None, "return_token_strs": False}
        try:
            result = parse_json(self._request(self.tokenize, body, call), maximum_bytes=self.tokenize.maximum_response_bytes)
            count, ids = result.get("count"), result.get("tokens")
            if (not isinstance(ids, list) or type(count) is not int or count < 1 or count != len(ids)
                    or any(type(token) is not int or token < 0 for token in ids)
                    or type(result.get("max_model_len")) is not int
                    or result["max_model_len"] != self.policy.maximum_context_tokens
                    or call.max_total_tokens > self.policy.maximum_context_tokens):
                raise AgentFault("model-unavailable")
            key = (call.run_id, call.attempt_id, call.model_version)
            with self._lock:
                if key in self._metered or len(self._metered) >= 128:
                    raise AgentFault("model-unavailable")
                self._metered[key] = (messages, count)
            return count
        except AgentFault:
            raise
        except Exception:
            raise AgentFault("model-unavailable") from None

    def run(self, call: AgnoCall, *, cancellation: Cancellation) -> Mapping[str, Any]:
        with self._lock:
            measured = self._metered.pop((call.run_id, call.attempt_id, call.model_version), None)
        if measured is None or measured[0] != _messages(call) or call.max_output_tokens <= 0:
            raise AgentFault("model-unavailable")
        messages, count = measured
        if cancellation.cancelled() or count + call.max_output_tokens > min(call.max_total_tokens, self.policy.maximum_context_tokens):
            raise AgentFault("budget-exhausted")
        receipt = self.admission.reserve_model(run_id=call.run_id, attempt_id=call.attempt_id,
                                               model_policy_id=self.policy.policy_id, tokens=call.max_total_tokens,
                                               usd=call.max_cost_usd, deadline_ns=call.deadline_ns)
        if receipt is None:
            raise AgentFault("budget-exhausted")
        settled = False
        try:
            for package, expected in DEPENDENCIES.items():
                if version(package) != expected:
                    raise AgentFault("model-unavailable")
            import httpx
            from agno.models.message import Message
            from agno.models.openai import OpenAIChat
            owner = self
            schema = {"type": "json_schema", "json_schema": {"name": "vertex_advisory_v1", "schema": _schema(call.tool_names), "strict": True}}

            class HostTransport(httpx.BaseTransport):
                def handle_request(self, request: Any) -> Any:
                    if (str(request.url) != owner.complete.origin + owner.complete.path or request.method != "POST"
                            or len(request.content) > owner.complete.maximum_request_bytes):
                        raise AgentFault("model-unavailable")
                    body = parse_json(request.content, maximum_bytes=owner.complete.maximum_request_bytes)
                    if (body.get("model") != owner.policy.served_model or body.get("messages") != messages
                            or body.get("response_format") != schema or body.get("stream") is not False
                            or body.get("n") != 1 or body.get("tool_choice") != "none"
                            or body.get("tools") is not None or body.get("max_completion_tokens") != call.max_output_tokens
                            or any(body.get(key) != value for key, value in CHAT_OPTIONS.items())
                            or body.get("truncate_prompt_tokens") is not None):
                        raise AgentFault("model-unavailable")
                    # Ignore ALL SDK headers, including ambient account/auth fields.
                    data = owner._request(owner.complete, body, call)
                    return httpx.Response(200, headers={"Content-Type": "application/json"}, content=data, request=request)

            with httpx.Client(transport=HostTransport(), trust_env=False, follow_redirects=False,
                              timeout=self.complete.timeout_ms / 1000, proxy=None, mounts=None) as client:
                model = OpenAIChat(id=self.policy.served_model, api_key="vertex-host-injected",
                    organization="", base_url=self.complete.origin + "/v1",
                    client_params={"project": "", "webhook_secret": ""}, http_client=client,
                    timeout=self.complete.timeout_ms / 1000, max_retries=0, store=False,
                    max_completion_tokens=call.max_output_tokens, role_map={"system": "system", "user": "user", "assistant": "assistant", "tool": "tool"},
                    request_params={"stream": False, "n": 1, "tool_choice": "none",
                                    "extra_body": {**CHAT_OPTIONS, "truncate_prompt_tokens": None, "skip_special_tokens": True}})
                response = model.invoke([Message(**message) for message in messages], response_format=schema,
                                        tools=None, tool_choice="none")
            usage = response.usage
            inputs, outputs, total = usage.prompt_tokens, usage.completion_tokens, usage.total_tokens
            if (response.model != self.policy.served_model or any(type(n) is not int or n < 0 for n in (inputs, outputs, total))
                    or inputs != count or total != inputs + outputs or outputs > call.max_output_tokens
                    or total > call.max_total_tokens):
                raise AgentFault("model-unavailable")
            # The selected policy charges ALL prompt/output IDs at these rates.
            # Cache/reasoning details are subsets and never added again or guessed.
            units = (inputs * usd_units(self.policy.input_usd_per_million)
                     + outputs * usd_units(self.policy.output_usd_per_million) + 999_999) // 1_000_000
            cost = usd_text(units)
            if units > usd_units(call.max_cost_usd):
                raise AgentFault("budget-exhausted")
            self.admission.settle_model(receipt, tokens=total, usd=cost)
            settled = True
            if cancellation.cancelled() or self.clock.now_ns() >= call.deadline_ns:
                raise AgentFault("cancelled")
            if len(response.choices) != 1:
                raise AgentFault("invalid-model-response")
            choice = response.choices[0]
            message = choice.message
            if (choice.finish_reason != "stop" or getattr(message, "refusal", None)
                    or message.tool_calls or getattr(message, "function_call", None) or not isinstance(message.content, str)):
                raise AgentFault("invalid-model-response")
            parsed = parse_json(message.content.encode("utf-8"), maximum_bytes=500_000)
            if not isinstance(parsed, dict) or set(parsed) != {"output", "tool_requests"}:
                raise AgentFault("invalid-model-response")
            return {"run_id": call.run_id, "trace_id": call.trace_id, "attempt_id": call.attempt_id,
                    "model_version": call.model_version,
                    "usage": {"input_tokens": inputs, "output_tokens": outputs, "cost_usd": cost}, **parsed}
        except AgentFault:
            raise
        except Exception:
            raise AgentFault("model-unavailable") from None
        finally:
            if not settled:
                self.admission.settle_model(receipt, tokens=None, usd=None)


def create_model(**ports: Any) -> AgnoAdvisoryAdapter:
    bridge = ExactAgnoTransport(**ports)
    return AgnoAdvisoryAdapter(transport=bridge, meter=bridge, model_version=bridge.policy.model_version,
                               pricing=bridge.policy.pricing())


def invoke_native_evidence_once(*, endpoint: EndpointPolicy, policy: ModelPolicy,
                                input_bytes: bytes, send: Callable[[bytes], Any]) -> Any:
    """One SDK invocation through the existing HostTransport/HTTPS boundary.

    SDK serialization is an untrusted proposal. Only the exact independently
    materialized canonical bytes leave HostTransport, after structural equality;
    the caller's normal pre-HTTP guard still authorizes those actual wire bytes.
    No SDK tools are registered and its parsed response is never authority.
    """
    from .chat_inputs import canonical_chat_input_bytes
    for package, expected in DEPENDENCIES.items():
        if version(package) != expected:
            raise AdapterUnavailable("native-sdk-version-unavailable")
    body = parse_json(input_bytes, maximum_bytes=endpoint.maximum_request_bytes)
    if type(body) is not dict or canonical_chat_input_bytes(body) != input_bytes:
        raise AdapterUnavailable("native-input-noncanonical")
    import httpx
    from agno.models.message import Message
    from agno.models.openai import OpenAIChat

    calls = 0
    exchange = None
    # Pinned Agno _format_message omits None message fields. Validate precisely
    # that internal proposal (not arbitrary semantic JSON equality), then emit
    # the original authorized transcript with explicit assistant content:null.
    sdk_body = {**body, "messages": [{key: value for key, value in message.items() if value is not None}
                                    for message in body["messages"]]}
    sdk_bytes = canonical_chat_input_bytes(sdk_body)

    class HostTransport(httpx.BaseTransport):
        def handle_request(self, request: Any) -> Any:
            nonlocal calls, exchange
            if (calls != 0 or str(request.url) != endpoint.origin + endpoint.path
                    or request.method != "POST" or len(request.content) > endpoint.maximum_request_bytes):
                raise AdapterUnavailable("native-sdk-dispatch-denied")
            proposed = parse_json(request.content, maximum_bytes=endpoint.maximum_request_bytes)
            if canonical_chat_input_bytes(proposed) != sdk_bytes:
                raise AdapterUnavailable("native-sdk-input-drift")
            calls += 1
            # Drop SDK headers/auth and pass exactly the approved bytes to the
            # existing authenticated host transport. That transport owns both
            # before-send and after-response model-use proofs, not this bridge.
            exchange = send(input_bytes)
            if exchange.status_code != 200:
                raise AdapterUnavailable("native-provider-response-unavailable")
            return httpx.Response(exchange.status_code, headers={"Content-Type": "application/json"},
                                  content=exchange.body, request=request)

    params = {"stream": False, "n": 1, "tool_choice": body["tool_choice"],
              "extra_body": {**CHAT_OPTIONS, "truncate_prompt_tokens": None, "skip_special_tokens": True}}
    if "parallel_tool_calls" in body:
        params["parallel_tool_calls"] = False
    with httpx.Client(transport=HostTransport(), trust_env=False, follow_redirects=False,
                      timeout=endpoint.timeout_ms / 1000, proxy=None, mounts=None) as client:
        model = OpenAIChat(id=policy.served_model, api_key="vertex-host-injected",
            organization="", base_url=endpoint.origin + "/v1",
            client_params={"project": "", "webhook_secret": ""}, http_client=client,
            timeout=endpoint.timeout_ms / 1000, max_retries=0, store=False,
            max_completion_tokens=body["max_completion_tokens"],
            role_map={"system": "system", "user": "user", "assistant": "assistant", "tool": "tool"},
            request_params=params)
        # Agno logs exception strings and OpenAI debug logging includes request
        # bodies. Suppress only this synchronous private invoke's thread, without
        # mutating global levels or hiding unrelated worker diagnostics.
        import logging
        from agno.utils import log as agno_log
        thread_id = threading.get_ident()

        class PrivateInvokeLogFilter(logging.Filter):
            def filter(self, record: Any) -> bool:
                return record.thread != thread_id

        private_filter = PrivateInvokeLogFilter()
        loggers = {agno_log.agent_logger, agno_log.team_logger, agno_log.workflow_logger,
                   logging.getLogger("openai._base_client"), logging.getLogger("httpx")}
        for logger in loggers:
            logger.addFilter(private_filter)
        try:
            model.invoke([Message(**message) for message in body["messages"]],
                         response_format=body.get("response_format"), tools=body.get("tools"),
                         tool_choice=body["tool_choice"])
        finally:
            for logger in loggers:
                logger.removeFilter(private_filter)
    if calls != 1 or exchange is None:
        raise AdapterUnavailable("native-sdk-exchange-missing")
    return exchange
