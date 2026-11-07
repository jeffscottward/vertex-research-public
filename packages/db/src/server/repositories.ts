// What: Drizzle repositories for profiles, addresses, preferences, feature items and theme. Typed persistence errors live in repository-errors.ts.
// Used by: packages/db/src/server/index.ts (re-export), packages/api/src/server/router.ts services, packages/db/src/seeds/*.
// See: docs/debugging.md#symptom--where-to-look; packages/db/src/schema/index.ts; packages/db/src/server/client.ts#withTransaction.
import {
  and as andWhere,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  ne,
  or as orWhere,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  createGeneratedFeatureRepositories,
  type GeneratedFeatureRepositories,
} from "../generated/repository-registry.ts";
import {
  type Address,
  type AddressType,
  addresses,
  auditRecords,
  APPEARANCE_THEMES,
  type AppearanceTheme,
  DENSITIES,
  type Density,
  FONT_SIZES,
  type FontSize,
  type FeatureItem,
  type FeatureItemMetadata,
  type FeatureItemStatus,
  featureItems,
  type JsonValue,
  outboxEvents,
  RADII,
  type Radius,
  type Profile,
  type ProfileVisibility,
  profiles,
  type UserPreferences,
  userPreferences,
  watchlistItems,
  todos,
  TODO_MAX_TAGS,
  TODO_NOTE_MAX_LENGTH,
  TODO_STATUSES,
  TODO_TAG_PATTERN,
  TODO_TITLE_MAX_LENGTH,
  WATCHLIST_NOTE_MAX_LENGTH,
  WATCHLIST_SYMBOL_PATTERN,
  agentTaskEvents,
  agentTasks,
  backtestResults,
  deploymentRequests,
  assistantMessages,
  assistantThreads,
  assistantUsage,
  optimizationRuns,
  researchPapers,
  strategies,
  strategyPresets,
  type BacktestEquityPoint,
  type Strategy,
  type StrategyKind,
  type StrategyPreset,
  type DeploymentRequest,
  type DeploymentRequestStatus,
  type StrategyStatus,
  AGENT_TASK_EVENT_LEVELS,
  AGENT_TASK_KINDS,
  AGENT_TASK_STATUSES,
  RESEARCH_PAPER_KINDS,
  RESEARCH_PAPER_STAGES,
  RESEARCH_PAPER_VERDICTS,
  type AgentLink,
  type AgentMetrics,
  type AgentTask,
  type AgentTaskEvent,
  type AgentTaskEventLevel,
  type AgentTaskKind,
  type AgentTaskStatus,
  type BacktestResult,
  type OptimizationRun,
  type ResearchPaper,
  type ResearchPaperKind,
  type ResearchPaperStage,
  type ResearchPaperVerdict,
  type Todo,
  type TodoStatus,
  type WatchlistItem,
  type AssistantMessage,
  type AssistantMessageRole,
  type AssistantMode,
  type AssistantThread,
} from "../schema/index.ts";
import {
  type AdminUsersRepository,
  createAdminUsersRepository,
} from "./admin-users-repository.ts";
import {
  type DatabaseExecutor,
  type Transaction,
  withTransaction,
} from "./client.ts";
import {
  createDashboardRepository,
  type DashboardRepository,
} from "./dashboard-repository.ts";
import {
  BacktestResultInputError,
  normalizeBacktestResult,
  type BacktestResultDraft,
  type NormalizedBacktestResult,
} from "./backtest-results.ts";
import {
  createMarketBarsRepository,
  type MarketBarsRepository,
} from "./market-bars.ts";
import {
  type BacktestRunsRepository,
  createBacktestRunsRepository,
} from "./backtest-runs.ts";
import {
  type AcademyAuditRepository,
  createAcademyAuditRepository,
} from "./academy-audit.ts";
import {
  type NautilusArmAuditRepository,
  createNautilusArmAuditRepository,
} from "./arm-switch-audit.ts";
import {
  createOrderIntentRepository,
  type OrderIntentRepository,
} from "./order-intents.ts";
import {
  createForwardDriftRepository,
  type ForwardDriftRepository,
} from "./forward-drift.ts";
import {
  createPriceAlertRepository,
  type PriceAlertRepository,
} from "./price-alerts.ts";
import {
  createSignalAlertRepository,
  type SignalAlertRepository,
} from "./signal-alerts.ts";
import {
  CLICK_LOG_RETENTION_DAYS,
  type ClickLogRepository,
  createClickLogRepository,
} from "./click-log.ts";
import {
  createResearchReportsRepository,
  type ResearchReportsRepository,
} from "./research-reports.ts";
import {
  type AgentModelRunsRepository,
  createAgentModelRunsRepository,
} from "./agent-model-runs.ts";
import {
  createStrategyDefinitionsRepository,
  type StrategyDefinitionsRepository,
} from "./strategy-definitions.ts";
import {
  type AutopilotRepository,
  createAutopilotRepository,
} from "./autopilot.ts";
import {
  type AssistantActionsRepository,
  createAssistantActionsRepository,
} from "./assistant-actions.ts";
import {
  OptimizationRunInputError,
  normalizeOptimizationRun,
  type NormalizedOptimizationRun,
  type OptimizationRunDraft,
} from "./optimization-runs.ts";
import {
  STRATEGY_PRESETS_MAX,
  STRATEGY_SEARCH_MAX_LENGTH,
  StrategyInputError,
  normalizeStrategyDescription,
  normalizeStrategyFavorite,
  normalizeStrategyKind,
  normalizeStrategyName,
  normalizeStrategyParams,
  normalizeStrategyPresetName,
  normalizeStrategyPresetValues,
  normalizeStrategySection,
  normalizeStrategySlug,
  normalizeStrategySourceRef,
  normalizeStrategyStatus,
  normalizeStrategyTags,
  slugifyStrategyName,
} from "./strategy-library.ts";
import {
  DeploymentRequestInputError,
  DeploymentRequestStateError,
  DEPLOYMENT_REQUEST_ACTIONS,
  checkDeploymentParamsFit,
  checkDeploymentTransition,
  normalizeDeploymentLimits,
  normalizeDeploymentNote,
  normalizeDeploymentStatus,
  normalizeDeploymentSymbol,
  normalizeDeploymentTimeframe,
  resolveDeploymentParams,
  type DeploymentRequestAction,
} from "./deployment-requests.ts";
import {
  AssistantRecordInputError,
  normalizeAssistantContent,
  normalizeAssistantMode,
  normalizeAssistantRole,
  normalizeAssistantThreadTitle,
  normalizeAssistantTokens,
  normalizeAssistantToolTrace,
} from "./assistant-records.ts";
import {
  type BasketRepository,
  createBasketRepository,
} from "./basket-repository.ts";
import {
  createPickListRepository,
  type PickListRepository,
} from "./pick-list-repository.ts";
import {
  createPlaysRepository,
  type PlaysRepository,
} from "./plays-repository.ts";
import {
  createQuantLabReadRepository,
  type QuantLabReadRepository,
} from "./quant-lab-read.ts";
import {
  createSectorRotationRepository,
  type SectorRotationRepository,
} from "./sector-rotation.ts";
import { required } from "./required.ts";
import {
  DatabaseConflictError,
  DatabasePersistenceError,
  databaseErrorDetails,
  InvalidRepositoryInputError,
  OptimisticConcurrencyError,
  type RepositoryDependencies,
  requireNonBlank,
} from "./repository-errors.ts";

const FEATURE_METADATA_LIMIT_BYTES = 16 * 1024;
const nextOptimisticVersion = (candidate: Date, expected: Date): Date => {
  return new Date(Math.max(candidate.getTime(), expected.getTime() + 1));
};
const MAX_ADDRESSES_PER_USER = 20;

type ResolvedRepositoryDependencies = Readonly<{
  now: () => Date;
  generateId: () => string;
}>;

const resolveDependencies = (
  dependencies: RepositoryDependencies = {}
): ResolvedRepositoryDependencies => ({
  now: dependencies.now ?? (() => new Date()),
  generateId: dependencies.generateId ?? (() => crypto.randomUUID()),
});

const isUniqueViolation = (error: unknown): boolean => {
  return databaseErrorDetails(error).code === "23505";
};

const mapConflict = (error: unknown, entity: string): never => {
  if (isUniqueViolation(error)) throw new DatabaseConflictError(entity);
  throw error;
};

const mapFeatureMutationError = (error: unknown): never => {
  const details = databaseErrorDetails(error);
  if (details.code === "23505" && details.constraint === "feature_items_pkey") {
    throw new DatabaseConflictError("feature item");
  }
  if (
    details.code === "23514" &&
    details.constraint === "feature_items_metadata_check"
  ) {
    throw new InvalidRepositoryInputError("metadata must not exceed 16 KiB");
  }
  if (typeof details.code === "string") {
    throw new DatabasePersistenceError("feature item mutation");
  }
  throw error;
};

const invalidJsonMetadata = (): never => {
  throw new InvalidRepositoryInputError(
    "metadata must contain only strict JSON values"
  );
};

const normalizeJsonValue = (
  value: unknown,
  ancestors: Set<object>
): JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalidJsonMetadata();
    return value;
  }

  if (typeof value !== "object" || value === null) {
    return invalidJsonMetadata();
  }
  if (ancestors.has(value)) return invalidJsonMetadata();

  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) {
      return invalidJsonMetadata();
    }

    ancestors.add(value);
    const normalized: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return invalidJsonMetadata();
      }
      normalized.push(normalizeJsonValue(descriptor.value, ancestors));
    }
    ancestors.delete(value);
    return normalized;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidJsonMetadata();
  }
  if (Object.hasOwn(value, "toJSON")) {
    return invalidJsonMetadata();
  }

  ancestors.add(value);
  const normalized: Record<string, JsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return invalidJsonMetadata();
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      return invalidJsonMetadata();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return invalidJsonMetadata();
    }
    normalized[key] = normalizeJsonValue(descriptor.value, ancestors);
  }
  ancestors.delete(value);
  return normalized;
};

const jsonbNumberText = (value: number): string => {
  const source = String(value);
  if (!(source.includes("e") || source.includes("E"))) return source;

  const match = required(
    /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(source),
    "exponent notation"
  );
  const sign = required(match[1], "exponent sign");
  const whole = required(match[2], "exponent mantissa");
  const fraction = match[3] ?? "";
  const exponent = Number(match[4]);
  const digits = whole + fraction;
  const decimalIndex = whole.length + exponent;

  if (decimalIndex <= 0) {
    return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  }
  return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
};

const jsonbText = (value: JsonValue): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return jsonbNumberText(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => jsonbText(entry)).join(", ")}]`;
  }

  return `{${Object.entries(value)
    .map(([key, entry]) => `${JSON.stringify(key)}: ${jsonbText(entry)}`)
    .join(", ")}}`;
};

const validateFeatureMetadata = (metadata: unknown): FeatureItemMetadata => {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new InvalidRepositoryInputError("metadata must be a JSON object");
  }

  let normalized: JsonValue;
  try {
    normalized = normalizeJsonValue(metadata, new Set());
  } catch (error) {
    if (error instanceof InvalidRepositoryInputError) throw error;
    return invalidJsonMetadata();
  }

  const serialized = jsonbText(normalized);
  if (
    new TextEncoder().encode(serialized).byteLength >
    FEATURE_METADATA_LIMIT_BYTES
  ) {
    throw new InvalidRepositoryInputError("metadata must not exceed 16 KiB");
  }
  return normalized as FeatureItemMetadata;
};

export type UpsertProfileInput = Readonly<{
  userId: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  phone: string | null;
  businessName: string | null;
  jobTitle: string | null;
  biography: string | null;
  timezone: string;
  locale: string;
  dateOfBirth: string | null;
}>;
export type OptimisticProfileInput = UpsertProfileInput &
  Readonly<{ expectedUpdatedAt: Date | null }>;

export type ProfileRepository = Readonly<{
  findByUserId: (userId: string) => Promise<Profile | null>;
  upsert: (input: UpsertProfileInput) => Promise<Profile>;
  updateOptimistic: (input: OptimisticProfileInput) => Promise<Profile>;
}>;

export const createProfileRepository = (
  database: DatabaseExecutor,
  dependencies: RepositoryDependencies = {}
): ProfileRepository => {
  const { now } = resolveDependencies(dependencies);

  return {
    findByUserId: async (userId) => {
      const [profile] = await database
        .select()
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);
      return profile ?? null;
    },

    upsert: async (input) => {
      requireNonBlank(input.userId, "userId");
      requireNonBlank(input.timezone, "timezone");
      requireNonBlank(input.locale, "locale");
      const updatedAt = now();
      const [profile] = await database
        .insert(profiles)
        .values(input)
        .onConflictDoUpdate({
          target: profiles.userId,
          set: {
            firstName: input.firstName,
            lastName: input.lastName,
            displayName: input.displayName,
            avatarUrl: input.avatarUrl,
            phone: input.phone,
            businessName: input.businessName,
            jobTitle: input.jobTitle,
            biography: input.biography,
            timezone: input.timezone,
            locale: input.locale,
            dateOfBirth: input.dateOfBirth,
            updatedAt,
          },
        })
        .returning();
      return required(profile, "profile row");
    },

    updateOptimistic: async (input) => {
      requireNonBlank(input.userId, "userId");
      requireNonBlank(input.timezone, "timezone");
      requireNonBlank(input.locale, "locale");
      const updatedAt =
        input.expectedUpdatedAt === null
          ? now()
          : nextOptimisticVersion(now(), input.expectedUpdatedAt);
      const values = {
        userId: input.userId,
        firstName: input.firstName,
        lastName: input.lastName,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        phone: input.phone,
        businessName: input.businessName,
        jobTitle: input.jobTitle,
        biography: input.biography,
        timezone: input.timezone,
        locale: input.locale,
        dateOfBirth: input.dateOfBirth,
        updatedAt,
      };
      const [profile] =
        input.expectedUpdatedAt === null
          ? await database
              .insert(profiles)
              .values(values)
              .onConflictDoNothing()
              .returning()
          : await database
              .update(profiles)
              .set(values)
              .where(
                andWhere(
                  eq(profiles.userId, input.userId),
                  sql`date_trunc('milliseconds', ${profiles.updatedAt}) = ${input.expectedUpdatedAt}`
                )
              )
              .returning();
      if (profile === undefined) {
        throw new OptimisticConcurrencyError("profile");
      }
      return profile;
    },
  };
};

export type CreateAddressInput = Readonly<{
  id?: string;
  userId: string;
  type: AddressType;
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  isPrimary?: boolean;
}>;

export type UpdateAddressInput = Readonly<{
  id: string;
  userId: string;
  type?: AddressType;
  line1?: string;
  line2?: string | null;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  isPrimary?: boolean;
}>;
export type OptimisticAddressUpdateInput = UpdateAddressInput &
  Readonly<{ expectedUpdatedAt: Date }>;
export type OptimisticAddressIdInput = Readonly<{
  id: string;
  userId: string;
  expectedUpdatedAt: Date;
}>;

export type AddressRepository = Readonly<{
  listByUserId: (userId: string) => Promise<Address[]>;
  findByIdForUser: (id: string, userId: string) => Promise<Address | null>;
  create: (input: CreateAddressInput) => Promise<Address>;
  update: (input: UpdateAddressInput) => Promise<Address | null>;
  updateOptimistic: (
    input: OptimisticAddressUpdateInput
  ) => Promise<Address | null>;
  remove: (id: string, userId: string) => Promise<boolean>;
  removeOptimistic: (input: OptimisticAddressIdInput) => Promise<boolean>;
  setPrimary: (id: string, userId: string) => Promise<Address | null>;
  setPrimaryOptimistic: (
    input: OptimisticAddressIdInput
  ) => Promise<Address | null>;
}>;

const findAddress = async (
  database: DatabaseExecutor,
  id: string,
  userId: string
): Promise<Address | null> => {
  const [address] = await database
    .select()
    .from(addresses)
    .where(andWhere(eq(addresses.id, id), eq(addresses.userId, userId)))
    .limit(1);
  return address ?? null;
};

const lockAddressOwner = async (
  transaction: Transaction,
  userId: string
): Promise<void> => {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`
  );
};
const nextPrimaryMutationVersion = async (
  transaction: Transaction,
  userId: string,
  candidate: Date,
  targetVersion?: Date
): Promise<Date> => {
  const [primary] = await transaction
    .select({ updatedAt: addresses.updatedAt })
    .from(addresses)
    .where(
      andWhere(eq(addresses.userId, userId), eq(addresses.isPrimary, true))
    )
    .limit(1);
  const priorMilliseconds = Math.max(
    targetVersion?.getTime() ?? Number.NEGATIVE_INFINITY,
    primary?.updatedAt.getTime() ?? Number.NEGATIVE_INFINITY
  );
  return Number.isFinite(priorMilliseconds)
    ? nextOptimisticVersion(candidate, new Date(priorMilliseconds))
    : candidate;
};

