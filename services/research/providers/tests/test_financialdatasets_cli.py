"""Financial Datasets research CLI: fake transport only. No network, key or broker."""
import io
import json
import tempfile
import unittest
from pathlib import Path

from providers.financialdatasets_cli import EXIT_GUARD, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE, UrllibTransport, main
from providers.ports import HttpRequest, HttpResponse
from providers.tests._fixtures import FixedClock, NOW

KEY = "fdtestkey-0123456789abcdef-NEVER-PRINT"


class FakeTransport:
    """Returns one scripted response per call and records the requests."""

    def __init__(self, status=200, body=b"{}", retry_after=None):
        self.status, self.body, self.retry_after = status, body, retry_after
        self.requests, self.keys = [], []
        self.calls, self.last_status, self.last_retry_after = 0, None, None

    def factory(self, key, clock):
        self.keys.append(key)
        return self

    def request(self, request):
        self.requests.append(request)
        self.calls += 1
        self.last_status, self.last_retry_after = self.status, self.retry_after
        return HttpResponse(self.status, self.body, NOW, self.retry_after)


class FakeOpener:
    def __init__(self):
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        raise AssertionError("unit tests never reach the network")


class FinancialDatasetsCliCases(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.private = Path(self.tmp.name) / "private" / "fd"

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, argv, transport=None, environ=None):
        transport = transport or FakeTransport()
        out, err = io.StringIO(), io.StringIO()
        env = {"FINANCIAL_DATASETS_API_KEY": KEY} if environ is None else environ
        code = main(argv, environ=env, transport_factory=transport.factory, clock=FixedClock(), stdout=out, stderr=err)
        return code, out.getvalue(), err.getvalue(), transport

    def assert_no_key(self, *texts):
        for text in texts:
            self.assertNotIn(KEY, text)

    def test_company_facts_request_shape_and_envelope(self):
        body = b'{"company_facts":{"ticker":"AAPL","name":"Apple Inc.","market_cap":3500000000000.5}}'
        code, out, err, fake = self.run_cli(["company-facts", "--ticker", "aapl"], FakeTransport(body=body))
        self.assertEqual(code, EXIT_OK, err)
        request = fake.requests[0]
        self.assertEqual((request.method, request.origin, request.path, request.query),
                         ("GET", "https://api.financialdatasets.ai", "/company/facts", (("ticker", "AAPL"),)))
        result = json.loads(out)
        self.assertEqual((result["source"], result["endpoint"], result["ticker"], result["fetched_at"]),
                         ("financialdatasets", "company-facts", "AAPL", NOW))
        self.assertEqual(result["rights"]["mode"], "research-only")
        self.assertEqual(result["record_count"], 1)
        self.assertEqual(result["payload"]["market_cap"], "3500000000000.5")  # exact decimal text, not float
        self.assertEqual(result["age_seconds"], 0)
        self.assertEqual(fake.keys, [KEY])
        self.assert_no_key(out, err)
        self.assertNotIn("order", json.dumps(sorted(result)))

    def test_metrics_statements_and_prices_request_shapes(self):
        cases = [
            (["financial-metrics", "--ticker", "MSFT"], b'{"snapshot":{"ticker":"MSFT"}}',
             "/financial-metrics/snapshot", (("ticker", "MSFT"),), 1),
            (["financial-statements", "--ticker", "MSFT", "--period", "quarterly", "--limit", "2"],
             b'{"financials":{"income_statements":[{},{}],"balance_sheets":[{},{}],"cash_flow_statements":[{}]}}',
             "/financials", (("ticker", "MSFT"), ("period", "quarterly"), ("limit", "2")), 5),
            (["prices", "--ticker", "MSFT", "--days", "5"], b'{"prices":[{"close":"1.5"},{"close":"2"}],"next_page_url":null}',
             "/prices", (("ticker", "MSFT"), ("start_date", "2026-09-18"), ("end_date", "2026-09-22"), ("interval", "day")), 2),
            (["prices", "--ticker", "MSFT", "--start-date", "2026-09-01", "--end-date", "2026-09-05"], b'{"prices":[]}',
             "/prices", (("ticker", "MSFT"), ("start_date", "2026-09-01"), ("end_date", "2026-09-05"), ("interval", "day")), 0),
        ]
        for argv, body, path, query, count in cases:
            with self.subTest(argv=argv):
                code, out, err, fake = self.run_cli(argv, FakeTransport(body=body))
                self.assertEqual(code, EXIT_OK, err)
                self.assertEqual(len(fake.requests), 1)
                self.assertEqual((fake.requests[0].path, fake.requests[0].query), (path, query))
                self.assertEqual(json.loads(out)["record_count"], count)
                self.assert_no_key(out, err)

    def test_missing_key_makes_no_request(self):
        for environ in ({}, {"FINANCIAL_DATASETS_API_KEY": "  "}):
            code, out, err, fake = self.run_cli(["company-facts", "--ticker", "AAPL"], environ=environ)
            self.assertEqual(code, EXIT_USAGE)
            self.assertIn("missing API key", err)
            self.assertIn("FINANCIAL_DATASETS_API_KEY", err)
            self.assertEqual((out, fake.keys, fake.requests), ("", [], []))

    def test_alias_key_and_base_url_override(self):
        environ = {"FINANCIALDATASETS_API_KEY": KEY, "FINANCIAL_DATASETS_API_BASE_URL": "https://fd.example.test/"}
        code, out, err, fake = self.run_cli(["company-facts", "--ticker", "AAPL"],
                                            FakeTransport(body=b'{"company_facts":{"ticker":"AAPL"}}'), environ)
        self.assertEqual(code, EXIT_OK, err)
        self.assertEqual(fake.keys, [KEY])
        self.assertEqual(fake.requests[0].origin, "https://fd.example.test")
        for bad in ("http://fd.example.test", "https://fd.example.test/v1", "https://user:pw@fd.example.test", "https://fd.example.test?x=1"):
            with self.subTest(base=bad):
                code, out, err, fake = self.run_cli(["company-facts", "--ticker", "AAPL"],
                                                    environ={"FINANCIAL_DATASETS_API_KEY": KEY, "FINANCIAL_DATASETS_API_BASE_URL": bad})
                self.assertEqual(code, EXIT_USAGE)
                self.assertEqual(fake.requests, [])

    def test_429_reports_retry_after_and_never_retries(self):
        fake = FakeTransport(429, b'{"error":"slow down"}', retry_after=120)
        code, out, err, _ = self.run_cli(["prices", "--ticker", "AAPL"], fake)
        self.assertEqual(code, EXIT_UNAVAILABLE)
        result = json.loads(out)
        self.assertEqual((result["reason"], result["http_status"], result["retry_after_seconds"], result["requests_made"]),
                         ("rate-limited", 429, 120, 1))
        self.assertFalse(result["automatic_retry"])
        self.assertNotIn("slow down", out)
        self.assertEqual(len(fake.requests), 1)

    def test_access_denied_and_payment_required_are_reported(self):
        for status, reason in ((401, "provider-access-denied"), (403, "provider-access-denied"), (402, "provider-unavailable")):
            with self.subTest(status=status):
                code, out, err, _ = self.run_cli(["company-facts", "--ticker", "AAPL"], FakeTransport(status, KEY.encode()))
                self.assertEqual(code, EXIT_UNAVAILABLE)
                result = json.loads(out)
                self.assertEqual((result["reason"], result["http_status"]), (reason, status))
                self.assert_no_key(out, err)

    def test_key_echoed_by_provider_is_blocked(self):
        body = json.dumps({"company_facts": {"name": KEY}}).encode()
        code, out, err, _ = self.run_cli(["company-facts", "--ticker", "AAPL"], FakeTransport(body=body))
        self.assertEqual(code, EXIT_GUARD)
        self.assertIn("output blocked", err)
        self.assert_no_key(out, err)

    def test_pagination_is_not_followed(self):
        body = b'{"prices":[{"close":"1"}],"next_page_url":"https://api.financialdatasets.ai/prices?cursor=x"}'
        code, out, err, fake = self.run_cli(["prices", "--ticker", "AAPL", "--days", "30"], FakeTransport(body=body))
        self.assertEqual(code, EXIT_UNAVAILABLE)
        self.assertEqual(json.loads(out)["reason"], "unsupported-pagination")
        self.assertEqual(len(fake.requests), 1)

    def test_out_file_only_inside_private(self):
        target = self.private / "aapl.json"
        code, out, err, _ = self.run_cli(["company-facts", "--ticker", "AAPL", "--out", str(target)],
                                         FakeTransport(body=b'{"company_facts":{"ticker":"AAPL"}}'))
        self.assertEqual(code, EXIT_OK, err)
        self.assertEqual(json.loads(target.read_text())["payload"], {"ticker": "AAPL"})
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        summary = json.loads(out)
        self.assertEqual((summary["record_count"], summary["out"]), (1, str(target.resolve())))
        self.assertNotIn("payload", summary)
        self.assert_no_key(out, err, target.read_text())
        outside = Path(self.tmp.name) / "public" / "aapl.json"
        code, out, err, fake = self.run_cli(["company-facts", "--ticker", "AAPL", "--out", str(outside)])
        self.assertEqual(code, EXIT_USAGE)
        self.assertEqual(fake.requests, [])
        self.assertFalse(outside.exists())

    def test_invalid_arguments_make_no_request(self):
        for argv in (["financial-statements", "--ticker", "AAPL", "--limit", "11"],
                     ["prices", "--ticker", "AAPL", "--days", "0"],
                     ["prices", "--ticker", "AAPL", "--start-date", "2026-09-10", "--end-date", "2026-09-01"],
                     ["prices", "--ticker", "AAPL", "--end-date", "09/01/2026"],
                     ["company-facts", "--ticker", "AAPL;rm"],
                     ["quotes", "--ticker", "AAPL"],
                     ["company-facts", "--ticker", "AAPL", "--rights-mode", "storage"]):
            with self.subTest(argv=argv):
                code, out, err, fake = self.run_cli(argv)
                self.assertEqual(code, EXIT_USAGE)
                self.assertEqual(fake.requests, [])
                self.assert_no_key(out, err)

    def test_urllib_transport_sends_key_only_in_header(self):
        opener = FakeOpener()
        transport = UrllibTransport(KEY, FixedClock(), opener=opener)
        self.assertNotIn(KEY, repr(transport))
        prepared = transport.build(HttpRequest("financialdatasets", "equity-bars", "GET", "https://api.financialdatasets.ai", "/prices",
                                               (("ticker", "AAPL"), ("interval", "day"))))
        self.assertEqual(prepared.full_url, "https://api.financialdatasets.ai/prices?ticker=AAPL&interval=day")
        self.assertEqual(prepared.get_header("X-api-key"), KEY)
        self.assertNotIn(KEY, prepared.full_url)
        self.assertEqual(prepared.get_method(), "GET")


if __name__ == "__main__":
    unittest.main()
