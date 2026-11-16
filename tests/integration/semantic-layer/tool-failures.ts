import type { AssistantTraceEntry } from "../../../packages/api/src/server/assistant-runtime.ts";

// Failed tool calls in the semantic-layer eval. A trial can be graded correct although a tool failed:
// the model reads the error and answers from another tool, or says that the data is not available. So
// the replay (eval-replay.test.ts) fails on every failed tool call that is not listed here.
// Only an input rejection can be listed: the layer refused the arguments of the call and said what it
// accepts. Every other failure fails the replay: a server error (5xx), a call that threw, a row that
// does not exist (404), a refused session (401, 403), a tool the turn does not have.

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
    args: '{"term":"open_risk","params":{"symbol":"NVDA"}}',
    error:
      "BAD_REQUEST (400): Unknown parameter symbol. This term takes no parameters.",
    question: "H2",
    tool: "terms_query",
    why: "The term has no per-symbol form. The layer says so and the model reads the NVDA row from the term position instead.",
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
