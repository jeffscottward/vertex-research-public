import { describe, expect, it } from "vitest";

import type { AssistantToolDefinition } from "../../../packages/api/src/server/assistant-runtime.ts";
import {
  assertCurrentFormat,
  calledTools,
  differingTools,
  type IdentifiedToolList,
  identifyToolList,
  mergeRecording,
  parseCount,
  parseSelection,
  RECORDING_SCHEMA_VERSION,
  type RecordedTrial,
  type Recording,
  selectWitnesses,
  toolVerdicts,
} from "./recording.ts";

// The pure rules of the recorder and of the replay (recording.ts). No database and no model: these
// tests give the failing case of each fault that a partial re-record had before (dropped audit header,
// overwritten model and date), and each case of the tool rule.

const tool = (name: string, description = name): AssistantToolDefinition => ({
  function: { description, name, parameters: { type: "object" } },
  type: "function",
});
/** The list the trials below were recorded with, and three later lists. */
const OLD = identifyToolList([tool("ask"), tool("bars"), tool("notes")]);
const BARS_CHANGED = identifyToolList([
  tool("ask"),
  tool("bars", "bars, also forex"),
  tool("notes"),
]);
const ASK_CHANGED = identifyToolList([
  tool("ask", "ask, new text"),
  tool("bars"),
  tool("notes"),
]);
const REORDERED = identifyToolList([tool("bars"), tool("ask"), tool("notes")]);

const calls = (...names: string[]): RecordedTrial["completions"] => [
  {
    content: "",
    inputDigest: "digest",
    toolCalls: names.map((name, index) => ({
      arguments: "{}",
      id: `call_${index}`,
      name,
    })),
  },
];

const trial = (
  question: string,
  number: number,
  fields: Partial<RecordedTrial> = {}
): RecordedTrial => ({
  answer: `${question}.${number} answer`,
  completions: calls("ask"),
  grade: "correct",
  model: "model-a",
  promptFormat: "prompt-a",
  question,
  recordedAt: `2026-11-1${number}T00:00:00.000Z`,
  toolList: OLD.id,
  tools: [],
  trial: number,
  ...fields,
});

const AUDIT = {
  gradedAt: "2026-11-11T01:00:00.000Z",
  grader: "a grader",
  instructions: "the instructions",
};
const ORDER = ["Q1", "Q2", "H1"];
const existing: Recording = {
  audit: AUDIT,
  note: "the note of the existing file",
  schemaVersion: RECORDING_SCHEMA_VERSION,
  toolLists: { [OLD.id]: OLD.tools },
  trials: [
    trial("Q1", 1, { audit: "correct" }),
    trial("Q1", 2, { audit: "correct" }),
    trial("Q2", 1, { audit: "declined" }),
    trial("H1", 1, { audit: "correct" }),
  ],
};

