import type { InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as entrypoint from "./vertex-chart-read.ts";
import {
  VertexModulesListOutputSchema,
  VertexScopedModulesInputSchema,
  vertexChartReadContract,
  type VertexScopedModulesInput,
} from "./vertex-chart-read.ts";
import { VERTEX_READ_ERRORS } from "./contracts/vertex-read.ts";
import type { ModuleManifest } from "./contracts/vertex.ts";
import type { createVertexChartReadService } from "./server/vertex-chart-service.ts";

const scope = {
  accountAlias: "fixture-account",
  environment: "research",
} as const;

describe("explicitly scoped Vertex module catalog contract", () => {
  it("requires explicit strict account and environment", () => {
    const schema = VertexScopedModulesInputSchema;
    expect(schema.parse(scope)).toEqual(scope);
    for (const key of ["accountAlias", "environment"]) {
      const missing: Record<string, unknown> = { ...scope };
      delete missing[key];
      expect(schema.safeParse(missing).success).toBe(false);
    }
    for (const extra of [
      { userId: "other" },
      { principal: { role: "admin" } },
      { ownerId: "other" },
      { includePrivate: true },
      { executionAuthorized: true },
      { scope },
      { collectionId: null },
      { datasetId: "fixture-dataset" },
    ]) {
      expect(schema.safeParse({ ...scope, ...extra }).success).toBe(false);
    }
    for (const accountAlias of [
      "",
      " ",
      "../other",
      "a/b",
      "a%2Fb",
      "a".repeat(161),
      "a\u0000",
    ]) {
      expect(schema.safeParse({ ...scope, accountAlias }).success).toBe(false);
    }
    expect(
      schema.safeParse({ ...scope, environment: "production" }).success
    ).toBe(false);
    for (const environment of ["research", "paper", "live"]) {
      expect(schema.safeParse({ ...scope, environment }).success).toBe(true);
    }
  });

  it("exposes only the scoped module catalog procedure on the pure entrypoint", () => {
    expect(Object.keys(vertexChartReadContract)).toEqual(["modules"]);
    expect(Object.keys(entrypoint).sort()).toEqual([
      "VertexModulesListOutputSchema",
      "VertexScopedModulesInputSchema",
      "vertexChartReadContract",
    ]);
  });

  it("keeps established error statuses on the GET-only /vertex/scoped/modules route", () => {
    expect(VERTEX_READ_ERRORS).toEqual({
      BAD_REQUEST: { status: 400, message: "Invalid Vertex read request" },
      UNAUTHORIZED: { status: 401, message: "Authentication required" },
      FORBIDDEN: { status: 403, message: "Vertex access denied" },
      NOT_FOUND: { status: 404, message: "Vertex artifact not found" },
      SERVICE_UNAVAILABLE: {
        status: 503,
        message: "Vertex read service unavailable",
      },
      INVALID_SOURCE: {
        status: 502,
        message: "Vertex source artifact invalid",
      },
    });
    const procedure = vertexChartReadContract.modules["~orpc"];
    expect(procedure.route).toEqual({
      method: "GET",
      path: "/vertex/scoped/modules",
      operationId: "vertex.scoped.modules",
      tags: ["Vertex"],
      summary: "Read an explicitly scoped authorized module catalog",
    });
    expect(procedure.errorMap).toEqual(VERTEX_READ_ERRORS);
    expect(procedure.inputSchema).toBe(VertexScopedModulesInputSchema);
    expect(procedure.outputSchema).toBe(VertexModulesListOutputSchema);

    type InputSchema = NonNullable<
      (typeof vertexChartReadContract.modules)["~orpc"]["inputSchema"]
    >;
    type OutputSchema = NonNullable<
      (typeof vertexChartReadContract.modules)["~orpc"]["outputSchema"]
    >;
    type Service = ReturnType<typeof createVertexChartReadService>;
    expectTypeOf<
      InferSchemaOutput<InputSchema>
    >().toEqualTypeOf<VertexScopedModulesInput>();
    expectTypeOf<Parameters<Service["modules"]>[1]>().toEqualTypeOf<
      InferSchemaOutput<InputSchema>
    >();
    expectTypeOf<Awaited<ReturnType<Service["modules"]>>>().toExtend<
      InferSchemaInput<OutputSchema>
    >();
    return expectTypeOf<InferSchemaOutput<OutputSchema>>().toEqualTypeOf<
      readonly ModuleManifest[]
    >();
  });
});
