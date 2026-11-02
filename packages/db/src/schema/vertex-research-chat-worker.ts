import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vertexOutbox } from "./vertex.ts";
import {
  vertexResearchChatExecutionApprovals,
  vertexResearchChatExecutionPlans,
} from "./vertex-research-chat-execution.ts";

// SOURCE ONLY. One immutable original response -> queued run/event -> future job.
// Job is not FK'd here: this transaction precedes actual worker lease admission.
export const vertexResearchChatWorkerOrigins = pgTable(
  "vertex_research_chat_worker_origins",
  {
    accountAlias: text("account_alias").notNull(),
    environment: text("environment").notNull(),
    responseRequestId: text("response_request_id").notNull(),
    ownerActorId: text("owner_actor_id").notNull(),
    planId: text("plan_id").notNull(),
    planSha256: text("plan_sha256").notNull(),
    runId: text("run_id").notNull(),
    eventId: text("event_id").notNull(),
    jobId: text("job_id").notNull(),
    recipeSha256: text("recipe_sha256").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: jsonb("payload")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.responseRequestId],
    }),
    uniqueIndex("vertex_chat_worker_origin_run").on(
      t.accountAlias,
      t.environment,
      t.runId
    ),
    uniqueIndex("vertex_chat_worker_origin_event").on(
      t.accountAlias,
      t.environment,
      t.eventId
    ),
    uniqueIndex("vertex_chat_worker_origin_job").on(
      t.accountAlias,
      t.environment,
      t.jobId
    ),
    foreignKey({
      name: "vertex_chat_worker_origin_plan",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.planId,
        t.planSha256,
      ],
      foreignColumns: [
        vertexResearchChatExecutionPlans.accountAlias,
        vertexResearchChatExecutionPlans.environment,
        vertexResearchChatExecutionPlans.responseRequestId,
        vertexResearchChatExecutionPlans.planId,
        vertexResearchChatExecutionPlans.planSha256,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_worker_origin_approval",
      columns: [t.accountAlias, t.environment, t.responseRequestId],
      foreignColumns: [
        vertexResearchChatExecutionApprovals.accountAlias,
        vertexResearchChatExecutionApprovals.environment,
        vertexResearchChatExecutionApprovals.responseRequestId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_worker_origin_outbox",
      columns: [t.accountAlias, t.environment, t.eventId],
      foreignColumns: [
        vertexOutbox.accountAlias,
        vertexOutbox.environment,
        vertexOutbox.eventId,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_worker_origin_scope",
      sql`${t.environment} = 'research'`
    ),
    check(
      "vertex_chat_worker_origin_hashes",
      sql`${t.planSha256} ~ '^[0-9a-f]{64}$' and ${t.recipeSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_chat_worker_origin_payload",
      sql`(${t.payload}->>'profile' = 'vertex-research-chat-worker-origin-v1' and ${t.payload}->>'responseRequestId' = ${t.responseRequestId} and ${t.payload}->>'ownerActorId' = ${t.ownerActorId} and ${t.payload}->>'planId' = ${t.planId} and ${t.payload}->>'planSha256' = ${t.planSha256} and ${t.payload}->>'runId' = ${t.runId} and ${t.payload}->>'eventId' = ${t.eventId} and ${t.payload}->>'jobId' = ${t.jobId} and ${t.payload}->>'recipeSha256' = ${t.recipeSha256} and ${t.payload}->'recipe'->>'profile' in ('vertex-research-chat-job-v1','vertex-research-chat-job-v2','vertex-research-chat-native-evidence-job-v1') and not (${t.payload} ?| array['request','retrievalQuery','body','advisory','answer'])) is true`
    ),
  ]
);
