// What: Drizzle schema: auth tables, profiles, addresses, preferences, feature items, outbox and audit records.
// Used by: packages/db/src/server/repositories.ts, packages/auth/src/server.ts, packages/db/src/seeds/index.ts.
// See: packages/db/migrations/; docs/deploy.md#migrations.
export * from "./vertex.ts";
export * from "./notification.ts";
export * from "./object-metadata.ts";
export * from "./vertex-authorization.ts";
export * from "./vertex-commands.ts";
export * from "./vertex-native-facts.ts";
export * from "./vertex-policy.ts";
export * from "./vertex-worker.ts";
export * from "./notification-grants.ts";
export * from "./vertex-model-use.ts";
export * from "./vertex-epoch-transitions.ts";
export * from "./vertex-native-approval-audit.ts";
export {
  vertexResearchChatThreads,
  vertexResearchChatMessages,
} from "./vertex-research-chat.ts";
export * from "./vertex-research-chat-copies.ts";
export * from "./vertex-research-chat-execution.ts";
export * from "./vertex-research-chat-worker.ts";
export * from "./vertex-research-chat-model-privacy.ts";
export * from "./vertex-research-chat-advisory.ts";
export * from "./vertex-research-chat-debate.ts";
export * from "./vertex-research-chat-native-evidence.ts";
export * from "./research-reports.ts";
export * from "./research-studies.ts";
export * from "./flow.ts";
export * from "./openbb.ts";
export * from "./semantic-layer.ts";
export * from "./academy-content.ts";

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const USER_ROLES = ["member", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "suspended", "deactivated"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ADDRESS_TYPES = ["home", "work", "other"] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

// Canonical appearance values. Keep in sync with packages/state and packages/ui/src/themes.ts.
export const APPEARANCE_THEMES = [
  "system",
  "default-light",
  "default-dark",
  "graphite",
  "dracula",
  "monokai",
  "tokyo-night",
  "one-dark",
  "night-owl",
  "synthwave-84",
  "github-dark",
  "github-light",
] as const;
export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number];

export const FONT_SIZES = ["small", "default", "large"] as const;
export type FontSize = (typeof FONT_SIZES)[number];

export const DENSITIES = ["compact", "default", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];

export const RADII = ["none", "small", "medium", "large"] as const;
export type Radius = (typeof RADII)[number];

export const PROFILE_VISIBILITIES = ["private", "members", "public"] as const;
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

export const FEATURE_ITEM_STATUSES = ["draft", "active", "archived"] as const;
export type FeatureItemStatus = (typeof FEATURE_ITEM_STATUSES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type FeatureItemMetadata = Readonly<Record<string, JsonValue>>;
export type EventPayload = Readonly<Record<string, JsonValue>>;
export type AuditMetadata = Readonly<Record<string, JsonValue>>;

const utcTimestamp = (name: string) => {
  return timestamp(name, { mode: "date", withTimezone: true });
};
const utcTimestampMs = (name: string) => {
  return timestamp(name, { mode: "date", withTimezone: true, precision: 3 });
};

export const users = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    createdAt: utcTimestampMs("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    role: text("role").$type<UserRole>().default("member").notNull(),
    status: text("status").$type<UserStatus>().default("active").notNull(),
  },
  (table) => [
    index("user_created_at_id_idx").on(table.createdAt.desc(), table.id.desc()),
    index("user_email_prefix_idx").on(
      sql`lower(${table.email}) text_pattern_ops`
    ),
    index("user_name_prefix_idx").on(
      sql`lower(${table.name}) text_pattern_ops`
    ),
    check("user_role_check", sql`${table.role} in ('member', 'admin')`),
    check(
      "user_status_check",
      sql`${table.status} in ('active', 'suspended', 'deactivated')`
    ),
  ]
);

export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("session_user_id_idx").on(table.userId),
    index("session_expires_at_idx").on(table.expiresAt),
  ]
);

export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: utcTimestamp("access_token_expires_at"),
    refreshTokenExpiresAt: utcTimestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_provider_account_unique_idx").on(
      table.providerId,
      table.accountId
    ),
  ]
);

export const verifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("verification_identifier_idx").on(table.identifier),
    index("verification_expires_at_idx").on(table.expiresAt),
    uniqueIndex("verification_identifier_value_unique_idx").on(
      table.identifier,
      table.value
    ),
  ]
);

export const rateLimit = pgTable(
  "rate_limit",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [index("rate_limit_last_request_idx").on(table.lastRequest)]
);

// Better Auth @better-auth/api-key 1.6.24 table (model "apikey", exported as
// apiKeys for the drizzle adapter modelName). `key` holds the SHA-256
// base64url hash, never the plaintext key. Keys are agent-ledger credentials
// only; see packages/auth/src/server.ts createAgentApiKeyService.
export const apiKeys = pgTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: utcTimestamp("last_refill_at"),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(60_000),
    rateLimitMax: integer("rate_limit_max").default(600),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: utcTimestamp("last_request"),
    expiresAt: utcTimestamp("expires_at"),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_config_id_idx").on(table.configId),
    index("apikey_reference_id_idx").on(table.referenceId),
    index("apikey_key_idx").on(table.key),
  ]
);

export const profiles = pgTable(
  "profiles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    phone: text("phone"),
    businessName: text("business_name"),
    jobTitle: text("job_title"),
    biography: text("biography"),
    timezone: text("timezone").default("UTC").notNull(),
    locale: text("locale").default("en").notNull(),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("profiles_display_name_prefix_idx").on(
      sql`lower(${table.displayName}) text_pattern_ops`
    ),
    index("profiles_first_name_prefix_idx").on(
      sql`lower(${table.firstName}) text_pattern_ops`
    ),
    index("profiles_last_name_prefix_idx").on(
      sql`lower(${table.lastName}) text_pattern_ops`
    ),
  ]
);

export const addresses = pgTable(
  "addresses",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AddressType>().notNull(),
    line1: text("line_1").notNull(),
    line2: text("line_2"),
    city: text("city").notNull(),
    region: text("region").notNull(),
    postalCode: text("postal_code").notNull(),
    country: text("country").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("addresses_user_id_idx").on(
      table.userId,
      table.isPrimary.desc(),
      table.createdAt,
      table.id
    ),
    uniqueIndex("addresses_one_primary_per_user_idx")
      .on(table.userId)
      .where(sql`${table.isPrimary} = true`),
    check(
      "addresses_type_check",
      sql`${table.type} in ('home', 'work', 'other')`
    ),
    check("addresses_line_1_check", sql`length(trim(${table.line1})) > 0`),
    check("addresses_country_check", sql`length(${table.country}) = 2`),
  ]
);

export const userPreferences = pgTable(
  "user_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    theme: text("theme").$type<AppearanceTheme>().default("system").notNull(),
    fontSize: text("font_size").$type<FontSize>().default("default").notNull(),
    density: text("density").$type<Density>().default("default").notNull(),
    radius: text("radius").$type<Radius>().default("medium").notNull(),
    emailNotifications: boolean("email_notifications").default(true).notNull(),
    productUpdates: boolean("product_updates").default(true).notNull(),
    analyticsConsent: boolean("analytics_consent").default(false).notNull(),
    personalizationConsent: boolean("personalization_consent")
      .default(false)
      .notNull(),
    profileVisibility: text("profile_visibility")
      .$type<ProfileVisibility>()
      .default("private")
      .notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "user_preferences_theme_check",
      sql`${table.theme} in (
        'system', 'default-light', 'default-dark', 'graphite', 'dracula',
        'monokai', 'tokyo-night', 'one-dark', 'night-owl', 'synthwave-84',
        'github-dark', 'github-light'
      )`
    ),
    check(
      "user_preferences_font_size_check",
      sql`${table.fontSize} in ('small', 'default', 'large')`
    ),
    check(
      "user_preferences_density_check",
      sql`${table.density} in ('compact', 'default', 'comfortable')`
    ),
    check(
      "user_preferences_radius_check",
      sql`${table.radius} in ('none', 'small', 'medium', 'large')`
    ),
    check(
      "user_preferences_profile_visibility_check",
      sql`${table.profileVisibility} in ('private', 'members', 'public')`
    ),
  ]
);

export const featureItems = pgTable(
  "feature_items",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    status: text("status")
      .$type<FeatureItemStatus>()
      .default("draft")
      .notNull(),
    metadata: jsonb("metadata")
      .$type<FeatureItemMetadata>()
      .default({})
      .notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("feature_items_owner_id_idx").on(
      table.ownerId,
      table.updatedAt.desc(),
      table.id.desc()
    ),
    index("feature_items_owner_status_order_idx").on(
      table.ownerId,
      table.status,
      table.updatedAt.desc(),
      table.id.desc()
    ),
    check(
      "feature_items_status_check",
      sql`${table.status} in ('draft', 'active', 'archived')`
    ),
    check("feature_items_name_check", sql`length(trim(${table.name})) > 0`),
    check(
      "feature_items_metadata_check",
      sql`jsonb_typeof(${table.metadata}) = 'object' and octet_length(${table.metadata}::text) <= 16384`
    ),
  ]
);

export const WATCHLIST_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
export const WATCHLIST_NOTE_MAX_LENGTH = 500;

export const watchlistItems = pgTable(
  "watchlist_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    note: text("note"),
    buyZoneLow: numeric("buy_zone_low"),
    buyZoneHigh: numeric("buy_zone_high"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("watchlist_items_user_symbol_unique_idx").on(
      table.userId,
      table.symbol
    ),
    check(
      "watchlist_items_symbol_check",
      sql`${table.symbol} ~ '^[A-Z][A-Z0-9.\\-]{0,9}$'`
    ),
    check(
      "watchlist_items_note_check",
      sql`${table.note} is null or char_length(${table.note}) <= 500`
    ),
    check(
      "watchlist_items_buy_zone_check",
      sql`(${table.buyZoneLow} is null or ${table.buyZoneLow} > 0) and (${table.buyZoneHigh} is null or ${table.buyZoneHigh} > 0) and (${table.buyZoneLow} is null or ${table.buyZoneHigh} is null or ${table.buyZoneLow} <= ${table.buyZoneHigh})`
    ),
  ]
);

// Private per-user custom baskets ("fake ETFs"): tracked price index only. No orders,
// intents, quantities held, or broker linkage. base_date null = base not fixed yet
// (fixed at the first full session close after creation).
export const BASKET_SYMBOL_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
export const BASKET_NAME_MAX_LENGTH = 80;
export const BASKET_MAX_MEMBERS = 50;

export const baskets = pgTable(
  "baskets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    baseDate: date("base_date"),
    baseValue: numeric("base_value").default("100").notNull(),
    // Benchmark (SPY) close on base_date; kept so the benchmark line survives after the
    // base date leaves the one-year history window. Null = not known yet.
    benchmarkBasePrice: numeric("benchmark_base_price"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("baskets_user_symbol_unique_idx").on(
      table.userId,
      table.symbol
    ),
    check(
      "baskets_symbol_check",
      sql`${table.symbol} ~ '^[A-Z][A-Z0-9]{0,9}$'`
    ),
    check(
      "baskets_name_check",
      sql`char_length(trim(${table.name})) between 1 and 80`
    ),
    check("baskets_base_value_check", sql`${table.baseValue} > 0`),
    check(
      "baskets_benchmark_base_price_check",
      sql`${table.benchmarkBasePrice} is null or ${table.benchmarkBasePrice} > 0`
    ),
  ]
);

export const basketMembers = pgTable(
  "basket_members",
  {
    basketId: text("basket_id")
      .notNull()
      .references(() => baskets.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    weight: numeric("weight").notNull(),
    basePrice: numeric("base_price"),
    sharesAtBase: numeric("shares_at_base"),
  },
  (table) => [
    primaryKey({ columns: [table.basketId, table.symbol] }),
    check(
      "basket_members_symbol_check",
      sql`${table.symbol} ~ '^[A-Z][A-Z0-9.\\-]{0,9}$'`
    ),
    check(
      "basket_members_weight_check",
      sql`${table.weight} > 0 and ${table.weight} <= 1`
    ),
    check(
      "basket_members_base_check",
      sql`(${table.basePrice} is null or ${table.basePrice} > 0) and (${table.sharesAtBase} is null or ${table.sharesAtBase} > 0)`
    ),
  ]
);

// Dated snapshots of external stock-pick lists with provenance per row (source slug, list slug,
// as-of date, import method). Research only: no orders. bucket_symbol links a basket by symbol.
export const PICK_LIST_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PICK_LIST_NAME_MAX_LENGTH = 80;
export const PICK_LIST_MAX_MEMBERS = 200;
export const PICK_LIST_IMPORT_METHODS = ["manual", "adapter"] as const;

export const pickLists = pgTable(
  "pick_lists",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceLabel: text("source_label").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    bucketSymbol: text("bucket_symbol"),
    // The basket the list was last synced into; cleared when that basket is deleted.
    bucketBasketId: text("bucket_basket_id").references(() => baskets.id, {
      onDelete: "set null",
    }),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pick_lists_user_source_slug_unique_idx").on(
      table.userId,
      table.source,
      table.slug
    ),
    check(
      "pick_lists_fields_check",
      sql`${table.source} ~ '^[a-z0-9][a-z0-9-]{0,39}$' and ${table.slug} ~ '^[a-z0-9][a-z0-9-]{0,39}$' and char_length(trim(${table.sourceLabel})) between 1 and 80 and char_length(trim(${table.name})) between 1 and 80 and (${table.bucketSymbol} is null or ${table.bucketSymbol} ~ '^[A-Z][A-Z0-9]{0,9}$')`
    ),
  ]
);

