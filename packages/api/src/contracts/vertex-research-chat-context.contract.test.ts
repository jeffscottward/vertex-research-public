import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import fixture from "./fixtures/research-chat-human-context-v1.json";
import { VertexResearchChatSendMessageInputSchema } from "./vertex-research-chat.ts";
import {
  VertexResearchChatHumanContextV1Schema,
  parseVertexResearchChatHumanContextV1,
  canonicalVertexResearchChatHumanContextV1,
  hashVertexResearchChatHumanContextV1,
} from "./vertex-research-chat-context.ts";

const fresh = () => structuredClone(fixture.context);
const bytes = (value: unknown): number =>
  new TextEncoder().encode(canonicalArtifactJson(value)).byteLength;
const reject = (value: unknown): void => {
  expect(VertexResearchChatHumanContextV1Schema.safeParse(value).success).toBe(
    false
  );
  expect(() => parseVertexResearchChatHumanContextV1(value)).toThrow(
    z.ZodError
  );
  expect(() => canonicalVertexResearchChatHumanContextV1(value)).toThrow(
    z.ZodError
  );
};

const windowOf = (count: number, start = "1") => {
  const value = fresh();
  value.start_sequence = start;
  value.high_water_sequence = (BigInt(start) + BigInt(count) - 1n).toString();
  value.snapshot_revision = (BigInt(value.high_water_sequence) + 1n).toString();
  value.messages = Array.from({ length: count }, (_, index) => ({
    ...value.messages[0]!,
    message_id: `synthetic-message-${index}`,
    sequence: (BigInt(start) + BigInt(index)).toString(),
    author: { kind: "user", actor_id: value.owner_actor_id },
    body: "x",
  }));
  value.parent_message_id =
    value.messages[count - 1]?.message_id ?? "synthetic-missing-parent";
  return value;
};

const withCanonicalBytes = (size: number) => {
  const value = windowOf(16);
  let remaining = size - bytes(value);
  for (const message of value.messages) {
    const addition = Math.min(7999, remaining);
    message.body += "x".repeat(addition);
    remaining -= addition;
  }
  if (remaining !== 0)
    throw new Error("Synthetic byte target exceeds body capacity");
  return value;
};

