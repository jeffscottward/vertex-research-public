// @vitest-environment jsdom
import type {
  DeployServiceStatusOutput,
  DeploymentStatusOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { DeploymentGateway } from "./agent-ops-client.tsx";
import v2Fixture from "../../../../../packages/api/src/contracts/fixtures/deploy-status-v2-stopped-session.json";
import { deploymentTabKeyTarget } from "./deployments-snapshot.tsx";
import {
  DeploymentsWorkspace,
  deploymentAlerts,
  formatAge,
  upSinceText,
} from "./deployments-workspace.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/deployments");
  return vi.useRealTimers();
});

const flush = async () => ({
  ...(await (async () => {
    const results = {};
    for (let i = 0; i < 20; i += 1)
      Object.assign(results, await Promise.resolve());
    return results;
  })()),
});
const now = new Date("2026-09-29T12:00:00.000Z");

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    return await flush();
  });
  return container;
};

const service = (
  overrides: Partial<DeployServiceStatusOutput>
): DeployServiceStatusOutput => ({
  service: "redis",
  present: true,
  status: "running",
  running: true,
  health: "healthy",
  startedAt: "2026-09-29T10:00:00Z",
  finishedAt: null,
  exitCode: 0,
  restartCount: 0,
  oomKilled: false,
  image: "redis:7",
  log: null,
  ...overrides,
});

const neverStartedNautilus = service({
  service: "nautilus-trader",
  status: "created",
  running: false,
  health: null,
  startedAt: null,
  finishedAt: null,
});
const healthyGateway = service({
  service: "ib-gateway",
  log: {
    lastLineAt: "2026-09-29T11:59:00Z",
    lines: 500,
    errorLines: 3,
    warnLines: 7,
  },
});

const status = (
  services: DeployServiceStatusOutput[],
  stale = false
): DeploymentStatusOutput => ({
  configured: true,
  fetchedAt: "2026-09-29T12:00:00.000Z",
  source: {
    host: "quantvps",
    generatedAt: "2026-09-29T11:59:30Z",
    ageSeconds: stale ? 400 : 30,
    stale,
  },
  services,
});

const gatewayOf = (
  fn: () => Promise<DeploymentStatusOutput>
): DeploymentGateway & { status: ReturnType<typeof vi.fn> } => {
  return { status: vi.fn(fn) };
};

describe("deploymentAlerts", () => {
  it("flags a never-started Nautilus container explicitly", () =>
    expect(deploymentAlerts([neverStartedNautilus, healthyGateway])).toEqual([
      {
        service: "nautilus-trader",
        message: "Nautilus is not running: status created, never started",
      },
    ]));

  it("flags IB Gateway when unhealthy, stopped or missing", () => {
    const running = service({ service: "nautilus-trader" });
    expect(
      deploymentAlerts([
        running,
        service({ service: "ib-gateway", health: "unhealthy" }),
      ])[0]!.message
    ).toMatch(/^IB Gateway is unhealthy/);
    expect(
      deploymentAlerts([
        running,
        service({
          service: "ib-gateway",
          status: "exited",
          running: false,
          exitCode: 1,
        }),
      ])[0]!.message
    ).toBe("IB Gateway is not running: status exited, exit code 1");
    expect(
      deploymentAlerts([
        running,
        { ...service({ service: "ib-gateway" }), present: false },
      ])[0]!.message
    ).toBe("IB Gateway is not running: container missing");
    return expect(deploymentAlerts([running, healthyGateway])).toEqual([]);
  });

  return it("formats up-since and ages", () => {
    expect(upSinceText(neverStartedNautilus, now)).toBe("never started");
    expect(upSinceText(service({}), now)).toBe(
      "2026-09-29 10:00:00 UTC (2h 0m)"
    );
    expect(formatAge(45)).toBe("45s");
    return expect(formatAge(400)).toBe("6m 40s");
  });
});

