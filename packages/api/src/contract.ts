// What: Public oRPC contract (appContract) and shared Zod schemas; the single source for client, server and OpenAPI.
// Used by: packages/api/src/client.ts, packages/api/src/openapi.ts, packages/api/src/server/router.ts.
// See: packages/api/src/contracts/account.ts; docs/getting-started.md#add-your-first-feature.
import { oc } from "@orpc/contract";
import { z } from "zod";
import { academyContract } from "./contracts/academy.ts";
import { accountContract, preferencesContract } from "./contracts/account.ts";
import { adminUsersContract } from "./contracts/admin-users.ts";
import { agentApiKeysContract } from "./contracts/agent-api-keys.ts";
import { agentModelRunsContract } from "./contracts/agent-model-runs.ts";
import { agentOpsContract, papersContract } from "./contracts/agent-ops.ts";
import { AppearanceFieldsSchema } from "./contracts/appearance.ts";
import { assistantContract } from "./contracts/assistant.ts";
import { autopilotContract } from "./contracts/autopilot.ts";
import { backtestRunsContract } from "./contracts/backtest-runs.ts";
import { basketsContract } from "./contracts/baskets.ts";
import { clickLogContract } from "./contracts/click-log.ts";
import { congressTradesContract } from "./contracts/congress-trades.ts";
import { contactContract } from "./contracts/contact.ts";
import { createDashboardContract } from "./contracts/dashboard.ts";
import { deploymentRequestsContract } from "./contracts/deployment-requests.ts";
import { enginesContract } from "./contracts/engines.ts";
import { flowContract } from "./contracts/flow.ts";
import { ibkrMonitorContract } from "./contracts/ibkr-monitor.ts";
import { ibkrRecoveryContract } from "./contracts/ibkr-recovery.ts";
import { instantBacktestContract } from "./contracts/instant-backtest.ts";
import { jevVerdictContract } from "./contracts/jev-verdict.ts";
import { marketContextContract } from "./contracts/market-context.ts";
import { marketDataContract } from "./contracts/market-data.ts";
import { marketNewsContract } from "./contracts/market-news.ts";
import { nautilusArmContract } from "./contracts/nautilus-arm.ts";
import { optimizationsContract } from "./contracts/optimizations.ts";
import { optionsAnalyticsContract } from "./contracts/options-analytics.ts";
import { optionsChainContract } from "./contracts/options-chain.ts";
import { pickListsContract } from "./contracts/pick-lists.ts";
import { playsContract } from "./contracts/plays.ts";
import { portfolioMonitorContract } from "./contracts/portfolio-monitor.ts";
import { priceAlertsContract } from "./contracts/price-alerts.ts";
import { quantLabContract } from "./contracts/quant-lab.ts";
import { researchLensesContract } from "./contracts/research-lenses.ts";
import { researchReportsContract } from "./contracts/research-reports.ts";
import { researchStudiesContract } from "./contracts/research-studies.ts";
import { riskAllocatorContract } from "./contracts/risk-allocator.ts";
import { sectorRotationContract } from "./contracts/sector-rotation.ts";
import { setupReplayContract } from "./contracts/setup-replay.ts";
import { strategyLibraryContract } from "./contracts/strategy-library.ts";
import { todosContract } from "./contracts/todos.ts";
import { vertexChartReadContract } from "./contracts/vertex-chart-read.ts";
import { vertexExperienceContract } from "./contracts/vertex-experience.ts";
import { vertexLocalSetupContract } from "./contracts/vertex-local-setup.ts";
import { vertexNotificationReadContract } from "./contracts/vertex-notification-read.ts";
import { vertexOrdersContract } from "./contracts/vertex-orders.ts";
import { vertexReadContract } from "./contracts/vertex-read.ts";
import { vertexResearchChatContract } from "./contracts/vertex-research-chat.ts";
import { vertexResearchChatCopyCleanupContract } from "./contracts/vertex-research-chat-copy-cleanup-rpc.ts";
import { vertexResearchChatResponseContract } from "./contracts/vertex-research-chat-response-rpc.ts";
import { vertexWorkerContract } from "./contracts/vertex-worker-rpc.ts";
import { watchlistContract } from "./contracts/watchlist.ts";
import { generatedFeatureContracts } from "./generated/contract-registry.ts";

