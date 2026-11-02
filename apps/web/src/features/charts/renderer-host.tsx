"use client";

import { Component, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  CandleRenderer,
  CandleRendererFactory,
  ChartMarker,
  ChartPalette,
  ChartStudies,
  DisplayCandle,
} from "./types.ts";
import { paneStudyCount } from "./vertex-studies.ts";

// Resolve the existing Vertex tokens at the mounted element. No palette or
// browser global is evaluated during server rendering or module import.
const readChartPalette = (element: HTMLElement): ChartPalette => {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  const foreground = token("--foreground", style.color);
  const background = token("--background", style.backgroundColor);
  return {
    foreground,
    background,
    grid: token("--border", foreground),
    rising: foreground,
    falling: token("--muted-foreground", foreground),
    accent: token("--vx-gold", foreground),
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
  // Optional caption copy for hosts without an exact-value table.
  captions?: Readonly<{ ready: string; loading: string; error: string }>;
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
}: CandleCanvasProps) => {
  const element = useRef<HTMLDivElement>(null);
  const renderer = useRef<CandleRenderer | null>(null);
  const latest = useRef(values);
  latest.current = values;
  const latestStudies = useRef(studies);
  latestStudies.current = studies;
  const latestMarkers = useRef(markers);
  latestMarkers.current = markers;
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
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
      setPhase("loading");
      try {
        const instance = await factory(target, {
          palette: readChartPalette(target),
          pricePrecision,
          volumePrecision,
          signal: controller.signal,
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
        return setPhase("ready");
      } catch {
        if (active && mine === generation) {
          mounted?.dispose();
          mounted = null;
          renderer.current = null;
          return setPhase("error");
        }
        return;
      }
    };
    void mount();
    if (typeof ResizeObserver !== "undefined") {
      resize = new ResizeObserver(() => {
        try {
          return mounted?.resize();
        } catch {
          return setPhase("error");
        }
      });
      resize.observe(target);
    }
    // Existing theme controls change root attributes. Recreate the canvas using
    // current semantic tokens; renderer packages never become theme authorities.
    if (typeof MutationObserver !== "undefined") {
      theme = new MutationObserver(() => {
        generation += 1;
        mounted?.dispose();
        mounted = null;
        renderer.current = null;
        return void mount();
      });
      theme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme", "data-palette", "style"],
      });
    }
    return () => {
      active = false;
      generation += 1;
      controller?.abort();
      resize?.disconnect();
      theme?.disconnect();
      mounted?.dispose();
      renderer.current = null;
    };
  }, [factory, pricePrecision, volumePrecision]);
  useEffect(() => {
    try {
      renderer.current?.replace(values);
    } catch {
      renderer.current?.dispose();
      renderer.current = null;
      setPhase("error");
    }
    return;
  }, [values]);
  useEffect(() => {
    if (studies === undefined) return;
    try {
      renderer.current?.setStudies?.(studies);
    } catch {
      renderer.current?.dispose();
      renderer.current = null;
      setPhase("error");
    }
    return;
  }, [studies]);
  useEffect(() => {
    if (markers === undefined) return;
    try {
      renderer.current?.setMarkers?.(markers);
    } catch {
      renderer.current?.dispose();
      renderer.current = null;
      setPhase("error");
    }
    return;
  }, [markers]);
  return (
    <figure className="vx-chart-panel" aria-label={label}>
      <div
        ref={element}
        className="vx-chart-canvas"
        style={
          {
            "--vx-chart-sub-panes": paneStudyCount(studies?.extra ?? []),
          } as CSSProperties
        }
        role="group"
        aria-label={label}
        aria-describedby={description}
      />
      <figcaption id={description} className="vx-chart-note">
        {captions === undefined
          ? phase === "error"
            ? "Chart renderer unavailable. Exact data remains in the table."
            : phase === "loading"
              ? "Loading chart renderer. Exact data remains available below."
              : "The chart uses approximate values. Use the table for exact prices, volumes and nanosecond timestamps."
          : captions[phase]}
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
        <p role="status" className="vx-chart-note">
          The renderer could not display the selected data. The exact table
          remains available.
        </p>
      );
    return this.props.children;
  }
}
