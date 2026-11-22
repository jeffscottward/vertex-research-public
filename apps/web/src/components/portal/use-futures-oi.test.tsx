// @vitest-environment jsdom
import type { OpenbbMacroOutput } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { FuturesOiMarket } from "../../features/charts/futures-oi.ts";
import type { OpenbbGateway } from "../../features/openbb/gateway.ts";
import { type FuturesOiState, useFuturesOi } from "./use-futures-oi.ts";

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

type Input = Readonly<{
  market: FuturesOiMarket | null;
  enabled: boolean;
  from: string | null;
}>;
type Macro = Pick<OpenbbGateway, "macro">;

const series = (id: string): OpenbbMacroOutput["series"][number] => ({
  firstDate: "2025-11-20",
  frequency: "daily",
  id,
  lastDate: "2026-11-19",
  name: `${id} (made-up)`,
  pointCount: 1,
  points: [{ date: "2026-11-19", value: 2_127_055 }],
  source: "CME",
  unit: "contracts",
  updatedAt: new Date("2026-11-20T10:02:00Z"),
});
const reply = (...ids: string[]): OpenbbMacroOutput => ({
  from: "2026-01-01",
  series: ids.map(series),
});

// Renders the hook and records the state of every render (`all`) and of the newest one.
const harness = async (gateway: Macro, first: Input) => {
  const seen: { all: FuturesOiState[]; state: FuturesOiState | null } = {
    all: [],
    state: null,
  };
  const Probe = (input: Input) => {
    seen.state = useFuturesOi({ ...input, gateway });
    seen.all.push(seen.state);
    return null;
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (input: Input) =>
    await act(async () => root.render(<Probe {...input} />));
  await render(first);
  return { render, seen };
};

const ES: Input = { enabled: true, from: "2026-01-01", market: "ES" };

describe("useFuturesOi", () => {
  it("is off and reads nothing without a market, a from-date or when not enabled", async () => {
    const gateway = { macro: vi.fn(async () => reply("CME_ES_OI")) };
    const { render, seen } = await harness(gateway, { ...ES, market: null });
    expect(seen.state).toEqual({ type: "off" });
    await render({ ...ES, enabled: false });
    expect(seen.state).toEqual({ type: "off" });
    await render({ ...ES, from: null });
    expect(seen.state).toEqual({ type: "off" });
    expect(gateway.macro).not.toHaveBeenCalled();
  });

  it("is loading, then ready with the series of the market", async () => {
    let resolve: (output: OpenbbMacroOutput) => void = () => undefined;
    const gateway = {
      macro: vi.fn(
        () =>
          new Promise<OpenbbMacroOutput>((done) => {
            resolve = done;
          })
      ),
    };
    const { seen } = await harness(gateway, ES);
    expect(seen.state).toEqual({ type: "loading" });
    expect(gateway.macro).toHaveBeenCalledWith("2026-01-01", ["CME_ES_OI"]);
    // Another series in the reply is not taken for the requested one.
    await act(async () => resolve(reply("CME_NQ_OI", "CME_ES_OI")));
    expect(seen.state).toEqual({ series: series("CME_ES_OI"), type: "ready" });
  });

  it("is ready with null when the reply has no series", async () => {
    const gateway = { macro: vi.fn(async () => reply()) };
    const { seen } = await harness(gateway, { ...ES, market: "NQ" });
    expect(gateway.macro).toHaveBeenCalledWith("2026-01-01", ["CME_NQ_OI"]);
    expect(seen.state).toEqual({ series: null, type: "ready" });
  });

  it("reports an error when the gateway rejects", async () => {
    const gateway = {
      macro: vi.fn(() => Promise.reject(new Error("read failed"))),
    };
    const { seen } = await harness(gateway, ES);
    expect(seen.state).toEqual({ type: "error" });
  });

  it("reads again after a failed read when enabled goes off and on", async () => {
    const macro = vi
      .fn<Macro["macro"]>()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockImplementation(async () => reply("CME_ES_OI"));
    const { render, seen } = await harness({ macro }, ES);
    expect(seen.state).toEqual({ type: "error" });
    await render({ ...ES, enabled: false });
    expect(seen.state).toEqual({ type: "off" });
    await render(ES);
    expect(macro).toHaveBeenCalledTimes(2);
    expect(seen.state).toEqual({ series: series("CME_ES_OI"), type: "ready" });
    // The loaded series is kept from here on.
    await render({ ...ES, enabled: false });
    await render(ES);
    expect(macro).toHaveBeenCalledTimes(2);
  });

  it("does not show the failed result while it reads again", async () => {
    let resolve: (output: OpenbbMacroOutput) => void = () => undefined;
    const macro = vi
      .fn<Macro["macro"]>()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockImplementation(
        () =>
          new Promise<OpenbbMacroOutput>((done) => {
            resolve = done;
          })
      );
    const { render, seen } = await harness({ macro }, ES);
    expect(seen.state).toEqual({ type: "error" });
    // The input changes and comes back: the failed read of the first input is repeated.
    await render({ ...ES, market: "NQ" });
    await render(ES);
    expect(macro).toHaveBeenCalledTimes(3);
    expect(seen.state).toEqual({ type: "loading" });
    await act(async () => resolve(reply("CME_ES_OI")));
    expect(seen.state).toEqual({ series: series("CME_ES_OI"), type: "ready" });
  });

  it("reads again after a reply without a series when enabled goes off and on", async () => {
    const macro = vi
      .fn<Macro["macro"]>()
      .mockResolvedValueOnce(reply())
      .mockImplementation(async () => reply("CME_ES_OI"));
    const { render, seen } = await harness({ macro }, ES);
    expect(seen.state).toEqual({ series: null, type: "ready" });
    await render({ ...ES, enabled: false });
    await render(ES);
    expect(macro).toHaveBeenCalledTimes(2);
    expect(seen.state).toEqual({ series: series("CME_ES_OI"), type: "ready" });
  });

  it("never renders the old failed or empty result after enabled comes back", async () => {
    for (const first of ["error", "empty"] as const) {
      const macro = vi.fn<Macro["macro"]>(async () => reply("CME_ES_OI"));
      if (first === "error")
        macro.mockRejectedValueOnce(new Error("read failed"));
      else macro.mockResolvedValueOnce(reply());
      const { render, seen } = await harness({ macro }, ES);
      const old: FuturesOiState =
        first === "error" ? { type: "error" } : { series: null, type: "ready" };
      expect(seen.state).toEqual(old);
      await render({ ...ES, enabled: false });
      const from = seen.all.length;
      await render(ES);
      const after = seen.all.slice(from);
      expect(after[0]).toEqual({ type: "loading" });
      expect(after.at(-1)).toEqual({
        series: series("CME_ES_OI"),
        type: "ready",
      });
      expect(after).not.toContainEqual(old);
    }
  });

  it("reads again when the input changes and comes back after a failed read", async () => {
    const macro = vi.fn<Macro["macro"]>(async () => reply("CME_ES_OI"));
    macro.mockRejectedValueOnce(new Error("read failed"));
    const { render, seen } = await harness({ macro }, ES);
    expect(seen.state).toEqual({ type: "error" });
    await render({ ...ES, from: "2020-01-01" });
    expect(macro).toHaveBeenCalledTimes(2);
    const from = seen.all.length;
    await render(ES);
    expect(macro).toHaveBeenCalledTimes(3);
    const after = seen.all.slice(from);
    expect(after[0]).toEqual({ type: "loading" });
    expect(after).not.toContainEqual({ type: "error" });
    expect(after.at(-1)).toEqual({
      series: series("CME_ES_OI"),
      type: "ready",
    });
  });

  it("drops a read that fails while the hook is off and reads again", async () => {
    let reject: (error: Error) => void = () => undefined;
    const macro = vi
      .fn<Macro["macro"]>(async () => reply("CME_ES_OI"))
      .mockImplementationOnce(
        () =>
          new Promise<OpenbbMacroOutput>((_done, fail) => {
            reject = fail;
          })
      );
    const { render, seen } = await harness({ macro }, ES);
    expect(seen.state).toEqual({ type: "loading" });
    await render({ ...ES, enabled: false });
    await act(async () => reject(new Error("read failed")));
    expect(seen.state).toEqual({ type: "off" });
    const from = seen.all.length;
    await render(ES);
    expect(macro).toHaveBeenCalledTimes(2);
    expect(seen.all.slice(from)).not.toContainEqual({ type: "error" });
    expect(seen.state).toEqual({ series: series("CME_ES_OI"), type: "ready" });
  });

  it("keeps a series that arrives while the hook is off", async () => {
    let resolve: (output: OpenbbMacroOutput) => void = () => undefined;
    const macro = vi.fn<Macro["macro"]>(
      () =>
        new Promise<OpenbbMacroOutput>((done) => {
          resolve = done;
        })
    );
    const { render, seen } = await harness({ macro }, ES);
    await render({ ...ES, enabled: false });
    await act(async () => resolve(reply("CME_ES_OI")));
    await render(ES);
    expect(seen.state).toEqual({ series: series("CME_ES_OI"), type: "ready" });
    expect(macro).toHaveBeenCalledTimes(1);
  });

  it("ignores the result of an older request after the market changes", async () => {
    const pending = new Map<string, (output: OpenbbMacroOutput) => void>();
    const gateway: Macro = {
      macro: vi.fn(
        (_from, ids) =>
          new Promise<OpenbbMacroOutput>((done) => {
            pending.set(ids?.[0] ?? "", done);
          })
      ),
    };
    const { render, seen } = await harness(gateway, ES);
    await render({ ...ES, market: "NQ" });
    expect(seen.state).toEqual({ type: "loading" });
    await act(async () => pending.get("CME_ES_OI")?.(reply("CME_ES_OI")));
    expect(seen.state).toEqual({ type: "loading" });
    await act(async () => pending.get("CME_NQ_OI")?.(reply("CME_NQ_OI")));
    expect(seen.state).toEqual({ series: series("CME_NQ_OI"), type: "ready" });
    // Another from-date is another request.
    await render({ ...ES, from: "2026-02-01" });
    expect(seen.state).toEqual({ type: "loading" });
    expect(gateway.macro).toHaveBeenCalledTimes(3);
  });

  it("reuses the loaded series when enabled goes off and on", async () => {
    const gateway = { macro: vi.fn(async () => reply("CME_ES_OI")) };
    const { render, seen } = await harness(gateway, ES);
    expect(seen.state?.type).toBe("ready");
    await render({ ...ES, enabled: false });
    expect(seen.state).toEqual({ type: "off" });
    await render(ES);
    expect(seen.state).toEqual({ series: series("CME_ES_OI"), type: "ready" });
    expect(gateway.macro).toHaveBeenCalledTimes(1);
  });
});
