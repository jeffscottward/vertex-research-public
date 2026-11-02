"use client";

import type { ResearchReadScope } from "./read-scope.tsx";

// This constant carries no session, principal, credential or artifact information.
// It can only retire presentation scopes; it never establishes authentication.
export const RESEARCH_SESSION_ENDING_CHANNEL =
  "vertex-research-session-ending-v1";
export const RESEARCH_SESSION_ENDING_SIGNAL = "session-ending-v1";
export const RESEARCH_SESSION_ENDING_STORAGE_KEY =
  "vertex:research:session-ending:v1";

export interface ResearchSessionEndingChannel {
  readonly post: (value: string) => void;
  readonly listen: (
    receive: (value: unknown) => void,
    invalid: () => void
  ) => () => void;
  readonly close: () => void;
}

export interface ResearchSessionEndingEnvironment {
  readonly openChannel: (name: string) => ResearchSessionEndingChannel;
  readonly listenStorage: (
    receive: (key: string | null, value: string | null) => void
  ) => () => void;
  readonly pulseStorage: (key: string, value: string) => void;
}

export const browserSessionEndingEnvironment: ResearchSessionEndingEnvironment =
  {
    openChannel: (name) => {
      const channel = new BroadcastChannel(name);
      return {
        post: (value) => channel.postMessage(value),
        listen: (receive, invalid) => {
          const message = (event: MessageEvent<unknown>) => receive(event.data);
          channel.addEventListener("message", message);
          channel.addEventListener("messageerror", invalid);
          return () => {
            channel.removeEventListener("message", message);
            return channel.removeEventListener("messageerror", invalid);
          };
        },
        close: () => channel.close(),
      };
    },
    listenStorage: (receive) => {
      const storage = window.localStorage;
      const listener = (event: StorageEvent) => {
        if (event.storageArea === storage)
          return receive(event.key, event.newValue);
        return;
      };
      window.addEventListener("storage", listener);
      return () => window.removeEventListener("storage", listener);
    },
    pulseStorage: (key, value) => {
      const storage = window.localStorage;
      // A transient invalidation pulse, not an auth/data cache. Removal also permits
      // another identical pulse after an unconfirmed sign-out retry.
      try {
        return storage.setItem(key, value);
      } finally {
        storage.removeItem(key);
      }
    },
  };

const attempt = (action: () => void): void => {
  try {
    action();
  } catch {
    // Privacy cleanup and strict revocation must not depend on browser messaging.
    return;
  }
};

export const createResearchSessionEndingCoordinator = (
  environment: ResearchSessionEndingEnvironment = browserSessionEndingEnvironment
) => {
  const retirements = new Set<() => void>();
  let channel: ResearchSessionEndingChannel | undefined;
  let removeChannelListeners: (() => void) | undefined;
  let removeStorageListener: (() => void) | undefined;

  const retireAll = () => {
    for (const retire of Array.from(retirements)) attempt(retire);
  };

  const start = () => {
    try {
      channel = environment.openChannel(RESEARCH_SESSION_ENDING_CHANNEL);
      const receive = (value: unknown) => {
        if (value === RESEARCH_SESSION_ENDING_SIGNAL) return retireAll();
        return;
      };
      removeChannelListeners = channel.listen(receive, retireAll);
    } catch {
      if (channel !== undefined) attempt(() => channel?.close());
      channel = undefined;
    }
    try {
      removeStorageListener = environment.listenStorage((key, value) => {
        if (
          key === RESEARCH_SESSION_ENDING_STORAGE_KEY &&
          value === RESEARCH_SESSION_ENDING_SIGNAL
        )
          retireAll();
      });
    } catch {
      removeStorageListener = undefined;
    }
  };

  const stop = () => {
    if (removeChannelListeners !== undefined) attempt(removeChannelListeners);
    if (channel !== undefined) attempt(() => channel?.close());
    if (removeStorageListener !== undefined) attempt(removeStorageListener);
    removeChannelListeners = undefined;
    removeStorageListener = undefined;
    channel = undefined;
  };

  const subscribe = (scope: ResearchReadScope): (() => void) => {
    const retire = () => scope.invalidate();
    retirements.add(retire);
    if (retirements.size === 1) start();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      retirements.delete(retire);
      if (retirements.size === 0) return stop();
      return;
    };
  };

  const endSession = (scope: ResearchReadScope): void => {
    // Always clear the initiating scope first, even before effect registration or
    // when BOTH browser transports are unavailable. Receivers never rebroadcast.
    const registered = Array.from(retirements);
    attempt(() => scope.invalidate());
    for (const retire of registered) attempt(retire);
    if (channel === undefined) {
      let sender: ResearchSessionEndingChannel | undefined;
      try {
        sender = environment.openChannel(RESEARCH_SESSION_ENDING_CHANNEL);
        sender.post(RESEARCH_SESSION_ENDING_SIGNAL);
      } catch {
        // The independent storage pulse below may still reach other documents.
        void 0;
      } finally {
        if (sender !== undefined) attempt(() => sender?.close());
      }
    } else {
      attempt(() => channel?.post(RESEARCH_SESSION_ENDING_SIGNAL));
    }
    // Send on both: another document may not support the same transport as this
    // one. No online/focus/refetch event, timer, identifier or acknowledgement needed.
    attempt(() =>
      environment.pulseStorage(
        RESEARCH_SESSION_ENDING_STORAGE_KEY,
        RESEARCH_SESSION_ENDING_SIGNAL
      )
    );
  };

  return { subscribe, endSession };
};

// Lazy browser work: constructing this document-local coordinator does no I/O.
const sessionEnding = createResearchSessionEndingCoordinator();
export const subscribeToResearchSessionEnding = sessionEnding.subscribe;
export const endResearchSession = sessionEnding.endSession;
