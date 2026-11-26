// @vitest-environment jsdom
import type { FlowControl, OptionsAnalyticsOutput } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LAB_NOW } from "../../lab/fixtures/core.ts";
import { labFlowControl } from "../../lab/fixtures/flow.ts";
import type { WallDriftAnalyticsState } from "../../features/flow/wall-drift-view-model.ts";
import { StockWallDrift, WallDriftBadge } from "./wall-drift-badge.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return {
    container,
    rerender: (next: ReactElement) => act(async () => root.render(next)),
  };
};

const MINUTE = 60_000;
const minutesAgo = (minutes: number): string =>
  new Date(LAB_NOW.getTime() - minutes * MINUTE).toISOString();

const analytics = (receivedAt = minutesAgo(1)): WallDriftAnalyticsState => ({
  analytics: {
    context: { levels: { callWall: 620, flip: 590, putWall: 600 } },
    receivedAt,
    spot: 600.4,
    symbol: "SPY",
  } as unknown as OptionsAnalyticsOutput,
  kind: "ready",
});

/** The sp500 document with SPY call drift rising over the last 15 minutes. */
const risingSpy = (): FlowControl => {
  const base = labFlowControl("sp500");
  const points = Array.from({ length: 16 }, (_, index) => ({
    longer: null,
    minute: minutesAgo(17 - index),
    total: { netCallPremiumUsd: index * 40_000, netPutPremiumUsd: 0 },
    underlyingPrice: 600.5,
    zeroDte: null,
  }));
  return {
    ...base,
    netDrift: base.netDrift.map((series) =>
      series.ticker === "SPY" ? { ...series, points } : series
    ),
  };
};

const now = () => LAB_NOW;
const read = (container: HTMLElement) =>
  container.querySelector("[data-wall-drift]");

describe("WallDriftBadge", () => {
  it("shows the label, context, rules version and collector note", async () => {
    const { container } = await mount(
      <WallDriftBadge
        view={{
          code: "window_short",
          collectorNote: "QuantData answered HTTP 401",
          context: "Wall not read",
          inputs:
            "no GEX levels read · no drift price read · gex-wall-drift-rules.v1",
          label: "No data",
          read: "no-data",
          reason: "net drift has less than 15 min this session",
          rulesVersion: "gex-wall-drift-rules.v1",
          ticker: null,
          tone: "info",
        }}
      />
    );
    const badge = read(container);
    expect(badge?.getAttribute("data-wall-drift")).toBe("no-data");
    expect(badge?.getAttribute("data-wall-drift-ticker")).toBe("");
    expect(badge?.getAttribute("data-wall-drift-code")).toBe("window_short");
    expect(badge?.textContent).toContain("Wall × drift");
    expect(badge?.textContent).toContain("No data");
    expect(badge?.textContent).toContain(
      "Unvalidated: study accruing · research only"
    );
    expect(
      container.querySelector("[data-wall-drift-context]")?.textContent
    ).toBe("Wall not read");
    expect(container.querySelector("h3")?.id).toBe(
      badge?.getAttribute("aria-labelledby")
    );
    expect(
      container.querySelector("[data-wall-drift-full-reason]")?.textContent
    ).toContain("collector: QuantData answered HTTP 401");
    expect(
      container.querySelector("[data-wall-drift-reason]")?.textContent
    ).toBe(
      "net drift has less than 15 min this session · collector: QuantData answered HTTP 401"
    );
    expect(
      container.querySelector("[data-wall-drift-inputs]")?.textContent
    ).toBe(
      "no GEX levels read · no drift price read · gex-wall-drift-rules.v1"
    );
    expect(
      container.querySelector("summary")?.classList.contains("min-h-11")
    ).toBe(true);
  });
});

