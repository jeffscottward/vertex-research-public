// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PayoffLab } from "./payoff-lab.tsx";
import type { CatalogFacts } from "./payoff-strategies.ts";

// Synthetic fixtures only; no stored dossier data.
const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mount = async (element: ReactElement): Promise<HTMLElement> => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return host;
};

const TODAY = "2026-11-19";
const JAN = "2027-01-15";
const MAR = "2027-03-19";
const leg = (side: string, type: string, strike: number, premium: number) => ({
  multiplier: 100,
  premium,
  side,
  strike,
  type,
});
const STRATEGIES = [
  { expiry: JAN, kind: "long-call", legs: [leg("buy", "call", 100, 5)] },
  {
    expiry: JAN,
    kind: "bull-call-spread",
    legs: [leg("buy", "call", 100, 8), leg("sell", "call", 110, 3)],
  },
  { expiry: JAN, kind: "cash-secured-put", legs: [leg("sell", "put", 90, 4)] },
  {
    expiry: JAN,
    kind: "put-credit-spread",
    legs: [leg("sell", "put", 95, 3), leg("buy", "put", 85, 1)],
  },
  { hypothetical: true, kind: "stock", stockEntry: 40, stockShares: 100 },
  { expiry: MAR, kind: "long-call", legs: [leg("buy", "call", 120, 6)] },
  { expiry: JAN, kind: "long-call", legs: [leg("buy", "call", 130, 2)] },
  { kind: "stock", stockEntry: 55, stockShares: 600 },
  { expiry: JAN, kind: "long-call", legs: [] },
];
const DATA = { strategies: STRATEGIES };

const ready = (
  overrides: Partial<Extract<CatalogFacts, { status: "ready" }>> = {}
): CatalogFacts => ({
  assetType: "equity",
  currency: "USD",
  status: "ready",
  ...overrides,
});

const lab = (host: HTMLElement): HTMLElement => {
  const element = host.querySelector<HTMLElement>("[data-payoff-lab]");
  if (element === null) throw new Error("no lab container");
  return element;
};
const stateOf = (host: HTMLElement): string | undefined =>
  lab(host).dataset["payoffLabState"];
const one = <T extends Element>(host: HTMLElement, selector: string): T => {
  const element = host.querySelector<T>(selector);
  if (element === null) throw new Error(`no element for ${selector}`);
  return element;
};
const textOf = (host: HTMLElement, selector: string): string =>
  one(host, selector).textContent ?? "";
const count = (host: HTMLElement, selector: string): number =>
  host.querySelectorAll(selector).length;

/** Sets the value of a controlled field the way a browser does, then fires the event React reads. */
const setValue = async (
  element: HTMLInputElement | HTMLSelectElement,
  value: string
): Promise<void> => {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter === undefined) throw new Error("no value setter");
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
  });
};
const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => element.click());
};
const pick = (host: HTMLElement, key: string): HTMLInputElement =>
  one<HTMLInputElement>(host, `[data-payoff-pick="${key}"]`);
const add = async (host: HTMLElement, key: string): Promise<void> =>
  setValue(one<HTMLSelectElement>(host, "[data-payoff-add]"), key);
const outcomes = (host: HTMLElement): readonly string[] =>
  [...host.querySelectorAll("[data-payoff-outcome]")].map(
    (cell) => cell.textContent ?? ""
  );

const mountReady = (
  data: unknown = DATA,
  catalog: CatalogFacts = ready(),
  reportId = "AAA"
): Promise<HTMLElement> =>
  mount(
    <PayoffLab
      catalog={catalog}
      data={data}
      reportId={reportId}
      today={TODAY}
    />
  );

