// @vitest-environment jsdom
import {
  OWNER_RISK_CAPS,
  RiskAllocatorInputSchema,
  suggestAllocation,
  type WatchlistItemOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createBrowserRiskAllocatorGateway,
  createRiskAllocatorGateway,
  type RiskAllocatorGateway,
} from "./risk-allocator-client.ts";
import {
  parseRiskAllocatorParams,
  type RiskAllocatorSettings,
} from "./risk-allocator-params.ts";
import {
  createBrowserRiskAllocatorWatchlist,
  invalidAmountFields,
  parseAmount,
  RISK_ALLOCATOR_DEFAULTS,
  type RiskAllocatorForm,
  type RiskAllocatorWatchlist,
  RiskAllocatorWorkspace,
  toAllocatorInput,
} from "./risk-allocator-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  window.history.replaceState(null, "", "/");
  document.body.replaceChildren();
});

const localGateway = (): RiskAllocatorGateway => ({
  caps: async () => OWNER_RISK_CAPS,
  suggest: async (input) =>
    suggestAllocation(RiskAllocatorInputSchema.parse(input)),
});

const watchlistItem = (symbol: string): WatchlistItemOutput => ({
  buyZoneHigh: null,
  buyZoneLow: null,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  id: `item-${symbol}`,
  note: null,
  symbol,
  updatedAt: new Date("2026-10-01T00:00:00.000Z"),
});

const watchlistOf = (...symbols: string[]): RiskAllocatorWatchlist => ({
  list: vi.fn(async () => symbols.map(watchlistItem)),
});

const render = async (
  gateway: RiskAllocatorGateway,
  options: {
    readonly initial?: RiskAllocatorSettings;
    readonly watchlist?: RiskAllocatorWatchlist;
  } = {}
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      options.initial === undefined ? (
        <RiskAllocatorWorkspace
          gateway={gateway}
          initialAsOf="2026-10-22"
          watchlist={options.watchlist ?? watchlistOf()}
        />
      ) : (
        <RiskAllocatorWorkspace
          gateway={gateway}
          initial={options.initial}
          initialAsOf="2026-10-22"
          watchlist={options.watchlist ?? watchlistOf()}
        />
      )
    )
  );
  return container;
};

const CAPS_PANEL = '[aria-labelledby="owner-caps-heading"]';
const SUGGESTION_PANEL = '[aria-labelledby="risk-suggestion-heading"]';

const alertIn = (container: HTMLElement, panel: string) =>
  container.querySelector(`${panel} [role="alert"]`)?.textContent;

const fieldValue = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)
    ?.value;

const defaultHint = (container: HTMLElement, key: string) =>
  container.querySelector(`[data-default-for="${key}"]`)?.textContent;

const setValue = async (container: HTMLElement, id: string, value: string) => {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    `#${id}`
  );
  if (element === null) throw new Error(`missing ${id}`);
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const submit = async (container: HTMLElement) =>
  act(async () =>
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );

const baseForm: RiskAllocatorForm = {
  asOf: "2026-10-22",
  copyNameExposure: "",
  copyTotalExposure: "",
  crownCopy: false,
  expiry: "2027-12-17",
  kind: "option",
  nlv: "1,000,000",
  openPremium: "",
  symbol: " msft ",
  unitCost: "5000",
};

describe("toAllocatorInput", () => {
  it("maps the form and adds open premium and copy exposure as positions", () => {
    expect(toAllocatorInput(baseForm)).toMatchObject({
      candidates: [{ crownCopy: false, expiry: "2027-12-17", symbol: "MSFT" }],
      nlv: 1_000_000,
      positions: [],
    });
    const copy = toAllocatorInput({
      ...baseForm,
      copyNameExposure: "40000",
      copyTotalExposure: "100000",
      crownCopy: true,
      kind: "share",
      openPremium: "",
      symbol: "OTHER",
    });
    expect(copy.candidates[0]?.expiry).toBeNull();
    expect(copy.positions).toEqual([
      { crownCopy: true, kind: "share", symbol: "OTHER", value: 40_000 },
      { crownCopy: true, kind: "share", symbol: "OTHRS", value: 60_000 },
    ]);
    expect(
      toAllocatorInput({ ...baseForm, expiry: "", openPremium: "3000" })
    ).toMatchObject({
      candidates: [{ expiry: null }],
      positions: [{ kind: "option", value: 3000 }],
    });
    // The submit handler rejects unparseable text first; this mapping alone treats it as 0.
    expect(
      toAllocatorInput({ ...baseForm, openPremium: "abc" }).positions
    ).toEqual([]);
  });
});

