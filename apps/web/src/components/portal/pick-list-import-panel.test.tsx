// @vitest-environment jsdom
import type { PickListOutput } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PickListImportPanel } from "./pick-list-import-panel.tsx";
import type { PickListGateway } from "./pick-lists-client.ts";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const settle = async () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};
const setValue = async (element: Element | null, value: string) => {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element?.dispatchEvent(new Event("input", { bubbles: true }));
    element?.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const button = (container: Element, text: string) =>
  [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text)
  ) as HTMLButtonElement;
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};

const savedList = (count: number): PickListOutput => ({
  bucketSymbol: null,
  id: "list-9",
  latest: {
    asOf: "2026-11-05",
    id: "snap-9",
    importedAt: "2026-11-05T12:00:00.000Z",
    members: Array.from({ length: count }, (_, index) => ({
      addedOn: null,
      rank: index + 1,
      rating: null,
      sector: null,
      symbol: `S${index}`,
      targetPrice: null,
      thesis: null,
      weight: null,
    })),
    method: "manual",
  },
  name: "Tech Titans",
  slug: "tech-titans",
  snapshotCount: 1,
  source: "propicks",
  sourceLabel: "ProPicks",
});

const gatewayWith = (importFn: PickListGateway["import"]): PickListGateway => ({
  import: importFn,
  list: async () => [],
  screen: async () => {
    throw new Error("unused");
  },
  syncBucket: async () => {
    throw new Error("unused");
  },
});

describe("PickListImportPanel", () => {
  it("previews a paste, shows rejects and saves a manual snapshot", async () => {
    const importFn = vi.fn<PickListGateway["import"]>(async () => savedList(2));
    const onImported = vi.fn();
    const container = await render(
      <PickListImportPanel
        gateway={gatewayWith(importFn)}
        onImported={onImported}
        today="2026-11-05"
      />
    );
    const save = button(container, "Save list");
    expect(button(container, "Preview").disabled).toBe(true);
    expect(save.disabled).toBe(true);

    await setValue(container.querySelector("select"), "propicks");
    await setValue(
      container.querySelector('input[maxlength="80"]'),
      "Tech Titans"
    );
    await setValue(container.querySelector('input[type="date"]'), "2026-11-04");
    await setValue(container.querySelector("textarea"), "MSFT nvda 9X MSFT");
    await click(button(container, "Preview"));

    expect(container.textContent).toContain("2 tickers ready: MSFT, NVDA");
    const rejects = container.querySelector('[aria-label="Rejected rows"]');
    expect(rejects?.textContent).toContain('Line 1 "9X": Not a ticker: 9X');
    expect(rejects?.textContent).toContain('Line 1 "MSFT": Duplicate');

    await click(button(container, "Save list"));
    expect(importFn).toHaveBeenCalledWith({
      asOf: "2026-11-04",
      list: { name: "Tech Titans", slug: "tech-titans" },
      members: [
        { rank: 1, symbol: "MSFT" },
        { rank: 2, symbol: "NVDA" },
      ],
      method: "manual",
      source: "propicks",
      sourceLabel: "ProPicks",
    });
    expect(onImported).toHaveBeenCalledWith(savedList(2));
    expect(container.textContent).toContain(
      "Saved Tech Titans with 2 members."
    );

    await setValue(container.querySelector("textarea"), "AAPL");
    expect(container.textContent).not.toContain("tickers ready");
    expect(container.textContent).not.toContain("Saved Tech Titans");
  });

  it("reads an uploaded CSV file into the text box", async () => {
    const container = await render(
      <PickListImportPanel
        gateway={gatewayWith(async () => savedList(1))}
        onImported={() => undefined}
      />
    );
    const input = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    const file = new File(["Symbol\nAMD\n"], "list.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(container.querySelector("textarea")?.value).toBe("Symbol\nAMD\n");
    Object.defineProperty(input, "files", { configurable: true, value: [] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("textarea")?.value).toBe("Symbol\nAMD\n");
    expect(
      (container.querySelector('input[type="date"]') as HTMLInputElement).value
    ).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("shows a save failure and does not save without a valid name", async () => {
    const importFn = vi.fn<PickListGateway["import"]>(async () => {
      throw Object.assign(new Error("x"), { code: "FORBIDDEN" });
    });
    const container = await render(
      <PickListImportPanel
        gateway={gatewayWith(importFn)}
        onImported={() => undefined}
        today="2026-11-05"
      />
    );
    await setValue(container.querySelector('input[maxlength="80"]'), "!!!");
    await setValue(container.querySelector("select"), "unknown");
    await setValue(container.querySelector("textarea"), "AAPL");
    await click(button(container, "Preview"));
    expect(button(container, "Save list").disabled).toBe(true);
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => form.requestSubmit());
    expect(importFn).not.toHaveBeenCalled();

    await setValue(container.querySelector('input[maxlength="80"]'), "Wish");
    await click(button(container, "Save list"));
    expect(importFn.mock.calls[0]?.[0].source).toBe("moby");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Operator access required."
    );
  });
});
