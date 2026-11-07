// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import JournalError from "./error.tsx";
import JournalLoading from "./loading.tsx";
import JournalPage, { metadata } from "./page.tsx";

const mocks = vi.hoisted(() => ({
  resolveJournalSource: vi.fn(() => "ibkr-monitor" as const),
}));

vi.mock("../../../components/portal/trade-journal-source.ts", () => ({
  resolveJournalSource: mocks.resolveJournalSource,
}));
vi.mock("../../../components/portal/trade-journal.tsx", () => ({
  TradeJournal: ({ source }: { source: string | null }) => (
    <div data-journal-source={String(source)} data-workspace="journal" />
  ),
}));

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

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

describe("trade journal route files", () => {
  it("renders the header and the journal with the server-chosen source", async () => {
    const container = await render(<JournalPage />);
    expect(metadata).toEqual({ title: "Trade journal" });
    expect(container.querySelector("h1")?.textContent).toBe("Trade journal");
    expect(
      container
        .querySelector('[data-workspace="journal"]')
        ?.getAttribute("data-journal-source")
    ).toBe("ibkr-monitor");
    expect(mocks.resolveJournalSource).toHaveBeenCalledTimes(1);
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<JournalLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading trade journal"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<JournalError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Trade journal unavailable");
  });
});
