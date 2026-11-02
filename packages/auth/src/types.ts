import type { UserRole, UserStatus } from "@darkfactory/db/schema";

export const AUTH_BASE_URL = "https://darkfactory.localhost" as const;

export const AUTHORIZATION_ERROR_CODES = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  FORBIDDEN: "FORBIDDEN",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  ACCOUNT_DEACTIVATED: "ACCOUNT_DEACTIVATED",
} as const;

export type AuthAuthorizationErrorCode =
  (typeof AUTHORIZATION_ERROR_CODES)[keyof typeof AUTHORIZATION_ERROR_CODES];

export class AuthAuthorizationError extends Error {
  readonly code: AuthAuthorizationErrorCode;
  readonly status: 401 | 403;

  constructor(code: AuthAuthorizationErrorCode, status: 401 | 403) {
    super(code);
    this.name = "AuthAuthorizationError";
    this.code = code;
    this.status = status;
  }
}

export type SafeAuthUser = Readonly<{
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  role: UserRole;
  status: UserStatus;
}>;

export type SafeSessionRecord = Readonly<{
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}>;

export type SafePrincipal = Readonly<{
  userId: string;
  role: UserRole;
  status: UserStatus;
}>;

export type SafeAuthSession = Readonly<{
  user: SafeAuthUser;
  session: SafeSessionRecord;
  principal: SafePrincipal;
}>;

// Agent API keys (@better-auth/api-key). Keys authenticate ONLY the agent
// ledger (oRPC agentOps.* and papers.*); every other procedure rejects them.
export const AGENT_API_KEY_HEADER = "x-api-key" as const;
export const AGENT_API_KEY_PREFIX = "vrk_" as const;
export const AGENT_API_KEY_NAME_MAX = 64;
// Key access levels, stored on every key this app issues and required on
// verification, so keys created any other way never authenticate the ledger.
// A write key also reads. Keys issued before access levels existed carry only
// ["write"] and stay write keys.
export const AGENT_API_KEY_ACCESS_VALUES = ["read", "write"] as const;
export type AgentApiKeyAccess = (typeof AGENT_API_KEY_ACCESS_VALUES)[number];
export const AGENT_API_KEY_PERMISSIONS: Readonly<Record<string, string[]>> =
  Object.freeze({ agentLedger: ["read", "write"] });
export const AGENT_API_KEY_READ_PERMISSIONS: Readonly<
  Record<string, string[]>
> = Object.freeze({ agentLedger: ["read"] });

const parsePermissions = (permissions: unknown): unknown => {
  if (typeof permissions !== "string") return permissions;
  try {
    return JSON.parse(permissions);
  } catch {
    return null;
  }
};

// Derives the access level from the stored permission map (object or JSON text).
// Returns null when the key carries no agentLedger permission.
export const agentApiKeyAccessFrom = (
  permissions: unknown
): AgentApiKeyAccess | null => {
  const value = parsePermissions(permissions);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const actions: unknown = Reflect.get(value, "agentLedger");
  if (!Array.isArray(actions)) return null;
  if (actions.includes("write")) return "write";
  if (actions.includes("read")) return "read";
  return null;
};

export class AgentApiKeyRateLimitedError extends Error {
  constructor() {
    super("AGENT_API_KEY_RATE_LIMITED");
    this.name = "AgentApiKeyRateLimitedError";
  }
}

// Owner facts are read at request time so the operator allow-list and email
// verification are re-checked on every key use (see oRPC requireOperator).
export type AgentApiKeyPrincipal = SafePrincipal &
  Readonly<{
    apiKeyId: string;
    email: string;
    emailVerified: boolean;
    access: AgentApiKeyAccess;
  }>;

// Display-safe record. Never carries the plaintext key or its hash.
export type AgentApiKeyRecord = Readonly<{
  id: string;
  name: string | null;
  prefix: string | null;
  start: string | null;
  enabled: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  access: AgentApiKeyAccess | null;
}>;

export type CreatedAgentApiKey = Readonly<{
  record: AgentApiKeyRecord;
  // Plaintext key, returned exactly once at creation.
  key: string;
}>;

// Request-header-bound port. authenticate() reads only the x-api-key header;
// list/create/revoke require an active browser session on the same headers.
export type AgentApiKeyService = Readonly<{
  authenticate: (headers: Headers) => Promise<AgentApiKeyPrincipal>;
  list: (headers: Headers) => Promise<AgentApiKeyRecord[]>;
  create: (
    headers: Headers,
    input: Readonly<{ name: string; access?: AgentApiKeyAccess | undefined }>
  ) => Promise<CreatedAgentApiKey>;
  revoke: (headers: Headers, id: string) => Promise<boolean>;
}>;

export type { UserRole, UserStatus } from "@darkfactory/db/schema";