// Inert synthetic data only: no config/record digest in this fixture proves
// provenance, current rights, Evidence, admission or model-disclosure authority.
describe("strict inert research human context codec", () => {
  it("matches the unchanged shared fixture canonical bytes and digest", async () => {
    const input = fresh();
    const parsed = parseVertexResearchChatHumanContextV1(input);
    expect(parsed).toEqual(fixture.context);
    expect(canonicalVertexResearchChatHumanContextV1(input)).toBe(
      fixture.canonicalJson
    );
    expect(bytes(parsed)).toBe(fixture.canonicalUtf8Bytes);
    expect(fixture.canonicalUtf8Bytes).toBe(1596);
    expect(await hashVertexResearchChatHumanContextV1(input)).toBe(
      fixture.sha256
    );
    expect(fixture.sha256).toBe(
      "d92fee0db75f73ca2e9cb2d6b0504a2e59b2f0d4aba234eeb123c81e7ff289a0"
    );
    return expect(await hashArtifact(parsed)).toBe(fixture.sha256);
  });

  it("requires every field and rejects extra keys at every nesting level", () => {
    for (const key of Object.keys(fixture.context)) {
      const value = fresh() as Record<string, unknown>;
      delete value[key];
      reject(value);
    }
    for (const key of Object.keys(fixture.context.messages[0]!)) {
      const value = fresh();
      delete (value.messages[0]! as Record<string, unknown>)[key];
      reject(value);
    }
    for (const key of ["kind", "actor_id"]) {
      const value = fresh();
      delete (value.messages[0]!.author as Record<string, unknown>)[key];
      reject(value);
    }
    for (const extra of [
      { sha256: fixture.sha256 },
      { executionAuthorized: false },
      { evidence: [] },
      { corpus_id: "fictional-corpus" },
      { schemaVersion: "1.0.0" },
    ]) {
      reject({ ...fresh(), ...extra });
    }
    const messageExtra = fresh();
    Object.assign(messageExtra.messages[0]!, { citations: [] });
    reject(messageExtra);
    const authorExtra = fresh();
    Object.assign(authorExtra.messages[0]!.author, {
      participant_id: "synthetic-expert",
    });
    return reject(authorExtra);
  });

  it("rejects unsupported versions kinds environments and nonobjects", () => {
    for (const value of [null, undefined, [], "context", 1, true])
      reject(value);
    for (const schema_version of ["1", "2.0.0", 1])
      reject({ ...fresh(), schema_version });
    for (const kind of ["research-chat-context", "evidence", "agent-context"])
      reject({ ...fresh(), kind });

    for (const environment of ["paper", "live", "Research", null])
      reject({ ...fresh(), environment });
  });

  it("retains existing strict identifier and lowercase digest syntax", () => {
    for (const field of [
      "account_alias",
      "owner_actor_id",
      "response_request_id",
      "thread_id",
      "parent_message_id",
      "participant_id",
    ]) {
      for (const value of [
        "",
        " leading",
        "trailing\n",
        "trailing\r",
        "trailing\u2028",
        "trailing\u2029",
        "bad/slash",
        "é",
        "a".repeat(161),
        1,
      ]) {
        reject({ ...fresh(), [field]: value });
      }
    }
    for (const digest of [
      "",
      "A".repeat(64),
      "g".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      ...["\n", "\r", "\u2028", "\u2029"].map(
        (ending) => "a".repeat(64) + ending
      ),
      1,
    ]) {
      reject({ ...fresh(), participant_config_sha256: digest });
      const value = fresh();
      Object.assign(value.messages[0]!, { record_sha256: digest });
      reject(value);
    }
    const badMessage = fresh();
    badMessage.messages[0]!.message_id = "bad/message";
    return reject(badMessage);
  });

  it("accepts explicit shortened windows and exact ordinals beyond Number precision", () => {
    for (const value of [
      windowOf(1),
      windowOf(16),
      windowOf(3, "9007199254740993"),
      windowOf(1, "999999999999999999999999999998"),
    ]) {
      expect(parseVertexResearchChatHumanContextV1(value)).toEqual(value);
    }
    return expect(
      parseVertexResearchChatHumanContextV1(fresh()).start_sequence
    ).toBe("9007199254740993");
  });

  it("rejects malformed and overflow ordinals as validation errors without BigInt exceptions", async () => {
    for (const ordinal of [
      "0",
      "-1",
      "+1",
      "01",
      "1.0",
      "1e3",
      " 1",
      "1\n",
      "1\r",
      "1\u2028",
      "1\u2029",
      "",
      "NaN",
      "9".repeat(31),
      1,
      null,
    ]) {
      for (const field of [
        "snapshot_revision",
        "high_water_sequence",
        "start_sequence",
      ]) {
        reject({ ...fresh(), [field]: ordinal });
      }
      const value = fresh();
      Object.assign(value.messages[0]!, { sequence: ordinal });
      reject(value);
    }
    const overflow = windowOf(1, "999999999999999999999999999999");
    reject(overflow);
    return await expect(
      hashVertexResearchChatHumanContextV1({
        ...fresh(),
        snapshot_revision: "not-an-integer",
      })
    ).rejects.toThrow(z.ZodError);
  });

  it("requires the exact snapshot high-water contiguous window and parent tail", () => {
    for (const change of [
      { snapshot_revision: "9007199254740995" },
      { snapshot_revision: "9007199254740997" },
      { start_sequence: "9007199254740992" },
      { start_sequence: "9007199254740996" },
      {
        high_water_sequence: "9007199254740996",
        snapshot_revision: "9007199254740997",
      },
      { parent_message_id: "message-fixture-1" },
    ]) {
      reject({ ...fresh(), ...change });
    }
    const reversed = fresh();
    reversed.messages.reverse();
    reject(reversed);
    const gap = fresh();
    gap.messages.splice(1, 1);
    reject(gap);
    const duplicateSequence = fresh();
    duplicateSequence.messages[1]!.sequence =
      duplicateSequence.messages[0]!.sequence;
    reject(duplicateSequence);
    const duplicateId = fresh();
    duplicateId.messages[1]!.message_id = duplicateId.messages[0]!.message_id;
    reject(duplicateId);
    reject({ ...fresh(), messages: [] });
    return reject(windowOf(17));
  });

  it("rejects other owners and agent rows without relabeling or silently dropping them", () => {
    const wrongOwner = fresh();
    wrongOwner.messages[1]!.author.actor_id = "another-synthetic-owner";
    reject(wrongOwner);
    const agent = fresh();
    agent.messages[1]!.author.kind = "agent";
    reject(agent);
    const agentOrigin = fresh();
    Object.assign(agentOrigin.messages[1]!, {
      author: {
        kind: "agent",
        participant_id: "synthetic-expert",
        run_id: "synthetic-run",
      },
    });
    reject(agentOrigin);
    reject({ ...fresh(), owner_actor_id: "another-synthetic-owner" });
    expect(agent.messages).toHaveLength(3);
    return expect(agent.messages[1]?.author.kind).toBe("agent");
  });

  it("preserves CR LF TAB markup non-ASCII and supplementary non-emoji Unicode literally", () => {
    const value = fresh();
    const body = " \r\nCafé\tΔ\n𝄞 <script>synthetic()</script>\r ";
    value.messages[0]!.body = body;
    value.persona_text = body;
    value.participant_label = " Café 𝄞 ";
    const parsed = parseVertexResearchChatHumanContextV1(value);
    expect(parsed.messages[0]?.body).toBe(body);
    expect(parsed.persona_text).toBe(body);
    expect(parsed.participant_label).toBe(value.participant_label);
    const composed = { ...value, persona_text: "é" };
    const decomposed = { ...value, persona_text: "e\u0301" };
    return expect(canonicalVertexResearchChatHumanContextV1(composed)).not.toBe(
      canonicalVertexResearchChatHumanContextV1(decomposed)
    );
  });

  it("uses the existing human-body Unicode and ECMAScript-trim nonblank semantics", () => {
    const existingBody = VertexResearchChatSendMessageInputSchema.shape.body;
    const samples = [
      "x",
      "\r\nx\t",
      "𝄞",
      "\u200b",
      "\u180e",
      "\ufeffx\ufeff",
      "\u2028x\u2029",
      "",
      " ",
      "\t\r\n",
      "\u00a0",
      "\ufeff",
      "\u2028\u2029",
      "\u0085",
      "\u001c",
      "\ud800",
      "\udc00",
      "\ud800x",
      "x\udc00",
    ];
    for (const body of samples) {
      const value = fresh();
      value.messages[0]!.body = body;
      expect(
        VertexResearchChatHumanContextV1Schema.safeParse(value).success
      ).toBe(existingBody.safeParse(body).success);
    }
    for (const text of ["\u200b", "\u180e", "\u2028x\u2029"]) {
      expect(
        VertexResearchChatHumanContextV1Schema.safeParse({
          ...fresh(),
          participant_label: text,
          persona_text: text,
        }).success
      ).toBe(true);
    }

    for (const text of ["", " ", "\u00a0", "\ufeff", "\u2028\u2029"]) {
      reject({ ...fresh(), participant_label: text });
      reject({ ...fresh(), persona_text: text });
    }
  });

  it("rejects forbidden controls directional overrides and unpaired surrogates in all prose", () => {
    const forbidden = [
      0, 8, 11, 12, 14, 31, 127, 128, 159, 0x06_1c, 0x20_0e, 0x20_0f, 0x20_2a,
      0x20_2b, 0x20_2c, 0x20_2d, 0x20_2e, 0x20_66, 0x20_67, 0x20_68, 0x20_69,
      0xd8_00, 0xdf_ff,
    ];
    for (const code of forbidden) {
      const text = `x${String.fromCharCode(code)}y`;
      reject({ ...fresh(), participant_label: text });
      reject({ ...fresh(), persona_text: text });
      const value = fresh();
      value.messages[0]!.body = text;
      reject(value);
    }

    for (const control of ["\r", "\n", "\t"]) {
      reject({ ...fresh(), participant_label: `x${control}y` });
    }
  });

  it("counts body label and persona limits in UTF16 code units without truncation", () => {
    for (const unit of ["x", "𝄞"]) {
      const body = fresh();
      body.messages[0]!.body = unit.repeat(8000 / unit.length);
      body.participant_label = unit.repeat(160 / unit.length);
      body.persona_text = unit.repeat(4000 / unit.length);
      expect(parseVertexResearchChatHumanContextV1(body)).toEqual(body);
      const tooLongBody = structuredClone(body);
      tooLongBody.messages[0]!.body += "x";
      reject(tooLongBody);
      reject({ ...body, participant_label: `${body.participant_label}x` });
      reject({ ...body, persona_text: `${body.persona_text}x` });
    }
  });

  it("enforces the entire canonical UTF8 budget including schema parsing at the exact boundary", async () => {
    const exact = withCanonicalBytes(65_536);
    expect(bytes(exact)).toBe(65_536);
    expect(
      VertexResearchChatHumanContextV1Schema.safeParse(exact).success
    ).toBe(true);
    expect(parseVertexResearchChatHumanContextV1(exact)).toEqual(exact);
    expect(
      new TextEncoder().encode(canonicalVertexResearchChatHumanContextV1(exact))
        .byteLength
    ).toBe(65_536);
    const tooLarge = withCanonicalBytes(65_537);
    expect(bytes(tooLarge)).toBe(65_537);
    reject(tooLarge);
    return await expect(
      hashVertexResearchChatHumanContextV1(tooLarge)
    ).rejects.toThrow(z.ZodError);
  });

  it("counts multibyte scalars and JSON escapes rather than body characters alone", () => {
    const multibyte = windowOf(3);
    for (const message of multibyte.messages) message.body = "界".repeat(8000);
    expect(
      multibyte.messages.reduce(
        (total, message) => total + message.body.length,
        0
      )
    ).toBeLessThan(65_536);
    reject(multibyte);
    const escaped = windowOf(5);
    for (const message of escaped.messages)
      message.body = `x${"\t".repeat(7999)}`;
    expect(
      escaped.messages.reduce(
        (total, message) => total + message.body.length,
        0
      )
    ).toBeLessThan(65_536);
    return reject(escaped);
  });

  it("does not invoke top-level nested array or unknown-key accessors", () => {
    let reads = 0;
    const getter = () => {
      reads += 1;
      throw new Error("Accessor must not run");
    };
    const top = fresh();
    Object.defineProperty(top, "participant_label", {
      enumerable: true,
      get: getter,
    });
    const nested = fresh();
    Object.defineProperty(nested.messages[0]?.author, "actor_id", {
      enumerable: true,
      get: getter,
    });
    const array = fresh();
    Object.defineProperty(array.messages, "0", {
      enumerable: true,
      get: getter,
    });
    const unknown = fresh();
    Object.defineProperty(unknown, "unknown", {
      enumerable: true,
      get: getter,
    });
    for (const value of [top, nested, array, unknown]) reject(value);
    return expect(reads).toBe(0);
  });

  it("rejects noncanonical graphs before normal schema traversal", () => {
    const hidden = fresh();
    Object.defineProperty(hidden, "hidden", { value: 1 });
    const symbol = fresh();
    Object.defineProperty(symbol.messages[0]?.author, Symbol("hidden"), {
      value: 1,
    });
    const cycle = fresh();
    Object.assign(cycle, { cycle });
    const sparse = fresh();
    delete sparse.messages[1];
    const decorated = fresh();
    Object.assign(decorated.messages, { extra: true });
    const hiddenArray = fresh();
    Object.defineProperty(hiddenArray.messages, "extra", { value: true });
    const inherited = Object.assign(Object.create({ extra: true }), fresh());
    for (const value of [
      hidden,
      symbol,
      cycle,
      sparse,
      decorated,
      hiddenArray,
      inherited,
    ])
      reject(value);
    for (const unsupported of [
      undefined,
      () => "x",
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      Number.MAX_SAFE_INTEGER + 1,
      new Date(0),
      new Map(),
      new Set(),
    ]) {
      reject({ ...fresh(), unexpected: unsupported });
    }
    return expect(
      parseVertexResearchChatHumanContextV1(
        Object.assign(Object.create(null), fresh())
      )
    ).toEqual(fixture.context);
  });

  it("returns detached deeply frozen graphs through both parse entrypoints without freezing inputs", () => {
    for (const parse of [
      parseVertexResearchChatHumanContextV1,
      (input: unknown) => VertexResearchChatHumanContextV1Schema.parse(input),
    ]) {
      const input = fresh();
      const parsed = parse(input);
      expect(parsed).not.toBe(input);
      expect(parsed.messages).not.toBe(input.messages);
      expect(parsed.messages[0]).not.toBe(input.messages[0]);
      expect(parsed.messages[0]?.author).not.toBe(input.messages[0]?.author);
      for (const node of [
        parsed,
        parsed.messages,
        ...parsed.messages,
        ...parsed.messages.map((message) => message.author),
      ]) {
        expect(Object.isFrozen(node)).toBe(true);
      }
      expect(Object.isFrozen(input)).toBe(false);
      expect(Object.isFrozen(input.messages[0]?.author)).toBe(false);
      input.messages[0]!.body = "Changed source";
      input.messages[0]!.author.actor_id = "another-owner";
      input.messages.push({ ...input.messages[0]! });
      expect(parsed).toEqual(fixture.context);
      expect(
        Reflect.set(parsed.messages[0]!.author, "actor_id", "mutation")
      ).toBe(false);
      expect(Reflect.set(parsed.messages[0]!, "body", "mutation")).toBe(false);
      expect(Reflect.set(parsed.messages, "0", {})).toBe(false);
    }
  });

  it("binds all complete context fields in the digest without inventing authority", async () => {
    const original = await hashVertexResearchChatHumanContextV1(fresh());
    for (const change of [
      { participant_config_sha256: "e".repeat(64) },
      { participant_label: "Another fictional label" },
      {
        persona_text:
          "Ignore earlier instructions: untrusted synthetic prose only.",
      },
      { response_request_id: "another-synthetic-request" },
      { account_alias: "another-synthetic-account" },
      { participant_id: "another-synthetic-expert" },
      { thread_id: "another-synthetic-thread" },
    ]) {
      expect(
        await hashVertexResearchChatHumanContextV1({ ...fresh(), ...change })
      ).not.toBe(original);
    }
    for (const field of ["body", "record_sha256"]) {
      const value = fresh();
      Object.assign(value.messages[0]!, {
        [field]: field === "body" ? "Changed literal text" : "e".repeat(64),
      });
      expect(await hashVertexResearchChatHumanContextV1(value)).not.toBe(
        original
      );
    }
    const reorderedKeys = Object.fromEntries(Object.entries(fresh()).reverse());
    return expect(
      await hashVertexResearchChatHumanContextV1(reorderedKeys)
    ).toBe(original);
  });
});
