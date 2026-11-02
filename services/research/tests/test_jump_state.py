"""Three focused jump-model source proofs; no fitting, downloads or backtesting."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import unittest

from strategies.jump import (FEATURE_CONSTRUCTION, TIE_RULE, WINDOW_SEMANTICS, FixedCentroidJumpModel,
                             JumpFeatureObservation, JumpFeatureScaler, assign_fixed_centroid_states)

T = datetime(2026, 9, 1, tzinfo=timezone.utc)


def fixture(values=("0", "0", "0.8"), penalty="0.5", window=3):
    model = FixedCentroidJumpModel("vertex-jump-fixed-centroid-model-v1", ("downside",), ("bull", "bear"),
        (("0",), ("1",)), penalty, window, WINDOW_SEMANTICS, TIE_RULE, T, T + timedelta(days=1),
        "model-origin", "a" * 64)
    scaler = JumpFeatureScaler("vertex-jump-scaler-v1", ("downside",), ("0",), ("1",),
        T, T + timedelta(days=1), "scaler-origin", "b" * 64)
    rows = tuple(JumpFeatureObservation(T + timedelta(days=2 + day), T + timedelta(days=2 + day), (value,),
                                      "features-origin", "c" * 64) for day, value in enumerate(values))
    return dict(feature_order=("downside",), feature_construction=FEATURE_CONSTRUCTION, observations=rows,
                model=model, scaler=scaler, as_of=rows[-1].available_at)


def summary(result):
    return [(row.state_index, row.state_label, row.tie, row.cost_margin, row.window_observations, row.warmup)
            for row in result.states]


class JumpStateTests(unittest.TestCase):
    def test_hand_computable_dp_penalty_effect(self):
        # Centroids 0 (bull) / 1 (bear); x = 0, 0, 0.8 -> losses (0,.5), (0,.5), (.32,.02).
        # lambda .5: V2 = (.32+0, .02+min(1.0, 0+.5)) = (.32,.52): switch suppressed.
        result = assign_fixed_centroid_states(**fixture())
        self.assertEqual(summary(result), [(0, "bull", False, "0.5", 1, True), (0, "bull", False, "1", 2, True),
                                           (0, "bull", False, "0.2", 3, False)])
        self.assertEqual((result.profile, result.assignment_kind, result.jump_penalty, result.window_length),
                         ("vertex-jump-state-result-v1", "hard-assignment-not-probability", "0.5", 3))
        self.assertFalse(hasattr(result.states[0], "posterior"))
        # lambda .1: V1=(0,.6); V2=(.32, .02+min(.6,.1)=.12): switch allowed.
        self.assertEqual(summary(assign_fixed_centroid_states(**fixture(penalty="0.1")))[2],
                         (1, "bear", False, "0.2", 3, False))
        # lambda 0 is nearest centroid; lambda .3 is an exact tie .32/.32 -> lowest index.
        self.assertEqual(summary(assign_fixed_centroid_states(**fixture(penalty="0")))[2][:4], (1, "bear", False, "0.3"))
        self.assertEqual(summary(assign_fixed_centroid_states(**fixture(penalty="0.3")))[2][:4], (0, "bull", True, "0"))
        # Window 1 forgets context: each step is nearest-centroid despite lambda .5.
        self.assertEqual(summary(assign_fixed_centroid_states(**fixture(window=1)))[2], (1, "bear", False, "0.3", 1, False))
        # Scaled space: (x-center)/scale = (1.6-0)/2 = .8 reproduces the base case.
        data = fixture(values=("0", "0", "1.6"))
        data["scaler"] = replace(data["scaler"], scale=("2",))
        self.assertEqual(summary(assign_fixed_centroid_states(**data)), summary(result))
        # Large magnitudes: an order-one-scale cost difference survives exactly.
        # x=1e12, c=(0, 1e-6): losses 5e23 and 5e23-1e6+5e-13, margin 1e6-5e-13.
        data = fixture(values=("1000000000000",), penalty="1000000000000", window=1)
        data["model"] = replace(data["model"], centroids=(("0",), ("0.000001",)))
        self.assertEqual(summary(assign_fixed_centroid_states(**data)), [(1, "bear", False, "999999.9999999999995", 1, False)])

    def test_prefix_causality_future_rejection_and_history_immutability(self):
        # Rows 0, .9, 1, 1 with lambda .75: V1=(.405,.505) publishes bull without a
        # tie; V2=(.905,.505) flips to bear. The step-2 optimal path is bear from
        # step 0 in hindsight, yet the step-0/1 publications stay bull (no rewrite).
        data = fixture(values=("0", "0.9", "1", "1"), penalty="0.75", window=4)
        full = assign_fixed_centroid_states(**data)
        self.assertEqual([(row.state_index, row.tie, row.cost_margin) for row in full.states],
                         [(0, False, "0.5"), (0, False, "0.1"), (1, False, "0.4"), (1, False, "0.9")])
        for size in range(1, 5):
            prefix = assign_fixed_centroid_states(**{**data, "observations": data["observations"][:size],
                                                   "as_of": data["observations"][size - 1].available_at})
            self.assertEqual(prefix.states, full.states[:size])
        changed = (*data["observations"][:2], *(replace(row, values=("-5",)) for row in data["observations"][2:]))
        self.assertEqual(assign_fixed_centroid_states(**{**data, "observations": changed}).states[:2], full.states[:2])
        self.assertIsInstance(full.states, tuple)
        with self.assertRaises(Exception):
            full.states[1].state_index = 1
        variants = [
            {"as_of": data["observations"][-1].available_at - timedelta(seconds=1)},
            {"model": replace(data["model"], available_at=T + timedelta(days=3))},
            {"model": replace(data["model"], fit_cutoff=T + timedelta(days=2))},
            {"scaler": replace(data["scaler"], available_at=T + timedelta(days=3))},
            {"scaler": replace(data["scaler"], fit_cutoff=T + timedelta(hours=36))},
            {"observations": tuple(reversed(data["observations"]))},
            {"observations": (replace(data["observations"][0], available_at=T + timedelta(days=9)),)},
            {"observations": (replace(data["observations"][0], available_at=T),)},
            {"as_of": datetime(2026, 9, 9)},
        ]
        for variant in variants:
            with self.assertRaises(ValueError):
                assign_fixed_centroid_states(**{**data, **variant})

    def test_invalid_numerical_and_model_inputs(self):
        data = fixture()
        model, scaler, row = data["model"], data["scaler"], data["observations"][0]
        bad_models = [
            replace(model, profile="continuous-jump"),
            replace(model, state_labels=("same", "same")),
            replace(model, state_labels=("one",)),
            replace(model, state_labels=("bull", "bear", "extra")),
            replace(model, feature_order=("other",)),
            replace(model, centroids=(("0",),)),
            replace(model, centroids=(("0", "1"), ("1", "0"))),
            replace(model, centroids=(("NaN",), ("1",))),
            replace(model, centroids=(("Infinity",), ("1",))),
            replace(model, centroids=((0.0,), ("1",))),
            replace(model, centroids=(("1e3",), ("1",))),
            replace(model, centroids=(("1000000000001",), ("1",))),
            replace(model, jump_penalty="-0.1"),
            replace(model, jump_penalty=0.5),
            replace(model, jump_penalty="0.0000000000000000001"),
            replace(model, window_length=0),
            replace(model, window_length=513),
            replace(model, window_length=True),
            replace(model, window_length="3"),
            replace(model, window_semantics="expanding-carry-state"),
            replace(model, tie_rule="random"),
        ]
        variants = [{"model": value} for value in bad_models] + [
            {"scaler": replace(scaler, profile="vertex-hmm-scaler-v1")},
            {"scaler": replace(scaler, scale=("0",))},
            {"scaler": replace(scaler, scale=("-1",))},
            {"scaler": replace(scaler, center=("0", "1"))},
            {"feature_construction": "paper-downside-variance"},
            {"feature_order": ("downside", "downside")},
            {"feature_order": tuple("feature" + str(i) for i in range(17))},
            {"observations": ()},
            {"observations": list(data["observations"])},
            {"observations": data["observations"][:1] * 513},
            {"observations": (replace(row, values=("-Infinity",)),)},
            {"observations": (replace(row, values=(True,)),)},
            {"observations": (replace(row, values=("1", "2")),)},
            {"observations": (replace(row, values=(" 1",)),)},
            {"observations": (replace(row, observed_at=datetime(2026, 9, 3)),)},
        ]
        for variant in variants:
            with self.assertRaises(ValueError, msg=str(variant)[:160]):
                assign_fixed_centroid_states(**{**data, **variant})
        # A margin outside the public output domain fails closed, never truncates.
        huge = fixture(values=("1000000000000",), window=1)
        huge["model"] = replace(huge["model"], centroids=(("0",), ("-1000000000000",)))
        huge["scaler"] = replace(huge["scaler"], scale=("0.000000000001",))
        with self.assertRaises(ValueError):
            assign_fixed_centroid_states(**huge)


if __name__ == "__main__":
    unittest.main()
