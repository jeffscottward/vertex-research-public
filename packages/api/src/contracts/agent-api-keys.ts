import { oc } from "@orpc/contract";
import { z } from "zod";

// Operator-issued agent API keys (Better Auth @better-auth/api-key). Session-only:
// a request carrying x-api-key is rejected here, so a key can never mint, list or
// revoke keys. Keys authenticate ONLY agentOps.*, papers.* and strategyLibrary.*.
// Outputs never include the stored hash; `key` on create is the plaintext value,
// returned exactly once.

// Mirrors AGENT_API_KEY_NAME_MAX / AGENT_API_KEY_PREFIX in @darkfactory/auth/types.
export const AGENT_API_KEY_NAME_MAX_LENGTH = 64;
export const AGENT_API_KEY_DISPLAY_PREFIX = "vrk_";
// read: list/get ledger, papers and backtests. write: also create and update them.
export const AGENT_API_KEY_ACCESS_LEVELS = ["read", "write"] as const;

export const AgentApiKeySchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  prefix: z.string().nullable(),
  start: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  access: z.enum(AGENT_API_KEY_ACCESS_LEVELS).nullable(),
});

export const AGENT_API_KEYS_API_ERRORS = {
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "API key not found" },
  UNAVAILABLE: { status: 503, message: "Agent API keys unavailable" },
} as const;

const keys = oc.errors(AGENT_API_KEYS_API_ERRORS);

export const AgentApiKeysListInputSchema = z.object({}).strict();
export const AgentApiKeysListOutputSchema = z.object({
  keys: z.array(AgentApiKeySchema),
});

export const AgentApiKeyCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(AGENT_API_KEY_NAME_MAX_LENGTH),
    access: z.enum(AGENT_API_KEY_ACCESS_LEVELS).default("read"),
  })
  .strict();
export const AgentApiKeyCreateOutputSchema = z.object({
  apiKey: AgentApiKeySchema,
  key: z.string().min(1),
});

export const AgentApiKeyRevokeInputSchema = z
  .object({ id: z.string().trim().min(1).max(128) })
  .strict();
export const AgentApiKeyRevokeOutputSchema = z.object({
  revoked: z.literal(true),
});

const list = keys
  .route({
    method: "GET",
    path: "/agent-api-keys",
    operationId: "agentApiKeys.list",
    summary: "List your agent API keys (name, prefix, created, last used)",
    tags: ["Agent API keys"],
  })
  .input(AgentApiKeysListInputSchema)
  .output(AgentApiKeysListOutputSchema);

const create = keys
  .route({
    method: "POST",
    path: "/agent-api-keys",
    operationId: "agentApiKeys.create",
    summary: "Issue an agent API key; the full key is returned once",
    tags: ["Agent API keys"],
  })
  .input(AgentApiKeyCreateInputSchema)
  .output(AgentApiKeyCreateOutputSchema);

const revoke = keys
  .route({
    method: "DELETE",
    path: "/agent-api-keys/{id}",
    operationId: "agentApiKeys.revoke",
    summary: "Revoke (delete) one of your agent API keys",
    tags: ["Agent API keys"],
  })
  .input(AgentApiKeyRevokeInputSchema)
  .output(AgentApiKeyRevokeOutputSchema);

export const agentApiKeysContract = { list, create, revoke };

export type AgentApiKeyOutput = z.infer<typeof AgentApiKeySchema>;
export type AgentApiKeyCreateInput = z.input<
  typeof AgentApiKeyCreateInputSchema
>;
export type AgentApiKeyCreateOutput = z.infer<
  typeof AgentApiKeyCreateOutputSchema
>;
