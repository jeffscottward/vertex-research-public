import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperienceServices } from "./ports.ts";

const mocks = vi.hoisted(() => {
  const read = vi.fn(async (_input: unknown, _signal: AbortSignal) => ({
    status: "unavailable",
    reason: "source-unavailable",
    executionAuthorized: false,
  }));
  const decide = vi.fn(async () => undefined);
  const propose = vi.fn(async () => undefined);
  const client = { vertex: { experience: {} } };
  const services = {
    reads: {
      portfolio: read,
      continuity: read,
      inbox: read,
      strategies: read,
      dossier: read,
      agents: read,
      agent: read,
      audit: read,
      gateway: read,
      gateways: read,
      scopes: read,
    },
    reviews: { decide },
    jobs: { proposeResearch: propose, proposeSimulation: propose },
  };
  return {
    read,
    decide,
    propose,
    client,
    services,
    createApiClient: vi.fn(
      (_options: {
        baseUrl: string | URL;
        fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
      }) => client
    ),
    // Typed loosely: tests swap in service shapes with or without researchChat.
    createExperienceServices: vi.fn((): object => services),
  };
});
vi.mock("@darkfactory/api/client", () => ({
  createApiClient: mocks.createApiClient,
}));
vi.mock("./transport.ts", () => ({
  createExperienceServices: mocks.createExperienceServices,
}));

import {
  BrowserExperienceProvider,
  createBrowserExperienceServices,
} from "./browser-provider.tsx";

const input = {
  accountAlias: "authorized-alias",
  environment: "paper",
} as const;
const signal = () => new AbortController().signal;
const researchScope = {
  accountAlias: "authorized-alias",
  environment: "research",
} as const;
const chatPort = (services: ExperienceServices) => {
  const port = services.researchChat;
  if (port === null || port === undefined)
    throw new Error("Expected lazy research chat capability");
  return port;
};
const fetchHook = () => {
  const hook = mocks.createApiClient.mock.calls[0]?.[0]?.fetch;
  if (hook === undefined)
    throw new Error("Expected authenticated no-store fetch hook");
  return hook;
};

afterEach(() => {
  vi.unstubAllGlobals();
  return vi.clearAllMocks();
});