describe("amount validation", () => {
  it("parses plain and comma-grouped amounts and rejects the rest", () => {
    expect(parseAmount("  ")).toBe(0);
    expect(parseAmount("1,500.25")).toBe(1500.25);
    expect(parseAmount(".5")).toBe(0.5);
    for (const bad of ["$1,500", "1.5k", "abc", "-200", "1,5", "1e3", "."])
      expect(parseAmount(bad)).toBeNull();
    expect(parseAmount("9".repeat(400))).toBeNull();
  });

  it("names every unparseable field, copy fields only for a copy leg", () => {
    const bad = {
      ...baseForm,
      copyNameExposure: "x",
      copyTotalExposure: "y",
      kind: "share" as const,
      nlv: "-1",
      openPremium: "abc",
      unitCost: "1.5k",
    };
    expect(invalidAmountFields(bad)).toEqual([
      "Price per share (USD)",
      "Net liquidation value (USD)",
      "Option premium already open in this name",
    ]);
    expect(invalidAmountFields({ ...bad, crownCopy: true })).toHaveLength(5);
    expect(invalidAmountFields(baseForm)).toEqual([]);
  });

  it("shows an error and sends nothing for an unparseable exposure", async () => {
    const suggest = vi.fn<RiskAllocatorGateway["suggest"]>();
    const container = await render({
      caps: async () => OWNER_RISK_CAPS,
      suggest,
    });
    await setValue(container, "risk-openPremium", "$1,500");
    await submit(container);
    expect(suggest).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Enter a number of 0 or more (commas allowed) for: Option premium already open in this name."
    );
  });
});