describe("DeploymentsWorkspace", () => {
  it("renders the table, alert row and log counts without any service action controls", async () => {
    const gateway = gatewayOf(async () =>
      status([neverStartedNautilus, healthyGateway])
    );
    window.history.replaceState(null, "", "/deployments?tab=services");
    const container = await mount(
      <DeploymentsWorkspace gateway={gateway} now={() => now} />
    );
    const alert = container.querySelector(
      "[data-deployment-alert='nautilus-trader']"
    );
    expect(alert?.textContent).toBe(
      "Nautilus is not running: status created, never started"
    );
    expect(
      container.querySelector("[data-deployment-alert='ib-gateway']")
    ).toBeNull();
    const headers = [
      ...container.querySelectorAll("[data-deployment-panel='services'] th"),
    ].map((node) => node.textContent);
    expect(headers).toEqual([
      "Service",
      "State",
      "Health",
      "Up since",
      "Restarts",
      "Last log",
      "Errors/Warns (last 500 lines)",
    ]);
    const gatewayRow = container.querySelector(
      "[data-deployment-service='ib-gateway']"
    );
    expect(gatewayRow?.textContent).toContain("3 / 7");
    expect(
      container.querySelector("[data-deployment-service='nautilus-trader']")
        ?.textContent
    ).toContain("never started");
    expect(
      container.querySelector("[data-deployment-snapshot]")?.textContent
    ).toContain("age 30s");
    expect(container.querySelector("[data-deployment-stale]")).toBeNull();
    const buttons = [
      ...container.querySelectorAll("button:not([role='tab'])"),
    ].map((node) => node.textContent?.trim());
    return expect(buttons).toEqual(["Reload"]);
  });

  it("shows the stale warning and an unhealthy gateway alert", async () => {
    const gateway = gatewayOf(async () =>
      status(
        [
          service({ service: "nautilus-trader" }),
          service({ service: "ib-gateway", health: "unhealthy" }),
        ],
        true
      )
    );
    const container = await mount(
      <DeploymentsWorkspace gateway={gateway} now={() => now} />
    );
    expect(
      container.querySelector("[data-deployment-stale]")?.textContent
    ).toContain("Stale snapshot");
    return expect(
      container.querySelector("[data-deployment-alert='ib-gateway']")
        ?.textContent
    ).toMatch(/unhealthy/);
  });

  it("renders operator-access-required and not-configured states", async () => {
    const forbidden = await mount(
      <DeploymentsWorkspace
        gateway={gatewayOf(async () => {
          throw Object.assign(new Error("x"), { code: "FORBIDDEN" });
        })}
      />
    );
    expect(
      forbidden.querySelector("[data-operator-access='required']")
    ).not.toBeNull();
    const unconfigured = await mount(
      <DeploymentsWorkspace
        gateway={gatewayOf(async () => {
          throw Object.assign(new Error("x"), { code: "NOT_CONFIGURED" });
        })}
      />
    );
    return expect(
      unconfigured.querySelector("[data-deployment-state='not-configured']")
    ).not.toBeNull();
  });

  it("stops polling after 403 and 401; Reload asks again after a 401", async () => {
    vi.useFakeTimers();
    const forbiddenGateway = gatewayOf(async () => {
      throw Object.assign(new Error("x"), { code: "FORBIDDEN" });
    });
    const forbidden = await mount(
      <DeploymentsWorkspace gateway={forbiddenGateway} refreshMs={1000} />
    );
    expect(
      forbidden
        .querySelector("[data-operator-access='required']")
        ?.getAttribute("data-operator-feature")
    ).toBe("deployments");
    await act(async () => {
      vi.advanceTimersByTime(5000);
      document.dispatchEvent(new Event("visibilitychange"));
      return await flush();
    });
    expect(forbiddenGateway.status).toHaveBeenCalledTimes(1);

    const expiredGateway = gatewayOf(async () => {
      throw Object.assign(new Error("x"), { code: "UNAUTHORIZED" });
    });
    const expired = await mount(
      <DeploymentsWorkspace gateway={expiredGateway} refreshMs={1000} />
    );
    await act(async () => {
      vi.advanceTimersByTime(5000);
      return await flush();
    });
    expect(expiredGateway.status).toHaveBeenCalledTimes(1);
    const reload = [...expired.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === "Reload"
    );
    await act(async () => {
      reload?.click();
      return await flush();
    });
    return expect(expiredGateway.status).toHaveBeenCalledTimes(2);
  });

  return it("reloads on demand and auto-refreshes while visible", async () => {
    vi.useFakeTimers();
    const gateway = gatewayOf(async () =>
      status([neverStartedNautilus, healthyGateway])
    );
    const container = await mount(
      <DeploymentsWorkspace
        gateway={gateway}
        now={() => now}
        refreshMs={1000}
      />
    );
    expect(gateway.status).toHaveBeenCalledTimes(1);
    const reload = [...container.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === "Reload"
    )!;
    await act(async () => {
      reload.click();
      return await flush();
    });
    expect(gateway.status).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1000);
      return await flush();
    });
    return expect(gateway.status).toHaveBeenCalledTimes(3);
  });
});

