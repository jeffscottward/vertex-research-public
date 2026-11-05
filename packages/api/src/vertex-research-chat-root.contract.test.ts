import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { appContract } from "./contract.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import {
  vertexResearchChatContract,
  VertexResearchChatErrors,
} from "./contracts/vertex-research-chat.ts";
import { vertexResearchChatResponseContract } from "./contracts/vertex-research-chat-response-rpc.ts";
import { vertexResearchChatCopyCleanupContract } from "./contracts/vertex-research-chat-copy-cleanup-rpc.ts";
import { scaledTimeout } from "../../../scripts/lib/test-timeout-scale.ts";

// A full in-memory Vite browser build. Measured 2026-11-02 on dev-rig: 1.6-4.2 s
// unthrottled or pinned to one or two CPUs; under a 50% CPU quota completed builds took
// up to 27.9 s, and the 5 s default timed out under high rig load. 60 s keeps about a
// 2x margin over that worst case.
const BROWSER_BUNDLE_BUILD_TIMEOUT_MS = scaledTimeout(60_000);

const composedChatContract = {
  ...vertexResearchChatContract,
  ...vertexResearchChatResponseContract,
  ...vertexResearchChatCopyCleanupContract,
};

const operations = {
  roster: ["GET", "/vertex/research-chat/roster"],
  listThreads: ["GET", "/vertex/research-chat/threads"],
  createThread: ["POST", "/vertex/research-chat/threads"],
  readThread: ["GET", "/vertex/research-chat/threads/{threadId}"],
  listMessages: ["GET", "/vertex/research-chat/threads/{threadId}/messages"],
  readTranscriptPage: ["GET", "/vertex/research-chat/transcript"],
  sendMessage: ["POST", "/vertex/research-chat/threads/{threadId}/messages"],
  requestResponse: [
    "POST",
    "/vertex/research-chat/threads/{threadId}/responses",
  ],
  readResponse: ["GET", "/vertex/research-chat/threads/{threadId}/responses"],
  prepareResponse: [
    "POST",
    "/vertex/research-chat/threads/{threadId}/responses/prepare",
  ],
  approveAndRequestResponse: [
    "POST",
    "/vertex/research-chat/responses/approve-and-request",
  ],
  appendResponse: [
    "POST",
    "/vertex/research-chat/threads/{threadId}/responses/{responseRequestId}/append",
  ],
  readResponseContent: [
    "GET",
    "/vertex/research-chat/threads/{threadId}/responses/{responseRequestId}/content",
  ],
  prepareDebateStep: ["POST", "/vertex/research-chat/debate/prepare"],
  approveAndRequestDebateStep: [
    "POST",
    "/vertex/research-chat/debate/approve-and-request",
  ],
  readDebateRun: ["GET", "/vertex/research-chat/debate"],
  prepareNativeEvidence: [
    "POST",
    "/vertex/research-chat/native-evidence/prepare",
  ],
  approveAndRequestNativeEvidence: [
    "POST",
    "/vertex/research-chat/native-evidence/approve-and-request",
  ],
  readNativeModelPrivacyReviewRequest: [
    "POST",
    "/vertex/research-chat/native-evidence/model-privacy/read",
  ],
  recordNativeModelPrivacyReview: [
    "POST",
    "/vertex/research-chat/native-evidence/model-privacy/record",
  ],
  readModelPrivacyReviewRequest: [
    "POST",
    "/vertex/research-chat/model-privacy/read",
  ],
  recordModelPrivacyReview: [
    "POST",
    "/vertex/research-chat/model-privacy/record",
  ],
  requestCopyCleanup: [
    "POST",
    "/vertex/research-chat/threads/{threadId}/copy-cleanup",
  ],
  readCopyCleanup: [
    "GET",
    "/vertex/research-chat/threads/{threadId}/copy-cleanup",
  ],
} as const;

