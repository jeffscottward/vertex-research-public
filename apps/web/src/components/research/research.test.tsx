import { type ApiClient, createApiClient } from "@darkfactory/api";
import { ModuleManifestSchema } from "@darkfactory/api/vertex";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ModulesPage from "../../app/(portal)/modules/page.tsx";
import ResearchPage from "../../app/(portal)/research/page.tsx";
import { createReadResource } from "./read-resource.ts";
import {
  ArtifactFacts,
  ModuleResults,
  ReadFailure,
  ReadNotice,
  ResearchHeading,
} from "./research-views.tsx";
import { ModulesWorkspace } from "./research-workspace.tsx";
import {
  classifyVertexFailure,
  createBrowserVertexReadGateway,
  createVertexReadGateway,
  toVertexReadError,
  VertexReadError,
} from "./vertex-client.ts";

const digest = "a".repeat(64);
const module = ModuleManifestSchema.parse({
  artifactDigest: digest,
  capabilities: ["research"],
  dataRequirements: [
    {
      entitlementPolicyId: "policy-1",
      kind: "candles",
      maximumAgeMs: 1000,
      pointInTimeRequired: true,
    },
  ],
  inputSchemaVersion: "1.0.0",
  lifecycleState: "unavailable",
  moduleId: "fixture-module",
  outputSchemaVersion: "1.0.0",
  reasonCodes: ["not-connected"],
  riskPolicyVersion: "1.0.0",
  runtime: "python-external",
  schemaVersion: "1.0.0",
  supportedInstruments: ["equity"],
  version: "1.0.0",
});
const signal = new AbortController().signal;
const clientFixture = () => {
  const list = vi.fn(async () => [module]);
  const client = {
    vertex: { modules: { list } },
  } as unknown as Pick<ApiClient, "vertex">;
  return { gateway: createVertexReadGateway(client), list };
};

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
    return;
  });
  return { promise, reject, resolve };
};

const typedFailures = [
  ["UNAUTHORIZED", 401, "unauthorized"],
  ["FORBIDDEN", 403, "denied"],
  ["NOT_FOUND", 404, "not-found"],
  ["SERVICE_UNAVAILABLE", 503, "unavailable"],
  ["INVALID_SOURCE", 502, "malformed"],
  ["BAD_REQUEST", 400, "invalid"],
] as const;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  return vi.restoreAllMocks();
});

