import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchInternalAuthRequest: vi.fn(),
  getPortalSession: vi.fn(),
  headers: vi.fn<() => Promise<Headers>>(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("./server-internal-dispatch.ts", () => ({
  dispatchInternalAuthRequest: mocks.dispatchInternalAuthRequest,
}));
vi.mock("./server-session.ts", () => ({
  getPortalSession: mocks.getPortalSession,
}));

import {
  getRequestPortalSession,
  portalOperatorEmails,
} from "./request-portal-session.ts";

const COOKIE = "better-auth.session_token=opaque";
const EDGE_IP = "203.0.113.42";

describe("getRequestPortalSession", () => {
  let requestHeaders: Headers;
  beforeEach(() => {
    requestHeaders = new Headers();
    mocks.headers.mockReset();
    mocks.headers.mockImplementation(async () => requestHeaders);
    return mocks.getPortalSession.mockReset();
  });

  it("checks the session once per request across the vinext probe and render passes", async () => {
    const session = { userId: "u" };
    mocks.getPortalSession.mockResolvedValueOnce(session);

    // Probe pass, then render pass, plus a page in the render: one request headers object.
    const results = await Promise.all([
      getRequestPortalSession(COOKIE, EDGE_IP),
      getRequestPortalSession(COOKIE, EDGE_IP),
    ]);
    results.push(await getRequestPortalSession(COOKIE, EDGE_IP));

    expect(results).toEqual([session, session, session]);
    return expect(mocks.getPortalSession).toHaveBeenCalledOnce();
  });

  it("never shares a session check across requests", async () => {
    mocks.getPortalSession
      .mockResolvedValueOnce({ userId: "first" })
      .mockResolvedValueOnce({ userId: "second" });

    const first = await getRequestPortalSession(COOKIE, EDGE_IP);
    requestHeaders = new Headers();
    const second = await getRequestPortalSession(COOKIE, EDGE_IP);

    expect(first).toEqual({ userId: "first" });
    expect(second).toEqual({ userId: "second" });
    return expect(mocks.getPortalSession).toHaveBeenCalledTimes(2);
  });

  it("keys a request's checks by cookie and edge IP", async () => {
    mocks.getPortalSession.mockResolvedValue(null);

    await getRequestPortalSession(COOKIE, EDGE_IP);
    await getRequestPortalSession(COOKIE, null);
    await getRequestPortalSession(null, EDGE_IP);
    await getRequestPortalSession(COOKIE, EDGE_IP);

    return expect(mocks.getPortalSession).toHaveBeenCalledTimes(3);
  });

  it("keeps a failed check with its own request", async () => {
    const failure = new Error("dispatch failed");
    mocks.getPortalSession
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(null);

    await expect(getRequestPortalSession(COOKIE, EDGE_IP)).rejects.toBe(
      failure
    );
    await expect(getRequestPortalSession(COOKIE, EDGE_IP)).rejects.toBe(
      failure
    );
    requestHeaders = new Headers();
    await expect(getRequestPortalSession(COOKIE, EDGE_IP)).resolves.toBeNull();
    return expect(mocks.getPortalSession).toHaveBeenCalledTimes(2);
  });

  return it.each([
    [COOKIE, EDGE_IP],
    [null, null],
    ["   ", null],
  ])(
    "uses primitive cookie and edge IP inputs with the fixed internal dispatcher",
    async (cookieHeader, cfConnectingIp) => {
      mocks.getPortalSession.mockResolvedValueOnce(null);

      await expect(
        getRequestPortalSession(cookieHeader, cfConnectingIp)
      ).resolves.toBeNull();
      return expect(mocks.getPortalSession).toHaveBeenCalledWith({
        cookieHeader,
        cfConnectingIp,
        fetch: mocks.dispatchInternalAuthRequest,
        operatorEmails: [],
      });
    }
  );
});

describe("portalOperatorEmails", () =>
  it("reads VERTEX_OPERATOR_EMAILS and fails closed on an invalid list", () => {
    expect(
      portalOperatorEmails({ VERTEX_OPERATOR_EMAILS: " A@Example.test " })
    ).toEqual(["a@example.test"]);
    expect(portalOperatorEmails({})).toEqual([]);
    expect(
      portalOperatorEmails({ VERTEX_OPERATOR_EMAILS: "not-an-email" })
    ).toEqual([]);
    return expect(portalOperatorEmails()).toEqual(expect.any(Array));
  }));
