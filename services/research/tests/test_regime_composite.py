"""Three focused composite-envelope source proofs; no fitting, downloads or backtesting.

Component contents are synthetic vertex-sleeve-result-v1 shapes of the verified
HMM and jump operations; hashes, pins and current reviews are the adapter's job
and are proven only by the connected Civet case.
"""
from dataclasses import fields, replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import unittest

from strategies.composite import (PENDING, ComponentSource, ComponentStance, bind_components, compose_envelope,
                                  hmm_stance, implemented_components_summary, jump_stance, posterior_mass_threshold)
from strategies.hmm import NUMERICAL_ENCODING as HMM_ENCODING
from strategies.jump import NUMERICAL_ENCODING as JUMP_ENCODING

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
AS_OF = datetime(2026, 9, 22, 12, tzinfo=timezone.utc)
COMPONENT_AS_OF = AS_OF - timedelta(hours=2)
CAPTURED = AS_OF - timedelta(hours=1)
DAY1 = AS_OF - timedelta(days=1)
DAY2 = AS_OF - timedelta(hours=3)
FIT = AS_OF - timedelta(days=5)
MODEL_AT = AS_OF - timedelta(days=4)
HMM_MODEL, JUMP_MODEL, HMM_CONTENT, JUMP_CONTENT = "d" * 64, "e" * 64, "a" * 64, "b" * 64
MARKET, CALENDAR = "synthetic-us-equity-index", "synthetic-xnys"
HMM_LABELS = ("low-vol", "mid-vol", "high-vol")
HMM_MAP = {"low-vol": "non-defensive", "mid-vol": "neutral", "high-vol": "defensive"}
JUMP_MAP = {"bull": "non-defensive", "bear": "defensive"}


def ns(value):
    delta = value - EPOCH
    return str((delta.days * 86_400 + delta.seconds) * 1_000_000_000 + delta.microseconds * 1000)


def sleeve(operation, variant, encoding, result, prefix, model_sha):
    inputs = [{"role": f"{prefix}_{name}", "review": {}, "content": {"artifactId": f"{prefix}-{name}", "sha256": sha}}
              for name, sha in (("features", "1" * 64), ("model", model_sha), ("scaler", "2" * 64))]
    return {"profile": "vertex-sleeve-result-v1", "operation": operation, "asOf": "2026-09-22T10:00:00Z",
            "recipeSha256": "c" * 64, "parameters": {"variant": variant}, "proposalOnly": True,
            "executionAuthorized": False, "acceptanceStatus": "unreviewed", "simulatedCapitalEntersNav": False,
            "projectedResult": result, "projectionTimeEncoding": "epoch-nanoseconds-decimal-string",
            "projectionDecimalEncoding": encoding, "stateBasis": None, "inputs": inputs,
            "limitations": ["Synthetic component fixture."]}


