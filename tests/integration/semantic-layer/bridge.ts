// Model bridge of the semantic-layer eval recorder (record.ts). It runs inside the JavaScript eval
// kernel of an OMP session and answers each model request of the recorder with `completion()` of that
// session, so a recording uses no new provider. The model of `completion()` is the model that the
// session was started with; record-session.ts starts the session with RECORDING_MODEL and has it call
// `runBridge` once.
//
// This file imports only `node:` modules (bridge.test.ts checks it): the eval kernel cannot resolve
// the packages of this workspace (probe of 2026-11-26), so the recorder itself runs as a child
// process with the Bun of the repository, and this file starts it.
//
// The prompt that `buildPrompt` makes is model input. It is byte-identical to the prompt of the
// bridge that recorded the trials of 2026-11-20 and 2026-11-26. bridge.test.ts pins it to
// RECORDING_PROMPT_FORMAT (recording.ts), which every trial stores: a change of this prompt changes
// that constant, makes every trial stale and so needs a full recording.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** The part of the kernel's `completion()` that the bridge uses. */
export type CompletionHandle = Readonly<{
  wait: () => Promise<unknown>;
  attempts: () => Promise<readonly Readonly<{ model?: string | null }>[]>;
}>;
export type Completion = (
  prompt: string,
  options: Readonly<{ model: string; system: string; schema?: object }>
) => Promise<CompletionHandle>;

type RequestMessage = Readonly<{
  role?: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: readonly Readonly<{
    id?: string;
    function?: Readonly<{ name?: string; arguments?: string }>;
  }>[];
}>;

/** One model request of the recorder (record.ts, message type "request"). */
export type BridgeRequest = Readonly<{
  key: string;
  messages: readonly RequestMessage[];
  tools?: readonly unknown[];
}>;

/**
 * The schema of the reply object that `completion()` is asked for. JSON text, so that the key order
 * is the order of the earlier bridge: the schema goes to the model provider as it is written here.
 */
export const REPLY_SCHEMA: object = JSON.parse(
  '{"type":"object","properties":{"content":{"type":"string"},"toolCalls":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"string","description":"JSON object text with the tool arguments"}},"required":["name","arguments"]}}},"required":["content","toolCalls"]}'
);

const BRIDGE_NOTE =
  "\n\n---\nBridge note (transport only): you are called through a text bridge without native tool calling. " +
  "The tools you may call are listed below as JSON function definitions. Reply with one JSON object " +
  '{"content": string, "toolCalls": [{"name": string, "arguments": string}]}. ' +
  'To call tools, put each call in toolCalls (arguments = a JSON object as text) and set content to "". ' +
  "When you have the final answer for the user, put it in content and set toolCalls to []. " +
  "Call only tools from the list. Tool results arrive in the transcript as TOOL RESULT blocks.\n\nTools:\n";

/**
 * The JSON text of the tool list as the earlier bridge wrote it (Python `json.dumps(tools,
 * indent=1)`): one space of indentation, and every character above ASCII as a `\uXXXX` escape of its
 * UTF-16 code units.
 */
const toolListText = (tools: readonly unknown[]): string => {
  const text = JSON.stringify(tools, null, 1);
  let ascii = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    ascii +=
      code < 0x80 ? text[index] : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return ascii;
};

const messageBlock = (message: RequestMessage): string => {
  const content = message.content ?? "";
  switch (message.role) {
    case "user":
      return `USER:\n${content}`;
    case "assistant":
      return [
        `ASSISTANT:${content === "" ? "" : `\n${content}`}`,
        ...(message.tool_calls ?? []).map(
          (call) =>
            `TOOL CALL ${call.id}: ${call.function?.name}(${call.function?.arguments})`
        ),
      ].join("\n");
    case "tool":
      return `TOOL RESULT ${message.tool_call_id}:\n${content}`;
    default:
      return `${String(message.role).toUpperCase()}:\n${content}`;
  }
};

