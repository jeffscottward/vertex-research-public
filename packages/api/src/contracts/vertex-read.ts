import { oc } from "@orpc/contract";
import { z } from "zod";
import { ModuleManifestSchema, type ModuleManifest } from "./vertex.ts";

export const VERTEX_READ_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid Vertex read request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Vertex access denied" },
  NOT_FOUND: { status: 404, message: "Vertex artifact not found" },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "Vertex read service unavailable",
  },
  INVALID_SOURCE: { status: 502, message: "Vertex source artifact invalid" },
} as const;

export const VertexModulesListInputSchema = z.object({}).strict();
export const VertexModulesListOutputSchema: z.ZodType<
  readonly ModuleManifest[],
  readonly (z.input<typeof ModuleManifestSchema> | ModuleManifest)[]
> = z
  .array(ModuleManifestSchema)
  .max(256)
  .refine(
    (modules) =>
      new Set(modules.map((module) => module.moduleId)).size === modules.length,
    { message: "Duplicate module identity" }
  )
  .readonly();

const vertex = oc.errors(VERTEX_READ_ERRORS);

export const vertexReadContract = {
  modules: {
    list: vertex
      .route({
        method: "GET",
        path: "/vertex/modules",
        operationId: "vertex.modules.list",
        summary: "List authenticated read-only module manifests",
        tags: ["Vertex"],
      })
      .input(VertexModulesListInputSchema)
      .output(VertexModulesListOutputSchema),
  },
};

export type VertexModulesListInput = z.infer<
  typeof VertexModulesListInputSchema
>;
