// What: oRPC implementation of appContract: binds each procedure to feature, account, theme and contact services,
// plus the Vertex research surface (vertex.*, vertexWorker.*, agentOps.*, papers.*, agentApiKeys.*,
// strategyLibrary.*, deploymentRequests.*, marketData.*, optionsAnalytics.*, jevVerdict.*, optionsChain.*, instantBacktest.*, backtestRuns.*, autopilot.*, researchLenses.*, watchlist.*, baskets.*, pickLists.*, assistant.*).
// Used by: packages/api/src/server/handler.ts, packages/api/src/server/index.ts (appRouter).
// See: packages/api/src/contract.ts#appContract; docs/getting-started.md#add-your-first-feature.
import {
  AuthAuthorizationError,
  type SafeAuthSession,
  type SafePrincipal,
} from "@darkfactory/auth/server";
import type { Address, FeatureItem } from "@darkfactory/db/schema";
import type {
  EventOutcome,
  SemanticEvent,
} from "@darkfactory/observability/port";
import { implement } from "@orpc/server";
import type { z } from "zod";

import {
  appContract,
  type ContactSubmitInput,
  type ContactSubmitOutput,
  type FeatureItemInput,
  type ThemePreferenceOutput,
} from "../contract.ts";
import type {
  ReadModelPrivacyReviewRequestOutputSchema,
  ReadNativeModelPrivacyReviewRequestOutputSchema,
} from "../contracts/vertex-model-privacy-rendezvous.ts";
import { VertexResearchChatErrors } from "../contracts/vertex-research-chat.ts";
import {
  VERTEX_WORKER_SERVICE_ERRORS,
  type VertexWorkerMethod,
  type VertexWorkerOutput,
  type VertexWorkerServiceErrorCode,
} from "../contracts/vertex-worker-rpc.ts";
import { generatedFeatureRouters } from "../generated/router-registry.ts";
import { academyRouter } from "./academy.ts";
import {
  AccountServiceError,
  type AccountServiceErrorCode,
  createAccountService,
} from "./account-service.ts";
import {
  AdminUsersServiceError,
  type AdminUsersServiceErrorCode,
  createAdminUsersService,
} from "./admin-users-service.ts";
import { agentApiKeysRouter } from "./agent-api-keys.ts";
import { agentModelRunsRouter } from "./agent-model-runs.ts";
import { agentOpsRouter, papersRouter } from "./agent-ops.ts";
import { assistantRouter } from "./assistant.ts";
import { autopilotRouter } from "./autopilot.ts";
import { backtestRunEngineRouter } from "./backtest-run-engine.ts";
import { backtestRunsRouter } from "./backtest-runs.ts";
import { basketsRouter } from "./baskets.ts";
import { clickLogRouter } from "./click-log.ts";
import { congressTradesRouter } from "./congress-trades.ts";
import {
  ContactServiceError,
  type ContactServiceErrorCode,
  createContactService,
} from "./contact-service.ts";
import type { ApiContext } from "./context.ts";
import {
  createDashboardService,
  DashboardServiceError,
  type DashboardServiceErrorCode,
} from "./dashboard-service.ts";
import { deploymentRequestsRouter } from "./deployment-requests.ts";
import { engineComparisonsRouter } from "./engine-comparison.ts";
import { enginesRouter } from "./engines.ts";
import { flowRouter } from "./flow.ts";
import { forwardDriftRouter } from "./forward-drift.ts";
import { ibkrMonitorRouter } from "./ibkr-monitor.ts";
import { ibkrRecoveryRouter } from "./ibkr-recovery.ts";
import { instantBacktestRouter } from "./instant-backtest.ts";
import { jevVerdictRouter } from "./jev-verdict.ts";
import { marketContextRouter } from "./market-context.ts";
import { marketDataRouter } from "./market-data.ts";
import { marketNewsRouter } from "./market-news.ts";
import { nautilusArmRouter } from "./nautilus-arm.ts";
import { optimizationsRouter } from "./optimizations.ts";
import { optionsAnalyticsRouter } from "./options-analytics.ts";
import { optionsChainRouter } from "./options-chain.ts";
import { pickListsRouter } from "./pick-lists.ts";
import { playsRouter } from "./plays.ts";
import { portfolioMonitorRouter } from "./portfolio-monitor.ts";
import { priceAlertsRouter } from "./price-alerts.ts";
import { quantLabRouter } from "./quant-lab.ts";
import { researchLensesRouter } from "./research-lenses.ts";
import { researchReportsRouter } from "./research-reports.ts";
import { researchStudiesRouter } from "./research-studies.ts";
import { riskAllocatorRouter } from "./risk-allocator.ts";
import { sectorRotationRouter } from "./sector-rotation.ts";
import {
  createFeatureItemService,
  createThemePreferenceService,
  FeatureServiceError,
  type FeatureServiceErrorCode,
  ThemePreferenceServiceError,
  type ThemePreferenceServiceErrorCode,
} from "./service.ts";
import { setupReplayRouter } from "./setup-replay.ts";
import { strategyDefinitionsRouter } from "./strategy-definitions.ts";
import { strategyLibraryRouter } from "./strategy-library.ts";
import { todosRouter } from "./todos.ts";
import { createVertexChartReadService } from "./vertex-chart-service.ts";
import {
  type VertexExperienceErrorCode,
  VertexExperienceServiceError,
} from "./vertex-experience-core.ts";
import { createVertexExperienceService } from "./vertex-experience-service.ts";
import { VertexLocalSetupError } from "./vertex-local-setup.ts";
import { vertexOrdersRouter } from "./vertex-orders.ts";
import {
  appendResearchChatResponse,
  approveAndRequestResearchChatDebateStep,
  approveAndRequestResearchChatNativeEvidence,
  approveAndRequestResearchChatResponse,
  createResearchChatThread,
  getResearchChatRoster,
  listResearchChatMessages,
  listResearchChatThreads,
  prepareResearchChatDebateStep,
  prepareResearchChatNativeEvidence,
  prepareResearchChatResponse,
  readResearchChatCopyCleanup,
  readResearchChatDebateRun,
  readResearchChatResponse,
  readResearchChatResponseContent,
  readResearchChatThread,
  readResearchChatTranscriptPage,
  requestResearchChatCopyCleanup,
  requestResearchChatResponse,
  sendResearchChatMessage,
} from "./vertex-research-chat.ts";
import {
  createVertexReadService,
  VertexReadServiceError,
  type VertexReadServiceErrorCode,
} from "./vertex-service.ts";
import { VertexWorkerServiceError } from "./vertex-worker-auth.ts";
import { createVertexWorkerService } from "./vertex-worker-service.ts";
import { watchlistRouter } from "./watchlist.ts";