/** The system text and the prompt of one model call. */
export const buildPrompt = (
  request: Pick<BridgeRequest, "messages" | "tools">
): Readonly<{ system: string; prompt: string }> => {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "");
  const blocks = request.messages
    .filter((message) => message.role !== "system")
    .map(messageBlock);
  return {
    prompt: `${blocks.join("\n\n")}\n\nReply now as the assistant with the JSON object.`,
    system: `${system.join("\n\n")}${BRIDGE_NOTE}${toolListText(request.tools ?? [])}`,
  };
};

/** The reply of the model as the recorder takes it (record.ts, stdin), without key and model. */
export type ModelReply = Readonly<{
  content: string;
  toolCalls: readonly Readonly<{ name: string; arguments: unknown }>[];
}>;

/**
 * Reads the output of one `completion()` call: the reply object (with a schema), or text that holds
 * it (without). Text around the JSON object is dropped, never invented. Throws when the output is
 * not the reply object; the call is then asked again.
 */
export const parseModelReply = (output: unknown): ModelReply => {
  let value = output;
  if (typeof value === "string") {
    let text = value.trim();
    if (text.startsWith("```")) {
      text = text.slice(text.indexOf("\n") + 1);
      const fence = text.lastIndexOf("```");
      text = fence === -1 ? text : text.slice(0, fence);
    }
    if (
      !text.trimStart().startsWith("{") &&
      text.includes("{") &&
      text.includes("}")
    ) {
      text = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    }
    value = JSON.parse(text);
  }
  if (typeof value !== "object" || value === null || !("content" in value)) {
    throw new Error("the reply is not the JSON object");
  }
  const calls: unknown =
    "toolCalls" in value && value.toolCalls ? value.toolCalls : [];
  if (!Array.isArray(calls)) throw new Error("toolCalls is not a list");
  return {
    content: typeof value.content === "string" ? value.content : "",
    toolCalls: calls.map((call: unknown) => {
      if (
        typeof call !== "object" ||
        call === null ||
        !("name" in call) ||
        typeof call.name !== "string" ||
        call.name === ""
      ) {
        throw new Error("a tool call has no name");
      }
      const text: unknown = "arguments" in call ? call.arguments : undefined;
      return {
        // As the earlier bridge (Python `json.loads(args) if isinstance(args, str) and args.strip()
        // else (args or {})`): JSON text is parsed; no value and every empty value (`null`, `""`,
        // `[]`, `0`, `false`) are no arguments; every other value is passed on.
        arguments:
          typeof text === "string" && text.trim() !== ""
            ? (JSON.parse(text) as unknown)
            : (Array.isArray(text) && text.length === 0 ? null : text) || {},
        name: call.name,
      };
    }),
  };
};

/** The model id of a finished `completion()` call: the model of its last attempt that names one. */
export const modelOf = async (
  handle: CompletionHandle
): Promise<string | null> => {
  const named = (await handle.attempts())
    .map((attempt) => attempt.model)
    .filter((model): model is string => typeof model === "string");
  return named.at(-1) ?? null;
};

/** The recorder process as the bridge uses it; `startRecorder` makes the real one. */
export type RecorderProcess = Readonly<{
  /** Each line of stdout and of stderr. */
  onLine: (listener: (stream: "out" | "err", line: string) => void) => void;
  /** Writes one line to stdin. False when the process is gone. */
  write: (line: string) => boolean;
  /** Kills the process and its children. */
  kill: () => void;
  /** The exit code when the process and both streams ended (null when a signal ended it). */
  exit: Promise<number | null>;
}>;

const REPOSITORY = new URL("../../../", import.meta.url);

/**
 * Starts the recorder with the test environment (scripts/with-test-env.ts) in its own process group,
 * so that a kill also ends its children.
 */
