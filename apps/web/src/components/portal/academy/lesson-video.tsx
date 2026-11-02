"use client";

// Lesson video with WebVTT captions rendered BELOW the video, colored with the same token as the
// element the video is drawing. Without a rendered MP4 the same timeline plays as a live SVG preview.
import {
  buildScene,
  defaultValues,
  elementColors,
  type Lesson,
  lessonTimeline,
  stateAt,
} from "@darkfactory/academy";
import { LessonChart } from "@darkfactory/academy/chart";
import { Pause, Play, RotateCcw } from "lucide-react";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AcademyMediaEntry } from "./academy-gallery.tsx";
import { useAcademyTheme } from "./academy-theme.tsx";

const ELEMENT_NAMES: Readonly<Record<string, string>> = {
  expiry: "expiry payoff",
  now: "current value curve",
  zones: "profit and loss zones",
  maxProfit: "max profit",
  maxLoss: "max loss",
  breakeven: "breakeven",
  spot: "spot price",
  strikes: "strikes",
  legs: "individual legs",
  surface: "3D surface",
  a: "first position",
  b: "second position",
  diff: "difference",
  pdf: "price distribution",
  band1: "1σ band",
  band2: "2σ band",
  pop: "payoff zones",
  ev: "expected value",
  rv: "realized volatility",
  iv: "implied volatility",
  vrp: "volatility premium",
  price: "price",
  bars: "GEX bars",
  flip: "gamma flip",
  callWall: "call wall",
  putWall: "put wall",
  paths: "equity paths",
  median: "median path",
  drawdown: "drawdown",
  curve: "recovery curve",
  marker: "marker",
  core: "core holdings",
  options: "options sleeve",
  cash: "total portfolio",
  events: "events",
  pnl: "position P&L",
  delta: "delta",
  gamma: "gamma",
  theta: "theta",
  vega: "vega",
  title: "title",
};

export const elementName = (element: string): string =>
  ELEMENT_NAMES[element] ?? element;

// Live SVG preview of the lesson timeline (only mounted when there is no MP4).
const PreviewChart = ({
  lesson,
  values,
  t,
  ...chart
}: {
  readonly lesson: Lesson;
  readonly values: Record<string, number | string>;
  readonly t: number;
  readonly colors: ComponentProps<typeof LessonChart>["colors"];
  readonly highlight: string | null;
  readonly palette: ComponentProps<typeof LessonChart>["palette"];
  readonly revealed: ComponentProps<typeof LessonChart>["revealed"];
}) => {
  const scene = useMemo(
    () => buildScene(lesson, values, t),
    [lesson, values, t]
  );
  return (
    <LessonChart
      {...chart}
      height={720}
      scene={scene}
      title={lesson.title}
      width={1280}
    />
  );
};

