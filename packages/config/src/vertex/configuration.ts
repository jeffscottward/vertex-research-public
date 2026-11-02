import type { PolicySelection, ReferenceMetadata } from "./ports.ts";

// Names/provenance only, transcribed from the edited report's
// configuration-registry-plan.json. No environment is read by this catalog.
export const VERTEX_CONFIGURATION_GROUPS = Object.freeze([
  {
    group: "broker-execution",
    reportName: "Broker and execution",
    logicalName: "broker.ibkr.*",
    owner: "deterministic-broker-edge",
    aliases: [
      "IBKR_HOST",
      "IB_HOST",
      "IB_GATEWAY_HOST",
      "IBKR_PORT",
      "IB_PORT",
      "IB_GATEWAY_PORT",
      "IBKR_CLIENT_ID",
      "IB_CLIENT_ID",
      "IBKR_TRADING_MODE",
      "IBKR_PAPER_TRADING_ENABLED",
    ],
    requirements: [
      "separate-client-portal-http-and-tws-socket",
      "explicit-account-environment",
      "unique-client-id-role-lease",
      "no-agent-broker-credentials",
      "no-trading-enable-on-healthcheck",
    ],
  },
  {
    group: "quantvps-transport",
    reportName: "QuantVPS transport",
    logicalName: "infrastructure.quantvps.*",
    owner: "infrastructure-operations",
    aliases: [
      "QUANTVPS_HOST",
      "QUANTVPS_SSH_HOST",
      "QUANTVPS_SSH_USER",
      "QUANTVPS_SSH_PORT",
    ],
    requirements: [
      "server-only-host-key-references",
      "independent-trusted-host-verification",
      "scoped-key-operations",
      "no-research-agent-ssh",
    ],
  },
  {
    group: "options-analytics",
    reportName: "Options analytics",
    logicalName: "providers.quantdata.apiKey",
    owner: "market-data-ingestion",
    aliases: ["QUANTDATA_API_KEY"],
    requirements: [
      "api-plan-evidence",
      "independent-opra-nonprofessional-entitlement",
      "server-shared-cache",
      "provider-timestamps",
      "aggregate-quota-budget",
    ],
  },
  {
    group: "fundamentals-news",
    reportName: "Fundamentals and news",
    logicalName: "providers.financialdatasets.apiKey",
    owner: "research-data-ingestion",
    aliases: ["FINANCIALDATASETS_API_KEY", "FINANCIAL_DATASETS_API_KEY"],
    requirements: [
      "explicit-alias-resolution-without-values",
      "retention-policy",
      "redistribution-policy",
      "billable-request-budget-including-mcp",
    ],
  },
  {
    group: "historical-quant-data",
    reportName: "Historical quant data",
    logicalName: "providers.quantpad.apiKey",
    owner: "research-data-ingestion",
    aliases: [],
    proposedAlias: "QUANTPAD_API_KEY",
    requirements: [
      "optional-not-detected",
      "written-external-use-export-rights",
      "retention-clarification",
      "plan-coverage",
      "quota-verification",
      "v01-v06-cutover-separate",
    ],
  },
  {
    group: "models-agent-tools",
    reportName: "Models and agent tools",
    logicalName: "models.provider.*",
    owner: "agent-gateway",
    aliases: [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "GROQ_API_KEY",
    ],
    requirements: [
      "exact-model-version",
      "per-role-tool-allowlist",
      "explicit-token-and-cost-budget",
      "server-only-secret-references",
      "no-confidence-or-autoaccept-authority",
    ],
  },
  {
    group: "storage-queue-audit",
    reportName: "Storage, queue and audit",
    logicalName: "storage.*",
    owner: "platform-services",
    aliases: ["DATABASE_URL", "REDIS_URL"],
    requirements: [
      "separate-database-roles-and-environments",
      "append-only-audit",
      "immutable-evidence",
      "backup-restore-contract",
      "object-storage-policy",
    ],
  },
] as const);

