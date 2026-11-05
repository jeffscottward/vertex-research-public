// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cacheKey,
  createResultCache,
  currentSearch,
  pickNumberParam,
  pickParam,
  readListParam,
  readParam,
  useDebouncedValue,
  withQuery,
  writeQuery,
} from "./backtest-lab-query.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

describe("query parsing", () => {
  it("reads trimmed non-empty values", () => {
    expect(readParam("?symbol=%20SPY%20", "symbol")).toBe("SPY");
    expect(readParam("?symbol=", "symbol")).toBeNull();
    expect(readParam("?symbol=%20%20", "symbol")).toBeNull();
    expect(readParam("", "symbol")).toBeNull();
  });

  it("picks allowed values and falls back otherwise", () => {
    const allowed = ["a", "b"] as const;
    expect(pickParam("b", allowed, "a")).toBe("b");
    expect(pickParam("z", allowed, "a")).toBe("a");
    expect(pickParam(null, allowed, "a")).toBe("a");
    expect(pickNumberParam("10", [5, 10] as const, 5)).toBe(10);
    expect(pickNumberParam("7", [5, 10] as const, 5)).toBe(5);
    expect(pickNumberParam("x", [5, 10] as const, 5)).toBe(5);
    expect(pickNumberParam(null, [5, 10] as const, 5)).toBe(5);
  });

  it("reads a unique, bounded list", () => {
    expect(readListParam("?runs=a,%20b,,a,c", "runs", 2)).toEqual(["a", "b"]);
    expect(readListParam("?other=1", "runs", 4)).toEqual([]);
  });
});

describe("query writing", () => {
  it("sets, removes and drops default values", () => {
    expect(
      withQuery(
        "?keep=1&drop=2",
        { drop: null, empty: "", gone: undefined, same: "x", set: 3 },
        { same: "x" }
      )
    ).toBe("?keep=1&set=3");
    expect(withQuery("?a=1", { a: null })).toBe("");
    expect(withQuery("", { a: "2" }, { a: null })).toBe("?a=2");
  });

  it("replaces the address bar only when the query changes", () => {
    window.history.replaceState(null, "", "/setup-replay#top");
    const spy = vi.spyOn(window.history, "replaceState");
    writeQuery({ symbol: "SPY" });
    expect(currentSearch()).toBe("?symbol=SPY");
    expect(window.location.hash).toBe("#top");
    writeQuery({ symbol: "SPY" });
    expect(spy).toHaveBeenCalledTimes(1);
    writeQuery({ symbol: "ES=F" }, { symbol: "ES=F" });
    expect(currentSearch()).toBe("");
    spy.mockRestore();
  });
});

describe("useDebouncedValue", () => {
  it("settles after the delay", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const Probe = ({ value }: { readonly value: string }) => {
      seen.push(useDebouncedValue(value, 200));
      return null;
    };
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe value="a" />));
    act(() => root.render(<Probe value="b" />));
    expect(seen.at(-1)).toBe("a");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(seen.at(-1)).toBe("b");
    act(() => root.unmount());
  });
});

describe("createResultCache", () => {
  it("keeps the most recently used entries", () => {
    const cache = createResultCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    cache.set("c", 4);
    expect(cache.get("c")).toBe(4);
    expect(cacheKey({ a: 1 })).toBe('{"a":1}');
  });
});

describe("server rendering", () => {
  it("reads and writes nothing without a window", () => {
    const saved = globalThis.window;
    vi.stubGlobal("window", undefined);
    try {
      expect(currentSearch()).toBe("");
      expect(() => writeQuery({ a: 1 })).not.toThrow();
    } finally {
      vi.stubGlobal("window", saved);
      vi.unstubAllGlobals();
    }
  });
});
