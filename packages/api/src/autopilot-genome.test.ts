import { describe, expect, it } from "vitest";

import {
  AUTOPILOT_BLOCK_IDS,
  AUTOPILOT_BLOCKS,
  AUTOPILOT_ENTRY_MAX,
  AUTOPILOT_EXIT_MAX,
  type AutopilotGenome,
  crossover,
  genomeDefinition,
  genomeKey,
  genomeLabel,
  genomeNeighbours,
  mutate,
  normalizeGene,
  randomGenome,
} from "./autopilot-genome.ts";
import { createRandom } from "./backtest-analytics.ts";
import { validateStrategyDefinition } from "./strategy-dsl.ts";

const scripted = (values: readonly number[]) => {
  let index = 0;
  return () => {
    const value = values[index % values.length] as number;
    index += 1;
    return value;
  };
};

const base: AutopilotGenome = {
  entry: [
    { block: "trendSma", params: [200] },
    { block: "rsiDip", params: [2, 10] },
  ],
  exit: [{ block: "exitAboveSma", params: [5] }],
  stop: { block: "stopPct", params: [8] },
  target: null,
};

const assertValid = (genome: AutopilotGenome) => {
  expect(genome.entry.length).toBeGreaterThanOrEqual(1);
  expect(genome.entry.length).toBeLessThanOrEqual(AUTOPILOT_ENTRY_MAX);
  expect(genome.exit.length).toBeLessThanOrEqual(AUTOPILOT_EXIT_MAX);
  for (const gene of genome.entry)
    expect(AUTOPILOT_BLOCKS[gene.block].role).toBe("entry");
  for (const gene of genome.exit)
    expect(AUTOPILOT_BLOCKS[gene.block].role).toBe("exit");
  if (genome.stop !== null)
    expect(AUTOPILOT_BLOCKS[genome.stop.block].role).toBe("stop");
  if (genome.target !== null)
    expect(AUTOPILOT_BLOCKS[genome.target.block].role).toBe("target");
  expect(new Set(genome.entry.map((gene) => gene.block)).size).toBe(
    genome.entry.length
  );
  const result = validateStrategyDefinition(
    genomeDefinition(genome, "AP test")
  );
  expect(result.ok).toBe(true);
};

