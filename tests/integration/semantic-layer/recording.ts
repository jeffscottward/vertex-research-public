import { createHash } from "node:crypto";

import type { AssistantToolDefinition } from "../../../packages/api/src/server/assistant-runtime.ts";
import type { RecordedCompletion } from "./harness.ts";
import type { Grade } from "./questions.ts";

// The file format of eval-recording.fixture.json and the pure rules of the recorder (recorder.ts) and
// of the replay (harness.ts): which trials a run records, how a run is merged into the file that
// exists, and when a change of the tool list makes a trial stale. No database and no model.

export const RECORDING_SCHEMA_VERSION = 3;

/**
 * The one model of the recording. The recorder stores no trial with a reply from another model, and
 * the replay test requires this id on every trial. A change of the model is a full recording: change
 * this constant in the commit of that recording.
 */
export const RECORDING_MODEL = "anthropic/claude-opus-5-5";

/**
 * The prompt format of the model bridge: the SHA-256 of the system text and the prompt that
 * `buildPrompt` (bridge.ts) makes for one fixed request (bridge.test.ts checks it). The bridge turns
 * each request into this prompt, so it is model input that no other digest covers. The recorder
 * stores this value on every trial, and the replay requires it. An edit of the prompt changes this
 * constant and so makes every trial stale: it is a full recording.
 */
export const RECORDING_PROMPT_FORMAT =
  "158f1e99d3a322715b69164490e8135dd08648ddcfb7b7e1f97f6c342dc865ba";

/**
 * One tool list as the model saw it: the digest of each tool definition, by tool name. Its id (the
 * key in `toolLists`) is the digest of the whole list as sent, so the id also covers the order.
 */
export type ToolList = Readonly<Record<string, string>>;

/** A tool list with its id. */
export type IdentifiedToolList = Readonly<{ id: string; tools: ToolList }>;

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
  /** The prompt format of the bridge that asked this trial (RECORDING_PROMPT_FORMAT at that time). */
  promptFormat: string;
  /** When this trial was recorded (ISO 8601). */
  recordedAt: string;
  /** The id of the tool list that the model saw in every call of this trial (a key of `toolLists`). */
  toolList: string;
  tools: readonly string[];
  completions: readonly RecordedCompletion[];
}>;

/** The recording file. Keys other than `toolLists` and `trials` are the header. */
export type Recording = Readonly<
  Record<string, unknown> & {
    schemaVersion: number;
    /** Every tool list that a trial names, by id. */
    toolLists: Readonly<Record<string, ToolList>>;
    trials: readonly RecordedTrial[];
  }
>;

export const trialKey = (
  trial: Readonly<{ question: string; trial: number }>
): string => `${trial.question}.${trial.trial}`;

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * The tool list of one model request: the id is the digest of the JSON text of the whole list (so the
 * order counts), and each tool has the digest of the JSON text of its own definition as sent.
 */
export const identifyToolList = (
  tools: readonly AssistantToolDefinition[]
): IdentifiedToolList => ({
  id: sha256(JSON.stringify(tools)),
  tools: Object.fromEntries(
    tools.map((tool) => [tool.function.name, sha256(JSON.stringify(tool))])
  ),
});

/**
 * The names of the tools that differ between two lists: a tool in one list only, or in both with
 * another digest. Sorted. Empty when the lists hold the same tools (the order alone may differ).
 */
export const differingTools = (
  recorded: ToolList,
  current: ToolList
): string[] => {
  return [...new Set([...Object.keys(recorded), ...Object.keys(current)])]
    .filter((name) => recorded[name] !== current[name])
    .sort();
};

/** The names of the tools that the recorded model replies of a trial call. */
export const calledTools = (
  trial: Pick<RecordedTrial, "completions">
): Set<string> =>
  new Set(
    trial.completions.flatMap((completion) =>
      completion.toolCalls.map((call) => call.name)
    )
  );

/**
 * What the tool rule says about one trial.
 * - `exact`: the trial was recorded with the current tool list.
 * - `drifted`: the current list differs only in tools that the trial does not call, and `witness` (a
 *   trial of the same question, recorded with the current list) calls none of them. The trial is valid.
 * - `needs-witness`: as `drifted`, but the question has no trial recorded with the current list.
 * - `stale`: the trial must be recorded again; `reason` says why.
 */
