-- AUTHORED SOURCE ONLY, UNAPPLIED. Not a migration journal entry.
-- Requires execution/debate/model-privacy/rendezvous sources separately reviewed.
-- No grants, deployment, existing row rewrite, storage writes or activation.
BEGIN;

ALTER TABLE vertex_research_chat_execution_plans DROP CONSTRAINT vertex_chat_execution_plan_payload;
ALTER TABLE vertex_research_chat_execution_plans ADD CONSTRAINT vertex_chat_execution_plan_payload CHECK (((
  (payload->>'format' = 'vertex-research-chat-plan-v1' AND NOT (payload ? 'debate')) OR
  (payload->>'format' = 'vertex-research-chat-plan-v2' AND payload #>> '{debate,profile}' = 'vertex-research-chat-debate-plan-v1') OR
  (payload->>'format' = 'vertex-research-chat-native-evidence-plan-v1' AND NOT (payload ? 'debate') AND payload #>> '{nativeEvidence,profile}' = 'first-mate-read-reviewed-evidence-v1')) AND
  payload->>'responseRequestId' = response_request_id AND payload->>'planId' = plan_id AND payload->>'planSha256' = plan_sha256 AND payload->>'ownerActorId' = owner_actor_id AND
  NOT (payload ?| ARRAY['request','retrievalQuery','body','advisory','answer'])) IS TRUE);
ALTER TABLE vertex_research_chat_execution_approvals DROP CONSTRAINT vertex_chat_execution_approval_payload;
ALTER TABLE vertex_research_chat_execution_approvals ADD CONSTRAINT vertex_chat_execution_approval_payload CHECK (((
  (payload->>'format' = 'vertex-research-chat-approval-v1' AND NOT (payload ? 'debateSha256')) OR
  (payload->>'format' = 'vertex-research-chat-approval-v2' AND payload->>'debateSha256' ~ '^[0-9a-f]{64}$') OR
  (payload->>'format' = 'vertex-research-chat-native-evidence-approval-v1' AND NOT (payload ? 'debateSha256') AND payload->>'nativeEvidenceSha256' ~ '^[0-9a-f]{64}$')) AND
  payload->>'ownerActorId' = owner_actor_id AND payload->>'planSha256' = plan_sha256 AND payload->>'responseRequestId' = response_request_id AND payload->>'storageReviewId' = storage_review_id AND
  NOT (payload ?| ARRAY['request','retrievalQuery','body','context','tokenizeInput','completionInput','advisory','answer'])) IS TRUE);

CREATE TABLE vertex_research_chat_native_phases (
  account_alias text NOT NULL, environment text NOT NULL, response_request_id text NOT NULL,
  phase_ordinal integer NOT NULL, phase_sha256 text NOT NULL, plan_sha256 text NOT NULL,
  expires_at_ns numeric(30,0) NOT NULL, payload jsonb NOT NULL, record_hash text NOT NULL,
  PRIMARY KEY (account_alias, environment, response_request_id, phase_ordinal),
  CONSTRAINT vertex_chat_native_phase_plan_fk FOREIGN KEY (account_alias, environment, response_request_id)
    REFERENCES vertex_research_chat_execution_plans (account_alias, environment, response_request_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_phase_scope CHECK (environment = 'research' AND phase_ordinal IN (1,2)),
  CONSTRAINT vertex_chat_native_phase_hashes CHECK (record_hash ~ '^[0-9a-f]{64}$' AND plan_sha256 ~ '^[0-9a-f]{64}$' AND phase_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_chat_native_phase_payload CHECK ((
    payload->>'profile' = 'vertex-research-chat-native-phase-v1' AND payload->>'accountAlias' = account_alias AND payload->>'environment' = environment AND
    payload->>'responseRequestId' = response_request_id AND payload->>'planSha256' = plan_sha256 AND payload->>'phaseOrdinal' = phase_ordinal::text AND payload->>'phaseSha256' = phase_sha256 AND
    payload - ARRAY['profile','accountAlias','environment','responseRequestId','planSha256','phaseOrdinal','tokenizeInput','completionInput','derivation','expiresAt','phaseSha256'] = '{}'::jsonb AND
    payload->'tokenizeInput' - ARRAY['sha256','byteLength'] = '{}'::jsonb AND payload->'completionInput' - ARRAY['sha256','byteLength'] = '{}'::jsonb AND
    payload #>> '{tokenizeInput,sha256}' ~ '^[0-9a-f]{64}$' AND payload #>> '{completionInput,sha256}' ~ '^[0-9a-f]{64}$' AND
    (payload #>> '{tokenizeInput,byteLength}')::integer BETWEEN 1 AND 262144 AND (payload #>> '{completionInput,byteLength}')::integer BETWEEN 1 AND 262144 AND
    ((phase_ordinal = 1 AND payload->'derivation' = 'null'::jsonb) OR (phase_ordinal = 2 AND payload #>> '{derivation,profile}' = 'reviewed-evidence-single-projection-v1' AND
      payload #>> '{derivation,toolName}' = 'read_reviewed_evidence' AND payload->'derivation' - ARRAY['profile','phaseOneResponseSha256','phaseOneRequestSha256','phaseOneProofSha256','callId','toolName','argumentsCanonical','evidenceId','bundleSha256','toolResultSha256'] = '{}'::jsonb))
  ) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_native_phase_pin ON vertex_research_chat_native_phases (account_alias, environment, response_request_id, phase_ordinal, phase_sha256);

CREATE TABLE vertex_research_chat_native_phase_requests (
  account_alias text NOT NULL, environment text NOT NULL, response_request_id text NOT NULL, plan_sha256 text NOT NULL,
  phase_ordinal integer NOT NULL, phase_sha256 text NOT NULL, operation text NOT NULL, request_id text NOT NULL, request_sha256 text NOT NULL,
  job_id text NOT NULL, lease_id text NOT NULL, lease_epoch numeric(30,0) NOT NULL, selection_id text NOT NULL, selection_sha256 text NOT NULL,
  payload jsonb NOT NULL, record_hash text NOT NULL,
  PRIMARY KEY (account_alias, environment, response_request_id, phase_ordinal, operation),
  CONSTRAINT vertex_chat_native_request_phase_fk FOREIGN KEY (account_alias, environment, response_request_id, phase_ordinal, phase_sha256)
    REFERENCES vertex_research_chat_native_phases (account_alias, environment, response_request_id, phase_ordinal, phase_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_request_scope CHECK (environment = 'research' AND phase_ordinal IN (1,2) AND operation IN ('model-tokenize','model-completion') AND lease_epoch >= 1),
  CONSTRAINT vertex_chat_native_request_hashes CHECK (record_hash ~ '^[0-9a-f]{64}$' AND plan_sha256 ~ '^[0-9a-f]{64}$' AND phase_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$' AND selection_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_chat_native_request_payload CHECK ((payload->>'profile' = 'vertex-research-chat-native-phase-request-v1' AND
    payload->>'accountAlias' = account_alias AND payload->>'environment' = environment AND payload->>'responseRequestId' = response_request_id AND payload->>'planSha256' = plan_sha256 AND
    payload->>'phaseOrdinal' = phase_ordinal::text AND payload->>'phaseSha256' = phase_sha256 AND payload->>'operation' = operation AND
    payload->>'requestId' = request_id AND payload->>'requestSha256' = request_sha256 AND payload->>'jobId' = job_id AND payload->>'leaseId' = lease_id AND payload->>'leaseEpoch' = lease_epoch::text AND
    payload->>'selectionId' = selection_id AND payload->>'selectionSha256' = selection_sha256 AND
    payload - ARRAY['profile','accountAlias','environment','responseRequestId','planSha256','phaseOrdinal','phaseSha256','operation','requestId','requestSha256','jobId','leaseId','leaseEpoch','selectionId','selectionSha256'] = '{}'::jsonb) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_native_request_pin ON vertex_research_chat_native_phase_requests (account_alias, environment, response_request_id, phase_ordinal, phase_sha256, operation, request_id, request_sha256);
CREATE UNIQUE INDEX vertex_chat_native_request_id ON vertex_research_chat_native_phase_requests (account_alias, environment, request_id);

-- LIKE copies column types/nullability only. Legacy indexes, keys and payload
-- constraints are NOT inherited: otherwise response+operation would collapse phases.
CREATE TABLE vertex_research_chat_native_model_privacy_reviews (LIKE vertex_research_chat_model_privacy_reviews INCLUDING DEFAULTS,
  phase_ordinal integer NOT NULL, phase_sha256 text NOT NULL,
  PRIMARY KEY (account_alias, environment, review_id),
  CONSTRAINT vertex_chat_native_privacy_scope CHECK (environment = 'research' AND phase_ordinal IN (1,2) AND operation IN ('model-tokenize','model-completion')),
  CONSTRAINT vertex_chat_native_privacy_window CHECK (revision BETWEEN 1 AND 128 AND expires_at_ns > reviewed_at_ns AND ((revision = 1 AND supersedes_review_id IS NULL) OR (revision > 1 AND supersedes_review_id IS NOT NULL)) AND review_id IS DISTINCT FROM supersedes_review_id),
  CONSTRAINT vertex_chat_native_privacy_hashes CHECK (record_hash ~ '^[0-9a-f]{64}$' AND plan_sha256 ~ '^[0-9a-f]{64}$' AND phase_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$' AND command_sha256 ~ '^[0-9a-f]{64}$' AND review_id = 'chat-privacy-' || command_sha256),
  CONSTRAINT vertex_chat_native_privacy_plan_fk FOREIGN KEY (account_alias, environment, response_request_id, plan_id, plan_sha256) REFERENCES vertex_research_chat_execution_plans (account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_privacy_phase_fk FOREIGN KEY (account_alias, environment, response_request_id, phase_ordinal, phase_sha256, operation, request_id, request_sha256) REFERENCES vertex_research_chat_native_phase_requests (account_alias, environment, response_request_id, phase_ordinal, phase_sha256, operation, request_id, request_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_privacy_model_grant_fk FOREIGN KEY (account_alias, environment, model_grant_id, model_grant_version) REFERENCES vertex_model_use_grant_versions (account_alias, environment, grant_id, grant_version) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_privacy_account_grant_fk FOREIGN KEY (account_alias, environment, account_read_grant_id, account_read_grant_version) REFERENCES vertex_grant_versions (account_alias, environment, grant_id, version) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_privacy_policy_grant_fk FOREIGN KEY (account_alias, environment, policy_review_grant_id, policy_review_grant_version) REFERENCES vertex_grant_versions (account_alias, environment, grant_id, version) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_privacy_request_grant_fk FOREIGN KEY (account_alias, environment, request_review_grant_id, request_review_grant_version) REFERENCES vertex_grant_versions (account_alias, environment, grant_id, version) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_privacy_payload CHECK ((jsonb_typeof(payload) = 'object' AND payload->>'profile' = 'vertex-research-chat-native-model-privacy-review-v1' AND
    payload->>'accountAlias' = account_alias AND payload->>'environment' = environment AND payload->>'responseRequestId' = response_request_id AND payload->>'planId' = plan_id AND payload->>'planSha256' = plan_sha256 AND
    payload->'nativePhase' = jsonb_build_object('phaseOrdinal',phase_ordinal,'phaseSha256',phase_sha256) AND payload->>'reviewId' = review_id AND payload->>'reviewerActorId' = actor_id AND payload->>'decision' = decision AND
    payload->>'policyId' = policy_id AND payload->>'policyVersion' = policy_version AND payload->>'commandSha256' = command_sha256 AND payload->>'idempotencyKey' = idempotency_key AND
    (payload->>'supersedesReviewId') IS NOT DISTINCT FROM supersedes_review_id AND payload ? 'supersedesReviewId' AND
    payload->'request'->>'accountAlias' = account_alias AND payload->'request'->>'environment' = environment AND payload->'request'->>'requestId' = request_id AND payload->'request'->>'requestSha256' = request_sha256 AND payload->'request'->>'operation' = operation AND
    payload->'request'->>'grantId' = model_grant_id AND payload->'request'->>'grantVersion' = model_grant_version AND
    payload - ARRAY['profile','accountAlias','environment','responseRequestId','planId','planSha256','nativePhase','reviewId','request','decision','privacyDecision','reviewerActorId','reviewerGrants','policyId','policyVersion','reviewedAt','expiresAt','supersedesReviewId','idempotencyKey','commandSha256'] = '{}'::jsonb AND
    payload->'request' - ARRAY['schemaVersion','requestId','requestSha256','accountAlias','environment','researchPrincipalId','consumerServiceId','selectionId','selectionSha256','providerId','modelVersion','tokenizerArtifactId','tokenizerSha256','endpointReferenceId','endpointSha256','modelUsePolicyVersion','jobId','leaseId','leaseEpoch','grantId','grantVersion','operation','purpose','tools','evidence','inputSha256','inputBytes','inputTokens','maximumOutputTokens','maximumCostUsd','deadlineAt'] = '{}'::jsonb) IS TRUE),
  CONSTRAINT vertex_chat_native_privacy_grant_pins CHECK ((jsonb_array_length(payload->'reviewerGrants') = 3 AND
    payload->'reviewerGrants'->0->>'grantId' = account_read_grant_id AND payload->'reviewerGrants'->0->>'version' = account_read_grant_version AND payload->'reviewerGrants'->0->>'resourceId' = 'account-scope' AND payload->'reviewerGrants'->0->>'action' = 'read' AND
    payload->'reviewerGrants'->1->>'grantId' = policy_review_grant_id AND payload->'reviewerGrants'->1->>'version' = policy_review_grant_version AND payload->'reviewerGrants'->1->>'resourceId' = policy_id AND payload->'reviewerGrants'->1->>'action' = 'review' AND
    payload->'reviewerGrants'->2->>'grantId' = request_review_grant_id AND payload->'reviewerGrants'->2->>'version' = request_review_grant_version AND payload->'reviewerGrants'->2->>'resourceId' = 'research-chat-model-privacy:' || response_request_id || ':phase-' || phase_ordinal || ':' || operation AND payload->'reviewerGrants'->2->>'action' = 'review') IS TRUE),
  CONSTRAINT vertex_chat_native_privacy_original_decision CHECK (((decision = 'rejected' AND payload->'privacyDecision' = 'null'::jsonb AND decision_canonical IS NULL AND decision_sha256 IS NULL) OR
    (decision = 'accepted' AND decision_canonical IS NOT NULL AND decision_sha256 ~ '^[0-9a-f]{64}$' AND decision_canonical::jsonb = payload->'privacyDecision' AND payload->'privacyDecision' = jsonb_build_object(
      'format','vertex-model-privacy-decision-v1','request',payload->'request','policyId',policy_id,'policyVersion',policy_version,'issuedByActorId',actor_id,'decidedAt',payload->>'reviewedAt','expiresAt',payload->>'expiresAt','decision','allow-model-processing','executionAuthorized',false))) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_native_privacy_key ON vertex_research_chat_native_model_privacy_reviews (account_alias, environment, actor_id, idempotency_key);
CREATE UNIQUE INDEX vertex_chat_native_privacy_revision ON vertex_research_chat_native_model_privacy_reviews (account_alias, environment, response_request_id, phase_ordinal, operation, revision);
CREATE UNIQUE INDEX vertex_chat_native_privacy_predecessor ON vertex_research_chat_native_model_privacy_reviews (account_alias, environment, response_request_id, phase_ordinal, operation, coalesce(supersedes_review_id, ''));
CREATE UNIQUE INDEX vertex_chat_native_privacy_response_pin ON vertex_research_chat_native_model_privacy_reviews (account_alias, environment, response_request_id, phase_ordinal, operation, review_id);
CREATE UNIQUE INDEX vertex_chat_native_privacy_dispatch_pin ON vertex_research_chat_native_model_privacy_reviews (account_alias, environment, response_request_id, phase_ordinal, operation, request_id, request_sha256, review_id);
ALTER TABLE vertex_research_chat_native_model_privacy_reviews ADD CONSTRAINT vertex_chat_native_privacy_previous_fk FOREIGN KEY (account_alias, environment, response_request_id, phase_ordinal, operation, supersedes_review_id) REFERENCES vertex_research_chat_native_model_privacy_reviews (account_alias, environment, response_request_id, phase_ordinal, operation, review_id) ON DELETE RESTRICT;

CREATE TABLE vertex_research_chat_native_model_dispatches (LIKE vertex_research_chat_model_dispatches INCLUDING DEFAULTS,
  phase_ordinal integer NOT NULL, phase_sha256 text NOT NULL,
  PRIMARY KEY (account_alias, environment, response_request_id, phase_ordinal, operation),
  CONSTRAINT vertex_chat_native_dispatch_scope CHECK (environment = 'research' AND phase_ordinal IN (1,2) AND operation IN ('model-tokenize','model-completion')),
  CONSTRAINT vertex_chat_native_dispatch_hashes CHECK (record_hash ~ '^[0-9a-f]{64}$' AND phase_sha256 ~ '^[0-9a-f]{64}$' AND plan_sha256 ~ '^[0-9a-f]{64}$' AND original_request_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_chat_native_dispatch_plan_fk FOREIGN KEY (account_alias, environment, response_request_id, plan_id, plan_sha256) REFERENCES vertex_research_chat_execution_plans (account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_dispatch_phase_fk FOREIGN KEY (account_alias, environment, response_request_id, phase_ordinal, phase_sha256, operation, request_id, request_sha256) REFERENCES vertex_research_chat_native_phase_requests (account_alias, environment, response_request_id, phase_ordinal, phase_sha256, operation, request_id, request_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_dispatch_review_fk FOREIGN KEY (account_alias, environment, response_request_id, phase_ordinal, operation, request_id, request_sha256, review_id) REFERENCES vertex_research_chat_native_model_privacy_reviews (account_alias, environment, response_request_id, phase_ordinal, operation, request_id, request_sha256, review_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_dispatch_payload CHECK ((jsonb_typeof(payload) = 'object' AND payload->>'profile' = 'vertex-research-chat-native-model-dispatch-v1' AND
    payload->>'accountAlias' = account_alias AND payload->>'environment' = environment AND payload->>'responseRequestId' = response_request_id AND payload->>'planId' = plan_id AND payload->>'planSha256' = plan_sha256 AND
    payload->'nativePhase' = jsonb_build_object('phaseOrdinal',phase_ordinal,'phaseSha256',phase_sha256) AND payload->>'originalRequestSha256' = original_request_sha256 AND payload->>'reviewId' = review_id AND
    payload->'request'->>'requestId' = request_id AND payload->'request'->>'requestSha256' = request_sha256 AND payload->'request'->>'operation' = operation AND payload->'request'->>'accountAlias' = account_alias AND payload->'request'->>'environment' = environment AND
    payload - ARRAY['profile','accountAlias','environment','responseRequestId','planId','planSha256','nativePhase','originalRequestSha256','request','reviewId','reservedAt'] = '{}'::jsonb AND
    payload->'request' - ARRAY['schemaVersion','requestId','requestSha256','accountAlias','environment','researchPrincipalId','consumerServiceId','selectionId','selectionSha256','providerId','modelVersion','tokenizerArtifactId','tokenizerSha256','endpointReferenceId','endpointSha256','modelUsePolicyVersion','jobId','leaseId','leaseEpoch','grantId','grantVersion','operation','purpose','tools','evidence','inputSha256','inputBytes','inputTokens','maximumOutputTokens','maximumCostUsd','deadlineAt'] = '{}'::jsonb) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_native_dispatch_request ON vertex_research_chat_native_model_dispatches (account_alias, environment, request_id);

CREATE TABLE vertex_research_chat_native_model_privacy_candidates (LIKE vertex_research_chat_model_privacy_candidates INCLUDING DEFAULTS,
  phase_ordinal integer NOT NULL, phase_sha256 text NOT NULL,
  PRIMARY KEY (account_alias, environment, response_request_id, phase_ordinal, operation),
  CONSTRAINT vertex_chat_native_candidate_scope CHECK (environment = 'research' AND phase_ordinal IN (1,2) AND operation IN ('model-tokenize','model-completion')),
  CONSTRAINT vertex_chat_native_candidate_window CHECK (expires_at_ns > submitted_at_ns AND expires_at_ns - submitted_at_ns <= 300000000000),
  CONSTRAINT vertex_chat_native_candidate_hashes CHECK (record_hash ~ '^[0-9a-f]{64}$' AND phase_sha256 ~ '^[0-9a-f]{64}$' AND plan_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$' AND candidate_id ~ '^chat-candidate-[0-9a-f]{64}$'),
  CONSTRAINT vertex_chat_native_candidate_plan_fk FOREIGN KEY (account_alias, environment, response_request_id, plan_id, plan_sha256) REFERENCES vertex_research_chat_execution_plans (account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_candidate_phase_fk FOREIGN KEY (account_alias, environment, response_request_id, phase_ordinal, phase_sha256, operation, request_id, request_sha256) REFERENCES vertex_research_chat_native_phase_requests (account_alias, environment, response_request_id, phase_ordinal, phase_sha256, operation, request_id, request_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_native_candidate_payload CHECK ((jsonb_typeof(payload) = 'object' AND payload->>'profile' = 'vertex-first-mate-native-model-privacy-candidate-v1' AND
    payload->>'accountAlias' = account_alias AND payload->>'environment' = environment AND payload->>'candidateId' = candidate_id AND payload->>'responseRequestId' = response_request_id AND payload->>'planId' = plan_id AND payload->>'planSha256' = plan_sha256 AND
    payload->'nativePhase' = jsonb_build_object('phaseOrdinal',phase_ordinal,'phaseSha256',phase_sha256) AND payload->'request'->>'requestId' = request_id AND payload->'request'->>'requestSha256' = request_sha256 AND
    payload->'request'->>'accountAlias' = account_alias AND payload->'request'->>'environment' = environment AND payload->'request'->>'operation' = operation AND
    payload - ARRAY['profile','candidateId','accountAlias','environment','responseRequestId','planId','planSha256','nativePhase','request','submittedAt','expiresAt'] = '{}'::jsonb AND
    payload->'request' - ARRAY['schemaVersion','requestId','requestSha256','accountAlias','environment','researchPrincipalId','consumerServiceId','selectionId','selectionSha256','providerId','modelVersion','tokenizerArtifactId','tokenizerSha256','endpointReferenceId','endpointSha256','modelUsePolicyVersion','jobId','leaseId','leaseEpoch','grantId','grantVersion','operation','purpose','tools','evidence','inputSha256','inputBytes','inputTokens','maximumOutputTokens','maximumCostUsd','deadlineAt'] = '{}'::jsonb) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_native_candidate_id ON vertex_research_chat_native_model_privacy_candidates (account_alias, environment, candidate_id);
CREATE UNIQUE INDEX vertex_chat_native_candidate_request ON vertex_research_chat_native_model_privacy_candidates (account_alias, environment, request_id);

CREATE FUNCTION vertex_chat_native_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'native evidence metadata is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER vertex_chat_native_phase_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_native_phases FOR EACH ROW EXECUTE FUNCTION vertex_chat_native_evidence_immutable();
CREATE TRIGGER vertex_chat_native_request_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_native_phase_requests FOR EACH ROW EXECUTE FUNCTION vertex_chat_native_evidence_immutable();
CREATE TRIGGER vertex_chat_native_privacy_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_native_model_privacy_reviews FOR EACH ROW EXECUTE FUNCTION vertex_chat_native_evidence_immutable();
CREATE TRIGGER vertex_chat_native_dispatch_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_native_model_dispatches FOR EACH ROW EXECUTE FUNCTION vertex_chat_native_evidence_immutable();
CREATE TRIGGER vertex_chat_native_candidate_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_native_model_privacy_candidates FOR EACH ROW EXECUTE FUNCTION vertex_chat_native_evidence_immutable();
ALTER TABLE vertex_research_chat_advisory_origins DROP CONSTRAINT vertex_chat_advisory_bodyless;
ALTER TABLE vertex_research_chat_advisory_origins ADD CONSTRAINT vertex_chat_advisory_bodyless CHECK ((
  jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 32768 AND
  ((payload->>'profile' = 'vertex-research-chat-advisory-origin-v1' AND NOT (payload ? 'nativeChain')) OR
    (payload->>'profile' = 'vertex-research-chat-native-evidence-advisory-origin-v1' AND jsonb_typeof(payload->'nativeChain') = 'object' AND
      payload->'nativeChain' - ARRAY['phaseOneDispatchSha256','phaseOneProofSha256','phaseTwoSha256','derivationSha256'] = '{}'::jsonb AND
      payload #>> '{nativeChain,phaseOneDispatchSha256}' ~ '^[0-9a-f]{64}$' AND payload #>> '{nativeChain,phaseOneProofSha256}' ~ '^[0-9a-f]{64}$' AND
      payload #>> '{nativeChain,phaseTwoSha256}' ~ '^[0-9a-f]{64}$' AND payload #>> '{nativeChain,derivationSha256}' ~ '^[0-9a-f]{64}$')) AND
  payload->>'accountAlias' = account_alias AND payload->>'environment' = environment AND
  payload->>'responseRequestId' = response_request_id AND payload->>'jobId' = job_id AND payload->>'runId' = run_id AND
  payload->>'planSha256' = plan_sha256 AND payload->>'copyId' = copy_id AND payload->>'contentSha256' = content_sha256 AND
  payload->>'modelUseRequestSha256' = request_sha256 AND payload->>'responseSha256' = response_sha256 AND
  (payload->>'byteLength')::bigint BETWEEN 1 AND 262144 AND
  payload - ARRAY['profile','accountAlias','environment','responseRequestId','planId','planSha256','originalRequestSha256','jobId','runId','traceId','eventId','recipeSha256','copyId','contentSha256','byteLength','modelUseRequestId','modelUseRequestSha256','postProofSha256','postProofCheckedAt','firstDispatchProofSha256','dispatchSha256','budgetSha256','privacyReviewId','privacyReviewSha256','responseSha256','usage','boundAt','nativeChain'] = '{}'::jsonb AND
  jsonb_typeof(payload->'usage') = 'object' AND payload->'usage' - ARRAY['inputTokens','outputTokens','totalTokens','completionCostUsd'] = '{}'::jsonb
) IS TRUE);
ALTER TABLE vertex_research_chat_worker_origins DROP CONSTRAINT vertex_chat_worker_origin_payload;
ALTER TABLE vertex_research_chat_worker_origins ADD CONSTRAINT vertex_chat_worker_origin_payload CHECK ((
  payload->>'profile' = 'vertex-research-chat-worker-origin-v1' AND payload->>'responseRequestId' = response_request_id AND
  payload->>'ownerActorId' = owner_actor_id AND payload->>'planId' = plan_id AND payload->>'planSha256' = plan_sha256 AND
  payload->>'runId' = run_id AND payload->>'eventId' = event_id AND payload->>'jobId' = job_id AND payload->>'recipeSha256' = recipe_sha256 AND
  payload->'recipe'->>'profile' IN ('vertex-research-chat-job-v1','vertex-research-chat-job-v2','vertex-research-chat-native-evidence-job-v1') AND
  NOT (payload ?| ARRAY['request','retrievalQuery','body','advisory','answer'])
) IS TRUE);
COMMIT;
