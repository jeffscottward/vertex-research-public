// @vitest-environment jsdom
import type {
  ApiClient,
  ResearchScreenRow,
  ResearchScreenRun,
  ResearchScreenStatusOutput,
} from "@darkfactory/api";
import type { ReactElement } from "react";
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
  createBrowserResearchScreenGateway,
  RESEARCH_SCREEN_RELOAD_MS,
  type ResearchScreenGateway,
  ResearchScreenWorkspace,
} from "./research-screen.tsx";

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

const mount = async (element: ReactElement) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return { host, root };
};

// Synthetic fixtures: fictional symbols and values.
const AT = new Date("2026-11-13T14:30:00.000Z");

const run = (
  overrides: Partial<ResearchScreenRun> = {}
): ResearchScreenRun => ({
  barsFromIbkr: 10,
  barsFromYahoo: 1,
  claimedAt: AT,
  deadlineAt: AT,
  failed: 1,
  finishedAt: null,
  id: "run-1",
  message: null,
  notReached: 46,
  slotAt: AT,
  slotLabels: ["open"],
  status: "running",
  succeeded: 11,
  total: 58,
  ...overrides,
});

const row = (
  overrides: Partial<ResearchScreenRow> = {}
): ResearchScreenRow => ({
  action: "watch",
  barsSource: "ibkr",
  blockingWarnings: [],
  buyZone: { high: 103.5, low: 101 },
  changePercent: 1.2,
  collection: "fresh",
  errorCode: null,
  errorMessage: null,
  historyAt: AT,
  lastAttemptAt: AT,
  lastAttemptRunId: "run-1",
  lastGoodAt: AT,
  lastGoodRunId: "run-1",
  momentumPercent: 4,
  price: 102.5,
  providerSymbol: "AAA",
  quoteAgeMs: 11_520_000,
  quoteAt: AT,
  quoteSource: "yahoo",
  reasons: ["Price is inside the buy zone"],
  reportId: "AAA",
  rewardRisk: 2.5,
  score: 71,
  stop: 98,
  storedAction: "watch",
  storedScore: 70,
  support: 100,
  symbol: "AAA",
  target: 112,
  warnings: [],
  ...overrides,
});

const snapshot: NonNullable<
  NonNullable<ResearchScreenStatusOutput["swinglytics"]>["snapshot"]
> = {
  breadth: {
    above20DayPercent: 60,
    above50DayPercent: 55,
    above200DayPercent: 50,
    regime: "healthy",
    score: 64,
  },
  regime: { label: "Uptrend", riskLevel: "low", trendStrength: "strong" },
  scanner: { bearish: 12, bullish: 40, total: 500, withSetups: 52 },
  setups: [
    {
      direction: "bullish",
      name: "Demo Maker",
      pattern: "flag",
      sector: "Tech",
      ticker: "CCC",
    },
  ],
  themes: [
    { bias: "bullish", changePercent: 1.5, name: "Chips" },
    { bias: null, changePercent: null, name: "Banks" },
  ],
  vix: { level: 15.5, percentile1Year: 20, regime: "calm", trend: "down" },
};

const WARNING = "Third-party context only. Not an order signal.";

const status = (
  overrides: Partial<ResearchScreenStatusOutput> = {}
): ResearchScreenStatusOutput => ({
  activeRun: null,
  evaluatedAt: AT,
  lastRun: null,
  limitations: ["Screen values are research only."],
  missedSlots: [],
  nextSlots: Array.from({ length: 12 }, (_, index) => ({
    at: new Date(AT.getTime() + index * 1_800_000),
    labels: index === 0 ? ["open"] : [],
  })),
  rows: [row()],
  scheduler: { lastTickAt: AT, lastTickDecision: "not-due", state: "ok" },
  swinglytics: {
    generatedAt: AT,
    lastAttemptAt: AT,
    lastAttemptStatus: "ok",
    lastError: null,
    retrievedAt: AT,
    snapshot,
    stale: false,
    warning: WARNING,
  },
  ...overrides,
});

