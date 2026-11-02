import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock("@darkfactory/auth/client", () => ({
  authClient: { useSession: { subscribe: authMocks.subscribe } },
}));

import {
  createResearchReadScope,
  observeResearchSessionScope,
} from "./read-scope.tsx";
import { createReadResource } from "./read-resource.ts";
import {
  browserSessionEndingEnvironment,
  createResearchSessionEndingCoordinator,
  RESEARCH_SESSION_ENDING_CHANNEL,
  RESEARCH_SESSION_ENDING_SIGNAL,
  RESEARCH_SESSION_ENDING_STORAGE_KEY,
  type ResearchSessionEndingEnvironment,
} from "./session-ending.ts";
import { createSignOutActionController } from "../account/sign-out-action.tsx";
import { SIGN_OUT_FAILED_MESSAGE } from "../account/sign-out-client.ts";

// Each environment is an independent document. Delivery is queued like browser
// events, not an invented shared authentication store or an online refresh.
const documents = () => {
  const queued: Array<() => void> = [];
  const channels = new Set<{
    receive: (value: unknown) => void;
    invalid: () => void;
  }>();
  const storageListeners = new Map<
    object,
    (key: string | null, value: string | null) => void
  >();
  const sent: unknown[] = [];
  const pulses: Array<readonly [string, string]> = [];
  const opened: string[] = [];
  const environment = (
    options: {
      broadcast?: boolean;
      storage?: boolean;
      postThrows?: boolean;
      pulseThrows?: boolean;
    } = {}
  ): ResearchSessionEndingEnvironment => {
    const document = {};
    return {
      openChannel: (name) => {
        if (options.broadcast === false)
          throw new Error("BroadcastChannel unavailable");
        opened.push(name);
        const endpoint = {
          receive: (_value: unknown): void => undefined,
          invalid: (): void => undefined,
        };
        channels.add(endpoint);
        return {
          post: (value) => {
            if (options.postThrows) throw new Error("post denied");
            sent.push(value);
            for (const receiver of channels) {
              if (receiver !== endpoint) {
                queued.push(() => {
                  if (channels.has(receiver)) receiver.receive(value);
                  return;
                });
              }
            }
          },
          listen: (receive, invalid) => {
            endpoint.receive = receive;
            endpoint.invalid = invalid;
            return () => {
              endpoint.receive = () => undefined;
              endpoint.invalid = () => undefined;
              return;
            };
          },
          close: () => {
            channels.delete(endpoint);
            return;
          },
        };
      },
      listenStorage: (receive) => {
        if (options.storage === false) throw new Error("storage denied");
        storageListeners.set(document, receive);
        return () => {
          storageListeners.delete(document);
          return;
        };
      },
      pulseStorage: (key, value) => {
        if (options.storage === false || options.pulseThrows)
          throw new Error("storage denied");
        pulses.push([key, value]);
        for (const [receiver, receive] of storageListeners) {
          if (receiver !== document) {
            queued.push(() => {
              if (storageListeners.get(receiver) === receive) {
                receive(key, value);
                return receive(key, null);
              }
              return;
            });
          }
        }
      },
    };
  };
  return {
    environment,
    sent,
    pulses,
    opened,
    flush: () => {
      const events = queued.splice(0);
      for (const deliver of events) deliver();
    },
    signal: (value: unknown) => {
      for (const endpoint of channels) endpoint.receive(value);
      return;
    },
    malformed: () => {
      for (const endpoint of channels) endpoint.invalid();
      return;
    },
    storage: (key: string | null, value: string | null) => {
      for (const receive of storageListeners.values()) receive(key, value);
      return;
    },
    active: () => ({
      channels: channels.size,
      storage: storageListeners.size,
      queued: queued.length,
    }),
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  return vi.clearAllMocks();
});