describe("RiskAllocatorWorkspace", () => {
  it("shows the caps and a LEAPS option size under the options-only rule set", async () => {
    const container = await render(localGateway());
    expect(container.textContent).toContain("Owner risk caps");
    expect(container.textContent).toContain("2% NLV for LEAPS");
    expect(
      container.querySelector('[data-testid="leaps-pending"]')?.textContent
    ).toContain("Pending: 6% NLV for LEAPS");
    await setValue(container, "risk-symbol", "msft");
    await setValue(container, "risk-expiry", "2027-12-17");
    await setValue(container, "risk-unitCost", "5000");
    await setValue(container, "risk-nlv", "1000000");
    await submit(container);
    expect(container.querySelector("[data-rule-set]")?.textContent).toContain(
      "Options only"
    );
    expect(container.textContent).toContain("LEAPS");
    expect(
      container.querySelector('[data-testid="max-units"]')?.textContent
    ).toContain("Max 4 contracts");
    expect(container.textContent).toContain("(binding)");
  });

  it("never sizes shares for a non-Crown name", async () => {
    const container = await render(localGateway());
    await setValue(container, "risk-kind", "share");
    expect(container.querySelector("#risk-expiry")).toBeNull();
    await setValue(container, "risk-symbol", "AAPL");
    await setValue(container, "risk-unitCost", "200");
    await setValue(container, "risk-nlv", "1000000");
    await submit(container);
    expect(
      container.querySelector('[data-testid="max-units"]')?.textContent
    ).toContain("Max 0 shares");
    expect(container.textContent).toContain("Options only:");
    expect(container.querySelector("table")).toBeNull();
  });

  it("uses the copy-book caps for a Crown copy leg", async () => {
    const container = await render(localGateway());
    await setValue(container, "risk-kind", "share");
    await act(async () =>
      container.querySelector<HTMLInputElement>("#risk-crownCopy")?.click()
    );
    await setValue(container, "risk-symbol", "XOM");
    await setValue(container, "risk-unitCost", "100");
    await setValue(container, "risk-nlv", "1000000");
    await setValue(container, "risk-copyNameExposure", "60000");
    await setValue(container, "risk-copyTotalExposure", "100000");
    await submit(container);
    expect(container.querySelector("[data-rule-set]")?.textContent).toContain(
      "Crown copy book"
    );
    expect(container.textContent).toContain("Max 400 shares");
    await setValue(container, "risk-kind", "option");
    expect(container.querySelector("#risk-expiry")).not.toBeNull();
  });

  it("reports caps and suggestion failures in their own panels", async () => {
    const forbidden = Object.assign(new Error("no"), { code: "FORBIDDEN" });
    const container = await render({
      caps: () => Promise.reject(forbidden),
      suggest: () => Promise.reject(new Error("  ")),
    });
    expect(alertIn(container, CAPS_PANEL)).toBe("Operator access required.");
    expect(container.querySelector('[data-slot="kpi-row"]')).toBeNull();
    await setValue(container, "risk-symbol", "MSFT");
    await submit(container);
    expect(alertIn(container, SUGGESTION_PANEL)).toBe("Request failed.");
    const other = await render({
      caps: async () => OWNER_RISK_CAPS,
      suggest: () => Promise.reject(new Error(" Bad input ")),
    });
    await setValue(other, "risk-symbol", "MSFT");
    await submit(other);
    expect(alertIn(other, SUGGESTION_PANEL)).toBe("Bad input");
  });

  it("ignores caps and watchlist results that arrive after unmount", async () => {
    let resolve: (value: typeof OWNER_RISK_CAPS) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    let resolveList: (items: WatchlistItemOutput[]) => void = () => undefined;
    let rejectList: (error: unknown) => void = () => undefined;
    const late = await render(
      {
        caps: () =>
          new Promise((ok) => {
            resolve = ok;
          }),
        suggest: vi.fn(),
      },
      {
        watchlist: {
          list: () =>
            new Promise((ok) => {
              resolveList = ok;
            }),
        },
      }
    );
    const lateFail = await render(
      {
        caps: () =>
          new Promise((_ok, fail) => {
            reject = fail;
          }),
        suggest: vi.fn(),
      },
      {
        watchlist: {
          list: () =>
            new Promise((_ok, fail) => {
              rejectList = fail;
            }),
        },
      }
    );
    expect(late.textContent).toContain("Loading caps…");
    expect(late.textContent).toContain("Loading watchlist…");
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      resolve(OWNER_RISK_CAPS);
      reject(new Error("late"));
      resolveList([watchlistItem("MSFT")]);
      rejectList(new Error("late"));
    });
    expect(late.textContent).toBe("");
    expect(lateFail.textContent).toBe("");
  });

  it("sizes the first watchlist symbol by default with labelled default inputs", async () => {
    const suggest = vi.fn(localGateway().suggest);
    const watchlist = watchlistOf("NVDA", "AAPL");
    const container = await render(
      { caps: async () => OWNER_RISK_CAPS, suggest },
      { watchlist }
    );
    expect(container.querySelector("h1")?.textContent).toBe("Risk allocator");
    expect(
      container
        .querySelector('[data-slot="page-status"]')
        ?.textContent?.replace(/^Status:/u, "")
    ).toBe("Advisory only");
    expect(watchlist.list).toHaveBeenCalledTimes(1);
    expect(fieldValue(container, "risk-symbol")).toBe("NVDA");
    expect(fieldValue(container, "risk-kind")).toBe("option");
    expect(fieldValue(container, "risk-unitCost")).toBe(
      RISK_ALLOCATOR_DEFAULTS.unitCost
    );
    expect(fieldValue(container, "risk-nlv")).toBe(RISK_ALLOCATOR_DEFAULTS.nlv);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest.mock.calls[0]?.[0]).toEqual({
      asOf: "2026-10-22",
      candidates: [
        {
          crownCopy: false,
          expiry: null,
          kind: "option",
          symbol: "NVDA",
          unitCost: 500,
        },
      ],
      nlv: 100_000,
      positions: [],
    });
    // Every defaulted input says so next to the field.
    expect(defaultHint(container, "kind")).toBe("Default: Option");
    expect(defaultHint(container, "expiry")).toBe(
      "Default: blank (sized with the shorter-dated cap)"
    );
    expect(defaultHint(container, "unitCost")).toBe(
      "Default: 500 (example cost, not a quote)"
    );
    expect(defaultHint(container, "nlv")).toBe(
      "Default: 100,000 (example account size, not yours)"
    );
    expect(defaultHint(container, "asOf")).toBe("Default: today");
    expect(
      container.querySelector("#risk-nlv")?.getAttribute("aria-describedby")
    ).toBe("risk-nlv-default");
    expect(
      container.querySelector("#risk-symbol")?.hasAttribute("aria-describedby")
    ).toBe(false);
    const panel = container.querySelector(SUGGESTION_PANEL);
    expect(panel?.textContent).toContain(
      "Sizing NVDA, the first symbol on your watchlist."
    );
    expect(
      panel?.querySelector('[aria-label="Suggestion for NVDA"]')
    ).not.toBeNull();
    expect(
      panel?.querySelector('[data-testid="max-units"]')?.textContent
    ).toMatch(/^Max \d+ contracts/u);
    // The caps stay read only: a KPI row with the real cap numbers and the caps panel.
    expect(
      container.querySelector('[data-kpi="leaps"]')?.textContent
    ).toContain(`${OWNER_RISK_CAPS.leapsPremiumPct}% NLV`);
    expect(
      container.querySelector('[data-kpi="short"]')?.textContent
    ).toContain(`${OWNER_RISK_CAPS.shortPremiumPct}% NLV`);
    expect(container.querySelector('[data-kpi="copy"]')?.textContent).toContain(
      `${OWNER_RISK_CAPS.copyBookNamePct}% / ${OWNER_RISK_CAPS.copyBookTotalPct}%`
    );
    expect(container.querySelector(CAPS_PANEL)?.textContent).toContain(
      "It does not enforce or change them."
    );
    expect(container.querySelector('section[role="region"]')).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("sizes the URL symbol without reading the watchlist", async () => {
    const suggest = vi.fn(localGateway().suggest);
    const watchlist = watchlistOf("AAPL");
    const container = await render(
      { caps: async () => OWNER_RISK_CAPS, suggest },
      { initial: { symbol: "TSLA" }, watchlist }
    );
    expect(watchlist.list).not.toHaveBeenCalled();
    expect(fieldValue(container, "risk-symbol")).toBe("TSLA");
    expect(suggest.mock.calls[0]?.[0].candidates[0]?.symbol).toBe("TSLA");
    expect(container.querySelector(SUGGESTION_PANEL)?.textContent).toContain(
      "Sizing TSLA from the link."
    );
    expect(container.textContent).not.toContain("Loading watchlist…");
    expect(container.querySelector('section[role="region"]')).toBeNull();
  });

  it("explains how to get a suggestion when the watchlist is empty", async () => {
    window.history.replaceState(null, "", "/risk-allocator#size");
    const suggest = vi.fn(localGateway().suggest);
    const container = await render({
      caps: async () => OWNER_RISK_CAPS,
      suggest,
    });
    expect(suggest).not.toHaveBeenCalled();
    const empty = container.querySelector(
      `${SUGGESTION_PANEL} section[role="region"]`
    );
    expect(empty?.querySelector("h3")?.textContent).toBe(
      "No watchlist symbol to size"
    );
    expect(empty?.textContent).toContain("Add a symbol there");
    expect(empty?.querySelector("a")?.getAttribute("href")).toBe("/watchlist");
    expect(
      container.querySelector(
        `${SUGGESTION_PANEL} [data-slot="panel-header"] p`
      )
    ).toBeNull();
    // The form stays usable: a manual symbol replaces the empty state and lands in the URL.
    await setValue(container, "risk-symbol", " msft ");
    await submit(container);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(container.querySelector('section[role="region"]')).toBeNull();
    expect(window.location.pathname).toBe("/risk-allocator");
    expect(window.location.search).toBe("?symbol=MSFT");
    expect(window.location.hash).toBe("#size");
    await setValue(container, "risk-symbol", "not a symbol");
    await submit(container);
    expect(window.location.search).toBe("");
  });

  it("keeps the form usable when the watchlist cannot be read", async () => {
    const suggest = vi.fn(localGateway().suggest);
    const container = await render(
      { caps: async () => OWNER_RISK_CAPS, suggest },
      {
        watchlist: {
          list: () =>
            Promise.reject(
              Object.assign(new Error("x"), { code: "FORBIDDEN" })
            ),
        },
      }
    );
    expect(alertIn(container, SUGGESTION_PANEL)).toBe(
      "Watchlist unavailable: Not permitted for this session. Enter a symbol below to get a suggestion."
    );
    expect(suggest).not.toHaveBeenCalled();
    expect(container.querySelector('section[role="region"]')).toBeNull();
  });

  it("does not replace a symbol typed before the watchlist loads", async () => {
    let resolveList: (items: WatchlistItemOutput[]) => void = () => undefined;
    const suggest = vi.fn(localGateway().suggest);
    const container = await render(
      { caps: async () => OWNER_RISK_CAPS, suggest },
      {
        watchlist: {
          list: () =>
            new Promise((ok) => {
              resolveList = ok;
            }),
        },
      }
    );
    await setValue(container, "risk-symbol", "AMD");
    await act(async () => resolveList([watchlistItem("NVDA")]));
    expect(fieldValue(container, "risk-symbol")).toBe("AMD");
    expect(suggest).not.toHaveBeenCalled();
    expect(
      container.querySelector(SUGGESTION_PANEL)?.textContent
    ).not.toContain("the first symbol on your watchlist");
  });
});

