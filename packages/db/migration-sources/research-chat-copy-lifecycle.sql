-- SOURCE ONLY. Depends on existing copy inventory plus research-chat-execution.sql.
-- Not registered, generated or applied. No current deployment qualification.
-- An intent is NOT evidence a call happened; replay never grants dispatch.
CREATE TABLE vertex_research_chat_copy_effects (
  account_alias text NOT NULL,
  environment text NOT NULL,
  response_request_id text NOT NULL,
  copy_id text NOT NULL,
  operation text NOT NULL,
  plan_sha256 text NOT NULL,
  binding_sha256 text NOT NULL,
  intent_committed_at_ns numeric(30,0) NOT NULL,
  payload jsonb NOT NULL,
  record_hash text NOT NULL,
  PRIMARY KEY(account_alias, environment, response_request_id, copy_id, operation),
  CONSTRAINT vertex_chat_copy_effect_approval FOREIGN KEY(account_alias, environment, response_request_id)
    REFERENCES vertex_research_chat_execution_approvals(account_alias, environment, response_request_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_copy_effect_allocation FOREIGN KEY(account_alias, environment, response_request_id, copy_id)
    REFERENCES vertex_research_chat_copy_allocations(account_alias, environment, response_request_id, copy_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_copy_effect_shape CHECK(environment = 'research' AND operation IN ('create','fence') AND plan_sha256 ~ '^[0-9a-f]{64}$' AND binding_sha256 ~ '^[0-9a-f]{64}$' AND record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_chat_copy_effect_payload CHECK((
    payload = jsonb_build_object('profile','vertex-research-chat-copy-effect-v1','scope',jsonb_build_object('accountAlias',account_alias,'environment',environment),'responseRequestId',response_request_id,'copyId',copy_id,'planSha256',plan_sha256,'operation',operation,'bindingSha256',binding_sha256,'content',payload->'content','intentCommittedAt',payload->'intentCommittedAt')
    AND (payload->'content' = 'null'::jsonb OR (payload->'content' = jsonb_build_object('sha256',payload #> '{content,sha256}','byteLength',payload #> '{content,byteLength}') AND payload #>> '{content,sha256}' ~ '^[0-9a-f]{64}$' AND (payload #>> '{content,byteLength}')::integer BETWEEN 1 AND 16777216))
    AND (operation <> 'create' OR payload->'content' <> 'null'::jsonb)
  ) IS TRUE)
);

CREATE TABLE vertex_research_chat_copy_effect_observations (
  account_alias text NOT NULL,
  environment text NOT NULL,
  response_request_id text NOT NULL,
  copy_id text NOT NULL,
  operation text NOT NULL,
  observed_at_ns numeric(30,0) NOT NULL,
  payload jsonb NOT NULL,
  record_hash text NOT NULL,
  PRIMARY KEY(account_alias, environment, response_request_id, copy_id, operation),
  CONSTRAINT vertex_chat_copy_observation_effect FOREIGN KEY(account_alias, environment, response_request_id, copy_id, operation)
    REFERENCES vertex_research_chat_copy_effects(account_alias, environment, response_request_id, copy_id, operation) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_copy_observation_shape CHECK(environment = 'research' AND operation IN ('create','fence') AND record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_chat_copy_observation_payload CHECK((
    payload = jsonb_build_object('profile','vertex-research-chat-copy-effect-observation-v1','scope',jsonb_build_object('accountAlias',account_alias,'environment',environment),'responseRequestId',response_request_id,'copyId',copy_id,'planSha256',payload->'planSha256','operation',operation,'proof',payload->'proof','observedAt',payload->'observedAt')
    AND payload #>> '{proof,state}' = CASE WHEN operation = 'create' THEN 'live' ELSE 'fenced' END
    AND payload->'proof' = jsonb_build_object('key',payload #> '{proof,key}','state',payload #> '{proof,state}','bindingSha256',payload #> '{proof,bindingSha256}','reservationSha256',payload #> '{proof,reservationSha256}','storageProfileSha256',payload #> '{proof,storageProfileSha256}','sha256',payload #> '{proof,sha256}','byteLength',payload #> '{proof,byteLength}','etag',payload #> '{proof,etag}','version',payload #> '{proof,version}','uploadedAt',payload #> '{proof,uploadedAt}')
  ) IS TRUE)
);

CREATE TABLE vertex_research_chat_copy_domain_closures (
  account_alias text NOT NULL,
  environment text NOT NULL,
  response_request_id text NOT NULL,
  domain text NOT NULL,
  plan_sha256 text NOT NULL,
  closed_at_ns numeric(30,0) NOT NULL,
  payload jsonb NOT NULL,
  record_hash text NOT NULL,
  PRIMARY KEY(account_alias, environment, response_request_id, domain),
  CONSTRAINT vertex_chat_copy_domain_approval FOREIGN KEY(account_alias, environment, response_request_id)
    REFERENCES vertex_research_chat_execution_approvals(account_alias, environment, response_request_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_copy_domain_shape CHECK(environment = 'research' AND domain IN ('inputs','derived') AND plan_sha256 ~ '^[0-9a-f]{64}$' AND record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_chat_copy_domain_payload CHECK((
    payload = jsonb_build_object('profile','vertex-research-chat-copy-domain-closure-v1','scope',jsonb_build_object('accountAlias',account_alias,'environment',environment),'responseRequestId',response_request_id,'planSha256',plan_sha256,'domain',domain,'cause',payload->'cause','authority',payload->'authority','closedAt',payload->'closedAt')
    AND payload->>'cause' IN ('explicit','deadline','original-authority-revoked','original-authority-expired','rights-denied','rights-expiry','rights-superseded','retention-ended','storage-review-superseded','storage-review-rejected','storage-review-expired','corpus-review-superseded','corpus-review-rejected','corpus-review-expired','response-attempt-terminal','storage-fenced')
    AND payload->'authority' = jsonb_build_object('kind',payload #> '{authority,kind}','resourceId',payload #> '{authority,resourceId}','version',payload #> '{authority,version}')
    AND payload #>> '{authority,kind}' IN ('owner-context-grant','corpus-rights','private-policy-rights','storage-review','corpus-review','plan','cleanup-grant','response-attempt','storage-fence')
    AND payload #>> '{authority,resourceId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
    AND (payload #> '{authority,version}' = 'null'::jsonb OR payload #>> '{authority,version}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')
  ) IS TRUE)
);

-- Reuse the immutable governance trigger already defined by prerequisite source.
CREATE TRIGGER vertex_chat_copy_effect_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_copy_effects
  FOR EACH ROW EXECUTE FUNCTION vertex_research_chat_execution_immutable();
CREATE TRIGGER vertex_chat_copy_observation_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_copy_effect_observations
  FOR EACH ROW EXECUTE FUNCTION vertex_research_chat_execution_immutable();
CREATE TRIGGER vertex_chat_copy_domain_immutable BEFORE UPDATE OR DELETE ON vertex_research_chat_copy_domain_closures
  FOR EACH ROW EXECUTE FUNCTION vertex_research_chat_execution_immutable();