const api = implement(appContract).$context<ApiContext>();

type ExpectedErrorFactories = Record<
  FeatureServiceErrorCode,
  (options?: { message?: string }) => Error
>;

const mapFeatureServiceError = (
  error: unknown,
  errors: ExpectedErrorFactories
): never => {
  if (!(error instanceof FeatureServiceError)) throw error;
  throw errors[error.code]({ message: error.message });
};
type ThemeExpectedErrorFactories = Record<
  ThemePreferenceServiceErrorCode,
  (options?: { message?: string }) => Error
>;

const mapThemePreferenceServiceError = (
  error: unknown,
  errors: ThemeExpectedErrorFactories
): never => {
  if (!(error instanceof ThemePreferenceServiceError)) throw error;
  throw errors[error.code]({ message: error.message });
};

const toContractItem = (item: FeatureItem): FeatureItemInput => {
  return item as unknown as FeatureItemInput;
};

const toContractItems = (items: FeatureItem[]): FeatureItemInput[] => {
  return items as unknown as FeatureItemInput[];
};

type ServiceErrorFactories<Code extends string> = Record<
  Code,
  (options?: { message?: string }) => Error
>;

const mapAccountServiceError = (
  error: unknown,
  errors: ServiceErrorFactories<AccountServiceErrorCode>
): never => {
  if (!(error instanceof AccountServiceError)) throw error;
  throw errors[error.code]({ message: error.message });
};

const mapAdminUsersServiceError = (
  error: unknown,
  errors: ServiceErrorFactories<AdminUsersServiceErrorCode>
): never => {
  if (!(error instanceof AdminUsersServiceError)) throw error;
  throw errors[error.code]({ message: error.message });
};

const mapDashboardServiceError = (
  error: unknown,
  errors: ServiceErrorFactories<DashboardServiceErrorCode>
): never => {
  if (!(error instanceof DashboardServiceError)) throw error;
  throw errors[error.code]({ message: error.message });
};

const mapContactServiceError = (
  error: unknown,
  errors: ServiceErrorFactories<ContactServiceErrorCode>
): never => {
  if (!(error instanceof ContactServiceError)) throw error;
  throw errors[error.code]({ message: error.message });
};

const emitContactSubmittedEvent = async (
  context: ApiContext,
  input: ContactSubmitInput,
  result: ContactSubmitOutput
): Promise<void> => {
  if (context.semanticEvents === undefined) return;
  try {
    const event: SemanticEvent = {
      action: "submit",
      attributes: {
        delivered: result.status === "sent",
        honeypot: Boolean(input.website?.trim()),
        previewed: result.status === "previewed",
        sent: result.status === "sent",
      },
      correlation: {
        ...(context.span?.correlation ?? {}),
        procedure: "contact.submit",
        requestId: context.requestId,
        route: "/api/orpc/contact/submit",
      },
      entityType: "contact-request",
      eventId: crypto.randomUUID(),
      name: "contact.submitted",
      occurredAt: new Date().toISOString(),
      outcome: result.status === "not-delivered" ? "failure" : "success",
      source: "api",
    };
    await context.semanticEvents.emit(event, {
      ...(context.span === undefined ? {} : { span: context.span }),
      ...(context.waitUntil === undefined
        ? {}
        : { waitUntil: context.waitUntil }),
    });
  } catch {
    // Contact observability is best-effort and never exposes submission fields.
  }
};

const toContractAddress = (address: Address) => ({
  city: address.city,
  country: address.country,
  createdAt: address.createdAt,
  id: address.id,
  isPrimary: address.isPrimary,
  line1: address.line1,
  line2: address.line2,
  postalCode: address.postalCode,
  region: address.region,
  type: address.type,
  updatedAt: address.updatedAt,
});

type AccountMutationEventSpec = Readonly<{
  name:
    | "account.profile.updated"
    | "account.address.created"
    | "account.address.updated"
    | "account.address.removed"
    | "account.address.primary-set"
    | "user-preferences.updated";
  procedure:
    | "account.profile.update"
    | "account.addresses.create"
    | "account.addresses.update"
    | "account.addresses.remove"
    | "account.addresses.setPrimary"
    | "preferences.update";
  action: "update" | "create" | "remove" | "set-primary";
  entityType: "profile" | "address" | "user-preferences";
  entityId?: string;
}>;

const emitAccountMutationEvent = async (
  context: ApiContext,
  principal: SafePrincipal,
  spec: AccountMutationEventSpec
): Promise<void> => {
  if (context.semanticEvents === undefined) return;
  try {
    const event: SemanticEvent = {
      action: spec.action,
      correlation: {
        ...(context.span?.correlation ?? {}),
        actorId: principal.userId,
        procedure: spec.procedure,
        requestId: context.requestId,
        route: `/api/orpc/${spec.procedure.replaceAll(".", "/")}`,
      },
      entityType: spec.entityType,
      eventId: crypto.randomUUID(),
      name: spec.name,
      occurredAt: new Date().toISOString(),
      ...(spec.entityId === undefined ? {} : { entityId: spec.entityId }),
      attributes: { actorRole: principal.role },
      outcome: "success",
      source: "api",
    };
    await context.semanticEvents.emit(event, {
      ...(context.span === undefined ? {} : { span: context.span }),
      ...(context.waitUntil === undefined
        ? {}
        : { waitUntil: context.waitUntil }),
    });
  } catch {
    // Observability is best-effort and never changes successful account mutations.
  }
};
type MutationEventSpec = Readonly<{
  name:
    | "feature-item.created"
    | "feature-item.updated"
    | "feature-item.archived";
  procedure:
    | "featureItems.create"
    | "featureItems.update"
    | "featureItems.changeStatus"
    | "featureItems.archive";
  route:
    | "/api/orpc/featureItems/create"
    | "/api/orpc/featureItems/update"
    | "/api/orpc/featureItems/changeStatus"
    | "/api/orpc/featureItems/archive";
  action: "create" | "update" | "change-status" | "archive";
  entityId?: string;
}>;

