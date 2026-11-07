import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPortalSession,
  type PortalSessionFetch,
  PortalSessionUnavailableError,
  parsePortalSession,
  portalSignInHref,
  resolvePortalAppUrl,
  resolvePortalCallbackPath,
  safePortalCallbackPath,
} from "./server-session.ts";

const activeSession = {
  session: {
    expiresAt: "2030-01-01T00:00:00.000Z",
  },
  user: {
    id: "user-1",
    name: "Example Member",
    role: "member",
    status: "active",
  },
};
// Failed session checks write one stderr line; keep test output quiet and inspectable.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolvePortalAppUrl", () => {
  it("uses one validated HTTPS application origin", () => {
    expect(resolvePortalAppUrl("https://portal.example.test").href).toBe(
      "https://portal.example.test/"
    );
    expect(() => resolvePortalAppUrl("http://portal.example.test")).toThrow(
      "Portal application URL must be a clean HTTPS origin"
    );
    return expect(() =>
      resolvePortalAppUrl("https://user:secret@portal.example.test")
    ).toThrow("Portal application URL must be a clean HTTPS origin");
  });

  return it("accepts a portless plain-HTTP localhost origin only in development", () => {
    expect(
      resolvePortalAppUrl("http://vertex.localhost", "development").href
    ).toBe("http://vertex.localhost/");
    for (const environment of ["production", "test", ""]) {
      expect(() =>
        resolvePortalAppUrl("http://vertex.localhost", environment)
      ).toThrow("Portal application URL must be a clean HTTPS origin");
    }
    for (const configured of [
      "http://vertex.localhost:3450",
      "http://portal.example.test",
    ]) {
      expect(() => resolvePortalAppUrl(configured, "development")).toThrow(
        "Portal application URL must be a clean HTTPS origin"
      );
    }
  });
});

describe("parsePortalSession", () => {
  it("accepts only an active Better Auth session with a known role", () =>
    expect(
      parsePortalSession(activeSession, new Date("2029-01-01T00:00:00.000Z"))
    ).toEqual({
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      isOperator: false,
      name: "Example Member",
      role: "member",
      status: "active",
      userId: "user-1",
    }));

  it("marks only an active, verified, listed email as operator", () => {
    const now = new Date("2029-01-01T00:00:00.000Z");
    const listed = {
      ...activeSession,
      user: {
        ...activeSession.user,
        email: "Member@Example.test",
        emailVerified: true,
      },
    };
    const operators = ["member@example.test"];
    expect(parsePortalSession(listed, now, operators)?.isOperator).toBe(true);
    expect(parsePortalSession(listed, now)?.isOperator).toBe(false);
    expect(
      parsePortalSession(
        { ...listed, user: { ...listed.user, emailVerified: false } },
        now,
        operators
      )?.isOperator
    ).toBe(false);
    return expect(
      parsePortalSession(
        { ...listed, user: { ...listed.user, email: 42 } },
        now,
        operators
      )?.isOperator
    ).toBe(false);
  });

  return it.each([
    null,
    {},
    { ...activeSession, user: { ...activeSession.user, role: "owner" } },
    { ...activeSession, user: { ...activeSession.user, status: "suspended" } },
    {
      ...activeSession,
      user: { ...activeSession.user, status: "deactivated" },
    },
    { ...activeSession, session: { expiresAt: "not-a-date" } },
    { ...activeSession, session: { expiresAt: "2028-01-01T00:00:00.000Z" } },
  ])("rejects malformed, inactive, or expired session data", (value) =>
    expect(
      parsePortalSession(value, new Date("2029-01-01T00:00:00.000Z"))
    ).toBeNull()
  );
});

describe("portal callback paths", () => {
  it("preserves a safe relative portal path and encodes it for sign in", () => {
    const headers = new Headers({
      "x-pathname": "/library/item-1?mode=edit",
    });
    expect(resolvePortalCallbackPath(headers)).toBe(
      "/library/item-1?mode=edit"
    );
    return expect(portalSignInHref(headers)).toBe(
      "/sign-in?callbackURL=%2Flibrary%2Fitem-1%3Fmode%3Dedit"
    );
  });

  it("keeps an Academy lesson path as the sign-in callback", () =>
    expect(
      portalSignInHref(
        new Headers({ "x-pathname": "/academy/itm-cash-secured-put" })
      )
    ).toBe("/sign-in?callbackURL=%2Facademy%2Fitm-cash-secured-put"));

  return it.each([
    "https://attacker.invalid/steal",
    "//attacker.invalid/steal",
    "/sign-in",
    "/features",
    "/library/../../sign-in",
    "\\attacker.invalid\\steal",
  ])("falls back when the request path is unsafe", (pathname) =>
    expect(
      resolvePortalCallbackPath(new Headers({ "x-pathname": pathname }))
    ).toBe("/dashboard")
  );
});

