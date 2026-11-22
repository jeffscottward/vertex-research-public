"use client";

import type { CSSProperties, ReactNode } from "react";
import { Component, useEffect, useId, useRef, useState } from "react";
import type {
  CandleRenderer,
  CandleRendererFactory,
  ChartMarker,
  ChartPalette,
  ChartStudies,
  DisplayCandle,
} from "./types.ts";
import { utcClock } from "../../components/status-time.ts";
import { paneStudyCount } from "./vertex-studies.ts";

// What the host keeps of a caught renderer error: the step that failed, the error's name and
// the time, so the caption says what happened and since when. `load` is the mount (the
// renderer module, its first bars); `draw` is any later call on a mounted renderer.
type RendererFailure = Readonly<{
  stage: "load" | "draw";
  name: string;
  failedAt: number;
}>;
type HostState =
  | Readonly<{ phase: "loading" | "ready" }>
  | Readonly<{ phase: "error"; failure: RendererFailure }>;

// The cause in the caption is never blank: an Error whose name is empty is named as such.
const errorName = (error: unknown): string => {
  if (!(error instanceof Error)) return `non-Error value (${typeof error})`;
  return error.name.trim() === "" ? "Error without a name" : error.name;
};

const failed = (
  stage: RendererFailure["stage"],
  error: unknown
): HostState => ({
  failure: { failedAt: Date.now(), name: errorName(error), stage },
  phase: "error",
});

const failureCaption = (failure: RendererFailure, nextStep: string): string =>
  `Chart renderer failed to ${failure.stage}: ${failure.name} · ${utcClock(failure.failedAt)} · ${nextStep}`;

// Resolve the existing Vertex tokens at the mounted element. No palette or
// browser global is evaluated during server rendering or module import.
const readChartPalette = (element: HTMLElement): ChartPalette => {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  const foreground = token("--foreground", style.color);
  const background = token("--background", style.backgroundColor);
  const accent = token("--vx-gold", foreground);
  return {
    accent,
    background,
    falling: token("--muted-foreground", foreground),
    foreground,
    grid: token("--border", foreground),
    rising: foreground,
    warning: token("--warning", accent),
  };
};