describe("browser experience provider source regressions", () => {
  it("constructs and server-renders without touching location or creating transport", () => {
    vi.stubGlobal("window", undefined);
    const services = createBrowserExperienceServices();
    expect(services.reads.portfolio).toBeTypeOf("function");
    expect(chatPort(services).roster).toBeTypeOf("function");
    expect(chatPort(services).readTranscriptPage).toBeTypeOf("function");
    for (const name of [
      "prepareResponse",
      "approveAndRequestResponse",
      "prepareDebateStep",
      "approveAndRequestDebateStep",
      "readDebateRun",
      "readResponse",
      "appendResponse",
      "readResponseContent",
    ] as const) {
      expect(chatPort(services)[name]).toBeTypeOf("function");
    }
    expect(
      renderToStaticMarkup(
        <BrowserExperienceProvider>
          <p>Static child</p>
        </BrowserExperienceProvider>
      )
    ).toContain("Static child");
    expect(mocks.createApiClient).not.toHaveBeenCalled();
    expect(mocks.createExperienceServices).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    return expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("rejects server or already-aborted invocations without constructing a client", async () => {
    vi.stubGlobal("window", undefined);
    const services = createBrowserExperienceServices();
    await expect(
      services.reads.portfolio(input, signal())
    ).rejects.toMatchObject({ kind: "unavailable" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      services.reads.portfolio(input, controller.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
    return expect(mocks.createApiClient).not.toHaveBeenCalled();
  });

  it("creates exactly one same-origin transport on the first explicit read and does not cache response data", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", origin: "https://vertex.test" },
    });
    const services = createBrowserExperienceServices();
    expect(mocks.read).not.toHaveBeenCalled();
    const firstSignal = signal();
    await services.reads.portfolio(input, firstSignal);
    await services.reads.portfolio(input, signal());
    expect(mocks.createApiClient).toHaveBeenCalledExactlyOnceWith({
      baseUrl: "https://vertex.test",
      fetch: expect.any(Function),
    });
    expect(mocks.createExperienceServices).toHaveBeenCalledExactlyOnceWith(
      mocks.client
    );
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenNthCalledWith(1, input, firstSignal);
    expect(mocks.decide).not.toHaveBeenCalled();
    return expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("delegates the scope and gateway lists to the lazily created services", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", origin: "https://vertex.test" },
    });
    const services = createBrowserExperienceServices();
    const abort = signal();
    await services.reads.scopes(undefined, abort);
    await services.reads.gateways(undefined, abort);
    expect(mocks.read).toHaveBeenNthCalledWith(1, undefined, abort);
    return expect(mocks.read).toHaveBeenNthCalledWith(2, undefined, abort);
  });

  it("rejects unsupported origins before initialization and isolates separate provider instances", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "file:", origin: "null" },
    });
    await expect(
      createBrowserExperienceServices().reads.portfolio(input, signal())
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(mocks.createApiClient).not.toHaveBeenCalled();
    vi.stubGlobal("window", {
      location: { protocol: "http:", origin: "http://localhost:3000" },
    });
    await createBrowserExperienceServices().reads.portfolio(input, signal());
    await createBrowserExperienceServices().reads.portfolio(input, signal());
    return expect(mocks.createApiClient).toHaveBeenCalledTimes(2);
  });

  it("keeps chat SSR and already-aborted calls unavailable without creating a client", async () => {
    vi.stubGlobal("window", undefined);
    const port = chatPort(createBrowserExperienceServices());
    await expect(port.roster(researchScope, signal())).rejects.toMatchObject({
      kind: "unavailable",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      port.roster(researchScope, controller.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
    await expect(
      port.readTranscriptPage(
        { ...researchScope, threadId: "thread-a", cursor: null, limit: 1 },
        controller.signal
      )
    ).rejects.toMatchObject({ kind: "suspended" });
    expect(mocks.createApiClient).not.toHaveBeenCalled();
    return expect(mocks.createExperienceServices).not.toHaveBeenCalled();
  });

  it("normalizes missing and explicit null chat capability without optional-state assertions", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", origin: "https://vertex.test" },
    });
    await expect(
      chatPort(createBrowserExperienceServices()).roster(
        researchScope,
        signal()
      )
    ).rejects.toMatchObject({ kind: "unavailable" });
    const disabled = { ...mocks.services, researchChat: null };
    mocks.createExperienceServices.mockReturnValueOnce(disabled);
    await expect(
      chatPort(createBrowserExperienceServices()).roster(
        researchScope,
        signal()
      )
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(mocks.read).not.toHaveBeenCalled();
    return expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("lazily forwards all fifteen chat operations through one transport without caching records", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", origin: "https://vertex.test" },
    });
    const operation = () =>
      vi.fn(async (_input: unknown, _signal: AbortSignal) => undefined);
    const researchChat = {
      roster: operation(),
      listThreads: operation(),
      createThread: operation(),
      readThread: operation(),
      listMessages: operation(),
      readTranscriptPage: operation(),
      sendMessage: operation(),
      prepareResponse: operation(),
      approveAndRequestResponse: operation(),
      readResponse: operation(),
      appendResponse: operation(),
      readResponseContent: operation(),
      prepareDebateStep: operation(),
      approveAndRequestDebateStep: operation(),
      readDebateRun: operation(),
    };
    const supplied = { ...mocks.services, researchChat };
    mocks.createExperienceServices.mockReturnValueOnce(supplied);
    const port = chatPort(createBrowserExperienceServices());
    const abort = signal();
    const page = { ...researchScope, limit: 2, cursor: "page_a" };
    const thread = { ...researchScope, threadId: "thread-a" };
    const creation = {
      ...researchScope,
      title: "Research",
      participantIds: ["expert-a"],
      idempotencyKey: "create-a",
    };
    const message = {
      ...thread,
      expectedRevision: "1",
      body: "Question",
      requestedParticipantIds: [],
      mode: "debate",
      idempotencyKey: "send-a",
    } as const;
    const request = {
      ...thread,
      parentMessageId: "human-a",
      participantId: "expert-a",
      snapshotRevision: "2",
      contextStartSequence: "1",
      retrievalQuery: "Compare the research assumptions.",
      idempotencyKey: "response-key-a",
    };
    const approval = { planId: "plan-a", planSha256: "a".repeat(64), request };
    const responseKey = { ...thread, idempotencyKey: request.idempotencyKey };
    const append = {
      ...thread,
      responseRequestId: "response-a",
      expectedRevision: "2",
    };
    const content = {
      ...thread,
      responseRequestId: "response-a",
      messageId: "agent-a",
    };
    const debateRequest = {
      ...request,
      debate: {
        profile: "vertex-research-chat-debate-step-v1" as const,
        runKey: "debate-key",
        ordinal: 1,
        predecessors: [],
      },
    };
    const debateApproval = { ...approval, request: debateRequest };
    const debateSelector = { ...thread, runKey: "debate-key" };
    expect(mocks.createApiClient).not.toHaveBeenCalled();
    await port.roster(researchScope, abort);
    await port.listThreads(page, abort);
    await port.createThread(creation, abort);
    await port.readThread(thread, abort);
    await port.listMessages({ ...page, threadId: thread.threadId }, abort);
    await port.readTranscriptPage(
      { ...page, threadId: thread.threadId },
      abort
    );
    await port.sendMessage(message, abort);
    await port.prepareResponse(request, abort);
    await port.approveAndRequestResponse(approval, abort);
    await port.readResponse(responseKey, abort);
    await port.appendResponse(append, abort);
    await port.readResponseContent(content, abort);
    await port.prepareDebateStep(debateRequest, abort);
    await port.approveAndRequestDebateStep(debateApproval, abort);
    await port.readDebateRun(debateSelector, abort);
    expect(researchChat.roster).toHaveBeenCalledExactlyOnceWith(
      researchScope,
      abort
    );
    expect(researchChat.listThreads).toHaveBeenCalledExactlyOnceWith(
      page,
      abort
    );
    expect(researchChat.createThread).toHaveBeenCalledExactlyOnceWith(
      creation,
      abort
    );
    expect(researchChat.readThread).toHaveBeenCalledExactlyOnceWith(
      thread,
      abort
    );
    expect(researchChat.listMessages).toHaveBeenCalledExactlyOnceWith(
      { ...page, threadId: thread.threadId },
      abort
    );
    expect(researchChat.readTranscriptPage).toHaveBeenCalledExactlyOnceWith(
      { ...page, threadId: thread.threadId },
      abort
    );
    expect(researchChat.sendMessage).toHaveBeenCalledExactlyOnceWith(
      message,
      abort
    );
    expect(researchChat.prepareResponse).toHaveBeenCalledExactlyOnceWith(
      request,
      abort
    );
    expect(
      researchChat.approveAndRequestResponse
    ).toHaveBeenCalledExactlyOnceWith(approval, abort);
    expect(researchChat.readResponse).toHaveBeenCalledExactlyOnceWith(
      responseKey,
      abort
    );
    expect(researchChat.appendResponse).toHaveBeenCalledExactlyOnceWith(
      append,
      abort
    );
    expect(researchChat.readResponseContent).toHaveBeenCalledExactlyOnceWith(
      content,
      abort
    );
    expect(researchChat.prepareDebateStep).toHaveBeenCalledExactlyOnceWith(
      debateRequest,
      abort
    );
    expect(
      researchChat.approveAndRequestDebateStep
    ).toHaveBeenCalledExactlyOnceWith(debateApproval, abort);
    expect(researchChat.readDebateRun).toHaveBeenCalledExactlyOnceWith(
      debateSelector,
      abort
    );
    await port.roster(researchScope, abort);
    expect(researchChat.roster).toHaveBeenCalledTimes(2);
    expect(mocks.createApiClient).toHaveBeenCalledExactlyOnceWith({
      baseUrl: "https://vertex.test",
      fetch: expect.any(Function),
    });
    expect(mocks.createExperienceServices).toHaveBeenCalledExactlyOnceWith(
      mocks.client
    );
    expect(mocks.read).not.toHaveBeenCalled();
    return expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("forces no-store and same-origin credentials while preserving the original Request body headers and cancellation", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", origin: "https://vertex.test" },
    });
    const response = new Response(null, { status: 204 });
    const transport = vi.fn(
      async (_request: Request, _init?: RequestInit) => response
    );
    vi.stubGlobal("fetch", transport);
    const services = createBrowserExperienceServices();
    expect(transport).not.toHaveBeenCalled();
    await services.reads.portfolio(input, signal());
    const controller = new AbortController();
    const request = new Request("https://vertex.test/api/orpc", {
      method: "POST",
      body: "opaque request bytes",
      headers: {
        "content-type": "application/json",
        "x-boundary-test": "literal",
      },
      signal: controller.signal,
      cache: "force-cache",
      credentials: "include",
    });
    const hook = fetchHook();
    await expect(hook(request)).resolves.toBe(response);
    expect(transport).toHaveBeenCalledExactlyOnceWith(request, {
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(transport.mock.calls[0]?.[0]).toBe(request);
    expect(request.bodyUsed).toBe(false);
    expect(request.headers.get("x-boundary-test")).toBe("literal");
    expect(request.cache).toBe("force-cache");
    expect(request.credentials).toBe("include");
    const effective = new Request(
      request.clone(),
      transport.mock.calls[0]?.[1]
    );
    expect(effective.method).toBe("POST");
    expect(await effective.text()).toBe("opaque request bytes");
    expect(effective.cache).toBe("no-store");
    expect(effective.credentials).toBe("same-origin");
    controller.abort();
    expect(effective.signal.aborted).toBe(true);
    return expect(request.signal.aborted).toBe(true);
  });

  it("preserves explicit fetch init and signal without changing caller data or reusing response bytes", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", origin: "https://vertex.test" },
    });
    const first = new Response(null, { status: 204 });
    const second = new Response(null, { status: 204 });
    const transport = vi
      .fn(async (_request: Request, _init?: RequestInit) => first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    vi.stubGlobal("fetch", transport);
    await createBrowserExperienceServices().reads.portfolio(input, signal());
    const hook = fetchHook();
    const request = new Request("https://vertex.test/api/orpc", {
      method: "POST",
      body: "original",
      signal: signal(),
    });
    const controller = new AbortController();
    const headers = { "x-boundary-test": "explicit" };
    const init: RequestInit = {
      method: "POST",
      body: "overridden",
      headers,
      signal: controller.signal,
      redirect: "error",
      cache: "force-cache",
      credentials: "omit",
    };
    await expect(hook(request, init)).resolves.toBe(first);
    await expect(hook(request, init)).resolves.toBe(second);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenNthCalledWith(1, request, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
    });
    const forwarded = transport.mock.calls[0]?.[1];
    expect(forwarded).not.toBe(init);
    expect(forwarded?.signal).toBe(controller.signal);
    expect(forwarded?.headers).toBe(headers);
    expect(init.cache).toBe("force-cache");
    expect(init.credentials).toBe("omit");
    return expect(request.bodyUsed).toBe(false);
  });

  return it("keeps each new operation lazy and rejects already-aborted calls before service initialization", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", origin: "https://vertex.test" },
    });
    const port = chatPort(createBrowserExperienceServices());
    const controller = new AbortController();
    controller.abort();
    const thread = { ...researchScope, threadId: "thread-a" };
    const request = {
      ...thread,
      parentMessageId: "human-a",
      participantId: "expert-a",
      snapshotRevision: "2",
      contextStartSequence: "1",
      retrievalQuery: "Compare the research assumptions.",
      idempotencyKey: "response-key-a",
    };
    const debateRequest = {
      ...request,
      debate: {
        profile: "vertex-research-chat-debate-step-v1" as const,
        runKey: "debate-key",
        ordinal: 1,
        predecessors: [],
      },
    };
    const calls = [
      () => port.prepareResponse(request, controller.signal),
      () =>
        port.approveAndRequestResponse(
          { planId: "plan-a", planSha256: "a".repeat(64), request },
          controller.signal
        ),
      () =>
        port.readResponse(
          { ...thread, idempotencyKey: request.idempotencyKey },
          controller.signal
        ),
      () =>
        port.appendResponse(
          { ...thread, responseRequestId: "response-a", expectedRevision: "2" },
          controller.signal
        ),
      () =>
        port.readResponseContent(
          { ...thread, responseRequestId: "response-a", messageId: "agent-a" },
          controller.signal
        ),
      () => port.prepareDebateStep(debateRequest, controller.signal),
      () =>
        port.approveAndRequestDebateStep(
          {
            planId: "plan-a",
            planSha256: "a".repeat(64),
            request: debateRequest,
          },
          controller.signal
        ),
      () =>
        port.readDebateRun(
          { ...thread, runKey: "debate-key" },
          controller.signal
        ),
    ];
    for (const invoke of calls) {
      await expect(invoke()).rejects.toMatchObject({ kind: "suspended" });
    }
    expect(mocks.createApiClient).not.toHaveBeenCalled();
    return expect(mocks.createExperienceServices).not.toHaveBeenCalled();
  });
});