describe("risk allocator URL settings", () => {
  it("reads and writes ?symbol=", () => {
    expect(parseRiskAllocatorParams({})).toEqual({ symbol: null });
    expect(parseRiskAllocatorParams({ symbol: " brk.b " })).toEqual({
      symbol: "BRK.B",
    });
    expect(parseRiskAllocatorParams({ symbol: "TOO LONG" })).toEqual({
      symbol: null,
    });
    expect(parseRiskAllocatorParams({ symbol: ["MSFT"] })).toEqual({
      symbol: null,
    });
  });
});

describe("RiskAllocatorWorkspace defaults", () => {
  it("keeps foreign query parameters when the symbol is written", async () => {
    window.history.replaceState(
      null,
      "",
      "/risk-allocator?theme=light&symbol=NVDA#x"
    );
    const container = await render(localGateway(), {
      initial: { symbol: "NVDA" },
      watchlist: watchlistOf(),
    });
    await setValue(container, "risk-symbol", "amd");
    await submit(container);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("theme")).toBe("light");
    expect(params.get("symbol")).toBe("AMD");
    expect(window.location.hash).toBe("#x");
    await setValue(container, "risk-symbol", "");
    await submit(container);
    expect(window.location.search).toBe("?theme=light");
  });

  it("describes the computed suggestion, not the live form symbol", async () => {
    const container = await render(localGateway(), {
      initial: { symbol: "NVDA" },
      watchlist: watchlistOf(),
    });
    await setValue(container, "risk-symbol", "AMD");
    const text = container.querySelector(SUGGESTION_PANEL)?.textContent;
    expect(text).toContain("Sizing NVDA from the link.");
    expect(text).not.toContain("AMD from");
  });

  it("mounts the live region before the first result", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const container = await render(
      {
        caps: async () => OWNER_RISK_CAPS,
        suggest: async (input) => {
          await gate;
          return localGateway().suggest(input);
        },
      },
      { initial: { symbol: "NVDA" }, watchlist: watchlistOf() }
    );
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe("");
    await act(async () => release());
    expect(container.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live?.textContent).not.toBe("");
  });

  it("narrows the browser watchlist to list only", () => {
    const watchlist = createBrowserRiskAllocatorWatchlist();
    expect(Object.keys(watchlist)).toEqual(["list"]);
    expect(typeof watchlist.list).toBe("function");
  });

  it("uses the browser gateway and today's date when no props are given", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 500 }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<RiskAllocatorWorkspace />));
    expect(container.querySelector<HTMLInputElement>("#risk-asOf")?.value).toBe(
      new Date().toLocaleDateString("en-CA")
    );
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("omits the options-only sentence when the caps say so", async () => {
    const container = await render({
      ...localGateway(),
      caps: async () => ({
        ...OWNER_RISK_CAPS,
        leapsPremiumPending: null,
        optionsOnly: false,
      }),
    });
    expect(container.textContent).not.toContain("Options only. ");
    expect(container.querySelector('[data-testid="leaps-pending"]')).toBeNull();
  });
});

describe("risk allocator gateway", () => {
  it("calls the riskAllocator procedures", async () => {
    const caps = vi.fn(async () => OWNER_RISK_CAPS);
    const suggest = vi.fn(async () => ({
      advisoryOnly: true as const,
      rows: [],
    }));
    const client = {
      riskAllocator: { caps, suggest },
    } as unknown as Parameters<typeof createRiskAllocatorGateway>[0];
    const gateway = createRiskAllocatorGateway(client);
    await gateway.caps();
    const input = toAllocatorInput(baseForm);
    await gateway.suggest(input);
    expect(caps).toHaveBeenCalledWith({});
    expect(suggest).toHaveBeenCalledWith(input);
  });

  it("builds a browser client lazily against the page origin", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 500 }));
    const gateway = createBrowserRiskAllocatorGateway();
    await expect(gateway.caps()).rejects.toBeDefined();
    await expect(
      gateway.suggest(toAllocatorInput(baseForm))
    ).rejects.toBeDefined();
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
