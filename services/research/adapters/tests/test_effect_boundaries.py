"""Source-authored regressions. NOT executed during implementation wave."""
from dataclasses import replace
from types import SimpleNamespace

import pytest

from adapters.admission import AdmissionLimit, HostAdmissionOwner
from adapters.decode_worker import _csv, dispatch
from adapters.http import HttpsTransport, SharedRateGate
from adapters.ports import AdapterUnavailable, EndpointPolicy, ResearchClock
from providers.ports import HttpRequest


class Clock:
    ns = 1_800_000_000_000_000_000
    mono = 100.0

    def now_ns(self):
        return self.ns

    def monotonic(self):
        return self.mono

    def advance(self, seconds):
        self.ns += seconds * 1_000_000_000
        self.mono += seconds


def policy(**values):
    original = EndpointPolicy("endpoint", "vendor", "bars", "https://api.example.com", "/bars", "GET",
        "credential-ref", "Authorization", "Bearer ", ("ticker",), "rights-policy", "pinned-source",
        allowed_ip_addresses=("93.184.216.34",))
    return replace(original, **values)


def budget(clock):
    fence = SimpleNamespace(is_current=lambda: True)
    owner = HostAdmissionOwner((AdmissionLimit("vendor", "rights-policy", 60, 2, 100, "1"),), clock=clock, owner_fence=fence)
    return owner


def test_new_host_cannot_reset_window_by_restart():
    clock = Clock()
    owner = budget(clock)
    assert owner.acquire("vendor", "rights-policy", clock.now_ns(), 1) is False
    clock.advance(60)
    assert owner.acquire("vendor", "rights-policy", clock.now_ns(), 1) is True
    assert owner.acquire("vendor", "rights-policy", clock.now_ns(), 1) is True
    assert owner.acquire("vendor", "rights-policy", clock.now_ns(), 1) is False
    restarted = budget(clock)
    assert restarted.acquire("vendor", "rights-policy", clock.now_ns(), 1) is False


def test_unknown_model_usage_keeps_full_charge_and_duplicate_cannot_reclaim():
    clock = Clock()
    owner = budget(clock)
    clock.advance(60)
    request = dict(run_id="run", attempt_id="attempt", model_policy_id="rights-policy", tokens=100, usd="1", deadline_ns=clock.ns + 1000)
    receipt = owner.reserve_model(**request)
    assert receipt is not None
    owner.settle_model(receipt, tokens=None, usd=None)
    assert owner.reserve_model(**request) is None
    assert owner.reserve_model(**{**request, "attempt_id": "other"}) is None


def test_owner_fence_and_clock_regression_fail_closed():
    clock = Clock()
    owner = budget(clock)
    clock.advance(60)
    owner.owner_fence = SimpleNamespace(is_current=lambda: False)
    with pytest.raises(AdapterUnavailable, match="owner-unavailable"):
        owner.acquire("vendor", "rights-policy", clock.ns, 1)


def test_gate_is_single_use_not_an_independent_window():
    clock = Clock()
    owner = budget(clock)
    clock.advance(60)
    gate = SharedRateGate(owner, clock)
    assert gate.acquire("vendor", "rights-policy", clock.ns, 1)
    gate.consume(policy())
    with pytest.raises(AdapterUnavailable, match="shared-admission-required"):
        gate.consume(policy())


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "224.0.0.1"])
def test_endpoint_never_routes_to_local_or_metadata_addresses(address):
    with pytest.raises(AdapterUnavailable):
        HttpsTransport._validate_policy(policy(allowed_ip_addresses=(address,)))


@pytest.mark.parametrize("changes", [{"origin": "http://api.example.com"}, {"origin": "https://user:pass@api.example.com"},
    {"origin": "https://api.example.com/"}, {"path": "//other.example"}, {"path": "/%2e%2e/internal"},
    {"credential_header": "Host"}, {"allowed_ip_addresses": ()}])
def test_endpoint_policy_rejects_url_and_header_escape(changes):
    with pytest.raises(AdapterUnavailable):
        HttpsTransport._validate_policy(policy(**changes))


def test_transport_drops_error_bodies_and_never_follows_redirect(monkeypatch):
    clock = Clock()
    owner = budget(clock)
    clock.advance(60)
    gate = SharedRateGate(owner, clock)
    observed = []
    class Connection:
        sock = None
        def __init__(self, *args):
            observed.append(args)
        def connect(self):
            pass
        def request(self, *args, **kwargs):
            observed.append((args, kwargs))
        def getresponse(self):
            return SimpleNamespace(status=302)
        def close(self):
            pass
    monkeypatch.setattr("adapters.http._PinnedHTTPSConnection", Connection)
    transport = HttpsTransport(policies=(policy(),), secrets=SimpleNamespace(resolve=lambda *a, **k: "test-only-placeholder"),
        budget=gate, clock=clock, timestamps=ResearchClock(clock, None), cancellation=SimpleNamespace(cancelled=lambda: False),
        deadline_ns=clock.ns + 20_000_000_000, authorize_endpoint=lambda endpoint: None)
    assert gate.acquire("vendor", "rights-policy", clock.ns, 1)
    with pytest.raises(AdapterUnavailable, match="redirect-rejected"):
        transport.request(HttpRequest("vendor", "bars", "GET", "https://api.example.com", "/bars"))
    assert len(observed) == 2


def test_csv_preserves_exact_financial_strings_and_source_columns():
    assert _csv(b"ticker,price,quantity\nSPY,500.123456789012345678,1\n", 10, 8) == [
        {"ticker": "SPY", "price": "500.123456789012345678", "quantity": "1"}]


@pytest.mark.parametrize("data", [b"a,a\n1,2\n", b"a,b\n1\n", b"a\n1\n2\n", b"a\n\x00\n"])
def test_csv_rejects_duplicate_ragged_oversize_and_nul(data):
    with pytest.raises(Exception):
        _csv(data, 1, 8)


def test_decoder_is_fixed_opcode_not_arbitrary_module_or_path():
    assert dispatch("os.system", {"path": "/etc/passwd"}) == {"status": "unavailable", "result": None}
    assert dispatch("adapters.decode-csv", {"contentBase64": "%%%", "maximumRows": 1, "maximumColumns": 1}) == {"status": "unavailable", "result": None}


def test_optional_parser_version_mismatch_is_unavailable_without_import(monkeypatch):
    monkeypatch.setattr("adapters.decode_worker.version", lambda name: "0.0.0")
    assert dispatch("adapters.decode-pdf", {"contentBase64": "JVBERi0xLjUK", "maximumPages": 1, "maximumCharacters": 100})["status"] == "unavailable"
