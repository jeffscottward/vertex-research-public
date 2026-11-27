import type { AssistantTraceEntry } from "../../../packages/api/src/server/assistant-runtime.ts";
import type { ProcedureResult } from "../../../packages/api/src/server/mcp.ts";

// Failed tool calls in the semantic-layer eval. A trial can be graded correct although a tool failed:
// the model reads the error and answers from another tool, or says that the data is not available. So
// the replay (eval-replay.test.ts) fails on every failed tool call that is not listed here.
// Only an input rejection can be listed: the layer refused the arguments of the call and said what it
// accepts. Every other failure fails the replay: a server error (5xx), a call that threw, a row that
// does not exist (404), a refused session (401, 403), a tool the turn does not have.
// A terms_query answer with status unknown also fails the replay (unknownTermAnswer below). The call
// worked, so the trace marks it ok, but the answer gives no value: the certified SQL failed, the
// live-account feed could not be used (unavailable, not live, not the live account, or a missing, stale or
// future data time), or the feed data has no value for the term. The synthetic fixture and the synthetic
// live-account feed give every certified term a value (read-tools.test.ts checks each term with its
// default parameters, and position with NVDA), so this rule has no list of expected answers.

/** One failed tool call that the recorded trials of a question are expected to make. */
export type ExpectedRejection = Readonly<{
  /** Question id (questions.ts). The entry holds for every trial of this question. */
  question: string;
  tool: string;
  /** The arguments as the turn trace holds them (the text inside the brackets of a `tools` line). */
  args: string;
  /** The error text as the turn trace holds it (the trace keeps at most 240 characters). */
  error: string;
  /** Why the rejection is correct behavior of the layer. */
  why: string;
}>;

export const EXPECTED_REJECTIONS: readonly ExpectedRejection[] = [
  {
    args: '{"term":"pnl","params":{"period":"today"}}',
    error:
      "BAD_REQUEST (400): Unknown parameter period. This term takes window (text: daily|unrealized|realized).",
    question: "Q5",
    tool: "terms_query",
    why: "The model guessed a parameter name. The layer names the valid parameter and the model asks again with it.",
  },
  {
    args: '{"term":"pnl","params":{"kind":"unrealized"}}',
    error:
      "BAD_REQUEST (400): Unknown parameter kind. This term takes window (text: daily|unrealized|realized).",
    question: "Q6",
    tool: "terms_query",
    why: "The model guessed a parameter name. The layer names the valid parameter and the model asks again with it.",
  },
  {
    args: '{"term":"pnl","params":{"kind":"realized"}}',
    error:
      "BAD_REQUEST (400): Unknown parameter kind. This term takes window (text: daily|unrealized|realized).",
    question: "H3",
    tool: "terms_query",
    why: "The model guessed a parameter name. The layer names the valid parameter and the model asks again with it.",
  },
];

/**
 * The two texts of a call whose arguments the layer refused (callMcpTool in mcp.ts): the API answered
 * `BAD_REQUEST (400): message`, or the tool's input schema answered `Invalid arguments for <tool>: issues`.
 */
const INPUT_REJECTION =
  /^(?:BAD_REQUEST \(400\)|Invalid arguments for [a-z][a-z0-9_]*): \S/u;

export const isInputRejection = (error: string | null): boolean =>
  error !== null && INPUT_REJECTION.test(error);

type TracedCall = Pick<AssistantTraceEntry, "args" | "error" | "ok" | "tool">;

/**
 * The failed tool calls of one replayed trial that are not expected, one line each; empty when every
 * failed call is expected. A failed call is expected only when its error is an input rejection and
 * `expected` has an entry with the same question, tool, arguments and error text.
 */
export const unexpectedToolFailures = (
  question: string,
  trace: readonly TracedCall[],
  expected: readonly ExpectedRejection[] = EXPECTED_REJECTIONS
): string[] =>
  trace
    .filter(
      (call) =>
        !(
          call.ok ||
          (isInputRejection(call.error) &&
            expected.some(
              (entry) =>
                entry.question === question &&
                entry.tool === call.tool &&
                entry.args === call.args &&
                entry.error === call.error
            ))
        )
    )
    .map(
      (call) => `${call.tool}(${call.args}): ${call.error ?? "no error text"}`
    );

/**
 * One line when a semanticTerms/query call (the terms_query tool) answered with status unknown; else
 * null. A failed call returns null here: the trace marks it failed and unexpectedToolFailures reports it.
 */
export const unknownTermAnswer = (
  procedure: string,
  input: unknown,
  result: ProcedureResult
): string | null => {
  if (procedure !== "semanticTerms/query" || !result.ok) return null;
  const { value } = result;
  if (typeof value !== "object" || value === null) return null;
  const { answer, status } = value as Readonly<Record<string, unknown>>;
  if (status !== "unknown") return null;
  return `terms_query(${JSON.stringify(input)}): status unknown: ${typeof answer === "string" ? answer : "no answer text"}`;
};
