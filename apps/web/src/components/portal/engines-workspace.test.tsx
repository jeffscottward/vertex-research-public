// @vitest-environment jsdom
import type { ApiClient, EnginesStatusOutput } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
    runtime.origins.push(options.baseUrl);
    return runtime.client as ApiClient;
  }),
}));

import {
  createBrowserEnginesGateway,
  ENGINES_REFRESH_MS,
  EnginesWorkspace,
  engineHealth,
} from "./engines-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  runtime.client = null;
  runtime.origins.length = 0;
  vi.useRealTimers();
});

const engine = (
  overrides: Partial<EnginesStatusOutput["engines"][number]> = {}
) => ({
  unit: "market-watch-gex",
  timerActive: true,
  serviceState: "inactive",
  result: "success",
  exitStatus: 0,
  lastRunAt: "2026-11-02T14:59:00.000Z",
  lastExitAt: "2026-11-02T14:59:05.000Z",
  nextRunAt: "2026-11-02T15:14:00.000Z",
  ...overrides,
});

const ready = (
  overrides: Partial<EnginesStatusOutput> = {}
): EnginesStatusOutput => ({
  generatedAt: "2026-11-02T14:59:30.000Z",
  stale: false,
  engines: [
    engine(),
    engine({
      unit: "market-watch-news",
      serviceState: "failed",
      result: "exit-code",
      exitStatus: 2,
      nextRunAt: null,
    }),
  ],
  ...overrides,
});

const mount = async (element: React.ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

describe("engine health", () => {
  it("ranks failed, running, timer off and OK", () => {
    expect(engineHealth(engine({ serviceState: "failed" })).label).toBe(
      "Failed"
    );
    expect(engineHealth(engine({ result: "timeout" })).label).toBe("Failed");
    expect(engineHealth(engine({ serviceState: "active" })).label).toBe(
      "Running"
    );
    expect(engineHealth(engine({ serviceState: "activating" })).tone).toBe(
      "info"
    );
    expect(engineHealth(engine({ timerActive: false })).label).toBe(
      "Timer off"
    );
    expect(engineHealth(engine()).label).toBe("OK");
  });
});

describe("EnginesWorkspace", () => {
  it("lists engines with state, runs and the exit code of a failure", async () => {
    const container = await mount(
      <EnginesWorkspace gateway={{ status: async () => ready() }} />
    );
    const news = container.querySelector('[data-engine="market-watch-news"]');
    expect(news?.querySelector("[data-health]")?.textContent).toContain(
      "Failed"
    );
    expect(news?.textContent).toContain("exit-code (exit 2)");
    expect(news?.textContent).toContain("—");
    const mobile = news?.querySelector("[data-engine-runs-mobile]");
    expect(mobile?.textContent).toMatch(/^Last .+ · Next — · exit-code$/u);
    expect(
      container.querySelector(
        '[data-engine="market-watch-gex"] [data-engine-runs-mobile]'
      )?.textContent
    ).not.toContain("success");
    expect(
      container
        .querySelector('[data-engine="market-watch-gex"]')
        ?.textContent?.includes("(exit")
    ).toBe(false);
    expect(container.querySelector("[data-engines-stale]")).toBeNull();
  });

  it("warns when the push is stale and handles an empty list", async () => {
    const stale = await mount(
      <EnginesWorkspace
        gateway={{ status: async () => ready({ stale: true }) }}
      />
    );
    expect(stale.querySelector("[data-engines-stale]")).not.toBeNull();
    const empty = await mount(
      <EnginesWorkspace
        gateway={{ status: async () => ready({ engines: [] }) }}
      />
    );
    expect(empty.textContent).toContain("No engine timers found.");
  });

  it("shows failures with a retry and access-required for non-operators", async () => {
    let fail = true;
    const container = await mount(
      <EnginesWorkspace
        gateway={{
          status: async () => {
            if (fail)
              throw {
                code: "UNAVAILABLE",
                message: "No engine status pushed yet",
              };
            return ready();
          },
        }}
      />
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "UNAVAILABLE: No engine status pushed yet"
    );
    fail = false;
    await act(async () => container.querySelector("button")?.click());
    expect(
      container.querySelector('[data-engines-state="ready"]')
    ).not.toBeNull();
    const denied = await mount(
      <EnginesWorkspace
        gateway={{
          status: async () => {
            throw { code: "FORBIDDEN", status: 403, message: "Forbidden" };
          },
        }}
      />
    );
    expect(
      denied
        .querySelector("[data-operator-feature]")
        ?.getAttribute("data-operator-feature")
    ).toBe("engines");
  });

  it("shows loading first and refreshes once a minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let resolveFirst: (value: EnginesStatusOutput) => void = () => undefined;
    const pending = new Promise<EnginesStatusOutput>((resolve) => {
      resolveFirst = resolve;
    });
    const status = vi.fn(() => pending);
    const container = await mount(<EnginesWorkspace gateway={{ status }} />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Loading engine status…"
    );
    await act(async () => resolveFirst(ready()));
    await act(async () => {
      vi.advanceTimersByTime(ENGINES_REFRESH_MS);
    });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const status = vi.fn(async () => ready());
    runtime.client = { engines: { status } } as unknown as ApiClient;
    const gateway = createBrowserEnginesGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.status();
    await gateway.status();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(Object.isFrozen(gateway)).toBe(true);
    await mount(<EnginesWorkspace />);
    expect(status).toHaveBeenCalledTimes(3);
  });
});
