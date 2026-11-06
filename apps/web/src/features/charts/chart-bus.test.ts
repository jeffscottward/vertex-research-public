import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDrawingCommand,
  CHART_COMMAND_EVENT,
  type ChartCommand,
  clearPendingScript,
  currentChartContext,
  isQuantDrawing,
  PENDING_SCRIPT_KEY,
  publishChartContext,
  QUANT_DRAWING_PREFIX,
  QUANT_TEACH_PREFIX,
  readPendingScript,
  sendChartCommand,
  subscribeChartCommands,
} from "./chart-bus.ts";
import type { Drawing } from "./workstation.ts";

const memoryStore = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};
const failingStore = () => ({
  getItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
});

const level = (id: string, value = 10): Drawing => ({
  id,
  points: [{ timestamp: 1000, value }],
  text: "",
  tool: "level",
});

afterEach(() => {
  vi.unstubAllGlobals();
  publishChartContext(null);
});

describe("applyDrawingCommand", () => {
  it("adds Quant drawings with the prefix, keeping the user's", () => {
    const next = applyDrawingCommand([level("user")], {
      drawings: [level("a"), level(`${QUANT_DRAWING_PREFIX}b`)],
      replace: false,
      symbol: "SPY",
      type: "drawings",
    });
    expect(next.map((drawing) => drawing.id)).toEqual([
      "user",
      "quant-a",
      "quant-b",
    ]);
    expect(next.filter(isQuantDrawing)).toHaveLength(2);
    return expect(isQuantDrawing(level("user"))).toBe(false);
  });
  it("replaces Quant drawings of the same id and, with replace, all earlier ones", () => {
    const current = [level("user"), level("quant-a", 1), level("quant-old")];
    const merged = applyDrawingCommand(current, {
      drawings: [level("a", 2)],
      replace: false,
      symbol: "SPY",
      type: "drawings",
    });
    expect(merged.map((drawing) => drawing.id)).toEqual([
      "user",
      "quant-old",
      "quant-a",
    ]);
    expect(merged.at(-1)?.points[0]?.value).toBe(2);
    const replaced = applyDrawingCommand(current, {
      drawings: [level("new")],
      replace: true,
      symbol: "SPY",
      type: "drawings",
    });
    return expect(replaced.map((drawing) => drawing.id)).toEqual([
      "user",
      "quant-new",
    ]);
  });
  it("drops invalid drawings, including ids too long once prefixed", () => {
    const next = applyDrawingCommand([], {
      drawings: [
        level("x".repeat(160)),
        { ...level("bad"), points: [] },
        level("ok"),
      ],
      replace: false,
      symbol: "SPY",
      type: "drawings",
    });
    return expect(next.map((drawing) => drawing.id)).toEqual(["quant-ok"]);
  });
  it("never drops the operator's drawings for Quant's", () => {
    const operator = Array.from({ length: 200 }, (_, index) =>
      level(`user-${index}`)
    );
    // The operator alone fills the limit: Quant's drawings are refused.
    expect(
      applyDrawingCommand(operator, {
        drawings: [level("a")],
        replace: false,
        symbol: "SPY",
        type: "drawings",
      })
    ).toEqual(operator);
    // Over the limit, the oldest Quant drawings go first.
    const mixed = [
      level("quant-old"),
      ...operator.slice(0, 198),
      level("quant-mid"),
    ];
    const next = applyDrawingCommand(mixed, {
      drawings: [level("new")],
      replace: false,
      symbol: "SPY",
      type: "drawings",
    });
    expect(next).toHaveLength(200);
    expect(next.filter((drawing) => !isQuantDrawing(drawing))).toEqual(
      operator.slice(0, 198)
    );
    return expect(
      next.filter(isQuantDrawing).map((drawing) => drawing.id)
    ).toEqual(["quant-mid", "quant-new"]);
  });
  it("keeps teach drawings in their own group", () => {
    const current = [level("user"), level("quant-a"), level("quant-teach-1")];
    const teach = applyDrawingCommand(current, {
      drawings: [level("2"), level(`${QUANT_TEACH_PREFIX}3`)],
      group: "teach",
      replace: true,
      symbol: "SPY",
      type: "drawings",
    });
    // replace with group removes only earlier teach drawings.
    expect(teach.map((drawing) => drawing.id)).toEqual([
      "user",
      "quant-a",
      "quant-teach-2",
      "quant-teach-3",
    ]);
    expect(
      teach.every((drawing) => drawing.id === "user" || isQuantDrawing(drawing))
    ).toBe(true);
    const added = applyDrawingCommand(current, {
      drawings: [level("2")],
      group: "teach",
      replace: false,
      symbol: "SPY",
      type: "drawings",
    });
    expect(added.map((drawing) => drawing.id)).toEqual([
      "user",
      "quant-a",
      "quant-teach-1",
      "quant-teach-2",
    ]);
    // replace without group removes every Quant drawing, teach ones included.
    const plain = applyDrawingCommand(teach, {
      drawings: [level("b")],
      replace: true,
      symbol: "SPY",
      type: "drawings",
    });
    expect(plain.map((drawing) => drawing.id)).toEqual(["user", "quant-b"]);
    return expect(
      applyDrawingCommand(teach, { symbol: "SPY", type: "clear_quant" })
    ).toEqual([level("user")]);
  });
  it("ignores malformed drawings in an untyped command", () => {
    const command = {
      drawings: "none",
      replace: false,
      symbol: "SPY",
      type: "drawings",
    } as unknown as Parameters<typeof applyDrawingCommand>[1];
    expect(applyDrawingCommand([level("user")], command)).toEqual([
      level("user"),
    ]);
    const odd = {
      drawings: [null, 4, { id: 5 }, level("ok")],
      replace: false,
      symbol: "SPY",
      type: "drawings",
    } as unknown as Parameters<typeof applyDrawingCommand>[1];
    return expect(applyDrawingCommand([], odd)).toEqual([level("quant-ok")]);
  });
  it("clear_quant removes only Quant drawings", () => {
    return expect(
      applyDrawingCommand([level("user"), level("quant-a")], {
        symbol: "SPY",
        type: "clear_quant",
      })
    ).toEqual([level("user")]);
  });
});

