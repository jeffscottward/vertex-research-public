// What: The one SVG chart for Academy lessons. The web page renders it interactively and the video
// renderer renders it frame by frame, so both show the same drawing in the same colors.
import type { ReactElement } from "react";

import type {
  Marker,
  Panel,
  SceneData,
  Series,
  Surface,
} from "../scene-kit.ts";
import type { ColorToken } from "../schema.ts";
import type { Palette } from "./palette.ts";

export type LessonChartProps = Readonly<{
  scene: SceneData;
  palette: Palette;
  /** Element color tokens (elementColors(lesson)). */
  colors: Readonly<Record<string, ColorToken>>;
  /** Draw progress 0..1 per element; "all" draws everything. */
  revealed: ReadonlyMap<string, number> | "all";
  /** Element of the active caption; drawn thicker. */
  highlight?: string | null;
  width: number;
  height: number;
  /** Rotation of 3D surfaces in radians. */
  azimuth?: number;
  fontScale?: number;
  title?: string;
  idPrefix?: string;
  /** Fixed pixel size (video frames). Default: scale to the container width, keep the aspect ratio. */
  fixed?: boolean;
}>;

type Box = Readonly<{ x: number; y: number; w: number; h: number }>;

const niceStep = (span: number, count: number): number => {
  const raw = span / Math.max(count, 1);
  const power = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1));
  const unit = raw / power;
  return (unit >= 5 ? 10 : unit >= 2 ? 5 : unit >= 1 ? 2 : 1) * power;
};

const ticks = (low: number, high: number, count: number): number[] => {
  const step = niceStep(high - low, count);
  const result: number[] = [];
  for (
    let value = Math.ceil(low / step) * step;
    value <= high + step * 1e-9;
    value += step
  )
    result.push(Math.abs(value) < step * 1e-9 ? 0 : value);
  return result;
};

const format = (
  value: number,
  kind: Panel["xFormat"] | Panel["yFormat"],
  step = 1
): string => {
  const abs = Math.abs(value);
  const digits =
    abs >= 1e4
      ? 0
      : Math.min(Math.max(-Math.floor(Math.log10(Math.abs(step) || 1)), 0), 4);
  const short =
    abs >= 1e6
      ? `${(value / 1e6).toFixed(1)}M`
      : abs >= 1e4
        ? `${(value / 1e3).toFixed(0)}k`
        : value.toFixed(digits);
  if (kind === "usd")
    return `${value < 0 ? "-" : ""}$${short.replace("-", "")}`;
  if (kind === "pct") return `${short}%`;
  return short;
};

const progressOf = (
  revealed: LessonChartProps["revealed"],
  element: string
): number =>
  revealed === "all"
    ? 1
    : element === "axes"
      ? 1
      : (revealed.get(element) ?? 0);

const layoutBoxes = (
  scene: SceneData,
  width: number,
  height: number,
  top: number
): { box: Box; panel: Panel }[] => {
  const count = scene.panels.length;
  const inner = { h: height - top, w: width, x: 0, y: top };
  if (scene.layout === "grid" && count > 1) {
    const cols = 2;
    const rows = Math.ceil(count / cols);
    return scene.panels.map((panel, index) => ({
      box: {
        h: inner.h / rows,
        w: inner.w / cols,
        x: inner.x + (index % cols) * (inner.w / cols),
        y: inner.y + Math.floor(index / cols) * (inner.h / rows),
      },
      panel,
    }));
  }
  if (count === 1) return scene.panels.map((panel) => ({ box: inner, panel }));
  const weight = (index: number) => (index === 0 ? 1.6 : 1);
  const total = scene.panels.reduce((sum, _, index) => sum + weight(index), 0);
  let cursor = inner.y;
  return scene.panels.map((panel, index) => {
    const h = (inner.h * weight(index)) / total;
    const box = { h, w: inner.w, x: inner.x, y: cursor };
    cursor += h;
    return { box, panel };
  });
};