const mutationErrorCategory = (error: unknown): string => {
  return error instanceof FeatureServiceError
    ? error.code.toLowerCase()
    : "unexpected";
};

const emitMutationEvent = async (
  context: ApiContext,
  principal: SafePrincipal,
  spec: MutationEventSpec,
  outcome: EventOutcome,
  entityId: string | undefined,
  error?: unknown
): Promise<void> => {
  try {
    if (context.semanticEvents === undefined) return;
    const event: SemanticEvent = {
      action: spec.action,
      correlation: {
        ...(context.span?.correlation ?? {}),
        actorId: principal.userId,
        procedure: spec.procedure,
        requestId: context.requestId,
        route: spec.route,
      },
      eventId: crypto.randomUUID(),
      name: spec.name,
      occurredAt: new Date().toISOString(),
      ...(entityId === undefined ? {} : { entityId }),
      entityType: "feature-item",
      outcome,
      source: "api",
      ...(error === undefined
        ? {}
        : { errorCategory: mutationErrorCategory(error) }),
      attributes: { actorRole: principal.role },
    };
    await context.semanticEvents.emit(event, {
      ...(context.span === undefined ? {} : { span: context.span }),
      ...(context.waitUntil === undefined
        ? {}
        : { waitUntil: context.waitUntil }),
    });
  } catch {
    // Observability is best-effort and must not affect domain mutation results.
  }
};

const runMutation = async (
  context: ApiContext,
  principal: SafePrincipal,
  spec: MutationEventSpec,
  operation: () => Promise<FeatureItem>
): Promise<FeatureItem> => {
  try {
    const item = await operation();
    await emitMutationEvent(context, principal, spec, "success", item.id);
    return item;
  } catch (error) {
    await emitMutationEvent(
      context,
      principal,
      spec,
      "failure",
      spec.entityId,
      error
    );
    throw error;
  }
};

const emitThemeUpdateEvent = async (
  context: ApiContext,
  principal: SafePrincipal,
  outcome: EventOutcome,
  error?: unknown
): Promise<void> => {
  try {
    if (context.semanticEvents === undefined) return;
    const event: SemanticEvent = {
      action: "update",
      correlation: {
        ...(context.span?.correlation ?? {}),
        actorId: principal.userId,
        procedure: "preferences.theme.update",
        requestId: context.requestId,
        route: "/api/orpc/preferences/theme/update",
      },
      entityType: "user-preferences",
      eventId: crypto.randomUUID(),
      name: "user-preferences.theme-updated",
      occurredAt: new Date().toISOString(),
      outcome,
      source: "api",
      ...(error === undefined
        ? {}
        : {
            errorCategory:
              error instanceof ThemePreferenceServiceError
                ? error.code.toLowerCase()
                : "unexpected",
          }),
      attributes: { actorRole: principal.role },
    };
    await context.semanticEvents.emit(event, {
      ...(context.span === undefined ? {} : { span: context.span }),
      ...(context.waitUntil === undefined
        ? {}
        : { waitUntil: context.waitUntil }),
    });
  } catch {
    // Observability is best-effort and must not affect preference persistence.
  }
};

const runThemeUpdate = async (
  context: ApiContext,
  principal: SafePrincipal,
  operation: () => Promise<ThemePreferenceOutput>
): Promise<ThemePreferenceOutput> => {
  try {
    const preference = await operation();
    await emitThemeUpdateEvent(context, principal, "success");
    return preference;
  } catch (error) {
    await emitThemeUpdateEvent(context, principal, "failure", error);
    throw error;
  }
};

type AuthorizationErrorFactories = Readonly<{
  UNAUTHORIZED: (options?: { message?: string }) => Error;
  FORBIDDEN: (options?: { message?: string }) => Error;
}>;

const authorizationErrors = (errors: unknown): AuthorizationErrorFactories => {
  return errors as AuthorizationErrorFactories;
};

const requireAuthenticated = api.middleware(
  async ({ context, next, errors }) => {
    const authErrors = authorizationErrors(errors);
    try {
      const session = await context.requireSession();
      return next({
        context: {
          authSession: session,
          principal: session.principal,
        },
      });
    } catch (error) {
      if (!(error instanceof AuthAuthorizationError)) throw error;
      if (error.status === 401) {
        throw authErrors.UNAUTHORIZED();
      }
      throw authErrors.FORBIDDEN();
    }
  }
);

// Operator gate for agentOps.*, papers.*, agentApiKeys.* and the other Vertex
// operator routers (VERTEX_OPERATOR_EMAILS allow-list; fail closed) lives in
// operator-access.ts and is applied inside each of those routers.

const requireAdmin = api.middleware(async ({ context, next, errors }) => {
  const authErrors = authorizationErrors(errors);
  try {
    const session = await context.requireRole("admin");
    return next({ context: { principal: session.principal } });
  } catch (error) {
    if (!(error instanceof AuthAuthorizationError)) throw error;
    if (error.status === 401) {
      throw authErrors.UNAUTHORIZED();
    }
    throw authErrors.FORBIDDEN();
  }
});

const list = api.featureItems.list
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return toContractItems(
        await createFeatureItemService(context.repositories.featureItems).list(
          context.principal,
          input
        )
      );
    } catch (error) {
      return mapFeatureServiceError(error, errors);
    }
  });

