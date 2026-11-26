import { describe, expect, it } from "vitest";

import {
  alertableConnectivityIssues,
  CONNECTIVITY_IN_FLIGHT_LEASE_MS,
  classifyConnectivityMessage,
  diffConnectivityAlerts,
  evaluateConnectivityHealth,
  formatConnectivityAlert,
  formatConnectivityRecovery,
} from "./connectivity-health.ts";

const NOW = new Date("2026-11-24T15:30:00.000Z");
const EARLIER = new Date("2026-11-24T15:25:00.000Z");
const OLDER_OK = new Date("2026-11-24T14:00:00.000Z");

const ALL_CONFIGURED = {
  deployStatus: true,
  engineStatus: true,
  ibkrMonitor: true,
  ibkrRecovery: true,
  marketHistory: true,
  portfolioMonitor: true,
  priceAlertsNtfy: true,
  quantData: true,
  researchLenses: true,
} as const;

describe("classifyConnectivityMessage", () => {
  it("classifies HTTP 401/403 and auth text as auth_failed with credential-rotation escalation", () => {
    expect(
      classifyConnectivityMessage("QuantData orderFlow: HTTP 401.")
    ).toEqual({
      category: "auth_failed",
      escalation: "needs_you_credential_rotation",
      httpStatus: 401,
    });
    expect(
      classifyConnectivityMessage("QuantData netDrift: HTTP 403.")
    ).toEqual({
      category: "auth_failed",
      escalation: "needs_you_credential_rotation",
      httpStatus: 403,
    });
    expect(classifyConnectivityMessage("invalid token from upstream")).toEqual({
      category: "auth_failed",
      escalation: "needs_you_credential_rotation",
      httpStatus: null,
    });
  });

  it("classifies rate limits, 5xx, unreachable, and generic feed errors", () => {
    expect(
      classifyConnectivityMessage("QuantData orderFlow: HTTP 429.")
    ).toEqual({
      category: "rate_limited",
      escalation: "info",
      httpStatus: 429,
    });
    expect(
      classifyConnectivityMessage("IBKR history pacing: retry in 30 s")
    ).toEqual({
      category: "rate_limited",
      escalation: "info",
      httpStatus: null,
    });
    expect(
      classifyConnectivityMessage("History endpoint returned HTTP 503")
    ).toEqual({
      category: "upstream_5xx",
      escalation: "alert",
      httpStatus: 503,
    });
    expect(classifyConnectivityMessage("bad gateway from collector")).toEqual({
      category: "upstream_5xx",
      escalation: "alert",
      httpStatus: null,
    });
    expect(
      classifyConnectivityMessage("QuantData orderFlow: request timed out.")
    ).toEqual({
      category: "unreachable",
      escalation: "alert",
      httpStatus: null,
    });
    expect(
      classifyConnectivityMessage("QuantData orderFlow: unexpected payload")
    ).toEqual({
      category: "feed_error",
      escalation: "alert",
      httpStatus: null,
    });
  });
});

