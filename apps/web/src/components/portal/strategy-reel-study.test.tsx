// @vitest-environment jsdom
import type {
  ApiClient,
  ResearchStudy,
  StrategyBacktestStudy,
  StrategyGetOutput,
} from "@darkfactory/api";
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
  QcPortStudySchema,
  StrategyBacktestStudySchema,
} from "@darkfactory/api";

import qcFixture from "../../features/research-studies/fixtures/qc-port-study.json";
import fixture from "../../features/research-studies/fixtures/strategy-backtest-study.json";
import type { StrategyLibraryGateway } from "./agent-ops-client.tsx";
import {
  RESEARCH_STUDIES_IMPORT_COMMAND,
  type ResearchStudyGateway,
} from "./filter-studies-section.tsx";
import { NOT_APPROVAL } from "./strategy-backtest-study.tsx";
import { StrategyDetail } from "./strategy-library-detail.tsx";
import { StrategyReelStudy } from "./strategy-reel-study.tsx";

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
});

const SLUG = "ld34-nested-donchian-breakout";
const UPDATED_AT = new Date("2026-11-08T12:00:00.000Z");
const DOCUMENT = StrategyBacktestStudySchema.parse(fixture);
const stored = (study: StrategyBacktestStudy): ResearchStudy => ({
  id: study.id,
  study,
  updatedAt: UPDATED_AT,
});
const STUDY = stored(DOCUMENT);

