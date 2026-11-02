// What: Readiness for Vertex's declared-but-pending integrations (capabilities.yaml `integrations`).
// Used by: packages/config/src/server/capabilities.ts (re-export).
// See: packages/config/src/capabilities.ts (pendingIntegration).
import type {
  CapabilityManifest,
  PendingRuntimeState,
} from "../capabilities.ts";
import type { ServerEnv } from "../server.ts";

export type IntegrationReadinessStatus = PendingRuntimeState;

export type IntegrationReadinessReason =
  | "capability_disabled"
  | "runtime_not_probed"
  | "runtime_incompatible";

export type IntegrationReadiness = Readonly<{
  provider: string;
  enabled: false;
  configured: false;
  available: false;
  status: IntegrationReadinessStatus;
  reason: IntegrationReadinessReason;
}>;

export type IntegrationReadinessInventory = Readonly<{
  nativeQuant: IntegrationReadiness;
  research: IntegrationReadiness;
  rustKernel: IntegrationReadiness;
  marketData: IntegrationReadiness;
  charts: IntegrationReadiness;
  notifications: IntegrationReadiness;
  browserWatch: IntegrationReadiness;
}>;

type PendingRuntimeKey =
  | "QUANT_RUNTIME_STATE"
  | "NAUTILUS_RUNTIME_STATE"
  | "IBKR_RUNTIME_STATE"
  | "RESEARCH_RUNTIME_STATE"
  | "AGNO_RUNTIME_STATE"
  | "RUST_KERNEL_RUNTIME_STATE"
  | "MARKET_DATA_RUNTIME_STATE"
  | "CHART_RUNTIME_STATE"
  | "NOTIFICATION_RUNTIME_STATE"
  | "JEV_RUNTIME_STATE";

export type IntegrationReadinessEnvironment = Readonly<
  Partial<Pick<ServerEnv, PendingRuntimeKey>>
>;

// New integrations have no operational adapter in this baseline. Neither the
// manifest nor runtime configuration can promote them to ready or authorize
// execution; incompatible evidence always outranks unknown.
const pendingReadiness = (
  integration: Readonly<{
    provider: string;
    runtime_state: PendingRuntimeState;
  }>,
  ...runtimeStates: readonly (PendingRuntimeState | undefined)[]
): IntegrationReadiness => {
  const states = [integration.runtime_state, ...runtimeStates];
  let status: IntegrationReadinessStatus = "disabled";
  if (states.includes("incompatible")) status = "incompatible";
  else if (states.includes("unknown")) status = "unknown";
  let reason: IntegrationReadinessReason = "capability_disabled";
  if (status === "incompatible") reason = "runtime_incompatible";
  else if (status === "unknown") reason = "runtime_not_probed";
  return Object.freeze({
    provider: integration.provider,
    enabled: false,
    configured: false,
    available: false,
    status,
    reason,
  });
};

export const evaluateIntegrationReadiness = (
  manifest: CapabilityManifest,
  source: IntegrationReadinessEnvironment
): IntegrationReadinessInventory => {
  const { integrations } = manifest;
  return Object.freeze({
    nativeQuant: pendingReadiness(
      integrations.native_quant,
      source.QUANT_RUNTIME_STATE,
      source.NAUTILUS_RUNTIME_STATE,
      source.IBKR_RUNTIME_STATE
    ),
    research: pendingReadiness(
      integrations.research,
      source.RESEARCH_RUNTIME_STATE,
      source.AGNO_RUNTIME_STATE
    ),
    rustKernel: pendingReadiness(
      integrations.rust_kernel,
      source.RUST_KERNEL_RUNTIME_STATE
    ),
    marketData: pendingReadiness(
      integrations.market_data,
      source.MARKET_DATA_RUNTIME_STATE
    ),
    charts: pendingReadiness(integrations.charts, source.CHART_RUNTIME_STATE),
    notifications: pendingReadiness(
      integrations.notifications,
      source.NOTIFICATION_RUNTIME_STATE
    ),
    browserWatch: pendingReadiness(
      integrations.browser_watch,
      source.JEV_RUNTIME_STATE
    ),
  });
};