export const pickListSnapshots = pgTable(
  "pick_list_snapshots",
  {
    id: text("id").primaryKey(),
    pickListId: text("pick_list_id")
      .notNull()
      .references(() => pickLists.id, { onDelete: "cascade" }),
    asOf: date("as_of").notNull(),
    method: text("method").notNull(),
    importedAt: utcTimestamp("imported_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pick_list_snapshots_list_as_of_unique_idx").on(
      table.pickListId,
      table.asOf
    ),
    check(
      "pick_list_snapshots_method_check",
      sql`${table.method} in ('manual', 'adapter')`
    ),
  ]
);

export const pickListMembers = pgTable(
  "pick_list_members",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => pickListSnapshots.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    rank: integer("rank"),
    weight: numeric("weight"),
    sector: text("sector"),
    rating: text("rating"),
    thesis: text("thesis"),
    targetPrice: numeric("target_price"),
    addedOn: date("added_on"),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.symbol] }),
    check(
      "pick_list_members_fields_check",
      sql`${table.symbol} ~ '^[A-Z][A-Z0-9.\\-]{0,9}$' and (${table.rank} is null or ${table.rank} between 1 and 1000) and (${table.weight} is null or (${table.weight} >= 0 and ${table.weight} <= 1)) and (${table.targetPrice} is null or ${table.targetPrice} > 0) and (${table.sector} is null or char_length(${table.sector}) <= 60) and (${table.rating} is null or char_length(${table.rating}) <= 40) and (${table.thesis} is null or char_length(${table.thesis}) <= 2000)`
    ),
  ]
);

// Operator's options plays (research ideas with defined risk). Options only; never orders.
// legs: [{ side, right, strike, expiry, quantity }]; validated by the repository on write and
// shape-checked here (non-empty array). Defined risk is required: max_loss_usd > 0 and
// defined_risk must be true.
export const PLAYS_MAX = 200;
export const PLAY_STATUSES = ["idea", "armed", "taken", "dropped"] as const;
export type PlayStatus = (typeof PLAY_STATUSES)[number];
export interface PlayLeg {
  readonly expiry: string;
  readonly quantity: number;
  readonly right: "call" | "put";
  readonly side: "buy" | "sell";
  readonly strike: number;
}

export const plays = pgTable(
  "plays",
  {
    id: text("id").primaryKey(),
    ticker: text("ticker").notNull(),
    structure: text("structure").notNull(),
    legs: jsonb("legs").$type<PlayLeg[]>().notNull(),
    maxLossUsd: numeric("max_loss_usd").notNull(),
    definedRisk: boolean("defined_risk").default(true).notNull(),
    thesis: text("thesis").notNull(),
    trigger: text("trigger").notNull(),
    exitRule: text("exit_rule").notNull(),
    status: text("status").$type<PlayStatus>().notNull(),
    notes: text("notes"),
    sourceUrl: text("source_url"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("plays_updated_at_idx").on(table.updatedAt),
    check("plays_max_loss_check", sql`${table.maxLossUsd} > 0`),
    check("plays_defined_risk_check", sql`${table.definedRisk} = true`),
    check(
      "plays_status_check",
      sql`${table.status} in ('idea', 'armed', 'taken', 'dropped')`
    ),
    check(
      "plays_legs_check",
      sql`case when jsonb_typeof(${table.legs}) = 'array' then jsonb_array_length(${table.legs}) between 1 and 8 else false end`
    ),
    check(
      "plays_fields_check",
      sql`${table.ticker} ~ '^[A-Z][A-Z0-9.\\-]{0,9}$' and char_length(trim(${table.structure})) between 1 and 80 and char_length(trim(${table.thesis})) between 1 and 2000 and char_length(trim(${table.trigger})) between 1 and 500 and char_length(trim(${table.exitRule})) between 1 and 500 and (${table.notes} is null or char_length(${table.notes}) <= 2000) and (${table.sourceUrl} is null or ${table.sourceUrl} ~ '^https://')`
    ),
  ]
);

// Workspace-scoped agent operations ledger and research paper library.
// Single-operator fund: rows are not owned by a user; any authenticated session reads and writes.
export const AGENT_TASK_KINDS = [
  "research",
  "paper",
  "strategy",
  "backtest",
  "forward_test",
  "optimization",
  "deployment",
  "data",
  "ops",
] as const;
export const AGENT_TASK_STATUSES = [
  "queued",
  "running",
  "needs_review",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const AGENT_TASK_EVENT_LEVELS = ["info", "warn", "error"] as const;
export const RESEARCH_PAPER_KINDS = ["paper", "article"] as const;
export const RESEARCH_PAPER_STAGES = [
  "queued",
  "ingested",
  "spec_extracted",
  "implemented",
  "backtested",
  "forward_tested",
  "verdict",
] as const;
export const RESEARCH_PAPER_VERDICTS = [
  "pending",
  "promising",
  "inconclusive",
  "rejected",
] as const;

export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number];
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];
export type AgentTaskEventLevel = (typeof AGENT_TASK_EVENT_LEVELS)[number];
export type ResearchPaperKind = (typeof RESEARCH_PAPER_KINDS)[number];
export type ResearchPaperStage = (typeof RESEARCH_PAPER_STAGES)[number];
export type ResearchPaperVerdict = (typeof RESEARCH_PAPER_VERDICTS)[number];
export type AgentMetrics = Record<string, number | string>;
export interface AgentLink {
  label: string;
  url: string;
}

export const researchPapers = pgTable(
  "research_papers",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    authors: text("authors"),
    year: integer("year"),
    sourceUrl: text("source_url"),
    identifier: text("identifier"),
    kind: text("kind").$type<ResearchPaperKind>().default("paper").notNull(),
    stage: text("stage")
      .$type<ResearchPaperStage>()
      .default("queued")
      .notNull(),
    verdict: text("verdict")
      .$type<ResearchPaperVerdict>()
      .default("pending")
      .notNull(),
    blockers: text("blockers"),
    notes: text("notes"),
    reportedMetrics: jsonb("reported_metrics")
      .$type<AgentMetrics>()
      .default({})
      .notNull(),
    reproducedMetrics: jsonb("reproduced_metrics")
      .$type<AgentMetrics>()
      .default({})
      .notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("research_papers_identifier_unique_idx").on(table.identifier),
    index("research_papers_stage_updated_idx").on(
      table.stage,
      table.updatedAt.desc()
    ),
    check(
      "research_papers_title_check",
      sql`char_length(trim(${table.title})) between 1 and 300`
    ),
    check(
      "research_papers_kind_check",
      sql`${table.kind} in ('paper', 'article')`
    ),
    check(
      "research_papers_stage_check",
      sql`${table.stage} in ('queued', 'ingested', 'spec_extracted', 'implemented', 'backtested', 'forward_tested', 'verdict')`
    ),
    check(
      "research_papers_verdict_check",
      sql`${table.verdict} in ('pending', 'promising', 'inconclusive', 'rejected')`
    ),
    check(
      "research_papers_year_check",
      sql`${table.year} is null or ${table.year} between 1900 and 2100`
    ),
    check(
      "research_papers_text_check",
      sql`(${table.authors} is null or char_length(${table.authors}) <= 500) and (${table.sourceUrl} is null or char_length(${table.sourceUrl}) <= 2000) and (${table.identifier} is null or char_length(${table.identifier}) <= 200) and (${table.blockers} is null or char_length(${table.blockers}) <= 4000) and (${table.notes} is null or char_length(${table.notes}) <= 4000)`
    ),
    check(
      "research_papers_metrics_check",
      sql`jsonb_typeof(${table.reportedMetrics}) = 'object' and jsonb_typeof(${table.reproducedMetrics}) = 'object' and octet_length(${table.reportedMetrics}::text) <= 8192 and octet_length(${table.reproducedMetrics}::text) <= 8192`
    ),
  ]
);

export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<AgentTaskKind>().notNull(),
    agent: text("agent").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status").$type<AgentTaskStatus>().default("queued").notNull(),
    metrics: jsonb("metrics").$type<AgentMetrics>().default({}).notNull(),
    links: jsonb("links").$type<AgentLink[]>().default([]).notNull(),
    paperId: text("paper_id").references(() => researchPapers.id, {
      onDelete: "set null",
    }),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
    startedAt: utcTimestamp("started_at"),
    finishedAt: utcTimestamp("finished_at"),
  },
  (table) => [
    index("agent_tasks_status_updated_idx").on(
      table.status,
      table.updatedAt.desc()
    ),
    index("agent_tasks_kind_updated_idx").on(
      table.kind,
      table.updatedAt.desc()
    ),
    index("agent_tasks_updated_idx").on(table.updatedAt.desc()),
    index("agent_tasks_paper_idx").on(table.paperId),
    check(
      "agent_tasks_kind_check",
      sql`${table.kind} in ('research', 'paper', 'strategy', 'backtest', 'forward_test', 'optimization', 'deployment', 'data', 'ops')`
    ),
    check(
      "agent_tasks_status_check",
      sql`${table.status} in ('queued', 'running', 'needs_review', 'blocked', 'succeeded', 'failed', 'cancelled')`
    ),
    check(
      "agent_tasks_agent_check",
      sql`char_length(trim(${table.agent})) between 1 and 100`
    ),
    check(
      "agent_tasks_title_check",
      sql`char_length(trim(${table.title})) between 1 and 300`
    ),
    check(
      "agent_tasks_summary_check",
      sql`${table.summary} is null or char_length(${table.summary}) <= 4000`
    ),
    check(
      "agent_tasks_metrics_check",
      sql`jsonb_typeof(${table.metrics}) = 'object' and octet_length(${table.metrics}::text) <= 8192`
    ),
    check(
      "agent_tasks_links_check",
      sql`jsonb_typeof(${table.links}) = 'array' and jsonb_array_length(${table.links}) <= 20 and octet_length(${table.links}::text) <= 8192`
    ),
  ]
);

export const agentTaskEvents = pgTable(
  "agent_task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    at: utcTimestamp("at").defaultNow().notNull(),
    level: text("level").$type<AgentTaskEventLevel>().default("info").notNull(),
    message: text("message").notNull(),
  },
  (table) => [
    index("agent_task_events_task_at_idx").on(table.taskId, table.at.desc()),
    index("agent_task_events_at_idx").on(table.at.desc()),
    check(
      "agent_task_events_level_check",
      sql`${table.level} in ('info', 'warn', 'error')`
    ),
    check(
      "agent_task_events_message_check",
      sql`char_length(trim(${table.message})) between 1 and 2000`
    ),
  ]
);

// Operator strategy library (single-operator fund; rows carry no owner). A strategy names research
// code by a repository-relative source reference; params is a typed schema, presets are named values.
export const STRATEGY_KINDS = ["python", "native", "external"] as const;
export const STRATEGY_STATUSES = [
  "idea",
  "researching",
  "backtested",
  "paper",
  "live_candidate",
  "retired",
] as const;
export const STRATEGY_PARAM_TYPES = [
  "integer",
  "decimal",
  "boolean",
  "choice",
] as const;
export type StrategyKind = (typeof STRATEGY_KINDS)[number];
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];
export type StrategyParamType = (typeof STRATEGY_PARAM_TYPES)[number];
export type StrategyParamValue = number | boolean | string;
// min/max/step apply to integer and decimal only; options to choice only.
export interface StrategyParam {
  name: string;
  type: StrategyParamType;
  title: string;
  default: StrategyParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}
export type StrategyPresetValues = Record<string, StrategyParamValue>;
// high lists a strategy first inside every library sort.
export const STRATEGY_PRIORITIES = ["normal", "high"] as const;
export type StrategyPriority = (typeof STRATEGY_PRIORITIES)[number];
// A third party's published claim about a strategy (source, claimed method, claimed metrics).
// Non-null is the single source of the label "Externally pre-validated"; it never means
// validated by Vertex. null means no external claim.
export interface StrategyExternalValidationMetric {
  label: string;
  value: string;
}
export interface StrategyExternalValidation {
  sourceUrl: string;
  sourceTitle: string;
  sourceAuthor: string;
  publishedOn: string;
  claimedMethod: string;
  claimedMetrics: StrategyExternalValidationMetric[];
}

