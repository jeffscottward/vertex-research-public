// What: Public oRPC contract (appContract) and shared Zod schemas; the single source for client, server and OpenAPI.
// Used by: packages/api/src/client.ts, packages/api/src/openapi.ts, packages/api/src/server/router.ts.
// See: packages/api/src/contracts/account.ts; docs/getting-started.md#add-your-first-feature.
import { oc } from "@orpc/contract";
import { z } from "zod";
import { accountContract, preferencesContract } from "./contracts/account.ts";
import { AppearanceFieldsSchema } from "./contracts/appearance.ts";
import { adminUsersContract } from "./contracts/admin-users.ts";
import { contactContract } from "./contracts/contact.ts";
import { createDashboardContract } from "./contracts/dashboard.ts";
import { vertexReadContract } from "./contracts/vertex-read.ts";
import { vertexExperienceContract } from "./contracts/vertex-experience.ts";
import { vertexChartReadContract } from "./contracts/vertex-chart-read.ts";
import { vertexWorkerContract } from "./contracts/vertex-worker-rpc.ts";
import { vertexNotificationReadContract } from "./contracts/vertex-notification-read.ts";
import { vertexLocalSetupContract } from "./contracts/vertex-local-setup.ts";
import { vertexResearchChatContract } from "./contracts/vertex-research-chat.ts";
import { vertexResearchChatResponseContract } from "./contracts/vertex-research-chat-response-rpc.ts";
import { vertexResearchChatCopyCleanupContract } from "./contracts/vertex-research-chat-copy-cleanup-rpc.ts";
import { todosContract } from "./contracts/todos.ts";
import { watchlistContract } from "./contracts/watchlist.ts";
import { priceAlertsContract } from "./contracts/price-alerts.ts";
import { marketNewsContract } from "./contracts/market-news.ts";
import { basketsContract } from "./contracts/baskets.ts";
import { pickListsContract } from "./contracts/pick-lists.ts";
import { agentOpsContract, papersContract } from "./contracts/agent-ops.ts";
import { agentModelRunsContract } from "./contracts/agent-model-runs.ts";
import { optimizationsContract } from "./contracts/optimizations.ts";
import { quantLabContract } from "./contracts/quant-lab.ts";
import { researchReportsContract } from "./contracts/research-reports.ts";
import { researchStudiesContract } from "./contracts/research-studies.ts";
import { flowContract } from "./contracts/flow.ts";
import { clickLogContract } from "./contracts/click-log.ts";
import { agentApiKeysContract } from "./contracts/agent-api-keys.ts";
import { strategyLibraryContract } from "./contracts/strategy-library.ts";
import { deploymentRequestsContract } from "./contracts/deployment-requests.ts";
import { backtestRunsContract } from "./contracts/backtest-runs.ts";
import { autopilotContract } from "./contracts/autopilot.ts";
import { academyContract } from "./contracts/academy.ts";
import { instantBacktestContract } from "./contracts/instant-backtest.ts";
import { playsContract } from "./contracts/plays.ts";
import { setupReplayContract } from "./contracts/setup-replay.ts";
import { researchLensesContract } from "./contracts/research-lenses.ts";
import { sectorRotationContract } from "./contracts/sector-rotation.ts";
import { congressTradesContract } from "./contracts/congress-trades.ts";
import { riskAllocatorContract } from "./contracts/risk-allocator.ts";
import { marketDataContract } from "./contracts/market-data.ts";
import { optionsAnalyticsContract } from "./contracts/options-analytics.ts";
import { jevVerdictContract } from "./contracts/jev-verdict.ts";
import { optionsChainContract } from "./contracts/options-chain.ts";
import { portfolioMonitorContract } from "./contracts/portfolio-monitor.ts";
import { enginesContract } from "./contracts/engines.ts";
import { ibkrMonitorContract } from "./contracts/ibkr-monitor.ts";
import { marketContextContract } from "./contracts/market-context.ts";
import { ibkrRecoveryContract } from "./contracts/ibkr-recovery.ts";
import { nautilusArmContract } from "./contracts/nautilus-arm.ts";
import { vertexOrdersContract } from "./contracts/vertex-orders.ts";
import { assistantContract } from "./contracts/assistant.ts";
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
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  status: FeatureItemStatusSchema,
  metadata: FeatureItemMetadataSchema,
  ownerId: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const OwnerScopeSchema = z.object({
  ownerId: z.string().min(1).optional(),
});

const ItemScopeSchema = OwnerScopeSchema.extend({
  id: z.string().min(1),
});

const MutationFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  metadata: FeatureItemMetadataSchema.optional(),
});

export const EXPECTED_API_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Feature item not found" },
  CONFLICT: { status: 409, message: "Feature item conflict" },
  VALIDATION_ERROR: { status: 422, message: "Feature item validation failed" },
  STORAGE_ERROR: { status: 503, message: "Feature item storage unavailable" },
} as const;

const featureItem = oc.errors(EXPECTED_API_ERRORS);

