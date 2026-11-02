// @vitest-environment jsdom
import type {
  StrategyGetOutput,
  StrategyOutput,
  StrategySummaryOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
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

import type { StrategyLibraryGateway } from "./agent-ops-client.tsx";
import {
  descriptionLinks,
  groupBySection,
  parseParamsJson,
  presetExportText,
  presetValuesFromForm,
} from "./strategy-library-model.ts";
import {
  SEARCH_DEBOUNCE_MS,
  StrategyLibraryWorkspace,
} from "./strategy-library-workspace.tsx";

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
  } else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  return;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  return;
});

const flush = async () => ({
  ...(await (async () => {
    const results = {};
    for (let i = 0; i < 20; i += 1)
      Object.assign(results, await Promise.resolve());
    return results;
  })()),
});
const at = new Date("2026-01-02T03:04:05.000Z");

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    return await flush();
  });
  return container;
};

const button = (
  label: string,
  scope: ParentNode = document
): HTMLButtonElement => {
  const found = [...scope.querySelectorAll("button")].find((node) => {
    return (
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
    );
  });
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
};

const click = async (element: HTMLElement) => {
  return await act(async () => {
    element.click();
    return await flush();
  });
};

const setValue = async (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) => {
  return await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
    return await flush();
  });
};

const lookback = {
  name: "lookback",
  type: "integer" as const,
  title: "Lookback bars",
  default: 20,
  min: 5,
  max: 250,
  step: 1,
};
const venue = {
  name: "venue",
  type: "choice" as const,
  title: "Venue",
  default: "cme",
  options: ["cme", "cboe"],
};
const stops = {
  name: "use_stops",
  type: "boolean" as const,
  title: "Use stops",
  default: true,
};

const summary = (
  overrides: Partial<StrategySummaryOutput> = {}
): StrategySummaryOutput => ({
  id: "s-hmm",
  slug: "hmm",
  name: "HMM forward filter",
  description: "Forward filtering only.",
  kind: "python",
  status: "researching",
  sourceRef: "services/research/strategies/hmm.py",
  tags: ["regime"],
  favorite: false,
  section: null,
  params: [],
  createdAt: at,
  updatedAt: at,
  presetCount: 0,
  backtestCount: 0,
  latestBacktest: null,
  ...overrides,
});

const rows = (): StrategySummaryOutput[] => [
  summary(),
  summary({
    id: "s-jump",
    slug: "jump",
    name: "Jump model",
    section: "Regime",
    backtestCount: 1,
    latestBacktest: {
      id: "bt-1",
      createdAt: at,
      sharpe: 1.234,
      totalReturn: 0.1,
      cagr: 0.05,
      maxDrawdown: -0.08,
    },
  }),
  summary({
    id: "s-wheel",
    slug: "wheel",
    name: "Options wheel",
    section: "Options",
    favorite: true,
  }),
];

const detailFor = (
  row: StrategySummaryOutput,
  extra: Partial<StrategyGetOutput> = {}
): StrategyGetOutput => ({
  strategy: row,
  presets: [],
  backtests: [],
  ...extra,
});

const toStrategy = (row: StrategySummaryOutput): StrategyOutput => {
  const {
    presetCount: _p,
    backtestCount: _b,
    latestBacktest: _l,
    ...rest
  } = row;
  return rest;
};

