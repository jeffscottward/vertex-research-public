import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { AssistantCompletionRequest } from "../../../packages/api/src/server/assistant-runtime.ts";
import {
  type EvalBackend,
  replayRecording,
  runTrial,
  startEvalBackend,
} from "./harness.ts";
import { EVAL_QUESTIONS } from "./questions.ts";
import {
  parseBridgeLine,
  type RecordRunOptions,
  replyToCompletion,
  type RunMessage,
  recordRun,
  type TrialModel,
  upgradeRecording,
} from "./recorder.ts";
import {
  calledTools,
  RECORDING_MODEL,
  type RecordedTrial,
  type Recording,
  trialKey,
} from "./recording.ts";

// The recorder (recorder.ts) with a scripted model: each model call gets the reply that the committed
// recording holds for it, so a run reproduces the committed trials with no model. Real eval backend
// (Postgres with the synthetic fixture); the recording and the master-rules freeze are copies in a
// temporary folder.

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./${name}`, import.meta.url));
const COMMITTED = JSON.parse(
  readFileSync(fixture("eval-recording.fixture.json"), "utf8")
) as Recording;
const NOW = new Date("2026-12-01T00:00:00.000Z");
const question = (id: string) => {
  const found = EVAL_QUESTIONS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`question ${id} is missing`);
  return found;
};

/** A model that answers each call with the reply of the committed recording. */
const scripted =
  (
    behavior: Readonly<{
      model?: (key: string) => string;
      fault?: (key: string) => boolean;
      before?: (key: string) => void;
    }> = {}
  ): TrialModel =>
  async (key) => {
    behavior.before?.(key);
    if (behavior.fault?.(key) === true) {
      throw new Error("bridge fault: no model reply after 4 tries");
    }
    const [trial = "", call = ""] = key.split("#");
    const completion = COMMITTED.trials.find(
      (entry) => trialKey(entry) === trial
    )?.completions[Number(call)];
    if (completion === undefined) {
      throw new Error(`no scripted reply for ${key}`);
    }
    return {
      completion: {
        content: completion.content,
        finishReason: completion.toolCalls.length > 0 ? "tool_calls" : "stop",
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: completion.toolCalls.map((toolCall) => ({
          function: { arguments: toolCall.arguments, name: toolCall.name },
          id: toolCall.id,
          type: "function" as const,
        })),
      },
      model: behavior.model?.(key) ?? RECORDING_MODEL,
    };
  };

let backend: EvalBackend;
let folder: string;
let files: RecordRunOptions["files"];
let messages: RunMessage[];

const read = (): Recording =>
  JSON.parse(readFileSync(files.recording, "utf8")) as Recording;
const stored = (recording: Recording, key: string): RecordedTrial => {
  const found = recording.trials.find((entry) => trialKey(entry) === key);
  if (found === undefined) throw new Error(`trial ${key} is missing`);
  return found;
};
const run = (
  options: Partial<RecordRunOptions> & Pick<RecordRunOptions, "selection">
) =>
  recordRun({
    backend,
    concurrency: 2,
    emit: (message) => {
      messages.push(message);
    },
    files,
    log: () => undefined,
    model: scripted(),
    note: String(COMMITTED["note"]),
    now: () => NOW,
    questions: EVAL_QUESTIONS,
    trials: 3,
    ...options,
  });

/**
 * Writes the committed recording as if every trial had seen an older tool list: the current list
 * with another digest for `changed`. Returns the id of that older list.
 */
const writeWithOlderToolList = (changed: string): string => {
  const older = "0".repeat(64);
  const [current] = Object.values(COMMITTED.toolLists);
  if (current === undefined || !(changed in current)) {
    throw new Error(`the committed tool list has no tool ${changed}`);
  }
  writeFileSync(
    files.recording,
    JSON.stringify({
      ...COMMITTED,
      toolLists: { [older]: { ...current, [changed]: "f".repeat(64) } },
      trials: COMMITTED.trials.map((trial) => ({ ...trial, toolList: older })),
    })
  );
  return older;
};

beforeAll(async () => {
  backend = await startEvalBackend();
}, 120_000);

afterAll(async () => {
  await backend.close();
});

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "semantic-eval-recorder-"));
  files = {
    masterRules: join(folder, "master-rules.fixture.json"),
    recording: join(folder, "eval-recording.fixture.json"),
  };
  copyFileSync(fixture("eval-recording.fixture.json"), files.recording);
  copyFileSync(fixture("master-rules.fixture.json"), files.masterRules);
  messages = [];
});

afterEach(() => {
  rmSync(folder, { force: true, recursive: true });
});

describe("recordRun", () => {
  it("records the named question again and keeps every other trial and the header", async () => {
    const finished = await run({
      selection: { ids: ["Q1"], kind: "questions" },
    });

    expect(finished).toEqual({
      count: 90,
      failed: {},
      notStarted: [],
      recorded: expect.arrayContaining(["Q1.1", "Q1.2", "Q1.3"]),
      type: "finished",
    });
    expect(messages[0]).toEqual({
      keys: ["Q1.1", "Q1.2", "Q1.3"],
      reasons: {
        "Q1.1": "the run names this question",
        "Q1.2": "the run names this question",
        "Q1.3": "the run names this question",
      },
      type: "selected",
    });
    expect(messages.at(-1)).toEqual(finished);
    const after = read();
    for (const before of COMMITTED.trials) {
      const { audit: _audit, ...unaudited } = before;
      // A recorded trial is the committed one with a new date and no audit grade.
      expect(stored(after, trialKey(before))).toEqual(
        before.question === "Q1"
          ? { ...unaudited, recordedAt: NOW.toISOString() }
          : before
      );
    }
    expect(after["audit"]).toEqual(COMMITTED["audit"]);
    expect(after.toolLists).toEqual(COMMITTED.toolLists);
  });

  it("does not store a trial with a bridge fault and goes on with the next trial", async () => {
    const finished = await run({
      model: scripted({ fault: (key) => key === "Q1.2#1" }),
      selection: { ids: ["Q1"], kind: "questions" },
    });

    expect(finished.failed).toEqual({
      "Q1.2": "bridge fault: no model reply after 4 tries",
    });
    expect([...finished.recorded].sort()).toEqual(["Q1.1", "Q1.3"]);
    expect(messages).toContainEqual({
      key: "Q1.2",
      reason: "bridge fault: no model reply after 4 tries",
      type: "failed",
    });
    const after = read();
    expect(stored(after, "Q1.2")).toEqual(stored(COMMITTED, "Q1.2"));
    expect(stored(after, "Q1.1")).not.toHaveProperty("audit");
  });

  it("stops at a reply from another model: that trial is not stored and no further trial starts", async () => {
    const finished = await run({
      concurrency: 1,
      model: scripted({
        model: (key) => (key === "Q1.2#0" ? "other/model" : RECORDING_MODEL),
      }),
      selection: { ids: ["Q1"], kind: "questions" },
    });

    expect(finished.recorded).toEqual(["Q1.1"]);
    expect(finished.failed).toEqual({
      "Q1.2": `reply from the model other/model, not ${RECORDING_MODEL}`,
    });
    expect(finished.notStarted).toEqual(["Q1.3"]);
    const after = read();
    expect(stored(after, "Q1.2")).toEqual(stored(COMMITTED, "Q1.2"));
    expect(stored(after, "Q1.3")).toEqual(stored(COMMITTED, "Q1.3"));
  });

  it("writes each finished trial at once, so a killed run keeps it", async () => {
    let seenAtSecondTrial: RecordedTrial | undefined;
    await run({
      concurrency: 1,
      model: scripted({
        before: (key) => {
          if (key === "Q1.2#0") seenAtSecondTrial = stored(read(), "Q1.1");
        },
      }),
      selection: { ids: ["Q1"], kind: "questions" },
    });

    expect(seenAtSecondTrial?.recordedAt).toBe(NOW.toISOString());
  });

  it("writes the master-rules freeze when a trial froze a new search, and leaves the file otherwise", async () => {
    const before = readFileSync(files.masterRules, "utf8");
    await run({ selection: { ids: ["Q1"], kind: "questions" } });
    expect(readFileSync(files.masterRules, "utf8")).toBe(before);

    const masterRules = {
      note: backend.masterRules.note,
      searches: { ...backend.masterRules.searches },
    };
    await run({
      backend: { ...backend, masterRules },
      model: scripted({
        before: (key) => {
          if (key === "Q1.1#0") masterRules.searches["a new search"] = [];
        },
      }),
      selection: { ids: ["Q1"], kind: "questions" },
    });
    expect(
      (
        JSON.parse(readFileSync(files.masterRules, "utf8")) as {
          searches: Record<string, unknown>;
        }
      ).searches
    ).toHaveProperty("a new search");
  });

  it("drops the trials that a full run did not record when it stored every trial", async () => {
    const finished = await run({
      questions: [question("Q1")],
      selection: { kind: "all" },
      trials: 2,
    });

    expect(finished.count).toBe(2);
    const after = read();
    expect(after.trials.map(trialKey)).toEqual(["Q1.1", "Q1.2"]);
    expect(after["audit"]).toEqual(COMMITTED["audit"]);
  });

  it("keeps the other trials of a full run that did not store every trial", async () => {
    const finished = await run({
      model: scripted({ fault: (key) => key.startsWith("Q1.2#") }),
      questions: [question("Q1")],
      selection: { kind: "all" },
    });

    expect(Object.keys(finished.failed)).toEqual(["Q1.2"]);
    expect(finished.count).toBe(90);
  });

  it("stops before the first model request when the selection has another size than expected", async () => {
    const before = readFileSync(files.recording, "utf8");
    let requests = 0;

    const finished = await run({
      expectSelected: 30,
      model: scripted({
        before: () => {
          requests += 1;
        },
      }),
      selection: { ids: ["Q1"], kind: "questions" },
    });

    expect(requests).toBe(0);
    expect(messages[0]).toMatchObject({
      keys: ["Q1.1", "Q1.2", "Q1.3"],
      type: "selected",
    });
    expect(finished).toMatchObject({
      failed: {},
      notStarted: ["Q1.1", "Q1.2", "Q1.3"],
      recorded: [],
    });
    expect(readFileSync(files.recording, "utf8")).toBe(before);
  });

  it("reports a stored trial as failed when another program wrote the file over it during the run", async () => {
    const committedText = readFileSync(files.recording, "utf8");

    const finished = await run({
      concurrency: 1,
      model: scripted({
        before: (key) => {
          // A grading step that read the file before the run writes it whole now.
          if (key === "Q1.3#0") writeFileSync(files.recording, committedText);
        },
      }),
      selection: { ids: ["Q1"], kind: "questions" },
    });

    expect(finished.recorded).toEqual(["Q1.3"]);
    expect(Object.keys(finished.failed)).toEqual(["Q1.1", "Q1.2"]);
    expect(finished.failed["Q1.1"]).toMatch(/another program wrote the file/u);
  });

  it("refuses a partial run on a version 2 file before any model call", async () => {
    writeFileSync(
      files.recording,
      JSON.stringify({ ...COMMITTED, schemaVersion: 2 })
    );

    await expect(run({ selection: { kind: "stale" } })).rejects.toThrow(
      "Run the recorder with `upgrade` first"
    );
    expect(messages).toEqual([]);
  });
});

describe("recordRun with the stale selection", () => {
  it("selects nothing and writes nothing when the committed recording replays", async () => {
    const before = readFileSync(files.recording, "utf8");

    const finished = await run({ selection: { kind: "stale" } });

    expect(messages[0]).toEqual({ keys: [], reasons: {}, type: "selected" });
    expect(finished.recorded).toEqual([]);
    expect(readFileSync(files.recording, "utf8")).toBe(before);
    // A stale selection replays all 90 trials first.
  }, 120_000);

  it("records one witness trial for each question, the oldest, when a tool changed that no trial calls", async () => {
    const used = new Set(
      COMMITTED.trials.flatMap((trial) => [...calledTools(trial)])
    );
    expect(used.has("market_bars")).toBe(false);
    const older = writeWithOlderToolList("market_bars");
    const oldestOf = (id: string): string =>
      trialKey(
        [...COMMITTED.trials]
          .filter((trial) => trial.question === id)
          .sort(
            (left, right) =>
              left.recordedAt.localeCompare(right.recordedAt) ||
              left.trial - right.trial
          )[0] ?? { question: id, trial: 0 }
      );

    // The replay judges this file as the recorder does: every trial needs a witness.
    const before = await replayRecording(backend, EVAL_QUESTIONS, read());
    expect(
      [...before.values()].filter(
        (verdict) => verdict.tool?.state !== "needs-witness"
      )
    ).toEqual([]);

    const finished = await run({ selection: { kind: "stale" } });

    const selected = messages[0];
    if (selected?.type !== "selected") throw new Error("no selection");
    expect(selected.keys).toEqual(
      EVAL_QUESTIONS.map((entry) => oldestOf(entry.id))
    );
    expect(selected.keys).toHaveLength(EVAL_QUESTIONS.length);
    expect(selected.reasons).toEqual(
      Object.fromEntries(
        EVAL_QUESTIONS.map((entry) => [
          oldestOf(entry.id),
          `witness trial: the tool list changed (market_bars) and no trial of ${entry.id} was recorded with the current list`,
        ])
      )
    );
    expect(finished.failed).toEqual({});
    // After the run every trial is valid: the witnesses saw the current list, the others drifted.
    const after = read();
    const verdicts = await replayRecording(backend, EVAL_QUESTIONS, after);
    const states = [...verdicts.values()].map((verdict) => ({
      stale: verdict.stale,
      state: verdict.tool?.state,
    }));
    expect(states.filter((entry) => entry.stale !== null)).toEqual([]);
    expect(states.filter((entry) => entry.state === "exact")).toHaveLength(
      EVAL_QUESTIONS.length
    );
    expect(states.filter((entry) => entry.state === "drifted")).toHaveLength(
      COMMITTED.trials.length - EVAL_QUESTIONS.length
    );
    expect(Object.keys(after.toolLists).sort()).toEqual(
      [older, ...Object.keys(COMMITTED.toolLists)].sort()
    );
    // A second stale run finds nothing to record.
    messages = [];
    await run({ selection: { kind: "stale" } });
    expect(messages[0]).toEqual({ keys: [], reasons: {}, type: "selected" });
  }, 120_000);

  it("writes a search that the replay of the selection froze, also when the run records nothing", async () => {
    // The backend of a recording answers a search that is not frozen from the live index and adds
    // it. This stand-in adds one during the replay of the stale selection.
    const masterRules = {
      note: backend.masterRules.note,
      searches: { ...backend.masterRules.searches },
    };

    const finished = await run({
      backend: {
        ...backend,
        callProcedure: (procedure, input) => {
          masterRules.searches["frozen by the replay"] = [];
          return backend.callProcedure(procedure, input);
        },
        masterRules,
      },
      selection: { kind: "stale" },
    });

    expect(finished.recorded).toEqual([]);
    expect(
      (
        JSON.parse(readFileSync(files.masterRules, "utf8")) as {
          searches: Record<string, unknown>;
        }
      ).searches
    ).toHaveProperty("frozen by the replay");
  }, 120_000);

  it("selects a trial that was asked with another prompt format of the bridge or by another model", async () => {
    writeFileSync(
      files.recording,
      JSON.stringify({
        ...COMMITTED,
        trials: COMMITTED.trials.map((trial) => ({
          ...trial,
          ...(trialKey(trial) === "Q2.1" ? { promptFormat: "older" } : {}),
          ...(trialKey(trial) === "Q3.2" ? { model: "other/model" } : {}),
        })),
      })
    );

    await run({ expectSelected: 0, selection: { kind: "stale" } });

    expect(messages[0]).toEqual({
      keys: ["Q2.1", "Q3.2"],
      reasons: {
        "Q2.1": "asked with another prompt format of the bridge",
        "Q3.2": `recorded with the model other/model, not ${RECORDING_MODEL}`,
      },
      type: "selected",
    });
  }, 120_000);

  it("records every trial that calls a changed tool, and a witness for each other question", async () => {
    writeWithOlderToolList("drift_status");
    const callers = COMMITTED.trials.filter((trial) =>
      calledTools(trial).has("drift_status")
    );
    const withCaller = new Set(callers.map((trial) => trial.question));
    expect(callers.length).toBeGreaterThan(0);

    await run({ selection: { kind: "stale" } });

    const selected = messages[0];
    if (selected?.type !== "selected") throw new Error("no selection");
    expect(selected.keys).toHaveLength(
      callers.length + EVAL_QUESTIONS.length - withCaller.size
    );
    for (const trial of callers) {
      expect(selected.reasons[trialKey(trial)]).toBe(
        "the definition of a tool that the trial calls changed: drift_status"
      );
    }
  }, 120_000);
});

describe("upgradeRecording", () => {
  // The digest of a version 2 recording, written out here as the description of that format: the
  // JSON text of the tool list, then role (or tool call id) and content of every message but the
  // model's own.
  const versionTwoDigest = (request: AssistantCompletionRequest): string => {
    const hash = createHash("sha256");
    hash.update(`${JSON.stringify(request.tools)}\n`);
    for (const message of request.messages) {
      if (message.role === "assistant") continue;
      const id = message.role === "tool" ? message.tool_call_id : message.role;
      hash.update(`${id}\n${message.content}\n`);
    }
    return hash.digest("hex");
  };
  /** The committed trial as a version 2 trial: no tool list, whole-input digests. */
  const asVersionTwo = async (key: string): Promise<RecordedTrial> => {
    const committed = stored(COMMITTED, key);
    const digests: string[] = [];
    const model = scripted();
    await runTrial(
      backend,
      question(committed.question),
      async (request) => {
        digests.push(versionTwoDigest(request));
        return (await model(`${key}#${digests.length - 1}`, request))
          .completion;
      },
      { log: () => undefined }
    );
    const {
      promptFormat: _promptFormat,
      toolList: _toolList,
      ...rest
    } = committed;
    return {
      ...rest,
      completions: committed.completions.map((completion, index) => ({
        ...completion,
        inputDigest: digests[index] ?? "",
      })),
    } as unknown as RecordedTrial;
  };

  it("gives a version 2 trial that still replays its tool list and message digests, and changes nothing else", async () => {
    const versionTwo = {
      audit: COMMITTED["audit"],
      note: COMMITTED["note"],
      schemaVersion: 2,
      trials: [await asVersionTwo("Q1.1"), await asVersionTwo("Q13.2")],
    } as unknown as Recording;

    const result = await upgradeRecording(
      backend,
      EVAL_QUESTIONS,
      versionTwo,
      String(COMMITTED["note"])
    );

    expect(result.upgraded).toEqual(["Q1.1", "Q13.2"]);
    expect(result.kept).toEqual({});
    expect(result.changed).toBe(true);
    // Byte-equal to the committed trials, field order included.
    expect(JSON.stringify(result.recording.trials)).toBe(
      JSON.stringify([stored(COMMITTED, "Q1.1"), stored(COMMITTED, "Q13.2")])
    );
    expect(result.recording.toolLists).toEqual(COMMITTED.toolLists);
    expect(result.recording.schemaVersion).toBe(3);
    // A second run changes nothing.
    const again = await upgradeRecording(
      backend,
      EVAL_QUESTIONS,
      result.recording,
      String(COMMITTED["note"])
    );
    expect(again.upgraded).toEqual([]);
    // A file in the current format is not written again.
    expect(again.changed).toBe(false);
    expect(JSON.stringify(again.recording)).toBe(
      JSON.stringify(result.recording)
    );
  });

  it("keeps a version 2 trial that no longer replays as it is and names the reason", async () => {
    const good = await asVersionTwo("Q1.1");
    const first = good.completions[0];
    if (first === undefined) throw new Error("Q1.1 has no model call");
    const staleTrial = {
      ...good,
      completions: [
        { ...first, inputDigest: "0".repeat(64) },
        ...good.completions.slice(1),
      ],
    };

    const result = await upgradeRecording(
      backend,
      EVAL_QUESTIONS,
      {
        note: "n",
        schemaVersion: 2,
        trials: [staleTrial],
      } as unknown as Recording,
      "n"
    );

    expect(result.upgraded).toEqual([]);
    // The file is written although no trial was upgraded: it gets schemaVersion 3, so that a
    // stale run can record the kept trial.
    expect(result.changed).toBe(true);
    expect(result.recording.schemaVersion).toBe(3);
    expect(result.kept).toEqual({
      "Q1.1":
        "the input of model call 0 changed (tool definitions, system prompt, question or a tool result)",
    });
    expect(result.recording.trials).toEqual([staleTrial]);
  });
});

