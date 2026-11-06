// What: UI lab fixtures for Data & Ops and Settings pages: audit projections, gateways, modules,
// the Demo Analyst account (profile, addresses, preferences, sessions) and a fictional user directory.
// Every value is deterministic and obviously fake. Never put real account data here.
// Used by: apps/web/src/lab/entries/data-settings.tsx.
import type {
  AccountProfileOutput,
  AddressOutput,
  AdminUserSummaryOutput,
  AdminUsersListOutput,
  PreferencesOutput,
} from "@darkfactory/api";
import {
  type BrokerRecoveryStatus,
  computeExecutionProjectionHash,
  type ExecutionProjection,
  type ModuleManifest,
  ModuleManifestSchema,
  type VertexGatewayBinding,
} from "@darkfactory/api/vertex";

import type { SecuritySessions } from "../../components/account/security-client.ts";
import type { ExperienceScope } from "../../features/experience/ports.ts";
import { LAB_ACCOUNT, labDaysAgo } from "./core.ts";

/** Nanosecond Vertex timestamp on a lab day, e.g. labStamp(2, "14:30:00"). */
const labStamp = (daysAgo: number, time: string): string =>
  `${labDaysAgo(daysAgo)}T${time}.000000000Z`;

const labDate = (daysAgo: number): Date =>
  new Date(`${labDaysAgo(daysAgo)}T12:00:00.000Z`);

export const LAB_SCOPE: ExperienceScope = {
  accountAlias: LAB_ACCOUNT.id,
  environment: "paper",
};

// --- Audit ------------------------------------------------------------------

type AuditDraft = Readonly<{
  symbolIntent: string;
  status: "filled" | "partially-filled" | "submitted" | "cancelled";
  quantity: string;
  filled: string;
  day: number;
  time: string;
}>;

const AUDIT_DRAFTS: readonly AuditDraft[] = [
  {
    day: 3,
    filled: "4",
    quantity: "4",
    status: "filled",
    symbolIntent: "spy-call-spread",
    time: "14:31:05",
  },
  {
    day: 2,
    filled: "2",
    quantity: "6",
    status: "partially-filled",
    symbolIntent: "qqq-put-spread",
    time: "15:02:44",
  },
  {
    day: 1,
    filled: "0",
    quantity: "2",
    status: "submitted",
    symbolIntent: "nvda-iron-condor",
    time: "16:45:10",
  },
  {
    day: 0,
    filled: "0",
    quantity: "3",
    status: "cancelled",
    symbolIntent: "gld-call-spread",
    time: "13:15:30",
  },
];

const PLACEHOLDER_HASH = "0".repeat(64);

const auditDraft = (
  draft: AuditDraft,
  index: number,
  previousEventHash: string | null
): ExecutionProjection => {
  const sequence = String(index + 1);
  const occurredAt = labStamp(draft.day, draft.time);
  return {
    projectionId: `demo-projection-${sequence}`,
    schemaVersion: "1.0.0",
    ...LAB_SCOPE,
    actorId: "demo-analyst",
    admissionId: `demo-admission-${sequence}`,
    authoritative: false,
    eventHash: PLACEHOLDER_HASH,
    expiresAt: labStamp(draft.day - 1, draft.time),
    idempotencyKey: `demo-key-${sequence}`,
    occurredAt,
    ownerEpoch: "1",
    policyVersion: "1.0.0",
    previousEventHash,
    receipt: {
      auditEventIds: [`demo-event-${sequence}`],
      brokerOrderRef: `demo-order-${sequence}`,
      environment: "paper",
      errorClass: null,
      filledQuantity: draft.filled,
      intentId: `demo-intent-${draft.symbolIntent}`,
      lastReconciledAt: occurredAt,
      observationOnly: true,
      remainingQuantity: String(Number(draft.quantity) - Number(draft.filled)),
      schemaVersion: "1.0.0",
      status: draft.status,
      submissionKey: `demo-submission-${sequence}`,
      totalQuantity: draft.quantity,
    },
    receivedAt: occurredAt,
    reservationAuthority: "native-owner-only",
    reviewedArtifactSha256: "d".repeat(64),
    sequence,
    sourceKind: "paper-simulation",
    strategyVersion: "demo-momentum-v1",
    streamId: "demo-stream-1",
  };
};

/** A hash-chained paper execution stream (the guard verifies every eventHash). */
export const labAuditProjections = async (): Promise<
  readonly ExecutionProjection[]
> => {
  const chain: ExecutionProjection[] = [];
  for (const [index, draft] of AUDIT_DRAFTS.entries()) {
    const value = auditDraft(draft, index, chain.at(-1)?.eventHash ?? null);
    chain.push({
      ...value,
      eventHash: await computeExecutionProjectionHash(value),
    });
  }
  return chain;
};

// --- Connections ------------------------------------------------------------

export const LAB_GATEWAYS: readonly VertexGatewayBinding[] = [
  {
    accountAlias: LAB_ACCOUNT.id,
    environment: "paper",
    gatewayId: "demo-gateway-paper",
  },
  {
    accountAlias: LAB_ACCOUNT.id,
    environment: "paper",
    gatewayId: "demo-gateway-backup",
  },
];

