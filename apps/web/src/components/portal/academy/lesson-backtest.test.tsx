// @vitest-environment jsdom
import type { Lesson } from "@darkfactory/academy";
import { lessonBySlug } from "@darkfactory/academy/lessons";
import type {
  AcademyBacktestOutput,
  AcademyTickersOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import type { AcademyGateway } from "./academy-client.ts";
import { LessonBacktest } from "./lesson-backtest.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
/** Promise with external settle functions (Promise.withResolvers is outside the TS lib target). */
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const strategyLesson = (): Lesson => {
  const lesson = lessonBySlug("covered-call-asymmetry-fixes");
  if (lesson?.backtest === undefined) throw new Error("fixture missing");
  return lesson;
};

const trade = (index: number) => ({
  entryT: `2020-01-${String((index % 28) + 1).padStart(2, "0")}`,
  exitT: "2020-02-01",
  role: "cycle" as const,
  legs: ["short call 100", "long stock"],
  units: 1,
  spotEntry: 100,
  spotExit: 101.5,
  entryNet: -1200,
  exitValue: 1300,
  costs: 2,
  pnl: index % 2 === 0 ? 98 : -45,
  reason: "expiry" as const,
});

const result = (
  overrides: Partial<AcademyBacktestOutput> = {}
): AcademyBacktestOutput => ({
  slug: "covered-call-asymmetry-fixes",
  ticker: "SPY",
  structure: "covered_call",
  start: "2020-01-01",
  end: "2020-12-31",
  modeled: true,
  ivSource: "rv-model",
  assumptions: ["Modeled fills."],
  rules: { dte: 30, mysteryRule: 2 },
  equity: [
    { t: "2020-01-02", equity: 100_000 },
    { t: "2020-06-01", equity: 104_000 },
  ],
  benchmark: [
    { t: "2020-01-02", equity: 100_000 },
    { t: "2020-06-01", equity: 98_000 },
  ],
  drawdown: [
    { t: "2020-01-02", drawdown: 0 },
    { t: "2020-06-01", drawdown: -0.04 },
  ],
  trades: Array.from({ length: 30 }, (_, index) => trade(index)),
  tradesTotal: 30,
  stats: {
    totalReturn: 0.04,
    cagr: 0.08,
    maxDrawdown: -0.04,
    sharpe: 1.2,
    sortino: 1.5,
    volatility: 0.12,
    winRate: 0.5,
    trades: 30,
    wins: 15,
    avgPnl: -12,
    profitFactor: 1.4,
    exposure: 0.9,
    finalEquity: 104_000,
    benchmarkReturn: -0.02,
    benchmarkMaxDrawdown: -0.1,
  },
  data: {
    source: "stored bars",
    bars: 250,
    first: "2020-01-02",
    last: "2020-12-31",
  },
  ...overrides,
});

type Fake = AcademyGateway & {
  tickers: Mock;
  backtest: Mock;
};

const fakeGateway = (
  backtest: () => Promise<AcademyBacktestOutput>,
  tickers: () => Promise<AcademyTickersOutput> = async () => ({
    tickers: [
      { ticker: "QQQ", first: "2018-01-01", last: "2024-12-31", bars: 1000 },
      { ticker: "SPY", first: "2018-01-01", last: "2024-12-31", bars: 1000 },
    ],
  })
): Fake => ({
  tickers: vi.fn(tickers),
  backtest: vi.fn(backtest),
  deployPreview: vi.fn(),
  deployRequest: vi.fn(),
});

const mount = async (
  lesson: Lesson,
  gateway: AcademyGateway,
  onResult?: (output: AcademyBacktestOutput) => void
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <LessonBacktest
        gateway={gateway}
        lesson={lesson}
        {...(onResult === undefined ? {} : { onResult })}
      />
    )
  );
  return { container, root };
};

const change = async (
  element: HTMLInputElement | HTMLSelectElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value
  );
  await act(async () =>
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    )
  );
};

const query = <T extends Element>(container: HTMLElement, selector: string) =>
  container.querySelector(selector) as T;

