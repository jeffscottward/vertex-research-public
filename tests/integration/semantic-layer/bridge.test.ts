import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type BridgeOptions,
  type BridgeRequest,
  buildPrompt,
  type Completion,
  modelOf,
  parseModelReply,
  REPLY_SCHEMA,
  type RecorderProcess,
  runBridge,
} from "./bridge.ts";
import {
  parseSessionArgs,
  recorderArgsOf,
  sessionArgs,
  statsOf,
} from "./record-session.ts";
import { RECORDING_MODEL, RECORDING_PROMPT_FORMAT } from "./recording.ts";

// The model bridge (bridge.ts) with a scripted `completion()` and a scripted recorder process. No
// model, no database and no child process.

// One synthetic request: non-ASCII text, two tool calls, tool results, a nested tool schema, an empty
// list and object, a fraction. JSON text, so that the key order is the order of the recorder's line.
const PROBE = JSON.parse(
  String.raw`{"key":"P1.1#1","type":"request","messages":[{"role":"system","content":"You are the assistant. Use the tools. Café → ok."},{"role":"user","content":"What is my net liquidation? 😀"},{"role":"assistant","content":"","tool_calls":[{"id":"P1.1_0.0","type":"function","function":{"name":"terms_query","arguments":"{\"term\":\"net_liquidation\"}"}},{"id":"P1.1_0.1","type":"function","function":{"name":"terms_list","arguments":"{}"}}]},{"role":"tool","tool_call_id":"P1.1_0.0","content":"{\"value\":248350.12,\"unit\":\"USD\",\"note\":\"line1\\nline2 – dash\"}"},{"role":"tool","tool_call_id":"P1.1_0.1","content":"[]"},{"role":"assistant","content":"Checking one more thing.","tool_calls":[]}],"tools":[{"type":"function","function":{"name":"terms_query","description":"Answers one certified term. Quote \"exact\" names; tab\there; ünïcode.","parameters":{"type":"object","properties":{"term":{"type":"string","minLength":1},"limit":{"type":"integer","minimum":1,"maximum":200,"default":50},"ratio":{"type":"number","default":0.5},"tags":{"type":"array","items":{"type":"string"},"default":[]},"extra":{"type":"object","properties":{},"additionalProperties":false}},"required":["term"],"additionalProperties":false}}},{"type":"function","function":{"name":"terms_list","description":"Lists the terms.","parameters":{"type":"object","properties":{},"additionalProperties":false}}}]}`
) as BridgeRequest;

describe("buildPrompt", () => {
  it("builds the transcript of the messages", () => {
    expect(buildPrompt(PROBE).prompt).toBe(
      'USER:\nWhat is my net liquidation? 😀\n\nASSISTANT:\nTOOL CALL P1.1_0.0: terms_query({"term":"net_liquidation"})\nTOOL CALL P1.1_0.1: terms_list({})\n\nTOOL RESULT P1.1_0.0:\n{"value":248350.12,"unit":"USD","note":"line1\\nline2 – dash"}\n\nTOOL RESULT P1.1_0.1:\n[]\n\nASSISTANT:\nChecking one more thing.\n\nReply now as the assistant with the JSON object.'
    );
  });

  it("is byte-identical to the prompt of the bridge that recorded the trials of 2026-11-20 and 2026-11-26", () => {
    // RECORDING_PROMPT_FORMAT is the hash of system text and prompt that the earlier (Python) bridge
    // built for this request. Every trial stores it. When the prompt must change, change the
    // constant to the new hash: every trial is then stale and is recorded again.
    const { prompt, system } = buildPrompt(PROBE);
    expect(
      createHash("sha256").update(`${system}\n\0\n${prompt}`).digest("hex")
    ).toBe(RECORDING_PROMPT_FORMAT);
    expect(RECORDING_PROMPT_FORMAT).toBe(
      "158f1e99d3a322715b69164490e8135dd08648ddcfb7b7e1f97f6c342dc865ba"
    );
    expect(system).toContain("Caf\u00e9 \u2192 ok.\n\n---\nBridge note");
    // The tool list is ASCII: every other character is an escape of its UTF-16 code units.
    expect(system).toContain(String.raw`\u00fcn\u00efcode`);
  });

  it("writes an empty tool list when the request has none", () => {
    expect(
      buildPrompt({ messages: [{ content: "s", role: "system" }] }).system
    ).toMatch(/Tools:\n\[\]$/u);
  });
});

