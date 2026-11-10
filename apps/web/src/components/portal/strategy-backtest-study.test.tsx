// @vitest-environment jsdom
import type {
  ApiClient,
  ResearchStudy,
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

import { FilterStudySchema, QcPortStudySchema } from "@darkfactory/api";

import seededFilter from "../../features/research-studies/fixtures/adx-filter-study.json";
import fixture from "../../features/research-studies/fixtures/qc-port-study.json";
import type { StrategyLibraryGateway } from "./agent-ops-client.tsx";
import {
  RESEARCH_STUDIES_IMPORT_COMMAND,
  type ResearchStudyGateway,
} from "./filter-studies-section.tsx";
import {
  NOT_APPROVAL,
  QcPortDefinitionLink,
  StrategyBacktestStudy,
} from "./strategy-backtest-study.tsx";
import { StrategyDetail } from "./strategy-library-detail.tsx";

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

const UPDATED_AT = new Date("2026-11-08T12:00:00.000Z");
const QC = QcPortStudySchema.parse(fixture);
const STUDY: ResearchStudy = { id: QC.id, study: QC, updatedAt: UPDATED_AT };

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
    .querySelector("[data-backtest-study-state]")
    ?.getAttribute("data-backtest-study-state");

const failing = (error: unknown): ResearchStudyGateway => ({
  get: () => Promise.reject(error),
});

describe("StrategyBacktestStudy", () => {
  it("loads the study stored under the slug and shows verdict, runs, gates, equity and the modeled note", async () => {
    const get = vi.fn(async () => STUDY);
    const container = await mount(
      <StrategyBacktestStudy gateway={{ get }} slug="qc-iv-rank-gate" />
    );
    expect(get).toHaveBeenCalledWith("qc-iv-rank-gate");
    expect(stateOf(container)).toBe("ready");
    expect(container.querySelector("h3")?.textContent).toBe("Backtest study");
    expect(
      container.querySelector("[data-qc-port-verdict]")?.textContent
    ).toContain("Backtest FAIL");
    expect(
      container
        .querySelector("[data-qc-port-verdict]")
        ?.getAttribute("data-status")
    ).toBe("neutral");
    expect(
      container.querySelector("[data-qc-port-not-approval]")?.textContent
    ).toBe("A backtest result is not approval to trade (research only).");
    expect(
      container.querySelector("[data-qc-port-criteria]")?.textContent
    ).toContain("deflated Sharpe above 0.90");
    expect(
      container.querySelector("[data-qc-port-provenance]")?.textContent
    ).toContain("nautilus_trader 1.221.0");
    expect(
      container.querySelector("[data-qc-port-modeled]")?.textContent
    ).toContain("MODELED option prices");
    expect(
      container.querySelectorAll("[data-qc-port-runs] tbody tr")
    ).toHaveLength(3);
    expect(
      container.querySelector("[data-qc-port-gates] tbody tr")?.textContent
    ).toContain("0.48 → 0.52");
    const chart = container.querySelector('[data-chart="qc-port-equity"]');
    expect(chart?.querySelector("path")?.getAttribute("d")).toMatch(/^M0 /u);
    expect(chart?.querySelector("svg")?.getAttribute("aria-label")).toMatch(
      /^Monthly equity: .+ over 24 months$/u
    );
    expect(container.textContent).toContain("Test fixture (synthetic numbers)");
    // Research only: no arm, deploy or order controls.
    expect(container.querySelectorAll("button, a, form, input")).toHaveLength(
      0
    );
  });

  it("shows a PASS study without gates, equity or notes", async () => {
    const { gates: _gates, ...rest } = QC;
    const container = await mount(
      <StrategyBacktestStudy
        gateway={{
          get: async () => ({
            ...STUDY,
            study: {
              ...rest,
              equity: [],
              notes: "",
              verdict: "PASS" as const,
            },
          }),
        }}
        slug="qc-iv-rank-gate"
      />
    );
    expect(
      container
        .querySelector("[data-qc-port-verdict]")
        ?.getAttribute("data-status")
    ).toBe("neutral");
    // A PASS never reads as approval: same neutral badge, same notice.
    expect(
      container.querySelector("[data-qc-port-verdict]")?.textContent
    ).toContain("Backtest PASS");
    expect(container.textContent).toContain(NOT_APPROVAL);
    expect(container.querySelector("[data-qc-port-gates]")).toBeNull();
    expect(container.querySelector('[data-chart="empty"]')?.textContent).toBe(
      "No monthly equity stored."
    );
    expect(container.querySelector(".whitespace-pre-line")).toBeNull();
  });

  it("refuses a study of another kind stored under the slug", async () => {
    const container = await mount(
      <StrategyBacktestStudy
        gateway={{
          get: async () => ({
            id: "adx-rvol-filters",
            study: FilterStudySchema.parse(seededFilter),
            updatedAt: UPDATED_AT,
          }),
        }}
        slug="adx-rvol-filters"
      />
    );
    expect(stateOf(container)).toBe("error");
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "Backtest study unavailable. Study adx-rvol-filters is not a qc-port backtest study."
    );
  });

  it("shows loading, operator-only, signed-out and missing states", async () => {
    const loading = await mount(
      <StrategyBacktestStudy
        gateway={{ get: () => new Promise<ResearchStudy>(() => undefined) }}
        slug="qc-opex-week"
      />
    );
    expect(stateOf(loading)).toBe("loading");
    expect(
      loading.querySelector("[data-qc-port-not-approval]")?.textContent
    ).toBe(NOT_APPROVAL);
    expect(loading.querySelector("[aria-busy='true']")?.textContent).toBe(
      "Loading backtest study"
    );

    const denied = await mount(
      <StrategyBacktestStudy
        gateway={failing({ code: "FORBIDDEN", message: "Forbidden" })}
        slug="qc-opex-week"
      />
    );
    expect(stateOf(denied)).toBe("forbidden");
    expect(denied.textContent).toContain(
      "Backtest studies are limited to operators."
    );

    const signedOut = await mount(
      <StrategyBacktestStudy
        gateway={failing({ code: "UNAUTHORIZED", message: "Sign in" })}
        slug="qc-opex-week"
      />
    );
    expect(stateOf(signedOut)).toBe("unauthorized");
    expect(signedOut.querySelector("a")?.getAttribute("href")).toBe("/sign-in");

    const missing = await mount(
      <StrategyBacktestStudy
        gateway={failing({
          code: "NOT_FOUND",
          message: "Research study not found",
        })}
        slug="qc-opex-week"
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
      <StrategyBacktestStudy
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
        slug="qc-iv-rank-gate"
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
    runtime.client = {
      researchStudies: { get },
    } as unknown as ApiClient;
    const container = await mount(
      <StrategyBacktestStudy slug="qc-iv-rank-gate" />
    );
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(get).toHaveBeenCalledWith({ id: "qc-iv-rank-gate" });
    expect(stateOf(container)).toBe("ready");
  });
});

describe("strategy library detail: Backtest study section", () => {
  const strategy = (
    tags: string[],
    params: StrategyGetOutput["strategy"]["params"] = []
  ): StrategyGetOutput["strategy"] => ({
    backtestCount: 0,
    createdAt: UPDATED_AT,
    description: "Research only.",
    favorite: false,
    id: "strategy-seed-qc-iv-rank-gate",
    kind: "python",
    latestBacktest: null,
    name: "IV-Rank Gate for Credit Spreads",
    params,
    presetCount: 0,
    priority: "normal",
    externalValidation: null,
    section: "QuantConnect ideas",
    slug: "qc-iv-rank-gate",
    sourceRef: "docs/specs/strategies/qc-iv-rank-gate.md",
    status: "researching",
    tags,
    updatedAt: UPDATED_AT,
  });
  const detailFor = (
    tags: string[],
    params: StrategyGetOutput["strategy"]["params"] = []
  ) => (
    <StrategyDetail
      describeFailure={() => "failed"}
      detail={{ backtests: [], presets: [], strategy: strategy(tags, params) }}
      gateway={{} as StrategyLibraryGateway}
      onChanged={async () => undefined}
      onClose={() => undefined}
      onTab={() => undefined}
      researchStudies={{ get: async () => STUDY }}
      tab="backtests"
    />
  );

  it("loads the study by slug on the Backtests tab of a QuantConnect idea port", async () => {
    const container = await mount(
      detailFor(["research-only", "quantconnect-idea", "options"])
    );
    expect(stateOf(container)).toBe("ready");
    expect(
      container.querySelector("[data-strategy-research-only]")?.textContent
    ).toBe("Research only: no deployment");
    expect(
      container.querySelector("[data-strategy-request-deployment]")
    ).toBeNull();
  });

  it("has no Backtest study section on other entries", async () => {
    const container = await mount(detailFor(["research-only"]));
    expect(container.querySelector("[data-backtest-study-state]")).toBeNull();
  });

  it("links the stored definition of a qc-port row and still offers no deployment", async () => {
    const container = await mount(
      detailFor(["research-only", "quantconnect-idea"], DEFINITION_PARAMS)
    );
    expect(
      container
        .querySelector("[data-qc-port-definition]")
        ?.getAttribute("data-qc-port-definition")
    ).toBe("qc-iv-rank-gate");
    expect(
      container
        .querySelector("[data-qc-port-run-backtest]")
        ?.getAttribute("href")
    ).toContain("/backtest-runs?definition=qc-iv-rank-gate&");
    expect(
      container.querySelector("[data-strategy-research-only]")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-strategy-request-deployment]")
    ).toBeNull();
    expect(
      container.querySelector("[data-strategy-academy-lesson]")
    ).toBeNull();
  });
});

