// @vitest-environment jsdom
import type { ApiClient, PortfolioMonitorOutput } from "@darkfactory/api";
import { act, type ReactElement } from "react";
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
  createBrowserJournalLoader,
  journalSnapshotFor,
  type LoadState,
  useLoadOnce,
} from "./trade-journal-client.ts";

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

const snapshot = { executions: [] } as unknown as PortfolioMonitorOutput;

const fakeClient = () => {
  const ibkr = vi.fn(async () => snapshot);
  const portfolio = vi.fn(async () => snapshot);
  const client = {
    ibkrMonitor: { snapshot: ibkr },
    portfolioMonitor: { snapshot: portfolio },
  } as unknown as ApiClient;
  return { client, ibkr, portfolio };
};

describe("journal loaders", () => {
  it("reads ibkrMonitor.snapshot or portfolioMonitor.snapshot by source", async () => {
    const { client, ibkr, portfolio } = fakeClient();
    await expect(journalSnapshotFor(client, "ibkr-monitor")()).resolves.toBe(
      snapshot
    );
    expect(ibkr).toHaveBeenCalledWith({});
    expect(portfolio).not.toHaveBeenCalled();
    await journalSnapshotFor(client, "portfolio-monitor")();
    expect(portfolio).toHaveBeenCalledWith({});
  });

  it("creates one browser client on the first call", async () => {
    const { client, portfolio } = fakeClient();
    runtime.client = client;
    const load = createBrowserJournalLoader("portfolio-monitor");
    expect(runtime.origins).toEqual([]);
    await load();
    await load();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(portfolio).toHaveBeenCalledTimes(2);
  });
});

describe("useLoadOnce", () => {
  const Probe = ({
    load,
    reloadKey,
    seen,
  }: Readonly<{
    load: (() => Promise<string>) | null;
    reloadKey?: number;
    seen: LoadState<string>[];
  }>) => {
    seen.push(useLoadOnce(load, reloadKey));
    return null;
  };

  const mount = async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    return (element: ReactElement) => act(async () => root.render(element));
  };

  it("stays idle without a loader", async () => {
    const seen: LoadState<string>[] = [];
    const render = await mount();
    await render(<Probe load={null} seen={seen} />);
    expect(seen.at(-1)).toEqual({ type: "idle" });
  });

  it("loads, reloads on a new key and reports failures", async () => {
    const seen: LoadState<string>[] = [];
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockRejectedValueOnce(new Error("down"));
    const render = await mount();
    await render(<Probe load={load} reloadKey={0} seen={seen} />);
    expect(seen[0]).toEqual({ type: "loading" });
    expect(seen.at(-1)).toEqual({ type: "ready", value: "first" });
    await render(<Probe load={load} reloadKey={1} seen={seen} />);
    expect(seen.at(-1)).toMatchObject({ type: "error" });
    expect(load).toHaveBeenCalledTimes(2);
    await render(<Probe load={null} reloadKey={1} seen={seen} />);
    expect(seen.at(-1)).toEqual({ type: "idle" });
  });

  it("ignores answers that arrive after the loader changed", async () => {
    const seen: LoadState<string>[] = [];
    let resolveSlow: (value: string) => void = () => undefined;
    let rejectSlow: (error: unknown) => void = () => undefined;
    const slow = () =>
      new Promise<string>((resolve) => {
        resolveSlow = resolve;
      });
    const slowFailure = () =>
      new Promise<string>((_resolve, reject) => {
        rejectSlow = reject;
      });
    const render = await mount();
    await render(<Probe load={slow} seen={seen} />);
    await render(<Probe load={slowFailure} seen={seen} />);
    await render(<Probe load={null} seen={seen} />);
    await act(async () => {
      resolveSlow("late");
      rejectSlow(new Error("late"));
    });
    expect(seen.at(-1)).toEqual({ type: "idle" });
  });
});
