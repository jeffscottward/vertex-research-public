import { SIGNAL_ALERT_NOTIFICATION } from "@darkfactory/api";
import { describe, expect, it, vi } from "vitest";

import {
  ALERT_POLL_MS,
  ALERT_POLL_OVERLAP_MS,
  ALERT_START_TOLERANCE_MS,
  createAlertNotifier,
  TEST_NOTIFICATION,
} from "./alert-notifier.ts";
import type { AlertFire, DesktopApi } from "./desktop-api.ts";
import type { DesktopNotification } from "./ports.ts";
import { fakeEvery } from "./test-fakes.ts";

const START = new Date("2026-11-06T15:00:00.000Z");
const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

const setup = (alertFires: DesktopApi["alertFires"], pollMs?: number) => {
  const shown: DesktopNotification[] = [];
  const timers = fakeEvery();
  const openWorkspace = vi.fn();
  const notifier = createAlertNotifier({
    api: {
      alertFires,
      dailyQuote: async () => null,
      watchlist: async () => [],
    },
    every: timers.every,
    notify: (notification) => shown.push(notification),
    now: () => START,
    openWorkspace,
    ...(pollMs === undefined ? {} : { pollMs }),
  });
  return { notifier, openWorkspace, shown, timers };
};

describe("createAlertNotifier", () => {
  it("notifies once per batch of new fires with the fixed text", async () => {
    let fires: AlertFire[] = [
      { firedAt: at(-2), id: "old" },
      { firedAt: at(1), id: "a" },
      { firedAt: at(2), id: "b" },
    ];
    const sinces: Date[] = [];
    const { notifier, openWorkspace, shown } = setup(async (since) => {
      sinces.push(since);
      return fires;
    });
    await notifier.poll();
    expect(sinces[0]).toEqual(
      new Date(START.getTime() - ALERT_POLL_OVERLAP_MS)
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe(SIGNAL_ALERT_NOTIFICATION.title);
    expect(shown[0]?.body).toBe(SIGNAL_ALERT_NOTIFICATION.body);
    shown[0]?.onClick?.();
    expect(openWorkspace).toHaveBeenCalledWith("price-alerts");

    // Same fires again (overlap window): nothing new.
    await notifier.poll();
    expect(shown).toHaveLength(1);
    expect(sinces[1]).toEqual(
      new Date(at(2).getTime() - ALERT_POLL_OVERLAP_MS)
    );

    // A late-committed fire stamped before the cursor still notifies.
    fires = [{ firedAt: at(1.5), id: "late" }];
    await notifier.poll();
    expect(shown).toHaveLength(2);
  });

  it("does not notify for fires from before the app started, past the skew tolerance", async () => {
    const tolerance = ALERT_START_TOLERANCE_MS / 60_000;
    const { notifier, shown } = setup(async () => [
      { firedAt: at(-tolerance - 0.1), id: "before" },
    ]);
    await notifier.poll();
    expect(shown).toHaveLength(0);
    const skewed = setup(async () => [
      { firedAt: at(-tolerance + 0.1), id: "skewed" },
    ]);
    await skewed.notifier.poll();
    expect(skewed.shown).toHaveLength(1);
  });

  it("forgets ids that can no longer come back, without re-notifying", async () => {
    let fires: AlertFire[] = [{ firedAt: at(1), id: "a" }];
    const { notifier, shown } = setup(async () => fires);
    await notifier.poll();
    expect(shown).toHaveLength(1);
    // Twenty minutes later: "a" is far behind the cursor and gets dropped from memory.
    fires = [{ firedAt: at(21), id: "b" }];
    await notifier.poll();
    expect(shown).toHaveLength(2);
    // The server never returns "a" again (it is older than cursor - overlap); "b" is still known.
    fires = [{ firedAt: at(21), id: "b" }];
    await notifier.poll();
    expect(shown).toHaveLength(2);
  });

  it("ignores failed polls and retries from the same cursor", async () => {
    const sinces: Date[] = [];
    const { notifier, shown } = setup(async (since) => {
      sinces.push(since);
      throw new Error("signed out");
    });
    await notifier.poll();
    await notifier.poll();
    expect(shown).toHaveLength(0);
    expect(sinces[0]).toEqual(sinces[1]);
  });

  it("polls on start and on its timer, sharing an in-flight poll", async () => {
    const alertFires = vi.fn(async () => []);
    const { notifier, timers } = setup(alertFires);
    notifier.start();
    notifier.start();
    expect(timers.scheduled()).toEqual([ALERT_POLL_MS]);
    await notifier.poll();
    timers.tick();
    await notifier.poll();
    // start, start and poll share the first call; the tick makes the second.
    expect(alertFires).toHaveBeenCalledTimes(2);
    notifier.stop();
    notifier.stop();
    expect(timers.scheduled()).toEqual([]);
  });

  it("uses the poll interval option", () => {
    const { notifier, timers } = setup(async () => [], 5000);
    notifier.start();
    expect(timers.scheduled()).toEqual([5000]);
  });

  it("sends a test notification that opens Alerts", () => {
    const { notifier, openWorkspace, shown } = setup(async () => []);
    notifier.sendTest();
    expect(shown[0]).toMatchObject(TEST_NOTIFICATION);
    shown[0]?.onClick?.();
    expect(openWorkspace).toHaveBeenCalledWith("price-alerts");
  });
});
