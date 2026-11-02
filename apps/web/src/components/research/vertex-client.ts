import {
  createApiClient,
  VertexModulesListOutputSchema,
  type ApiClient,
} from "@darkfactory/api";
import type { ModuleManifest } from "@darkfactory/api/vertex";

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
  | "suspended";
export interface VertexFailure {
  readonly kind: VertexFailureKind;
  readonly title: string;
  readonly detail: string;
}

const FAILURES: Readonly<Record<VertexFailureKind, VertexFailure>> =
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
      title: "Source unavailable",
      detail:
        "The read service is disconnected or did not respond in time. This view does not substitute sample data. Try the read again.",
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

export class VertexReadError extends Error {
  readonly kind: VertexFailureKind;
  constructor(kind: VertexFailureKind) {
    super(FAILURES[kind].title);
    this.kind = kind;
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
  if (error instanceof VertexReadError) return FAILURES[error.kind];
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