const pathFor = (
  points: readonly (readonly [number, number])[],
  sx: (x: number) => number,
  sy: (y: number) => number
): string =>
  points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${sx(point[0]).toFixed(1)},${sy(point[1]).toFixed(1)}`
    )
    .join("");

const SurfaceView = ({
  surface,
  box,
  palette,
  color,
  progress,
  azimuth,
  font,
}: {
  surface: Surface;
  box: Box;
  palette: Palette;
  color: string;
  progress: number;
  azimuth: number;
  font: number;
}): ReactElement => {
  const xs = surface.xs;
  const ys = surface.ys;
  const all = surface.z.flat();
  const zMin = Math.min(...all, 0);
  const zMax = Math.max(...all, 0);
  const zSpan = zMax - zMin || 1;
  // nx/ny only run while drawing quads or the slice, which needs at least two xs and ys, so the
  // first/last lookups below always hit; Number() only narrows the type.
  const xFirst = Number(xs[0]);
  const xSpan = Number(xs.at(-1)) - xFirst || 1;
  const yFirst = Number(ys[0]);
  const ySpan = Number(ys.at(-1)) - yFirst || 1;
  const nx = (value: number) => ((value - xFirst) / xSpan) * 2 - 1;
  const ny = (value: number) => ((value - yFirst) / ySpan) * 2 - 1;
  const nz = (value: number) => ((value - zMin) / zSpan) * 2 - 1;
  const elevation = 0.75;
  const scale = Math.min(box.w * 0.34, box.h * 0.42);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h * 0.52;
  const project = (x: number, y: number, z: number) => {
    const rx = x * Math.cos(azimuth) - y * Math.sin(azimuth);
    const ry = x * Math.sin(azimuth) + y * Math.cos(azimuth);
    return {
      depth: ry,
      sx: cx + rx * scale,
      sy:
        cy -
        ry * Math.sin(elevation) * scale * 0.55 -
        z * Math.cos(elevation) * scale * 0.9,
    };
  };
  const quads: { d: string; depth: number; fill: string; opacity: number }[] =
    [];
  for (let j = 0; j < ys.length - 1; j += 1) {
    for (let i = 0; i < xs.length - 1; i += 1) {
      const corners = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ] as const;
      const projected = corners.map(([a, b]) =>
        project(
          nx(Number(xs[a])),
          ny(Number(ys[b])),
          nz(surface.z[b]?.[a] ?? 0) * progress
        )
      );
      const zAvg =
        corners.reduce((sum, [a, b]) => sum + (surface.z[b]?.[a] ?? 0), 0) / 4;
      quads.push({
        d: `M${projected.map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join("L")}Z`,
        depth: projected.reduce((sum, p) => sum + p.depth, 0) / 4,
        fill: zAvg >= 0 ? palette.tokens.green : palette.tokens.red,
        opacity:
          0.25 +
          0.6 *
            Math.min(
              Math.abs(zAvg) / (Math.max(Math.abs(zMin), Math.abs(zMax)) || 1),
              1
            ),
      });
    }
  }
  quads.sort((a, b) => b.depth - a.depth);
  const slice = surface.sliceY;
  const slicePath =
    slice === undefined
      ? null
      : (() => {
          const j = ys.reduce(
            (best, value, index) =>
              Math.abs(value - slice) < Math.abs(Number(ys[best]) - slice)
                ? index
                : best,
            0
          );
          return xs
            .map((x, i) => {
              const p = project(
                nx(x),
                ny(Number(ys[j])),
                nz(surface.z[j]?.[i] ?? 0) * progress
              );
              return `${i === 0 ? "M" : "L"}${p.sx.toFixed(1)},${p.sy.toFixed(1)}`;
            })
            .join("");
        })();
  const axisEnd = (x: number, y: number, z: number) => project(x, y, z);
  const o = axisEnd(-1, -1, -1);
  const ex = axisEnd(1, -1, -1);
  const ey = axisEnd(-1, 1, -1);
  return (
    <g opacity={Math.max(progress, 0.05)}>
      {quads.map((quad, index) => (
        <path
          d={quad.d}
          fill={quad.fill}
          fillOpacity={quad.opacity}
          key={index}
          stroke={palette.grid}
          strokeWidth={0.5}
        />
      ))}
      {slicePath === null ? null : (
        <path
          d={slicePath}
          fill="none"
          stroke={palette.tokens.blue}
          strokeWidth={3}
        />
      )}
      <line
        stroke={color}
        strokeWidth={1.5}
        x1={o.sx}
        x2={ex.sx}
        y1={o.sy}
        y2={ex.sy}
      />
      <line
        stroke={color}
        strokeWidth={1.5}
        x1={o.sx}
        x2={ey.sx}
        y1={o.sy}
        y2={ey.sy}
      />
      <text
        fill={palette.muted}
        fontSize={font}
        textAnchor={ex.sx > box.x + box.w - font * 6 ? "end" : "start"}
        x={Math.min(ex.sx + 6, box.x + box.w - 4)}
        y={ex.sy + font * 1.2}
      >
        {surface.xLabel}
      </text>
      <text fill={palette.muted} fontSize={font} x={ey.sx + 6} y={ey.sy + 4}>
        {surface.yLabel}
      </text>
      <text
        fill={palette.muted}
        fontSize={font}
        x={box.x + 12}
        y={box.y + box.h - 10}
      >
        {surface.legend ??
          `${surface.zLabel}: green = profit, red = loss, blue = current day`}
      </text>
    </g>
  );
};

const PanelView = ({
  panel,
  box,
  props,
  font,
  index,
}: {
  panel: Panel;
  box: Box;
  props: LessonChartProps;
  font: number;
  index: number;
}): ReactElement | null => {
  const { palette, colors, revealed, highlight } = props;
  const visible =
    panel.elements.some((element) => progressOf(revealed, element) > 0) ||
    panel.elements.includes("axes");
  if (!visible) return null;
  const tone = (element: string): string =>
    palette.tokens[colors[element] ?? "gray"];
  const margin = {
    bottom: font * 2.8,
    left: font * 4.6,
    right: font * 1.2,
    top: font * 2.2,
  };
  const plot = {
    h: Math.max(box.h - margin.top - margin.bottom, 10),
    w: Math.max(box.w - margin.left - margin.right, 10),
    x: box.x + margin.left,
    y: box.y + margin.top,
  };
  const [x0, x1] = panel.xDomain;
  const [y0, y1] = panel.yDomain;
  const sx = (x: number) => plot.x + ((x - x0) / (x1 - x0 || 1)) * plot.w;
  const sy = (y: number) =>
    plot.y + plot.h - ((y - y0) / (y1 - y0 || 1)) * plot.h;
  const clipId = `${props.idPrefix ?? "dyr"}-clip-${index}`;
  const zeroY = Math.min(Math.max(sy(0), plot.y), plot.y + plot.h);
  const xTicks = ticks(x0, x1, Math.max(Math.round(plot.w / (font * 7)), 2));
  const yTicks = ticks(y0, y1, Math.max(Math.round(plot.h / (font * 3.2)), 2));
  if (panel.surface !== undefined) {
    return (
      <g>
        <text
          fill={palette.text}
          fontSize={font * 1.05}
          fontWeight={600}
          x={box.x + font}
          y={box.y + font * 1.4}
        >
          {panel.title}
        </text>
        <SurfaceView
          azimuth={props.azimuth ?? 0.6}
          box={box}
          color={palette.axis}
          font={font * 0.85}
          palette={palette}
          progress={progressOf(revealed, panel.surface.element)}
          surface={panel.surface}
        />
      </g>
    );
  }
  const seriesView = (series: Series, key: number) => {
    const progress = progressOf(revealed, series.element);
    if (progress <= 0) return null;
    const revealTo = series.revealTo;
    const points =
      revealTo === undefined
        ? series.points
        : series.points.filter((point) => point[0] <= revealTo);
    const [first, second] = points;
    if (first === undefined || second === undefined) return null;
    const d = pathFor(points, sx, sy);
    const color = tone(series.element);
    const active = highlight === series.element;
    const width = (series.width ?? 2) * (active ? 1.35 : 1) * (font / 14);
    const last = points.reduce((_, point) => point, first);
    const area = `${d}L${sx(last[0]).toFixed(1)},${zeroY.toFixed(1)}L${sx(first[0]).toFixed(1)},${zeroY.toFixed(1)}Z`;
    return (
      <g key={key}>
        {series.signFill === true ? (
          <g opacity={0.22 * progress}>
            <clipPath id={`${clipId}-up-${key}`}>
              <rect
                height={Math.max(zeroY - plot.y, 0)}
                width={plot.w}
                x={plot.x}
                y={plot.y}
              />
            </clipPath>
            <clipPath id={`${clipId}-down-${key}`}>
              <rect
                height={Math.max(plot.y + plot.h - zeroY, 0)}
                width={plot.w}
                x={plot.x}
                y={zeroY}
              />
            </clipPath>
            <path
              clipPath={`url(#${clipId}-up-${key})`}
              d={area}
              fill={palette.tokens.green}
            />
            <path
              clipPath={`url(#${clipId}-down-${key})`}
              d={area}
              fill={palette.tokens.red}
            />
          </g>
        ) : null}
        {series.fill === true ? (
          <path d={area} fill={color} opacity={0.18 * progress} />
        ) : null}
        {width > 0 ? (
          <path
            d={d}
            fill="none"
            pathLength={1}
            stroke={
              series.signFill === true && series.element === "zones"
                ? "none"
                : color
            }
            strokeDasharray={series.dashed === true ? undefined : "1 1"}
            strokeDashoffset={series.dashed === true ? undefined : 1 - progress}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={series.dashed === true ? 0.85 * progress : 1}
            strokeWidth={width}
            style={
              series.dashed === true
                ? { strokeDasharray: `${font * 0.5} ${font * 0.35}` }
                : undefined
            }
          />
        ) : null}
      </g>
    );
  };
  // A background-colored outline keeps marker labels readable over grid lines, series and dots.
  const labelHalo = {
    paintOrder: "stroke",
    stroke: palette.background,
    strokeLinejoin: "round",
    strokeWidth: 3,
  } as const;
  const markerView = (marker: Marker, key: number) => {
    const progress = progressOf(revealed, marker.element);
    if (progress <= 0) return null;
    const color = tone(marker.element);
    const active = highlight === marker.element;
    const strokeWidth = (active ? 2.6 : 1.6) * (font / 14);
    const label = marker.label === "" ? null : marker.label;
    if (
      marker.kind === "band" &&
      marker.x !== undefined &&
      marker.x2 !== undefined
    ) {
      const left = Math.max(sx(marker.x), plot.x);
      const right = Math.min(sx(marker.x2), plot.x + plot.w);
      return (
        <g key={key} opacity={progress}>
          <rect
            fill={color}
            height={plot.h}
            opacity={0.14}
            width={Math.max(right - left, 0)}
            x={left}
            y={plot.y}
          />
          <line
            stroke={color}
            strokeDasharray="4 4"
            strokeWidth={strokeWidth}
            x1={left}
            x2={left}
            y1={plot.y}
            y2={plot.y + plot.h}
          />
          <line
            stroke={color}
            strokeDasharray="4 4"
            strokeWidth={strokeWidth}
            x1={right}
            x2={right}
            y1={plot.y}
            y2={plot.y + plot.h}
          />
          {label === null ? null : (
            <text
              fill={color}
              fontSize={font * 0.85}
              textAnchor="middle"
              x={(left + right) / 2}
              y={plot.y + font * (marker.element === "band2" ? 1 : 2.2)}
            >
              {label}
            </text>
          )}
        </g>
      );
    }
    if (marker.kind === "vline" && marker.x !== undefined) {
      if (marker.x < x0 || marker.x > x1) return null;
      const x = sx(marker.x);
      return (
        <g key={key} opacity={progress}>
          <line
            stroke={color}
            strokeDasharray="6 4"
            strokeWidth={strokeWidth}
            x1={x}
            x2={x}
            y1={plot.y}
            y2={plot.y + plot.h}
          />
          {label === null ? null : (
            <text
              {...labelHalo}
              fill={color}
              fontSize={font * 0.8}
              x={x + 4}
              y={plot.y + font * (1 + (key % 3) * 1.1)}
            >
              {label}
            </text>
          )}
        </g>
      );
    }
    if (marker.kind === "hline" && marker.y !== undefined) {
      // A level outside the y-range (a max loss at a price of zero) is pinned to the plot edge with
      // an arrow, so the step that names it still shows it.
      const below = marker.y < y0;
      const above = marker.y > y1;
      const y = sy(Math.min(Math.max(marker.y, y0), y1));
      const arrow = below ? "▼ " : above ? "▲ " : "";
      return (
        <g key={key} opacity={progress}>
          <line
            stroke={color}
            strokeDasharray={below || above ? "2 4" : "6 4"}
            strokeWidth={strokeWidth}
            x1={plot.x}
            x2={plot.x + plot.w}
            y1={y}
            y2={y}
          />
          {label === null ? null : (
            <text
              {...labelHalo}
              fill={color}
              fontSize={font * 0.8}
              textAnchor="end"
              x={plot.x + plot.w - 4}
              y={above ? y + font : y - 5}
            >
              {`${arrow}${label}${below || above ? " (off scale)" : ""}`}
            </text>
          )}
        </g>
      );
    }
    if (
      marker.kind === "dot" &&
      marker.x !== undefined &&
      marker.y !== undefined
    ) {
      const x = sx(marker.x);
      const y = sy(marker.y);
      return (
        <g key={key} opacity={progress}>
          <circle
            cx={x}
            cy={y}
            fill={color}
            r={(active ? 7 : 5.5) * (font / 14)}
            stroke={palette.background}
            strokeWidth={2}
          />
          {label === null ? null : (
            <text
              {...labelHalo}
              fill={color}
              fontSize={font * 0.8}
              textAnchor="middle"
              x={x}
              y={y - font * 0.9}
            >
              {label}
            </text>
          )}
        </g>
      );
    }
    return null;
  };
  const legend = panel.series.filter(
    (series, position) =>
      series.label !== "" &&
      progressOf(revealed, series.element) > 0 &&
      panel.series.findIndex((other) => other.label === series.label) ===
        position
  );
  return (
    <g>
      <rect
        fill={palette.panel}
        height={plot.h}
        rx={6}
        width={plot.w}
        x={plot.x}
        y={plot.y}
      />
      <text
        fill={palette.text}
        fontSize={font * 1.05}
        fontWeight={600}
        x={plot.x}
        y={box.y + font * 1.4}
      >
        {panel.title}
      </text>
      {yTicks.map((tick) => (
        <g key={`y${tick}`}>
          <line
            stroke={tick === 0 ? palette.axis : palette.grid}
            strokeWidth={tick === 0 ? 1.4 : 1}
            x1={plot.x}
            x2={plot.x + plot.w}
            y1={sy(tick)}
            y2={sy(tick)}
          />
          <text
            fill={palette.muted}
            fontSize={font * 0.78}
            textAnchor="end"
            x={plot.x - 6}
            y={sy(tick) + font * 0.3}
          >
            {format(tick, panel.yFormat, (yTicks[1] ?? 1) - Number(yTicks[0]))}
          </text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <g key={`x${tick}`}>
          <line
            stroke={palette.grid}
            x1={sx(tick)}
            x2={sx(tick)}
            y1={plot.y}
            y2={plot.y + plot.h}
          />
          <text
            fill={palette.muted}
            fontSize={font * 0.78}
            textAnchor="middle"
            x={sx(tick)}
            y={plot.y + plot.h + font * 1.2}
          >
            {format(tick, panel.xFormat, (xTicks[1] ?? 1) - Number(xTicks[0]))}
          </text>
        </g>
      ))}
      <text
        fill={palette.muted}
        fontSize={font * 0.8}
        textAnchor="middle"
        x={plot.x + plot.w / 2}
        y={plot.y + plot.h + font * 2.4}
      >
        {panel.xLabel}
      </text>
      <text
        fill={palette.muted}
        fontSize={font * 0.8}
        textAnchor="middle"
        transform={`rotate(-90 ${box.x + font * 0.9} ${plot.y + plot.h / 2})`}
        x={box.x + font * 0.9}
        y={plot.y + plot.h / 2}
      >
        {panel.yLabel}
      </text>
      <clipPath id={`${clipId}-plot`}>
        <rect height={plot.h} width={plot.w} x={plot.x} y={plot.y} />
      </clipPath>
      <g clipPath={`url(#${clipId}-plot)`}>
        {panel.markers
          .filter((marker) => marker.kind === "band")
          .map(markerView)}
        {panel.bars.map((bar, key) => {
          const barProgress = progressOf(revealed, bar.element);
          if (barProgress <= 0) return null;
          const x = sx(bar.x - bar.width / 2);
          const w = Math.max(sx(bar.x + bar.width / 2) - x, 1);
          const top = sy(Math.max(bar.y * barProgress, 0));
          const bottom = sy(Math.min(bar.y * barProgress, 0));
          return (
            <rect
              fill={
                bar.tone === true
                  ? tone(bar.element)
                  : bar.y >= 0
                    ? palette.tokens.green
                    : palette.tokens.red
              }
              height={Math.max(bottom - top, 0.5)}
              key={key}
              opacity={0.85}
              width={w}
              x={x}
              y={top}
            />
          );
        })}
        {panel.series.map(seriesView)}
        {panel.markers
          .filter((marker) => marker.kind !== "band")
          .map((marker, key) => ({ key: key + 100, marker }))
          // Labelled markers draw last, so an unlabelled dot cloud never covers their text.
          .sort(
            (a, b) =>
              Number(a.marker.label !== "") - Number(b.marker.label !== "")
          )
          .map(({ key, marker }) => markerView(marker, key))}
      </g>
      {legend.length > 0 ? (
        <g>
          {legend.slice(0, 5).map((series, position) => (
            <g
              key={series.label}
              transform={`translate(${plot.x + 8} ${plot.y + 8 + position * font * 1.25})`}
            >
              <rect
                fill={palette.background}
                height={font * 1.1}
                opacity={0.7}
                rx={3}
                width={font * 0.5 * series.label.length + font * 2}
                x={-4}
                y={-2}
              />
              <line
                stroke={tone(series.element)}
                strokeDasharray={series.dashed === true ? "4 3" : undefined}
                strokeWidth={3}
                x1={0}
                x2={font * 1.2}
                y1={font * 0.45}
                y2={font * 0.45}
              />
              <text
                fill={palette.text}
                fontSize={font * 0.78}
                x={font * 1.5}
                y={font * 0.75}
              >
                {series.label}
              </text>
            </g>
          ))}
        </g>
      ) : null}
    </g>
  );
};

