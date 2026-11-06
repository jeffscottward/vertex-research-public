import type { RunResult, ScriptBar } from "@darkfactory/scripting";
import { describe, expect, it, vi } from "vitest";
import {
  BLOCKED_WORKER_GLOBALS,
  handleScriptMessage,
  lockdownWorkerGlobals,
  scriptFailure,
} from "./script-sandbox.ts";

const bars: readonly ScriptBar[] = [1, 2, 3, 4].map((close, index) => ({
  close,
  high: close + 1,
  low: close - 1,
  open: close,
  timestamp: (index + 1) * 1000,
  volume: 10,
}));
const ok: RunResult = {
  inputs: [],
  kind: "indicator",
  ok: true,
  overlay: true,
  plots: [],
  shortTitle: "t",
  signals: [],
  title: "t",
  warnings: [],
};

describe("lockdownWorkerGlobals", () => {
  it("removes the APIs from the scope, its prototype chain and its navigator", () => {
    // Shaped like a worker: WorkerGlobalScope.prototype <- DedicatedWorkerGlobalScope.prototype <- self.
    const workerGlobalScope = {
      fetch: () => "network",
      importScripts: () => undefined,
      indexedDB: {},
    };
    const dedicated = Object.assign(Object.create(workerGlobalScope), {
      postMessage: () => undefined,
      WebSocketStream: class {},
    });
    const navigatorProto = { locks: {}, storage: {}, userAgent: "test" };
    const scope = Object.assign(Object.create(dedicated), {
      BroadcastChannel: class {},
      caches: {},
      EventSource: class {},
      keep: 1,
      navigator: Object.create(navigatorProto),
      WebSocket: class {},
      XMLHttpRequest: class {},
    }) as Record<string, unknown>;
    expect(lockdownWorkerGlobals(scope)).toEqual([]);
    for (const name of BLOCKED_WORKER_GLOBALS) {
      expect(scope[name]).toBeUndefined();
      expect(name in scope).toBe(false);
    }
    // Not reachable through a prototype either.
    expect("fetch" in workerGlobalScope).toBe(false);
    expect(
      Reflect.get(Object.getPrototypeOf(dedicated), "fetch")
    ).toBeUndefined();
    expect("WebSocketStream" in dedicated).toBe(false);
    const navigator = scope["navigator"] as Record<string, unknown>;
    expect(navigator["storage"]).toBeUndefined();
    expect(navigator["locks"]).toBeUndefined();
    expect("storage" in navigatorProto).toBe(false);
    expect(navigator["userAgent"]).toBe("test");
    expect(scope["keep"]).toBe(1);
    return expect(typeof scope["postMessage"]).toBe("function");
  });
  it("shadows what cannot be deleted, overwrites what is writable, reports the rest", () => {
    const base = {};
    Object.defineProperty(base, "fetch", {
      configurable: false,
      value: () => "network",
      writable: false,
    });
    const scope = Object.create(base) as Record<string, unknown>;
    Object.defineProperty(scope, "XMLHttpRequest", {
      configurable: false,
      value: class {},
      writable: true,
    });
    Object.defineProperty(scope, "WebSocket", {
      configurable: false,
      value: class {},
      writable: false,
    });
    const lockedNavigator = {};
    Object.defineProperty(lockedNavigator, "storage", {
      configurable: false,
      value: {},
      writable: false,
    });
    scope["navigator"] = lockedNavigator;
    expect(lockdownWorkerGlobals(scope)).toEqual([
      "WebSocket",
      "navigator.storage",
    ]);
    // The inherited non-configurable fetch is shadowed read-only on the scope.
    expect(scope["fetch"]).toBeUndefined();
    expect(() => {
      scope["fetch"] = () => "again";
    }).toThrow();
    expect(scope["XMLHttpRequest"]).toBeUndefined();
    return expect(lockdownWorkerGlobals({ navigator: null })).toEqual([]);
  });
});

describe("handleScriptMessage", () => {
  it("runs a valid request with its inputs", () => {
    const run = vi.fn(() => ok);
    const response = handleScriptMessage(
      {
        bars,
        id: 7,
        inputs: { length: 3, on: true, src: "close" },
        source: "s",
      },
      run
    );
    expect(run).toHaveBeenCalledWith("s", bars, {
      inputs: { length: 3, on: true, src: "close" },
    });
    return expect(response).toEqual({ id: 7, result: ok });
  });
  it.each([null, "text", {}, { id: "1" }, { id: 1.5 }])(
    "cannot answer %j",
    (data) => expect(handleScriptMessage(data, vi.fn())).toBeNull()
  );
  it.each([
    [{ bars, id: 1, inputs: {}, source: 4 }, "Script is missing or too long."],
    [
      { bars, id: 1, inputs: {}, source: "x".repeat(16_001) },
      "Script is missing or too long.",
    ],
    [{ bars: "no", id: 1, inputs: {}, source: "s" }, "Chart bars"],
    [{ bars: [null], id: 1, inputs: {}, source: "s" }, "Chart bars"],
    [
      {
        bars: [{ ...bars[0], close: Number.NaN }],
        id: 1,
        inputs: {},
        source: "s",
      },
      "Chart bars",
    ],
    [
      {
        bars: [{ ...bars[0], timestamp: 1.5 }],
        id: 1,
        inputs: {},
        source: "s",
      },
      "Chart bars",
    ],
    [
      {
        bars: Array.from({ length: 5001 }, () => bars[0]),
        id: 1,
        inputs: {},
        source: "s",
      },
      "Chart bars",
    ],
    [{ bars, id: 1, inputs: [], source: "s" }, "inputs"],
    [{ bars, id: 1, inputs: null, source: "s" }, "inputs"],
    [{ bars, id: 1, inputs: { a: {} }, source: "s" }, "inputs"],
    [
      { bars, id: 1, inputs: { a: Number.POSITIVE_INFINITY }, source: "s" },
      "inputs",
    ],
    [{ bars, id: 1, inputs: { a: "x".repeat(201) }, source: "s" }, "inputs"],
    [{ bars, id: 1, inputs: { ["k".repeat(65)]: 1 }, source: "s" }, "inputs"],
    [
      {
        bars,
        id: 1,
        inputs: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`i${index}`, index])
        ),
        source: "s",
      },
      "inputs",
    ],
  ])("answers an invalid request with an error: %#", (data, message) => {
    const run = vi.fn();
    const response = handleScriptMessage(data, run);
    expect(run).not.toHaveBeenCalled();
    expect(response?.id).toBe(1);
    expect(response?.result.ok).toBe(false);
    return expect(
      response?.result.ok === false && response.result.errors[0]?.message
    ).toContain(message);
  });
  it("turns an engine exception into an error result", () => {
    const thrown = handleScriptMessage(
      { bars, id: 2, inputs: {}, source: "s" },
      () => {
        throw new Error("stack overflow");
      }
    );
    expect(thrown).toEqual({
      id: 2,
      result: scriptFailure("Script engine failed: stack overflow"),
    });
    const odd = handleScriptMessage(
      { bars, id: 3, inputs: {}, source: "s" },
      () => {
        throw "odd";
      }
    );
    return expect(odd?.result).toEqual(
      scriptFailure("Script engine failed: unknown error")
    );
  });
});
