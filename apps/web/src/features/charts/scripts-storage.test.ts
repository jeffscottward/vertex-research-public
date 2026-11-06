import { describe, expect, it } from "vitest";
import {
  ACTIVE_SCRIPTS_MAX,
  activeScriptsKey,
  loadActiveScripts,
  loadSavedScripts,
  newScriptId,
  parseActiveScripts,
  parseSavedScripts,
  removeSavedScript,
  SAVED_SCRIPTS_MAX,
  type SavedScript,
  SCRIPTS_STORAGE_KEY,
  storeActiveScripts,
  storeSavedScripts,
  upsertSavedScript,
} from "./scripts-storage.ts";

const script = (id: string, updatedAt = 1): SavedScript => ({
  id,
  source: `plot(close) // ${id}`,
  title: `Script ${id}`,
  updatedAt,
});
const memoryStore = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};
const failingStore = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

describe("saved scripts", () => {
  it("parses valid scripts newest first and drops invalid or duplicate ones", () => {
    const raw = JSON.stringify([
      script("a", 1),
      script("b", 3),
      script("a", 2),
      { ...script("c"), id: "" },
      { ...script("d"), id: "x".repeat(81) },
      { ...script("e"), title: "t".repeat(81) },
      { ...script("f"), source: "s".repeat(16_001) },
      { ...script("g"), updatedAt: -1 },
      { ...script("h"), updatedAt: 1.5 },
      { ...script("i"), source: 4 },
      null,
      "text",
    ]);
    return expect(parseSavedScripts(raw)).toEqual([
      script("b", 3),
      script("a", 1),
    ]);
  });
  it.each([null, "", "{", "{}", "null"])("parses %j as no scripts", (raw) =>
    expect(parseSavedScripts(raw)).toEqual([])
  );
  it("keeps at most 50", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      script(`s${index}`, index)
    );
    const parsed = parseSavedScripts(JSON.stringify(many));
    expect(parsed).toHaveLength(SAVED_SCRIPTS_MAX);
    return expect(parsed[0]?.id).toBe("s59");
  });
  it("upserts to the front, bounded and trimmed, and removes by id", () => {
    const list = [script("a"), script("b")];
    const updated = upsertSavedScript(list, {
      ...script("b", 9),
      source: "s".repeat(20_000),
      title: "t".repeat(100),
    });
    expect(updated.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(updated[0]?.source).toHaveLength(16_000);
    expect(updated[0]?.title).toHaveLength(80);
    const full = Array.from({ length: 50 }, (_, index) => script(`s${index}`));
    expect(upsertSavedScript(full, script("new"))).toHaveLength(50);
    expect(upsertSavedScript(full, script("new")).at(-1)?.id).toBe("s48");
    return expect(removeSavedScript(list, "a")).toEqual([script("b")]);
  });
  it("loads and stores through storage without throwing", () => {
    const store = memoryStore();
    expect(storeSavedScripts(store, [script("a")])).toBe(true);
    expect(store.data.get(SCRIPTS_STORAGE_KEY)).toBe(
      JSON.stringify([script("a")])
    );
    expect(loadSavedScripts(store)).toEqual([script("a")]);
    expect(loadSavedScripts(null)).toEqual([]);
    expect(loadSavedScripts(failingStore)).toEqual([]);
    expect(storeSavedScripts(null, [])).toBe(false);
    return expect(storeSavedScripts(failingStore, [])).toBe(false);
  });
});

describe("active scripts per symbol", () => {
  it("uses one key per normalized symbol", () =>
    expect(activeScriptsKey(" spy ")).toBe("vx.charts.scripts.active.v1.SPY"));
  it("parses refs with inputs and drops invalid entries", () => {
    const raw = JSON.stringify([
      { inputs: { length: 3, on: true, src: "close" }, ref: "saved:a" },
      { inputs: {}, ref: "template:sma" },
      { inputs: {}, ref: "other:x" },
      { inputs: {}, ref: "saved:" },
      { inputs: [], ref: "saved:b" },
      { inputs: { a: {} }, ref: "saved:c" },
      { inputs: { a: Number.NaN }, ref: "saved:d" },
      { inputs: { ["k".repeat(65)]: 1 }, ref: "saved:e" },
      {
        inputs: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`i${index}`, 1])
        ),
        ref: "saved:f",
      },
      { inputs: { a: "x".repeat(201) }, ref: "saved:g" },
      { inputs: null, ref: "saved:h" },
      { ref: 4 },
      null,
    ]);
    return expect(parseActiveScripts(raw)).toEqual([
      { inputs: { length: 3, on: true, src: "close" }, ref: "saved:a" },
      { inputs: {}, ref: "template:sma" },
    ]);
  });
  it("keeps at most eight and never throws", () => {
    const store = memoryStore();
    const many = Array.from({ length: 10 }, (_, index) => ({
      inputs: {},
      ref: `saved:s${index}`,
    }));
    expect(storeActiveScripts(store, "spy", many)).toBe(true);
    expect(loadActiveScripts(store, "SPY")).toHaveLength(ACTIVE_SCRIPTS_MAX);
    expect(parseActiveScripts(JSON.stringify(many))).toHaveLength(8);
    expect(parseActiveScripts("{")).toEqual([]);
    expect(parseActiveScripts(null)).toEqual([]);
    expect(loadActiveScripts(failingStore, "SPY")).toEqual([]);
    return expect(storeActiveScripts(failingStore, "SPY", [])).toBe(false);
  });
});

describe("newScriptId", () => {
  it("is short, time-ordered and bounded", () => {
    expect(newScriptId(36, () => 0)).toBe("s100000");
    expect(newScriptId(-5, () => 0.999_999_9)).toBe("s0zzzz");
    return expect(newScriptId(Date.now()).length).toBeLessThanOrEqual(16);
  });
});