const mount = async (element: React.ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

const stateOf = (container: HTMLElement): string | null | undefined =>
  container
    .querySelector("[data-strategy-study-section]")
    ?.getAttribute("data-backtest-study-state");

const rowsOf = (container: HTMLElement, table: string): string[][] =>
  [
    ...container.querySelectorAll(
      `[data-strategy-study-table='${table}'] tbody tr`
    ),
  ].map((row) =>
    [...row.querySelectorAll("td")].map((td) => td.textContent ?? "")
  );

const headersOf = (container: HTMLElement, table: string): string[] =>
  [
    ...container.querySelectorAll(
      `[data-strategy-study-table='${table}'] thead th`
    ),
  ].map((th) => th.textContent ?? "");

const failing = (error: unknown): ResearchStudyGateway => ({
  get: () => Promise.reject(error),
});

// No control that could arm, deploy, paper trade or place an order: the section has no button,
// form or input at all, and its only link is the study source.
const expectReadOnly = (section: Element) => {
  expect(section.querySelectorAll("button, form, input, select")).toHaveLength(
    0
  );
  expect(
    [...section.querySelectorAll("a")].map((a) => a.getAttribute("href"))
  ).toEqual([DOCUMENT.source.url]);
  expect(section.textContent).not.toMatch(
    /\b(arm|disarm|deploy|deployment|place order|submit order|paper trade)\b/iu
  );
};

describe("StrategyReelStudy", () => {
  it("loads the study under the slug and renders every section", async () => {
    const get = vi.fn(async () => STUDY);
    const container = await mount(
      <StrategyReelStudy gateway={{ get }} slug={SLUG} />
    );
    expect(get).toHaveBeenCalledWith(SLUG);
    expect(stateOf(container)).toBe("ready");
    expect(container.querySelector("h3")?.textContent).toBe("Backtest study");
    expect(
      container.querySelector("[data-strategy-study-not-approval]")?.textContent
    ).toBe(NOT_APPROVAL);

    const verdict = container.querySelector("[data-strategy-study-verdict]");
    expect(verdict?.textContent).toContain("Needs more data");
    expect(verdict?.getAttribute("data-status")).toBe("neutral");
    expect(
      container.querySelector("[data-strategy-study-reason]")?.textContent
    ).toBe(DOCUMENT.verdictReason);
    expect(container.textContent).toContain(
      "Ran 2026-11-08 · docs/specs/strategies/ld34-nested-donchian-breakout.md"
    );

    const source = container.querySelector("[data-strategy-study-source]");
    expect(source?.getAttribute("href")).toBe(
      "https://www.instagram.com/reel/DffCOSDBMoC/"
    );
    expect(source?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(source?.getAttribute("target")).toBe("_blank");
    expect(source?.textContent).toBe(DOCUMENT.source.label);

    expect(rowsOf(container, "rules")).toEqual([
      [
        "Entry",
        "Buy when an hourly bar closes above the 20-day Donchian high.",
        "transcript [18.50-22.70]",
      ],
      ["Stop", "2x ATR(14) below the entry.", "frames/k03_steps12_t33.jpg"],
    ]);
    expect(rowsOf(container, "gaps")[0]).toEqual([
      "The Donchian lookbacks are not spoken.",
      "20/50/100/200 days, the ladder drawn on the chart.",
    ]);

    expect(headersOf(container, "runs-underlying")).toEqual([
      "Symbol",
      "Market",
      "Period",
      "Trades",
      "CAGR",
      "Sharpe",
      "Max DD",
      "PF",
      "Win rate",
      "Exposure",
      "OOS Sharpe",
      "OOS CAGR",
      "B&H CAGR",
      "B&H Sharpe",
    ]);
    expect(rowsOf(container, "runs-underlying")).toEqual([
      [
        "SPY",
        "US equity index ETF",
        "2004-01-02 to 2026-11-06",
        "1,212",
        "7.10%",
        "0.66",
        "-14.30%",
        "1.42",
        "41.00%",
        "38.00%",
        "0.48",
        "5.20%",
        "10.40%",
        "0.62",
      ],
      [
        "BTCUSD",
        "Crypto (no signal in the window)",
        "2018-01-02 to 2026-11-06",
        "0",
        "0.00%",
        "0.00",
        "0.00%",
        "—",
        "0.00%",
        "0.00%",
        "—",
        "—",
        "—",
        "—",
      ],
    ]);
    expect(rowsOf(container, "runs-options")).toHaveLength(1);
    expect(
      [...container.querySelectorAll("[data-strategy-study-form] h4")].map(
        (heading) => heading.textContent
      )
    ).toEqual([
      "As stated (underlying)",
      "Vertex form (options, defined risk)",
    ]);

    expect(
      [...container.querySelectorAll("[data-strategy-study-robustness]")].map(
        (badge) => [
          badge.getAttribute("data-strategy-study-robustness"),
          badge.getAttribute("data-status"),
          badge.textContent,
        ]
      )
    ).toEqual([
      ["pass", "success", "Status:Pass"],
      ["fail", "destructive", "Status:Fail"],
      ["info", "info", "Status:Info"],
    ]);
    expect(rowsOf(container, "sensitivity")[1]).toEqual([
      "ATR stop multiple",
      "2.5",
      "0.63",
      "6.90%",
      "-13.90%",
      "1,105",
    ]);
    expect(rowsOf(container, "comparison").map((row) => row[1])).toEqual([
      "Buy and hold",
      "Library strategy",
      "This strategy",
    ]);

    expect(
      container.querySelector("[data-strategy-study-equity]")?.textContent
    ).toBe(DOCUMENT.equityLabel);
    const equity = container.querySelector(
      "[data-chart='strategy-study-equity'] svg"
    );
    expect(equity?.getAttribute("aria-label")).toBe(
      "Monthly equity: 3.10% at the end of 6 months"
    );
    expect(
      container.querySelector("[data-line='strategy-study-equity']")
    ).not.toBeNull();
    const drawdown = container.querySelector(
      "[data-chart='strategy-study-drawdown'] svg"
    );
    expect(drawdown?.getAttribute("aria-label")).toBe(
      "Drawdown: 0.00% at the end of 6 months"
    );
    expect(
      container.querySelector("[data-chart='strategy-study-drawdown']")
        ?.textContent
    ).toContain("Deepest drawdown -2.10% in 2026-07.");
    expect(
      container.querySelector("[data-strategy-study-provenance]")?.textContent
    ).toBe(
      "Code bde73275e2a1 · nautilus_trader 1.221.0 · data sha256:3f1c9a0e77d2 · run ld34-2026-11-08T21:00Z"
    );
    expect(container.textContent).toContain(
      "Test fixture: the numbers are illustrative"
    );
  });

  it("has no arm, deploy, paper or order control, and its tables scroll inside their container", async () => {
    const container = await mount(
      <StrategyReelStudy gateway={{ get: async () => STUDY }} slug={SLUG} />
    );
    const section = container.querySelector(
      "[data-strategy-study-section]"
    ) as Element;
    expectReadOnly(section);
    const tables = [...section.querySelectorAll("table")];
    expect(tables).toHaveLength(7);
    for (const table of tables) {
      const region = table.closest("[role='region']");
      expect(region?.className).toContain("overflow-x-auto");
      expect(region?.getAttribute("tabindex")).toBe("0");
      expect(region?.getAttribute("aria-label")).toBe(
        table.querySelector("caption")?.textContent
      );
    }
  });

  it("omits empty lists and notes, and says when no gap was recorded", async () => {
    const lean = stored({
      ...DOCUMENT,
      comparison: [],
      gaps: [],
      notes: "",
      robustness: [],
      sensitivity: [],
    });
    const container = await mount(
      <StrategyReelStudy gateway={{ get: async () => lean }} slug={SLUG} />
    );
    expect(stateOf(container)).toBe("ready");
    expect(
      container.querySelector("[data-strategy-study-gaps]")?.textContent
    ).toBe("No gaps recorded: every rule was stated.");
    for (const table of ["gaps", "robustness", "sensitivity", "comparison"])
      expect(
        container.querySelector(`[data-strategy-study-table='${table}']`)
      ).toBeNull();
    expect(container.textContent).not.toContain("Test fixture");
  });

  it("refuses a study of another kind stored under the slug", async () => {
    const qc = QcPortStudySchema.parse(qcFixture);
    const container = await mount(
      <StrategyReelStudy
        gateway={{
          get: async () => ({ id: qc.id, study: qc, updatedAt: UPDATED_AT }),
        }}
        slug={SLUG}
      />
    );
    expect(stateOf(container)).toBe("error");
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      `Backtest study unavailable. Study ${SLUG} is not a strategy-backtest study.`
    );
    expect(container.textContent).toContain(NOT_APPROVAL);
  });

  it("shows loading, operator-only, signed-out and missing states", async () => {
    const loading = await mount(
      <StrategyReelStudy
        gateway={{ get: () => new Promise<ResearchStudy>(() => undefined) }}
        slug={SLUG}
      />
    );
    expect(stateOf(loading)).toBe("loading");
    expect(loading.textContent).toContain(NOT_APPROVAL);
    expect(loading.querySelector("[aria-busy='true']")?.textContent).toBe(
      "Loading backtest study"
    );

    const denied = await mount(
      <StrategyReelStudy
        gateway={failing({ code: "FORBIDDEN", message: "Forbidden" })}
        slug={SLUG}
      />
    );
    expect(stateOf(denied)).toBe("forbidden");
    expect(denied.textContent).toContain(
      "Backtest studies are limited to operators."
    );

    const signedOut = await mount(
      <StrategyReelStudy
        gateway={failing({ code: "UNAUTHORIZED", message: "Sign in" })}
        slug={SLUG}
      />
    );
    expect(stateOf(signedOut)).toBe("unauthorized");
    expect(signedOut.querySelector("a")?.getAttribute("href")).toBe("/sign-in");

    const missing = await mount(
      <StrategyReelStudy
        gateway={failing({
          code: "NOT_FOUND",
          message: "Research study not found",
        })}
        slug={SLUG}
      />
    );
    expect(stateOf(missing)).toBe("not-found");
    expect(missing.textContent).toContain(NOT_APPROVAL);
    expect(missing.textContent).toContain("No backtest study stored yet");
    expect(missing.querySelector("code")?.textContent).toBe(
      RESEARCH_STUDIES_IMPORT_COMMAND
    );
  });

  it("shows a storage error with a retry that loads the study", async () => {
    let calls = 0;
    const container = await mount(
      <StrategyReelStudy
        gateway={{
          get: async () => {
            calls += 1;
            if (calls === 1)
              throw {
                code: "STORAGE_ERROR",
                message: "Research study storage unavailable",
              };
            return STUDY;
          },
        }}
        slug={SLUG}
      />
    );
    expect(stateOf(container)).toBe("error");
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "Backtest study unavailable. STORAGE_ERROR: Research study storage unavailable"
    );
    await act(async () => container.querySelector("button")?.click());
    expect(stateOf(container)).toBe("ready");
    expect(calls).toBe(2);
  });

  it("uses the browser API client when no gateway is given", async () => {
    const get = vi.fn(async () => STUDY);
    runtime.client = { researchStudies: { get } } as unknown as ApiClient;
    const container = await mount(<StrategyReelStudy slug={SLUG} />);
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(get).toHaveBeenCalledWith({ id: SLUG });
    expect(stateOf(container)).toBe("ready");
  });
});