describe("autopilot genome", () => {
  it("builds the definition the building blocks describe", () => {
    const definition = genomeDefinition(base, "AP 1");
    expect(definition.entry.all).toEqual([
      {
        left: { length: 2, name: "rsi", source: "close", type: "indicator" },
        op: "<",
        right: { type: "const", value: 10 },
      },
      {
        left: { field: "close", type: "price" },
        op: ">",
        right: { length: 200, name: "sma", source: "close", type: "indicator" },
      },
    ]);
    expect(definition.exit.any).toHaveLength(1);
    expect(definition.stopLoss).toEqual({ kind: "pct", pct: 8 });
    expect(definition.takeProfit).toEqual({ kind: "none" });
    expect(definition.sizing).toEqual({ mode: "allIn" });
    expect(genomeLabel(base)).toBe(
      "rsiDip(2,10) + trendSma(200) / exitAboveSma(5) + stopPct(8)"
    );
    expect(
      genomeLabel({
        entry: [{ block: "breakout", params: [20] }],
        exit: [],
        stop: null,
        target: { block: "targetPct", params: [10] },
      })
    ).toBe("breakout(20) / targetPct(10)");
    expect(genomeLabel({ ...base, exit: [], stop: null })).toBe(
      "rsiDip(2,10) + trendSma(200)"
    );
  });

  it("builds a valid definition for every block", () => {
    for (const block of AUTOPILOT_BLOCK_IDS) {
      const gene = normalizeGene({ block, params: [] });
      const role = AUTOPILOT_BLOCKS[block].role;
      const genome: AutopilotGenome = {
        entry:
          role === "entry" ? [gene] : [{ block: "trendSma", params: [50] }],
        exit: role === "exit" ? [gene] : [],
        stop: role === "stop" ? gene : null,
        target: role === "target" ? gene : null,
      };
      assertValid(genome);
    }
  });

  it("keys genomes independent of gene order", () => {
    const swapped = { ...base, entry: [...base.entry].reverse() };
    expect(genomeKey(swapped)).toBe(genomeKey(base));
    expect(
      genomeKey({ ...base, target: { block: "targetPct", params: [10] } })
    ).not.toBe(genomeKey(base));
  });

  it("clamps parameters to the grid and orders fast before slow", () => {
    expect(normalizeGene({ block: "trendSma", params: [1003] })).toEqual({
      block: "trendSma",
      params: [250],
    });
    expect(normalizeGene({ block: "stopPct", params: [2.3] })).toEqual({
      block: "stopPct",
      params: [2.5],
    });
    expect(normalizeGene({ block: "emaCross", params: [60, 40] })).toEqual({
      block: "emaCross",
      params: [60, 70],
    });
    expect(normalizeGene({ block: "volExpansion", params: [20, 20] })).toEqual({
      block: "volExpansion",
      params: [20, 25],
    });
    expect(normalizeGene({ block: "maStack", params: [60, 20] })).toEqual({
      block: "maStack",
      params: [60, 70],
    });
    expect(
      normalizeGene({ block: "emaCross", params: [60, 60] }).params
    ).toEqual([60, 70]);
    expect(normalizeGene({ block: "volExpansion", params: [3] })).toEqual({
      block: "volExpansion",
      params: [3, 20],
    });
  });

  it("keeps every ordered block able to move its slow length above the fast one", () => {
    for (const block of AUTOPILOT_BLOCK_IDS) {
      const specs = AUTOPILOT_BLOCKS[block].params;
      if ("ordered" in AUTOPILOT_BLOCKS[block])
        expect(specs[0]?.max ?? 0).toBeLessThan(specs[1]?.max ?? 0);
    }
    expect(normalizeGene({ block: "volExpansion", params: [20, 100] })).toEqual(
      {
        block: "volExpansion",
        params: [20, 100],
      }
    );
    expect(
      normalizeGene({ block: "emaCross", params: [60, 250] }).params
    ).toEqual([60, 250]);
  });

  it("generates, crosses and mutates only valid genomes", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const random = createRandom(seed);
      const left = randomGenome(random);
      const right = randomGenome(random);
      assertValid(left);
      assertValid(right);
      const child = crossover(left, right, random);
      assertValid(child);
      let mutated = child;
      for (let step = 0; step < 6; step += 1) {
        mutated = mutate(mutated, random);
        assertValid(mutated);
      }
    }
  });

  it("keeps the entry list within bounds when a mutation adds or removes genes", () => {
    const full: AutopilotGenome = {
      ...base,
      entry: [
        { block: "trendSma", params: [200] },
        { block: "rsiDip", params: [2, 10] },
        { block: "breakout", params: [20] },
      ],
    };
    // roll < 0.55 (entry), list roll 0.1 (add) but the list is full, so a gene is removed.
    const added = mutate(full, scripted([0.1, 0.1, 0, 0, 0.9]));
    expect(added.entry).toHaveLength(2);
    // One entry gene: removing is not allowed, so a block is replaced (roll 0.4).
    const single: AutopilotGenome = {
      ...base,
      entry: [{ block: "trendSma", params: [200] }],
    };
    const replaced = mutate(single, scripted([0.1, 0.4, 0, 0, 0.5]));
    expect(replaced.entry).toHaveLength(1);
    expect(replaced.entry[0]?.block).not.toBe("trendSma");
    // Exit list empty and no add: unchanged.
    const noExit: AutopilotGenome = { ...base, exit: [] };
    const exitRoll = mutate(noExit, scripted([0.6, 0.9]));
    expect(exitRoll.exit).toEqual([]);
    // Exit removal (roll 0.3).
    expect(mutate(base, scripted([0.6, 0.3, 0])).exit).toEqual([]);
    // Exit addition (roll 0.1).
    expect(mutate(base, scripted([0.6, 0.1, 0, 0.5])).exit).toHaveLength(2);
  });

  it("mutates the stop and the target", () => {
    expect(mutate(base, scripted([0.85, 0.1])).stop).toBeNull();
    const replaced = mutate(base, scripted([0.85, 0.3, 0.99, 0.5, 0.5]));
    expect(replaced.stop?.block).toBe("stopPct");
    const shifted = mutate(base, scripted([0.85, 0.9, 0, 0, 0.9]));
    expect(shifted.stop?.block).toBe("stopPct");
    expect(shifted.stop?.params[0]).toBeGreaterThan(8);
    const added = mutate(base, scripted([0.95, 0, 0.5, 0.5]));
    expect(added.target).not.toBeNull();
  });

  it("crosses over parents whose gene lists are equal in size", () => {
    const right: AutopilotGenome = {
      entry: [{ block: "breakout", params: [55] }],
      exit: [],
      stop: null,
      target: { block: "targetAtr", params: [14, 3] },
    };
    const child = crossover(
      base,
      right,
      scripted([0.9, 0.99, 0.2, 0.9, 0, 0.9, 0.1])
    );
    assertValid(child);
    expect(child.stop).toBeNull();
    expect([base.target, right.target]).toContainEqual(child.target);
  });

  it("lists distinct parameter neighbours", () => {
    const neighbours = genomeNeighbours(base, 50);
    const keys = new Set(neighbours.map(genomeKey));
    expect(keys.size).toBe(neighbours.length);
    expect(keys.has(genomeKey(base))).toBe(false);
    // trendSma 200: 10% is 20 (grid step 10); rsiDip length 2 and level 10 move by one step.
    expect(neighbours.map((genome) => genome.entry[0]?.params[0])).toContain(
      180
    );
    expect(neighbours.map((genome) => genome.entry[0]?.params[0])).toContain(
      220
    );
    for (const neighbour of neighbours) assertValid(neighbour);
    expect(neighbours).toHaveLength(9);
    expect(genomeNeighbours(base, 4)).toHaveLength(4);
    const withTarget = genomeNeighbours(
      { ...base, exit: [], target: { block: "targetPct", params: [2] } },
      50
    );
    // targetPct 2 cannot go below the minimum: only the upward neighbour is distinct.
    expect(
      withTarget.filter((genome) => genome.target?.params[0] !== 2)
    ).toHaveLength(1);
    expect(
      genomeNeighbours(
        { ...base, stop: null, target: null, exit: [] },
        50
      ).every((genome) => genome.stop === null)
    ).toBe(true);
  });
});