describe("pending script", () => {
  it("reads a stored script and trims the title", () => {
    const store = memoryStore({
      [PENDING_SCRIPT_KEY]: JSON.stringify({
        source: "plot(close)",
        title: "t".repeat(100),
      }),
    });
    return expect(readPendingScript(store)).toEqual({
      source: "plot(close)",
      title: "t".repeat(80),
    });
  });
  it.each([
    ["nothing stored", null],
    ["broken JSON", "{"],
    ["a JSON null", "null"],
    ["a number", "4"],
    ["a missing title", JSON.stringify({ source: "plot(close)" })],
    ["a non-string source", JSON.stringify({ source: 1, title: "t" })],
    ["an empty source", JSON.stringify({ source: "", title: "t" })],
    [
      "an oversized source",
      JSON.stringify({ source: "x".repeat(16_001), title: "t" }),
    ],
  ])("returns null for %s", (_, raw) => {
    const store = memoryStore(
      raw === null ? {} : { [PENDING_SCRIPT_KEY]: raw }
    );
    return expect(readPendingScript(store)).toBeNull();
  });
  it("never throws when storage is missing or blocked", () => {
    expect(readPendingScript(null)).toBeNull();
    expect(readPendingScript(failingStore())).toBeNull();
    expect(() => clearPendingScript(failingStore())).not.toThrow();
    expect(() => clearPendingScript(null)).not.toThrow();
    const store = memoryStore({ [PENDING_SCRIPT_KEY]: "{}" });
    clearPendingScript(store);
    return expect(store.data.has(PENDING_SCRIPT_KEY)).toBe(false);
  });
  it("defaults to window.localStorage and survives a blocked one", () => {
    const store = memoryStore({
      [PENDING_SCRIPT_KEY]: JSON.stringify({
        source: "plot(close)",
        title: "t",
      }),
    });
    vi.stubGlobal("window", { localStorage: store });
    expect(readPendingScript()).toEqual({ source: "plot(close)", title: "t" });
    clearPendingScript();
    expect(store.data.size).toBe(0);
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      },
    });
    return expect(readPendingScript()).toBeNull();
  });
});