const gatewayWith = (
  overrides: Partial<StrategyLibraryGateway> = {}
): StrategyLibraryGateway & {
  [K in keyof StrategyLibraryGateway]: ReturnType<typeof vi.fn>;
} => {
  return {
    list: vi.fn(async () => rows()),
    get: vi.fn(async (id: string) =>
      detailFor(rows().find((row) => row.id === id) ?? summary({ id }))
    ),
    create: vi.fn(async (input) =>
      toStrategy(summary({ id: "s-new", name: input.name, kind: input.kind }))
    ),
    update: vi.fn(async (input) =>
      toStrategy(summary({ id: input.id, favorite: input.favorite ?? false }))
    ),
    savePreset: vi.fn(async (input) => ({
      id: "p-1",
      strategyId: input.strategyId,
      name: input.name,
      values: input.values,
      createdAt: at,
      updatedAt: at,
    })),
    removePreset: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as StrategyLibraryGateway & {
    [K in keyof StrategyLibraryGateway]: ReturnType<typeof vi.fn>;
  };
};

describe("strategy library board", () => {
  it("groups by section with Unsorted last and shows derived latest-backtest stats", async () => {
    const container = await mount(
      <StrategyLibraryWorkspace
        gateway={gatewayWith()}
        initialStrategyId={null}
      />
    );
    expect(
      [...container.querySelectorAll("[data-section]")].map((node) =>
        node.getAttribute("data-section")
      )
    ).toEqual(["Options", "Regime", "Unsorted"]);
    const jump = container.querySelector('[data-strategy-row="s-jump"]')!;
    expect(jump.querySelector('[data-col="sharpe"]')?.textContent).toBe("1.23");
    expect(jump.querySelector('[data-col="return"]')?.textContent).toBe(
      "10.00%"
    );
    expect(
      container.querySelector('[data-strategy-row="s-hmm"] [data-col="sharpe"]')
        ?.textContent
    ).toBe("—");
    return expect(
      container
        .querySelector('[data-strategy-row="s-wheel"] [data-favorite]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("sends status, favorites, sort and debounced search filters to the API", async () => {
    vi.useFakeTimers();
    try {
      const gateway = gatewayWith();
      const container = await mount(
        <StrategyLibraryWorkspace gateway={gateway} initialStrategyId={null} />
      );
      expect(gateway.list).toHaveBeenLastCalledWith({ sort: "updated" });
      await setValue(
        container.querySelector<HTMLSelectElement>(
          '[aria-label="Status filter"]'
        )!,
        "researching"
      );
      await click(button("Favorites only"));
      await setValue(
        container.querySelector<HTMLSelectElement>(
          '[aria-label="Sort strategies"]'
        )!,
        "sharpe"
      );
      expect(gateway.list).toHaveBeenLastCalledWith({
        status: "researching",
        favorite: true,
        sort: "sharpe",
      });
      const source = container.querySelector<HTMLSelectElement>(
        '[aria-label="Source filter"]'
      )!;
      expect([...source.options].map((option) => option.text)).toContain(
        "QuantJourney"
      );
      await setValue(source, "quantjourney");
      expect(gateway.list).toHaveBeenLastCalledWith({
        status: "researching",
        tag: "quantjourney",
        favorite: true,
        sort: "sharpe",
      });
      await setValue(source, "");
      await setValue(
        container.querySelector<HTMLInputElement>(
          '[aria-label="Search strategies"]'
        )!,
        " jump "
      );
      await act(async () => {
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
        return await flush();
      });
      expect(gateway.list).toHaveBeenLastCalledWith({
        search: "jump",
        status: "researching",
        favorite: true,
        sort: "sharpe",
      });
      return expect(button("Favorites only").getAttribute("aria-pressed")).toBe(
        "true"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("toggles a favorite through update and switches to the card view", async () => {
    const gateway = gatewayWith();
    const container = await mount(
      <StrategyLibraryWorkspace gateway={gateway} initialStrategyId={null} />
    );
    await click(
      button(
        "Favorite HMM forward filter",
        container.querySelector('[data-strategy-row="s-hmm"]')!
      )
    );
    expect(gateway.update).toHaveBeenCalledWith({
      id: "s-hmm",
      favorite: true,
    });
    expect(container.textContent).toContain("Favorited HMM forward filter.");
    await click(button("Cards"));
    expect(container.querySelectorAll("[data-strategy-card]")).toHaveLength(3);
    return expect(container.querySelector("[data-strategy-row]")).toBeNull();
  });

  it("links the source dashboard and code named in a description", async () => {
    const linked = summary({
      id: "s-qj",
      name: "QuantJourney W01",
      description:
        "Re-run in Vertex. Dashboard: https://backtester.quantjourney.cloud/strategies/w01. GitHub: https://github.com/QuantJourneyOrg/quantjourney-bt/blob/main/strategies/w01.py",
    });
    const gateway = gatewayWith({
      list: vi.fn(async () => [linked]),
      get: vi.fn(async () => detailFor(linked)),
    });
    const container = await mount(
      <StrategyLibraryWorkspace gateway={gateway} initialStrategyId={null} />
    );
    await click(button("Cards"));
    const card = container.querySelector('[data-strategy-card="s-qj"]')!;
    const links = [...card.querySelectorAll("[data-strategy-links] a")];
    expect(links.map((link) => link.textContent)).toEqual([
      "backtester.quantjourney.cloud",
      "github.com",
    ]);
    expect(links[0]?.getAttribute("href")).toBe(
      "https://backtester.quantjourney.cloud/strategies/w01"
    );
    expect(links[1]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[1]?.getAttribute("target")).toBe("_blank");
    await click(
      card.querySelector<HTMLAnchorElement>('a[href="/library?id=s-qj"]')!
    );
    return expect(
      container.querySelectorAll(
        '[data-strategy-detail="s-qj"] [data-strategy-links] a'
      )
    ).toHaveLength(2);
  });

  it("creates a strategy and opens it", async () => {
    const gateway = gatewayWith();
    const container = await mount(
      <StrategyLibraryWorkspace gateway={gateway} initialStrategyId={null} />
    );
    await click(button("Create strategy"));
    expect(container.textContent).toContain("Name is required.");
    expect(gateway.create).not.toHaveBeenCalled();
    await setValue(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Strategy name"]'
      )!,
      "Mean reversion"
    );
    await setValue(
      container.querySelector<HTMLSelectElement>(
        '[aria-label="Strategy kind"]'
      )!,
      "native"
    );
    await setValue(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Strategy section"]'
      )!,
      "Equities"
    );
    await click(button("Create strategy"));
    expect(gateway.create).toHaveBeenCalledWith({
      name: "Mean reversion",
      kind: "native",
      description: "",
      section: "Equities",
    });
    expect(gateway.get).toHaveBeenCalledWith("s-new");
    expect(
      container.querySelector('[data-strategy-detail="s-new"]')
    ).not.toBeNull();
    return expect(window.location.search).toBe("?id=s-new");
  });

  return it("shows operator denial", async () => {
    const gateway = gatewayWith({
      list: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "FORBIDDEN" });
      }),
    });
    const container = await mount(
      <StrategyLibraryWorkspace gateway={gateway} initialStrategyId={null} />
    );
    return expect(
      container.querySelector('[data-operator-access="required"]')
    ).not.toBeNull();
  });
});

describe("strategy detail", () => {
  it("opens from ?id=&tab=, supports arrow-key tabs and saves the overview", async () => {
    window.history.replaceState(null, "", "/library?id=s-jump&tab=backtests");
    const backtest = {
      id: "bt-1",
      taskId: "task-1",
      paperId: null,
      strategyId: "s-jump",
      strategy: "jump v1",
      instruments: "SPY",
      periodStart: "2020-01-01",
      periodEnd: "2020-12-31",
      dataSource: "fixture",
      isSplit: null,
      metrics: { sharpe: 0.7 },
      maxDrawdown: -0.08,
      tradeCount: 3,
      notes: null,
      createdAt: at,
      pointCount: 10,
      foldCount: 0,
      taskTitle: "Backtest jump",
    };
    const gateway = gatewayWith({
      get: vi.fn(async () => detailFor(rows()[1]!, { backtests: [backtest] })),
    });
    const container = await mount(
      <StrategyLibraryWorkspace gateway={gateway} />
    );
    const section = container.querySelector('[data-strategy-detail="s-jump"]')!;
    expect(
      section.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    ).toBe("Backtests");
    const link = section.querySelector<HTMLAnchorElement>(
      '[data-linked-backtest="bt-1"] a'
    )!;
    expect(link.getAttribute("href")).toBe("/backtests?id=bt-1");
    expect(
      section.querySelector("[data-latest-summary]")?.textContent
    ).toContain("Sharpe 1.23");

    const tablist = section.querySelector<HTMLElement>('[role="tablist"]')!;
    await act(async () => {
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true })
      );
      return await flush();
    });
    expect(
      section.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    ).toBe("Overview");
    expect(document.activeElement?.id).toBe("strategy-tab-overview");
    expect(window.location.search).toBe("?id=s-jump");
    await act(async () => {
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })
      );
      return await flush();
    });
    expect(window.location.search).toBe("?id=s-jump&tab=backtests");
    await act(async () => {
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      );
      return await flush();
    });

    const form = section.querySelector<HTMLFormElement>(
      "[data-strategy-overview-form]"
    )!;
    await setValue(
      form.querySelector<HTMLSelectElement>('[aria-label="Status"]')!,
      "backtested"
    );
    const inputs = form.querySelectorAll<HTMLInputElement>("input");
    await setValue(inputs[2]!, " regime, hmm ,, ");
    await click(button("Save overview", section));
    expect(gateway.update).toHaveBeenCalledWith({
      id: "s-jump",
      name: "Jump model",
      status: "backtested",
      section: "Regime",
      tags: ["regime", "hmm"],
      sourceRef: "services/research/strategies/hmm.py",
      description: "Forward filtering only.",
    });
    return expect(section.textContent).toContain("Saved.");
  });

  it("edits the params schema as JSON and shows server validation errors", async () => {
    const failure = Object.assign(new Error("x"), {
      code: "VALIDATION_ERROR",
      message: "params[0].default must be at most 250",
    });
    const gateway = gatewayWith({
      get: vi.fn(async () => detailFor(summary({ params: [lookback] }))),
      update: vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(toStrategy(summary({ params: [lookback] }))),
    });
    window.history.replaceState(null, "", "/library?id=s-hmm&tab=parameters");
    const container = await mount(
      <StrategyLibraryWorkspace gateway={gateway} />
    );
    expect(
      container.querySelector('[data-param="lookback"]')?.textContent
    ).toContain("Lookback bars");
    const editor = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Params schema JSON"]'
    )!;
    expect(JSON.parse(editor.value)).toEqual([lookback]);
    await setValue(editor, "{not json");
    await click(button("Save schema"));
    expect(container.textContent).toContain("Invalid JSON");
    expect(gateway.update).not.toHaveBeenCalled();
    await setValue(editor, JSON.stringify([{ ...lookback, default: 999 }]));
    await click(button("Save schema"));
    expect(gateway.update).toHaveBeenCalledWith({
      id: "s-hmm",
      params: [{ ...lookback, default: 999 }],
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Rejected: params[0].default must be at most 250"
    );
    await click(button("Save schema"));
    return expect(container.textContent).toContain("Schema saved.");
  });

  return it("saves a preset from typed inputs, copies it as text and deletes it", async () => {
    const preset = {
      id: "p-1",
      strategyId: "s-hmm",
      name: "fast",
      values: { lookback: 10, venue: "cboe", use_stops: false },
      createdAt: at,
      updatedAt: at,
    };
    const gateway = gatewayWith({
      get: vi.fn(async () =>
        detailFor(summary({ params: [lookback, venue, stops] }), {
          presets: [preset],
        })
      ),
    });
    window.history.replaceState(null, "", "/library?id=s-hmm&tab=parameters");
    const container = await mount(
      <StrategyLibraryWorkspace gateway={gateway} />
    );
    const form =
      container.querySelector<HTMLFormElement>("[data-preset-form]")!;
    const number = form.querySelector<HTMLInputElement>(
      "#preset-param-lookback"
    )!;
    expect(number.type).toBe("number");
    expect(number.min).toBe("5");
    expect(number.max).toBe("250");
    expect(
      form.querySelector<HTMLSelectElement>("#preset-param-venue")!.value
    ).toBe("cme");
    expect(
      form.querySelector<HTMLInputElement>("#preset-param-use_stops")!.checked
    ).toBe(true);
    await click(button("Save preset", form));
    expect(container.textContent).toContain("Preset name is required.");
    await setValue(
      form.querySelector<HTMLInputElement>("input:not([id])")!,
      "slow"
    );
    await setValue(number, "60");
    await setValue(
      form.querySelector<HTMLSelectElement>("#preset-param-venue")!,
      "cboe"
    );
    await click(
      form.querySelector<HTMLInputElement>("#preset-param-use_stops")!
    );
    await click(button("Save preset", form));
    expect(gateway.savePreset).toHaveBeenCalledWith({
      strategyId: "s-hmm",
      name: "slow",
      values: { lookback: 60, venue: "cboe", use_stops: false },
    });
    expect(container.textContent).toContain("Saved preset slow.");

    await click(button("Copy fast"));
    expect(
      container.querySelector('[data-preset-export="fast"]')?.textContent
    ).toBe("# hmm preset fast\nlookback=10\nvenue=cboe\nuse_stops=false");
    await click(button("Load fast"));
    expect(number.value).toBe("10");
    await click(button("Delete fast"));
    expect(gateway.removePreset).toHaveBeenCalledWith("s-hmm", "p-1");
    return expect(container.textContent).toContain("Deleted preset fast.");
  });
});

