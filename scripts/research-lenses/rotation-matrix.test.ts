import { describe, expect, it } from "vitest";
import {
  buildRotationMatrix,
  CAP_LABELS,
  capBucket,
  cellStats,
  median,
  monitorSummary,
  type OursInput,
  periodReturn,
  quantile,
  type RotationSecurity,
} from "./rotation-matrix.ts";

/** Linear path from 100 to 100 x (1 + endPct%) over `len` closes. */
const series = (endPct: number, len = 130): number[] =>
  Array.from(
    { length: len },
    (_, i) => 100 * (1 + (endPct / 100) * (i / (len - 1)))
  );

const NOW = () => new Date("2026-11-10T12:00:00.000Z");

describe("rotation matrix helpers (ported from vertex-research)", () => {
  it("cap buckets follow Finviz-style thresholds", () => {
    expect(capBucket(2e11)).toBe("large");
    expect(capBucket(1e10)).toBe("large");
    expect(capBucket(5e9)).toBe("mid");
    expect(capBucket(2e9)).toBe("mid");
    expect(capBucket(5e8)).toBe("small");
    expect(capBucket(3e8)).toBe("small");
    expect(capBucket(1e8)).toBeNull();
    expect(capBucket(null)).toBeNull();
    expect(capBucket(Number.NaN)).toBeNull();
  });

  it("period return needs enough history and a positive finite start", () => {
    expect(periodReturn([100, 110], 1)?.toFixed(2)).toBe("10.00");
    expect(periodReturn([100], 1)).toBeNull();
    expect(periodReturn([0, 110], 1)).toBeNull();
    expect(periodReturn([100, null], 1)).toBeNull();
    expect(periodReturn(null, 1)).toBeNull();
  });

  it("median and quantile ignore non-finite values", () => {
    expect(median([3, 1, null, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([Number.NaN])).toBeNull();
    expect(quantile([1, 2, 3, 4, 5], 0.75)).toBe(4);
    expect(quantile([1, 2], 0.75)).toBe(1.75);
    expect(quantile([undefined], 0.5)).toBeNull();
  });

  it("cell math: median, cap-weighted, breadth, leaders", () => {
    const c = cellStats([
      { marketCap: 300, ret: 10, symbol: "A" },
      { marketCap: 100, ret: -2, symbol: "B" },
      { marketCap: 100, ret: 4, symbol: "C" },
      { marketCap: 0, ret: null, symbol: "D" },
    ]);
    expect(c.n).toBe(3);
    expect(c.retMedian).toBe(4);
    expect(c.retCapWeighted).toBe((3000 - 200 + 400) / 500);
    expect(c.breadth).toBe(66.7);
    expect(c.leaders.map((l) => l.symbol)).toEqual(["A", "C", "B"]);
    expect(c.laggards[0]?.symbol).toBe("B");
  });

  it("cell math without caps or members", () => {
    const noCaps = cellStats([{ marketCap: null, ret: 1.234_56, symbol: "A" }]);
    expect(noCaps.retCapWeighted).toBeNull();
    expect(noCaps.leaders).toEqual([
      { marketCap: null, ret: 1.23, symbol: "A" },
    ]);
    expect(cellStats([])).toEqual({
      breadth: null,
      laggards: [],
      leaders: [],
      n: 0,
      retCapWeighted: null,
      retMedian: null,
    });
  });
});

const fixture = (): RotationSecurity[] => {
  const secs: RotationSecurity[] = [];
  // Leading industry: Semis +20..+30, one wish-list name at the top.
  for (let i = 0; i < 6; i++)
    secs.push({
      closes: series(20 + i),
      industry: "Semis",
      marketCap: 5e10,
      sector: "Tech",
      symbol: `S${i}`,
    });
  secs.push({
    closes: series(40),
    industry: "Semis",
    marketCap: 3e9,
    sector: "Tech",
    symbol: "WISH",
  });
  // Middle and lagging industries.
  for (const [ind, base] of [
    ["Banks", 5],
    ["REITs", 0],
    ["Utilities", -3],
    ["Oil", -10],
  ] as const)
    for (let i = 0; i < 4; i++)
      secs.push({
        closes: series(base + i),
        industry: ind,
        marketCap: 1e9,
        sector: ind === "Oil" ? "Energy" : "Other",
        symbol: `${ind.toUpperCase()}${i}`,
      });
  // Standout: one Retail name far from the rest.
  for (let i = 0; i < 9; i++)
    secs.push({
      closes: series(1 + (i % 2) * 0.5),
      industry: "Retail",
      marketCap: 4e9,
      sector: "Consumer",
      symbol: `R${i}`,
    });
  secs.push({
    closes: series(80),
    industry: "Retail",
    marketCap: 4e9,
    sector: "Consumer",
    symbol: "ROCKET",
  });
  secs.push({
    closes: series(500),
    industry: "Semis",
    marketCap: 1e7,
    sector: "Tech",
    symbol: "TINY",
  });
  return secs;
};

describe("buildRotationMatrix", () => {
  it("ranks industries, finds standouts and flags opportunities", () => {
    const secs = fixture();
    const m = buildRotationMatrix(secs, {
      asOf: "2026-10-20",
      now: NOW,
      ours: { held: ["S0"], wish: ["WISH", "OIL0", "NOPE"] },
    });
    expect(m.universeSize).toBe(secs.length - 1); // micro caps excluded
    expect(m.generatedAt).toBe("2026-11-10T12:00:00.000Z");
    expect(m.capLabels).toBe(CAP_LABELS);
    const p = m.periods["3M"];
    expect(p.top[0]?.industry).toBe("Semis");
    expect(p.bottom[0]?.industry).toBe("Oil");
    const semis = p.industries.find((i) => i.industry === "Semis");
    expect(
      semis?.cells.large && semis.cells.mid && !semis.cells.small
    ).toBeTruthy();
    expect(semis?.cells.mid?.n).toBe(1);
    expect(semis?.cells.mid?.symbols).toEqual([
      { marketCap: 3e9, ret: expect.any(Number), symbol: "WISH" },
    ]);
    expect(p.standouts.some((s) => s.symbol === "ROCKET" && s.z > 2)).toBe(
      true
    );
    const wish = m.ours.find((o) => o.symbol === "WISH");
    expect(wish?.covered && wish.cell3M).toBe("leading");
    expect(wish?.opportunity).toBe(true);
    const oil = m.ours.find((o) => o.symbol === "OIL0");
    expect(oil?.covered && oil.cell1M).toBe("lagging");
    expect(oil?.opportunity).toBe(false);
    // Held-only names are not candidates.
    expect(m.ours.find((o) => o.symbol === "S0")?.opportunity).toBe(false);
    expect(m.ours.find((o) => o.symbol === "NOPE")?.covered).toBe(false);
    // Opportunities sort first, then by symbol.
    expect(m.ours.map((o) => o.symbol)).toEqual(["WISH", "NOPE", "OIL0", "S0"]);
    const s = monitorSummary(m);
    expect(s.uncovered).toEqual(["NOPE"]);
    expect(s.periods["1D"]?.top).toHaveLength(5);
    expect(s.source).toBeNull();
    expect(s.ours.find((o) => o.symbol === "WISH")).toMatchObject({
      cell1M: "leading",
      opportunity: true,
      roles: ["wish"],
    });
    // Serializable: no Maps or private indexes left.
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    expect(JSON.stringify(p)).not.toContain("p75");
    expect("rows" in (p.industries[0] ?? {})).toBe(false);
  });

  it("labels middle quintiles, sectors and the sector sort", () => {
    const m = buildRotationMatrix(fixture(), { now: NOW });
    const p = m.periods["1M"];
    expect(p.industries.map((i) => i.quintile)).toEqual([1, 1, 2, 3, 4, 5]);
    expect(p.industries.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(p.sectors.map((sector) => sector.sector)).toEqual([
      "Tech",
      "Other",
      "Consumer",
      "Energy",
    ]);
    expect(p.sectors.find((s) => s.sector === "Other")?.industries).toEqual([
      "Banks",
      "REITs",
      "Utilities",
    ]);
    expect(m.ours).toEqual([]);
    expect(m.asOf).toBeNull();
  });

  it("tags our names in short-history, unranked and middle industries", () => {
    const secs: RotationSecurity[] = [
      ...fixture(),
      // Only 30 closes: a 1D/1M return, no 3M/6M return, alone in its industry.
      {
        closes: series(10, 30),
        industry: "Young",
        marketCap: 5e8,
        sector: "",
        symbol: "NEW",
      },
      // Two names: an industry below the ranking minimum of 3.
      {
        closes: series(3),
        industry: "Pair",
        marketCap: 5e8,
        sector: null,
        symbol: "PA",
      },
      { closes: series(4), industry: null, marketCap: 5e8, symbol: "PB" },
    ];
    const ours: OursInput = {
      held: null,
      reentry: ["utilities1", "PA", "NEW"],
      wish: undefined,
    };
    const m = buildRotationMatrix(secs, { now: NOW, ours });
    const byName = new Map(m.ours.map((o) => [o.symbol, o]));
    const young = byName.get("NEW");
    if (!young?.covered) throw new Error("NEW should be covered");
    expect(young.sector).toBe("Unclassified");
    // Alone in its industry: the industry median is its own return.
    expect(young.periods["1M"]).toEqual({
      industryRet: 7.05,
      leaderInIndustry: false,
      quintile: null,
      ret: 7.05,
    });
    expect(young.periods["3M"]).toEqual({
      industryRet: null,
      leaderInIndustry: false,
      quintile: null,
      ret: null,
    });
    expect(young.cell3M).toBe("unranked");
    const banks = byName.get("UTILITIES1");
    if (!banks?.covered) throw new Error("UTILITIES1 should be covered");
    expect(banks.cell1M).toBe("middle");
    expect(banks.roles).toEqual(["reentry"]);
    expect(banks.opportunity).toBe(false);
    const pa = byName.get("PA");
    expect(pa?.covered && pa.industry).toBe("Pair");
    expect(
      m.periods["1M"].industries.find((i) => i.industry === "Unclassified")?.n
    ).toBe(1);
  });

  it("standouts need enough names and spread", () => {
    const flat = Array.from({ length: 6 }, (_, i) => ({
      closes: series(5),
      industry: "Flat",
      marketCap: 5e9,
      sector: "X",
      symbol: `F${i}`,
    }));
    expect(
      buildRotationMatrix(flat, { now: NOW }).periods["1M"].standouts
    ).toEqual([]);
    const single = [
      {
        closes: series(5),
        industry: "One",
        marketCap: 5e9,
        sector: "X",
        symbol: "O",
      },
    ];
    expect(
      buildRotationMatrix(single, { minStandoutN: 1, now: NOW }).periods["1M"]
        .standouts
    ).toEqual([]);
    const spread = [
      ...flat.slice(0, 5).map((s, i) => ({ ...s, closes: series(i) })),
      { ...flat[0], closes: series(60), symbol: "OUT" },
    ] as RotationSecurity[];
    const loose = buildRotationMatrix(spread, { now: NOW, standoutSigma: 1 });
    expect(loose.periods["1M"].standouts.map((s) => s.symbol)).toEqual(["OUT"]);
    expect(
      buildRotationMatrix(spread, {
        minStandoutN: 7,
        now: NOW,
        standoutSigma: 1,
      }).periods["1M"].standouts
    ).toEqual([]);
  });

  it("defaults to no options and the current time", () => {
    const m = buildRotationMatrix([]);
    expect(Number.isNaN(Date.parse(m.generatedAt))).toBe(false);
    expect(m.universeSize).toBe(0);
    expect(m.periods["6M"]).toEqual({
      bars: 126,
      bottom: [],
      industries: [],
      n: 0,
      sectors: [],
      standouts: [],
      top: [],
    });
  });

  it("summary keeps the source and the first 10 standouts", () => {
    const m = buildRotationMatrix(fixture(), {
      now: NOW,
      ours: { wish: ["WISH"] },
    });
    m.source = { bars: "Yahoo" };
    const s = monitorSummary(m);
    expect(s.source).toEqual({ bars: "Yahoo" });
    expect(Object.keys(s.periods)).toEqual(["1D", "1M", "3M", "6M"]);
    expect(s.periods["3M"]?.standouts.length).toBeLessThanOrEqual(10);
    expect(s.ours[0]?.ret1M).toEqual(expect.any(Number));
    expect(s.uncovered).toEqual([]);
  });
});
