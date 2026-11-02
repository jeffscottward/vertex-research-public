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
import { vertexResearchChatWorkerOrigins } from "./vertex-research-chat-worker.ts";

// SOURCE ONLY. The matching migration-sources SQL is UNAPPLIED. This records
// immutable response/proof/budget/content identities, never provider bytes.
export const vertexResearchChatAdvisoryOrigins = pgTable(
  "vertex_research_chat_advisory_origins",
  {
    accountAlias: text("account_alias").notNull(),
    environment: text("environment").notNull(),
    responseRequestId: text("response_request_id").notNull(),
    jobId: text("job_id").notNull(),
    runId: text("run_id").notNull(),
    planSha256: text("plan_sha256").notNull(),
    copyId: text("copy_id").notNull(),
    contentSha256: text("content_sha256").notNull(),
    requestSha256: text("request_sha256").notNull(),
    responseSha256: text("response_sha256").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: jsonb("payload")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.accountAlias, t.environment, t.responseRequestId],
    }),
    uniqueIndex("vertex_chat_advisory_job").on(
      t.accountAlias,
      t.environment,
      t.jobId
    ),
    uniqueIndex("vertex_chat_advisory_copy").on(
      t.accountAlias,
      t.environment,
      t.copyId
    ),
    foreignKey({
      name: "vertex_chat_advisory_original",
      columns: [t.accountAlias, t.environment, t.responseRequestId],
      foreignColumns: [
        vertexResearchChatWorkerOrigins.accountAlias,
        vertexResearchChatWorkerOrigins.environment,
        vertexResearchChatWorkerOrigins.responseRequestId,
      ],
    }).onDelete("restrict"),
    check("vertex_chat_advisory_scope", sql`${t.environment} = 'research'`),
    check(
      "vertex_chat_advisory_hashes",
      sql`${t.planSha256} ~ '^[0-9a-f]{64}$' and ${t.contentSha256} ~ '^[0-9a-f]{64}$' and ${t.requestSha256} ~ '^[0-9a-f]{64}$' and ${t.responseSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_chat_advisory_bodyless",
      sql`(
    jsonb_typeof(${t.payload}) = 'object' and octet_length(${t.payload}::text) <= 32768 and
    ((${t.payload}->>'profile' = 'vertex-research-chat-advisory-origin-v1' and not (${t.payload} ? 'nativeChain')) or
      (${t.payload}->>'profile' = 'vertex-research-chat-native-evidence-advisory-origin-v1' and
        jsonb_typeof(${t.payload}->'nativeChain') = 'object' and
        ${t.payload}->'nativeChain' - array['phaseOneDispatchSha256','phaseOneProofSha256','phaseTwoSha256','derivationSha256'] = '{}'::jsonb and
        ${t.payload} #>> '{nativeChain,phaseOneDispatchSha256}' ~ '^[0-9a-f]{64}$' and
        ${t.payload} #>> '{nativeChain,phaseOneProofSha256}' ~ '^[0-9a-f]{64}$' and
        ${t.payload} #>> '{nativeChain,phaseTwoSha256}' ~ '^[0-9a-f]{64}$' and
        ${t.payload} #>> '{nativeChain,derivationSha256}' ~ '^[0-9a-f]{64}$')) and
    ${t.payload}->>'accountAlias' = ${t.accountAlias} and ${t.payload}->>'environment' = ${t.environment} and
    ${t.payload}->>'responseRequestId' = ${t.responseRequestId} and ${t.payload}->>'jobId' = ${t.jobId} and ${t.payload}->>'runId' = ${t.runId} and
    ${t.payload}->>'planSha256' = ${t.planSha256} and ${t.payload}->>'copyId' = ${t.copyId} and ${t.payload}->>'contentSha256' = ${t.contentSha256} and
    ${t.payload}->>'modelUseRequestSha256' = ${t.requestSha256} and ${t.payload}->>'responseSha256' = ${t.responseSha256} and
    (${t.payload}->>'byteLength')::bigint between 1 and 262144 and
    ${t.payload} - array['profile','accountAlias','environment','responseRequestId','planId','planSha256','originalRequestSha256','jobId','runId','traceId','eventId','recipeSha256','copyId','contentSha256','byteLength','modelUseRequestId','modelUseRequestSha256','postProofSha256','postProofCheckedAt','firstDispatchProofSha256','dispatchSha256','budgetSha256','privacyReviewId','privacyReviewSha256','responseSha256','usage','boundAt','nativeChain'] = '{}'::jsonb and
    jsonb_typeof(${t.payload}->'usage') = 'object' and ${t.payload}->'usage' - array['inputTokens','outputTokens','totalTokens','completionCostUsd'] = '{}'::jsonb
  ) is true`
    ),
  ]
);
