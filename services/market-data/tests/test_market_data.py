"""Authored, unexecuted synthetic market regression cases; real contract conformance is separate."""
import unittest
from dataclasses import replace

from providers.boundary import Boundary, BoundaryError
from providers.ports import ProviderCapture, RightRequest, Unavailable
from providers.tests._fixtures import CodecSpy, FixedClock, NOW, RightsSpy, ValidatorSpy
from vertex_market_data.calendar import BarBinding, ExplicitSessionCalendar, Session
from vertex_market_data.normalization import BarWindow, FieldSemantics, MarketNormalizer, SourceContext
from vertex_market_data.service import DatasetPlanner, normalize_measurements


class MarketCases(unittest.TestCase):
    def setUp(self):
        self.codec, self.rights, self.clock = CodecSpy(), RightsSpy(), FixedClock()
        self.boundary = Boundary(ValidatorSpy(), self.codec)
        self.start = "2026-09-22T14:59:00Z"
        self.end = "2026-09-22T15:00:00Z"
        window = BarWindow(self.start, self.end, self.end, "1m")
        self.calendar = ExplicitSessionCalendar(calendar_id="TESTEX:2026", version="2026", sessions=(Session("test-session", "2026-09-22T13:30:00Z", "2026-09-22T20:00:00Z"),),
            bindings=(BarBinding("financialdatasets", "time", "start", "1m", "synthetic fixture timestamp convention", (window,)),))
        self.normalizer = MarketNormalizer(boundary=self.boundary, clock=self.clock, rights=self.rights, calendar=self.calendar)
        self.context = SourceContext("TEST:equity", "USD", "TESTEX:2026", "America/New_York", "snapshot:test", "source:test",
            self.end, "vintage:test", 1000, "USD", "shares", "unadjusted", "synthetic", "Synthetic authored test input")
        self.row = {"time": self.start, "open": "1.5", "high": "2", "low": "1", "close": "1.75", "volume": "100"}

    def capture(self, payload, operation="equity-bars"):
        data = self.codec.encode(payload)
        rights = self.rights.decide(RightRequest("financialdatasets", "test-policy", operation, NOW))
        return ProviderCapture("financialdatasets", operation, NOW, self.boundary.content(data, "application/json"), data, rights,
                               "synthetic source, not live provider evidence", ("Synthetic only.",))

    def test_bars_have_exact_values_source_calendar_and_synthetic_label(self):
        capture = self.capture({"prices": [self.row]})
        result = self.normalizer.candles(capture, [self.row], self.context, interval="1m")
        value = result[0].decode()
        self.assertEqual(value["open"], "1.5")
        self.assertEqual(value["source"]["dataKind"], "synthetic")
        self.assertEqual(value["source"]["identity"]["contentHash"], capture.content.digest)
        self.assertEqual(value["source"]["freshness"]["observedAt"], self.end)
        self.assertEqual(value["source"]["freshness"]["status"], "fresh")

    def test_missing_ohlcv_and_fabricated_rows_reject(self):
        incomplete = {key: value for key, value in self.row.items() if key != "volume"}
        capture = self.capture({"prices": [incomplete]})
        self.assertEqual(self.normalizer.candles(capture, [incomplete], self.context, interval="1m").reason, "missing-ohlcv-field")
        self.assertEqual(self.normalizer.candles(capture, [self.row], self.context, interval="1m").reason, "bar-rows-not-bound-to-capture")

    def test_unknown_calendar_and_future_or_incomplete_bars_reject(self):
        capture = self.capture({"prices": [self.row]})
        context = replace(self.context, calendar="UNKNOWN")
        self.assertIsInstance(self.normalizer.candles(capture, [self.row], context, interval="1m"), Unavailable)
        context = replace(self.context, as_of_at=self.start)
        self.assertIsInstance(self.normalizer.candles(capture, [self.row], context, interval="1m"), Unavailable)
        normalizer = MarketNormalizer(boundary=self.boundary, clock=self.clock, rights=self.rights, calendar=None)
        self.assertEqual(normalizer.candles(capture, [self.row], self.context, interval="1m").reason, "exchange-calendar-unavailable")

    def test_quote_cannot_be_fabricated_from_last_price(self):
        row = {"last": "200", "time": self.end}
        capture = self.capture({"data": row}, "equity-snapshot")
        fields = {"bid": "bid", "ask": "ask", "bidSize": "bidSize", "askSize": "askSize", "lastPrice": "last", "sourceTimestamp": "time"}
        self.assertEqual(self.normalizer.quote(capture, row, self.context, fields=fields, source_reference="synthetic mapping").reason, "quote-bid-ask-size-unavailable")

    def test_unknown_trade_side_and_profile_precision_preserved(self):
        a = {"time": self.start, "price": "1.5", "quantity": "9007199254740993.123456789123456789", "sequence": 1}
        b = {"time": self.start, "price": "1.5", "quantity": "0.000000000000000001", "sequence": 2}
        capture = self.capture({"data": [a, b]}, "option-flow")
        semantics = FieldSemantics("time", "price", "quantity", "Synthetic actual-print fields; no side observation")
        trades = tuple(self.normalizer.trade_flow(capture, row, self.context, semantics) for row in (a, b))
        self.assertTrue(all(trade.decode()["aggressor"] == "unknown" for trade in trades))
        result = self.normalizer.volume_profile(trades, self.context, profile_id="profile:test", start_at=self.start, end_at=self.end, bins=(("1", "2"),))
        row = result.decode()["bins"][0]
        self.assertEqual(row["unknownVolume"], "9007199254740993.12345678912345679")
        self.assertEqual(row["buyVolume"], "0")
        self.assertEqual(row["sellVolume"], "0")
        duplicate = self.normalizer.volume_profile((trades[0], trades[0]), self.context, profile_id="profile:test", start_at=self.start, end_at=self.end, bins=(("1", "2"),))
        self.assertEqual(duplicate.reason, "profile-duplicate-trade")

    def test_dataset_manifest_preserves_raw_source_and_canonical_content_digests(self):
        capture = self.capture({"prices": [self.row]})
        records = self.normalizer.candles(capture, [self.row], self.context, interval="1m")
        planner = DatasetPlanner(boundary=self.boundary, clock=self.clock, rights=self.rights)
        plan = planner.plan(dataset_id="dataset:test", storage_ref="artifact:test", captures=(capture,), records=records, contexts=(self.context,),
                            start_at=self.start, end_at=self.end, as_of_at=self.end, retention_policy="retain-test", require_point_in_time=True)
        manifest = plan.manifest.decode()
        self.assertEqual(manifest["contentHash"], plan.content[0].digest)
        self.assertEqual(manifest["sources"][0]["contentHash"], capture.content.digest)
        self.assertNotEqual(manifest["contentHash"], capture.content.digest)
        self.assertEqual(manifest["calendar"], self.context.calendar)
        self.assertEqual(manifest["dataVintageId"], "vintage:test")
        self.assertEqual(plan.source_digests, (capture.content.digest,))

    def test_missing_fundamental_and_missing_vintage_are_not_zero(self):
        rows = normalize_measurements({"eps": "1.01"}, field_units=(("eps", "USD/share"), ("revenue", "USD")),
                                      fiscal_period="2026-Q2", published_at=None, vintage_id=None, as_of_at=NOW)
        self.assertEqual(rows[0].availability, "unknown-vintage")
        self.assertEqual(rows[1].availability, "missing")
        self.assertIsNone(rows[1].value)
        with self.assertRaises(BoundaryError):
            normalize_measurements({"eps": "1"}, field_units=(("eps", "USD/share"),), fiscal_period=None,
                                   published_at="2026-09-23T00:00:00Z", vintage_id="v2", as_of_at=NOW)
