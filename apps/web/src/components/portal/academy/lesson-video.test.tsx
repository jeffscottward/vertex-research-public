// @vitest-environment jsdom
import { lessonTimeline } from "@darkfactory/academy";
import { lessonBySlug } from "@darkfactory/academy/lessons";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { elementName, LessonVideo } from "./lesson-video.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const lesson = (() => {
  const found = lessonBySlug("itm-covered-call-otm-put");
  if (found === null) throw new Error("fixture lesson missing");
  return found;
})();

const mount = async (
  media: Parameters<typeof LessonVideo>[0]["media"]
): Promise<HTMLDivElement> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<LessonVideo lesson={lesson} media={media} />)
  );
  return container;
};

/** Manual animation-frame clock: frames run only when flushed. */
const frames = () => {
  let now = 0;
  let queue: FrameRequestCallback[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queue.push(callback);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    queue = [];
  });
  return {
    advance: async (ms: number) => {
      now += ms;
      const pending = queue;
      queue = [];
      await act(async () => {
        for (const callback of pending) callback(now);
      });
    },
  };
};

const status = (container: HTMLElement) =>
  container.querySelector("[data-lesson-video] span.text-muted-foreground")
    ?.textContent ?? "";

const click = async (element: Element | null) => {
  await act(async () => (element as HTMLButtonElement).click());
};

describe("LessonVideo live preview (no MP4)", () => {
  it("plays, restarts from 0 while playing, seeks from captions and stops at the end", async () => {
    const clock = frames();
    const total = lessonTimeline(lesson).total;
    const container = await mount(null);
    expect(container.textContent).toContain("Captions appear here");
    await click(container.querySelector('[aria-label="Play preview"]'));
    await clock.advance(0);
    await clock.advance(4000);
    expect(status(container)).toContain("Live preview 4.0");
    await click(container.querySelector('[aria-label="Restart preview"]'));
    await clock.advance(0);
    await clock.advance(1000);
    expect(status(container)).toContain("Live preview 1.0");
    const steps = container.querySelectorAll("[data-caption-list] button");
    await click(steps[2] ?? null);
    await clock.advance(0);
    await clock.advance(500);
    const third = lessonTimeline(lesson).steps[2];
    expect(status(container)).toContain(
      `Live preview ${((third?.start ?? 0) + 0.55).toFixed(1)}`
    );
    expect(steps[2]?.getAttribute("aria-current")).toBe("step");
    expect(
      container.querySelector("[data-lesson-caption]")?.textContent
    ).toContain(third?.caption ?? "missing");
    await clock.advance(total * 1000);
    expect(status(container)).toContain(`Live preview ${total.toFixed(1)}`);
    expect(
      container.querySelector('[aria-label="Play preview"]')
    ).not.toBeNull();
    // Play at the end starts over from 0.
    await click(container.querySelector('[aria-label="Play preview"]'));
    await clock.advance(0);
    await clock.advance(2000);
    expect(status(container)).toContain("Live preview 2.0");
    await click(container.querySelector('[aria-label="Pause preview"]'));
  });

  it("names elements, falling back to the raw id", () => {
    expect(elementName("maxLoss")).toBe("max loss");
    expect(elementName("custom")).toBe("custom");
  });
});

describe("LessonVideo with a rendered MP4", () => {
  it("drives the caption panel from the active cue and seeks the video", async () => {
    const track = Object.assign(new EventTarget(), {
      mode: "showing",
      activeCues: [] as { id: string }[],
    });
    vi.spyOn(HTMLMediaElement.prototype, "textTracks", "get").mockReturnValue([
      track,
    ] as unknown as TextTrackList);
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(new Error("autoplay blocked"));
    const container = await mount({
      video: "/academy-media/x/lesson.mp4",
      captions: "/academy-media/x/captions.vtt",
      thumbnail: "/academy-media/x/thumb.jpg",
      durationSeconds: 30,
    });
    expect(track.mode).toBe("hidden");
    track.activeCues = [{ id: "step-2" }];
    await act(async () => track.dispatchEvent(new Event("cuechange")));
    expect(
      container
        .querySelector("[data-lesson-caption]")
        ?.getAttribute("data-caption-element")
    ).toBe(lessonTimeline(lesson).steps[1]?.element);
    track.activeCues = [{ id: "step-99" }];
    await act(async () => track.dispatchEvent(new Event("cuechange")));
    expect(
      container
        .querySelector("[data-lesson-caption]")
        ?.getAttribute("data-caption-element")
    ).toBe("");
    track.activeCues = [{ id: "intro" }];
    await act(async () => track.dispatchEvent(new Event("cuechange")));
    expect(container.textContent).toContain("Captions appear here");
    track.activeCues = [];
    await act(async () => track.dispatchEvent(new Event("cuechange")));
    const video = container.querySelector("video") as HTMLVideoElement;
    await act(async () => video.dispatchEvent(new Event("timeupdate")));
    await click(container.querySelector("[data-caption-list] button"));
    expect(play).toHaveBeenCalled();
    expect(video.currentTime).toBeGreaterThan(0);
  });

  it("tolerates a video without a text track", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "textTracks", "get").mockReturnValue(
      [] as unknown as TextTrackList
    );
    const container = await mount({
      video: "/v.mp4",
      captions: "/c.vtt",
      thumbnail: "/t.jpg",
      durationSeconds: 1,
    });
    expect(container.querySelector("video")).not.toBeNull();
  });
});
