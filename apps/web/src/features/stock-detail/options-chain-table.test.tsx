// @vitest-environment jsdom
import type { OptionContract, OptionsChainOutput } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createFakeOptionsChainGateway } from "./fake-gateways.ts";
import {
  atmIndex,
  formatCell,
  OptionsChainTable,
  windowRows,
} from "./options-chain-table.tsx";

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

const render = async (chain: OptionsChainOutput, strikes: 10 | 20 | "all") => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<OptionsChainTable chain={chain} strikes={strikes} />)
  );
  return container;
};

const contract: OptionContract = {
  ask: 1.4,
  bid: 1.3,
  change: null,
  contractSymbol: "DEMO261106C00100000",
  flow: null,
  greeks: {
    delta: 0.5234,
    gamma: 0.019_12,
    rho: 0.0031,
    theta: -0.1834,
    vega: 0.0312,
  },
  inTheMoney: false,
  iv: 0.2815,
  last: null,
  lastTradeAt: null,
  openInterest: 12_345,
  sources: {
    delta: "model",
    iv: "yahoo",
    openInterest: "yahoo",
    quote: "yahoo",
  },
  volume: null,
};

const chain = async () =>
  await createFakeOptionsChainGateway().chain({ symbol: "NVDA" });

describe("formatCell", () => {
  it("formats quotes, counts, IV and Greeks", () => {
    expect(formatCell(contract, "bid")).toBe("1.30");
    expect(formatCell(contract, "last")).toBe("—");
    expect(formatCell(contract, "openInterest")).toBe("12,345");
    expect(formatCell(contract, "volume")).toBe("—");
    expect(formatCell(contract, "iv")).toBe("28.1%");
    expect(formatCell({ ...contract, iv: null }, "iv")).toBe("—");
    expect(formatCell(contract, "delta")).toBe("0.523");
    expect(formatCell(contract, "gamma")).toBe("0.0191");
    expect(formatCell(contract, "theta")).toBe("-0.183");
    expect(formatCell({ ...contract, greeks: null }, "gamma")).toBe("—");
    expect(formatCell({ ...contract, greeks: null }, "vega")).toBe("—");
    expect(formatCell(null, "ask")).toBe("—");
    expect(
      formatCell(
        { ...contract, greeks: { ...contract.greeks!, theta: -0.000_04 } },
        "theta"
      )
    ).toBe("0.000");
  });
});

describe("strike window", () => {
  it("centers on the at-the-money strike", async () => {
    const data = await chain();
    const atm = atmIndex(data.rows, data.spot);
    expect(atm).toBe(20);
    expect(atmIndex(data.rows, null)).toBe(-1);
    expect(atmIndex([], 100)).toBe(-1);
    const near = windowRows(data.rows, atm, 10);
    expect(near).toHaveLength(10);
    expect(near.map((row) => row.strike)).toContain(data.rows[20]?.strike);
    expect(windowRows(data.rows, 0, 10)[0]).toBe(data.rows[0]);
    expect(windowRows(data.rows, 40, 10).at(-1)).toBe(data.rows[40]);
    expect(windowRows(data.rows, -1, 10)[0]).toBe(data.rows[15]);
    expect(windowRows(data.rows, atm, "all")).toHaveLength(41);
    expect(windowRows(data.rows.slice(0, 5), 2, 10)).toHaveLength(5);
  });
});

