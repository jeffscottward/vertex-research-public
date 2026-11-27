import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createApiContext,
  createSessionProcedureCaller,
  handleApiRequest,
} from "@darkfactory/api/server";
import type { SafeAuthSession } from "@darkfactory/auth/server";
import {
  createNodeDatabase,
  createRepositories,
  type Database,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";

import { setDeployStatusFetchOptionsForTesting } from "../../../packages/api/src/server/agent-ops.ts";
import {
  type AssistantCompletion,
  type AssistantCompletionRequest,
  type AssistantLogEntry,
  type AssistantModelClient,
  type AssistantTraceEntry,
  AssistantTurnError,
  runAssistantTurn,
} from "../../../packages/api/src/server/assistant-runtime.ts";
import { setCongressTradesClockForTesting } from "../../../packages/api/src/server/congress-trades.ts";
import { setFlowClockForTesting } from "../../../packages/api/src/server/flow.ts";
import type { CallProcedure } from "../../../packages/api/src/server/mcp.ts";
import { setOpenbbClockForTesting } from "../../../packages/api/src/server/openbb.ts";
import { setSemanticTermsDependenciesForTesting } from "../../../packages/api/src/server/semantic-terms.ts";
import { setSmartMoneyClockForTesting } from "../../../packages/api/src/server/smart-money.ts";
import {
  EVAL_NOW,
  jsonResponse,
  LIVE_PORTFOLIO_DOCUMENT,
  paperExecNodeDocument,
} from "./fixtures.ts";
import {
  type FrozenMasterRules,
  freezeMasterRules,
  readFrozenMasterRules,
} from "./master-rules-freeze.ts";
import { type EvalQuestion, gradeAnswer } from "./questions.ts";
import {
  type IdentifiedToolList,
  identifyToolList,
  RECORDING_MODEL,
  RECORDING_PROMPT_FORMAT,
  type RecordedTrial,
  type Recording,
  type ToolVerdict,
  toolVerdicts,
  trialKey,
} from "./recording.ts";
import { unknownTermAnswer } from "./tool-failures.ts";

// Eval backend for the agent semantic layer: a real Postgres with every migration and the synthetic
// fixture.sql, the real oRPC handler with an operator session, the synthetic live-account feed and paper
// exec-node snapshot, and the real assistant turn (runAssistantTurn, Plan mode). Only the model is
// swapped: the recorder bridges it to the OMP completion model; the CI test replays the recording.

const FIXTURE = readFileSync(
  new URL(
    "../../../docs/vertex-rebuild/agent-semantic-layer/fixture.sql",
    import.meta.url
  ),
  "utf8"
);
const ORIGIN = "https://vertex.test";
const OWNER_EMAIL = "owner@vertex.test";
const AT = new Date("2026-11-01T00:00:00.000Z");

const OWNER_SESSION: SafeAuthSession = {
  principal: { role: "admin", status: "active", userId: "u_owner" },
  session: {
    createdAt: AT,
    expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    id: "session-owner",
    ipAddress: null,
    updatedAt: AT,
    userAgent: null,
    userId: "u_owner",
  },
  user: {
    createdAt: AT,
    email: OWNER_EMAIL,
    emailVerified: true,
    id: "u_owner",
    image: null,
    name: "Fictional Owner",
    role: "admin",
    status: "active",
    updatedAt: AT,
  },
};

/** A test database URL with the read-only login that scripts/ci/rig-postgres.sh creates. */
export const semanticReaderUrl = (databaseUrl: string): string => {
  const url = new URL(databaseUrl);
  url.username = "vertex_semantic_reader";
  url.password = "semantic-reader-test-only";
  return url.toString();
};

/** Fails early with a clear message when the test server lacks the reader login. */
export const assertReaderRole = async (db: Database): Promise<void> => {
  const roles = await db.execute(
    "select 1 from pg_roles where rolname = 'vertex_semantic_reader' and rolcanlogin"
  );
  if (roles.rows.length === 0) {
    throw new Error(
      "The test Postgres has no vertex_semantic_reader login: it was created before the role existed. Recreate it with bun run db:test:down, then bun run db:test:up (CI: scripts/ci/rig-postgres.sh up)."
    );
  }
};

/**
 * Sets the live-account feed of the semantic layer: the synthetic live document, or a feed that answers
 * 503. The setter replaces every setting, so the clock is set to EVAL_NOW again too.
 */
export const setLiveAccountFeed = (state: "live" | "down"): void => {
  setSemanticTermsDependenciesForTesting({
    feed: {
      fetch: async () =>
        state === "live"
          ? jsonResponse(LIVE_PORTFOLIO_DOCUMENT)
          : new Response("unavailable", { status: 503 }),
      now: () => EVAL_NOW,
    },
    now: () => EVAL_NOW,
  });
};

export type EvalBackend = Readonly<{
  callProcedure: CallProcedure;
  close: () => Promise<void>;
  /** The frozen master_rules_search results; record mode adds the searches it froze. */
  masterRules: FrozenMasterRules;
}>;

export const startEvalBackend = async (
  options: Readonly<{ masterRules?: "record" | "replay" }> = {}
): Promise<EvalBackend> => {
  const testDatabase: PostgresTestDatabase = await createPostgresTestDatabase();
  const resource: { db: Database; close: () => Promise<void> } =
    createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 6,
    });
  await migrate(resource.db);
  await assertReaderRole(resource.db);
  await resource.db.execute(FIXTURE);
  // Rows seeded by the migrations carry the migration time; the eval clock is EVAL_NOW.
  await resource.db.execute(
    "update strategies set created_at = '2026-10-01T00:00:00Z', updated_at = '2026-10-01T00:00:00Z'"
  );
  setLiveAccountFeed("live");
  setDeployStatusFetchOptionsForTesting({
    fetch: async () => jsonResponse(paperExecNodeDocument()),
    now: () => EVAL_NOW,
  });
  // flow_control and flow_snapshot read the flow clock: pin it so answers and the replay digest are stable.
  setFlowClockForTesting(() => EVAL_NOW);
  // Smart-money tools (smartMoney/ranking, congressTrades/feed, openbb/*) read their clocks: pin them too.
  setSmartMoneyClockForTesting(() => EVAL_NOW);
  setCongressTradesClockForTesting(() => EVAL_NOW);
  setOpenbbClockForTesting(() => EVAL_NOW);
  const repositories = createRepositories(resource.db, { now: () => EVAL_NOW });
  const dispatch = async (request: Request): Promise<Response> => {
    const context = createApiContext(request, {
      capabilities: {
        ai: true,
        analytics: false,
        emailDelivery: false,
        telemetryExport: false,
      },
      deployStatusV2: { token: "eval-token", url: "https://exec-node.test" },
      operatorEmails: [OWNER_EMAIL],
      portfolioMonitor: { token: "eval-token", url: "https://portfolio.test" },
      repositories,
      requestId: "eval",
      requireRole: async () => OWNER_SESSION,
      requireSession: async () => OWNER_SESSION,
      semanticDatabaseUrl: semanticReaderUrl(testDatabase.databaseUrl),
    });
    return await handleApiRequest(request, context);
  };
  const masterRules = readFrozenMasterRules();
  return {
    callProcedure: freezeMasterRules(
      createSessionProcedureCaller({
        appOrigin: ORIGIN,
        cookie: null,
        dispatch,
      }),
      masterRules,
      options.masterRules ?? "replay"
    ),
    close: async () => {
      setSemanticTermsDependenciesForTesting({});
      setDeployStatusFetchOptionsForTesting({});
      setFlowClockForTesting();
      setSmartMoneyClockForTesting(null);
      setCongressTradesClockForTesting(null);
      setOpenbbClockForTesting(null);
      await resource.close();
      await dropPostgresTestDatabase(testDatabase);
    },
    masterRules,
  };
};