describe("getPortalSession", () => {
  it("forwards only the request cookie and trusted edge IP before validating the response", async () => {
    vi.stubEnv("APP_URL", "https://darkfactory.localhost");
    const fetchSession = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        "https://darkfactory.localhost/api/auth/get-session"
      );
      expect(request.headers.get("cookie")).toBe(
        "better-auth.session_token=opaque"
      );
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.headers.get("cf-connecting-ip")).toBe("203.0.113.42");
      expect([...request.headers.keys()]).toEqual([
        "accept",
        "cf-connecting-ip",
        "cookie",
      ]);
      return Response.json(activeSession);
    });

    await expect(
      getPortalSession({
        cfConnectingIp: "203.0.113.42",
        cookieHeader: "better-auth.session_token=opaque",
        fetch: fetchSession,
        now: new Date("2029-01-01T00:00:00.000Z"),
      })
    ).resolves.toMatchObject({
      isOperator: false,
      role: "member",
      userId: "user-1",
    });

    return expect(fetchSession).toHaveBeenCalledOnce();
  });

  it("passes the operator list through to the parsed session", async () =>
    await expect(
      getPortalSession({
        cookieHeader: "better-auth.session_token=opaque",
        fetch: vi.fn(async () =>
          Response.json({
            ...activeSession,
            user: {
              ...activeSession.user,
              email: "member@example.test",
              emailVerified: true,
            },
          })
        ),
        now: new Date("2029-01-01T00:00:00.000Z"),
        operatorEmails: ["member@example.test"],
      })
    ).resolves.toMatchObject({ isOperator: true }));

  it.each([
    new Response(null, { status: 401 }),
    Response.json({ unexpected: true }),
  ])(
    "fails closed for missing or invalid session responses",
    async (response) =>
      await expect(
        getPortalSession({
          cookieHeader: "better-auth.session_token=opaque",
          fetch: vi.fn(async () => response),
          now: new Date("2029-01-01T00:00:00.000Z"),
        })
      ).resolves.toBeNull()
  );

  it("fails closed when the session endpoint cannot be reached", async () =>
    await expect(
      getPortalSession({
        cookieHeader: "better-auth.session_token=opaque",
        fetch: vi.fn(async () => {
          throw new Error("connection details must stay private");
        }),
        now: new Date("2029-01-01T00:00:00.000Z"),
      })
    ).resolves.toBeNull());

  it("bounds a streaming response even when content-length is absent", async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10_000));
        return controller.enqueue(new Uint8Array(10_000));
      },
    });
    return await expect(
      getPortalSession({
        cookieHeader: "better-auth.session_token=opaque",
        fetch: vi.fn(async () => new Response(oversized)),
        now: new Date("2029-01-01T00:00:00.000Z"),
      })
    ).resolves.toBeNull();
  });

  it("cancels a stalled response body at the same deadline", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        return controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    return await expect(
      getPortalSession({
        cookieHeader: "better-auth.session_token=opaque",
        fetch: vi.fn(async () => new Response(stalled)),
        now: new Date("2029-01-01T00:00:00.000Z"),
        timeoutMs: 5,
      })
    ).resolves.toBeNull();
  });

  it("aborts a hanging session request within the configured deadline", async () => {
    const fetchSession = vi.fn(
      (request: Request) =>
        new Promise<Response>((resolve) => {
          request.signal.addEventListener("abort", () =>
            resolve(new Response(null, { status: 504 }))
          );
          return;
        })
    );
    await expect(
      getPortalSession({
        cookieHeader: "better-auth.session_token=opaque",
        fetch: fetchSession,
        now: new Date("2029-01-01T00:00:00.000Z"),
        timeoutMs: 5,
      })
    ).resolves.toBeNull();
    return expect(fetchSession.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it("accepts the canonical fallback and rejects every non-origin URL shape", () => {
    expect(resolvePortalAppUrl("").protocol).toBe("https:");
    for (const configured of [
      "https://portal.example.test/path",
      "https://portal.example.test?query=1",
      "https://portal.example.test#fragment",
      "not a URL",
    ]) {
      expect(() => resolvePortalAppUrl(configured)).toThrow(
        "Portal application URL must be a clean HTTPS origin"
      );
    }
  });

  it("accepts Date expirations and trims bounded administrator names", () => {
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");
    return expect(
      parsePortalSession(
        {
          session: { expiresAt },
          user: {
            id: "admin-1",
            name: "  Example Admin  ",
            role: "admin",
            status: "active",
          },
        },
        new Date("2029-01-01T00:00:00.000Z")
      )
    ).toEqual({
      expiresAt,
      isOperator: false,
      name: "Example Admin",
      role: "admin",
      status: "active",
      userId: "admin-1",
    });
  });

  it.each([
    [],
    { ...activeSession, user: [] },
    { ...activeSession, session: [] },
    { ...activeSession, user: { ...activeSession.user, id: "" } },
    {
      ...activeSession,
      user: { ...activeSession.user, id: "x".repeat(257) },
    },
    { ...activeSession, user: { ...activeSession.user, name: " " } },
    {
      ...activeSession,
      user: { ...activeSession.user, name: "x".repeat(201) },
    },
    { ...activeSession, session: { expiresAt: 123 } },
    { ...activeSession, session: { expiresAt: new Date(Number.NaN) } },
    {
      ...activeSession,
      session: { expiresAt: "2029-01-01T00:00:00.000Z" },
    },
  ])("rejects malformed session field boundaries", (value) =>
    expect(
      parsePortalSession(value, new Date("2029-01-01T00:00:00.000Z"))
    ).toBeNull()
  );

  it("validates callback values directly and selects the first safe request header", () => {
    for (const value of [
      null,
      "",
      "dashboard",
      "//attacker.invalid/path",
      "/dashboard#fragment",
      "/dashboard\\nested",
      "/dashboard\u0000",
      `/${"x".repeat(2048)}`,
    ]) {
      expect(safePortalCallbackPath(value)).toBeNull();
    }
    expect(safePortalCallbackPath("/admin/users?cursor=next")).toBe(
      "/admin/users?cursor=next"
    );
    expect(safePortalCallbackPath("/settings/account/security")).toBe(
      "/settings/account/security"
    );
    expect(safePortalCallbackPath("/settings-archive")).toBeNull();
    expect(
      safePortalCallbackPath("/operator/runs/run-1?view=timeline")
    ).toBeNull();

    const fallbackHeaders = new Headers({
      "next-url": "/dashboard",
      "x-invoke-path": "/account/security?tab=sessions",
      "x-pathname": "/public",
    });
    expect(resolvePortalCallbackPath(fallbackHeaders)).toBe(
      "/account/security?tab=sessions"
    );
    fallbackHeaders.set("x-pathname", "/admin/users");
    return expect(resolvePortalCallbackPath(fallbackHeaders)).toBe(
      "/admin/users"
    );
  });

  it("does not call the session endpoint without a usable cookie", async () => {
    const fetchSession = vi.fn(async () => Response.json(activeSession));

    await expect(
      getPortalSession({
        cookieHeader: null,
        fetch: fetchSession,
      })
    ).resolves.toBeNull();
    await expect(
      getPortalSession({
        cookieHeader: "   ",
        fetch: fetchSession,
      })
    ).resolves.toBeNull();
    return expect(fetchSession).not.toHaveBeenCalled();
  });

  it("fails closed for bodyless, empty, malformed, and declared-oversized responses", async () => {
    const responses = [
      () => new Response(null),
      () =>
        new Response(null, {
          headers: { "content-length": "16385" },
        }),
      () => new Response(""),
      () => new Response("{"),
      () =>
        new Response(JSON.stringify(activeSession), {
          headers: { "content-length": "16385" },
        }),
    ];

    for (const response of responses) {
      await expect(
        getPortalSession({
          cookieHeader: "better-auth.session_token=opaque",
          fetch: vi.fn(async () => response()),
          now: new Date("2029-01-01T00:00:00.000Z"),
        })
      ).resolves.toBeNull();
    }
  });

  it("clamps finite deadlines and uses the default for non-finite input", async () => {
    for (const timeoutMs of [-10, 20_000, Number.NaN]) {
      await expect(
        getPortalSession({
          cookieHeader: "better-auth.session_token=opaque",
          fetch: vi.fn(
            async () =>
              new Response(JSON.stringify(activeSession), {
                headers: { "content-length": "not-declared" },
              })
          ),
          now: new Date("2029-01-01T00:00:00.000Z"),
          timeoutMs,
        })
      ).resolves.toMatchObject({
        role: "member",
        userId: "user-1",
      });
    }
  });

  it("uses the global session transport when no fetch override is supplied", async () => {
    const fetchSession = vi.fn(async () => Response.json(activeSession));
    vi.stubGlobal("fetch", fetchSession);
    try {
      await expect(
        getPortalSession({
          cookieHeader: "better-auth.session_token=opaque",
          now: new Date("2029-01-01T00:00:00.000Z"),
        })
      ).resolves.toMatchObject({ role: "member", userId: "user-1" });
      return expect(fetchSession).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels a response body that arrives only after the session deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    try {
      const pending = getPortalSession({
        cookieHeader: "better-auth.session_token=opaque",
        fetch: (request) =>
          new Promise<Response>((resolve) => {
            request.signal.addEventListener(
              "abort",
              () =>
                void resolve(
                  new Response(new ReadableStream<Uint8Array>({ cancel }))
                ),
              { once: true }
            );
            return;
          }),
        timeoutMs: 5,
      });

      await vi.advanceTimersByTimeAsync(5);

      await expect(pending).resolves.toBeNull();
      return expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  return it("fails closed if URL parsing throws after callback prevalidation", () => {
    const NativeUrl = URL;
    class ThrowingUrl extends NativeUrl {
      constructor(value: string | URL, base?: string | URL) {
        if (value === "/dashboard")
          throw new TypeError("URL parser unavailable");
        super(value, base);
      }
    }
    vi.stubGlobal("URL", ThrowingUrl);
    try {
      return expect(safePortalCallbackPath("/dashboard")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("getPortalSession failure log", () => {
  const now = new Date("2029-01-01T00:00:00.000Z");
  const privateValues = /opaque-secret|203\.0\.113\.42|user-1|example\.test/u;

  const loggedLines = (): string[] =>
    vi.mocked(console.error).mock.calls.map((call) => call.join(" "));

  const check = (fetchSession: PortalSessionFetch, timeoutMs = 3000) =>
    getPortalSession({
      cfConnectingIp: "203.0.113.42",
      cookieHeader: "better-auth.session_token=opaque-secret",
      fetch: fetchSession,
      now,
      timeoutMs,
    });

  const expectOneFailureLine = (reason: string) => {
    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(
        `^portal session check failed: ${reason} durationMs=\\d+$`,
        "u"
      )
    );
    return expect(lines[0]).not.toMatch(privateValues);
  };

  const capacityResponse = () =>
    new Response(null, { headers: { "retry-after": "1" }, status: 503 });

  it("retries a capacity 503 and returns the session that follows", async () => {
    vi.useFakeTimers();
    try {
      const responses = [
        capacityResponse(),
        new Response(JSON.stringify(activeSession), { status: 200 }),
      ];
      const fetchSession = vi.fn(async () => responses.shift()!);
      const pending = check(fetchSession);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toMatchObject({ userId: "user-1" });
      expect(fetchSession).toHaveBeenCalledTimes(2);
      return expect(loggedLines()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never signs out on persistent capacity: throws unavailable after three attempts", async () => {
    vi.useFakeTimers();
    try {
      const fetchSession = vi.fn(async () => capacityResponse());
      const pending = check(fetchSession, 10_000);
      const outcome = expect(pending).rejects.toBeInstanceOf(
        PortalSessionUnavailableError
      );
      await vi.advanceTimersByTimeAsync(2000);
      await outcome;
      expect(fetchSession).toHaveBeenCalledTimes(3);
      return expectOneFailureLine("reason=http status=503 capacity=true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws unavailable, not signed out, when the deadline ends a capacity wait", async () => {
    vi.useFakeTimers();
    try {
      const fetchSession = vi.fn(async () => capacityResponse());
      const pending = check(fetchSession, 500);
      const outcome = expect(pending).rejects.toBeInstanceOf(
        PortalSessionUnavailableError
      );
      await vi.advanceTimersByTimeAsync(500);
      await outcome;
      expect(fetchSession).toHaveBeenCalledOnce();
      return expectOneFailureLine("reason=timeout deadlineMs=500");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws unavailable when the deadline aborts the retry after a capacity 503", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchSession = vi.fn((request: Request) => {
        calls += 1;
        if (calls === 1) return Promise.resolve(capacityResponse());
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        });
      });
      const pending = check(fetchSession, 1500);
      const outcome = expect(pending).rejects.toBeInstanceOf(
        PortalSessionUnavailableError
      );
      await vi.advanceTimersByTimeAsync(1500);
      await outcome;
      expect(fetchSession).toHaveBeenCalledTimes(2);
      return expectOneFailureLine("reason=timeout deadlineMs=1500");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws unavailable when the deadline already passed before the capacity wait", async () => {
    const fetchSession = vi.fn(async (request: Request) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(request.signal.aborted).toBe(true);
      return capacityResponse();
    });
    await expect(check(fetchSession, 1)).rejects.toBeInstanceOf(
      PortalSessionUnavailableError
    );
    return expectOneFailureLine("reason=timeout deadlineMs=1");
  });

  it("denies and logs the deadline when the session request hangs", async () => {
    vi.useFakeTimers();
    try {
      const pending = check(
        (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => void reject(new DOMException("aborted", "AbortError")),
              { once: true }
            );
            return;
          })
      );
      await vi.advanceTimersByTimeAsync(3000);
      await expect(pending).resolves.toBeNull();
      return expect(loggedLines()).toEqual([
        "portal session check failed: reason=timeout deadlineMs=3000 durationMs=3000",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a body that stalls past the deadline as a timeout", async () => {
    vi.useFakeTimers();
    try {
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          return controller.enqueue(new TextEncoder().encode("{"));
        },
      });
      const pending = check(async () => new Response(stalled), 5);
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toBeNull();
      return expect(loggedLines()).toEqual([
        "portal session check failed: reason=timeout deadlineMs=5 durationMs=5",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      () => new Response(null, { status: 503 }),
      "reason=http status=503 capacity=false",
    ],
    [
      () =>
        new Response(null, { headers: { "retry-after": "1" }, status: 500 }),
      "reason=http status=500 capacity=false",
    ],
    [
      () => new Response(null, { status: 401 }),
      "reason=http status=401 capacity=false",
    ],
  ])(
    "denies and logs the HTTP status and capacity flag (%#)",
    async (response, reason) => {
      await expect(check(async () => response())).resolves.toBeNull();
      return expectOneFailureLine(reason);
    }
  );

  it.each([
    [
      new TypeError("connect ECONNREFUSED 10.0.0.5:5432 opaque-secret"),
      "TypeError",
    ],
    [
      Object.assign(new Error("user-1"), { name: "cookie=opaque-secret x" }),
      "unknown",
    ],
    ["thrown string with opaque-secret", "unknown"],
    [
      Object.defineProperty(new Error("user-1"), "name", {
        get(): string {
          throw new Error("hostile getter");
        },
      }),
      "unknown",
    ],
  ])(
    "denies and logs only the error class of a transport failure (%#)",
    async (thrown, errorName) => {
      await expect(
        check(async () => {
          throw thrown;
        })
      ).resolves.toBeNull();
      expectOneFailureLine(`reason=network error=${errorName}`);
      return expect(loggedLines()[0]).not.toContain("10.0.0.5");
    }
  );

  it("denies and logs a request that cannot be built as a setup failure", async () => {
    const fetchSession = vi.fn(async () => Response.json(activeSession));
    await expect(
      getPortalSession({
        cookieHeader: "better-auth.session_token=opaque\u0000secret",
        fetch: fetchSession,
        now,
      })
    ).resolves.toBeNull();
    expect(fetchSession).not.toHaveBeenCalled();
    return expectOneFailureLine("reason=setup error=TypeError");
  });

  it.each([
    () => new Response(null),
    () => new Response("{"),
    () =>
      new Response(JSON.stringify(activeSession), {
        headers: { "content-length": "16385" },
      }),
  ])("denies and logs an unusable session body (%#)", async (response) => {
    await expect(check(async () => response())).resolves.toBeNull();
    return expectOneFailureLine("reason=invalid-body");
  });

  return it("logs nothing for a valid session, a signed-out answer or a missing cookie", async () => {
    await expect(
      check(async () => Response.json(activeSession))
    ).resolves.toMatchObject({ userId: "user-1" });
    await expect(check(async () => Response.json(null))).resolves.toBeNull();
    await expect(
      getPortalSession({
        cookieHeader: null,
        fetch: async () => Response.json(activeSession),
      })
    ).resolves.toBeNull();
    return expect(loggedLines()).toEqual([]);
  });
});
