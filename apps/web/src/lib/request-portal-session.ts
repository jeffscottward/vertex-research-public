import { parseOperatorEmails } from "@darkfactory/config/server";
import { headers } from "next/headers";

import { dispatchInternalAuthRequest } from "./server-internal-dispatch.ts";
import { getPortalSession, type PortalSession } from "./server-session.ts";

/** VERTEX_OPERATOR_EMAILS for the portal session; an invalid list fails closed (no operators). */
export const portalOperatorEmails = (
  source: Readonly<Record<string, string | undefined>> = process.env
): readonly string[] =>
  parseOperatorEmails(source["VERTEX_OPERATOR_EMAILS"]) ?? [];

/*
 * vinext calls each layout twice per request: a probe pass and then the render
 * (same cause as server-theme.ts#loadTrustedThemeOncePerRequest). React
 * `cache()` does not span the probe, so each portal page opened two request
 * DB scopes for one session check. `headers()` returns one object per request,
 * so keying on it shares one check inside a request and never across requests;
 * a failed check stays with its request.
 */
const sessionChecks = new WeakMap<
  object,
  Map<string, Promise<PortalSession | null>>
>();

export const getRequestPortalSession = async (
  cookieHeader: string | null,
  cfConnectingIp: string | null
): Promise<PortalSession | null> => {
  const requestKey = await headers();
  let checks = sessionChecks.get(requestKey);
  if (checks === undefined) {
    checks = new Map();
    sessionChecks.set(requestKey, checks);
  }
  const inputKey = JSON.stringify([cookieHeader, cfConnectingIp]);
  const pending = checks.get(inputKey);
  if (pending !== undefined) return pending;
  const started = getPortalSession({
    cookieHeader,
    cfConnectingIp,
    fetch: dispatchInternalAuthRequest,
    operatorEmails: portalOperatorEmails(),
  });
  checks.set(inputKey, started);
  return started;
};
