// @vitest-environment jsdom
import {
  WATCHLIST_MAX_SYMBOLS_PER_ADD,
  type WatchlistItemOutput,
} from "@darkfactory/api";
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

import type {
  WatchlistEditInput,
  WatchlistGateway,
} from "./watchlist-client.ts";
import { WatchlistWorkspace } from "./watchlist-workspace.tsx";

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
  return document.body.replaceChildren();
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
const item = (
  symbol: string,
  overrides: Partial<WatchlistItemOutput> = {}
): WatchlistItemOutput => ({
  id: `id-${symbol}`,
  symbol,
  note: null,
  buyZoneLow: null,
  buyZoneHigh: null,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const setValue = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  return await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return await flush();
  });
};

const clickButton = async (label: string) => {
  const button = [...document.querySelectorAll("button")].find((node) => {
    return (
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
    );
  });
  if (button === undefined) throw new Error(`Missing button ${label}`);
  return await act(async () => {
    button.click();
    return await flush();
  });
};

const byLabel = <T extends Element>(label: string): T => {
  const found = document.querySelector<T>(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`Missing ${label}`);
  return found;
};

const mount = async (gateway: WatchlistGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<WatchlistWorkspace gateway={gateway} />);
    return await flush();
  });
  return container;
};

describe("watchlist workspace", () => {
  it("pastes symbols, edits a buy zone and note, then removes a row", async () => {
    let rows: WatchlistItemOutput[] = [];
    const gateway: WatchlistGateway = {
      list: vi.fn(async () => rows),
      add: vi.fn(async (symbols: readonly string[]) => {
        rows = [item("AAA"), item("BBB.X")];
        return {
          items: rows,
          added: ["AAA", "BBB.X"],
          existing: [],
          rejected: symbols.filter((token) => token === "9ZZ"),
        };
      }),
      update: vi.fn(async (id: string, input: WatchlistEditInput) => {
        const next = item("AAA", {
          note: input.note ?? null,
          buyZoneLow: input.buyZone?.low ?? null,
          buyZoneHigh: input.buyZone?.high ?? null,
        });
        rows = rows.map((row) => (row.id === id ? next : row));
        return next;
      }),
      remove: vi.fn(async (id: string) => {
        rows = rows.filter((row) => row.id !== id);
      }),
    };
    const container = await mount(gateway);
    expect(container.textContent).toContain("No symbols.");

    await setValue(
      byLabel<HTMLTextAreaElement>("Symbols to add"),
      "aaa, bbb.x\n9ZZ"
    );
    await clickButton("Add symbols");
    expect(gateway.add).toHaveBeenCalledWith(["aaa", "bbb.x", "9ZZ"]);
    expect(
      [...container.querySelectorAll("tbody tr")].map((row) =>
        row.getAttribute("data-symbol")
      )
    ).toEqual(["AAA", "BBB.X"]);
    expect(container.textContent).toContain(
      "Added 2 · already listed 0 · rejected 1: 9ZZ"
    );
    expect(byLabel<HTMLTextAreaElement>("Symbols to add").value).toBe("9ZZ");

    await clickButton("Edit AAA");
    await setValue(byLabel<HTMLInputElement>("AAA buy zone low"), "15");
    await setValue(byLabel<HTMLInputElement>("AAA buy zone high"), "12");
    await clickButton("Save");
    expect(gateway.update).not.toHaveBeenCalled();
    const zoneError = container.querySelector(
      'tr[data-symbol="AAA"] [role="alert"]'
    );
    expect(zoneError?.textContent).toBe(
      "Low (15) must be less than or equal to high (12)."
    );
    expect(
      byLabel<HTMLInputElement>("AAA buy zone low").getAttribute("aria-invalid")
    ).toBe("true");

    await setValue(byLabel<HTMLInputElement>("AAA buy zone low"), "10");
    await setValue(byLabel<HTMLInputElement>("AAA buy zone high"), "12.5");
    await setValue(byLabel<HTMLInputElement>("AAA note"), "base retest");
    await clickButton("Save");
    expect(gateway.update).toHaveBeenCalledWith("id-AAA", {
      note: "base retest",
      buyZone: { low: "10", high: "12.5" },
    });
    const aaa = container.querySelector('tr[data-symbol="AAA"]')!;
    expect(aaa.textContent).toContain("10 – 12.5");
    expect(aaa.textContent).toContain("base retest");

    const order = () =>
      [...container.querySelectorAll("tbody tr")].map((row) =>
        row.getAttribute("data-symbol")
      );
    const header = (name: string) =>
      [...container.querySelectorAll("thead th")].find((cell) =>
        cell.textContent?.startsWith(name)
      );
    await clickButton("Symbol");
    expect(header("Symbol")?.getAttribute("aria-sort")).toBe("ascending");
    await clickButton("Symbol");
    expect(order()).toEqual(["BBB.X", "AAA"]);
    await clickButton("Buy zone (low – high)");
    await clickButton("Buy zone (low – high)");
    // Empty buy zones sort last in both directions.
    expect(order()).toEqual(["AAA", "BBB.X"]);
    await clickButton("Note");
    expect(order()).toEqual(["AAA", "BBB.X"]);
    await clickButton("Updated");
    expect(header("Updated")?.getAttribute("aria-sort")).toBe("ascending");
    expect(header("Actions")?.hasAttribute("aria-sort")).toBe(false);

    await clickButton("Remove BBB.X");
    expect(gateway.remove).not.toHaveBeenCalled();
    await clickButton("Keep BBB.X");
    expect(container.querySelector('tr[data-symbol="BBB.X"]')).not.toBeNull();
    await clickButton("Remove BBB.X");
    await clickButton("Confirm remove BBB.X");
    expect(gateway.remove).toHaveBeenCalledWith("id-BBB.X");
    expect(container.querySelector('tr[data-symbol="BBB.X"]')).toBeNull();
    return expect(container.textContent).toContain("Removed BBB.X");
  });

  it("reports add, save and remove problems and clears the draft of a removed row", async () => {
    const failure = (code: string, message = "nope") =>
      Object.assign(new Error(message), { code });
    let finishRemoval: () => void = () => undefined;
    const removal = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    const gateway: WatchlistGateway = {
      list: vi.fn(async () => [item("AAA"), item("BBB")]),
      add: vi
        .fn()
        .mockRejectedValueOnce(failure("FORBIDDEN"))
        .mockResolvedValueOnce({
          items: [item("AAA"), item("BBB"), item("CCC")],
          added: ["CCC"],
          existing: ["AAA"],
          rejected: [],
        }),
      update: vi.fn().mockRejectedValueOnce(failure("NOT_FOUND")),
      remove: vi
        .fn()
        .mockRejectedValueOnce(failure("UNAUTHORIZED"))
        .mockImplementationOnce(() => removal),
    };
    const container = await mount(gateway);
    const status = () =>
      container.querySelector('[role="status"]')?.textContent;

    await clickButton("Add symbols");
    expect(status()).toBe(
      "Nothing to add. Paste symbols separated by commas, spaces or newlines."
    );
    const tooMany = Array.from(
      { length: WATCHLIST_MAX_SYMBOLS_PER_ADD + 1 },
      (_, i) => `S${i}`
    );
    await setValue(
      byLabel<HTMLTextAreaElement>("Symbols to add"),
      tooMany.join(" ")
    );
    await clickButton("Add symbols");
    expect(status()).toBe(
      `${tooMany.length} tokens; limit is ${WATCHLIST_MAX_SYMBOLS_PER_ADD} per add.`
    );
    await setValue(byLabel<HTMLTextAreaElement>("Symbols to add"), "AAA CCC");
    await clickButton("Add symbols");
    expect(status()).toBe("Not permitted for this session.");
    await clickButton("Add symbols");
    expect(status()).toBe("Added 1 · already listed 1 · rejected 0");
    expect(byLabel<HTMLTextAreaElement>("Symbols to add").value).toBe("");

    const rowAlert = () =>
      container.querySelector('tr[data-symbol="AAA"] [role="alert"]')
        ?.textContent;
    await clickButton("Edit AAA");
    await setValue(byLabel<HTMLInputElement>("AAA buy zone low"), "abc");
    await clickButton("Save");
    expect(rowAlert()).toBe("Low must be a positive number.");
    await setValue(byLabel<HTMLInputElement>("AAA buy zone low"), "");
    await setValue(byLabel<HTMLInputElement>("AAA buy zone high"), "x");
    await clickButton("Save");
    expect(rowAlert()).toBe("High must be a positive number.");
    await setValue(byLabel<HTMLInputElement>("AAA buy zone high"), "");
    await clickButton("Save");
    expect(rowAlert()).toBe("Row no longer exists. Reload the list.");
    await clickButton("Cancel");
    expect(container.querySelector('[aria-label="AAA note"]')).toBeNull();

    await clickButton("Remove BBB");
    await clickButton("Confirm remove BBB");
    expect(status()).toBe("Session expired. Sign in again.");
    // Editing a row while its removal is in flight: the draft goes with the row.
    await clickButton("Remove AAA");
    await clickButton("Confirm remove AAA");
    await clickButton("Edit AAA");
    expect(byLabel<HTMLInputElement>("AAA note")).not.toBeNull();
    await act(async () => {
      finishRemoval();
      await flush();
    });
    expect(container.querySelector('tr[data-symbol="AAA"]')).toBeNull();
    expect(status()).toBe("Removed AAA");
  });

  it("reads the list through the browser API client by default", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () => {
        root.render(<WatchlistWorkspace />);
        await flush();
      });
      expect(fetchMock).toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Request failed. Retry."
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  return it("shows a retryable error state when the list fails", async () => {
    const gateway: WatchlistGateway = {
      list: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("down"), { code: "STORAGE_ERROR" })
        )
        .mockResolvedValueOnce([item("AAA")]),
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };
    const container = await mount(gateway);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Watchlist storage unavailable"
    );
    await clickButton("Retry");
    return expect(
      container.querySelector('tr[data-symbol="AAA"]')
    ).not.toBeNull();
  });
});
