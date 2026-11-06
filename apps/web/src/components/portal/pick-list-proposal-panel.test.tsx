// @vitest-environment jsdom
import type {
  PickListOutput,
  PickListProposalOutput,
  PickListProposalRowOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  bucketKey,
  parseNlv,
  PickListProposalPanel,
  spreadsFor,
} from "./pick-list-proposal-panel.tsx";
import type { PickListGateway } from "./pick-lists-client.ts";

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

const settle = async () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await settle();
  return { container, root };
};
const setValue = async (element: Element | null | undefined, value: string) => {
  const input = element as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const cells = (row: Element | undefined) =>
  [...(row?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent);
const rowFor = (container: HTMLElement, symbol: string) =>
  [...container.querySelectorAll("tbody tr")].find(
    (entry) => entry.querySelector("th")?.textContent === symbol
  );

const list = (
  bucketSymbol: string | null,
  snapshot = "snap-1"
): PickListOutput => ({
  id: `list-${bucketSymbol ?? "none"}`,
  source: "moby",
  sourceLabel: "Moby",
  slug: "moby",
  name: "Moby",
  bucketSymbol,
  snapshotCount: 1,
  latest: {
    id: snapshot,
    asOf: "2026-11-04",
    method: "manual",
    importedAt: "2026-11-04T12:00:00.000Z",
    members: [],
  },
});

const fullRow: PickListProposalRowOutput = {
  symbol: "NVDA",
  buckets: ["TMOBY", "WISH"],
  status: "pass",
  last: 200,
  lastDate: "2026-11-04",
  sectorEtf: "XLK",
  quadrant: "leading",
  sectorQuadrant: "leading",
  tier: "full",
  maxLossPctNlv: 0.5,
  volatility: 0.4,
  structure: {
    kind: "call-debit-spread",
    expiry: "2027-03-19",
    dte: 134,
    longStrike: 195,
    shortStrike: 232.5,
    longDelta: 0.6,
    shortDelta: 0.3,
    estDebit: 12.34,
    maxLossPerSpread: 1234,
    maxProfitPerSpread: 2516,
  },
  notes:
    "All 3 gates pass; sector XLK leading; own RRG leading. Enter in 3 tranches (40/30/30).",
};

const noneRow: PickListProposalRowOutput = {
  ...fullRow,
  symbol: "XOM",
  buckets: ["TPROP"],
  status: "fail",
  last: null,
  tier: "none",
  maxLossPctNlv: 0,
  structure: null,
  notes: "No entry: gate failed (EMA trend). Watch only.",
};

const proposal = (
  overrides: Partial<PickListProposalOutput> = {}
): PickListProposalOutput => ({
  proposalOnly: true,
  computedAt: "2026-11-05T21:00:00.000Z",
  rules: {
    fullMaxLossPct: 0.5,
    halfMaxLossPct: 0.25,
    maxLossGatePct: 2,
    namePremiumCapPct: 2,
    dteMin: 90,
    dteMax: 180,
    targetDte: 120,
    longDelta: 0.6,
    shortDelta: 0.3,
    riskFreeRate: 0.04,
  },
  buckets: [{ symbol: "TMOBY", listId: "a", listName: "Moby", memberCount: 1 }],
  rows: [fullRow, noneRow],
  notProposed: [],
  totalMaxLossPct: 0.5,
  ...overrides,
});

const gatewayWith = (
  proposalFn: PickListGateway["proposal"]
): PickListGateway => ({
  import: async () => {
    throw new Error("unused");
  },
  list: async () => [],
  proposal: vi.fn(proposalFn),
  screen: async () => {
    throw new Error("unused");
  },
  syncBucket: async () => {
    throw new Error("unused");
  },
});

describe("proposal helpers", () => {
  it("parses an optional NLV", () => {
    expect(parseNlv("")).toBeNull();
    expect(parseNlv("  ")).toBeNull();
    expect(parseNlv("abc")).toBeNull();
    expect(parseNlv("-5")).toBeNull();
    expect(parseNlv("250,000")).toBe(250_000);
  });

  it("counts whole spreads inside the max-loss budget", () => {
    expect(spreadsFor(fullRow, null)).toBeNull();
    expect(spreadsFor(noneRow, 100_000)).toBeNull();
    expect(
      spreadsFor(
        {
          ...fullRow,
          structure: fullRow.structure && {
            ...fullRow.structure,
            maxLossPerSpread: 0,
          },
        },
        100_000
      )
    ).toBeNull();
    // 0.5% of 1,000,000 = 5,000; 5,000 / 1,234 = 4 spreads.
    expect(spreadsFor(fullRow, 1_000_000)).toBe(4);
  });

  it("keys buckets by symbol and snapshot", () => {
    expect(bucketKey([list(null)])).toBe("");
    expect(bucketKey([list("WISH"), list("TMOBY", "s2"), list(null)])).toBe(
      "TMOBY:s2|WISH:snap-1"
    );
  });
});

describe("PickListProposalPanel", () => {
  it("says proposal only and asks for a bucket when none exists", async () => {
    const gateway = gatewayWith(async () => proposal());
    const { container } = await mount(
      <PickListProposalPanel gateway={gateway} lists={[list(null)]} />
    );
    expect(container.textContent).toContain("Proposal only — no orders.");
    expect(container.textContent).toContain("No buckets yet.");
    expect(gateway.proposal).not.toHaveBeenCalled();
    expect(container.querySelector("table")).toBeNull();
  });

  it("loads the proposal and shows one row per member, without order controls", async () => {
    const gateway = gatewayWith(async () => proposal());
    const { container } = await mount(
      <PickListProposalPanel gateway={gateway} lists={[list("TMOBY")]} />
    );
    expect(gateway.proposal).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "2 names · 1 proposed · total max loss 0.50% NLV · computed 2026-11-05T21:00:00.000Z"
    );
    expect(container.textContent).toContain(
      "Max loss per new position ≤ 2% NLV"
    );
    expect(container.textContent).toContain("r = 4%");
    expect(cells(rowFor(container, "NVDA"))).toEqual([
      "TMOBY, WISH",
      "200.00",
      "Status:Full size",
      "Call debit spread2027-03-19 (134 DTE)Buy 195C / sell 232.5CDelta 0.60 / 0.30",
      "$12.34",
      "$1,234.00max profit $2,516.00",
      "0.50%",
      "—",
      fullRow.notes,
    ]);
    expect(cells(rowFor(container, "XOM"))).toEqual([
      "TPROP",
      "—",
      "Status:No entry",
      "—",
      "—",
      "—",
      "—",
      "—",
      noneRow.notes,
    ]);
    // The only button refreshes the proposal; nothing can place an order.
    expect(
      [...container.querySelectorAll("button")].map(
        (button) => button.textContent
      )
    ).toEqual(["Refresh proposal"]);
    expect(container.textContent).not.toContain("Not proposed");
  });

  it("sizes rows from an NLV typed in the tab", async () => {
    const gateway = gatewayWith(async () => proposal());
    const { container } = await mount(
      <PickListProposalPanel gateway={gateway} lists={[list("TMOBY")]} />
    );
    await setValue(container.querySelector("input"), "1,000,000");
    expect(cells(rowFor(container, "NVDA"))[7]).toBe("4");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "total max loss 0.50% NLV ($5,000.00)"
    );
  });

  it("lists members past the per-run limit", async () => {
    const gateway = gatewayWith(async () =>
      proposal({ notProposed: ["M060", "M061"] })
    );
    const { container } = await mount(
      <PickListProposalPanel gateway={gateway} lists={[list("TMOBY")]} />
    );
    expect(container.textContent).toContain(
      "Not proposed (first 60 names per run): M060, M061."
    );
  });

  it("shows a failure, refreshes on request and reloads when a bucket changes", async () => {
    let fail = true;
    const gateway = gatewayWith(async () => {
      if (fail) throw { code: "STORAGE_ERROR" };
      return proposal();
    });
    const { container, root } = await mount(
      <PickListProposalPanel gateway={gateway} lists={[list("TMOBY")]} />
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Pick list storage unavailable (503)."
    );
    fail = false;
    await act(async () =>
      (container.querySelector("button") as HTMLButtonElement).click()
    );
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(rowFor(container, "NVDA")).toBeDefined();
    await act(async () =>
      root.render(
        <PickListProposalPanel
          gateway={gateway}
          lists={[list("TMOBY", "snap-2")]}
        />
      )
    );
    await settle();
    expect(gateway.proposal).toHaveBeenCalledTimes(3);
  });

  it("keeps only the newest response", async () => {
    const answers: ((value: PickListProposalOutput) => void)[] = [];
    const failures: ((reason: unknown) => void)[] = [];
    const gateway = gatewayWith(
      () =>
        // The web tsconfig lib predates Promise.withResolvers.
        new Promise<PickListProposalOutput>((resolve, reject) => {
          answers.push(resolve);
          failures.push(reject);
        })
    );
    const { container, root } = await mount(
      <PickListProposalPanel gateway={gateway} lists={[list("TMOBY")]} />
    );
    const rerender = async (snapshot: string) => {
      await act(async () =>
        root.render(
          <PickListProposalPanel
            gateway={gateway}
            lists={[list("TMOBY", snapshot)]}
          />
        )
      );
      await settle();
    };
    await rerender("snap-2");
    await act(async () => answers[1]?.(proposal({ rows: [noneRow] })));
    await act(async () => answers[0]?.(proposal()));
    await settle();
    expect(rowFor(container, "NVDA")).toBeUndefined();
    expect(rowFor(container, "XOM")).toBeDefined();
    await rerender("snap-3");
    await rerender("snap-4");
    await act(async () => failures[2]?.({ code: "STORAGE_ERROR" }));
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => answers[3]?.(proposal()));
    await settle();
    expect(rowFor(container, "NVDA")).toBeDefined();
  });
});
