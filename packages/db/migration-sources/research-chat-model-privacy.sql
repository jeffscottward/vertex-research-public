-- SOURCE ONLY. Unnumbered, UNAPPLIED, unregistered additive source.
-- Requires the original execution plan/model-grant/authorization tables.
-- No authority, grants, provider calls, model budget or activation is created.
CREATE TABLE vertex_research_chat_model_privacy_reviews (
  account_alias text NOT NULL,
  environment text NOT NULL,
  response_request_id text NOT NULL,
  plan_id text NOT NULL,
  plan_sha256 text NOT NULL,
  review_id text NOT NULL,
  actor_id text NOT NULL,
  operation text NOT NULL,
  request_id text NOT NULL,
  request_sha256 text NOT NULL,
  model_grant_id text NOT NULL,
  model_grant_version text NOT NULL,
  account_read_grant_id text NOT NULL,
  account_read_grant_version text NOT NULL,
  policy_review_grant_id text NOT NULL,
  policy_review_grant_version text NOT NULL,
  request_review_grant_id text NOT NULL,
  request_review_grant_version text NOT NULL,
  decision text NOT NULL,
  policy_id text NOT NULL,
  policy_version text NOT NULL,
  revision numeric(30,0) NOT NULL,
  idempotency_key text NOT NULL,
  command_sha256 text NOT NULL,
  supersedes_review_id text,
  reviewed_at_ns numeric(30,0) NOT NULL,
  expires_at_ns numeric(30,0) NOT NULL,
  decision_canonical text,
  decision_sha256 text,
  payload jsonb NOT NULL,
  record_hash text NOT NULL,
  PRIMARY KEY (account_alias, environment, review_id),
  CONSTRAINT vertex_chat_model_privacy_plan_fk FOREIGN KEY (account_alias, environment, response_request_id, plan_id, plan_sha256)
    REFERENCES vertex_research_chat_execution_plans (account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_model_privacy_model_grant_fk FOREIGN KEY (account_alias, environment, model_grant_id, model_grant_version)
    REFERENCES vertex_model_use_grant_versions (account_alias, environment, grant_id, grant_version) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_model_privacy_account_grant_fk FOREIGN KEY (account_alias, environment, account_read_grant_id, account_read_grant_version)
    REFERENCES vertex_grant_versions (account_alias, environment, grant_id, version) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_model_privacy_policy_grant_fk FOREIGN KEY (account_alias, environment, policy_review_grant_id, policy_review_grant_version)
    REFERENCES vertex_grant_versions (account_alias, environment, grant_id, version) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_model_privacy_request_grant_fk FOREIGN KEY (account_alias, environment, request_review_grant_id, request_review_grant_version)
    REFERENCES vertex_grant_versions (account_alias, environment, grant_id, version) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_model_privacy_scope CHECK (environment = 'research' AND operation IN ('model-tokenize','model-completion')),
  CONSTRAINT vertex_chat_model_privacy_window CHECK (
    revision BETWEEN 1 AND 128 AND expires_at_ns > reviewed_at_ns AND
    ((revision = 1 AND supersedes_review_id IS NULL) OR (revision > 1 AND supersedes_review_id IS NOT NULL)) AND
    review_id IS DISTINCT FROM supersedes_review_id),
  CONSTRAINT vertex_chat_model_privacy_hashes CHECK (
    record_hash ~ '^[0-9a-f]{64}$' AND plan_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$' AND command_sha256 ~ '^[0-9a-f]{64}$' AND review_id = 'chat-privacy-' || command_sha256),
  CONSTRAINT vertex_chat_model_privacy_payload CHECK ((
    jsonb_typeof(payload) = 'object' AND
    payload->>'profile' = 'vertex-research-chat-model-privacy-review-v1' AND
    payload->>'accountAlias' = account_alias AND payload->>'environment' = environment AND
    payload->>'responseRequestId' = response_request_id AND payload->>'planId' = plan_id AND payload->>'planSha256' = plan_sha256 AND
    payload->>'reviewId' = review_id AND payload->>'reviewerActorId' = actor_id AND payload->>'decision' = decision AND
    payload->>'policyId' = policy_id AND payload->>'policyVersion' = policy_version AND
    payload->>'commandSha256' = command_sha256 AND payload->>'idempotencyKey' = idempotency_key AND
    (payload->>'supersedesReviewId') IS NOT DISTINCT FROM supersedes_review_id AND payload ? 'supersedesReviewId' AND
    payload->'request'->>'accountAlias' = account_alias AND payload->'request'->>'environment' = environment AND
    payload->'request'->>'requestId' = request_id AND payload->'request'->>'requestSha256' = request_sha256 AND payload->'request'->>'operation' = operation AND
    payload->'request'->>'grantId' = model_grant_id AND payload->'request'->>'grantVersion' = model_grant_version AND
    payload - ARRAY['profile','accountAlias','environment','responseRequestId','planId','planSha256','reviewId','request','decision','privacyDecision','reviewerActorId','reviewerGrants','policyId','policyVersion','reviewedAt','expiresAt','supersedesReviewId','idempotencyKey','commandSha256'] = '{}'::jsonb AND
    payload->'request' - ARRAY['schemaVersion','requestId','requestSha256','accountAlias','environment','researchPrincipalId','consumerServiceId','selectionId','selectionSha256','providerId','modelVersion','tokenizerArtifactId','tokenizerSha256','endpointReferenceId','endpointSha256','modelUsePolicyVersion','jobId','leaseId','leaseEpoch','grantId','grantVersion','operation','purpose','tools','evidence','inputSha256','inputBytes','inputTokens','maximumOutputTokens','maximumCostUsd','deadlineAt'] = '{}'::jsonb
  ) IS TRUE),
  CONSTRAINT vertex_chat_model_privacy_grant_pins CHECK ((
    jsonb_array_length(payload->'reviewerGrants') = 3 AND
    payload->'reviewerGrants'->0->>'grantId' = account_read_grant_id AND payload->'reviewerGrants'->0->>'version' = account_read_grant_version AND
    payload->'reviewerGrants'->0->>'resourceId' = 'account-scope' AND payload->'reviewerGrants'->0->>'action' = 'read' AND
    payload->'reviewerGrants'->1->>'grantId' = policy_review_grant_id AND payload->'reviewerGrants'->1->>'version' = policy_review_grant_version AND
    payload->'reviewerGrants'->1->>'resourceId' = policy_id AND payload->'reviewerGrants'->1->>'action' = 'review' AND
    payload->'reviewerGrants'->2->>'grantId' = request_review_grant_id AND payload->'reviewerGrants'->2->>'version' = request_review_grant_version AND
    payload->'reviewerGrants'->2->>'resourceId' = 'research-chat-model-privacy:' || response_request_id || ':' || operation AND payload->'reviewerGrants'->2->>'action' = 'review'
  ) IS TRUE),
  CONSTRAINT vertex_chat_model_privacy_original_decision CHECK ((
    (decision = 'rejected' AND payload->'privacyDecision' = 'null'::jsonb AND decision_canonical IS NULL AND decision_sha256 IS NULL) OR
    (decision = 'accepted' AND decision_canonical IS NOT NULL AND decision_sha256 ~ '^[0-9a-f]{64}$' AND
      decision_canonical::jsonb = payload->'privacyDecision' AND payload->'privacyDecision' = jsonb_build_object(
        'format','vertex-model-privacy-decision-v1','request',payload->'request','policyId',policy_id,'policyVersion',policy_version,
        'issuedByActorId',actor_id,'decidedAt',payload->>'reviewedAt','expiresAt',payload->>'expiresAt','decision','allow-model-processing','executionAuthorized',false))
  ) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_model_privacy_key ON vertex_research_chat_model_privacy_reviews (account_alias, environment, actor_id, idempotency_key);
CREATE UNIQUE INDEX vertex_chat_model_privacy_revision ON vertex_research_chat_model_privacy_reviews (account_alias, environment, response_request_id, operation, revision);
CREATE UNIQUE INDEX vertex_chat_model_privacy_predecessor ON vertex_research_chat_model_privacy_reviews (account_alias, environment, response_request_id, operation, coalesce(supersedes_review_id, ''));
CREATE UNIQUE INDEX vertex_chat_model_privacy_response_pin ON vertex_research_chat_model_privacy_reviews (account_alias, environment, response_request_id, operation, review_id);
CREATE UNIQUE INDEX vertex_chat_model_privacy_dispatch_pin ON vertex_research_chat_model_privacy_reviews (account_alias, environment, response_request_id, operation, request_id, request_sha256, review_id);
ALTER TABLE vertex_research_chat_model_privacy_reviews ADD CONSTRAINT vertex_chat_model_privacy_previous_fk
  FOREIGN KEY (account_alias, environment, response_request_id, operation, supersedes_review_id)
  REFERENCES vertex_research_chat_model_privacy_reviews (account_alias, environment, response_request_id, operation, review_id) ON DELETE RESTRICT;

CREATE TABLE vertex_research_chat_model_dispatches (
  account_alias text NOT NULL,
  environment text NOT NULL,
  response_request_id text NOT NULL,
  operation text NOT NULL,
  plan_id text NOT NULL,
  plan_sha256 text NOT NULL,
  original_request_sha256 text NOT NULL,
  request_id text NOT NULL,
  request_sha256 text NOT NULL,
  review_id text NOT NULL,
  reserved_at_ns numeric(30,0) NOT NULL,
  payload jsonb NOT NULL,
  record_hash text NOT NULL,
  PRIMARY KEY (account_alias, environment, response_request_id, operation),
  CONSTRAINT vertex_chat_model_dispatch_plan_fk FOREIGN KEY (account_alias, environment, response_request_id, plan_id, plan_sha256)
    REFERENCES vertex_research_chat_execution_plans (account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_model_dispatch_review_fk FOREIGN KEY (account_alias, environment, response_request_id, operation, request_id, request_sha256, review_id)
    REFERENCES vertex_research_chat_model_privacy_reviews (account_alias, environment, response_request_id, operation, request_id, request_sha256, review_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_model_dispatch_scope CHECK (environment = 'research' AND operation IN ('model-tokenize','model-completion')),
  CONSTRAINT vertex_chat_model_dispatch_hashes CHECK (record_hash ~ '^[0-9a-f]{64}$' AND plan_sha256 ~ '^[0-9a-f]{64}$' AND original_request_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_chat_model_dispatch_payload CHECK ((
    jsonb_typeof(payload) = 'object' AND payload->>'profile' = 'vertex-research-chat-model-dispatch-v1' AND
    payload->>'accountAlias' = account_alias AND payload->>'environment' = environment AND
    payload->>'responseRequestId' = response_request_id AND payload->>'planId' = plan_id AND payload->>'planSha256' = plan_sha256 AND
    payload->>'originalRequestSha256' = original_request_sha256 AND payload->>'reviewId' = review_id AND
    payload->'request'->>'requestId' = request_id AND payload->'request'->>'requestSha256' = request_sha256 AND
    payload->'request'->>'operation' = operation AND payload->'request'->>'accountAlias' = account_alias AND payload->'request'->>'environment' = environment AND
    payload - ARRAY['profile','accountAlias','environment','responseRequestId','planId','planSha256','originalRequestSha256','request','reviewId','reservedAt'] = '{}'::jsonb AND
    payload->'request' - ARRAY['schemaVersion','requestId','requestSha256','accountAlias','environment','researchPrincipalId','consumerServiceId','selectionId','selectionSha256','providerId','modelVersion','tokenizerArtifactId','tokenizerSha256','endpointReferenceId','endpointSha256','modelUsePolicyVersion','jobId','leaseId','leaseEpoch','grantId','grantVersion','operation','purpose','tools','evidence','inputSha256','inputBytes','inputTokens','maximumOutputTokens','maximumCostUsd','deadlineAt'] = '{}'::jsonb
  ) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_model_dispatch_request ON vertex_research_chat_model_dispatches (account_alias, environment, request_id);

-- A transient or unknown provider outcome never permits association replacement.
-- These two tables are append-only even if a generic row updater is introduced.
CREATE FUNCTION vertex_chat_model_privacy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chat model privacy metadata is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER vertex_chat_model_privacy_no_update_delete
  BEFORE UPDATE OR DELETE ON vertex_research_chat_model_privacy_reviews
  FOR EACH ROW EXECUTE FUNCTION vertex_chat_model_privacy_immutable();
CREATE TRIGGER vertex_chat_model_dispatch_no_update_delete
  BEFORE UPDATE OR DELETE ON vertex_research_chat_model_dispatches
  FOR EACH ROW EXECUTE FUNCTION vertex_chat_model_privacy_immutable();