describe("browser experience provider read, review, job and native forwarding", () => {
  it("forwards every remaining read, review, job and native evidence call through one lazy transport", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", origin: "https://vertex.test" },
    });
    const native = vi.fn(async (_input: unknown, _signal: AbortSignal) => ({
      status: "unavailable",
    }));
    mocks.createExperienceServices.mockReturnValueOnce({
      ...mocks.services,
      researchChat: {
        prepareNativeEvidence: native,
        approveAndRequestNativeEvidence: native,
      },
    });
    const services = createBrowserExperienceServices();
    const abort = signal();
    const artifact = { ...input, artifactId: "artifact-a" };
    const page = { ...input, limit: 1, cursor: null };
    await services.reads.continuity(page as never, abort);
    await services.reads.inbox(input, abort);
    await services.reads.strategies(input, abort);
    await services.reads.dossier(artifact, abort);
    await services.reads.agents(input, abort);
    await services.reads.agent(artifact, abort);
    await services.reads.audit(input, abort);
    await services.reads.gateway(
      { gatewayId: "gateway-a", environment: "paper" },
      abort
    );
    expect(mocks.read).toHaveBeenCalledTimes(8);
    expect(mocks.read).toHaveBeenCalledWith(artifact, abort);
    await services.reviews?.decide({ ...artifact } as never, abort);
    await services.jobs?.proposeResearch({ ...input } as never, abort);
    await services.jobs?.proposeSimulation({ ...input } as never, abort);
    expect(mocks.decide).toHaveBeenCalledTimes(1);
    expect(mocks.propose).toHaveBeenCalledTimes(2);
    const port = chatPort(services);
    await port.prepareNativeEvidence({ ...researchScope } as never, abort);
    await port.approveAndRequestNativeEvidence(
      { ...researchScope } as never,
      abort
    );
    expect(native).toHaveBeenCalledTimes(2);
    return expect(mocks.createApiClient).toHaveBeenCalledTimes(1);
  });

  return it("rejects review and job commands when their capabilities are absent", async () => {
    vi.stubGlobal("window", {
      location: { protocol: "https:", origin: "https://vertex.test" },
    });
    mocks.createExperienceServices.mockReturnValueOnce({
      ...mocks.services,
      reviews: null,
      jobs: null,
    });
    const services = createBrowserExperienceServices();
    for (const invoke of [
      () => services.reviews?.decide({ ...input } as never, signal()),
      () => services.jobs?.proposeResearch({ ...input } as never, signal()),
      () => services.jobs?.proposeSimulation({ ...input } as never, signal()),
    ])
      await expect(invoke()).rejects.toMatchObject({ kind: "unavailable" });
    expect(mocks.decide).not.toHaveBeenCalled();
    return expect(mocks.propose).not.toHaveBeenCalled();
  });
});