/** One model call as recorded: the reply and a digest of the messages it saw. */
export type RecordedCompletion = Readonly<{
  content: string;
  toolCalls: readonly Readonly<{
    id: string;
    name: string;
    arguments: string;
  }>[];
  inputDigest: string;
}>;

/**
 * Digest of the messages the model was given except its own replies: the system prompt, the question
 * and every tool result, in order. The replay compares it with the recording, so a changed prompt,
 * question or tool result (the semantic layer above all) makes the recording stale. The tool list is
 * not in this digest: a trial names the list it saw (`toolList`), and the tool rule of recording.ts
 * decides what a change of the list means for the trial.
 */
const messageDigest = (
  request: Pick<AssistantCompletionRequest, "messages">
): string => {
  const hash = createHash("sha256");
  for (const message of request.messages) {
    if (message.role === "assistant") continue;
    const id = message.role === "tool" ? message.tool_call_id : message.role;
    hash.update(`${id}\n${message.content}\n`);
  }
  return hash.digest("hex");
};

const toCompletion = (recorded: RecordedCompletion): AssistantCompletion => ({
  content: recorded.content,
  finishReason: recorded.toolCalls.length > 0 ? "tool_calls" : "stop",
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: recorded.toolCalls.map((call) => ({
    function: { arguments: call.arguments, name: call.name },
    id: call.id,
    type: "function" as const,
  })),
});

