// @vitest-environment jsdom
import type { RotationMatrixOutput } from "@darkfactory/api";
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

import type { ResearchLensesGateway } from "./research-lenses-client.ts";
import { rotationFixture } from "./research-lenses-test-fixtures.ts";
import {
  parseRotationMatrixParams,
  type RotationMatrixSettings,
  rotationMatrixSearch,
} from "./rotation-matrix-params.ts";
import {
  formatReturn,
  generatedPhrase,
  heatColor,
  RotationMatrixWorkspace,
} from "./rotation-matrix-workspace.tsx";

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
  vi.useRealTimers();
  return document.body.replaceChildren();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const gatewayWith = (
  rotationMatrix: ResearchLensesGateway["rotationMatrix"]
): ResearchLensesGateway => ({
  deepValue: vi.fn(),
  rotationMatrix,
  score: vi.fn(),
});

const render = async (
  gateway: ResearchLensesGateway,
  initial?: RotationMatrixSettings
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      initial === undefined ? (
        <RotationMatrixWorkspace gateway={gateway} />
      ) : (
        <RotationMatrixWorkspace gateway={gateway} initial={initial} />
      )
    );
    return await flush();
  });
  return container;
};

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  return await act(async () => {
    (element as HTMLElement).click();
    return await flush();
  });
};

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find(
    (element) =>
      element.textContent === text ||
      element.getAttribute("aria-label") === text
  );

const typeFilter = async (container: HTMLElement, value: string) => {
  const input = container.querySelector(
    'input[type="search"]'
  ) as HTMLInputElement;
  return await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return await flush();
  });
};

const industryRows = (container: HTMLElement) =>
  [...container.querySelectorAll('tbody th[scope="row"]')].map(
    (cell) => cell.textContent
  );

