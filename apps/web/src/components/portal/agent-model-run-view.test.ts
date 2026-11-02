import type {
  AgentModelRunEventOutput,
  AgentModelRunOutput,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  agentCards,
  headLine,
  initRunView,
  isFinishedStatus,
  type RunEventPage,
  runViewReducer,
  tailLine,
} from "./agent-model-run-view.ts";

const at = new Date("2026-10-01T12:00:00.000Z");
const run = (status: AgentModelRunOutput["status"]) =>
  ({ id: "run-1", status }) as AgentModelRunOutput;

const event = (
  seq: number,
  overrides: Partial<AgentModelRunEventOutput> = {}
): AgentModelRunEventOutput => ({
  agent: "Market Analyst",
  at,
  body: null,
  costUsd: null,
  durationMs: null,
  id: `e-${seq}`,
  inputTokens: null,
  kind: "reasoning",
  model: null,
  outputTokens: null,
  runId: "run-1",
  seq,
  title: `event ${seq}`,
  toolName: null,
  ...overrides,
});

const page = (
  events: AgentModelRunEventOutput[],
  done: boolean,
  status: AgentModelRunOutput["status"] = done ? "succeeded" : "running"
): RunEventPage => ({
  done,
  events,
  nextSeq: events.at(-1)?.seq ?? -1,
  run: run(status),
});

describe("run view reducer", () => {
  it("starts live and follows new events, ignoring repeats", () => {
    const live = initRunView(page([event(0)], false));
    expect(live).toMatchObject({ follow: true, mode: "live", position: 0 });
    const next = runViewReducer(live, {
      page: page([event(0), event(1), event(2)], false),
      type: "appended",
    });
    expect(next.events.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(next).toMatchObject({ follow: true, nextSeq: 2, position: 2 });
    const empty = runViewReducer(initRunView(page([], false)), {
      page: page([event(0)], false),
      type: "appended",
    });
    expect(empty.position).toBe(0);
  });

  it("keeps the position while paused and switches to replay when done", () => {
    const paused = runViewReducer(initRunView(page([event(0)], false)), {
      type: "pause",
    });
    expect(paused).toMatchObject({ follow: false, playing: false });
    const appended = runViewReducer(paused, {
      page: page([event(1)], false),
      type: "appended",
    });
    expect(appended.position).toBe(0);
    const done = runViewReducer(appended, {
      page: page([event(2)], true),
      type: "appended",
    });
    expect(done).toMatchObject({
      follow: false,
      mode: "replay",
      playing: false,
      position: 0,
    });
    expect(done.run.status).toBe("succeeded");
    const scrolled = runViewReducer(initRunView(page([event(0)], false)), {
      type: "scrolledAway",
    });
    expect(scrolled.follow).toBe(false);
    const resumed = runViewReducer(
      runViewReducer(scrolled, {
        page: page([event(1)], false),
        type: "appended",
      }),
      { type: "play" }
    );
    expect(resumed).toMatchObject({ follow: true, position: 1 });
  });

  it("replays from the start, steps, seeks, changes speed and stops at the end", () => {
    const replay = initRunView(page([event(0), event(1), event(2)], true));
    expect(replay).toMatchObject({
      mode: "replay",
      playing: false,
      position: 2,
    });
    const playing = runViewReducer(replay, { type: "play" });
    expect(playing).toMatchObject({ playing: true, position: 0 });
    const ticked = runViewReducer(playing, { type: "tick" });
    expect(ticked).toMatchObject({ playing: true, position: 1 });
    const end = runViewReducer(ticked, { type: "tick" });
    expect(end).toMatchObject({ playing: false, position: 2 });
    expect(runViewReducer(end, { type: "tick" })).toBe(end);
    const middle = runViewReducer(end, { position: 1, type: "seek" });
    expect(runViewReducer(middle, { type: "play" }).position).toBe(1);
    expect(runViewReducer(middle, { by: -1, type: "step" }).position).toBe(0);
    expect(
      runViewReducer(runViewReducer(middle, { by: -1, type: "step" }), {
        by: -1,
        type: "step",
      }).position
    ).toBe(0);
    expect(runViewReducer(end, { by: 1, type: "step" }).position).toBe(2);
    expect(runViewReducer(end, { position: 99, type: "seek" }).position).toBe(
      2
    );
    expect(runViewReducer(end, { speed: 4, type: "speed" }).speed).toBe(4);
    const nothing = initRunView(page([], true));
    expect(runViewReducer(nothing, { type: "play" }).playing).toBe(false);
    const appendedInReplay = runViewReducer(replay, {
      page: page([event(3)], true),
      type: "appended",
    });
    expect(appendedInReplay).toMatchObject({ mode: "replay", position: 2 });
  });

  it("tells finished statuses apart", () => {
    expect(isFinishedStatus("failed")).toBe(true);
    expect(isFinishedStatus("cancelled")).toBe(true);
    expect(isFinishedStatus("succeeded")).toBe(true);
    expect(isFinishedStatus("queued")).toBe(false);
  });
});

describe("agent cards", () => {
  const events = [
    event(0, {
      agent: "Market Analyst",
      kind: "tool_call",
      title: "get_stock_data",
    }),
    event(1, {
      agent: "News Analyst",
      body: "Earnings beat by 4 percent.",
      costUsd: 0.01,
      inputTokens: 100,
      kind: "llm_call",
      outputTokens: 50,
    }),
    event(2, { agent: "Market Analyst", kind: "tool_result", title: "bars" }),
    event(3, {
      agent: "Market Analyst",
      body: "RSI is oversold.",
      kind: "reasoning",
    }),
    event(4, { agent: "Trader", kind: "message", title: "Drafting the plan" }),
    event(5, { agent: "Trader", body: "Overweight AAPL.", kind: "decision" }),
    event(6, { agent: "Risk Manager", kind: "status", title: "started" }),
  ];

  it("shows one card per agent with counts and a phase at the position", () => {
    const early = agentCards(events, 0, false);
    expect(early).toEqual([
      expect.objectContaining({
        agent: "Market Analyst",
        line: "get_stock_data",
        phase: "reading",
        toolCalls: 1,
      }),
    ]);
    const cards = agentCards(events, 6, false);
    expect(cards.map((card) => [card.agent, card.phase, card.line])).toEqual([
      ["Market Analyst", "thinking", "RSI is oversold."],
      ["News Analyst", "writing", "Earnings beat by 4 percent."],
      ["Trader", "done", "Overweight AAPL."],
      ["Risk Manager", "thinking", "started"],
    ]);
    expect(cards[1]).toMatchObject({ costUsd: 0.01, llmCalls: 1, tokens: 150 });
    expect(agentCards(events, 4, false)[2]).toMatchObject({
      line: "Drafting the plan",
      phase: "writing",
    });
    const finished = agentCards(events, 6, true);
    expect(finished.every((card) => card.phase === "done")).toBe(true);
    expect(finished[0]?.line).toBe("RSI is oversold.");
  });

  it("cuts long lines at the right end", () => {
    const long = `${"a".repeat(150)} ${"b".repeat(150)}`;
    expect(tailLine(long)).toBe(`…${long.slice(-200)}`);
    expect(headLine(long)).toBe(`${long.slice(0, 200)}…`);
    expect(tailLine("  short\n text ")).toBe("short text");
    expect(headLine("short")).toBe("short");
  });
});