const get = api.featureItems.get
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return toContractItem(
        await createFeatureItemService(context.repositories.featureItems).get(
          context.principal,
          input
        )
      );
    } catch (error) {
      return mapFeatureServiceError(error, errors);
    }
  });

const create = api.featureItems.create
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const service = createFeatureItemService(
        context.repositories.featureItems
      );
      return toContractItem(
        await runMutation(
          context,
          context.principal,
          {
            action: "create",
            name: "feature-item.created",
            procedure: "featureItems.create",
            route: "/api/orpc/featureItems/create",
          },
          () => service.create(context.principal, input, context.requestId)
        )
      );
    } catch (error) {
      return mapFeatureServiceError(error, errors);
    }
  });

const update = api.featureItems.update
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const service = createFeatureItemService(
        context.repositories.featureItems
      );
      return toContractItem(
        await runMutation(
          context,
          context.principal,
          {
            action: "update",
            entityId: input.id,
            name: "feature-item.updated",
            procedure: "featureItems.update",
            route: "/api/orpc/featureItems/update",
          },
          () => service.update(context.principal, input, context.requestId)
        )
      );
    } catch (error) {
      return mapFeatureServiceError(error, errors);
    }
  });

const changeStatus = api.featureItems.changeStatus
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const service = createFeatureItemService(
        context.repositories.featureItems
      );
      return toContractItem(
        await runMutation(
          context,
          context.principal,
          {
            action: "change-status",
            entityId: input.id,
            name: "feature-item.updated",
            procedure: "featureItems.changeStatus",
            route: "/api/orpc/featureItems/changeStatus",
          },
          () =>
            service.changeStatus(context.principal, input, context.requestId)
        )
      );
    } catch (error) {
      return mapFeatureServiceError(error, errors);
    }
  });

const archive = api.featureItems.archive
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const service = createFeatureItemService(
        context.repositories.featureItems
      );
      return toContractItem(
        await runMutation(
          context,
          context.principal,
          {
            action: "archive",
            entityId: input.id,
            name: "feature-item.archived",
            procedure: "featureItems.archive",
            route: "/api/orpc/featureItems/archive",
          },
          () => service.archive(context.principal, input, context.requestId)
        )
      );
    } catch (error) {
      return mapFeatureServiceError(error, errors);
    }
  });

const adminList = api.admin.featureItems.list
  .use(requireAdmin)
  .handler(async ({ context, input, errors }) => {
    try {
      return toContractItems(
        await createFeatureItemService(context.repositories.featureItems).list(
          context.principal,
          input
        )
      );
    } catch (error) {
      return mapFeatureServiceError(error, errors);
    }
  });

const themeGet = api.preferences.theme.get
  .use(requireAuthenticated)
  .handler(async ({ context, errors }) => {
    try {
      return await createThemePreferenceService(
        context.repositories.userPreferences
      ).get(context.principal);
    } catch (error) {
      return mapThemePreferenceServiceError(error, errors);
    }
  });

const themeUpdate = api.preferences.theme.update
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const service = createThemePreferenceService(
        context.repositories.userPreferences
      );
      const operation = (): Promise<ThemePreferenceOutput> => {
        return service.update(context.principal, input);
      };
      return await runThemeUpdate(context, context.principal, operation);
    } catch (error) {
      return mapThemePreferenceServiceError(error, errors);
    }
  });

const accountProfileGet = api.account.profile.get
  .use(requireAuthenticated)
  .handler(async ({ context, errors }) => {
    try {
      return await createAccountService(context.repositories).getProfile(
        context.authSession
      );
    } catch (error) {
      return mapAccountServiceError(error, errors);
    }
  });

const accountProfileUpdate = api.account.profile.update
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const result = await createAccountService(
        context.repositories
      ).updateProfile(context.authSession, input);
      await emitAccountMutationEvent(context, context.principal, {
        action: "update",
        entityType: "profile",
        name: "account.profile.updated",
        procedure: "account.profile.update",
      });
      return result;
    } catch (error) {
      return mapAccountServiceError(error, errors);
    }
  });

const accountAddressesList = api.account.addresses.list
  .use(requireAuthenticated)
  .handler(async ({ context, errors }) => {
    try {
      const addresses = await createAccountService(
        context.repositories
      ).listAddresses(context.principal);
      return addresses.map(toContractAddress);
    } catch (error) {
      return mapAccountServiceError(error, errors);
    }
  });

const accountAddressesCreate = api.account.addresses.create
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const address = await createAccountService(
        context.repositories
      ).createAddress(context.principal, input);
      await emitAccountMutationEvent(context, context.principal, {
        action: "create",
        entityId: address.id,
        entityType: "address",
        name: "account.address.created",
        procedure: "account.addresses.create",
      });
      return toContractAddress(address);
    } catch (error) {
      return mapAccountServiceError(error, errors);
    }
  });

const accountAddressesUpdate = api.account.addresses.update
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const address = await createAccountService(
        context.repositories
      ).updateAddress(context.principal, input);
      await emitAccountMutationEvent(context, context.principal, {
        action: "update",
        entityId: address.id,
        entityType: "address",
        name: "account.address.updated",
        procedure: "account.addresses.update",
      });
      return toContractAddress(address);
    } catch (error) {
      return mapAccountServiceError(error, errors);
    }
  });

const accountAddressesRemove = api.account.addresses.remove
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const result = await createAccountService(
        context.repositories
      ).removeAddress(context.principal, input);
      await emitAccountMutationEvent(context, context.principal, {
        action: "remove",
        entityId: input.id,
        entityType: "address",
        name: "account.address.removed",
        procedure: "account.addresses.remove",
      });
      return result;
    } catch (error) {
      return mapAccountServiceError(error, errors);
    }
  });