describe("parseModelReply", () => {
  it("takes the reply object and reads the arguments text of each call", () => {
    expect(
      parseModelReply({
        content: "",
        toolCalls: [{ arguments: '{"term":"x"}', name: "terms_query" }],
      })
    ).toEqual({
      content: "",
      toolCalls: [{ arguments: { term: "x" }, name: "terms_query" }],
    });
  });

  it("finds the object in plain text, in a code fence and after other text", () => {
    const reply = { content: "done", toolCalls: [] };
    for (const text of [
      '{"content":"done","toolCalls":[]}',
      '```json\n{"content":"done","toolCalls":[]}\n```',
      'Here is the reply: {"content":"done","toolCalls":[]} (end)',
    ]) {
      expect(parseModelReply(text), text).toEqual(reply);
    }
  });

  it("reads no arguments, an empty text and an empty list as an empty object, and passes every other value on", () => {
    // The earlier bridge did the same (Python: `args or {}`). The turn reads blank text as no
    // arguments and refuses a value that is no object.
    expect(
      parseModelReply({
        content: "",
        toolCalls: [
          { name: "a" },
          { arguments: "", name: "a2" },
          { arguments: [], name: "a3" },
          { arguments: " ", name: "b" },
          { arguments: { c: 1 }, name: "c" },
          { arguments: "[1]", name: "d" },
          { arguments: "null", name: "e" },
        ],
      }).toolCalls
    ).toEqual([
      { arguments: {}, name: "a" },
      { arguments: {}, name: "a2" },
      { arguments: {}, name: "a3" },
      { arguments: " ", name: "b" },
      { arguments: { c: 1 }, name: "c" },
      { arguments: [1], name: "d" },
      { arguments: null, name: "e" },
    ]);
  });

  it("refuses text that is not JSON, an object with no content, a call with no name and arguments that are not JSON", () => {
    expect(() => parseModelReply("I cannot answer")).toThrow();
    expect(() => parseModelReply({ toolCalls: [] })).toThrow(
      "the reply is not the JSON object"
    );
    expect(() =>
      parseModelReply({ content: "", toolCalls: [{ arguments: "{}" }] })
    ).toThrow("a tool call has no name");
    expect(() =>
      parseModelReply({
        content: "",
        toolCalls: [{ arguments: "{broken", name: "a" }],
      })
    ).toThrow();
    expect(() => parseModelReply({ content: "", toolCalls: "none" })).toThrow(
      "toolCalls is not a list"
    );
  });
});

describe("REPLY_SCHEMA", () => {
  it("is the schema of the earlier bridge, key order included", () => {
    // The JSON text of REPLY_SCHEMA of the Python bridge (json.dumps with compact separators).
    expect(JSON.stringify(REPLY_SCHEMA)).toBe(
      '{"type":"object","properties":{"content":{"type":"string"},"toolCalls":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"string","description":"JSON object text with the tool arguments"}},"required":["name","arguments"]}}},"required":["content","toolCalls"]}'
    );
  });
});

describe("bridge.ts", () => {
  it("imports only node: modules, because the eval kernel cannot load a package of this workspace", () => {
    const source = readFileSync(
      new URL("./bridge.ts", import.meta.url),
      "utf8"
    );
    const specifiers = [...source.matchAll(/\bfrom "([^"]+)"/gu)].map(
      (match) => match[1] ?? ""
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((name) => !name.startsWith("node:"))).toEqual([]);
    expect(source).not.toMatch(/\bimport\(/u);
  });
});

describe("modelOf", () => {
  it("gives the model of the last attempt that names one", async () => {
    expect(
      await modelOf({
        attempts: async () => [{ model: "a" }, { model: "b" }, { model: null }],
        wait: async () => "",
      })
    ).toBe("b");
    expect(
      await modelOf({ attempts: async () => [], wait: async () => "" })
    ).toBeNull();
  });
});

type CompletionCall = Readonly<{
  prompt: string;
  options: Parameters<Completion>[1];
}>;