describe("PayoffLab states", () => {
  it("shows a skeleton while the catalog entry loads", async () => {
    const host = await mountReady(DATA, { status: "loading" });
    expect(stateOf(host)).toBe("loading");
    expect(lab(host).textContent).toContain("Loading payoff lab");
    expect(count(host, "[data-payoff-chart]")).toBe(0);
  });

  it("shows one sentence for a dossier without strategies", async () => {
    const host = await mountReady({ summary: "text only" });
    expect(stateOf(host)).toBe("no-strategies");
    expect(lab(host).textContent).toContain(
      "This dossier stores no strategies, so there is no payoff chart."
    );
    expect(count(host, "input, select, svg")).toBe(0);
  });

  it("shows one sentence for strategies of a wrong shape", async () => {
    const host = await mountReady({ strategies: "seventy-nine" });
    expect(stateOf(host)).toBe("malformed");
    expect(lab(host).textContent).toContain(
      "The stored strategies have an unsupported shape, so there is no payoff chart."
    );
    expect(count(host, "input, select, svg")).toBe(0);
  });

  it("shows only the counts when no row is drawable", async () => {
    const host = await mountReady({
      strategies: [STRATEGIES[8], STRATEGIES[7]],
    });
    expect(stateOf(host)).toBe("none-drawable");
    expect(textOf(host, "[data-payoff-lab-counts]")).toBe(
      "2 stored rows = 0 drawable (0 lines) + 1 not drawable + 1 not shown."
    );
    expect(textOf(host, "[data-payoff-lab-reasons]")).toBe("1: no legs stored");
    expect(lab(host).textContent).toContain(
      "Not shown: stock rows that the dossier does not mark as hypothetical"
    );
    expect(count(host, "input, select, svg")).toBe(0);
  });

  it("keeps the page up when the lab throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile = {
      get strategies(): never {
        throw new Error("hostile getter");
      },
    };
    const host = await mountReady(hostile);
    expect(stateOf(host)).toBe("failed");
    expect(textOf(host, '[role="alert"]')).toBe(
      "The payoff lab failed to render. The text panels above are not affected."
    );
  });

  it("reads the clock once when no date is passed", async () => {
    vi.useFakeTimers({ now: new Date("2027-02-01T12:00:00.000Z") });
    const host = await mount(
      <PayoffLab catalog={ready()} data={DATA} reportId="AAA" />
    );
    expect(stateOf(host)).toBe("ready");
    // On 2027-02-01 the January lines are past, so the first set uses March.
    expect(lab(host).textContent).toContain(
      "Long call 120 · debit 6 · 2027-03-19"
    );
    expect(pick(host, "line-5").checked).toBe(true);
  });
});

describe("PayoffLab asset-type gate", () => {
  it("draws no line for a dossier that is not equity or ETF", async () => {
    const host = await mountReady(DATA, ready({ assetType: "future" }));
    expect(stateOf(host)).toBe("none-drawable");
    expect(textOf(host, "[data-payoff-lab-counts]")).toBe(
      "9 stored rows = 0 drawable (0 lines) + 8 not drawable + 1 not shown."
    );
    expect(textOf(host, "[data-payoff-lab-reasons]")).toBe(
      "8: the lab draws only equity and ETF dossiers"
    );
    expect(count(host, "input, select, svg")).toBe(0);
    expect(lab(host).outerHTML).not.toContain("future");
  });

  it("draws no line when the catalog could not be read", async () => {
    const host = await mountReady(DATA, { status: "failed" });
    expect(stateOf(host)).toBe("none-drawable");
    expect(textOf(host, "[data-payoff-lab-reasons]")).toBe(
      "8: the catalog asset type could not be read; reload the page"
    );
  });

  it("lets a dossier without a stated asset type pass only for APP and SIVE", async () => {
    const untyped = ready({ assetType: null });
    expect(stateOf(await mountReady(DATA, untyped))).toBe("none-drawable");
    const app = await mountReady(DATA, untyped, "APP");
    expect(stateOf(app)).toBe("ready");
    expect(count(app, "[data-payoff-line]")).toBe(5);
    expect(stateOf(await mountReady(DATA, untyped, "SIVE"))).toBe("ready");
  });

  it("compares the asset type without regard to letter case", async () => {
    const host = await mountReady(DATA, ready({ assetType: "ETF" }));
    expect(count(host, "[data-payoff-line]")).toBe(5);
  });
});

