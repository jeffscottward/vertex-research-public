import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";

import type {
  AssistantCompletion,
  AssistantCompletionRequest,
  AssistantLogEntry,
} from "../../../packages/api/src/server/assistant-runtime.ts";
import {
  type EvalBackend,
  replayRecording,
  runTrial,
  type TrialVerdict,
} from "./harness.ts";
import { writeFrozenMasterRules } from "./master-rules-freeze.ts";
import { type EvalQuestion, gradeAnswer } from "./questions.ts";
import {
  assertCurrentFormat,
  type IdentifiedToolList,
  mergeRecording,
  RECORDING_MODEL,
  RECORDING_PROMPT_FORMAT,
  type RecordedTrial,
  type Recording,
  type RecordSelection,
  selectWitnesses,
  type ToolVerdict,
  trialKey,
} from "./recording.ts";

// The recorder of the agent semantic-layer eval: which trials a run records, how a model reply is
// checked, how the stdin/stdout bridge dispatches replies and faults, and when the files are written.
// record.ts adds the command line and the `@@EVAL ` framing of the model bridge (bridge.ts);
// recorder.test.ts runs this code with a scripted model and scripted stdin streams.

/** One reply of the model bridge to a request (one JSON object on one stdin line of the recorder). */
const BridgeReplySchema = z.object({
  content: z.string(),
  key: z.string().min(1),
  model: z.string().min(1),
  toolCalls: z.array(
    z.object({
      // The arguments object, or its JSON text; absent and `null` mean no arguments. Any other
      // JSON value is passed to the turn as JSON text, and the turn refuses a value that is no
      // object as it does in production.
      arguments: z.unknown().optional(),
      name: z.string().min(1),
    })
  ),
});
/** The bridge got no model reply for this request. The trial of the request is not recorded. */
const BridgeFaultSchema = z.object({
  fault: z.string().min(1),
  key: z.string().min(1),
});
const BridgeKeySchema = z.object({
  key: z.string().min(1),
});
const BridgeLineSchema = z.union([BridgeFaultSchema, BridgeReplySchema]);
const BRIDGE_SHAPE_ERROR =
  "bridge line is not {key, content, toolCalls: [{name, arguments}], model} and not {key, fault}";

export type BridgeReply = z.infer<typeof BridgeReplySchema>;
export type BridgeFault = z.infer<typeof BridgeFaultSchema>;

type ClassifiedBridgeLine =
  | Readonly<{ kind: "valid"; message: BridgeReply | BridgeFault }>
  | Readonly<{ kind: "keyed-invalid"; key: string; error: Error }>
  | Readonly<{ kind: "fatal"; error: Error }>;

/**
 * Classifies one stdin line of the bridge so `parseBridgeLine` and `createBridgeModel` share one
 * parser and error contract: non-JSON and keyless lines are fatal, while a JSON object with a
 * non-empty string `key` but wrong shape carries its `key` so a waiting request can fail alone.
 */
const classifyBridgeLine = (line: string): ClassifiedBridgeLine => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return {
      error: new Error(
        `bridge line is not JSON; first 120 characters: ${line.slice(0, 120)}`
      ),
      kind: "fatal",
    };
  }
  const parsed = BridgeLineSchema.safeParse(value);
  if (parsed.success) {
    return { kind: "valid", message: parsed.data };
  }
  const keyed = BridgeKeySchema.safeParse(value);
  if (keyed.success) {
    return {
      error: new Error(BRIDGE_SHAPE_ERROR),
      key: keyed.data.key,
      kind: "keyed-invalid",
    };
  }
  return {
    error: new Error(BRIDGE_SHAPE_ERROR),
    kind: "fatal",
  };
};

/**
 * Reads one stdin line of the bridge. Throws on non-JSON or any line that is neither a valid reply
 * nor a valid fault. `createBridgeModel` uses `classifyBridgeLine` directly so a wrong-shape JSON
 * line with a waiting request's key fails only that request as a fault.
 */
export const parseBridgeLine = (line: string): BridgeReply | BridgeFault => {
  const classified = classifyBridgeLine(line);
  if (classified.kind !== "valid") throw classified.error;
  return classified.message;
};

/** The model call of a request as the assistant turn takes it. `key` is `<trial key>#<call number>`. */
export const replyToCompletion = (
  key: string,
  reply: BridgeReply
): AssistantCompletion => ({
  content: reply.content,
  finishReason: reply.toolCalls.length > 0 ? "tool_calls" : "stop",
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: reply.toolCalls.map((toolCall, index) => ({
    function: {
      arguments:
        typeof toolCall.arguments === "string"
          ? toolCall.arguments
          : JSON.stringify(toolCall.arguments ?? {}),
      name: toolCall.name,
    },
    id: `${key}.${index}`.replaceAll("#", "_"),
    type: "function" as const,
  })),
});

