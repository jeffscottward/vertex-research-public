// @vitest-environment jsdom
import { act, type ReactElement, useState } from "react";
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
  DEFAULT_UNIVERSE_CHOICE,
  firstSeriesKey,
  parseUniverseChoice,
  UNIVERSE_CHOICES,
  type UniverseChoice,
  UniverseSelect,
  universeChoiceLabel,
  visibleSeries,
} from "./backtest-universe.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return container;
};

const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value"
    )?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
};

const STORED = [
  { symbol: "BTCUSDT", timeframe: "1m" },
  { symbol: "CL=F", timeframe: "1d" },
  { symbol: "ES=F", timeframe: "1d" },
  { symbol: "SPY", timeframe: "1d" },
  { symbol: "ES=F", timeframe: "1m" },
  { symbol: "TEST", timeframe: "1d" },
] as const;

describe("universe choices", () => {
  it("offers both Core 7 universes and all stored series, with Core 7 futures as default", () => {
    expect(DEFAULT_UNIVERSE_CHOICE).toBe("core7-futures");
    expect(UNIVERSE_CHOICES).toEqual([
      { label: "Core 7 futures", value: "core7-futures" },
      { label: "Core 7 ETF twins", value: "core7-etf-twins" },
      { label: "All stored series", value: "all" },
    ]);
    expect(universeChoiceLabel("core7-etf-twins")).toBe("Core 7 ETF twins");
    expect(universeChoiceLabel("all")).toBe("All stored series");
  });

  it("reads known choices and falls back to the default for anything else", () => {
    expect(parseUniverseChoice("all")).toBe("all");
    expect(parseUniverseChoice("core7-etf-twins")).toBe("core7-etf-twins");
    expect(parseUniverseChoice("core7-futures")).toBe("core7-futures");
    expect(parseUniverseChoice("nasdaq")).toBe("core7-futures");
    expect(parseUniverseChoice(null)).toBe("core7-futures");
  });

  it("lists universe members in member order and falls back to every series when none is stored", () => {
    expect(visibleSeries(STORED, "core7-futures")).toEqual({
      fallback: false,
      series: [STORED[2], STORED[4], STORED[1]],
    });
    expect(visibleSeries(STORED, "core7-etf-twins")).toEqual({
      fallback: false,
      series: [STORED[3]],
    });
    expect(visibleSeries(STORED, "all")).toEqual({
      fallback: false,
      series: [...STORED],
    });
    const onlyTest = [{ symbol: "TEST" }];
    expect(visibleSeries(onlyTest, "core7-futures")).toEqual({
      fallback: true,
      series: onlyTest,
    });
    expect(visibleSeries([], "core7-futures")).toEqual({
      fallback: true,
      series: [],
    });
  });
});

const Harness = ({
  initial,
  stored,
  onPick,
}: Readonly<{
  initial: UniverseChoice;
  stored: readonly string[];
  onPick: (value: UniverseChoice) => void;
}>) => {
  const [value, setValue] = useState(initial);
  return (
    <UniverseSelect
      fallback={
        visibleSeries(
          stored.map((symbol) => ({ symbol })),
          value
        ).fallback
      }
      onChange={(next) => {
        onPick(next);
        setValue(next);
      }}
      storedSymbols={stored}
      value={value}
    />
  );
};

describe("firstSeriesKey", () => {
  it("keys the first series the choice lists, or returns an empty key", () => {
    const SPY = { symbol: "SPY", timeframe: "1d" };
    const ES = { symbol: "ES=F", timeframe: "1d" };
    expect(firstSeriesKey([SPY, ES], "core7-futures")).toBe("ES=F:1d");
    expect(firstSeriesKey([SPY, ES], "all")).toBe("SPY:1d");
    expect(firstSeriesKey([], "core7-futures")).toBe("");
  });
});

describe("UniverseSelect", () => {
  it("shows the members, marks the ones without bars and changes the choice", async () => {
    const onPick = vi.fn();
    const container = await mount(
      <Harness
        initial="core7-futures"
        onPick={onPick}
        stored={["ES=F", "CL=F", "SPY"]}
      />
    );
    const label = container.querySelector("label");
    expect(label?.textContent).toBe("Universe");
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(label?.getAttribute("for")).toBe(select.id);
    expect(select.value).toBe("core7-futures");
    expect(select.className).toBe(
      "min-h-11 rounded-md border bg-background px-3 text-sm"
    );
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Core 7 futures",
      "Core 7 ETF twins",
      "All stored series",
    ]);
    const members = container.querySelector("[data-universe-members]");
    expect(members?.textContent).toBe(
      "ES=F S&P 500 · NQ=F Nasdaq-100 (no bars) · YM=F Dow 30 (no bars) · RTY=F Russell 2000 (no bars) · GC=F Gold (no bars) · SI=F Silver (no bars) · CL=F WTI crude oil"
    );
    expect(select.getAttribute("aria-describedby")).toBe(members?.id);
    expect(container.querySelector("[data-universe-fallback]")).toBeNull();

    await choose(select, "core7-etf-twins");
    expect(onPick).toHaveBeenLastCalledWith("core7-etf-twins");
    expect(
      container.querySelector("[data-universe-members]")?.textContent
    ).toMatch(/^SPY S&P 500 · QQQ Nasdaq-100 \(no bars\)/u);

    await choose(select, "all");
    expect(onPick).toHaveBeenLastCalledWith("all");
    expect(container.querySelector("[data-universe-members]")).toBeNull();
    expect(select.hasAttribute("aria-describedby")).toBe(false);
  });

  it("explains the fallback when no member has stored bars", async () => {
    const container = await mount(
      <UniverseSelect
        fallback
        id="universe"
        onChange={vi.fn()}
        selectClassName="custom"
        storedSymbols={["TEST"]}
        value="core7-etf-twins"
      />
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.id).toBe("universe");
    expect(select.className).toBe("custom");
    const note = container.querySelector("[data-universe-fallback]");
    expect(note?.textContent).toBe(
      "No stored bars for Core 7 ETF twins yet. Showing all stored series."
    );
    expect(select.getAttribute("aria-describedby")).toBe(
      "universe-members universe-note"
    );
  });
});