describe("parseBridgeLine", () => {
  it("reads a reply and a fault", () => {
    expect(
      parseBridgeLine(
        '{"key":"Q1.1#0","content":"","toolCalls":[{"name":"terms_query","arguments":{"term":"x"}}],"model":"m"}'
      )
    ).toEqual({
      content: "",
      key: "Q1.1#0",
      model: "m",
      toolCalls: [{ arguments: { term: "x" }, name: "terms_query" }],
    });
    expect(parseBridgeLine('{"key":"Q1.1#0","fault":"no reply"}')).toEqual({
      fault: "no reply",
      key: "Q1.1#0",
    });
  });

  it("takes a call with no arguments, and passes arguments that are no object on as JSON text for the turn to refuse", () => {
    expect(
      parseBridgeLine(
        '{"key":"k","content":"","toolCalls":[{"name":"terms_list"}],"model":"m"}'
      )
    ).toMatchObject({ toolCalls: [{ name: "terms_list" }] });
    const reply = parseBridgeLine(
      '{"key":"Q1.1#0","content":"","toolCalls":[{"name":"terms_list","arguments":[1]},{"name":"terms_list","arguments":null}],"model":"m"}'
    );
    if ("fault" in reply) throw new Error("a reply was expected");
    expect(
      replyToCompletion("Q1.1#0", reply).toolCalls.map(
        (call) => call.function.arguments
      )
    ).toEqual(["[1]", "{}"]);
  });

  it("refuses a line that is not JSON, a reply with no model and a reply with no key", () => {
    expect(() => parseBridgeLine("{not json")).toThrow(
      "bridge line is not JSON"
    );
    expect(() =>
      parseBridgeLine('{"key":"Q1.1#0","content":"a","toolCalls":[]}')
    ).toThrow("bridge line is not {key, content");
    expect(() =>
      parseBridgeLine('{"content":"a","toolCalls":[],"model":"m"}')
    ).toThrow("bridge line is not {key, content");
  });
});
