import { sql } from "drizzle-orm";
import { bigint, check, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

// Generic object metadata index. Rights/lineage remain in vertex_artifacts and
// current policy records; this table is not an authorization decision or body.
export const vertexObjectMetadata = pgTable(
  "vertex_object_metadata",
  {
    accountAlias: text("account_alias").notNull(),
    environment: text("environment").notNull(),
    collectionKey: text("collection_key").notNull(),
    objectKey: text("object_key").notNull(),
    kind: text("kind").notNull(),
    digest: text("digest").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    checksum: text("checksum"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "vertex_object_metadata_pkey",
      columns: [
        table.accountAlias,
        table.environment,
        table.collectionKey,
        table.objectKey,
      ],
    }),
    check(
      "vertex_object_metadata_scope_check",
      sql`${table.accountAlias} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${table.environment} in ('research', 'paper', 'live') and (${table.collectionKey} = '' or ${table.collectionKey} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')`
    ),
    check(
      "vertex_object_metadata_kind_check",
      sql`${table.kind} in ('manifest', 'content')`
    ),
    check(
      "vertex_object_metadata_digest_check",
      sql`${table.digest} ~ '^[0-9a-f]{64}$' and (${table.checksum} is null or ${table.checksum} = ${table.digest})`
    ),
    check(
      "vertex_object_metadata_size_check",
      sql`${table.size} between 1 and 9007199254740991 and (${table.kind} <> 'manifest' or ${table.size} <= 1048576)`
    ),
    check(
      "vertex_object_metadata_key_check",
      sql`octet_length(${table.objectKey}) <= 1024 and ${table.objectKey} like 'vertex/v1/%'`
    ),
    check(
      "vertex_object_metadata_type_check",
      sql`${table.contentType} is null or octet_length(${table.contentType}) between 1 and 200`
    ),
  ]
);