// Distinct branch-only candidates, NEVER merged into the canonical 460-name
// inventory or accepted as executable configuration. Flags/proof labels cannot
// bypass independent current privileged authorization or native risk policy.
export const VERTEX_TRAIL_ONLY_CANDIDATES = Object.freeze([
  "EXECUTION_APPROVAL_HMAC_KEY",
  "EXECUTION_REVIEWER_KEY_ID",
  "EXECUTION_REVIEWER_PUBLIC_KEY",
  "EXECUTION_STARTUP_GENERATION",
  "EXTERNAL_FILL_PROTECTION_AUTHORIZED",
  "EXTERNAL_FILL_PROTECTION_CLIENT_ID",
  "EXTERNAL_FILL_PROTECTION_ENABLED",
  "EXTERNAL_FILL_PROTECTION_POLL_INTERVAL_SECONDS",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_ACCOUNT_FINGERPRINT",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_CLIENT_ID",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_CON_ID",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_CONTEXT_PATH",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_CONTRACT_HASH",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_ENABLED",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_EXPIRES_AT",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_GROUP_HASH",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_MAX_NOTIONAL_USD",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_MAX_QUANTITY",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_PROOF_ID",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_SECURITY_TYPE",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_STARTUP_GENERATION",
  "IBKR_LIVE_PROTECTED_BUY_PROOF_SYMBOL",
  "IBKR_RECOVERY_SNAPSHOT_CLIENT_ID",
  "TRADING_ENABLED",
  "VERTEX_QUANT_RUNTIME_INSTANCE_ID",
] as const);

export const VERTEX_REGISTRY_METADATA_FIELDS = Object.freeze([
  "logicalName",
  "ownerService",
  "environment",
  "secretReferenceOrNonsecretValue",
  "legacyAliases",
  "requiredWhen",
  "permissions",
  "entitlementPolicyId",
  "rotationOwner",
  "verificationStatus",
  "lastVerifiedAt",
] as const);
export const VERTEX_CONFIGURATION_PROVENANCE = Object.freeze({
  report: "platform-consolidation-2026-09-11/configuration-registry-plan.json",
  canonicalInventory:
    "platform-consolidation-2026-09-11/environment-name-inventory.json",
  trailInventory:
    "platform-consolidation-2026-09-11/worktree-environment-delta.json",
  canonicalProjectVariablePairs: 579,
  canonicalDistinctNames: 460,
  canonicalSourceFiles: 1945,
  trailCandidateCount: 25,
  // Values are private immutable config artifacts or secret-reference metadata;
  // neither dotenv aliases nor declaration labels are runtime readiness facts.
  registryValueRepresentation: "scoped-reference-id-and-sha256",
  riskAndLicensingPolicyDistinct: true,
  automaticallyActivate: false,
} as const);

export type ReferenceResolution =
  | Readonly<{ status: "selected"; reference: ReferenceMetadata }>
  | Readonly<{
      status: "unknown" | "incompatible";
      reason: "not-configured" | "ambiguous-alias" | "trail-candidate-only";
    }>;
export const resolveConfiguredReference = (
  selection: PolicySelection,
  logicalName: string,
  ownerService: string,
  alias?: string
): ReferenceResolution => {
  if (
    alias &&
    (VERTEX_TRAIL_ONLY_CANDIDATES as readonly string[]).includes(alias)
  )
    return Object.freeze({
      status: "incompatible",
      reason: "trail-candidate-only",
    });
  const matches = selection.references.filter(
    (reference) =>
      reference.logicalName === logicalName &&
      reference.ownerService === ownerService &&
      reference.accountAlias === selection.accountAlias &&
      reference.environment === selection.environment &&
      (alias === undefined || reference.legacyAliases.includes(alias))
  );
  if (matches.length === 0)
    return Object.freeze({ status: "unknown", reason: "not-configured" });
  const [selected] = matches;
  if (matches.length !== 1 || selected === undefined)
    return Object.freeze({ status: "incompatible", reason: "ambiguous-alias" });
  return Object.freeze({ status: "selected", reference: selected });
};