describe("Vertex readonly browser gateway", () => {
  it("sends only an abort signal, validating and freezing the returned catalog", async () => {
    const fixture = clientFixture();
    const modules = await fixture.gateway.modules(signal);
    expect(fixture.list).toHaveBeenCalledWith({}, { signal });
    expect(modules).toEqual([module]);
    return expect(Object.isFrozen(modules)).toBe(true);
  });

  it("rejects malformed, oversized, and duplicate catalogs rather than displaying partial data", async () => {
    const fixture = clientFixture();
    for (const value of [
      null,
      {},
      [null],
      [{ ...module, lifecycleState: "ready" }],
      [module, module],
      new Array(257).fill(module),
    ]) {
      fixture.list.mockResolvedValueOnce(value as never);
      await expect(fixture.gateway.modules(signal)).rejects.toMatchObject({
        kind: "malformed",
      });
    }
    fixture.list.mockResolvedValueOnce([]);
    return await expect(fixture.gateway.modules(signal)).resolves.toEqual([]);
  });

  it.each(typedFailures)(
    "preserves the typed %s/%s failure without provider text",
    async (code, status, kind) => {
      const fixture = clientFixture();
      const failure = {
        code,
        defined: true,
        message: "private provider payload",
        status,
      };
      fixture.list.mockRejectedValueOnce(failure);
      await expect(fixture.gateway.modules(signal)).rejects.toBe(failure);
      const classified = classifyVertexFailure(failure);
      expect(classified.kind).toBe(kind);
      return expect(JSON.stringify(classified)).not.toContain("private");
    }
  );

  it.each([
    ["not-configured", "server-not-configured", "not configured"],
    ["request-cancelled", "request-cancelled", "was cancelled"],
  ] as const)(
    "shows the typed 503 cause %s as its own state",
    (reason, kind, text) => {
      const classified = classifyVertexFailure({
        code: "SERVICE_UNAVAILABLE",
        data: { reason },
        defined: true,
        status: 503,
      });
      expect(classified.kind).toBe(kind);
      expect(classified.detail).toContain("named the cause");
      return expect(classified.detail).toContain(text);
    }
  );

  it.each([
    [undefined],
    [null],
    ["private provider payload"],
    [{}],
    [{ reason: "a-new-cause" }],
    [{ reason: 7 }],
  ])("states that a 503 named no cause when its data is %j", (data) => {
    const classified = classifyVertexFailure({
      code: "SERVICE_UNAVAILABLE",
      data,
      defined: true,
      status: 503,
    });
    expect(classified.kind).toBe("unavailable");
    expect(classified.title).toBe("Server answered 503 without a cause");
    return expect(classified.detail).toContain("did not name the cause");
  });

  it("keeps the typed 503 cause in the UI-facing copy of the error", () => {
    const copy = toVertexReadError({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "not-configured" },
      defined: true,
      status: 503,
    });
    expect(copy.kind).toBe("server-not-configured");
    return expect(copy.message).toBe("Server backend not configured");
  });

  it("ignores inherited, mismatched, unknown, and getter-backed error metadata", () => {
    const getter = vi.fn(() => "UNAUTHORIZED");
    for (const failure of [
      null,
      "private provider payload",
      new Error("private provider payload"),
      { code: "UNAUTHORIZED", defined: false, status: 401 },
      { code: "UNAUTHORIZED", defined: true, status: 500 },
      Object.create({ code: "UNAUTHORIZED", defined: true, status: 401 }),
      Object.defineProperty({ defined: true, status: 401 }, "code", {
        get: getter,
      }),
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error("private");
          },
        }
      ),
    ]) {
      expect(classifyVertexFailure(failure).kind).toBe("error");
      expect(JSON.stringify(classifyVertexFailure(failure))).not.toContain(
        "private provider"
      );
    }
    expect(getter).not.toHaveBeenCalled();
    return expect(
      classifyVertexFailure(new VertexReadError("malformed")).kind
    ).toBe("malformed");
  });

  it("creates no browser client until a read is requested", async () => {
    vi.stubGlobal("window", { location: { origin: "https://vertex.test" } });
    const fetcher = vi.fn(async (_request: Request) =>
      Response.json({ json: [] })
    );
    vi.stubGlobal("fetch", fetcher);
    const gateway = createBrowserVertexReadGateway();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(gateway.modules(signal)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = fetcher.mock.calls[0]?.[0] as Request | undefined;
    return expect(request?.url).toBe(
      "https://vertex.test/api/orpc/vertex/modules/list"
    );
  });

  it("uses the real typed client to reject an unavailable wire response", async () => {
    const client = createApiClient({
      baseUrl: "https://vertex.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            json: {
              code: "SERVICE_UNAVAILABLE",
              defined: true,
              message: "Vertex read service unavailable",
              status: 503,
            },
          }),
          { headers: { "content-type": "application/json" }, status: 503 }
        ),
    });
    try {
      await createVertexReadGateway(client).modules(signal);
      return expect.unreachable("Unavailable must never become sample data");
    } catch (error) {
      return expect(classifyVertexFailure(error).kind).toBe("unavailable");
    }
  });

  it("names the cause, the time and the next step of each local failure", () => {
    const at = Date.UTC(2026, 10, 19, 14, 2);
    const text = (error: VertexReadError): string => {
      const failure = classifyVertexFailure(error);
      return `${failure.title} | ${failure.detail}`;
    };
    expect(text(new VertexReadError("not-configured"))).toContain(
      "This service not configured | This service is not configured in this deployment. Nothing was sent."
    );
    expect(
      text(new VertexReadError("not-configured", { service: "Job service" }))
    ).toContain("Job service not configured | Job service is not configured");
    expect(text(new VertexReadError("not-mounted"))).toContain(
      "Experience services are not connected on this page"
    );
    expect(text(new VertexReadError("unsupported-origin"))).toContain(
      "not running in a browser over http(s)"
    );
    expect(text(new VertexReadError("discarded", { at }))).toMatch(
      /^Result discarded: the request was no longer current \| The result arrived at .*\d{2}:\d{2}.*, when its request was no longer current: the request window ended, the tab was hidden, the browser went offline or the sign-in changed\. Nothing was applied\. Run the action again\.$/u
    );
    expect(text(new VertexReadError("discarded"))).toContain(
      "arrived at a time that was not recorded"
    );
    expect(text(new VertexReadError("timed-out", { at, seconds: 12 }))).toMatch(
      /^No response within 12s \| The request was stopped at .*\d{2}:\d{2}.* \(timed out\)/u
    );
    const bare = new VertexReadError("timed-out");
    expect(bare.message).toBe("No response before the deadline");
    expect(bare.context).toEqual({});
    return expect(text(bare)).toContain("inspect the same request key");
  });

  return it("copies a failure for the UI with its local context and without server text", () => {
    const local = new VertexReadError("not-configured", {
      service: "Review service",
    });
    const copy = toVertexReadError(local);
    expect(copy).not.toBe(local);
    expect(copy).toMatchObject({
      kind: "not-configured",
      message: "Review service not configured",
    });
    const wire = toVertexReadError({
      code: "FORBIDDEN",
      defined: true,
      message: "provider text",
      status: 403,
    });
    return expect(wire).toMatchObject({
      kind: "denied",
      message: "Access not granted",
    });
  });
});