const kpi = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-kpi="${id}"]`)?.textContent;

const status = (container: HTMLElement) =>
  container
    .querySelector('[data-slot="page-status"]')
    ?.textContent?.replace(/^Status:/u, "");

describe("rotation matrix helpers", () => {
  it("colors gains green, losses red and unknown values transparent", () => {
    expect(heatColor(10, "1M")).toBe("rgba(22, 163, 74, 0.85)");
    expect(heatColor(-1.5, "1D")).toBe("rgba(220, 38, 38, 0.50)");
    expect(heatColor(-100, "6M")).toBe("rgba(220, 38, 38, 0.85)");
    expect(heatColor(null, "3M")).toBe("transparent");
    return expect(heatColor(Number.NaN, "3M")).toBe("transparent");
  });

  it("words the generation time as a phrase, also when it is not a time", () => {
    const now = new Date("2026-10-21T20:00:00.000Z");
    expect(generatedPhrase("2026-10-21T17:10:32.981Z", now)).toBe(
      "generated 17:10 UTC"
    );
    expect(generatedPhrase("2026-10-20T17:10:32.981Z", now)).toBe(
      "generated 2026-10-20 17:10 UTC"
    );
    expect(generatedPhrase("last night", now)).toBe(
      "generated at a time that cannot be read"
    );
    return expect(generatedPhrase("")).toBe(
      "generated at a time that cannot be read"
    );
  });

  it("formats returns with a sign", () => {
    expect(formatReturn(4.26)).toBe("+4.3%");
    expect(formatReturn(-2)).toBe("-2.0%");
    expect(formatReturn(0)).toBe("0.0%");
    expect(formatReturn(null)).toBe("no return");
    expect(formatReturn(undefined, 4)).toBe("no return");
    expect(formatReturn(null, 0)).toBe("no name has a return");
    return expect(formatReturn(1.5, 0)).toBe("+1.5%");
  });

  return it("reads and writes the period URL parameter", () => {
    expect(parseRotationMatrixParams({})).toEqual({ period: "1M" });
    expect(parseRotationMatrixParams({ period: "3M" })).toEqual({
      period: "3M",
    });
    expect(parseRotationMatrixParams({ period: "2Y" })).toEqual({
      period: "1M",
    });
    expect(rotationMatrixSearch({ period: "1M" })).toBe("");
    return expect(rotationMatrixSearch({ period: "6M" })).toBe("?period=6M");
  });
});

describe("RotationMatrixWorkspace", () => {
  it("renders the header, KPIs, summary, our names and the grouped matrix by default", async () => {
    const rotationMatrix = vi.fn(async () => rotationFixture());
    const container = await render(gatewayWith(rotationMatrix));
    expect(rotationMatrix).toHaveBeenCalledWith("1M");
    expect(container.querySelector("h1")?.textContent).toBe("Rotation matrix");
    expect(status(container)).toBe("As of 2026-10-21");
    expect(window.location.search).toBe("");
    expect(button(container, "1M")?.getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "6M")?.getAttribute("aria-pressed")).toBe("false");
    expect(kpi(container, "leading")).toBe(
      "Leading industry (1M)+6.0%Oil & Gas Production"
    );
    expect(kpi(container, "lagging")).toBe(
      "Lagging industry (1M)-2.5%Water Supply"
    );
    expect(kpi(container, "standouts")).toBe(
      "Standouts (> 2σ vs industry)1Top: HPK +42.4%"
    );
    const text = container.textContent;
    expect(text).toContain(
      "Median returns for 3,022 US-listed stocks by sector, industry and cap bucket. Color scale ±10%."
    );
    expect(text).toContain("Leading industries (1M)");
    expect(text).toContain("HPK +42.4% z=3.1 · Oil & Gas Production");
    expect(text).toContain(
      "Leaders in leading industries (1M and 3M top quintile): XOM"
    );
    expect(text).toContain("2 tracked names by cell");
    expect(text).toContain("Sources: Nasdaq stock screener; Yahoo Finance");
    expect(industryRows(container)).toEqual([
      "XOM",
      "OLD",
      "Oil & Gas Production ▲",
      "Oil Refining",
      "Water Supply ▼",
    ]);
    // Every symbol links to its stock page.
    const tickerLinks = [
      ...container.querySelectorAll('[data-slot="ticker-link"]'),
    ].map((link) => link.getAttribute("href"));
    expect(tickerLinks).toEqual([
      "/stock/HPK",
      "/stock/XOM",
      "/stock/XOM",
      "/stock/OLD",
    ]);
    const scroll = container.querySelector(
      '[aria-labelledby="rotation-matrix-heading"] [data-slot="table-scroll"]'
    );
    expect(scroll?.getAttribute("aria-label")).toBe("Rotation matrix for 1M");
    // The empty sector has no industries and is not listed.
    expect(text).not.toContain("Empty Sector");
    return expect(
      container.querySelector('a[href="https://finviz.com/map.ashx?t=sec_all"]')
    ).not.toBeNull();
  });

  it("names the state of a tracked name without an industry, without a cell state and in an unranked industry", async () => {
    const base = rotationFixture();
    const container = await render(
      gatewayWith(
        vi.fn(async () => ({
          ...base,
          ours: [
            ...base.ours,
            {
              cell1M: "unranked",
              cell3M: "lagging",
              covered: true,
              industry: "Water Supply",
              roles: ["wish"],
              symbol: "AWK",
            },
            {
              cell3M: "unranked",
              covered: true,
              roles: ["held"],
              symbol: "NEW",
            },
          ],
        }))
      )
    );
    const cells = [
      ...container.querySelectorAll(
        '[aria-label="Our names by rotation cell"] tbody tr'
      ),
    ].map((row) =>
      [...row.querySelectorAll("td")]
        .slice(1)
        .map((cell) => [cell.textContent, cell.getAttribute("title")])
    );
    const generated = "generated 2026-10-21 17:10 UTC";
    expect(cells).toEqual([
      [
        ["Oil & Gas Production", null],
        ["leading", null],
        ["leading", null],
      ],
      [
        [
          "no industry",
          `The matrix document ${generated} has no industry for OLD`,
        ],
        [
          "no cell state",
          `The matrix document ${generated} has no 1M cell state for OLD`,
        ],
        [
          "no cell state",
          `The matrix document ${generated} has no 3M cell state for OLD`,
        ],
      ],
      [
        ["Water Supply", null],
        ["not ranked", "Water Supply has fewer than 3 names with a 1M return"],
        ["lagging", null],
      ],
      [
        [
          "no industry",
          `The matrix document ${generated} has no industry for NEW`,
        ],
        [
          "no cell state",
          `The matrix document ${generated} has no 1M cell state for NEW`,
        ],
        ["not ranked", "Its industry has fewer than 3 names with a 3M return"],
      ],
    ]);
  });

  it("keeps the badge and the titles readable when the generation time is not a time", async () => {
    const container = await render(
      gatewayWith(
        vi.fn(async () =>
          rotationFixture("1M", { asOf: null, generatedAt: "last night" })
        )
      )
    );
    expect(status(container)).toBe(
      "As-of date not reported by generator · generated at a time that cannot be read"
    );
    const titles = [
      ...container.querySelectorAll(
        '[aria-label="Our names by rotation cell"] tbody td[title]'
      ),
    ].map((cell) => cell.getAttribute("title"));
    expect(titles).toEqual([
      "The matrix document generated at a time that cannot be read has no industry for OLD",
      "The matrix document generated at a time that cannot be read has no 1M cell state for OLD",
      "The matrix document generated at a time that cannot be read has no 3M cell state for OLD",
    ]);
    // The footer still shows the text as the document holds it.
    expect(container.textContent).toContain("Generated last night.");
  });

  it("opens a cell, a cell without a symbol list and the all-caps column", async () => {
    const container = await render(
      gatewayWith(vi.fn(async () => rotationFixture()))
    );
    await click(
      button(
        container,
        "Oil & Gas Production large: +5.0%, 3 names with a return"
      )
    );
    let detail = container.querySelector('[aria-label="Selected cell"]');
    expect(detail?.textContent).toContain("Oil & Gas Production · large · 1M");
    expect(detail?.textContent).toContain("Industry rank 1 (quintile 1).");
    expect(detail?.querySelector("a")?.getAttribute("href")).toBe("/stock/XOM");
    expect(detail?.textContent).toContain("$12.0B");
    await click(
      button(
        container,
        "Oil & Gas Production small: +9.0%, 1 name with a return"
      )
    );
    detail = container.querySelector('[aria-label="Selected cell"]');
    // No symbol list in the cell: every cap bucket of the industry is listed.
    expect(detail?.textContent).toContain("XOM");
    // All caps of an industry without a mid cell.
    await click(
      button(
        container,
        "Oil & Gas Production all caps: +6.0%, 3 names with a return"
      )
    );
    detail = container.querySelector('[aria-label="Selected cell"]');
    expect(detail?.textContent).toContain(
      "Energy. Median +6.0%, cap-weighted +6.0%, 66.7% of 3 names up. Industry rank 1 (quintile 1)."
    );
    await click(
      button(container, "Oil Refining all caps: +1.0%, 3 names with a return")
    );
    detail = container.querySelector('[aria-label="Selected cell"]');
    expect(detail?.textContent).toContain("Oil Refining · All caps · 1M");
    expect(detail?.textContent).toContain("PSX no return");
    expect(detail?.textContent).not.toContain("Industry rank");
    expect(detail?.textContent).toContain("DK no return");
    // A cell with one name and no return: n 0. The button and the sentence do not say "no names".
    const emptyCell = button(
      container,
      "Oil Refining mid: no name has a return, 0 names with a return"
    );
    expect(emptyCell?.textContent).toBe("no name has a return0");
    // The short count carries its meaning as a title.
    expect(emptyCell?.querySelector("span")?.getAttribute("title")).toBe(
      "0 names with a return"
    );
    expect(
      button(
        container,
        "Oil & Gas Production small: +9.0%, 1 name with a return"
      )
        ?.querySelector("span")
        ?.getAttribute("title")
    ).toBe("1 name with a return");
    expect(container.querySelector("tbody th[colspan]")?.textContent).toBe(
      "Energy +4.6% 3 names with a return"
    );
    await click(emptyCell);
    detail = container.querySelector('[aria-label="Selected cell"]');
    expect(detail?.textContent).toBe(
      "Oil Refining · mid · 1MCloseEnergy: the 1 listed name has no 1M return.PSX no return $12.0B"
    );
    await click(button(container, "Close"));
    return expect(
      container.querySelector('[aria-label="Selected cell"]')
    ).toBeNull();
  });

  it("filters by industry text and by exact symbol, and clears a filter with no match", async () => {
    const container = await render(
      gatewayWith(vi.fn(async () => rotationFixture()))
    );
    await typeFilter(container, "water");
    expect(industryRows(container)).toEqual(["XOM", "OLD", "Water Supply ▼"]);
    await typeFilter(container, "psx");
    expect(industryRows(container)).toEqual(["XOM", "OLD", "Oil Refining"]);
    await typeFilter(container, " nothing-matches ");
    expect(industryRows(container)).toEqual(["XOM", "OLD"]);
    expect(container.textContent).toContain(
      "No industry, sector or symbol matches “nothing-matches”."
    );
    await click(button(container, "Clear filter"));
    expect(
      (container.querySelector('input[type="search"]') as HTMLInputElement)
        .value
    ).toBe("");
    return expect(industryRows(container)).toHaveLength(5);
  });

  it("switches period, writes it to the URL, closes the selection and handles empty optional data", async () => {
    window.history.replaceState(null, "", "/rotation-matrix#matrix");
    const rotationMatrix = vi.fn(async (period: "1D" | "1M" | "3M" | "6M") =>
      period === "1M"
        ? rotationFixture()
        : rotationFixture(period, {
            asOf: null,
            bottom: [],
            ours: [],
            source: null,
            standouts: [],
            top: [],
          })
    );
    const container = await render(gatewayWith(rotationMatrix));
    await click(
      button(
        container,
        "Oil & Gas Production large: +5.0%, 3 names with a return"
      )
    );
    await click(button(container, "6M"));
    expect(rotationMatrix).toHaveBeenLastCalledWith("6M");
    expect(window.location.pathname).toBe("/rotation-matrix");
    expect(window.location.search).toBe("?period=6M");
    expect(window.location.hash).toBe("#matrix");
    expect(button(container, "6M")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[aria-label="Selected cell"]')).toBeNull();
    expect(status(container)).toBe(
      "As-of date not reported by generator · generated 2026-10-21 17:10 UTC"
    );
    expect(kpi(container, "leading")).toBe(
      "Leading industry (6M)none rankedNo ranked industry"
    );
    expect(kpi(container, "lagging")).toBe(
      "Lagging industry (6M)none rankedNo ranked industry"
    );
    expect(kpi(container, "standouts")).toBe(
      "Standouts (> 2σ vs industry)0None above 2σ"
    );
    const text = container.textContent;
    expect(text).toContain("Color scale ±30%.");
    expect(text).toContain("No wish-list or re-entry name is a leader");
    expect(text).toContain(
      "Sources: not recorded by the generator. Generated 2026-10-21T17:10:32.981Z. Read-only research view; no orders."
    );
    expect(
      container.querySelector('a[href="https://finviz.com/map.ashx?t=sec_all"]')
    ).not.toBeNull();
    await click(button(container, "1M"));
    return expect(window.location.search).toBe("");
  });

  it("starts from the URL period and refreshes on demand", async () => {
    const leader = (symbol: string) => ({
      cap: "large" as const,
      cell1M: "leading",
      cell3M: "leading",
      covered: true,
      industry: "Oil & Gas Production",
      opportunity: true,
      roles: ["wish"],
      sector: "Energy",
      symbol,
    });
    const rotationMatrix = vi.fn(async (period: "1D" | "1M" | "3M" | "6M") =>
      rotationFixture(period, { ours: [leader("XOM"), leader("CVX")] })
    );
    const container = await render(gatewayWith(rotationMatrix), {
      period: "3M",
    });
    expect(rotationMatrix).toHaveBeenCalledWith("3M");
    expect(container.textContent).toContain(
      "Leaders in leading industries (1M and 3M top quintile): XOM, CVX"
    );
    expect(window.location.search).toBe("?period=3M");
    expect(button(container, "3M")?.getAttribute("aria-pressed")).toBe("true");
    await click(button(container, "Refresh"));
    expect(rotationMatrix).toHaveBeenCalledTimes(2);
    return expect(rotationMatrix).toHaveBeenLastCalledWith("3M");
  });

  it("keeps parameters it does not own in the URL", async () => {
    window.history.replaceState(
      null,
      "",
      "/rotation-matrix?theme=light&period=3M"
    );
    const rotationMatrix = vi.fn(async (period: "1D" | "1M" | "3M" | "6M") =>
      rotationFixture(period)
    );
    const container = await render(gatewayWith(rotationMatrix), {
      period: "3M",
    });
    expect(window.location.search).toBe("?theme=light&period=3M");
    await click(button(container, "6M"));
    expect(rotationMatrix).toHaveBeenLastCalledWith("6M");
    expect(window.location.search).toBe("?theme=light&period=6M");
    await click(button(container, "1M"));
    return expect(window.location.search).toBe("?theme=light");
  });

  it("keeps the newest period when an older response arrives late", async () => {
    let releaseSlow: (matrix: RotationMatrixOutput) => void = () => undefined;
    const slow = new Promise<RotationMatrixOutput>((resolve) => {
      releaseSlow = resolve;
    });
    const rotationMatrix = vi.fn(async (period: "1D" | "1M" | "3M" | "6M") =>
      period === "1M" ? slow : rotationFixture(period, { asOf: "2026-04-01" })
    );
    const container = await render(gatewayWith(rotationMatrix));
    expect(status(container)).toBe("Loading");
    expect(button(container, "Refresh")?.hasAttribute("disabled")).toBe(true);
    await click(button(container, "1D"));
    await act(async () => {
      releaseSlow(rotationFixture());
      return await flush();
    });
    return expect(status(container)).toBe("As of 2026-04-01");
  });

  it("tells a cell without names from a cell whose names have no return", async () => {
    const base = rotationFixture();
    const refining = base.industries[2];
    const mid = refining?.cells.mid;
    if (refining === undefined || mid === undefined)
      throw new Error("fixture has no Oil Refining mid cell");
    const { symbols: _symbols, ...unlisted } = mid;
    const container = await render(
      gatewayWith(
        vi.fn(async () =>
          rotationFixture("1M", {
            industries: [
              {
                ...refining,
                cells: {
                  // Two names with a return, too few for a share of names up.
                  large: { ...mid, n: 2, retCapWeighted: 3, retMedian: 2 },
                  // An empty list: the job lists only names with a return.
                  mid: { ...mid, symbols: [] },
                  // Older job output: no symbol list, so the name count is not known.
                  small: unlisted,
                },
              },
            ],
          })
        )
      )
    );
    const sentence = () =>
      container.querySelector('[aria-label="Selected cell"] p')?.textContent;
    await click(
      button(
        container,
        "Oil Refining mid: no name has a return, 0 names with a return"
      )
    );
    expect(sentence()).toBe("Energy: no name is listed with a 1M return.");
    await click(
      button(
        container,
        "Oil Refining small: no name has a return, 0 names with a return"
      )
    );
    expect(sentence()).toBe("Energy: no name has a 1M return.");
    await click(
      button(container, "Oil Refining large: +2.0%, 2 names with a return")
    );
    return expect(sentence()).toBe(
      "Energy. Median +2.0%, cap-weighted +3.0%, share of names up not computed: 2 names have a 1M return."
    );
  });

  it("words the all-caps column of an industry where no name has a return", async () => {
    const refining = rotationFixture().industries[2];
    const mid = refining?.cells.mid;
    const small = refining?.cells.small;
    if (refining === undefined || mid === undefined || small === undefined)
      throw new Error("fixture has no Oil Refining mid and small cells");
    const { symbols: _symbols, ...unlisted } = small;
    const empty = { ...refining, breadth: null, n: 0, retMedian: null };
    const label =
      "Oil Refining all caps: no name has a return, 0 names with a return";
    const sentence = (container: HTMLElement) =>
      container.querySelector('[aria-label="Selected cell"] p')?.textContent;
    // Every cell carries its list: the names of all cap buckets are counted.
    const listed = await render(
      gatewayWith(
        vi.fn(async () =>
          rotationFixture("1M", {
            industries: [{ ...empty, cells: { mid, small } }],
          })
        )
      )
    );
    await click(button(listed, label));
    expect(sentence(listed)).toBe("Energy: none of 2 names has a 1M return.");
    // One cell has no list (older job output): the count is not known.
    const partly = await render(
      gatewayWith(
        vi.fn(async () =>
          rotationFixture("1M", {
            industries: [{ ...empty, cells: { mid, small: unlisted } }],
          })
        )
      )
    );
    await click(button(partly, label));
    expect(sentence(partly)).toBe("Energy: no name has a 1M return.");
    // No cell at all: the list is empty, which does not prove an empty industry.
    const bare = await render(
      gatewayWith(
        vi.fn(async () =>
          rotationFixture("1M", { industries: [{ ...empty, cells: {} }] })
        )
      )
    );
    await click(button(bare, label));
    return expect(sentence(bare)).toBe(
      "Energy: no name is listed with a 1M return."
    );
  });

  it("creates the browser gateway when none is supplied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    try {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () => {
        root.render(<RotationMatrixWorkspace />);
        for (let index = 0; index < 200; index += 1) await Promise.resolve();
      });
      return expect(container.textContent).toMatch(
        /Loading rotation matrix|Rotation matrix load failed/u
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  return it("shows loading, the server message on failure and retries", async () => {
    let fail = true;
    const rotationMatrix = vi.fn(async () => {
      if (fail)
        throw Object.assign(new Error("rotation document returned HTTP 404"), {
          code: "NOT_FOUND",
        });
      return rotationFixture();
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T14:05:30.000Z"));
    const container = await render(gatewayWith(rotationMatrix));
    expect(container.querySelector('[role="alert"] p')?.textContent).toBe(
      "Rotation matrix load failed: rotation document returned HTTP 404 · 14:05 UTC · try again after the nightly run"
    );
    expect(status(container)).toBe("Load failed 14:05 UTC");
    // The badge keeps the time of the failure and adds the date on a later UTC day.
    vi.setSystemTime(new Date("2026-11-20T00:01:00.000Z"));
    await typeFilter(container, "x");
    expect(status(container)).toBe("Load failed 2026-11-19 14:05 UTC");
    expect(container.querySelector('[data-slot="kpi-row"]')).toBeNull();
    fail = false;
    await click(button(container, "Try again"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const pending = vi.fn(() => new Promise<never>(() => undefined));
    // One trailing full stop of the message is dropped before the separator.
    vi.setSystemTime(new Date("2026-11-19T15:00:00.000Z"));
    const denied = await render(
      gatewayWith(
        vi.fn(async () => {
          throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" });
        })
      )
    );
    expect(denied.querySelector('[role="alert"] p')?.textContent).toBe(
      "Rotation matrix load failed: Operator access required · 15:00 UTC · sign in with an operator account"
    );
    // A retry can help after a server error.
    const serverError = await render(
      gatewayWith(
        vi.fn(async () => {
          throw Object.assign(new Error("Matrix read failed"), {
            code: "INTERNAL_SERVER_ERROR",
          });
        })
      )
    );
    expect(serverError.querySelector('[role="alert"] p')?.textContent).toBe(
      "Rotation matrix load failed: Matrix read failed · 15:00 UTC · press Try again"
    );
    const notConfigured = await render(
      gatewayWith(
        vi.fn(async () => {
          throw Object.assign(
            new Error(
              "Research lens endpoint not configured (VERTEX_RESEARCH_LENSES_URL)"
            ),
            { code: "NOT_CONFIGURED" }
          );
        })
      )
    );
    expect(notConfigured.querySelector('[role="alert"] p')?.textContent).toBe(
      "Rotation matrix load failed: Research lens endpoint not configured (VERTEX_RESEARCH_LENSES_URL) · 15:00 UTC · ask the operator to configure the research lens endpoint"
    );
    // A rejected request names the one input of the matrix.
    const rejected = await render(
      gatewayWith(
        vi.fn(async () => {
          throw Object.assign(new Error("Unknown period."), {
            code: "BAD_REQUEST",
          });
        })
      )
    );
    expect(rejected.querySelector('[role="alert"] p')?.textContent).toBe(
      "Rotation matrix load failed: Unknown period · 15:00 UTC · choose another period"
    );
    // The server message already holds the time of the timeout and its retry step.
    const timedOut = await render(
      gatewayWith(
        vi.fn(async () => {
          throw Object.assign(
            new Error(
              "Rotation matrix request timed out at 14:05 UTC. Nothing was changed. Try again."
            ),
            { code: "UNAVAILABLE" }
          );
        })
      )
    );
    expect(timedOut.querySelector('[role="alert"] p')?.textContent).toBe(
      "Rotation matrix load failed: Rotation matrix request timed out at 14:05 UTC. Nothing was changed. Try again."
    );
    expect(button(timedOut, "Try again")).not.toBeNull();
    const loading = await render(gatewayWith(pending));
    return expect(
      loading.querySelector('[role="status"]')?.textContent
    ).toContain("Loading rotation matrix…");
  });
});
