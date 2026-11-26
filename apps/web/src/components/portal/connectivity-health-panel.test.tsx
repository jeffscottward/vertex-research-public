// @vitest-environment jsdom
import type { ConnectivityHealthOutput } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ConnectivityHealthGateway,
  ConnectivityHealthPanel,
  createBrowserConnectivityHealthGateway,
} from "./connectivity-health-panel.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CHECKED_AT = new Date("2026-11-24T15:30:00.000Z");

const mounted: Root[] = [];

const render = async (gateway?: ConnectivityHealthGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      <ConnectivityHealthPanel
        {...(gateway === undefined ? {} : { gateway })}
      />
    );
  });
  return container;
};

afterEach(() => {
  for (const root of mounted.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const makeHealth = (
  overrides: Partial<ConnectivityHealthOutput> = {}
): ConnectivityHealthOutput => ({
  activeAlertKeys: [],
  checkedAt: CHECKED_AT,
  issues: [],
  ntfyConfigured: true,
  overallStatus: "healthy",
  pendingDelivery: null,
  pendingKind: null,
  providers: [
    {
      activeIssueCount: 0,
      configured: true,
      envVars: ["QUANTDATA_API_KEY"],
      id: "quantdata",
      label: "QuantData Options & Flow",
      status: "healthy",
      summary: "Configured; no active feed errors",
    },
    {
      activeIssueCount: 0,
      configured: false,
      envVars: ["VERTEX_PRICE_ALERTS_NTFY_ORIGIN"],
      id: "ntfy-alerts",
      label: "Automated Alert Delivery (ntfy)",
      status: "not_configured",
      summary: "Not configured on this server",
    },
  ],
  ...overrides,
});

describe("ConnectivityHealthPanel", () => {
  it("renders loading, healthy state, refresh action, and browser gateway", async () => {
    let resolveLoad!: (value: ConnectivityHealthOutput) => void;
    const loadingGateway: ConnectivityHealthGateway = {
      health: () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    };
    const view = await render(loadingGateway);
    expect(view.textContent).toContain("Checking feed connectivity");
    await act(async () => {
      resolveLoad(makeHealth());
    });
    expect(
      view.querySelector("[data-connectivity-overall='healthy']")?.textContent
    ).toContain("Healthy");
    expect(view.querySelector("[data-connectivity-issues]")).toBeNull();
    expect(view.textContent).toContain("ntfy alerts configured");

    // Browser gateway smoke test
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ json: makeHealth() }));
    const browserGateway = createBrowserConnectivityHealthGateway();
    await browserGateway.health().catch(() => undefined);
    await browserGateway.health().catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("renders auth_failed credential-rotation alert and degraded feed alerts", async () => {
    const health = vi
      .fn<ConnectivityHealthGateway["health"]>()
      .mockResolvedValueOnce(
        makeHealth({
          issues: [
            {
              category: "auth_failed",
              consecutiveFailures: 3,
              envVars: ["QUANTDATA_API_KEY"],
              escalation: "needs_you_credential_rotation",
              httpStatus: 401,
              key: "flow:SPY:options:auth_failed",
              lastFailureAt: CHECKED_AT,
              lastOkAt: null,
              layer: "flow",
              message:
                "QuantData orderFlow: HTTP 401 (authentication failed — check QUANTDATA_API_KEY).",
              provider: "quantdata",
              source: "SPY options",
            },
          ],
          ntfyConfigured: false,
          overallStatus: "auth_failed",
          providers: [
            {
              activeIssueCount: 1,
              configured: true,
              envVars: ["QUANTDATA_API_KEY"],
              id: "quantdata",
              label: "QuantData Options & Flow",
              status: "auth_failed",
              summary:
                "Credential/auth error on 1 feed(s) — owner credential rotation required",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        makeHealth({
          issues: [
            {
              category: "upstream_5xx",
              consecutiveFailures: 1,
              envVars: ["VERTEX_HISTORY_URL"],
              escalation: "alert",
              httpStatus: 503,
              key: "flow:ES:ticks:upstream_5xx",
              lastFailureAt: CHECKED_AT,
              lastOkAt: null,
              layer: "flow",
              message: "History endpoint returned HTTP 503",
              provider: "ibkr-history",
              source: "ES ticks",
            },
          ],
          overallStatus: "degraded",
          providers: [
            {
              activeIssueCount: 1,
              configured: true,
              envVars: ["VERTEX_HISTORY_URL"],
              id: "ibkr-history",
              label: "IBKR History & Order Flow",
              status: "degraded",
              summary: "1 degraded feed(s): History endpoint returned HTTP 503",
            },
          ],
        })
      );

    const view = await render({ health });
    expect(
      view.querySelector("[data-connectivity-overall='auth_failed']")
        ?.textContent
    ).toContain("Credential rotation required");
    const alert = view.querySelector("[data-connectivity-issues]");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("owner credential rotation required");
    expect(alert?.textContent).toContain("rotate QUANTDATA_API_KEY");
    expect(alert?.textContent).toContain("(3 consecutive)");
    expect(view.textContent).toContain(
      "not configured (uses #omp-alerts fallback)"
    );

    const refresh = view.querySelector("button");
    await act(async () => {
      refresh?.click();
    });
    expect(
      view.querySelector("[data-connectivity-overall='degraded']")?.textContent
    ).toContain("Degraded feeds");
    expect(
      view.querySelector("[data-connectivity-issues]")?.textContent
    ).toContain("1 active feed connectivity issue(s) detected.");
  });

  it("renders forbidden and error states cleanly without swallowing failures", async () => {
    const forbiddenView = await render({
      health: async () => {
        throw Object.assign(new Error("Operator access required"), {
          code: "FORBIDDEN",
          status: 403,
        });
      },
    });
    expect(forbiddenView.textContent).toContain("Operator access required");

    const errorView = await render({
      health: async () => {
        throw new Error("database unavailable");
      },
    });
    expect(
      errorView.querySelector("[data-connectivity-error]")?.textContent
    ).toContain("database unavailable");
  });
});
