import { AGENT_API_KEY_HEADER } from "@darkfactory/auth/types";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";

import { agentViewerReadOnlyInterceptor } from "./agent-viewer.ts";
import type { ApiContext } from "./context.ts";
import { appRouter } from "./router.ts";

export const ORPC_RPC_PREFIX = "/api/orpc";
export const ORPC_OPENAPI_PREFIX = "/api/openapi";

// Agent API keys may call ONLY these router roots. Every other procedure
// (including agentApiKeys.* key management) rejects a request carrying
// x-api-key before its own middleware runs, even if a session cookie is also
// present. Session-only requests are unaffected.
export const AGENT_API_KEY_PROCEDURE_ROOTS: readonly string[] = Object.freeze([
  "agentOps",
  "papers",
  "strategyLibrary",
  "marketData",
  "backtestRuns",
  "todos",
  "priceAlerts",
  "agentModelRuns",
  "openbb",
]);

// Single procedures outside those roots that keys may call. The Autopilot scheduler ticks running
// campaigns with an operator write key; every other autopilot.* procedure stays session-only. The
// sector rotation scheduler collects and records chat delivery results with a write key, and research agents read the snapshot with a
// read key; sectorRotation.map stays session-only. The click-log CLI (scripts/vertex-click-log.ts)
// reads clicks with an operator key; clickLog.record stays session-only, so a key never writes
// clicks for a user. The pick-list importer (scripts/vertex-pick-lists.ts) stores snapshots with a
// write key and research agents read lists, screens and the buy proposal with a read key; pickLists.syncBucket stays
// session-only, so a key never edits baskets. The flow timer (infra/flow/quantvps) samples with a write
// key (flow.collect) and research agents read flow.snapshot with a read key.
// openbb.* is a root: the OpenBB tick (scripts/openbb/tick.ts) writes ingest and recordRun with a
// write key, and research agents read the other openbb.* procedures with a read key.
// The breadth-90 rig tick pushes sessions with a write key (breadth90.collect) and research agents
// read the signal with a read key (breadth90.get).
// The go-live draft generator on the rig stores its candidates with a write key
// (goLiveDrafts.collect) and agents read the queue with a read key (goLiveDrafts.queue), which
// never shows the account value or a sized order to a key; goLiveDrafts.approve and
// goLiveDrafts.reject stay session-only, so a key never decides a draft.
// The engine comparison driver (scripts/engine-comparison-driver) asks for its fixed instant
// backtests with an operator write key (instantBacktest.run, research only, no order path);
// instantBacktest.series and instantBacktest.universes stay session-only.
export const AGENT_API_KEY_PROCEDURE_PATHS: readonly string[] = Object.freeze([
  "autopilot.campaigns.tick",
  "sectorRotation.collect",
  "sectorRotation.recordChatDelivery",
  "sectorRotation.snapshot",
  "clickLog.query",
  "pickLists.import",
  "pickLists.list",
  "pickLists.proposal",
  "pickLists.screen",
  "flow.collect",
  "flow.snapshot",
  "breadth90.collect",
  "breadth90.get",
  "goLiveDrafts.collect",
  "goLiveDrafts.queue",
  "instantBacktest.run",
]);

export const isAgentApiKeyProcedurePath = (
  path: readonly string[]
): boolean => {
  const [root] = path;
  return (
    (path.length > 1 &&
      root !== undefined &&
      AGENT_API_KEY_PROCEDURE_ROOTS.includes(root)) ||
    AGENT_API_KEY_PROCEDURE_PATHS.includes(path.join("."))
  );
};

type ScopeInterceptorOptions = Readonly<{
  context: ApiContext;
  path: readonly string[];
  next: () => Promise<unknown>;
}>;

export const agentApiKeyScopeInterceptor = (
  options: ScopeInterceptorOptions
): Promise<unknown> => {
  if (
    options.context.agentApiKeyPresented === true &&
    !isAgentApiKeyProcedurePath(options.path)
  ) {
    return Promise.reject(
      new ORPCError("FORBIDDEN", {
        message:
          "API keys may call only agentOps.*, papers.*, strategyLibrary.*, marketData.*, backtestRuns.*, todos.*, priceAlerts.*, agentModelRuns.* and openbb.* procedures, and autopilot.campaigns.tick, sectorRotation.collect, sectorRotation.recordChatDelivery, sectorRotation.snapshot, clickLog.query, pickLists.import, pickLists.list, pickLists.proposal, pickLists.screen, flow.collect, flow.snapshot, breadth90.collect, breadth90.get, goLiveDrafts.collect, goLiveDrafts.queue and instantBacktest.run",
      })
    );
  }
  return options.next();
};

const rpcHandler = new RPCHandler(appRouter, {
  clientInterceptors: [
    agentApiKeyScopeInterceptor,
    agentViewerReadOnlyInterceptor,
  ],
});
const openApiHandler = new OpenAPIHandler(appRouter, {
  clientInterceptors: [
    agentApiKeyScopeInterceptor,
    agentViewerReadOnlyInterceptor,
  ],
});

const notFound = (): Response => new Response("Not Found", { status: 404 });

const decodePathSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

// Applies to both transports, not just the currently mounted web RPC adapter.
// Never inspect or duplicate body bytes while enforcing private cache policy.
export const researchChatResponse = (
  request: Request,
  response: Response
): Response => {
  const path = new URL(request.url).pathname
    .split("/")
    .map(decodePathSegment)
    .join("/")
    .split("/");
  if (
    path[1] !== "api" ||
    !["orpc", "openapi"].includes(path[2] ?? "") ||
    path[3] !== "vertex" ||
    !["researchChat", "research-chat"].includes(path[4] ?? "")
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("Referrer-Policy", "no-referrer");
  headers.delete("ETag");
  headers.delete("Last-Modified");
  const vary = headers.get("Vary");
  if (vary !== "*") {
    const names = new Map(
      (vary ?? "")
        .split(",")
        .map((name) => [name.trim().toLowerCase(), name.trim()] as const)
        .filter(([key]) => key.length > 0)
    );
    names.set("cookie", "Cookie");
    names.set("authorization", "Authorization");
    headers.set("Vary", [...names.values()].join(", "));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const handleApiRequest = async (
  request: Request,
  context: ApiContext
): Promise<Response> => {
  const result = await rpcHandler.handle(request, {
    prefix: ORPC_RPC_PREFIX,
    // The flag always reflects the actual request, whatever the caller-built context says.
    context: {
      ...context,
      agentApiKeyPresented: request.headers.has(AGENT_API_KEY_HEADER),
    },
  });
  return researchChatResponse(
    request,
    result.matched ? result.response : notFound()
  );
};

export const handleOpenApiRequest = async (
  request: Request,
  context: ApiContext
): Promise<Response> => {
  const result = await openApiHandler.handle(request, {
    prefix: ORPC_OPENAPI_PREFIX,
    context: {
      ...context,
      agentApiKeyPresented: request.headers.has(AGENT_API_KEY_HEADER),
    },
  });
  return researchChatResponse(
    request,
    result.matched ? result.response : notFound()
  );
};