describe("bounded read resource", () => {
  it("publishes loading and ready once, then clears retained artifacts before another read", async () => {
    const read = vi.fn(async (value: string) => value);
    const resource = createReadResource(read);
    const listener = vi.fn();
    const unsubscribe = resource.subscribe(listener);
    expect(resource.getSnapshot()).toEqual({ type: "idle" });
    const pending = resource.load("first");
    expect(resource.getSnapshot()).toEqual({ type: "loading" });
    await pending;
    expect(resource.getSnapshot()).toEqual({ type: "ready", value: "first" });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    resource.clear();
    expect(resource.getSnapshot()).toEqual({ type: "idle" });
    return expect(listener).toHaveBeenCalledTimes(2);
  });

  it("never lets a late request overwrite the latest identity or its error", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const signals: AbortSignal[] = [];
    const resource = createReadResource((id: string, active) => {
      signals.push(active);
      return id === "first" ? first.promise : second.promise;
    });
    const firstRead = resource.load("first");
    const secondRead = resource.load("second");
    expect(signals[0]?.aborted).toBe(true);
    second.reject({ code: "FORBIDDEN", defined: true, status: 403 });
    await secondRead;
    expect(resource.getSnapshot()).toMatchObject({
      failure: { kind: "denied" },
      type: "error",
    });
    first.resolve("private old result");
    await firstRead;
    return expect(resource.getSnapshot()).toMatchObject({
      failure: { kind: "denied" },
      type: "error",
    });
  });

  it("bounds a stalled read and discards late success without automatic retries", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const read = vi.fn(
      (_input: string, _signal: AbortSignal) => pending.promise
    );
    const resource = createReadResource(read, 100);
    const operation = resource.load("record");
    await vi.advanceTimersByTimeAsync(100);
    expect(resource.getSnapshot()).toMatchObject({
      failure: { kind: "timed-out", title: "No response within 0.1s" },
      type: "error",
    });
    expect(read.mock.calls[0]?.[1].aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve("late");
    await operation;
    expect(resource.getSnapshot()).toMatchObject({ type: "error" });
    return expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pending work on clear and ignores cancellation rejection", async () => {
    const pending = deferred<string>();
    const resource = createReadResource(() => pending.promise);
    const operation = resource.load(undefined);
    resource.clear();
    pending.reject(new Error("cancelled private payload"));
    await operation;
    return expect(resource.getSnapshot()).toEqual({ type: "idle" });
  });

  return it("allows an explicit retry after failure and releases its deadline", async () => {
    vi.useFakeTimers();
    let succeeds = false;
    const resource = createReadResource(async () => {
      if (!succeeds) throw new Error("private");
      return "verified";
    });
    await resource.load(undefined);
    expect(resource.getSnapshot()).toMatchObject({
      failure: { kind: "error" },
      type: "error",
    });
    succeeds = true;
    await resource.load(undefined);
    expect(resource.getSnapshot()).toEqual({
      type: "ready",
      value: "verified",
    });
    return expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Vertex rendered research states", () => {
  it("renders distinct loading, empty, unavailable, and ready module views", () => {
    for (const type of ["idle", "loading"] as const) {
      const html = renderToStaticMarkup(
        <ModuleResults retry={() => undefined} state={{ type }} />
      );
      expect(html).toContain("Reading module manifests");
      expect(html).toContain('aria-busy="true"');
    }
    expect(
      renderToStaticMarkup(
        <ModuleResults
          retry={() => undefined}
          state={{ type: "ready", value: [] }}
        />
      )
    ).toContain("No modules returned");
    const failure = classifyVertexFailure(new VertexReadError("unavailable"));
    const unavailable = renderToStaticMarkup(
      <ModuleResults
        retry={() => undefined}
        state={{ failure, type: "error" }}
      />
    );
    expect(unavailable).toContain("Server answered 503 without a cause");
    expect(unavailable).not.toContain(module.moduleId);
    const html = renderToStaticMarkup(
      <ModuleResults
        retry={() => undefined}
        state={{ type: "ready", value: [module] }}
      />
    );
    for (const text of [
      module.moduleId,
      "unavailable",
      "not-connected",
      "candles",
      "point-in-time required",
      digest,
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Activate");
    const empty = {
      ...module,
      dataRequirements: [],
      reasonCodes: [],
      supportedInstruments: [],
    };
    expect(
      renderToStaticMarkup(
        <ModuleResults
          retry={() => undefined}
          state={{ type: "ready", value: [empty] }}
        />
      )
    ).toContain("No data requirements declared");
    const noPit = {
      ...module,
      dataRequirements: [
        { ...module.dataRequirements[0]!, pointInTimeRequired: false },
      ],
    };
    return expect(
      renderToStaticMarkup(
        <ModuleResults
          retry={() => undefined}
          state={{ type: "ready", value: [noPit] }}
        />
      )
    ).toContain("point-in-time not required");
  });

  it("shows only safe recovery actions and preserves the sign-in callback contract", () => {
    for (const [, , kind] of typedFailures) {
      const html = renderToStaticMarkup(
        <ReadFailure
          failure={classifyVertexFailure(new VertexReadError(kind))}
          retry={() => undefined}
          returnTo="/modules"
        />
      );
      expect(html).toContain('role="alert"');
      if (kind === "unauthorized")
        expect(html).toContain("/sign-in?callbackURL=%2Fmodules");
      if (kind === "denied") expect(html).toContain('href="/account"');
      if (kind === "not-found" || kind === "invalid")
        expect(html).not.toContain("<button");
    }
    const retry = vi.fn();
    const node = ReadFailure({
      failure: classifyVertexFailure(new Error()),
      retry,
      returnTo: "/modules",
    });
    return expect(renderToStaticMarkup(node)).toContain("Retry read");
  });

  it("renders the module catalog without reading before mount", () => {
    const fixture = clientFixture();
    expect(
      renderToStaticMarkup(<ModulesWorkspace gateway={fixture.gateway} />)
    ).toContain("Refresh catalog");
    return expect(fixture.list).not.toHaveBeenCalled();
  });

  return it("retains source-first foundations while exposing scope-protected Research Lab", () => {
    for (const Page of [ModulesPage, ResearchPage]) {
      const html = renderToStaticMarkup(createElement(Page));
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).not.toMatch(/Run backtest|Place order|Start execution/);
    }
    const workflow = renderToStaticMarkup(<ResearchPage />);
    expect(workflow).toMatch(/<h1[^>]*>Research<\/h1>/u);
    expect(workflow).toContain("This view cannot verify the research session");
    expect(workflow).not.toContain("research-conversations");
    expect(workflow).not.toContain("<form");
    const heading = <ResearchHeading title="Heading" />;
    expect(renderToStaticMarkup(heading)).toContain("Heading");
    expect(
      renderToStaticMarkup(<ResearchHeading level={2} title="Section" />)
    ).toContain("<h2>Section</h2>");
    expect(
      renderToStaticMarkup(<ArtifactFacts entries={[["Field", "Value"]]} />)
    ).toContain("<dd>Value</dd>");
    const notice = <ReadNotice title="Empty">No record</ReadNotice>;
    return expect(renderToStaticMarkup(notice)).toContain('aria-busy="false"');
  });
});
