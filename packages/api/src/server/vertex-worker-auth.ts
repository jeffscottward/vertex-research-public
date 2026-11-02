import { z } from "zod";
import type {
  VertexWorkerStore,
  WorkerServiceIdentity,
} from "@darkfactory/db/server/vertex-worker";
import { timestampToEpochNanoseconds } from "@darkfactory/shared/vertex";
import { IdentifierSchema, TimestampSchema } from "../contracts/vertex.ts";
import { WorkerScopeSchema } from "../contracts/vertex-worker.ts";
import {
  VERTEX_WORKER_SERVICE_ERRORS,
  type VertexWorkerServiceErrorCode,
} from "../contracts/vertex-worker-rpc.ts";
import { present } from "./present.ts";

const wireReserveBytes = 4096;
const encoder = new TextEncoder();
export class VertexWorkerServiceError extends Error {
  readonly code: VertexWorkerServiceErrorCode;
  constructor(code: VertexWorkerServiceErrorCode) {
    super(VERTEX_WORKER_SERVICE_ERRORS[code].message);
    this.name = "VertexWorkerServiceError";
    this.code = code;
  }
}

export type VertexWorkerRequestContext = Readonly<{
  // Bound from Request.headers by createApiContext, NEVER from RPC input.
  headers: Pick<Headers, "get">;
  signal?: AbortSignal;
}>;
export const IdentitySchema = z
  .object({
    grantId: IdentifierSchema,
    servicePrincipalId: IdentifierSchema,
    scope: WorkerScopeSchema,
    expiresAt: TimestampSchema,
  })
  .strict();
// Check a data-only JSON graph BEFORE schema traversal or stringify. Accessors,
// cycles, sparse/decorated arrays and huge/deep graphs never execute getters.
// The byte count is exact JSON size; leave room for oRPC's JSON envelope.
export const boundedJson = (
  value: unknown,
  ceiling: number,
  code: VertexWorkerServiceErrorCode
): void => {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const add = (text: string): void => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > ceiling - wireReserveBytes)
      throw new VertexWorkerServiceError(code);
  };
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) throw new VertexWorkerServiceError(code);
    if (item === null || typeof item === "boolean") {
      add(JSON.stringify(item));
      return;
    }
    if (typeof item === "string") {
      if (item.length > ceiling) throw new VertexWorkerServiceError(code);
      add(JSON.stringify(item));
      return;
    }
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0))
        throw new VertexWorkerServiceError(code);
      add(String(item));
      return;
    }
    if (typeof item !== "object" || ancestors.has(item))
      throw new VertexWorkerServiceError(code);
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new VertexWorkerServiceError(code);
    const keys = Reflect.ownKeys(item);
    if (keys.length > 100_000 || keys.some((key) => typeof key !== "string"))
      throw new VertexWorkerServiceError(code);
    ancestors.add(item);
    add(array ? "[" : "{");
    const dataKeys = array ? keys.filter((key) => key !== "length") : keys;
    if (
      array &&
      (dataKeys.length !== item.length ||
        dataKeys.some((key, index) => key !== String(index)))
    )
      throw new VertexWorkerServiceError(code);
    for (const [index, key] of dataKeys.entries()) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!(descriptor?.enumerable && "value" in descriptor))
        throw new VertexWorkerServiceError(code);
      if (index > 0) add(",");
      if (!array) add(`${JSON.stringify(key)}:`);
      visit(descriptor.value, depth + 1);
    }
    add(array ? "]" : "}");
    ancestors.delete(item);
  };
  visit(value, 0);
};

export const parse = <T>(
  schema: z.ZodType<T>,
  raw: unknown,
  code: VertexWorkerServiceErrorCode
): T => {
  const result = schema.safeParse(raw);
  if (!result.success) throw new VertexWorkerServiceError(code);
  return result.data;
};
export const bearerDigest = async (
  headers: Pick<Headers, "get">
): Promise<string> => {
  try {
    const value = headers.get("authorization");
    const match =
      typeof value === "string"
        ? /^Bearer ([A-Za-z0-9_-]{43,171})$/.exec(value)
        : null;
    if (!match) throw new VertexWorkerServiceError("UNAUTHORIZED");
    const token = present(match[1]);
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    // Provisioning must generate >=32 random bytes. This is a format/length
    // check, not a claim that entropy can be measured from one credential.
    if (
      decoded.length < 32 ||
      decoded.length > 128 ||
      btoa(decoded)
        .replace(/[=]/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_") !== token
    )
      throw new VertexWorkerServiceError("UNAUTHORIZED");
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  } catch {
    // No upstream message, cause, token, headers or digest enters the error.
    throw new VertexWorkerServiceError("UNAUTHORIZED");
  }
};
export const sourceFailure = (error: unknown): never => {
  if (error instanceof VertexWorkerServiceError) throw error;
  // Repository errors have fixed codes; never forward arbitrary source text.
  const code = error instanceof Error && "code" in error ? error["code"] : null;
  if (code === "denied") throw new VertexWorkerServiceError("FORBIDDEN");
  if (code === "conflict" || code === "stale")
    throw new VertexWorkerServiceError("CONFLICT");
  throw new VertexWorkerServiceError("SERVICE_UNAVAILABLE");
};

// One real header/digest/issued-reference boundary for existing workers and the
// independent metadata service. A parsed clone is never substituted for the
// database's instance-local identity capability.
export const authenticateVertexWorkerRequest = async (
  context: VertexWorkerRequestContext,
  scope: z.infer<typeof WorkerScopeSchema>,
  operation: string,
  store: Pick<VertexWorkerStore, "authenticate">,
  clock: Readonly<{ now: () => string }>
): Promise<WorkerServiceIdentity> => {
  const digest = await bearerDigest(context.headers);
  let identity: WorkerServiceIdentity;
  try {
    identity = await store.authenticate(digest, scope, operation);
    boundedJson(identity, 8192, "UNAUTHORIZED");
    parse(IdentitySchema, identity, "UNAUTHORIZED");
  } catch {
    throw new VertexWorkerServiceError("UNAUTHORIZED");
  }
  const at = parse(TimestampSchema, clock.now(), "SERVICE_UNAVAILABLE");
  if (
    identity.scope.accountAlias !== scope.accountAlias ||
    identity.scope.environment !== scope.environment ||
    timestampToEpochNanoseconds(identity.expiresAt) <=
      timestampToEpochNanoseconds(at)
  )
    throw new VertexWorkerServiceError("UNAUTHORIZED");
  if (context.signal?.aborted)
    throw new VertexWorkerServiceError("SERVICE_UNAVAILABLE");
  return identity;
};
