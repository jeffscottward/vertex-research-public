import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  type CallProcedure,
  callMcpTool,
} from "../../../packages/api/src/server/mcp.ts";
import { EVAL_QUESTIONS } from "./questions.ts";
import { type RecordedTrial, trialKey } from "./recording.ts";
import {
  EXPECTED_REJECTIONS,
  type ExpectedRejection,
  isInputRejection,
  unexpectedToolFailures,
  unknownTermAnswer,
} from "./tool-failures.ts";

// The rules of tool-failures.ts, with no database: what the gate lets pass, that the list of expected
// rejections matches the recording (no missing entry and no entry that nothing uses), and which
// terms_query answers fail the replay.

const recording = JSON.parse(
  readFileSync(
    new URL("./eval-recording.fixture.json", import.meta.url),
    "utf8"
  )
) as Readonly<{ trials: readonly RecordedTrial[] }>;

const LISTED: ExpectedRejection = {
  args: '{"term":"pnl","params":{"period":"today"}}',
  error: "BAD_REQUEST (400): Unknown parameter period.",
  question: "Q5",
  tool: "terms_query",
  why: "test entry",
};
const failed = (
  error: string | null,
  args = LISTED.args,
  tool = LISTED.tool
) => ({ args, error, ok: false, tool });

/** The error text that the assistant turn gets from callMcpTool for one call. */
const errorText = async (
  args: unknown,
  procedure: CallProcedure
): Promise<string> => {
  const result = await callMcpTool("terms_query", args, procedure);
  const [content] = result["content"] as readonly Readonly<{ text: string }>[];
  return content?.text ?? "";
};
const answering =
  (status: number, code: string): CallProcedure =>
  async () => ({ code, message: "the message", ok: false, status });

describe("failed tool calls in a replayed trial", () => {
  it("passes a call that worked and a listed input rejection", () => {
    expect(
      unexpectedToolFailures(
        "Q5",
        [
          { args: "{}", error: null, ok: true, tool: "terms_list" },
          failed(LISTED.error),
        ],
        [LISTED]
      )
    ).toEqual([]);
  });

  it.each([
    ["another question", "Q6", LISTED.error, LISTED.args, LISTED.tool],
    ["another tool", "Q5", LISTED.error, LISTED.args, "terms_list"],
    ["other arguments", "Q5", LISTED.error, '{"term":"pnl"}', LISTED.tool],
    [
      "another error text",
      "Q5",
      "BAD_REQUEST (400): Other.",
      LISTED.args,
      LISTED.tool,
    ],
    ["a call that threw", "Q5", "Tool call failed", LISTED.args, LISTED.tool],
    ["no error text", "Q5", null, LISTED.args, LISTED.tool],
  ])("reports a failed call with %s", (_name, question, error, args, tool) => {
    expect(
      unexpectedToolFailures(question, [failed(error, args, tool)], [LISTED])
    ).toEqual([`${tool}(${args}): ${error ?? "no error text"}`]);
  });

  it.each([
    "INTERNAL_SERVER_ERROR (500): Output validation failed",
    "NOT_CONFIGURED (503): The service is not configured",
    "NOT_FOUND (404): Record not found",
    "FORBIDDEN (403): Procedure not available to the assistant",
    "Tool call failed",
  ])("reports %s even when the list names it", (error) => {
    expect(
      unexpectedToolFailures("Q5", [failed(error)], [{ ...LISTED, error }])
    ).toEqual([`terms_query(${LISTED.args}): ${error}`]);
  });

  it("takes the two texts of refused arguments as input rejections, and no other text", async () => {
    // Refused by the API.
    expect(
      isInputRejection(
        await errorText({ term: "pnl" }, answering(400, "BAD_REQUEST"))
      )
    ).toBe(true);
    // Refused by the input schema of the tool; the API is not called.
    expect(
      isInputRejection(await errorText({}, answering(500, "NOT_CALLED")))
    ).toBe(true);
    for (const [status, code] of [
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [500, "INTERNAL_SERVER_ERROR"],
      [503, "NOT_CONFIGURED"],
    ] as const) {
      expect(
        isInputRejection(
          await errorText({ term: "pnl" }, answering(status, code))
        ),
        code
      ).toBe(false);
    }
    // The text must start with the form: a server error that quotes a 400 is not an input rejection.
    expect(
      isInputRejection(
        "INTERNAL_SERVER_ERROR (500): upstream said BAD_REQUEST (400): x"
      )
    ).toBe(false);
  });
});

