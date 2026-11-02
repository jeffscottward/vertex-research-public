"""Authored only; execute after source buildout in the deferred native gate."""

import hashlib
import unittest

from vertex_contracts import ContractError, rawSHA256
from vertex_contracts.codec import MAX_STRING_BYTES, canonical_encode, decimal_units, epoch_ns, parse_canonical


class CanonicalCodecCases(unittest.TestCase):
    def test_codepoint_order_scalar_utf8_and_escapes(self):
        value = {"\U00010000": "é", "\ue000": "\n\t\u0000", "a": True}
        expected = '{"a":true,"\ue000":"\\n\\t\\u0000","\U00010000":"é"}'.encode()
        self.assertEqual(canonical_encode(value), expected)
        self.assertEqual(parse_canonical(expected), value)

    def test_safe_integer_endpoints(self):
        self.assertEqual(canonical_encode([-9007199254740991, 9007199254740991]), b"[-9007199254740991,9007199254740991]")
        for value in [9007199254740992, -9007199254740992, 1.0, -0.0, float("nan"), float("inf")]:
            with self.subTest(value=value), self.assertRaises(ContractError):
                canonical_encode(value)

    def test_reject_noncanonical_and_duplicate_json_before_validation(self):
        rejected = [b'{"x":1,"x":1}', b'{"b":1,"a":2}', b' {"a":1}', b'{"a":1}\n',
                    b"-0", b"1.0", b"1e0", b"NaN", b"9007199254740992", b'"\\u0061"',
                    b'"\\ud800"', b'"\xff"', b'\xef\xbb\xbf{}', b"[1,]"]
        for value in rejected:
            with self.subTest(value=value), self.assertRaises(ContractError):
                parse_canonical(value)

    def test_plain_graph_only(self):
        class Decorated(list):
            pass
        cycle = []
        cycle.append(cycle)
        for value in [cycle, Decorated([1]), (1,), {1: "key"}, b"raw", {"x": object()}, "\ud800"]:
            with self.subTest(kind=type(value)), self.assertRaises(ContractError):
                canonical_encode(value)

    def test_resource_limits(self):
        value = None
        for _ in range(70):
            value = [value]
        with self.assertRaises(ContractError):
            canonical_encode(value)
        with self.assertRaises(ContractError):
            parse_canonical(b"[" * 70 + b"0" + b"]" * 70)
        with self.assertRaises(ContractError):
            canonical_encode("x" * (MAX_STRING_BYTES + 1))
        # The canonical admission ceiling must fit the source's bounded 1MiB
        # worker payload after base64 transport expansion. Contract-specific
        # validation and decoding/hash checks remain separate.
        worker_body = "A" * 1_398_100 + "AA=="
        self.assertEqual(parse_canonical(canonical_encode(worker_body)), worker_body)

    def test_raw_gamma_hash_is_not_canonical_string_hash(self):
        raw = b"original-gamma-source"
        self.assertEqual(rawSHA256(raw), hashlib.sha256(raw).hexdigest())
        self.assertNotEqual(rawSHA256(raw), rawSHA256(canonical_encode(raw.decode())))
        with self.assertRaises(ContractError):
            rawSHA256(raw.decode())

    def test_decimal_has_no_float_or_trailing_zero_alias(self):
        self.assertEqual(decimal_units("0.000000000000000001"), 1)
        self.assertEqual(decimal_units("-0.000000000000000001"), -1)
        self.assertEqual(decimal_units("999999999999999999999999999999.999999999999999999"), 10**48 - 1)
        for value in ["-0", "1.0", "01", "+1", "1e2", "0.0000000000000000001", "1\n"]:
            with self.subTest(value=value), self.assertRaises(ContractError):
                decimal_units(value)


class GregorianNanosecondCases(unittest.TestCase):
    def test_signed_fraction_and_offset_equivalence(self):
        self.assertEqual(epoch_ns("1969-12-31T23:59:59.999999999Z"), -1)
        self.assertEqual(epoch_ns("1970-01-01T00:00:00.000000001Z"), 1)
        self.assertEqual(epoch_ns("1970-01-01T23:59:00+23:59"), 0)
        self.assertEqual(epoch_ns("1969-12-31T00:01:00-23:59"), 0)
        self.assertEqual(epoch_ns("1970-01-01T00:00:00-00:00"), 0)

    def test_astronomical_year_zero(self):
        self.assertEqual(epoch_ns("0000-01-01T00:00:00Z"), -62167219200000000000)
        self.assertEqual(epoch_ns("0000-03-01T00:00:00Z") - epoch_ns("0000-02-28T00:00:00Z"), 2 * 86400 * 10**9)
        self.assertEqual(epoch_ns("2000-03-01T00:00:00Z") - epoch_ns("2000-02-28T00:00:00Z"), 2 * 86400 * 10**9)

    def test_calendar_lexical_and_precision_rejection(self):
        for value in ["1900-02-29T00:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z",
                      "2026-01-01T24:00:00Z", "2026-01-01T00:00:60Z", "2026-01-01T00:00Z",
                      "2026-01-01T00:00:00.0000000000Z", "2026-01-01T00:00:00+24:00",
                      "2026-01-01T00:00:00Z\n", "2026-01-01T00:00:00z", "10000-01-01T00:00:00Z"]:
            with self.subTest(value=value), self.assertRaises(ContractError):
                epoch_ns(value)


if __name__ == "__main__":
    unittest.main()