const clearPrimaryAddress = async (
  transaction: Transaction,
  userId: string,
  updatedAt: Date,
  excludedId?: string
): Promise<void> => {
  await transaction
    .update(addresses)
    .set({ isPrimary: false, updatedAt })
    .where(
      excludedId === undefined
        ? andWhere(eq(addresses.userId, userId), eq(addresses.isPrimary, true))
        : andWhere(
            eq(addresses.userId, userId),
            eq(addresses.isPrimary, true),
            ne(addresses.id, excludedId)
          )
    );
};

export const createAddressRepository = (
  database: DatabaseExecutor,
  dependencies: RepositoryDependencies = {}
): AddressRepository => {
  const { generateId, now } = resolveDependencies(dependencies);

  return {
    listByUserId: async (userId) => {
      return await database
        .select()
        .from(addresses)
        .where(eq(addresses.userId, userId))
        .orderBy(
          desc(addresses.isPrimary),
          asc(addresses.createdAt),
          asc(addresses.id)
        )
        .limit(MAX_ADDRESSES_PER_USER);
    },

    findByIdForUser: async (id, userId) => {
      return await findAddress(database, id, userId);
    },

    create: async (input) => {
      requireNonBlank(input.userId, "userId");
      requireNonBlank(input.line1, "line1");
      if (input.country.length !== 2) {
        throw new InvalidRepositoryInputError(
          "country must be a two-letter code"
        );
      }

      try {
        return await withTransaction(database, async (transaction) => {
          await lockAddressOwner(transaction, input.userId);
          const [addressCount] = await transaction
            .select({ value: sql<number>`count(*)::int` })
            .from(addresses)
            .where(eq(addresses.userId, input.userId));
          if ((addressCount?.value ?? 0) >= MAX_ADDRESSES_PER_USER) {
            throw new InvalidRepositoryInputError("address limit reached");
          }
          const timestamp = input.isPrimary
            ? await nextPrimaryMutationVersion(transaction, input.userId, now())
            : now();
          if (input.isPrimary) {
            await clearPrimaryAddress(transaction, input.userId, timestamp);
          }

          const [address] = await transaction
            .insert(addresses)
            .values({
              id: input.id ?? generateId(),
              userId: input.userId,
              type: input.type,
              line1: input.line1,
              line2: input.line2 ?? null,
              city: input.city,
              region: input.region,
              postalCode: input.postalCode,
              country: input.country.toUpperCase(),
              isPrimary: input.isPrimary ?? false,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning();
          return required(address, "address row");
        });
      } catch (error) {
        return mapConflict(error, "address");
      }
    },

    update: async (input) => {
      requireNonBlank(input.id, "id");
      requireNonBlank(input.userId, "userId");
      if (input.line1 !== undefined) requireNonBlank(input.line1, "line1");
      if (input.country !== undefined && input.country.length !== 2) {
        throw new InvalidRepositoryInputError(
          "country must be a two-letter code"
        );
      }

      try {
        return await withTransaction(database, async (transaction) => {
          await lockAddressOwner(transaction, input.userId);
          const existing = await findAddress(
            transaction,
            input.id,
            input.userId
          );
          if (!existing) return null;

          const updatedAt =
            input.isPrimary === true
              ? await nextPrimaryMutationVersion(
                  transaction,
                  input.userId,
                  now(),
                  existing.updatedAt
                )
              : now();
          if (input.isPrimary === true) {
            await clearPrimaryAddress(
              transaction,
              input.userId,
              updatedAt,
              input.id
            );
          }

          const [address] = await transaction
            .update(addresses)
            .set({
              ...(input.type === undefined ? {} : { type: input.type }),
              ...(input.line1 === undefined ? {} : { line1: input.line1 }),
              ...(input.line2 === undefined ? {} : { line2: input.line2 }),
              ...(input.city === undefined ? {} : { city: input.city }),
              ...(input.region === undefined ? {} : { region: input.region }),
              ...(input.postalCode === undefined
                ? {}
                : { postalCode: input.postalCode }),
              ...(input.country === undefined
                ? {}
                : { country: input.country.toUpperCase() }),
              ...(input.isPrimary === undefined
                ? {}
                : { isPrimary: input.isPrimary }),
              updatedAt,
            })
            .where(
              andWhere(
                eq(addresses.id, input.id),
                eq(addresses.userId, input.userId)
              )
            )
            .returning();
          return address ?? null;
        });
      } catch (error) {
        return mapConflict(error, "address");
      }
    },

    updateOptimistic: async (input) => {
      requireNonBlank(input.id, "id");
      requireNonBlank(input.userId, "userId");
      if (input.line1 !== undefined) requireNonBlank(input.line1, "line1");
      if (input.country !== undefined && input.country.length !== 2) {
        throw new InvalidRepositoryInputError(
          "country must be a two-letter code"
        );
      }

      const values = {
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.line1 === undefined ? {} : { line1: input.line1 }),
        ...(input.line2 === undefined ? {} : { line2: input.line2 }),
        ...(input.city === undefined ? {} : { city: input.city }),
        ...(input.region === undefined ? {} : { region: input.region }),
        ...(input.postalCode === undefined
          ? {}
          : { postalCode: input.postalCode }),
        ...(input.country === undefined
          ? {}
          : { country: input.country.toUpperCase() }),
        ...(input.isPrimary === undefined
          ? {}
          : { isPrimary: input.isPrimary }),
      };

      try {
        if (input.isPrimary === true) {
          return await withTransaction(database, async (transaction) => {
            await lockAddressOwner(transaction, input.userId);
            const existing = await findAddress(
              transaction,
              input.id,
              input.userId
            );
            if (existing === null) return null;
            if (
              existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
            ) {
              throw new OptimisticConcurrencyError("address");
            }

            const updatedAt = await nextPrimaryMutationVersion(
              transaction,
              input.userId,
              now(),
              existing.updatedAt
            );
            await clearPrimaryAddress(
              transaction,
              input.userId,
              updatedAt,
              input.id
            );
            const [address] = await transaction
              .update(addresses)
              .set({ ...values, updatedAt })
              .where(
                andWhere(
                  eq(addresses.id, input.id),
                  eq(addresses.userId, input.userId),
                  sql`date_trunc('milliseconds', ${addresses.updatedAt}) = ${input.expectedUpdatedAt}`
                )
              )
              .returning();
            if (address === undefined) {
              throw new OptimisticConcurrencyError("address");
            }
            return address;
          });
        }

        const [address] = await database
          .update(addresses)
          .set({
            ...values,
            updatedAt: nextOptimisticVersion(now(), input.expectedUpdatedAt),
          })
          .where(
            andWhere(
              eq(addresses.id, input.id),
              eq(addresses.userId, input.userId),
              sql`date_trunc('milliseconds', ${addresses.updatedAt}) = ${input.expectedUpdatedAt}`
            )
          )
          .returning();
        if (address !== undefined) return address;
        if ((await findAddress(database, input.id, input.userId)) === null) {
          return null;
        }
        throw new OptimisticConcurrencyError("address");
      } catch (error) {
        return mapConflict(error, "address");
      }
    },

    remove: async (id, userId) => {
      const removed = await database
        .delete(addresses)
        .where(andWhere(eq(addresses.id, id), eq(addresses.userId, userId)))
        .returning({ id: addresses.id });
      return removed.length > 0;
    },

    removeOptimistic: async (input) => {
      const removed = await database
        .delete(addresses)
        .where(
          andWhere(
            eq(addresses.id, input.id),
            eq(addresses.userId, input.userId),
            sql`date_trunc('milliseconds', ${addresses.updatedAt}) = ${input.expectedUpdatedAt}`
          )
        )
        .returning({ id: addresses.id });
      if (removed.length > 0) return true;
      if ((await findAddress(database, input.id, input.userId)) === null)
        return false;
      throw new OptimisticConcurrencyError("address");
    },

    setPrimary: async (id, userId) => {
      try {
        return await withTransaction(database, async (transaction) => {
          await lockAddressOwner(transaction, userId);
          const existing = await findAddress(transaction, id, userId);
          if (!existing) return null;
          const updatedAt = await nextPrimaryMutationVersion(
            transaction,
            userId,
            now(),
            existing.updatedAt
          );
          await clearPrimaryAddress(transaction, userId, updatedAt, id);
          const [address] = await transaction
            .update(addresses)
            .set({ isPrimary: true, updatedAt })
            .where(andWhere(eq(addresses.id, id), eq(addresses.userId, userId)))
            .returning();
          return address ?? null;
        });
      } catch (error) {
        return mapConflict(error, "address");
      }
    },

    setPrimaryOptimistic: async (input) => {
      return await withTransaction(database, async (transaction) => {
        await lockAddressOwner(transaction, input.userId);
        const existing = await findAddress(transaction, input.id, input.userId);
        if (existing === null) return null;
        if (
          existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
        ) {
          throw new OptimisticConcurrencyError("address");
        }
        const updatedAt = await nextPrimaryMutationVersion(
          transaction,
          input.userId,
          now(),
          existing.updatedAt
        );
        await clearPrimaryAddress(
          transaction,
          input.userId,
          updatedAt,
          input.id
        );
        const [address] = await transaction
          .update(addresses)
          .set({ isPrimary: true, updatedAt })
          .where(
            andWhere(
              eq(addresses.id, input.id),
              eq(addresses.userId, input.userId),
              sql`date_trunc('milliseconds', ${addresses.updatedAt}) = ${input.expectedUpdatedAt}`
            )
          )
          .returning();
        if (address === undefined) {
          throw new OptimisticConcurrencyError("address");
        }
        return address;
      });
    },
  };
};

export type UpsertUserPreferencesInput = Readonly<{
  userId: string;
  theme: AppearanceTheme;
  fontSize: FontSize;
  density: Density;
  radius: Radius;
  emailNotifications: boolean;
  productUpdates: boolean;
  analyticsConsent: boolean;
  personalizationConsent: boolean;
  profileVisibility: ProfileVisibility;
}>;
export type OptimisticUserPreferencesInput = Readonly<{
  userId: string;
  emailNotifications: boolean;
  productUpdates: boolean;
  analyticsConsent: boolean;
  personalizationConsent: boolean;
  profileVisibility: ProfileVisibility;
  expectedUpdatedAt: Date | null;
}>;

export type UpsertUserThemeInput = Readonly<{
  userId: string;
  theme: AppearanceTheme;
  fontSize: FontSize;
  density: Density;
  radius: Radius;
  expectedUpdatedAt: Date | null;
}>;

export type UserThemePreference = Readonly<
  Pick<
    UserPreferences,
    "theme" | "fontSize" | "density" | "radius" | "updatedAt"
  >
>;

export type UserPreferencesRepository = Readonly<{
  findByUserId: (userId: string) => Promise<UserPreferences | null>;
  findThemeByUserId: (userId: string) => Promise<UserThemePreference | null>;
  upsertTheme: (input: UpsertUserThemeInput) => Promise<UserThemePreference>;
  upsert: (input: UpsertUserPreferencesInput) => Promise<UserPreferences>;
  updateOptimistic: (
    input: OptimisticUserPreferencesInput
  ) => Promise<UserPreferences>;
}>;

const requireCanonical = (
  values: readonly string[],
  value: string,
  field: string
): void => {
  if (!values.includes(value)) {
    throw new InvalidRepositoryInputError(`${field} must be canonical`);
  }
};

export const createUserPreferencesRepository = (
  database: DatabaseExecutor,
  dependencies: RepositoryDependencies = {}
): UserPreferencesRepository => {
  const { now } = resolveDependencies(dependencies);

  return {
    findThemeByUserId: async (userId) => {
      requireNonBlank(userId, "userId");
      try {
        const [preference] = await database
          .select({
            theme: userPreferences.theme,
            fontSize: userPreferences.fontSize,
            density: userPreferences.density,
            radius: userPreferences.radius,
            updatedAt: userPreferences.updatedAt,
          })
          .from(userPreferences)
          .where(eq(userPreferences.userId, userId))
          .limit(1);
        return preference ?? null;
      } catch {
        throw new DatabasePersistenceError("theme preference query");
      }
    },

    findByUserId: async (userId) => {
      const [preferences] = await database
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1);
      return preferences ?? null;
    },

    upsertTheme: async (input) => {
      requireNonBlank(input.userId, "userId");
      requireCanonical(APPEARANCE_THEMES, input.theme, "theme");
      requireCanonical(FONT_SIZES, input.fontSize, "fontSize");
      requireCanonical(DENSITIES, input.density, "density");
      requireCanonical(RADII, input.radius, "radius");

      try {
        const updatedAt =
          input.expectedUpdatedAt === null
            ? now()
            : nextOptimisticVersion(now(), input.expectedUpdatedAt);
        const [preference] =
          input.expectedUpdatedAt === null
            ? await database
                .insert(userPreferences)
                .values({
                  userId: input.userId,
                  theme: input.theme,
                  fontSize: input.fontSize,
                  density: input.density,
                  radius: input.radius,
                  updatedAt,
                })
                .onConflictDoNothing()
                .returning({
                  theme: userPreferences.theme,
                  fontSize: userPreferences.fontSize,
                  density: userPreferences.density,
                  radius: userPreferences.radius,
                  updatedAt: userPreferences.updatedAt,
                })
            : await database
                .update(userPreferences)
                .set({
                  theme: input.theme,
                  fontSize: input.fontSize,
                  density: input.density,
                  radius: input.radius,
                  updatedAt,
                })
                .where(
                  andWhere(
                    eq(userPreferences.userId, input.userId),
                    sql`date_trunc('milliseconds', ${userPreferences.updatedAt}) = ${input.expectedUpdatedAt}`
                  )
                )
                .returning({
                  theme: userPreferences.theme,
                  fontSize: userPreferences.fontSize,
                  density: userPreferences.density,
                  radius: userPreferences.radius,
                  updatedAt: userPreferences.updatedAt,
                });
        if (preference === undefined) {
          throw new OptimisticConcurrencyError("theme preference");
        }
        return preference;
      } catch (error) {
        if (
          error instanceof InvalidRepositoryInputError ||
          error instanceof OptimisticConcurrencyError
        ) {
          throw error;
        }
        throw new DatabasePersistenceError("theme preference upsert");
      }
    },

    upsert: async (input) => {
      requireNonBlank(input.userId, "userId");
      const [preferences] = await database
        .insert(userPreferences)
        .values(input)
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            theme: input.theme,
            fontSize: input.fontSize,
            density: input.density,
            radius: input.radius,
            emailNotifications: input.emailNotifications,
            productUpdates: input.productUpdates,
            analyticsConsent: input.analyticsConsent,
            personalizationConsent: input.personalizationConsent,
            profileVisibility: input.profileVisibility,
            updatedAt: now(),
          },
        })
        .returning();
      return required(preferences, "preferences row");
    },

    updateOptimistic: async (input) => {
      requireNonBlank(input.userId, "userId");
      const updatedAt =
        input.expectedUpdatedAt === null
          ? now()
          : nextOptimisticVersion(now(), input.expectedUpdatedAt);
      const values = {
        emailNotifications: input.emailNotifications,
        productUpdates: input.productUpdates,
        analyticsConsent: input.analyticsConsent,
        personalizationConsent: input.personalizationConsent,
        profileVisibility: input.profileVisibility,
        updatedAt,
      };
      const [preferences] =
        input.expectedUpdatedAt === null
          ? await database
              .insert(userPreferences)
              .values({ userId: input.userId, ...values })
              .onConflictDoNothing()
              .returning()
          : await database
              .update(userPreferences)
              .set(values)
              .where(
                andWhere(
                  eq(userPreferences.userId, input.userId),
                  sql`date_trunc('milliseconds', ${userPreferences.updatedAt}) = ${input.expectedUpdatedAt}`
                )
              )
              .returning();
      if (preferences === undefined) {
        throw new OptimisticConcurrencyError("user preferences");
      }
      return preferences;
    },
  };
};