export type TrialResult = Readonly<{
  answer: string;
  trace: readonly AssistantTraceEntry[];
  completions: readonly RecordedCompletion[];
  /** The tool list that every model call of the turn was given. */
  toolList: IdentifiedToolList;
}>;

/**
 * Runs one question as a Plan-mode assistant turn with the given model. `log` takes the turn log
 * entry; without it the turn prints the entry on stdout, which the recorder must not do (its stdout
 * carries the bridge protocol).
 */
export const runTrial = async (
  backend: EvalBackend,
  question: EvalQuestion,
  complete: (
    request: AssistantCompletionRequest
  ) => Promise<AssistantCompletion>,
  options: Readonly<{
    log?: (entry: AssistantLogEntry) => void;
    onToolList?: (toolList: IdentifiedToolList) => void;
  }> = {}
): Promise<TrialResult> => {
  const completions: RecordedCompletion[] = [];
  let toolList: IdentifiedToolList | undefined;
  const client: AssistantModelClient = {
    complete: async (request) => {
      const seen = identifyToolList(request.tools);
      if (toolList !== undefined && toolList.id !== seen.id) {
        throw new Error(
          "the turn gave the model two different tool lists; a trial stores one"
        );
      }
      toolList = seen;
      options.onToolList?.(seen);
      const completion = await complete(request);
      completions.push({
        content: completion.content,
        inputDigest: messageDigest(request),
        toolCalls: completion.toolCalls.map((call) => ({
          arguments: call.function.arguments,
          id: call.id,
          name: call.function.name,
        })),
      });
      return completion;
    },
    model: "eval-model",
  };
  const result = await runAssistantTurn({
    budget: { record: () => Promise.resolve(), reserve: async () => true },
    callProcedure: backend.callProcedure,
    client,
    clock: () => EVAL_NOW.getTime(),
    history: [],
    ...(options.log === undefined ? {} : { log: options.log }),
    message: question.question,
    mode: "plan",
    now: () => EVAL_NOW,
  });
  if (toolList === undefined) {
    throw new Error("the turn ended with no model call");
  }
  return {
    answer: result.content,
    completions,
    toolList,
    trace: result.trace,
  };
};

/** One recorded trial replayed against the built layer. */
export type TrialReplay = Readonly<{
  /**
   * Null when every model call saw the recorded messages and the final answer is the recorded one;
   * else the first difference (the trial is stale). The tool list is not compared here: see
   * `replayRecording`.
   */
  stale: string | null;
  /** The tool calls of the replayed turn; when the turn threw, the calls made before the throw. */
  trace: readonly AssistantTraceEntry[];
  /**
   * One line for each terms_query answer with status unknown (unknownTermAnswer in tool-failures.ts),
   * also when the turn threw: a term that answers unknown since the recording makes the replay stale,
   * and this line names the cause.
   */
  unknownTerms: readonly string[];
  /** The tool list of the replayed turn (the current list); null when the turn made no model call. */
  toolList: IdentifiedToolList | null;
}>;

/**
 * Replays one recorded trial against the built layer, with the recorded model replies in order.
 * `stale` is null when the trial replays unchanged; else the first difference (record the trial again).
 */
export const replayTrial = async (
  backend: EvalBackend,
  question: EvalQuestion,
  recorded: Readonly<{
    answer: string;
    completions: readonly RecordedCompletion[];
  }>
): Promise<TrialReplay> => {
  let call = 0;
  let reason: string | null = null;
  let toolList: IdentifiedToolList | null = null;
  // The trace marks a terms_query answer with status unknown as a call that worked; keep those answers.
  const unknownTerms: string[] = [];
  const watched: EvalBackend = {
    ...backend,
    callProcedure: async (procedure, input) => {
      const answer = await backend.callProcedure(procedure, input);
      const unknown = unknownTermAnswer(procedure, input, answer);
      if (unknown !== null) unknownTerms.push(unknown);
      return answer;
    },
  };
  const replay = async (
    request: AssistantCompletionRequest
  ): Promise<AssistantCompletion> => {
    const next = recorded.completions[call];
    if (next === undefined) {
      reason ??= `the turn asked for more than the ${recorded.completions.length} recorded model calls`;
      throw new Error(reason);
    }
    if (messageDigest(request) !== next.inputDigest) {
      reason ??= `the input of model call ${call} changed (system prompt, question or a tool result)`;
      throw new Error(reason);
    }
    call += 1;
    return toCompletion(next);
  };
  let result: TrialResult;
  try {
    result = await runTrial(watched, question, replay, {
      // A replay prints no turn log: 90 lines for each run of the replay test say nothing.
      log: () => undefined,
      onToolList: (seen) => {
        toolList = seen;
      },
    });
  } catch (error) {
    if (reason === null) throw error;
    return {
      stale: reason,
      toolList,
      trace: error instanceof AssistantTurnError ? error.trace : [],
      unknownTerms,
    };
  }
  const { answer, trace } = result;
  const rest = { toolList, trace, unknownTerms };
  if (call !== recorded.completions.length) {
    return {
      stale: `the turn made ${call} of the ${recorded.completions.length} recorded model calls`,
      ...rest,
    };
  }
  return {
    stale:
      answer === recorded.answer
        ? null
        : "the final answer differs from the recorded answer",
    ...rest,
  };
};

