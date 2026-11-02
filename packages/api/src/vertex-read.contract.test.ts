import type { InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  VERTEX_READ_ERRORS,
  VertexModulesListInputSchema,
  VertexModulesListOutputSchema,
  appContract,
} from "./contract.ts";
import type { ModuleManifest } from "./contracts/vertex.ts";
import type { VertexReadService } from "./server/vertex-service.ts";
import { buildOpenApiDocument } from "./openapi.ts";

const route = (procedure: unknown) => {
  return (
    procedure as {
      ["~orpc"]: {
        route: { method: string; path: string; operationId: string };
      };
    }
  )["~orpc"].route;
};

const routes = [
  {
    procedure: appContract.vertex.modules.list,
    path: "/vertex/modules",
    operationId: "vertex.modules.list",
  },
] as const;

describe("Vertex read contracts", () => {
  it("exposes only the module list read procedure and removes dead routes", () => {
    expect(Object.keys(appContract.vertex)).toEqual([
      "modules",
      "experience",
      "scoped",
      "notifications",
      "localSetup",
      "researchChat",
    ]);
    expect(Object.keys(appContract.vertex.modules)).toEqual(["list"]);
    expect("datasets" in appContract.vertex).toBe(false);
    expect("evidence" in appContract.vertex).toBe(false);
    expect(appContract.dashboard.summary).toBeDefined();
    expect(appContract.featureItems.create).toBeDefined();
    expect(appContract.account.profile.get).toBeDefined();
    expect(appContract.contact.submit).toBeDefined();
    return expectTypeOf<
      z.output<typeof VertexModulesListOutputSchema>
    >().toEqualTypeOf<readonly ModuleManifest[]>();
  });

  it("accepts deep-frozen service outputs without widening validated outputs or replacing schemas", () => {
    type ModulesSchema = NonNullable<
      (typeof appContract.vertex.modules.list)["~orpc"]["outputSchema"]
    >;
    expectTypeOf<
      Awaited<ReturnType<VertexReadService["listModules"]>>
    >().toExtend<InferSchemaInput<ModulesSchema>>();
    expectTypeOf<InferSchemaOutput<ModulesSchema>>().toEqualTypeOf<
      readonly ModuleManifest[]
    >();
    expectTypeOf<readonly { moduleId: string }[]>().not.toExtend<
      InferSchemaInput<ModulesSchema>
    >();
    return expect(appContract.vertex.modules.list["~orpc"].outputSchema).toBe(
      VertexModulesListOutputSchema
    );
  });

  it.each(routes)(
    "declares GET $operationId",
    ({ procedure, path, operationId }) =>
      expect(route(procedure)).toMatchObject({
        method: "GET",
        path,
        operationId,
      })
  );

  it("keeps denied, not-found, unavailable and invalid-source errors distinct and sanitized", () =>
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
    }));

  it("accepts only an actually empty list input", () => {
    expect(VertexModulesListInputSchema.parse({})).toEqual({});
    for (const value of [
      undefined,
      null,
      [],
      "",
      { principal: { userId: "admin" } },
      { ownerId: "other" },
      { limit: 100 },
      { datasetId: "dataset-1" },
      { collectionId: "collection-1", evidenceId: "evidence-1" },
    ]) {
      expect(VertexModulesListInputSchema.safeParse(value).success).toBe(false);
    }
  });

  it("publishes read-only operations and all explicit failure statuses in OpenAPI", async () => {
    const document = await buildOpenApiDocument();

    for (const { path, operationId } of routes) {
      const item = document.paths?.[path];
      expect(item?.get?.operationId).toBe(operationId);
      expect(Object.keys(item?.get?.responses ?? {})).toEqual(
        expect.arrayContaining([
          "200",
          "400",
          "401",
          "403",
          "404",
          "502",
          "503",
        ])
      );
      expect(item?.post).toBeUndefined();
      expect(item?.put).toBeUndefined();
      expect(item?.patch).toBeUndefined();
      expect(item?.delete).toBeUndefined();
    }
  });

  it("does not erase immutable artifact output shapes to any in OpenAPI", async () => {
    const document = await buildOpenApiDocument();
    const modulesResponse =
      document.paths?.["/vertex/modules"]?.get?.responses?.["200"];
    expect(document.paths?.["/vertex/datasets/{datasetId}"]).toBeUndefined();
    expect(
      document.paths?.[
        "/vertex/collections/{collectionId}/evidence/{evidenceId}"
      ]
    ).toBeUndefined();
    return expect(modulesResponse).toMatchObject({
      content: {
        "application/json": {
          schema: {
            type: "array",
            maxItems: 256,
            items: {
              type: "object",
              required: expect.arrayContaining([
                "moduleId",
                "lifecycleState",
                "artifactDigest",
              ]),
            },
          },
        },
      },
    });
  });
});