export type CandleCanvasProps = Readonly<{
  values: readonly DisplayCandle[];
  factory: CandleRendererFactory;
  label: string;
  pricePrecision: number;
  volumePrecision: number;
  // Optional; applied after every mount and whenever they change.
  studies?: ChartStudies;
  markers?: readonly ChartMarker[];
  // Optional caption copy for hosts without an exact-value table. `error` is only the next
  // step: the host writes the state, the cause and the time before it.
  captions?: Readonly<{ ready: string; loading: string; error: string }>;
  // Receives each mounted renderer, and null when it goes away.
  onRenderer?: (renderer: CandleRenderer | null) => void;
  // Panes the host adds below the candles besides pane studies (script layers).
  extraPanes?: number;
}>;
export const CandleCanvas = ({
  values,
  factory,
  label,
  pricePrecision,
  volumePrecision,
  studies,
  markers,
  captions,
  onRenderer,
  extraPanes = 0,
}: CandleCanvasProps) => {
  const latestOnRenderer = useRef(onRenderer);
  latestOnRenderer.current = onRenderer;
  const element = useRef<HTMLDivElement>(null);
  const renderer = useRef<CandleRenderer | null>(null);
  const latest = useRef(values);
  latest.current = values;
  const latestStudies = useRef(studies);
  latestStudies.current = studies;
  const latestMarkers = useRef(markers);
  latestMarkers.current = markers;
  const [state, setState] = useState<HostState>({ phase: "loading" });
  const description = useId();
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    let active = true;
    let mounted: CandleRenderer | null = null;
    let resize: ResizeObserver | null = null;
    let theme: MutationObserver | null = null;
    let generation = 0;
    let controller: AbortController | null = null;
    const mount = async () => {
      const mine = ++generation;
      controller?.abort();
      controller = new AbortController();
      setState({ phase: "loading" });
      try {
        const instance = await factory(target, {
          palette: readChartPalette(target),
          pricePrecision,
          signal: controller.signal,
          volumePrecision,
        });
        if (!active || mine !== generation) {
          instance.dispose();
          return;
        }
        mounted = instance;
        renderer.current = instance;
        instance.replace(latest.current);
        if (latestStudies.current !== undefined)
          instance.setStudies?.(latestStudies.current);
        if (latestMarkers.current !== undefined)
          instance.setMarkers?.(latestMarkers.current);
        instance.resize();
        latestOnRenderer.current?.(instance);
        return setState({ phase: "ready" });
      } catch (error) {
        if (active && mine === generation) {
          latestOnRenderer.current?.(null);
          mounted?.dispose();
          mounted = null;
          renderer.current = null;
          return setState(failed("load", error));
        }
        return;
      }
    };
    void mount();
    if (typeof ResizeObserver !== "undefined") {
      resize = new ResizeObserver(() => {
        try {
          return mounted?.resize();
        } catch (error) {
          return setState(failed("draw", error));
        }
      });
      resize.observe(target);
    }
    // Existing theme controls change root attributes. Recreate the canvas using
    // current semantic tokens; renderer packages never become theme authorities.
    if (typeof MutationObserver !== "undefined") {
      theme = new MutationObserver(() => {
        generation += 1;
        latestOnRenderer.current?.(null);
        mounted?.dispose();
        mounted = null;
        renderer.current = null;
        return void mount();
      });
      theme.observe(document.documentElement, {
        attributeFilter: ["class", "data-theme", "data-palette", "style"],
        attributes: true,
      });
    }
    return () => {
      active = false;
      generation += 1;
      controller?.abort();
      resize?.disconnect();
      theme?.disconnect();
      latestOnRenderer.current?.(null);
      mounted?.dispose();
      renderer.current = null;
    };
  }, [factory, pricePrecision, volumePrecision]);
  useEffect(() => {
    try {
      renderer.current?.replace(values);
    } catch (error) {
      latestOnRenderer.current?.(null);
      renderer.current?.dispose();
      renderer.current = null;
      setState(failed("draw", error));
    }
    return;
  }, [values]);
  useEffect(() => {
    if (studies === undefined) return;
    try {
      renderer.current?.setStudies?.(studies);
    } catch (error) {
      latestOnRenderer.current?.(null);
      renderer.current?.dispose();
      renderer.current = null;
      setState(failed("draw", error));
    }
    return;
  }, [studies]);
  useEffect(() => {
    if (markers === undefined) return;
    try {
      renderer.current?.setMarkers?.(markers);
    } catch (error) {
      latestOnRenderer.current?.(null);
      renderer.current?.dispose();
      renderer.current = null;
      setState(failed("draw", error));
    }
    return;
  }, [markers]);
  return (
    <figure
      aria-label={label}
      className="@container min-w-0 max-w-full border-border-strong border-t-2 pt-4 text-foreground [&>*]:min-w-0 [&>*]:max-w-full motion-reduce:[&_*]:animate-none motion-reduce:[&_*]:scroll-auto motion-reduce:[&_*]:transition-none [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-foreground [&_:focus-visible]:outline-solid [&_:focus-visible]:outline-offset-3"
    >
      <div
        aria-describedby={description}
        aria-label={label}
        className="h-[calc(clamp(18rem,45cqi,32rem)+var(--vx-chart-sub-panes,0)*6rem)] min-h-[18rem] w-full min-w-0 max-w-full overflow-hidden bg-background"
        data-chart-canvas=""
        ref={element}
        role="group"
        style={
          {
            "--vx-chart-sub-panes":
              paneStudyCount(studies?.extra ?? []) +
              (studies?.panes?.length ?? 0) +
              extraPanes,
          } as CSSProperties
        }
      />
      <figcaption
        id={description}
        className="my-3 text-muted-foreground text-sm leading-[1.6] [overflow-wrap:anywhere]"
      >
        {state.phase === "error"
          ? failureCaption(
              state.failure,
              captions === undefined
                ? "exact data is in the table; reload the page to retry"
                : captions.error
            )
          : captions === undefined
            ? state.phase === "loading"
              ? "Loading chart renderer. Exact data remains available below."
              : "The chart uses approximate values. Use the table for exact prices, volumes and nanosecond timestamps."
            : captions[state.phase]}
      </figcaption>
    </figure>
  );
};

export class ChartRendererBoundary extends Component<
  { readonly children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render() {
    if (this.state.failed)
      return (
        <p
          role="status"
          className="my-3 text-muted-foreground text-sm leading-[1.6] [overflow-wrap:anywhere]"
        >
          The renderer could not display the selected data. The exact table
          remains available.
        </p>
      );
    return this.props.children;
  }
}
