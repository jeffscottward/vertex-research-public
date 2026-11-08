import { describe, expect, it, vi } from "vitest";

import type { DatabaseExecutor } from "../server/client.ts";

const upsert = vi.hoisted(() => vi.fn(async (_play: unknown) => ({})));
vi.mock("../server/plays-repository.ts", () => ({
  createPlaysRepository: () => ({ upsert }),
}));

import { convergeDevelopmentPlays, DEVELOPMENT_PLAYS } from "./plays.ts";

describe("development plays seed", () => {
  it("uses only clearly fake tickers with defined risk", () => {
    expect(DEVELOPMENT_PLAYS.length).toBeGreaterThan(0);
    for (const play of DEVELOPMENT_PLAYS) {
      expect(play.id).toMatch(/^seed-play-/u);
      expect(play.thesis).toMatch(/^FAKE/u);
      expect(Number(play.maxLossUsd)).toBeGreaterThan(0);
      for (const leg of play.legs) expect(leg.expiry).toMatch(/^2099-/u);
    }
  });

  it("upserts every seed play", async () => {
    await convergeDevelopmentPlays({} as DatabaseExecutor);
    expect(upsert.mock.calls.map(([play]) => play)).toEqual([
      ...DEVELOPMENT_PLAYS,
    ]);
  });
});
