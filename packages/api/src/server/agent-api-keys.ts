import { AuthAuthorizationError } from "@darkfactory/auth/server";
import type { AgentApiKeyRecord } from "@darkfactory/auth/types";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { AgentApiKeyOutput } from "../contracts/agent-api-keys.ts";
import type { ApiAgentApiKeys, ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Session-only, operator-only key management. A request carrying x-api-key is
// refused here as well as by the handler scope interceptor, so a key can never
// manage keys; the session user must pass requireOperator (allow-list).
// The plaintext key is only ever in the create response; nothing here logs it.

const api = implement(appContract).$context<ApiContext>();

type AgentApiKeysErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "UNAVAILABLE";
type AgentApiKeysErrorFactories = Readonly<
  Record<AgentApiKeysErrorCode, (options?: { message?: string }) => Error>
>;

const factories = (errors: unknown): AgentApiKeysErrorFactories => {
  return errors as AgentApiKeysErrorFactories;
};

const mapAuthError = (error: unknown, errors: unknown): never => {
  if (!(error instanceof AuthAuthorizationError)) throw error;
  if (error.status === 401) throw factories(errors).UNAUTHORIZED();
  throw factories(errors).FORBIDDEN();
};

const refuseApiKeyRequests = api.middleware(
  async ({ context, next, errors }) => {
    if (context.agentApiKeyPresented === true) {
      throw factories(errors).FORBIDDEN({
        message: "API keys cannot manage API keys",
      });
    }
    return await next({});
  }
);

const keysFor = (context: ApiContext, errors: unknown): ApiAgentApiKeys => {
  const service = context.agentApiKeys;
  if (service === undefined) throw factories(errors).UNAVAILABLE();
  return service;
};

const toAgentApiKeyOutput = (record: AgentApiKeyRecord): AgentApiKeyOutput => ({
  id: record.id,
  name: record.name,
  prefix: record.prefix,
  start: record.start,
  enabled: record.enabled,
  createdAt: record.createdAt,
  lastUsedAt: record.lastUsedAt,
  expiresAt: record.expiresAt,
  access: record.access ?? null,
});

const agentApiKeysList = api.agentApiKeys.list
  .use(refuseApiKeyRequests)
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const service = keysFor(context, errors);
    try {
      return { keys: (await service.list()).map(toAgentApiKeyOutput) };
    } catch (error) {
      return mapAuthError(error, errors);
    }
  });

const agentApiKeysCreate = api.agentApiKeys.create
  .use(refuseApiKeyRequests)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const service = keysFor(context, errors);
    try {
      const created = await service.create({
        name: input.name,
        access: input.access,
      });
      return { apiKey: toAgentApiKeyOutput(created.record), key: created.key };
    } catch (error) {
      return mapAuthError(error, errors);
    }
  });

const agentApiKeysRevoke = api.agentApiKeys.revoke
  .use(refuseApiKeyRequests)
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const service = keysFor(context, errors);
    let revoked: boolean;
    try {
      revoked = await service.revoke(input.id);
    } catch (error) {
      return mapAuthError(error, errors);
    }
    if (!revoked) throw factories(errors).NOT_FOUND();
    return { revoked: true as const };
  });

export const agentApiKeysRouter = {
  list: agentApiKeysList,
  create: agentApiKeysCreate,
  revoke: agentApiKeysRevoke,
};