export const strategies = pgTable(
  "strategies",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").$type<StrategyKind>().notNull(),
    status: text("status").$type<StrategyStatus>().default("idea").notNull(),
    sourceRef: text("source_ref"),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    favorite: boolean("favorite").default(false).notNull(),
    section: text("section"),
    params: jsonb("params").$type<StrategyParam[]>().default([]).notNull(),
    priority: text("priority")
      .$type<StrategyPriority>()
      .default("normal")
      .notNull(),
    externalValidation: jsonb(
      "external_validation"
    ).$type<StrategyExternalValidation>(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("strategies_slug_unique_idx").on(table.slug),
    index("strategies_updated_idx").on(table.updatedAt.desc()),
    index("strategies_section_idx").on(table.section),
    check(
      "strategies_slug_check",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${table.slug}) <= 80`
    ),
    check(
      "strategies_name_check",
      sql`char_length(trim(${table.name})) between 1 and 200`
    ),
    check(
      "strategies_kind_check",
      sql`${table.kind} in ('python', 'native', 'external')`
    ),
    check(
      "strategies_status_check",
      sql`${table.status} in ('idea', 'researching', 'backtested', 'paper', 'live_candidate', 'retired')`
    ),
    check(
      "strategies_text_check",
      sql`(${table.description} is null or char_length(${table.description}) <= 2000) and (${table.sourceRef} is null or char_length(${table.sourceRef}) between 1 and 300) and (${table.section} is null or char_length(trim(${table.section})) between 1 and 80)`
    ),
    check(
      "strategies_json_check",
      sql`jsonb_typeof(${table.tags}) = 'array' and jsonb_array_length(${table.tags}) <= 20 and octet_length(${table.tags}::text) <= 2048 and jsonb_typeof(${table.params}) = 'array' and jsonb_array_length(${table.params}) <= 60 and octet_length(${table.params}::text) <= 65536`
    ),
    check(
      "strategies_priority_check",
      sql`${table.priority} in ('normal', 'high')`
    ),
  ]
);

export const strategyPresets = pgTable(
  "strategy_presets",
  {
    id: text("id").primaryKey(),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    values: jsonb("values").$type<StrategyPresetValues>().default({}).notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("strategy_presets_strategy_name_unique_idx").on(
      table.strategyId,
      table.name
    ),
    check(
      "strategy_presets_name_check",
      sql`char_length(trim(${table.name})) between 1 and 80`
    ),
    check(
      "strategy_presets_values_check",
      sql`jsonb_typeof(${table.values}) = 'object' and octet_length(${table.values}::text) <= 16384`
    ),
  ]
);

// Backtest results reported by agents against a ledger task. Values are agent-reported, not verified.
// drawdown and max_drawdown are derived server-side from equity; clients cannot supply them.
export interface BacktestEquityPoint {
  t: string;
  equity: number;
}
export interface BacktestDrawdownPoint {
  t: string;
  drawdown: number;
}
// Optional trade fields: stop and target prices, commission paid, a regime label and the traded symbol.
export interface BacktestTrade {
  entry_t: string;
  exit_t: string;
  side: "long" | "short";
  qty: number;
  entry_px: number;
  exit_px: number;
  pnl: number;
  sl?: number;
  tp?: number;
  commission?: number;
  regime?: string;
  symbol?: string;
}
export interface BacktestFold {
  label: string;
  train_start: string;
  train_end: string;
  test_start: string;
  test_end: string;
  metrics: AgentMetrics;
}
export interface BacktestSplitWindow {
  start: string;
  end: string;
  metrics: AgentMetrics;
}
export interface BacktestIsSplit {
  in_sample: BacktestSplitWindow;
  out_of_sample: BacktestSplitWindow;
}
export type BacktestFillModel = "bar" | "tick" | "l2";
// Run assumptions reported with the result. Every field is optional; units are account currency or percent.
export interface BacktestRunConfig {
  initialCapital?: number;
  commissionPerContract?: number;
  commissionPerTrade?: number;
  commissionPercent?: number;
  slippagePercent?: number;
  timeframe?: string;
  fillModel?: BacktestFillModel;
  leverage?: number;
}
// Benchmark equity on the same timestamps as the strategy equity (for alpha/beta).
export interface BacktestBenchmark {
  label: string;
  points: BacktestEquityPoint[];
}
// Agent rating decisions replayed on read against stored daily bars. Research stance labels only; a rating
// never authorizes, creates or sizes an order. rating null marks a failed or unparseable run.
export const BACKTEST_RATING_VALUES = [
  "buy",
  "overweight",
  "hold",
  "underweight",
  "sell",
] as const;
export type BacktestRating = (typeof BACKTEST_RATING_VALUES)[number];
export interface BacktestRatingDecision {
  date: string;
  rating: BacktestRating | null;
  runId?: string | null;
}
export interface BacktestRatingSeries {
  costBps: number;
  decisions: BacktestRatingDecision[];
  symbol: string;
  timeframe: string;
}

export const backtestResults = pgTable(
  "backtest_results",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    paperId: text("paper_id").references(() => researchPapers.id, {
      onDelete: "set null",
    }),
    strategyId: text("strategy_id").references(() => strategies.id, {
      onDelete: "set null",
    }),
    strategy: text("strategy").notNull(),
    instruments: text("instruments").notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    dataSource: text("data_source").notNull(),
    isSplit: jsonb("is_split").$type<BacktestIsSplit>(),
    metrics: jsonb("metrics").$type<AgentMetrics>().default({}).notNull(),
    equity: jsonb("equity")
      .$type<BacktestEquityPoint[]>()
      .default([])
      .notNull(),
    drawdown: jsonb("drawdown")
      .$type<BacktestDrawdownPoint[]>()
      .default([])
      .notNull(),
    maxDrawdown: doublePrecision("max_drawdown"),
    trades: jsonb("trades").$type<BacktestTrade[]>().default([]).notNull(),
    tradeCount: integer("trade_count").default(0).notNull(),
    folds: jsonb("folds").$type<BacktestFold[]>().default([]).notNull(),
    notes: text("notes"),
    runConfig: jsonb("run_config").$type<BacktestRunConfig>(),
    benchmark: jsonb("benchmark").$type<BacktestBenchmark>(),
    ratingSeries: jsonb("rating_series").$type<BacktestRatingSeries>(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("backtest_results_created_idx").on(table.createdAt.desc()),
    index("backtest_results_task_idx").on(table.taskId, table.createdAt.desc()),
    index("backtest_results_paper_idx").on(table.paperId),
    index("backtest_results_strategy_idx").on(
      table.strategyId,
      table.createdAt.desc()
    ),
    check(
      "backtest_results_text_check",
      sql`char_length(trim(${table.strategy})) between 1 and 200 and char_length(trim(${table.instruments})) between 1 and 500 and char_length(trim(${table.dataSource})) between 1 and 300 and (${table.notes} is null or char_length(${table.notes}) <= 4000)`
    ),
    check(
      "backtest_results_period_check",
      sql`${table.periodStart} <= ${table.periodEnd}`
    ),
    check(
      "backtest_results_json_check",
      sql`jsonb_typeof(${table.metrics}) = 'object' and octet_length(${table.metrics}::text) <= 8192 and (${table.isSplit} is null or (jsonb_typeof(${table.isSplit}) = 'object' and octet_length(${table.isSplit}::text) <= 32768)) and jsonb_typeof(${table.equity}) = 'array' and jsonb_array_length(${table.equity}) <= 5000 and jsonb_typeof(${table.drawdown}) = 'array' and jsonb_array_length(${table.drawdown}) = jsonb_array_length(${table.equity}) and jsonb_typeof(${table.trades}) = 'array' and jsonb_array_length(${table.trades}) <= 2000 and ${table.tradeCount} = jsonb_array_length(${table.trades}) and jsonb_typeof(${table.folds}) = 'array' and jsonb_array_length(${table.folds}) <= 100 and octet_length(${table.folds}::text) <= 524288`
    ),
    check(
      "backtest_results_max_drawdown_check",
      sql`${table.maxDrawdown} is null or (${table.maxDrawdown} <= 0 and ${table.maxDrawdown} > -1)`
    ),
    check(
      "backtest_results_extras_check",
      sql`(${table.runConfig} is null or (jsonb_typeof(${table.runConfig}) = 'object' and octet_length(${table.runConfig}::text) <= 2048)) and (${table.benchmark} is null or (jsonb_typeof(${table.benchmark}) = 'object' and octet_length(${table.benchmark}::text) <= 524288))`
    ),
    check(
      "backtest_results_rating_series_check",
      sql`${table.ratingSeries} is null or (jsonb_typeof(${table.ratingSeries}) = 'object' and octet_length(${table.ratingSeries}::text) <= 65536)`
    ),
  ]
);

// Quant Lab (migration 0043): SSRN paper captures and frozen strategy specs. Research records only;
// nothing reads them to start, route or submit orders. Written through server/quant-lab-store.ts.
// A capture is unique by DOI and Crossref deposit time (version); a spec is unique by its SHA-256.
export const paperCaptures = pgTable(
  "paper_captures",
  {
    id: text("id").primaryKey(),
    paperId: text("paper_id")
      .notNull()
      .references(() => researchPapers.id, { onDelete: "cascade" }),
    doi: text("doi").notNull(),
    ssrnId: text("ssrn_id").notNull(),
    version: text("version").notNull(),
    topic: text("topic").notNull(),
    title: text("title").notNull(),
    authors: jsonb("authors").$type<string[]>().default([]).notNull(),
    posted: text("posted"),
    abstract: text("abstract"),
    url: text("url").notNull(),
    metadataSource: text("metadata_source").notNull(),
    pdfStatus: text("pdf_status").notNull(),
    pdfSha256: text("pdf_sha256"),
    pdfBytes: integer("pdf_bytes"),
    pdfSourceUrl: text("pdf_source_url"),
    capturedAt: utcTimestamp("captured_at").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("paper_captures_doi_version_unique_idx").on(
      table.doi,
      table.version
    ),
    index("paper_captures_paper_idx").on(table.paperId),
    check(
      "paper_captures_text_check",
      sql`${table.doi} ~ '^10\\.2139/ssrn\\.[0-9]+$' and ${table.ssrnId} ~ '^[0-9]+$' and char_length(${table.version}) between 1 and 120 and char_length(trim(${table.topic})) between 1 and 200 and char_length(trim(${table.title})) between 1 and 300 and (${table.abstract} is null or char_length(${table.abstract}) <= 10000) and char_length(${table.url}) <= 2000 and (${table.pdfSourceUrl} is null or char_length(${table.pdfSourceUrl}) <= 2000)`
    ),
    check(
      "paper_captures_pdf_check",
      sql`(${table.pdfStatus} = 'retained' and ${table.pdfSha256} ~ '^[0-9a-f]{64}$' and ${table.pdfBytes} > 0) or (${table.pdfStatus} like 'metadata_only:%' and ${table.pdfSha256} is null and ${table.pdfBytes} is null)`
    ),
    check(
      "paper_captures_authors_check",
      sql`jsonb_typeof(${table.authors}) = 'array' and jsonb_array_length(${table.authors}) <= 100 and octet_length(${table.authors}::text) <= 8192`
    ),
  ]
);

export const strategySpecs = pgTable(
  "strategy_specs",
  {
    id: text("id").primaryKey(),
    specKey: text("spec_key").notNull(),
    specSha256: text("spec_sha256").notNull(),
    paperId: text("paper_id").references(() => researchPapers.id, {
      onDelete: "set null",
    }),
    captureId: text("capture_id").references(() => paperCaptures.id, {
      onDelete: "set null",
    }),
    strategyId: text("strategy_id").references(() => strategies.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    hypothesis: text("hypothesis").notNull(),
    paperClaims: jsonb("paper_claims")
      .$type<Record<string, unknown>[]>()
      .notNull(),
    ourReading: jsonb("our_reading").$type<Record<string, unknown>>().notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("strategy_specs_sha_unique_idx").on(table.specSha256),
    index("strategy_specs_paper_idx").on(table.paperId),
    check(
      "strategy_specs_text_check",
      sql`${table.specSha256} ~ '^[0-9a-f]{64}$' and ${table.specKey} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${table.specKey}) <= 80 and char_length(trim(${table.name})) between 1 and 200 and char_length(trim(${table.hypothesis})) between 1 and 4000`
    ),
    check(
      "strategy_specs_json_check",
      sql`jsonb_typeof(${table.paperClaims}) = 'array' and jsonb_array_length(${table.paperClaims}) between 1 and 50 and jsonb_typeof(${table.ourReading}) = 'object' and jsonb_typeof(${table.spec}) = 'object' and octet_length(${table.spec}::text) <= 65536`
    ),
  ]
);

export type QuantLabPaperCapture = typeof paperCaptures.$inferSelect;
export type QuantLabStrategySpec = typeof strategySpecs.$inferSelect;

// Agent model runs: one row per framework run (for example TradingAgents) on one ticker and decision
// date, recorded by the agent that ran it. rating and the entry/stop/target levels are research labels.
// They never authorize, create or size an order; no order path reads this table.
export const AGENT_MODEL_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type AgentModelRunStatus = (typeof AGENT_MODEL_RUN_STATUSES)[number];
export const AGENT_MODEL_RUN_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly AgentModelRunStatus[];
// How the rating was read from the model output. A run without a rating is "missing", never hold.
export const AGENT_MODEL_RUN_RATING_SOURCES = [
  "stated",
  "mapped",
  "missing",
] as const;
export type AgentModelRunRatingSource =
  (typeof AGENT_MODEL_RUN_RATING_SOURCES)[number];
export const AGENT_MODEL_RUN_PURPOSES = [
  "live",
  "backtest",
  "benchmark",
  "imported",
] as const;
export type AgentModelRunPurpose = (typeof AGENT_MODEL_RUN_PURPOSES)[number];
export const AGENT_MODEL_RUN_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
export const AGENT_MODEL_RUN_TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.=/-]{0,19}$/;
export const AGENT_MODEL_RUN_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const AGENT_MODEL_RUN_LABEL_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const AGENT_MODEL_RUN_LIMITS = {
  analystLength: 64,
  analysts: 16,
  dataSource: 120,
  error: 2000,
  flags: 16,
  frameworkVersion: 64,
  horizon: 64,
  model: 200,
  modelsServed: 16,
  provider: 64,
} as const;
export interface AgentModelServed {
  requested: string;
  served: string;
}

export const agentModelRuns = pgTable(
  "agent_model_runs",
  {
    id: text("id").primaryKey(),
    runKey: text("run_key").notNull(),
    taskId: text("task_id").references(() => agentTasks.id, {
      onDelete: "set null",
    }),
    framework: text("framework").notNull(),
    frameworkVersion: text("framework_version"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    modelsServed: jsonb("models_served")
      .$type<AgentModelServed[]>()
      .default([])
      .notNull(),
    ticker: text("ticker").notNull(),
    decisionDate: date("decision_date", { mode: "string" }).notNull(),
    analysts: jsonb("analysts").$type<string[]>().default([]).notNull(),
    rating: text("rating").$type<BacktestRating>(),
    ratingSource: text("rating_source")
      .$type<AgentModelRunRatingSource>()
      .default("missing")
      .notNull(),
    entryPrice: doublePrecision("entry_price"),
    stopPrice: doublePrecision("stop_price"),
    targetPrice: doublePrecision("target_price"),
    horizon: text("horizon"),
    status: text("status")
      .$type<AgentModelRunStatus>()
      .default("queued")
      .notNull(),
    error: text("error"),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    llmCalls: integer("llm_calls").default(0).notNull(),
    toolCalls: integer("tool_calls").default(0).notNull(),
    costUsd: doublePrecision("cost_usd").default(0).notNull(),
    durationMs: integer("duration_ms"),
    flags: jsonb("flags").$type<string[]>().default([]).notNull(),
    batch: text("batch"),
    purpose: text("purpose")
      .$type<AgentModelRunPurpose>()
      .default("live")
      .notNull(),
    variant: text("variant"),
    memory: boolean("memory").default(false).notNull(),
    dataSource: text("data_source"),
    startedAt: utcTimestamp("started_at"),
    finishedAt: utcTimestamp("finished_at"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_model_runs_run_key_idx").on(table.runKey),
    index("agent_model_runs_decision_idx").on(
      table.decisionDate.desc(),
      table.createdAt.desc(),
      table.id.desc()
    ),
    index("agent_model_runs_framework_idx").on(
      table.framework,
      table.decisionDate.desc()
    ),
    index("agent_model_runs_provider_model_idx").on(
      table.provider,
      table.model
    ),
    index("agent_model_runs_ticker_idx").on(
      table.ticker,
      table.decisionDate.desc()
    ),
    index("agent_model_runs_status_idx").on(table.status),
    index("agent_model_runs_rating_idx").on(table.rating),
    index("agent_model_runs_batch_idx").on(table.batch),
    index("agent_model_runs_variant_idx").on(table.variant),
    index("agent_model_runs_task_idx").on(table.taskId),
    index("agent_model_runs_flags_idx").using("gin", table.flags),
    check(
      "agent_model_runs_enum_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled') and ${table.purpose} in ('live', 'backtest', 'benchmark', 'imported') and ((${table.rating} is null and ${table.ratingSource} = 'missing') or (${table.rating} in ('buy', 'overweight', 'hold', 'underweight', 'sell') and ${table.ratingSource} in ('stated', 'mapped')))`
    ),
    check(
      "agent_model_runs_text_check",
      sql`${table.runKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.framework} ~ '^[a-z][a-z0-9_-]{0,39}$' and ${table.ticker} ~ '^[A-Z0-9][A-Z0-9.=/-]{0,19}$' and char_length(trim(${table.provider})) between 1 and 64 and char_length(trim(${table.model})) between 1 and 200 and (${table.frameworkVersion} is null or char_length(trim(${table.frameworkVersion})) between 1 and 64) and (${table.horizon} is null or char_length(trim(${table.horizon})) between 1 and 64) and (${table.error} is null or char_length(${table.error}) <= 2000) and (${table.batch} is null or ${table.batch} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$') and (${table.variant} is null or ${table.variant} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$') and (${table.dataSource} is null or char_length(trim(${table.dataSource})) between 1 and 120)`
    ),
    check(
      "agent_model_runs_numbers_check",
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.llmCalls} >= 0 and ${table.toolCalls} >= 0 and ${table.costUsd} >= 0 and ${table.costUsd} <= 1000000 and (${table.durationMs} is null or ${table.durationMs} >= 0) and (${table.entryPrice} is null or (${table.entryPrice} > 0 and ${table.entryPrice} < 1e12)) and (${table.stopPrice} is null or (${table.stopPrice} > 0 and ${table.stopPrice} < 1e12)) and (${table.targetPrice} is null or (${table.targetPrice} > 0 and ${table.targetPrice} < 1e12))`
    ),
    check(
      "agent_model_runs_json_check",
      sql`jsonb_typeof(${table.analysts}) = 'array' and jsonb_array_length(${table.analysts}) <= 16 and not jsonb_path_exists(${table.analysts}, '$[*] ? (@.type() != "string")') and jsonb_typeof(${table.flags}) = 'array' and jsonb_array_length(${table.flags}) <= 16 and not jsonb_path_exists(${table.flags}, '$[*] ? (@.type() != "string")') and jsonb_typeof(${table.modelsServed}) = 'array' and jsonb_array_length(${table.modelsServed}) <= 16 and not jsonb_path_exists(${table.modelsServed}, '$[*] ? (@.type() != "object")') and octet_length(${table.analysts}::text) <= 2048 and octet_length(${table.flags}::text) <= 1024 and octet_length(${table.modelsServed}::text) <= 8192`
    ),
  ]
);

export type AgentModelRun = typeof agentModelRuns.$inferSelect;

// Events of one model run (LLM calls, tool calls and results, reasoning, messages, decisions, status
// changes, flags) for the live view and replay. Model text only; bodies are bounded and the API
// rejects text that the shared redaction detectors flag. `search` is a generated full-text vector.
export const AGENT_MODEL_RUN_EVENT_KINDS = [
  "llm_call",
  "tool_call",
  "tool_result",
  "reasoning",
  "message",
  "decision",
  "status",
  "flag",
] as const;
export type AgentModelRunEventKind =
  (typeof AGENT_MODEL_RUN_EVENT_KINDS)[number];
export const AGENT_MODEL_RUN_EVENT_LIMITS = {
  agent: 100,
  body: 16_000,
  model: 200,
  title: 300,
  toolName: 100,
} as const;

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export const agentModelRunEvents = pgTable(
  "agent_model_run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentModelRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: utcTimestamp("at").notNull(),
    agent: text("agent").notNull(),
    kind: text("kind").$type<AgentModelRunEventKind>().notNull(),
    title: text("title").notNull(),
    body: text("body"),
    model: text("model"),
    toolName: text("tool_name"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: doublePrecision("cost_usd"),
    durationMs: integer("duration_ms"),
    search: tsvector("search")
      .notNull()
      .generatedAlwaysAs(
        sql`to_tsvector('english'::regconfig, coalesce("title", '') || ' ' || coalesce("body", ''))`
      ),
  },
  (table) => [
    uniqueIndex("agent_model_run_events_run_seq_idx").on(
      table.runId,
      table.seq
    ),
    index("agent_model_run_events_search_idx").using("gin", table.search),
    check(
      "agent_model_run_events_kind_check",
      sql`${table.kind} in ('llm_call', 'tool_call', 'tool_result', 'reasoning', 'message', 'decision', 'status', 'flag') and (${table.kind} <> 'flag' or ${table.title} ~ '^[a-z][a-z0-9_-]{0,39}$')`
    ),
    check(
      "agent_model_run_events_text_check",
      sql`char_length(trim(${table.agent})) between 1 and 100 and char_length(trim(${table.title})) between 1 and 300 and (${table.body} is null or char_length(${table.body}) <= 16000) and (${table.model} is null or char_length(trim(${table.model})) between 1 and 200) and (${table.toolName} is null or char_length(trim(${table.toolName})) between 1 and 100)`
    ),
    check(
      "agent_model_run_events_numbers_check",
      sql`${table.seq} >= 0 and (${table.inputTokens} is null or ${table.inputTokens} >= 0) and (${table.outputTokens} is null or ${table.outputTokens} >= 0) and (${table.costUsd} is null or (${table.costUsd} >= 0 and ${table.costUsd} <= 1000000)) and (${table.durationMs} is null or ${table.durationMs} >= 0)`
    ),
  ]
);

export type AgentModelRunEvent = typeof agentModelRunEvents.$inferSelect;

// Optimizer runs recorded by agents against a ledger task: services/research/backtesting/optimizer.py
// OptimizationResult.to_dict() mapped to camelCase by the reporting agent (see the agentOps.optimizations
// contract). Values are agent-reported. Parameter importance and score profiles are derived at read
// time and never stored. Rows carry no owner.
export const OPTIMIZATION_METHODS = [
  "grid",
  "random",
  "tpe",
  "evolution",
  "pareto",
  "market_only",
] as const;
export const OPTIMIZATION_VALIDATION_MODES = [
  "single",
  "is_oos",
  "walk_forward",
] as const;
export const OPTIMIZATION_STOP_REASONS = [
  "completed",
  "budget",
  "time_budget",
  "exhausted",
] as const;
export const OPTIMIZATION_DIRECTIONS = ["maximize", "minimize"] as const;
export type OptimizationMethod = (typeof OPTIMIZATION_METHODS)[number];
export type OptimizationValidationMode =
  (typeof OPTIMIZATION_VALIDATION_MODES)[number];
export type OptimizationStopReason = (typeof OPTIMIZATION_STOP_REASONS)[number];
export type OptimizationDirection = (typeof OPTIMIZATION_DIRECTIONS)[number];
export type OptimizationParamValue = number | boolean | string | null;
export type OptimizationParams = Record<string, OptimizationParamValue>;
export type OptimizationMetricMap = Record<string, number>;
export interface OptimizationObjective {
  metric: string;
  direction: OptimizationDirection;
}
// Half-open bar range [start, end) over the agent's data.
export interface OptimizationWindow {
  start: number;
  end: number;
}
export interface OptimizationValidationParams {
  nObservations?: number;
  isFraction?: number;
  trainLength?: number;
  testLength?: number;
  step?: number;
  anchored?: boolean;
  topK?: number;
}
export interface OptimizationValidation {
  mode: OptimizationValidationMode;
  params: OptimizationValidationParams;
}
export interface OptimizationBest {
  trialIndex: number | null;
  params: OptimizationParams;
  score: number | null;
  metrics: OptimizationMetricMap;
}
export type OptimizationTrialStatus = "ok" | "failed";
export interface OptimizationTrial {
  index: number;
  params: OptimizationParams;
  score: number | null;
  status: OptimizationTrialStatus;
  metrics?: OptimizationMetricMap;
  fold?: number;
  reason?: string;
}
export interface OptimizationParetoPoint {
  trialIndex: number;
  params: OptimizationParams;
  values: OptimizationMetricMap;
}
export interface OptimizationOosReport {
  trialIndex: number;
  params: OptimizationParams;
  inSampleScore: number | null;
  score: number | null;
  degradation: number | null;
  status: OptimizationTrialStatus;
  reason?: string;
  window?: OptimizationWindow;
}
export interface OptimizationDeflatedSharpe {
  sharpe: number;
  nTrials: number;
  sharpeVariance: number;
  nObservations: number;
  skew: number;
  kurtosis: number;
  expectedMaxSharpe: number;
  z: number;
  probability: number;
}
export interface OptimizationPbo {
  pbo: number;
  nTrials: number;
  nPeriodsUsed: number;
  nPartitions: number;
  nCombinations: number;
  metric: "sharpe" | "mean";
}
export interface OptimizationDiagnostics {
  deflatedSharpe: OptimizationDeflatedSharpe | null;
  deflatedSharpeReason: string | null;
  pbo: OptimizationPbo | null;
  pboReason: string | null;
}
export interface OptimizationFold {
  index: number;
  train: OptimizationWindow;
  test: OptimizationWindow;
  seed?: number;
  stopReason: OptimizationStopReason;
  trialCount: number;
  bestTrialIndex: number | null;
  params: OptimizationParams | null;
  oos: OptimizationOosReport | null;
  diagnostics?: OptimizationDiagnostics;
}
export interface OptimizationOos {
  mode: "is_oos" | "walk_forward";
  inSample?: OptimizationWindow;
  outOfSample?: OptimizationWindow;
  selected?: OptimizationOosReport | null;
  topK?: OptimizationOosReport[];
  stitchedScore?: number | null;
  stitchedMetrics?: Record<string, OptimizationMetricMap>;
  droppedMarkets?: string[];
  reason?: string | null;
}
export interface OptimizationMarketRank {
  rank: number | null;
  market: string;
  status: OptimizationTrialStatus;
  value: number | null;
  reason?: string;
}

export const optimizationRuns = pgTable(
  "optimization_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    strategyId: text("strategy_id").references(() => strategies.id, {
      onDelete: "set null",
    }),
    method: text("method").$type<OptimizationMethod>().notNull(),
    objectives: jsonb("objectives").$type<OptimizationObjective[]>().notNull(),
    validation: jsonb("validation").$type<OptimizationValidation>().notNull(),
    markets: jsonb("markets").$type<string[]>().notNull(),
    seed: bigint("seed", { mode: "number" }),
    trialCount: integer("trial_count").notNull(),
    stopReason: text("stop_reason").$type<OptimizationStopReason>().notNull(),
    best: jsonb("best").$type<OptimizationBest>(),
    paretoFront: jsonb("pareto_front")
      .$type<OptimizationParetoPoint[]>()
      .default([])
      .notNull(),
    trials: jsonb("trials").$type<OptimizationTrial[]>().default([]).notNull(),
    folds: jsonb("folds").$type<OptimizationFold[]>().default([]).notNull(),
    marketRanking: jsonb("market_ranking")
      .$type<OptimizationMarketRank[]>()
      .default([])
      .notNull(),
    oos: jsonb("oos").$type<OptimizationOos>(),
    diagnostics: jsonb("diagnostics").$type<OptimizationDiagnostics>(),
    notes: text("notes"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("optimization_runs_created_idx").on(table.createdAt.desc()),
    index("optimization_runs_task_idx").on(
      table.taskId,
      table.createdAt.desc()
    ),
    index("optimization_runs_strategy_idx").on(
      table.strategyId,
      table.createdAt.desc()
    ),
    check(
      "optimization_runs_enum_check",
      sql`${table.method} in ('grid', 'random', 'tpe', 'evolution', 'pareto', 'market_only') and ${table.stopReason} in ('completed', 'budget', 'time_budget', 'exhausted')`
    ),
    check(
      "optimization_runs_text_check",
      sql`${table.notes} is null or char_length(${table.notes}) <= 4000`
    ),
    check(
      "optimization_runs_json_check",
      sql`jsonb_typeof(${table.objectives}) = 'array' and jsonb_array_length(${table.objectives}) between 1 and 8 and octet_length(${table.objectives}::text) <= 4096 and jsonb_typeof(${table.validation}) = 'object' and ${table.validation}->>'mode' in ('single', 'is_oos', 'walk_forward') and octet_length(${table.validation}::text) <= 4096 and jsonb_typeof(${table.markets}) = 'array' and jsonb_array_length(${table.markets}) between 1 and 40 and octet_length(${table.markets}::text) <= 8192 and (${table.best} is null or (jsonb_typeof(${table.best}) = 'object' and octet_length(${table.best}::text) <= 32768)) and jsonb_typeof(${table.paretoFront}) = 'array' and jsonb_array_length(${table.paretoFront}) <= 500 and octet_length(${table.paretoFront}::text) <= 2097152 and jsonb_typeof(${table.folds}) = 'array' and jsonb_array_length(${table.folds}) <= 100 and octet_length(${table.folds}::text) <= 4194304 and jsonb_typeof(${table.marketRanking}) = 'array' and jsonb_array_length(${table.marketRanking}) <= 40 and octet_length(${table.marketRanking}::text) <= 131072 and (${table.oos} is null or (jsonb_typeof(${table.oos}) = 'object' and octet_length(${table.oos}::text) <= 1048576)) and (${table.diagnostics} is null or (jsonb_typeof(${table.diagnostics}) = 'object' and octet_length(${table.diagnostics}::text) <= 32768))`
    ),
    check(
      "optimization_runs_trials_check",
      sql`jsonb_typeof(${table.trials}) = 'array' and jsonb_array_length(${table.trials}) <= 5000 and octet_length(${table.trials}::text) <= 16777216 and ${table.trialCount} between 0 and 1000000 and ${table.trialCount} >= jsonb_array_length(${table.trials})`
    ),
  ]
);

// Operator paper-deployment requests: records only. Nothing reads these rows to start, route or
// submit anything; there is no transport to the Quant VPS execution owner or a broker. mode is
// fixed to paper. An approval records a human decision and never authorizes execution.
export const DEPLOYMENT_REQUEST_STATUSES = [
  "draft",
  "requested",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export const DEPLOYMENT_REQUEST_MODES = ["paper"] as const;
export type DeploymentRequestStatus =
  (typeof DEPLOYMENT_REQUEST_STATUSES)[number];
export type DeploymentRequestMode = (typeof DEPLOYMENT_REQUEST_MODES)[number];
export interface DeploymentRequestLimits {
  maxOrderSize: number;
  maxPosition: number;
  maxOrdersPerMinute: number;
  dailyLossLimit: number;
}

export const deploymentRequests = pgTable(
  "deployment_requests",
  {
    id: text("id").primaryKey(),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "restrict" }),
    presetId: text("preset_id").references(() => strategyPresets.id, {
      onDelete: "set null",
    }),
    params: jsonb("params").$type<StrategyPresetValues>().default({}).notNull(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    mode: text("mode")
      .$type<DeploymentRequestMode>()
      .default("paper")
      .notNull(),
    limits: jsonb("limits").$type<DeploymentRequestLimits>().notNull(),
    status: text("status")
      .$type<DeploymentRequestStatus>()
      .default("draft")
      .notNull(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    requestedAt: utcTimestamp("requested_at"),
    decidedBy: text("decided_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    decidedAt: utcTimestamp("decided_at"),
    decisionNote: text("decision_note"),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("deployment_requests_created_idx").on(table.createdAt.desc()),
    index("deployment_requests_status_idx").on(
      table.status,
      table.createdAt.desc()
    ),
    index("deployment_requests_strategy_idx").on(
      table.strategyId,
      table.createdAt.desc()
    ),
    check("deployment_requests_mode_check", sql`${table.mode} = 'paper'`),
    check(
      "deployment_requests_status_check",
      sql`${table.status} in ('draft', 'requested', 'approved', 'rejected', 'withdrawn')`
    ),
    check(
      "deployment_requests_text_check",
      sql`${table.symbol} ~ '^[A-Z0-9][A-Z0-9._/:-]{0,31}$' and ${table.timeframe} ~ '^[1-9][0-9]{0,2}(s|m|h|d|w)$' and (${table.decisionNote} is null or char_length(trim(${table.decisionNote})) between 1 and 1000)`
    ),
    check(
      "deployment_requests_params_check",
      sql`jsonb_typeof(${table.params}) = 'object' and octet_length(${table.params}::text) <= 16384`
    ),
    check(
      "deployment_requests_limits_check",
      sql`jsonb_typeof(${table.limits}) = 'object' and ${table.limits} ?& array['maxOrderSize', 'maxPosition', 'maxOrdersPerMinute', 'dailyLossLimit'] and ${table.limits} - array['maxOrderSize', 'maxPosition', 'maxOrdersPerMinute', 'dailyLossLimit'] = '{}'::jsonb and (case when jsonb_typeof(${table.limits}->'maxOrderSize') = 'number' and jsonb_typeof(${table.limits}->'maxPosition') = 'number' and jsonb_typeof(${table.limits}->'maxOrdersPerMinute') = 'number' and jsonb_typeof(${table.limits}->'dailyLossLimit') = 'number' then (${table.limits}->>'maxOrderSize')::numeric > 0 and (${table.limits}->>'maxPosition')::numeric > 0 and (${table.limits}->>'maxOrderSize')::numeric <= (${table.limits}->>'maxPosition')::numeric and (${table.limits}->>'maxOrdersPerMinute')::numeric between 1 and 1000 and (${table.limits}->>'maxOrdersPerMinute')::numeric = trunc((${table.limits}->>'maxOrdersPerMinute')::numeric) and (${table.limits}->>'dailyLossLimit')::numeric > 0 else false end)`
    ),
    check(
      "deployment_requests_lifecycle_check",
      sql`((${table.status} = 'draft' and ${table.requestedAt} is null) or (${table.status} in ('requested', 'approved', 'rejected') and ${table.requestedAt} is not null) or ${table.status} = 'withdrawn') and ((${table.decidedBy} is null) = (${table.decidedAt} is null)) and (${table.status} not in ('approved', 'rejected') or ${table.decidedAt} is not null) and (${table.status} not in ('draft', 'requested') or ${table.decidedAt} is null) and (${table.decisionNote} is null or ${table.decidedAt} is not null) and (${table.status} <> 'rejected' or ${table.decisionNote} is not null)`
    ),
  ]
);

// Operator research assistant (portal /assistant). Threads belong to one user; messages keep the
// text, a tool-call trace summary (tool name, short argument summary, ok/error, duration) and token
// usage. assistant_usage is the per-user, per-UTC-day model budget ledger: requests counts model
// calls, admitted atomically before each call. Nothing here authorizes trading or deployment.
export const ASSISTANT_MESSAGE_ROLES = ["user", "assistant"] as const;
export const ASSISTANT_MODES = ["plan", "act"] as const;
export type AssistantMessageRole = (typeof ASSISTANT_MESSAGE_ROLES)[number];
export type AssistantMode = (typeof ASSISTANT_MODES)[number];
export interface AssistantToolTraceEntry {
  tool: string;
  args: string;
  ok: boolean;
  error: string | null;
  durationMs: number;
  // A chart tool's display artifact (drawings, a script, a teach walkthrough), validated by the
  // api contract on read; the runtime caps artifact bytes per turn so the row stays under its check.
  artifact?: Record<string, unknown>;
}

export const assistantThreads = pgTable(
  "assistant_threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("assistant_threads_user_idx").on(
      table.userId,
      table.updatedAt.desc()
    ),
    check(
      "assistant_threads_title_check",
      sql`char_length(trim(${table.title})) between 1 and 120`
    ),
  ]
);

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => assistantThreads.id, { onDelete: "cascade" }),
    role: text("role").$type<AssistantMessageRole>().notNull(),
    mode: text("mode").$type<AssistantMode>().notNull(),
    content: text("content").notNull(),
    toolCalls: jsonb("tool_calls")
      .$type<AssistantToolTraceEntry[]>()
      .default([])
      .notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("assistant_messages_thread_idx").on(table.threadId, table.createdAt),
    check(
      "assistant_messages_role_check",
      sql`${table.role} in ('user', 'assistant')`
    ),
    check(
      "assistant_messages_mode_check",
      sql`${table.mode} in ('plan', 'act')`
    ),
    check(
      "assistant_messages_content_check",
      sql`char_length(${table.content}) <= 32000 and (${table.role} = 'assistant' or char_length(trim(${table.content})) >= 1)`
    ),
    check(
      "assistant_messages_tool_calls_check",
      sql`jsonb_typeof(${table.toolCalls}) = 'array' and jsonb_array_length(${table.toolCalls}) <= 64 and octet_length(${table.toolCalls}::text) <= 65536`
    ),
    check(
      "assistant_messages_tokens_check",
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0`
    ),
  ]
);

