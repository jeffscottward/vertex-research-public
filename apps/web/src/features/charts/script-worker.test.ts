import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLOCKED_NAVIGATOR_FIELDS,
  BLOCKED_WORKER_GLOBALS,
  SCRIPT_WORKER_READY,
} from "./script-sandbox.ts";

const mocks = vi.hoisted(() => ({
  // What the engine could reach when it was loaded.
  atEngineLoad: null as null | Readonly<{ fetch: string; storage: string }>,
  runScript: vi.fn(() => ({ errors: [], ok: false as const })),
}));
vi.mock("@darkfactory/scripting", () => {
  const scope = globalThis as Record<string, unknown>;
  const navigator = scope["navigator"] as Record<string, unknown> | undefined;
  mocks.atEngineLoad = {
    fetch: typeof scope["fetch"],
    storage: typeof navigator?.["storage"],
  };
  return { runScript: mocks.runScript };
});

// The real lockdown runs on this test process's global: every property it may remove is
// recorded (on the global, its prototypes and its navigator) and put back afterwards.
type Saved = Readonly<{
  owner: object;
  name: string;
  descriptor: PropertyDescriptor;
}>;
const saved: Saved[] = [];
const record = (target: object | undefined, names: readonly string[]) => {
  for (
    let owner: object | null = target ?? null;
    owner !== null && owner !== Object.prototype;
    owner = Reflect.getPrototypeOf(owner)
  )
    for (const name of names) {
      const descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
      if (descriptor !== undefined) saved.push({ descriptor, name, owner });
    }
};

afterEach(() => {
  for (const { owner, name, descriptor } of saved.splice(0)) {
    Reflect.deleteProperty(owner, name);
    Reflect.defineProperty(owner, name, descriptor);
  }
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("script worker entry", () => {
  it("locks the real worker scope down before the engine loads, then answers each message", async () => {
    const scope = globalThis as Record<string, unknown>;
    record(globalThis, BLOCKED_WORKER_GLOBALS);
    record(scope["navigator"] as object | undefined, BLOCKED_NAVIGATOR_FIELDS);
    let listener: ((event: { data: unknown }) => void) | undefined;
    const postMessage = vi.fn();
    vi.stubGlobal(
      "addEventListener",
      (type: string, next: (event: { data: unknown }) => void) => {
        if (type === "message") listener = next;
      }
    );
    vi.stubGlobal("postMessage", postMessage);
    // Dynamic: these modules act on import, so they load only after the globals are recorded.
    await import("./script-worker.ts");
    const lockdown = await import("./script-worker-lockdown.ts");
    expect(lockdown.WORKER_GLOBALS_LEFT).toEqual([]);
    expect(typeof scope["fetch"]).toBe("undefined");
    expect("fetch" in globalThis).toBe(false);
    expect(mocks.atEngineLoad).toEqual({
      fetch: "undefined",
      storage: "undefined",
    });
    // Ready once the listener is installed, then one answer per request.
    expect(postMessage).toHaveBeenNthCalledWith(1, {
      type: SCRIPT_WORKER_READY,
    });
    listener?.({
      data: { bars: [], id: 4, inputs: {}, source: "plot(close)" },
    });
    expect(mocks.runScript).toHaveBeenCalledWith("plot(close)", [], {
      inputs: {},
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: 4,
      result: { errors: [], ok: false },
    });
    listener?.({ data: "not a request" });
    return expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