describe("strategy library detail: strategy-backtest study section", () => {
  const strategy = (tags: string[]): StrategyGetOutput["strategy"] => ({
    backtestCount: 0,
    createdAt: UPDATED_AT,
    description: "Research only.",
    favorite: false,
    id: `strategy-seed-${SLUG}`,
    kind: "python",
    latestBacktest: null,
    name: "LD34 nested Donchian long-only breakout (reel)",
    params: [],
    presetCount: 0,
    section: "Reel ideas",
    slug: SLUG,
    sourceRef: `docs/specs/strategies/${SLUG}.md`,
    status: "backtested",
    tags,
    updatedAt: UPDATED_AT,
  });
  const detailFor = (tags: string[], get = vi.fn(async () => STUDY)) => (
    <StrategyDetail
      describeFailure={() => "failed"}
      detail={{ backtests: [], presets: [], strategy: strategy(tags) }}
      gateway={{} as StrategyLibraryGateway}
      onChanged={async () => undefined}
      onClose={() => undefined}
      onTab={() => undefined}
      researchStudies={{ get }}
      tab="backtests"
    />
  );

  it("loads the study by slug on the Backtests tab of an entry tagged backtest-study, with no deployment action", async () => {
    const get = vi.fn(async () => STUDY);
    const container = await mount(
      detailFor(["research-only", "backtest-study", "reel-idea"], get)
    );
    expect(get).toHaveBeenCalledWith(SLUG);
    expect(stateOf(container)).toBe("ready");
    expect(
      container.querySelector("[data-strategy-research-only]")?.textContent
    ).toBe("Research only: no deployment");
    expect(
      container.querySelector(
        "[data-strategy-request-deployment], [data-strategy-academy-lesson]"
      )
    ).toBeNull();
    expect(container.querySelector("[data-qc-port-not-approval]")).toBeNull();
    expectReadOnly(
      container.querySelector("[data-strategy-study-section]") as Element
    );
  });

  it("has no strategy-backtest study section on other entries", async () => {
    const get = vi.fn(async () => STUDY);
    const container = await mount(detailFor(["research-only"], get));
    expect(container.querySelector("[data-strategy-study-section]")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
