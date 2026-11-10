import { inspect } from "node:util";

/** One teardown action of the E2E run. `name` identifies the step in the failure report. */
export type TeardownStep = Readonly<{
  name: string;
  run: () => Promise<void>;
}>;

const MAX_ERROR_DEPTH = 5;

/** One rejection as text. A value that is not an Error keeps its fields. */
const errorText = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  return inspect(error, { breakLength: Number.POSITIVE_INFINITY, depth: 1 });
};

/**
 * `error`, then the errors it carries (`errors` of an AggregateError, then `cause`), each line
 * indented by its depth. Playwright prints only the message and stack of a teardown error, so a
 * cause that is not in the message is lost. The depth limit ends a cause cycle.
 */
const describeError = (error: unknown, depth: number): string[] => {
  const lines = errorText(error)
    .trimEnd()
    .split("\n")
    .map((line) => `${"  ".repeat(depth)}${line}`);
  if (!(error instanceof Error) || depth >= MAX_ERROR_DEPTH) return lines;
  const carried = [
    ...(error instanceof AggregateError ? error.errors : []),
    ...(error.cause === undefined ? [] : [error.cause]),
  ];
  return [
    ...lines,
    ...carried.flatMap((inner) => describeError(inner, depth + 1)),
  ];
};

/**
 * Runs the steps one at a time, the last registered step first, and runs every step even after
 * an earlier step failed. A step must settle: a step that never settles stops the teardown.
 *
 * One at a time: steps share state outside this process. Two `portless alias --remove` processes
 * that run together race on the proxy's routes.json (portless writes the file in place and reads
 * it without its lock): one reads the half-written file, reports "No alias found" and exits 1.
 * Last first: a resource closes before the resources it was built on.
 *
 * @throws AggregateError when a step failed. The message names each failed step and its causes;
 * `errors` holds the original rejections in the order the steps ran.
 */
export const runTeardown = async (
  steps: readonly TeardownStep[]
): Promise<void> => {
  const failures: { error: unknown; name: string }[] = [];
  for (const step of steps.toReversed()) {
    try {
      await step.run();
    } catch (error) {
      failures.push({ error, name: step.name });
    }
  }
  if (failures.length === 0) return;
  const report = failures.flatMap(({ error, name }) => [
    `- ${name}:`,
    ...describeError(error, 1),
  ]);
  throw new AggregateError(
    failures.map(({ error }) => error),
    [
      `E2E teardown failed in ${failures.length} of ${steps.length} steps`,
      ...report,
    ].join("\n")
  );
};
