// @vitest-environment jsdom
import type { DeepValueScoreOutput } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type DeepValueFilter,
  type DeepValueSettings,
  DeepValueWorkspace,
  deepValueSearch,
  filterDeepValueRows,
  formatMoney,
  parseDeepValueParams,
} from "./deep-value-workspace.tsx";
import type { ResearchLensesGateway } from "./research-lenses-client.ts";
import {
  deepValueFixture,
  deepValueRow,
  deepValueScore,
} from "./research-lenses-test-fixtures.ts";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  window.history.replaceState(null, "", "/");
  return document.body.replaceChildren();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const gatewayWith = (
  overrides: Partial<ResearchLensesGateway> = {}
): ResearchLensesGateway => ({
  deepValue: vi.fn(async () => deepValueFixture()),
  rotationMatrix: vi.fn(),
  score: vi.fn(async () => deepValueScore()),
  ...overrides,
});

const render = async (
  gateway: ResearchLensesGateway,
  initial?: DeepValueSettings
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      initial === undefined ? (
        <DeepValueWorkspace gateway={gateway} />
      ) : (
        <DeepValueWorkspace gateway={gateway} initial={initial} />
      )
    );
    return await flush();
  });
  return container;
};

const act$ = async (action: () => void) =>
  await act(async () => {
    action();
    return await flush();
  });

const setInput = async (
  element: HTMLInputElement | HTMLSelectElement,
  value: string
) =>
  await act$(() => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
  });

const RANKING = '[aria-labelledby="deep-value-ranking-heading"]';
const SCORE_PANEL = '[aria-labelledby="deep-value-score-heading"]';

const symbols = (container: HTMLElement) =>
  [
    ...container.querySelectorAll(
      `${RANKING} tbody th[scope="row"] [data-slot="ticker-link"]`
    ),
  ].map((element) => element.textContent);

const expander = (container: HTMLElement, symbol: string) =>
  container.querySelector(
    `button[aria-label="Scorecard for ${symbol}"]`
  ) as HTMLButtonElement;

const status = (container: HTMLElement) =>
  container
    .querySelector('[data-slot="page-status"]')
    ?.textContent?.replace(/^Status:/u, "");

const scoreBody = (container: HTMLElement) =>
  container.querySelector(`${SCORE_PANEL} [data-slot="panel-content"]`);

const buttonNamed = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (element) => element.textContent === name
  ) as HTMLButtonElement;

const submitTicker = async (container: HTMLElement, value: string) => {
  const input = container.querySelector(
    'input[placeholder="e.g. SIRI"]'
  ) as HTMLInputElement;
  await setInput(input, value);
  return await act$(() => container.querySelector("form")?.requestSubmit());
};

