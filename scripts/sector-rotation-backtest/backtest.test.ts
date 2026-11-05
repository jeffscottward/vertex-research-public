import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKTEST_SECTORS,
  metricsOf,
  runBacktest,
  runWeights,
  turnover,
} from "./backtest.ts";
import {
  FREEZE_FROM,
  FREEZE_TO,
  FREEZE_USER_AGENT,
  freeze,
  parseChart,
  runFreeze,
} from "./freeze.ts";

const root = resolve(import.meta.dirname, "../..");
const frozen = JSON.parse(
  readFileSync(
    resolve(root, "research/backtests/sector-rotation/closes.json"),
    "utf8"
  )
) as { symbols: Record<string, [string, number][]> };

const round = (value: number) => Math.round(value * 10_000) / 10_000;

describe("frozen sector rotation backtest", () => {
  it("matches the numbers in report.md", () => {
    const result = runBacktest(frozen.symbols);
    const report = readFileSync(
      resolve(root, "research/backtests/sector-rotation/report.md"),
      "utf8"
    );
    expect(result.startDate).toBe("2019-03-08");
    expect(result.endDate).toBe("2026-10-30");
    expect(result.weeks).toBe(399);
    expect(round(result.rotationShareInvested)).toBe(0.9799);
    const rows = {
      "Equal-weight sectors": result.equalWeight,
      "Leading sectors": result.rotation,
      "SPY buy and hold": result.spyBuyHold,
    };
    for (const [label, m] of Object.entries(rows)) {
      const line = [
        m.cagr,
        m.volatility,
        m.sharpe,
        m.maxDrawdown,
        m.averageTurnover,
      ]
        .map((v) => round(v).toFixed(4))
        .join(" | ");
      expect(report).toContain(`| ${label} | ${line} |`);
    }
    expect(round(result.rotation.cagr)).toBe(0.095);
    expect(round(result.equalWeight.cagr)).toBe(0.1345);
    expect(round(result.spyBuyHold.cagr)).toBe(0.1586);
  });
});

describe("weekly loop and costs", () => {
  it("measures one-way turnover over both sides", () => {
    expect(turnover({ A: 0.5, B: 0.5 }, { B: 0.5, C: 0.5 })).toBe(1);
    expect(turnover({}, { A: 1 })).toBe(1);
  });

  it("charges 10 bps per unit of turnover and uses only next-week closes", () => {
    const closes = { A: [100, 110, 121], B: [100, 100, 50] };
    const { returns, turnovers } = runWeights(
      [{ A: 1 }, { B: 1 }, { A: 1 }],
      closes
    );
    // Week 1: from cash into A (turnover 1), +10%.
    expect(returns[0]).toBeCloseTo(1.1 * 0.999 - 1, 12);
    // Week 2: A to B (turnover 2), B falls 50%. The last target earns nothing.
    expect(returns[1]).toBeCloseTo(0.5 * 0.998 - 1, 12);
    expect(turnovers).toEqual([1, 2]);
  });

  it("measures turnover against drifted weights", () => {
    const closes = { A: [100, 200, 200], B: [100, 100, 100] };
    const { turnovers } = runWeights(
      [
        { A: 0.5, B: 0.5 },
        { A: 0.5, B: 0.5 },
        { A: 0.5, B: 0.5 },
      ],
      closes
    );
    expect(turnovers[0]).toBe(1);
    // After drift A is 2/3 and B 1/3: moving back to 1/2 each trades 1/3.
    expect(turnovers[1]).toBeCloseTo(1 / 3, 12);
  });

  it("computes metrics, with zero Sharpe for flat returns", () => {
    const flat = metricsOf([0, 0], [0, 0], 1);
    expect(flat).toEqual({
      averageTurnover: 0,
      cagr: 0,
      maxDrawdown: 0,
      sharpe: 0,
      volatility: 0,
    });
    const m = metricsOf([0.1, -0.5, 0.2], [1, 0, 0], 1);
    expect(m.maxDrawdown).toBeCloseTo(-0.5, 12);
    expect(m.cagr).toBeCloseTo(1.1 * 0.5 * 1.2 - 1, 12);
    expect(m.averageTurnover).toBeCloseTo(1 / 3, 12);
    expect(m.volatility).toBeGreaterThan(0);
  });

  it("falls back to SPY when no sector leads", () => {
    // Every sector equals SPY, so ratio = 100 and momentum = 100: all leading.
    const days = frozen.symbols["SPY"] ?? [];
    const same = Object.fromEntries(
      ["SPY", ...BACKTEST_SECTORS].map((s) => [s, days])
    );
    expect(runBacktest(same).rotationShareInvested).toBe(1);
    // Sectors that fall steadily vs SPY are never leading.
    const weak = Object.fromEntries([
      ["SPY", days],
      ...BACKTEST_SECTORS.map((s) => [
        s,
        days.map(([d, c], i) => [d, c * 0.999 ** i] as [string, number]),
      ]),
    ]);
    const result = runBacktest(weak);
    expect(result.rotationShareInvested).toBe(0);
    expect(result.rotation.cagr).toBeCloseTo(result.spyBuyHold.cagr, 3);
  });
});

