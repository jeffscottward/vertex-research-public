import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type HistoryAnswerMode,
  parseHistoryBarsAnswer,
} from "./history-answer.ts";

const FIXTURES = new URL("../fixtures/history-answers/", import.meta.url);

const ReaderExpectationSchema = z.discriminatedUnion("accepted", [
  z
    .object({
      accepted: z.literal(true),
      volumes: z.array(z.number().nullable()),
    })
    .strict(),
  z.object({ accepted: z.literal(false) }).strict(),
]);

const ExpectedSchema = z
  .object({
    _doc: z.string(),
    cases: z.record(
      z.string(),
      z
        .object({
          charts: ReaderExpectationSchema,
          v2only: ReaderExpectationSchema,
        })
        .strict()
    ),
  })
  .strict();

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));

const expected = ExpectedSchema.parse(readJson("expected.json"));
const answerFiles = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".json") && name !== "expected.json")
  .sort();

// expected.json names the readers; "charts" is market-data.ts, "v2only" is ibkr-history.ts.
const MODES: ReadonlyArray<readonly ["charts" | "v2only", HistoryAnswerMode]> =
  [
    ["charts", "v1-or-v2"],
    ["v2only", "v2-only"],
  ];

const v2Answer = (): Record<string, unknown> => {
  const raw = readJson("bars-v2-stk-usd.json");
  if (typeof raw !== "object" || raw === null) throw new Error("bad fixture");
  return { ...raw };
};

describe("parseHistoryBarsAnswer: shared sample answers", () => {
  it("expected.json lists every sample answer and no other", () => {
    expect(answerFiles.length).toBeGreaterThan(0);
    expect(Object.keys(expected.cases).sort()).toEqual(
      answerFiles.map((name) => name.replace(/\.json$/, ""))
    );
  });

  for (const file of answerFiles) {
    const name = file.replace(/\.json$/, "");
    for (const [reader, mode] of MODES) {
      it(`${name} in ${mode} mode matches expected.json "${reader}"`, () => {
        const want = expected.cases[name]?.[reader];
        if (want === undefined) throw new Error(`no expectation for ${name}`);
        const answer = parseHistoryBarsAnswer(readJson(file), mode);
        if (!want.accepted) {
          expect(answer).toBeNull();
          return;
        }
        expect(answer).not.toBeNull();
        expect(answer?.bars.map((bar) => bar.v)).toEqual(want.volumes);
      });
    }
  }
});

describe("parseHistoryBarsAnswer: schema", () => {
  it("returns the fields of a v2 answer with the volume unit", () => {
    const answer = parseHistoryBarsAnswer(v2Answer(), "v2-only");
    expect(answer).toMatchObject({
      asOf: "2026-11-19T00:00:00Z",
      count: 3,
      fetchedAt: "2026-11-20T02:30:00Z",
      schema: "vertex-history-bars-v2",
      source: "ibkr-gateway",
      volumeUnit: "shares",
    });
    expect(answer?.request.secType).toBe("STK");
    expect(answer?.cache.stale).toBe(false);
  });

  it("refuses a v2 answer without volume_unit", () => {
    const { volume_unit: _unit, ...raw } = v2Answer();
    expect(parseHistoryBarsAnswer(raw, "v1-or-v2")).toBeNull();
  });

  it("refuses an unknown volume unit", () => {
    expect(
      parseHistoryBarsAnswer({ ...v2Answer(), volume_unit: "lots" }, "v2-only")
    ).toBeNull();
  });

  it("refuses a v1 answer that carries volume_unit (strict v1)", () => {
    const raw = { ...v2Answer(), schema: "vertex-history-bars-v1" };
    expect(parseHistoryBarsAnswer(raw, "v1-or-v2")).toBeNull();
  });

  it("refuses an unknown key, an unknown schema and a count mismatch", () => {
    expect(
      parseHistoryBarsAnswer({ ...v2Answer(), extra: 1 }, "v2-only")
    ).toBeNull();
    expect(
      parseHistoryBarsAnswer(
        { ...v2Answer(), schema: "vertex-history-bars-v3" },
        "v1-or-v2"
      )
    ).toBeNull();
    expect(parseHistoryBarsAnswer({ ...v2Answer(), count: 2 }, "v2-only")).toBe(
      null
    );
  });
});