export const LessonVideo = ({
  lesson,
  media,
}: {
  readonly lesson: Lesson;
  readonly media: AcademyMediaEntry | null;
}) => {
  const { palette } = useAcademyTheme();
  const timeline = useMemo(() => lessonTimeline(lesson), [lesson]);
  const colors = useMemo(() => elementColors(lesson), [lesson]);
  const values = useMemo(() => defaultValues(lesson.params), [lesson]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [cueStep, setCueStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  // Bumped on every preview seek so a running clock restarts from the new time.
  const [seekEpoch, setSeekEpoch] = useState(0);
  const frame = useRef(0);

  // Native captions stay hidden (they would cover the chart); the active cue drives the caption panel.
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    const track = video.textTracks[0];
    if (track === undefined) return;
    track.mode = "hidden";
    const onCue = () => {
      const cue = track.activeCues?.[0];
      const match = cue === undefined ? null : /^step-(\d+)$/u.exec(cue.id);
      setCueStep(match === null ? null : Number(match[1]) - 1);
    };
    track.addEventListener("cuechange", onCue);
    return () => track.removeEventListener("cuechange", onCue);
  }, []);

  // Live preview clock when there is no MP4.
  const tick = useCallback(
    (start: number, offset: number) => {
      const now = (performance.now() - start) / 1000 + offset;
      if (now >= timeline.total) {
        setTime(timeline.total);
        setPlaying(false);
        return;
      }
      setTime(now);
      frame.current = requestAnimationFrame(() => tick(start, offset));
    },
    [timeline.total]
  );
  useEffect(() => {
    if (media !== null) return;
    if (!playing) return;
    const offset = time >= timeline.total ? 0 : time;
    frame.current = requestAnimationFrame(() =>
      tick(performance.now(), offset)
    );
    return () => cancelAnimationFrame(frame.current);
    // Restarts on play/pause and on a seek; time is read once as the resume offset.
  }, [playing, media, seekEpoch]);

  const state = stateAt(timeline, time);
  const activeIndex = media === null ? (state.active?.index ?? null) : cueStep;
  const active =
    activeIndex === null ? null : (timeline.steps[activeIndex] ?? null);
  const seekPreview = (seconds: number) => {
    setTime(seconds);
    setSeekEpoch((value) => value + 1);
  };
  const seek = (seconds: number) => {
    if (videoRef.current === null) seekPreview(seconds);
    else {
      videoRef.current.currentTime = seconds;
      void videoRef.current.play().catch(() => undefined);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-lesson-video>
      <div className="overflow-hidden rounded-lg border border-border bg-black">
        {media === null ? (
          <div className="relative">
            <PreviewChart
              colors={colors}
              highlight={active?.element ?? null}
              lesson={lesson}
              palette={palette}
              revealed={state.revealed}
              t={state.t}
              values={values}
            />
            <div className="flex items-center gap-2 border-border border-t bg-background p-2 text-sm">
              <button
                aria-label={playing ? "Pause preview" : "Play preview"}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border"
                onClick={() => setPlaying((value) => !value)}
                type="button"
              >
                {playing ? (
                  <Pause aria-hidden className="size-4" />
                ) : (
                  <Play aria-hidden className="size-4" />
                )}
              </button>
              <button
                aria-label="Restart preview"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border"
                onClick={() => seekPreview(0)}
                type="button"
              >
                <RotateCcw aria-hidden className="size-4" />
              </button>
              <span className="text-muted-foreground">
                Live preview {time.toFixed(1)} / {timeline.total.toFixed(1)} s.
                The MP4 for this lesson is not rendered yet.
              </span>
            </div>
          </div>
        ) : (
          <video
            className="aspect-video w-full"
            controls
            crossOrigin="anonymous"
            data-lesson-video-element
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            playsInline
            poster={media.thumbnail}
            preload="metadata"
            ref={videoRef}
            src={media.video}
          >
            <track
              default
              kind="captions"
              label="English (color-coded below the video)"
              src={media.captions}
              srcLang="en"
            />
          </video>
        )}
      </div>
      <div
        aria-live="polite"
        className="min-h-16 rounded-lg border border-border p-3 text-base sm:text-lg"
        data-caption-color={active?.color ?? "gray"}
        data-caption-element={active?.element ?? ""}
        data-lesson-caption
        style={{
          borderLeft: `6px solid ${active === null ? palette.tokens.gray : palette.tokens[active.color]}`,
        }}
      >
        {active === null ? (
          <span className="text-muted-foreground">
            Captions appear here, colored to match the element drawn on the
            chart.
          </span>
        ) : (
          <span>
            <span
              className="mr-2 font-semibold text-xs uppercase tracking-wide"
              style={{ color: palette.tokens[active.color] }}
            >
              ● {elementName(active.element)}
            </span>
            <span style={{ color: palette.tokens[active.color] }}>
              {active.caption}
            </span>
          </span>
        )}
      </div>
      <ol className="grid gap-1 text-sm" data-caption-list>
        {timeline.steps.map((step) => (
          <li key={step.index}>
            <button
              aria-current={activeIndex === step.index ? "step" : undefined}
              className={`flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted ${activeIndex === step.index ? "bg-muted" : ""}`}
              onClick={() => seek(step.start + 0.05)}
              type="button"
            >
              <span
                className="mt-1.5 size-2.5 shrink-0 rounded-full"
                style={{ background: palette.tokens[step.color] }}
              />
              <span className="w-12 shrink-0 text-muted-foreground tabular-nums">
                {step.start.toFixed(1)}s
              </span>
              <span>{step.caption}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
};
