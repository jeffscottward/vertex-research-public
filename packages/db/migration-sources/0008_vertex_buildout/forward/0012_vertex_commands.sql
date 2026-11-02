-- Immutable command receipts and review overlays. No source evidence, accepted
-- derivative, active collection snapshot or inherited table is rewritten.
CREATE TABLE vertex_command_receipts (
  account_alias text NOT NULL, environment text NOT NULL, actor_id text NOT NULL,
  kind text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
  command jsonb NOT NULL, result jsonb NOT NULL, result_hash text NOT NULL,
  collection_key text NOT NULL, target_artifact_id text, review_id text, admission_id text,
  committed_at text NOT NULL, committed_at_ns numeric(30,0) NOT NULL,
  CONSTRAINT vertex_command_receipts_pk PRIMARY KEY(account_alias,environment,actor_id,kind,idempotency_key),
  CONSTRAINT vertex_command_kind CHECK(kind IN ('review','research','simulation')),
  CONSTRAINT vertex_command_hashes CHECK(request_hash ~ '^[0-9a-f]{64}$' AND result_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE vertex_reviewed_artifact_links (
  account_alias text NOT NULL, environment text NOT NULL, review_id text NOT NULL,
  collection_key text NOT NULL, artifact_id text NOT NULL, artifact_sha256 text NOT NULL,
  committed_at text NOT NULL, committed_at_ns numeric(30,0) NOT NULL,
  CONSTRAINT vertex_reviewed_artifact_links_pk PRIMARY KEY(account_alias,environment,review_id),
  CONSTRAINT vertex_reviewed_artifact_review_fk FOREIGN KEY(account_alias,environment,review_id)
    REFERENCES vertex_reviews(account_alias,environment,review_id),
  CONSTRAINT vertex_reviewed_artifact_record_fk FOREIGN KEY(account_alias,environment,artifact_id)
    REFERENCES vertex_records(account_alias,environment,artifact_id)
);
CREATE INDEX vertex_reviewed_artifact_lookup ON vertex_reviewed_artifact_links(account_alias,environment,collection_key,artifact_id);
--> statement-breakpoint
CREATE TABLE vertex_research_proposals (
  account_alias text NOT NULL, environment text NOT NULL, artifact_id text NOT NULL,
  actor_id text NOT NULL, collection_id text NOT NULL, question text NOT NULL,
  role text NOT NULL, proposal_hash text NOT NULL, payload jsonb NOT NULL,
  committed_at text NOT NULL, committed_at_ns numeric(30,0) NOT NULL,
  CONSTRAINT vertex_research_proposals_pk PRIMARY KEY(account_alias,environment,artifact_id),
  CONSTRAINT vertex_research_proposal_record_fk FOREIGN KEY(account_alias,environment,artifact_id)
    REFERENCES vertex_records(account_alias,environment,artifact_id),
  -- API counts UTF-16 units; PostgreSQL counts Unicode characters. The source
  -- validator applies exact 10..2000 UTF-16 bounds; SQL never rejects a valid
  -- astral-character question by imposing a stricter character minimum.
  CONSTRAINT vertex_research_question CHECK(length(question) BETWEEN 1 AND 2000),
  CONSTRAINT vertex_research_role CHECK(role IN ('research','paper-to-strategy','backtest-review','knowledge-import'))
);
--> statement-breakpoint
CREATE TABLE vertex_research_proposal_evidence (
  account_alias text NOT NULL, environment text NOT NULL, artifact_id text NOT NULL,
  ordinal numeric(2,0) NOT NULL, evidence_id text NOT NULL,
  evidence_artifact_id text NOT NULL, evidence_sha256 text NOT NULL,
  CONSTRAINT vertex_research_proposal_evidence_pk PRIMARY KEY(account_alias,environment,artifact_id,evidence_id),
  CONSTRAINT vertex_proposal_evidence_proposal_fk FOREIGN KEY(account_alias,environment,artifact_id)
    REFERENCES vertex_research_proposals(account_alias,environment,artifact_id),
  CONSTRAINT vertex_proposal_evidence_artifact_fk FOREIGN KEY(account_alias,environment,evidence_artifact_id)
    REFERENCES vertex_artifacts(account_alias,environment,artifact_id),
  CONSTRAINT vertex_proposal_evidence_ordinal_bound CHECK(ordinal BETWEEN 0 AND 31)
);
CREATE UNIQUE INDEX vertex_proposal_evidence_ordinal ON vertex_research_proposal_evidence(account_alias,environment,artifact_id,ordinal);