export const assistantUsage = pgTable(
  "assistant_usage",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    requests: integer("requests").default(0).notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "assistant_usage_pk",
      columns: [table.userId, table.day],
    }),
    check(
      "assistant_usage_counts_check",
      sql`${table.requests} >= 0 and ${table.inputTokens} >= 0 and ${table.outputTokens} >= 0`
    ),
  ]
);

export const contactRateLimits = pgTable(
  "contact_rate_limits",
  {
    keyHash: text("key_hash").primaryKey(),
    windowStartedAt: utcTimestampMs("window_started_at").notNull(),
    requestCount: integer("request_count").notNull(),
    expiresAt: utcTimestampMs("expires_at").notNull(),
  },
  (table) => [
    index("contact_rate_limits_expires_at_idx").on(table.expiresAt),
    check(
      "contact_rate_limits_key_hash_check",
      sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "contact_rate_limits_request_count_check",
      sql`${table.requestCount} between 1 and 1000`
    ),
    check(
      "contact_rate_limits_window_check",
      sql`${table.expiresAt} > ${table.windowStartedAt}`
    ),
  ]
);

// UI click log (card vertex-click-log): one row per recorded portal click or form submit, for
// debugging what a user did before a problem. Rows are redacted before insert (no typed text,
// field values, tokens or numbers shown on screen) and deleted 14 days after receipt.
// Used by: packages/db/src/server/click-log.ts. See: docs/vertex-rebuild/click-log.md.
export const uiClickEvents = pgTable(
  "ui_click_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Random id of one browser tab, so one tab's clicks read in order. */
    tabId: text("tab_id").notNull(),
    /** Browser time of the click. */
    occurredAt: utcTimestampMs("occurred_at").notNull(),
    /** Server time of the batch insert; retention uses this column. */
    receivedAt: utcTimestampMs("received_at").defaultNow().notNull(),
    kind: text("kind").notNull(),
    role: text("role").notNull(),
    label: text("label").notNull(),
    testId: text("test_id"),
    route: text("route").notNull(),
    targetRoute: text("target_route"),
    important: boolean("important").notNull(),
    /** Correlation ids of the oRPC calls an important click caused. */
    requestIds: text("request_ids").array().notNull(),
    /** Correlation id of the clickLog.record request that stored the row. */
    recordRequestId: text("record_request_id").notNull(),
    buildSha: text("build_sha").notNull(),
  },
  (table) => [
    index("ui_click_events_user_occurred_idx").on(
      table.userId,
      table.occurredAt
    ),
    index("ui_click_events_occurred_idx").on(table.occurredAt),
    index("ui_click_events_received_idx").on(table.receivedAt),
    check(
      "ui_click_events_kind_check",
      sql`${table.kind} in ('click', 'submit') and ${table.role} in ('button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch', 'summary', 'form')`
    ),
    check(
      "ui_click_events_text_check",
      sql`char_length(${table.label}) <= 80 and char_length(${table.route}) between 1 and 300 and (${table.testId} is null or char_length(${table.testId}) <= 80) and (${table.targetRoute} is null or char_length(${table.targetRoute}) <= 300) and cardinality(${table.requestIds}) <= 8`
    ),
  ]
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").$type<EventPayload>().notNull(),
    occurredAt: utcTimestamp("occurred_at").defaultNow().notNull(),
    publishedAt: utcTimestamp("published_at"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    handler: text("handler").default("default").notNull(),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    availableAt: utcTimestamp("available_at").defaultNow().notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: utcTimestamp("lease_expires_at"),
    fence: bigint("fence", { mode: "number" }).default(0).notNull(),
    lastError: text("last_error"),
    deadAt: utcTimestamp("dead_at"),
  },
  (table) => [
    index("outbox_events_unpublished_idx")
      .on(table.occurredAt)
      .where(sql`${table.publishedAt} is null`),
    index("outbox_events_aggregate_idx").on(
      table.aggregateType,
      table.aggregateId
    ),
    uniqueIndex("outbox_events_handler_idempotency_unique_idx")
      .on(table.handler, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("outbox_events_due_idx")
      .on(table.handler, table.availableAt, table.leaseExpiresAt, table.id)
      .where(sql`${table.publishedAt} is null and ${table.deadAt} is null`),
    index("outbox_events_lease_expiry_idx")
      .on(table.leaseExpiresAt)
      .where(
        sql`${table.publishedAt} is null and ${table.deadAt} is null and ${table.leaseExpiresAt} is not null`
      ),
    check(
      "outbox_events_payload_check",
      sql`jsonb_typeof(${table.payload}) = 'object' and octet_length(${table.payload}::text) <= 65536`
    ),
    check("outbox_events_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "outbox_events_handler_check",
      sql`length(trim(${table.handler})) > 0`
    ),
    check(
      "outbox_events_idempotency_key_check",
      sql`${table.idempotencyKey} is null or length(trim(${table.idempotencyKey})) > 0`
    ),
    check(
      "outbox_events_request_hash_check",
      sql`(${table.idempotencyKey} is null) = (${table.requestHash} is null) and (${table.requestHash} is null or ${table.requestHash} ~ '^[0-9a-f]{64}$')`
    ),
    check("outbox_events_fence_check", sql`${table.fence} >= 0`),
    check(
      "outbox_events_lease_check",
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAt} is null)`
    ),
    check(
      "outbox_events_last_error_check",
      sql`${table.lastError} is null or octet_length(${table.lastError}) <= 4096`
    ),
  ]
);

export const auditRecords = pgTable(
  "audit_records",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    metadata: jsonb("metadata").$type<AuditMetadata>().default({}).notNull(),
    requestId: text("request_id").notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_records_actor_user_id_idx").on(table.actorUserId),
    index("audit_records_entity_idx").on(table.entityType, table.entityId),
    index("audit_records_request_id_idx").on(table.requestId),
    check(
      "audit_records_metadata_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`
    ),
    check(
      "audit_records_request_id_check",
      sql`length(trim(${table.requestId})) > 0`
    ),
  ]
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type ApiKeyRecord = typeof apiKeys.$inferSelect;
export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;
export type FeatureItem = typeof featureItems.$inferSelect;
export type NewFeatureItem = typeof featureItems.$inferInsert;
export type WatchlistItem = typeof watchlistItems.$inferSelect;
export type NewWatchlistItem = typeof watchlistItems.$inferInsert;
export type Basket = typeof baskets.$inferSelect;
export type BasketMember = typeof basketMembers.$inferSelect;
export type PickList = typeof pickLists.$inferSelect;
export type PickListSnapshot = typeof pickListSnapshots.$inferSelect;
export type PickListMember = typeof pickListMembers.$inferSelect;
export type Play = typeof plays.$inferSelect;
export type NewPlay = typeof plays.$inferInsert;
export type ResearchPaper = typeof researchPapers.$inferSelect;
export type NewResearchPaper = typeof researchPapers.$inferInsert;
export type AgentTask = typeof agentTasks.$inferSelect;
export type NewAgentTask = typeof agentTasks.$inferInsert;
export type AgentTaskEvent = typeof agentTaskEvents.$inferSelect;
export type NewAgentTaskEvent = typeof agentTaskEvents.$inferInsert;
export type BacktestResult = typeof backtestResults.$inferSelect;
export type NewBacktestResult = typeof backtestResults.$inferInsert;
export type OptimizationRun = typeof optimizationRuns.$inferSelect;
export type NewOptimizationRun = typeof optimizationRuns.$inferInsert;
export type DeploymentRequest = typeof deploymentRequests.$inferSelect;
export type NewDeploymentRequest = typeof deploymentRequests.$inferInsert;
export type AssistantThread = typeof assistantThreads.$inferSelect;
export type AssistantMessage = typeof assistantMessages.$inferSelect;
export type AssistantUsage = typeof assistantUsage.$inferSelect;
export type Strategy = typeof strategies.$inferSelect;
export type NewStrategy = typeof strategies.$inferInsert;
export type StrategyPreset = typeof strategyPresets.$inferSelect;
export type NewStrategyPreset = typeof strategyPresets.$inferInsert;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type AuditRecord = typeof auditRecords.$inferSelect;
export type NewAuditRecord = typeof auditRecords.$inferInsert;
export type ContactRateLimit = typeof contactRateLimits.$inferSelect;
export type NewContactRateLimit = typeof contactRateLimits.$inferInsert;
export * from "../generated/schema-registry.ts";

