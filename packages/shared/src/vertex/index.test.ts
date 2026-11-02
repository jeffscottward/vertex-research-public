import { describe, expect, it } from "vitest";

import {
  canonicalArtifactJson,
  compareDecimals,
  decimalUnits,
  deepFreezeArtifact,
  hashArtifact,
  serverSha256,
  sha256Hex,
  isTickAligned,
  timestampToEpochNanoseconds,
  verifyArtifactHash,
} from "./index.ts";

describe("Vertex canonical artifacts", () => {
  it("encodes JSON scalars, dense arrays and shared plain records without changing order", () => {
    const leaf = Object.assign(Object.create(null), {
      label: "café",
      amount: "0.1",
    });
    expect(canonicalArtifactJson(null)).toBe("null");
    expect(canonicalArtifactJson(true)).toBe("true");
    expect(canonicalArtifactJson(false)).toBe("false");
    expect(canonicalArtifactJson(0)).toBe("0");
    expect(canonicalArtifactJson(Number.MAX_SAFE_INTEGER)).toBe(
      "9007199254740991"
    );
    expect(canonicalArtifactJson(-Number.MAX_SAFE_INTEGER)).toBe(
      "-9007199254740991"
    );
    expect(canonicalArtifactJson([leaf, leaf, null, false])).toBe(
      '[{"amount":"0.1","label":"café"},{"amount":"0.1","label":"café"},null,false]'
    );
    expect(canonicalArtifactJson([])).toBe("[]");
    expect(canonicalArtifactJson({})).toBe("{}");
    expect(
      canonicalArtifactJson({ 𐀀: 4, "\ue000": 3, ab: 2, a: 1, "": 0 })
    ).toBe('{"":0,"a":1,"ab":2,"\ue000":3,"𐀀":4}');
    return expect(canonicalArtifactJson('\n\t"\\')).toBe('"\\n\\t\\"\\\\"');
  });

  it("rejects unsupported values before freezing any part of the caller graph", () => {
    for (const value of [undefined, 1n, Symbol("fixture"), () => 1]) {
      expect(() => canonicalArtifactJson(value)).toThrow(
        "Artifact must be JSON data"
      );
    }
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0,
      0.1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => canonicalArtifactJson(value)).toThrow(
        "Artifact numbers must be safe integers"
      );
    }
    for (const value of ["\ud800", "\udfff", { "\ud800": "invalid key" }]) {
      expect(() => canonicalArtifactJson(value)).toThrow(
        "Invalid Unicode scalar"
      );
    }
    const leaf = { nested: [1] };
    const graph = { first: leaf, unsupported: undefined };
    expect(() => deepFreezeArtifact(graph)).toThrow(
      "Artifact must be JSON data"
    );
    expect(Object.isFrozen(graph)).toBe(false);
    expect(Object.isFrozen(leaf)).toBe(false);
    return expect(Object.isFrozen(leaf.nested)).toBe(false);
  });

  it("rejects cycles, nonplain objects, hidden keys, symbols and accessors without invoking them", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() => canonicalArtifactJson(cycle)).toThrow("Cyclic artifact");
    expect(() => canonicalArtifactJson(new Date(0))).toThrow(
      "Artifact must contain plain records"
    );
    expect(() =>
      canonicalArtifactJson(Object.defineProperty({}, "hidden", { value: 1 }))
    ).toThrow("Artifact must not contain hidden properties");
    expect(() => canonicalArtifactJson({ [Symbol("fixture")]: 1 })).toThrow(
      "Artifact must not contain symbol keys"
    );
    let accesses = 0;
    const getter = () => {
      accesses += 1;
      return "not-data";
    };
    const record = Object.defineProperty({}, "value", {
      enumerable: true,
      get: getter,
    });
    const array = Object.defineProperty([1], "0", {
      enumerable: true,
      get: getter,
    });
    expect(() => canonicalArtifactJson(record)).toThrow(
      "Artifact must not contain accessors"
    );
    expect(() => canonicalArtifactJson(array)).toThrow(
      "Sparse array or accessor"
    );
    expect(accesses).toBe(0);
    expect(() => canonicalArtifactJson(new Array(1))).toThrow(
      "Sparse or decorated array"
    );
    expect(() =>
      canonicalArtifactJson(Object.assign([1], { extra: 2 }))
    ).toThrow("Sparse or decorated array");
    expect(() =>
      canonicalArtifactJson(Object.defineProperty([1], "hidden", { value: 2 }))
    ).toThrow("Decorated array");
    const disguisedSparse = Object.assign(new Array(1), { extra: 1 });
    expect(() => canonicalArtifactJson(disguisedSparse)).toThrow(
      "Sparse array or accessor"
    );
    // An earlier element's own error keeps precedence over a later accessor.
    const laterAccessor = Object.defineProperty([1, 2], "1", {
      enumerable: true,
      get: getter,
    });
    expect(() => canonicalArtifactJson(laterAccessor)).toThrow(
      "Sparse array or accessor"
    );
    const earlierError = Object.defineProperty([{ bad: undefined }, 2], "1", {
      enumerable: true,
      get: getter,
    });
    expect(() => canonicalArtifactJson(earlierError)).toThrow(
      "Artifact must be JSON data"
    );
    return expect(accesses).toBe(0);
  });

  it("encodes records with more distinct keys than the key cache holds", () => {
    const wide: Record<string, number> = {};
    for (let index = 4200; index >= 0; index -= 1) wide[`k${index}`] = index;
    const expected = `{${Object.keys(wide)
      .sort()
      .map((key) => `"${key}":${wide[key]}`)
      .join(",")}}`;
    expect(canonicalArtifactJson(wide)).toBe(expected);
    return expect(canonicalArtifactJson(wide)).toBe(expected);
  });

  it("checks an earlier key's accessor before a later key's Unicode", () => {
    const record = Object.defineProperty({ "\ud800": 1 }, "a", {
      enumerable: true,
      get: () => 1,
    });
    return expect(() => canonicalArtifactJson(record)).toThrow(
      "Artifact must not contain accessors"
    );
  });

  it("keeps an escaped backslash before 'ud' as ordinary text", () => {
    expect(canonicalArtifactJson("\\ud800")).toBe('"\\\\ud800"');
    return expect(canonicalArtifactJson({ "\\udfff": "\\ud83d" })).toBe(
      '{"\\\\udfff":"\\\\ud83d"}'
    );
  });

  it("freezes shared descendants even when their parent was already shallow-frozen", () => {
    const leaf = { values: [null, true, "retained", 1] };
    const parent = Object.freeze({ first: leaf, second: leaf });
    const frozen = deepFreezeArtifact(parent);
    expect(frozen).toBe(parent);
    expect(frozen.first).toBe(frozen.second);
    expect(Object.isFrozen(frozen.first)).toBe(true);
    expect(Object.isFrozen(frozen.first.values)).toBe(true);
    expect(Reflect.set(frozen.first.values, 2, "changed")).toBe(false);
    expect(deepFreezeArtifact(null)).toBeNull();
    return expect(deepFreezeArtifact("scalar")).toBe("scalar");
  });

  return it("hashes raw UTF-8 and exact byte views rather than quoted strings or backing buffers", async () => {
    const abcDigest =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const bytes = new Uint8Array([0, 97, 98, 99, 255]).subarray(1, 4);
    expect(await hashArtifact("abc")).toBe(abcDigest);
    expect(await hashArtifact(bytes)).toBe(abcDigest);
    expect(await hashArtifact(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(await hashArtifact({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
    expect(await hashArtifact({ a: 1, b: 2 })).toBe(
      await hashArtifact({ b: 2, a: 1 })
    );
    expect(await hashArtifact([1, 2])).not.toBe(await hashArtifact([2, 1]));
    expect(await hashArtifact("abc")).not.toBe(await hashArtifact(["abc"]));
    expect(await hashArtifact("café 𐀀")).toBe(
      await hashArtifact(new TextEncoder().encode("café 𐀀"))
    );
    expect(await verifyArtifactHash(bytes, abcDigest)).toBe(true);
    expect(await verifyArtifactHash("changed", abcDigest)).toBe(false);
    expect(await verifyArtifactHash(undefined, "invalid")).toBe(false);
    expect(await verifyArtifactHash("abc", abcDigest.toUpperCase())).toBe(
      false
    );
    await expect(hashArtifact("\ud800")).rejects.toThrow(
      "Invalid Unicode scalar"
    );
    return await expect(hashArtifact({ value: undefined })).rejects.toThrow(
      "Artifact must be JSON data"
    );
  });
});

describe("Vertex exact numeric primitives", () => {
  it("retains signed bounded decimal precision without binary floating point", () => {
    expect(decimalUnits("0")).toBe(0n);
    expect(decimalUnits("1")).toBe(1_000_000_000_000_000_000n);
    expect(decimalUnits("-1")).toBe(-1_000_000_000_000_000_000n);
    expect(decimalUnits("0.000000000000000001")).toBe(1n);
    expect(decimalUnits("-0.000000000000000001")).toBe(-1n);
    expect(
      decimalUnits("999999999999999999999999999999.999999999999999999")
    ).toBe(10n ** 48n - 1n);
    expect(
      compareDecimals(
        "9007199254740993.000000000000000001",
        "9007199254740993.000000000000000002"
      )
    ).toBe(-1);
    expect(compareDecimals("-0.1", "-0.2")).toBe(1);
    expect(compareDecimals("-0.1", "-0.1")).toBe(0);
    expect(isTickAligned("0.3", "0.1")).toBe(true);
    expect(isTickAligned("0.300000000000000001", "0.1")).toBe(false);
    expect(isTickAligned("1", "0")).toBe(false);
    expect(isTickAligned("1", "-0.1")).toBe(false);
    for (const value of [
      "-0",
      "01",
      "1.0",
      ".1",
      "1e3",
      "NaN",
      "Infinity",
      " 1",
      "1.",
      "1000000000000000000000000000000",
      "0.0000000000000000001",
    ]) {
      expect(() => decimalUnits(value)).toThrow(
        "Expected a canonical bounded decimal string"
      );
    }
    for (const terminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      expect(() => decimalUnits(`1${terminator}`)).toThrow(
        "Expected a canonical bounded decimal string"
      );
    }
    return;
  });

  return it("uses proleptic Gregorian leap years and signed exact nanoseconds", () => {
    expect(timestampToEpochNanoseconds("1970-01-01T00:00:00Z")).toBe(0n);
    expect(timestampToEpochNanoseconds("1969-12-31T23:59:59.999999999Z")).toBe(
      -1n
    );
    expect(
      timestampToEpochNanoseconds("1970-01-01T01:30:00.000000001+01:30")
    ).toBe(1n);
    expect(
      timestampToEpochNanoseconds("1969-12-31T22:30:00.000000001-01:30")
    ).toBe(1n);
    expect(timestampToEpochNanoseconds("1970-01-01T00:00:00.1-00:00")).toBe(
      100_000_000n
    );
    expect(timestampToEpochNanoseconds("0000-01-01T00:00:00Z")).toBe(
      -62_167_219_200_000_000_000n
    );
    expect(timestampToEpochNanoseconds("9999-12-31T23:59:59.999999999Z")).toBe(
      253_402_300_799_999_999_999n
    );
    for (const year of ["0000", "2000", "2024"]) {
      expect(
        timestampToEpochNanoseconds(`${year}-03-01T00:00:00Z`) -
          timestampToEpochNanoseconds(`${year}-02-28T00:00:00Z`)
      ).toBe(172_800_000_000_000n);
    }
    for (const year of ["1900", "2026"]) {
      expect(
        timestampToEpochNanoseconds(`${year}-03-01T00:00:00Z`) -
          timestampToEpochNanoseconds(`${year}-02-28T00:00:00Z`)
      ).toBe(86_400_000_000_000n);
      expect(() =>
        timestampToEpochNanoseconds(`${year}-02-29T00:00:00Z`)
      ).toThrow("Invalid Gregorian calendar date");
    }
    for (const value of [
      "1970-01-01T00:00Z",
      "1970-01-01T00:00:00Z\n",
      "1970-01-01T00:00:00.0000000001Z",
      "1970-01-01T00:00:60Z",
      "1970-01-01T00:00:00+24:00",
    ]) {
      expect(() => timestampToEpochNanoseconds(value)).toThrow(
        "Expected a seconds-qualified timestamp"
      );
    }
    return expect(() =>
      timestampToEpochNanoseconds("2026-04-31T00:00:00Z")
    ).toThrow("Invalid Gregorian calendar date");
  });
});

describe("sha256Hex server and browser paths", () => {
  it("gives identical digests for strings and bytes on both paths", async () => {
    const nodeCrypto = process.getBuiltinModule("node:crypto");
    const inputs = [
      new TextEncoder().encode("abc"),
      new TextEncoder().encode('{"a":1,"b":"\u00e9"}'),
      Uint8Array.from([0, 255, 1, 128]),
      new Uint8Array(),
    ];
    for (const bytes of inputs) {
      const server = await sha256Hex(bytes, nodeCrypto);
      expect(server).toBe(await sha256Hex(bytes, null));
      expect(server).toBe(await sha256Hex(bytes));
    }
    expect(serverSha256({})).toBeNull();
    expect(serverSha256({ process: {} })).toBeNull();
    expect(
      serverSha256({ window: {}, process: globalThis.process })
    ).toBeNull();
    expect(serverSha256()).not.toBeNull();
    expect(await sha256Hex(new TextEncoder().encode("abc"), null)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
