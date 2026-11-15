import { describe, expect, it } from "vitest";

import {
  assertTrialsHaveModelAndDate,
  mergeRecording,
  parseCount,
  parseSelection,
  RECORDING_SCHEMA_VERSION,
  type RecordedTrial,
  type Recording,
} from "./recording.ts";

// The recorder's two pure rules (recording.ts). No database and no model: these tests give the failing
// case of each fault that a partial re-record had before (dropped audit header, overwritten model and date).

const trial = (
  question: string,
  number: number,
  fields: Partial<RecordedTrial> = {}
): RecordedTrial => ({
  answer: `${question}.${number} answer`,
  completions: [],
  grade: "correct",
  model: "model-a",
  question,
  recordedAt: "2026-11-11T00:00:00.000Z",
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
  trials: [
    trial("Q1", 1, { audit: "correct" }),
    trial("Q1", 2, { audit: "correct" }),
    trial("Q2", 1, { audit: "declined" }),
    trial("H1", 1, { audit: "correct" }),
  ],
};

describe("mergeRecording", () => {
  it("keeps the audit header on a partial run and writes the current note", () => {
    const merged = mergeRecording(
      existing,
      [trial("Q2", 1, { model: "model-b" })],
      ORDER,
      "a new note"
    );
    expect(merged["audit"]).toEqual(AUDIT);
    expect(merged["note"]).toBe("a new note");
    expect(Object.keys(merged)).toEqual([
      "audit",
      "note",
      "schemaVersion",
      "trials",
    ]);
  });

  it("replaces only the recorded trials; the others keep model, date and audit grade", () => {
    const recorded = trial("Q1", 2, {
      answer: "new answer",
      model: "model-b",
      recordedAt: "2026-11-15T00:00:00.000Z",
    });
    const merged = mergeRecording(existing, [recorded], ORDER, "note");
    expect(merged.trials).toEqual([
      existing.trials[0],
      recorded,
      existing.trials[2],
      existing.trials[3],
    ]);
    // The trial recorded again has no audit grade: the replay test fails until it is graded again.
    expect(merged.trials[1]).not.toHaveProperty("audit");
  });

  it("moves no model or date into the header, and drops the ones of a version 1 file", () => {
    const versionOne = {
      ...existing,
      model: "omp-completion",
      recordedAt: "2026-11-15T06:13:20.256Z",
      schemaVersion: 1,
    };
    const merged = mergeRecording(versionOne, [trial("Q2", 1)], ORDER, "note");
    expect(merged).not.toHaveProperty("model");
    expect(merged).not.toHaveProperty("recordedAt");
    expect(merged.schemaVersion).toBe(RECORDING_SCHEMA_VERSION);
    expect(merged["audit"]).toEqual(AUDIT);
  });

  it("sorts by question order, then trial; a full run on no file writes the note", () => {
    const merged = mergeRecording(
      undefined,
      [trial("H1", 1), trial("Q2", 2), trial("Q1", 1), trial("Q2", 1)],
      ORDER,
      "the note"
    );
    expect(
      merged.trials.map((entry) => `${entry.question}.${entry.trial}`)
    ).toEqual(["Q1.1", "Q2.1", "Q2.2", "H1.1"]);
    expect(merged["note"]).toBe("the note");
    expect(merged).not.toHaveProperty("audit");
  });

  it("keeps a trial of a question that is not in the question list, after the known ones", () => {
    const merged = mergeRecording(
      { ...existing, trials: [trial("X9", 1), ...existing.trials] },
      [],
      ORDER,
      "note"
    );
    expect(merged.trials.at(-1)?.question).toBe("X9");
    expect(merged.trials).toHaveLength(5);
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

  it("reads the word stale, alone", () => {
    expect(parseSelection(["stale"], ORDER)).toEqual({ kind: "stale" });
    expect(() => parseSelection(["stale", "Q1"], ORDER)).toThrow(
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

describe("assertTrialsHaveModelAndDate", () => {
  it("accepts a recording in which every trial has a model and a date", () => {
    expect(() => assertTrialsHaveModelAndDate(existing)).not.toThrow();
  });

  it("refuses a version 1 recording: its trials have no model and no date of their own", () => {
    const { model: _model, recordedAt: _recordedAt, ...bare } = trial("Q2", 1);
    const versionOne = {
      ...existing,
      model: "omp-completion",
      recordedAt: "2026-11-15T06:13:20.256Z",
      schemaVersion: 1,
      trials: [existing.trials[0], bare],
    } as unknown as Recording;
    expect(() => assertTrialsHaveModelAndDate(versionOne)).toThrow(
      "1 trials with no model or recordedAt of their own (first: Q2.1)"
    );
  });
});
