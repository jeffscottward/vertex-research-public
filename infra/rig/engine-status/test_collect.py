import unittest

import collect


class CollectTest(unittest.TestCase):
    def test_picks_only_engine_timers(self):
        listing = (
            "market-watch-gex.timer loaded active waiting GEX\n"
            "crown-sync-full.timer loaded active waiting x\n"
            "omarchy-other.timer loaded active waiting y\n"
            "bad name.timer loaded\n"
        )
        self.assertEqual(
            collect.engine_timers(listing), ["crown-sync-full", "market-watch-gex"]
        )

    def test_builds_unit_state_only(self):
        units = collect.parse_show(
            "Id=market-watch-gex.timer\nActiveState=active\n"
            "NextElapseUSecRealtime=@1700000600\nLastTriggerUSec=@1700000000\n\n"
            "Id=market-watch-gex.service\nActiveState=failed\nResult=exit-code\n"
            "ExecMainStatus=1\nExecMainExitTimestamp=@1700000005\n"
        )
        doc = collect.build(["market-watch-gex", "market-watch-news"], units, 1700000010)
        self.assertEqual(doc["schema"], "vertex-engine-status-v1")
        self.assertEqual(
            doc["engines"][0],
            {
                "unit": "market-watch-gex",
                "timerActive": True,
                "serviceState": "failed",
                "result": "exit-code",
                "exitStatus": 1,
                "lastRunAt": 1700000000,
                "lastExitAt": 1700000005,
                "nextRunAt": 1700000600,
            },
        )
        missing = doc["engines"][1]
        self.assertFalse(missing["timerActive"])
        self.assertEqual(missing["serviceState"], "unknown")
        self.assertIsNone(missing["lastRunAt"])

    def test_bad_values_become_null(self):
        self.assertIsNone(collect.stamp(""))
        self.assertIsNone(collect.stamp("@0"))
        self.assertIsNone(collect.stamp("@x"))
        self.assertIsNone(collect.exit_status("x"))
        self.assertIsNone(collect.exit_status(""))


if __name__ == "__main__":
    unittest.main()
