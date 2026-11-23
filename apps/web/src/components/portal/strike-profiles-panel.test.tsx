// @vitest-environment jsdom
import type { StrikeProfileRow } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { centerMarkedRow } from "./center-marked-row.ts";
import type { StrikeProfileSnapshot } from "./strike-profiles-model.ts";
import { StrikeProfilesPanel } from "./strike-profiles-panel.tsx";

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

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const row = (
  strike: number,
  over: Partial<StrikeProfileRow> = {}
): StrikeProfileRow => ({
  bearishPremium: 0,
  bullishPremium: 0,
  callOpenInterest: 0,
  callVolume: 0,
  holderPayout: 0,
  putOpenInterest: 0,
  putVolume: 0,
  strike,
  trades: 0,
  ...over,
});

const snapshot = (
  over: Partial<StrikeProfileSnapshot> = {}
): StrikeProfileSnapshot => ({
  exposure: {
    gexExpiry: null,
    maxPain: 100,
    message: null,
    status: "ok",
    strikes: [],
    totalGex: null,
  },
  flow: {
    buckets: [],
    callPremium: 0,
    events: [],
    hours: 6,
    message: null,
    putPremium: 0,
    status: "ok",
  },
  spot: 104.5,
  strikeProfiles: {
    flow: {
      complete: true,
      newestTradeAt: "2026-10-22T14:10:00.000Z",
      offLadderTrades: 0,
      oldestTradeAt: "2026-10-22T09:00:00.000Z",
      source: "stored_prints",
      trades: 4,
    },
    strikes: [
      row(90, { holderPayout: 50_000, putOpenInterest: 400 }),
      row(100, {
        bearishPremium: 100,
        bullishPremium: 900,
        callOpenInterest: 200,
        callVolume: 30,
        holderPayout: 10_000,
        putOpenInterest: 100,
        trades: 4,
      }),
      row(110, { callOpenInterest: 600, holderPayout: 70_000 }),
    ],
  },
  ...over,
});

const render = async (value: StrikeProfileSnapshot): Promise<HTMLElement> => {
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  await act(async () => {
    mounted.render(<StrikeProfilesPanel snapshot={value} />);
  });
  return host;
};

const bodyRows = (view: HTMLElement): string[] =>
  [...view.querySelectorAll("tbody tr")].map((item) =>
    item.hasAttribute("data-spot-line")
      ? "spot"
      : (item.querySelector("td")?.textContent ?? "")
  );

const choose = async (view: HTMLElement, label: string): Promise<void> => {
  const input = [...view.querySelectorAll("label")]
    .find((item) => item.textContent === label)
    ?.querySelector("input");
  await act(async () => {
    input?.click();
  });
};

describe("StrikeProfilesPanel", () => {
  it("draws the open interest ladder from the highest strike with the spot line", async () => {
    const view = await render(snapshot());
    const section = view.querySelector("[data-strike-profiles]");
    expect(section?.getAttribute("data-strike-profiles")).toBe("openInterest");
    expect(view.querySelector("legend")?.textContent).toBe("Profile");
    const radios = [
      ...view.querySelectorAll<HTMLInputElement>("input[type=radio]"),
    ];
    expect(radios.map((radio) => radio.checked)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(bodyRows(view)).toEqual(["110", "spot", "100", "90"]);
    expect(view.querySelector("[data-spot-line]")?.textContent).toBe(
      "Spot 104.50"
    );
    expect(
      [...view.querySelectorAll("thead th")].map((cell) => cell.textContent)
    ).toEqual(["Strike", "Puts", "Bar", "Calls"]);
    const callBar = view.querySelector<HTMLElement>(
      'tbody tr [data-bar="calls"]'
    );
    expect(callBar?.style.width).toBe("100%");
    expect(view.querySelector("tbody tr")?.getAttribute("title")).toBe(
      "Strike 110: put OI 0, call OI 600"
    );
  });

  it("switches profiles and keeps the same rows", async () => {
    const view = await render(snapshot());
    await choose(view, "Net premium");
    expect(
      view
        .querySelector("[data-strike-profiles]")
        ?.getAttribute("data-strike-profiles")
    ).toBe("netPremium");
    expect(view.textContent).toContain("All stored prints of the last 6 h");
    expect(bodyRows(view)).toEqual(["110", "spot", "100", "90"]);
    expect(view.querySelector('[data-bar="bullish"]')).not.toBeNull();
    // The signed net is readable text in the bar cell.
    expect(
      view.querySelector("tbody tr td:nth-child(3) .sr-only")?.textContent
    ).toBe("Net $0");
    expect(view.textContent).toContain("Net +$800");
    await choose(view, "Flow volume");
    expect(view.querySelector('[data-bar="calls"]')).not.toBeNull();
    await choose(view, "Max pain");
    expect(
      [...view.querySelectorAll("thead th")].map((cell) => cell.textContent)
    ).toEqual(["Strike", "Payout", "Bar"]);
    const marked = view.querySelector("[data-max-pain-row]");
    expect(marked?.textContent).toContain("100max pain");
    expect(
      marked?.querySelector<HTMLElement>('[data-bar="payout"]')?.className
    ).toContain("bg-primary");
    expect(view.querySelectorAll('[data-bar="payout"]')).toHaveLength(3);
    expect(
      view.querySelector("[data-spot-line] td")?.getAttribute("colspan")
    ).toBe("3");
  });

  it("puts the spot line first or leaves it out", async () => {
    const above = await render(snapshot({ spot: 120 }));
    expect(bodyRows(above)).toEqual(["spot", "110", "100", "90"]);
    act(() => root?.unmount());
    const none = await render(snapshot({ spot: null }));
    expect(bodyRows(none)).toEqual(["110", "100", "90"]);
  });

  it("shows the source message instead of a ladder", async () => {
    const view = await render(
      snapshot({
        exposure: {
          gexExpiry: null,
          maxPain: null,
          message: "QuantData openInterest: HTTP 500.",
          status: "unavailable",
          strikes: [],
          totalGex: null,
        },
      })
    );
    expect(view.querySelector("[role=status]")?.textContent).toBe(
      "QuantData openInterest: HTTP 500."
    );
    expect(view.querySelector("table")).toBeNull();
  });
});

describe("centerMarkedRow", () => {
  it("scrolls the box so the marked row sits in its middle", () => {
    const box = document.createElement("div");
    const marked = document.createElement("div");
    marked.setAttribute("data-mark", "");
    box.append(marked);
    Object.defineProperty(box, "clientHeight", { value: 100 });
    Object.defineProperty(marked, "offsetTop", { value: 300 });
    centerMarkedRow(box, "[data-mark]");
    expect(box.scrollTop).toBe(250);
    // No marked row or no box: nothing moves.
    const empty = document.createElement("div");
    centerMarkedRow(empty, "[data-mark]");
    expect(empty.scrollTop).toBe(0);
    expect(() => centerMarkedRow(null, "[data-mark]")).not.toThrow();
  });
});
