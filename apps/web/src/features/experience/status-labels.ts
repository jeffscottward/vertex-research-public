import type {
  BacktestRun,
  BrokerRecoveryStatus,
  Freshness,
  ModuleManifest,
  PortfolioSnapshot,
  ProjectionContinuity,
} from "@darkfactory/api/vertex";

// Wire values from the frozen Vertex contracts stay as protocol tokens on the wire.
// These helpers turn the vague ones ("unavailable", "unknown") into definite labels
// that name what the source reported before the UI displays them.

// The projection store sets "unavailable" only when the latest snapshot is a source-unavailable
// report: the source answered that it has no portfolio data.
export const continuityStateLabel = (
  state: ProjectionContinuity["state"]
): string => (state === "unavailable" ? "source reported no data" : state);

export const reservationStateLabel = (
  state: PortfolioSnapshot["reservations"][number]["state"]
): string => (state === "unknown" ? "not confirmed by native owner" : state);

export const freshnessStatusLabel = (status: Freshness["status"]): string =>
  status === "unknown" ? "not evaluated by source" : status;

export const gatewayInfrastructureLabel = (
  state: BrokerRecoveryStatus["infrastructure"]
): string => {
  if (state === "unavailable") return "not reachable by status probe";
  if (state === "unknown") return "not reported by status probe";
  return state;
};

export const brokerHandshakeLabel = (
  state: BrokerRecoveryStatus["brokerHandshake"]
): string => {
  if (state === "unavailable") return "handshake probe could not reach broker";
  if (state === "unknown") return "not reported by status probe";
  return state;
};

export const gatewayRecoveryLabel = (
  state: BrokerRecoveryStatus["recovery"]
): string => (state === "unknown" ? "not reported by status probe" : state);

export const leakageCheckStatusLabel = (
  status: BacktestRun["leakageChecks"][number]["status"]
): string =>
  status === "unknown" ? "not reported by backtest runner" : status;

export const moduleLifecycleStateLabel = (
  state: ModuleManifest["lifecycleState"]
): string => {
  if (state === "unavailable") return "not reachable in catalog";
  if (state === "unknown") return "not reported by catalog";
  return state;
};