describe("LessonBacktest", () => {
  it("runs the preset on load, renders stats and trades, and expands the trade list", async () => {
    const onResult = vi.fn();
    const gateway = fakeGateway(async () => result());
    const { container } = await mount(strategyLesson(), gateway, onResult);
    expect(onResult).toHaveBeenCalledTimes(1);
    const lesson = strategyLesson();
    expect(gateway.backtest).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: lesson.slug,
        ticker: lesson.backtest?.tickers[0],
        capital: 100_000,
      })
    );
    const panel = query(container, "[data-backtest-result]");
    expect(panel.getAttribute("data-backtest-trades")).toBe("30");
    const stats = query(container, '[data-table="bt-stats"]');
    expect(stats.textContent).toContain("4.0%");
    expect(stats.textContent).toContain("1.50");
    expect(stats.textContent).toContain("1.40");
    expect(stats.textContent).toContain("-$12");
    expect(stats.textContent).toContain("realized-volatility model");
    const rules = query(container, '[data-table="bt-rules"]');
    expect(rules.textContent).toContain("Days to expiry (cycle legs)");
    expect(rules.textContent).toContain("mysteryRule");
    expect(rules.textContent).toContain("Modeled fills.");
    const tradesTable = () =>
      query(container, '[data-table="bt-trades"]').querySelectorAll("tbody tr");
    expect(tradesTable().length).toBe(25);
    const more = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Show all")
    ) as HTMLButtonElement;
    await act(async () => more.click());
    expect(tradesTable().length).toBe(30);
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.startsWith("Show all")
      )
    ).toBe(false);
    const ticker = query<HTMLSelectElement>(container, "#bt-ticker");
    expect([...ticker.options].map((option) => option.value)).toContain("QQQ");
  });

  it("renders n/a for missing statistics and the supplied IV source without onResult", async () => {
    const gateway = fakeGateway(async () =>
      result({
        ivSource: "supplied",
        trades: [trade(0)],
        tradesTotal: 1,
        stats: {
          ...result().stats,
          sortino: null,
          volatility: null,
          profitFactor: null,
        },
      })
    );
    const { container } = await mount(strategyLesson(), gateway);
    const stats = query(container, '[data-table="bt-stats"]');
    expect(stats.textContent).toContain("n/a");
    expect(stats.textContent).toContain("VIX index (SPY)");
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.startsWith("Show all")
      )
    ).toBe(false);
  });

  it("edits the form, submits it, shows errors, and resets to the preset", async () => {
    let fail = false;
    const gateway = fakeGateway(async () => {
      if (fail) throw "not an error";
      return result();
    });
    const lesson = strategyLesson();
    const { container } = await mount(lesson, gateway);
    await change(query(container, "#bt-ticker"), "QQQ");
    await change(query(container, "#bt-start"), "2019-01-01");
    await change(query(container, "#bt-end"), "2020-01-01");
    await change(query(container, "#bt-capital"), "50000");
    const ruleInput = container.querySelector<HTMLInputElement>(
      '[id^="bt-rule-"]'
    ) as HTMLInputElement;
    const ruleKey = ruleInput.id.replace("bt-rule-", "");
    await change(ruleInput, "7");
    fail = true;
    await act(async () =>
      query<HTMLFormElement>(container, "form").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
    );
    expect(gateway.backtest).toHaveBeenLastCalledWith({
      slug: lesson.slug,
      ticker: "QQQ",
      start: "2019-01-01",
      end: "2020-01-01",
      rules: expect.objectContaining({ [ruleKey]: 7 }),
      capital: 50_000,
    });
    expect(query(container, '[role="alert"]').textContent).toBe(
      "Request failed"
    );
    expect(container.querySelector("[data-backtest-result]")).toBeNull();
    const reset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reset to preset"
    ) as HTMLButtonElement;
    await act(async () => reset.click());
    expect(query<HTMLSelectElement>(container, "#bt-ticker").value).toBe(
      lesson.backtest?.tickers[0]
    );
    expect(query<HTMLInputElement>(container, "#bt-start").value).toBe(
      lesson.backtest?.scenario.start
    );
    expect(ruleInput.value).not.toBe("7");
  });

  it("shows the running state while a backtest is pending", async () => {
    const { promise, resolve } = deferred<AcademyBacktestOutput>();
    const gateway = fakeGateway(() => promise);
    const { container } = await mount(strategyLesson(), gateway);
    const button = query<HTMLButtonElement>(container, "[data-run-backtest]");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Running…");
    expect(query(container, '[role="status"]').textContent).toContain(
      "Running the modeled backtest"
    );
    await act(async () => resolve(result()));
    expect(button.textContent).toBe("Run backtest");
  });

  it("falls back to SPY, unknown rule labels and the default note for a sparse preset", async () => {
    const base = strategyLesson();
    const preset = base.backtest;
    if (preset === undefined) throw new Error("fixture missing");
    const lesson: Lesson = {
      ...base,
      backtest: {
        ...preset,
        tickers: [],
        note: undefined,
        rules: { ...preset.rules, oddRule: 3 },
      },
    };
    const gateway = fakeGateway(
      async () => result(),
      async () => {
        throw new Error("tickers down");
      }
    );
    const { container } = await mount(lesson, gateway);
    expect(gateway.backtest).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: "SPY" })
    );
    expect(container.textContent).toContain("oddRule");
    await act(async () =>
      (
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Reset to preset"
        ) as HTMLButtonElement
      ).click()
    );
    expect(query<HTMLSelectElement>(container, "#bt-ticker").value).toBe("SPY");
  });

  it("renders nothing and runs nothing for a concept lesson, and ignores late ticker results", async () => {
    const concept = lessonBySlug("vega-exposure-basics");
    if (concept === null) throw new Error("fixture missing");
    const pending = deferred<AcademyTickersOutput>();
    const gateway = fakeGateway(
      async () => result(),
      () => pending.promise
    );
    const { container, root } = await mount(concept, gateway);
    expect(container.innerHTML).toBe("");
    expect(gateway.backtest).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    roots.splice(0);
    await act(async () => pending.resolve({ tickers: [] }));
    expect(gateway.tickers).toHaveBeenCalledTimes(1);
    const loaded = fakeGateway(async () => result());
    const second = await mount(concept, loaded);
    expect(loaded.tickers).toHaveBeenCalledTimes(1);
    expect(second.container.innerHTML).toBe("");
  });

  it("keeps the preset tickers that are stored, first, when tickers load ", async () => {
    const gateway = fakeGateway(async () => result());
    const lesson = strategyLesson();
    const { container } = await mount(lesson, gateway);
    const options = [
      ...query<HTMLSelectElement>(container, "#bt-ticker").options,
    ].map((option) => option.value);
    expect(new Set(options).size).toBe(options.length);
    expect(options[0]).toBe(lesson.backtest?.tickers[0]);
  });
});
