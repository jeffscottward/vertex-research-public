import type { StructuredEventSink } from "@darkfactory/observability/port";

// Read-only agent viewer on the Better Auth routes (owner decision 2026-11-04, card
// vertex-agent-viewer). A viewer session may sign in, read its session and sign out. Every other
// auth route (change password or email, update or delete the user, API keys, 2FA, ...) is refused
// with 403. Every viewer sign-in attempt is written to the audit sink as
// `vertex.agent-viewer.sign-in` (email, outcome, HTTP status; never the password).

const VIEWER_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email",
  "/sign-out",
  "/get-session",
]);
const AUTH_PREFIX = "/api/auth";

export type AgentViewerAuthOptions = Readonly<{
  request: Request;
  viewerEmails: readonly string[];
  // Better Auth session email for this request's cookie, or null.
  sessionEmail: () => Promise<string | null>;
  sink: StructuredEventSink;
  requestId: string;
  run: () => Promise<Response>;
}>;

const authPath = (request: Request): string =>
  new URL(request.url).pathname.replace(/^\/api\/auth/u, "");

const isViewer = (
  email: string | null,
  viewerEmails: readonly string[]
): boolean => {
  const normalized = (email ?? "").trim().toLowerCase();
  return normalized !== "" && viewerEmails.includes(normalized);
};

const signInEmail = async (request: Request): Promise<string | null> => {
  try {
    const body: unknown = await request.clone().json();
    return typeof body === "object" &&
      body !== null &&
      "email" in body &&
      typeof body.email === "string"
      ? body.email
      : null;
  } catch {
    return null;
  }
};

export const guardAgentViewerAuth = async (
  options: AgentViewerAuthOptions
): Promise<Response> => {
  const viewers = options.viewerEmails.map((entry) =>
    entry.trim().toLowerCase()
  );
  if (viewers.length === 0) return await options.run();
  const path = authPath(options.request);
  if (!VIEWER_AUTH_PATHS.has(path)) {
    if (isViewer(await options.sessionEmail(), viewers))
      return Response.json(
        { error: "Agent viewer access is read-only" },
        { status: 403 }
      );
    return await options.run();
  }
  if (path !== "/sign-in/email") return await options.run();
  const email = await signInEmail(options.request);
  const response = await options.run();
  if (email !== null && isViewer(email, viewers)) {
    // A failing sink (sync throw or rejection) never blocks the sign-in.
    await Promise.resolve()
      .then(() =>
        options.sink.emit({
          eventId: crypto.randomUUID(),
          name: "vertex.agent-viewer.sign-in",
          occurredAt: new Date().toISOString(),
          correlation: {
            requestId: options.requestId,
            route: `${AUTH_PREFIX}${path}`,
          },
          action: "sign-in",
          entityType: "agent-viewer",
          outcome: response.ok ? "success" : "failure",
          source: "web",
          attributes: {
            email: email.trim().toLowerCase(),
            status: response.status,
          },
        })
      )
      .catch(() => undefined);
  }
  return response;
};
