import type { SafeAuthSession } from "@darkfactory/auth/server";
import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { appContract } from "./contract.ts";
import {
  AGENT_VIEWER_PLAN_ONLY_MESSAGE,
  AGENT_VIEWER_READ_ONLY_MESSAGE,
  agentViewerReadOnlyInterceptor,
  isAgentViewerEmail,
  isAgentViewerReadProcedure,
} from "./server/agent-viewer.ts";
import { type ApiContext, createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

// Fictional identities only.
const at = new Date("2026-11-04T12:00:00.000Z");
const VIEWER = "agent-viewer@domain.test";
const OPERATOR = "operator@domain.test";

const session = (email: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId: email },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-11-05T12:00:00.000Z"),
    id: `session-${email}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId: email,
  },
  user: {
    createdAt: at,
    email,
    emailVerified: true,
    id: email,
    image: null,
    name: email,
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

const allProcedures = (): readonly (readonly [string, string])[] => {
  const out: [string, string][] = [];
  const walk = (node: unknown, path: readonly string[]): void => {
    if (node === null || typeof node !== "object") return;
    if ("~orpc" in node) {
      const route = (node as { "~orpc": { route?: { method?: string } } })[
        "~orpc"
      ].route;
      out.push([path.join("."), route?.method ?? "POST"]);
      return;
    }
    for (const [key, value] of Object.entries(node))
      walk(value, [...path, key]);
  };
  walk(appContract, []);
  return out;
};

const contextFor = (
  email: string | null,
  over: Readonly<Record<string, unknown>> = {}
): ApiContext =>
  ({
    agentViewerEmails: [VIEWER],
    requireSession: async () => {
      if (email === null)
        throw new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
          401
        );
      return session(email);
    },
    ...over,
  }) as unknown as ApiContext;

const intercept = async (context: ApiContext, path: string) => {
  const next = vi.fn(async () => "ran");
  const result = await agentViewerReadOnlyInterceptor({
    context,
    next,
    path: path.split("."),
  }).catch((error: unknown) => error);
  return { ran: next.mock.calls.length === 1, result };
};

// Owner decisions: a viewer may start its own threads and chat in Plan mode (2026-11-05) and run
// Academy backtests, which are modeled and place no orders (2026-11-10).
const VIEWER_CHAT = new Set([
  "assistant.threads.create",
  "assistant.send",
  "academy.backtest",
]);

describe("agent viewer read-only gate", () => {
  it("refuses every write procedure for a viewer and lets every read through", async () => {
    const procedures = allProcedures();
    expect(procedures.length).toBeGreaterThan(100);
    for (const [path, method] of procedures) {
      const { result, ran } = await intercept(contextFor(VIEWER), path);
      if (VIEWER_CHAT.has(path)) {
        expect(ran, path).toBe(true);
      } else if (isAgentViewerReadProcedure(path.split("."))) {
        expect(ran, path).toBe(true);
        expect(
          method === "GET" ||
            path === "agentModelRuns.list" ||
            path === "agentModelRuns.search" ||
            path === "masterRules.search" ||
            path === "semanticTerms.query"
        ).toBe(true);
      } else {
        expect(ran, path).toBe(false);
        expect(result).toMatchObject({
          code: "FORBIDDEN",
          message: AGENT_VIEWER_READ_ONLY_MESSAGE,
          status: 403,
        });
      }
    }
  });

  it.each([
    // Orders, previews, combo and cancel
    "vertexOrders.preview",
    "vertexOrders.submit",
    "vertexOrders.comboPreview",
    "vertexOrders.comboSubmit",
    "vertexOrders.cancelPreview",
    "vertexOrders.cancelSubmit",
    // Arm / disarm (the engine kill switch path) and IBKR recovery
    "nautilusArm.arm",
    "nautilusArm.disarm",
    "ibkrRecovery.request",
    // Paid JEV call
    "jevVerdict.refresh",
    // Keys and settings
    "agentApiKeys.create",
    "agentApiKeys.revoke",
    "watchlist.add",
    "priceAlerts.create",
    "featureItems.changeStatus",
    "account.profile.update",
    "account.addresses.create",
    "preferences.update",
    "preferences.theme.update",
    "deploymentRequests.submit",
    "autopilot.campaigns.setStatus",
    // Confirm cards stay operator-only
    "assistant.actions.decide",
    // Academy paper deployment stays operator-only (backtest is allowed)
    "academy.deployPreview",
    "academy.deployRequest",
  ])("refuses %s for a viewer", async (path) => {
    expect(isAgentViewerReadProcedure(path.split("."))).toBe(false);
    const { ran, result } = await intercept(contextFor(VIEWER), path);
    expect(ran).toBe(false);
    expect(result).toMatchObject({
      code: "FORBIDDEN",
      message: AGENT_VIEWER_READ_ONLY_MESSAGE,
      status: 403,
    });
  });

  it("does not touch operators, anonymous calls, API keys or an empty list", async () => {
    expect((await intercept(contextFor(OPERATOR), "nautilusArm.arm")).ran).toBe(
      true
    );
    expect((await intercept(contextFor(null), "nautilusArm.arm")).ran).toBe(
      true
    );
    // A viewer cookie plus a made-up x-api-key header is still refused.
    expect(
      (
        await intercept(
          contextFor(VIEWER, { agentApiKeyPresented: true }),
          "nautilusArm.arm"
        )
      ).ran
    ).toBe(false);
    // A session store failure fails closed.
    const broken = await intercept(
      contextFor(VIEWER, {
        requireSession: async () => {
          throw new Error("db down");
        },
      }),
      "nautilusArm.arm"
    );
    expect(broken.ran).toBe(false);
    expect(broken.result).toMatchObject({ status: 403 });
    expect(
      (
        await intercept(
          contextFor(VIEWER, { agentViewerEmails: [] }),
          "nautilusArm.arm"
        )
      ).ran
    ).toBe(true);
    expect(
      (
        await intercept(
          contextFor(VIEWER, { agentViewerEmails: undefined }),
          "nautilusArm.arm"
        )
      ).ran
    ).toBe(true);
    expect(isAgentViewerEmail(" Agent-Viewer@domain.test ", [VIEWER])).toBe(
      true
    );
    expect(isAgentViewerEmail(" ", [VIEWER])).toBe(false);
    expect(isAgentViewerEmail(VIEWER, undefined)).toBe(false);
  });
});

const REVIEWED_READS: readonly string[] = [
  "academy.lesson",
  "academy.lessons",
  "academy.tickers",
  "account.addresses.list",
  "account.profile.get",
  "admin.featureItems.list",
  "admin.users.list",
  "agentApiKeys.list",
  "agentModelRuns.events",
  "agentModelRuns.get",
  "agentModelRuns.list",
  "agentModelRuns.search",
  "agentOps.backtests.get",
  "agentOps.backtests.list",
  "agentOps.deployment.status",
  "agentOps.optimizations.get",
  "agentOps.optimizations.list",
  "agentOps.summary",
  "agentOps.tasks.get",
  "agentOps.tasks.list",
  "assistant.threads.get",
  "assistant.threads.list",
  "autopilot.campaigns.get",
  "autopilot.campaigns.list",
  "autopilot.candidates.get",
  "backtestRuns.comparisons.list",
  "backtestRuns.definitions.get",
  "backtestRuns.definitions.list",
  "backtestRuns.drift.get",
  "backtestRuns.drift.list",
  "backtestRuns.get",
  "backtestRuns.list",
  "baskets.list",
  "baskets.valuation",
  "breadth90.get",
  "clickLog.query",
  "congressTrades.feed",
  "connectivity.health",
  "dashboard.summary",
  "deploymentRequests.get",
  "deploymentRequests.list",
  "engines.status",
  "featureItems.get",
  "featureItems.list",
  "flow.control",
  "flow.events",
  "flow.hedgingPressure",
  "flow.liquidityHeatmap",
  "flow.liveDom",
  "flow.liveDomStream",
  "flow.optionBubbles",
  "flow.optionPrints",
  "flow.putCallRatio",
  "flow.snapshot",
  "flow.strikeHeatmap",
  "flow.tapeSpeed",
  "flow.tradeBubbles",
  "goLiveDrafts.queue",
  "ibkrMonitor.roundHandles",
  "ibkrMonitor.snapshot",
  "ibkrMonitor.volatility",
  "ibkrRecovery.status",
  "instantBacktest.series",
  "instantBacktest.universes",
  "jevVerdict.get",
  "marketContext.get",
  "marketData.bars",
  "marketData.depth",
  "marketData.ticks",
  "marketNews.watchlist",
  "marketNotes.get",
  "marketNotes.list",
  "marketRegime.get",
  "masterRules.search",
  "nautilusArm.status",
  "openbb.changes13f",
  "openbb.cot",
  "openbb.events",
  "openbb.factors",
  "openbb.insiderClusters",
  "openbb.ivHistory",
  "openbb.macro",
  "openbb.priceFreshness",
  "openbb.sec",
  "openbb.shorts",
  "openbb.status",
  "openbb.volContext",
  "optionsAnalytics.greekHeatmap",
  "optionsAnalytics.snapshot",
  "optionsChain.chain",
  "optionsChain.expectedMove",
  "optionsChain.expiries",
  "optionsChain.snapshot",
  "optionsChain.spread",
  "papers.list",
  "pickLists.list",
  "pickLists.proposal",
  "plays.list",
  "portfolioMonitor.snapshot",
  "preferences.get",
  "preferences.theme.get",
  "priceAlerts.list",
  "priceAlerts.signals.events",
  "priceAlerts.signals.list",
  "quantLab.list",
  "researchLenses.deepValue",
  "researchLenses.deepValueScore",
  "researchLenses.rotationMatrix",
  "researchReports.companyResearch",
  "researchReports.dataset",
  "researchReports.list",
  "researchReports.technicals",
  "researchScreen.status",
  "researchStudies.get",
  "riskAllocator.caps",
  "sectorRotation.snapshot",
  "semanticTerms.catalog",
  "semanticTerms.list",
  "semanticTerms.query",
  "setupReplay.presets",
  "smartMoney.ranking",
  "strategyLibrary.get",
  "strategyLibrary.list",
  "todos.list",
  "vertex.experience.agent",
  "vertex.experience.agents",
  "vertex.experience.audit",
  "vertex.experience.continuity",
  "vertex.experience.dossier",
  "vertex.experience.gateway",
  "vertex.experience.gateways",
  "vertex.experience.inbox",
  "vertex.experience.portfolio",
  "vertex.experience.scopes",
  "vertex.experience.strategies",
  "vertex.modules.list",
  "vertex.notifications.delivery",
  "vertex.researchChat.listMessages",
  "vertex.researchChat.listThreads",
  "vertex.researchChat.readCopyCleanup",
  "vertex.researchChat.readDebateRun",
  "vertex.researchChat.readResponse",
  "vertex.researchChat.readResponseContent",
  "vertex.researchChat.readThread",
  "vertex.researchChat.readTranscriptPage",
  "vertex.researchChat.roster",
  "vertex.scoped.modules",
  "vertexOrders.status",
  "watchlist.list",
];

describe("agent viewer read list", () => {
  // Snapshot of every procedure a viewer may call. A new GET procedure must be reviewed (no side
  // effects) and added here on purpose; this test then fails until it is.
  it("matches the reviewed read list", () => {
    const reads = allProcedures()
      .map(([path]) => path)
      .filter((path) => isAgentViewerReadProcedure(path.split(".")))
      .sort();
    expect(reads).toEqual(REVIEWED_READS);
  });
});

describe("agent viewer through the real handler", () => {
  const clientFor = (email: string) =>
    createApiClient({
      baseUrl: "https://darkfactory.localhost",
      fetch: async (request: Request) =>
        handleApiRequest(
          request,
          createApiContext(request, {
            agentViewerEmails: [VIEWER.toUpperCase()],
            capabilities: {
              ai: false,
              analytics: false,
              emailDelivery: false,
              telemetryExport: false,
            },
            operatorEmails: [OPERATOR],
            repositories: {} as unknown as Repositories,
            requestId: "request-1",
            requireRole: async () => {
              throw new AuthAuthorizationError(
                AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
                403
              );
            },
            requireSession: async () => session(email),
          })
        ),
    });

  const expectViewerRefusal = async (promise: Promise<unknown>) => {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      message: AGENT_VIEWER_READ_ONLY_MESSAGE,
      status: 403,
    });
  };

  it("refuses arm, disarm, recovery and order calls with 403", async () => {
    const viewer = clientFor(VIEWER);
    await expectViewerRefusal(viewer.nautilusArm.disarm({}));
    await expectViewerRefusal(
      viewer.ibkrRecovery.request({
        confirmation:
          "I request IBKR recovery only; this does not authorize trading.",
      })
    );
    await expectViewerRefusal(
      viewer.vertexOrders.cancelSubmit({
        confirm: true,
        confirmToken: "x".repeat(20),
        permId: 1,
      })
    );
  });

  it("refuses Act mode chat for a viewer with 403", async () => {
    const viewer = clientFor(VIEWER);
    const error = await (async () => {
      const stream = await viewer.assistant.send({
        message: "hi",
        mode: "act",
        threadId: "00000000-0000-4000-8000-000000000000",
      });
      for await (const _ of stream) break;
    })().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: AGENT_VIEWER_PLAN_ONLY_MESSAGE,
      status: 403,
    });
  });

  it("never passes a role check, even with the admin role in the database", async () => {
    const admin = createApiContext(
      new Request("https://darkfactory.localhost/x"),
      {
        agentViewerEmails: [VIEWER],
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        repositories: {} as unknown as Repositories,
        requireRole: async () => session(VIEWER),
        requireSession: async () => session(VIEWER),
      }
    );
    await expect(admin.requireRole("admin")).rejects.toMatchObject({
      status: 403,
    });
    const operator = createApiContext(
      new Request("https://darkfactory.localhost/x"),
      {
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        repositories: {} as unknown as Repositories,
        requireRole: async () => session(OPERATOR),
        requireSession: async () => session(OPERATOR),
      }
    );
    await expect(operator.requireRole("admin")).resolves.toMatchObject({
      user: { email: OPERATOR },
    });
  });

  it("lets a viewer pass the operator gate on reads but not the owner gate", async () => {
    const viewer = clientFor(VIEWER);
    // Operator-only read: past the viewer gate and the operator gate (not "Operator access required").
    const arm = await viewer.nautilusArm
      .status({})
      .catch((caught: unknown) => caught);
    expect(arm).not.toMatchObject({ message: "Operator access required" });
    expect(arm).not.toMatchObject({ message: AGENT_VIEWER_READ_ONLY_MESSAGE });
    // Owner-only read: the viewer is not an admin.
    const status = await viewer.vertexOrders
      .status({})
      .catch((caught: unknown) => caught);
    expect(status).toMatchObject({ code: "FORBIDDEN", status: 403 });
    // A non-listed member stays outside the operator gate.
    const member = await clientFor("member@domain.test")
      .nautilusArm.status({})
      .catch((caught: unknown) => caught);
    expect(member).toMatchObject({ message: "Operator access required" });
  });
});
