"""Synthetic inert context vectors, not evidence, admission or model-use approval."""
from copy import deepcopy
from dataclasses import FrozenInstanceError, fields, replace
from hashlib import sha256
import json
from pathlib import Path
from unittest import TestCase

from agents.chat_context import (
    ResearchChatHumanAuthorV1, ResearchChatHumanContextV1, ResearchChatHumanMessageV1,
    canonical_research_chat_human_context_v1, parse_research_chat_human_context_v1,
)
from agents.types import AgentFault


FIXTURE_PATH = (Path(__file__).resolve().parents[3]
                / "packages/api/src/contracts/fixtures/research-chat-human-context-v1.json")
GOLDEN = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


class CodecFixture:
    """Explicit test codec only, following the existing agent safety fixtures.

    This string/integer-only vector avoids Python/ECMAScript number differences;
    the golden bytes come from the real shared Vertex encoder, not this fixture.
    """

    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False).encode("utf-8")

    def digest(self, value):
        return sha256(self.encode(value)).hexdigest()


def payload():
    return deepcopy(GOLDEN["context"])


def window(count, start=1):
    value = payload()
    value["messages"] = [
        dict(message_id=f"message-{index}", sequence=str(start + index),
             record_sha256="a" * 64,
             author=dict(kind="user", actor_id=value["owner_actor_id"]), body="x")
        for index in range(count)
    ]
    value["start_sequence"] = str(start)
    value["high_water_sequence"] = str(start + count - 1)
    value["snapshot_revision"] = str(start + count)
    value["parent_message_id"] = f"message-{count - 1}"
    return value


def byte_limit_payload():
    value = window(16)
    remaining = 65_536 - len(CodecFixture().encode(value))
    for message in value["messages"]:
        added = min(remaining, 7_999)
        message["body"] += "x" * added
        remaining -= added
    assert remaining == 0
    return value


