// @vitest-environment jsdom
import {
  type ApiClient,
  PORTFOLIO_MONITOR_MAX_ROWS,
  type PortfolioMonitorExecution,
  type PortfolioMonitorOutput,
  type PortfolioMonitorStatus,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
}));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn(() => runtime.client as ApiClient),
}));

import {
  JOURNAL_WINDOW_NOTICE,
  JournalReport,
  TradeJournal,
} from "./trade-journal.tsx";
import { CumulativeRealizedChart } from "./trade-journal-chart.tsx";

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
});

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

const fill = (
  overrides: Partial<PortfolioMonitorExecution> = {}
): PortfolioMonitorExecution => ({
  avgPrice: 100,
  commission: 1,
  exchange: "SMART",
  execId: "e1",
  localSymbol: "",
  permId: null,
  orderRef: "",
  price: 100,
  realized: 0,
  secType: "STK",
  shares: 10,
  side: "BOT",
  symbol: "AAPL",
  time: "20261009 09:30:00 US/Eastern",
  ...overrides,
});

const EXECUTIONS = [
  fill({ execId: "b1", time: "20261009 09:30:00 US/Eastern" }),
  fill({
    commission: 1.2,
    execId: "s1",
    realized: 25,
    side: "SLD",
    time: "20261009 10:30:00 US/Eastern",
  }),
  fill({
    commission: null,
    execId: "m1",
    realized: -5,
    side: "SLD",
    symbol: "MSFT",
    time: "20261009 10:00:00 US/Eastern",
  }),
];

const snapshotWith = (
  executions: readonly PortfolioMonitorExecution[]
): PortfolioMonitorOutput =>
  ({ executions: [...executions] }) as unknown as PortfolioMonitorOutput;

const text = (container: HTMLElement) => container.textContent ?? "";