describe("sendChartCommand and subscribeChartCommands", () => {
  it("stores drawings for the symbol, then announces the command", () => {
    const store = memoryStore({
      "vx.charts.drawings.SPY": JSON.stringify([level("user")]),
    });
    const target = new EventTarget();
    const received: ChartCommand[] = [];
    const unsubscribe = subscribeChartCommands(
      (command) => received.push(command),
      target
    );
    const command: ChartCommand = {
      drawings: [level("a")],
      replace: true,
      symbol: "spy",
      type: "drawings",
    };
    expect(sendChartCommand(command, store, target)).toBe(true);
    expect(
      JSON.parse(store.data.get("vx.charts.drawings.SPY") ?? "[]").map(
        (drawing: Drawing) => drawing.id
      )
    ).toEqual(["user", "quant-a"]);
    expect(received).toEqual([command]);
    sendChartCommand({ symbol: "SPY", type: "clear_quant" }, store, target);
    expect(store.data.get("vx.charts.drawings.SPY")).toBe(
      JSON.stringify([level("user")])
    );
    unsubscribe();
    sendChartCommand({ symbol: "SPY", type: "clear_quant" }, store, target);
    return expect(received).toHaveLength(2);
  });
  it("stores a script as the pending script, bounded", () => {
    const store = memoryStore();
    expect(
      sendChartCommand(
        { source: "x".repeat(20_000), title: "y".repeat(100), type: "script" },
        store,
        null
      )
    ).toBe(true);
    const pending = JSON.parse(store.data.get(PENDING_SCRIPT_KEY) ?? "{}");
    expect(pending.source).toHaveLength(16_000);
    return expect(pending.title).toHaveLength(80);
  });
  it("still announces when storage is missing or refuses the write", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    subscribeChartCommands(listener, target);
    expect(
      sendChartCommand({ symbol: "SPY", type: "clear_quant" }, null, target)
    ).toBe(false);
    const refusing = memoryStore({
      "vx.charts.drawings.SPY": JSON.stringify([level("quant-a")]),
    });
    refusing.setItem = () => {
      throw new Error("quota");
    };
    expect(
      sendChartCommand(
        { source: "plot(close)", title: "t", type: "script" },
        refusing,
        target
      )
    ).toBe(false);
    expect(
      sendChartCommand({ symbol: "SPY", type: "clear_quant" }, refusing, target)
    ).toBe(false);
    expect(
      sendChartCommand(
        { symbol: "SPY", type: "clear_quant" },
        failingStore(),
        target
      )
    ).toBe(false);
    // Nothing was written: the stored drawings are unchanged and no script is pending.
    expect(refusing.data.get("vx.charts.drawings.SPY")).toBe(
      JSON.stringify([level("quant-a")])
    );
    expect(refusing.data.has(PENDING_SCRIPT_KEY)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
    return expect(listener.mock.calls.map(([command]) => command.type)).toEqual(
      ["clear_quant", "script", "clear_quant", "clear_quant"]
    );
  });
  it("ignores events without a command and works without a window", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    subscribeChartCommands(listener, target);
    target.dispatchEvent(
      new CustomEvent(CHART_COMMAND_EVENT, { detail: null })
    );
    target.dispatchEvent(new CustomEvent(CHART_COMMAND_EVENT, { detail: 4 }));
    target.dispatchEvent(new CustomEvent(CHART_COMMAND_EVENT, { detail: {} }));
    target.dispatchEvent(new Event(CHART_COMMAND_EVENT));
    expect(listener).not.toHaveBeenCalled();
    const unsubscribe = subscribeChartCommands(listener, null);
    expect(() => unsubscribe()).not.toThrow();
    return expect(
      sendChartCommand({ symbol: "SPY", type: "clear_quant" }, null, null)
    ).toBe(false);
  });
  it("has no event target or storage on the server", () => {
    expect(typeof window).toBe("undefined");
    const unsubscribe = subscribeChartCommands(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
    return expect(
      sendChartCommand({ symbol: "SPY", type: "clear_quant" })
    ).toBe(false);
  });
  it("defaults to the browser window when there is one", () => {
    const target = new EventTarget();
    const store = memoryStore();
    vi.stubGlobal(
      "window",
      Object.assign(target, { localStorage: store }) as unknown as Window
    );
    const listener = vi.fn();
    const unsubscribe = subscribeChartCommands(listener);
    expect(
      sendChartCommand({ source: "plot(close)", title: "t", type: "script" })
    ).toBe(true);
    unsubscribe();
    expect(store.data.has(PENDING_SCRIPT_KEY)).toBe(true);
    return expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("chart context", () => {
  it("publishes and clears what the chart shows", () => {
    expect(currentChartContext()).toBeNull();
    const context = {
      bars: 2,
      firstTimestamp: 1000,
      label: "SPY 1 day bars",
      lastClose: 12,
      lastTimestamp: 2000,
      symbol: "SPY",
    };
    publishChartContext(context);
    expect(currentChartContext()).toEqual(context);
    publishChartContext(null);
    return expect(currentChartContext()).toBeNull();
  });
});
