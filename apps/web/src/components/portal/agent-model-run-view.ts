import type {
  AgentModelRunEventOutput,
  AgentModelRunEventsOutput,
  AgentModelRunOutput,
} from "@darkfactory/api";

// Live view and replay of one model run. A small explicit reducer (feature-local): the run is "live"
// while the server may still add events and "replay" once it reports done. The position is the index
// of the last event shown; the agent cards and the timeline show events up to it.

export const LIVE_POLL_MS = 2000;
export const REPLAY_SPEEDS = [1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export type RunEventPage = Pick<
  AgentModelRunEventsOutput,
  "done" | "events" | "nextSeq" | "run"
>;

export type RunViewState = Readonly<{
  run: AgentModelRunOutput;
  events: readonly AgentModelRunEventOutput[];
  nextSeq: number;
  mode: "live" | "replay";
  position: number;
  follow: boolean;
  playing: boolean;
  speed: ReplaySpeed;
}>;

export type RunViewAction =
  | Readonly<{ type: "appended"; page: RunEventPage }>
  | Readonly<{ type: "pause" }>
  | Readonly<{ type: "play" }>
  | Readonly<{ type: "step"; by: 1 | -1 }>
  | Readonly<{ type: "seek"; position: number }>
  | Readonly<{ type: "speed"; speed: ReplaySpeed }>
  | Readonly<{ type: "tick" }>
  | Readonly<{ type: "scrolledAway" }>;

export const isFinishedStatus = (status: AgentModelRunOutput["status"]) =>
  status === "succeeded" || status === "failed" || status === "cancelled";

export const initRunView = (page: RunEventPage): RunViewState => ({
  events: page.events,
  follow: !page.done,
  mode: page.done ? "replay" : "live",
  nextSeq: page.nextSeq,
  playing: false,
  position: page.events.length - 1,
  run: page.run,
  speed: 1,
});

const clampPosition = (state: RunViewState, position: number): number =>
  Math.min(Math.max(position, 0), state.events.length - 1);

const atEnd = (state: RunViewState): boolean =>
  state.position >= state.events.length - 1;

export const runViewReducer = (
  state: RunViewState,
  action: RunViewAction
): RunViewState => {
  switch (action.type) {
    case "appended": {
      // Only events after the newest one shown are added; a repeated page changes nothing.
      const lastSeq = state.events.at(-1)?.seq ?? -1;
      const events = [
        ...state.events,
        ...action.page.events.filter((event) => event.seq > lastSeq),
      ];
      const following = state.mode === "live" && state.follow;
      const done = action.page.done;
      return {
        ...state,
        events,
        follow: following && !done,
        mode: done ? "replay" : state.mode,
        nextSeq: action.page.nextSeq,
        playing: done ? false : state.playing,
        position: following ? events.length - 1 : state.position,
        run: action.page.run,
      };
    }
    case "pause":
      return { ...state, follow: false, playing: false };
    case "play":
      if (state.mode === "live")
        return { ...state, follow: true, position: state.events.length - 1 };
      // Playing from the last event starts the replay again from the first one.
      return {
        ...state,
        playing: state.events.length > 0,
        position: atEnd(state) ? 0 : state.position,
      };
    case "step":
      return {
        ...state,
        follow: false,
        playing: false,
        position: clampPosition(state, state.position + action.by),
      };
    case "seek":
      return {
        ...state,
        follow: false,
        playing: false,
        position: clampPosition(state, action.position),
      };
    case "speed":
      return { ...state, speed: action.speed };
    case "tick": {
      if (!state.playing) return state;
      const position = clampPosition(state, state.position + 1);
      return {
        ...state,
        playing: position < state.events.length - 1,
        position,
      };
    }
    case "scrolledAway":
      return { ...state, follow: false };
  }
};

export const AGENT_PHASE_LABELS = {
  done: "Done",
  reading: "Reading data",
  thinking: "Thinking",
  writing: "Writing",
} as const;
export type AgentPhase = keyof typeof AGENT_PHASE_LABELS;

export type AgentCard = Readonly<{
  agent: string;
  llmCalls: number;
  toolCalls: number;
  tokens: number;
  costUsd: number;
  phase: AgentPhase;
  line: string;
}>;

const LINE_MAX = 200;
const textOf = (event: AgentModelRunEventOutput): string =>
  event.body ?? event.title;

// The end of a long text (the newest reasoning) or its start (a conclusion), on one line.
export const tailLine = (text: string): string => {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length <= LINE_MAX ? flat : `…${flat.slice(-LINE_MAX)}`;
};
export const headLine = (text: string): string => {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length <= LINE_MAX ? flat : `${flat.slice(0, LINE_MAX)}…`;
};

const phaseOf = (
  events: readonly AgentModelRunEventOutput[],
  finished: boolean
): AgentPhase => {
  const last = events.at(-1);
  if (finished || last?.kind === "decision") return "done";
  let open = 0;
  for (const event of events) {
    if (event.kind === "tool_call") open += 1;
    if (event.kind === "tool_result") open = Math.max(open - 1, 0);
  }
  if (open > 0) return "reading";
  if (last?.kind === "llm_call" || last?.kind === "message") return "writing";
  return "thinking";
};

// One card per agent in order of first appearance, from the events up to `position`. `finished`:
// the run ended and the position is at its last event.
export const agentCards = (
  events: readonly AgentModelRunEventOutput[],
  position: number,
  finished: boolean
): AgentCard[] => {
  const byAgent = new Map<string, AgentModelRunEventOutput[]>();
  for (const event of events.slice(0, position + 1)) {
    const list = byAgent.get(event.agent) ?? [];
    list.push(event);
    byAgent.set(event.agent, list);
  }
  return [...byAgent].map(([agent, list]) => {
    const phase = phaseOf(list, finished);
    const conclusion = list.findLast(
      (event) => event.kind === "decision" || event.kind === "message"
    );
    const reasoning = list.findLast((event) => event.kind === "reasoning");
    const fallback = list.at(-1) as AgentModelRunEventOutput;
    const line =
      phase === "done"
        ? headLine(textOf(conclusion ?? fallback))
        : tailLine(textOf(reasoning ?? fallback));
    return {
      agent,
      costUsd: list.reduce((sum, event) => sum + (event.costUsd ?? 0), 0),
      line,
      llmCalls: list.filter((event) => event.kind === "llm_call").length,
      phase,
      tokens: list.reduce(
        (sum, event) =>
          sum + (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
        0
      ),
      toolCalls: list.filter((event) => event.kind === "tool_call").length,
    };
  });
};