describe("CumulativeRealizedChart", () => {
  it("says so when nothing closed", async () => {
    const container = await render(<CumulativeRealizedChart points={[]} />);
    expect(container.querySelector('[data-chart="empty"]')).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("draws the running total with a labelled SVG", async () => {
    const one = await render(
      <CumulativeRealizedChart points={[{ time: "t", value: -4 }]} />
    );
    expect(one.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Cumulative realized P&L: -$4.00 after 1 closing fill"
    );
    expect(one.querySelector("svg")?.getAttribute("class")).toContain(
      "text-destructive"
    );
    const two = await render(
      <CumulativeRealizedChart
        points={[
          { time: "a", value: 10 },
          { time: "b", value: 20 },
        ]}
      />
    );
    expect(two.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Cumulative realized P&L: +$20.00 after 2 closing fills"
    );
    expect(two.querySelector('[data-line="realized"]')?.getAttribute("d")).toBe(
      "M0 160 L300 80 L600 0"
    );
  });
});

describe("JournalReport", () => {
  it("shows an empty state without fills", async () => {
    const container = await render(<JournalReport executions={[]} />);
    expect(text(container)).toContain("No fills yet");
  });

  it("shows KPIs, chart, per-symbol rows and fills oldest first", async () => {
    const container = await render(<JournalReport executions={EXECUTIONS} />);
    const totals = container.querySelector('[aria-label="Journal totals"]');
    expect(totals?.textContent).toContain("Fills3");
    expect(totals?.textContent).toContain("+$20.00");
    expect(totals?.textContent).toContain("$2.20");
    expect(totals?.textContent).toContain("50%");
    expect(totals?.textContent).toContain("1 won · 1 lost");
    expect(totals?.textContent).toContain("+$25.00");
    expect(totals?.textContent).toContain("-$5.00");
    expect(
      container.querySelector('[data-chart="cumulative-realized"]')
    ).not.toBeNull();
    expect(
      [...container.querySelectorAll("[data-symbol]")].map((row) =>
        row.getAttribute("data-symbol")
      )
    ).toEqual(["AAPL", "MSFT"]);
    const aapl = container.querySelector('[data-symbol="AAPL"]');
    expect(aapl?.textContent).toContain("+$25.00");
    expect(
      [...container.querySelectorAll("[data-exec-id]")].map((row) =>
        row.getAttribute("data-exec-id")
      )
    ).toEqual(["b1", "m1", "s1"]);
    const first = container.querySelector('[data-exec-id="b1"]');
    expect(first?.textContent).toContain("2026-10-09 09:30:00 US/Eastern");
    expect(first?.textContent).toContain("Buy");
    expect(
      container.querySelector('[data-exec-id="m1"]')?.textContent
    ).toContain("—");
    expect(
      container
        .querySelector('a[data-slot="ticker-link"]')
        ?.getAttribute("href")
    ).toContain("AAPL");
  });
});

describe("JournalReport status and contracts", () => {
  const status = (
    overrides: Partial<PortfolioMonitorStatus> = {}
  ): PortfolioMonitorStatus => ({
    clientId: 78,
    connected: true,
    dataAsOf: "2026-10-09T14:00:00.000Z",
    gateway: "live",
    generatedAt: "2026-10-09T14:00:00.000Z",
    lastError: null,
    ordersAsOf: null,
    receivedAt: "2026-10-09T14:00:00.000Z",
    since: "2026-10-09T13:00:00.000Z",
    ...overrides,
  });

  it("explains an empty window by gateway state", async () => {
    const offline = await render(
      <JournalReport
        executions={[]}
        status={status({ connected: false, dataAsOf: null })}
      />
    );
    expect(text(offline)).toContain("Fills withheld");
    expect(text(offline)).not.toContain("No fills yet");
    const note = offline.querySelector("[data-journal-connected]");
    expect(note?.getAttribute("data-journal-connected")).toBe("false");
    expect(note?.textContent).toContain(
      "The IBKR gateway is disconnected, so account data is withheld until it reconnects."
    );
    expect(text(offline)).not.toMatch(/unknown/i);
    // The API shape of an account mode mismatch: gateway live, lists emptied, not connected.
    const mismatch = await render(
      <JournalReport
        account={{
          mode: null,
          modeSource: null,
          modeConfirmedAt: null,
          modeError: "mismatch",
          count: 0,
        }}
        executions={[]}
        status={status({ connected: false, dataAsOf: null })}
      />
    );
    expect(text(mismatch)).toContain("Fills withheld");
    expect(text(mismatch)).toContain("does not match its configured mode");
    expect(text(mismatch)).not.toContain("disconnected");
    const noTime = await render(
      <JournalReport executions={[]} status={status({ dataAsOf: null })} />
    );
    expect(noTime.querySelector("[data-journal-connected]")?.textContent).toBe(
      "Gateway connected · IBKR has sent no data time yet"
    );
    const online = await render(
      <JournalReport executions={[]} status={status()} />
    );
    expect(text(online)).toContain("IBKR reported no fills");
    const connected = online.querySelector("[data-journal-connected]");
    expect(connected?.getAttribute("data-journal-connected")).toBe("true");
    expect(connected?.textContent).toContain("Gateway connected");
    expect(connected?.textContent).toContain("2026-10-09T14:00:00.000Z");
  });

  it("warns when the fill list hit the row cap", async () => {
    const capped = Array.from({ length: PORTFOLIO_MONITOR_MAX_ROWS }, (_, i) =>
      fill({ execId: `c${i}` })
    );
    const container = await render(
      <JournalReport executions={capped} status={status()} />
    );
    expect(
      container.querySelector('[data-journal-notice="cap"]')?.textContent
    ).toContain(`first ${PORTFOLIO_MONITOR_MAX_ROWS} fills`);
    expect(container.querySelector("[data-journal-connected]")).not.toBeNull();
  });

  it("links stock rows and labels other contracts with their type", async () => {
    const container = await render(
      <JournalReport
        executions={[
          fill({ execId: "blank", secType: "", symbol: "SPY" }),
          fill({
            execId: "opt",
            localSymbol: "AAPL  261120C00200000",
            secType: "OPT",
          }),
        ]}
      />
    );
    const blank = container.querySelector('[data-sectype=""]');
    expect(blank?.querySelector('a[data-slot="ticker-link"]')).not.toBeNull();
    const option = container.querySelector('[data-sectype="OPT"]');
    expect(option?.querySelector('a[data-slot="ticker-link"]')).toBeNull();
    expect(option?.textContent).toContain("AAPL  261120C00200000 OPT");
  });
});

describe("TradeJournal", () => {
  it("shows not configured and sends nothing without a source", async () => {
    const load = vi.fn();
    const container = await render(<TradeJournal load={load} source={null} />);
    expect(load).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-journal-failure="not-configured"]')
    ).not.toBeNull();
    expect(text(container)).toContain("Not configured");
    expect(text(container)).toContain(JOURNAL_WINDOW_NOTICE);
    expect(container.querySelector("button")?.disabled).toBe(true);
  });

  it("loads the snapshot, then refreshes on demand", async () => {
    let resolve: (value: PortfolioMonitorOutput) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<PortfolioMonitorOutput>((done) => {
          resolve = done;
        })
    );
    const container = await render(
      <TradeJournal load={load} source="ibkr-monitor" />
    );
    expect(
      container.querySelector('[data-journal-state="loading"]')
    ).not.toBeNull();
    expect(container.querySelector("button")?.disabled).toBe(true);
    await act(async () => resolve(snapshotWith(EXECUTIONS)));
    expect(
      container.querySelector('[data-journal-state="ready"]')
    ).not.toBeNull();
    expect(container.querySelector('[data-journal="report"]')).not.toBeNull();
    await act(async () => container.querySelector("button")?.click());
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => resolve(snapshotWith([])));
    expect(text(container)).toContain("No fills yet");
  });

  it("shows the operator notice for a 403", async () => {
    const container = await render(
      <TradeJournal
        load={() => Promise.reject({ code: "FORBIDDEN", message: "no" })}
        source="ibkr-monitor"
      />
    );
    expect(
      container.querySelector('[data-operator-feature="ibkr-monitor"]')
    ).not.toBeNull();
  });

  it.each([
    ["NOT_CONFIGURED", "not-configured", "Not configured"],
    ["UNAVAILABLE", "unavailable", "did not answer"],
    ["UNAUTHORIZED", "unauthorized", "Session expired"],
    ["BOOM", "error", "could not load"],
  ])("explains a %s failure", async (code, kind, copy) => {
    const container = await render(
      <TradeJournal
        load={() => Promise.reject({ code, message: "upstream says no" })}
        source="portfolio-monitor"
      />
    );
    expect(
      container.querySelector(`[data-journal-failure="${kind}"]`)
    ).not.toBeNull();
    expect(text(container)).toContain(copy);
    expect(text(container)).toContain(`${code}: upstream says no`);
  });

  it("reads through the browser API client by default", async () => {
    const snapshot = vi.fn(async () => snapshotWith(EXECUTIONS));
    runtime.client = {
      portfolioMonitor: { snapshot },
    } as unknown as ApiClient;
    const container = await render(<TradeJournal source="portfolio-monitor" />);
    expect(snapshot).toHaveBeenCalledWith({});
    expect(container.querySelector('[data-journal="report"]')).not.toBeNull();
  });
});