describe("root research-chat contract integration", () => {
  it("registers the exact research chat contracts without cloning wire validators", () => {
    for (const key of Object.keys(
      vertexResearchChatContract
    ) as (keyof typeof vertexResearchChatContract)[]) {
      expect(appContract.vertex.researchChat[key]).toBe(
        vertexResearchChatContract[key]
      );
    }
    expect(Object.keys(appContract.vertex.researchChat).sort()).toEqual(
      Object.keys(operations).sort()
    );

    for (const key of Object.keys(operations) as (keyof typeof operations)[]) {
      const definition = appContract.vertex.researchChat[key]["~orpc"];
      expect(definition.route).toMatchObject({
        method: operations[key][0],
        path: operations[key][1],
        operationId: `vertex.researchChat.${key}`,
      });
      expect(definition.errorMap).toEqual(VertexResearchChatErrors);
      expect(definition.inputSchema).toBe(
        composedChatContract[key]["~orpc"].inputSchema
      );
      expect(definition.outputSchema).toBe(
        composedChatContract[key]["~orpc"].outputSchema
      );
    }
  });

  it("documents only the declared GET/POST operations through the existing OpenAPI owner", async () => {
    const document = await buildOpenApiDocument();
    for (const key of Object.keys(operations) as (keyof typeof operations)[]) {
      const [method, path] = operations[key];
      const endpoint =
        document.paths?.[path]?.[method === "GET" ? "get" : "post"];
      expect(endpoint?.operationId).toBe(`vertex.researchChat.${key}`);
      expect(Object.keys(endpoint?.responses ?? {})).toEqual(
        expect.arrayContaining([
          "200",
          "400",
          "401",
          "403",
          "404",
          "409",
          "502",
          "503",
        ])
      );
    }
    const chatPaths = Object.keys(document.paths ?? {}).filter((path) =>
      path.startsWith("/vertex/research-chat")
    );
    expect(new Set(chatPaths)).toEqual(
      new Set(Object.values(operations).map((entry) => entry[1]))
    );

    for (const path of chatPaths) {
      for (const method of ["delete", "put", "patch"] as const) {
        expect(document.paths?.[path]?.[method]).toBeUndefined();
      }
    }
  });

  it(
    "keeps the chat contract browser bundle free of server, database and model runtime imports",
    async () => {
      const modules: string[] = [];
      const result = await build({
        configFile: false,
        envDir: false,
        logLevel: "silent",
        plugins: [
          {
            name: "capture-research-chat-boundary",
            generateBundle() {
              modules.push(...this.getModuleIds());
              return;
            },
          },
        ],
        resolve: { conditions: ["browser"] },
        build: {
          target: "esnext",
          write: false,
          minify: false,
          lib: {
            entry: fileURLToPath(new URL("./contract.ts", import.meta.url)),
            formats: ["es"],
            fileName: "research-chat-contract",
          },
        },
      });
      const builds = Array.isArray(result) ? result : [result];
      const chunks = builds.flatMap((entry) => {
        if (!("output" in entry))
          throw new Error("Expected an in-memory browser contract bundle");
        return entry.output.filter((output) => output.type === "chunk");
      });
      expect(
        modules.filter((id) => id.includes("vertex-research-chat"))
      ).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /\/contracts\/vertex-research-chat\.ts(?:\?.*)?$/
          ),
        ])
      );
      expect(
        modules.filter((id) =>
          /\/packages\/(?:db|jobs)\/|\/packages\/api\/src\/server\/|@darkfactory\/(?:db|jobs)(?:\/|$)|@copilotkit\/runtime(?:\/|$)|\/agno\//i.test(
            id
          )
        )
      ).toEqual([]);
      expect(chunks.map((chunk) => chunk.code).join("\n")).not.toContain(
        "createVertexStore"
      );
      return expect(chunks.map((chunk) => chunk.code).join("\n")).not.toContain(
        "createCopilotRuntimeHandler"
      );
    },
    BROWSER_BUNDLE_BUILD_TIMEOUT_MS
  );
});
