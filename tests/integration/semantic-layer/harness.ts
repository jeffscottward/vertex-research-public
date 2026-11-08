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
  type AssistantModelClient,
  type AssistantTraceEntry,
  runAssistantTurn,
} from "../../../packages/api/src/server/assistant-runtime.ts";
import type { CallProcedure } from "../../../packages/api/src/server/mcp.ts";
import { setSemanticTermsDependenciesForTesting } from "../../../packages/api/src/server/semantic-terms.ts";
import {
  EVAL_NOW,
  jsonResponse,
  LIVE_PORTFOLIO_DOCUMENT,
  paperExecNodeDocument,
} from "./fixtures.ts";
import type { EvalQuestion } from "./questions.ts";

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
      "The test Postgres has no vertex_semantic_reader login: recreate it with scripts/ci/rig-postgres.sh up (bun run db:test:up)."
    );
  }
};

export type EvalBackend = Readonly<{
  callProcedure: CallProcedure;
  close: () => Promise<void>;
}>;

export const startEvalBackend = async (): Promise<EvalBackend> => {
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
  setSemanticTermsDependenciesForTesting({
    feed: {
      fetch: async () => jsonResponse(LIVE_PORTFOLIO_DOCUMENT),
      now: () => EVAL_NOW,
    },
    now: () => EVAL_NOW,
  });
  setDeployStatusFetchOptionsForTesting({
    fetch: async () => jsonResponse(paperExecNodeDocument()),
    now: () => EVAL_NOW,
  });
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
  return {
    callProcedure: createSessionProcedureCaller({
      appOrigin: ORIGIN,
      cookie: null,
      dispatch,
    }),
    close: async () => {
      setSemanticTermsDependenciesForTesting({});
      setDeployStatusFetchOptionsForTesting({});
      await resource.close();
      await dropPostgresTestDatabase(testDatabase);
    },
  };
};

/** One model call as recorded: the reply and a digest of the input it saw. */
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
 * Digest of everything the model was given except its own replies: the tool definitions, the system
 * prompt, the question and every tool result, in order. The replay compares it with the recording, so a changed prompt, question
 * or tool result (the semantic layer above all) makes the recording stale.
 */
export const inputDigest = (
  request: Pick<AssistantCompletionRequest, "messages" | "tools">
): string => {
  const hash = createHash("sha256");
  hash.update(`${JSON.stringify(request.tools)}\n`);
  for (const message of request.messages) {
    if (message.role === "assistant") continue;
    const id = message.role === "tool" ? message.tool_call_id : message.role;
    hash.update(`${id}\n${message.content}\n`);
  }
  return hash.digest("hex");
};

export const toCompletion = (
  recorded: RecordedCompletion
): AssistantCompletion => ({
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
}>;

/** Runs one question as a Plan-mode assistant turn with the given model. */
export const runTrial = async (
  backend: EvalBackend,
  question: EvalQuestion,
  complete: (
    request: AssistantCompletionRequest
  ) => Promise<AssistantCompletion>,
  model = "eval-model"
): Promise<TrialResult> => {
  const completions: RecordedCompletion[] = [];
  const client: AssistantModelClient = {
    complete: async (request) => {
      const completion = await complete(request);
      completions.push({
        content: completion.content,
        inputDigest: inputDigest(request),
        toolCalls: completion.toolCalls.map((call) => ({
          arguments: call.function.arguments,
          id: call.id,
          name: call.function.name,
        })),
      });
      return completion;
    },
    model,
  };
  const result = await runAssistantTurn({
    budget: { record: () => Promise.resolve(), reserve: async () => true },
    callProcedure: backend.callProcedure,
    client,
    clock: () => EVAL_NOW.getTime(),
    history: [],
    message: question.question,
    mode: "plan",
    now: () => EVAL_NOW,
  });
  return { answer: result.content, completions, trace: result.trace };
};