describe("StockWallDrift", () => {
  it("loads the group's net drift and grades the read", async () => {
    const loadControl = vi.fn(async () => risingSpy());
    const { container } = await mount(
      <StockWallDrift
        analytics={analytics()}
        enabled
        loadControl={loadControl}
        now={now}
        symbol="SPY"
      />
    );
    expect(loadControl).toHaveBeenCalledWith({ group: "sp500" });
    expect(read(container)?.getAttribute("data-wall-drift")).toBe("hold-A");
    expect(read(container)?.getAttribute("data-wall-drift-ticker")).toBe("SPY");
    expect(
      container.querySelector("[data-wall-drift-context]")?.textContent
    ).toBe("Put wall 600 · above flip 590");
    expect(read(container)?.getAttribute("data-wall-drift-code")).toBe("");
  });

  it("shows the failure reason of flow.control", async () => {
    const { container } = await mount(
      <StockWallDrift
        analytics={analytics()}
        enabled
        loadControl={async () => {
          throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" });
        }}
        now={now}
        symbol="SPY"
      />
    );
    expect(read(container)?.getAttribute("data-wall-drift")).toBe("no-data");
    expect(
      container.querySelector("[data-wall-drift-reason]")?.textContent
    ).toBe("net drift not loaded: FORBIDDEN: Operator access required");
  });

  it("renders nothing for other symbols or accounts, and names a missing loader", async () => {
    const loadControl = vi.fn(async () => risingSpy());
    const other = await mount(
      <StockWallDrift
        analytics={analytics()}
        enabled
        loadControl={loadControl}
        now={now}
        symbol="AAPL"
      />
    );
    const member = await mount(
      <StockWallDrift
        analytics={analytics()}
        enabled={false}
        loadControl={loadControl}
        now={now}
        symbol="SPY"
      />
    );
    expect(loadControl).not.toHaveBeenCalled();
    expect(read(other.container)).toBeNull();
    expect(read(member.container)).toBeNull();
    const missing = await mount(
      <StockWallDrift
        analytics={analytics()}
        enabled
        loadControl={undefined}
        now={now}
        symbol="SPY"
      />
    );
    expect(
      missing.container.querySelector("[data-wall-drift-reason]")?.textContent
    ).toBe("net drift not loaded: this page does not load flow.control");
  });

  it("ignores a late answer after a new analytics answer or unmount", async () => {
    // The web tsconfig lib predates Promise.withResolvers, so the executor form keeps the callbacks.
    let resolveFirst: (control: FlowControl) => void = () => undefined;
    let rejectSecond: (reason: unknown) => void = () => undefined;
    const loadControl = vi
      .fn<() => Promise<FlowControl>>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
      )
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectSecond = reject;
        })
      );
    const view = await mount(
      <StockWallDrift
        analytics={analytics()}
        enabled
        loadControl={loadControl}
        now={now}
        symbol="SPY"
      />
    );
    expect(read(view.container)?.getAttribute("data-wall-drift")).toBe(
      "no-data"
    );
    await view.rerender(
      <StockWallDrift
        analytics={analytics(minutesAgo(0))}
        enabled
        loadControl={loadControl}
        now={now}
        symbol="SPY"
      />
    );
    await act(async () => resolveFirst(risingSpy()));
    expect(
      view.container.querySelector("[data-wall-drift-reason]")?.textContent
    ).toBe("net drift is loading");
    await act(async () => roots.splice(0)[0]?.unmount());
    await act(async () => rejectSecond(new Error("late")));
    expect(loadControl).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer on screen while a new analytics answer reloads", async () => {
    let resolveSecond: (control: FlowControl) => void = () => undefined;
    const loadControl = vi
      .fn<() => Promise<FlowControl>>()
      .mockResolvedValueOnce(risingSpy())
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        })
      );
    const view = await mount(
      <StockWallDrift
        analytics={analytics()}
        enabled
        loadControl={loadControl}
        now={now}
        symbol="SPY"
      />
    );
    await view.rerender(
      <StockWallDrift
        analytics={analytics(minutesAgo(0))}
        enabled
        loadControl={loadControl}
        now={now}
        symbol="SPY"
      />
    );
    expect(loadControl).toHaveBeenCalledTimes(2);
    expect(read(view.container)?.getAttribute("data-wall-drift")).toBe(
      "hold-A"
    );
    await act(async () => resolveSecond(risingSpy()));
    expect(read(view.container)?.getAttribute("data-wall-drift")).toBe(
      "hold-A"
    );
  });

  it("re-checks the read every minute so aged inputs turn into no data", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let clock = LAB_NOW;
      const { container } = await mount(
        <StockWallDrift
          analytics={analytics()}
          enabled
          loadControl={async () => risingSpy()}
          now={() => clock}
          symbol="SPY"
        />
      );
      expect(read(container)?.getAttribute("data-wall-drift")).toBe("hold-A");
      clock = new Date(LAB_NOW.getTime() + 10 * MINUTE);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(read(container)?.getAttribute("data-wall-drift-code")).toBe(
        "drift_stale"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends no request while options analytics is missing, then one per answer", async () => {
    const loadControl = vi.fn(async () => risingSpy());
    const missing: WallDriftAnalyticsState = {
      detail: "options analytics is loading",
      kind: "missing",
    };
    const view = await mount(
      <StockWallDrift
        analytics={missing}
        enabled
        loadControl={loadControl}
        now={now}
        symbol="SPY"
      />
    );
    expect(loadControl).not.toHaveBeenCalled();
    expect(
      view.container.querySelector("[data-wall-drift-reason]")?.textContent
    ).toBe("options analytics is loading");
    await view.rerender(
      <StockWallDrift
        analytics={analytics()}
        enabled
        loadControl={loadControl}
        now={now}
        symbol="SPY"
      />
    );
    expect(loadControl).toHaveBeenCalledTimes(1);
  });

  it("can render its title as a level-two heading", async () => {
    const { container } = await mount(
      <WallDriftBadge
        heading="h2"
        view={{
          code: null,
          collectorNote: null,
          context: "Put wall 600 · above flip 590",
          inputs:
            "no GEX levels read · no drift price read · gex-wall-drift-rules.v1",
          label: "Hold (A)",
          read: "hold-A",
          reason: "call drift rising",
          rulesVersion: "gex-wall-drift-rules.v1",
          ticker: "SPY",
          tone: "success",
        }}
      />
    );
    expect(container.querySelector("h2")?.textContent).toBe(
      "Wall × drift · SPY"
    );
  });

  it("uses the system clock by default", async () => {
    const { container } = await mount(
      <StockWallDrift
        analytics={analytics()}
        enabled
        loadControl={async () => risingSpy()}
        symbol="SPY"
      />
    );
    // LAB_NOW is in the past, so real time makes the lab GEX and drift stale.
    expect(read(container)?.getAttribute("data-wall-drift")).toBe("no-data");
  });
});
