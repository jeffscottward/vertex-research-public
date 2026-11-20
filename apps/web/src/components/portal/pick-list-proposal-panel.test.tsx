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
  PickListProposalPanel,
  parseNlv,
  spreadsFor,
  spreadsText,
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
  bucketSymbol,
  id: `list-${bucketSymbol ?? "none"}`,
  latest: {
    asOf: "2026-11-04",
    id: snapshot,
    importedAt: "2026-11-04T12:00:00.000Z",
    members: [],
    method: "manual",
  },
  name: "Moby",
  slug: "moby",
  snapshotCount: 1,
  source: "moby",
  sourceLabel: "Moby",
});

const fullRow: PickListProposalRowOutput = {
  buckets: ["TMOBY", "WISH"],
  last: 200,
  lastDate: "2026-11-04",
  maxLossPctNlv: 0.5,
  notes:
    "All 3 gates pass; sector XLK leading; own RRG leading. Enter in 3 tranches (40/30/30).",
  quadrant: "leading",
  sectorEtf: "XLK",
  sectorQuadrant: "leading",
  status: "pass",
  structure: {
    dte: 134,
    estDebit: 12.34,
    expiry: "2027-03-19",
    kind: "call-debit-spread",
    longDelta: 0.6,
    longStrike: 195,
    maxLossPerSpread: 1234,
    maxProfitPerSpread: 2516,
    shortDelta: 0.3,
    shortStrike: 232.5,
  },
  symbol: "NVDA",
  tier: "full",
  volatility: 0.4,
};

const noneRow: PickListProposalRowOutput = {
  ...fullRow,
  buckets: ["TPROP"],
  last: null,
  maxLossPctNlv: 0,
  notes: "No entry: gate failed (EMA trend). Watch only.",
  status: "fail",
  structure: null,
  symbol: "XOM",
  tier: "none",
};

const proposal = (
  overrides: Partial<PickListProposalOutput> = {}
): PickListProposalOutput => ({
  buckets: [{ listId: "a", listName: "Moby", memberCount: 1, symbol: "TMOBY" }],
  computedAt: "2026-11-05T21:00:00.000Z",
  notProposed: [],
  proposalOnly: true,
  rows: [fullRow, noneRow],
  rules: {
    dteMax: 180,
    dteMin: 90,
    fullMaxLossPct: 0.5,
    halfMaxLossPct: 0.25,
    longDelta: 0.6,
    maxLossGatePct: 2,
    namePremiumCapPct: 2,
    riskFreeRate: 0.04,
    shortDelta: 0.3,
    targetDte: 120,
  },
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

  it("names why a row has no spread count", () => {
    const free: PickListProposalRowOutput = {
      ...fullRow,
      structure: fullRow.structure && {
        ...fullRow.structure,
        maxLossPerSpread: 0,
      },
    };
    expect(spreadsText(noneRow, 100_000)).toBe("No entry");
    expect(spreadsText({ ...fullRow, structure: null }, 100_000)).toBe(
      "No spread estimate from the server"
    );
    expect(spreadsText(fullRow, null)).toBe("Enter NLV to size");
    expect(spreadsText(free, 100_000)).toBe("Max loss estimate is 0");
    expect(spreadsText(fullRow, 1000)).toBe("0 (one spread is over the cap)");
    expect(spreadsText(fullRow, 1_000_000)).toBe("4");
  });

  it("keys buckets by symbol and snapshot", () => {
    expect(bucketKey([list(null)])).toBe("");
    expect(bucketKey([list("WISH"), list("TMOBY", "s2"), list(null)])).toBe(
      "TMOBY:s2|WISH:snap-1"
    );
  });
});

describe("PickListProposalPanel", () => {
  it("says proposal only and asks for a bucket when the server has none", async () => {
    const gateway = gatewayWith(async () =>
      proposal({ buckets: [], rows: [], totalMaxLossPct: 0 })
    );
    const { container } = await mount(
      <PickListProposalPanel gateway={gateway} lists={[list(null)]} />
    );
    expect(container.textContent).toContain("Proposal only — no orders.");
    expect(container.textContent).toContain("No buckets yet.");
    expect(gateway.proposal).toHaveBeenCalledTimes(1);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("loads the proposal even without own lists (agent viewer)", async () => {
    const gateway = gatewayWith(async () => proposal());
    const { container } = await mount(
      <PickListProposalPanel gateway={gateway} lists={[]} />
    );
    expect(gateway.proposal).toHaveBeenCalledTimes(1);
    expect(rowFor(container, "NVDA")).toBeDefined();
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
      "Enter NLV to size",
      fullRow.notes,
    ]);
    expect(cells(rowFor(container, "XOM"))).toEqual([
      "TPROP",
      "No daily close",
      "Status:No entry",
      "No structure: no entry. See the Why column.",
      "No entry",
      "No entry",
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
    expect(cells(rowFor(container, "XOM"))[5]).toBe("No entry");
    expect(container.querySelector("[data-nlv-total]")?.textContent).toBe(
      " · at this NLV: $5,000.00"
    );
    // The live region keeps only the counts, so typing does not re-announce it.
    expect(
      container.querySelector('[role="status"]')?.textContent
    ).not.toContain("$");
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
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
      /^Pick list storage gave no cause for a failure at \d\d:\d\d UTC \(503\)\./u
    );
    fail = false;
    await act(async () =>
      (container.querySelector("button") as HTMLButtonElement).click()
    );
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(rowFor(container, "NVDA")).toBeDefined();
    // A failed refresh keeps the last proposal on screen.
    fail = true;
    await act(async () =>
      (container.querySelector("button") as HTMLButtonElement).click()
    );
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
      /^Pick list storage gave no cause for a failure at \d\d:\d\d UTC \(503\)\./u
    );
    expect(rowFor(container, "NVDA")).toBeDefined();
    fail = false;
    await act(async () =>
      root.render(
        <PickListProposalPanel
          gateway={gateway}
          lists={[list("TMOBY", "snap-2")]}
        />
      )
    );
    await settle();
    expect(gateway.proposal).toHaveBeenCalledTimes(4);
    expect(container.querySelector('[role="alert"]')).toBeNull();
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