describe("freeze helper", () => {
  const body = (timestamps: number[], closes: (number | null)[]) => ({
    chart: {
      result: [
        {
          indicators: { adjclose: [{ adjclose: closes }] },
          timestamp: timestamps,
        },
      ],
    },
  });
  const at = (date: string) => Date.parse(`${date}T14:30:00Z`) / 1000;

  it("keeps rounded closes inside the window and skips gaps", () => {
    expect(
      parseChart(
        body(
          [
            at("2018-06-18"),
            at(FREEZE_FROM),
            at("2020-01-02"),
            at(FREEZE_TO),
            at("2026-11-02"),
          ],
          [1, 1.234_56, null, 2, 3]
        )
      )
    ).toEqual([
      [FREEZE_FROM, 1.2346],
      [FREEZE_TO, 2],
    ]);
    expect(() => parseChart({ chart: { result: [] } })).toThrow();
  });

  it("builds the frozen file for every symbol", async () => {
    const urls: string[] = [];
    const text = await freeze(async (url) => {
      urls.push(url);
      return body([at(FREEZE_FROM)], [10]);
    }, new Date("2026-11-02T00:00:00Z"));
    const parsed = JSON.parse(text) as {
      fetchedAt: string;
      symbols: Record<string, unknown>;
    };
    expect(urls).toHaveLength(12);
    expect(urls[0]).toContain("/SPY?range=10y&interval=1d");
    expect(parsed.fetchedAt).toBe("2026-11-02T00:00:00.000Z");
    expect(parsed.symbols["XLK"]).toEqual([[FREEZE_FROM, 10]]);
  });

  it("fetches with the User-Agent, writes the file and fails on HTTP errors", async () => {
    const writes: [string, string][] = [];
    const agents: unknown[] = [];
    const code = await runFreeze({
      fetch: async (_url, init) => {
        agents.push(new Headers(init.headers).get("User-Agent"));
        return Response.json(body([at(FREEZE_FROM)], [1]));
      },
      now: new Date("2026-11-02T00:00:00Z"),
      out: "/tmp/out.json",
      write: (path, content) => writes.push([path, content]),
    });
    expect(code).toBe(0);
    expect(agents[0]).toBe(FREEZE_USER_AGENT);
    expect(writes[0]?.[0]).toBe("/tmp/out.json");
    expect(writes[0]?.[1]).toContain('"XLY":[["2018-06-19",1]]');
    await expect(
      runFreeze({
        fetch: async () => new Response("no", { status: 429 }),
        now: new Date(),
        out: "/tmp/out.json",
        write: () => undefined,
      })
    ).rejects.toThrow("HTTP 429");
  });
});