describe("evaluateConnectivityHealth & alertableConnectivityIssues", () => {
  it("reports healthy when all feeds succeed and marks missing runtime config as not_configured", () => {
    const result = evaluateConnectivityHealth({
      config: { ...ALL_CONFIGURED, priceAlertsNtfy: false, quantData: false },
      flowSamples: [
        {
          at: NOW,
          message: "12 prints",
          source: "options",
          status: "ok",
          symbol: "SPY",
        },
      ],
      openbbRuns: [
        {
          error: null,
          finishedAt: NOW,
          job: "daily-prices",
          startedAt: EARLIER,
          status: "ok",
        },
      ],
    });
    expect(result.overallStatus).toBe("healthy");
    expect(result.issues).toEqual([]);
    const quantData = result.providers.find((p) => p.id === "quantdata");
    expect(quantData?.status).toBe("not_configured");
    const openbb = result.providers.find((p) => p.id === "openbb");
    expect(openbb?.status).toBe("healthy");
    const ibkr = result.providers.find((p) => p.id === "ibkr-history");
    expect(ibkr?.status).toBe("healthy");
  });

  it("detects QuantData 401 immediately, counts consecutive 5xx failures, and detects OpenBB failures", () => {
    const result = evaluateConnectivityHealth({
      config: ALL_CONFIGURED,
      flowSamples: [
        // SPY options: single 401 (immediate auth_failed alert)
        {
          at: NOW,
          message:
            "QuantData orderFlow: HTTP 401 (authentication failed — check QUANTDATA_API_KEY).",
          source: "options",
          status: "unavailable",
          symbol: "SPY",
        },
        {
          at: OLDER_OK,
          message: "ok",
          source: "options",
          status: "ok",
          symbol: "SPY",
        },
        // ES ticks: 2 consecutive 503s (alertable repeated 5xx)
        {
          at: NOW,
          message: "History endpoint returned HTTP 503",
          source: "ticks",
          status: "unavailable",
          symbol: "ES",
        },
        {
          at: EARLIER,
          message: "History endpoint returned HTTP 503",
          source: "ticks",
          status: "unavailable",
          symbol: "ES",
        },
        {
          at: OLDER_OK,
          message: "ok",
          source: "ticks",
          status: "ok",
          symbol: "ES",
        },
        // QQQ gex: single 502 (not yet repeated -> not alertable)
        {
          at: NOW,
          message: "QuantData openInterest: HTTP 502.",
          source: "gex",
          status: "unavailable",
          symbol: "QQQ",
        },
        // NQ depth: rate limited (info only, not alertable)
        {
          at: NOW,
          message: "IBKR history pacing: retry in 20 s",
          source: "depth",
          status: "unavailable",
          symbol: "NQ",
        },
        // SPY net_drift: empty message fallback
        {
          at: NOW,
          message: null,
          source: "net_drift",
          status: "unavailable",
          symbol: "SPY",
        },
      ],
      openbbRuns: [
        {
          error: "History endpoint returned HTTP 401",
          finishedAt: NOW,
          job: "daily-prices",
          startedAt: EARLIER,
          status: "failed",
        },
        {
          error: null,
          finishedAt: NOW,
          job: "sec-filings",
          startedAt: EARLIER,
          status: "blocked_upstream",
        },
        {
          error: null,
          finishedAt: NOW,
          job: "cboe-vol",
          startedAt: EARLIER,
          status: "failed",
        },
        {
          error: "FINRA upstream returned HTTP 403",
          finishedAt: NOW,
          job: "finra-otc",
          startedAt: EARLIER,
          status: "blocked_upstream",
        },
        {
          error: "Yahoo returned HTTP 403",
          finishedAt: NOW,
          job: "daily-prices",
          startedAt: EARLIER,
          status: "blocked_upstream",
        },
      ],
    });

    expect(result.overallStatus).toBe("auth_failed");
    expect(result.providers.find((p) => p.id === "quantdata")?.status).toBe(
      "auth_failed"
    );
    expect(result.providers.find((p) => p.id === "ibkr-history")?.status).toBe(
      "degraded"
    );
    expect(result.providers.find((p) => p.id === "openbb")?.status).toBe(
      "auth_failed"
    );

    const alertable = alertableConnectivityIssues(result.issues);
    const alertableKeys = alertable.map((issue) => issue.key);
    expect(alertableKeys).toContain("flow:SPY:options:auth_failed");
    expect(alertableKeys).toContain("flow:ES:ticks:upstream_5xx");
    expect(alertableKeys).toContain("openbb:daily-prices:auth_failed");
    expect(alertableKeys).toContain("openbb:sec-filings:feed_error");
    expect(alertableKeys).toContain("openbb:cboe-vol:feed_error");
    // Public OpenBB HTTP 403 / blocked_upstream runs never trigger false credential-rotation asks.
    const finra = result.issues.find((issue) => issue.source === "finra-otc");
    expect(finra).toMatchObject({
      category: "feed_error",
      envVars: [],
      escalation: "alert",
      httpStatus: 403,
    });
    const dailyBlocked = result.issues.find(
      (issue) =>
        issue.source === "daily-prices" && issue.category === "feed_error"
    );
    expect(dailyBlocked).toMatchObject({
      category: "feed_error",
      envVars: [],
      escalation: "alert",
      httpStatus: 403,
    });
    // Single flow 502 and rate_limited are not paged
    expect(alertableKeys).not.toContain("flow:QQQ:gex:upstream_5xx");
    expect(alertableKeys).not.toContain("flow:NQ:depth:rate_limited");
  });

  it("reports degraded overall status when issues exist without auth_failed", () => {
    const result = evaluateConnectivityHealth({
      config: ALL_CONFIGURED,
      flowSamples: [
        {
          at: NOW,
          message: "History endpoint returned HTTP 503",
          source: "ticks",
          status: "unavailable",
          symbol: "ES",
        },
      ],
      openbbRuns: [],
    });
    expect(result.overallStatus).toBe("degraded");
  });
});

