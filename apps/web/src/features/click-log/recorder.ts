// What: the browser-side click-log queue (card vertex-click-log). It batches descriptors and sends
// them with clickLog.record. An important click is held for IMPORTANT_HOLD_MS and collects request
// ids so the event can be matched to server logs: the oRPC calls still open at the click (Stop ends
// a streamed assistant.send that started earlier) and the calls that started within
// IMPORTANT_MATCH_MS after it (Send, order buttons). Send failures are dropped: the log is diagnostics only and must never
// retry in a loop or affect the page.
// Used by: ./install.ts. See: docs/vertex-rebuild/click-log.md.
import {
  CLICK_LOG_BATCH_MAX,
  CLICK_LOG_REQUEST_IDS_MAX,
  ClickLogRequestIdSchema,
  type ClickLogEventInput,
  type ClickLogRecordInput,
} from "@darkfactory/api";
import type { ApiCallObservation } from "@darkfactory/api/client";

import type { ClickDescriptor } from "./describe.ts";

export const CLICK_LOG_FLUSH_MS = 5000;
export const IMPORTANT_HOLD_MS = 5000;
export const IMPORTANT_MATCH_MS = 3000;
const FLUSH_AT = 20;
// Bound for calls whose close was never observed (a body nobody read).
const OPEN_CALLS_MAX = 50;

type Cancel = () => void;

export type ClickRecorderDependencies = Readonly<{
  buildSha: string;
  now: () => number;
  /** Runs `callback` after `ms`; returns the function that cancels it. */
  schedule: (callback: () => void, ms: number) => Cancel;
  send: (input: ClickLogRecordInput) => Promise<unknown>;
  tabId: string;
}>;

export type ClickRecorder = Readonly<{
  record: (descriptor: ClickDescriptor) => void;
  observe: (observation: ApiCallObservation) => void;
  /** Sends everything now, held important events included (page hide). */
  flush: () => void;
  dispose: () => void;
}>;

interface Held {
  cancel: Cancel;
  clickAt: number;
  event: ClickLogEventInput;
}

export const createClickRecorder = (
  dependencies: ClickRecorderDependencies
): ClickRecorder => {
  const { buildSha, now, schedule, send, tabId } = dependencies;
  let queue: ClickLogEventInput[] = [];
  let held: Held[] = [];
  let cancelFlush: Cancel | null = null;
  // Open calls by request id, oldest first.
  const open = new Map<string, number>();

  const sendQueue = () => {
    cancelFlush?.();
    cancelFlush = null;
    while (queue.length > 0) {
      const events = queue.slice(0, CLICK_LOG_BATCH_MAX);
      queue = queue.slice(CLICK_LOG_BATCH_MAX);
      send({ buildSha, events, tabId }).catch(() => undefined);
    }
  };

  const enqueue = (event: ClickLogEventInput) => {
    queue.push(event);
    if (queue.length >= FLUSH_AT) {
      sendQueue();
      return;
    }
    cancelFlush ??= schedule(() => {
      cancelFlush = null;
      sendQueue();
    }, CLICK_LOG_FLUSH_MS);
  };

  const release = (entry: Held) => {
    held = held.filter((candidate) => candidate !== entry);
    enqueue(entry.event);
  };

  return {
    dispose: () => {
      cancelFlush?.();
      cancelFlush = null;
      for (const entry of held) entry.cancel();
      held = [];
      queue = [];
    },
    flush: () => {
      for (const entry of held) {
        entry.cancel();
        queue.push(entry.event);
      }
      held = [];
      sendQueue();
    },
    observe: ({ path, phase, requestId, startedAt }) => {
      if (path === "clickLog.record") return;
      const parsed = ClickLogRequestIdSchema.safeParse(requestId);
      if (!parsed.success) return;
      if (phase === "closed") {
        open.delete(parsed.data);
        return;
      }
      open.set(parsed.data, startedAt);
      if (open.size > OPEN_CALLS_MAX) {
        for (const oldest of open.keys()) {
          open.delete(oldest);
          break;
        }
      }
      for (const entry of held) {
        const ids = entry.event.requestIds;
        if (
          startedAt >= entry.clickAt &&
          startedAt <= entry.clickAt + IMPORTANT_MATCH_MS &&
          ids.length < CLICK_LOG_REQUEST_IDS_MAX
        ) {
          entry.event = { ...entry.event, requestIds: [...ids, parsed.data] };
        }
      }
    },
    record: (descriptor) => {
      const clickAt = now();
      const event: ClickLogEventInput = {
        ...descriptor,
        at: new Date(clickAt).toISOString(),
        requestIds: [],
      };
      if (!descriptor.important) {
        enqueue(event);
        return;
      }
      // Newest open calls first, so the call a Stop ends is kept when there are many.
      const running = [...open.keys()]
        .reverse()
        .slice(0, CLICK_LOG_REQUEST_IDS_MAX);
      const entry: Held = {
        cancel: schedule(() => release(entry), IMPORTANT_HOLD_MS),
        clickAt,
        event: { ...event, requestIds: running },
      };
      held.push(entry);
    },
  };
};
