-- Source only. Not generated/applied. Private request-bound evidence approval;
-- no alteration of public vertex_reviews, StrategySpec, or catalog semantics.
CREATE UNIQUE INDEX vertex_worker_stage_content_identity
  ON vertex_worker_stages(account_alias, environment, artifact_id, content_sha256);

CREATE TABLE vertex_research_chat_execution_plans (
  account_alias text NOT NULL, environment text NOT NULL CHECK(environment = 'research'),
  response_request_id text NOT NULL, owner_actor_id text NOT NULL, thread_id text NOT NULL,
  idempotency_key text NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
  plan_id text NOT NULL, plan_sha256 text NOT NULL CHECK(plan_sha256 ~ '^[0-9a-f]{64}$'),
  storage_evidence_artifact_id text NOT NULL, storage_evidence_sha256 text NOT NULL,
  payload jsonb NOT NULL, record_hash text NOT NULL CHECK(record_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(account_alias, environment, response_request_id),
  CONSTRAINT vertex_chat_execution_plan_pin UNIQUE(account_alias, environment, response_request_id, plan_id, plan_sha256),
  CONSTRAINT vertex_chat_execution_plan_request_key UNIQUE(account_alias, environment, owner_actor_id, thread_id, idempotency_key),
  CONSTRAINT vertex_chat_execution_plan_thread FOREIGN KEY(account_alias, environment, owner_actor_id, thread_id)
    REFERENCES vertex_research_chat_threads(account_alias, environment, owner_actor_id, thread_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_execution_plan_evidence FOREIGN KEY(account_alias, environment, storage_evidence_artifact_id, storage_evidence_sha256)
    REFERENCES vertex_worker_stages(account_alias, environment, artifact_id, content_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_execution_plan_payload CHECK((payload->>'format' = 'vertex-research-chat-plan-v1'
    AND payload->>'responseRequestId' = response_request_id AND payload->>'planId' = plan_id
    AND payload->>'planSha256' = plan_sha256 AND payload->>'ownerActorId' = owner_actor_id
    AND NOT (payload ?| ARRAY['request','retrievalQuery','body','advisory','answer'])) IS TRUE)
);

CREATE TABLE vertex_research_chat_storage_reviews (
  account_alias text NOT NULL, environment text NOT NULL CHECK(environment = 'research'),
  review_id text NOT NULL, response_request_id text NOT NULL, plan_id text NOT NULL, plan_sha256 text NOT NULL,
  evidence_artifact_id text NOT NULL, evidence_sha256 text NOT NULL,
  actor_id text NOT NULL, issuer_actor_id text NOT NULL CHECK(actor_id <> issuer_actor_id),
  idempotency_key text NOT NULL, request_sha256 text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('accepted','rejected')),
  reviewed_at_ns numeric(30,0) NOT NULL, expires_at_ns numeric(30,0) NOT NULL CHECK(expires_at_ns > reviewed_at_ns),
  supersedes_review_id text, payload jsonb NOT NULL, record_hash text NOT NULL,
  PRIMARY KEY(account_alias, environment, review_id),
  CONSTRAINT vertex_chat_storage_review_request_pin UNIQUE(account_alias, environment, response_request_id, review_id),
  CONSTRAINT vertex_chat_storage_review_request_key UNIQUE(account_alias, environment, actor_id, idempotency_key),
  CONSTRAINT vertex_chat_storage_review_plan FOREIGN KEY(account_alias, environment, response_request_id, plan_id, plan_sha256)
    REFERENCES vertex_research_chat_execution_plans(account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_storage_review_stage FOREIGN KEY(account_alias, environment, evidence_artifact_id, evidence_sha256)
    REFERENCES vertex_worker_stages(account_alias, environment, artifact_id, content_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_storage_review_payload CHECK((payload->>'format' = 'vertex-research-chat-storage-qualification-review-v1'
    AND payload->>'purpose' = 'storage-qualification' AND payload->>'reviewId' = review_id
    AND payload->>'planSha256' = plan_sha256 AND payload->>'responseRequestId' = response_request_id
    AND payload->>'decision' = decision AND payload->>'actorId' = actor_id
    AND payload->>'ownerActorId' <> actor_id) IS TRUE)
);

CREATE TABLE vertex_research_chat_execution_approvals (
  account_alias text NOT NULL, environment text NOT NULL CHECK(environment = 'research'),
  response_request_id text NOT NULL, owner_actor_id text NOT NULL,
  plan_id text NOT NULL, plan_sha256 text NOT NULL, storage_review_id text NOT NULL,
  payload jsonb NOT NULL, record_hash text NOT NULL,
  PRIMARY KEY(account_alias, environment, response_request_id),
  CONSTRAINT vertex_chat_execution_approval_plan FOREIGN KEY(account_alias, environment, response_request_id, plan_id, plan_sha256)
    REFERENCES vertex_research_chat_execution_plans(account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_execution_approval_review FOREIGN KEY(account_alias, environment, response_request_id, storage_review_id)
    REFERENCES vertex_research_chat_storage_reviews(account_alias, environment, response_request_id, review_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_execution_approval_payload CHECK((payload->>'format' = 'vertex-research-chat-approval-v1'
    AND payload->>'ownerActorId' = owner_actor_id AND payload->>'planSha256' = plan_sha256
    AND payload->>'responseRequestId' = response_request_id AND payload->>'storageReviewId' = storage_review_id
    AND NOT (payload ?| ARRAY['request','retrievalQuery','body','context','tokenizeInput','completionInput','advisory','answer'])) IS TRUE)
);

-- Original plans, evidence reviews and owner approvals are immutable receipts.
-- Later rejection/closure is an additive record, never an UPDATE or DELETE.
CREATE FUNCTION vertex_research_chat_execution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable research chat governance record' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER vertex_chat_execution_plan_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_execution_plans
  FOR EACH ROW EXECUTE FUNCTION vertex_research_chat_execution_immutable();
CREATE TRIGGER vertex_chat_storage_review_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_storage_reviews
  FOR EACH ROW EXECUTE FUNCTION vertex_research_chat_execution_immutable();
CREATE TRIGGER vertex_chat_execution_approval_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_execution_approvals
  FOR EACH ROW EXECUTE FUNCTION vertex_research_chat_execution_immutable();
