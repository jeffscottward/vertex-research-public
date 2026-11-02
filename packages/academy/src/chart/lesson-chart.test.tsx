import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ACADEMY_LESSONS } from "../lessons/index.ts";
import { defaultValues } from "../position.ts";
import { buildScene, elementColors } from "../scenes.ts";
import { buildTables } from "../tables.ts";
import type { Panel, SceneData } from "../scenes.ts";
import { lessonTimeline, stateAt } from "../timeline.ts";
import { LessonChart } from "./lesson-chart.tsx";
import { DARK_PALETTE, LIGHT_PALETTE, paletteFor } from "./palette.ts";

describe("LessonChart and tables for every lesson", () => {
  it("maps the light theme to the light palette", () => {
    expect(paletteFor("light")).toBe(LIGHT_PALETTE);
  });

  it.each(ACADEMY_LESSONS.map((lesson) => [lesson.slug, lesson] as const))(
    "renders %s at several times, partly and fully revealed, in both palettes",
    (_slug, lesson) => {
      {
        const values = defaultValues(lesson.params);
        const timeline = lessonTimeline(lesson);
        const colors = elementColors(lesson);
        for (const [index, t] of [0, 0.5, 1].entries()) {
          const scene = buildScene(lesson, values, t, 0.4 + index);
          const midStep =
            timeline.steps[Math.min(index * 2, timeline.steps.length - 1)];
          const partial = stateAt(timeline, (midStep?.start ?? 0) + 0.2);
          const svg = renderToStaticMarkup(
            <LessonChart
              azimuth={0.4 + index}
              colors={colors}
              fixed={index === 1}
              height={720}
              highlight={midStep?.element ?? null}
              palette={index === 2 ? LIGHT_PALETTE : DARK_PALETTE}
              revealed={index === 0 ? "all" : partial.revealed}
              scene={scene}
              {...(index === 0 ? { title: lesson.title } : {})}
              width={1280}
            />
          );
          expect(svg.startsWith("<svg"), lesson.slug).toBe(true);
          expect(svg.includes("NaN"), `${lesson.slug} t=${t}`).toBe(false);
          const tables = buildTables(lesson, values, t);
          expect(tables.length, lesson.slug).toBeGreaterThanOrEqual(2);
          for (const table of tables)
            for (const row of table.rows)
              expect(
                row.join(" ").includes("NaN"),
                `${lesson.slug} ${table.id}`
              ).toBe(false);
        }
      }
    }
  );

  it("pins an off-scale max-loss line to the plot edge with an arrow label", () => {
    const lesson = ACADEMY_LESSONS.find(
      (entry) => entry.slug === "covered-call-two-legs"
    );
    if (lesson === undefined) throw new Error("fixture lesson missing");
    const scene = buildScene(lesson, defaultValues(lesson.params), 1, 0.4);
    const svg = renderToStaticMarkup(
      <LessonChart
        colors={elementColors(lesson)}
        height={720}
        palette={DARK_PALETTE}
        revealed="all"
        scene={scene}
        width={1280}
      />
    );
    expect(svg).toMatch(/▼ Max loss -\$9,?\d{3} \(off scale\)/u);
  });

  it("shows the greeks panels (axes, spot and strikes) during a spot step", () => {
    const lesson = ACADEMY_LESSONS.find(
      (entry) => entry.slug === "theta-is-the-price-of-gamma"
    );
    if (lesson === undefined) throw new Error("fixture lesson missing");
    const timeline = lessonTimeline(lesson);
    const first = timeline.steps[0];
    const state = stateAt(timeline, (first?.end ?? 0) - 0.01);
    const svg = renderToStaticMarkup(
      <LessonChart
        colors={elementColors(lesson)}
        height={720}
        palette={DARK_PALETTE}
        revealed={state.revealed}
        scene={buildScene(lesson, defaultValues(lesson.params), state.t, 0)}
        width={1280}
      />
    );
    expect(svg).toContain("Delta (share equivalents)");
  });
});

const panel = (overrides: Partial<Panel>): Panel => ({
  id: "p",
  title: "Synthetic",
  xLabel: "x",
  yLabel: "y",
  xDomain: [0, 10],
  yDomain: [-5, 5],
  series: [],
  markers: [],
  bars: [],
  elements: ["axes"],
  xFormat: "price",
  yFormat: "usd",
  ...overrides,
});

