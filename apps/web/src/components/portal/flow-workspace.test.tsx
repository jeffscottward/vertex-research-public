// @vitest-environment jsdom
import type { ApiClient, FlowSnapshot } from "@darkfactory/api";
import { act, type ReactElement } from "react";
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

import type { FlowRequest } from "../../features/flow/view-model.ts";
import { labFlowSnapshot } from "../../lab/fixtures/flow.ts";
import {
  createBrowserFlowGateway,
  type FlowGateway,
  FlowWorkspace,
} from "./flow-workspace.tsx";

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

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

const flush = () => act(async () => await Promise.resolve());

const fixed = (
  snapshot: (request: FlowRequest) => FlowSnapshot | Promise<FlowSnapshot>
) => {
  const calls: FlowRequest[] = [];
  const gateway: FlowGateway = {
    snapshot: async (request) => {
      calls.push(request);
      return await snapshot(request);
    },
  };
  return { calls, gateway };
};

const button = (container: HTMLElement, name: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name
  );
  if (found === undefined) throw new Error(`Missing button ${name}`);
  return found;
};

const click = (element: HTMLElement) => act(async () => element.click());

const empty: FlowSnapshot = {
  ...labFlowSnapshot("SPY", 60),
  confluence: {
    bearish: 0,
    bullish: 0,
    factors: [],
    known: 0,
    label: "Not enough data",
    summary: "insufficient",
  },
  events: [],
  freshness: (["ticks", "depth", "options", "gex"] as const).map((source) => ({
    ageSeconds: null,
    lastOkAt: null,
    lastStatus: null,
    message: null,
    sessionOpen: false,
    source,
    state: "never" as const,
  })),
  gex: null,
  minutes: [],
  notes: [],
  optionsFlow: { ...labFlowSnapshot("SPY", 60).optionsFlow, trades: 0 },
  orderFlow: { ...labFlowSnapshot("SPY", 60).orderFlow, book: null },
};

describe("createBrowserFlowGateway", () => {
  it("creates one client on first use and calls flow.snapshot", async () => {
    const snapshot = vi.fn(async () => labFlowSnapshot("SPY", 60));
    runtime.client = { flow: { snapshot } } as unknown as ApiClient;
    const gateway = createBrowserFlowGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.snapshot({ minutes: 60, symbol: "SPY" });
    await gateway.snapshot({ minutes: 120, symbol: "ES" });
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(snapshot).toHaveBeenCalledWith({ minutes: 60, symbol: "SPY" });
    expect(snapshot).toHaveBeenCalledWith({ minutes: 120, symbol: "ES" });
  });

  it("is the default gateway of the workspace", async () => {
    const snapshot = vi.fn(async () => labFlowSnapshot("SPY", 120));
    runtime.client = { flow: { snapshot } } as unknown as ApiClient;
    const container = await render(<FlowWorkspace />);
    await vi.waitFor(() =>
      expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull()
    );
    expect(snapshot).toHaveBeenCalledWith({ minutes: 120, symbol: "SPY" });
  });
});

