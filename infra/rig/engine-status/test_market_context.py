import json
import os
import tempfile
import unittest
from unittest import mock

import market_context as mc

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "market-context.v1.json")

GEX = {
    "updatedAt": "2026-11-02T20:53:00.612929+00:00",
    "label": "estimate from QuantData OI+IV",
    "oiSession": "2026-10-30",
    "index": {
        "SPY": {
            "spot": 752.69,
            "status": "ok",
            "netGex": -12500453319,
            "regime": "amplified",
            "flip": 768.49,
            "spotVsFlip": "below",
            "callWall": 752.0,
            "putWall": 750.0,
            "netVex": 1,
            "netChex": 2,
            "netDex": -3,
            "concentration": {"text": "levels may fade after 2026-11-04"},
            "zeroDte": {"status": "ok", "expiry": "2026-11-02", "netGex": -5, "flip": 756.77,
                        "callWall": 752.0, "putWall": 753.0, "byStrike": [{"strike": 1}]},
            "regimeText": ["GEX negative", 7, "", "GEX  negative"],
        },
        "QQQ": {"spot": 681.65, "status": "ok", "zeroDte": {"status": "error"}},
        "NVDA": {"spot": 1.0, "status": "ok"},
    },
    "symbols": [{"symbol": "EWG", "position": -435}],
    "strategyFit": [{"area": "Graded stops"}],
}

MACRO = {
    "updatedAt": "2026-11-03T07:17:08+00:00",
    "seriesOrder": ["DGS2", "NOPE", "bad id!", "DGS2", 7],
    "series": {
        "DGS2": {"id": "DGS2", "label": "2-year Treasury yield", "group": "rates", "units": "%",
                 "status": "ok", "stale": False, "value": 4.56, "date": "2026-10-30",
                 "change1d": -0.05, "pct1y": 86.4, "source": "FRED",
                 "sourceUrl": "https://fred.stlouisfed.org/series/DGS2", "error": None},
        "bad id!": {"id": "bad id!"},
    },
    "regimes": {"curve": {"label": "normal", "rule": "10y-2y < 0 inverted"}, "x": {"rule": "no label"},
                "bad\n": {"label": "trailing newline id"}},
    "events": {"upcoming": [{"date": "2026-11-06", "time": "08:30", "summary": "Employment Situation"},
                            {"date": "soon", "summary": "bad"},
                            {"date": "2026-02-30", "summary": "no such day"},
                            {"date": "2026-11-07\n", "summary": "trailing newline"},
                            {"date": "2026-11-06", "time": "08:30", "summary": "Employment Situation"}]},
    "relevance": [{"appliesTo": ["re-entry buys"]}],
}

NEWS = {
    "updatedAt": "2026-11-03T07:05:00+00:00",
    "themes": [
        {"id": "fed_rates", "label": "Fed / rates", "kind": "macro", "symbols": ["SPY"],
         "linkedHeld": ["SPY"], "count24h": 5, "count72h": 11, "sentiment24h": -0.09, "shock": False},
        {"id": "memory", "label": "Chinese DRAM", "kind": "competitor_sector", "symbols": ["MU"]},
        {"id": "fed_rates", "label": "Fed again", "kind": "macro"},
    ],
    "symbols": [{"symbol": "SPY", "groups": ["held"]}],
    "universeSource": {"source": "ibkr-monitor snapshot"},
    "items": [
        {"title": "Fed holds", "publisher": "Reuters", "url": "https://example.test/a",
         "published": "2026-11-03T06:00:00+00:00", "themes": ["fed_rates"], "links": {"SPY": "x"},
         "scores": {"SPY": {"relation": "company", "sentiment": -0.5, "materiality": "low"}}},
        {"title": "Oil jumps", "publisher": "CNBC", "url": "https://example.test/b",
         "published": "2026-11-03T07:00:00+00:00", "themes": [],
         "scores": {"XLE": {"relation": "macro", "sentiment": 0.4, "materiality": "high"},
                    "VST": {"relation": "macro", "sentiment": 0.2, "materiality": "medium"},
                    "MU": {"relation": "company", "sentiment": -1, "materiality": "high"}}},
        {"title": "Oil jumps (older copy)", "publisher": "CNBC", "url": "https://example.test/b",
         "published": "2026-11-03T05:00:00+00:00", "themes": [],
         "scores": {"XLE": {"relation": "macro", "sentiment": 0.4, "materiality": "high"}}},
        {"title": "Micron earnings", "url": "https://example.test/c",
         "published": "2026-11-03T07:00:00+00:00", "themes": ["memory"],
         "scores": {"MU": {"relation": "company", "sentiment": 1, "materiality": "high"}}},
        {"title": "Spaced link", "url": "https://exa mple.test/x", "published": "2026-11-03T07:00:00+00:00",
         "themes": ["fed_rates"]},
        {"title": "Bad port", "url": "http://example.test:99999/a", "published": "2026-11-03T07:00:00+00:00",
         "themes": ["fed_rates"]},
        {"title": "Bad host", "url": "http://exa<mple.test/a", "published": "2026-11-03T07:00:00+00:00",
         "themes": ["fed_rates"]},
        {"title": "No host", "url": "https:///x", "published": "2026-11-03T07:00:00+00:00",
         "themes": ["fed_rates"]},
        {"title": "Bad link", "url": "javascript:alert(1)", "published": "2026-11-03T07:00:00+00:00",
         "themes": ["fed_rates"]},
    ],
}


class MarketContextTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        for name, data in (("gex", GEX), ("macro", MACRO), ("news", NEWS)):
            with open(os.path.join(self.dir.name, f"{name}.json"), "w", encoding="utf-8") as f:
                json.dump(data, f)

    def tearDown(self):
        self.dir.cleanup()

    def doc(self):
        return mc.collect_document(self.dir.name, now=1793700000)

    def test_keeps_index_gex_only(self):
        gex = self.doc()["gex"]
        self.assertEqual(gex["asOf"], 1793652780)
        self.assertEqual([r["symbol"] for r in gex["index"]], ["SPY", "QQQ"])
        spy, qqq = gex["index"]
        self.assertEqual(spy["zeroDte"]["flip"], 756.77)
        self.assertNotIn("byStrike", spy["zeroDte"])
        self.assertEqual(spy["notes"], ["GEX negative"])
        self.assertIsNone(qqq["zeroDte"])
        self.assertIsNone(qqq["netGex"])

    def test_macro_series_regimes_events(self):
        macro = self.doc()["macro"]
        self.assertEqual([s["id"] for s in macro["series"]], ["DGS2"])
        self.assertEqual(macro["series"][0]["value"], 4.56)
        self.assertEqual(macro["regimes"], [{"id": "curve", "label": "normal", "rule": "10y-2y < 0 inverted"}])
        self.assertEqual(macro["events"], [{"date": "2026-11-06", "time": "08:30", "name": "Employment Situation"}])

    def test_news_keeps_macro_headlines_only(self):
        news = self.doc()["news"]
        self.assertEqual([t["id"] for t in news["themes"]], ["fed_rates"])
        self.assertEqual([h["title"] for h in news["headlines"]], ["Oil jumps", "Fed holds"])
        oil, fed = news["headlines"]
        self.assertEqual((oil["sentiment"], oil["materiality"], oil["theme"]), (0.3, "high", None))
        self.assertEqual((fed["sentiment"], fed["theme"]), (-0.5, "Fed / rates"))

    def test_no_account_data_in_document(self):
        body = json.dumps(self.doc())
        for word in ("EWG", "position", "linkedHeld", "symbols", "universe", "relevance", "MU", "XLE",
                     "Graded stops", "javascript:"):
            self.assertNotIn(word, body)

    def test_matches_the_shared_fixture(self):
        # packages/api/src/market-context.test.ts parses the same file, so the two sides cannot drift.
        # Regenerate after a schema change: MC_WRITE_FIXTURE=1 python3 -m unittest test_market_context
        doc = self.doc()
        if os.environ.get("MC_WRITE_FIXTURE") == "1":
            with open(FIXTURE, "w", encoding="utf-8") as f:
                json.dump(doc, f, indent=2)
                f.write("\n")
        with open(FIXTURE, encoding="utf-8") as f:
            self.assertEqual(json.load(f), doc)

    def test_text_caps_in_utf16_units(self):
        self.assertEqual(mc.text("\U0001F600" * 3, 4), "\U0001F600" * 2)
        self.assertEqual(mc.text("  a \n b  ", 10), "a b")
        self.assertIsNone(mc.text("   ", 10))

    def test_missing_section_is_null_and_listed(self):
        os.remove(os.path.join(self.dir.name, "news.json"))
        with open(os.path.join(self.dir.name, "gex.json"), "w", encoding="utf-8") as f:
            f.write("[1]")
        doc = self.doc()
        self.assertEqual(doc["missing"], ["gex", "news"])
        self.assertIsNone(doc["gex"])
        self.assertIsNotNone(doc["macro"])

    def test_main_pushes_then_fails_when_a_section_is_missing(self):
        os.remove(os.path.join(self.dir.name, "macro.json"))
        with mock.patch.object(mc, "STATE_DIR", self.dir.name), mock.patch.object(mc.collect, "push") as push:
            self.assertEqual(mc.main([]), 1)
            pushed, host = push.call_args.args
            self.assertEqual((pushed["schema"], pushed["missing"], host), (mc.SCHEMA, ["macro"], "quantvps"))


if __name__ == "__main__":
    unittest.main()