describe("strategy library helpers", () =>
  it("groups sections, parses schema JSON and converts preset form values", () => {
    expect(groupBySection(rows()).map((group) => group.label)).toEqual([
      "Options",
      "Regime",
      "Unsorted",
    ]);
    expect(descriptionLinks(null)).toEqual([]);
    expect(
      descriptionLinks(
        "See https://a.test/x, https://a.test/x; http://b.test and https://[bad."
      )
    ).toEqual([{ label: "a.test", url: "https://a.test/x" }]);
    expect(parseParamsJson("")).toEqual([]);
    expect(parseParamsJson("{}")).toBe("Params schema must be a JSON array.");
    expect(
      presetValuesFromForm([lookback, stops], {
        lookback: "12",
        use_stops: false,
      })
    ).toEqual({ lookback: 12, use_stops: false });
    expect(presetValuesFromForm([lookback], { lookback: "1.5" })).toBe(
      "Lookback bars must be a whole number."
    );
    expect(presetValuesFromForm([lookback], { lookback: " " })).toBe(
      "Lookback bars is required."
    );
    return expect(
      presetExportText(
        "x",
        {
          id: "p",
          strategyId: "s",
          name: "n",
          values: { z: 1, lookback: 2 },
          createdAt: at,
          updatedAt: at,
        },
        [lookback]
      )
    ).toBe("# x preset n\nlookback=2\nz=1");
  }));