const accountAddressesSetPrimary = api.account.addresses.setPrimary
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const address = await createAccountService(
        context.repositories
      ).setPrimaryAddress(context.principal, input);
      await emitAccountMutationEvent(context, context.principal, {
        action: "set-primary",
        entityId: address.id,
        entityType: "address",
        name: "account.address.primary-set",
        procedure: "account.addresses.setPrimary",
      });
      return toContractAddress(address);
    } catch (error) {
      return mapAccountServiceError(error, errors);
    }
  });

const preferencesGet = api.preferences.get
  .use(requireAuthenticated)
  .handler(async ({ context, errors }) => {
    try {
      return await createAccountService(context.repositories).getPreferences(
        context.principal
      );
    } catch (error) {
      return mapAccountServiceError(error, errors);
    }
  });

const preferencesUpdate = api.preferences.update
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      const result = await createAccountService(
        context.repositories
      ).updatePreferences(context.principal, input);
      await emitAccountMutationEvent(context, context.principal, {
        action: "update",
        entityType: "user-preferences",
        name: "user-preferences.updated",
        procedure: "preferences.update",
      });
      return result;
    } catch (error) {
      return mapAccountServiceError(error, errors);
    }
  });

const contactSubmit = api.contact.submit.handler(
  async ({ context, input, errors }) => {
    try {
      if (
        context.contactDelivery === undefined ||
        context.contactThrottle === undefined ||
        context.contactThrottleKey === undefined
      ) {
        throw new ContactServiceError("SERVICE_UNAVAILABLE");
      }
      const result = await createContactService({
        delivery: context.contactDelivery,
        throttle: context.contactThrottle,
        throttleKey: context.contactThrottleKey,
      }).submit(input);
      await emitContactSubmittedEvent(context, input, result);
      return result;
    } catch (error) {
      return mapContactServiceError(error, errors);
    }
  }
);

const adminUsersList = api.admin.users.list
  .use(requireAdmin)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createAdminUsersService(
        context.repositories.adminUsers
      ).list(input);
    } catch (error) {
      return mapAdminUsersServiceError(error, errors);
    }
  });

const dashboardSummary = api.dashboard.summary
  .use(requireAuthenticated)
  .handler(async ({ context, errors }) => {
    try {
      const summary = await createDashboardService(
        context.repositories.dashboard,
        context.capabilities
      ).summary(context.principal);
      return {
        ...summary,
        featureItems: {
          ...summary.featureItems,
          recent: toContractItems(summary.featureItems.recent),
        },
        session: {
          expiresAt: context.authSession.session.expiresAt,
          name: context.authSession.user.name,
          role: context.authSession.principal.role,
          status: "active",
          userId: context.authSession.principal.userId,
        },
      };
    } catch (error) {
      return mapDashboardServiceError(error, errors);
    }
  });

const mapVertexReadServiceError = (
  error: unknown,
  errors: ServiceErrorFactories<VertexReadServiceErrorCode>
): never => {
  if (!(error instanceof VertexReadServiceError)) throw error;
  throw errors[error.code]({ message: error.message });
};

const vertexModulesList = api.vertex.modules.list
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexReadService(context.vertexRead).listModules(
        context.principal,
        input
      );
    } catch (error) {
      return mapVertexReadServiceError(error, errors);
    }
  });

const mapVertexExperienceError = (
  error: unknown,
  errors: ServiceErrorFactories<VertexExperienceErrorCode>
): never => {
  if (!(error instanceof VertexExperienceServiceError)) throw error;
  throw errors[error.code]({ message: error.message });
};

type ResearchChatErrorCode = keyof typeof VertexResearchChatErrors;

const isResearchChatErrorCode = (code: string): code is ResearchChatErrorCode =>
  Object.hasOwn(VertexResearchChatErrors, code);

const mapResearchChatError = (
  error: unknown,
  errors: ServiceErrorFactories<ResearchChatErrorCode>
): never => {
  if (
    !(
      error instanceof VertexExperienceServiceError &&
      isResearchChatErrorCode(error.code)
    )
  ) {
    throw errors.SERVICE_UNAVAILABLE();
  }
  // Chat uses the same typed keys, but never inherits another feature's text.
  throw errors[error.code]();
};

// Request-bound experience dependencies; the abort signal always comes from the
// actual request, never from caller input.
const researchChatDependencies = (context: ApiContext) => ({
  ...context.vertexExperience,
  ...(context.signal === undefined ? {} : { signal: context.signal }),
});

const researchChatReadModelPrivacyReviewRequest =
  api.vertex.researchChat.readModelPrivacyReviewRequest
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      if (!context.vertexModelPrivacyReviewer) {
        throw errors.SERVICE_UNAVAILABLE();
      }
      if (context.principal.status !== "active") throw errors.FORBIDDEN();
      try {
        // Deep-frozen service output; oRPC re-validates it against the contract schema.
        return (await context.vertexModelPrivacyReviewer.readModelPrivacyReviewRequest(
          { actorId: context.principal.userId },
          input
        )) as z.input<typeof ReadModelPrivacyReviewRequestOutputSchema>;
      } catch {
        throw errors.FORBIDDEN();
      }
    });
const researchChatRecordModelPrivacyReview =
  api.vertex.researchChat.recordModelPrivacyReview
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      if (!context.vertexModelPrivacyReviewer) {
        throw errors.SERVICE_UNAVAILABLE();
      }
      if (context.principal.status !== "active") throw errors.FORBIDDEN();
      try {
        return await context.vertexModelPrivacyReviewer.recordModelPrivacyReview(
          { actorId: context.principal.userId },
          input
        );
      } catch {
        throw errors.FORBIDDEN();
      }
    });
const researchChatReadNativeModelPrivacyReviewRequest =
  api.vertex.researchChat.readNativeModelPrivacyReviewRequest
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      if (!context.vertexModelPrivacyReviewer) {
        throw errors.SERVICE_UNAVAILABLE();
      }
      if (context.principal.status !== "active") throw errors.FORBIDDEN();
      try {
        // Deep-frozen service output; oRPC re-validates it against the contract schema.
        return (await context.vertexModelPrivacyReviewer.readNativeModelPrivacyReviewRequest(
          { actorId: context.principal.userId },
          input
        )) as z.input<typeof ReadNativeModelPrivacyReviewRequestOutputSchema>;
      } catch {
        throw errors.FORBIDDEN();
      }
    });
