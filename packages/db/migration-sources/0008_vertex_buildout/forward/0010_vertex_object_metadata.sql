-- Hand-authored source only. Journal/snapshot generation and execution deferred.
-- Storage rights remain in current policy and artifact catalogs, not this index.
CREATE TABLE "vertex_object_metadata" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "collection_key" text NOT NULL,
  "object_key" text NOT NULL,
  "kind" text NOT NULL,
  "digest" text NOT NULL,
  "size" bigint NOT NULL,
  "content_type" text,
  "checksum" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "vertex_object_metadata_pkey" PRIMARY KEY ("account_alias", "environment", "collection_key", "object_key"),
  CONSTRAINT "vertex_object_metadata_scope_check" CHECK ("account_alias" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' AND "environment" IN ('research', 'paper', 'live') AND ("collection_key" = '' OR "collection_key" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')),
  CONSTRAINT "vertex_object_metadata_kind_check" CHECK ("kind" IN ('manifest', 'content')),
  CONSTRAINT "vertex_object_metadata_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$' AND ("checksum" IS NULL OR "checksum" = "digest")),
  CONSTRAINT "vertex_object_metadata_size_check" CHECK ("size" BETWEEN 1 AND 9007199254740991 AND ("kind" <> 'manifest' OR "size" <= 1048576)),
  CONSTRAINT "vertex_object_metadata_key_check" CHECK (octet_length("object_key") <= 1024 AND "object_key" LIKE 'vertex/v1/%'),
  CONSTRAINT "vertex_object_metadata_type_check" CHECK ("content_type" IS NULL OR octet_length("content_type") BETWEEN 1 AND 200)
);
