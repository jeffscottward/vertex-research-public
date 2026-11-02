import { timestampToEpochNanoseconds } from "@darkfactory/shared/vertex";
import type {
  ObjectMetadata,
  ObjectMetadataRepository,
} from "@darkfactory/storage";
import { sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import type {
  VertexAuthorization,
  VertexClock,
  VertexPrincipal,
  VertexScope,
} from "./vertex-ports.ts";
import { VertexStoreError } from "./vertex-ports.ts";

export type VertexObjectMetadataOptions = Readonly<{
  principal: VertexPrincipal;
  scope: VertexScope;
  collectionId: string | null;
  authorization: VertexAuthorization;
  clock: VertexClock;
  maximumContentBytes?: number;
}>;
const fail: (code: VertexStoreError["code"]) => never = (code) => {
  throw new VertexStoreError(code);
};
const identifier = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  )
    return fail("invalid");
  return value;
};
const instant = (value: unknown): bigint => {
  try {
    if (typeof value !== "string") return fail("invalid");
    return timestampToEpochNanoseconds(value);
  } catch {
    return fail("invalid");
  }
};
const metadataFields = (value: unknown): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = [
    "key",
    "size",
    "contentType",
    "checksum",
    "createdAt",
    "updatedAt",
  ];
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.includes(key)
    ) ||
    ["key", "size", "createdAt", "updatedAt"].some(
      (key) => !Object.hasOwn(descriptors, key)
    ) ||
    Object.values(descriptors).some(
      (field) => !(field.enumerable && Object.hasOwn(field, "value"))
    )
  )
    return fail("invalid");
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, field]) => [key, field.value])
  );
};