describe("deep value helpers", () => {
  it("formats money in billions, millions and thousands", () => {
    expect(formatMoney(2.5e9)).toBe("$2.50B");
    expect(formatMoney(278e6)).toBe("$278M");
    expect(formatMoney(5e5)).toBe("$500k");
    return expect(formatMoney(null)).toBe("–");
  });

  it("reads and writes the screen settings in the URL", () => {
    const defaults = {
      hideFlagged: false,
      minTotal: 0,
      role: "all",
      symbol: null,
      text: "",
    };
    expect(parseDeepValueParams({})).toEqual(defaults);
    expect(deepValueSearch(defaults)).toBe("");
    const custom = parseDeepValueParams({
      hide: "1",
      min: "6",
      q: "metal ore",
      show: "re-entry",
      symbol: " siri ",
    });
    expect(custom).toEqual({
      hideFlagged: true,
      minTotal: 6,
      role: "re-entry",
      symbol: "SIRI",
      text: "metal ore",
    });
    expect(deepValueSearch(custom)).toBe(
      "?symbol=SIRI&show=re-entry&min=6&hide=1&q=metal+ore"
    );
    // Unknown, out-of-range or repeated values fall back to the defaults.
    expect(
      parseDeepValueParams({
        hide: "yes",
        min: "abc",
        q: "x".repeat(101),
        show: "everything",
        symbol: "NOT A TICKER",
      })
    ).toEqual(defaults);
    // Out-of-range min scores clamp to 0..16; loose ticker shapes are rejected.
    expect(parseDeepValueParams({ min: "17" }).minTotal).toBe(16);
    expect(parseDeepValueParams({ min: "2.7" }).minTotal).toBe(2);
    expect(parseDeepValueParams({ symbol: "brk.b" }).symbol).toBe("BRK.B");
    expect(parseDeepValueParams({ symbol: "ABC123" }).symbol).toBeNull();
    expect(parseDeepValueParams({ symbol: "TOOLONG" }).symbol).toBeNull();
    expect(
      parseDeepValueParams({ min: ["1", "2"], q: ["a"], symbol: ["SIRI"] })
    ).toEqual(defaults);
    expect(parseDeepValueParams({ min: "-1" }).minTotal).toBe(0);
    return expect(deepValueSearch({ ...defaults, text: "   " })).toBe("");
  });

  return it("filters by role, text, flags and minimum total", () => {
    const rows = deepValueFixture().rows;
    const pick = (filter: Partial<DeepValueFilter>) =>
      filterDeepValueRows(rows, {
        hideFlagged: false,
        minTotal: 0,
        role: "all",
        text: "",
        ...filter,
      }).map((row) => row.symbol);
    expect(pick({})).toEqual(["TG", "SIRI", "REN"]);
    expect(pick({ role: "ours" })).toEqual(["SIRI", "REN"]);
    expect(pick({ role: "re-entry" })).toEqual(["REN"]);
    expect(pick({ text: " metal " })).toEqual(["TG", "REN"]);
    expect(pick({ text: "siri" })).toEqual(["SIRI"]);
    expect(pick({ hideFlagged: true })).toEqual(["TG", "REN"]);
    return expect(pick({ minTotal: 6 })).toEqual(["SIRI", "REN"]);
  });
});