describe("identifyToolList", () => {
  it("gives each tool the digest of its definition and the list an id that covers the order", () => {
    expect(Object.keys(OLD.tools)).toEqual(["ask", "bars", "notes"]);
    expect(OLD.tools["ask"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(BARS_CHANGED.tools["ask"]).toBe(OLD.tools["ask"]);
    expect(BARS_CHANGED.tools["bars"]).not.toBe(OLD.tools["bars"]);
    expect(REORDERED.tools).toEqual(OLD.tools);
    expect(new Set([OLD.id, BARS_CHANGED.id, REORDERED.id]).size).toBe(3);
  });
});

describe("differingTools", () => {
  it("names a changed, an added and a removed tool, and none for another order", () => {
    expect(differingTools(OLD.tools, BARS_CHANGED.tools)).toEqual(["bars"]);
    expect(
      differingTools(
        OLD.tools,
        identifyToolList([tool("ask"), tool("notes"), tool("zeta")]).tools
      )
    ).toEqual(["bars", "zeta"]);
    expect(differingTools(OLD.tools, REORDERED.tools)).toEqual([]);
  });
});

describe("calledTools", () => {
  it("reads the tool names of every recorded model reply", () => {
    expect([
      ...calledTools({ completions: [...calls("ask", "bars"), ...calls()] }),
    ]).toEqual(["ask", "bars"]);
  });
});

describe("toolVerdicts", () => {
  const verdictsFor = (
    trials: readonly RecordedTrial[],
    current: IdentifiedToolList,
    lists: readonly IdentifiedToolList[] = [OLD, current]
  ) =>
    Object.fromEntries(
      toolVerdicts(
        {
          toolLists: Object.fromEntries(
            lists.map((list) => [list.id, list.tools])
          ),
          trials,
        },
        current
      )
    );

  it("calls a trial of the current list exact", () => {
    expect(verdictsFor(existing.trials, OLD)["Q1.1"]).toEqual({
      state: "exact",
    });
  });

  it("makes a trial stale when a tool that it calls changed or is gone", () => {
    expect(verdictsFor([trial("Q1", 1)], ASK_CHANGED)["Q1.1"]).toEqual({
      reason: "the definition of a tool that the trial calls changed: ask",
      state: "stale",
    });
    expect(
      verdictsFor([trial("Q1", 1)], identifyToolList([tool("bars")]))["Q1.1"]
    ).toMatchObject({ state: "stale" });
  });

  it("asks for a witness when only tools that the trial does not call changed", () => {
    expect(verdictsFor([trial("Q1", 1), trial("Q1", 2)], BARS_CHANGED)).toEqual(
      {
        "Q1.1": {
          differing: ["bars"],
          reason:
            "the tool list changed (bars) and no trial of Q1 was recorded with the current list",
          state: "needs-witness",
        },
        "Q1.2": {
          differing: ["bars"],
          reason:
            "the tool list changed (bars) and no trial of Q1 was recorded with the current list",
          state: "needs-witness",
        },
      }
    );
  });

  it("asks for a witness when only the order of the tools changed", () => {
    expect(verdictsFor([trial("Q1", 1)], REORDERED)["Q1.1"]).toEqual({
      differing: [],
      reason:
        "the tool list changed (the order of the tools) and no trial of Q1 was recorded with the current list",
      state: "needs-witness",
    });
  });

  it("keeps a drifted trial valid while a trial of its question, recorded with the current list, calls no changed tool", () => {
    const verdicts = verdictsFor(
      [
        trial("Q1", 1, { toolList: BARS_CHANGED.id }),
        trial("Q1", 2),
        trial("Q2", 1),
      ],
      BARS_CHANGED
    );
    expect(verdicts["Q1.1"]).toEqual({ state: "exact" });
    expect(verdicts["Q1.2"]).toEqual({
      differing: ["bars"],
      state: "drifted",
      witness: "Q1.1",
    });
    // The witness of another question does not count.
    expect(verdicts["Q2.1"]).toMatchObject({ state: "needs-witness" });
  });

  it("makes a drifted trial stale when every trial of the current list calls a changed tool", () => {
    const verdicts = verdictsFor(
      [
        trial("Q1", 1, {
          completions: calls("ask", "bars"),
          toolList: BARS_CHANGED.id,
        }),
        trial("Q1", 2),
      ],
      BARS_CHANGED
    );
    expect(verdicts["Q1.2"]).toEqual({
      reason:
        "the tool list changed (bars) and every trial of Q1 recorded with the current list calls a changed tool",
      state: "stale",
    });
  });

  it("takes as witness only a trial that the caller accepts (the replay passes: it replays unchanged)", () => {
    const trials = [
      trial("Q1", 1, { toolList: BARS_CHANGED.id }),
      trial("Q1", 2),
    ];
    const verdicts = toolVerdicts(
      {
        toolLists: {
          [OLD.id]: OLD.tools,
          [BARS_CHANGED.id]: BARS_CHANGED.tools,
        },
        trials,
      },
      BARS_CHANGED,
      () => false
    );
    expect(verdicts.get("Q1.2")).toMatchObject({ state: "needs-witness" });
  });

  it("judges each drifted trial by its own tool list", () => {
    // Q1.2 saw OLD, Q1.3 saw the list with the changed `bars`; the current list also changed `notes`.
    const current = identifyToolList([
      tool("ask"),
      tool("bars", "bars, also forex"),
      tool("notes", "notes, new text"),
    ]);
    const verdicts = verdictsFor(
      [
        trial("Q1", 1, { toolList: current.id }),
        trial("Q1", 2),
        trial("Q1", 3, { toolList: BARS_CHANGED.id }),
      ],
      current,
      [OLD, BARS_CHANGED, current]
    );
    expect(verdicts["Q1.2"]).toMatchObject({ differing: ["bars", "notes"] });
    expect(verdicts["Q1.3"]).toMatchObject({ differing: ["notes"] });
  });

  it("makes a trial stale when the recording does not hold its tool list (a version 2 trial)", () => {
    const { toolList: _toolList, ...versionTwo } = trial("Q1", 1);
    const verdicts = toolVerdicts(
      { trials: [versionTwo as RecordedTrial] },
      OLD
    );
    expect(verdicts.get("Q1.1")).toMatchObject({ state: "stale" });
    expect(
      verdictsFor([trial("Q1", 1, { toolList: "not in the header" })], OLD)[
        "Q1.1"
      ]
    ).toMatchObject({ state: "stale" });
  });
});

describe("selectWitnesses", () => {
  const trials = [
    trial("Q1", 1, { recordedAt: "2026-11-20T00:00:00.000Z" }),
    trial("Q1", 2, { recordedAt: "2026-11-12T00:00:00.000Z" }),
    trial("Q1", 3, { recordedAt: "2026-11-12T00:00:00.000Z" }),
    trial("Q2", 1),
    trial("Q2", 2),
    trial("H1", 1, { toolList: BARS_CHANGED.id }),
    trial("H1", 2),
  ];
  const verdicts = toolVerdicts(
    {
      toolLists: {
        [OLD.id]: OLD.tools,
        [BARS_CHANGED.id]: BARS_CHANGED.tools,
      },
      trials,
    },
    BARS_CHANGED
  );

  it("takes for each question without a trial of the current list its oldest trial, then the lowest number", () => {
    expect(selectWitnesses(trials, verdicts, new Set())).toEqual([
      "Q1.2",
      "Q2.1",
    ]);
  });

  it("takes none for a question that the run records anyway", () => {
    expect(selectWitnesses(trials, verdicts, new Set(["Q1.3"]))).toEqual([
      "Q2.1",
    ]);
  });
});

describe("mergeRecording", () => {
  it("keeps the audit header on a partial run and writes the current note", () => {
    const merged = mergeRecording(
      existing,
      [trial("Q2", 1, { model: "model-b" })],
      [OLD],
      ORDER,
      "a new note"
    );
    expect(merged["audit"]).toEqual(AUDIT);
    expect(merged["note"]).toBe("a new note");
    expect(Object.keys(merged)).toEqual([
      "audit",
      "note",
      "schemaVersion",
      "toolLists",
      "trials",
    ]);
  });

  it("replaces only the recorded trials; the others keep model, date and audit grade", () => {
    const recorded = trial("Q1", 2, {
      answer: "new answer",
      model: "model-b",
      recordedAt: "2026-11-15T00:00:00.000Z",
    });
    const merged = mergeRecording(existing, [recorded], [OLD], ORDER, "note");
    expect(merged.trials).toEqual([
      existing.trials[0],
      recorded,
      existing.trials[2],
      existing.trials[3],
    ]);
    // The trial recorded again has no audit grade: the replay test fails until it is graded again.
    expect(merged.trials[1]).not.toHaveProperty("audit");
  });

  it("sorts by question order, then trial; a full run on no file writes the note", () => {
    const merged = mergeRecording(
      undefined,
      [trial("H1", 1), trial("Q2", 2), trial("Q1", 1), trial("Q2", 1)],
      [OLD],
      ORDER,
      "the note"
    );
    expect(
      merged.trials.map((entry) => `${entry.question}.${entry.trial}`)
    ).toEqual(["Q1.1", "Q2.1", "Q2.2", "H1.1"]);
    expect(merged["note"]).toBe("the note");
    expect(merged).not.toHaveProperty("audit");
    expect(merged.schemaVersion).toBe(RECORDING_SCHEMA_VERSION);
  });

  it("keeps a trial of a question that is not in the question list, after the known ones", () => {
    const merged = mergeRecording(
      { ...existing, trials: [trial("X9", 1), ...existing.trials] },
      [],
      [],
      ORDER,
      "note"
    );
    expect(merged.trials.at(-1)?.question).toBe("X9");
    expect(merged.trials).toHaveLength(5);
  });

  it("adds the tool list of a new trial and drops a list that no trial names any more", () => {
    const added = mergeRecording(
      existing,
      [trial("Q2", 1, { toolList: BARS_CHANGED.id })],
      [BARS_CHANGED],
      ORDER,
      "note"
    );
    expect(added.toolLists).toEqual({
      [OLD.id]: OLD.tools,
      [BARS_CHANGED.id]: BARS_CHANGED.tools,
    });
    const replacedAll = mergeRecording(
      { ...added, trials: [trial("Q2", 1, { toolList: BARS_CHANGED.id })] },
      [],
      [],
      ORDER,
      "note"
    );
    expect(Object.keys(replacedAll.toolLists)).toEqual([BARS_CHANGED.id]);
  });
});

describe("parseSelection", () => {
  it("reads no selector as every question", () => {
    expect(parseSelection([], ORDER)).toEqual({ kind: "all" });
  });

  it("reads question ids", () => {
    expect(parseSelection(["Q2", "H1"], ORDER)).toEqual({
      ids: ["Q2", "H1"],
      kind: "questions",
    });
  });

  it("reads the words stale and upgrade, each alone", () => {
    expect(parseSelection(["stale"], ORDER)).toEqual({ kind: "stale" });
    expect(parseSelection(["upgrade"], ORDER)).toEqual({ kind: "upgrade" });
    expect(() => parseSelection(["stale", "Q1"], ORDER)).toThrow(
      "cannot be combined"
    );
    expect(() => parseSelection(["upgrade", "stale"], ORDER)).toThrow(
      "cannot be combined"
    );
  });

  it("refuses an unknown question id", () => {
    expect(() => parseSelection(["Q1", "Q99"], ORDER)).toThrow(
      "Unknown question id: Q99"
    );
  });
});

describe("parseCount", () => {
  it("reads a positive whole number and gives the default when the argument is absent", () => {
    expect(parseCount("trials", "3", 9)).toBe(3);
    expect(parseCount("trials", undefined, 9)).toBe(9);
  });

  it("refuses a word, zero, a negative number, a fraction and other number notations", () => {
    for (const value of [
      "stale",
      "0",
      "-1",
      "1.5",
      "",
      "1e2",
      "0x10",
      "3.0",
      " 3",
    ]) {
      expect(() => parseCount("trials", value, 3), value).toThrow(
        "The trials argument must be a positive whole number"
      );
    }
  });
});

describe("assertCurrentFormat", () => {
  it("accepts a recording of the current version", () => {
    expect(() => assertCurrentFormat(existing)).not.toThrow();
  });

  it("refuses a version 2 recording and names the upgrade", () => {
    expect(() =>
      assertCurrentFormat({ ...existing, schemaVersion: 2 })
    ).toThrow("schemaVersion 2, not 3. Run the recorder with `upgrade` first");
  });
});