describe("FlowWorkspace", () => {
  it("shows every section of a SPY snapshot with its as-of stamp", async () => {
    const { calls, gateway } = fixed(({ minutes, symbol }) =>
      labFlowSnapshot(symbol, minutes)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    expect(calls).toEqual([{ minutes: 120, symbol: "SPY" }]);
    await vi.waitFor(() =>
      expect(
        container
          .querySelector("[data-flow-state]")
          ?.getAttribute("data-flow-state")
      ).toBe("idle")
    );
    const text = container.textContent ?? "";
    expect(container.querySelector("[data-flow-as-of]")?.textContent).toContain(
      "As of Oct 30, 4:00 PM EDT"
    );
    expect(text).toContain("generated Oct 30, 4:00 PM EDT");
    expect(text).toContain("Auto-refreshes every 60 s.");
    expect(container.querySelectorAll("[data-flow-source]")).toHaveLength(4);
    expect(
      container.querySelector('[data-flow-source="options"] [data-freshness]')
        ?.textContent
    ).toContain("stale");
    expect(text).toContain("No new prints since the last sample.");
    expect(container.querySelector("[data-flow-never]")).toBeNull();
    expect(
      container.querySelector('[data-flow-confluence="agree_bullish"]')
        ?.textContent
    ).toContain("Agree: bullish");
    expect(text).toContain("not a trade signal");
    expect(container.querySelectorAll("[data-flow-factor]")).toHaveLength(4);
    expect(
      container.querySelector('[data-flow-metrics="order-flow"]')?.textContent
    ).toContain("Off-exchange share");
    expect(
      container.querySelectorAll("[data-flow-bar]").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-gap]").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-cvd-segment]").length
    ).toBeGreaterThan(1);
    expect(
      container.querySelector('[data-flow-metrics="book"]')
    ).not.toBeNull();
    expect(text).toContain("Options flow (SPY)");
    expect(container.querySelectorAll("[data-flow-print]")).toHaveLength(2);
    expect(
      container.querySelector(
        '[role="region"][aria-label^="Top option prints"]'
      )
    ).not.toBeNull();
    expect(text).toContain("golden sweep");
    expect(container.querySelector("[data-flow-basis]")?.textContent).toBe(
      "Levels come from SPY options, already in SPY price."
    );
    expect(
      container.querySelectorAll('[data-flow-level="flip"] td')
    ).toHaveLength(1);
    expect(container.querySelectorAll("[data-flow-event]")).toHaveLength(2);
    expect(container.querySelector("[data-flow-notes]")?.textContent).toContain(
      "Fictional lab data"
    );
    expect(button(container, "SPY").getAttribute("aria-pressed")).toBe("true");
  });

  it("switches symbol and window and refreshes on demand", async () => {
    const { calls, gateway } = fixed(({ minutes, symbol }) =>
      labFlowSnapshot(symbol, minutes)
    );
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await flush();
    await click(button(container, "SPY"));
    expect(calls).toHaveLength(1);

    await click(button(container, "ES"));
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-flow-snapshot="ES"]')
      ).not.toBeNull()
    );
    expect(calls.at(-1)).toEqual({ minutes: 120, symbol: "ES" });
    const text = container.textContent ?? "";
    expect(text).toContain("Options flow (SPX)");
    expect(text).toContain("ES options flow is read from SPX options.");
    expect(text).not.toContain("Off-exchange share");
    expect(container.querySelector("[data-flow-basis]")?.textContent).toContain(
      "basis of +18.50"
    );
    expect(
      container.querySelectorAll('[data-flow-level="flip"] td')
    ).toHaveLength(2);

    const select = container.querySelector(
      "[data-flow-window]"
    ) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "60 min",
      "120 min",
      "240 min",
      "390 min (full session)",
    ]);
    await act(async () => {
      select.value = "240";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(calls.at(-1)).toEqual({ minutes: 240, symbol: "ES" });

    const before = calls.length;
    await click(
      container.querySelector("[data-flow-refresh]") as HTMLButtonElement
    );
    await flush();
    expect(calls).toHaveLength(before + 1);
  });

  it("refreshes on its timer", async () => {
    vi.useFakeTimers();
    const { calls, gateway } = fixed(({ minutes, symbol }) =>
      labFlowSnapshot(symbol, minutes)
    );
    const container = await render(
      <FlowWorkspace gateway={gateway} refreshMs={5000} />
    );
    await flush();
    expect(container.textContent).toContain("Auto-refreshes every 5 s.");
    expect(calls).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(calls).toHaveLength(2);
  });

  it("explains a never-collected symbol and empty sections", async () => {
    const { gateway } = fixed(() => empty);
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull()
    );
    expect(container.querySelector("[data-flow-never]")?.textContent).toContain(
      "Nothing has been collected for SPY yet"
    );
    expect(
      [...container.querySelectorAll("[data-flow-empty]")].map((item) =>
        item.getAttribute("data-flow-empty")
      )
    ).toEqual(["factors", "minutes", "book", "options", "gex", "events"]);
    const text = container.textContent ?? "";
    expect(text).toContain("never collected");
    expect(text).toContain("no samples yet");
    expect(container.querySelector("[data-flow-chart]")).toBeNull();
    expect(container.querySelector("[data-flow-notes]")).toBeNull();
  });

  it("explains option flow without top prints", async () => {
    const base = labFlowSnapshot("SPY", 60);
    const { gateway } = fixed(() => ({
      ...base,
      optionsFlow: { ...base.optionsFlow, topPrints: [] },
    }));
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-flow-empty="prints"]')
      ).not.toBeNull()
    );
    expect(
      container.querySelector('[data-flow-metrics="options"]')
    ).not.toBeNull();
  });

  it("shows a dash for a print without flags", async () => {
    const base = labFlowSnapshot("SPY", 60);
    const [print] = base.optionsFlow.topPrints;
    const { gateway } = fixed(() => ({
      ...base,
      optionsFlow: {
        ...base.optionsFlow,
        topPrints: [
          {
            ...(print as FlowSnapshot["optionsFlow"]["topPrints"][number]),
            goldenSweep: false,
            moneyness: "unknown",
            opening: false,
            unusual: false,
            volumeOverOi: false,
          },
        ],
      },
    }));
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(container.querySelector("[data-flow-print]")).not.toBeNull()
    );
    expect(
      container.querySelector("[data-flow-print] td:last-child")?.textContent
    ).toBe("—");
  });

  it("shows operator access required when the API forbids it", async () => {
    const { gateway } = fixed(() => {
      throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
    });
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(
        container
          .querySelector("[data-operator-access]")
          ?.getAttribute("data-operator-feature")
      ).toBe("flow")
    );
  });

  it("shows an error, then recovers on refresh", async () => {
    let fail = true;
    const { gateway } = fixed(() => {
      if (fail)
        throw { code: "STORAGE_ERROR", message: "Flow storage unavailable" };
      return labFlowSnapshot("SPY", 120);
    });
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Flow snapshot unavailable. STORAGE_ERROR: Flow storage unavailable"
      )
    );
    expect(container.querySelector("[data-flow-snapshot]")).toBeNull();

    fail = false;
    await click(
      container.querySelector("[data-flow-refresh]") as HTMLButtonElement
    );
    await vi.waitFor(() =>
      expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull()
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();

    fail = true;
    await click(
      container.querySelector("[data-flow-refresh]") as HTMLButtonElement
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Refresh failed (STORAGE_ERROR: Flow storage unavailable). Showing the last snapshot, as of Oct 30, 4:00 PM EDT."
      )
    );
    expect(container.querySelector("[data-flow-snapshot]")).not.toBeNull();
  });

  it("ignores answers to requests a newer one replaced", async () => {
    // Promise.withResolvers is outside the ES2023 lib of this package.
    const pending: {
      resolve: (value: FlowSnapshot) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const { calls, gateway } = fixed(({ minutes, symbol }) => {
      if (symbol === "ES") return labFlowSnapshot("ES", minutes);
      return new Promise<FlowSnapshot>((resolve, reject) => {
        pending.push({ reject, resolve });
      });
    });
    const container = await render(<FlowWorkspace gateway={gateway} />);
    await click(button(container, "ES"));
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-flow-snapshot="ES"]')
      ).not.toBeNull()
    );
    await act(async () => pending[0]?.resolve(labFlowSnapshot("SPY", 120)));
    await flush();
    expect(container.querySelector('[data-flow-snapshot="ES"]')).not.toBeNull();
    expect(
      container
        .querySelector("[data-flow-state]")
        ?.getAttribute("data-flow-state")
    ).toBe("idle");

    await click(button(container, "SPY"));
    await click(button(container, "ES"));
    await act(async () => pending[1]?.reject(new Error("late failure")));
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-flow-snapshot="ES"]')
      ).not.toBeNull()
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(calls.map((call) => call.symbol)).toEqual([
      "SPY",
      "ES",
      "SPY",
      "ES",
    ]);
  });
});