export const FeatureItemListInputSchema = OwnerScopeSchema.extend({
  query: z.string().trim().min(1).max(200).optional(),
  status: FeatureItemStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

const list = featureItem
  .route({
    method: "GET",
    path: "/feature-items",
    operationId: "featureItems.list",
    summary: "List feature items",
    tags: ["Feature items"],
  })
  .input(FeatureItemListInputSchema)
  .output(z.array(FeatureItemSchema));

const get = featureItem
  .route({
    method: "GET",
    path: "/feature-items/{id}",
    operationId: "featureItems.get",
    summary: "Get a feature item",
    tags: ["Feature items"],
  })
  .input(ItemScopeSchema)
  .output(FeatureItemSchema);

const create = featureItem
  .route({
    method: "POST",
    path: "/feature-items",
    operationId: "featureItems.create",
    summary: "Create a feature item",
    tags: ["Feature items"],
  })
  .input(OwnerScopeSchema.extend(MutationFieldsSchema.shape))
  .output(FeatureItemSchema);

const update = featureItem
  .route({
    method: "PATCH",
    path: "/feature-items/{id}",
    operationId: "featureItems.update",
    summary: "Update a feature item",
    tags: ["Feature items"],
  })
  .input(
    ItemScopeSchema.extend({
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(10_000).optional(),
      metadata: FeatureItemMetadataSchema.optional(),
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
    path: "/feature-items/{id}/status",
    operationId: "featureItems.changeStatus",
    summary: "Change a feature item status",
    tags: ["Feature items"],
  })
  .input(ItemScopeSchema.extend({ status: FeatureItemStatusSchema }))
  .output(FeatureItemSchema);

const archive = featureItem
  .route({
    method: "DELETE",
    path: "/feature-items/{id}",
    operationId: "featureItems.archive",
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
    path: "/admin/feature-items",
    operationId: "admin.featureItems.list",
    summary: "List feature items for an owner",
    tags: ["Admin"],
  })
  .input(AdminFeatureItemListInputSchema)
  .output(z.array(FeatureItemSchema));

export const THEME_PREFERENCE_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  CONFLICT: { status: 409, message: "Theme preference conflict" },
  VALIDATION_ERROR: {
    status: 422,
    message: "Theme preference validation failed",
  },
  STORAGE_ERROR: {
    status: 503,
    message: "Theme preference storage unavailable",
  },
} as const;

const themePreference = oc.errors(THEME_PREFERENCE_ERRORS);

const getThemePreference = themePreference
  .route({
    method: "GET",
    path: "/preferences/theme",
    operationId: "preferences.theme.get",
    summary: "Get the authenticated user's theme preference",
    tags: ["Preferences"],
  })
  .input(z.object({}).strict())
  .output(ThemePreferenceSchema);

const updateThemePreference = themePreference
  .route({
    method: "PATCH",
    path: "/preferences/theme",
    operationId: "preferences.theme.update",
    summary: "Update the authenticated user's theme preference",
    tags: ["Preferences"],
  })
  .input(UpdateThemePreferenceSchema)
  .output(ThemePreferenceSchema);

const dashboardDefinitions = createDashboardContract(FeatureItemSchema);

export const appContract = {
  featureItems: { list, get, create, update, changeStatus, archive },
  ...generatedFeatureContracts,
  contact: contactContract,
  account: accountContract,
  admin: {
    featureItems: { list: adminList },
    users: adminUsersContract,
  },
  preferences: {
    get: preferencesContract.get,
    update: preferencesContract.update,
    theme: { get: getThemePreference, update: updateThemePreference },
  },
  dashboard: dashboardDefinitions.contract,
  vertex: {
    ...vertexReadContract,
    experience: vertexExperienceContract,
    scoped: vertexChartReadContract,
    notifications: vertexNotificationReadContract,
    localSetup: vertexLocalSetupContract,
    researchChat: {
      ...vertexResearchChatContract,
      ...vertexResearchChatResponseContract,
      ...vertexResearchChatCopyCleanupContract,
    },
  },
  vertexWorker: vertexWorkerContract,
  watchlist: watchlistContract,
  priceAlerts: priceAlertsContract,
  marketNews: marketNewsContract,
  baskets: basketsContract,
  pickLists: pickListsContract,
  todos: todosContract,
  agentOps: { ...agentOpsContract, optimizations: optimizationsContract },
  quantLab: quantLabContract,
  researchReports: researchReportsContract,
  researchStudies: researchStudiesContract,
  flow: flowContract,
  clickLog: clickLogContract,
  papers: papersContract,
  agentModelRuns: agentModelRunsContract,
  agentApiKeys: agentApiKeysContract,
  strategyLibrary: strategyLibraryContract,
  deploymentRequests: deploymentRequestsContract,
  marketData: marketDataContract,
  optionsAnalytics: optionsAnalyticsContract,
  jevVerdict: jevVerdictContract,
  optionsChain: optionsChainContract,
  instantBacktest: instantBacktestContract,
  setupReplay: setupReplayContract,
  plays: playsContract,
  academy: academyContract,
  backtestRuns: backtestRunsContract,
  autopilot: autopilotContract,
  researchLenses: researchLensesContract,
  sectorRotation: sectorRotationContract,
  congressTrades: congressTradesContract,
  riskAllocator: riskAllocatorContract,
  portfolioMonitor: portfolioMonitorContract,
  ibkrMonitor: ibkrMonitorContract,
  engines: enginesContract,
  marketContext: marketContextContract,
  ibkrRecovery: ibkrRecoveryContract,
  nautilusArm: nautilusArmContract,
  vertexOrders: vertexOrdersContract,
  assistant: assistantContract,
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
  ContactSubmitInput,
  ContactSubmitOutput,
} from "./contracts/contact.ts";
export {
  CONTACT_ERRORS,
  ContactSubmitInputSchema,
  ContactSubmitOutputSchema,
} from "./contracts/contact.ts";
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
export type { CapabilityProjection } from "./contracts/dashboard.ts";
export { CapabilityProjectionSchema } from "./contracts/dashboard.ts";
export {
  VERTEX_READ_ERRORS,
  VertexModulesListInputSchema,
  VertexModulesListOutputSchema,
} from "./contracts/vertex-read.ts";
export type { VertexModulesListInput } from "./contracts/vertex-read.ts";