const full = (): ResearchScreenStatusOutput =>
  status({
    lastRun: run({
      finishedAt: AT,
      id: "run-0",
      message: "One provider timed out",
      slotLabels: [],
      status: "partial",
    }),
    missedSlots: [{ at: AT, labels: ["open"] }],
    rows: [
      row({ action: "review-entry", storedAction: "wait" }),
      row({
        action: "unavailable",
        blockingWarnings: [{ code: "old", text: "Quote is too old" }],
        collection: "failed",
        errorCode: "provider-timeout",
        reportId: "BBB",
        score: 0,
        storedAction: "review-entry",
        storedScore: 71,
        symbol: "BBB",
        warnings: ["Earnings in 3 days"],
      }),
    ],
    swinglytics: {
      generatedAt: AT,
      lastAttemptAt: AT,
      lastAttemptStatus: "error",
      lastError: "HTTP 503",
      retrievedAt: AT,
      snapshot,
      stale: true,
      warning: WARNING,
    },
  });

const gatewayOf = (
  read: ResearchScreenGateway["status"]
): ResearchScreenGateway => ({ status: read });

// The TypeScript lib of this app has no Promise.withResolvers.
const deferred = () => {
  let resolve: (value: ResearchScreenStatusOutput) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<ResearchScreenStatusOutput>(
    (onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    }
  );
  return { promise, reject, resolve };
};

const chip = (host: HTMLElement) =>
  host
    .querySelector('[data-slot="page-status"]')
    ?.textContent?.replace("Status:", "");
const stateOf = (host: HTMLElement) =>
  host
    .querySelector("[data-research-screen-state]")
    ?.getAttribute("data-research-screen-state");

const VAGUE =
  /\b(unknown|n\/a|unavailable|not available|not known|not set|unspecified|undetermined|tbd)\b/i;

