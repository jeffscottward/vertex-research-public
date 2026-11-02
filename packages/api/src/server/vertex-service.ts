import type { SafePrincipal } from "@darkfactory/auth/types";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { z } from "zod";
import { DigestSchema, type ModuleManifest } from "../contracts/vertex.ts";
import {
  VERTEX_READ_ERRORS,
  VertexModulesListInputSchema,
  VertexModulesListOutputSchema,
  type VertexModulesListInput,
} from "../contracts/vertex-read.ts";
import { present } from "./present.ts";

export const MAX_VERTEX_ARTIFACT_BYTES = 1_048_576;

const StorageIdentitySchema = z.object({ kind: z.literal("modules") }).strict();

// Metadata MUST come from the trusted catalog, not from JSON fields or caller
// input. artifactSha256 seals these exact manifest bytes. contentSha256 is the
// catalog's independently verified source-content digest, not a manifest hash.
// Adapters enforce the bound before allocating/reading; the service checks it
// again. No storage/provider implementation or source-content fetch lives here.
export type VertexStoredArtifact = Readonly<{
  bytes: Uint8Array;
  artifactSha256: string;
  identity: z.infer<typeof StorageIdentitySchema>;
}>;

export type VertexReadPort = Readonly<{
  listModules: (principal: SafePrincipal) => Promise<VertexStoredArtifact>;
}>;

// An explicit decision is required for each read, before any storage access.
// Roles, supplied IDs, acceptance labels and lifecycle states are not grants.
export type VertexAuthorizationPort = Readonly<{
  canListModules: (principal: SafePrincipal) => Promise<boolean>;
}>;

export type VertexReadDependencies = Readonly<{
  read?: VertexReadPort;
  authorization?: VertexAuthorizationPort;
}>;
export type VertexReadServiceErrorCode = keyof typeof VERTEX_READ_ERRORS;

export class VertexReadServiceError extends Error {
  readonly code: VertexReadServiceErrorCode;
  constructor(code: VertexReadServiceErrorCode) {
    super(VERTEX_READ_ERRORS[code].message);
    this.name = "VertexReadServiceError";
    this.code = code;
  }
}

export type VertexReadService = Readonly<{
  listModules: (
    principal: SafePrincipal,
    input: VertexModulesListInput
  ) => Promise<readonly ModuleManifest[]>;
}>;

const inputValue = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new VertexReadServiceError("BAD_REQUEST");
  return result.data;
};

const portsFor = (dependencies: VertexReadDependencies) => {
  if (
    dependencies.read === undefined ||
    dependencies.authorization === undefined
  ) {
    throw new VertexReadServiceError("SERVICE_UNAVAILABLE");
  }
  return { read: dependencies.read, authorization: dependencies.authorization };
};

const fromPort = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch {
    // Never forward provider exceptions, even if they mimic our error class.
    throw new VertexReadServiceError("SERVICE_UNAVAILABLE");
  }
};

const authorize = async (operation: () => Promise<boolean>): Promise<void> => {
  const decision = await fromPort(operation);
  if (decision === false) throw new VertexReadServiceError("FORBIDDEN");
  if (decision !== true)
    throw new VertexReadServiceError("SERVICE_UNAVAILABLE");
};

const decodeArtifact = async (stored: VertexStoredArtifact) => {
  try {
    // Read data properties only: adapter mistakes must not execute accessors or
    // change the checked byte container between bounds checks and snapshotting.
    if (
      stored === null ||
      typeof stored !== "object" ||
      Object.getPrototypeOf(stored) !== Object.prototype
    ) {
      throw new Error("Invalid envelope");
    }
    const fields = Object.getOwnPropertyDescriptors(stored);
    if (
      Reflect.ownKeys(stored).length !== 3 ||
      !Object.hasOwn(fields, "bytes") ||
      !Object.hasOwn(fields, "identity") ||
      !Object.hasOwn(fields, "artifactSha256") ||
      Object.values(fields).some(
        (field) => !(field.enumerable && Object.hasOwn(field, "value"))
      )
    ) {
      throw new Error("Invalid envelope fields");
    }
    const sourceBytes: unknown = present(fields.bytes).value;
    if (
      !(sourceBytes instanceof Uint8Array) ||
      Object.getPrototypeOf(sourceBytes) !== Uint8Array.prototype ||
      Object.hasOwn(sourceBytes, "buffer") ||
      Object.hasOwn(sourceBytes, "byteLength") ||
      !(sourceBytes.buffer instanceof ArrayBuffer) ||
      sourceBytes.byteLength === 0 ||
      sourceBytes.byteLength > MAX_VERTEX_ARTIFACT_BYTES
    ) {
      throw new Error("Invalid bytes");
    }
    const bytes = new Uint8Array(sourceBytes);
    canonicalArtifactJson(present(fields.identity).value);
    const identity = StorageIdentitySchema.parse(
      present(fields.identity).value
    );
    const expectedDigest = DigestSchema.parse(
      present(fields.artifactSha256).value
    );
    if ((await hashArtifact(bytes)) !== expectedDigest)
      throw new Error("Digest mismatch");
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const value: unknown = JSON.parse(text);
    // Exact equality rejects whitespace, duplicate keys, alternate escapes,
    // reordered keys, BOMs, lossy integers, -0, and noncanonical scalar values.
    if (canonicalArtifactJson(value) !== text)
      throw new Error("Noncanonical artifact");
    return { value, identity };
  } catch {
    throw new VertexReadServiceError("INVALID_SOURCE");
  }
};

const sourceValue = <T>(schema: z.ZodType<T>, value: unknown): T => {
  try {
    // Existing artifact schemas clone and recursively freeze the parsed graph.
    return schema.parse(value);
  } catch {
    throw new VertexReadServiceError("INVALID_SOURCE");
  }
};

export const createVertexReadService = (
  dependencies: VertexReadDependencies = {}
): VertexReadService => ({
  listModules: async (principal, input) => {
    inputValue(VertexModulesListInputSchema, input);
    const ports = portsFor(dependencies);
    await authorize(() => ports.authorization.canListModules(principal));
    const stored = await fromPort(() => ports.read.listModules(principal));
    const decoded = await decodeArtifact(stored);
    return sourceValue(VertexModulesListOutputSchema, decoded.value);
  },
});
