import type { ClickLogRecordInput } from "@darkfactory/api";
import type { ApiCallObservation } from "@darkfactory/api/client";
import { describe, expect, it, vi } from "vitest";

import type { ClickDescriptor } from "./describe.ts";
import {
  CLICK_LOG_FLUSH_MS,
  createClickRecorder,
  IMPORTANT_HOLD_MS,
  IMPORTANT_MATCH_MS,
} from "./recorder.ts";

const TAB = "0f0e8a52-1d6e-4c55-9d4b-3c1f2b8b5a11";

/** Manual clock and timer queue. */
const harness = (send = vi.fn(async (_input: ClickLogRecordInput) => ({}))) => {
  let time = Date.parse("2026-11-03T20:00:00.000Z");
  let timers: { at: number; callback: () => void; id: number }[] = [];
  let nextId = 0;
  const recorder = createClickRecorder({
    buildSha: "abc1234",
    now: () => time,
    schedule: (callback, ms) => {
      const id = nextId++;
      timers.push({ at: time + ms, callback, id });
      return () => {
        timers = timers.filter((timer) => timer.id !== id);
      };
    },
    send,
    tabId: TAB,
  });
  const advance = (ms: number) => {
    time += ms;
    const due = timers.filter((timer) => timer.at <= time);
    timers = timers.filter((timer) => timer.at > time);
    for (const timer of due) timer.callback();
  };
  return {
    advance,
    now: () => time,
    pendingTimers: () => timers.length,
    recorder,
    send,
  };
};

const descriptor = (
  overrides: Partial<ClickDescriptor> = {}
): ClickDescriptor => ({
  important: false,
  kind: "click",
  label: "Dashboard",
  role: "link",
  route: "/assistant",
  targetRoute: "/dashboard",
  testId: null,
  ...overrides,
});

const call = (
  overrides: Partial<ApiCallObservation> = {}
): ApiCallObservation => ({
  path: "assistant.send",
  phase: "open",
  requestId: "request-1",
  startedAt: 0,
  status: 200,
  ...overrides,
});

const sentEvents = (send: ReturnType<typeof harness>["send"]) =>
  send.mock.calls.flatMap(([input]) => input.events);

describe("click recorder", () => {
  it("batches ordinary clicks and sends them after the flush delay", () => {
    const h = harness();
    h.recorder.record(descriptor());
    h.recorder.record(descriptor({ label: "Backtests" }));
    expect(h.send).not.toHaveBeenCalled();
    h.advance(CLICK_LOG_FLUSH_MS);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({
      buildSha: "abc1234",
      tabId: TAB,
    });
    expect(sentEvents(h.send).map((event) => event.label)).toEqual([
      "Dashboard",
      "Backtests",
    ]);
    expect(sentEvents(h.send)[0]).toMatchObject({
      at: "2026-11-03T20:00:00.000Z",
      requestIds: [],
    });
  });

  it("sends at once when 20 events wait, in batches of at most 25", () => {
    const h = harness();
    for (let index = 0; index < 20; index += 1) h.recorder.record(descriptor());
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.pendingTimers()).toBe(0);
    h.recorder.dispose();
  });

  it("sends many held important events in batches of at most 25", () => {
    const h = harness();
    // Important events skip the size trigger until they are released together.
    for (let index = 0; index < 205; index += 1) {
      h.recorder.record(descriptor({ important: true, label: "Stop" }));
    }
    h.recorder.flush();
    const batches = h.send.mock.calls.map(([input]) => input.events.length);
    expect(batches.every((size) => size <= 25)).toBe(true);
    expect(batches.reduce((sum, size) => sum + size, 0)).toBe(205);
  });

  it("attaches calls running at the click and calls started just after it to important clicks", () => {
    const h = harness();
    const start = h.now();
    h.recorder.observe(
      call({ requestId: "send-1", startedAt: start - 10_000 })
    );
    h.recorder.observe(
      call({ path: "todos.list", requestId: "done-1", startedAt: start - 5000 })
    );
    h.recorder.observe(
      call({
        path: "todos.list",
        phase: "closed",
        requestId: "done-1",
        startedAt: start - 5000,
      })
    );

    h.recorder.record(descriptor({ important: true, label: "Stop" }));
    h.advance(100);
    h.recorder.observe(
      call({
        path: "assistant.threads.get",
        requestId: "reload-1",
        startedAt: h.now(),
      })
    );
    h.recorder.observe(
      call({ path: "clickLog.record", requestId: "own-1", startedAt: h.now() })
    );
    h.recorder.observe(call({ requestId: null, startedAt: h.now() }));
    h.recorder.observe(
      call({ requestId: "late-1", startedAt: start + IMPORTANT_MATCH_MS + 1 })
    );
    expect(h.send).not.toHaveBeenCalled();

    h.advance(IMPORTANT_HOLD_MS);
    h.advance(CLICK_LOG_FLUSH_MS);
    expect(sentEvents(h.send)).toEqual([
      expect.objectContaining({
        important: true,
        label: "Stop",
        requestIds: ["send-1", "reload-1"],
      }),
    ]);
  });

  it("caps request ids and forgets the oldest of too many open calls", () => {
    const h = harness();
    for (let index = 0; index < 60; index += 1) {
      h.recorder.observe(
        call({ requestId: `open-${index}`, startedAt: index })
      );
    }
    h.recorder.record(descriptor({ important: true, label: "Send" }));
    for (let index = 0; index < 3; index += 1) {
      h.recorder.observe(
        call({ requestId: `after-${index}`, startedAt: h.now() })
      );
    }
    h.recorder.flush();
    const [event] = sentEvents(h.send);
    expect(event?.requestIds).toEqual([
      "open-59",
      "open-58",
      "open-57",
      "open-56",
      "open-55",
      "open-54",
      "open-53",
      "open-52",
    ]);
  });

  it("sends held important events on flush and drops send failures", async () => {
    const send = vi.fn(async () => {
      throw new Error("offline");
    });
    const h = harness(send);
    h.recorder.record(descriptor({ important: true, label: "Confirm" }));
    h.recorder.record(descriptor());
    h.recorder.flush();
    expect(h.pendingTimers()).toBe(0);
    expect(sentEvents(h.send).map((event) => event.label)).toEqual([
      "Dashboard",
      "Confirm",
    ]);
    await Promise.resolve();
  });

  it("drops everything and cancels timers on dispose", () => {
    const h = harness();
    h.recorder.record(descriptor());
    h.recorder.record(descriptor({ important: true, label: "Stop" }));
    h.recorder.dispose();
    expect(h.pendingTimers()).toBe(0);
    h.recorder.flush();
    expect(h.send).not.toHaveBeenCalled();
  });
});