const researchChatRecordNativeModelPrivacyReview =
  api.vertex.researchChat.recordNativeModelPrivacyReview
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      if (!context.vertexModelPrivacyReviewer) {
        throw errors.SERVICE_UNAVAILABLE();
      }
      if (context.principal.status !== "active") throw errors.FORBIDDEN();
      try {
        return await context.vertexModelPrivacyReviewer.recordNativeModelPrivacyReview(
          { actorId: context.principal.userId },
          input
        );
      } catch {
        throw errors.FORBIDDEN();
      }
    });

const researchChatRoster = api.vertex.researchChat.roster
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await getResearchChatRoster(
        researchChatDependencies(context),
        context.principal,
        input,
        context.vertexResearchChatConversation
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatListThreads = api.vertex.researchChat.listThreads
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await listResearchChatThreads(
        researchChatDependencies(context),
        context.principal,
        input
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatCreateThread = api.vertex.researchChat.createThread
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createResearchChatThread(
        researchChatDependencies(context),
        context.principal,
        input
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatReadThread = api.vertex.researchChat.readThread
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await readResearchChatThread(
        researchChatDependencies(context),
        context.principal,
        input
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatListMessages = api.vertex.researchChat.listMessages
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await listResearchChatMessages(
        researchChatDependencies(context),
        context.principal,
        input
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatReadTranscriptPage =
  api.vertex.researchChat.readTranscriptPage
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      try {
        return await readResearchChatTranscriptPage(
          researchChatDependencies(context),
          context.principal,
          input
        );
      } catch (error) {
        return mapResearchChatError(error, errors);
      }
    });
const researchChatSendMessage = api.vertex.researchChat.sendMessage
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await sendResearchChatMessage(
        researchChatDependencies(context),
        context.principal,
        input
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatRequestResponse = api.vertex.researchChat.requestResponse
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await requestResearchChatResponse(
        researchChatDependencies(context),
        context.principal,
        input
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatReadResponse = api.vertex.researchChat.readResponse
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await readResearchChatResponse(
        researchChatDependencies(context),
        context.principal,
        input,
        context.vertexResearchChatConversation
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatPrepareDebateStep = api.vertex.researchChat.prepareDebateStep
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await prepareResearchChatDebateStep(
        researchChatDependencies(context),
        context.principal,
        input,
        context.vertexResearchChatConversation
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatApproveAndRequestDebateStep =
  api.vertex.researchChat.approveAndRequestDebateStep
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      try {
        return await approveAndRequestResearchChatDebateStep(
          researchChatDependencies(context),
          context.principal,
          input,
          context.vertexResearchChatConversation
        );
      } catch (error) {
        return mapResearchChatError(error, errors);
      }
    });
const researchChatReadDebateRun = api.vertex.researchChat.readDebateRun
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await readResearchChatDebateRun(
        researchChatDependencies(context),
        context.principal,
        input,
        context.vertexResearchChatConversation
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatPrepareNativeEvidence =
  api.vertex.researchChat.prepareNativeEvidence
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      try {
        return await prepareResearchChatNativeEvidence(
          researchChatDependencies(context),
          context.principal,
          input,
          context.vertexResearchChatConversation
        );
      } catch (error) {
        return mapResearchChatError(error, errors);
      }
    });
const researchChatApproveAndRequestNativeEvidence =
  api.vertex.researchChat.approveAndRequestNativeEvidence
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      try {
        return await approveAndRequestResearchChatNativeEvidence(
          researchChatDependencies(context),
          context.principal,
          input,
          context.vertexResearchChatConversation
        );
      } catch (error) {
        return mapResearchChatError(error, errors);
      }
    });
const researchChatPrepareResponse = api.vertex.researchChat.prepareResponse
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await prepareResearchChatResponse(
        researchChatDependencies(context),
        context.principal,
        input,
        context.vertexResearchChatConversation
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatApproveAndRequestResponse =
  api.vertex.researchChat.approveAndRequestResponse
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      try {
        return await approveAndRequestResearchChatResponse(
          researchChatDependencies(context),
          context.principal,
          input,
          context.vertexResearchChatConversation
        );
      } catch (error) {
        return mapResearchChatError(error, errors);
      }
    });
const researchChatAppendResponse = api.vertex.researchChat.appendResponse
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await appendResearchChatResponse(
        researchChatDependencies(context),
        context.principal,
        input,
        context.vertexResearchChatConversation
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });
const researchChatReadResponseContent =
  api.vertex.researchChat.readResponseContent
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      try {
        return await readResearchChatResponseContent(
          researchChatDependencies(context),
          context.principal,
          input,
          context.vertexResearchChatConversation
        );
      } catch (error) {
        return mapResearchChatError(error, errors);
      }
    });

// Account sessions establish identity, not literal human presence. Cleanup
// routes deliberately do not exist in the separate worker bearer method table.
const researchChatRequestCopyCleanup =
  api.vertex.researchChat.requestCopyCleanup
    .use(requireAuthenticated)
    .handler(async ({ context, input, errors }) => {
      try {
        return await requestResearchChatCopyCleanup(
          researchChatDependencies(context),
          context.principal,
          input
        );
      } catch (error) {
        return mapResearchChatError(error, errors);
      }
    });
const researchChatReadCopyCleanup = api.vertex.researchChat.readCopyCleanup
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await readResearchChatCopyCleanup(
        researchChatDependencies(context),
        context.principal,
        input
      );
    } catch (error) {
      return mapResearchChatError(error, errors);
    }
  });