export const labGatewayStatus = (
  gateway: Readonly<{ gatewayId: string; environment: "paper" | "live" }>
): BrokerRecoveryStatus => ({
  brokerHandshake: "authenticated",
  environment: gateway.environment,
  gatewayId: gateway.gatewayId,
  infrastructure: "observed",
  lastHumanRequestId: "demo-request-1",
  observedAt: labStamp(0, "19:58:12"),
  reasonCodes: ["connectivity-observed"],
  recovery: "completed",
  schemaVersion: "1.0.0",
  statusId: `demo-status-${gateway.gatewayId}`,
  trading: "disabled",
});

// --- Modules ----------------------------------------------------------------

const moduleManifest = (
  moduleId: string,
  capability: "research" | "market-data-read" | "backtest" | "chart-render",
  lifecycleState: "active-read-only" | "shadow" | "candidate",
  runtime: "civet-cloudflare" | "python-external" | "rust-external",
  digit: string
): ModuleManifest =>
  ModuleManifestSchema.parse({
    artifactDigest: digit.repeat(64),
    capabilities: [capability],
    dataRequirements: [
      {
        entitlementPolicyId: "demo-policy-1",
        kind: "candles",
        maximumAgeMs: 60_000,
        pointInTimeRequired: true,
      },
    ],
    inputSchemaVersion: "1.0.0",
    lifecycleState,
    moduleId,
    outputSchemaVersion: "1.0.0",
    reasonCodes: ["demo-fixture"],
    riskPolicyVersion: "1.0.0",
    runtime,
    schemaVersion: "1.0.0",
    supportedInstruments: ["etf", "option"],
    version: "1.2.0",
  });

export const LAB_MODULES: readonly ModuleManifest[] = [
  moduleManifest(
    "demo-momentum-scanner",
    "research",
    "active-read-only",
    "civet-cloudflare",
    "a"
  ),
  moduleManifest(
    "demo-bars-reader",
    "market-data-read",
    "active-read-only",
    "rust-external",
    "b"
  ),
  moduleManifest(
    "demo-spread-backtester",
    "backtest",
    "shadow",
    "python-external",
    "c"
  ),
  moduleManifest(
    "demo-chart-renderer",
    "chart-render",
    "candidate",
    "civet-cloudflare",
    "e"
  ),
];

// --- Account ----------------------------------------------------------------

export const LAB_PROFILE: AccountProfileOutput = {
  identity: { email: "demo@example.test", emailVerified: true },
  profile: {
    avatarUrl: null,
    biography: "Fictional analyst used by the Vertex UI lab.",
    businessName: LAB_ACCOUNT.name,
    dateOfBirth: null,
    displayName: "Demo Analyst",
    firstName: "Demo",
    jobTitle: "Research analyst",
    lastName: "Analyst",
    locale: "en-US",
    phone: "+1 555 0100",
    timezone: "America/New_York",
    updatedAt: labDate(12),
  },
};

export const LAB_ADDRESSES: readonly AddressOutput[] = [
  {
    city: "Demo City",
    country: "US",
    createdAt: labDate(90),
    id: "demo-address-1",
    isPrimary: true,
    line1: "100 Example Avenue",
    line2: "Suite 200",
    postalCode: "10001",
    region: "NY",
    type: "work",
    updatedAt: labDate(30),
  },
  {
    city: "Fixture Falls",
    country: "US",
    createdAt: labDate(60),
    id: "demo-address-2",
    isPrimary: false,
    line1: "42 Sample Street",
    line2: null,
    postalCode: "07001",
    region: "NJ",
    type: "home",
    updatedAt: labDate(60),
  },
];

export const LAB_PREFERENCES: PreferencesOutput = {
  analyticsConsent: false,
  density: "default",
  emailNotifications: true,
  fontSize: "default",
  personalizationConsent: true,
  productUpdates: false,
  profileVisibility: "members",
  radius: "small",
  theme: "default-dark",
  updatedAt: labDate(5),
};

export const LAB_SESSIONS: SecuritySessions = {
  currentSessionId: "demo-session-1",
  sessions: [
    {
      createdAt: labDate(1),
      expiresAt: labDate(-6),
      id: "demo-session-1",
      isCurrent: true,
      updatedAt: labDate(0),
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) DemoBrowser/1.0",
    },
    {
      createdAt: labDate(4),
      expiresAt: labDate(-3),
      id: "demo-session-2",
      isCurrent: false,
      updatedAt: labDate(2),
      userAgent: "Mozilla/5.0 (Macintosh) DemoBrowser/1.0",
    },
  ],
};

// --- Administration ---------------------------------------------------------

const labUser = (
  index: number,
  name: string,
  role: "member" | "admin",
  status: "active" | "suspended" | "deactivated",
  jobTitle: string
): AdminUserSummaryOutput => ({
  createdAt: labDate(200 - index * 20),
  email: `${name.toLowerCase().replaceAll(" ", ".")}@example.test`,
  emailVerified: status === "active",
  id: `demo-user-${index}`,
  image: null,
  name,
  profile: {
    avatarUrl: null,
    businessName: LAB_ACCOUNT.name,
    displayName: name,
    jobTitle,
  },
  role,
  status,
});

export const LAB_USERS: AdminUsersListOutput = {
  items: [
    labUser(1, "Demo Analyst", "admin", "active", "Research analyst"),
    labUser(2, "Demo Trader", "member", "active", "Options trader"),
    labUser(3, "Demo Reviewer", "member", "active", "Risk reviewer"),
    labUser(4, "Demo Intern", "member", "suspended", "Summer intern"),
    labUser(5, "Demo Alumni", "member", "deactivated", "Former analyst"),
  ],
  nextCursor: null,
};