describe("DeepValueWorkspace", () => {
  it("renders the header, the stored ranking and no score card by default", async () => {
    const gateway = gatewayWith();
    const container = await render(gateway);
    expect(container.querySelector("h1")?.textContent).toBe(
      "Deep value screen"
    );
    expect(status(container)).toBe("Scored 2026-10-21");
    expect(gateway.score).not.toHaveBeenCalled();
    expect(scoreBody(container)?.className).toContain("hidden");
    expect(container.querySelector('[aria-label$=" scorecard"]')).toBeNull();
    expect(window.location.search).toBe("");
    const text = container.textContent;
    expect(text).toContain(
      "every proxy and cutoff here is ours, not the reel's"
    );
    expect(text).toContain(
      "3 names scored 2026-10-21 20:28 UTC (2 of ours, 1 from the optional low-price universe: price ≤ $10, cap $50M–$1.00B, ≥ $100k/day"
    );
    expect(symbols(container)).toEqual(["TG", "SIRI", "REN"]);
    expect(
      [
        ...container.querySelectorAll(
          `${RANKING} tbody [data-slot="ticker-link"]`
        ),
      ].map((link) => link.getAttribute("href"))
    ).toEqual(["/stock/TG", "/stock/SIRI", "/stock/REN"]);
    expect(
      container
        .querySelector(`${RANKING} [data-slot="table-scroll"]`)
        ?.getAttribute("aria-label")
    ).toBe("TRUE SLAP ranking");
    // The screen controls sit in the ranking panel header.
    const header = container.querySelector(
      `${RANKING} [data-slot="panel-header"]`
    );
    expect(header?.querySelector("select")).not.toBeNull();
    expect(header?.querySelector('input[type="number"]')).not.toBeNull();
    expect(header?.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(header?.querySelector('input[type="search"]')).not.toBeNull();
    expect(
      container.querySelector(
        `${SCORE_PANEL} [data-slot="panel-header"] input[placeholder="e.g. SIRI"]`
      )
    ).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "3 shown"
    );
    const headers = [...container.querySelectorAll("thead th")].map(
      (cell) => cell.textContent
    );
    expect(headers).toContain("Time horizon");
    expect(text).toContain("penny");
    return expect(text).toContain(
      "Sources: Yahoo Finance; SEC EDGAR. All numeric cutoffs and proxies are ours."
    );
  });

  it("opens and closes a scorecard row", async () => {
    const container = await render(gatewayWith());
    const siri = expander(container, "SIRI");
    await act$(() => siri.click());
    const card = container.querySelector('[aria-label="SIRI scorecard"]');
    expect(siri.getAttribute("aria-expanded")).toBe("true");
    expect(card?.textContent).toContain("#2 SIRI");
    expect(card?.textContent).toContain(
      "– · cap $12.50B · industry unknown · wish list, low-price universe"
    );
    expect(card?.textContent).toContain("⚠️ Penny stock (price < $1)");
    expect(card?.textContent).toContain(
      "Source gaps: sec: SEC companyfacts returned HTTP 500"
    );
    // The ticker link plus the SEC and Finviz links.
    expect(card?.querySelectorAll("a")).toHaveLength(3);
    expect(
      card?.querySelector('[data-slot="ticker-link"]')?.getAttribute("href")
    ).toBe("/stock/SIRI");
    await act$(() => siri.click());
    expect(siri.getAttribute("aria-expanded")).toBe("false");
    return expect(
      container.querySelector('[aria-label="SIRI scorecard"]')
    ).toBeNull();
  });

  it("applies the filter controls and writes them to the URL", async () => {
    const container = await render(gatewayWith());
    await setInput(
      container.querySelector("select") as HTMLSelectElement,
      "re-entry"
    );
    expect(symbols(container)).toEqual(["REN"]);
    expect(window.location.search).toBe("?show=re-entry");
    await setInput(
      container.querySelector("select") as HTMLSelectElement,
      "all"
    );
    const checkbox = container.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    await act$(() => checkbox.click());
    expect(symbols(container)).toEqual(["TG", "REN"]);
    expect(window.location.search).toBe("?hide=1");
    await act$(() => checkbox.click());
    const number = container.querySelector(
      'input[type="number"]'
    ) as HTMLInputElement;
    await setInput(number, "6");
    expect(symbols(container)).toEqual(["SIRI", "REN"]);
    expect(window.location.search).toBe("?min=6");
    await setInput(number, "");
    await setInput(
      container.querySelector('input[type="search"]') as HTMLInputElement,
      "tg"
    );
    expect(window.location.search).toBe("?q=tg");
    return expect(symbols(container)).toEqual(["TG"]);
  });

  it("starts from the URL settings, scores the URL ticker and resets filters that match nothing", async () => {
    window.history.replaceState(null, "", "/deep-value#screen");
    const score = vi.fn(async () => deepValueScore());
    const container = await render(gatewayWith({ score }), {
      hideFlagged: true,
      minTotal: 15,
      role: "ours",
      symbol: "SIRI",
      text: "",
    });
    expect(score).toHaveBeenCalledWith("SIRI");
    expect(
      (
        container.querySelector(
          'input[placeholder="e.g. SIRI"]'
        ) as HTMLInputElement
      ).value
    ).toBe("SIRI");
    expect(scoreBody(container)?.className).not.toContain("hidden");
    expect(
      scoreBody(container)?.querySelector('[aria-label="SIRI scorecard"]')
    ).not.toBeNull();
    expect(window.location.pathname).toBe("/deep-value");
    expect(window.location.search).toBe("?symbol=SIRI&show=ours&min=15&hide=1");
    expect(window.location.hash).toBe("#screen");
    expect(symbols(container)).toEqual([]);
    expect(container.textContent).toContain(
      "No scored name matches these filters."
    );
    await act$(() => buttonNamed(container, "Reset filters").click());
    expect(symbols(container)).toEqual(["TG", "SIRI", "REN"]);
    expect(window.location.search).toBe("?symbol=SIRI");
    await act$(() => buttonNamed(container, "Clear").click());
    expect(window.location.search).toBe("");
    expect(scoreBody(container)?.className).toContain("hidden");
    expect(
      (
        container.querySelector(
          'input[placeholder="e.g. SIRI"]'
        ) as HTMLInputElement
      ).value
    ).toBe("");
    return expect(buttonNamed(container, "Clear")).toBeUndefined();
  });

  it("lists at most 300 rows and uses the fallback criteria when none are stored", async () => {
    const rows = Array.from({ length: 301 }, (_, index) =>
      deepValueRow(`S${index}`, { rank: index + 1 })
    );
    const container = await render(
      gatewayWith({
        deepValue: vi.fn(async () => deepValueFixture({ criteria: [], rows })),
      })
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "301 shown (first 300 listed)"
    );
    expect(symbols(container)).toHaveLength(300);
    const headers = [...container.querySelectorAll("thead th")].map(
      (cell) => cell.textContent
    );
    expect(headers).toContain("Longevity");
    await act$(() => expander(container, "S0").click());
    const card = container.querySelector('[aria-label="S0 scorecard"]');
    // Criteria without a stored result show a dash.
    return expect(card?.textContent).toContain("Longevity–");
  });

  it("keeps foreign URL params, drops an invalid URL ticker and clamps inputs", async () => {
    window.history.replaceState(
      null,
      "",
      "/deep-value?theme=light&symbol=bad1&min=3"
    );
    const gateway = gatewayWith();
    const container = await render(
      gateway,
      parseDeepValueParams({ min: "3", symbol: "bad1", theme: "light" })
    );
    expect(gateway.score).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?theme=light&min=3");
    const min = container.querySelector(
      'input[type="number"]'
    ) as HTMLInputElement;
    await setInput(min, "99");
    expect(min.value).toBe("16");
    expect(window.location.search).toBe("?theme=light&min=16");
    await setInput(min, "-4");
    expect(min.value).toBe("0");
    expect(window.location.search).toBe("?theme=light");
    const filter = container.querySelector(
      'input[type="search"]'
    ) as HTMLInputElement;
    expect(filter.maxLength).toBe(100);
    const ticker = container.querySelector(
      'input[placeholder="e.g. SIRI"]'
    ) as HTMLInputElement;
    expect(ticker.maxLength).toBe(7);
    return expect(ticker.value).toBe("");
  });

  it("shows an inline alert for an invalid typed ticker without calling the server", async () => {
    const gateway = gatewayWith();
    const container = await render(gateway);
    await submitTicker(container, "12$");
    const alert = container.querySelector("#deep-value-ticker-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe("Enter a ticker like AAPL or BRK.B");
    const ticker = container.querySelector(
      'input[placeholder="e.g. SIRI"]'
    ) as HTMLInputElement;
    expect(ticker.getAttribute("aria-invalid")).toBe("true");
    expect(gateway.score).not.toHaveBeenCalled();
    await setInput(ticker, "SIR");
    expect(container.querySelector("#deep-value-ticker-error")).toBeNull();
    await submitTicker(container, "1");
    expect(container.querySelector("#deep-value-ticker-error")).not.toBeNull();
    await submitTicker(container, "   ");
    expect(container.querySelector("#deep-value-ticker-error")).toBeNull();
    expect(gateway.score).not.toHaveBeenCalled();
    await submitTicker(container, "siri");
    expect(gateway.score).toHaveBeenCalledTimes(1);
    await submitTicker(container, "9");
    expect(container.querySelector("#deep-value-ticker-error")).not.toBeNull();
    await act$(() => buttonNamed(container, "Clear").click());
    expect(container.querySelector("#deep-value-ticker-error")).toBeNull();
    return expect(gateway.score).toHaveBeenCalledTimes(1);
  });

  it("scores one ticker on demand, again on resubmit, and keeps it in the URL", async () => {
    const score = vi.fn(async () => deepValueScore());
    const container = await render(gatewayWith({ score }));
    await submitTicker(container, "   ");
    expect(score).not.toHaveBeenCalled();
    expect(scoreBody(container)?.className).toContain("hidden");
    await submitTicker(container, " siri ");
    expect(score).toHaveBeenCalledWith("SIRI");
    expect(window.location.search).toBe("?symbol=SIRI");
    const card = container.querySelector('[aria-label="SIRI scorecard"]');
    expect(card?.textContent).toContain("$7.96 · cap $500k");
    expect(card?.textContent).toContain("requested");
    expect(container.textContent).not.toContain("No stored industry median");
    expect(card?.textContent).toContain("3/16");
    await act$(() => container.querySelector("form")?.requestSubmit());
    return expect(score).toHaveBeenCalledTimes(2);
  });

  it("notes a missing peer median, shows scoring progress and errors", async () => {
    let finish: (value: DeepValueScoreOutput) => void = () => undefined;
    const score = vi
      .fn<ResearchLensesGateway["score"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("No price or SEC data for ZZZZ"), {
          code: "NOT_FOUND",
        })
      );
    const container = await render(gatewayWith({ score }));
    await submitTicker(container, "SIRI");
    const submit = container.querySelector(
      'button[type="submit"]'
    ) as HTMLButtonElement;
    expect(submit.textContent).toBe("Scoring…");
    expect(submit.disabled).toBe(true);
    expect(scoreBody(container)?.textContent).toBe("Scoring SIRI…");
    await act$(() => finish(deepValueScore({ peerMedian: null })));
    expect(container.textContent).toContain(
      "No stored industry median for this ticker"
    );
    await submitTicker(container, "ZZZZ");
    return expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not score: No price or SEC data for ZZZZ"
    );
  });

  it("keeps the newest ticker when an older score arrives late", async () => {
    let finishOld: (value: DeepValueScoreOutput) => void = () => undefined;
    const score = vi
      .fn<ResearchLensesGateway["score"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          })
      )
      .mockResolvedValueOnce(deepValueScore({ symbol: "TG" }));
    const container = await render(gatewayWith({ score }));
    await submitTicker(container, "SIRI");
    await submitTicker(container, "TG");
    await act$(() => finishOld(deepValueScore()));
    expect(container.querySelector('[aria-label="SIRI scorecard"]')).toBeNull();
    return expect(
      container.querySelector('[aria-label="TG scorecard"]')
    ).not.toBeNull();
  });

  it("shows an unknown price date and creates the browser gateway when none is supplied", async () => {
    const container = await render(gatewayWith());
    await act$(() => expander(container, "REN").click());
    expect(
      container.querySelector('[aria-label="REN scorecard"]')?.textContent
    ).toContain("prices as of –");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    try {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      roots.push(root);
      await act(async () => {
        root.render(<DeepValueWorkspace />);
        for (let index = 0; index < 200; index += 1) await Promise.resolve();
      });
      return expect(host.textContent).toMatch(
        /Loading ranking|Stored ranking unavailable/u
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  return it("shows loading, the operator notice, a retry and a refresh for the stored ranking", async () => {
    const pending = await render(
      gatewayWith({
        deepValue: vi.fn(() => new Promise<never>(() => undefined)),
      })
    );
    expect(pending.textContent).toContain("Loading ranking…");
    expect(status(pending)).toBe("Loading");
    expect(buttonNamed(pending, "Refresh").disabled).toBe(true);
    let fail = true;
    const deepValue = vi.fn(async () => {
      if (fail)
        throw Object.assign(new Error("Forbidden"), {
          code: "FORBIDDEN",
          status: 403,
        });
      return deepValueFixture();
    });
    const container = await render(gatewayWith({ deepValue }));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Stored ranking unavailable:");
    expect(status(container)).toBe("Unavailable");
    fail = false;
    await act$(() => alert?.querySelector("button")?.click());
    expect(symbols(container)).toEqual(["TG", "SIRI", "REN"]);
    await act$(() => buttonNamed(container, "Refresh").click());
    expect(deepValue).toHaveBeenCalledTimes(3);
    return expect(symbols(container)).toEqual(["TG", "SIRI", "REN"]);
  });
});