const v2Status = (
  overrides: Partial<DeploymentStatusOutput> = {}
): DeploymentStatusOutput => {
  const fixture = structuredClone(v2Fixture) as unknown as Record<
    string,
    unknown
  >;
  return {
    ...status([neverStartedNautilus, healthyGateway], true),
    session: fixture["session"] as DeploymentStatusOutput["session"],
    positions: fixture["positions"] as DeploymentStatusOutput["positions"],
    orders: fixture["orders"] as DeploymentStatusOutput["orders"],
    fills: fixture["fills"] as DeploymentStatusOutput["fills"],
    equity: fixture["equity"] as DeploymentStatusOutput["equity"],
    risk: fixture["risk"] as DeploymentStatusOutput["risk"],
    logs: fixture["logs"] as DeploymentStatusOutput["logs"],
    ...overrides,
  };
};

const clickTab = async (container: HTMLElement, tab: string) => {
  const button = container.querySelector<HTMLButtonElement>(
    `[role='tab'][data-tab='${tab}']`
  )!;
  return await act(async () => {
    button.click();
    return await flush();
  });
};

describe("DeploymentsWorkspace v2 snapshot", () => {
  it("renders the status strip, session chip with raw-state tooltip and the kill switch", async () => {
    const container = await mount(
      <DeploymentsWorkspace
        gateway={gatewayOf(async () => v2Status())}
        now={() => now}
      />
    );
    const chip = container.querySelector("[data-session-state]")!;
    expect(chip.getAttribute("data-session-state")).toBe("stopped");
    expect(chip.getAttribute("title")).toContain("container created");
    expect(chip.getAttribute("title")).toContain(
      "last runner event runner_stopped"
    );
    expect(
      container.querySelector("[data-strip-field='account']")?.textContent
    ).toContain("****0042");
    expect(
      container.querySelector("[data-strip-field='strategies']")?.textContent
    ).toContain("example_strategy");
    expect(
      container.querySelector("[data-strip-field='symbols']")?.textContent
    ).toContain("AAPL");
    expect(
      container.querySelector("[data-strip-field='stopped']")?.textContent
    ).toContain("2026-09-25 16:38:44 UTC");
    expect(
      container.querySelector(
        "[data-strip-field='age'] [data-deployment-block-stale]"
      )
    ).not.toBeNull();
    expect(container.querySelector("[data-kill-switch]")?.textContent).toBe(
      "Kill switch clear"
    );
    expect(
      container.querySelector("[data-risk-limits]")?.textContent
    ).toContain("nautilus_risk_max_daily_loss_usd");
    expect(
      container.querySelector("[data-risk-last-check]")?.textContent
    ).toContain("risk_order_approved");
    expect(container.querySelector("[data-watchdog-status]")?.textContent).toBe(
      "degraded"
    );
    return expect(
      container.querySelector("[data-watchdog-check='ib_gateway']")?.textContent
    ).toContain("ibapi handshake timeout");
  });

  it("switches tabs by click and keyboard, writes ?tab= and shows source, as_of and stale per tab", async () => {
    const container = await mount(
      <DeploymentsWorkspace
        gateway={gatewayOf(async () => v2Status())}
        now={() => now}
      />
    );
    expect(
      container.querySelector("[data-deployment-panel='positions']")
    ).not.toBeNull();
    expect(container.querySelectorAll("[data-position-row]")).toHaveLength(2);
    expect(
      container.querySelector(
        "[data-deployment-block='positions'] [data-deployment-block-meta]"
      )?.textContent
    ).toContain("as of 2026-09-18 20:15:50 UTC");
    expect(
      container.querySelector(
        "[data-deployment-block='positions'] [data-deployment-block-stale]"
      )
    ).not.toBeNull();
    await clickTab(container, "orders");
    expect(window.location.search).toBe("?tab=orders");
    expect(
      container.querySelector("[data-order-row='AMZN']")?.textContent
    ).toContain("200.25");
    const tablist = container.querySelector("[role='tablist']")!;
    await act(async () => {
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      );
      return await flush();
    });
    expect(
      container.querySelector("[data-deployment-panel='fills']")
    ).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-tab")).toBe("fills");
    await clickTab(container, "equity");
    expect(container.querySelector("[data-equity]")?.textContent).toContain(
      "150,000.25"
    );
    await clickTab(container, "logs");
    expect(container.querySelectorAll("[data-log-row]")).toHaveLength(9);
    await clickTab(container, "services");
    expect(
      container.querySelector("[data-deployment-service='ib-gateway']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-deployment-scroll='services']")?.className
    ).toContain("overflow-x-auto");
    await clickTab(container, "positions");
    expect(window.location.search).toBe("");
    expect(deploymentTabKeyTarget("ArrowLeft", "positions")).toBe("services");
    return expect(deploymentTabKeyTarget("End", "positions")).toBe("services");
  });

  it("restores the tab from ?tab= deep links", async () => {
    window.history.replaceState(null, "", "/deployments?tab=logs");
    const container = await mount(
      <DeploymentsWorkspace
        gateway={gatewayOf(async () => v2Status())}
        now={() => now}
      />
    );
    return expect(
      container
        .querySelector("[role='tab'][aria-selected='true']")
        ?.getAttribute("data-tab")
    ).toBe("logs");
  });

  it("shows server reasons for unavailable blocks and keeps the kill switch visible", async () => {
    const withheld = {
      available: false as const,
      source: "guard",
      reason: "withheld: leak pattern",
    };
    const container = await mount(
      <DeploymentsWorkspace
        gateway={gatewayOf(async () =>
          v2Status({ positions: withheld, risk: withheld, session: withheld })
        )}
        now={() => now}
      />
    );
    expect(
      container.querySelector("[data-deployment-unavailable='positions']")
        ?.textContent
    ).toBe("Unavailable: withheld: leak pattern");
    expect(
      container.querySelector("[data-deployment-unavailable='risk']")
        ?.textContent
    ).toContain("withheld");
    expect(
      container
        .querySelector("[data-kill-switch]")
        ?.getAttribute("data-kill-switch")
    ).toBe("unknown");
    return expect(
      container
        .querySelector("[data-session-state]")
        ?.getAttribute("data-session-state")
    ).toBe("unknown");
  });

  it("falls back to v1 with the snapshot error and an engaged kill switch is prominent", async () => {
    const fallback = {
      ...status([neverStartedNautilus, healthyGateway]),
      snapshotError:
        "Tailnet snapshot unavailable: Status endpoint returned HTTP 403",
    };
    const container = await mount(
      <DeploymentsWorkspace
        gateway={gatewayOf(async () => fallback)}
        now={() => now}
      />
    );
    expect(
      container.querySelector("[data-deployment-snapshot-error]")?.textContent
    ).toContain("HTTP 403");
    expect(
      container.querySelector("[data-deployment-unavailable='positions']")
        ?.textContent
    ).toContain("HTTP 403");
    expect(
      container
        .querySelector("[data-kill-switch]")
        ?.getAttribute("data-kill-switch")
    ).toBe("unknown");
    const engagedRisk = {
      ...(v2Fixture.risk as object),
      kill_switch: "engaged",
    } as unknown as DeploymentStatusOutput["risk"];
    const halted = await mount(
      <DeploymentsWorkspace
        gateway={gatewayOf(async () => v2Status({ risk: engagedRisk }))}
        now={() => now}
      />
    );
    const kill = halted.querySelector("[data-kill-switch]")!;
    expect(kill.textContent).toBe("Kill switch engaged");
    return expect(kill.className).toContain("text-destructive");
  });

  return it("uses 44px tab targets", async () => {
    const container = await mount(
      <DeploymentsWorkspace
        gateway={gatewayOf(async () => v2Status())}
        now={() => now}
      />
    );
    for (const tab of container.querySelectorAll("[role='tab']")) {
      expect(tab.className).toContain("min-h-11");
    }
  });
});