/** A `completion()` that gives the outputs in order (the last one again when they run out). */
const completionOf = (
  outputs: readonly unknown[],
  model: string = RECORDING_MODEL
): Readonly<{ completion: Completion; calls: CompletionCall[] }> => {
  const calls: CompletionCall[] = [];
  return {
    calls,
    completion: async (prompt, options) => {
      const output = outputs[Math.min(calls.length, outputs.length - 1)];
      calls.push({ options, prompt });
      return {
        attempts: async () => [{ model }],
        wait: async () => {
          if (output instanceof Error) throw output;
          return output;
        },
      };
    },
  };
};

type FakeRecorder = Readonly<{
  process: RecorderProcess;
  written: string[];
  print: (line: string, stream?: "out" | "err") => void;
  end: (code: number | null) => void;
  killed: () => boolean;
  /** Resolves when the bridge wrote `count` lines. */
  writes: (count: number) => Promise<void>;
}>;

const fakeRecorder = (): FakeRecorder => {
  const written: string[] = [];
  const listeners: ((stream: "out" | "err", line: string) => void)[] = [];
  let killed = false;
  let resolveExit: (code: number | null) => void = () => undefined;
  // Executor form: the tests tsconfig targets a lib without Promise.withResolvers.
  const exit = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  return {
    end: resolveExit,
    killed: () => killed,
    print: (line, stream = "out") => {
      for (const listener of listeners) listener(stream, line);
    },
    process: {
      exit,
      kill: () => {
        killed = true;
        resolveExit(null);
      },
      onLine: (listener) => {
        listeners.push(listener);
      },
      write: (line) => {
        written.push(line);
        return true;
      },
    },
    writes: async (count) => {
      while (written.length < count) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
    written,
  };
};

const REQUEST = `@@EVAL ${JSON.stringify({ ...PROBE, type: "request" })}`;
const FINISHED = {
  count: 90,
  failed: {},
  notStarted: [],
  recorded: ["P1.1"],
  type: "finished",
};
const REPLY = { content: "the answer", toolCalls: [] };

let folder: string;
let log: string;

/** Runs the bridge against a scripted recorder; `script` starts when the recorder was started. */
const runWith = async (
  completion: Completion,
  script: (recorder: FakeRecorder) => Promise<void>,
  options: Partial<BridgeOptions> = {}
) => {
  const recorder = fakeRecorder();
  let started: readonly string[] | null = null;
  const stats = await runBridge({
    completion,
    log,
    model: RECORDING_MODEL,
    recorderArgs: ["3", "4", "stale"],
    start: (recorderArgs) => {
      started = recorderArgs;
      setTimeout(() => {
        void script(recorder);
      }, 0);
      return recorder.process;
    },
    ...options,
  });
  return { recorder, started, stats };
};

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "semantic-eval-bridge-"));
  log = join(folder, "run.log");
});

afterEach(() => {
  rmSync(folder, { force: true, recursive: true });
});

