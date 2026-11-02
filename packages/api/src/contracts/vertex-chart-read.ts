import { oc } from "@orpc/contract";
import type { z } from "zod";
import { VertexPortfolioGetInputSchema } from "./vertex-control.ts";
import {
  VERTEX_READ_ERRORS,
  VertexModulesListOutputSchema,
} from "./vertex-read.ts";

// Additive scope-bearing reads. A requested account is not a grant.
export const VertexScopedModulesInputSchema = VertexPortfolioGetInputSchema;
export type VertexScopedModulesInput = z.infer<
  typeof VertexScopedModulesInputSchema
>;

const read = oc.errors(VERTEX_READ_ERRORS);
export const vertexChartReadContract = {
  modules: read
    .route({
      method: "GET",
      path: "/vertex/scoped/modules",
      operationId: "vertex.scoped.modules",
      tags: ["Vertex"],
      summary: "Read an explicitly scoped authorized module catalog",
    })
    .input(VertexScopedModulesInputSchema)
    .output(VertexModulesListOutputSchema),
};