// Stored OHLCV history for the instant backtest page. One series per symbol and timeframe, with
// the source file's SHA-256 for provenance. Bars are research input only; nothing here places orders.
export const MARKET_BAR_TIMEFRAMES = ["1d", "1m"] as const;
export type MarketBarTimeframe = (typeof MARKET_BAR_TIMEFRAMES)[number];

export const marketBarSeries = pgTable(
  "market_bar_series",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").$type<MarketBarTimeframe>().notNull(),
    source: text("source").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    barCount: integer("bar_count").notNull(),
    firstT: bigint("first_t", { mode: "number" }).notNull(),
    lastT: bigint("last_t", { mode: "number" }).notNull(),
    importedAt: utcTimestamp("imported_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("market_bar_series_symbol_timeframe_idx").on(
      table.symbol,
      table.timeframe
    ),
    check(
      "market_bar_series_text_check",
      sql`${table.symbol} ~ '^[A-Z0-9.^=-]{1,20}$' and ${table.timeframe} in ('1d', '1m') and char_length(trim(${table.source})) between 1 and 300 and ${table.sourceSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "market_bar_series_range_check",
      sql`${table.barCount} >= 2 and ${table.firstT} < ${table.lastT}`
    ),
  ]
);

export const marketBars = pgTable(
  "market_bars",
  {
    seriesId: text("series_id")
      .notNull()
      .references(() => marketBarSeries.id, { onDelete: "cascade" }),
    t: bigint("t", { mode: "number" }).notNull(),
    o: doublePrecision("o").notNull(),
    h: doublePrecision("h").notNull(),
    l: doublePrecision("l").notNull(),
    c: doublePrecision("c").notNull(),
    v: doublePrecision("v"),
  },
  (table) => [
    primaryKey({ columns: [table.seriesId, table.t] }),
    check(
      "market_bars_price_check",
      sql`${table.o} > 0 and ${table.h} > 0 and ${table.l} > 0 and ${table.c} > 0 and ${table.l} <= least(${table.o}, ${table.c}) and ${table.h} >= greatest(${table.o}, ${table.c}) and (${table.v} is null or ${table.v} >= 0)`
    ),
  ]
);

// Stored daily research series of the QuantConnect idea ports (ETFs, continuous futures,
// volatility and rate indices, and derived series such as EY_TNX_RATIO). One row per series with
// the source file's SHA-256 for provenance; points keep every row whose close is a finite number,
// with open, high, low and adj_close null where the source has no usable value. Research input
// only; nothing here places orders.
export const MARKET_DAILY_SERIES_KINDS = [
  "etf",
  "future",
  "index",
  "derived",
] as const;
export type MarketDailySeriesKind = (typeof MARKET_DAILY_SERIES_KINDS)[number];

export const marketDailySeries = pgTable(
  "market_daily_series",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<MarketDailySeriesKind>().notNull(),
    source: text("source").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    pointCount: integer("point_count").notNull(),
    firstDate: date("first_date", { mode: "string" }).notNull(),
    lastDate: date("last_date", { mode: "string" }).notNull(),
    importedAt: utcTimestamp("imported_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "market_daily_series_text_check",
      sql`${table.id} ~ '^[A-Z0-9._^=-]{1,20}$' and ${table.kind} in ('etf', 'future', 'index', 'derived') and char_length(trim(${table.source})) between 1 and 300 and ${table.sourceSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "market_daily_series_range_check",
      sql`${table.pointCount} >= 1 and ${table.firstDate} <= ${table.lastDate} and (${table.pointCount} > 1 or ${table.firstDate} = ${table.lastDate})`
    ),
  ]
);