export type ToolVerdict =
  | Readonly<{ state: "exact" }>
  | Readonly<{
      state: "drifted";
      differing: readonly string[];
      witness: string;
    }>
  | Readonly<{
      state: "needs-witness";
      differing: readonly string[];
      reason: string;
    }>
  | Readonly<{ state: "stale"; reason: string }>;

type ToolRuleTrial = Pick<
  RecordedTrial,
  "completions" | "question" | "toolList" | "trial"
>;

/**
 * The tool rule for every trial of a recording against the current tool list.
 * - A trial is stale when the definition of a tool that it calls differs from the recorded one (or the
 *   tool is gone), or when the recording does not say which tool list it saw.
 * - Else, when the current list differs, the trial is drifted. It stays valid only while a witness
 *   exists: a trial of the same question that was recorded with the current list, that `isWitness`
 *   accepts (the replay passes "replays unchanged"), and that calls none of the tools that differ for
 *   the drifted trial. When a trial of the current list calls one of them, the model uses a changed tool
 *   for this question, so the drifted trial is stale.
 */
export const toolVerdicts = (
  recording: Readonly<{
    toolLists?: Readonly<Record<string, ToolList>>;
    trials: readonly ToolRuleTrial[];
  }>,
  current: IdentifiedToolList,
  isWitness: (trial: ToolRuleTrial) => boolean = () => true
): Map<string, ToolVerdict> => {
  const verdicts = new Map<string, ToolVerdict>();
  const witnesses = recording.trials.filter(
    (trial) => trial.toolList === current.id && isWitness(trial)
  );
  for (const trial of recording.trials) {
    const key = trialKey(trial);
    if (trial.toolList === current.id) {
      verdicts.set(key, { state: "exact" });
      continue;
    }
    const recorded =
      typeof trial.toolList === "string"
        ? recording.toolLists?.[trial.toolList]
        : undefined;
    if (recorded === undefined) {
      verdicts.set(key, {
        reason:
          "the recording does not hold the tool list of this trial (a version 2 trial: run the recorder with `upgrade`)",
        state: "stale",
      });
      continue;
    }
    const differing = differingTools(recorded, current.tools);
    const called = calledTools(trial);
    const calledAndChanged = differing.filter((name) => called.has(name));
    if (calledAndChanged.length > 0) {
      verdicts.set(key, {
        reason: `the definition of a tool that the trial calls changed: ${calledAndChanged.join(", ")}`,
        state: "stale",
      });
      continue;
    }
    const sameQuestion = witnesses.filter(
      (witness) => witness.question === trial.question
    );
    const changed =
      differing.length > 0 ? differing.join(", ") : "the order of the tools";
    if (sameQuestion.length === 0) {
      verdicts.set(key, {
        differing,
        reason: `the tool list changed (${changed}) and no trial of ${trial.question} was recorded with the current list`,
        state: "needs-witness",
      });
      continue;
    }
    const clean = sameQuestion.find((witness) => {
      const witnessCalls = calledTools(witness);
      return differing.every((name) => !witnessCalls.has(name));
    });
    if (clean === undefined) {
      verdicts.set(key, {
        reason: `the tool list changed (${changed}) and every trial of ${trial.question} recorded with the current list calls a changed tool`,
        state: "stale",
      });
      continue;
    }
    verdicts.set(key, {
      differing,
      state: "drifted",
      witness: trialKey(clean),
    });
  }
  return verdicts;
};

/**
 * The witness trials of a `stale` run: for each question that has trials in state `needs-witness` and
 * no trial that the run records anyway (`selected`), the one with the oldest `recordedAt` (then the
 * lowest trial number). Oldest first, so that three changes of the tool list record all three trials
 * of a question again and no trial is more than three tool lists old.
 */