export const startRecorder = (
  recorderArgs: readonly string[]
): RecorderProcess => {
  const child = spawn(
    "bun",
    [
      fileURLToPath(new URL("scripts/with-test-env.ts", REPOSITORY)),
      "bun",
      fileURLToPath(new URL("./record.ts", import.meta.url)),
      ...recorderArgs,
    ],
    {
      cwd: fileURLToPath(REPOSITORY),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const out = createInterface({ input: child.stdout });
  const err = createInterface({ input: child.stderr });
  const ended = (stream: typeof out): Promise<void> =>
    // Executor form: the tests tsconfig targets a lib without Promise.withResolvers.
    new Promise((resolve) => {
      stream.once("close", resolve);
    });
  const exit = Promise.all([
    new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("exit", (code) => resolve(code));
    }),
    ended(out),
    ended(err),
  ]).then(([code]) => code);
  // A write after the process ended must not throw in the kernel.
  child.stdin.on("error", () => undefined);
  return {
    exit,
    kill: () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
    onLine: (listener) => {
      out.on("line", (line) => listener("out", line));
      err.on("line", (line) => listener("err", line));
    },
    write: (line) => {
      if (child.exitCode !== null || !child.stdin.writable) return false;
      child.stdin.write(`${line}\n`);
      return true;
    },
  };
};

export type BridgeOptions = Readonly<{
  /** `completion` of the eval kernel. */
  completion: Completion;
  /** The model id that the session must answer with (RECORDING_MODEL; the recorder checks each reply). */
  model: string;
  /** The arguments of the recorder: [trials] [concurrency] [stale | ids...]. */
  recorderArgs: readonly string[];
  /** The log file of this run. It must not exist: one log for each run. */
  log: string;
  /** The run is killed after this time. Default 3000 (a full recording took about 25 minutes). */
  deadlineSeconds?: number;
  /** Test seam; default `startRecorder`. */
  start?: (recorderArgs: readonly string[]) => RecorderProcess;
}>;

/** What one run of the bridge did. */
export type BridgeStats = Readonly<{
  /**
   * How the run ended: `finished` (the recorder printed its last message; see `rc` for failed
   * trials), or the reason why the bridge stopped it or did not start it.
   */
  outcome:
    | "finished"
    | "wrong-model-before-start"
    | "garbled-line"
    | "deadline"
    | "recorder-ended-early";
  /** The exit code of the recorder; null when it was not started or was killed. */
  rc: number | null;
  /** The model ids of all replies, with the check call before the start. */
  models: readonly string[];
  /** The number of trials that the recorder selected; null when it printed no selection. */
  selected: number | null;
  requests: number;
  /** `completion()` calls that failed or gave no reply object (each was asked again, up to 4 tries). */
  errors: number;
  /** Requests answered with a fault after the last try. */
  faults: number;
  /** The last message of the recorder (type "finished"), when it printed one. */
  last: unknown;
  seconds: number;
}>;

const TRIES = 4;

/**
 * Runs the recorder and answers its model requests until it ends.
 * - Before the start, one `completion()` call checks that the session answers with `model`; with
 *   another model the recorder is not started (it would stop at its first reply).
 * - A call that fails or gives no reply object is asked again, first with the reply schema, then as
 *   plain text (the structured-output path sometimes rejects a valid long reply). After 4 tries the
 *   request gets a fault, and the recorder does not store that trial.
 * - Every reply names its model. The recorder stops the run at a reply from another model.
 * - A protocol line that is not JSON, or the deadline, kills the recorder. Trials that it had
 *   stored stay stored.
 */