/**
 * The model of one trial: answers one model call and names the model that answered. It throws when
 * no model reply came (a bridge fault); the trial is then not recorded.
 */
export type TrialModel = (
  key: string,
  request: AssistantCompletionRequest
) => Promise<Readonly<{ completion: AssistantCompletion; model: string }>>;

/** One model request emitted to the bridge over stdout. */
export type BridgeRequestMessage = Readonly<{
  type: "request";
  key: string;
  messages: AssistantCompletionRequest["messages"];
  tools: AssistantCompletionRequest["tools"];
}>;

export type BridgeModelHandle = Readonly<{
  model: TrialModel;
  close: () => void;
}>;

/**
 * Wires the recorder's stdio bridge protocol to a `TrialModel`.
 * - A JSON line with a waiting request's `key` but wrong shape (for example an empty model id)
 *   rejects only that request as a fault; other trials continue and store normally.
 * - Only non-JSON lines, lines with no non-empty string `key`, lines for a key that is not open,
 *   or EOF on `input` close the bridge and reject all waiting and subsequent requests.
 */
export const createBridgeModel = (
  options: Readonly<{
    input: NodeJS.ReadableStream;
    send: (message: BridgeRequestMessage) => void;
  }>
): BridgeModelHandle => {
  type Waiter = Readonly<{
    resolve: (reply: BridgeReply) => void;
    reject: (error: Error) => void;
  }>;
  const pending = new Map<string, Waiter>();
  let closed: Error | null = null;
  const lines = createInterface({ input: options.input });
  const failAll = (error: Error): void => {
    closed ??= error;
    lines.close();
    for (const waiter of pending.values()) waiter.reject(closed);
    pending.clear();
  };
  lines.on("line", (line) => {
    if (closed !== null || line.trim() === "") return;
    const classified = classifyBridgeLine(line);
    if (classified.kind === "fatal") {
      failAll(classified.error);
      return;
    }
    const key =
      classified.kind === "valid" ? classified.message.key : classified.key;
    const waiter = pending.get(key);
    if (waiter === undefined) {
      failAll(new Error(`reply for a request that is not open: ${key}`));
      return;
    }
    pending.delete(key);
    if (classified.kind === "keyed-invalid") {
      waiter.reject(new Error(`bridge fault: ${classified.error.message}`));
      return;
    }
    if ("fault" in classified.message) {
      waiter.reject(new Error(`bridge fault: ${classified.message.fault}`));
    } else {
      waiter.resolve(classified.message);
    }
  });
  lines.on("close", () => {
    failAll(new Error("the bridge closed stdin before it answered"));
  });
  const model: TrialModel = async (key, request) => {
    if (closed !== null) throw closed;
    // Executor form: the tests tsconfig targets a lib without Promise.withResolvers.
    const reply = await new Promise<BridgeReply>((resolve, reject) => {
      pending.set(key, { reject, resolve });
      try {
        options.send({
          key,
          messages: request.messages,
          tools: request.tools,
          type: "request",
        });
      } catch (error) {
        pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { completion: replyToCompletion(key, reply), model: reply.model };
  };
  return {
    close: () => {
      lines.close();
    },
    model,
  };
};
/** What a run tells its caller while it works. record.ts prints each message as an `@@EVAL` line. */
export type RunMessage =
  | Readonly<{
      type: "selected";
      /** The trials of this run, in recording order. */
      keys: readonly string[];
      /** Why each trial is recorded. */
      reasons: Readonly<Record<string, string>>;
    }>
  | Readonly<{ type: "done"; key: string }>
  | Readonly<{ type: "failed"; key: string; reason: string }>
  | Readonly<{
      type: "finished";
      /** Trials in the recording file after the run. */
      count: number;
      /** Trials that this run recorded and wrote. */
      recorded: readonly string[];
      /** Trials that this run did not store, with the reason. */
      failed: Readonly<Record<string, string>>;
      /**
       * Trials that the run did not start: it stopped at a reply from another model, or its
       * selection had another size than `expectSelected`.
       */
      notStarted: readonly string[];
    }>;

export type RecordRunOptions = Readonly<{
  backend: EvalBackend;
  questions: readonly EvalQuestion[];
  selection: RecordSelection;
  /** Trials for each question (the recording has 3). */
  trials: number;
  concurrency: number;
  model: TrialModel;
  /** The recording file and the file of the frozen master_rules_search results. */
  files: Readonly<{ recording: string; masterRules: string }>;
  note: string;
  /**
   * When set: the run stops before the first model request if it selects another number of trials.
   * It then prints the selection, stores nothing and reports every trial as not started.
   */
  expectSelected?: number;
  emit: (message: RunMessage) => void;
  /** Takes the turn log entry of each trial. */
  log: (entry: AssistantLogEntry) => void;
  now?: () => Date;
}>;

type Job = Readonly<{ question: EvalQuestion; trial: number }>;

const readRecording = (path: string): Recording | undefined =>
  existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Recording)
    : undefined;

/** Writes the recording whole: temporary file, then rename. */
const writeRecording = (path: string, recording: Recording): void => {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(recording, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
};

/**
 * The reason for each trial of a `stale` run: every recorded trial that must be recorded again, every
 * missing trial up to `trials`, and one witness trial for each question whose trials all saw an older
 * tool list (recording.ts, `selectWitnesses`). It depends only on the recording file and the built
 * layer, so a second `stale` run continues a run that was killed.
 */
const staleReasons = async (
  options: Pick<RecordRunOptions, "backend" | "questions">,
  recording: Recording | undefined,
  all: readonly string[]
): Promise<Map<string, string>> => {
  const recorded = recording?.trials ?? [];
  const verdicts =
    recording === undefined
      ? new Map<string, TrialVerdict>()
      : await replayRecording(options.backend, options.questions, recording);
  const reasons = new Map<string, string>();
  const needsWitness = new Map<string, ToolVerdict>();
  for (const trial of recorded) {
    const key = trialKey(trial);
    const verdict = verdicts.get(key);
    if (verdict === undefined || verdict.stale === null) continue;
    // A trial that only lacks a witness is not recorded for that alone: one trial of its question is.
    if (
      verdict.tool?.state === "needs-witness" &&
      verdict.stale === verdict.tool.reason
    ) {
      needsWitness.set(key, verdict.tool);
    } else {
      reasons.set(key, verdict.stale);
    }
  }
  const recordedKeys = new Set(recorded.map(trialKey));
  for (const key of all) {
    if (!recordedKeys.has(key)) {
      reasons.set(key, "the recording has no such trial");
    }
  }
  for (const key of selectWitnesses(
    recorded,
    needsWitness,
    new Set(reasons.keys())
  )) {
    const tool = needsWitness.get(key);
    if (tool?.state === "needs-witness") {
      reasons.set(key, `witness trial: ${tool.reason}`);
    }
  }
  return reasons;
};

/**
 * The trials of a run in recording order, and the reason for each: all, the named questions, or the
 * stale selection.
 */
const selectJobs = async (
  options: Pick<
    RecordRunOptions,
    "backend" | "questions" | "selection" | "trials"
  >,
  recording: Recording | undefined
): Promise<Readonly<{ jobs: Job[]; reasons: Record<string, string> }>> => {
  const { questions, selection, trials } = options;
  const numbers = new Map<string, Set<number>>(
    questions.map((question) => [
      question.id,
      new Set(Array.from({ length: trials }, (_, index) => index + 1)),
    ])
  );
  // A stale run also looks at recorded trials above `trials`.
  if (selection.kind === "stale") {
    for (const trial of recording?.trials ?? []) {
      numbers.get(trial.question)?.add(trial.trial);
    }
  }
  const candidates: Job[] = questions.flatMap((question) =>
    [...(numbers.get(question.id) ?? [])]
      .sort((left, right) => left - right)
      .map((trial) => ({ question, trial }))
  );
  const keyOf = (job: Job): string =>
    trialKey({ question: job.question.id, trial: job.trial });
  let reasons: Map<string, string>;
  if (selection.kind === "stale") {
    reasons = await staleReasons(
      options,
      recording,
      candidates.filter((job) => job.trial <= trials).map(keyOf)
    );
  } else {
    const ids = selection.kind === "all" ? null : selection.ids;
    reasons = new Map(
      candidates
        .filter((job) => ids === null || ids.includes(job.question.id))
        .map((job) => [
          keyOf(job),
          ids === null
            ? "the run records every question"
            : "the run names this question",
        ])
    );
  }
  const jobs = candidates.filter((job) => reasons.has(keyOf(job)));
  return {
    jobs,
    reasons: Object.fromEntries(
      jobs.map((job) => [keyOf(job), reasons.get(keyOf(job)) ?? ""])
    ),
  };
};

export type RecordRunResult = Extract<
  RunMessage,
  Readonly<{ type: "finished" }>
>;

/**
 * One run of the recorder.
 * - Each finished trial is written at once: first the frozen master_rules_search results, then the
 *   recording (read again, merged, written whole), so a run that is killed keeps its finished trials.
 * - A trial whose model call fails (a bridge fault) is not stored; the run goes on with the next trial.
 * - A reply from another model than RECORDING_MODEL is not transient (the OMP default model was
 *   switched): the trial is not stored and the run starts no further trial.
 * - A run of every question that stored every trial drops the trials it did not record.
 */
export const recordRun = async (
  options: RecordRunOptions
): Promise<RecordRunResult> => {
  const { backend, emit, files, questions, selection } = options;
  const now = options.now ?? (() => new Date());
  const questionOrder = questions.map((question) => question.id);
  const atStart = readRecording(files.recording);
  // Checked here, before any model request.
  if (atStart !== undefined && selection.kind !== "all") {
    assertCurrentFormat(atStart);
  }
  // Counted before the selection: its replay can freeze a search too (the backend of a recording
  // answers a master_rules_search that is not frozen from the live index).
  let frozen = Object.keys(backend.masterRules.searches).length;
  // The freeze is written before a recording that names a new search, and never later: a recording
  // must not name a search that the freeze does not hold.
  const writeFreeze = (): void => {
    const searches = Object.keys(backend.masterRules.searches).length;
    if (searches === frozen) return;
    writeFrozenMasterRules(backend.masterRules, files.masterRules);
    frozen = searches;
  };
  const { jobs, reasons } = await selectJobs(options, atStart);
  emit({ keys: Object.keys(reasons), reasons, type: "selected" });

  const recorded: string[] = [];
  const failed: Record<string, string> = {};
  // Set when the run starts no further trial.
  let stopped =
    options.expectSelected !== undefined &&
    options.expectSelected !== jobs.length;
  let next = 0;
  const storedAt = new Map<string, string>();
  // A search that the replay of the selection froze belongs to a trial that is in the file already.
  if (!stopped) writeFreeze();
  const store = (trial: RecordedTrial, toolList: IdentifiedToolList): void => {
    writeFreeze();
    // Read again for each trial: the file changes while the model answers.
    writeRecording(
      files.recording,
      mergeRecording(
        readRecording(files.recording),
        [trial],
        [toolList],
        questionOrder,
        options.note
      )
    );
  };
  const worker = async (): Promise<void> => {
    while (!stopped && next < jobs.length) {
      const job = jobs[next++];
      if (job === undefined) return;
      const key = trialKey({ question: job.question.id, trial: job.trial });
      // The turn wraps an error of the model call, so the cause is kept here.
      let fault: string | null = null;
      try {
        const result = await runTrial(
          backend,
          job.question,
          async (request) => {
            const call = request.messages.filter(
              (message) => message.role === "assistant"
            ).length;
            try {
              const reply = await options.model(`${key}#${call}`, request);
              if (reply.model !== RECORDING_MODEL) {
                stopped = true;
                throw new Error(
                  `reply from the model ${reply.model}, not ${RECORDING_MODEL}`
                );
              }
              return reply.completion;
            } catch (error) {
              fault ??= error instanceof Error ? error.message : String(error);
              throw error;
            }
          },
          { log: options.log }
        );
        const recordedAt = now().toISOString();
        store(
          {
            answer: result.answer,
            completions: result.completions,
            grade: gradeAnswer(job.question, result.answer),
            model: RECORDING_MODEL,
            promptFormat: RECORDING_PROMPT_FORMAT,
            question: job.question.id,
            recordedAt,
            toolList: result.toolList.id,
            tools: result.trace.map(
              (entry) =>
                `${entry.tool}(${entry.args})${entry.ok ? "" : " failed"}`
            ),
            trial: job.trial,
          },
          result.toolList
        );
        storedAt.set(key, recordedAt);
        recorded.push(key);
        emit({ key, type: "done" });
      } catch (error) {
        const reason =
          fault ?? (error instanceof Error ? error.message : String(error));
        failed[key] = reason;
        emit({ key, reason, type: "failed" });
      }
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));

  const notStarted = jobs
    .slice(next)
    .map((job) => trialKey({ question: job.question.id, trial: job.trial }));
  let final = readRecording(files.recording);
  // Another program that writes the whole file during the run (a grading step) can delete trials
  // that this run stored. Such a trial is reported as failed, never as recorded.
  const present = new Set(
    (final?.trials ?? [])
      .filter((trial) => trial.recordedAt === storedAt.get(trialKey(trial)))
      .map(trialKey)
  );
  for (const key of recorded.filter((entry) => !present.has(entry))) {
    failed[key] =
      "stored, but no longer in the file at the end of the run: another program wrote the file";
  }
  const kept = recorded.filter((key) => present.has(key));
  if (
    selection.kind === "all" &&
    final !== undefined &&
    kept.length === jobs.length
  ) {
    final = mergeRecording(
      {
        ...final,
        trials: final.trials.filter((trial) => present.has(trialKey(trial))),
      },
      [],
      [],
      questionOrder,
      options.note
    );
    writeRecording(files.recording, final);
  }
  const finished: RecordRunResult = {
    count: final?.trials.length ?? 0,
    failed,
    notStarted,
    recorded: kept,
    type: "finished",
  };
  emit(finished);
  return finished;
};