export type FeatureMutationContext = Readonly<{
  actorUserId: string | null;
  requestId: string;
}>;

export type CreateFeatureItemInput = Readonly<{
  id?: string;
  ownerId: string;
  name: string;
  description: string;
  status?: FeatureItemStatus;
  metadata?: FeatureItemMetadata;
}>;

export type UpdateFeatureItemInput = Readonly<{
  id: string;
  ownerId: string;
  name?: string;
  description?: string;
  status?: FeatureItemStatus;
  metadata?: FeatureItemMetadata;
}>;

export type FeatureListFilters = Readonly<{
  query?: string;
  status?: FeatureItemStatus;
  limit?: number;
}>;

export type FeatureItemRepository = Readonly<{
  listByOwner: (
    ownerId: string,
    filters?: FeatureListFilters
  ) => Promise<FeatureItem[]>;
  findByIdForOwner: (
    id: string,
    ownerId: string
  ) => Promise<FeatureItem | null>;
  create: (
    input: CreateFeatureItemInput,
    context: FeatureMutationContext
  ) => Promise<FeatureItem>;
  update: (
    input: UpdateFeatureItemInput,
    context: FeatureMutationContext
  ) => Promise<FeatureItem | null>;
  archive: (
    id: string,
    ownerId: string,
    context: FeatureMutationContext
  ) => Promise<FeatureItem | null>;
}>;

type FeatureMutationAction =
  | "feature_item.created"
  | "feature_item.updated"
  | "feature_item.archived";

const validateMutationContext = (context: FeatureMutationContext): void => {
  requireNonBlank(context.requestId, "requestId");
  if (context.actorUserId !== null) {
    requireNonBlank(context.actorUserId, "actorUserId");
  }
};

const writeMutationRecords = async (
  transaction: Transaction,
  item: FeatureItem,
  action: FeatureMutationAction,
  context: FeatureMutationContext,
  metadata: FeatureItemMetadata,
  dependencies: ResolvedRepositoryDependencies,
  occurredAt: Date
): Promise<void> => {
  await transaction.insert(auditRecords).values({
    id: dependencies.generateId(),
    actorUserId: context.actorUserId,
    action,
    entityType: "feature_item",
    entityId: item.id,
    metadata,
    requestId: context.requestId,
    createdAt: occurredAt,
  });

  await transaction.insert(outboxEvents).values({
    id: dependencies.generateId(),
    eventType: action,
    aggregateType: "feature_item",
    aggregateId: item.id,
    payload: {
      id: item.id,
      ownerId: item.ownerId,
      status: item.status,
    },
    occurredAt,
    attemptCount: 0,
  });
};

const findFeatureItem = async (
  database: DatabaseExecutor,
  id: string,
  ownerId: string
): Promise<FeatureItem | null> => {
  const [item] = await database
    .select()
    .from(featureItems)
    .where(andWhere(eq(featureItems.id, id), eq(featureItems.ownerId, ownerId)))
    .limit(1);
  return item ?? null;
};

export const createFeatureItemRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): FeatureItemRepository => {
  const dependencies = resolveDependencies(repositoryDependencies);

  return {
    listByOwner: async (ownerId, filters = {}) => {
      const limit = filters.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new InvalidRepositoryInputError(
          "feature list limit must be 1-100"
        );
      }
      if (filters.query !== undefined) {
        requireNonBlank(filters.query, "query");
        if (filters.query.length > 200) {
          throw new InvalidRepositoryInputError(
            "query must not exceed 200 characters"
          );
        }
      }
      const conditions: (SQL | undefined)[] = [
        eq(featureItems.ownerId, ownerId),
      ];
      if (filters.query !== undefined) {
        const escaped = filters.query
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_");
        const pattern = `%${escaped}%`;
        conditions.push(
          orWhere(
            ilike(featureItems.name, pattern),
            ilike(featureItems.description, pattern)
          )
        );
      }
      if (filters.status !== undefined) {
        conditions.push(eq(featureItems.status, filters.status));
      }
      return await database
        .select()
        .from(featureItems)
        .where(andWhere(...conditions))
        .orderBy(desc(featureItems.updatedAt), desc(featureItems.id))
        .limit(limit);
    },

    findByIdForOwner: async (id, ownerId) => {
      return await findFeatureItem(database, id, ownerId);
    },

    create: async (input, context) => {
      requireNonBlank(input.ownerId, "ownerId");
      requireNonBlank(input.name, "name");
      validateMutationContext(context);
      const metadata = validateFeatureMetadata(
        input.metadata === undefined ? {} : input.metadata
      );

      try {
        return await withTransaction(database, async (transaction) => {
          const timestamp = dependencies.now();
          const [item] = await transaction
            .insert(featureItems)
            .values({
              id: input.id ?? dependencies.generateId(),
              ownerId: input.ownerId,
              name: input.name,
              description: input.description,
              status: input.status ?? "draft",
              metadata,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning();
          const createdItem = required(item, "feature item row");
          await writeMutationRecords(
            transaction,
            createdItem,
            "feature_item.created",
            context,
            { status: createdItem.status },
            dependencies,
            timestamp
          );
          return createdItem;
        });
      } catch (error) {
        return mapFeatureMutationError(error);
      }
    },

    update: async (input, context) => {
      requireNonBlank(input.id, "id");
      requireNonBlank(input.ownerId, "ownerId");
      if (input.name !== undefined) requireNonBlank(input.name, "name");
      validateMutationContext(context);
      const metadata =
        input.metadata === undefined
          ? undefined
          : validateFeatureMetadata(input.metadata);

      const changedFields = [
        input.name === undefined ? null : "name",
        input.description === undefined ? null : "description",
        input.status === undefined ? null : "status",
        input.metadata === undefined ? null : "metadata",
      ].filter((field): field is string => field !== null);
      if (changedFields.length === 0) {
        throw new InvalidRepositoryInputError(
          "feature item update must change at least one field"
        );
      }

      try {
        return await withTransaction(database, async (transaction) => {
          const timestamp = dependencies.now();
          const [item] = await transaction
            .update(featureItems)
            .set({
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.description === undefined
                ? {}
                : { description: input.description }),
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(metadata === undefined ? {} : { metadata }),
              updatedAt: timestamp,
            })
            .where(
              andWhere(
                eq(featureItems.id, input.id),
                eq(featureItems.ownerId, input.ownerId)
              )
            )
            .returning();
          if (!item) return null;

          await writeMutationRecords(
            transaction,
            item,
            "feature_item.updated",
            context,
            { changedFields },
            dependencies,
            timestamp
          );
          return item;
        });
      } catch (error) {
        return mapFeatureMutationError(error);
      }
    },

    archive: async (id, ownerId, context) => {
      requireNonBlank(id, "id");
      requireNonBlank(ownerId, "ownerId");
      validateMutationContext(context);

      try {
        return await withTransaction(database, async (transaction) => {
          const timestamp = dependencies.now();
          const [item] = await transaction
            .update(featureItems)
            .set({ status: "archived", updatedAt: timestamp })
            .where(
              andWhere(
                eq(featureItems.id, id),
                eq(featureItems.ownerId, ownerId)
              )
            )
            .returning();
          if (!item) return null;

          await writeMutationRecords(
            transaction,
            item,
            "feature_item.archived",
            context,
            { status: "archived" },
            dependencies,
            timestamp
          );
          return item;
        });
      } catch (error) {
        return mapFeatureMutationError(error);
      }
    },
  };
};

export type WatchlistBuyZone = Readonly<{
  low: string | null;
  high: string | null;
}>;

export type UpdateWatchlistItemInput = Readonly<{
  id: string;
  userId: string;
  note?: string | null;
  buyZone?: WatchlistBuyZone;
}>;

export type AddWatchlistSymbolsResult = Readonly<{
  added: WatchlistItem[];
  existing: string[];
}>;

export type WatchlistRepository = Readonly<{
  listByUser: (userId: string) => Promise<WatchlistItem[]>;
  addMany: (
    userId: string,
    symbols: readonly string[]
  ) => Promise<AddWatchlistSymbolsResult>;
  update: (input: UpdateWatchlistItemInput) => Promise<WatchlistItem | null>;
  remove: (id: string, userId: string) => Promise<boolean>;
}>;

const WATCHLIST_MAX_SYMBOLS_PER_ADD = 200;
const WATCHLIST_MAX_ITEMS_LISTED = 1000;
const WATCHLIST_DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/;

export const normalizeWatchlistSymbol = (value: string): string | null => {
  const symbol = value.trim().toUpperCase();
  return WATCHLIST_SYMBOL_PATTERN.test(symbol) ? symbol : null;
};

// Scaled integer comparison avoids binary floating point for price bounds.
const scaledDecimal = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(required(whole, "whole") + fraction.padEnd(8, "0"));
};

const validateBuyZone = (zone: WatchlistBuyZone): void => {
  for (const [label, value] of [
    ["buy zone low", zone.low],
    ["buy zone high", zone.high],
  ] as const) {
    if (value === null) continue;
    if (!WATCHLIST_DECIMAL_PATTERN.test(value)) {
      throw new InvalidRepositoryInputError(
        `${label} must be a positive decimal`
      );
    }
    if (scaledDecimal(value) <= 0n) {
      throw new InvalidRepositoryInputError(
        `${label} must be greater than zero`
      );
    }
  }
  if (
    zone.low !== null &&
    zone.high !== null &&
    scaledDecimal(zone.low) > scaledDecimal(zone.high)
  ) {
    throw new InvalidRepositoryInputError(
      "buy zone low must not exceed buy zone high"
    );
  }
};

const mapWatchlistMutationError = (error: unknown): never => {
  if (error instanceof InvalidRepositoryInputError) throw error;
  const details = databaseErrorDetails(error);
  if (details.code === "23514") {
    throw new InvalidRepositoryInputError(
      "watchlist item violates a field constraint"
    );
  }
  if (details.code === "23505") {
    throw new DatabaseConflictError("watchlist item");
  }
  if (typeof details.code === "string") {
    throw new DatabasePersistenceError("watchlist mutation");
  }
  throw error;
};

