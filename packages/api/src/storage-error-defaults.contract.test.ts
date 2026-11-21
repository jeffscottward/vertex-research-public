import { describe, expect, it } from "vitest";

import { appContract } from "./contract.ts";

// Default texts of the 502/503 contract errors that name a cause. A handler that throws one of these
// codes with no message sends this text, so each text must state only what that failure proves:
// a failed database request does not prove that a write was not saved.

const MIXED =
  "database request failed; request not confirmed; reload to check, then retry";

type WithErrorMap = Readonly<{
  "~orpc": { errorMap: Record<string, { message?: string } | undefined> };
}>;

// oRPC keeps the error map of a contract procedure under "~orpc" and exports no reader for it.
const defaultMessage = (
  procedure: unknown,
  code: string
): string | undefined => {
  const definition = procedure as WithErrorMap;
  return definition["~orpc"].errorMap[code]?.message;
};

describe("default messages of storage and service contract errors", () => {
  it.each([
    [
      "featureItems.list",
      appContract.featureItems.list,
      `Feature item storage: ${MIXED}`,
    ],
    [
      "preferences.theme.update",
      appContract.preferences.theme.update,
      `Theme preference storage: ${MIXED}`,
    ],
    [
      "agentModelRuns.get",
      appContract.agentModelRuns.get,
      `Model run storage: ${MIXED}`,
    ],
    [
      "breadth90.get",
      appContract.breadth90.get,
      `Breadth-90 storage: ${MIXED}`,
    ],
    [
      "clickLog.record",
      appContract.clickLog.record,
      `Click log storage: ${MIXED}`,
    ],
    [
      "backtestRuns.drift.list",
      appContract.backtestRuns.drift.list,
      `Drift storage: ${MIXED}`,
    ],
    ["openbb.ingest", appContract.openbb.ingest, `OpenBB storage: ${MIXED}`],
    [
      "priceAlerts.list",
      appContract.priceAlerts.list,
      `Price alert storage: ${MIXED}`,
    ],
    [
      "priceAlerts.signals.list",
      appContract.priceAlerts.signals.list,
      `Signal alert storage: ${MIXED}`,
    ],
    ["todos.list", appContract.todos.list, `To-do storage: ${MIXED}`],
  ])(
    "%s names a failed database request and an unconfirmed result (reads and writes share the error)",
    (_name, procedure, message) => {
      expect(defaultMessage(procedure, "STORAGE_ERROR")).toBe(message);
    }
  );

  it.each([
    [
      "admin.users.list",
      appContract.admin.users.list,
      "User directory: database request failed; no user was read; retry",
    ],
    [
      "dashboard.summary",
      appContract.dashboard.summary,
      "Dashboard storage: database request failed; no dashboard data was read; retry",
    ],
    [
      "backtestRuns.comparisons.list",
      appContract.backtestRuns.comparisons.list,
      "Backtest storage: database request failed; no comparison was read; retry",
    ],
    [
      "quantLab.list",
      appContract.quantLab.list,
      "Quant Lab storage: database request failed; no record was read; retry",
    ],
    [
      "setupReplay.run",
      appContract.setupReplay.run,
      "Bar storage: database request failed; no bars were read; retry",
    ],
  ])(
    "%s is read-only and names what was not read",
    (_name, procedure, message) => {
      expect(defaultMessage(procedure, "STORAGE_ERROR")).toBe(message);
    }
  );

  it("names the service and the effect for the 502/503 errors that are not storage", () => {
    expect(defaultMessage(appContract.agentApiKeys.list, "UNAVAILABLE")).toBe(
      "Agent API keys are not configured on this server; no key was read or changed"
    );
    expect(defaultMessage(appContract.engines.status, "UNAVAILABLE")).toBe(
      "Engine status service did not answer; no engine state was read; retry"
    );
    expect(
      defaultMessage(appContract.ibkrMonitor.snapshot, "UNAVAILABLE")
    ).toBe(
      "ibkr-monitor service did not answer; no account data was read; retry"
    );
    expect(
      defaultMessage(appContract.priceAlerts.signals.backfill, "UPSTREAM_ERROR")
    ).toBe(
      "Market data request failed at the data source; no signal backfill was computed; retry"
    );
    expect(
      defaultMessage(appContract.contact.submit, "SERVICE_UNAVAILABLE")
    ).toBe(
      "Message delivery not confirmed: the mail delivery request failed; retry later"
    );
  });
});