export const FEATURE_ITEM_STATUSES = ["draft", "active", "archived"] as const;
export const ThemePreferenceSchema = z.object({
  ...AppearanceFieldsSchema.shape,
  updatedAt: z.date().nullable(),
});
export const UpdateThemePreferenceSchema = z
  .object({
    ...AppearanceFieldsSchema.shape,
    expectedUpdatedAt: z.date().nullable(),
  })
  .strict();

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;
export type FeatureItemMetadata = Readonly<Record<string, JsonValue>>;

export const FeatureItemStatusSchema = z.enum(FEATURE_ITEM_STATUSES);
const JsonValueSchema = z
  .json()
  .transform((value): JsonValue => value as JsonValue);
export const FeatureItemMetadataSchema = z
  .record(z.string(), JsonValueSchema)
  .transform((value): FeatureItemMetadata => value);

export const FeatureItemSchema = z.object({
  createdAt: z.date(),
  description: z.string(),
  id: z.string().min(1),
  metadata: FeatureItemMetadataSchema,
  name: z.string(),
  ownerId: z.string().min(1),
  status: FeatureItemStatusSchema,
  updatedAt: z.date(),
});

const OwnerScopeSchema = z.object({
  ownerId: z.string().min(1).optional(),
});

const ItemScopeSchema = OwnerScopeSchema.extend({
  id: z.string().min(1),
});

const MutationFieldsSchema = z.object({
  description: z.string().max(10_000),
  metadata: FeatureItemMetadataSchema.optional(),
  name: z.string().trim().min(1).max(200),
});

