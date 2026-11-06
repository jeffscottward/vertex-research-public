"use client";

import {
  BAR_REPLAY_IDLE,
  type BarReplayAction,
  type BarReplayState,
  barReplayReducer,
  REPLAY_SPEEDS,
  type ReplaySpeed,
} from "@darkfactory/api";
import { type Dispatch, useEffect, useId, useMemo, useReducer } from "react";

import type { ChartMarker, DisplayCandle } from "./types.ts";

// Bar-by-bar replay for the charts page: hides bars after the cursor and reveals them one by one.
// One tick per second at 1x; speed multiplies the rate.
const BASE_TICK_MS = 1000;

const useBarReplay = (
  total: number
): readonly [BarReplayState, Dispatch<BarReplayAction>] => {
  const [state, dispatch] = useReducer(barReplayReducer, BAR_REPLAY_IDLE);
  useEffect(() => dispatch({ total, type: "resize" }), [total]);
  useEffect(() => {
    if (!state.playing) return;
    const timer = setInterval(
      () => dispatch({ type: "tick" }),
      BASE_TICK_MS / state.speed
    );
    return () => clearInterval(timer);
  }, [state.playing, state.speed]);
  return [state, dispatch];
};

const NO_CANDLES: readonly DisplayCandle[] = [];

// The candles and markers the chart shows: all of them, or those up to the replay cursor.
export const useBarReplayView = (
  display: Readonly<{ candles: readonly DisplayCandle[] }> | null,
  markers: readonly ChartMarker[]
) => {
  const candles = display?.candles ?? NO_CANDLES;
  const [state, dispatch] = useBarReplay(candles.length);
  const shown = useMemo(
    () => (state.active ? candles.slice(0, state.index + 1) : candles),
    [candles, state.active, state.index]
  );
  const end = shown.at(-1)?.timestamp;
  const shownMarkers = useMemo(
    () =>
      state.active && end !== undefined
        ? markers.filter((marker) => marker.timestamp <= end)
        : markers,
    [markers, state.active, end]
  );
  const label =
    end === undefined ? "" : new Date(end).toISOString().replace(".000Z", "Z");
  return { candles: shown, dispatch, label, markers: shownMarkers, state };
};

const BUTTON = "min-h-11 min-w-11 rounded-md border px-3 text-sm";

export const BarReplayControls = ({
  dispatch,
  label,
  state,
  total,
}: Readonly<{
  dispatch: Dispatch<BarReplayAction>;
  label: string;
  state: BarReplayState;
  total: number;
}>) => {
  const sliderId = useId();
  const speedId = useId();
  if (!state.active)
    return (
      <section aria-label="Bar replay" className="flex items-center gap-3">
        <button
          className={BUTTON}
          disabled={total < 2}
          onClick={() => dispatch({ total, type: "start" })}
          type="button"
        >
          Start bar replay
        </button>
      </section>
    );
  return (
    <section
      aria-label="Bar replay"
      className="flex flex-wrap items-center gap-3 rounded-md border p-2"
    >
      <button
        className={BUTTON}
        disabled={state.index <= 0}
        onClick={() => dispatch({ by: -1, type: "step" })}
        type="button"
      >
        Step back
      </button>
      {state.playing ? (
        <button
          className={BUTTON}
          onClick={() => dispatch({ type: "pause" })}
          type="button"
        >
          Pause
        </button>
      ) : (
        <button
          className={BUTTON}
          disabled={state.index >= state.total - 1}
          onClick={() => dispatch({ type: "play" })}
          type="button"
        >
          Play
        </button>
      )}
      <button
        className={BUTTON}
        disabled={state.index >= state.total - 1}
        onClick={() => dispatch({ by: 1, type: "step" })}
        type="button"
      >
        Step forward
      </button>
      <label className="sr-only" htmlFor={sliderId}>
        Replay position
      </label>
      <input
        className="min-h-11 min-w-40 flex-1"
        id={sliderId}
        max={state.total - 1}
        min={0}
        onChange={(event) =>
          dispatch({ index: Number(event.target.value), type: "seek" })
        }
        type="range"
        value={state.index}
      />
      <label className="flex items-center gap-2 text-sm" htmlFor={speedId}>
        Speed
        <select
          className="min-h-11 rounded-md border bg-background px-2"
          id={speedId}
          onChange={(event) =>
            dispatch({
              speed: Number(event.target.value) as ReplaySpeed,
              type: "speed",
            })
          }
          value={state.speed}
        >
          {REPLAY_SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {speed}x
            </option>
          ))}
        </select>
      </label>
      <button
        className={BUTTON}
        onClick={() => dispatch({ type: "stop" })}
        type="button"
      >
        Exit replay
      </button>
      <span aria-live="polite" className="text-muted-foreground text-sm">
        Bar {state.index + 1} of {state.total}: {label}
      </span>
    </section>
  );
};