export const selectWitnesses = (
  trials: readonly Pick<RecordedTrial, "question" | "recordedAt" | "trial">[],
  verdicts: ReadonlyMap<string, ToolVerdict>,
  selected: ReadonlySet<string>
): string[] => {
  const busy = new Set(
    trials
      .filter((trial) => selected.has(trialKey(trial)))
      .map((trial) => trial.question)
  );
  const oldest = new Map<string, (typeof trials)[number]>();
  for (const trial of trials) {
    if (busy.has(trial.question)) continue;
    if (verdicts.get(trialKey(trial))?.state !== "needs-witness") continue;
    const held = oldest.get(trial.question);
    if (
      held === undefined ||
      trial.recordedAt < held.recordedAt ||
      (trial.recordedAt === held.recordedAt && trial.trial < held.trial)
    ) {
      oldest.set(trial.question, trial);
    }
  }
  return [...oldest.values()].map(trialKey);
};

/**
 * What the recorder was asked to do: record every trial, the stale trials only or the named
 * questions, or (`upgrade`, no model call) write a version 2 recording in the current format.
 */
export type RecordSelection =
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "upgrade" }>
  | Readonly<{ kind: "questions"; ids: readonly string[] }>;

/**
 * Reads the recorder arguments after [trials] [concurrency]: nothing (every question), the word `stale`
 * (only the trials that no longer replay, the missing ones and the witness trials), the word `upgrade`,
 * or question ids.
 */
export const parseSelection = (
  selectors: readonly string[],
  questionIds: readonly string[]
): RecordSelection => {
  if (selectors.length === 0) return { kind: "all" };
  for (const word of ["stale", "upgrade"] as const) {
    if (!selectors.includes(word)) continue;
    if (selectors.length > 1) {
      throw new Error(
        `\`${word}\` cannot be combined with question ids or another word.`
      );
    }
    return { kind: word };
  }
  const unknown = selectors.filter((id) => !questionIds.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown question id: ${unknown.join(", ")}. Known ids: ${questionIds.join(", ")}, or the word stale or upgrade.`
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
      `The ${name} argument must be a positive whole number, not "${value}". Usage: [trials] [concurrency] [stale | upgrade | ids...]`
    );
  }
  return Number(value);
};

/**
 * Stops a run that would keep trials of an older format next to new ones. A version 2 file has no
 * tool lists: `upgrade` writes them without a model call. Checked before the first model request.
 */
export const assertCurrentFormat = (recording: Recording): void => {
  if (recording.schemaVersion === RECORDING_SCHEMA_VERSION) return;
  throw new Error(
    `The recording has schemaVersion ${recording.schemaVersion}, not ${RECORDING_SCHEMA_VERSION}. Run the recorder with \`upgrade\` first (no model call; docs/vertex-rebuild/agent-semantic-layer.md, format note of 2026-11-26), or record every question.`
  );
};

/**
 * Merges the trials of one recorder run into the recording that exists.
 * - The header of the existing recording (the `audit` block above all) is kept as it is, but for `note`,
 *   which is always the recorder's current note.
 * - A new trial replaces the existing trial with the same question and trial number; every other
 *   existing trial is kept unchanged, with its own model, date and audit grade.
 * - `toolLists` holds the lists that the trials of the merged file name, and no other: the lists of
 *   the existing file, then `lists` (the lists that the new trials saw).
 */
export const mergeRecording = (
  previous: Recording | undefined,
  recorded: readonly RecordedTrial[],
  lists: readonly IdentifiedToolList[],
  questionOrder: readonly string[],
  note: string
): Recording => {
  const header = Object.fromEntries(
    Object.entries(previous ?? {}).filter(
      ([key]) => !["toolLists", "trials"].includes(key)
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
  const known: Record<string, ToolList> = {
    ...previous?.toolLists,
    ...Object.fromEntries(lists.map((list) => [list.id, list.tools])),
  };
  const used = [...new Set(trials.map((trial) => trial.toolList))].sort();
  const toolLists = Object.fromEntries(
    used.flatMap((id) => {
      const tools = known[id];
      return tools === undefined ? [] : [[id, tools] as const];
    })
  );
  return {
    ...header,
    note,
    schemaVersion: RECORDING_SCHEMA_VERSION,
    toolLists,
    trials,
  };
};
