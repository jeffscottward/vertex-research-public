import {
  createApiClient,
  VertexModulesListOutputSchema,
  type ApiClient,
} from "@darkfactory/api";
import type { ModuleManifest } from "@darkfactory/api/vertex";
import { sinceClock } from "../portal/portfolio-monitor-model.ts";

export interface VertexReadGateway {
  readonly modules: (signal: AbortSignal) => Promise<readonly ModuleManifest[]>;
}

export type VertexFailureKind =
  | "unauthorized"
  | "denied"
  | "not-found"
  | "unavailable"
  | "invalid"
  | "malformed"
  | "error"
  | "suspended"
  | "not-configured"
  | "not-mounted"
  | "unsupported-origin"
  | "discarded"
  | "timed-out";
// Facts that a dynamic failure text needs. Each field is optional: a caller passes what it knows.
export interface VertexFailureContext {
  // Epoch milliseconds when the request timed out or expired.
  readonly at?: number;
  // Seconds the request was allowed to wait.
  readonly seconds?: number;
  // Name of the service that is not configured ("Review service").
  readonly service?: string;
}
export interface VertexFailure {
  readonly kind: VertexFailureKind;
  readonly title: string;
  readonly detail: string;
}

type DynamicFailureKind = "not-configured" | "discarded" | "timed-out";
type StaticFailureKind = Exclude<VertexFailureKind, DynamicFailureKind>;

const FAILURES: Readonly<Record<StaticFailureKind, VertexFailure>> =
  Object.freeze({
    suspended: {
      kind: "suspended",
      title: "Research reads paused",
      detail:
        "This page session ended. The page cleared previous artifacts. Reopen the workspace to verify your current session before reading again.",
    },
    unauthorized: {
      kind: "unauthorized",
      title: "Sign in again",
      detail:
        "Your session cannot authorize this request. Sign in to continue. This view does not retain the previous result.",
    },
    denied: {
      kind: "denied",
      title: "Access not granted",
      detail:
        "Your session does not have permission to read this source. Ask your administrator for access. This view does not display an artifact.",
    },
    "not-found": {
      kind: "not-found",
      title: "Record not found",
      detail:
        "The source returned no authorized record for this ID. Check the ID and collection with the source owner.",
    },
    unavailable: {
      kind: "unavailable",
      title: "Read service disconnected",
      detail:
        "The server answered 503: its read backend is not connected or failed. Nothing was read. This view does not substitute sample data. Try the read again.",
    },
    "not-mounted": {
      kind: "not-mounted",
      title: "Experience services are not connected on this page",
      detail:
        "No service provider is mounted on this page, so nothing was sent. Open the workspace from the portal navigation.",
    },
    "unsupported-origin": {
      kind: "unsupported-origin",
      title: "Reads are disabled on this page",
      detail:
        "This page is not running in a browser over http(s), so reads are disabled and nothing was sent. Open the workspace from its http(s) address.",
    },
    invalid: {
      kind: "invalid",
      title: "Check the identifier",
      detail:
        "Use 1–160 characters: letters, numbers, underscores, periods, colons, or hyphens. Start with a letter or number.",
    },
    malformed: {
      kind: "malformed",
      title: "Source verification failed",
      detail:
        "The response did not match the required format or requested ID. This view does not display it. Try again or report the issue to your administrator.",
    },
    error: {
      kind: "error",
      title: "Read failed",
      detail:
        "An unexpected response interrupted this read. This view does not show the previous result. Try again when the connection is available.",
    },
  });

const failureClock = (at: number | undefined): string =>
  sinceClock(at, Date.now()) ?? "a time that was not recorded";

const DYNAMIC_FAILURES: Readonly<
  Record<DynamicFailureKind, (context: VertexFailureContext) => VertexFailure>
> = Object.freeze({
  // Raised when a result arrives and its request is no longer current. The page cannot tell
  // which of the listed causes applied, so the text names all of them.
  discarded: ({ at }) => ({
    detail: `The result arrived at ${failureClock(at)}, when its request was no longer current: the request window ended, the tab was hidden, the browser went offline or the sign-in changed. Nothing was applied. Run the action again.`,
    kind: "discarded",
    title: "Result discarded: the request was no longer current",
  }),
  "not-configured": ({ service = "This service" }) => ({
    detail: `${service} is not configured in this deployment. Nothing was sent. Ask the operator to enable it.`,
    kind: "not-configured",
    title: `${service} not configured`,
  }),
  "timed-out": ({ at, seconds }) => ({
    detail: `The request was stopped at ${failureClock(at)} (timed out). This view shows no result. If the request was a write, its outcome is not confirmed: inspect the same request key before you repeat it.`,
    kind: "timed-out",
    title:
      seconds === undefined
        ? "No response before the deadline"
        : `No response within ${seconds}s`,
  }),
});

const isDynamic = (kind: VertexFailureKind): kind is DynamicFailureKind =>
  Object.hasOwn(DYNAMIC_FAILURES, kind);

const describeFailure = (
  kind: VertexFailureKind,
  context: VertexFailureContext
): VertexFailure =>
  isDynamic(kind) ? DYNAMIC_FAILURES[kind](context) : FAILURES[kind];

export class VertexReadError extends Error {
  readonly kind: VertexFailureKind;
  readonly context: VertexFailureContext;
  constructor(kind: VertexFailureKind, context: VertexFailureContext = {}) {
    super(describeFailure(kind, context).title);
    this.kind = kind;
    this.context = Object.freeze({ ...context });
    this.name = "VertexReadError";
  }
}

const ownValue = (error: unknown, key: string): unknown => {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(error, key)?.value;
  } catch {
    return undefined;
  }
};

export const classifyVertexFailure = (error: unknown): VertexFailure => {
  if (error instanceof VertexReadError)
    return describeFailure(error.kind, error.context);
  const code = ownValue(error, "code");
  const status = ownValue(error, "status");
  if (ownValue(error, "defined") === true) {
    if (code === "UNAUTHORIZED" && status === 401) return FAILURES.unauthorized;
    if (code === "FORBIDDEN" && status === 403) return FAILURES.denied;
    if (code === "NOT_FOUND" && status === 404) return FAILURES["not-found"];
    if (code === "BAD_REQUEST" && status === 400) return FAILURES.invalid;
    if (code === "INVALID_SOURCE" && status === 502) return FAILURES.malformed;
    if (code === "SERVICE_UNAVAILABLE" && status === 503)
      return FAILURES.unavailable;
  }
  return FAILURES.error;
};

// A UI-facing copy of any failure. It keeps the kind and the local context, never server text.
export const toVertexReadError = (error: unknown): VertexReadError =>
  error instanceof VertexReadError
    ? new VertexReadError(error.kind, error.context)
    : new VertexReadError(classifyVertexFailure(error).kind);

export const createVertexReadGateway = (
  client: Pick<ApiClient, "vertex">
): VertexReadGateway => ({
  modules: async (signal) => {
    const result: unknown = await client.vertex.modules.list({}, { signal });
    const parsed = VertexModulesListOutputSchema.safeParse(result);
    if (!parsed.success) throw new VertexReadError("malformed");
    return parsed.data;
  },
});

export const createBrowserVertexReadGateway = (): VertexReadGateway => {
  let gateway: VertexReadGateway | undefined;
  const current = (): VertexReadGateway => {
    gateway ??= createVertexReadGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return { modules: (signal) => current().modules(signal) };
};
