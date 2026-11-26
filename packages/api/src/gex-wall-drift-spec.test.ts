import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GEX_WALL_DRIFT_RULES,
  gradeGexWallDrift,
} from "./gex-wall-drift-rules.ts";

// The pre-registered study embeds the rules object and golden cases; a rule change without a new
// spec fails here.
const SPEC = readFileSync(
  new URL(
    "../../../docs/specs/strategies/gex-wall-drift-confluence.md",
    import.meta.url
  ),
  "utf8"
);

const jsonBlockAfter = (heading: string): unknown => {
  const section = SPEC.slice(SPEC.indexOf(`\n${heading}\n`));
  return JSON.parse(/```json\n([\s\S]*?)\n```/u.exec(section)?.[1] ?? "null");
};

type GoldenCase = Readonly<{
  price: number;
  flip: number | null;
  call: number;
  put: number;
  read: string;
  code: string | null;
}>;

const NOW = new Date("2026-11-25T15:00:00.000Z");
const ago = (minutes: number): string =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe("gex-wall-drift-confluence spec", () => {
  it("embeds exactly GEX_WALL_DRIFT_RULES", () => {
    expect(jsonBlockAfter("## Rules")).toEqual({ ...GEX_WALL_DRIFT_RULES });
    expect(SPEC).toContain(`Rules version \`${GEX_WALL_DRIFT_RULES.version}\``);
  });

  it("matches every golden case", () => {
    const cases = jsonBlockAfter("## Golden cases") as readonly GoldenCase[];
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const golden of cases) {
      const read = gradeGexWallDrift({
        drift: {
          kind: "series",
          points: Array.from({ length: 16 }, (_, index) => ({
            minute: ago(17 - index),
            total: {
              netCallPremiumUsd: index * golden.call,
              netPutPremiumUsd: index * golden.put,
            },
            underlyingPrice: golden.price,
          })),
          ticker: "SPX",
        },
        levels: {
          at: ago(10),
          callWall: 610,
          flip: golden.flip,
          kind: "levels",
          putWall: 600,
          source: "flow_gex",
          spot: 600.4,
          ticker: "SPX",
        },
        now: NOW,
      });
      expect(
        { code: read.code, read: read.read },
        JSON.stringify(golden)
      ).toEqual({
        code: golden.code,
        read: golden.read,
      });
    }
  });
});
