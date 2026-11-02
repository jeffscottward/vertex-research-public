import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vertexResearchChatThreads } from "./vertex-research-chat.ts";
import { vertexResearchChatExecutionPlans } from "./vertex-research-chat-execution.ts";

const scope = () => ({
  accountAlias: text("account_alias").notNull(),
  environment: text("environment").notNull(),
});
const record = () => ({
  payload: jsonb("payload")
    .$type<Readonly<Record<string, unknown>>>()
    .notNull(),
  recordHash: text("record_hash").notNull(),
});
// SOURCE ONLY. No startup DDL, admission, grant, budget refill or deployment.
export const vertexResearchChatDebateRuns = pgTable(
  "vertex_research_chat_debate_runs",
  {
    ...scope(),
    ...record(),
    debateRunId: text("debate_run_id").notNull(),
    ownerActorId: text("owner_actor_id").notNull(),
    threadId: text("thread_id").notNull(),
    runKey: text("run_key").notNull(),
    configurationSha256: text("configuration_sha256").notNull(),
    humanWindowSha256: text("human_window_sha256").notNull(),
    collectionId: text("collection_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountAlias, t.environment, t.debateRunId] }),
    uniqueIndex("vertex_chat_debate_owner_key").on(
      t.accountAlias,
      t.environment,
      t.ownerActorId,
      t.threadId,
      t.runKey
    ),
    foreignKey({
      name: "vertex_chat_debate_thread",
      columns: [t.accountAlias, t.environment, t.ownerActorId, t.threadId],
      foreignColumns: [
        vertexResearchChatThreads.accountAlias,
        vertexResearchChatThreads.environment,
        vertexResearchChatThreads.ownerActorId,
        vertexResearchChatThreads.threadId,
      ],
    }).onDelete("restrict"),
    check("vertex_chat_debate_run_scope", sql`${t.environment} = 'research'`),
    check(
      "vertex_chat_debate_run_payload",
      sql`(${t.payload}->>'profile' = 'vertex-research-chat-debate-run-v1' and ${t.payload}->>'debateRunId' = ${t.debateRunId} and ${t.payload}->>'ownerActorId' = ${t.ownerActorId} and ${t.payload}->>'threadId' = ${t.threadId} and ${t.payload}->>'humanWindowSha256' = ${t.humanWindowSha256} and not (${t.payload} ?| array['messages','body','answer','advisory','retrievalQuery'])) is true`
    ),
  ]
);
// Permanent full-ceiling charge before copy/model effects. Spent observations do
// not release or redistribute reserved headroom. Unknown remains reserved.
export const vertexResearchChatDebateSteps = pgTable(
  "vertex_research_chat_debate_steps",
  {
    ...scope(),
    ...record(),
    debateRunId: text("debate_run_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    responseRequestId: text("response_request_id").notNull(),
    planId: text("plan_id").notNull(),
    planSha256: text("plan_sha256").notNull(),
    state: text("state").notNull(),
    chargedTokens: numeric("charged_tokens", {
      precision: 30,
      scale: 0,
    }).notNull(),
    chargedUsdUnits: numeric("charged_usd_units", {
      precision: 60,
      scale: 0,
    }).notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.debateRunId, t.ordinal],
    }),
    uniqueIndex("vertex_chat_debate_step_response").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId
    ),
    foreignKey({
      name: "vertex_chat_debate_step_run",
      columns: [t.accountAlias, t.environment, t.debateRunId],
      foreignColumns: [
        vertexResearchChatDebateRuns.accountAlias,
        vertexResearchChatDebateRuns.environment,
        vertexResearchChatDebateRuns.debateRunId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_chat_debate_step_plan",
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
    check(
      "vertex_chat_debate_step_bounds",
      sql`${t.environment} = 'research' and ${t.ordinal} between 1 and 5 and ${t.state} in ('reserved','spent') and ${t.chargedTokens} > 0 and ${t.chargedUsdUnits} >= 0`
    ),
    check(
      "vertex_chat_debate_step_payload",
      sql`(${t.payload}->>'profile' = 'vertex-research-chat-debate-charge-v1' and ${t.payload}->>'debateRunId' = ${t.debateRunId} and (${t.payload}->>'ordinal')::integer = ${t.ordinal} and ${t.payload}->>'responseRequestId' = ${t.responseRequestId} and ${t.payload}->>'planSha256' = ${t.planSha256} and ${t.payload}->>'state' = ${t.state} and not (${t.payload} ?| array['messages','body','answer','advisory','retrievalQuery'])) is true`
    ),
  ]
);
// Independent reviewer-issued lineage authority, not client-supplied accepted
// flags. Every immutable revision binds all exact predecessors and destination.
export const vertexResearchChatDerivedDependencies = pgTable(
  "vertex_research_chat_derived_dependencies",
  {
    ...scope(),
    ...record(),
    responseRequestId: text("response_request_id").notNull(),
    reviewId: text("review_id").notNull(),
    planId: text("plan_id").notNull(),
    planSha256: text("plan_sha256").notNull(),
    revision: integer("revision").notNull(),
    reviewerActorId: text("reviewer_actor_id").notNull(),
    ownerActorId: text("owner_actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    decision: text("decision").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.responseRequestId, t.revision],
    }),
    uniqueIndex("vertex_chat_derived_review_id").on(
      t.accountAlias,
      t.environment,
      t.reviewId
    ),
    uniqueIndex("vertex_chat_derived_review_key").on(
      t.accountAlias,
      t.environment,
      t.reviewerActorId,
      t.idempotencyKey
    ),
    foreignKey({
      name: "vertex_chat_derived_review_plan",
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
    check(
      "vertex_chat_derived_review_bounds",
      sql`${t.environment} = 'research' and ${t.revision} between 1 and 64 and ${t.reviewerActorId} <> ${t.ownerActorId} and ${t.decision} in ('accepted','rejected')`
    ),
    check(
      "vertex_chat_derived_review_payload",
      sql`(${t.payload}->>'profile' = 'vertex-research-chat-derived-use-review-v1' and ${t.payload}->>'responseRequestId' = ${t.responseRequestId} and ${t.payload}->>'planSha256' = ${t.planSha256} and ${t.payload}->>'reviewId' = ${t.reviewId} and ${t.payload}->>'reviewerActorId' = ${t.reviewerActorId} and ${t.payload}->>'decision' = ${t.decision} and not (${t.payload} ?| array['messages','body','answer','advisory','retrievalQuery'])) is true`
    ),
  ]
);
