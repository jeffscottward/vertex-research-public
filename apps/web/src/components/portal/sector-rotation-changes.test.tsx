// @vitest-environment jsdom
import type { SectorRotationSnapshot } from "@darkfactory/api";
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

const snapshotCall = vi.hoisted(() => vi.fn());
vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: () => ({ sectorRotation: { snapshot: snapshotCall } }),
}));

import {
  loadBrowserSectorRotationSnapshot,
  SectorRotationChanges,
} from "./sector-rotation-changes.tsx";

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
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = false;
});

const render = async (load?: () => Promise<SectorRotationSnapshot>) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(<SectorRotationChanges {...(load ? { load } : {})} />)
  );
  return host;
};

const sector = (
  symbol: string,
  quadrant: SectorRotationSnapshot["sectors"][number]["quadrant"]
) => ({
  date: "2026-10-30",
  momentum: 100.5,
  name: symbol,
  periods: 3,
  quadrant,
  ratio: 101,
  since: "2026-10-01",
  symbol,
});

const snapshot = (
  changes: SectorRotationSnapshot["changes"],
  previousDate: string | null = "2026-10-29"
): SectorRotationSnapshot => ({
  asOf: "2026-10-30",
  benchmark: "SPY",
  changes,
  previousDate,
  recentTransitions: changes,
  schemaVersion: 1,
  sectors: [sector("XLK", "leading"), sector("XLE", "lagging")],
  timeframe: "daily",
});

const fail = (code: string) => () =>
  Promise.reject(Object.assign(new Error(code), { code }));

describe("SectorRotationChanges", () => {
  it("lists changes with text labels, counts and link", async () => {
    const host = await render(() =>
      Promise.resolve(
        snapshot([
          {
            date: "2026-10-30",
            from: "improving",
            name: "Technology",
            symbol: "XLK",
            to: "leading",
          },
          {
            date: "2026-10-30",
            from: "weakening",
            name: null,
            symbol: "ABC",
            to: "lagging",
          },
        ])
      )
    );
    const text = host.textContent ?? "";
    expect(text).toContain("Sector rotation");
    expect(text).toContain("Quadrant changes since 2026-10-29");
    expect(text).toContain("XLK Technology:Improving→toLeading");
    expect(text).toContain("ABC:Weakening→toLagging");
    expect(text).toContain("Leading 1 · Weakening 0 · Lagging 1 · Improving 0");
    expect(host.querySelector('a[href="/sector-rotation"]')?.textContent).toBe(
      "Open sector rotation"
    );
  });

  it("shows the empty message", async () => {
    const host = await render(() => Promise.resolve(snapshot([])));
    expect(host.textContent).toContain("No quadrant changes since 2026-10-29.");
  });

  it("falls back when no previous date", async () => {
    const host = await render(() => Promise.resolve(snapshot([], null)));
    expect(host.textContent).toContain(
      "No quadrant changes since the previous session."
    );
  });

  it("shows not collected for NOT_FOUND", async () => {
    const host = await render(fail("NOT_FOUND"));
    expect(host.textContent).toContain(
      "Not yet collected. The nightly job fills it after the US close."
    );
  });

  it("renders nothing for FORBIDDEN", async () => {
    const host = await render(fail("FORBIDDEN"));
    expect(host.innerHTML).toBe("");
  });

  it("shows a loading state", async () => {
    const host = await render(() => new Promise(() => undefined));
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("retries after a generic error", async () => {
    const load = vi
      .fn<() => Promise<SectorRotationSnapshot>>()
      .mockRejectedValueOnce("boom")
      .mockResolvedValueOnce(snapshot([]));
    const host = await render(load);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load sector rotation."
    );
    const button = host.querySelector("button");
    await act(async () => button?.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("No quadrant changes");
  });

  it("uses the browser client by default", async () => {
    snapshotCall.mockResolvedValue(snapshot([]));
    const host = await render();
    expect(snapshotCall).toHaveBeenCalledWith({ timeframe: "daily" });
    expect(host.textContent).toContain("No quadrant changes");
    await expect(loadBrowserSectorRotationSnapshot()).resolves.toBeTruthy();
  });
});