export const marketDailyPoints = pgTable(
  "market_daily_points",
  {
    seriesId: text("series_id")
      .notNull()
      .references(() => marketDailySeries.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    open: doublePrecision("open"),
    high: doublePrecision("high"),
    low: doublePrecision("low"),
    close: doublePrecision("close").notNull(),
    adjClose: doublePrecision("adj_close"),
  },
  (table) => [
    primaryKey({ columns: [table.seriesId, table.date] }),
    // NaN sorts above Infinity in Postgres, so `< 'Infinity'` also refuses NaN.
    check(
      "market_daily_points_finite_check",
      sql`${table.close} > '-Infinity'::float8 and ${table.close} < 'Infinity'::float8 and (${table.open} is null or (${table.open} > '-Infinity'::float8 and ${table.open} < 'Infinity'::float8)) and (${table.high} is null or (${table.high} > '-Infinity'::float8 and ${table.high} < 'Infinity'::float8)) and (${table.low} is null or (${table.low} > '-Infinity'::float8 and ${table.low} < 'Infinity'::float8)) and (${table.adjClose} is null or (${table.adjClose} > '-Infinity'::float8 and ${table.adjClose} < 'Infinity'::float8))`
    ),
  ]
);

// Backtest runs started from the portal or MCP. A row is created queued, claimed once, then
// completed or failed. The spec and the strategy revision snapshot are written at submit time and
// never updated; only status, timing, error and report change. Research only; no order path.
export const BACKTEST_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
export type BacktestRunStatus = (typeof BACKTEST_RUN_STATUSES)[number];

export interface BacktestRunSpec {
  symbol: string;
  timeframe: MarketBarTimeframe;
  from: string;
  to: string;
  rule:
    | { kind: "smaCross"; fast: number; slow: number }
    | {
        kind: "breakout";
        entryLookback: number;
        exitLookback: number;
        trendSma: number;
      }
    | {
        kind: "dsl";
        /** Strategy definition (version 1), validated by the API contract. */
        definition: Record<string, unknown>;
      };
  stopLossPct: number;
  takeProfitPct: number;
  costBps: number;
  /** Resolved cost profile (shape owned by the API cost-profile contract); absent: none. */
  costProfile?: Record<string, unknown>;
  initialCapital: number;
  /**
   * Engine comparison (dual run): the feature, group and label of a Nautilus run that repeats a
   * TypeScript result, with that result (shape owned by the API engine-comparison contract).
   * Absent on ordinary runs.
   */
  comparison?: Record<string, unknown>;
}

export interface BacktestRunStrategySnapshot {
  id: string;
  slug: string;
  name: string;
  kind: string;
  sourceRef: string | null;
  params: unknown[];
  updatedAt: string;
}

export const backtestRuns = pgTable(
  "backtest_runs",
  {
    id: text("id").primaryKey(),
    status: text("status").$type<BacktestRunStatus>().notNull(),
    strategyId: text("strategy_id").references(() => strategies.id, {
      onDelete: "set null",
    }),
    strategyRevision: text("strategy_revision"),
    strategySnapshot:
      jsonb("strategy_snapshot").$type<BacktestRunStrategySnapshot>(),
    spec: jsonb("spec").$type<BacktestRunSpec>().notNull(),
    engineVersion: text("engine_version").notNull(),
    requestedBy: text("requested_by").notNull(),
    error: text("error"),
    report: jsonb("report").$type<Record<string, unknown>>(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    startedAt: utcTimestamp("started_at"),
    finishedAt: utcTimestamp("finished_at"),
  },
  (table) => [
    index("backtest_runs_created_idx").on(table.createdAt.desc()),
    index("backtest_runs_strategy_idx").on(
      table.strategyId,
      table.createdAt.desc()
    ),
    check(
      "backtest_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed')`
    ),
    check(
      "backtest_runs_revision_check",
      sql`(${table.strategyRevision} is null or ${table.strategyRevision} ~ '^[0-9a-f]{64}$') and (${table.strategyRevision} is null) = (${table.strategySnapshot} is null)`
    ),
    check(
      "backtest_runs_outcome_check",
      sql`(${table.status} <> 'succeeded' or ${table.report} is not null) and (${table.status} <> 'failed' or ${table.error} is not null)`
    ),
  ]
);

// Forward drift monitors: a paper (forward) equity series and its closed trades, pinned to one
// finished backtest run as the baseline. Each recording replaces the stored series (append only at
// the API) and the levels of the last evaluation; `version` guards concurrent recordings. Alerts
// are in-app rows raised when a check reaches warn or alert. Paper data only; no order path.
export const FORWARD_DRIFT_CHECKS = [
  "drawdown",
  "losingStreak",
  "profitFactor",
  "sharpe",
  "winRate",
] as const;
export type ForwardDriftCheck = (typeof FORWARD_DRIFT_CHECKS)[number];
export const FORWARD_DRIFT_LEVELS = [
  "ok",
  "warn",
  "alert",
  "insufficient",
] as const;
export type ForwardDriftLevel = (typeof FORWARD_DRIFT_LEVELS)[number];
export type ForwardDriftThresholds = Record<
  ForwardDriftCheck,
  { warn: number; alert: number }
>;
export interface ForwardDriftPoint {
  equity: number;
  t: number;
}
export type PaperRunnerStatus = "off" | "running";
export interface ForwardDriftTrade {
  pnl: number;
  t: number;
}
export type ForwardDriftLevels = Partial<
  Record<ForwardDriftCheck, ForwardDriftLevel>
>;

export const forwardDriftMonitors = pgTable(
  "forward_drift_monitors",
  {
    baselineRunId: text("baseline_run_id")
      .notNull()
      .references(() => backtestRuns.id, { onDelete: "restrict" }),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    level: text("level")
      .$type<ForwardDriftLevel>()
      .notNull()
      .default("insufficient"),
    levels: jsonb("levels")
      .$type<ForwardDriftLevels>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    points: jsonb("points")
      .$type<ForwardDriftPoint[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    paperNote: text("paper_note"),
    paperStatus: text("paper_status")
      .$type<PaperRunnerStatus>()
      .notNull()
      .default("off"),
    paperTickedAt: utcTimestamp("paper_ticked_at"),
    strategyRevision: text("strategy_revision"),
    thresholds: jsonb("thresholds").$type<ForwardDriftThresholds>().notNull(),
    trades: jsonb("trades")
      .$type<ForwardDriftTrade[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    index("forward_drift_monitors_created_idx").on(table.createdAt.desc()),
    index("forward_drift_monitors_baseline_idx").on(table.baselineRunId),
    check(
      "forward_drift_monitors_label_check",
      sql`char_length(${table.label}) between 1 and 120`
    ),
    check(
      "forward_drift_monitors_revision_check",
      sql`${table.strategyRevision} is null or ${table.strategyRevision} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "forward_drift_monitors_level_check",
      sql`${table.level} in ('ok', 'warn', 'alert', 'insufficient')`
    ),
    check("forward_drift_monitors_version_check", sql`${table.version} >= 0`),
    check(
      "forward_drift_monitors_paper_status_check",
      sql`${table.paperStatus} in ('off', 'running')`
    ),
    check(
      "forward_drift_monitors_paper_note_check",
      sql`${table.paperNote} is null or char_length(${table.paperNote}) between 1 and 500`
    ),
  ]
);

export const forwardDriftAlerts = pgTable(
  "forward_drift_alerts",
  {
    acknowledgedAt: utcTimestamp("acknowledged_at"),
    acknowledgedBy: text("acknowledged_by"),
    baselineValue: doublePrecision("baseline_value"),
    check: text("check_key").$type<ForwardDriftCheck>().notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    forwardValue: doublePrecision("forward_value"),
    id: text("id").primaryKey(),
    level: text("level").$type<"warn" | "alert">().notNull(),
    message: text("message").notNull(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => forwardDriftMonitors.id, { onDelete: "cascade" }),
    ratio: doublePrecision("ratio"),
  },
  (table) => [
    index("forward_drift_alerts_created_idx").on(table.createdAt.desc()),
    index("forward_drift_alerts_monitor_idx").on(
      table.monitorId,
      table.createdAt.desc()
    ),
    check(
      "forward_drift_alerts_check_check",
      sql`${table.check} in ('drawdown', 'losingStreak', 'profitFactor', 'sharpe', 'winRate')`
    ),
    check(
      "forward_drift_alerts_level_check",
      sql`${table.level} in ('warn', 'alert')`
    ),
    check(
      "forward_drift_alerts_message_check",
      sql`char_length(${table.message}) between 1 and 500`
    ),
    check(
      "forward_drift_alerts_ack_check",
      sql`(${table.acknowledgedAt} is null) = (${table.acknowledgedBy} is null)`
    ),
  ]
);

// Saved strategy definitions: append-only revisions of one declarative strategy definition (see
// packages/api/src/strategy-dsl.ts). Rows are never updated; a change is a new revision. Research
// and backtest input only; nothing here places orders.
export const strategyDefinitionRevisions = pgTable(
  "strategy_definition_revisions",
  {
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    definitionId: text("definition_id").notNull(),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    note: text("note"),
    revision: integer("revision").notNull(),
    sha256: text("sha256").notNull(),
  },
  (table) => [
    uniqueIndex("strategy_definition_revisions_revision_unique_idx").on(
      table.definitionId,
      table.revision
    ),
    index("strategy_definition_revisions_created_idx").on(
      table.createdAt.desc()
    ),
    check(
      "strategy_definition_revisions_revision_check",
      sql`${table.revision} between 1 and 1000000`
    ),
    check(
      "strategy_definition_revisions_sha_check",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "strategy_definition_revisions_text_check",
      sql`char_length(trim(${table.name})) between 1 and 120 and char_length(${table.definitionId}) between 1 and 128 and (${table.note} is null or char_length(${table.note}) <= 500)`
    ),
    check(
      "strategy_definition_revisions_definition_check",
      sql`jsonb_typeof(${table.definition}) = 'object' and octet_length(${table.definition}::text) <= 65536`
    ),
  ]
);

// Assistant actions waiting for the operator: a mutating research tool call proposed by the
// assistant is stored here as a confirm card and runs only after the operator approves it in the
// portal. Statuses: pending -> running -> executed | failed, or pending -> rejected.
export const ASSISTANT_ACTION_STATUSES = [
  "pending",
  "running",
  "executed",
  "failed",
  "rejected",
] as const;
export type AssistantActionStatus = (typeof ASSISTANT_ACTION_STATUSES)[number];

export const assistantActions = pgTable(
  "assistant_actions",
  {
    args: jsonb("args").$type<Record<string, unknown>>().notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    decidedAt: utcTimestamp("decided_at"),
    error: text("error"),
    finishedAt: utcTimestamp("finished_at"),
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => assistantMessages.id, { onDelete: "cascade" }),
    result: text("result"),
    status: text("status")
      .$type<AssistantActionStatus>()
      .default("pending")
      .notNull(),
    summary: text("summary").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => assistantThreads.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("assistant_actions_thread_idx").on(table.threadId, table.createdAt),
    check(
      "assistant_actions_status_check",
      sql`${table.status} in ('pending', 'running', 'executed', 'failed', 'rejected')`
    ),
    check(
      "assistant_actions_tool_check",
      sql`${table.tool} ~ '^[a-z][a-z0-9_]{0,63}$'`
    ),
    check(
      "assistant_actions_text_check",
      sql`char_length(${table.summary}) between 1 and 500 and (${table.result} is null or char_length(${table.result}) <= 16000) and (${table.error} is null or char_length(${table.error}) between 1 and 500)`
    ),
    check(
      "assistant_actions_args_check",
      sql`jsonb_typeof(${table.args}) = 'object' and octet_length(${table.args}::text) <= 65536`
    ),
    check(
      "assistant_actions_decided_check",
      sql`(${table.status} = 'pending') = (${table.decidedAt} is null)`
    ),
  ]
);

export type StrategyDefinitionRevisionRow =
  typeof strategyDefinitionRevisions.$inferSelect;
export type AssistantAction = typeof assistantActions.$inferSelect;

// Private per-user to-do list for the owner (portal /todos and the agent API).
// Plain notes only: no orders, intents or trading linkage.
export const TODO_STATUSES = ["open", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
export const TODO_TITLE_MAX_LENGTH = 200;
export const TODO_NOTE_MAX_LENGTH = 2000;
export const TODO_MAX_TAGS = 10;
export const TODO_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const todos = pgTable(
  "todos",
  {
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    dueDate: date("due_date", { mode: "string" }),
    id: text("id").primaryKey(),
    note: text("note"),
    sourceUrl: text("source_url"),
    status: text("status").$type<TodoStatus>().default("open").notNull(),
    tags: text("tags").array().default(sql`'{}'::text[]`).notNull(),
    title: text("title").notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("todos_user_status_due_idx").on(
      table.userId,
      table.status,
      table.dueDate
    ),
    check(
      "todos_text_check",
      sql`char_length(trim(${table.title})) between 1 and 200 and (${table.note} is null or char_length(${table.note}) <= 2000) and ${table.status} in ('open', 'done') and cardinality(${table.tags}) <= 10 and (${table.sourceUrl} is null or (char_length(${table.sourceUrl}) <= 2000 and ${table.sourceUrl} ~ '^https?://'))`
    ),
  ]
);

export type Todo = typeof todos.$inferSelect;

// Autopilot campaigns (research only): a campaign breeds strategy-definition candidates for one
// stored bar series under CPU and candidate budgets. Status lifecycle (guarded in the repository):
// running <-> stopped, running -> completed (budget used) | failed. completed and failed are final.
// Nothing here creates orders; a paper deployment request is a separate operator action.
export const AUTOPILOT_CAMPAIGN_STATUSES = [
  "running",
  "stopped",
  "completed",
  "failed",
] as const;
export type AutopilotCampaignStatus =
  (typeof AUTOPILOT_CAMPAIGN_STATUSES)[number];

export const autopilotCampaigns = pgTable(
  "autopilot_campaigns",
  {
    bestCandidateId: text("best_candidate_id"),
    bestFitness: doublePrecision("best_fitness"),
    candidateCount: integer("candidate_count").notNull().default(0),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    cpuMs: bigint("cpu_ms", { mode: "number" }).notNull().default(0),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    finishedAt: utcTimestamp("finished_at"),
    gatedCount: integer("gated_count").notNull().default(0),
    generation: integer("generation").notNull().default(0),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    note: text("note"),
    startedAt: utcTimestamp("started_at"),
    status: text("status").$type<AutopilotCampaignStatus>().notNull(),
    symbol: text("symbol").notNull(),
    tickedAt: utcTimestamp("ticked_at"),
    timeframe: text("timeframe").notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
    verifiedCount: integer("verified_count").notNull().default(0),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    index("autopilot_campaigns_due_idx").on(table.status, table.tickedAt),
    index("autopilot_campaigns_created_idx").on(table.createdAt.desc()),
    check(
      "autopilot_campaigns_status_check",
      sql`${table.status} in ('running', 'stopped', 'completed', 'failed')`
    ),
    check(
      "autopilot_campaigns_counts_check",
      sql`${table.generation} >= 0 and ${table.candidateCount} >= 0 and ${table.gatedCount} >= 0 and ${table.verifiedCount} >= 0 and ${table.cpuMs} >= 0 and ${table.version} >= 0`
    ),
    check(
      "autopilot_campaigns_text_check",
      sql`char_length(trim(${table.name})) between 1 and 120 and char_length(${table.symbol}) between 1 and 64 and char_length(${table.timeframe}) between 1 and 16 and (${table.note} is null or char_length(${table.note}) between 1 and 500)`
    ),
    check(
      "autopilot_campaigns_config_check",
      sql`jsonb_typeof(${table.config}) = 'object' and octet_length(${table.config}::text) <= 8192`
    ),
  ]
);

export const AUTOPILOT_CANDIDATE_STATUSES = [
  "evaluated",
  "rejected",
  "verified",
] as const;
export type AutopilotCandidateStatus =
  (typeof AUTOPILOT_CANDIDATE_STATUSES)[number];
export const AUTOPILOT_CANDIDATE_ORIGINS = [
  "random",
  "crossover",
  "mutation",
  "neighbour",
] as const;
export type AutopilotCandidateOrigin =
  (typeof AUTOPILOT_CANDIDATE_ORIGINS)[number];

// One candidate = one trial. Every row counts in the multiple-testing ledger of its series
// (symbol/timeframe), across campaigns. The in-sample return summary feeds the deflated Sharpe ratio.
export const autopilotCandidates = pgTable(
  "autopilot_candidates",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => autopilotCampaigns.id, { onDelete: "restrict" }),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    deploymentRequestId: text("deployment_request_id"),
    firstT: utcTimestamp("first_t").notNull(),
    fitness: doublePrecision("fitness"),
    gate: jsonb("gate").$type<Record<string, unknown>>(),
    gatedAt: utcTimestamp("gated_at"),
    generation: integer("generation").notNull(),
    genome: jsonb("genome").$type<Record<string, unknown>>().notNull(),
    genomeKey: text("genome_key").notNull(),
    id: text("id").primaryKey(),
    inSample: jsonb("in_sample").$type<Record<string, unknown>>().notNull(),
    label: text("label").notNull(),
    lastT: utcTimestamp("last_t").notNull(),
    oosSharpe: doublePrecision("oos_sharpe"),
    origin: text("origin").$type<AutopilotCandidateOrigin>().notNull(),
    parentIds: jsonb("parent_ids").$type<string[]>().notNull(),
    returnsCount: integer("returns_count").notNull(),
    returnsMean: doublePrecision("returns_mean").notNull(),
    returnsStd: doublePrecision("returns_std").notNull(),
    series: text("series").notNull(),
    status: text("status")
      .$type<AutopilotCandidateStatus>()
      .notNull()
      .default("evaluated"),
    strategyId: text("strategy_id"),
  },
  (table) => [
    uniqueIndex("autopilot_candidates_genome_unique_idx").on(
      table.campaignId,
      table.genomeKey
    ),
    index("autopilot_candidates_fitness_idx").on(
      table.campaignId,
      table.fitness.desc().nullsLast()
    ),
    index("autopilot_candidates_series_idx").on(
      table.series,
      table.createdAt.desc()
    ),
    check(
      "autopilot_candidates_status_check",
      sql`${table.status} in ('evaluated', 'rejected', 'verified')`
    ),
    check(
      "autopilot_candidates_origin_check",
      sql`${table.origin} in ('random', 'crossover', 'mutation', 'neighbour')`
    ),
    check(
      "autopilot_candidates_gate_check",
      sql`(${table.status} = 'evaluated') = (${table.gatedAt} is null) and (${table.gate} is null or (jsonb_typeof(${table.gate}) = 'object' and octet_length(${table.gate}::text) <= 65536))`
    ),
    check(
      "autopilot_candidates_json_check",
      sql`jsonb_typeof(${table.genome}) = 'object' and jsonb_typeof(${table.definition}) = 'object' and jsonb_typeof(${table.inSample}) = 'object' and jsonb_typeof(${table.parentIds}) = 'array' and octet_length(${table.definition}::text) <= 65536`
    ),
    check(
      "autopilot_candidates_text_check",
      sql`char_length(${table.label}) between 1 and 500 and char_length(${table.genomeKey}) between 2 and 2000 and char_length(${table.series}) between 3 and 81 and ${table.generation} >= 0 and ${table.returnsCount} >= 0`
    ),
    check(
      "autopilot_candidates_handoff_check",
      sql`(${table.deploymentRequestId} is null or (${table.status} = 'verified' and ${table.strategyId} is not null))`
    ),
  ]
);
// Owner price alerts (priceAlerts.*): one symbol from the owner's watchlist, an at-or-above or
// at-or-below level, and a state. An active rule has no trigger fields; a triggered rule has all
// of them. Research only: nothing here places orders.
export type PriceAlertKindValue = "above" | "below";
export type PriceAlertRoleValue = "price" | "stop" | "target";
export type PriceAlertStatusValue = "active" | "triggered";
export type PriceAlertDeliveryValue =
  | "pending"
  | "sent"
  | "not-configured"
  | "failed";

export const priceAlertRules = pgTable(
  "price_alert_rules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    kind: text("kind").$type<PriceAlertKindValue>().notNull(),
    role: text("role").$type<PriceAlertRoleValue>().notNull(),
    level: numeric("level").notNull(),
    note: text("note"),
    status: text("status")
      .$type<PriceAlertStatusValue>()
      .default("active")
      .notNull(),
    lastCheckedAt: utcTimestamp("last_checked_at"),
    triggeredAt: utcTimestamp("triggered_at"),
    triggerPrice: numeric("trigger_price"),
    delivery: text("delivery").$type<PriceAlertDeliveryValue>(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("price_alert_rules_user_created_idx").on(
      table.userId,
      table.createdAt
    ),
    index("price_alert_rules_status_updated_idx").on(
      table.status,
      table.updatedAt
    ),
    check(
      "price_alert_rules_fields_check",
      sql`${table.symbol} ~ '^[A-Z][A-Z0-9.\\-]{0,9}$' and ${table.kind} in ('above', 'below') and ${table.role} in ('price', 'stop', 'target') and ${table.level} > 0 and (${table.note} is null or char_length(${table.note}) <= 200)`
    ),
    check(
      "price_alert_rules_state_check",
      sql`(${table.status} = 'active' and ${table.triggeredAt} is null and ${table.triggerPrice} is null and ${table.delivery} is null) or (${table.status} = 'triggered' and ${table.triggeredAt} is not null and ${table.triggerPrice} > 0 and ${table.delivery} in ('pending', 'sent', 'not-configured', 'failed'))`
    ),
  ]
);

export type PriceAlertRuleRow = typeof priceAlertRules.$inferSelect;

// Owner signal alerts and watches (priceAlerts.signals.*, LuxAlgo P4). The condition is a JSON
// document validated by the oRPC contract (two lines and an operator); the evaluator lives in
// packages/api. A watch starts "proposed" (from Quant) and runs only after the owner starts it.
// Each fire is one signal_alert_events row, insert-once by (rule, bar). Research only: no orders.
export type SignalAlertKindValue = "alert" | "watch";
export type SignalAlertOriginValue = "manual" | "strategy" | "quant";
export type SignalAlertStatusValue =
  | "proposed"
  | "active"
  | "done"
  | "dismissed";
export type SignalAlertFrequencyValue = "once" | "per-bar" | "per-bar-close";
export type SignalAlertTimeframeValue = "5m" | "15m" | "1h" | "1d";
export type SignalAlertDeliveryValue =
  | "pending"
  | "sent"
  | "not-configured"
  | "failed";

export const signalAlertRules = pgTable(
  "signal_alert_rules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<SignalAlertKindValue>().notNull(),
    origin: text("origin").$type<SignalAlertOriginValue>().notNull(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").$type<SignalAlertTimeframeValue>().notNull(),
    condition: jsonb("condition").$type<Record<string, unknown>>().notNull(),
    frequency: text("frequency").$type<SignalAlertFrequencyValue>().notNull(),
    status: text("status").$type<SignalAlertStatusValue>().notNull(),
    /** When the rule became active: created active, or a proposed watch started. */
    activatedAt: utcTimestamp("activated_at"),
    lastCheckedAt: utcTimestamp("last_checked_at"),
    lastBarAt: utcTimestamp("last_bar_at"),
    lastFiredBarAt: utcTimestamp("last_fired_bar_at"),
    lastFiredAt: utcTimestamp("last_fired_at"),
    fireCount: integer("fire_count").default(0).notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("signal_alert_rules_user_created_idx").on(
      table.userId,
      table.createdAt
    ),
    index("signal_alert_rules_status_updated_idx").on(
      table.status,
      table.updatedAt
    ),
    check(
      "signal_alert_rules_fields_check",
      sql`${table.symbol} ~ '^[A-Z][A-Z0-9.\\-]{0,9}(=F)?$' and ${table.kind} in ('alert', 'watch') and ${table.origin} in ('manual', 'strategy', 'quant') and ${table.status} in ('proposed', 'active', 'done', 'dismissed') and ${table.frequency} in ('once', 'per-bar', 'per-bar-close') and ${table.timeframe} in ('5m', '15m', '1h', '1d') and char_length(${table.name}) between 1 and 120 and ${table.fireCount} >= 0`
    ),
  ]
);

export type SignalAlertRuleRow = typeof signalAlertRules.$inferSelect;

export const signalAlertEvents = pgTable(
  "signal_alert_events",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id")
      .notNull()
      .references(() => signalAlertRules.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    barAt: utcTimestamp("bar_at").notNull(),
    price: numeric("price").notNull(),
    delivery: text("delivery").$type<SignalAlertDeliveryValue>().notNull(),
    firedAt: utcTimestamp("fired_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("signal_alert_events_rule_bar_idx").on(
      table.ruleId,
      table.barAt
    ),
    index("signal_alert_events_user_fired_idx").on(table.userId, table.firedAt),
    check(
      "signal_alert_events_delivery_check",
      sql`${table.delivery} in ('pending', 'sent', 'not-configured', 'failed')`
    ),
  ]
);

export type SignalAlertEventRow = typeof signalAlertEvents.$inferSelect;

// Sector rotation map (sectorRotation.*): ratio and momentum of each stored sector against its
// benchmark, recomputed and upserted by (timeframe, symbol, date). Alerts are insert-once by
// (symbol, quadrant, entered_on), so a rerun never sends the same alert twice. Research only.
export type SectorRotationTimeframeValue = "daily" | "weekly";
export type SectorRotationQuadrantValue =
  | "leading"
  | "weakening"
  | "lagging"
  | "improving";
export type SectorRotationAlertDeliveryValue =
  | "pending"
  | "sent"
  | "not-configured"
  | "failed";

export const sectorRotationPoints = pgTable(
  "sector_rotation_points",
  {
    timeframe: text("timeframe")
      .$type<SectorRotationTimeframeValue>()
      .notNull(),
    symbol: text("symbol").notNull(),
    benchmark: text("benchmark").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    ratio: doublePrecision("ratio").notNull(),
    momentum: doublePrecision("momentum").notNull(),
    quadrant: text("quadrant").$type<SectorRotationQuadrantValue>().notNull(),
    computedAt: utcTimestamp("computed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.timeframe, table.symbol, table.date] }),
    index("sector_rotation_points_timeframe_date_idx").on(
      table.timeframe,
      table.date
    ),
    check(
      "sector_rotation_points_fields_check",
      sql`${table.timeframe} in ('daily', 'weekly') and ${table.symbol} ~ '^[A-Z][A-Z0-9.\\-]{0,9}$' and ${table.benchmark} ~ '^[A-Z][A-Z0-9.\\-]{0,9}$' and ${table.quadrant} in ('leading', 'weakening', 'lagging', 'improving')`
    ),
    check(
      "sector_rotation_points_values_check",
      sql`${table.ratio} > 0 and ${table.ratio} < 'Infinity'::double precision and ${table.momentum} > 0 and ${table.momentum} < 'Infinity'::double precision`
    ),
  ]
);

export type SectorRotationPointRow = typeof sectorRotationPoints.$inferSelect;

export const sectorRotationAlerts = pgTable(
  "sector_rotation_alerts",
  {
    symbol: text("symbol").notNull(),
    quadrant: text("quadrant").$type<SectorRotationQuadrantValue>().notNull(),
    enteredOn: date("entered_on", { mode: "string" }).notNull(),
    line: text("line").notNull(),
    delivery: text("delivery")
      .$type<SectorRotationAlertDeliveryValue>()
      .default("pending")
      .notNull(),
    createdAt: utcTimestamp("created_at").defaultNow().notNull(),
    updatedAt: utcTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.quadrant, table.enteredOn] }),
    check(
      "sector_rotation_alerts_fields_check",
      sql`${table.symbol} ~ '^[A-Z][A-Z0-9.\\-]{0,9}$' and ${table.quadrant} in ('leading', 'weakening', 'lagging', 'improving') and char_length(${table.line}) between 1 and 300 and ${table.delivery} in ('pending', 'sent', 'not-configured', 'failed')`
    ),
  ]
);

export type SectorRotationAlertRow = typeof sectorRotationAlerts.$inferSelect;