class HumanChatContextTests(TestCase):
    def parse(self, value):
        return parse_research_chat_human_context_v1(value, codec=CodecFixture())

    def assert_rejected(self, value, code=None):
        with self.assertRaises(AgentFault) as raised:
            self.parse(value)
        if code is not None:
            self.assertEqual(raised.exception.code, code)
        self.assertFalse(raised.exception.retryable)

    def test_shared_golden_vector_preserves_exact_bytes_digest_and_text(self):
        value = payload()
        context = self.parse(value)
        encoded, digest = canonical_research_chat_human_context_v1(
            context, codec=CodecFixture())
        self.assertEqual(encoded, GOLDEN["canonicalJson"].encode("utf-8"))
        self.assertEqual(len(encoded), GOLDEN["canonicalUtf8Bytes"])
        self.assertEqual(digest, GOLDEN["sha256"])
        self.assertEqual(digest, "d92fee0db75f73ca2e9cb2d6b0504a2e59b2f0d4aba234eeb123c81e7ff289a0")
        self.assertEqual(json.loads(encoded), value)
        self.assertEqual(context.messages[0].body, value["messages"][0]["body"])
        self.assertIn("\r\nCafé\tΔ\n", context.messages[0].body)
        self.assertIn("\U0001d11e", context.messages[1].body)
        self.assertEqual(context.start_sequence, "9007199254740993")
        self.assertEqual(context.snapshot_revision, "9007199254740996")

    def test_every_level_rejects_missing_and_unknown_fields(self):
        for location in ((), ("messages", 0), ("messages", 0, "author")):
            for key in tuple(self._at(payload(), location)):
                with self.subTest(location=location, missing=key):
                    value = payload()
                    del self._at(value, location)[key]
                    self.assert_rejected(value)
            for extra in ("sha256", "execution_authorized", "evidence", "other"):
                with self.subTest(location=location, extra=extra):
                    value = payload()
                    self._at(value, location)[extra] = "not authority"
                    self.assert_rejected(value)

    @staticmethod
    def _at(value, path):
        for key in path:
            value = value[key]
        return value

    def test_all_wire_scalars_require_exact_strings_without_coercion(self):
        for location in ((), ("messages", 0), ("messages", 0, "author")):
            original = self._at(payload(), location)
            for key, field in original.items():
                if not isinstance(field, str):
                    continue
                for bad in (None, True, False, 1, 1.0, [], {}):
                    with self.subTest(location=location, key=key, bad=bad):
                        value = payload()
                        self._at(value, location)[key] = bad
                        self.assert_rejected(value)

    def test_wire_containers_are_exact_json_objects_and_arrays(self):
        for bad in (None, [], (), "{}", True, 1, self.parse(payload())):
            with self.subTest(root=type(bad).__name__):
                self.assert_rejected(bad)
        for bad in (None, {}, (), "[]", True):
            value = payload()
            value["messages"] = bad
            self.assert_rejected(value)
        for path in (("messages", 0), ("messages", 0, "author")):
            for bad in (None, [], "user", True):
                value = payload()
                self._at(value, path[:-1])[path[-1]] = bad
                self.assert_rejected(value)

    def test_python_subclasses_and_nonstring_keys_are_not_wire_scalars(self):
        class StringSubclass(str):
            pass

        class ObjectSubclass(dict):
            pass

        class ArraySubclass(list):
            pass

        self.assert_rejected(ObjectSubclass(payload()))
        value = payload()
        value["messages"] = ArraySubclass(value["messages"])
        self.assert_rejected(value)
        value = payload()
        value["persona_text"] = StringSubclass("literal")
        self.assert_rejected(value)
        value = payload()
        value[1] = "unknown"
        self.assert_rejected(value)

    def test_version_kind_and_environment_are_exact_and_research_only(self):
        for key, options in {
            "schema_version": ("1", "1.0.1", " 1.0.0"),
            "kind": ("research-chat-context", "evidence", "Research-chat-human-context"),
            "environment": ("paper", "live", "Research", "research "),
        }.items():
            for bad in options:
                with self.subTest(key=key, bad=bad):
                    value = payload()
                    value[key] = bad
                    self.assert_rejected(value)

    def test_identifier_pattern_is_exact_and_does_not_trim_or_normalize(self):
        locations = [((), key) for key in (
            "account_alias", "owner_actor_id", "response_request_id", "thread_id",
            "parent_message_id", "participant_id")]
        locations += [(("messages", 0), "message_id"),
                      (("messages", 0, "author"), "actor_id")]
        for path, key in locations:
            for bad in ("", "-leading", "_leading", "has space", "café", "x" * 161,
                        "trailing\n", "trailing\r", "trailing\u2028", "trailing\u2029"):
                with self.subTest(path=path, key=key, bad=bad):
                    value = payload()
                    self._at(value, path)[key] = bad
                    self.assert_rejected(value)
        value = payload()
        value["account_alias"] = "A" + "_.:-a0" * 26 + "xyz"
        self.assertEqual(len(value["account_alias"]), 160)
        self.assertEqual(self.parse(value).account_alias, value["account_alias"])

    def test_hash_fields_are_lowercase64hex_syntax_not_integrity_proofs(self):
        for path, key in (((), "participant_config_sha256"),
                          (("messages", 0), "record_sha256")):
            for bad in ("A" * 64, "a" * 63, "a" * 65, "g" * 64,
                        *("a" * 64 + suffix for suffix in ("\n", "\r", "\u2028", "\u2029"))):
                value = payload()
                self._at(value, path)[key] = bad
                self.assert_rejected(value)
        value = payload()
        value["participant_config_sha256"] = "0" * 64
        value["messages"][0]["record_sha256"] = "0" * 64
        self.assertEqual(self.parse(value).messages[0].record_sha256, "0" * 64)

    def test_author_is_human_owner_only_and_never_relabels_agent_rows(self):
        for bad in ("agent", "assistant", "system", "tool", "User"):
            value = payload()
            value["messages"][1]["author"]["kind"] = bad
            self.assert_rejected(value)
        for index in range(3):
            value = payload()
            value["messages"][index]["author"]["actor_id"] = "another-owner"
            self.assert_rejected(value)
        value = payload()
        value["owner_actor_id"] = "another-owner"
        self.assert_rejected(value)

    def test_one_to_sixteen_complete_rows_and_explicit_omitted_prefix(self):
        for count, start in ((1, 1), (16, 1), (1, 57), (16, 57)):
            value = window(count, start)
            context = self.parse(value)
            self.assertEqual(len(context.messages), count)
            self.assertEqual(context.start_sequence, str(start))
            self.assertEqual(context.messages[-1].sequence, context.high_water_sequence)
        for count in (0, 17):
            self.assert_rejected(window(count))

    def test_window_rejects_duplicates_gaps_reordering_parent_and_snapshot_mismatch(self):
        for change in ("duplicate-id", "gap", "reorder", "parent", "snapshot",
                       "start", "high-water", "drop", "append", "past-start"):
            with self.subTest(change=change):
                value = window(3, 10)
                if change == "duplicate-id":
                    value["messages"][1]["message_id"] = value["messages"][0]["message_id"]
                elif change == "gap":
                    value["messages"][1]["sequence"] = "12"
                elif change == "reorder":
                    value["messages"][0], value["messages"][1] = value["messages"][1], value["messages"][0]
                elif change == "parent":
                    value["parent_message_id"] = value["messages"][0]["message_id"]
                elif change == "snapshot":
                    value["snapshot_revision"] = "12"
                elif change == "start":
                    value["start_sequence"] = "9"
                elif change == "high-water":
                    value["high_water_sequence"] = "13"
                    value["snapshot_revision"] = "14"
                elif change == "drop":
                    del value["messages"][1]
                elif change == "append":
                    value["messages"].append(dict(value["messages"][-1], message_id="later", sequence="13"))
                else:
                    value["start_sequence"] = "14"
                self.assert_rejected(value)

    def test_ordinals_use_exact_positive30digit_decimal_strings(self):
        for path, key in (((), "start_sequence"), ((), "high_water_sequence"),
                          ((), "snapshot_revision"), (("messages", 0), "sequence")):
            for bad in ("0", "00", "01", "-1", "+1", "1.0", "1e3", " 1", "1\n",
                        "١", "１", "9" * 31, 9_007_199_254_740_993):
                with self.subTest(path=path, key=key, bad=bad):
                    value = payload()
                    self._at(value, path)[key] = bad
                    self.assert_rejected(value)
        maximum = 10 ** 30 - 1
        context = self.parse(window(1, maximum - 1))
        self.assertEqual(context.snapshot_revision, str(maximum))
        self.assert_rejected(window(1, maximum))
        value = payload()
        value["messages"][0]["sequence"] = "9007199254740992"
        self.assert_rejected(value)

    def test_utf16_body_persona_and_label_limits_include_supplementary_scalars(self):
        for path, key, limit in ((("messages", 0), "body", 8_000),
                                 ((), "persona_text", 4_000),
                                 ((), "participant_label", 160)):
            for exact in ("a" * limit, "\U0001d11e" * (limit // 2)):
                value = window(1)
                self._at(value, path)[key] = exact
                context = self.parse(value)
                actual = context.messages[0].body if key == "body" else getattr(context, key)
                self.assertEqual(actual, exact)
                self._at(value, path)[key] += "a"
                self.assert_rejected(value)
            value = window(1)
            self._at(value, path)[key] = "a" * (limit - 1) + "\U0001d11e"
            self.assert_rejected(value)

    def test_multiline_preserves_cr_lf_tab_and_does_not_normalize_unicode(self):
        literal = " \ufeffCafé e\u0301\r\n\t\r\n\U0001d11e\u2028\u2029 \ufeff"
        value = payload()
        value["persona_text"] = literal
        value["messages"][0]["body"] = literal
        value["participant_label"] = " Café e\u0301\u2028\u2029 "
        context = self.parse(value)
        self.assertEqual(context.persona_text, literal)
        self.assertEqual(context.messages[0].body, literal)
        self.assertEqual(context.participant_label, value["participant_label"])
        encoded, _ = canonical_research_chat_human_context_v1(context, codec=CodecFixture())
        self.assertEqual(json.loads(encoded), value)
        for char in ("\t", "\n", "\r"):
            value["participant_label"] = "label" + char
            self.assert_rejected(value)

    def test_blank_matches_ecmascript_trim_including_bom_not_python_strip(self):
        blanks = ("", " ", "\ufeff", "\u00a0", "\u1680", "\u2000", "\u2001", "\u2002",
                  "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009",
                  "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", " \r\n\t\ufeff")
        for path, key in ((("messages", 0), "body"), ((), "persona_text"), ((), "participant_label")):
            for blank in blanks:
                value = payload()
                self._at(value, path)[key] = blank
                self.assert_rejected(value)
            for literal in ("\u180e", "\u200b", "\u2060"):
                value = payload()
                self._at(value, path)[key] = literal
                self.parse(value)

    def test_disallowed_controls_bidi_and_unpaired_surrogates_fail_closed(self):
        forbidden = [point for point in range(32) if point not in (9, 10, 13)]
        forbidden += list(range(0x7f, 0xa0))
        forbidden += [0x061c, 0x200e, 0x200f, *range(0x202a, 0x202f),
                      *range(0x2066, 0x206a), 0xd800, 0xdbff, 0xdc00, 0xdfff]
        for path, key in ((("messages", 0), "body"), ((), "persona_text"), ((), "participant_label")):
            for point in forbidden:
                with self.subTest(key=key, point=hex(point)):
                    value = payload()
                    self._at(value, path)[key] = "visible" + chr(point)
                    self.assert_rejected(value)

    def test_exact_entire_canonical_byte_limit_and_one_byte_over(self):
        value = byte_limit_payload()
        context = self.parse(value)
        encoded, _ = canonical_research_chat_human_context_v1(context, codec=CodecFixture())
        self.assertEqual(len(encoded), 65_536)
        value["messages"][-1]["body"] += "x"
        self.assertEqual(len(CodecFixture().encode(value)), 65_537)
        self.assert_rejected(value, "chat-context-too-large")
        oversized = replace(context, persona_text=context.persona_text + "x")
        with self.assertRaises(AgentFault) as raised:
            canonical_research_chat_human_context_v1(oversized, codec=CodecFixture())
        self.assertEqual(raised.exception.code, "chat-context-too-large")

    def test_utf8_and_json_escaping_overhead_count_not_only_text_length(self):
        for count, body in ((3, "\u0800" * 8_000), (5, "\r" * 7_999 + "x")):
            value = window(count)
            for message in value["messages"]:
                message["body"] = body
            self.assertLess(sum(len(message["body"]) for message in value["messages"]), 65_536)
            self.assertGreater(len(CodecFixture().encode(value)), 65_536)
            self.assert_rejected(value, "chat-context-too-large")

    def test_input_mutation_cannot_change_output_or_later_digest(self):
        value = payload()
        context = self.parse(value)
        before = canonical_research_chat_human_context_v1(context, codec=CodecFixture())
        value["owner_actor_id"] = "changed-owner"
        value["messages"][0]["body"] = "changed-body"
        value["messages"][0]["author"]["actor_id"] = "changed-author"
        value["messages"].clear()
        self.assertEqual(canonical_research_chat_human_context_v1(context, codec=CodecFixture()), before)
        self.assertEqual(len(context.messages), 3)
        self.assertEqual(context.messages[0].author.actor_id, "fixture-owner")

    def test_output_is_nested_frozen_typed_data_without_mutable_aliases(self):
        context = self.parse(payload())
        self.assertIs(type(context), ResearchChatHumanContextV1)
        self.assertIs(type(context.messages), tuple)
        self.assertIs(type(context.messages[0]), ResearchChatHumanMessageV1)
        self.assertIs(type(context.messages[0].author), ResearchChatHumanAuthorV1)
        for value, name in ((context, "persona_text"), (context.messages[0], "body"),
                            (context.messages[0].author, "actor_id")):
            with self.assertRaises(FrozenInstanceError):
                setattr(value, name, "changed")
            self.assertFalse(hasattr(value, "__dict__"))
        with self.assertRaises(TypeError):
            context.messages[0] = context.messages[1]
        with self.assertRaises(AgentFault):
            replace(context, messages=list(context.messages))
        with self.assertRaises(AgentFault):
            replace(context.messages[0], author={"kind": "user", "actor_id": "fixture-owner"})
        with self.assertRaises(AgentFault):
            replace(context.messages[0].author, actor_id=[])

    def test_canonical_helper_revalidates_typed_structure_and_never_accepts_raw_wire(self):
        with self.assertRaises(AgentFault):
            canonical_research_chat_human_context_v1(payload(), codec=CodecFixture())
        context = self.parse(payload())
        object.__setattr__(context.messages[0].author, "kind", "agent")
        with self.assertRaises(AgentFault):
            canonical_research_chat_human_context_v1(context, codec=CodecFixture())

    def test_no_codec_default_and_all_helpers_check_digest_integrity(self):
        with self.assertRaises(TypeError):
            parse_research_chat_human_context_v1(payload())
        context = self.parse(payload())
        with self.assertRaises(TypeError):
            canonical_research_chat_human_context_v1(context)

        class TamperedCodec(CodecFixture):
            def digest(self, value):
                return "0" * 64

        for call in (lambda: parse_research_chat_human_context_v1(payload(), codec=TamperedCodec()),
                     lambda: canonical_research_chat_human_context_v1(context, codec=TamperedCodec())):
            with self.assertRaises(AgentFault) as raised:
                call()
            self.assertEqual(raised.exception.code, "canonical-codec-mismatch")

    def test_codec_must_return_bytes_valid_utf8_and_matching_lowercase_digest(self):
        class ReturnedCodec:
            def __init__(self, encoded, digest):
                self.encoded, self.hash = encoded, digest

            def encode(self, value):
                return self.encoded

            def digest(self, value):
                return self.hash

        good_bytes = GOLDEN["canonicalJson"].encode("utf-8")
        good_hash = GOLDEN["sha256"]
        for encoded, digest in ((good_bytes.decode(), good_hash), (bytearray(good_bytes), good_hash),
                                (good_bytes, good_hash.upper()), (good_bytes, None),
                                (b"\xff", sha256(b"\xff").hexdigest())):
            with self.subTest(encoded_type=type(encoded).__name__, digest=digest):
                with self.assertRaises(AgentFault) as raised:
                    parse_research_chat_human_context_v1(payload(), codec=ReturnedCodec(encoded, digest))
                self.assertEqual(raised.exception.code, "canonical-codec-mismatch")

    def test_codec_receives_detached_exact_wire_and_no_hidden_authority_fields(self):
        class RecordingCodec(CodecFixture):
            def __init__(self):
                self.values = []

            def encode(self, value):
                self.values.append(value)
                return super().encode(value)

        value = payload()
        codec = RecordingCodec()
        context = parse_research_chat_human_context_v1(value, codec=codec)
        self.assertTrue(codec.values)
        self.assertTrue(all(wire == value and wire is not value for wire in codec.values))
        wire = codec.values[0]
        self.assertIs(type(wire["messages"]), list)
        self.assertIsNot(wire["messages"], value["messages"])
        wire["messages"][0]["author"]["actor_id"] = "mutated-codec-copy"
        self.assertEqual(context.messages[0].author.actor_id, "fixture-owner")
        self.assertEqual({field.name for field in fields(context)}, set(value))
        for forbidden in ("sha256", "execution_authorized", "evidence", "job_id", "run_id",
                          "authorized", "ready", "citations", "model_request"):
            self.assertFalse(hasattr(context, forbidden))
        self.assertEqual(context.persona_text, value["persona_text"])
