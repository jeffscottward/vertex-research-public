-- AUTHORED SOURCE ONLY. UNAPPLIED. No migration runner/generator was invoked.
-- Metadata only. Every execution/lineage/grant/rights join remains in its owner.
-- Charges reserve the full step ceiling permanently before any copy/model effect;
-- unknown or failed effects never refund, reallocate, or authorize another step.
BEGIN;

ALTER TABLE vertex_research_chat_execution_plans
  DROP CONSTRAINT vertex_chat_execution_plan_payload,
  ADD CONSTRAINT vertex_chat_execution_plan_payload CHECK (((
    (payload->>'format' = 'vertex-research-chat-plan-v1' AND NOT (payload ? 'debate')) OR
    (payload->>'format' = 'vertex-research-chat-plan-v2' AND payload #>> '{debate,profile}' = 'vertex-research-chat-debate-plan-v1'))
    AND payload->>'responseRequestId' = response_request_id AND payload->>'planId' = plan_id
    AND payload->>'planSha256' = plan_sha256 AND payload->>'ownerActorId' = owner_actor_id
    AND NOT (payload ?| ARRAY['request','retrievalQuery','body','advisory','answer'])) IS TRUE);
ALTER TABLE vertex_research_chat_execution_approvals
  DROP CONSTRAINT vertex_chat_execution_approval_payload,
  ADD CONSTRAINT vertex_chat_execution_approval_payload CHECK (((
    (payload->>'format' = 'vertex-research-chat-approval-v1' AND NOT (payload ? 'debateSha256')) OR
    (payload->>'format' = 'vertex-research-chat-approval-v2' AND payload->>'debateSha256' ~ '^[0-9a-f]{64}$'))
    AND payload->>'ownerActorId' = owner_actor_id AND payload->>'planSha256' = plan_sha256
    AND payload->>'responseRequestId' = response_request_id AND payload->>'storageReviewId' = storage_review_id
    AND NOT (payload ?| ARRAY['request','retrievalQuery','body','context','tokenizeInput','completionInput','advisory','answer'])) IS TRUE);

CREATE TABLE vertex_research_chat_debate_runs (
  account_alias text NOT NULL,
  environment text NOT NULL,
  debate_run_id text NOT NULL,
  owner_actor_id text NOT NULL,
  thread_id text NOT NULL,
  run_key text NOT NULL,
  configuration_sha256 text NOT NULL,
  human_window_sha256 text NOT NULL,
  collection_id text NOT NULL,
  snapshot_id text NOT NULL,
  record_hash text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (account_alias, environment, debate_run_id),
  CONSTRAINT vertex_chat_debate_thread FOREIGN KEY (account_alias, environment, owner_actor_id, thread_id)
    REFERENCES vertex_research_chat_threads (account_alias, environment, owner_actor_id, thread_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_debate_run_scope CHECK (environment = 'research'),
  CONSTRAINT vertex_chat_debate_run_payload CHECK ((payload->>'profile' = 'vertex-research-chat-debate-run-v1'
    AND payload->>'debateRunId' = debate_run_id AND payload->>'ownerActorId' = owner_actor_id
    AND payload->>'threadId' = thread_id AND payload->>'humanWindowSha256' = human_window_sha256
    AND NOT (payload ?| ARRAY['messages','body','answer','advisory','retrievalQuery'])) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_debate_owner_key
  ON vertex_research_chat_debate_runs (account_alias, environment, owner_actor_id, thread_id, run_key);

CREATE TABLE vertex_research_chat_debate_steps (
  account_alias text NOT NULL,
  environment text NOT NULL,
  debate_run_id text NOT NULL,
  ordinal integer NOT NULL,
  response_request_id text NOT NULL,
  plan_id text NOT NULL,
  plan_sha256 text NOT NULL,
  state text NOT NULL,
  charged_tokens numeric(30,0) NOT NULL,
  charged_usd_units numeric(60,0) NOT NULL,
  record_hash text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (account_alias, environment, debate_run_id, ordinal),
  CONSTRAINT vertex_chat_debate_step_run FOREIGN KEY (account_alias, environment, debate_run_id)
    REFERENCES vertex_research_chat_debate_runs (account_alias, environment, debate_run_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_debate_step_plan FOREIGN KEY (account_alias, environment, response_request_id, plan_id, plan_sha256)
    REFERENCES vertex_research_chat_execution_plans (account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_debate_step_bounds CHECK (environment = 'research' AND ordinal BETWEEN 1 AND 5
    AND state IN ('reserved','spent') AND charged_tokens > 0 AND charged_usd_units >= 0),
  CONSTRAINT vertex_chat_debate_step_payload CHECK ((payload->>'profile' = 'vertex-research-chat-debate-charge-v1'
    AND payload->>'debateRunId' = debate_run_id AND (payload->>'ordinal')::integer = ordinal
    AND payload->>'responseRequestId' = response_request_id AND payload->>'planSha256' = plan_sha256
    AND payload->>'state' = state AND NOT (payload ?| ARRAY['messages','body','answer','advisory','retrievalQuery'])) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_debate_step_response
  ON vertex_research_chat_debate_steps (account_alias, environment, response_request_id);

-- Each revision binds exact published predecessors, owner, original human window,
-- per-step destination, input descriptors, current grant pins and plan hash.
-- This is a separate derived-use authority: it never widens v1 copy parents.
CREATE TABLE vertex_research_chat_derived_dependencies (
  account_alias text NOT NULL,
  environment text NOT NULL,
  response_request_id text NOT NULL,
  review_id text NOT NULL,
  plan_id text NOT NULL,
  plan_sha256 text NOT NULL,
  revision integer NOT NULL,
  reviewer_actor_id text NOT NULL,
  owner_actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  decision text NOT NULL,
  record_hash text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (account_alias, environment, response_request_id, revision),
  CONSTRAINT vertex_chat_derived_review_plan FOREIGN KEY (account_alias, environment, response_request_id, plan_id, plan_sha256)
    REFERENCES vertex_research_chat_execution_plans (account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_derived_review_bounds CHECK (environment = 'research' AND revision BETWEEN 1 AND 64
    AND reviewer_actor_id <> owner_actor_id AND decision IN ('accepted','rejected')),
  CONSTRAINT vertex_chat_derived_review_payload CHECK ((payload->>'profile' = 'vertex-research-chat-derived-use-review-v1'
    AND payload->>'responseRequestId' = response_request_id AND payload->>'planSha256' = plan_sha256
    AND payload->>'reviewId' = review_id AND payload->>'reviewerActorId' = reviewer_actor_id
    AND payload->>'decision' = decision AND NOT (payload ?| ARRAY['messages','body','answer','advisory','retrievalQuery'])) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_derived_review_id
  ON vertex_research_chat_derived_dependencies (account_alias, environment, review_id);
CREATE UNIQUE INDEX vertex_chat_derived_review_key
  ON vertex_research_chat_derived_dependencies (account_alias, environment, reviewer_actor_id, idempotency_key);

COMMIT;
