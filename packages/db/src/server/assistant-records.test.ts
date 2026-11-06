import { describe, expect, it } from "vitest";

import {
  ASSISTANT_TOOL_TRACE_MAX,
  AssistantRecordInputError,
  normalizeAssistantContent,
  normalizeAssistantMode,
  normalizeAssistantRole,
  normalizeAssistantTokens,
  normalizeAssistantToolTrace,
} from "./assistant-records.ts";

const entry = { durationMs: 3, ok: true, tool: "chart_draw" };

describe("assistant record validation", () => {
  it("rejects unknown roles and modes and non-string content", () => {
    expect(() => normalizeAssistantRole("system")).toThrow(
      AssistantRecordInputError
    );
    expect(() => normalizeAssistantRole(1)).toThrow(/role must be one of/u);
    expect(() => normalizeAssistantMode("other")).toThrow(/mode must be/u);
    return expect(() => normalizeAssistantContent(5, "user")).toThrow(
      "content must be a string"
    );
  });

  it("rejects malformed tool traces", () => {
    expect(() => normalizeAssistantToolTrace("x")).toThrow(
      "toolCalls must be an array"
    );
    expect(() =>
      normalizeAssistantToolTrace(
        new Array(ASSISTANT_TOOL_TRACE_MAX + 1).fill(entry)
      )
    ).toThrow(/at most/u);
    expect(() => normalizeAssistantToolTrace([[]])).toThrow(
      "toolCalls entries must be objects"
    );
    expect(() => normalizeAssistantToolTrace([null])).toThrow(
      "toolCalls entries must be objects"
    );
    expect(() =>
      normalizeAssistantToolTrace([{ ...entry, ok: "yes" }])
    ).toThrow("toolCalls.ok must be a boolean");
    for (const durationMs of ["1", Number.NaN, -1])
      expect(() =>
        normalizeAssistantToolTrace([{ ...entry, durationMs }])
      ).toThrow("toolCalls.durationMs must be a non-negative number");
    expect(() => normalizeAssistantToolTrace([{ ...entry, tool: 4 }])).toThrow(
      "toolCalls.tool must be a string"
    );
    expect(() =>
      normalizeAssistantToolTrace([{ ...entry, tool: "Bad Tool" }])
    ).toThrow("toolCalls.tool must be a tool name");
    for (const artifact of [null, [], "x"])
      expect(() =>
        normalizeAssistantToolTrace([{ ...entry, artifact }])
      ).toThrow("toolCalls.artifact must be an object");
    return expect(() => normalizeAssistantTokens(1.5, "inputTokens")).toThrow(
      "inputTokens must be a non-negative integer"
    );
  });

  it("keeps a clean trace entry with an artifact", () => {
    return expect(
      normalizeAssistantToolTrace([
        { ...entry, artifact: { kind: "chart_clear", symbol: "E\u0001S" } },
      ])
    ).toEqual([
      {
        args: "",
        artifact: { kind: "chart_clear", symbol: "ES" },
        durationMs: 3,
        error: null,
        ok: true,
        tool: "chart_draw",
      },
    ]);
  });
});