describe("formatConnectivityAlert & diffConnectivityAlerts", () => {
  const makeIssue = (
    overrides: Partial<
      ReturnType<typeof evaluateConnectivityHealth>["issues"][number]
    > = {}
  ) => ({
    category: "auth_failed" as const,
    consecutiveFailures: 1,
    envVars: ["QUANTDATA_API_KEY"],
    escalation: "needs_you_credential_rotation" as const,
    httpStatus: 401,
    key: "flow:SPY:options:auth_failed",
    lastFailureAt: NOW,
    lastOkAt: OLDER_OK,
    layer: "flow" as const,
    message: "QuantData orderFlow: HTTP 401.",
    provider: "quantdata",
    source: "SPY options",
    ...overrides,
  });

  it("formats auth_failed alerts with Needs-you escalation and truncates long lists", () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      makeIssue({
        consecutiveFailures: index === 0 ? 3 : 1,
        key: `flow:S${index}:options:auth_failed`,
        source: `S${index} options`,
      })
    );
    const alert = formatConnectivityAlert(many);
    expect(alert.needsOwnerAsk).toBe(true);
    expect(alert.title).toContain("credential rotation needed");
    expect(alert.body).toContain("[3x]");
    expect(alert.body).toContain("and 2 more feed(s)");
    expect(alert.body).toContain("QUANTDATA_API_KEY");
    expect(alert.body).toContain("Needs-you owner ask");

    const noEnvAuth = formatConnectivityAlert([makeIssue({ envVars: [] })]);
    expect(noEnvAuth.body).toContain("Credential rotation required by owner.");

    const feedAlert = formatConnectivityAlert([
      makeIssue({
        category: "upstream_5xx",
        consecutiveFailures: 2,
        escalation: "alert",
        httpStatus: 503,
        key: "flow:ES:ticks:upstream_5xx",
        provider: "ibkr-history",
      }),
    ]);
    expect(feedAlert.needsOwnerAsk).toBe(false);
    expect(feedAlert.title).toContain("repeated feed failures");
    expect(feedAlert.body).toContain("/connections");

    expect(formatConnectivityRecovery().kind).toBe("recovery");
  });

  it("handles all state-machine transitions: noop, alert, in-flight, retry, prune, recovery, clear-pending", () => {
    const issueA = makeIssue();
    const issueB = makeIssue({
      category: "upstream_5xx",
      consecutiveFailures: 2,
      escalation: "alert",
      httpStatus: 503,
      key: "flow:ES:ticks:upstream_5xx",
      provider: "ibkr-history",
      source: "ES ticks",
    });

    // Healthy steady state -> noop
    expect(
      diffConnectivityAlerts({ alertable: [], now: NOW, state: null }).action
    ).toBe("noop");

    // First auth failure -> alert
    const first = diffConnectivityAlerts({
      alertable: [issueA],
      now: NOW,
      state: null,
    });
    expect(first.action).toBe("alert");
    expect(first.newlyAlerted).toHaveLength(1);

    // Active key already alerted -> noop
    expect(
      diffConnectivityAlerts({
        alertable: [issueA],
        now: NOW,
        state: {
          activeKeys: [issueA.key],
          pendingDelivery: null,
          pendingEventId: null,
          pendingKeys: [],
          pendingKind: null,
          updatedAt: EARLIER,
        },
      }).action
    ).toBe("noop");

    // In-flight lease active -> in-flight
    expect(
      diffConnectivityAlerts({
        alertable: [issueA],
        now: new Date(NOW.getTime() + CONNECTIVITY_IN_FLIGHT_LEASE_MS - 1000),
        state: {
          activeKeys: [],
          pendingDelivery: "pending",
          pendingEventId: "evt-1",
          pendingKeys: [issueA.key],
          pendingKind: "alert",
          updatedAt: NOW,
        },
      }).action
    ).toBe("in-flight");

    // Pending alert that failed delivery -> retries alert
    expect(
      diffConnectivityAlerts({
        alertable: [issueA],
        now: NOW,
        state: {
          activeKeys: [issueA.key],
          pendingDelivery: "failed",
          pendingEventId: "evt-1",
          pendingKeys: [issueA.key],
          pendingKind: "alert",
          updatedAt: EARLIER,
        },
      }).action
    ).toBe("alert");

    // Pending alert clears when all issues resolved before activeKeys set -> clear-pending
    expect(
      diffConnectivityAlerts({
        alertable: [],
        now: NOW,
        state: {
          activeKeys: [],
          pendingDelivery: "failed",
          pendingEventId: "evt-1",
          pendingKeys: [issueA.key],
          pendingKind: "alert",
          updatedAt: EARLIER,
        },
      }).action
    ).toBe("clear-pending");

    // Pending alert turns into recovery when activeKeys existed and issues cleared
    expect(
      diffConnectivityAlerts({
        alertable: [],
        now: NOW,
        state: {
          activeKeys: [issueA.key],
          pendingDelivery: "failed",
          pendingEventId: "evt-1",
          pendingKeys: [issueA.key],
          pendingKind: "alert",
          updatedAt: EARLIER,
        },
      }).action
    ).toBe("recovery");

    // Pending recovery retries when still healthy, clears when active issue returns
    expect(
      diffConnectivityAlerts({
        alertable: [],
        now: NOW,
        state: {
          activeKeys: [issueA.key],
          pendingDelivery: "not-configured",
          pendingEventId: "evt-2",
          pendingKeys: [],
          pendingKind: "recovery",
          updatedAt: EARLIER,
        },
      }).action
    ).toBe("recovery");

    expect(
      diffConnectivityAlerts({
        alertable: [issueA],
        now: NOW,
        state: {
          activeKeys: [issueA.key],
          pendingDelivery: "not-configured",
          pendingEventId: "evt-2",
          pendingKeys: [],
          pendingKind: "recovery",
          updatedAt: EARLIER,
        },
      }).action
    ).toBe("clear-pending");

    // Partial recovery prunes recovered key
    const pruned = diffConnectivityAlerts({
      alertable: [issueA],
      now: NOW,
      state: {
        activeKeys: [issueA.key, issueB.key],
        pendingDelivery: null,
        pendingEventId: null,
        pendingKeys: [],
        pendingKind: null,
        updatedAt: EARLIER,
      },
    });
    expect(pruned.action).toBe("prune-active");
    expect(pruned.targetKeys).toEqual([issueA.key]);

    // Full recovery when activeKeys existed
    const recovered = diffConnectivityAlerts({
      alertable: [],
      now: NOW,
      state: {
        activeKeys: [issueA.key],
        pendingDelivery: null,
        pendingEventId: null,
        pendingKeys: [],
        pendingKind: null,
        updatedAt: EARLIER,
      },
    });
    expect(recovered.action).toBe("recovery");
  });
});