describe("research screen workspace", () => {
  it("shows the loading state, then the full page", async () => {
    const pending = deferred();
    const { host } = await mount(
      <ResearchScreenWorkspace gateway={gatewayOf(() => pending.promise)} />
    );
    expect(stateOf(host)).toBe("loading");
    expect(host.querySelector("h1")?.textContent).toBe("Research screen");
    expect(chip(host)).toBe("Loading");
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(
      host.querySelector('nav[aria-label="Breadcrumb"] a')?.getAttribute("href")
    ).toBe("/research");

    await act(async () => pending.resolve(full()));
    expect(stateOf(host)).toBe("ready");
    expect(chip(host)).toBe("Scheduler running");
    const text = host.textContent ?? "";
    expect(text).toContain(
      "Last run: Run of Nov 13, 09:30 ET (14:30 UTC): 12 of 58 reports"
    );
    expect(text).toContain("Partial");
    expect(text).toContain("One provider timed out");
    expect(text).toContain("Missed in the last 24 hours");
    expect(host.querySelector("progress")).toBeNull();

    const table = host.querySelector("table");
    expect(table?.querySelector("caption")?.textContent).toContain(
      "Screen result per report"
    );
    expect(table?.querySelectorAll('th[scope="col"]')).toHaveLength(13);
    expect(
      [...(table?.querySelectorAll('th[scope="row"]') ?? [])].map(
        (cell) => cell.textContent
      )
    ).toEqual(["AAA", "BBB"]);
    expect(host.querySelector('[data-slot="table-scroll"]')).not.toBeNull();
    const first = host.querySelector('[data-research-screen-row="AAA"]');
    expect(first?.textContent).toContain("Review entry");
    expect(first?.textContent).toContain("Last action: Wait");
    expect(first?.textContent).toContain("3 h 12 min");
    expect(first?.textContent).toContain("IBKR bars, Yahoo quote");
    expect(first?.textContent).toContain("Reasons: Price is inside");
    const second = host.querySelector('[data-research-screen-row="BBB"]');
    expect(second?.textContent).toContain("No current data");
    expect(second?.textContent).toContain(
      "Latest collection failed; values are from Nov 13, 09:30 ET (14:30 UTC)"
    );
    expect(second?.textContent).toContain("Last action: Review entry");
    expect(second?.textContent).toContain("102.50");
    expect(second?.textContent).toContain("Error code: provider-timeout");
    expect(second?.textContent).toContain("Blocking: Quote is too old");
    expect(second?.textContent).toContain("Warnings: Earnings in 3 days");

    const panel = host.querySelector("[data-research-screen-context]");
    expect(panel?.querySelector("h2")?.textContent).toBe("Third-party context");
    expect(panel?.textContent).toContain(WARNING);
    expect(panel?.textContent).toContain("Stale");
    expect(panel?.textContent).toContain("Last retrieval error: HTTP 503");
    const group = (title: string) =>
      [
        ...(panel
          ?.querySelector(`[data-research-screen-group="${title}"]`)
          ?.querySelectorAll("dl > div") ?? []),
      ].map((item) => [
        item.querySelector("dt")?.textContent,
        item.querySelector("dd")?.textContent,
      ]);
    expect(group("Regime")).toEqual([
      ["Label", "Uptrend"],
      ["Trend strength", "strong"],
      ["Risk level", "low"],
    ]);
    expect(group("Breadth")).toEqual([
      ["Score", "64"],
      ["Regime", "healthy"],
      ["Above 20-day average", "60.0 %"],
      ["Above 50-day average", "55.0 %"],
      ["Above 200-day average", "50.0 %"],
    ]);
    expect(group("VIX")).toEqual([
      ["Level", "15.50"],
      ["1-year percentile", "20"],
      ["Regime", "calm"],
      ["Trend", "down"],
    ]);
    expect(group("Scanner")).toEqual([
      ["Scanned", "500"],
      ["With setups", "52"],
      ["Bullish", "40"],
      ["Bearish", "12"],
    ]);
    const cells = (slot: string) =>
      [
        ...(panel?.querySelectorAll(
          `[data-research-screen-${slot}] tbody tr`
        ) ?? []),
      ].map((line) => [...line.children].map((cell) => cell.textContent));
    expect(cells("themes")).toEqual([
      ["Chips", "+1.50 %", "bullish"],
      ["Banks", "none", "none"],
    ]);
    expect(cells("setups")).toEqual([
      ["CCC", "Bullish", "Demo Maker", "flag", "Tech"],
    ]);
    for (const slot of ["themes", "setups"]) {
      const inner = panel?.querySelector(`[data-research-screen-${slot}]`);
      expect(inner?.querySelector("caption")).not.toBeNull();
      expect(inner?.querySelector('[data-slot="table-scroll"]')).not.toBeNull();
      expect(inner?.querySelector('th[scope="row"]')).not.toBeNull();
    }
    expect(text).toContain("Screen values are research only.");
    expect(text).not.toMatch(VAGUE);
  });

  it("shows the empty parts of an idle screen without a snapshot", async () => {
    const { host } = await mount(
      <ResearchScreenWorkspace
        gateway={gatewayOf(async () =>
          status({
            nextSlots: [],
            rows: [],
            scheduler: {
              lastTickAt: null,
              lastTickDecision: null,
              state: "never",
            },
            swinglytics: {
              generatedAt: null,
              lastAttemptAt: null,
              lastAttemptStatus: null,
              lastError: null,
              retrievedAt: null,
              snapshot: null,
              stale: false,
              warning: WARNING,
            },
          })
        )}
      />
    );
    const text = host.textContent ?? "";
    expect(chip(host)).toBe("No tick yet");
    expect(text).toContain("No run is stored yet.");
    expect(text).toContain("No slot is planned.");
    expect(text).toContain("No slot was missed.");
    expect(text).toContain("No row is stored yet.");
    expect(text).toContain("No snapshot is stored yet.");
    expect(host.querySelector("table")).toBeNull();
    expect(text).not.toMatch(VAGUE);
  });

  it("names empty themes and setups and leaves the panel out without context", async () => {
    const { host } = await mount(
      <ResearchScreenWorkspace
        gateway={gatewayOf(async () =>
          status({
            swinglytics: {
              generatedAt: AT,
              lastAttemptAt: AT,
              lastAttemptStatus: "ok",
              lastError: null,
              retrievedAt: AT,
              snapshot: { ...snapshot, setups: [], themes: [] },
              stale: false,
              warning: WARNING,
            },
          })
        )}
      />
    );
    const panel = host.querySelector("[data-research-screen-context]");
    expect(panel?.textContent).toContain("No theme is in the snapshot.");
    expect(panel?.textContent).toContain("No setup is in the snapshot.");
    expect(panel?.querySelector("table")).toBeNull();
    const none = await mount(
      <ResearchScreenWorkspace
        gateway={gatewayOf(async () => status({ swinglytics: null }))}
      />
    );
    expect(
      none.host.querySelector("[data-research-screen-context]")
    ).toBeNull();
  });

  it("shows the operator-only state", async () => {
    const { host } = await mount(
      <ResearchScreenWorkspace
        gateway={gatewayOf(async () => {
          throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
        })}
      />
    );
    expect(stateOf(host)).toBe("forbidden");
    expect(chip(host)).toBe("Operator only");
    expect(host.textContent).toContain("limited to operators");
  });

  it("shows an error and loads again on retry", async () => {
    const read = vi
      .fn<ResearchScreenGateway["status"]>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(status());
    const { host } = await mount(
      <ResearchScreenWorkspace gateway={gatewayOf(read)} />
    );
    expect(stateOf(host)).toBe("error");
    expect(chip(host)).toBe("Load failed");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "The research screen did not load."
    );
    await act(async () => host.querySelector("button")?.click());
    expect(stateOf(host)).toBe("ready");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reloads every minute while a run is active and stops when idle", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<ResearchScreenGateway["status"]>()
      .mockResolvedValueOnce(status({ activeRun: run() }))
      .mockResolvedValueOnce(
        status({ activeRun: run({ failed: 2, succeeded: 27 }) })
      )
      .mockResolvedValue(status({ lastRun: run({ status: "completed" }) }));
    const { host } = await mount(
      <ResearchScreenWorkspace gateway={gatewayOf(read)} />
    );
    expect(host.textContent).toContain("Active run: Run of");
    expect(host.textContent).toContain("12 of 58 reports");
    expect(host.querySelector("progress")?.getAttribute("value")).toBe("21");
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () =>
      vi.advanceTimersByTimeAsync(RESEARCH_SCREEN_RELOAD_MS)
    );
    expect(read).toHaveBeenCalledTimes(2);
    // A quiet reload: the page never went back to the loading state.
    expect(stateOf(host)).toBe("ready");
    expect(host.textContent).toContain("29 of 58 reports");

    await act(async () =>
      vi.advanceTimersByTimeAsync(RESEARCH_SCREEN_RELOAD_MS)
    );
    expect(read).toHaveBeenCalledTimes(3);
    expect(host.textContent).not.toContain("Active run");
    await act(async () =>
      vi.advanceTimersByTimeAsync(RESEARCH_SCREEN_RELOAD_MS * 3)
    );
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not reload an idle screen and clears the timer on unmount", async () => {
    vi.useFakeTimers();
    const idle = vi.fn(async () => status());
    await mount(<ResearchScreenWorkspace gateway={gatewayOf(idle)} />);
    await act(async () =>
      vi.advanceTimersByTimeAsync(RESEARCH_SCREEN_RELOAD_MS * 2)
    );
    expect(idle).toHaveBeenCalledTimes(1);

    const active = vi.fn(async () => status({ activeRun: run() }));
    const { root } = await mount(
      <ResearchScreenWorkspace gateway={gatewayOf(active)} />
    );
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await vi.advanceTimersByTimeAsync(RESEARCH_SCREEN_RELOAD_MS * 2);
    expect(active).toHaveBeenCalledTimes(1);
  });

  it("ignores a slow older response after a newer one", async () => {
    vi.useFakeTimers();
    const slow = deferred();
    const slowFailure = deferred();
    const read = vi
      .fn<ResearchScreenGateway["status"]>()
      .mockResolvedValueOnce(status({ activeRun: run() }))
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(slowFailure.promise)
      .mockResolvedValue(
        status({ activeRun: run({ failed: 0, succeeded: 40 }) })
      );
    const { host } = await mount(
      <ResearchScreenWorkspace gateway={gatewayOf(read)} />
    );
    await act(async () =>
      vi.advanceTimersByTimeAsync(RESEARCH_SCREEN_RELOAD_MS * 3)
    );
    expect(read).toHaveBeenCalledTimes(4);
    expect(host.textContent).toContain("40 of 58 reports");
    await act(async () => {
      slow.resolve(status({ activeRun: run({ failed: 0, succeeded: 5 }) }));
      slowFailure.reject(new Error("late failure"));
      await Promise.resolve();
    });
    expect(stateOf(host)).toBe("ready");
    expect(host.textContent).toContain("40 of 58 reports");
  });
});

describe("research screen gateway and entry point", () => {
  it("creates the browser client lazily, once, on the page origin", async () => {
    const read = vi.fn(async () => status());
    runtime.client = {
      researchScreen: { status: read },
    } as unknown as ApiClient;
    const gateway = createBrowserResearchScreenGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.status();
    await gateway.status();
    expect(read).toHaveBeenCalledWith({});
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(Object.isFrozen(gateway)).toBe(true);
    const { host } = await mount(<ResearchScreenWorkspace />);
    expect(stateOf(host)).toBe("ready");
    expect(read).toHaveBeenCalledTimes(3);
  });
});