/** Draws a lesson scene (all panels) into one SVG. */
export const LessonChart = (props: LessonChartProps): ReactElement => {
  const font = 14 * (props.fontScale ?? 1);
  const top = props.title === undefined ? 0 : font * 2.4;
  // Panels with nothing revealed yet give their space to the visible ones (stacks and 2-panel grids),
  // so a 3D surface or a lower panel appears without leaving an empty area first.
  const visible = (panel: Panel) =>
    panel.elements.some(
      (element) => progressOf(props.revealed, element) > 0 && element !== "axes"
    ) || panel === props.scene.panels[0];
  const panels =
    props.scene.layout === "grid" && props.scene.panels.length > 2
      ? props.scene.panels
      : props.scene.panels.filter(visible);
  const boxes = layoutBoxes(
    { ...props.scene, panels },
    props.width,
    props.height,
    top
  );
  return (
    <svg
      aria-label={props.title ?? "Lesson chart"}
      fontFamily="'Public Sans Variable', 'Public Sans', system-ui, sans-serif"
      height={props.fixed === true ? props.height : undefined}
      role="img"
      style={
        props.fixed === true
          ? undefined
          : { display: "block", height: "auto", width: "100%" }
      }
      viewBox={`0 0 ${props.width} ${props.height}`}
      width={props.fixed === true ? props.width : "100%"}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        fill={props.palette.background}
        height={props.height}
        width={props.width}
      />
      {props.title === undefined ? null : (
        <text
          fill={props.palette.text}
          fontFamily="'Manrope Variable', 'Manrope', system-ui, sans-serif"
          fontSize={font * 1.35}
          fontWeight={700}
          x={font}
          y={font * 1.7}
        >
          {props.title}
        </text>
      )}
      {boxes.map(({ box, panel }, index) => (
        <PanelView
          box={box}
          font={font}
          index={index}
          key={panel.id}
          panel={panel}
          props={props}
        />
      ))}
    </svg>
  );
};