// The same verified session middleware protects every read and command. No
// actor, policy, grant, recovery challenge or broker action comes from input.
const experienceScopes = api.vertex.experience.scopes
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).scopes(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experiencePortfolio = api.vertex.experience.portfolio
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).portfolio(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceContinuity = api.vertex.experience.continuity
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).continuity(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceInbox = api.vertex.experience.inbox
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).inbox(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceStrategies = api.vertex.experience.strategies
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).strategies(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceDossier = api.vertex.experience.dossier
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).dossier(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceAgents = api.vertex.experience.agents
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).agents(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceAgent = api.vertex.experience.agent
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).agent(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceAudit = api.vertex.experience.audit
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).audit(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceGateways = api.vertex.experience.gateways
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).gateways(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceGateway = api.vertex.experience.gateway
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).gateway(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceDecideReview = api.vertex.experience.decideReview
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).decideReview(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceProposeResearch = api.vertex.experience.proposeResearch
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).proposeResearch(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });
const experienceProposeSimulation = api.vertex.experience.proposeSimulation
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexExperienceService(
        context.vertexExperience
      ).proposeSimulation(context.principal, input);
    } catch (error) {
      return mapVertexExperienceError(error, errors);
    }
  });

const scopedModules = api.vertex.scoped.modules
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    try {
      return await createVertexChartReadService(
        context.vertexChartRead
      ).modules(context.principal, input);
    } catch (error) {
      return mapVertexReadServiceError(error, errors);
    }
  });

const notificationDelivery = api.vertex.notifications.delivery
  .use(requireAuthenticated)
  .handler(async ({ context, input, errors }) => {
    if (!context.vertexNotificationRead || context.signal?.aborted) {
      throw errors.SERVICE_UNAVAILABLE();
    }
    try {
      const output = await context.vertexNotificationRead.delivery(
        context.principal,
        input
      );
      if (context.signal?.aborted) {
        throw new VertexReadServiceError("SERVICE_UNAVAILABLE");
      }
      return output;
    } catch (error) {
      if (error instanceof VertexReadServiceError) {
        return mapVertexReadServiceError(error, errors);
      }
      throw errors.SERVICE_UNAVAILABLE();
    }
  });

const invokeVertexWorker = async <M extends VertexWorkerMethod>(
  context: ApiContext,
  method: M,
  input: unknown,
  errors: ServiceErrorFactories<VertexWorkerServiceErrorCode>
): Promise<VertexWorkerOutput<M>> => {
  if (!(context.vertexWorker && context.workerRequest)) {
    throw errors.SERVICE_UNAVAILABLE();
  }
  try {
    // Every invocation authenticates an explicit bearer against the current
    // scoped service grant. Browser sessions, cookies and roles never substitute.
    return await createVertexWorkerService(context.vertexWorker).invoke(
      context.workerRequest,
      method,
      input
    );
  } catch (error) {
    if (
      error instanceof VertexWorkerServiceError &&
      Object.hasOwn(VERTEX_WORKER_SERVICE_ERRORS, error.code)
    ) {
      throw errors[error.code]();
    }
    throw errors.SERVICE_UNAVAILABLE();
  }
};

const worker = api.vertexWorker;
const vertexWorkerRouter = {
  acceptedEvidence: worker.acceptedEvidence.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "acceptedEvidence", input, errors)
  ),
  acceptedEvidenceObservation: worker.acceptedEvidenceObservation.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "acceptedEvidenceObservation", input, errors)
  ),
  activateCollection: worker.activateCollection.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "activateCollection", input, errors)
  ),
  admitRun: worker.admitRun.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "admitRun", input, errors)
  ),
  cancel: worker.cancel.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "cancel", input, errors)
  ),
  claim: worker.claim.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "claim", input, errors)
  ),
  complete: worker.complete.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "complete", input, errors)
  ),
  currentModelUse: worker.currentModelUse.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "currentModelUse", input, errors)
  ),
  currentPaperAdmission: worker.currentPaperAdmission.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "currentPaperAdmission", input, errors)
  ),
  currentRights: worker.currentRights.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "currentRights", input, errors)
  ),
  currentRightsObservation: worker.currentRightsObservation.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "currentRightsObservation", input, errors)
  ),
  policySelection: worker.policySelection.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "policySelection", input, errors)
  ),
  prepareModelPrivacyReview: worker.prepareModelPrivacyReview.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "prepareModelPrivacyReview", input, errors)
  ),
  prepareNativeEvidencePhaseTwo: worker.prepareNativeEvidencePhaseTwo.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(
        context,
        "prepareNativeEvidencePhaseTwo",
        input,
        errors
      )
  ),
  publishAgent: worker.publishAgent.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "publishAgent", input, errors)
  ),
  publishArtifact: worker.publishArtifact.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "publishArtifact", input, errors)
  ),
  publishCollection: worker.publishCollection.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "publishCollection", input, errors)
  ),
  publishEpochTransition: worker.publishEpochTransition.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "publishEpochTransition", input, errors)
  ),
  publishExperiment: worker.publishExperiment.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "publishExperiment", input, errors)
  ),
  publishGenesis: worker.publishGenesis.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "publishGenesis", input, errors)
  ),
  publishNativeFacts: worker.publishNativeFacts.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "publishNativeFacts", input, errors)
  ),
  publishOrderProjection: worker.publishOrderProjection.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "publishOrderProjection", input, errors)
  ),
  publishPortfolioSnapshot: worker.publishPortfolioSnapshot.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "publishPortfolioSnapshot", input, errors)
  ),
  readArtifact: worker.readArtifact.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "readArtifact", input, errors)
  ),
  readBacktestRun: worker.readBacktestRun.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "readBacktestRun", input, errors)
  ),
  readCollection: worker.readCollection.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "readCollection", input, errors)
  ),
  readContinuity: worker.readContinuity.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "readContinuity", input, errors)
  ),
  readDataset: worker.readDataset.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "readDataset", input, errors)
  ),
  readExperiment: worker.readExperiment.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "readExperiment", input, errors)
  ),
  readiness: worker.readiness.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "readiness", input, errors)
  ),
  readModelPrivacyReview: worker.readModelPrivacyReview.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "readModelPrivacyReview", input, errors)
  ),
  renew: worker.renew.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "renew", input, errors)
  ),
  replayNativeOutbox: worker.replayNativeOutbox.handler(
    ({ context, input, errors }) =>
      invokeVertexWorker(context, "replayNativeOutbox", input, errors)
  ),
  stageArtifact: worker.stageArtifact.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "stageArtifact", input, errors)
  ),
  status: worker.status.handler(({ context, input, errors }) =>
    invokeVertexWorker(context, "status", input, errors)
  ),
};