describe("OptionsChainTable", () => {
  it("shows calls, strike and puts side by side with all Greek columns", async () => {
    const data = await chain();
    const container = await render(data, 20);
    const split = container.querySelector("[data-chain-layout=split]");
    const heads = [
      ...(split?.querySelectorAll("thead tr:nth-child(2) th abbr") ?? []),
    ].map((node) => node.getAttribute("title"));
    for (const name of [
      "Delta",
      "Gamma",
      "Theta per day",
      "Implied volatility",
      "Open interest",
      "Bid",
      "Ask",
      "Last trade price",
      "Volume",
      "Rho per 1 rate point",
      "Vega per 1 volatility point",
    ])
      expect(heads.filter((title) => title === name)).toHaveLength(2);
    expect(split?.querySelectorAll("tbody tr")).toHaveLength(20);
    const atm = split?.querySelector("tr[data-atm]");
    expect(atm?.textContent).toContain("ATM");
    expect(atm?.getAttribute("data-strike")).toBe(
      String(data.rows[20]?.strike)
    );
    // ITM shading: a low strike shades the call side, a high strike the put side.
    const rows = [...(split?.querySelectorAll("tbody tr") ?? [])];
    expect(rows[0]?.querySelector("td")?.className).toContain("bg-muted/50");
    expect(rows.at(-1)?.querySelector("td:last-child")?.className).toContain(
      "bg-muted/50"
    );
    // The middle strike column scrolls with the table; the one-side table pins it.
    expect(atm?.querySelector("th")?.className).not.toContain("sticky");
    expect(
      container.querySelector("[data-chain-layout=calls] tbody th")?.className
    ).toContain("sticky");
    expect(
      container.querySelector("[data-strike-count]")?.textContent
    ).toContain("Showing 20 of 41 strikes");
  });

  it("marks a bid and ask from IBKR with screen-reader text and a visible legend", async () => {
    const data = await chain();
    const container = await render(
      {
        ...data,
        rows: [
          {
            call: {
              ...contract,
              sources: { ...contract.sources, quote: "ibkr" },
            },
            put: contract,
            strike: 100,
          },
          { call: null, put: null, strike: 105 },
        ],
      },
      10
    );
    const row = container.querySelector(
      "[data-chain-layout=split] tbody tr[data-strike='100']"
    );
    const live = [
      ...(row?.querySelectorAll("td[data-quote-source=ibkr]") ?? []),
    ];
    // Only the call's bid and ask; the Yahoo put and the other columns stay unmarked.
    expect(live.map((cell) => cell.textContent)).toEqual([
      "1.40 (IBKR live quote)",
      "1.30 (IBKR live quote)",
    ]);
    for (const cell of live) {
      expect(cell.className).toContain("decoration-dotted");
      expect(cell.querySelector("span")?.className).toBe("sr-only");
      // The reason is text, not a hover title.
      expect(cell.hasAttribute("title")).toBe(false);
    }
    expect(row?.querySelectorAll("td span.sr-only")).toHaveLength(2);
    // No column was added: 11 per side.
    expect(row?.querySelectorAll("td")).toHaveLength(22);
    expect(
      container.querySelector("[data-strike-count] [data-quote-legend=split]")
        ?.textContent
    ).toBe(" A dotted underline marks an IBKR live quote.");
    // The dummy chain marks the strikes nearest the spot on both sides.
    const lab = await render(data, "all");
    expect(
      lab.querySelectorAll(
        "[data-chain-layout=split] td[data-quote-source=ibkr]"
      )
    ).toHaveLength(13 * 4);
  });

  it("shows the legend only when a cell of the current view has an IBKR quote", async () => {
    const data = await chain();
    const legends = (container: HTMLElement) =>
      [...container.querySelectorAll("[data-quote-legend]")].map((node) => [
        node.getAttribute("data-quote-legend"),
        node.className,
      ]);
    const press = async (container: HTMLElement, label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === label
      );
      await act(async () => button?.click());
    };
    const yahooOnly = await render(
      {
        ...data,
        rows: [
          { call: contract, put: contract, strike: 100 },
          { call: null, put: null, strike: 105 },
        ],
      },
      10
    );
    expect(legends(yahooOnly)).toEqual([]);
    expect(yahooOnly.querySelector("[data-quote-source]")).toBeNull();
    // Only a put has an IBKR quote: the wide view (both sides) shows the legend, the narrow
    // view shows it for Puts and not for Calls.
    const putOnly = await render(
      {
        ...data,
        rows: [
          {
            call: contract,
            put: {
              ...contract,
              sources: { ...contract.sources, quote: "ibkr" },
            },
            strike: 100,
          },
        ],
      },
      10
    );
    expect(legends(putOnly)).toEqual([["split", "hidden lg:inline"]]);
    await press(putOnly, "Puts");
    expect(legends(putOnly)).toEqual([
      ["split", "hidden lg:inline"],
      ["put", "lg:hidden"],
    ]);
    expect(putOnly.querySelector("[data-quote-legend=put]")?.textContent).toBe(
      " A dotted underline marks an IBKR live quote."
    );
    await press(putOnly, "Calls");
    expect(legends(putOnly)).toEqual([["split", "hidden lg:inline"]]);
    // Only a call: the narrow view opens on Calls and shows it.
    const callOnly = await render(
      {
        ...data,
        rows: [
          {
            call: {
              ...contract,
              sources: { ...contract.sources, quote: "ibkr" },
            },
            put: contract,
            strike: 100,
          },
        ],
      },
      10
    );
    expect(legends(callOnly)).toEqual([
      ["split", "hidden lg:inline"],
      ["call", "lg:hidden"],
    ]);
    await press(callOnly, "Puts");
    expect(legends(callOnly)).toEqual([["split", "hidden lg:inline"]]);
  });

  it("switches between calls and puts on narrow screens", async () => {
    const data = await chain();
    const container = await render(data, "all");
    expect(container.querySelector("[data-chain-layout=calls]")).not.toBeNull();
    const puts = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Puts"
    );
    await act(async () => puts?.click());
    expect(container.querySelector("[data-chain-layout=puts]")).not.toBeNull();
    expect(puts?.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelectorAll("[data-chain-layout=puts] tbody tr")
    ).toHaveLength(41);
  });

  it("uses the provider ITM flag without a spot and handles an empty expiry", async () => {
    const data = await chain();
    const noSpot = await render(
      {
        ...data,
        rows: [
          { call: { ...contract, inTheMoney: true }, put: null, strike: 100 },
          { call: null, put: null, strike: 105 },
        ],
        spot: null,
      },
      10
    );
    const cells = noSpot.querySelectorAll("[data-chain-layout=split] tbody td");
    expect(cells[0]?.className).toContain("bg-muted/50");
    expect(noSpot.querySelector("tr[data-atm]")).toBeNull();
    const empty = await render({ ...data, rows: [] }, 10);
    expect(empty.textContent).toContain("No contracts are listed");
  });
});