const scene = (
  panels: Panel[],
  layout: SceneData["layout"] = "stack"
): SceneData => ({
  panels,
  horizon: 1,
  timeLabel: "t",
  timeUnit: "days",
  now: 0,
  layout,
});

const render = (
  data: SceneData,
  revealed: ReadonlyMap<string, number> | "all" = "all",
  highlight: string | null = null
) =>
  renderToStaticMarkup(
    <LessonChart
      colors={{ line: "blue" }}
      height={400}
      highlight={highlight}
      palette={LIGHT_PALETTE}
      revealed={revealed}
      scene={data}
      width={600}
    />
  );

describe("LessonChart edge cases", () => {
  it("draws a degenerate flat surface with ragged z rows at the default azimuth", () => {
    const flat = render(
      scene([
        panel({
          elements: ["surface"],
          surface: {
            element: "surface",
            xs: [1, 1, 1],
            ys: [2, 2],
            z: [[0, 0, 0], [0]],
            xLabel: "spot",
            yLabel: "days",
            zLabel: "P&L",
          },
        }),
      ])
    );
    expect(flat).toContain("P&amp;L: green = profit");
    expect(flat).not.toContain('stroke-width="3"');
    const sliced = render(
      scene([
        panel({
          elements: ["surface"],
          surface: {
            element: "surface",
            xs: [1, 2, 3],
            ys: [0, 5, 10],
            z: [[1, -1, 2], [3], [-2, 4, 1]],
            xLabel: "spot",
            yLabel: "days",
            zLabel: "P&L",
            sliceY: 6,
          },
        }),
      ])
    );
    expect(sliced).toContain('stroke-width="3"');
  });

  it("handles zero-width domains, short series and unknown element colors", () => {
    const svg = render(
      scene([
        panel({
          xDomain: [1, 1],
          yDomain: [0, 0],
          elements: ["axes", "line", "mystery"],
          series: [
            { element: "line", label: "Empty", points: [] },
            { element: "line", label: "One", points: [[1, 1]] },
            {
              element: "mystery",
              label: "Mystery",
              points: [
                [0, 1],
                [1, 2],
                [2, 3],
              ],
              revealTo: 1,
            },
          ],
        }),
      ]),
      "all",
      "mystery"
    );
    expect(svg).toContain(LIGHT_PALETTE.tokens.gray);
    expect(svg).toContain(">Mystery<");
  });

  it("draws markers: bands, off-range vlines, pinned hlines, dots and unlabeled variants", () => {
    const svg = render(
      scene([
        panel({
          elements: ["axes", "zones", "m", "bars"],
          series: [
            {
              element: "zones",
              label: "",
              signFill: true,
              points: [
                [0, -1],
                [10, 1],
              ],
            },
          ],
          bars: [
            { element: "bars", x: 2, y: 3, width: 1 },
            { element: "bars", x: 4, y: -3, width: 1 },
          ],
          markers: [
            { element: "m", label: "", kind: "band", x: 1, x2: 3 },
            { element: "m", label: "Off", kind: "vline", x: 50 },
            { element: "m", label: "", kind: "vline", x: 5 },
            { element: "m", label: "High", kind: "hline", y: 50 },
            { element: "m", label: "", kind: "hline", y: 1 },
            { element: "m", label: "Dot", kind: "dot", x: 5, y: 1 },
            { element: "m", label: "", kind: "dot", x: 6, y: 2 },
            { element: "m", label: "No y", kind: "dot", x: 6 },
          ],
        }),
      ])
    );
    expect(svg).toContain('stroke="none"');
    expect(svg).toContain("▲ High (off scale)");
    expect(svg).toContain(">Dot<");
    expect(svg).not.toContain(">Off<");
    expect(svg).not.toContain("No y");
    expect(svg).toContain(LIGHT_PALETTE.tokens.red);
  });

  it("skips bars that are not revealed yet", () => {
    const svg = render(
      scene([
        panel({
          elements: ["axes", "bars"],
          bars: [{ element: "bars", x: 2, y: 3, width: 1 }],
        }),
      ]),
      new Map([["bars", 0]])
    );
    expect(svg).not.toContain('opacity="0.85"');
  });

  it("picks the palette for each theme", () => {
    expect(paletteFor("light")).toBe(LIGHT_PALETTE);
    expect(paletteFor("dark")).toBe(DARK_PALETTE);
  });
});
