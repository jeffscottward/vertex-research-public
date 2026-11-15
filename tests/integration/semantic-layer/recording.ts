import type { RecordedCompletion } from "./harness.ts";
import type { Grade } from "./questions.ts";

// The file format of eval-recording.fixture.json and the two pure rules of the recorder (record.ts):
// which trials a run records, and how a run is merged into the file that exists.

export const RECORDING_SCHEMA_VERSION = 2;

/** One recorded trial. The recorder writes every field but `audit`. */
export type RecordedTrial = Readonly<{
  question: string;
  trial: number;
  answer: string;
  grade: Grade;
  /**
   * Independent grader verdict against the reference, written by the grading step after the recording
   * and audited by hand. A trial that was recorded again has none until it is graded again.
   */
  audit?: Grade;
  /** The model that answered this trial, as the model bridge named it. */
  model: string;
  /** When this trial was recorded (ISO 8601). */
  recordedAt: string;
  tools: readonly string[];
  completions: readonly RecordedCompletion[];
}>;

/** The recording file. Keys other than `trials` are the header. */
export type Recording = Readonly<
  Record<string, unknown> & {
    schemaVersion: number;
    trials: readonly RecordedTrial[];
  }
>;

export const trialKey = (
  trial: Readonly<{ question: string; trial: number }>
): string => `${trial.question}.${trial.trial}`;

/** What the recorder was asked to record: every trial, the stale trials only, or the named questions. */
export type RecordSelection =
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "questions"; ids: readonly string[] }>;

/**
 * Reads the recorder arguments after [trials] [concurrency]: nothing (every question), the word `stale`
 * (only the trials that no longer replay, and the missing ones), or question ids.
 */
export const parseSelection = (
  selectors: readonly string[],
  questionIds: readonly string[]
): RecordSelection => {
  if (selectors.length === 0) return { kind: "all" };
  if (selectors.includes("stale")) {
    if (selectors.length > 1) {
      throw new Error("`stale` cannot be combined with question ids.");
    }
    return { kind: "stale" };
  }
  const unknown = selectors.filter((id) => !questionIds.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown question id: ${unknown.join(", ")}. Known ids: ${questionIds.join(", ")}, or the word stale.`
    );
  }
  return { ids: selectors, kind: "questions" };
};

/** Reads the trials or the concurrency argument: a positive whole number, or the default when absent. */
export const parseCount = (
  name: string,
  value: string | undefined,
  fallback: number
): number => {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `The ${name} argument must be a positive whole number, not "${value}". Usage: [trials] [concurrency] [stale | ids...]`
    );
  }
  return Number(value);
};

/**
 * Stops a run that would keep trials of a version 1 recording. Such a file has one `model` and one
 * `recordedAt` for all trials; the merge drops both, so the kept trials would lose them. Checked before
 * the first model request.
 */
export const assertTrialsHaveModelAndDate = (recording: Recording): void => {
  const missing = recording.trials
    .filter(
      (trial) =>
        typeof trial.model !== "string" || typeof trial.recordedAt !== "string"
    )
    .map(trialKey);
  if (missing.length > 0) {
    throw new Error(
      `The recording has ${missing.length} trials with no model or recordedAt of their own (first: ${missing[0]}). Add both fields to every trial before a run that keeps trials (docs/vertex-rebuild/agent-semantic-layer.md, format note of 2026-11-15), or record every question.`
    );
  }
};

/**
 * Merges the trials of one recorder run into the recording that exists.
 * - The header of the existing recording (the `audit` block above all) is kept as it is, but for `note`,
 *   which is always the recorder's current note.
 * - A new trial replaces the existing trial with the same question and trial number; every other
 *   existing trial is kept unchanged, with its own model, date and audit grade.
 * - `model` and `recordedAt` are stored on each trial, so the header has neither.
 */
export const mergeRecording = (
  previous: Recording | undefined,
  recorded: readonly RecordedTrial[],
  questionOrder: readonly string[],
  note: string
): Recording => {
  const header = Object.fromEntries(
    Object.entries(previous ?? {}).filter(
      ([key]) => !["model", "recordedAt", "trials"].includes(key)
    )
  );
  const replaced = new Set(recorded.map(trialKey));
  const order = new Map(questionOrder.map((id, index) => [id, index]));
  const position = (trial: RecordedTrial): number =>
    order.get(trial.question) ?? questionOrder.length;
  const trials = [
    ...recorded,
    ...(previous?.trials ?? []).filter(
      (trial) => !replaced.has(trialKey(trial))
    ),
  ].sort(
    (left, right) =>
      position(left) - position(right) ||
      left.question.localeCompare(right.question) ||
      left.trial - right.trial
  );
  return {
    ...header,
    note,
    schemaVersion: RECORDING_SCHEMA_VERSION,
    trials,
  };
};
