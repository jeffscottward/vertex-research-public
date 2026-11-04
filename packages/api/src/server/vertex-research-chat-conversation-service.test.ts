import {
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import { describe, expect, it } from "vitest";
import type { SafePrincipal } from "@darkfactory/auth/types";
import { canonicalArtifactJson } from "@darkfactory/shared/vertex";
import type { ApiContext } from "./context.ts";
import type { VertexExperienceDependencies } from "./vertex-experience-core.ts";
import {
  handleApiRequest,
  handleOpenApiRequest,
  researchChatResponse,
} from "./handler.ts";
import {
  appendResearchChatResponse,
  readResearchChatResponse,
  readResearchChatResponseContent,
  readResearchChatTranscriptPage,
} from "./vertex-research-chat.ts";
import {
  eligibleResponse,
  readSelector,
  answerText,
} from "./vertex-research-chat-conversation-runtime.test-support.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

// Only an already-authenticated principal value crosses this service boundary.
// These tests do not claim to qualify login, a live corpus, storage or a provider.
// All conversation/source/permission/publication/fence owners below are real;
// their underlying SQL, object and clock ports are the existing external doubles.
const principal: SafePrincipal = {
  userId: owner.actorId,
  role: "member",
  status: "active",
};
const dependencies = (
  f: Awaited<ReturnType<typeof eligibleResponse>>
): VertexExperienceDependencies => ({
  store: f.store,
  authorization: f.authorization,
  clock: f.clock,
});

// Owner-boundary cases build the full real-owner conversation fixture.
describe("public conversation service retains genuine owner boundaries", {
  timeout: scaledTimeout(120_000),
}, () => {
  const messagesTable = "vertex_research_chat_messages";
  const threadsTable = "vertex_research_chat_threads";
  it("GET status does not append, and explicit append alone exposes a bodyless reference", async () => {
    const f = await eligibleResponse(),
      deps = dependencies(f);
    const messages = canonicalArtifactJson(f.table(messagesTable));
    const threads = canonicalArtifactJson(f.table(threadsTable));
    const status = await readResearchChatResponse(
      deps,
      principal,
      readSelector(f),
      f.runtime.conversation
    );
    expect(status.job?.state).toBe("succeeded");
    expect(status.delivery.status).toBe("eligible");
    expect(canonicalArtifactJson(f.table(messagesTable))).toBe(messages);
    expect(canonicalArtifactJson(f.table(threadsTable))).toBe(threads);
    expect(canonicalArtifactJson(status)).not.toContain(answerText);

    const appended = await appendResearchChatResponse(
      deps,
      principal,
      { ...f.selector, expectedRevision: "2" },
      f.runtime.conversation
    );
    expect(appended.status).toBe("appended");
    if (appended.status !== "appended")
      throw new Error("Actual reference append absent");
    expect(appended.message.kind).toBe("advisory-reference");
    expect(Object.hasOwn(appended.message, "body")).toBe(false);
    expect(Object.hasOwn(appended.message, "citations")).toBe(false);
    expect(canonicalArtifactJson(appended)).not.toContain(answerText);
    const after = canonicalArtifactJson(f.table(messagesTable));
    const replay = await appendResearchChatResponse(
      deps,
      principal,
      { ...f.selector, expectedRevision: "999" },
      f.runtime.conversation
    );
    expect(replay).toEqual(appended);
    const visible = await readResearchChatResponse(
      deps,
      principal,
      readSelector(f),
      f.runtime.conversation
    );
    expect(visible.delivery.status).toBe("appended");
    expect(canonicalArtifactJson(f.table(messagesTable))).toBe(after);
    const transcript = await readResearchChatTranscriptPage(deps, principal, {
      ...scope,
      threadId: f.request.threadId,
      limit: 20,
      cursor: null,
    });
    expect(transcript.items.map((item) => item.sequence)).toEqual(["1", "2"]);
    expect(transcript.items[1]?.kind).toBe("advisory-reference");
    return expect(canonicalArtifactJson(transcript)).not.toContain(answerText);
  });

  return it("only the separate current content operation returns the exact actual governed profile", async () => {
    const f = await eligibleResponse(),
      deps = dependencies(f);
    const appended = await appendResearchChatResponse(
      deps,
      principal,
      { ...f.selector, expectedRevision: "2" },
      f.runtime.conversation
    );
    if (appended.status !== "appended")
      throw new Error("Actual reference append absent");
    const input = { ...f.selector, messageId: appended.message.messageId };
    const content = await readResearchChatResponseContent(
      deps,
      principal,
      input,
      f.runtime.conversation
    );
    expect(content.status).toBe("available");
    if (content.status !== "available")
      throw new Error("Actual governed content absent");
    expect(content.reference).toEqual(appended.message);
    expect(content.sha256).toBe(
      appended.message.response.advisoryArtifact.artifactSha256
    );
    expect(content.profile.output.claims[0]?.text).toBe(answerText);
    expect(content.profile.executionAuthorized).toBe(false);
    expect(Object.isFrozen(content)).toBe(true);
    await expect(
      readResearchChatResponseContent(
        deps,
        { ...principal, userId: "different-chat-owner" },
        input,
        f.runtime.conversation
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    return await expect(
      readResearchChatResponseContent(
        deps,
        { ...principal, status: "suspended" },
        input,
        f.runtime.conversation
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("private chat HTTP caching applies to both actual transports", () => {
  // Unknown procedures exercise transport-only errors; no fabricated body or
  // authenticated/eligible answer is used as a cache-policy authority fixture.
  const transports = [
    {
      name: "RPC",
      handler: handleApiRequest,
      path: "/api/orpc/vertex/researchChat/noSuchConversationOperation",
    },
    {
      name: "REST",
      handler: handleOpenApiRequest,
      path: "/api/openapi/vertex/research-chat/no-such-conversation-operation",
    },
  ] as const;
  for (const transport of transports)
    it(`${transport.name} private errors are noncacheable and vary on credentials`, async () => {
      const response = await transport.handler(
        new Request(`https://test.invalid${transport.path}`),
        {} as ApiContext
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store, max-age=0"
      );
      expect(response.headers.get("cdn-cache-control")).toBe("no-store");
      expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
        "no-store"
      );
      expect(response.headers.get("vary")).toBe("Cookie, Authorization");
      expect(response.headers.get("etag")).toBeNull();
      expect(response.headers.get("last-modified")).toBeNull();
      return expect(response.headers.get("referrer-policy")).toBe(
        "no-referrer"
      );
    });
  it("preserves stream, unrelated headers and cookie values while invalidating cache validators", async () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "X-Original": "preserved",
      Vary: "Accept-Encoding",
      ETag: "old-validator",
      "Last-Modified": "Thu, 24 Sep 2026 12:00:00 GMT",
    });
    headers.append("Set-Cookie", "fixture-one=one; Secure; HttpOnly");
    headers.append("Set-Cookie", "fixture-two=two; Secure; HttpOnly");
    const original = new Response(
      "transport-only fixture, not an authorized answer",
      { status: 200, headers }
    );
    const result = researchChatResponse(
      new Request(
        "https://test.invalid/api/openapi/vertex/research-chat/threads/thread/responses/response/content"
      ),
      original
    );
    expect(result.body).toBe(original.body);
    expect(result.headers.get("X-Original")).toBe("preserved");
    expect(result.headers.get("Content-Type")).toBe("application/json");
    expect(result.headers.get("Set-Cookie")).toBe(headers.get("Set-Cookie"));
    expect(result.headers.get("Vary")).toBe(
      "Accept-Encoding, Cookie, Authorization"
    );
    expect(result.headers.has("ETag")).toBe(false);
    expect(result.headers.has("Last-Modified")).toBe(false);
    expect(original.bodyUsed).toBe(false);
    return expect(await result.text()).toBe(
      "transport-only fixture, not an authorized answer"
    );
  });
  return it("covers canonical encoded chat aliases without changing unrelated response policy", () => {
    const privateResponse = researchChatResponse(
      new Request(
        "https://test.invalid/api/orpc/vertex/research%43hat/readResponseContent"
      ),
      new Response(null, { status: 204 })
    );
    expect(privateResponse.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0"
    );
    const publicResponse = new Response("unrelated", {
      headers: { "Cache-Control": "max-age=60" },
    });
    expect(
      researchChatResponse(
        new Request(
          "https://test.invalid/api/orpc/not-vertex/researchChat/readResponseContent"
        ),
        publicResponse
      )
    ).toBe(publicResponse);
    return expect(publicResponse.headers.get("Cache-Control")).toBe(
      "max-age=60"
    );
  });
});