describe("terms_query answers with status unknown", () => {
  const input = { params: { window: "daily" }, term: "pnl" };
  const answered = (value: unknown) => ({ ok: true as const, value });

  it("reports an unknown answer with the input and the answer text", () => {
    expect(
      unknownTermAnswer(
        "semanticTerms/query",
        input,
        answered({
          answer: "Unknown: the feed is stale.",
          status: "unknown",
        })
      )
    ).toBe(
      'terms_query({"params":{"window":"daily"},"term":"pnl"}): status unknown: Unknown: the feed is stale.'
    );
  });

  it("reports an unknown answer that has no answer text", () => {
    expect(
      unknownTermAnswer(
        "semanticTerms/query",
        input,
        answered({ status: "unknown" })
      )
    ).toBe(
      'terms_query({"params":{"window":"daily"},"term":"pnl"}): status unknown: no answer text'
    );
  });

  it.each([
    ["status ok", "semanticTerms/query", answered({ status: "ok" })],
    [
      "status not_available (a designed answer)",
      "semanticTerms/query",
      answered({ status: "not_available" }),
    ],
    [
      "a failed call (the trace gate reports it)",
      "semanticTerms/query",
      {
        code: "INTERNAL_SERVER_ERROR",
        message: "boom",
        ok: false as const,
        status: 500,
      },
    ],
    ["a value that is not an object", "semanticTerms/query", answered(null)],
    [
      "another procedure",
      "semanticTerms/list",
      answered({ status: "unknown" }),
    ],
  ])("passes %s", (_name, procedure, result) => {
    expect(unknownTermAnswer(procedure, input, result)).toBeNull();
  });
});

describe("the list of expected rejections", () => {
  const questionIds = new Set(EVAL_QUESTIONS.map((question) => question.id));
  const failedLines = recording.trials.flatMap((trial) =>
    trial.tools
      .filter((line) => line.endsWith(" failed"))
      .map((line) => ({ line, question: trial.question, trial }))
  );
  /** The line that the recorder (record.ts) writes into `tools` for the failed call of an entry. */
  const lineOf = (entry: ExpectedRejection): string =>
    `${entry.tool}(${entry.args}) failed`;
  const keyOf = (entry: ExpectedRejection): string =>
    `${entry.question} ${lineOf(entry)}`;

  it.each(EXPECTED_REJECTIONS.map((entry) => [keyOf(entry), entry] as const))(
    "%s is an input rejection that a recorded trial makes",
    (_key, entry) => {
      expect(isInputRejection(entry.error)).toBe(true);
      expect(entry.why).toMatch(/\S/u);
      expect(questionIds.has(entry.question)).toBe(true);
      // An entry that no recorded trial uses any more must be removed.
      expect(
        failedLines.filter(
          (failure) =>
            failure.question === entry.question &&
            failure.line === lineOf(entry)
        ).length
      ).toBeGreaterThan(0);
    }
  );

  it("has one entry for each question and failed call, and names every failed call of the recording", () => {
    const keys = EXPECTED_REJECTIONS.map(keyOf);
    expect(keys).toEqual([...new Set(keys)]);
    const listed = new Set(keys);
    expect(
      failedLines
        .filter((failure) => !listed.has(`${failure.question} ${failure.line}`))
        .map((failure) => `${trialKey(failure.trial)} ${failure.line}`)
    ).toEqual([]);
  });
});