describe("runBridge", () => {
  it("does not start the recorder when the session answers with another model", async () => {
    const { completion } = completionOf(["OK"], "google/other-model");

    const { started, stats } = await runWith(completion, async () => undefined);

    expect(started).toBeNull();
    expect(stats).toMatchObject({
      models: ["google/other-model"],
      outcome: "wrong-model-before-start",
      rc: null,
    });
    expect(readFileSync(log, "utf8")).toContain(
      `ABORT the session answers with the model google/other-model, not ${RECORDING_MODEL}`
    );
  });

  it("answers a request with the model reply and the model id, and reports the end of the recorder", async () => {
    const { calls, completion } = completionOf(["OK", REPLY]);

    const { recorder, started, stats } = await runWith(
      completion,
      async (process) => {
        process.print(
          '@@EVAL {"type":"selected","keys":["P1.1"],"reasons":{}}'
        );
        process.print("a log line of the recorder", "err");
        process.print(REQUEST);
        await process.writes(1);
        process.print(`@@EVAL ${JSON.stringify(FINISHED)}`);
        process.end(0);
      }
    );

    expect(started).toEqual(["3", "4", "stale"]);
    expect(recorder.written.map((line) => JSON.parse(line))).toEqual([
      { key: "P1.1#1", ...REPLY, model: RECORDING_MODEL },
    ]);
    // The first try asks for the reply schema, with the prompt of buildPrompt.
    expect(calls[1]?.prompt).toBe(buildPrompt(PROBE).prompt);
    expect(calls[1]?.options).toMatchObject({
      model: "default",
      system: buildPrompt(PROBE).system,
    });
    expect(calls[1]?.options.schema).toBe(REPLY_SCHEMA);
    expect(stats).toMatchObject({
      errors: 0,
      faults: 0,
      last: FINISHED,
      models: [RECORDING_MODEL],
      outcome: "finished",
      rc: 0,
      requests: 1,
      selected: 1,
    });
    const lines = readFileSync(log, "utf8");
    expect(lines).toContain("REQUEST P1.1#1\n");
    expect(lines).toContain("ERR a log line of the recorder\n");
    expect(lines).toContain('REPLY {"key":"P1.1#1"');
    expect(lines).toContain("STATS {");
  });

  it("asks again as plain text when a call fails, and uses the first reply object", async () => {
    const { calls, completion } = completionOf([
      "OK",
      new Error("structured output rejected"),
      `Here: ${JSON.stringify(REPLY)}`,
    ]);

    const { recorder, stats } = await runWith(completion, async (process) => {
      process.print(REQUEST);
      await process.writes(1);
      process.print(`@@EVAL ${JSON.stringify(FINISHED)}`);
      process.end(0);
    });

    expect(JSON.parse(recorder.written[0] ?? "")).toMatchObject(REPLY);
    expect(calls[2]?.options.schema).toBeUndefined();
    expect(stats).toMatchObject({ errors: 1, faults: 0, outcome: "finished" });
  });

  it("sends a fault after four tries, never an answer that the model did not give", async () => {
    const { calls, completion } = completionOf(["OK", "I cannot answer"]);

    const { recorder, stats } = await runWith(completion, async (process) => {
      process.print(REQUEST);
      await process.writes(1);
      process.print(
        `@@EVAL ${JSON.stringify({ ...FINISHED, failed: { "P1.1": "bridge fault" }, recorded: [] })}`
      );
      process.end(1);
    });

    expect(calls).toHaveLength(5);
    const fault = JSON.parse(recorder.written[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(Object.keys(fault).sort()).toEqual(["fault", "key"]);
    expect(fault["key"]).toBe("P1.1#1");
    expect(fault["fault"]).toMatch(
      /^no model reply after 4 tries; last error: /u
    );
    expect(stats).toMatchObject({
      errors: 4,
      faults: 1,
      outcome: "finished",
      rc: 1,
    });
  });

  it("kills the recorder at a protocol line that is not JSON", async () => {
    const { completion } = completionOf(["OK", REPLY]);

    const { recorder, stats } = await runWith(completion, async (process) => {
      process.print('@@EVAL {"type":"request","key":"P1.1#0","mess{"event":');
    });

    expect(recorder.killed()).toBe(true);
    expect(stats).toMatchObject({ outcome: "garbled-line", rc: null });
    expect(readFileSync(log, "utf8")).toContain(
      "ABORT protocol line is not JSON; first 200 characters: "
    );
  });

  it("asks the model no more for a request when the recorder is gone", async () => {
    // Every reply is unusable, so a live recorder would get four tries.
    const { calls, completion } = completionOf(["OK", "I cannot answer"]);

    const { recorder, stats } = await runWith(completion, async (process) => {
      process.print(REQUEST);
      process.print("@@EVAL {broken");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The check call and the one try that was running. That try is no error of the run and
    // writes no line after the statistics.
    expect(calls).toHaveLength(2);
    expect(recorder.written).toEqual([]);
    expect(stats.errors).toBe(0);
    expect(readFileSync(log, "utf8").trimEnd().split("\n").at(-1)).toMatch(
      /^STATS /u
    );
  });

  it("kills the recorder at the deadline", async () => {
    const { completion } = completionOf(["OK"]);

    const { recorder, stats } = await runWith(
      completion,
      async () => undefined,
      { deadlineSeconds: 0.02 }
    );

    expect(recorder.killed()).toBe(true);
    expect(stats.outcome).toBe("deadline");
  });

  it("reports a recorder that ended with no last message", async () => {
    const { completion } = completionOf(["OK"]);

    const { stats } = await runWith(completion, async (process) => {
      process.print("error: Postgres is not reachable", "err");
      process.end(1);
    });

    expect(stats).toMatchObject({ outcome: "recorder-ended-early", rc: 1 });
  });

  it("refuses to write into the log of an earlier run", async () => {
    const { completion } = completionOf(["OK"]);
    await runWith(completion, async (process) => {
      process.end(0);
    });
    expect(existsSync(log)).toBe(true);

    await expect(runWith(completion, async () => undefined)).rejects.toThrow(
      "log exists"
    );
  });
});

describe("the recording session", () => {
  const NOW = new Date("2026-11-26T08:00:00.000Z");
  // No log file exists, whatever the temporary directory of the machine holds.
  const parse = (argv: readonly string[]) =>
    parseSessionArgs(argv, NOW, () => false);

  it("reads the options and passes the recorder arguments on", () => {
    const options = parse([
      "--expect=30",
      "--log=/tmp/run.log",
      "3",
      "4",
      "stale",
    ]);
    expect(options).toEqual({
      deadlineSeconds: 3000,
      expectSelected: 30,
      log: "/tmp/run.log",
      needsModel: true,
      recorderArgs: ["3", "4", "stale"],
    });
    expect(recorderArgsOf(options)).toEqual(["--expect=30", "3", "4", "stale"]);
    expect(parse([]).log).toBe(
      join(tmpdir(), "semantic-eval-record-2026-11-26T08-00-00-000Z.log")
    );
  });

  it("keeps a log path with an equals sign and makes a relative one absolute", () => {
    expect(parse(["--log=/tmp/a=b.log"]).log).toBe("/tmp/a=b.log");
    expect(parse(["--log=run.log"]).log).toBe(join(process.cwd(), "run.log"));
  });

  it("needs no model for upgrade and for --expect=0", () => {
    expect(parse(["3", "6", "upgrade"]).needsModel).toBe(false);
    expect(parse(["--expect=0", "3", "4", "stale"]).needsModel).toBe(false);
    expect(parse(["3", "4", "stale"]).needsModel).toBe(true);
  });

  it("refuses a log file that exists for a run that needs the model, and takes it for a run that needs none", () => {
    const exists = (): boolean => true;
    expect(() =>
      parseSessionArgs(["--log=/tmp/run.log", "3", "4", "stale"], NOW, exists)
    ).toThrow("The log file /tmp/run.log exists");
    expect(
      parseSessionArgs(["--log=/tmp/run.log", "3", "6", "upgrade"], NOW, exists)
        .needsModel
    ).toBe(false);
  });

  it("refuses a wrong argument before any session starts", () => {
    expect(() => parse(["3", "4", "Q99"])).toThrow("Unknown question id: Q99");
    expect(() => parse(["0"])).toThrow("positive whole number");
    expect(() => parse(["--fast"])).toThrow("Unknown option");
    expect(() => parse(["--expect=many"])).toThrow("Unknown option");
  });

  it("starts the session with the recording model and one eval cell that runs the bridge", () => {
    const args = sessionArgs({
      deadlineSeconds: 3000,
      expectSelected: 30,
      log: "/tmp/run.log",
      needsModel: true,
      recorderArgs: ["3", "4", "stale"],
    });
    expect(
      args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)
    ).toEqual(["--model", RECORDING_MODEL]);
    const prompt = args.at(-1) ?? "";
    expect(prompt).toContain('language "js", timeout 3300');
    expect(prompt).toMatch(
      /const \{ runBridge \} = await import\(".*\/tests\/integration\/semantic-layer\/bridge\.ts"\);/u
    );
    expect(prompt).toContain(
      `await runBridge({ completion, ...{"deadlineSeconds":3000,"log":"/tmp/run.log","model":"${RECORDING_MODEL}","recorderArgs":["--expect=30","3","4","stale"]} });`
    );
  });

  it("reads the verdict of a run from the last statistics line of the bridge log", () => {
    expect(
      statsOf(
        'REQUEST Q1.1#0\nSTATS {"rc":1}\nSTATS {"rc":0,"outcome":"finished"}\n'
      )
    ).toEqual({ line: 'STATS {"rc":0,"outcome":"finished"}', rc: 0 });
    expect(statsOf("REQUEST Q1.1#0\n")).toBeNull();
    expect(statsOf("STATS {broken\n")).toBeNull();
  });
});
