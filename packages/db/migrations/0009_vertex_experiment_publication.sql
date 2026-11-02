CREATE TABLE "vertex_worker_experiment_publications" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "collection_id" text NOT NULL,
  "experiment_id" text NOT NULL,
  "artifact_id" text NOT NULL,
  "content_sha256" text NOT NULL,
  "object_key" text NOT NULL,
  "byte_length" integer NOT NULL,
  "record_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  CONSTRAINT "vertex_worker_experiment_identity" PRIMARY KEY ("account_alias", "environment", "collection_id", "experiment_id"),
  CONSTRAINT "vertex_worker_experiment_scope" CHECK ("environment" in ('research','paper') and length("collection_id") > 0),
  CONSTRAINT "vertex_worker_experiment_length" CHECK ("byte_length" between 1 and 1048576),
  CONSTRAINT "vertex_worker_experiment_hash" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$' and "record_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_worker_experiment_artifact" ON "vertex_worker_experiment_publications" USING btree ("account_alias", "environment", "artifact_id");