export const EXPECTED_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  CONFLICT: { message: "Feature item conflict", status: 409 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Feature item not found", status: 404 },
  STORAGE_ERROR: { message: "Feature item storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  VALIDATION_ERROR: { message: "Feature item validation failed", status: 422 },
} as const;

const featureItem = oc.errors(EXPECTED_API_ERRORS);

export const FeatureItemListInputSchema = OwnerScopeSchema.extend({
  limit: z.number().int().min(1).max(100).default(50),
  query: z.string().trim().min(1).max(200).optional(),
  status: FeatureItemStatusSchema.optional(),
}).strict();

const list = featureItem
  .route({
    method: "GET",
    operationId: "featureItems.list",
    path: "/feature-items",
    summary: "List feature items",
    tags: ["Feature items"],
  })
  .input(FeatureItemListInputSchema)
  .output(z.array(FeatureItemSchema));

const get = featureItem
  .route({
    method: "GET",
    operationId: "featureItems.get",
    path: "/feature-items/{id}",
    summary: "Get a feature item",
    tags: ["Feature items"],
  })
  .input(ItemScopeSchema)
  .output(FeatureItemSchema);

const create = featureItem
  .route({
    method: "POST",
    operationId: "featureItems.create",
    path: "/feature-items",
    summary: "Create a feature item",
    tags: ["Feature items"],
  })
  .input(OwnerScopeSchema.extend(MutationFieldsSchema.shape))
  .output(FeatureItemSchema);

const update = featureItem
  .route({
    method: "PATCH",
    operationId: "featureItems.update",
    path: "/feature-items/{id}",
    summary: "Update a feature item",
    tags: ["Feature items"],
  })
  .input(
    ItemScopeSchema.extend({
      description: z.string().max(10_000).optional(),
      metadata: FeatureItemMetadataSchema.optional(),
      name: z.string().trim().min(1).max(200).optional(),
    }).refine(
      (input) =>
        input.name !== undefined ||
        input.description !== undefined ||
        input.metadata !== undefined,
      { message: "At least one field must change" }
    )
  )
  .output(FeatureItemSchema);

const changeStatus = featureItem
  .route({
    method: "PATCH",
    operationId: "featureItems.changeStatus",
    path: "/feature-items/{id}/status",
    summary: "Change a feature item status",
    tags: ["Feature items"],
  })
  .input(ItemScopeSchema.extend({ status: FeatureItemStatusSchema }))
  .output(FeatureItemSchema);

const archive = featureItem
  .route({
    method: "DELETE",
    operationId: "featureItems.archive",
    path: "/feature-items/{id}",
    summary: "Archive a feature item",
    tags: ["Feature items"],
  })
  .input(ItemScopeSchema)
  .output(FeatureItemSchema);

export const AdminFeatureItemListInputSchema =
  FeatureItemListInputSchema.extend({
    ownerId: z.string().min(1),
  });

const adminList = featureItem
  .route({
    method: "GET",
    operationId: "admin.featureItems.list",
    path: "/admin/feature-items",
    summary: "List feature items for an owner",
    tags: ["Admin"],
  })
  .input(AdminFeatureItemListInputSchema)
  .output(z.array(FeatureItemSchema));

export const THEME_PREFERENCE_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  CONFLICT: { message: "Theme preference conflict", status: 409 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: {
    message: "Theme preference storage unavailable",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  VALIDATION_ERROR: {
    message: "Theme preference validation failed",
    status: 422,
  },
} as const;

const themePreference = oc.errors(THEME_PREFERENCE_ERRORS);

const getThemePreference = themePreference
  .route({
    method: "GET",
    operationId: "preferences.theme.get",
    path: "/preferences/theme",
    summary: "Get the authenticated user's theme preference",
    tags: ["Preferences"],
  })
  .input(z.object({}).strict())
  .output(ThemePreferenceSchema);

const updateThemePreference = themePreference
  .route({
    method: "PATCH",
    operationId: "preferences.theme.update",
    path: "/preferences/theme",
    summary: "Update the authenticated user's theme preference",
    tags: ["Preferences"],
  })
  .input(UpdateThemePreferenceSchema)
  .output(ThemePreferenceSchema);

const dashboardDefinitions = createDashboardContract(FeatureItemSchema);

export const appContract = {
  featureItems: { archive, changeStatus, create, get, list, update },
  ...generatedFeatureContracts,
  academy: academyContract,
  account: accountContract,
  admin: {
    featureItems: { list: adminList },
    users: adminUsersContract,
  },
  agentApiKeys: agentApiKeysContract,
  agentModelRuns: agentModelRunsContract,
  agentOps: { ...agentOpsContract, optimizations: optimizationsContract },
  assistant: assistantContract,
  autopilot: autopilotContract,
  backtestRuns: backtestRunsContract,
  baskets: basketsContract,
  clickLog: clickLogContract,
  congressTrades: congressTradesContract,
  contact: contactContract,
  dashboard: dashboardDefinitions.contract,
  deploymentRequests: deploymentRequestsContract,
  engines: enginesContract,
  flow: flowContract,
  ibkrMonitor: ibkrMonitorContract,
  ibkrRecovery: ibkrRecoveryContract,
  instantBacktest: instantBacktestContract,
  jevVerdict: jevVerdictContract,
  marketContext: marketContextContract,
  marketData: marketDataContract,
  marketNews: marketNewsContract,
  nautilusArm: nautilusArmContract,
  optionsAnalytics: optionsAnalyticsContract,
  optionsChain: optionsChainContract,
  papers: papersContract,
  pickLists: pickListsContract,
  plays: playsContract,
  portfolioMonitor: portfolioMonitorContract,
  preferences: {
    get: preferencesContract.get,
    theme: { get: getThemePreference, update: updateThemePreference },
    update: preferencesContract.update,
  },
  priceAlerts: priceAlertsContract,
  quantLab: quantLabContract,
  researchLenses: researchLensesContract,
  researchReports: researchReportsContract,
  researchStudies: researchStudiesContract,
  riskAllocator: riskAllocatorContract,
  sectorRotation: sectorRotationContract,
  setupReplay: setupReplayContract,
  strategyLibrary: strategyLibraryContract,
  todos: todosContract,
  vertex: {
    ...vertexReadContract,
    experience: vertexExperienceContract,
    localSetup: vertexLocalSetupContract,
    notifications: vertexNotificationReadContract,
    researchChat: {
      ...vertexResearchChatContract,
      ...vertexResearchChatResponseContract,
      ...vertexResearchChatCopyCleanupContract,
    },
    scoped: vertexChartReadContract,
  },
  vertexOrders: vertexOrdersContract,
  vertexWorker: vertexWorkerContract,
  watchlist: watchlistContract,
};

export type FeatureItemInput = z.input<typeof FeatureItemSchema>;
export type FeatureItemOutput = z.infer<typeof FeatureItemSchema>;
export type FeatureItemStatus = z.infer<typeof FeatureItemStatusSchema>;
export type FeatureItemListInput = z.input<typeof FeatureItemListInputSchema>;
export type AdminFeatureItemListInput = z.input<
  typeof AdminFeatureItemListInputSchema
>;

export type ThemePreferenceOutput = z.infer<typeof ThemePreferenceSchema>;
export type UpdateThemePreferenceInput = z.input<
  typeof UpdateThemePreferenceSchema
>;

export type {
  AccountProfileOutput,
  AddressCreateInput,
  AddressOutput,
  AddressUpdateInput,
  PreferencesOutput,
  PreferencesUpdateInput,
  ProfileOutput,
  ProfileUpdateInput,
} from "./contracts/account.ts";
export {
  ACCOUNT_ERRORS,
  AccountProfileSchema,
  ADDRESS_TYPES,
  AddressCreateSchema,
  AddressIdSchema,
  AddressSchema,
  AddressUpdateSchema,
  PROFILE_VISIBILITIES,
  PreferenceFieldsSchema,
  PreferencesSchema,
  PreferencesUpdateSchema,
  ProfileFieldsSchema,
  ProfileSchema,
  ProfileUpdateSchema,
} from "./contracts/account.ts";
export type {
  AdminUserSummaryOutput,
  AdminUsersListInput,
  AdminUsersListOutput,
} from "./contracts/admin-users.ts";
export {
  ADMIN_USERS_ERRORS,
  AdminUserSummarySchema,
  AdminUsersListInputSchema,
  AdminUsersListOutputSchema,
} from "./contracts/admin-users.ts";
export type {
  Density,
  FontSize,
  Radius,
  ThemeName,
} from "./contracts/appearance.ts";
export {
  AppearanceFieldsSchema,
  DENSITIES,
  DensitySchema,
  FONT_SIZES,
  FontSizeSchema,
  RADII,
  RadiusSchema,
  THEME_NAMES,
  ThemeNameSchema,
} from "./contracts/appearance.ts";
export type {
  ContactSubmitInput,
  ContactSubmitOutput,
} from "./contracts/contact.ts";
export {
  CONTACT_ERRORS,
  ContactSubmitInputSchema,
  ContactSubmitOutputSchema,
} from "./contracts/contact.ts";
export type { CapabilityProjection } from "./contracts/dashboard.ts";
export { CapabilityProjectionSchema } from "./contracts/dashboard.ts";
export type { VertexModulesListInput } from "./contracts/vertex-read.ts";
export {
  VERTEX_READ_ERRORS,
  VertexModulesListInputSchema,
  VertexModulesListOutputSchema,
} from "./contracts/vertex-read.ts";