def fixture():
    times = {"model_fit_cutoff": ns(FIT), "model_available_at": ns(MODEL_AT),
             "scaler_fit_cutoff": ns(FIT), "scaler_available_at": ns(MODEL_AT)}
    hmm_result = {"profile": "vertex-hmm-forward-result-v1", "prediction_as_of": ns(COMPONENT_AS_OF),
        "feature_order": ["ret"], "state_labels": list(HMM_LABELS), **times, "numerical_encoding": HMM_ENCODING,
        "filtered": [
            {"observed_at": ns(DAY1), "available_at": ns(DAY1), "posterior": ["0.8", "0.15", "0.05"],
             "state_index": 0, "state_label": "low-vol"},
            {"observed_at": ns(DAY2), "available_at": ns(DAY2), "posterior": ["0.1", "0.1", "0.8"],
             "state_index": 2, "state_label": "high-vol"}],
        "limitations": ["Synthetic component fixture."]}
    jump_result = {"profile": "vertex-jump-state-result-v1", "assignment_kind": "hard-assignment-not-probability",
        "variant": "discrete-fixed-centroid-trailing-window-dp-v1", "prediction_as_of": ns(COMPONENT_AS_OF),
        "feature_order": ["downside"],
        "feature_construction": "upstream-reviewed-downside-deviation-variant-declared-unknown-v1",
        "state_labels": ["bull", "bear"], "jump_penalty": "0.5", "window_length": 2,
        "window_semantics": "trailing-window-fresh-start-each-step-v1", "tie_rule": "lowest-state-index-v1",
        **times, "numerical_encoding": JUMP_ENCODING,
        "states": [
            {"observed_at": ns(DAY1), "available_at": ns(DAY1), "window_start_observed_at": ns(DAY1),
             "window_observations": 1, "warmup": True, "state_index": 0, "state_label": "bull", "tie": False,
             "cost_margin": "0.5"},
            {"observed_at": ns(DAY2), "available_at": ns(DAY2 + timedelta(minutes=30)),
             "window_start_observed_at": ns(DAY1), "window_observations": 2, "warmup": False, "state_index": 1,
             "state_label": "bear", "tie": False, "cost_margin": "0.2"}],
        "limitations": ["Synthetic component fixture."]}
    hmm = ComponentSource("hmm-component-evidence", HMM_CONTENT, int(ns(CAPTURED)), int(ns(COMPONENT_AS_OF)),
        sleeve("macro-hmm-forward-v1", "diagonal-gaussian-log-forward-v1", HMM_ENCODING, hmm_result, "hmm", HMM_MODEL))
    jump = ComponentSource("jump-component-evidence", JUMP_CONTENT, int(ns(CAPTURED)), int(ns(COMPONENT_AS_OF)),
        sleeve("macro-jump-state-v1", "discrete-fixed-centroid-trailing-window-dp-v1", JUMP_ENCODING, jump_result,
               "jump", JUMP_MODEL))
    common = {"market_id": MARKET, "calendar_id": CALENDAR, "identity_basis": "reviewed-attestation-not-machine-verified-v1"}
    hmm_binding = {"profile": "vertex-composite-hmm-binding-v1", "component_evidence_id": "hmm-component-evidence",
                   "component_content_sha256": HMM_CONTENT, **common, "model_content_sha256": HMM_MODEL,
                   "stance_map": dict(HMM_MAP), "posterior_mass_threshold": "0.7"}
    jump_binding = {"profile": "vertex-composite-jump-binding-v1", "component_evidence_id": "jump-component-evidence",
                    "component_content_sha256": JUMP_CONTENT, **common, "model_content_sha256": JUMP_MODEL,
                    "stance_map": dict(JUMP_MAP)}
    return dict(market_id=MARKET, calendar_id=CALENDAR, hmm_binding=hmm_binding, jump_binding=jump_binding,
                hmm=hmm, jump=jump, as_of=AS_OF, maximum_age_ns=3 * 86_400 * 1_000_000_000)


def outline(stance):
    return (stance.component, stance.status, stance.stance)


