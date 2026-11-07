// @vitest-environment jsdom
import {
  AgentOpsSummaryOutputSchema,
  AgentTaskSchema,
  IbkrRecoveryStatusOutputSchema,
  NautilusArmStatusOutputSchema,
  PortfolioMonitorOutputSchema,
  RoundHandleCheckOutputSchema,
  SectorRotationSnapshotSchema,
  TodoItemSchema,
  VertexOrdersStatusSchema,
} from "@darkfactory/api";
import {
  AgentRunSchema,
  StrategySpecSchema,
  VertexContinuityReadSchema,
  VertexPortfolioReadSchema,
} from "@darkfactory/api/vertex";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { localDayKey } from "../../components/portal/portfolio-monitor-model.ts";
import { PORTFOLIO_VIEW_STORAGE_KEY } from "../../components/portal/portfolio-tabs.tsx";
import {
  LAB_AGENT_SUMMARY,
  LAB_AGENT_TASKS,
  LAB_INBOX_CONTINUITY,
  LAB_INBOX_RUNS,
  LAB_INBOX_STRATEGIES,
  LAB_NAUTILUS_STATUS,
  LAB_PORTFOLIO_READ,
  LAB_RECOVERY_STATUS,
  LAB_ROUND_HANDLES,
  LAB_SECTOR_ROTATION,
  LAB_TODOS,
  LAB_VERTEX_ORDERS_STATUS,
  labDecisionInbox,
  labHex,
} from "../fixtures/overview.ts";
import { findLabEntry } from "../registry.ts";
import { mountLab, unmountLab } from "../test-support.tsx";
import {
  createLabIbkrMonitorGateway,
  OVERVIEW_LAB_ENTRIES,
} from "./overview.tsx";

afterEach(async () => {
  await unmountLab();
  window.localStorage.clear();
});

const render = (id: string, query = ""): Promise<HTMLElement> => {
  const entry = findLabEntry(OVERVIEW_LAB_ENTRIES, id);
  if (entry === undefined) throw new Error(`Missing lab entry ${id}`);
  return mountLab(entry.render(new URLSearchParams(query)));
};

/** Hashing the experience artifacts uses WebCrypto; give it real turns until the text shows. */
const settle = async (host: HTMLElement, text: string): Promise<void> => {
  for (let turn = 0; turn < 50; turn += 1) {
    if (host.textContent?.includes(text)) return;
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  }
  expect(host.textContent).toContain(text);
};