const withUnknownTerms = (
  stale: string | null,
  unknownTerms: readonly string[]
): string | null =>
  stale === null || unknownTerms.length === 0
    ? stale
    : `${stale}; ${[...new Set(unknownTerms)].join("; ")}`;

/**
 * Null when the recorded trial replays unchanged; else the first difference (the trial is stale: record
 * it again). A stale reason also names each terms_query answer with status unknown in the replay: such
 * an answer can be the cause, and recording the trial again does not remove it (correct the layer, the
 * fixture or the feed first).
 */
export const staleReason = async (
  backend: EvalBackend,
  question: EvalQuestion,
  recorded: Readonly<{
    answer: string;
    completions: readonly RecordedCompletion[];
  }>
): Promise<string | null> => {
  const { stale, unknownTerms } = await replayTrial(
    backend,
    question,
    recorded
  );
  return withUnknownTerms(stale, unknownTerms);
};

/** One trial of a recording, judged against the built layer and the current tool list. */
export type TrialVerdict = Readonly<{
  /**
   * Null when the trial is valid. Else every reason why it must be recorded again, joined with "; ":
   * the replay difference, the tool rule (a called tool changed, or the tool list changed and the
   * question has no witness), another model than RECORDING_MODEL, another prompt format of the bridge
   * than RECORDING_PROMPT_FORMAT, a changed rubric grade.
   */
  stale: string | null;
  /** The verdict of the tool rule alone (recording.ts); null when no trial gave a current tool list. */
  tool: ToolVerdict | null;
  trace: readonly AssistantTraceEntry[];
  unknownTerms: readonly string[];
}>;

/**
 * Replays every trial of a recording and applies the tool rule. The replay test and the recorder's
 * `stale` selection share this one definition of "must be recorded again".
 */
export const replayRecording = async (
  backend: EvalBackend,
  questions: readonly EvalQuestion[],
  recording: Pick<Recording, "toolLists" | "trials">
): Promise<Map<string, TrialVerdict>> => {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const replays = new Map<string, TrialReplay>();
  const reasons = new Map<string, string[]>();
  let current: IdentifiedToolList | null = null;
  // One at a time: the replay needs no model, and the order of the results stays fixed.
  for (const trial of recording.trials) {
    const key = trialKey(trial);
    const question = byId.get(trial.question);
    if (question === undefined) {
      reasons.set(key, [`unknown question ${trial.question}`]);
      continue;
    }
    const replayed = await replayTrial(backend, question, trial);
    replays.set(key, replayed);
    current ??= replayed.toolList;
    const found: string[] = [];
    const stale = withUnknownTerms(replayed.stale, replayed.unknownTerms);
    if (stale !== null) found.push(stale);
    if (trial.model !== RECORDING_MODEL) {
      found.push(
        `recorded with the model ${trial.model}, not ${RECORDING_MODEL}`
      );
    }
    if (trial.promptFormat !== RECORDING_PROMPT_FORMAT) {
      found.push("asked with another prompt format of the bridge");
    }
    if (gradeAnswer(question, trial.answer) !== trial.grade) {
      found.push("the rubric grade of the recorded answer changed");
    }
    reasons.set(key, found);
  }
  const tools =
    current === null
      ? null
      : toolVerdicts(
          recording,
          current,
          (trial) => reasons.get(trialKey(trial))?.length === 0
        );
  return new Map(
    recording.trials.map((trial: RecordedTrial) => {
      const key = trialKey(trial);
      const tool = tools?.get(key) ?? null;
      const found = [...(reasons.get(key) ?? [])];
      if (tool?.state === "stale" || tool?.state === "needs-witness") {
        found.push(tool.reason);
      }
      const replayed = replays.get(key);
      return [
        key,
        {
          stale: found.length === 0 ? null : found.join("; "),
          tool,
          trace: replayed?.trace ?? [],
          unknownTerms: replayed?.unknownTerms ?? [],
        },
      ];
    })
  );
};
