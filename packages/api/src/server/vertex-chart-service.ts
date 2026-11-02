import type { SafePrincipal } from "@darkfactory/auth/types";
import type {
  VertexArtifactMetadata,
  VertexPrincipal,
  VertexScope,
} from "@darkfactory/db/server/vertex";
import { timestampToEpochNanoseconds } from "@darkfactory/shared/vertex";
import { z } from "zod";
import {
  IdentifierSchema,
  TimestampSchema,
  VersionSchema,
} from "../contracts/vertex.ts";
import { VertexModulesListOutputSchema } from "../contracts/vertex-read.ts";
import {
  VertexScopedModulesInputSchema,
  type VertexScopedModulesInput,
} from "../contracts/vertex-chart-read.ts";
import { VertexReadServiceError } from "./vertex-service.ts";
import {
  authorizeVertex,
  failVertex,
  loadVertexArtifact,
  requireVertexScope,
  vertexArtifactMetadata,
  vertexInput,
  vertexNow,
  vertexOperation,
  vertexPorts,
  vertexSource,
  VertexExperienceServiceError,
  type VertexExperienceDependencies,
} from "./vertex-experience-core.ts";

export type VertexChartReadDependencies = VertexExperienceDependencies;
const ns = timestampToEpochNanoseconds;
const CurrentRightsSchema = z
  .object({
    policyId: IdentifierSchema,
    version: VersionSchema,
    status: z.enum(["granted", "denied", "expired", "unknown"]),
    allowedUses: z
      .array(z.enum(["store", "read", "derive", "export"]))
      .max(4)
      .refine((uses) => new Set(uses).size === uses.length),
    checkedAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
    retentionUntil: TimestampSchema.nullable(),
  })
  .strict();

// Preserve the established scoped read error/status contract, never leak port text.
const asRead = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof VertexReadServiceError) throw error;
    if (error instanceof VertexExperienceServiceError) {
      const code = error.code;
      if (
        code === "BAD_REQUEST" ||
        code === "UNAUTHORIZED" ||
        code === "FORBIDDEN" ||
        code === "NOT_FOUND" ||
        code === "INVALID_SOURCE" ||
        code === "SERVICE_UNAVAILABLE"
      )
        throw new VertexReadServiceError(code);
    }
    throw new VertexReadServiceError("SERVICE_UNAVAILABLE");
  }
};

const scopeOf = (input: VertexScopedModulesInput): VertexScope =>
  Object.freeze({
    accountAlias: input.accountAlias,
    environment: input.environment,
  });
const metadataFor = (
  value: VertexArtifactMetadata | null,
  collectionId: string | null
): VertexArtifactMetadata => {
  if (value === null) return failVertex("NOT_FOUND");
  const metadata = vertexArtifactMetadata(value);
  if (metadata.collectionId !== collectionId) return failVertex("FORBIDDEN");
  return metadata;
};

const finalRead = async (
  dependencies: VertexChartReadDependencies,
  actor: VertexPrincipal,
  scope: VertexScope,
  metadata: VertexArtifactMetadata,
  lookupId: string
) => {
  await authorizeVertex(
    dependencies,
    actor,
    scope,
    metadata.artifactId,
    "read",
    metadata.collectionId
  );
  await authorizeVertex(dependencies, actor, scope, "account-scope");
  await authorizeVertex(
    dependencies,
    actor,
    scope,
    lookupId,
    "read",
    metadata.collectionId
  );
  const result = await vertexOperation(dependencies, () =>
    vertexPorts(dependencies).store.getRights(
      actor,
      scope,
      metadata.collectionId,
      metadata.rights.policyId
    )
  );
  if (result === null) return failVertex("FORBIDDEN");
  const rights = vertexSource(CurrentRightsSchema, result);
  const now = vertexNow(dependencies);
  if (
    rights.policyId !== metadata.rights.policyId ||
    rights.status !== "granted" ||
    !rights.allowedUses.includes("read") ||
    rights.expiresAt === null
  )
    return failVertex("FORBIDDEN");
  if (ns(rights.checkedAt) > ns(now)) return failVertex("FORBIDDEN");
  for (const end of [rights.expiresAt, rights.retentionUntil]) {
    if (end === null) continue;
    vertexSource(TimestampSchema, end);
    if (ns(end) <= ns(now)) return failVertex("FORBIDDEN");
  }
};

export const createVertexChartReadService = (
  dependencies: VertexChartReadDependencies = {}
) => ({
  modules: (principal: SafePrincipal, raw: VertexScopedModulesInput) =>
    asRead(async () => {
      const input = vertexInput(VertexScopedModulesInputSchema, raw);
      const scope = scopeOf(input);
      const actor = await requireVertexScope(dependencies, principal, scope);
      await authorizeVertex(dependencies, actor, scope, "module-catalog");
      const metadata = metadataFor(
        await vertexOperation(dependencies, () =>
          vertexPorts(dependencies).store.findModuleCatalog(actor, scope)
        ),
        null
      );
      const artifact = await loadVertexArtifact(
        dependencies,
        actor,
        scope,
        metadata,
        VertexModulesListOutputSchema,
        "ModuleManifestList"
      );
      await finalRead(dependencies, actor, scope, metadata, "module-catalog");
      return artifact.value;
    }),
});
