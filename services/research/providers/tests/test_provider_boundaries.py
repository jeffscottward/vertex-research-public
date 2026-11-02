"""Authored synthetic regressions; deliberately not executed during build-first wave."""
import unittest
from dataclasses import replace
from decimal import Decimal

from providers.boundary import Boundary, BoundaryError, epoch_ns, exact_decimal, parse_json, raw_sha256
from providers.client import WindowBudget
from providers.financialdatasets import FinancialDatasets
from providers.ports import HttpResponse, ProviderConfig, Unavailable
from providers.quantdata import QuantData, canonical_bar, rows_from_data
from providers.quantpad import QuantPadInputBoundary, missing_macro_input
from providers.tests._fixtures import CodecSpy, FixedClock, NOW, RightsSpy, TransportSpy, ValidatorSpy


class ProviderBoundaryCases(unittest.TestCase):
    def setUp(self):
        self.codec = CodecSpy()
        self.validator = ValidatorSpy()
        self.boundary = Boundary(self.validator, self.codec)
        self.rights = RightsSpy()
        self.transport = TransportSpy(HttpResponse(200, b'{"prices":[]}', NOW))
        self.budget = WindowBudget(3, 60_000_000_000)

    def client(self, enabled=False, boundary=None):
        return FinancialDatasets(config=ProviderConfig("financialdatasets", enabled=enabled, policy_id="test-policy"),
            boundary=boundary or self.boundary, clock=FixedClock(), rights=self.rights, transport=self.transport, budget=self.budget)

    def test_decimal_exactness_and_missing_not_zero(self):
        self.assertEqual(exact_decimal("9007199254740993.123456789123456789"), "9007199254740993.123456789123456789")
        self.assertEqual(exact_decimal("1e-18"), "0.000000000000000001")
        self.assertEqual(exact_decimal(Decimal("10.500")), "10.5")
        for value in (None, True, 1.5, "1e-19", "NaN", "Infinity", "1e99999999"):
            with self.subTest(value=value), self.assertRaises(BoundaryError):
                exact_decimal(value)

    def test_nanosecond_and_year_zero_safe(self):
        self.assertEqual(epoch_ns("2026-09-22T15:00:00.123456789Z") - epoch_ns("2026-09-22T15:00:00.123456788Z"), 1)
        self.assertEqual(epoch_ns("2026-09-22T16:00:00+01:00"), epoch_ns("2026-09-22T15:00:00Z"))
        self.assertLess(epoch_ns("0000-02-29T00:00:00Z"), 0)
        for value in ("2026-02-29T00:00:00Z", "2026-09-22", "2026-09-22T00:00:00.1234567890Z"):
            with self.assertRaises(BoundaryError):
                epoch_ns(value)

    def test_bounded_json_rejects_duplicates_nonfinite_and_depth(self):
        self.assertEqual(parse_json(b'{"value":9007199254740993.25}')["value"], "9007199254740993.25")
        for payload in (b'{"a":1,"a":2}', b'{"a":NaN}', b'"\xff"'):
            with self.assertRaises(BoundaryError):
                parse_json(payload)
        with self.assertRaises(BoundaryError):
            parse_json(b'[[[0]]]', maximum_depth=1)
        with self.assertRaises(BoundaryError):
            parse_json(b'{}', maximum_bytes=1)

    def test_no_authoritative_fallback_or_truthy_validation(self):
        for validator in (None, ValidatorSpy(1), ValidatorSpy(False), ValidatorSpy({"success": True})):
            with self.assertRaises(BoundaryError):
                Boundary(validator, self.codec).record("Quote", {"schemaVersion": "1.0.0"})
        with self.assertRaises(BoundaryError):
            Boundary(self.validator, None).record("Quote", {})

    def test_raw_hash_and_canonical_identity_are_distinct(self):
        content = self.boundary.content(b"text", "text/plain")
        self.assertEqual(content.digest, raw_sha256(b"text"))
        self.assertNotEqual(content.digest, self.codec.digest("text"))
        value = {"schemaVersion": "1.0.0", "a": ["original"]}
        record = self.boundary.record("SyntheticTestOnly", value)
        value["a"][0] = "changed"
        self.assertEqual(record.decode()["a"], ["original"])
        decoded = record.decode()
        decoded["a"].append("changed")
        self.assertEqual(record.decode()["a"], ["original"])

    def test_default_disabled_and_denied_rights_never_call_transport(self):
        client = self.client()
        plan = client.request_plan("company-facts", "AAPL")
        self.assertEqual(client.client.capture(plan).reason, "disabled")
        self.rights.denied.add("financialdatasets")
        self.assertIsInstance(self.client(True).client.capture(plan), Unavailable)
        self.assertEqual(self.transport.calls, [])

    def test_endpoint_request_and_shape_source_backed(self):
        client = self.client(True)
        plan = client.request_plan("equity-bars", "aapl", start_date="2026-09-01", end_date="2026-09-21", interval="day")
        self.assertEqual(plan.requests[0].path, "/prices")
        self.assertFalse(plan.complete)
        capture = client.client.capture(plan)
        self.assertEqual(client.records(capture), [])
        self.assertEqual(capture.content.data, b'{"prices":[]}')
        self.assertIsInstance(client.request_plan("news", "AAPL"), Unavailable)

    def test_429_cooldown_no_automatic_retry(self):
        self.transport.response = HttpResponse(429, b"do not expose provider detail", NOW, 120)
        client = self.client(True)
        plan = client.request_plan("company-facts", "AAPL")
        self.assertEqual(client.client.capture(plan).reason, "rate-limited")
        self.assertEqual(client.client.capture(plan).reason, "rate-budget-or-cooldown")
        self.assertEqual(len(self.transport.calls), 1)

    def test_unknown_pagination_and_redirect_are_not_followed(self):
        client = self.client(True)
        plan = client.request_plan("company-facts", "AAPL")
        self.transport.response = HttpResponse(200, b'{"next_url":"https://host.invalid/private"}', NOW)
        self.assertEqual(client.client.capture(plan).reason, "unsupported-pagination")
        self.transport.response = HttpResponse(302, b"", NOW)
        self.assertEqual(client.client.capture(plan).reason, "provider-unavailable")
        self.assertEqual(len(self.transport.calls), 2)

    def test_budget_refuses_clock_regression(self):
        self.assertTrue(self.budget.acquire("p", "policy", 100, 1))
        self.assertFalse(self.budget.acquire("p", "policy", 99, 1))

    def test_quantdata_missing_and_conflicting_aliases_reject(self):
        with self.assertRaises(BoundaryError):
            rows_from_data(None, 10)
        with self.assertRaises(BoundaryError):
            canonical_bar({"open": "1", "openPrice": "2"})
        self.assertEqual(canonical_bar({"openPrice": "1.50"})["open"], "1.50")
        quant = QuantData(config=ProviderConfig("quantdata"), boundary=self.boundary, clock=FixedClock(), rights=self.rights, transport=None, budget=None)
        self.assertEqual(quant.request_plan("option-price", "SPY").reason, "invalid-request")
        plan = quant.request_plan("option-price", "SPY", expiration_date="2026-10-16", strike="123.125000000000000001", contract_type="CALL")
        self.assertIn(b'"strikePrice":123.125000000000000001', plan.requests[0].body)
        self.assertNotIn(b'"strikePrice":"', plan.requests[0].body)
        self.assertEqual(quant.request_plan("dark-pool", "SPY").reason, "unsupported-capability")

    def test_missing_macro_and_quantpad_are_explicit(self):
        self.assertEqual(missing_macro_input().reason, "macro-source-links-unavailable")
        adapter = QuantPadInputBoundary(boundary=self.boundary, clock=FixedClock(), rights=None, decoder=None)
        self.assertFalse(adapter.enabled)