// Instantiate per authenticated request/scope. This is the concrete durable
// ObjectMetadataRepository consumed by the storage factory; NOT another blob
// store, artifact authority, rights registry, or automatic deletion policy.
export const createVertexObjectMetadataRepository = (
  db: Database,
  options: VertexObjectMetadataOptions
): ObjectMetadataRepository => {
  if (
    !db ||
    typeof db.transaction !== "function" ||
    !options ||
    typeof options.authorization?.authorize !== "function" ||
    typeof options.clock?.now !== "function"
  )
    fail("unavailable");
  const principal = Object.freeze({
    actorId: identifier(options.principal?.actorId),
  });
  const scope = Object.freeze({
    accountAlias: identifier(options.scope?.accountAlias),
    environment: options.scope?.environment,
  });
  if (
    scope.environment !== "research" &&
    scope.environment !== "paper" &&
    scope.environment !== "live"
  )
    fail("invalid");
  const collectionId =
    options.collectionId === null ? null : identifier(options.collectionId);
  const collectionKey = collectionId ?? "";
  const maximumContentBytes = options.maximumContentBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maximumContentBytes) || maximumContentBytes <= 0)
    fail("invalid");
  const namespace = `vertex/v1/${encodeURIComponent(scope.accountAlias)}/${scope.environment}/${collectionId === null ? "account" : `collection/${encodeURIComponent(collectionId)}`}/`;
  const locate = (
    key: unknown
  ): Readonly<{
    key: string;
    kind: "manifest" | "content";
    digest: string;
  }> => {
    if (
      typeof key !== "string" ||
      key.length > 1024 ||
      !key.startsWith(namespace)
    )
      return fail("denied");
    const parts = key.slice(namespace.length).split("/");
    if (
      parts.length !== 3 ||
      (parts[0] !== "manifest" && parts[0] !== "content") ||
      parts[1] !== "sha256" ||
      !/^[0-9a-f]{64}$/.test(requirePresent(parts[2], "parts[2]"))
    )
      return fail("invalid");
    return {
      key,
      kind: parts[0],
      digest: requirePresent(parts[2], "parts[2]"),
    };
  };
  const snapshot = (source: unknown): ObjectMetadata => {
    const value = metadataFields(source);
    const location = locate(value["key"]);
    const maximum =
      location.kind === "manifest" ? 1_048_576 : maximumContentBytes;
    if (
      typeof value["size"] !== "number" ||
      !Number.isSafeInteger(value["size"]) ||
      value["size"] <= 0 ||
      value["size"] > maximum
    )
      return fail("invalid");
    if (
      value["contentType"] !== undefined &&
      (typeof value["contentType"] !== "string" ||
        !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(
          value["contentType"]
        ) ||
        value["contentType"].length > 200)
    )
      return fail("invalid");
    if (
      value["checksum"] !== undefined &&
      value["checksum"] !== location.digest
    )
      return fail("integrity");
    const createdAt = value["createdAt"] as string;
    const updatedAt = value["updatedAt"] as string;
    if (
      instant(createdAt) > instant(updatedAt) ||
      instant(updatedAt) > instant(options.clock.now())
    )
      return fail("invalid");
    return Object.freeze({
      key: location.key,
      size: value["size"],
      createdAt,
      updatedAt,
      ...(value["contentType"] === undefined
        ? {}
        : { contentType: value["contentType"] as string }),
      ...(value["checksum"] === undefined
        ? {}
        : { checksum: value["checksum"] as string }),
    });
  };
  const authorize = async (
    key: string,
    action: "read" | "publish"
  ): Promise<void> => {
    const location = locate(key);
    const at = options.clock.now();
    instant(at);
    let allowed = false;
    try {
      allowed =
        (await options.authorization.authorize({
          principal,
          scope,
          collectionId,
          resourceId: `object-${location.digest}`,
          action,
          now: at,
        })) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) fail("denied");
  };
  const where = (key: string) =>
    sql`account_alias = ${scope.accountAlias} and environment = ${scope.environment} and collection_key = ${collectionKey} and object_key = ${key}`;
  const fromRow = (row: Record<string, unknown>): ObjectMetadata => {
    const size =
      typeof row["size"] === "string" && /^(0|[1-9]\d{0,15})$/.test(row["size"])
        ? Number(row["size"])
        : row["size"];
    const value = snapshot({
      key: row["object_key"],
      size,
      createdAt: row["created_at"],
      updatedAt: row["updated_at"],
      ...(row["content_type"] === null
        ? {}
        : { contentType: row["content_type"] }),
      ...(row["checksum"] === null ? {} : { checksum: row["checksum"] }),
    });
    const location = locate(value.key);
    if (location.digest !== row["digest"] || location.kind !== row["kind"])
      fail("integrity");
    return value;
  };
  const identical = (left: ObjectMetadata, right: ObjectMetadata): boolean =>
    left.key === right.key &&
    left.size === right.size &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.contentType === right.contentType &&
    left.checksum === right.checksum;
  const protect = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof VertexStoreError)
        throw new VertexStoreError(error.code);
      return fail("unavailable");
    }
  };
  return Object.freeze<ObjectMetadataRepository>({
    upsert: (input) =>
      protect(async () => {
        const metadata = snapshot(input);
        const location = locate(metadata.key);
        await authorize(metadata.key, "publish");
        return await db.transaction(async (tx) => {
          await authorize(metadata.key, "publish");
          // Create-only upsert. Concurrent identical retries converge; a changed
          // immutable descriptor conflicts and never overwrites prior metadata.
          await tx.execute(
            sql`insert into vertex_object_metadata (account_alias, environment, collection_key, object_key, kind, digest, size, content_type, checksum, created_at, updated_at) values (${scope.accountAlias}, ${scope.environment}, ${collectionKey}, ${metadata.key}, ${location.kind}, ${location.digest}, ${metadata.size}, ${metadata.contentType ?? null}, ${metadata.checksum ?? null}, ${metadata.createdAt}, ${metadata.updatedAt}) on conflict (account_alias, environment, collection_key, object_key) do nothing`
          );
          const result = await tx.execute(
            sql`select * from vertex_object_metadata where ${where(metadata.key)} limit 1`
          );
          const row = (result.rows as Record<string, unknown>[])[0];
          if (!(row && identical(fromRow(row), metadata))) fail("conflict");
          return await authorize(metadata.key, "publish");
        });
      }),
    findByKey: (input) =>
      protect(async () => {
        const { key } = locate(input);
        await authorize(key, "read");
        return db.transaction(
          async (tx) => {
            const result = await tx.execute(
              sql`select * from vertex_object_metadata where ${where(key)} limit 1`
            );
            const row = (result.rows as Record<string, unknown>[])[0];
            const metadata = row ? fromRow(row) : null;
            await authorize(key, "read");
            return metadata;
          },
          { accessMode: "read only" }
        );
      }),
    deleteByKey: (input) =>
      protect(async () => {
        const { key } = locate(input);
        await authorize(key, "publish");
        // Immutable artifact metadata is never a GC authority. No caller can
        // bypass retention or remove metadata shared by another artifact alias.
        // Archival/GC needs a separately approved, reference-aware migration.
        return fail("denied");
      }),
  });
};