export const createWatchlistRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): WatchlistRepository => {
  const dependencies = resolveDependencies(repositoryDependencies);

  return {
    listByUser: async (userId) => {
      requireNonBlank(userId, "userId");
      return await database
        .select()
        .from(watchlistItems)
        .where(eq(watchlistItems.userId, userId))
        .orderBy(asc(watchlistItems.symbol))
        .limit(WATCHLIST_MAX_ITEMS_LISTED);
    },
    addMany: async (userId, rawSymbols) => {
      requireNonBlank(userId, "userId");
      const symbols: string[] = [];
      for (const raw of rawSymbols) {
        const symbol = normalizeWatchlistSymbol(raw);
        if (symbol === null) {
          throw new InvalidRepositoryInputError(
            `invalid symbol: ${raw.trim().slice(0, 16)}`
          );
        }
        if (!symbols.includes(symbol)) symbols.push(symbol);
      }
      if (symbols.length === 0) {
        throw new InvalidRepositoryInputError(
          "at least one symbol is required"
        );
      }
      if (symbols.length > WATCHLIST_MAX_SYMBOLS_PER_ADD) {
        throw new InvalidRepositoryInputError(
          `at most ${WATCHLIST_MAX_SYMBOLS_PER_ADD} symbols per add`
        );
      }
      try {
        const timestamp = dependencies.now();
        const added = await database
          .insert(watchlistItems)
          .values(
            symbols.map((symbol) => ({
              id: dependencies.generateId(),
              userId,
              symbol,
              createdAt: timestamp,
              updatedAt: timestamp,
            }))
          )
          .onConflictDoNothing({
            target: [watchlistItems.userId, watchlistItems.symbol],
          })
          .returning();
        const addedSymbols = new Set(added.map((item) => item.symbol));
        return {
          added,
          existing: symbols.filter((symbol) => !addedSymbols.has(symbol)),
        };
      } catch (error) {
        return mapWatchlistMutationError(error);
      }
    },

    update: async (input) => {
      requireNonBlank(input.id, "id");
      requireNonBlank(input.userId, "userId");
      if (input.note === undefined && input.buyZone === undefined) {
        throw new InvalidRepositoryInputError(
          "watchlist update must change note or buy zone"
        );
      }
      const note =
        input.note === undefined || input.note === null
          ? input.note
          : input.note.trim() === ""
            ? null
            : input.note.trim();
      if (typeof note === "string" && note.length > WATCHLIST_NOTE_MAX_LENGTH) {
        throw new InvalidRepositoryInputError(
          `note must not exceed ${WATCHLIST_NOTE_MAX_LENGTH} characters`
        );
      }
      if (input.buyZone !== undefined) validateBuyZone(input.buyZone);
      try {
        const [item] = await database
          .update(watchlistItems)
          .set({
            ...(note === undefined ? {} : { note }),
            ...(input.buyZone === undefined
              ? {}
              : {
                  buyZoneLow: input.buyZone.low,
                  buyZoneHigh: input.buyZone.high,
                }),
            updatedAt: dependencies.now(),
          })
          .where(
            andWhere(
              eq(watchlistItems.id, input.id),
              eq(watchlistItems.userId, input.userId)
            )
          )
          .returning();
        return item ?? null;
      } catch (error) {
        return mapWatchlistMutationError(error);
      }
    },

    remove: async (id, userId) => {
      requireNonBlank(id, "id");
      requireNonBlank(userId, "userId");
      try {
        const removed = await database
          .delete(watchlistItems)
          .where(
            andWhere(
              eq(watchlistItems.id, id),
              eq(watchlistItems.userId, userId)
            )
          )
          .returning({ id: watchlistItems.id });
        return removed.length > 0;
      } catch (error) {
        return mapWatchlistMutationError(error);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Owner to-do list (portal /todos and the agent API). Owner-scoped like the watchlist.

export type TodoInput = Readonly<{
  title: string;
  note?: string | null;
  dueDate?: string | null;
  tags?: readonly string[];
  sourceUrl?: string | null;
}>;

export type UpdateTodoInput = Readonly<{
  id: string;
  userId: string;
  title?: string;
  note?: string | null;
  status?: TodoStatus;
  dueDate?: string | null;
  tags?: readonly string[];
  sourceUrl?: string | null;
}>;

export type TodoRepository = Readonly<{
  listByUser: (userId: string, tag?: string) => Promise<Todo[]>;
  create: (userId: string, input: TodoInput) => Promise<Todo>;
  update: (input: UpdateTodoInput) => Promise<Todo | null>;
  remove: (id: string, userId: string) => Promise<boolean>;
}>;

const TODO_MAX_ITEMS_LISTED = 1000;
const TODO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TODO_URL_MAX_LENGTH = 2000;

const normalizeTodoTitle = (value: string): string => {
  const title = value.trim();
  if (title.length === 0 || title.length > TODO_TITLE_MAX_LENGTH) {
    throw new InvalidRepositoryInputError(
      `title must be 1 to ${TODO_TITLE_MAX_LENGTH} characters`
    );
  }
  return title;
};

const normalizeTodoNote = (value: string | null): string | null => {
  if (value === null) return null;
  const note = value.trim();
  if (note.length > TODO_NOTE_MAX_LENGTH) {
    throw new InvalidRepositoryInputError(
      `note must not exceed ${TODO_NOTE_MAX_LENGTH} characters`
    );
  }
  return note === "" ? null : note;
};

export const normalizeTodoDueDate = (value: string | null): string | null => {
  if (value === null || value.trim() === "") return null;
  const date = value.trim();
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    !TODO_DATE_PATTERN.test(date) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new InvalidRepositoryInputError("due date must be YYYY-MM-DD");
  }
  return date;
};

export const normalizeTodoTags = (values: readonly string[]): string[] => {
  const tags: string[] = [];
  for (const raw of values) {
    const tag = raw.trim().toLowerCase();
    if (tag === "") continue;
    if (!TODO_TAG_PATTERN.test(tag)) {
      throw new InvalidRepositoryInputError(
        `invalid tag: ${raw.trim().slice(0, 32)}`
      );
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > TODO_MAX_TAGS) {
    throw new InvalidRepositoryInputError(
      `at most ${TODO_MAX_TAGS} tags per to-do`
    );
  }
  return tags;
};

const normalizeTodoSourceUrl = (value: string | null): string | null => {
  if (value === null || value.trim() === "") return null;
  const url = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidRepositoryInputError("source URL is not a valid URL");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    url.length > TODO_URL_MAX_LENGTH
  ) {
    throw new InvalidRepositoryInputError(
      "source URL must be an http(s) URL of at most 2000 characters"
    );
  }
  return url;
};

const mapTodoMutationError = (error: unknown): never => {
  const details = databaseErrorDetails(error);
  if (details.code === "23514") {
    throw new InvalidRepositoryInputError("to-do violates a field constraint");
  }
  if (typeof details.code === "string") {
    throw new DatabasePersistenceError("to-do mutation");
  }
  throw error;
};

export const createTodoRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): TodoRepository => {
  const dependencies = resolveDependencies(repositoryDependencies);

  return {
    create: async (userId, input) => {
      requireNonBlank(userId, "userId");
      const values = {
        dueDate: normalizeTodoDueDate(input.dueDate ?? null),
        note: normalizeTodoNote(input.note ?? null),
        sourceUrl: normalizeTodoSourceUrl(input.sourceUrl ?? null),
        tags: normalizeTodoTags(input.tags ?? []),
        title: normalizeTodoTitle(input.title),
      };
      try {
        const timestamp = dependencies.now();
        const [item] = await database
          .insert(todos)
          .values({
            id: dependencies.generateId(),
            status: "open",
            userId,
            ...values,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning();
        return required(item, "inserted to-do");
      } catch (error) {
        return mapTodoMutationError(error);
      }
    },
    // Open first, then earliest due date (no date last), then newest.
    listByUser: async (userId, tag) => {
      requireNonBlank(userId, "userId");
      const ownerOnly = eq(todos.userId, userId);
      // A blank tag means no filter.
      const [tagFilter] = normalizeTodoTags(tag === undefined ? [] : [tag]);
      const filter =
        tagFilter === undefined
          ? ownerOnly
          : andWhere(ownerOnly, sql`${tagFilter} = any(${todos.tags})`);
      try {
        return await database
          .select()
          .from(todos)
          .where(filter)
          .orderBy(
            sql`case when ${todos.status} = 'open' then 0 else 1 end`,
            sql`${todos.dueDate} asc nulls last`,
            desc(todos.createdAt)
          )
          .limit(TODO_MAX_ITEMS_LISTED);
      } catch (error) {
        return mapTodoMutationError(error);
      }
    },

    remove: async (id, userId) => {
      requireNonBlank(id, "id");
      requireNonBlank(userId, "userId");
      try {
        const removed = await database
          .delete(todos)
          .where(andWhere(eq(todos.id, id), eq(todos.userId, userId)))
          .returning({ id: todos.id });
        return removed.length > 0;
      } catch (error) {
        return mapTodoMutationError(error);
      }
    },

    update: async (input) => {
      requireNonBlank(input.id, "id");
      requireNonBlank(input.userId, "userId");
      const changes = {
        ...(input.title === undefined
          ? {}
          : { title: normalizeTodoTitle(input.title) }),
        ...(input.note === undefined
          ? {}
          : { note: normalizeTodoNote(input.note) }),
        ...(input.dueDate === undefined
          ? {}
          : { dueDate: normalizeTodoDueDate(input.dueDate) }),
        ...(input.tags === undefined
          ? {}
          : { tags: normalizeTodoTags(input.tags) }),
        ...(input.sourceUrl === undefined
          ? {}
          : { sourceUrl: normalizeTodoSourceUrl(input.sourceUrl) }),
        ...(input.status === undefined ? {} : { status: input.status }),
      };
      if (Object.keys(changes).length === 0) {
        throw new InvalidRepositoryInputError("to-do update changes nothing");
      }
      if (input.status !== undefined && !TODO_STATUSES.includes(input.status)) {
        throw new InvalidRepositoryInputError("status must be open or done");
      }
      try {
        const [item] = await database
          .update(todos)
          .set({ ...changes, updatedAt: dependencies.now() })
          .where(
            andWhere(eq(todos.id, input.id), eq(todos.userId, input.userId))
          )
          .returning();
        return item ?? null;
      } catch (error) {
        return mapTodoMutationError(error);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Agent operations ledger and research paper library (workspace-scoped, no owner column).

const AGENT_METRICS_MAX_KEYS = 40;
const AGENT_METRIC_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const AGENT_METRIC_STRING_MAX_LENGTH = 200;
const AGENT_LINKS_MAX = 20;
const AGENT_LINK_LABEL_MAX_LENGTH = 100;
const AGENT_LINK_URL_MAX_LENGTH = 2000;
const AGENT_TASK_TITLE_MAX_LENGTH = 300;
const AGENT_TASK_AGENT_MAX_LENGTH = 100;
const AGENT_TASK_SUMMARY_MAX_LENGTH = 4000;
const AGENT_EVENT_MESSAGE_MAX_LENGTH = 2000;
const AGENT_TASKS_MAX_LISTED = 200;
const AGENT_TASK_EVENTS_MAX_LISTED = 500;
const AGENT_SUMMARY_EVENTS_LISTED = 20;
const RESEARCH_PAPER_TEXT_MAX_LENGTH = 4000;
const RESEARCH_PAPERS_MAX_LISTED = 500;
export const AGENT_TERMINAL_STATUSES: readonly AgentTaskStatus[] =
  Object.freeze(["succeeded", "failed", "cancelled"]);

const includesValue = <T extends string>(
  values: readonly T[],
  value: unknown
): value is T => {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
};

const boundedText = (value: string, field: string, max: number): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new InvalidRepositoryInputError(`${field} must not be blank`);
  if (trimmed.length > max)
    throw new InvalidRepositoryInputError(
      `${field} must not exceed ${max} characters`
    );
  return trimmed;
};

const optionalText = (
  value: string | null | undefined,
  field: string,
  max: number
): string | null | undefined => {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max)
    throw new InvalidRepositoryInputError(
      `${field} must not exceed ${max} characters`
    );
  return trimmed;
};

export const validateAgentMetrics = (
  value: unknown,
  field = "metrics"
): AgentMetrics => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRepositoryInputError(`${field} must be a flat object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > AGENT_METRICS_MAX_KEYS) {
    throw new InvalidRepositoryInputError(
      `${field} must not exceed ${AGENT_METRICS_MAX_KEYS} keys`
    );
  }
  const result: AgentMetrics = {};
  for (const [key, entry] of entries) {
    if (!AGENT_METRIC_KEY_PATTERN.test(key)) {
      throw new InvalidRepositoryInputError(
        `${field} key is invalid: ${key.slice(0, 32)}`
      );
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry))
        throw new InvalidRepositoryInputError(`${field}.${key} must be finite`);
      result[key] = entry;
    } else if (typeof entry === "string") {
      if (entry.length > AGENT_METRIC_STRING_MAX_LENGTH) {
        throw new InvalidRepositoryInputError(
          `${field}.${key} must not exceed ${AGENT_METRIC_STRING_MAX_LENGTH} characters`
        );
      }
      result[key] = entry;
    } else {
      throw new InvalidRepositoryInputError(
        `${field}.${key} must be a number or string`
      );
    }
  }
  return result;
};

const isSafeAgentLinkUrl = (value: string): boolean => {
  if (value.length > AGENT_LINK_URL_MAX_LENGTH) return false;
  // Relative portal paths are allowed; absolute links must be http(s).
  if (/^\/(?!\/)/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

export const validateAgentLinks = (value: unknown): AgentLink[] => {
  if (!Array.isArray(value))
    throw new InvalidRepositoryInputError("links must be an array");
  if (value.length > AGENT_LINKS_MAX) {
    throw new InvalidRepositoryInputError(
      `links must not exceed ${AGENT_LINKS_MAX} entries`
    );
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new InvalidRepositoryInputError("each link must be an object");
    }
    const { label, url } = entry as Record<string, unknown>;
    if (typeof label !== "string" || typeof url !== "string") {
      throw new InvalidRepositoryInputError("each link needs a label and url");
    }
    const cleanUrl = url.trim();
    if (!isSafeAgentLinkUrl(cleanUrl)) {
      throw new InvalidRepositoryInputError(
        "link url must be http(s) or a portal path"
      );
    }
    return {
      label: boundedText(label, "link label", AGENT_LINK_LABEL_MAX_LENGTH),
      url: cleanUrl,
    };
  });
};

// Status transitions own the lifecycle timestamps; callers never set them directly.
export const agentTaskLifecycle = (
  current: Pick<AgentTask, "startedAt" | "finishedAt">,
  status: AgentTaskStatus,
  now: Date
): Pick<AgentTask, "startedAt" | "finishedAt"> => {
  if (status === "queued") return { startedAt: null, finishedAt: null };
  if (AGENT_TERMINAL_STATUSES.includes(status)) {
    return { startedAt: current.startedAt ?? null, finishedAt: now };
  }
  return { startedAt: current.startedAt ?? now, finishedAt: null };
};

const mapAgentOpsMutationError = (error: unknown, entity: string): never => {
  if (error instanceof InvalidRepositoryInputError) throw error;
  const details = databaseErrorDetails(error);
  if (details.code === "23514") {
    throw new InvalidRepositoryInputError(
      `${entity} violates a field constraint`
    );
  }
  if (details.code === "23503") {
    throw new InvalidRepositoryInputError(
      `${entity} references a missing record`
    );
  }
  if (details.code === "23505") {
    throw new DatabaseConflictError(entity);
  }
  if (typeof details.code === "string") {
    throw new DatabasePersistenceError(`${entity} mutation`);
  }
  throw error;
};

const mapAgentOpsReadError = (error: unknown, entity: string): never => {
  if (typeof databaseErrorDetails(error).code === "string") {
    throw new DatabasePersistenceError(`${entity} read`);
  }
  throw error;
};

export type AgentTaskListFilters = Readonly<{
  status?: AgentTaskStatus;
  kind?: AgentTaskKind;
  limit?: number;
}>;

export type CreateAgentTaskInput = Readonly<{
  kind: AgentTaskKind;
  agent: string;
  title: string;
  summary?: string | null;
  status?: AgentTaskStatus;
  metrics?: AgentMetrics;
  links?: readonly AgentLink[];
  paperId?: string | null;
}>;

export type UpdateAgentTaskInput = Readonly<{
  id: string;
  status?: AgentTaskStatus;
  title?: string;
  summary?: string | null;
  metrics?: AgentMetrics;
  links?: readonly AgentLink[];
  paperId?: string | null;
}>;

export type AppendAgentTaskEventInput = Readonly<{
  taskId: string;
  level?: AgentTaskEventLevel;
  message: string;
}>;

export type AgentTaskEventWithTask = AgentTaskEvent &
  Readonly<{ taskTitle: string; taskKind: AgentTaskKind }>;

export type AgentOpsSummary = Readonly<{
  statusCounts: Record<AgentTaskStatus, number>;
  failedLast24h: number;
  paperStageCounts: Record<ResearchPaperStage, number>;
  latestEvents: AgentTaskEventWithTask[];
}>;

export type AgentOpsRepository = Readonly<{
  summary: () => Promise<AgentOpsSummary>;
  listTasks: (filters?: AgentTaskListFilters) => Promise<AgentTask[]>;
  getTask: (
    id: string
  ) => Promise<Readonly<{ task: AgentTask; events: AgentTaskEvent[] }> | null>;
  createTask: (input: CreateAgentTaskInput) => Promise<AgentTask>;
  updateTask: (input: UpdateAgentTaskInput) => Promise<AgentTask | null>;
  appendEvent: (
    input: AppendAgentTaskEventInput
  ) => Promise<AgentTaskEvent | null>;
}>;

const zeroCounts = <T extends string>(
  keys: readonly T[]
): Record<T, number> => {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
};

const clampLimit = (
  limit: number | undefined,
  fallback: number,
  max: number
): number => {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1)
    throw new InvalidRepositoryInputError("limit must be a positive integer");
  return Math.min(limit, max);
};

export const createAgentOpsRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): AgentOpsRepository => {
  const dependencies = resolveDependencies(repositoryDependencies);

  return {
    summary: async () => {
      try {
        const cutoff = new Date(
          dependencies.now().getTime() - 24 * 60 * 60 * 1000
        );
        const statusRows = await database
          .select({
            status: agentTasks.status,
            count: sql<number>`count(*)::int`,
          })
          .from(agentTasks)
          .groupBy(agentTasks.status);
        const failedRows = await database
          .select({ count: sql<number>`count(*)::int` })
          .from(agentTasks)
          .where(
            andWhere(
              eq(agentTasks.status, "failed"),
              sql`coalesce(${agentTasks.finishedAt}, ${agentTasks.updatedAt}) >= ${cutoff.toISOString()}::timestamptz`
            )
          );
        const stageRows = await database
          .select({
            stage: researchPapers.stage,
            count: sql<number>`count(*)::int`,
          })
          .from(researchPapers)
          .groupBy(researchPapers.stage);
        const eventRows = await database
          .select({
            id: agentTaskEvents.id,
            taskId: agentTaskEvents.taskId,
            at: agentTaskEvents.at,
            level: agentTaskEvents.level,
            message: agentTaskEvents.message,
            taskTitle: agentTasks.title,
            taskKind: agentTasks.kind,
          })
          .from(agentTaskEvents)
          .innerJoin(agentTasks, eq(agentTaskEvents.taskId, agentTasks.id))
          .orderBy(desc(agentTaskEvents.at), desc(agentTaskEvents.id))
          .limit(AGENT_SUMMARY_EVENTS_LISTED);
        const statusCounts = zeroCounts(AGENT_TASK_STATUSES);
        for (const entry of statusRows) {
          if (includesValue(AGENT_TASK_STATUSES, entry.status))
            statusCounts[entry.status] = Number(entry.count);
        }
        const paperStageCounts = zeroCounts(RESEARCH_PAPER_STAGES);
        for (const entry of stageRows) {
          if (includesValue(RESEARCH_PAPER_STAGES, entry.stage))
            paperStageCounts[entry.stage] = Number(entry.count);
        }
        return {
          statusCounts,
          failedLast24h: Number(failedRows[0]?.count ?? 0),
          paperStageCounts,
          latestEvents: eventRows,
        };
      } catch (error) {
        return mapAgentOpsReadError(error, "agent summary");
      }
    },

    listTasks: async (filters = {}) => {
      if (
        filters.status !== undefined &&
        !includesValue(AGENT_TASK_STATUSES, filters.status)
      ) {
        throw new InvalidRepositoryInputError("unknown task status");
      }
      if (
        filters.kind !== undefined &&
        !includesValue(AGENT_TASK_KINDS, filters.kind)
      ) {
        throw new InvalidRepositoryInputError("unknown task kind");
      }
      const limit = clampLimit(filters.limit, 100, AGENT_TASKS_MAX_LISTED);
      const conditions = [
        ...(filters.status === undefined
          ? []
          : [eq(agentTasks.status, filters.status)]),
        ...(filters.kind === undefined
          ? []
          : [eq(agentTasks.kind, filters.kind)]),
      ];
      try {
        return await database
          .select()
          .from(agentTasks)
          .where(conditions.length === 0 ? undefined : andWhere(...conditions))
          .orderBy(desc(agentTasks.updatedAt), desc(agentTasks.id))
          .limit(limit);
      } catch (error) {
        return mapAgentOpsReadError(error, "agent tasks");
      }
    },

    getTask: async (id) => {
      requireNonBlank(id, "id");
      try {
        const [task] = await database
          .select()
          .from(agentTasks)
          .where(eq(agentTasks.id, id))
          .limit(1);
        if (task === undefined) return null;
        const events = await database
          .select()
          .from(agentTaskEvents)
          .where(eq(agentTaskEvents.taskId, id))
          .orderBy(desc(agentTaskEvents.at), desc(agentTaskEvents.id))
          .limit(AGENT_TASK_EVENTS_MAX_LISTED);
        return { task, events };
      } catch (error) {
        return mapAgentOpsReadError(error, "agent task");
      }
    },

    createTask: async (input) => {
      if (!includesValue(AGENT_TASK_KINDS, input.kind))
        throw new InvalidRepositoryInputError("unknown task kind");
      const status = input.status ?? "queued";
      if (!includesValue(AGENT_TASK_STATUSES, status))
        throw new InvalidRepositoryInputError("unknown task status");
      const title = boundedText(
        input.title,
        "title",
        AGENT_TASK_TITLE_MAX_LENGTH
      );
      const agent = boundedText(
        input.agent,
        "agent",
        AGENT_TASK_AGENT_MAX_LENGTH
      );
      const summary =
        optionalText(input.summary, "summary", AGENT_TASK_SUMMARY_MAX_LENGTH) ??
        null;
      const metrics = validateAgentMetrics(input.metrics ?? {});
      const links = validateAgentLinks(input.links ?? []);
      const timestamp = dependencies.now();
      const lifecycle = agentTaskLifecycle(
        { startedAt: null, finishedAt: null },
        status,
        timestamp
      );
      try {
        const [task] = await database
          .insert(agentTasks)
          .values({
            id: dependencies.generateId(),
            kind: input.kind,
            agent,
            title,
            summary,
            status,
            metrics,
            links,
            paperId: input.paperId ?? null,
            createdAt: timestamp,
            updatedAt: timestamp,
            ...lifecycle,
          })
          .returning();
        return required(task, "task");
      } catch (error) {
        return mapAgentOpsMutationError(error, "agent task");
      }
    },
    updateTask: async (input) => {
      requireNonBlank(input.id, "id");
      if (
        input.status !== undefined &&
        !includesValue(AGENT_TASK_STATUSES, input.status)
      ) {
        throw new InvalidRepositoryInputError("unknown task status");
      }
      const title =
        input.title === undefined
          ? undefined
          : boundedText(input.title, "title", AGENT_TASK_TITLE_MAX_LENGTH);
      const summary = optionalText(
        input.summary,
        "summary",
        AGENT_TASK_SUMMARY_MAX_LENGTH
      );
      const metrics =
        input.metrics === undefined
          ? undefined
          : validateAgentMetrics(input.metrics);
      const links =
        input.links === undefined ? undefined : validateAgentLinks(input.links);
      if (
        [input.status, title, summary, metrics, links, input.paperId].every(
          (value) => value === undefined
        )
      ) {
        throw new InvalidRepositoryInputError(
          "task update must change at least one field"
        );
      }
      try {
        const [current] = await database
          .select({
            startedAt: agentTasks.startedAt,
            finishedAt: agentTasks.finishedAt,
            status: agentTasks.status,
          })
          .from(agentTasks)
          .where(eq(agentTasks.id, input.id))
          .limit(1);
        if (current === undefined) return null;
        const timestamp = dependencies.now();
        const lifecycle =
          input.status === undefined || input.status === current.status
            ? {}
            : agentTaskLifecycle(current, input.status, timestamp);
        const [task] = await database
          .update(agentTasks)
          .set({
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(title === undefined ? {} : { title }),
            ...(summary === undefined ? {} : { summary }),
            ...(metrics === undefined ? {} : { metrics }),
            ...(links === undefined ? {} : { links }),
            ...(input.paperId === undefined ? {} : { paperId: input.paperId }),
            ...lifecycle,
            updatedAt: timestamp,
          })
          .where(eq(agentTasks.id, input.id))
          .returning();
        return task ?? null;
      } catch (error) {
        return mapAgentOpsMutationError(error, "agent task");
      }
    },

    appendEvent: async (input) => {
      requireNonBlank(input.taskId, "taskId");
      const level = input.level ?? "info";
      if (!includesValue(AGENT_TASK_EVENT_LEVELS, level))
        throw new InvalidRepositoryInputError("unknown event level");
      const message = boundedText(
        input.message,
        "message",
        AGENT_EVENT_MESSAGE_MAX_LENGTH
      );
      try {
        const timestamp = dependencies.now();
        const touched = await database
          .update(agentTasks)
          .set({ updatedAt: timestamp })
          .where(eq(agentTasks.id, input.taskId))
          .returning({ id: agentTasks.id });
        if (touched.length === 0) return null;
        const [event] = await database
          .insert(agentTaskEvents)
          .values({
            id: dependencies.generateId(),
            taskId: input.taskId,
            at: timestamp,
            level,
            message,
          })
          .returning();
        return event ?? null;
      } catch (error) {
        return mapAgentOpsMutationError(error, "agent task event");
      }
    },
  };
};

export type AddResearchPaperInput = Readonly<{
  title: string;
  sourceUrl?: string | null;
  authors?: string | null;
  year?: number | null;
  identifier?: string | null;
  kind?: ResearchPaperKind;
  stage?: ResearchPaperStage;
  notes?: string | null;
}>;

export type UpdateResearchPaperInput = Readonly<{
  id: string;
  stage?: ResearchPaperStage;
  verdict?: ResearchPaperVerdict;
  blockers?: string | null;
  notes?: string | null;
  reportedMetrics?: AgentMetrics;
  reproducedMetrics?: AgentMetrics;
}>;

export type ResearchPapersRepository = Readonly<{
  list: () => Promise<ResearchPaper[]>;
  add: (input: AddResearchPaperInput) => Promise<ResearchPaper>;
  update: (input: UpdateResearchPaperInput) => Promise<ResearchPaper | null>;
  // Rows whose identifier is arXiv:<baseId> or arXiv:<baseId>v<n>, oldest first.
  findByArxivId: (baseId: string) => Promise<ResearchPaper[]>;
}>;

export const createResearchPapersRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): ResearchPapersRepository => {
  const dependencies = resolveDependencies(repositoryDependencies);

  return {
    list: async () => {
      try {
        return await database
          .select()
          .from(researchPapers)
          .orderBy(asc(researchPapers.createdAt), asc(researchPapers.id))
          .limit(RESEARCH_PAPERS_MAX_LISTED);
      } catch (error) {
        return mapAgentOpsReadError(error, "research papers");
      }
    },

    add: async (input) => {
      const title = boundedText(
        input.title,
        "title",
        AGENT_TASK_TITLE_MAX_LENGTH
      );
      const sourceUrl =
        optionalText(input.sourceUrl, "sourceUrl", AGENT_LINK_URL_MAX_LENGTH) ??
        null;
      if (sourceUrl !== null && !isSafeAgentLinkUrl(sourceUrl)) {
        throw new InvalidRepositoryInputError("sourceUrl must be http(s)");
      }
      const kind = input.kind ?? "paper";
      if (!includesValue(RESEARCH_PAPER_KINDS, kind))
        throw new InvalidRepositoryInputError("unknown paper kind");
      const stage = input.stage ?? "queued";
      if (!includesValue(RESEARCH_PAPER_STAGES, stage))
        throw new InvalidRepositoryInputError("unknown paper stage");
      const notes =
        optionalText(input.notes, "notes", RESEARCH_PAPER_TEXT_MAX_LENGTH) ??
        null;
      if (
        input.year !== undefined &&
        input.year !== null &&
        !(
          Number.isInteger(input.year) &&
          input.year >= 1900 &&
          input.year <= 2100
        )
      ) {
        throw new InvalidRepositoryInputError(
          "year must be between 1900 and 2100"
        );
      }
      const timestamp = dependencies.now();
      try {
        const [paper] = await database
          .insert(researchPapers)
          .values({
            id: dependencies.generateId(),
            title,
            sourceUrl,
            authors: optionalText(input.authors, "authors", 500) ?? null,
            year: input.year ?? null,
            identifier:
              optionalText(input.identifier, "identifier", 200) ?? null,
            kind,
            stage,
            notes,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning();
        return required(paper, "paper");
      } catch (error) {
        return mapAgentOpsMutationError(error, "research paper");
      }
    },
    update: async (input) => {
      requireNonBlank(input.id, "id");
      if (
        input.stage !== undefined &&
        !includesValue(RESEARCH_PAPER_STAGES, input.stage)
      ) {
        throw new InvalidRepositoryInputError("unknown paper stage");
      }
      if (
        input.verdict !== undefined &&
        !includesValue(RESEARCH_PAPER_VERDICTS, input.verdict)
      ) {
        throw new InvalidRepositoryInputError("unknown paper verdict");
      }
      const blockers = optionalText(
        input.blockers,
        "blockers",
        RESEARCH_PAPER_TEXT_MAX_LENGTH
      );
      const notes = optionalText(
        input.notes,
        "notes",
        RESEARCH_PAPER_TEXT_MAX_LENGTH
      );
      const reportedMetrics =
        input.reportedMetrics === undefined
          ? undefined
          : validateAgentMetrics(input.reportedMetrics, "reportedMetrics");
      const reproducedMetrics =
        input.reproducedMetrics === undefined
          ? undefined
          : validateAgentMetrics(input.reproducedMetrics, "reproducedMetrics");
      if (
        [
          input.stage,
          input.verdict,
          blockers,
          notes,
          reportedMetrics,
          reproducedMetrics,
        ].every((value) => value === undefined)
      ) {
        throw new InvalidRepositoryInputError(
          "paper update must change at least one field"
        );
      }
      try {
        const [paper] = await database
          .update(researchPapers)
          .set({
            ...(input.stage === undefined ? {} : { stage: input.stage }),
            ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
            ...(blockers === undefined ? {} : { blockers }),
            ...(notes === undefined ? {} : { notes }),
            ...(reportedMetrics === undefined ? {} : { reportedMetrics }),
            ...(reproducedMetrics === undefined ? {} : { reproducedMetrics }),
            updatedAt: dependencies.now(),
          })
          .where(eq(researchPapers.id, input.id))
          .returning();
        return paper ?? null;
      } catch (error) {
        return mapAgentOpsMutationError(error, "research paper");
      }
    },

    findByArxivId: async (baseId) => {
      if (!ARXIV_BASE_ID_PATTERN.test(baseId))
        throw new InvalidRepositoryInputError(
          "baseId must be an arXiv identifier without version"
        );
      try {
        return await database
          .select()
          .from(researchPapers)
          .where(
            orWhere(
              eq(researchPapers.identifier, `arXiv:${baseId}`),
              sql`${researchPapers.identifier} ~ ${`^arXiv:${baseId.replaceAll(".", "\\.")}v[0-9]+$`}`
            )
          )
          .orderBy(asc(researchPapers.createdAt), asc(researchPapers.id))
          .limit(10);
      } catch (error) {
        return mapAgentOpsReadError(error, "research papers");
      }
    },
  };
};

// New-style (2402.05272) or old-style (hep-th/9901001) arXiv identifiers without version.
export const ARXIV_BASE_ID_PATTERN =
  /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/;

// ---------------------------------------------------------------------------
// Backtest results (agent-reported; drawdown derived from equity at write time).

export const BACKTEST_RESULTS_MAX_LISTED = 200;

export type BacktestResultSummary = Omit<
  BacktestResult,
  | "equity"
  | "drawdown"
  | "trades"
  | "folds"
  | "runConfig"
  | "benchmark"
  | "ratingSeries"
> &
  Readonly<{
    pointCount: number;
    foldCount: number;
  }>;

export type BacktestResultListFilters = Readonly<{
  taskId?: string;
  paperId?: string;
  strategyId?: string;
  limit?: number;
}>;

// Per-period simple-return summary of one backtest's equity series, computed in the database.
export type BacktestTrialReturns = Readonly<{
  id: string;
  returns: number;
  meanReturn: number | null;
  stdReturn: number | null;
  firstT: string | null;
  lastT: string | null;
}>;

// The trial ledger of one backtest: every result for its strategy (or, without a strategy,
// its ledger task). total counts all of them; others holds the newest other results only.
export type BacktestTrialLedger = Readonly<{
  scope: "strategy" | "task";
  key: string;
  total: number;
  others: BacktestTrialReturns[];
}>;

// Bounds the per-view cost: each sampled result's equity series is expanded once
// (about 0.3 s for 49 results of 5000 points on the test Postgres).
const BACKTEST_TRIAL_LEDGER_SAMPLE = 49;

export type BacktestResultsRepository = Readonly<{
  record: (input: BacktestResultDraft) => Promise<BacktestResult>;
  list: (
    filters?: BacktestResultListFilters
  ) => Promise<BacktestResultSummary[]>;
  get: (id: string) => Promise<BacktestResult | null>;
  trialLedger: (
    backtest: Readonly<{
      id: string;
      strategyId: string | null;
      taskId: string;
    }>
  ) => Promise<BacktestTrialLedger>;
}>;

// One pass over a stored equity series: mean and sample standard deviation of
// equity[i] / equity[i - 1] - 1, plus the first and last timestamps.
const trialReturnStats = sql<{
  returns: number;
  mean: number | null;
  sd: number | null;
  firstT: string | null;
  lastT: string | null;
}>`(
  select json_build_object(
    'returns', count(r), 'mean', avg(r), 'sd', stddev_samp(r),
    'firstT', max(t) filter (where ordinality = 1),
    'lastT', max(t) filter (where ordinality = points)
  )
  from (
    select e.value ->> 't' as t, e.ordinality, count(*) over () as points,
      (e.value ->> 'equity')::float8
        / nullif(lag((e.value ->> 'equity')::float8) over (order by e.ordinality), 0) - 1 as r
    from jsonb_array_elements(${backtestResults.equity}) with ordinality as e(value, ordinality)
  ) as trial_returns
)`;

export const createBacktestResultsRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): BacktestResultsRepository => {
  const dependencies = resolveDependencies(repositoryDependencies);

  return {
    record: async (input) => {
      let normalized: NormalizedBacktestResult;
      try {
        normalized = normalizeBacktestResult(input);
      } catch (error) {
        if (error instanceof BacktestResultInputError)
          throw new InvalidRepositoryInputError(error.message);
        throw error;
      }
      try {
        const [row] = await database
          .insert(backtestResults)
          .values({
            id: dependencies.generateId(),
            ...normalized,
            createdAt: dependencies.now(),
          })
          .returning();
        return required(row, "row");
      } catch (error) {
        return mapAgentOpsMutationError(error, "backtest result");
      }
    },

    list: async (filters = {}) => {
      const limit = clampLimit(filters.limit, 100, BACKTEST_RESULTS_MAX_LISTED);
      const conditions = [
        ...(filters.taskId === undefined
          ? []
          : [eq(backtestResults.taskId, filters.taskId)]),
        ...(filters.paperId === undefined
          ? []
          : [eq(backtestResults.paperId, filters.paperId)]),
        ...(filters.strategyId === undefined
          ? []
          : [eq(backtestResults.strategyId, filters.strategyId)]),
      ];
      try {
        return await database
          .select({
            id: backtestResults.id,
            taskId: backtestResults.taskId,
            paperId: backtestResults.paperId,
            strategyId: backtestResults.strategyId,
            strategy: backtestResults.strategy,
            instruments: backtestResults.instruments,
            periodStart: backtestResults.periodStart,
            periodEnd: backtestResults.periodEnd,
            dataSource: backtestResults.dataSource,
            isSplit: backtestResults.isSplit,
            metrics: backtestResults.metrics,
            maxDrawdown: backtestResults.maxDrawdown,
            tradeCount: backtestResults.tradeCount,
            notes: backtestResults.notes,
            createdAt: backtestResults.createdAt,
            pointCount: sql<number>`jsonb_array_length(${backtestResults.equity})::int`,
            foldCount: sql<number>`jsonb_array_length(${backtestResults.folds})::int`,
          })
          .from(backtestResults)
          .where(conditions.length === 0 ? undefined : andWhere(...conditions))
          .orderBy(desc(backtestResults.createdAt), desc(backtestResults.id))
          .limit(limit);
      } catch (error) {
        return mapAgentOpsReadError(error, "backtest results");
      }
    },
    get: async (id) => {
      requireNonBlank(id, "id");
      try {
        const [row] = await database
          .select()
          .from(backtestResults)
          .where(eq(backtestResults.id, id))
          .limit(1);
        return row ?? null;
      } catch (error) {
        return mapAgentOpsReadError(error, "backtest result");
      }
    },
    trialLedger: async (backtest) => {
      requireNonBlank(backtest.id, "id");
      const scope =
        backtest.strategyId === null
          ? ({ scope: "task", key: backtest.taskId } as const)
          : ({ scope: "strategy", key: backtest.strategyId } as const);
      const inScope =
        scope.scope === "strategy"
          ? eq(backtestResults.strategyId, scope.key)
          : eq(backtestResults.taskId, scope.key);
      try {
        const [counted] = await database
          .select({ total: sql<number>`count(*)::int` })
          .from(backtestResults)
          .where(inScope);
        const rows = await database
          .select({
            id: backtestResults.id,
            stats: trialReturnStats,
          })
          .from(backtestResults)
          .where(andWhere(inScope, ne(backtestResults.id, backtest.id)))
          .orderBy(desc(backtestResults.createdAt), desc(backtestResults.id))
          .limit(BACKTEST_TRIAL_LEDGER_SAMPLE);
        return {
          ...scope,
          total: required(counted, "count").total,
          others: rows.map((row) => ({
            id: row.id,
            returns: Number(row.stats.returns),
            meanReturn: row.stats.mean,
            stdReturn: row.stats.sd,
            firstT: row.stats.firstT,
            lastT: row.stats.lastT,
          })),
        };
      } catch (error) {
        return mapAgentOpsReadError(error, "backtest trial ledger");
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Optimization runs (agent-recorded optimizer output; importance and profiles are derived on read).

export const OPTIMIZATION_RUNS_MAX_LISTED = 200;

export type OptimizationRunDetail = OptimizationRun &
  Readonly<{ strategyName: string | null }>;

export type OptimizationRunSummary = Omit<
  OptimizationRunDetail,
  "trials" | "folds" | "paretoFront" | "oos" | "marketRanking"
> &
  Readonly<{
    storedTrialCount: number;
    foldCount: number;
    paretoCount: number;
  }>;

export type OptimizationRunListFilters = Readonly<{
  taskId?: string;
  strategyId?: string;
  limit?: number;
}>;

export type OptimizationRunsRepository = Readonly<{
  record: (input: OptimizationRunDraft) => Promise<OptimizationRunDetail>;
  list: (
    filters?: OptimizationRunListFilters
  ) => Promise<OptimizationRunSummary[]>;
  get: (id: string) => Promise<OptimizationRunDetail | null>;
}>;

export const createOptimizationRunsRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): OptimizationRunsRepository => {
  const dependencies = resolveDependencies(repositoryDependencies);
  const {
    trials,
    folds,
    paretoFront,
    oos: _oos,
    marketRanking: _marketRanking,
    ...summaryColumns
  } = getTableColumns(optimizationRuns);

  return {
    record: async (input) => {
      let normalized: NormalizedOptimizationRun;
      try {
        normalized = normalizeOptimizationRun(input);
      } catch (error) {
        if (error instanceof OptimizationRunInputError)
          throw new InvalidRepositoryInputError(error.message);
        throw error;
      }
      try {
        const [row] = await database
          .insert(optimizationRuns)
          .values({
            id: dependencies.generateId(),
            ...normalized,
            createdAt: dependencies.now(),
          })
          .returning();
        let strategyName: string | null = null;
        if (normalized.strategyId !== null) {
          const [strategy] = await database
            .select({ name: strategies.name })
            .from(strategies)
            .where(eq(strategies.id, normalized.strategyId))
            .limit(1);
          strategyName = strategy?.name ?? null;
        }
        return { ...required(row, "row"), strategyName };
      } catch (error) {
        return mapAgentOpsMutationError(error, "optimization run");
      }
    },

    list: async (filters = {}) => {
      const limit = clampLimit(
        filters.limit,
        100,
        OPTIMIZATION_RUNS_MAX_LISTED
      );
      const conditions = [
        ...(filters.taskId === undefined
          ? []
          : [eq(optimizationRuns.taskId, filters.taskId)]),
        ...(filters.strategyId === undefined
          ? []
          : [eq(optimizationRuns.strategyId, filters.strategyId)]),
      ];
      try {
        return await database
          .select({
            ...summaryColumns,
            strategyName: strategies.name,
            storedTrialCount: sql<number>`jsonb_array_length(${trials})::int`,
            foldCount: sql<number>`jsonb_array_length(${folds})::int`,
            paretoCount: sql<number>`jsonb_array_length(${paretoFront})::int`,
          })
          .from(optimizationRuns)
          .leftJoin(strategies, eq(optimizationRuns.strategyId, strategies.id))
          .where(conditions.length === 0 ? undefined : andWhere(...conditions))
          .orderBy(desc(optimizationRuns.createdAt), desc(optimizationRuns.id))
          .limit(limit);
      } catch (error) {
        return mapAgentOpsReadError(error, "optimization runs");
      }
    },
    get: async (id) => {
      requireNonBlank(id, "id");
      try {
        const [row] = await database
          .select({
            ...getTableColumns(optimizationRuns),
            strategyName: strategies.name,
          })
          .from(optimizationRuns)
          .leftJoin(strategies, eq(optimizationRuns.strategyId, strategies.id))
          .where(eq(optimizationRuns.id, id))
          .limit(1);
        return row === undefined
          ? null
          : { ...row, strategyName: row.strategyName ?? null };
      } catch (error) {
        return mapAgentOpsReadError(error, "optimization run");
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Strategy library (operator-owned). Field, params and preset rules live in strategy-library.ts.

export const STRATEGIES_MAX_LISTED = 500;

export type StrategyListFilters = Readonly<{
  search?: string;
  status?: StrategyStatus;
  favorite?: boolean;
  // null lists only strategies without a section.
  section?: string | null;
  // Only strategies whose tags include this tag (exact match, same rules as a stored tag).
  tag?: string;
  limit?: number;
}>;

// jsonb containment: only strategies whose tags include the tag, normalized like a stored tag.
const strategyTagCondition = (tag: string | undefined): SQL[] =>
  tag === undefined
    ? []
    : [
        sql`${strategies.tags} @> ${JSON.stringify(
          strategyInput(() => normalizeStrategyTags([tag]))
        )}::jsonb`,
      ];

export type StrategyListRow = Strategy &
  Readonly<{ presetCount: number; backtestCount: number }>;

export type StrategyLatestBacktest = Readonly<{
  strategyId: string;
  id: string;
  createdAt: Date;
  maxDrawdown: number | null;
  equity: BacktestEquityPoint[];
}>;

export type CreateStrategyInput = Readonly<{
  name: string;
  kind: StrategyKind;
  slug?: string;
  description?: string | null;
  status?: StrategyStatus;
  sourceRef?: string | null;
  tags?: readonly string[];
  favorite?: boolean;
  section?: string | null;
  params?: unknown;
}>;

export type UpdateStrategyInput = Readonly<{
  id: string;
  name?: string;
  description?: string | null;
  status?: StrategyStatus;
  sourceRef?: string | null;
  tags?: readonly string[];
  favorite?: boolean;
  section?: string | null;
  params?: unknown;
}>;

export type SaveStrategyPresetInput = Readonly<{
  strategyId: string;
  name: string;
  values: unknown;
}>;
export type RemoveStrategyPresetInput = Readonly<{
  strategyId: string;
  id: string;
}>;

export type StrategyLibraryRepository = Readonly<{
  list: (filters?: StrategyListFilters) => Promise<StrategyListRow[]>;
  get: (id: string) => Promise<Readonly<{
    strategy: StrategyListRow;
    presets: StrategyPreset[];
  }> | null>;
  create: (input: CreateStrategyInput) => Promise<Strategy>;
  // Changing params is refused while a saved preset would no longer fit them.
  update: (input: UpdateStrategyInput) => Promise<Strategy | null>;
  // Upsert by (strategy, name); null when the strategy does not exist.
  savePreset: (
    input: SaveStrategyPresetInput
  ) => Promise<StrategyPreset | null>;
  removePreset: (input: RemoveStrategyPresetInput) => Promise<boolean>;
  // Most recent linked backtest per strategy, with equity for server-side return statistics.
  latestBacktests: (
    strategyIds: readonly string[]
  ) => Promise<StrategyLatestBacktest[]>;
}>;

const strategyInput = <T>(operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof StrategyInputError)
      throw new InvalidRepositoryInputError(error.message);
    throw error;
  }
};

const escapeLikePattern = (value: string): string => {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
};

// Correlated counts use explicit aliases: Drizzle renders column interpolations unqualified in a
// single-table select, which would bind both sides of the comparison to the subquery's table.
const STRATEGY_PRESET_COUNT_SQL =
  'select count(*)::int from "strategy_presets" as "sp" where "sp"."strategy_id" = "strategies"."id"';
const STRATEGY_BACKTEST_COUNT_SQL =
  'select count(*)::int from "backtest_results" as "br" where "br"."strategy_id" = "strategies"."id"';
const strategyListColumns = {
  ...getTableColumns(strategies),
  presetCount: sql<number>`(${sql.raw(STRATEGY_PRESET_COUNT_SQL)})`,
  backtestCount: sql<number>`(${sql.raw(STRATEGY_BACKTEST_COUNT_SQL)})`,
};

const withStrategyCounts = (
  row: Strategy & Readonly<{ presetCount: unknown; backtestCount: unknown }>
): StrategyListRow => {
  return {
    ...row,
    presetCount: Number(row.presetCount ?? 0),
    backtestCount: Number(row.backtestCount ?? 0),
  };
};

export const createStrategyLibraryRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): StrategyLibraryRepository => {
  const dependencies = resolveDependencies(repositoryDependencies);

  return {
    list: async (filters = {}) => {
      const limit = clampLimit(
        filters.limit,
        STRATEGIES_MAX_LISTED,
        STRATEGIES_MAX_LISTED
      );
      const status =
        filters.status === undefined
          ? undefined
          : strategyInput(() => normalizeStrategyStatus(filters.status));
      const section = strategyInput(() =>
        normalizeStrategySection(filters.section)
      );
      const search = (filters.search ?? "").trim();
      if (search.length > STRATEGY_SEARCH_MAX_LENGTH) {
        throw new InvalidRepositoryInputError(
          `search must not exceed ${STRATEGY_SEARCH_MAX_LENGTH} characters`
        );
      }
      const pattern = `%${escapeLikePattern(search)}%`;
      const conditions = [
        ...(search === ""
          ? []
          : [
              required(
                orWhere(
                  ilike(strategies.name, pattern),
                  ilike(strategies.slug, pattern),
                  ilike(strategies.description, pattern),
                  sql`${strategies.tags}::text ilike ${pattern}`
                ),
                "orWhere( ilike(strategies.name, pattern), ilike(strategies.slug, pattern), il..."
              ),
            ]),
        ...(status === undefined ? [] : [eq(strategies.status, status)]),
        ...(filters.favorite === undefined
          ? []
          : [eq(strategies.favorite, filters.favorite)]),
        ...(section === undefined
          ? []
          : [
              section === null
                ? isNull(strategies.section)
                : eq(strategies.section, section),
            ]),
        ...strategyTagCondition(filters.tag),
      ];
      try {
        const rows = await database
          .select(strategyListColumns)
          .from(strategies)
          .where(conditions.length === 0 ? undefined : andWhere(...conditions))
          .orderBy(desc(strategies.updatedAt), desc(strategies.id))
          .limit(limit);
        return rows.map(withStrategyCounts);
      } catch (error) {
        return mapAgentOpsReadError(error, "strategies");
      }
    },

    get: async (id) => {
      requireNonBlank(id, "id");
      try {
        const [row] = await database
          .select(strategyListColumns)
          .from(strategies)
          .where(eq(strategies.id, id))
          .limit(1);
        if (row === undefined) return null;
        const presets = await database
          .select()
          .from(strategyPresets)
          .where(eq(strategyPresets.strategyId, id))
          .orderBy(asc(strategyPresets.name), asc(strategyPresets.id))
          .limit(STRATEGY_PRESETS_MAX);
        return { strategy: withStrategyCounts(row), presets };
      } catch (error) {
        return mapAgentOpsReadError(error, "strategy");
      }
    },

    create: async (input) => {
      const values = strategyInput(() => {
        const name = normalizeStrategyName(input.name);
        return {
          name,
          slug:
            input.slug === undefined
              ? slugifyStrategyName(name)
              : normalizeStrategySlug(input.slug),
          kind: normalizeStrategyKind(input.kind),
          status:
            input.status === undefined
              ? ("idea" as StrategyStatus)
              : normalizeStrategyStatus(input.status),
          description: normalizeStrategyDescription(input.description) ?? null,
          sourceRef: normalizeStrategySourceRef(input.sourceRef) ?? null,
          tags: normalizeStrategyTags(input.tags ?? []),
          favorite:
            input.favorite === undefined
              ? false
              : normalizeStrategyFavorite(input.favorite),
          section: normalizeStrategySection(input.section) ?? null,
          params: normalizeStrategyParams(input.params ?? []),
        };
      });
      const timestamp = dependencies.now();
      try {
        const [row] = await database
          .insert(strategies)
          .values({
            id: dependencies.generateId(),
            ...values,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning();
        return required(row, "row");
      } catch (error) {
        return mapAgentOpsMutationError(error, "strategy");
      }
    },
    update: async (input) => {
      requireNonBlank(input.id, "id");
      const changes = strategyInput(() => ({
        ...(input.name === undefined
          ? {}
          : { name: normalizeStrategyName(input.name) }),
        ...(input.description === undefined
          ? {}
          : {
              description:
                normalizeStrategyDescription(input.description) ?? null,
            }),
        ...(input.status === undefined
          ? {}
          : { status: normalizeStrategyStatus(input.status) }),
        ...(input.sourceRef === undefined
          ? {}
          : { sourceRef: normalizeStrategySourceRef(input.sourceRef) ?? null }),
        ...(input.tags === undefined
          ? {}
          : { tags: normalizeStrategyTags(input.tags) }),
        ...(input.favorite === undefined
          ? {}
          : { favorite: normalizeStrategyFavorite(input.favorite) }),
        ...(input.section === undefined
          ? {}
          : { section: normalizeStrategySection(input.section) ?? null }),
        ...(input.params === undefined
          ? {}
          : { params: normalizeStrategyParams(input.params) }),
      }));
      if (Object.keys(changes).length === 0) {
        throw new InvalidRepositoryInputError(
          "strategy update must change at least one field"
        );
      }
      try {
        return await withTransaction(database, async (transaction) => {
          const [current] = await transaction
            .select({ id: strategies.id })
            .from(strategies)
            .where(eq(strategies.id, input.id))
            .limit(1)
            .for("update");
          if (current === undefined) return null;
          const params = changes.params;
          if (params !== undefined) {
            const presets = await transaction
              .select({
                name: strategyPresets.name,
                values: strategyPresets.values,
              })
              .from(strategyPresets)
              .where(eq(strategyPresets.strategyId, input.id));
            for (const preset of presets) {
              try {
                normalizeStrategyPresetValues(preset.values, params);
              } catch (error) {
                if (error instanceof StrategyInputError) {
                  throw new InvalidRepositoryInputError(
                    `preset ${preset.name} no longer fits these params (${error.message}); update or delete it first`
                  );
                }
                throw error;
              }
            }
          }
          const [row] = await transaction
            .update(strategies)
            .set({ ...changes, updatedAt: dependencies.now() })
            .where(eq(strategies.id, input.id))
            .returning();
          return row ?? null;
        });
      } catch (error) {
        return mapAgentOpsMutationError(error, "strategy");
      }
    },

    savePreset: async (input) => {
      requireNonBlank(input.strategyId, "strategyId");
      const name = strategyInput(() => normalizeStrategyPresetName(input.name));
      try {
        return await withTransaction(database, async (transaction) => {
          const [strategy] = await transaction
            .select({ params: strategies.params })
            .from(strategies)
            .where(eq(strategies.id, input.strategyId))
            .limit(1)
            .for("update");
          if (strategy === undefined) return null;
          const values = strategyInput(() =>
            normalizeStrategyPresetValues(input.values, strategy.params ?? [])
          );
          const existing = await transaction
            .select({ name: strategyPresets.name })
            .from(strategyPresets)
            .where(eq(strategyPresets.strategyId, input.strategyId));
          if (
            existing.length >= STRATEGY_PRESETS_MAX &&
            !existing.some((row) => row.name === name)
          ) {
            throw new InvalidRepositoryInputError(
              `a strategy may have at most ${STRATEGY_PRESETS_MAX} presets`
            );
          }
          const timestamp = dependencies.now();
          const [preset] = await transaction
            .insert(strategyPresets)
            .values({
              id: dependencies.generateId(),
              strategyId: input.strategyId,
              name,
              values,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .onConflictDoUpdate({
              target: [strategyPresets.strategyId, strategyPresets.name],
              set: { values, updatedAt: timestamp },
            })
            .returning();
          return preset ?? null;
        });
      } catch (error) {
        return mapAgentOpsMutationError(error, "strategy preset");
      }
    },

    removePreset: async (input) => {
      requireNonBlank(input.strategyId, "strategyId");
      requireNonBlank(input.id, "id");
      try {
        const removed = await database
          .delete(strategyPresets)
          .where(
            andWhere(
              eq(strategyPresets.id, input.id),
              eq(strategyPresets.strategyId, input.strategyId)
            )
          )
          .returning({ id: strategyPresets.id });
        return removed.length > 0;
      } catch (error) {
        return mapAgentOpsMutationError(error, "strategy preset");
      }
    },

    latestBacktests: async (strategyIds) => {
      const ids = [...new Set(strategyIds)].filter(
        (id) => id.trim().length > 0
      );
      if (ids.length === 0) return [];
      try {
        const rows = await database
          .selectDistinctOn([backtestResults.strategyId], {
            strategyId: backtestResults.strategyId,
            id: backtestResults.id,
            createdAt: backtestResults.createdAt,
            maxDrawdown: backtestResults.maxDrawdown,
            equity: backtestResults.equity,
          })
          .from(backtestResults)
          .where(inArray(backtestResults.strategyId, ids))
          .orderBy(
            backtestResults.strategyId,
            desc(backtestResults.createdAt),
            desc(backtestResults.id)
          );
        return rows.flatMap((row) => {
          return row.strategyId === null
            ? []
            : [
                {
                  ...row,
                  strategyId: row.strategyId,
                  equity: row.equity ?? [],
                },
              ];
        });
      } catch (error) {
        return mapAgentOpsReadError(error, "strategy backtests");
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Paper deployment requests (operator-owned records only). Field, limit, params and lifecycle rules
// live in deployment-requests.ts. Nothing here starts, routes or submits anything: there is no
// execution transport, and an approval is a recorded human decision, not an execution grant.

const DEPLOYMENT_REQUESTS_DEFAULT_LISTED = 100;
export const DEPLOYMENT_REQUESTS_MAX_LISTED = 200;

export type DeploymentRequestRow = DeploymentRequest &
  Readonly<{
    strategySlug: string;
    strategyName: string;
    presetName: string | null;
  }>;

export type DeploymentRequestListFilters = Readonly<{
  status?: DeploymentRequestStatus;
  strategyId?: string;
  limit?: number;
}>;

export type CreateDeploymentRequestInput = Readonly<{
  strategyId: string;
  presetId?: string | null;
  // Explicit values layered over the strategy defaults and the preset's values.
  params?: unknown;
  symbol: string;
  timeframe: string;
  limits: unknown;
  requestedBy: string;
}>;

export type UpdateDeploymentRequestInput = Readonly<{
  id: string;
  presetId?: string | null;
  params?: unknown;
  symbol?: string;
  timeframe?: string;
  limits?: unknown;
}>;

export type TransitionDeploymentRequestInput = Readonly<{
  id: string;
  action: DeploymentRequestAction;
  actorId: string;
  note?: string | null;
  // approve only: must equal the strategy slug.
  confirmSlug?: string;
}>;

export type DeploymentRequestsRepository = Readonly<{
  list: (
    filters?: DeploymentRequestListFilters
  ) => Promise<DeploymentRequestRow[]>;
  get: (id: string) => Promise<DeploymentRequestRow | null>;
  // null when the strategy does not exist.
  create: (
    input: CreateDeploymentRequestInput
  ) => Promise<DeploymentRequestRow | null>;
  // Drafts only; null when the request does not exist.
  update: (
    input: UpdateDeploymentRequestInput
  ) => Promise<DeploymentRequestRow | null>;
  // submit, approve, reject or withdraw; null when the request does not exist.
  transition: (
    input: TransitionDeploymentRequestInput
  ) => Promise<DeploymentRequestRow | null>;
}>;

const deploymentInput = <T>(operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof DeploymentRequestInputError ||
      error instanceof StrategyInputError
    ) {
      throw new InvalidRepositoryInputError(error.message);
    }
    throw error;
  }
};

const deploymentRequestColumns = {
  ...getTableColumns(deploymentRequests),
  strategySlug: strategies.slug,
  strategyName: strategies.name,
  presetName: strategyPresets.name,
};

const readDeploymentRequests = (database: DatabaseExecutor) => {
  return database
    .select(deploymentRequestColumns)
    .from(deploymentRequests)
    .innerJoin(strategies, eq(deploymentRequests.strategyId, strategies.id))
    .leftJoin(
      strategyPresets,
      eq(deploymentRequests.presetId, strategyPresets.id)
    );
};

const readDeploymentRequest = async (
  database: DatabaseExecutor,
  id: string
): Promise<DeploymentRequestRow | null> => {
  const [row] = await readDeploymentRequests(database)
    .where(eq(deploymentRequests.id, id))
    .limit(1);
  return row ?? null;
};

const presetValuesFor = async (
  database: DatabaseExecutor,
  strategyId: string,
  presetId: string
): Promise<unknown> => {
  const [preset] = await database
    .select({ values: strategyPresets.values })
    .from(strategyPresets)
    .where(
      andWhere(
        eq(strategyPresets.id, presetId),
        eq(strategyPresets.strategyId, strategyId)
      )
    )
    .limit(1);
  if (preset === undefined)
    throw new InvalidRepositoryInputError(
      "presetId is not a preset of this strategy"
    );
  return preset.values;
};

export const createDeploymentRequestsRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): DeploymentRequestsRepository => {
  const dependencies = resolveDependencies(repositoryDependencies);

  return {
    list: async (filters = {}) => {
      const limit = clampLimit(
        filters.limit,
        DEPLOYMENT_REQUESTS_DEFAULT_LISTED,
        DEPLOYMENT_REQUESTS_MAX_LISTED
      );
      const status =
        filters.status === undefined
          ? undefined
          : deploymentInput(() => normalizeDeploymentStatus(filters.status));
      const conditions = [
        ...(status === undefined
          ? []
          : [eq(deploymentRequests.status, status)]),
        ...(filters.strategyId === undefined
          ? []
          : [eq(deploymentRequests.strategyId, filters.strategyId)]),
      ];
      try {
        return await readDeploymentRequests(database)
          .where(conditions.length === 0 ? undefined : andWhere(...conditions))
          .orderBy(
            desc(deploymentRequests.createdAt),
            desc(deploymentRequests.id)
          )
          .limit(limit);
      } catch (error) {
        return mapAgentOpsReadError(error, "deployment requests");
      }
    },

    get: async (id) => {
      requireNonBlank(id, "id");
      try {
        return await readDeploymentRequest(database, id);
      } catch (error) {
        return mapAgentOpsReadError(error, "deployment request");
      }
    },
    create: async (input) => {
      requireNonBlank(input.strategyId, "strategyId");
      requireNonBlank(input.requestedBy, "requestedBy");
      const fields = deploymentInput(() => ({
        symbol: normalizeDeploymentSymbol(input.symbol),
        timeframe: normalizeDeploymentTimeframe(input.timeframe),
        limits: normalizeDeploymentLimits(input.limits),
      }));
      const presetId = input.presetId ?? null;
      try {
        return await withTransaction(database, async (transaction) => {
          const [strategy] = await transaction
            .select({ params: strategies.params })
            .from(strategies)
            .where(eq(strategies.id, input.strategyId))
            .limit(1);
          if (strategy === undefined) return null;
          const presetValues =
            presetId === null
              ? undefined
              : await presetValuesFor(transaction, input.strategyId, presetId);
          const params = deploymentInput(() =>
            resolveDeploymentParams(
              strategy.params ?? [],
              presetValues,
              input.params
            )
          );
          const timestamp = dependencies.now();
          const id = dependencies.generateId();
          await transaction.insert(deploymentRequests).values({
            id,
            strategyId: input.strategyId,
            presetId,
            params,
            ...fields,
            mode: "paper",
            status: "draft",
            requestedBy: input.requestedBy,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          return await readDeploymentRequest(transaction, id);
        });
      } catch (error) {
        return mapAgentOpsMutationError(error, "deployment request");
      }
    },

    update: async (input) => {
      requireNonBlank(input.id, "id");
      const changes = deploymentInput(() => ({
        ...(input.symbol === undefined
          ? {}
          : { symbol: normalizeDeploymentSymbol(input.symbol) }),
        ...(input.timeframe === undefined
          ? {}
          : { timeframe: normalizeDeploymentTimeframe(input.timeframe) }),
        ...(input.limits === undefined
          ? {}
          : { limits: normalizeDeploymentLimits(input.limits) }),
      }));
      if (
        Object.keys(changes).length === 0 &&
        input.params === undefined &&
        input.presetId === undefined
      ) {
        throw new InvalidRepositoryInputError(
          "deployment request update must change at least one field"
        );
      }
      try {
        return await withTransaction(database, async (transaction) => {
          const [current] = await transaction
            .select({
              status: deploymentRequests.status,
              strategyId: deploymentRequests.strategyId,
            })
            .from(deploymentRequests)
            .where(eq(deploymentRequests.id, input.id))
            .limit(1)
            .for("update");
          if (current === undefined) return null;
          if (current.status !== "draft") {
            throw new DeploymentRequestStateError(
              `Only draft requests can be edited; this request is ${current.status}`
            );
          }
          const [strategy] = await transaction
            .select({ params: strategies.params })
            .from(strategies)
            .where(eq(strategies.id, current.strategyId))
            .limit(1);
          const schema = strategy?.params ?? [];
          const presetId =
            input.presetId === undefined ? undefined : (input.presetId ?? null);
          const presetValues =
            presetId === undefined || presetId === null
              ? undefined
              : await presetValuesFor(
                  transaction,
                  current.strategyId,
                  presetId
                );
          // Explicit params replace the stored map (defaults fill gaps); a new preset alone re-applies its values.
          const params =
            input.params === undefined
              ? presetValues === undefined
                ? undefined
                : deploymentInput(() =>
                    resolveDeploymentParams(schema, presetValues)
                  )
              : deploymentInput(() =>
                  resolveDeploymentParams(schema, input.params)
                );
          await transaction
            .update(deploymentRequests)
            .set({
              ...changes,
              ...(presetId === undefined ? {} : { presetId }),
              ...(params === undefined ? {} : { params }),
              updatedAt: dependencies.now(),
            })
            .where(
              andWhere(
                eq(deploymentRequests.id, input.id),
                eq(deploymentRequests.status, "draft")
              )
            );
          return await readDeploymentRequest(transaction, input.id);
        });
      } catch (error) {
        return mapAgentOpsMutationError(error, "deployment request");
      }
    },

    transition: async (input) => {
      requireNonBlank(input.id, "id");
      requireNonBlank(input.actorId, "actorId");
      if (
        !(DEPLOYMENT_REQUEST_ACTIONS as readonly string[]).includes(
          input.action
        )
      ) {
        throw new InvalidRepositoryInputError(
          `action must be one of ${DEPLOYMENT_REQUEST_ACTIONS.join(", ")}`
        );
      }
      const decides = input.action === "approve" || input.action === "reject";
      const note = deploymentInput(() =>
        normalizeDeploymentNote(input.note, input.action === "reject")
      );
      if (!decides && note !== null) {
        throw new InvalidRepositoryInputError(
          "note applies only when approving or rejecting"
        );
      }
      try {
        return await withTransaction(database, async (transaction) => {
          const [current] = await transaction
            .select({
              status: deploymentRequests.status,
              strategyId: deploymentRequests.strategyId,
              params: deploymentRequests.params,
            })
            .from(deploymentRequests)
            .where(eq(deploymentRequests.id, input.id))
            .limit(1)
            .for("update");
          if (current === undefined) return null;
          const next = checkDeploymentTransition(input.action, current.status);
          if (input.action === "submit" || input.action === "approve") {
            const [strategy] = await transaction
              .select({ slug: strategies.slug, params: strategies.params })
              .from(strategies)
              .where(eq(strategies.id, current.strategyId))
              .limit(1);
            if (
              input.action === "approve" &&
              (input.confirmSlug ?? "").trim() !== strategy?.slug
            ) {
              throw new InvalidRepositoryInputError(
                `type the strategy slug ${strategy?.slug ?? ""} to approve`
              );
            }
            deploymentInput(() =>
              checkDeploymentParamsFit(strategy?.params ?? [], current.params)
            );
          }
          const timestamp = dependencies.now();
          await transaction
            .update(deploymentRequests)
            .set({
              status: next,
              updatedAt: timestamp,
              ...(input.action === "submit" ? { requestedAt: timestamp } : {}),
              ...(decides
                ? {
                    decidedBy: input.actorId,
                    decidedAt: timestamp,
                    decisionNote: note,
                  }
                : {}),
            })
            .where(
              andWhere(
                eq(deploymentRequests.id, input.id),
                eq(deploymentRequests.status, current.status)
              )
            );
          return await readDeploymentRequest(transaction, input.id);
        });
      } catch (error) {
        return mapAgentOpsMutationError(error, "deployment request");
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Research assistant: owner-scoped threads and messages plus the per-user daily model budget ledger.
// Field rules live in assistant-records.ts. reserveRequest admits one model call atomically (the
// conditional upsert either increments requests or returns nothing), so concurrent turns cannot
// overspend the daily request or token budget.

const ASSISTANT_THREADS_DEFAULT_LISTED = 50;
export const ASSISTANT_THREADS_MAX_LISTED = 100;
const ASSISTANT_MESSAGES_DEFAULT_LISTED = 100;
export const ASSISTANT_MESSAGES_MAX_LISTED = 200;

export type AssistantUsageTotals = Readonly<{
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}>;

export type AppendAssistantMessageInput = Readonly<{
  threadId: string;
  role: AssistantMessageRole;
  mode: AssistantMode;
  content: string;
  toolCalls?: unknown;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
}>;

export type ReserveAssistantRequestInput = Readonly<{
  userId: string;
  day: string;
  maxRequests: number;
  maxTokens: number;
}>;

export type AssistantRepository = Readonly<{
  listThreads: (userId: string, limit?: number) => Promise<AssistantThread[]>;
  createThread: (
    input: Readonly<{ userId: string; title?: string | null }>
  ) => Promise<AssistantThread>;
  // null when the thread does not exist or belongs to another user.
  getThread: (
    input: Readonly<{ id: string; userId: string }>
  ) => Promise<AssistantThread | null>;
  // The most recent messages, oldest first.
  listMessages: (
    threadId: string,
    limit?: number
  ) => Promise<AssistantMessage[]>;
  appendMessage: (
    input: AppendAssistantMessageInput
  ) => Promise<AssistantMessage>;
  usage: (userId: string, day: string) => Promise<AssistantUsageTotals>;
  // Admits one model call: increments requests when under both limits; null when refused.
  reserveRequest: (
    input: ReserveAssistantRequestInput
  ) => Promise<AssistantUsageTotals | null>;
  recordTokens: (
    input: Readonly<{
      userId: string;
      day: string;
      inputTokens: number;
      outputTokens: number;
    }>
  ) => Promise<void>;
}>;

const assistantInput = <T>(operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AssistantRecordInputError)
      throw new InvalidRepositoryInputError(error.message);
    throw error;
  }
};

const ASSISTANT_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const requireAssistantDay = (day: string): void => {
  if (!ASSISTANT_DAY_PATTERN.test(day))
    throw new InvalidRepositoryInputError("day must be YYYY-MM-DD");
};

const usageTotals = (
  day: string,
  row:
    | Readonly<{ requests: number; inputTokens: number; outputTokens: number }>
    | undefined
): AssistantUsageTotals => ({
  day,
  requests: row?.requests ?? 0,
  inputTokens: row?.inputTokens ?? 0,
  outputTokens: row?.outputTokens ?? 0,
});

export const createAssistantRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): AssistantRepository => {
  const dependencies = resolveDependencies(repositoryDependencies);

  return {
    listThreads: async (userId, limit) => {
      requireNonBlank(userId, "userId");
      const count = clampLimit(
        limit,
        ASSISTANT_THREADS_DEFAULT_LISTED,
        ASSISTANT_THREADS_MAX_LISTED
      );
      try {
        return await database
          .select()
          .from(assistantThreads)
          .where(eq(assistantThreads.userId, userId))
          .orderBy(desc(assistantThreads.updatedAt), desc(assistantThreads.id))
          .limit(count);
      } catch (error) {
        return mapAgentOpsReadError(error, "assistant threads");
      }
    },

    createThread: async (input) => {
      requireNonBlank(input.userId, "userId");
      const title = assistantInput(() =>
        normalizeAssistantThreadTitle(input.title)
      );
      const timestamp = dependencies.now();
      try {
        const [row] = await database
          .insert(assistantThreads)
          .values({
            id: dependencies.generateId(),
            userId: input.userId,
            title,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning();
        if (row === undefined)
          throw new DatabasePersistenceError("assistant thread create");
        return row;
      } catch (error) {
        return mapAgentOpsMutationError(error, "assistant thread");
      }
    },

    getThread: async (input) => {
      requireNonBlank(input.id, "id");
      requireNonBlank(input.userId, "userId");
      try {
        const [row] = await database
          .select()
          .from(assistantThreads)
          .where(
            andWhere(
              eq(assistantThreads.id, input.id),
              eq(assistantThreads.userId, input.userId)
            )
          )
          .limit(1);
        return row ?? null;
      } catch (error) {
        return mapAgentOpsReadError(error, "assistant thread");
      }
    },

    listMessages: async (threadId, limit) => {
      requireNonBlank(threadId, "threadId");
      const count = clampLimit(
        limit,
        ASSISTANT_MESSAGES_DEFAULT_LISTED,
        ASSISTANT_MESSAGES_MAX_LISTED
      );
      try {
        const rows = await database
          .select()
          .from(assistantMessages)
          .where(eq(assistantMessages.threadId, threadId))
          .orderBy(
            desc(assistantMessages.createdAt),
            desc(assistantMessages.id)
          )
          .limit(count);
        return [...rows].reverse();
      } catch (error) {
        return mapAgentOpsReadError(error, "assistant messages");
      }
    },
    appendMessage: async (input) => {
      requireNonBlank(input.threadId, "threadId");
      const fields = assistantInput(() => {
        const role = normalizeAssistantRole(input.role);
        return {
          role,
          mode: normalizeAssistantMode(input.mode),
          content: normalizeAssistantContent(input.content, role),
          toolCalls: normalizeAssistantToolTrace(input.toolCalls),
          inputTokens: normalizeAssistantTokens(
            input.inputTokens,
            "inputTokens"
          ),
          outputTokens: normalizeAssistantTokens(
            input.outputTokens,
            "outputTokens"
          ),
        };
      });
      const model =
        input.model === undefined || input.model === null
          ? null
          : input.model.slice(0, 100);
      const timestamp = dependencies.now();
      try {
        return await withTransaction(database, async (transaction) => {
          const [row] = await transaction
            .insert(assistantMessages)
            .values({
              id: dependencies.generateId(),
              threadId: input.threadId,
              ...fields,
              model,
              createdAt: timestamp,
            })
            .returning();
          if (row === undefined)
            throw new DatabasePersistenceError("assistant message append");
          await transaction
            .update(assistantThreads)
            .set({ updatedAt: timestamp })
            .where(eq(assistantThreads.id, input.threadId));
          return row;
        });
      } catch (error) {
        return mapAgentOpsMutationError(error, "assistant message");
      }
    },

    usage: async (userId, day) => {
      requireNonBlank(userId, "userId");
      requireAssistantDay(day);
      try {
        const [row] = await database
          .select({
            requests: assistantUsage.requests,
            inputTokens: assistantUsage.inputTokens,
            outputTokens: assistantUsage.outputTokens,
          })
          .from(assistantUsage)
          .where(
            andWhere(
              eq(assistantUsage.userId, userId),
              eq(assistantUsage.day, day)
            )
          )
          .limit(1);
        return usageTotals(day, row);
      } catch (error) {
        return mapAgentOpsReadError(error, "assistant usage");
      }
    },

    reserveRequest: async (input) => {
      requireNonBlank(input.userId, "userId");
      requireAssistantDay(input.day);
      if (
        !Number.isInteger(input.maxRequests) ||
        input.maxRequests < 1 ||
        !Number.isInteger(input.maxTokens) ||
        input.maxTokens < 1
      ) {
        throw new InvalidRepositoryInputError(
          "budget limits must be positive integers"
        );
      }
      const timestamp = dependencies.now();
      try {
        const [row] = await database
          .insert(assistantUsage)
          .values({
            userId: input.userId,
            day: input.day,
            requests: 1,
            inputTokens: 0,
            outputTokens: 0,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: [assistantUsage.userId, assistantUsage.day],
            set: {
              requests: sql`${assistantUsage.requests} + 1`,
              updatedAt: timestamp,
            },
            setWhere: sql`${assistantUsage.requests} < ${input.maxRequests} and ${assistantUsage.inputTokens} + ${assistantUsage.outputTokens} < ${input.maxTokens}`,
          })
          .returning({
            requests: assistantUsage.requests,
            inputTokens: assistantUsage.inputTokens,
            outputTokens: assistantUsage.outputTokens,
          });
        return row === undefined ? null : usageTotals(input.day, row);
      } catch (error) {
        return mapAgentOpsMutationError(error, "assistant usage");
      }
    },

    recordTokens: async (input) => {
      requireNonBlank(input.userId, "userId");
      requireAssistantDay(input.day);
      const inputTokens = assistantInput(() =>
        normalizeAssistantTokens(input.inputTokens, "inputTokens")
      );
      const outputTokens = assistantInput(() =>
        normalizeAssistantTokens(input.outputTokens, "outputTokens")
      );
      if (inputTokens === 0 && outputTokens === 0) return;
      try {
        await database
          .update(assistantUsage)
          .set({
            inputTokens: sql`${assistantUsage.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${assistantUsage.outputTokens} + ${outputTokens}`,
            updatedAt: dependencies.now(),
          })
          .where(
            andWhere(
              eq(assistantUsage.userId, input.userId),
              eq(assistantUsage.day, input.day)
            )
          );
        return;
      } catch (error) {
        return mapAgentOpsMutationError(error, "assistant usage");
      }
    },
  };
};

export type Repositories = Readonly<{
  profiles: ProfileRepository;
  addresses: AddressRepository;
  userPreferences: UserPreferencesRepository;
  featureItems: FeatureItemRepository;
  adminUsers: AdminUsersRepository;
  dashboard: DashboardRepository;
  generated?: GeneratedFeatureRepositories;
  watchlist?: WatchlistRepository;
  baskets?: BasketRepository;
  pickLists?: PickListRepository;
  plays?: PlaysRepository;
  todos?: TodoRepository;
  agentOps?: AgentOpsRepository;
  researchPapers?: ResearchPapersRepository;
  backtestResults?: BacktestResultsRepository;
  optimizationRuns?: OptimizationRunsRepository;
  quantLab?: QuantLabReadRepository;
  deploymentRequests?: DeploymentRequestsRepository;
  assistant?: AssistantRepository;
  strategyLibrary?: StrategyLibraryRepository;
  marketBars?: MarketBarsRepository;
  backtestRuns?: BacktestRunsRepository;
  forwardDrift?: ForwardDriftRepository;
  agentModelRuns?: AgentModelRunsRepository;
  academyAudit?: AcademyAuditRepository;
  nautilusArmAudit?: NautilusArmAuditRepository;
  orderIntents?: OrderIntentRepository;
  strategyDefinitions?: StrategyDefinitionsRepository;
  assistantActions?: AssistantActionsRepository;
  autopilot?: AutopilotRepository;
  priceAlerts?: PriceAlertRepository;
  signalAlerts?: SignalAlertRepository;
  researchReports?: ResearchReportsRepository;
  sectorRotation?: SectorRotationRepository;
  clickLog?: ClickLogRepository;
}>;

export const createRepositories = (
  database: DatabaseExecutor,
  dependencies: RepositoryDependencies = {}
): Repositories => ({
  profiles: createProfileRepository(database, dependencies),
  addresses: createAddressRepository(database, dependencies),
  userPreferences: createUserPreferencesRepository(database, dependencies),
  featureItems: createFeatureItemRepository(database, dependencies),
  adminUsers: createAdminUsersRepository(database),
  dashboard: createDashboardRepository(database),
  generated: createGeneratedFeatureRepositories(database),
  watchlist: createWatchlistRepository(database, dependencies),
  baskets: createBasketRepository(database, dependencies),
  pickLists: createPickListRepository(database, dependencies),
  plays: createPlaysRepository(database, dependencies),
  todos: createTodoRepository(database, dependencies),
  agentOps: createAgentOpsRepository(database, dependencies),
  researchPapers: createResearchPapersRepository(database, dependencies),
  backtestResults: createBacktestResultsRepository(database, dependencies),
  optimizationRuns: createOptimizationRunsRepository(database, dependencies),
  quantLab: createQuantLabReadRepository(database),
  strategyLibrary: createStrategyLibraryRepository(database, dependencies),
  deploymentRequests: createDeploymentRequestsRepository(
    database,
    dependencies
  ),
  assistant: createAssistantRepository(database, dependencies),
  marketBars: createMarketBarsRepository(database, dependencies.now),
  backtestRuns: createBacktestRunsRepository(
    database,
    resolveDependencies(dependencies)
  ),
  forwardDrift: createForwardDriftRepository(
    database,
    resolveDependencies(dependencies)
  ),
  agentModelRuns: createAgentModelRunsRepository(
    database,
    resolveDependencies(dependencies)
  ),
  academyAudit: createAcademyAuditRepository(
    database,
    resolveDependencies(dependencies)
  ),
  nautilusArmAudit: createNautilusArmAuditRepository(
    database,
    resolveDependencies(dependencies)
  ),
  orderIntents: createOrderIntentRepository(
    database,
    resolveDependencies(dependencies)
  ),
  strategyDefinitions: createStrategyDefinitionsRepository(
    database,
    resolveDependencies(dependencies)
  ),
  assistantActions: createAssistantActionsRepository(
    database,
    resolveDependencies(dependencies)
  ),
  autopilot: createAutopilotRepository(
    database,
    resolveDependencies(dependencies)
  ),
  priceAlerts: createPriceAlertRepository(
    database,
    resolveDependencies(dependencies)
  ),
  signalAlerts: createSignalAlertRepository(
    database,
    resolveDependencies(dependencies)
  ),
  researchReports: createResearchReportsRepository(database, dependencies.now),
  sectorRotation: createSectorRotationRepository(
    database,
    resolveDependencies(dependencies)
  ),
  clickLog: createClickLogRepository(database, {
    ...resolveDependencies(dependencies),
    retentionDays: CLICK_LOG_RETENTION_DAYS,
  }),
});
