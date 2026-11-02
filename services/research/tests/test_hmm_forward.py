"""Three focused source proofs; no fitting, downloads or backtesting."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import unittest

from strategies.hmm import (DiagonalGaussianModel, FeatureObservation, FeatureScaler,
                            filter_diagonal_gaussian)

T = datetime(2026, 9, 1, tzinfo=timezone.utc)


def fixture():
    model = DiagonalGaussianModel("vertex-hmm-diagonal-model-v1", ("return",), ("calm", "stress"),
        ("0.5", "0.5"), (("0.75", "0.25"), ("0.25", "0.75")), (("0",), ("0",)),
        (("1",), ("4",)), T, T + timedelta(days=1), "model-origin", "a" * 64)
    scaler = FeatureScaler("vertex-hmm-scaler-v1", ("return",), ("0",), ("1",),
        T, T + timedelta(days=1), "scaler-origin", "b" * 64)
    rows = tuple(FeatureObservation(T + timedelta(days=day), T + timedelta(days=day), ("0",),
                                  "features-origin", "c" * 64) for day in (2, 3))
    return dict(feature_order=("return",), observations=rows, model=model, scaler=scaler, as_of=T + timedelta(days=3))


class HmmForwardTests(unittest.TestCase):
    def test_hand_computable_forward_filter(self):
        result = filter_diagonal_gaussian(**fixture())
        # Equal means, variances 1 and 4: at zero the likelihood ratio is 2:1.
        # alpha_0=(2/3,1/3); alpha_0 A=(7/12,5/12); alpha_1=(14/19,5/19).
        expected = ((Decimal(2) / 3, Decimal(1) / 3), (Decimal(14) / 19, Decimal(5) / 19))
        for row, probabilities in zip(result.filtered, expected):
            for actual, target in zip(row.posterior, probabilities):
                self.assertIsInstance(actual, str)
                self.assertLess(abs(Decimal(actual) - target), Decimal("0.000000000000001"))
            self.assertLess(abs(sum(map(Decimal, row.posterior)) - 1), Decimal("0.000000000000002"))
            self.assertEqual(row.state_label, "calm")
        self.assertEqual(result.profile, "vertex-hmm-forward-result-v1")
        # Raw densities at a remote observation underflow; log-domain ratios do not.
        data = fixture()
        data["observations"] = (replace(data["observations"][0], values=("1000000",)),)
        self.assertEqual(filter_diagonal_gaussian(**data).filtered[0].posterior, ("0", "1"))
        # Exact zeros remain impossible and ties use supplied state order.
        data["model"] = replace(data["model"], initial_probabilities=("1", "0"))
        self.assertEqual(filter_diagonal_gaussian(**data).filtered[0].posterior, ("1", "0"))
        data = fixture()
        data["model"] = replace(data["model"], variances=(("1",), ("1",)))
        self.assertEqual(filter_diagonal_gaussian(**data).filtered[0].state_index, 0)
        # Identical likelihoods at the allowed numerical bound must preserve
        # nonuniform initial AND subsequent predictive priors, not become ties.
        data["model"] = replace(data["model"], initial_probabilities=("0.25", "0.75"))
        data["observations"] = tuple(replace(row, values=("1000000000000",)) for row in data["observations"])
        remote = filter_diagonal_gaussian(**data)
        self.assertEqual(remote.filtered[0].posterior, ("0.25", "0.75"))
        self.assertEqual(remote.filtered[1].posterior, ("0.375", "0.625"))
        self.assertEqual(remote.filtered[0].state_index, 1)

    def test_prefix_causality_and_future_rejection(self):
        data = fixture()
        full = filter_diagonal_gaussian(**data)
        prefix = filter_diagonal_gaussian(**{**data, "observations": data["observations"][:1],
                                            "as_of": data["observations"][0].available_at})
        self.assertEqual(prefix.filtered, full.filtered[:1])
        changed = (*data["observations"][:1], replace(data["observations"][1], values=("20",)))
        self.assertEqual(filter_diagonal_gaussian(**{**data, "observations": changed}).filtered[:1], prefix.filtered)
        variants = [
            {"as_of": T + timedelta(days=2)},
            {"model": replace(data["model"], available_at=T + timedelta(days=3))},
            {"model": replace(data["model"], fit_cutoff=T + timedelta(days=4))},
            {"scaler": replace(data["scaler"], available_at=T + timedelta(days=3))},
            {"scaler": replace(data["scaler"], fit_cutoff=T + timedelta(days=2))},
            {"observations": tuple(reversed(data["observations"]))},
            {"observations": (replace(data["observations"][0], available_at=T + timedelta(days=4)),)},
            {"observations": (replace(data["observations"][0], available_at=T),)},
        ]
        for variant in variants:
            with self.assertRaises(ValueError):
                filter_diagonal_gaussian(**{**data, **variant})

    def test_invalid_numerical_and_model_inputs(self):
        data = fixture()
        model, scaler = data["model"], data["scaler"]
        bad_models = [
            replace(model, profile="full-covariance"),
            replace(model, state_labels=("same", "same")),
            replace(model, state_labels=("one",)),
            replace(model, feature_order=("other",)),
            replace(model, initial_probabilities=("0.5", "0.49")),
            replace(model, initial_probabilities=("-0.1", "1.1")),
            replace(model, transitions=(("1", "0"), ("0", "0"))),
            replace(model, transitions=(("1", "0"),)),
            replace(model, variances=(("0",), ("4",))),
            replace(model, variances=(("-1",), ("4",))),
            replace(model, variances=(("0.0000000000001",), ("4",))),
            replace(model, variances=((("1", "0"), ("0", "1")),)),
            replace(model, means=(("NaN",), ("0",))),
            replace(model, means=(("Infinity",), ("0",))),
            replace(model, means=((float("nan"),), ("0",))),
            replace(model, means=((1.0,), ("0",))),
            replace(model, means=(("1000000000001",), ("0",))),
        ]
        variants = [{"model": value} for value in bad_models] + [
            {"scaler": replace(scaler, scale=("0",))},
            {"scaler": replace(scaler, center=("0", "1"))},
            {"feature_order": ("return", "return")},
            {"feature_order": tuple("feature" + str(i) for i in range(17))},
            {"observations": ()},
            {"observations": data["observations"] * 257},
            {"observations": (replace(data["observations"][0], values=("1e9",)),)},
            {"observations": (replace(data["observations"][0], values=(True,)),)},
            {"observations": (replace(data["observations"][0], values=("1", "2")),)},
        ]
        for variant in variants:
            with self.assertRaises(ValueError):
                filter_diagonal_gaussian(**{**data, **variant})


if __name__ == "__main__":
    unittest.main()