describe("same-origin research session-ending invalidation", () => {
  it.each([
    { broadcast: true, storage: true },
    { broadcast: false, storage: true },
    { broadcast: true, storage: false },
    { broadcast: true, storage: true, postThrows: true },
    { broadcast: true, storage: true, pulseThrows: true },
  ])(
    "retires two documents without auth subscription, focus, refetch or connectivity: %j",
    (options) => {
      vi.stubGlobal("navigator", { onLine: false });
      const network = documents();
      const first = createResearchSessionEndingCoordinator(
        network.environment(options)
      );
      const second = createResearchSessionEndingCoordinator(
        network.environment(options)
      );
      const firstScope = createResearchReadScope();
      const secondScope = createResearchReadScope();
      const stopFirst = first.subscribe(firstScope);
      const stopSecond = second.subscribe(secondScope);
      first.endSession(firstScope);
      expect(firstScope.getPhase()).toBe("retired");
      network.flush();
      expect(secondScope.getPhase()).toBe("retired");
      expect(authMocks.subscribe).not.toHaveBeenCalled();
      expect(
        network.sent.every((value) => value === RESEARCH_SESSION_ENDING_SIGNAL)
      ).toBe(true);
      expect(
        network.pulses.every(
          ([key, value]) =>
            key === RESEARCH_SESSION_ENDING_STORAGE_KEY &&
            value === RESEARCH_SESSION_ENDING_SIGNAL
        )
      ).toBe(true);
      expect(
        network.opened.every((name) => name === RESEARCH_SESSION_ENDING_CHANNEL)
      ).toBe(true);
      expect(network.active().queued).toBe(0);
      stopFirst();
      stopSecond();
      return expect(network.active()).toEqual({
        channels: 0,
        storage: 0,
        queued: 0,
      });
    }
  );

  it("always emits both transports for receivers with different browser capabilities", () => {
    const network = documents();
    const sender = createResearchSessionEndingCoordinator(
      network.environment()
    );
    const channelOnly = createResearchSessionEndingCoordinator(
      network.environment({ storage: false })
    );
    const storageOnly = createResearchSessionEndingCoordinator(
      network.environment({ broadcast: false })
    );
    const scopes = [
      createResearchReadScope(),
      createResearchReadScope(),
      createResearchReadScope(),
    ];
    const cleanup = [
      sender.subscribe(scopes[0]!),
      channelOnly.subscribe(scopes[1]!),
      storageOnly.subscribe(scopes[2]!),
    ];
    sender.endSession(scopes[0]!);
    network.flush();
    expect(scopes.every((scope) => scope.getPhase() === "retired")).toBe(true);
    expect(network.sent).toEqual([RESEARCH_SESSION_ENDING_SIGNAL]);
    expect(network.pulses).toEqual([
      [RESEARCH_SESSION_ENDING_STORAGE_KEY, RESEARCH_SESSION_ENDING_SIGNAL],
    ]);
    for (const stop of cleanup) stop();
  });

  it("clears cached values and cancels all three remote pending read kinds, never committing late responses", async () => {
    const network = documents();
    const sender = createResearchSessionEndingCoordinator(
      network.environment()
    );
    const receiver = createResearchSessionEndingCoordinator(
      network.environment()
    );
    const scope = createResearchReadScope();
    const cleanup = receiver.subscribe(scope);
    const cached = createReadResource(
      async () => "prior-private-artifact",
      12_000,
      scope
    );
    await cached.load(undefined);
    const signals: AbortSignal[] = [];
    const completions: Array<(value: string) => void> = [];
    const reads = ["module", "dataset", "evidence"].map(() =>
      createReadResource(
        (_input: undefined, signal) =>
          new Promise<string>((resolve) => {
            signals.push(signal);
            completions.push(resolve);
            return;
          }),
        12_000,
        scope
      )
    );
    const unsubscribes = reads.map((read) => read.subscribe(() => undefined));
    const pending = reads.map((read) => read.load(undefined));
    // Sender can initiate before its React effect has registered.
    sender.endSession(createResearchReadScope());
    network.flush();
    expect(scope.getPhase()).toBe("retired");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(JSON.stringify(cached.getSnapshot())).not.toContain(
      "prior-private-artifact"
    );
    for (const complete of completions) complete("late-private-artifact");
    await Promise.all(pending);
    for (const read of reads)
      expect(JSON.stringify(read.getSnapshot())).not.toContain(
        "late-private-artifact"
      );
    expect(network.sent).toEqual([RESEARCH_SESSION_ENDING_SIGNAL]);
    for (const unsubscribe of unsubscribes) unsubscribe();
    return cleanup();
  });

  it("retires a checking/refetching scope even when the existing atom emits nothing further", () => {
    const network = documents();
    const sender = createResearchSessionEndingCoordinator(
      network.environment()
    );
    const receiver = createResearchSessionEndingCoordinator(
      network.environment()
    );
    const scope = createResearchReadScope(false);
    let snapshot: (value: unknown) => void = () => undefined;
    const authUnsubscribe = vi.fn();
    const stopAuth = observeResearchSessionScope(
      scope,
      "expected",
      (listener) => {
        snapshot = listener;
        return authUnsubscribe;
      }
    );
    const cleanup = receiver.subscribe(scope);
    snapshot({ isRefetching: true, isPending: false });
    sender.endSession(createResearchReadScope());
    network.flush();
    expect(scope.getPhase()).toBe("retired");
    snapshot({ isRefetching: true, isPending: true });
    scope.confirm();
    expect(scope.getPhase()).toBe("retired");
    cleanup();
    stopAuth();
    return expect(authUnsubscribe).toHaveBeenCalledOnce();
  });

  it("ignores malformed/unrelated payloads and storage removals; duplicate signals cannot restore or rebroadcast", () => {
    const network = documents();
    const coordinator = createResearchSessionEndingCoordinator(
      network.environment()
    );
    const scope = createResearchReadScope();
    const cleanup = coordinator.subscribe(scope);
    const inaccessible = Object.defineProperty({}, "type", {
      get: () => {
        throw new Error("must not inspect");
      },
    });
    for (const value of [
      null,
      {},
      inaccessible,
      [],
      1,
      "session-ending-v2",
      "x".repeat(1024),
      { type: RESEARCH_SESSION_ENDING_SIGNAL },
    ])
      network.signal(value);
    network.storage("unrelated", RESEARCH_SESSION_ENDING_SIGNAL);
    network.storage(RESEARCH_SESSION_ENDING_STORAGE_KEY, null);
    network.storage(RESEARCH_SESSION_ENDING_STORAGE_KEY, "other");
    expect(scope.isCurrent()).toBe(true);
    network.signal(RESEARCH_SESSION_ENDING_SIGNAL);
    const revision = scope.getRevision();
    network.signal(RESEARCH_SESSION_ENDING_SIGNAL);
    network.storage(
      RESEARCH_SESSION_ENDING_STORAGE_KEY,
      RESEARCH_SESSION_ENDING_SIGNAL
    );
    scope.confirm();
    expect(scope.getRevision()).toBe(revision);
    expect(scope.getPhase()).toBe("retired");
    expect(network.sent).toEqual([]);
    expect(network.pulses).toEqual([]);
    return cleanup();
  });

  it("fails closed on channel decoding error without rebroadcast", () => {
    const network = documents();
    const coordinator = createResearchSessionEndingCoordinator(
      network.environment()
    );
    const scope = createResearchReadScope();
    const cleanup = coordinator.subscribe(scope);
    network.malformed();
    expect(scope.getPhase()).toBe("retired");
    expect(network.sent).toEqual([]);
    expect(network.pulses).toEqual([]);
    return cleanup();
  });

  it("preserves local immediate retirement if both browser transports are blocked and does not invent remote delivery", () => {
    const network = documents();
    const blocked = createResearchSessionEndingCoordinator(
      network.environment({ broadcast: false, storage: false })
    );
    const other = createResearchSessionEndingCoordinator(network.environment());
    const initiating = createResearchReadScope();
    const localSibling = createResearchReadScope();
    const remote = createResearchReadScope();
    const stops = [
      blocked.subscribe(initiating),
      blocked.subscribe(localSibling),
      other.subscribe(remote),
    ];
    expect(() => blocked.endSession(initiating)).not.toThrow();
    network.flush();
    expect(initiating.getPhase()).toBe("retired");
    expect(localSibling.getPhase()).toBe("retired");
    expect(remote.isCurrent()).toBe(true);
    expect(network.sent).toEqual([]);
    expect(network.pulses).toEqual([]);
    for (const stop of stops) stop();
  });

  it("isolates throwing local subscribers and transport setup/teardown failures", () => {
    const close = vi.fn(() => {
      throw new Error("close denied");
    });
    const environment: ResearchSessionEndingEnvironment = {
      openChannel: () => ({
        post: () => {
          throw new Error("post denied");
        },
        listen: () => {
          throw new Error("listen denied");
        },
        close,
      }),
      listenStorage: () => () => {
        throw new Error("remove denied");
      },
      pulseStorage: () => {
        throw new Error("pulse denied");
      },
    };
    const coordinator = createResearchSessionEndingCoordinator(environment);
    const broken = createResearchReadScope();
    const sibling = createResearchReadScope();
    broken.subscribe(() => {
      throw new Error("view listener");
    });
    const stopBroken = coordinator.subscribe(broken);
    const stopSibling = coordinator.subscribe(sibling);
    expect(() => coordinator.endSession(broken)).not.toThrow();
    expect(broken.getPhase()).toBe("retired");
    expect(sibling.getPhase()).toBe("retired");
    expect(() => {
      stopBroken();
      stopSibling();
      stopSibling();
      return;
    }).not.toThrow();
    return expect(close).toHaveBeenCalledTimes(2);
  });

  it("keeps transport listeners until the last local scope is removed, then reopens cleanly", () => {
    const network = documents();
    const coordinator = createResearchSessionEndingCoordinator(
      network.environment()
    );
    const old = createResearchReadScope();
    const remaining = createResearchReadScope();
    const stopOld = coordinator.subscribe(old);
    const stopRemaining = coordinator.subscribe(remaining);
    expect(network.active()).toEqual({ channels: 1, storage: 1, queued: 0 });
    stopOld();
    stopOld();
    network.signal(RESEARCH_SESSION_ENDING_SIGNAL);
    expect(old.isCurrent()).toBe(true);
    expect(remaining.getPhase()).toBe("retired");
    stopRemaining();
    expect(network.active()).toEqual({ channels: 0, storage: 0, queued: 0 });
    const fresh = createResearchReadScope();
    const stopFresh = coordinator.subscribe(fresh);
    expect(fresh.isCurrent()).toBe(true);
    network.signal(RESEARCH_SESSION_ENDING_SIGNAL);
    expect(fresh.getPhase()).toBe("retired");
    return stopFresh();
  });

  it("retires scopes captured at initiation even if another scope's listener unsubscribes them", () => {
    const network = documents();
    const coordinator = createResearchSessionEndingCoordinator(
      network.environment()
    );
    const first = createResearchReadScope();
    const second = createResearchReadScope();
    const stopFirst = coordinator.subscribe(first);
    const stopSecond = coordinator.subscribe(second);
    first.subscribe(stopSecond);
    coordinator.endSession(first);
    expect(first.getPhase()).toBe("retired");
    expect(second.getPhase()).toBe("retired");
    return stopFirst();
  });

  it("attempts channel closure and storage cleanup even when removing channel handlers throws", () => {
    const removeChannel = vi.fn(() => {
      throw new Error("listener removal");
    });
    const close = vi.fn();
    const removeStorage = vi.fn();
    const coordinator = createResearchSessionEndingCoordinator({
      openChannel: () => ({
        post: () => undefined,
        listen: () => removeChannel,
        close,
      }),
      listenStorage: () => removeStorage,
      pulseStorage: () => undefined,
    });
    const cleanup = coordinator.subscribe(createResearchReadScope());
    expect(() => cleanup()).not.toThrow();
    expect(removeChannel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    return expect(removeStorage).toHaveBeenCalledOnce();
  });

  return it("clears local and remote scopes at strict sign-out initiation, remains cleared after failure, and retains confirmed-only redirect/retry", async () => {
    const network = documents();
    const first = createResearchSessionEndingCoordinator(network.environment());
    const second = createResearchSessionEndingCoordinator(
      network.environment()
    );
    const local = createResearchReadScope();
    const remote = createResearchReadScope();
    const stops = [first.subscribe(local), second.subscribe(remote)];
    const replace = vi.fn();
    const state = vi.fn();
    let confirmed = false;
    const signOut = vi.fn(async () => {
      expect(local.getPhase()).toBe("retired");
      expect(network.sent.length).toBeGreaterThan(0);
      network.flush();
      expect(remote.getPhase()).toBe("retired");
      return confirmed
        ? { ok: true as const }
        : { ok: false as const, message: SIGN_OUT_FAILED_MESSAGE };
    });
    const controller = createSignOutActionController({ signOut }, replace, () =>
      first.endSession(local)
    );
    await controller.activate(state);
    expect(replace).not.toHaveBeenCalled();
    expect(state).toHaveBeenLastCalledWith({
      type: "error",
      message: SIGN_OUT_FAILED_MESSAGE,
    });
    local.confirm();
    remote.confirm();
    expect(local.getPhase()).toBe("retired");
    expect(remote.getPhase()).toBe("retired");
    confirmed = true;
    await controller.activate(state);
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("/sign-in");
    for (const stop of stops) stop();
  });
});

describe("browser invalidation adapter", () => {
  it("uses the bounded channel message, cleans up event handlers, and closes the channel", () => {
    const events = new EventTarget();
    const postMessage = vi.fn();
    const close = vi.fn();
    // BroadcastChannel is called with `new`, so the mock must be constructible.
    const channelConstructor = vi.fn(
      class {
        readonly postMessage = postMessage;
        readonly close = close;
        readonly addEventListener = events.addEventListener.bind(events);
        readonly removeEventListener = events.removeEventListener.bind(events);
      }
    );
    vi.stubGlobal("BroadcastChannel", channelConstructor);
    const channel = browserSessionEndingEnvironment.openChannel(
      RESEARCH_SESSION_ENDING_CHANNEL
    );
    const receive = vi.fn();
    const invalid = vi.fn();
    const cleanup = channel.listen(receive, invalid);
    events.dispatchEvent(
      new MessageEvent("message", { data: RESEARCH_SESSION_ENDING_SIGNAL })
    );
    events.dispatchEvent(new Event("messageerror"));
    channel.post(RESEARCH_SESSION_ENDING_SIGNAL);
    expect(channelConstructor).toHaveBeenCalledWith(
      RESEARCH_SESSION_ENDING_CHANNEL
    );
    expect(receive).toHaveBeenCalledWith(RESEARCH_SESSION_ENDING_SIGNAL);
    expect(invalid).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(RESEARCH_SESSION_ENDING_SIGNAL);
    cleanup();
    events.dispatchEvent(
      new MessageEvent("message", { data: RESEARCH_SESSION_ENDING_SIGNAL })
    );
    events.dispatchEvent(new Event("messageerror"));
    expect(receive).toHaveBeenCalledOnce();
    expect(invalid).toHaveBeenCalledOnce();
    channel.close();
    return expect(close).toHaveBeenCalledOnce();
  });

  return it("uses only matching localStorage events and removes the constant pulse without reading stored data", () => {
    const events = new EventTarget();
    const setItem = vi.fn();
    const removeItem = vi.fn();
    const getItem = vi.fn(() => {
      throw new Error("must not read storage");
    });
    const storage = { setItem, removeItem, getItem };
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    });
    const receive = vi.fn();
    const cleanup = browserSessionEndingEnvironment.listenStorage(receive);
    const event = (area: unknown) =>
      Object.assign(new Event("storage"), {
        storageArea: area,
        key: RESEARCH_SESSION_ENDING_STORAGE_KEY,
        newValue: RESEARCH_SESSION_ENDING_SIGNAL,
      });
    events.dispatchEvent(event({}));
    expect(receive).not.toHaveBeenCalled();
    events.dispatchEvent(event(storage));
    expect(receive).toHaveBeenCalledWith(
      RESEARCH_SESSION_ENDING_STORAGE_KEY,
      RESEARCH_SESSION_ENDING_SIGNAL
    );
    browserSessionEndingEnvironment.pulseStorage(
      RESEARCH_SESSION_ENDING_STORAGE_KEY,
      RESEARCH_SESSION_ENDING_SIGNAL
    );
    expect(setItem).toHaveBeenCalledWith(
      RESEARCH_SESSION_ENDING_STORAGE_KEY,
      RESEARCH_SESSION_ENDING_SIGNAL
    );
    expect(removeItem).toHaveBeenCalledWith(
      RESEARCH_SESSION_ENDING_STORAGE_KEY
    );
    expect(getItem).not.toHaveBeenCalled();
    cleanup();
    events.dispatchEvent(event(storage));
    expect(receive).toHaveBeenCalledOnce();
    setItem.mockImplementation(() => {
      throw new Error("write blocked");
    });
    expect(() =>
      browserSessionEndingEnvironment.pulseStorage(
        RESEARCH_SESSION_ENDING_STORAGE_KEY,
        RESEARCH_SESSION_ENDING_SIGNAL
      )
    ).toThrow("write blocked");
    return expect(removeItem).toHaveBeenCalledTimes(2);
  });
});
