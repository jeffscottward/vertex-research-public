// One composition renders any lesson: the shared LessonChart drawn frame by frame from the same
// timeline that writes the WebVTT captions, so the page captions match the drawing.
import {
  buildScene,
  defaultValues,
  elementColors,
  lessonTimeline,
  stateAt,
} from "@darkfactory/academy";
import { DARK_PALETTE, LessonChart } from "@darkfactory/academy/chart";
import { lessonBySlug } from "@darkfactory/academy/lessons";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export type LessonVideoProps = Readonly<{ slug: string }>;

const WIDTH = 1280;
const HEIGHT = 720;
const palette = DARK_PALETTE;

const ELEMENT_LABEL: Readonly<Record<string, string>> = {
  expiry: "Expiry payoff",
  now: "Value today",
  zones: "Profit / loss zones",
  maxProfit: "Max profit",
  maxLoss: "Max loss",
  breakeven: "Breakeven",
  spot: "Spot price",
  strikes: "Strikes",
  legs: "Legs",
  surface: "3D surface",
  diff: "Difference",
  pdf: "Distribution",
  band1: "1σ band",
  band2: "2σ band",
  pop: "Payoff zones",
  ev: "Expected value",
  rv: "Realized vol",
  iv: "Implied vol",
  vrp: "Vol premium",
};

export const LessonVideoComposition = ({ slug }: LessonVideoProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lesson = lessonBySlug(slug);
  if (lesson === null)
    return (
      <AbsoluteFill
        style={{ background: palette.background, color: palette.text }}
      >
        Unknown lesson {slug}
      </AbsoluteFill>
    );
  const timeline = lessonTimeline(lesson);
  const seconds = frame / fps;
  const state = stateAt(timeline, seconds);
  const colors = elementColors(lesson);
  const values = defaultValues(lesson.params);
  const progress = seconds / timeline.total;
  // 3D surfaces turn slowly so depth is readable; 2D scenes ignore the azimuth.
  const azimuth = 0.25 + 0.7 * progress;
  const scene = buildScene(lesson, values, state.t, azimuth);
  const introOpacity = interpolate(
    seconds,
    [0, timeline.intro - 0.6, timeline.intro],
    [1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const outroStart = timeline.total - timeline.outro;
  const outroOpacity = interpolate(
    seconds,
    [outroStart, outroStart + 0.6],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    }
  );
  const active = state.active;
  const activeColor =
    active === null ? palette.tokens.gray : palette.tokens[active.color];
  return (
    <AbsoluteFill
      style={{
        background: palette.background,
        fontFamily: "'Public Sans', 'Manrope', system-ui, sans-serif",
      }}
    >
      <LessonChart
        azimuth={azimuth}
        colors={colors}
        fixed
        height={HEIGHT}
        highlight={active?.element ?? null}
        idPrefix="video"
        palette={palette}
        revealed={state.revealed}
        scene={scene}
        title={lesson.title}
        width={WIDTH}
      />
      {active === null ? null : (
        <div
          style={{
            position: "absolute",
            right: 24,
            top: 18,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "6px 14px",
            borderRadius: 999,
            background: "rgba(14,16,20,0.85)",
            border: `2px solid ${activeColor}`,
            color: activeColor,
            fontSize: 20,
            fontWeight: 600,
          }}
        >
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 6,
              background: activeColor,
            }}
          />
          {`Step ${active.index + 1}/${timeline.steps.length} · ${ELEMENT_LABEL[active.element] ?? active.element}`}
        </div>
      )}
      <AbsoluteFill
        style={{
          opacity: introOpacity,
          background: palette.background,
          justifyContent: "center",
          padding: 96,
          color: palette.text,
        }}
      >
        <div
          style={{
            color: palette.tokens.gold,
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: 1,
          }}
        >
          DEFINE YOUR RISK ACADEMY ·{" "}
          {lesson.kind === "strategy" ? "STRATEGY" : "CONCEPT"}
        </div>
        <div
          style={{
            fontSize: 58,
            fontWeight: 700,
            lineHeight: 1.1,
            marginTop: 18,
            fontFamily: "'Manrope', system-ui, sans-serif",
          }}
        >
          {lesson.title}
        </div>
        <div style={{ fontSize: 24, color: palette.muted, marginTop: 24 }}>
          {[
            ...lesson.tags.regime,
            ...lesson.tags.instruments,
            lesson.tags.timeframe,
          ].join(" · ")}
        </div>
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          opacity: outroOpacity,
          background: "rgba(14,16,20,0.94)",
          justifyContent: "center",
          padding: 96,
          color: palette.text,
        }}
      >
        <div
          style={{ color: palette.tokens.gold, fontSize: 28, fontWeight: 700 }}
        >
          Takeaways
        </div>
        {lesson.takeaways.map((item) => (
          <div
            key={item}
            style={{ fontSize: 30, marginTop: 20, lineHeight: 1.3 }}
          >
            • {item}
          </div>
        ))}
        <div style={{ fontSize: 18, color: palette.muted, marginTop: 40 }}>
          Educational. Illustrative Black-Scholes values. Not advice.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
