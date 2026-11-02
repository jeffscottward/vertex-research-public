import { describe, expect, it } from "vitest";
import * as shared from "@darkfactory/shared/vertex";
import {
  syncHashArtifact,
  withSyncHashArtifact,
} from "./vertex-sync-hash.test-support.ts";

const substitute = syncHashArtifact(shared.canonicalArtifactJson);
const outcome = async (
  hash: (value: unknown) => Promise<string>,
  value: unknown
): Promise<{ hash: string } | { error: string; message: string }> => {
  try {
    return { hash: await hash(value) };
  } catch (error) {
    const failure = error as Error;
    return { error: failure.name, message: failure.message };
  }
};

describe("synchronous hashArtifact test substitute", () => {
  it.each([
    ["empty string", ""],
    ["ascii string", "fixture"],
    ["non-ascii string", "naïve café ✓ 中文"],
    ["astral string", "emoji 😀 pair"],
    ["escaped surrogate text", "\\ud800 is just text"],
    ["empty bytes", new Uint8Array()],
    ["bytes", new Uint8Array([0, 1, 2, 254, 255])],
    ["empty record", {}],
    ["empty array", []],
    ["null", null],
    ["boolean", true],
    ["safe integer", 9_007_199_254_740_991],
    ["negative integer", -42],
    [
      "nested record",
      {
        z: [1, "two", { three: null, "😀": false }],
        a: { b: "c", "\u00e9": "é" },
        "": [],
      },
    ],
    ["lone high surrogate string", "bad \ud800 scalar"],
    ["lone low surrogate string", "\udfff"],
    ["record with lone surrogate value", { value: "x\ud800" }],
    ["record with lone surrogate key", { "k\udc00": 1 }],
    ["fractional number", 1.5],
    ["negative zero", -0],
    ["undefined", undefined],
    ["class instance", new Date(0)],
  ])("matches the real hashArtifact for %s", async (_label, value) => {
    const expected = await outcome(shared.hashArtifact, value);
    expect(await outcome(substitute, value)).toEqual(expected);
    // The second call takes a kept digest; rejected texts are never kept.
    expect(await outcome(substitute, value)).toEqual(expected);
  });

  it("matches the real hashArtifact while the kept digests are dropped", async () => {
    const small = syncHashArtifact(shared.canonicalArtifactJson, 8);
    const values = ["abc", { a: 1 }, "abc", "longer than eight", "abc", ["x"]];
    for (const value of values)
      expect(await small(value)).toBe(await shared.hashArtifact(value));
  });

  it("matches a pinned SHA-256 digest", async () => {
    expect(await substitute("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("replaces only hashArtifact in the mocked module", () => {
    const mocked = withSyncHashArtifact(shared);
    expect(mocked.hashArtifact).not.toBe(shared.hashArtifact);
    for (const [key, value] of Object.entries(shared))
      if (key !== "hashArtifact") expect(Reflect.get(mocked, key)).toBe(value);
  });
});