describe("PayoffLab ready state", () => {
  it("accounts for every row and starts with one line per kind of one expiry date", async () => {
    const host = await mountReady();
    expect(stateOf(host)).toBe("ready");
    expect(textOf(host, "[data-payoff-lab-counts]")).toBe(
      "9 stored rows = 7 drawable (7 lines) + 1 not drawable + 1 not shown."
    );
    expect(textOf(host, "[data-payoff-lab-reasons]")).toBe("1: no legs stored");
    expect(
      [...host.querySelectorAll("[data-payoff-picker] li")].map(
        (item) => item.textContent
      )
    ).toEqual([
      "1.Stock, hypothetical · basis 40",
      "2.Long call 100 · debit 5 · 2027-01-15",
      "3.Bull call spread 100/110 · debit 5 · 2027-01-15",
      "4.Cash-secured put 90 · credit 4 · 2027-01-15",
      "5.Put credit spread 85/95 · credit 2 · 2027-01-15",
    ]);
    expect(textOf(host, "[data-payoff-picker] legend")).toBe(
      "Lines (5 of 5 selected)"
    );
    expect(count(host, "[data-payoff-line]")).toBe(5);
    expect(count(host, "[data-payoff-row]")).toBe(5);
    expect(count(host, "[data-payoff-marker]")).toBe(1);
    expect(count(host, "[data-payoff-zero]")).toBe(1);
    // Each line has its own colour token and dash pattern.
    const strokes = [...host.querySelectorAll("[data-payoff-line]")].map(
      (path) =>
        `${path.getAttribute("stroke")}|${path.getAttribute("stroke-dasharray")}`
    );
    expect(new Set(strokes).size).toBe(5);
    expect(strokes[0]).toBe("var(--chart-1)|none");
  });

  it("shows the outcome at the starting price, the risk and the breakevens", async () => {
    const host = await mountReady();
    expect(one<HTMLInputElement>(host, "[data-payoff-price-field]").value).toBe(
      "40"
    );
    expect(lab(host).textContent).toContain(
      "Starting price: the entry basis of the hypothetical stock row. It is not a current quote."
    );
    expect(outcomes(host)).toEqual([
      "USD 0.00",
      "USD -500.00",
      "USD -500.00",
      "USD -4,600.00",
      "USD -800.00",
    ]);
    const cells = (row: number): readonly (string | null)[] =>
      [...host.querySelectorAll(`[data-payoff-row="${row}"] td`)].map(
        (cell) => cell.textContent
      );
    expect(cells(1).slice(1)).toEqual([
      "not applicable to stock",
      "USD 0.00",
      "USD 4,000.00",
      "Uncapped",
      "40",
    ]);
    expect(cells(2).slice(1)).toEqual([
      "100",
      "USD -500.00",
      "USD 500.00",
      "Uncapped",
      "105",
    ]);
    expect(cells(5).slice(1)).toEqual([
      "100",
      "USD -800.00",
      "USD 800.00",
      "USD 200.00",
      "93",
    ]);
    expect(lab(host).textContent).not.toContain(
      "Currency not stated in the dossier."
    );
    expect(count(host, "[data-payoff-limits] li")).toBe(7);
  });

  it("marks an assumed multiplier and says when the currency is not stated", async () => {
    const data = {
      strategies: [
        {
          expiry: JAN,
          kind: "long-call",
          legs: [{ premium: 5, side: "buy", strike: 100, type: "call" }],
        },
      ],
    };
    const host = await mount(
      <PayoffLab
        catalog={ready({ assetType: null, currency: null })}
        data={data}
        reportId="APP"
        today={TODAY}
      />
    );
    expect(textOf(host, '[data-payoff-row="1"] td:nth-of-type(2)')).toBe(
      "100 (assumed)"
    );
    expect(lab(host).textContent).toContain(
      "Currency not stated in the dossier."
    );
    expect(lab(host).textContent).toContain(
      "Starting price: the midpoint of the lowest and the highest strike of the first lines."
    );
    expect(outcomes(host)).toEqual(["-500.00"]);
    expect(count(host, "[data-payoff-add]")).toBe(0);
  });

  it("follows the price field and the slider", async () => {
    const host = await mountReady();
    const field = one<HTMLInputElement>(host, "[data-payoff-price-field]");
    const slider = one<HTMLInputElement>(host, "[data-payoff-price-slider]");
    const marker = (): string | null =>
      one(host, "[data-payoff-marker]").getAttribute("x1");
    const before = marker();
    await setValue(field, "120");
    expect(outcomes(host)[0]).toBe("USD 8,000.00");
    expect(outcomes(host)[1]).toBe("USD 1,500.00");
    expect(marker()).not.toBe(before);
    expect(slider.value).toBe("120");
    await setValue(slider, "100");
    expect(field.value).toBe("100");
    expect(outcomes(host)[1]).toBe("USD -500.00");

    await setValue(field, "500");
    expect(count(host, "[data-payoff-marker]")).toBe(0);
    expect(lab(host).textContent).toContain(
      "The price is outside the chart range."
    );
    expect(outcomes(host)[1]).toBe("USD 39,500.00");

    await setValue(field, "-3");
    expect(lab(host).textContent).toContain("Enter a price of 0 or more.");
    expect(outcomes(host)).toEqual(Array.from({ length: 5 }, () => "no price"));
    expect(count(host, "[data-payoff-marker]")).toBe(0);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(lab(host).textContent).toContain("Outcome at the price");
  });

  it("follows a size change and refuses an invalid size for that line only", async () => {
    const host = await mountReady();
    const size = (row: number): HTMLInputElement =>
      one<HTMLInputElement>(host, `[data-payoff-size="${row}"]`);
    const maxLoss = (row: number): string =>
      textOf(host, `[data-payoff-row="${row}"] td:nth-of-type(4)`);
    expect(size(2).value).toBe("1");
    expect(size(1).value).toBe("100");
    await setValue(size(2), "3");
    expect(maxLoss(2)).toBe("USD 1,500.00");
    expect(outcomes(host)[1]).toBe("USD -1,500.00");

    await setValue(size(2), "1.5");
    expect(textOf(host, '[data-payoff-row="2"] [role="status"]')).toBe(
      "Enter a whole number of contracts above 0."
    );
    expect(maxLoss(2)).toBe("no value");
    expect(outcomes(host)[1]).toBe("no value");
    expect(count(host, "[data-payoff-line]")).toBe(4);
    expect(count(host, '[data-payoff-line="2"]')).toBe(0);

    await setValue(size(1), "");
    expect(textOf(host, '[data-payoff-row="1"] [role="status"]')).toBe(
      "Enter a share count above 0."
    );
    expect(count(host, "[data-payoff-line]")).toBe(3);

    // A valid size that the model refuses names the reason.
    await setValue(size(2), "9".repeat(307));
    expect(textOf(host, '[data-payoff-row="2"] [role="status"]')).toBe(
      "Not drawn at this size: numbers exceed the supported range."
    );
    await setValue(size(2), "2");
    expect(count(host, '[data-payoff-row="2"] [role="status"]')).toBe(0);
    expect(maxLoss(2)).toBe("USD 1,000.00");
  });

  it("writes a profit beyond the supported range in words", async () => {
    const host = await mountReady({
      strategies: [
        {
          expiry: JAN,
          kind: "long-call",
          legs: [
            {
              multiplier: 1e300,
              premium: 5,
              side: "buy",
              strike: 100,
              type: "call",
            },
          ],
        },
      ],
    });
    await setValue(
      one<HTMLInputElement>(host, "[data-payoff-price-field]"),
      "9".repeat(300)
    );
    expect(outcomes(host)).toEqual(["beyond the supported range"]);
  });

  it("selects at most five lines, adds lines of other dates and warns about mixed dates", async () => {
    const host = await mountReady();
    const messages = (): string => textOf(host, "[data-payoff-messages]");
    expect(
      [...host.querySelectorAll("[data-payoff-add] optgroup")].map((group) => [
        group.getAttribute("label"),
        [...group.querySelectorAll("option")].map(
          (option) => option.textContent
        ),
      ])
    ).toEqual([
      ["2027-01-15 · Long call", ["Long call 130 · debit 2 · 2027-01-15"]],
      ["2027-03-19 · Long call", ["Long call 120 · debit 6 · 2027-03-19"]],
    ]);

    // A line of another date joins the picker, not selected.
    await add(host, "line-5");
    expect(pick(host, "line-5").checked).toBe(false);
    expect(count(host, "[data-payoff-picker] li")).toBe(6);
    expect(count(host, "[data-payoff-line]")).toBe(5);
    expect(messages()).toBe("");

    // A sixth selection is refused.
    await click(pick(host, "line-5"));
    expect(pick(host, "line-5").checked).toBe(false);
    expect(messages()).toBe("5 of 5 lines selected. Clear one to add another.");

    // Clearing one removes the message and renumbers the selected lines.
    await click(pick(host, "line-4"));
    expect(messages()).toBe("");
    expect(count(host, "[data-payoff-line]")).toBe(4);
    expect(textOf(host, '[data-payoff-row="1"] th')).toContain(
      "Long call 100 · debit 5 · 2027-01-15"
    );
    await click(pick(host, "line-5"));
    expect(pick(host, "line-5").checked).toBe(true);
    expect(messages()).toBe(
      "The selected lines settle on different dates. One price at expiry cannot describe all of them."
    );
    expect(textOf(host, '[data-payoff-row="5"] th')).toContain(
      "Long call 120 · debit 6 · 2027-03-19"
    );

    // The add control goes away when every line is listed; the empty choice changes nothing.
    await add(host, "");
    expect(count(host, "[data-payoff-picker] li")).toBe(6);
    await add(host, "line-6");
    expect(count(host, "[data-payoff-add]")).toBe(0);
    expect(count(host, "[data-payoff-picker] li")).toBe(7);

    // With no selected line the chart is empty and the lab says so.
    for (const box of host.querySelectorAll<HTMLInputElement>(
      "[data-payoff-pick]"
    ))
      if (box.checked) await click(box);
    expect(messages()).toBe("Select a line to draw it.");
    expect(count(host, "[data-payoff-line]")).toBe(0);
    expect(count(host, "[data-payoff-row]")).toBe(0);
    expect(textOf(host, "[data-payoff-picker] legend")).toBe(
      "Lines (0 of 5 selected)"
    );
  });

  it("marks expired lines with the UTC date mark", async () => {
    const data = {
      strategies: [
        {
          expiry: "2026-10-09",
          kind: "long-call",
          legs: [leg("buy", "call", 100, 5)],
        },
        { expiry: JAN, kind: "long-call", legs: [leg("buy", "call", 110, 5)] },
      ],
    };
    const host = await mountReady(data);
    expect(
      [...host.querySelectorAll("[data-payoff-picker] li")].map(
        (item) => item.textContent
      )
    ).toEqual(["1.Long call 110 · debit 5 · 2027-01-15"]);
    expect(textOf(host, "[data-payoff-add]")).toContain(
      "Long call 100 · debit 5 · 2026-10-09 (expired (UTC date))"
    );
    // When all expiry dates are in the past, the first set uses the latest one, with the mark.
    const later = await mount(
      <PayoffLab
        catalog={ready()}
        data={data}
        reportId="AAA"
        today="2027-06-01"
      />
    );
    expect(textOf(later, "[data-payoff-picker] li")).toBe(
      "1.Long call 110 · debit 5 · 2027-01-15expired (UTC date)"
    );
    expect(textOf(later, '[data-payoff-row="1"] th')).toContain(
      "expired (UTC date)"
    );
  });

  it("writes the singular count line and uses the dataset currency", async () => {
    const single = await mountReady({
      strategies: [STRATEGIES[0]],
    });
    expect(textOf(single, "[data-payoff-lab-counts]")).toBe(
      "1 stored row = 1 drawable (1 line) + 0 not drawable + 0 not shown."
    );
    const stated = await mountReady(
      { currency: "SEK", strategies: [STRATEGIES[4]] },
      ready({ currency: null })
    );
    expect(outcomes(stated)).toEqual(["SEK 0.00"]);
  });
});