const choice = (name: string, value: string) => ({
  default: value,
  name,
  options: [value],
  title: name,
  type: "choice" as const,
});
const SHA = "6af3acdf0f0cb18ad993aba2e7919f8630b4774ac019b595cf4d111eac564f03";
const DEFINITION_PARAMS = [
  choice("definitionId", "qc-iv-rank-gate"),
  choice("definitionSha256", SHA),
  choice("runFrom", "1993-01-29"),
  choice("initialCapital", "100000"),
];

describe("QcPortDefinitionLink", () => {
  it("names the stored definition and links Backtest runs prefilled with it", async () => {
    const container = await mount(
      <QcPortDefinitionLink
        params={DEFINITION_PARAMS}
        strategyId="strategy-seed-qc-iv-rank-gate"
      />
    );
    expect(
      container.querySelector("[data-qc-port-definition-ref]")?.textContent
    ).toBe("Strategy definition: qc-iv-rank-gate (sha 6af3acdf0f0c…)");
    expect(container.textContent).toContain(
      "daily bars from 1993-01-29, capital 100,000, no cost. Research only; no orders."
    );
    const link = container.querySelector(
      "[data-qc-port-run-backtest]"
    ) as HTMLAnchorElement;
    expect(link.textContent).toBe("Run backtest");
    expect(link.getAttribute("href")).toBe(
      `/backtest-runs?definition=qc-iv-rank-gate&sha=${SHA}&strategy=strategy-seed-qc-iv-rank-gate&timeframe=1d&from=1993-01-29&initialCapital=100000&costBps=0`
    );
  });

  it("leaves out a missing run start and capital, and shows nothing without a definition", async () => {
    const container = await mount(
      <QcPortDefinitionLink
        params={DEFINITION_PARAMS.slice(0, 2)}
        strategyId="s-1"
      />
    );
    expect(container.textContent).toContain(
      "this definition on daily bars, no cost."
    );
    const empty = await mount(
      <QcPortDefinitionLink params={[]} strategyId="s-1" />
    );
    expect(empty.innerHTML).toBe("");
  });
});
