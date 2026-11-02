-- SOURCE ONLY, UNAPPLIED and unregistered. Requires research-chat-execution.sql.
CREATE TABLE vertex_research_chat_worker_origins (
  account_alias text NOT NULL,
  environment text NOT NULL,
  response_request_id text NOT NULL,
  owner_actor_id text NOT NULL,
  plan_id text NOT NULL,
  plan_sha256 text NOT NULL,
  run_id text NOT NULL,
  event_id text NOT NULL,
  job_id text NOT NULL,
  recipe_sha256 text NOT NULL,
  record_hash text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(account_alias, environment, response_request_id),
  CONSTRAINT vertex_chat_worker_origin_plan FOREIGN KEY(account_alias, environment, response_request_id, plan_id, plan_sha256) REFERENCES vertex_research_chat_execution_plans(account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_worker_origin_approval FOREIGN KEY(account_alias, environment, response_request_id) REFERENCES vertex_research_chat_execution_approvals(account_alias, environment, response_request_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_worker_origin_outbox FOREIGN KEY(account_alias, environment, event_id) REFERENCES vertex_outbox(account_alias, environment, event_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_worker_origin_scope CHECK(environment = 'research'),
  CONSTRAINT vertex_chat_worker_origin_hashes CHECK(plan_sha256 ~ '^[0-9a-f]{64}$' AND recipe_sha256 ~ '^[0-9a-f]{64}$' AND record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT vertex_chat_worker_origin_payload CHECK((payload->>'profile' = 'vertex-research-chat-worker-origin-v1' AND payload->>'responseRequestId' = response_request_id AND payload->>'ownerActorId' = owner_actor_id AND payload->>'planId' = plan_id AND payload->>'planSha256' = plan_sha256 AND payload->>'runId' = run_id AND payload->>'eventId' = event_id AND payload->>'jobId' = job_id AND payload->>'recipeSha256' = recipe_sha256 AND payload->'recipe'->>'profile' = 'vertex-research-chat-job-v1' AND NOT (payload ?| array['request','retrievalQuery','body','advisory','answer'])) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_worker_origin_run ON vertex_research_chat_worker_origins(account_alias, environment, run_id);
CREATE UNIQUE INDEX vertex_chat_worker_origin_event ON vertex_research_chat_worker_origins(account_alias, environment, event_id);
CREATE UNIQUE INDEX vertex_chat_worker_origin_job ON vertex_research_chat_worker_origins(account_alias, environment, job_id);
CREATE FUNCTION vertex_research_chat_worker_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'research chat worker origins are immutable';
END;
$$;
CREATE TRIGGER vertex_chat_worker_origin_no_change BEFORE UPDATE OR DELETE ON vertex_research_chat_worker_origins FOR EACH ROW EXECUTE FUNCTION vertex_research_chat_worker_origin_immutable();