describe("PayoffLab privacy", () => {
  it("renders no stored text and no number of a row that is not shown", async () => {
    const TEXT = "SENTINEL-TEXT";
    const NUMBER = 987_654_321;
    const free = (tag: string) => ({
      capitalRequired: NUMBER + 1,
      entryPrice: NUMBER + 2,
      id: `${TEXT}-id-${tag}`,
      maxLoss: NUMBER + 3,
      name: `${TEXT}-name-${tag}`,
      notes: [`${TEXT}-note-${tag}`],
      quantity: NUMBER + 4,
      quoteBasis: `${TEXT}-quote-${tag}`,
      status: `${TEXT}-status-${tag}`,
    });
    const data = {
      brokerRefresh: { cash: NUMBER + 5, note: `${TEXT}-broker` },
      recommendation: {
        headline: `${TEXT}-headline`,
        strategyId: `${TEXT}-id-option`,
      },
      strategies: [
        {
          ...free("order"),
          kind: "stock",
          stockEntry: NUMBER + 6,
          stockShares: NUMBER + 7,
        },
        {
          ...free("option"),
          expiry: JAN,
          kind: "long-call",
          legs: [
            {
              ...leg("buy", "call", 100, 5),
              contractSymbol: `${TEXT}-contract`,
              delta: NUMBER + 8,
            },
          ],
        },
        {
          ...free("stock"),
          hypothetical: true,
          kind: "stock",
          stockEntry: 40,
          stockShares: 100,
        },
        {
          ...free("legless"),
          expiry: `${TEXT}-expiry`,
          kind: "long-call",
          legs: [],
        },
        { ...free("kind"), kind: `${TEXT}-kind` },
      ],
      userStatedOrder: { shares: NUMBER + 9, text: `${TEXT}-order` },
    };
    const host = await mountReady(data);
    expect(stateOf(host)).toBe("ready");
    expect(textOf(host, "[data-payoff-lab-counts]")).toBe(
      "5 stored rows = 2 drawable (2 lines) + 2 not drawable + 1 not shown."
    );
    const html = lab(host).outerHTML;
    expect(html).not.toContain("SENTINEL");
    expect(html).not.toMatch(/98765432\d/u);
    expect(html).not.toMatch(/987,654,32\d/u);
  });
});