describe("overview lab entries", () => {
  it("renders Mission control with the Demo Capital account card and agent work", async () => {
    const host = await render("dashboard");
    expect(host.querySelector("h1")?.textContent).toBe("Mission control");
    expect(
      host.querySelector('[data-dashboard-view="operator"]')
    ).not.toBeNull();
    expect(host.querySelector('[data-health="live"]')).not.toBeNull();
    expect(
      host.querySelector('[data-stat="netLiquidation"]')?.textContent
    ).toContain("250,000");
    expect(
      host.querySelector('[data-nautilus-badge="running-disarmed"]')
    ).not.toBeNull();
    expect(host.querySelector('[data-counter="Succeeded"]')?.textContent).toBe(
      "41"
    );
    expect(host.textContent).toContain(
      "Demo momentum v1 walk-forward on core 7 ETF twins"
    );
    expect(host.textContent).toContain("Demo history service timed out");
    expect(host.textContent).toContain("Communication Services");
  });

  it("renders the Today decision inbox from hashed fake artifacts", async () => {
    const host = await render("today");
    expect(host.querySelector("h1")?.textContent).toBe("Decision inbox");
    await settle(host, "demo-momentum-v1: exact-version review needed");
    expect(host.textContent).toContain("research: approval requested");
    expect(host.textContent).toContain("backtest-review: blocked");
    expect(host.textContent).toContain("Continuity: gap");
    expect(host.textContent).toContain("demo-capital / paper");
    expect(host.textContent).toContain("Utilities");
  });

  it("renders Todos from the fake list", async () => {
    const host = await render("todos");
    expect(host.querySelector("h1")?.textContent).toBe("Todos");
    expect(host.textContent).toContain(
      "Review Demo momentum v1 walk-forward folds"
    );
  });

  it("renders the Trade journal from the fake ibkr-monitor executions", async () => {
    const host = await render("journal");
    expect(host.querySelector("h1")?.textContent).toBe("Trade journal");
    expect(host.querySelector('[data-journal="report"]')).not.toBeNull();
    expect(host.textContent).toContain("+$412.60");
    expect(
      host.querySelector('[data-exec-id="demo-exec-0002"]')
    ).not.toBeNull();
  });

  it("opens Portfolio on Positions by default with the live fake monitor", async () => {
    const host = await render("portfolio");
    expect(host.querySelector("h1")?.textContent).toBe("Portfolio");
    expect(window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY)).toBe(
      JSON.stringify("positions")
    );
    expect(host.querySelector('[data-health="live"]')).not.toBeNull();
    expect(host.textContent).toContain("NVDA");
    expect(host.textContent).toContain("MSFT");
  });

  it("puts the real portfolio tab choice back when the lab page closes", async () => {
    await render("portfolio", "tab=pnl");
    await unmountLab();
    expect(window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY)).toBeNull();
    window.localStorage.setItem(
      PORTFOLIO_VIEW_STORAGE_KEY,
      JSON.stringify("options")
    );
    await render("portfolio", "tab=pnl");
    expect(window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY)).toBe(
      JSON.stringify("pnl")
    );
    await unmountLab();
    expect(window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY)).toBe(
      JSON.stringify("options")
    );
  });

  it("opens the Portfolio tab named by ?tab=", async () => {
    const orders = await render("portfolio", "tab=orders");
    expect(orders.textContent).toContain("Orders disabled");
    await settle(orders, "QQQ");
    await unmountLab();

    const stops = await render("portfolio", "tab=orders-stops");
    expect(stops.textContent).toContain("Completed / cancelled today");
    expect(stops.textContent).toContain("Cancelled by demo operator");
    await unmountLab();

    const projection = await render("portfolio", "tab=projection");
    await settle(projection, "demo-capital-paper-stream");
    expect(projection.textContent).toContain("Sleeve allocations");
    expect(projection.textContent).toContain("demo-reservation-1");
  });

  it("stamps monitor freshness with the injected clock", async () => {
    const pinned = new Date("2026-11-02T15:30:00.000Z");
    const gateway = createLabIbkrMonitorGateway(() => pinned);
    const snapshot = await gateway.snapshot();
    expect(snapshot.status.dataAsOf).toBe(pinned.toISOString());
    expect(
      snapshot.completed.every((order) =>
        order.completedTime.startsWith(localDayKey(pinned))
      )
    ).toBe(true);
    expect(PortfolioMonitorOutputSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      RoundHandleCheckOutputSchema.parse(await gateway.roundHandles())
    ).toEqual(LAB_ROUND_HANDLES);
  });

  it("keeps every fixture valid against its contract schema", async () => {
    expect(labHex("seed")).toMatch(/^[0-9a-f]{64}$/u);
    NautilusArmStatusOutputSchema.parse(LAB_NAUTILUS_STATUS);
    IbkrRecoveryStatusOutputSchema.parse(LAB_RECOVERY_STATUS);
    AgentOpsSummaryOutputSchema.parse(LAB_AGENT_SUMMARY);
    for (const task of LAB_AGENT_TASKS) AgentTaskSchema.parse(task);
    SectorRotationSnapshotSchema.parse(LAB_SECTOR_ROTATION);
    for (const todo of LAB_TODOS) TodoItemSchema.parse(todo);
    VertexOrdersStatusSchema.parse(LAB_VERTEX_ORDERS_STATUS);
    VertexPortfolioReadSchema.parse(LAB_PORTFOLIO_READ);
    VertexContinuityReadSchema.parse(LAB_INBOX_CONTINUITY);
    for (const strategy of LAB_INBOX_STRATEGIES)
      StrategySpecSchema.parse(strategy);
    for (const run of LAB_INBOX_RUNS) AgentRunSchema.parse(run);
    const inbox = await labDecisionInbox();
    expect(inbox.agents).toHaveLength(LAB_INBOX_RUNS.length);
    expect(inbox.strategies[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});