class RegimeCompositeTests(unittest.TestCase):
    def reject(self, mutate, reason):
        data = fixture()
        mutate(data)
        with self.assertRaisesRegex(ValueError, "^composite-" + reason + "$"):
            bind_components(**data)

    def test_stance_threshold_boundaries_and_implemented_components_summary(self):
        cut = posterior_mass_threshold("0.7")

        def hmm(posterior, threshold=cut):
            value = hmm_stance(tuple(posterior), HMM_LABELS, HMM_MAP, threshold, state_label="mid-vol")
            return value.status, value.stance, value.mapped_defensive_posterior_mass, value.mapped_non_defensive_posterior_mass

        # Defensive mass exactly .7 (= t) is defensive; one 15th-place unit below is neutral (no rounding up).
        self.assertEqual(hmm(("0.1", "0.2", "0.7")), ("available", "defensive", Decimal("0.7"), Decimal("0.1")))
        self.assertEqual(hmm(("0.1", "0.200000000000001", "0.699999999999999"))[:2], ("available", "neutral"))
        self.assertEqual(hmm(("0.7", "0.3", "0"))[:2], ("available", "non-defensive"))
        # Neutral-mapped mid-vol mass .6 counts toward neither side: .2/.2 -> neutral.
        self.assertEqual(hmm(("0.2", "0.6", "0.2")), ("available", "neutral", Decimal("0.2"), Decimal("0.2")))
        # Both sides >= t only via published rounding (sum 1.000000000000002): indeterminate, never guessed.
        tight = posterior_mass_threshold("0.5000000000000001")
        self.assertEqual(hmm(("0.500000000000001", "0", "0.500000000000001"), tight)[:2], ("indeterminate", None))
        # Jump: warmup -> warmup, exact tie -> indeterminate (warmup wins), otherwise the reviewed map.
        self.assertEqual(outline(jump_stance(warmup=True, tie=False, state_label="bear", stance_map=JUMP_MAP)),
                         ("JM", "warmup", None))
        self.assertEqual(outline(jump_stance(warmup=False, tie=True, state_label="bull", stance_map=JUMP_MAP)),
                         ("JM", "indeterminate", None))
        self.assertEqual(outline(jump_stance(warmup=True, tie=True, state_label="bull", stance_map=JUMP_MAP)),
                         ("JM", "warmup", None))
        self.assertEqual(outline(jump_stance(warmup=False, tie=False, state_label="bear", stance_map=JUMP_MAP)),
                         ("JM", "available", "defensive"))

        def h(status, stance):
            return ComponentStance("HMM", status, stance, "mid-vol", None, None)

        def j(status, stance):
            return ComponentStance("JM", status, stance, "bull", None, None)

        for components, expected in (
                ((h("available", "defensive"), j("available", "defensive")), "aligned-defensive"),
                ((h("available", "non-defensive"), j("available", "non-defensive")), "aligned-non-defensive"),
                ((h("available", "defensive"), j("available", "non-defensive")), "mixed"),
                ((h("available", "neutral"), j("available", "defensive")), "mixed"),
                ((h("available", "neutral"), j("available", "neutral")), "mixed"),
                ((h("available", "defensive"), j("warmup", None)), "incomplete"),
                ((h("available", "defensive"), j("indeterminate", None)), "incomplete"),
                ((h("indeterminate", None), j("available", "defensive")), "incomplete")):
            self.assertEqual(implemented_components_summary(components), expected)
        # Pending entries are never summary inputs: ORCA/HMM-RL cannot be counted or voted.
        orca = ComponentStance("ORCA", "available", "defensive", "crash", None, None)
        aligned = (h("available", "defensive"), j("available", "defensive"))
        for invalid in ((*aligned, orca), (aligned[0], orca), aligned[:1], (*aligned, *PENDING), PENDING, list(aligned)):
            with self.assertRaisesRegex(ValueError, "^composite-summary-scope-invalid$"):
                implemented_components_summary(invalid)
        # Whole envelope: rows eligible at max component available_at; coverage partial; pending listed only.
        result = compose_envelope(bound=bind_components(**fixture()), as_of=AS_OF)
        self.assertEqual([(row.observed_at, row.eligible_at, [outline(item) + (item.state_label,) for item in row.components],
                           row.coverage, row.pending, row.implemented_components_summary) for row in result.rows], [
            (ns(DAY1), ns(DAY1), [("HMM", "available", "non-defensive", "low-vol"), ("JM", "warmup", None, "bull")],
             "partial", PENDING, "incomplete"),
            (ns(DAY2), ns(DAY2 + timedelta(minutes=30)),
             [("HMM", "available", "defensive", "high-vol"), ("JM", "available", "defensive", "bear")],
             "partial", PENDING, "aligned-defensive")])
        self.assertEqual((result.rows[0].components[0].mapped_defensive_posterior_mass,
                          result.rows[0].components[0].mapped_non_defensive_posterior_mass), (Decimal("0.05"), Decimal("0.8")))
        self.assertEqual([(item.component, item.role) for item in result.pending],
                         [("ORCA", "detector"), ("HMM-RL", "downstream-policy-not-a-stance")])
        self.assertFalse(any(hasattr(item, "stance") for item in result.pending))
        self.assertEqual((result.summary_scope, result.aggregation, [item.component for item in result.components]),
                         (("HMM", "JM"), "agreement-envelope-replaces-numeric-average-v1", ["HMM", "JM"]))
        self.assertTrue(result.provenance_only[0].source.startswith("ruuj")
                        and result.provenance_only[0].role.startswith("methodological-provenance-only"))
        names = {field.name for kind in (type(result), type(result.rows[0])) for field in fields(kind)}
        for forbidden in ("average", "vote", "count", "percent", "weight", "probability", "aligned", "composite_label"):
            self.assertFalse(any(forbidden in name for name in names), forbidden)
        self.assertTrue(any("not independent confirmation" in text for text in result.limitations))
        self.assertTrue(any("uncalibrated" in text for text in result.limitations))
        self.assertTrue(any("replaces a numeric average" in text for text in result.limitations))

    def test_binding_rejections(self):
        bind_components(**fixture())

        def assign(key, field, value):
            return lambda data: data[key].__setitem__(field, value)

        self.reject(assign("hmm_binding", "component_content_sha256", "f" * 64), "component-content-hash-mismatch")
        self.reject(lambda data: data.__setitem__("jump", replace(data["jump"], content_sha256="f" * 64)),
                    "component-content-hash-mismatch")
        self.reject(assign("jump_binding", "component_evidence_id", "other-evidence"), "component-evidence-mismatch")
        # Stance maps must name the component model content hash and be total and exact over state_labels.
        self.reject(assign("hmm_binding", "model_content_sha256", JUMP_MODEL), "stance-map-model-mismatch")
        self.reject(assign("jump_binding", "model_content_sha256", HMM_MODEL), "stance-map-model-mismatch")
        self.reject(lambda data: data["hmm_binding"]["stance_map"].pop("mid-vol"), "stance-map-not-total")
        self.reject(lambda data: data["jump_binding"]["stance_map"].__setitem__("sideways", "neutral"), "stance-map-not-total")
        self.reject(lambda data: data["jump_binding"]["stance_map"].__setitem__("bear", "bearish"), "stance-map-not-total")
        # Frozen component operation / profile / variant only.
        self.reject(lambda data: data["hmm"].content.__setitem__("operation", "macro-jump-state-v1"),
                    "component-operation-or-profile-invalid")
        self.reject(lambda data: data["jump"].content.__setitem__("profile", "vertex-sleeve-result-v2"),
                    "component-operation-or-profile-invalid")
        self.reject(lambda data: data["hmm"].content.__setitem__("parameters", {"variant": "full-covariance-v1"}),
                    "component-variant-invalid")
        self.reject(lambda data: data["jump"].content["projectedResult"].__setitem__("variant", "continuous-jump"),
                    "component-variant-invalid")
        self.reject(lambda data: data["hmm"].content["projectedResult"].__setitem__("profile", "vertex-hmm-smoothed-result-v1"),
                    "component-result-profile-invalid")
        self.reject(assign("hmm_binding", "identity_basis", "machine-verified"), "binding-identity-basis-invalid")
        self.reject(assign("jump_binding", "posterior_mass_threshold", "0.7"), "binding-shape-invalid")
        # Threshold is reviewed decimal text strictly inside (0.5, 1).
        for value in ("0.5", "0.4", "0", "1", "1.0", "0.50", "-0.7", "0.7e0", 0.7, None):
            self.reject(assign("hmm_binding", "posterior_mass_threshold", value), "posterior-mass-threshold-invalid")
        for value in ("0.5", "1", "0.4"):
            with self.assertRaisesRegex(ValueError, "^composite-posterior-mass-threshold-invalid$"):
                posterior_mass_threshold(value)

    def test_alignment_rejections(self):
        def source(key, **changes):
            return lambda data: data.__setitem__(key, replace(data[key], **changes))

        def both(*mutations):
            return lambda data: [mutation(data) for mutation in mutations]

        def predicted(key, value):
            return lambda data: data[key].content["projectedResult"].__setitem__("prediction_as_of", value)

        later = AS_OF + timedelta(hours=1)
        # observed_at sequences must be identical: a shifted row or a missing row rejects (no intersection).
        self.reject(lambda data: data["jump"].content["projectedResult"]["states"][1].__setitem__(
            "observed_at", ns(DAY2 + timedelta(minutes=1))), "observed-at-mismatch")
        self.reject(lambda data: data["jump"].content["projectedResult"]["states"].pop(0), "observed-at-mismatch")
        # Component asOf identical and no later than the composite as_of.
        self.reject(both(source("jump", as_of_ns=int(ns(COMPONENT_AS_OF + timedelta(minutes=1)))),
                         predicted("jump", ns(COMPONENT_AS_OF + timedelta(minutes=1)))), "component-as-of-mismatch")
        self.reject(both(source("hmm", as_of_ns=int(ns(later))), predicted("hmm", ns(later)),
                         source("jump", as_of_ns=int(ns(later))), predicted("jump", ns(later))),
                    "component-as-of-after-composite-as-of")
        self.reject(source("hmm", as_of_ns=int(ns(COMPONENT_AS_OF)) + 1000), "component-as-of-inconsistent")
        # A later-captured or later-available component can never feed an earlier composite.
        self.reject(source("jump", captured_at_ns=int(ns(AS_OF)) + 1000), "component-captured-after-composite-as-of")
        self.reject(lambda data: data["hmm"].content["projectedResult"]["filtered"][1].__setitem__(
            "available_at", ns(AS_OF + timedelta(seconds=1))), "component-available-after-composite-as-of")
        # Market identity/calendar: exact equality of reviewed attestations with the recipe identity.
        self.reject(lambda data: data["jump_binding"].__setitem__("market_id", "other-market"), "market-identity-mismatch")
        self.reject(lambda data: data["hmm_binding"].__setitem__("calendar_id", "other-calendar"), "market-identity-mismatch")
        self.reject(lambda data: data.__setitem__("market_id", "other-market"), "market-identity-mismatch")
        # Freshness boundary: last shared observation exactly 3h old passes at 3h, rejects one nanosecond tighter.
        data = fixture()
        data["maximum_age_ns"] = 3 * 3600 * 1_000_000_000
        bind_components(**data)
        self.reject(lambda data: data.__setitem__("maximum_age_ns", 3 * 3600 * 1_000_000_000 - 1), "component-stale")


if __name__ == "__main__":
    unittest.main()
