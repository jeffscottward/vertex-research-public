import {
  vertexQualifiedObjectKey,
  type VertexObjectCapabilities,
} from "@darkfactory/storage/vertex";
import {
  VertexStoreError,
  type VertexScope,
} from "@darkfactory/db/server/vertex";
import { IdentifierSchema, DigestSchema } from "../contracts/vertex.ts";
import type {
  VertexRequestOptions,
  VertexScopedObjects,
} from "./vertex-experience-adapter.ts";

export type VertexRuntimeObjectOptions = Pick<
  VertexRequestOptions,
  "objectsForScope" | "objects" | "objectCapabilities" | "signal"
>;
const unavailable = (): never => {
  throw new VertexStoreError("unavailable");
};
const invalid = (): never => {
  throw new VertexStoreError("invalid");
};
const VERTEX_RUNTIME_OBJECT_MAX_BYTES = 1_048_576;

// The WorkerStore currently resolves a backend by account, while its qualified
// immutable keys include a collection. Resolve that exact collection backend,
// never use the account-only R2 backend as a wildcard. This is key validation,
// NOT authorization: worker/policy/storage callers still check current grants.
export const vertexRuntimeObjectCollection = (
  scope: VertexScope,
  key: string
): string | null => {
  try {
    if (typeof key !== "string" || key.length > 1024) return invalid();
    const parts = key.split("/");
    const collectionId =
      parts[4] === "account"
        ? null
        : parts[4] === "collection"
          ? IdentifierSchema.parse(decodeURIComponent(parts[5] ?? ""))
          : invalid();
    const index = collectionId === null ? 5 : 6;
    const kind = parts[index];
    if (kind !== "manifest" && kind !== "content") return invalid();
    const sha256 = DigestSchema.parse(parts[index + 2]);
    if (vertexQualifiedObjectKey(scope, collectionId, kind, sha256) !== key)
      return invalid();
    return collectionId;
  } catch {
    return invalid();
  }
};

export const createVertexRuntimeObjectCapabilities = (
  options: VertexRuntimeObjectOptions
): ((scope: VertexScope) => VertexObjectCapabilities) => {
  return (requestedScope) => {
    const scope = Object.freeze({
      accountAlias: IdentifierSchema.parse(requestedScope.accountAlias),
      environment: requestedScope.environment,
    });
    const bindings = new Map<string | null, Promise<VertexScopedObjects>>();
    const resolve = async (key: string): Promise<VertexObjectCapabilities> => {
      if (options.signal?.aborted) return unavailable();
      const collection = vertexRuntimeObjectCollection(scope, key);
      if (!options.objectsForScope) {
        if (!options.objectCapabilities) return unavailable();
        return options.objectCapabilities;
      }
      let binding = bindings.get(collection);
      if (!binding) {
        binding = Promise.resolve(
          options.objectsForScope(scope, collection, options.signal)
        );
        bindings.set(collection, binding);
      }
      const result = await binding;
      if (options.signal?.aborted) return unavailable();
      return result.objectCapabilities;
    };
    return Object.freeze({
      head: async (key) => {
        const port = (await resolve(key)).head;
        if (!port) return unavailable();
        return port(key);
      },
      getBounded: async (key, maximumBytes) => {
        if (
          !Number.isSafeInteger(maximumBytes) ||
          maximumBytes < 1 ||
          maximumBytes > VERTEX_RUNTIME_OBJECT_MAX_BYTES
        )
          return invalid();
        const port = (await resolve(key)).getBounded;
        if (!port) return unavailable();
        return port(key, maximumBytes);
      },
      putIfAbsent: async (input) => {
        if (
          !(input.body instanceof Uint8Array) ||
          input.body.byteLength > VERTEX_RUNTIME_OBJECT_MAX_BYTES
        )
          return invalid();
        const port = (await resolve(input.key)).putIfAbsent;
        if (!port) return unavailable();
        return port(input);
      },
    });
  };
};
