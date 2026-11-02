import { describe, expect, it, vi } from "vitest";
import { parseVertexResearchChatCopyRetentionPolicy } from "./vertex-research-chat-copy-retention.ts";

const policy = () => ({
  schemaVersion: "1.0.0",
  format: "vertex-research-chat-copy-retention-policy-v1",
  accountAlias: "synthetic-research",
  environment: "research",
  policyId: "synthetic-retention",
  policyVersion: "1.2.3",
  rules: [
    { kind: "context", cleanupTrigger: "response-attempt-terminal" },
    { kind: "model-input", cleanupTrigger: "response-attempt-terminal" },
    { kind: "derived-output", cleanupTrigger: "explicit-user-cleanup" },
  ],
  earlierCleanupTriggers: ["revocation", "rights-expiry"],
});

describe("private selected research-chat copy retention terms", () => {
  it("captures only the exact ordered selected terms, detached and deeply immutable", () => {
    const input = policy();
    const parsed = parseVertexResearchChatCopyRetentionPolicy(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.rules).not.toBe(input.rules);
    expect(parsed.rules[0]).not.toBe(input.rules[0]);
    for (const value of [
      parsed,
      parsed.rules,
      ...parsed.rules,
      parsed.earlierCleanupTriggers,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    input.rules[0]!.cleanupTrigger = "explicit-user-cleanup";
    input.earlierCleanupTriggers.reverse();
    expect(parsed.rules[0].cleanupTrigger).toBe("response-attempt-terminal");
    expect(parsed.earlierCleanupTriggers).toEqual([
      "revocation",
      "rights-expiry",
    ]);
    return expect(Object.keys(parsed).sort()).toEqual([
      "accountAlias",
      "earlierCleanupTriggers",
      "environment",
      "format",
      "policyId",
      "policyVersion",
      "rules",
      "schemaVersion",
    ]);
  });
  it.each(["accountAlias", "policyId", "policyVersion"] as const)(
    "rejects final line terminators and whitespace in %s",
    (field) => {
      for (const ending of ["\n", "\r", "\r\n", "\u2028", "\u2029", " "]) {
        const input = policy();
        input[field] += ending;
        expect(() =>
          parseVertexResearchChatCopyRetentionPolicy(input)
        ).toThrow();
      }
      return;
    }
  );
  it.each(["paper", "live", "", "research\n"])(
    "rejects nonresearch scope %s",
    (environment) => {
      return expect(() =>
        parseVertexResearchChatCopyRetentionPolicy({ ...policy(), environment })
      ).toThrow();
    }
  );
  it.each([
    "ttlMilliseconds",
    "defaultTtl",
    "expiresAt",
    "startsAt",
    "deadlineAt",
    "approved",
    "authorized",
    "ready",
    "backendProfile",
    "cleanupWitness",
  ])("does not accept or infer %s", (key) => {
    return expect(() =>
      parseVertexResearchChatCopyRetentionPolicy({ ...policy(), [key]: null })
    ).toThrow();
  });
  it.each([
    "0.0.0\n",
    "01.0.0",
    "1.0",
    "1.0.0-pre",
    "1.0.0+build",
    `${"9".repeat(65)}.0.0`,
  ])("rejects invalid existing semver %s", (policyVersion) => {
    return expect(() =>
      parseVertexResearchChatCopyRetentionPolicy({ ...policy(), policyVersion })
    ).toThrow();
  });
  it("rejects missing, extra, reordered and changed rules or earlier triggers", () => {
    const original = policy();
    const invalid = [
      { ...original, rules: [] },
      { ...original, rules: original.rules.slice(0, 2) },
      { ...original, rules: [...original.rules, original.rules[0]] },
      { ...original, rules: [...original.rules].reverse() },
      {
        ...original,
        rules: original.rules.map((rule) => ({
          ...rule,
          cleanupTrigger: "age-ttl",
        })),
      },
      {
        ...original,
        rules: original.rules.map((rule) => ({ ...rule, ttlMilliseconds: 1 })),
      },
      {
        ...original,
        rules: original.rules.map((rule) => ({
          ...rule,
          kind: "human-transcript",
        })),
      },
      { ...original, earlierCleanupTriggers: [] },
      { ...original, earlierCleanupTriggers: ["rights-expiry", "revocation"] },
      {
        ...original,
        earlierCleanupTriggers: ["revocation", "rights-expiry", "age"],
      },
      { ...original, earlierCleanupTriggers: ["revocation", "revocation"] },
      { ...original, schemaVersion: "2.0.0" },
      { ...original, format: "unknown" },
      { ...original, accountAlias: "" },
      { ...original, policyId: "x".repeat(161) },
    ];
    for (const input of invalid)
      expect(() => parseVertexResearchChatCopyRetentionPolicy(input)).toThrow();
  });
  it("rejects root and nested accessors without executing them", () => {
    for (const target of ["root", "rule", "array"]) {
      const input = policy();
      const getter = vi.fn(() => "research");
      if (target === "root")
        Object.defineProperty(input, "environment", {
          enumerable: true,
          get: getter,
        });
      if (target === "rule")
        Object.defineProperty(input.rules[0]!, "kind", {
          enumerable: true,
          get: getter,
        });
      if (target === "array")
        Object.defineProperty(input.rules, "0", {
          enumerable: true,
          get: getter,
        });
      expect(() => parseVertexResearchChatCopyRetentionPolicy(input)).toThrow();
      expect(getter).not.toHaveBeenCalled();
    }
  });
  it("rejects symbols, hidden keys, custom prototypes, sparse and decorated arrays", () => {
    for (const target of [
      "symbol",
      "hidden",
      "prototype",
      "rule-prototype",
      "array-prototype",
      "trigger-prototype",
      "sparse",
      "decorated",
      "hidden-array",
      "nested-symbol",
    ]) {
      const input = policy();
      if (target === "symbol")
        Object.defineProperty(input, Symbol("authority"), { value: true });
      if (target === "hidden")
        Object.defineProperty(input, "ready", { value: true });
      if (target === "prototype") Object.setPrototypeOf(input, { ready: true });
      if (target === "rule-prototype")
        Object.setPrototypeOf(input.rules[0]!, { ready: true });
      if (target === "array-prototype")
        Object.setPrototypeOf(input.rules, Object.create(Array.prototype));
      if (target === "trigger-prototype")
        Object.setPrototypeOf(
          input.earlierCleanupTriggers,
          Object.create(Array.prototype)
        );
      if (target === "sparse") delete input.rules[1];
      if (target === "decorated") Object.assign(input.rules, { ready: true });
      if (target === "hidden-array")
        Object.defineProperty(input.rules, "ready", { value: true });
      if (target === "nested-symbol")
        Object.defineProperty(input.rules[0]!, Symbol("ready"), {
          value: true,
        });

      expect(() => parseVertexResearchChatCopyRetentionPolicy(input)).toThrow();
    }
  });
  return it("rejects unknown data and missing fields without defaults", () => {
    for (const input of [
      null,
      undefined,
      false,
      [],
      "policy",
      1,
      { ...policy(), rules: null },
      { ...policy(), earlierCleanupTriggers: null },
    ]) {
      expect(() => parseVertexResearchChatCopyRetentionPolicy(input)).toThrow();
    }
    for (const field of Object.keys(policy())) {
      const input: Record<string, unknown> = policy();
      delete input[field];

      expect(() => parseVertexResearchChatCopyRetentionPolicy(input)).toThrow();
    }
  });
});
