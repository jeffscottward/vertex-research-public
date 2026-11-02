import {
  handleMcpHttp,
  procedureResultFromResponse,
  type CallProcedure,
} from "@darkfactory/api/server";

import { dispatchInternalOrpcRequest } from "../../../lib/server-internal-dispatch.ts";
import { resolvePortalAppUrl } from "../../../lib/server-session.ts";

// MCP endpoint for agents. Each tool call is an internal oRPC request carrying the
// caller's agent API key, so operator checks, key access level and validation are
// enforced by the existing procedures; this route adds no authority of its own.
const callerFor =
  (appOrigin: string) =>
  (apiKey: string): CallProcedure =>
  async (procedure, input) => {
    const response = await dispatchInternalOrpcRequest(
      new Request(`${appOrigin}/api/orpc/${procedure}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          origin: appOrigin,
        },
        body: JSON.stringify({ json: input }),
      })
    );
    return procedureResultFromResponse(response);
  };

const handle = (request: Request): Promise<Response> => {
  const appOrigin = resolvePortalAppUrl().origin;
  return handleMcpHttp(request, { appOrigin, callerFor: callerFor(appOrigin) });
};

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
