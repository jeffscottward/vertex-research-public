import type { SemanticEvent } from "@darkfactory/observability/port";
import { describe, expect, it, vi } from "vitest";

import { guardAgentViewerAuth } from "./agent-viewer-auth.ts";

// Fictional identities only. The fake password never leaves this test.
const VIEWER = "agent-viewer@domain.test";
const base = "https://darkfactory.localhost/api/auth";

const setup = (
  path: string,
  sessionEmail: string | null,
  options: Readonly<{
    cookie?: boolean;
    body?: unknown;
    viewers?: readonly string[];
    status?: number;
    sinkFails?: boolean;
  }> = {}
) => {
  const events: SemanticEvent[] = [];
  const run = vi.fn(
    async () => new Response("handled", { status: options.status ?? 200 })
  );
  const headers = new Headers({ "content-type": "application/json" });
  if (options.cookie !== false) headers.set("cookie", "session=x");
  const request = new Request(`${base}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers,
    ...(options.body === undefined
      ? {}
      : {
          body:
            typeof options.body === "string"
              ? options.body
              : JSON.stringify(options.body),
        }),
  });
  const sessionLookup = vi.fn(async () => sessionEmail);
  const response = guardAgentViewerAuth({
    request,
    viewerEmails: options.viewers ?? [VIEWER.toUpperCase()],
    sessionEmail: sessionLookup,
    sink: {
      emit: (event) => {
        if (options.sinkFails) throw new Error("sink down");
        events.push(event);
      },
    },
    requestId: "request-1",
    run,
  });
  return { response, run, events, sessionLookup };
};

describe("agent viewer on Better Auth routes", () => {
  it.each([
    "/change-password",
    "/change-email",
    "/update-user",
    "/delete-user",
    "/api-key/create",
    "/two-factor/enable",
  ])("refuses %s for a viewer session with 403", async (path) => {
    const { response, run } = setup(path, VIEWER, { body: {} });
    const result = await response;
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({
      error: "Agent viewer access is read-only",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("allows get-session and sign-out; other users and anonymous requests are untouched", async () => {
    expect((await setup("/get-session", VIEWER).response).status).toBe(200);
    expect(
      (await setup("/sign-out", VIEWER, { body: {} }).response).status
    ).toBe(200);
    expect(
      (
        await setup("/change-password", "member@domain.test", { body: {} })
          .response
      ).status
    ).toBe(200);
    const anonymous = setup("/change-password", null, {
      body: {},
      cookie: false,
    });
    expect((await anonymous.response).status).toBe(200);
    // A viewer session sent without a cookie header (other transport) is still refused.
    expect(
      (
        await setup("/change-password", VIEWER, { body: {}, cookie: false })
          .response
      ).status
    ).toBe(403);
    const noList = setup("/change-password", VIEWER, {
      body: {},
      viewers: [],
    });
    expect((await noList.response).status).toBe(200);
    expect(noList.sessionLookup).not.toHaveBeenCalled();
  });

  it("audits every viewer sign-in (success and failure) without the password", async () => {
    const ok = setup("/sign-in/email", null, {
      body: { email: ` ${VIEWER} `, password: "fictional-password" },
    });
    expect((await ok.response).status).toBe(200);
    expect(ok.events).toEqual([
      {
        eventId: expect.any(String),
        name: "vertex.agent-viewer.sign-in",
        occurredAt: expect.any(String),
        correlation: {
          requestId: "request-1",
          route: "/api/auth/sign-in/email",
        },
        action: "sign-in",
        entityType: "agent-viewer",
        outcome: "success",
        source: "web",
        attributes: { email: VIEWER, status: 200 },
      },
    ]);
    expect(JSON.stringify(ok.events)).not.toContain("fictional-password");
    const failed = setup("/sign-in/email", null, {
      body: { email: VIEWER, password: "x" },
      status: 401,
    });
    await failed.response;
    expect(failed.events[0]).toMatchObject({
      outcome: "failure",
      attributes: { status: 401 },
    });
    // A sink failure never blocks the sign-in.
    const sinkDown = setup("/sign-in/email", null, {
      body: { email: VIEWER, password: "x" },
      sinkFails: true,
    });
    expect((await sinkDown.response).status).toBe(200);
  });

  it("does not audit other users or unreadable bodies", async () => {
    for (const body of [
      { email: "member@domain.test", password: "x" },
      { email: 42 },
      "not json",
    ]) {
      const other = setup("/sign-in/email", null, { body });
      expect((await other.response).status).toBe(200);
      expect(other.events).toEqual([]);
    }
  });
});