const localSetupInitialize = api.vertex.localSetup.initialize
  .use(requireAuthenticated)
  .handler(async ({ context, errors }) => {
    if (context.vertexLocalSetup === undefined) throw errors.FORBIDDEN();
    try {
      return await context.vertexLocalSetup.initialize(context.principal);
    } catch (error) {
      if (error instanceof VertexLocalSetupError) throw errors[error.code]();
      throw errors.SERVICE_UNAVAILABLE();
    }
  });

export const appRouter = api.router({
  featureItems: { archive, changeStatus, create, get, list, update },
  ...generatedFeatureRouters,
  academy: academyRouter,
  account: {
    addresses: {
      create: accountAddressesCreate,
      list: accountAddressesList,
      remove: accountAddressesRemove,
      setPrimary: accountAddressesSetPrimary,
      update: accountAddressesUpdate,
    },
    profile: { get: accountProfileGet, update: accountProfileUpdate },
  },
  admin: {
    featureItems: { list: adminList },
    users: { list: adminUsersList },
  },
  agentApiKeys: agentApiKeysRouter,
  agentModelRuns: agentModelRunsRouter,
  agentOps: { ...agentOpsRouter, optimizations: optimizationsRouter },
  assistant: assistantRouter,
  autopilot: autopilotRouter,
  backtestRuns: {
    ...backtestRunsRouter,
    comparisons: engineComparisonsRouter,
    definitions: strategyDefinitionsRouter,
    drift: forwardDriftRouter,
    engine: backtestRunEngineRouter,
  },
  baskets: basketsRouter,
  clickLog: clickLogRouter,
  congressTrades: congressTradesRouter,
  contact: { submit: contactSubmit },
  dashboard: { summary: dashboardSummary },
  deploymentRequests: deploymentRequestsRouter,
  engines: enginesRouter,
  flow: flowRouter,
  ibkrMonitor: ibkrMonitorRouter,
  ibkrRecovery: ibkrRecoveryRouter,
  instantBacktest: instantBacktestRouter,
  jevVerdict: jevVerdictRouter,
  marketContext: marketContextRouter,
  marketData: marketDataRouter,
  marketNews: marketNewsRouter,
  nautilusArm: nautilusArmRouter,
  optionsAnalytics: optionsAnalyticsRouter,
  optionsChain: optionsChainRouter,
  papers: papersRouter,
  pickLists: pickListsRouter,
  plays: playsRouter,
  portfolioMonitor: portfolioMonitorRouter,
  preferences: {
    get: preferencesGet,
    theme: { get: themeGet, update: themeUpdate },
    update: preferencesUpdate,
  },
  priceAlerts: priceAlertsRouter,
  quantLab: quantLabRouter,
  researchLenses: researchLensesRouter,
  researchReports: researchReportsRouter,
  researchStudies: researchStudiesRouter,
  riskAllocator: riskAllocatorRouter,
  sectorRotation: sectorRotationRouter,
  setupReplay: setupReplayRouter,
  strategyLibrary: strategyLibraryRouter,
  todos: todosRouter,
  vertex: {
    experience: {
      agent: experienceAgent,
      agents: experienceAgents,
      audit: experienceAudit,
      continuity: experienceContinuity,
      decideReview: experienceDecideReview,
      dossier: experienceDossier,
      gateway: experienceGateway,
      gateways: experienceGateways,
      inbox: experienceInbox,
      portfolio: experiencePortfolio,
      proposeResearch: experienceProposeResearch,
      proposeSimulation: experienceProposeSimulation,
      scopes: experienceScopes,
      strategies: experienceStrategies,
    },
    localSetup: { initialize: localSetupInitialize },
    modules: { list: vertexModulesList },
    notifications: { delivery: notificationDelivery },
    researchChat: {
      appendResponse: researchChatAppendResponse,
      approveAndRequestDebateStep: researchChatApproveAndRequestDebateStep,
      approveAndRequestNativeEvidence:
        researchChatApproveAndRequestNativeEvidence,
      approveAndRequestResponse: researchChatApproveAndRequestResponse,
      createThread: researchChatCreateThread,
      listMessages: researchChatListMessages,
      listThreads: researchChatListThreads,
      prepareDebateStep: researchChatPrepareDebateStep,
      prepareNativeEvidence: researchChatPrepareNativeEvidence,
      prepareResponse: researchChatPrepareResponse,
      readCopyCleanup: researchChatReadCopyCleanup,
      readDebateRun: researchChatReadDebateRun,
      readModelPrivacyReviewRequest: researchChatReadModelPrivacyReviewRequest,
      readNativeModelPrivacyReviewRequest:
        researchChatReadNativeModelPrivacyReviewRequest,
      readResponse: researchChatReadResponse,
      readResponseContent: researchChatReadResponseContent,
      readThread: researchChatReadThread,
      readTranscriptPage: researchChatReadTranscriptPage,
      recordModelPrivacyReview: researchChatRecordModelPrivacyReview,
      recordNativeModelPrivacyReview:
        researchChatRecordNativeModelPrivacyReview,
      requestCopyCleanup: researchChatRequestCopyCleanup,
      requestResponse: researchChatRequestResponse,
      roster: researchChatRoster,
      sendMessage: researchChatSendMessage,
    },
    scoped: { modules: scopedModules },
  },
  vertexOrders: vertexOrdersRouter,
  vertexWorker: vertexWorkerRouter,
  watchlist: watchlistRouter,
});

export type AuthenticatedApiContext = ApiContext &
  Readonly<{ principal: SafePrincipal; authSession: SafeAuthSession }>;