export const runBridge = async (
  options: BridgeOptions
): Promise<BridgeStats> => {
  if (existsSync(options.log)) {
    throw new Error(`log exists: ${options.log} (one log file for each run)`);
  }
  writeFileSync(options.log, "");
  const log = (line: string): void => {
    appendFileSync(options.log, `${line}\n`);
  };
  const started = Date.now();
  const models = new Set<string>();
  const counts = { errors: 0, faults: 0, requests: 0 };
  let selected: number | null = null;
  let last: unknown = null;
  const stats = (
    outcome: BridgeStats["outcome"],
    rc: number | null
  ): BridgeStats => {
    const result = {
      ...counts,
      last,
      models: [...models].sort(),
      outcome,
      rc,
      seconds: Math.round((Date.now() - started) / 1000),
      selected,
    };
    log(`STATS ${JSON.stringify(result)}`);
    return result;
  };

  const check = await options.completion("Reply with the single word OK.", {
    model: "default",
    system: "You answer with one word.",
  });
  await check.wait();
  const sessionModel = await modelOf(check);
  if (sessionModel !== null) models.add(sessionModel);
  if (sessionModel !== options.model) {
    log(
      `ABORT the session answers with the model ${sessionModel}, not ${options.model}; the recorder was not started`
    );
    return stats("wrong-model-before-start", null);
  }

  const recorder = (options.start ?? startRecorder)(options.recorderArgs);
  let stop: BridgeStats["outcome"] | null = null;
  // Set when the recorder was killed or ended.
  let over = false;
  const abort = (outcome: BridgeStats["outcome"], why: string): void => {
    if (stop !== null) return;
    stop = outcome;
    over = true;
    log(`ABORT ${why}`);
    recorder.kill();
  };
  // One try for one request: the line for the recorder. Throws when the call fails or its output is
  // not the reply object.
  const ask = async (
    request: BridgeRequest,
    prompt: Readonly<{ system: string; prompt: string }>,
    attempt: number
  ): Promise<string> => {
    const handle = await options.completion(prompt.prompt, {
      model: "default",
      system: prompt.system,
      ...(attempt === 0 ? { schema: REPLY_SCHEMA } : {}),
    });
    const reply = parseModelReply(await handle.wait());
    const model = await modelOf(handle);
    if (model === null) throw new Error("the reply names no model");
    models.add(model);
    return JSON.stringify({ key: request.key, ...reply, model });
  };
  const answer = async (request: BridgeRequest): Promise<void> => {
    const prompt = buildPrompt(request);
    let lastError = "";
    // `over`: the recorder is gone (killed or ended), so no further model call is made for it.
    for (let attempt = 0; attempt < TRIES && !over; attempt += 1) {
      try {
        const line = await ask(request, prompt, attempt);
        if (!over) {
          log(`REPLY ${line}`);
          recorder.write(line);
        }
        return;
      } catch (error) {
        // A try that ends after the recorder is gone is no error of the run.
        if (over) return;
        counts.errors += 1;
        lastError = error instanceof Error ? error.message : String(error);
        log(`ERROR ${request.key} attempt ${attempt}: ${lastError}`);
      }
    }
    if (over) return;
    counts.faults += 1;
    const fault = JSON.stringify({
      fault: `no model reply after ${TRIES} tries; last error: ${lastError}`,
      key: request.key,
    });
    log(`FAULT ${fault}`);
    recorder.write(fault);
  };
  const onMessage = (text: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      abort(
        "garbled-line",
        `protocol line is not JSON; first 200 characters: ${text.slice(0, 200)}`
      );
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    // The recorder (this repository) wrote the line: the messages of record.ts.
    const message = parsed as Readonly<{
      type?: string;
      key?: string;
      keys?: readonly string[];
    }>;
    if (message.type === "request") {
      counts.requests += 1;
      log(`REQUEST ${message.key}`);
      void answer(parsed as BridgeRequest);
      return;
    }
    log(`MESSAGE ${text}`);
    if (message.type === "finished") {
      last = parsed;
    }
    if (message.type === "selected") selected = message.keys?.length ?? null;
  };
  recorder.onLine((stream, line) => {
    if (stream === "out" && line.startsWith("@@EVAL ")) {
      onMessage(line.slice("@@EVAL ".length));
    } else {
      log(`${stream === "out" ? "OUT" : "ERR"} ${line}`);
    }
  });
  const deadline = setTimeout(
    () => {
      abort("deadline", "the deadline passed");
    },
    (options.deadlineSeconds ?? 3000) * 1000
  );
  const rc = await recorder.exit;
  over = true;
  clearTimeout(deadline);
  if (stop !== null) return stats(stop, null);
  return stats(last === null ? "recorder-ended-early" : "finished", rc);
};
