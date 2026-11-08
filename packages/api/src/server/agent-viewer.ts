import { AuthAuthorizationError } from "@darkfactory/auth/types";
import { ORPCError } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { ApiContext } from "./context.ts";

// Read-only agent viewer (owner decision 2026-11-04, card vertex-agent-viewer). A user whose email is
// on VERTEX_AGENT_VIEWER_EMAILS may open the operator pages and read their data so agents can check
// live pages without the owner. Server-side rule: such a session may call ONLY read procedures
// (contract route method GET, plus READ_POST_PROCEDURES). Every other procedure is refused with 403
// before its own middleware runs: orders and order previews, arm/disarm, IBKR recovery, kill switch,
// settings, watchlists, API keys and every other write. Viewers are never admins (owner screen needs
// admin) and the list must not overlap VERTEX_OPERATOR_EMAILS (config check).

export const AGENT_VIEWER_READ_ONLY_MESSAGE =
  "Agent viewer access is read-only";

// POST procedures that only read (no side effects).
const READ_POST_PROCEDURES: ReadonlySet<string> = new Set([
  "agentModelRuns.list",
  "agentModelRuns.search",
  "semanticTerms.query",
]);

// Assistant procedures a viewer may call (owner decision 2026-11-05, card vertex-chat-entry-e2e):
// the viewer may start its own threads and chat in Plan mode only. assistant.send refuses Act mode
// for a viewer itself (this interceptor cannot see the input). Tool calls run as new requests with
// the viewer's cookie, so this interceptor still refuses every write tool. Confirm cards cannot run
// because assistant.actions.decide stays refused.
const VIEWER_ASSISTANT_PROCEDURES: ReadonlySet<string> = new Set([
  "assistant.threads.create",
  "assistant.send",
]);

export const AGENT_VIEWER_PLAN_ONLY_MESSAGE =
  "Agent viewer may chat in Plan mode only";

const collectGetProcedures = (): ReadonlySet<string> => {
  const found = new Set<string>();
  // Every node of the contract tree is an object: a router or a procedure ("~orpc").
  const walk = (node: object, path: readonly string[]): void => {
    if ("~orpc" in node) {
      const meta = (node as { "~orpc": { route?: { method?: string } } })[
        "~orpc"
      ];
      if (meta.route?.method === "GET") found.add(path.join("."));
      return;
    }
    for (const [key, value] of Object.entries(node))
      walk(value as object, [...path, key]);
  };
  walk(appContract, []);
  return found;
};

const GET_PROCEDURES = collectGetProcedures();

export const isAgentViewerReadProcedure = (
  path: readonly string[]
): boolean => {
  const name = path.join(".");
  return GET_PROCEDURES.has(name) || READ_POST_PROCEDURES.has(name);
};

export const isAgentViewerEmail = (
  email: string,
  viewerEmails: readonly string[] | undefined
): boolean => {
  const normalized = email.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    (viewerEmails ?? []).some((entry) => entry === normalized)
  );
};

type InterceptorOptions = Readonly<{
  context: ApiContext;
  path: readonly string[];
  next: () => Promise<unknown>;
}>;

// Runs for every procedure on both transports. An anonymous request continues and meets the
// procedure's own auth.
export const agentViewerReadOnlyInterceptor = async (
  options: InterceptorOptions
): Promise<unknown> => {
  const viewers = options.context.agentViewerEmails ?? [];
  if (
    viewers.length === 0 ||
    isAgentViewerReadProcedure(options.path) ||
    VIEWER_ASSISTANT_PROCEDURES.has(options.path.join("."))
  )
    return await options.next();
  // Checked also when an x-api-key header is present (a viewer cookie plus a made-up key). An
  // auth refusal (no session, suspended, ...) continues to the procedure's own auth, which refuses
  // it again; any other failure (session store down) fails closed.
  let email: string | null = null;
  try {
    email = (await options.context.requireSession()).user.email;
  } catch (error) {
    if (!(error instanceof AuthAuthorizationError))
      throw new ORPCError("FORBIDDEN", {
        status: 403,
        message: AGENT_VIEWER_READ_ONLY_MESSAGE,
      });
  }
  if (email !== null && isAgentViewerEmail(email, viewers))
    throw new ORPCError("FORBIDDEN", {
      status: 403,
      message: AGENT_VIEWER_READ_ONLY_MESSAGE,
    });
  return await options.next();
};
